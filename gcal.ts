#!/usr/bin/env node
/**
 * gcal - Google Calendar CLI tool
 * Manage Google Calendar events with ICS import support
 *
 * Can be associated with .ics files for direct import:
 *   assoc .ics=icsfile
 *   ftype icsfile=gcal "%1"
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { authenticateOAuth } from '@bobfrankston/oauthsupport';
import type { GoogleEvent, EventsListResponse, CalendarListEntry, CalendarListResponse } from './glib/types.ts';
import {
    CREDENTIALS_FILE, loadConfig, saveConfig, getUserPaths,
    ensureUserDir, formatDateTime, formatDuration, parseDuration, parseDateTime, ts, normalizeUser
} from './glib/gutils.js';
import { extractEventsFromText, readClipboard } from './glib/aihelper.js';

import pkg from './package.json' with { type: 'json' };
const VERSION: string = pkg.version;
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_SCOPE_READ = 'https://www.googleapis.com/auth/calendar.readonly';
const CALENDAR_SCOPE_WRITE = 'https://www.googleapis.com/auth/calendar';

let abortController: AbortController = null;

function setupAbortHandler(): void {
    abortController = new AbortController();
    let ctrlCCount = 0;
    process.on('SIGINT', () => {
        ctrlCCount++;
        abortController?.abort();
        if (ctrlCCount >= 2) {
            console.log('\n\nForce exit.');
            process.exit(1);
        }
        console.log('\n\nCtrl+C pressed - aborting... (press again to force exit)');
    });
}

async function getAccessToken(user: string, writeAccess = false, forceRefresh = false): Promise<string> {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
        console.error(`\nCredentials file not found: ${CREDENTIALS_FILE}\n`);
        console.error(`gcal uses the same credentials as gcards.`);
        console.error(`Make sure gcards is set up with OAuth credentials first.`);
        console.error(`See: https://github.com/BobFrankston/oauthsupport/blob/master/SETUP-GOOGLE-OAUTH.md`);
        process.exit(1);
    }

    const paths = getUserPaths(user);
    ensureUserDir(user);

    const scope = writeAccess ? CALENDAR_SCOPE_WRITE : CALENDAR_SCOPE_READ;
    const tokenFileName = writeAccess ? 'token-write.json' : 'token.json';
    const tokenFilePath = path.join(paths.userDir, tokenFileName);

    if (forceRefresh && fs.existsSync(tokenFilePath)) {
        fs.unlinkSync(tokenFilePath);
        console.log(`${ts()} Token expired, refreshing...`);
    }

    const token = await authenticateOAuth(CREDENTIALS_FILE, {
        scope,
        tokenDirectory: paths.userDir,
        tokenFileName,
        credentialsKey: 'installed',
        signal: abortController?.signal
    });

    if (!token) {
        throw new Error('OAuth authentication failed');
    }

    return token.access_token;
}

async function apiFetch(url: string, accessToken: string, options: RequestInit = {}): Promise<Response> {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers
    };
    return fetch(url, { ...options, headers });
}

async function listCalendars(accessToken: string): Promise<CalendarListEntry[]> {
    const url = `${CALENDAR_API_BASE}/users/me/calendarList`;
    const res = await apiFetch(url, accessToken);
    if (!res.ok) {
        throw new Error(`Failed to list calendars: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as CalendarListResponse;
    return data.items || [];
}

async function listEvents(
    accessToken: string,
    calendarId = 'primary',
    maxResults = 10,
    timeMin?: string
): Promise<GoogleEvent[]> {
    const params = new URLSearchParams({
        maxResults: maxResults.toString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin: timeMin || new Date().toISOString()
    });

    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    const res = await apiFetch(url, accessToken);
    if (!res.ok) {
        throw new Error(`Failed to list events: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as EventsListResponse;
    return data.items || [];
}

async function createEvent(
    accessToken: string,
    event: GoogleEvent,
    calendarId = 'primary'
): Promise<GoogleEvent> {
    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
    const res = await apiFetch(url, accessToken, {
        method: 'POST',
        body: JSON.stringify(event)
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to create event: ${res.status} ${errText}`);
    }
    return await res.json() as GoogleEvent;
}

async function deleteEvent(
    accessToken: string,
    eventId: string,
    calendarId = 'primary'
): Promise<void> {
    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const res = await apiFetch(url, accessToken, { method: 'DELETE' });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to delete event: ${res.status} ${errText}`);
    }
}

async function patchEvent(
    accessToken: string,
    eventId: string,
    patch: Partial<GoogleEvent>,
    calendarId = 'primary'
): Promise<GoogleEvent> {
    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const res = await apiFetch(url, accessToken, {
        method: 'PATCH',
        body: JSON.stringify(patch)
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to update event: ${res.status} ${errText}`);
    }
    return await res.json() as GoogleEvent;
}

async function importIcsFile(
    filePath: string,
    accessToken: string,
    calendarId = 'primary'
): Promise<{ imported: number; errors: string[] }> {
    const ICAL = await import('ical.js');
    const result = { imported: 0, errors: [] as string[] };

    const icsContent = fs.readFileSync(filePath, 'utf-8');

    try {
        const jcalData = ICAL.default.parse(icsContent);
        const vcalendar = new ICAL.default.Component(jcalData);
        const vevents = vcalendar.getAllSubcomponents('vevent');

        console.log(`Found ${vevents.length} event(s)\n`);

        for (const vevent of vevents) {
            try {
                const event = new ICAL.default.Event(vevent);
                const googleEvent: GoogleEvent = {
                    summary: event.summary || 'Untitled Event',
                    description: event.description || undefined,
                    location: event.location || undefined,
                    start: {},
                    end: {}
                };

                const startDate = event.startDate;
                if (startDate) {
                    if (startDate.isDate) {
                        googleEvent.start.date = startDate.toJSDate().toISOString().split('T')[0];
                    } else {
                        googleEvent.start.dateTime = startDate.toJSDate().toISOString();
                        googleEvent.start.timeZone = startDate.zone?.tzid || Intl.DateTimeFormat().resolvedOptions().timeZone;
                    }
                }

                const endDate = event.endDate;
                if (endDate) {
                    if (endDate.isDate) {
                        googleEvent.end.date = endDate.toJSDate().toISOString().split('T')[0];
                    } else {
                        googleEvent.end.dateTime = endDate.toJSDate().toISOString();
                        googleEvent.end.timeZone = endDate.zone?.tzid || Intl.DateTimeFormat().resolvedOptions().timeZone;
                    }
                }

                const attendees = vevent.getAllProperties('attendee');
                if (attendees.length > 0) {
                    googleEvent.attendees = attendees.map(att => {
                        const emailValue = att.getFirstValue();
                        const email = (typeof emailValue === 'string' ? emailValue.replace('mailto:', '') : emailValue?.toString() || '');
                        const cn = att.getParameter('cn');
                        const displayName = Array.isArray(cn) ? cn[0] : cn;
                        return { email, displayName: displayName || undefined };
                    });
                }

                const rrule = vevent.getFirstPropertyValue('rrule');
                if (rrule) {
                    googleEvent.recurrence = [`RRULE:${rrule.toString()}`];
                }

                await createEvent(accessToken, googleEvent, calendarId);
                console.log(`  + ${googleEvent.summary}`);
                result.imported++;
            } catch (e: any) {
                const summary = vevent.getFirstPropertyValue('summary') || 'unknown';
                result.errors.push(`${summary}: ${e.message}`);
                console.error(`  ! Failed: ${summary}`);
            }
        }
    } catch (e: any) {
        result.errors.push(`Parse error: ${e.message}`);
    }

    return result;
}

function showUsage(): void {
    console.log(`
gcal v${VERSION} - Google Calendar CLI

Usage:
  gcal <file.ics>                    Import ICS file (file association)
  gcal <command> [options]           Run command

Commands:
  list [n]                           List upcoming n events (default: 10)
  add <title> <when> [duration]      Add event (explicit args)
  add                                Add event (type description interactively)
  add "free text description"        Add event (AI parses single text arg)
  add -clip                          Add event from clipboard text (AI-parsed)
  del|delete <id> [id2...]           Delete event(s) by ID (prefix match)
  remind <id> <dur> [dur2...]        Add reminder(s) to existing event
  import <file.ics>                  Import events from ICS file
  calendars                          List available calendars
  assoc                              Set up .ics file association (Windows)
  help                               Show this help

Options:
  -u, -user <email>        Set default Google account
  -c, -calendar <id>       Calendar ID (default: primary)
  -n <count>               Number of events to list
  -v, -verbose             Show event IDs and links
  -b, -birthdays           Include birthday events (hidden by default)
  -clip                    Read from clipboard (for add command)
  -r, -reminder <dur>      Add popup reminder (e.g., 30m, 1h); repeatable
  -all                     Delete all instances of recurring event

Examples:
  gcal meeting.ics                        Import ICS file
  gcal list                               List next 10 events
  gcal add "Dentist" "Friday 3pm" "1h"
  gcal add "Lunch" "1/14/2026 12:00" "1h"
  gcal add "Meeting" "tomorrow 10:00"
  gcal add "Appointment" "jan 15 2pm"
  gcal add "Dentist appointment Friday 3pm for 1 hour"
  gcal add -clip                          Add from clipboard text
  gcal add "Dentist" "Friday 3pm" -r 30m  Add with 30-min reminder
  gcal remind abc12345 30m                Add 30-min reminder to event
  gcal add                                Type event description (one or multiple)
  gcal -u bob@gmail.com                   Set default user

File Association (Windows):
  gcal assoc                              Set up automatically
`);
}

interface ParsedArgs {
    command: string;
    args: string[];
    user: string;
    calendar: string;
    count: number;
    help: boolean;
    verbose: boolean;
    icsFile: string;  /** Direct .ics file path */
    birthdays: boolean;
    clip: boolean;
    all: boolean;
    reminders: number[];
}

