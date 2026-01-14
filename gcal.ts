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
import { authenticateOAuth } from '@bobfrankston/oauthsupport';
import type { GoogleEvent, EventsListResponse, CalendarListEntry, CalendarListResponse } from './glib/types.ts';
import {
    CREDENTIALS_FILE, loadConfig, saveConfig, getUserPaths,
    ensureUserDir, formatDateTime, parseDuration, parseDateTime, ts, normalizeUser
} from './glib/gutils.ts';

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_SCOPE_READ = 'https://www.googleapis.com/auth/calendar.readonly';
const CALENDAR_SCOPE_WRITE = 'https://www.googleapis.com/auth/calendar';

let abortController: AbortController = null;

function setupAbortHandler(): void {
    abortController = new AbortController();
    process.on('SIGINT', () => {
        abortController?.abort();
        console.log('\n\nCtrl+C pressed - aborting...');
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
        credentialsKey: 'web',
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
gcal - Google Calendar CLI

Usage:
  gcal <file.ics>                    Import ICS file (file association)
  gcal <command> [options]           Run command

Commands:
  list [n]                           List upcoming n events (default: 10)
  add <title> <when> [duration]      Add event
  import <file.ics>                  Import events from ICS file
  calendars                          List available calendars
  help                               Show this help

Options:
  -u, -user <email>        Google account (one-time)
  -defaultUser <email>     Set default user for future use
  -c, -calendar <id>       Calendar ID (default: primary)
  -n <count>               Number of events to list

Examples:
  gcal meeting.ics                   Import ICS file
  gcal list                          List next 10 events
  gcal add "Dentist" "Friday 3pm" "1h"
  gcal -defaultUser bob@gmail.com    Set default user

File Association (Windows):
  assoc .ics=icsfile
  ftype icsfile=gcal "%1"
`);
}

interface ParsedArgs {
    command: string;
    args: string[];
    user: string;
    defaultUser: string;
    calendar: string;
    count: number;
    help: boolean;
    icsFile: string;  /** Direct .ics file path */
}

function parseArgs(argv: string[]): ParsedArgs {
    const result: ParsedArgs = {
        command: '',
        args: [],
        user: '',
        defaultUser: '',
        calendar: 'primary',
        count: 10,
        help: false,
        icsFile: ''
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
            case '-defaultUser':
            case '--defaultUser':
                result.defaultUser = argv[++i] || '';
                break;
            case '-c':
            case '-calendar':
            case '--calendar':
                result.calendar = argv[++i] || 'primary';
                break;
            case '-n':
                result.count = parseInt(argv[++i]) || 10;
                break;
            case '-h':
            case '-help':
            case '--help':
            case 'help':
                result.help = true;
                break;
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

function resolveUser(cliUser: string, setAsDefault = false): string {
    if (cliUser) {
        const normalized = normalizeUser(cliUser);
        if (setAsDefault) {
            const config = loadConfig();
            config.lastUser = normalized;
            saveConfig(config);
        }
        return normalized;
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

    // Handle -defaultUser first (can be combined with other commands)
    if (parsed.defaultUser) {
        const normalized = normalizeUser(parsed.defaultUser);
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
        process.exit(0);
    }

    if (!parsed.command) {
        showUsage();
        process.exit(1);
    }

    // Resolve user
    const user = resolveUser(parsed.user, false);
    if (!user) {
        console.error('No user configured.');
        console.error('Use -u <email> for one-time, or -defaultUser <email> to set default.');
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
            const events = await listEvents(token, parsed.calendar, count);

            if (events.length === 0) {
                console.log('No upcoming events found.');
            } else {
                console.log(`\nUpcoming events (${events.length}):\n`);
                for (const event of events) {
                    const start = event.start ? formatDateTime(event.start) : '?';
                    const loc = event.location ? ` @ ${event.location}` : '';
                    console.log(`  ${start} - ${event.summary || '(no title)'}${loc}`);
                    if (event.htmlLink) {
                        console.log(`    ${event.htmlLink}`);
                    }
                }
            }
            break;
        }

        case 'add': {
            if (parsed.args.length < 2) {
                console.error('Usage: gcal add <title> <when> [duration]');
                console.error('Example: gcal add "Meeting" "tomorrow 2pm" "1h"');
                process.exit(1);
            }

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
                }
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
