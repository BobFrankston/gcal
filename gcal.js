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
import { loadConfig, saveConfig, formatDateTime, formatDuration, parseDuration, parseDateTime, hasTimeComponent, parseAllDay, formatYMD, normalizeUser } from './glib/gutils.js';
import { setupAbortHandler, getAccessToken, apiFetch } from './glib/goauth.js';
import { extractEventsFromText, readClipboard } from './glib/aihelper.js';
import pkg from './package.json' with { type: 'json' };
const VERSION = pkg.version;
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
async function listCalendars(accessToken) {
    const url = `${CALENDAR_API_BASE}/users/me/calendarList`;
    const res = await apiFetch(url, accessToken);
    if (!res.ok) {
        throw new Error(`Failed to list calendars: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return data.items || [];
}
async function listEvents(accessToken, calendarId = 'primary', maxResults = 10, timeMin, timeMax) {
    const params = new URLSearchParams({
        maxResults: maxResults.toString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin: timeMin || new Date().toISOString()
    });
    if (timeMax)
        params.set('timeMax', timeMax);
    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    const res = await apiFetch(url, accessToken);
    if (!res.ok) {
        throw new Error(`Failed to list events: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return data.items || [];
}
async function createEvent(accessToken, event, calendarId = 'primary') {
    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
    const res = await apiFetch(url, accessToken, {
        method: 'POST',
        body: JSON.stringify(event)
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to create event: ${res.status} ${errText}`);
    }
    return await res.json();
}
async function deleteEvent(accessToken, eventId, calendarId = 'primary') {
    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const res = await apiFetch(url, accessToken, { method: 'DELETE' });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to delete event: ${res.status} ${errText}`);
    }
}
async function patchEvent(accessToken, eventId, patch, calendarId = 'primary') {
    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const res = await apiFetch(url, accessToken, {
        method: 'PATCH',
        body: JSON.stringify(patch)
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to update event: ${res.status} ${errText}`);
    }
    return await res.json();
}
/** Print warnings for events that overlap or fall within 1 hour of [start, end]. */
async function checkProximity(accessToken, calendarId, start, end, excludeBaseId) {
    const HOUR = 60 * 60_000;
    const windowMin = new Date(start.getTime() - HOUR).toISOString();
    const windowMax = new Date(end.getTime() + HOUR).toISOString();
    let nearby;
    try {
        nearby = await listEvents(accessToken, calendarId, 50, windowMin, windowMax);
    }
    catch {
        return; // Non-fatal — skip warning on fetch failure
    }
    const sMs = start.getTime();
    const eMs = end.getTime();
    const warnings = [];
    for (const e of nearby) {
        if (e.eventType === 'birthday')
            continue;
        const baseId = (e.id || '').split('_')[0];
        if (excludeBaseId && baseId === excludeBaseId)
            continue;
        if (!e.start)
            continue;
        let evStart;
        let evEnd;
        if (e.start.dateTime && e.end?.dateTime) {
            evStart = new Date(e.start.dateTime).getTime();
            evEnd = new Date(e.end.dateTime).getTime();
        }
        else if (e.start.date && e.end?.date) {
            evStart = parseAllDay(e.start.date).getTime();
            evEnd = parseAllDay(e.end.date).getTime();
        }
        else {
            continue;
        }
        const summary = e.summary || '(no title)';
        const when = formatDateTime(e.start);
        if (evStart < eMs && evEnd > sMs) {
            warnings.push(`  OVERLAPS:    ${when}  ${summary}`);
        }
        else if (evEnd <= sMs && sMs - evEnd <= HOUR) {
            const mins = Math.round((sMs - evEnd) / 60_000);
            warnings.push(`  ${String(mins).padStart(2)}m before:   ${when}  ${summary}`);
        }
        else if (evStart >= eMs && evStart - eMs <= HOUR) {
            const mins = Math.round((evStart - eMs) / 60_000);
            warnings.push(`  ${String(mins).padStart(2)}m after:    ${when}  ${summary}`);
        }
    }
    if (warnings.length > 0) {
        console.log(`\nWarning: nearby events:`);
        for (const w of warnings)
            console.log(w);
    }
}
async function importIcsFile(filePath, accessToken, calendarId = 'primary') {
    const ICAL = await import('ical.js');
    const result = { imported: 0, errors: [] };
    const icsContent = fs.readFileSync(filePath, 'utf-8');
    try {
        const jcalData = ICAL.default.parse(icsContent);
        const vcalendar = new ICAL.default.Component(jcalData);
        const vevents = vcalendar.getAllSubcomponents('vevent');
        console.log(`Found ${vevents.length} event(s)\n`);
        for (const vevent of vevents) {
            try {
                const event = new ICAL.default.Event(vevent);
                const googleEvent = {
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
                    }
                    else {
                        googleEvent.start.dateTime = startDate.toJSDate().toISOString();
                        googleEvent.start.timeZone = startDate.zone?.tzid || Intl.DateTimeFormat().resolvedOptions().timeZone;
                    }
                }
                const endDate = event.endDate;
                if (endDate) {
                    if (endDate.isDate) {
                        googleEvent.end.date = endDate.toJSDate().toISOString().split('T')[0];
                    }
                    else {
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
            }
            catch (e) {
                const summary = vevent.getFirstPropertyValue('summary') || 'unknown';
                result.errors.push(`${summary}: ${e.message}`);
                console.error(`  ! Failed: ${summary}`);
            }
        }
    }
    catch (e) {
        result.errors.push(`Parse error: ${e.message}`);
    }
    return result;
}
const USAGE_SUMMARY = `gcal v${VERSION} - Google Calendar CLI

Usage: gcal <file.ics>                Import ICS file (file association)
       gcal <command> [options]       Run command
       gcal help <command>            Detailed help for a command

Commands:
  list                          List upcoming events
  show                          Show full details for an event (-json for JSON)
  open                          Open event in browser
  add                           Add event (explicit, AI, or interactive)
  del | delete                  Delete event(s) by ID
  remind                        Add reminder(s) to existing event
  resched                       Reschedule event
  snooze                        Snooze event (default: +1d)
  import                        Import events from ICS file
  calendars                     List available calendars
  assoc                         Set up .ics file association (Windows)
  help [command]                Show help

Global options:
  -u, -user <email>             Set / use default Google account
  -c, -calendar <id>            Calendar ID (default: primary)

Companion tool: gtask  (Google Tasks - shares OAuth with gcal)
`;
const USAGE = {
    list: `gcal list [n] [-since <date>] [-till <date>] [-c <calendar>] [-b] [-v]
  List upcoming events. Default n=10.
  -since <date>   Start from date (past dates allowed)
  -till <date>    End at date
  -b              Include birthday events (hidden by default)
  -v              Verbose (show full IDs and links)

  Examples:
    gcal list
    gcal list 20
    gcal list -since "10 days ago"
    gcal list -since "april 1" -till "may 1"
    gcal list -since "april 1" -n 50
`,
    show: `gcal show <id> [-json]
  Show full details for an event (by ID prefix).
  -json           Output raw event JSON instead of human-readable text.
  Searches up to 30 days back; widen with -since.

  Examples:
    gcal show abc12345
    gcal show abc12345 -json
`,
    open: `gcal open <id>
  Open the event in your default browser (uses the htmlLink).
  Searches up to 30 days back; widen with -since.

  Examples:
    gcal open abc12345
`,
    add: `gcal add <title> <when> [duration]      Explicit
       gcal add "<free text>"                  AI-parsed single arg
       gcal add -clip                          AI-parsed from clipboard
       gcal add                                Interactive (type description)
  Add a calendar event. Default duration 1h. Use -r <dur> to add reminder(s).

  Examples:
    gcal add "Dentist" "Friday 3pm" "1h"
    gcal add "Lunch" "1/14/2026 12:00" "1h"
    gcal add "Meeting" "tomorrow 10:00"
    gcal add "Appointment" "jan 15 2pm"
    gcal add "Dentist appointment Friday 3pm for 1 hour"
    gcal add -clip
    gcal add "Dentist" "Friday 3pm" -r 30m
`,
    del: `gcal del <id> [id2...] [-all] [-b]
       gcal delete <id> [id2...]
  Delete event(s) by ID prefix.
  -all            Delete entire recurring series (not just instance)
  -b              Allow deletion of birthday events
`,
    delete: `gcal delete <id> [id2...] [-all]
  Alias for "del".
`,
    remind: `gcal remind <id> <duration> [duration2...]
  Add popup reminder(s) to an existing event.

  Examples:
    gcal remind abc12345 30m
    gcal remind abc12345 30m 1h
`,
    resched: `gcal resched <id> <when> [duration]
  Reschedule an event. Preserves duration unless [duration] given.
  If <when> lacks a time-of-day, the original time is preserved.
  All-day events stay all-day. Searches up to 30 days back by default
  (widen with -since).

  Examples:
    gcal resched abc12345 "next friday 3pm"
    gcal resched abc12345 tomorrow
    gcal resched abc12345 +1w
`,
    snooze: `gcal snooze <id> [when]
  Like resched, but defaults to +1d if no <when> given.

  Examples:
    gcal snooze abc12345
    gcal snooze abc12345 +1w
`,
    import: `gcal import <file.ics>
       gcal <file.ics>                          (via file association)
  Import events from an iCalendar file.
`,
    calendars: `gcal calendars
  List available calendars (id, name, access role).
`,
    assoc: `gcal assoc
  Set up Windows .ics file association so double-clicking imports to gcal.
`,
    help: `gcal help [command]
  Show summary, or detailed help for a single command.
`
};
function showUsage(cmd) {
    if (cmd && USAGE[cmd]) {
        console.log(USAGE[cmd]);
        return;
    }
    if (cmd) {
        console.error(`Unknown command: ${cmd}\n`);
    }
    console.log(USAGE_SUMMARY);
}
function parseArgs(argv) {
    const result = {
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
        json: false,
        reminders: [],
        helpCmd: ''
    };
    const unknown = [];
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        const flag = arg.startsWith('-') ? arg.toLowerCase() : arg;
        switch (flag) {
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
            case '-json':
            case '--json':
                result.json = true;
                break;
            case '-r':
            case '-reminder':
            case '--reminder': {
                const val = argv[++i] || '';
                const mins = parseDuration(val);
                result.reminders.push(mins);
                break;
            }
            case '-since':
            case '--since': {
                const val = argv[++i] || '';
                try {
                    result.since = parseDateTime(val);
                }
                catch {
                    console.error(`Invalid -since value: ${val}`);
                    process.exit(1);
                }
                break;
            }
            case '-till':
            case '--till': {
                const val = argv[++i] || '';
                try {
                    result.till = parseDateTime(val);
                }
                catch {
                    console.error(`Invalid -till value: ${val}`);
                    process.exit(1);
                }
                break;
            }
            case '-h':
            case '-help':
            case '--help':
                result.help = true;
                break;
            case '-version':
            case '--version':
                console.log(`gcal v${VERSION}`);
                process.exit(0);
            default:
                if (arg.startsWith('-')) {
                    unknown.push(arg);
                }
                else if (!result.command) {
                    // Check if it's an .ics file
                    if (arg.toLowerCase().endsWith('.ics')) {
                        result.icsFile = arg;
                        result.command = 'import';
                    }
                    else {
                        result.command = arg.toLowerCase();
                    }
                }
                else {
                    result.args.push(arg);
                }
        }
        i++;
    }
    if (unknown.length > 0) {
        console.error(`Unknown options: ${unknown.join(', ')}`);
        process.exit(1);
    }
    if (result.command === 'help') {
        result.help = true;
        result.helpCmd = result.args[0] || '';
    }
    return result;
}
function buildReminders(minutes) {
    if (minutes.length === 0)
        return undefined;
    return {
        useDefault: false,
        overrides: minutes.map(m => ({ method: 'popup', minutes: m }))
    };
}
/** Match events by ID prefix and dedup recurring instances to the earliest.
 *  `events` must be ordered by startTime (as returned by listEvents). */
function findByPrefix(events, prefix, includeBirthdays) {
    const prefixLower = prefix.toLowerCase();
    let matches = events.filter(e => (e.id || '').toLowerCase().startsWith(prefixLower));
    if (!includeBirthdays) {
        matches = matches.filter(e => e.eventType !== 'birthday');
    }
    const seen = new Set();
    const unique = [];
    for (const e of matches) {
        const baseId = (e.id || '').split('_')[0];
        if (!seen.has(baseId)) {
            seen.add(baseId);
            unique.push(e);
        }
    }
    return unique;
}
function checkIcsAssoc() {
    if (process.platform !== 'win32')
        return true;
    try {
        const result = execSync('cmd /c assoc .ics 2>nul', { encoding: 'utf-8' }).trim();
        if (!result.includes('icsfile'))
            return false;
        const ftype = execSync('cmd /c ftype icsfile 2>nul', { encoding: 'utf-8' }).trim();
        return ftype.includes('gcal');
    }
    catch {
        return false;
    }
}
function setIcsAssoc() {
    if (process.platform !== 'win32') {
        console.log('File associations are only supported on Windows.');
        return false;
    }
    try {
        // Use HKCU registry — no admin needed
        execSync('reg add HKCU\\Software\\Classes\\.ics /ve /d icsfile /f', { stdio: 'pipe' });
        execSync('reg add HKCU\\Software\\Classes\\icsfile\\shell\\open\\command /ve /d "gcal \\"%1\\"" /f', { stdio: 'pipe' });
        return true;
    }
    catch (e) {
        console.error(`Failed to set file association: ${e.message}`);
        return false;
    }
}
function resolveUser(cliUser) {
    if (cliUser) {
        return normalizeUser(cliUser);
    }
    const config = loadConfig();
    if (config.lastUser) {
        return config.lastUser;
    }
    return '';
}
async function main() {
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
        showUsage(parsed.helpCmd);
        if (!parsed.helpCmd && process.platform === 'win32' && !checkIcsAssoc()) {
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
        }
        else if (setIcsAssoc()) {
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
            let count = parsed.count;
            if (parsed.args.length > 0) {
                if (parsed.args.length > 1 || !/^\d+$/.test(parsed.args[0])) {
                    console.error(`Invalid list arguments: ${parsed.args.join(' ')}`);
                    console.error('Usage: gcal list [n] [-since <date>] [-till <date>]');
                    process.exit(1);
                }
                count = parseInt(parsed.args[0], 10);
            }
            const token = await getAccessToken(user, false);
            const timeMin = parsed.since ? parsed.since.toISOString() : undefined;
            const timeMax = parsed.till ? parsed.till.toISOString() : undefined;
            let events = await listEvents(token, parsed.calendar, count, timeMin, timeMax);
            const birthdayCount = events.filter(e => e.eventType === 'birthday').length;
            if (!parsed.birthdays) {
                events = events.filter(e => e.eventType !== 'birthday');
            }
            if (events.length === 0) {
                console.log(parsed.since ? 'No events found.' : 'No upcoming events found.');
            }
            else {
                const label = parsed.since
                    ? `Events since ${formatDateTime({ dateTime: parsed.since.toISOString() })}`
                    : 'Upcoming events';
                console.log(`\n${label} (${events.length}):\n`);
                // Build table data
                const rows = [];
                for (const event of events) {
                    const shortId = (event.id || '').slice(0, 8);
                    const start = event.start ? formatDateTime(event.start) : '?';
                    const duration = (event.start && event.end) ? formatDuration(event.start, event.end) : '';
                    const summary = (event.summary || '(no title)') + (event.eventType === 'birthday' ? ' [from contact]' : '');
                    const loc = event.location || '';
                    if (parsed.verbose) {
                        rows.push([shortId, start, duration, summary, loc, event.htmlLink || '']);
                    }
                    else {
                        rows.push([shortId, start, duration, summary, loc]);
                    }
                }
                // Calculate column widths
                const headers = parsed.verbose
                    ? ['ID', 'When', 'Dur', 'Event', 'Location', 'Link']
                    : ['ID', 'When', 'Dur', 'Event', 'Location'];
                const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] || '').length)));
                const lastIdx = headers.length - 1;
                const padCell = (s, i) => i === lastIdx ? s : s.padEnd(colWidths[i]);
                console.log(headers.map(padCell).join('  '));
                console.log(colWidths.map(w => '-'.repeat(w)).join('  '));
                for (const row of rows) {
                    console.log(row.map((cell, i) => padCell(cell || '', i)).join('  '));
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
                const event = {
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
                await checkProximity(token, parsed.calendar, startTime, endTime);
                const created = await createEvent(token, event, parsed.calendar);
                console.log(`\nEvent created: ${created.summary}`);
                console.log(`  When: ${formatDateTime(created.start)} - ${formatDateTime(created.end)}`);
                if (created.htmlLink) {
                    console.log(`  Link: ${created.htmlLink}`);
                }
                break;
            }
            // AI mode: freeform text from clipboard, keyboard, or single arg
            let inputText;
            if (parsed.clip) {
                console.log('Reading from clipboard...');
                inputText = readClipboard();
                if (!inputText) {
                    console.error('Clipboard is empty');
                    process.exit(1);
                }
                console.log(`Clipboard: ${inputText.substring(0, 200)}${inputText.length > 200 ? '...' : ''}`);
            }
            else if (parsed.args.length === 1) {
                inputText = parsed.args[0].trim();
                if (!inputText) {
                    console.error('Event description is empty');
                    process.exit(1);
                }
            }
            else {
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
            const token = await getAccessToken(user, true);
            const events = [];
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
                const event = {
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
                if (extracted.location)
                    console.log(`  Where: ${extracted.location}`);
                if (extracted.description)
                    console.log(`  Note:  ${extracted.description}`);
                await checkProximity(token, parsed.calendar, new Date(startDt), endDate);
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
                new Promise(resolve => setTimeout(() => {
                    console.log('\nNo response — creating event(s).');
                    resolve('');
                }, 60_000))
            ]);
            rl2.close();
            if (confirm && confirm !== 'y' && confirm !== 'yes') {
                console.log('Cancelled.');
                break;
            }
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
                const unique = findByPrefix(events, idPrefix, parsed.birthdays);
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
                const deleteId = parsed.all ? (event.id || '').split('_')[0] : event.id;
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
            const unique = findByPrefix(events, idPrefix, parsed.birthdays);
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
            const updated = await patchEvent(token, event.id, { reminders }, parsed.calendar);
            console.log(`Updated: ${updated.summary}`);
            for (const m of reminderMins) {
                console.log(`  Reminder: ${m >= 60 ? `${m / 60}h` : `${m}m`} before`);
            }
            break;
        }
        case 'resched':
        case 'reschedule':
        case 'snooze': {
            if (parsed.args.length < 1) {
                console.error('Usage: gcal resched <id> <when> [duration]');
                console.error('       gcal snooze <id> [when]   (default: +1d)');
                console.error('  e.g.: gcal resched abc12345 "next friday 3pm"');
                console.error('  e.g.: gcal resched abc12345 tomorrow');
                console.error('  e.g.: gcal snooze abc12345 +1w');
                console.error('Use "gcal list" to see event IDs');
                process.exit(1);
            }
            const idPrefix = parsed.args[0];
            let whenArg = parsed.args[1];
            const durationArg = parsed.args[2];
            // Default lookback: -since if provided, else 30 days back (so stale reminders are findable)
            const lookback = parsed.since
                ? parsed.since.toISOString()
                : new Date(Date.now() - 30 * 86400_000).toISOString();
            const token = await getAccessToken(user, true);
            const events = await listEvents(token, parsed.calendar, 250, lookback);
            const unique = findByPrefix(events, idPrefix, parsed.birthdays);
            if (unique.length === 0) {
                console.error(`${idPrefix}: not found (searched from ${lookback.slice(0, 10)})`);
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
            if (!whenArg) {
                if (parsed.command === 'snooze') {
                    whenArg = '+1d';
                }
                else {
                    console.error('Usage: gcal resched <id> <when> [duration]');
                    process.exit(1);
                }
            }
            const origIsAllDay = !!event.start?.date;
            let patch;
            let newStartDisplay;
            let newEndDisplay;
            if (origIsAllDay) {
                const origStart = parseAllDay(event.start.date);
                const origEnd = parseAllDay(event.end.date);
                const origDurDays = Math.max(1, Math.round((origEnd.getTime() - origStart.getTime()) / 86400_000));
                let newStart;
                const adv = whenArg.match(/^\+(\d+)([dw])$/i);
                if (adv) {
                    const [, n, unit] = adv;
                    const amt = parseInt(n);
                    newStart = new Date(origStart);
                    newStart.setDate(newStart.getDate() + (unit.toLowerCase() === 'w' ? amt * 7 : amt));
                }
                else {
                    newStart = parseDateTime(whenArg);
                    newStart.setHours(0, 0, 0, 0);
                }
                const newEnd = new Date(newStart);
                newEnd.setDate(newEnd.getDate() + origDurDays);
                patch = {
                    start: { date: formatYMD(newStart) },
                    end: { date: formatYMD(newEnd) }
                };
                newStartDisplay = { date: formatYMD(newStart) };
                newEndDisplay = { date: formatYMD(newEnd) };
            }
            else {
                const origStart = new Date(event.start.dateTime);
                const origEnd = new Date(event.end.dateTime);
                const origDurMs = origEnd.getTime() - origStart.getTime();
                let newStart;
                const adv = whenArg.match(/^\+(\d+)([dwhm])$/i);
                if (adv) {
                    const [, n, unit] = adv;
                    const amt = parseInt(n);
                    newStart = new Date(origStart);
                    switch (unit.toLowerCase()) {
                        case 'd':
                            newStart.setDate(newStart.getDate() + amt);
                            break;
                        case 'w':
                            newStart.setDate(newStart.getDate() + amt * 7);
                            break;
                        case 'h':
                            newStart.setHours(newStart.getHours() + amt);
                            break;
                        case 'm':
                            newStart.setMinutes(newStart.getMinutes() + amt);
                            break;
                    }
                }
                else {
                    newStart = parseDateTime(whenArg);
                    if (!hasTimeComponent(whenArg)) {
                        newStart.setHours(origStart.getHours(), origStart.getMinutes(), 0, 0);
                    }
                }
                const durMs = durationArg ? parseDuration(durationArg) * 60_000 : origDurMs;
                const newEnd = new Date(newStart.getTime() + durMs);
                const tz = event.start.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
                patch = {
                    start: { dateTime: newStart.toISOString(), timeZone: tz },
                    end: { dateTime: newEnd.toISOString(), timeZone: tz }
                };
                newStartDisplay = patch.start;
                newEndDisplay = patch.end;
            }
            // Proximity check for timed events (skip all-day)
            if (!origIsAllDay && patch.start?.dateTime && patch.end?.dateTime) {
                await checkProximity(token, parsed.calendar, new Date(patch.start.dateTime), new Date(patch.end.dateTime), (event.id || '').split('_')[0]);
            }
            const updated = await patchEvent(token, event.id, patch, parsed.calendar);
            console.log(`Rescheduled: ${updated.summary}`);
            console.log(`  From: ${formatDateTime(event.start)} - ${formatDateTime(event.end)}`);
            console.log(`  To:   ${formatDateTime(newStartDisplay)} - ${formatDateTime(newEndDisplay)}`);
            break;
        }
        case 'show': {
            if (parsed.args.length < 1) {
                console.error('Usage: gcal show <id> [-json]');
                console.error('Use "gcal list" to see event IDs');
                process.exit(1);
            }
            const idPrefix = parsed.args[0];
            const lookback = parsed.since
                ? parsed.since.toISOString()
                : new Date(Date.now() - 30 * 86400_000).toISOString();
            const timeMax = parsed.till ? parsed.till.toISOString() : undefined;
            const token = await getAccessToken(user, false);
            const events = await listEvents(token, parsed.calendar, 250, lookback, timeMax);
            const unique = findByPrefix(events, idPrefix, parsed.birthdays);
            if (unique.length === 0) {
                console.error(`${idPrefix}: not found (searched from ${lookback.slice(0, 10)})`);
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
            if (parsed.json) {
                console.log(JSON.stringify(event, null, 2));
                break;
            }
            console.log(`\n${event.summary || '(no title)'}`);
            const duration = (event.start && event.end) ? formatDuration(event.start, event.end) : '';
            const whenLine = event.start && event.end
                ? `${formatDateTime(event.start)} - ${formatDateTime(event.end)}${duration ? `  (${duration})` : ''}`
                : '?';
            console.log(`  When:      ${whenLine}`);
            if (event.start?.timeZone) {
                console.log(`  TZ:        ${event.start.timeZone}`);
            }
            if (event.location)
                console.log(`  Where:     ${event.location}`);
            if (event.description) {
                const indented = event.description.split('\n').map((l, i) => i === 0 ? l : `             ${l}`).join('\n');
                console.log(`  Notes:     ${indented}`);
            }
            if (event.recurrence?.length) {
                console.log(`  Repeat:    ${event.recurrence.join('; ')}`);
            }
            if (event.recurringEventId) {
                console.log(`  Series ID: ${event.recurringEventId}`);
            }
            if (event.attendees?.length) {
                console.log(`  Attendees:`);
                for (const a of event.attendees) {
                    const name = a.displayName ? `${a.displayName} <${a.email}>` : (a.email || '?');
                    const status = a.responseStatus ? ` [${a.responseStatus}]` : '';
                    const role = a.organizer ? ' (organizer)' : a.optional ? ' (optional)' : '';
                    console.log(`    ${name}${status}${role}`);
                }
            }
            if (event.reminders?.overrides?.length) {
                console.log(`  Reminders:`);
                for (const r of event.reminders.overrides) {
                    const m = r.minutes || 0;
                    const dur = m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`;
                    console.log(`    ${dur} (${r.method || 'popup'})`);
                }
            }
            else if (event.reminders?.useDefault) {
                console.log(`  Reminders: (calendar default)`);
            }
            if (event.creator?.email) {
                console.log(`  Creator:   ${event.creator.displayName ? `${event.creator.displayName} <${event.creator.email}>` : event.creator.email}`);
            }
            if (event.organizer?.email && event.organizer.email !== event.creator?.email) {
                console.log(`  Organizer: ${event.organizer.displayName ? `${event.organizer.displayName} <${event.organizer.email}>` : event.organizer.email}`);
            }
            if (event.hangoutLink)
                console.log(`  Meet:      ${event.hangoutLink}`);
            if (event.htmlLink)
                console.log(`  Link:      ${event.htmlLink}`);
            console.log(`  Status:    ${event.status || 'confirmed'}`);
            if (event.created)
                console.log(`  Created:   ${formatDateTime({ dateTime: event.created })}`);
            if (event.updated)
                console.log(`  Updated:   ${formatDateTime({ dateTime: event.updated })}`);
            console.log(`  ID:        ${event.id}`);
            break;
        }
        case 'open': {
            if (parsed.args.length < 1) {
                console.error('Usage: gcal open <id>');
                console.error('Use "gcal list" to see event IDs');
                process.exit(1);
            }
            const idPrefix = parsed.args[0];
            const lookback = parsed.since
                ? parsed.since.toISOString()
                : new Date(Date.now() - 30 * 86400_000).toISOString();
            const timeMax = parsed.till ? parsed.till.toISOString() : undefined;
            const token = await getAccessToken(user, false);
            const events = await listEvents(token, parsed.calendar, 250, lookback, timeMax);
            const unique = findByPrefix(events, idPrefix, parsed.birthdays);
            if (unique.length === 0) {
                console.error(`${idPrefix}: not found (searched from ${lookback.slice(0, 10)})`);
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
            if (!event.htmlLink) {
                console.error(`${idPrefix}: event has no htmlLink`);
                process.exit(1);
            }
            console.log(`Opening: ${event.summary || '(no title)'}`);
            console.log(`  ${event.htmlLink}`);
            if (process.platform === 'win32') {
                execSync(`start "" "${event.htmlLink}"`, { stdio: 'ignore', shell: 'cmd.exe' });
            }
            else if (process.platform === 'darwin') {
                execSync(`open "${event.htmlLink}"`, { stdio: 'ignore' });
            }
            else {
                execSync(`xdg-open "${event.htmlLink}"`, { stdio: 'ignore' });
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
    main()
        .then(() => process.exit(0))
        .catch(e => {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    });
}
//# sourceMappingURL=gcal.js.map