function parseArgs(argv: string[]): ParsedArgs {
    const result: ParsedArgs = {
        command: '',
        args: [],
        user: '',
        calendar: 'primary',
        count: 10,
        help: false,
        verbose: false,
        icsFile: '',
        birthdays: false,
        clip: false,
        all: false,
        reminders: []
    };

    const unknown: string[] = [];
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        switch (arg) {
            case '-u':
            case '-user':
            case '--user':
                result.user = argv[++i] || '';
                break;
            case '-c':
            case '-calendar':
            case '--calendar':
                result.calendar = argv[++i] || 'primary';
                break;
            case '-n':
                result.count = parseInt(argv[++i]) || 10;
                break;
            case '-v':
            case '-verbose':
            case '--verbose':
                result.verbose = true;
                break;
            case '-b':
            case '-birthdays':
            case '--birthdays':
                result.birthdays = true;
                break;
            case '-clip':
            case '--clip':
                result.clip = true;
                break;
            case '-all':
            case '--all':
                result.all = true;
                break;
            case '-r':
            case '-reminder':
            case '--reminder': {
                const val = argv[++i] || '';
                const mins = parseDuration(val);
                result.reminders.push(mins);
                break;
            }
            case '-h':
            case '-help':
            case '--help':
            case 'help':
                result.help = true;
                break;
            case '-V':
            case '-version':
            case '--version':
                console.log(`gcal v${VERSION}`);
                process.exit(0);
            default:
                if (arg.startsWith('-')) {
                    unknown.push(arg);
                } else if (!result.command) {
                    // Check if it's an .ics file
                    if (arg.toLowerCase().endsWith('.ics')) {
                        result.icsFile = arg;
                        result.command = 'import';
                    } else {
                        result.command = arg;
                    }
                } else {
                    result.args.push(arg);
                }
        }
        i++;
    }

    if (unknown.length > 0) {
        console.error(`Unknown options: ${unknown.join(', ')}`);
        process.exit(1);
    }

    return result;
}

function buildReminders(minutes: number[]): GoogleEvent['reminders'] | undefined {
    if (minutes.length === 0) return undefined;
    return {
        useDefault: false,
        overrides: minutes.map(m => ({ method: 'popup' as const, minutes: m }))
    };
}

function checkIcsAssoc(): boolean {
    if (process.platform !== 'win32') return true;
    try {
        const result = execSync('cmd /c assoc .ics 2>nul', { encoding: 'utf-8' }).trim();
        if (!result.includes('icsfile')) return false;
        const ftype = execSync('cmd /c ftype icsfile 2>nul', { encoding: 'utf-8' }).trim();
        return ftype.includes('gcal');
    } catch {
        return false;
    }
}

function setIcsAssoc(): boolean {
    if (process.platform !== 'win32') {
        console.log('File associations are only supported on Windows.');
        return false;
    }
    try {
        // Use HKCU registry — no admin needed
        execSync('reg add HKCU\\Software\\Classes\\.ics /ve /d icsfile /f', { stdio: 'pipe' });
        execSync('reg add HKCU\\Software\\Classes\\icsfile\\shell\\open\\command /ve /d "gcal \\"%1\\"" /f', { stdio: 'pipe' });
        return true;
    } catch (e: any) {
        console.error(`Failed to set file association: ${e.message}`);
        return false;
    }
}

function resolveUser(cliUser: string): string {
    if (cliUser) {
        return normalizeUser(cliUser);
    }

    const config = loadConfig();
    if (config.lastUser) {
        return config.lastUser;
    }

    return '';
}

async function main(): Promise<void> {
    setupAbortHandler();

    const parsed = parseArgs(process.argv.slice(2));

    // Handle -u: save as default user
    if (parsed.user) {
        const normalized = normalizeUser(parsed.user);
        const config = loadConfig();
        config.lastUser = normalized;
        saveConfig(config);
        console.log(`Default user set to: ${normalized}`);

        // If no command, exit after setting default
        if (!parsed.command && !parsed.icsFile) {
            process.exit(0);
        }
    }

    if (parsed.help) {
        showUsage();
        if (process.platform === 'win32' && !checkIcsAssoc()) {
            console.log('Note: .ics file association not set. Run "gcal assoc" to set it up.');
        }
        process.exit(0);
    }

    if (!parsed.command) {
        // First run with no command: offer to set up .ics file association
        if (process.platform === 'win32') {
            const config = loadConfig();
            if (!config.assocChecked) {
                config.assocChecked = true;
                saveConfig(config);
                if (!checkIcsAssoc()) {
                    const rl = createInterface({ input: process.stdin, output: process.stdout });
                    const answer = await rl.question('Set up .ics file association so double-clicking imports to gcal? [Y/n] ');
                    rl.close();
                    if (!answer || answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
                        if (setIcsAssoc()) {
                            console.log('.ics file association set.\n');
                        }
                    }
                }
            }
        }
        showUsage();
        if (process.platform === 'win32' && !checkIcsAssoc()) {
            console.log('Note: .ics file association not set. Run "gcal assoc" to set it up.');
        }
        process.exit(1);
    }

    // Commands that don't need authentication
    if (parsed.command === 'assoc') {
        if (process.platform !== 'win32') {
            console.error('File associations are only supported on Windows.');
            process.exit(1);
        }
        if (checkIcsAssoc()) {
            console.log('.ics file association is already set.');
        } else if (setIcsAssoc()) {
            console.log('.ics file association set. Double-click .ics files to import with gcal.');
        }
        process.exit(0);
    }

    // Resolve user
    const user = resolveUser(parsed.user);
    if (!user) {
        console.error('No user configured. Use -u <email> to set default user.');
        process.exit(1);
    }

    console.log(`${ts()} User: ${user}`);

    switch (parsed.command) {
        case 'import': {
            const filePath = parsed.icsFile || parsed.args[0];
            if (!filePath) {
                console.error('Usage: gcal import <file.ics>  or  gcal <file.ics>');
                process.exit(1);
            }

            const resolvedPath = path.resolve(filePath);
            if (!fs.existsSync(resolvedPath)) {
                console.error(`File not found: ${resolvedPath}`);
                process.exit(1);
            }

            console.log(`Importing: ${path.basename(resolvedPath)}`);
            console.log(`Calendar: ${parsed.calendar}\n`);

            const token = await getAccessToken(user, true);
            const result = await importIcsFile(resolvedPath, token, parsed.calendar);

            console.log(`\n${result.imported} event(s) imported`);
            if (result.errors.length > 0) {
                console.log(`${result.errors.length} error(s)`);
            }
            break;
        }

        case 'list': {
            const count = parsed.args[0] ? parseInt(parsed.args[0]) : parsed.count;
            const token = await getAccessToken(user, false);
            let events = await listEvents(token, parsed.calendar, count);
            const birthdayCount = events.filter(e => e.eventType === 'birthday').length;
            if (!parsed.birthdays) {
                events = events.filter(e => e.eventType !== 'birthday');
            }

            if (events.length === 0) {
                console.log('No upcoming events found.');
            } else {
                console.log(`\nUpcoming events (${events.length}):\n`);

                // Build table data
                const rows: string[][] = [];
                for (const event of events) {
                    const shortId = (event.id || '').slice(0, 8);
                    const start = event.start ? formatDateTime(event.start) : '?';
                    const duration = (event.start && event.end) ? formatDuration(event.start, event.end) : '';
                    const summary = (event.summary || '(no title)') + (event.eventType === 'birthday' ? ' [from contact]' : '');
                    const loc = event.location || '';
                    if (parsed.verbose) {
                        rows.push([shortId, start, duration, summary, loc, event.htmlLink || '']);
                    } else {
                        rows.push([shortId, start, duration, summary, loc]);
                    }
                }

                // Calculate column widths
                const headers = parsed.verbose
                    ? ['ID', 'When', 'Dur', 'Event', 'Location', 'Link']
                    : ['ID', 'When', 'Dur', 'Event', 'Location'];
                const colWidths = headers.map((h, i) =>
                    Math.max(h.length, ...rows.map(r => (r[i] || '').length))
                );

                // Print header
                const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join('  ');
                console.log(headerLine);
                console.log(colWidths.map(w => '-'.repeat(w)).join('  '));

                // Print rows
                for (const row of rows) {
                    const line = row.map((cell, i) => (cell || '').padEnd(colWidths[i])).join('  ');
                    console.log(line);
                }
            }
            if (birthdayCount > 0 && !parsed.birthdays) {
                console.log(`\n(${birthdayCount} birthday${birthdayCount > 1 ? 's' : ''} hidden, -b to show)`);
            }
            break;
        }

        case 'add': {
            // Explicit mode: gcal add "title" "when" [duration]
            if (parsed.args.length >= 2 && !parsed.clip) {
                const [title, when, duration = '1h'] = parsed.args;
                const startTime = parseDateTime(when);
                const durationMins = parseDuration(duration);
                const endTime = new Date(startTime.getTime() + durationMins * 60 * 1000);

                const event: GoogleEvent = {
                    summary: title,
                    start: {
                        dateTime: startTime.toISOString(),
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
                    },
                    end: {
                        dateTime: endTime.toISOString(),
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
                    },
                    reminders: buildReminders(parsed.reminders)
                };

                const token = await getAccessToken(user, true);
                const created = await createEvent(token, event, parsed.calendar);
                console.log(`\nEvent created: ${created.summary}`);
                console.log(`  When: ${formatDateTime(created.start)} - ${formatDateTime(created.end)}`);
                if (created.htmlLink) {
                    console.log(`  Link: ${created.htmlLink}`);
                }
                break;
            }

            // AI mode: freeform text from clipboard, keyboard, or single arg
            let inputText: string;
            if (parsed.clip) {
                console.log('Reading from clipboard...');
                inputText = readClipboard();
                if (!inputText) {
                    console.error('Clipboard is empty');
                    process.exit(1);
                }
                console.log(`Clipboard: ${inputText.substring(0, 200)}${inputText.length > 200 ? '...' : ''}`);
            } else if (parsed.args.length === 1) {
                inputText = parsed.args[0].trim();
                if (!inputText) {
                    console.error('Event description is empty');
                    process.exit(1);
                }
            } else {
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                inputText = (await rl.question('Describe the event: ')).trim();
                rl.close();
                if (!inputText) {
                    console.error('No input provided');
                    process.exit(1);
                }
            }

            console.log('Extracting event details...');
            const extractedEvents = await extractEventsFromText(inputText);
            if (extractedEvents.length === 0) {
                console.error('Failed to extract event details from text');
                process.exit(1);
            }

            const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const events: GoogleEvent[] = [];
            for (const extracted of extractedEvents) {
                const tz = extracted.timeZone || localTz;
                const startDt = extracted.startDateTime;
                if (isNaN(new Date(startDt).getTime())) {
                    console.error(`AI returned invalid date: ${startDt} — skipping`);
                    continue;
                }
                const durationMins = parseDuration(extracted.duration || '1h');
                const endMs = new Date(startDt).getTime() + durationMins * 60 * 1000;
                const endDate = new Date(endMs);
                const endDt = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}T${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}:00`;

                const event: GoogleEvent = {
                    summary: extracted.summary,
                    start: { dateTime: startDt, timeZone: tz },
                    end: { dateTime: endDt, timeZone: tz },
                    location: extracted.location,
                    description: extracted.description,
                    reminders: buildReminders(parsed.reminders)
                };
                events.push(event);

                console.log(`\n  Event: ${extracted.summary}`);
                console.log(`  When:  ${formatDateTime(event.start)} - ${formatDateTime(event.end)} (${extracted.duration || '1h'})${tz !== localTz ? ` [${tz}]` : ''}`);
                if (extracted.location) console.log(`  Where: ${extracted.location}`);
                if (extracted.description) console.log(`  Note:  ${extracted.description}`);
            }

            if (events.length === 0) {
                console.error('No valid events extracted');
                process.exit(1);
            }

            const prompt = events.length === 1
                ? '\nCreate this event? [Y/n] (auto-yes in 60s) '
                : `\nCreate ${events.length} events? [Y/n] (auto-yes in 60s) `;
            const rl2 = createInterface({ input: process.stdin, output: process.stdout });
            const confirm = await Promise.race([
                rl2.question(prompt).then(s => s.trim().toLowerCase()),
                new Promise<string>(resolve => setTimeout(() => {
                    console.log('\nNo response — creating event(s).');
                    resolve('');
                }, 60_000))
            ]);
            rl2.close();
            if (confirm && confirm !== 'y' && confirm !== 'yes') {
                console.log('Cancelled.');
                break;
            }

            const token = await getAccessToken(user, true);
            for (const event of events) {
                const created = await createEvent(token, event, parsed.calendar);
                console.log(`\nEvent created: ${created.summary}`);
                console.log(`  When: ${formatDateTime(created.start)} - ${formatDateTime(created.end)}`);
                if (created.htmlLink) {
                    console.log(`  Link: ${created.htmlLink}`);
                }
            }
            break;
        }

        case 'del':
        case 'delete': {
            if (parsed.args.length === 0) {
                console.error('Usage: gcal delete <id> [id2] [id3] ...');
                console.error('Use "gcal list" to see event IDs');
                process.exit(1);
            }

            const token = await getAccessToken(user, true);
            const events = await listEvents(token, parsed.calendar, 50);

            for (const idPrefix of parsed.args) {
                let matches = events.filter(e => e.id?.startsWith(idPrefix));
                // Filter out birthdays unless -birthdays flag
                if (!parsed.birthdays) {
                    matches = matches.filter(e => e.eventType !== 'birthday');
                }
                // Deduplicate recurring event instances (same base ID before '_')
                const unique = [...new Map(matches.map(e => [(e.id || '').split('_')[0], e])).values()];

                if (unique.length === 0) {
                    console.error(`${idPrefix}: not found`);
                    continue;
                }
                if (unique.length > 1) {
                    console.error(`${idPrefix}: ambiguous (${unique.length} matches)`);
                    for (const e of unique) {
                        console.error(`  ${e.id?.slice(0, 8)} - ${e.summary}`);
                    }
                    console.error(`Use -all to delete entire recurring series`);
                    continue;
                }
                const event = unique[0];
                // -all: delete entire recurring series using base ID
                const deleteId = parsed.all ? (event.id || '').split('_')[0] : event.id!;
                await deleteEvent(token, deleteId, parsed.calendar);
                console.log(`Deleted${parsed.all ? ' (all instances)' : ''}: ${event.summary}`);
            }
            break;
        }

        case 'calendars': {
            const token = await getAccessToken(user, false);
            const calendars = await listCalendars(token);

            console.log(`\nCalendars (${calendars.length}):\n`);
            for (const cal of calendars) {
                const primary = cal.primary ? ' (primary)' : '';
                const role = cal.accessRole ? ` [${cal.accessRole}]` : '';
                console.log(`  ${cal.summary || cal.id}${primary}${role}`);
                console.log(`    ID: ${cal.id}`);
            }
            break;
        }

        case 'remind': {
            if (parsed.args.length < 2) {
                console.error('Usage: gcal remind <id> <duration> [duration2...]');
                console.error('  e.g.: gcal remind abc12345 30m');
                console.error('  e.g.: gcal remind abc12345 30m 1h');
                console.error('Use "gcal list" to see event IDs');
                process.exit(1);
            }

            const [idPrefix, ...durationArgs] = parsed.args;
            const reminderMins = durationArgs.map(d => parseDuration(d));

            const token = await getAccessToken(user, true);
            const events = await listEvents(token, parsed.calendar, 50);

            let matches = events.filter(e => e.id?.startsWith(idPrefix));
            if (!parsed.birthdays) {
                matches = matches.filter(e => e.eventType !== 'birthday');
            }
            const unique = [...new Map(matches.map(e => [(e.id || '').split('_')[0], e])).values()];

            if (unique.length === 0) {
                console.error(`${idPrefix}: not found`);
                process.exit(1);
            }
            if (unique.length > 1) {
                console.error(`${idPrefix}: ambiguous (${unique.length} matches)`);
                for (const e of unique) {
                    console.error(`  ${e.id?.slice(0, 8)} - ${e.summary}`);
                }
                process.exit(1);
            }

            const event = unique[0];
            const reminders = buildReminders(reminderMins);
            const updated = await patchEvent(token, event.id!, { reminders }, parsed.calendar);
            console.log(`Updated: ${updated.summary}`);
            for (const m of reminderMins) {
                console.log(`  Reminder: ${m >= 60 ? `${m / 60}h` : `${m}m`} before`);
            }
            break;
        }

        default:
            console.error(`Unknown command: ${parsed.command}`);
            showUsage();
            process.exit(1);
    }
}

if (import.meta.main) {
    main().catch(e => {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    });
}
