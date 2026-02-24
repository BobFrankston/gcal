#!/usr/bin/env node
/**
 * gcal - Google Calendar CLI tool
 * Manage Google Calendar events with ICS import support
 *
 * Can be associated with .ics files for direct import:
 *   gcal assoc
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { authenticateOAuth } from '@bobfrankston/oauthsupport';
import { CREDENTIALS_FILE, loadConfig, saveConfig, getUserPaths, ensureUserDir, formatDateTime, formatDuration, parseDuration, parseDateTime, ts, normalizeUser } from './glib/gutils.js';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_SCOPE_READ = 'https://www.googleapis.com/auth/calendar.readonly';
const CALENDAR_SCOPE_WRITE = 'https://www.googleapis.com/auth/calendar';
let abortController = null;
function setupAbortHandler() {
    abortController = new AbortController();
    process.on('SIGINT', () => {
        abortController?.abort();
        console.log('\n\nCtrl+C pressed - aborting...');
    });
}
async function getAccessToken(user, writeAccess = false, forceRefresh = false) {
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
async function apiFetch(url, accessToken, options = {}) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers
    };
    return fetch(url, { ...options, headers });
}
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
async function updateEvent(accessToken, eventId, body, calendarId = 'primary') {
    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const res = await apiFetch(url, accessToken, {
        method: 'PATCH',
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to update event: ${res.status} ${errText}`);
    }
    return await res.json();
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
function setupFileAssociation() {
    if (process.platform !== 'win32') {
        console.error('File association is only supported on Windows.');
        process.exit(1);
    }
    const classKey = 'HKCU\\Software\\Classes';
    const command = `cmd.exe /c gcal "%1"`;
    try {
        execSync(`reg add "${classKey}\\.ics" /ve /d "gcalFile" /f`, { stdio: 'pipe' });
        execSync(`reg add "${classKey}\\gcalFile\\shell\\open\\command" /ve /d "${command}" /f`, { stdio: 'pipe' });
        console.log('.ics file association set — double-click any .ics to import via gcal');
    }
    catch (e) {
        console.error(`Failed to set file association: ${e.message}`);
        process.exit(1);
    }
}
/** Clean up URLs — replace https URLs with [sitename] labels */
function cleanUrls(text) {
    if (!text)
        return text;
    return text.replace(/https?:\/\/([^\/\s]+)\S*/gi, (_match, host) => {
        // Extract meaningful site name from hostname
        const parts = host.split('.');
        // Drop common prefixes (www, us02web, events, etc.) and TLD suffixes
        // Keep the main domain name: "us02web.zoom.us" → "Zoom", "events.vtools.ieee.org" → "ieee"
        if (parts.length >= 2) {
            const domain = parts.length > 2 ? parts[parts.length - 2] : parts[0];
            return `[${domain.charAt(0).toUpperCase() + domain.slice(1)}]`;
        }
        return '[link]';
    });
}
function showUsage() {
    console.log(`
gcal - Google Calendar CLI

Usage:
  gcal <file.ics>                    Import ICS file (file association)
  gcal <command> [options]           Run command

Commands:
  list [n]                           List upcoming n events (default: 10)
  add <title> <when> [duration]      Add event
  del|delete <id> [id2...]           Delete event(s) by ID (prefix match)
  update <id> [flags]                Update event by ID (prefix match)
  import <file.ics>                  Import events from ICS file
  calendars                          List available calendars
  assoc                              Associate .ics files with gcal (Windows)
  help                               Show this help

Options:
  -u, -user <email>        Google account (one-time)
  -defaultUser <email>     Set default user for future use
  -c, -calendar <id>       Calendar ID (default: primary)
  -n <count>               Number of events to list
  -limit <span>            Time horizon for list: #d, #w, #m, #y (default: 3m)
  -v, -verbose             Show event IDs and links
  -b, -birthdays            Include birthday events (hidden by default)
  -title <text>            New title (update command)
  -loc <text>              New location (update command)
  -start <when>            New start time (update command)
  -dur <duration>          New duration (update command)
  -r <spec>                Reminders: #m, #h, #d with optional :email/:popup
                             -r 0          No reminders
                             -r 30m        30 min popup (default kind)
                             -r 1h:email   1 hour email
                             -r 15m,1h     Multiple: comma-separated

Examples:
  gcal meeting.ics                        Import ICS file
  gcal list                               List next 10 events
  gcal add "Dentist" "Friday 3pm" "1h"
  gcal add "Lunch" "1/14/2026 12:00" "1h"
  gcal add "Meeting" "tomorrow 10:00"
  gcal add "Appointment" "jan 15 2pm"
  gcal add "Call" "tomorrow 3pm" "30m" -r 15m,1h:email
  gcal update abc1 -title "New Title" -loc "Room 5"
  gcal update abc1 -start "friday 3pm" -dur 2h
  gcal update abc1 -r 15m,1h:email
  gcal -defaultUser bob@gmail.com         Set default user

File Association (Windows):
  gcal assoc                              Set up .ics file association
`);
}
/** Parse a reminder spec like "30m", "1h", "2d", "30m:email", "1h:popup" */
function parseReminder(spec) {
    // Split on colon for method: "30m:email" or just "30m"
    const [timePart, methodPart] = spec.split(':');
    const method = methodPart === 'email' ? 'email' : 'popup';
    const match = timePart.match(/^(\d+)\s*([mhd]?)$/i);
    if (!match) {
        console.error(`Invalid reminder: "${spec}" — use #m, #h, or #d (e.g. 30m, 1h, 2d)`);
        process.exit(1);
    }
    const num = parseInt(match[1]);
    const unit = (match[2] || 'm').toLowerCase();
    let minutes;
    switch (unit) {
        case 'h':
            minutes = num * 60;
            break;
        case 'd':
            minutes = num * 60 * 24;
            break;
        default:
            minutes = num;
            break;
    }
    return { method, minutes };
}
/** Parse a time limit spec like "3m", "1y", "2w", "90d" into a future Date */
function parseTimeLimit(spec) {
    const match = spec.match(/^(\d+)\s*([dwmy]?)$/i);
    if (!match) {
        console.error(`Invalid time limit: "${spec}" — use #d, #w, #m, or #y (e.g. 3m, 90d, 1y)`);
        process.exit(1);
    }
    const num = parseInt(match[1]);
    const unit = (match[2] || 'm').toLowerCase();
    const now = new Date();
    switch (unit) {
        case 'd':
            now.setDate(now.getDate() + num);
            break;
        case 'w':
            now.setDate(now.getDate() + num * 7);
            break;
        case 'y':
            now.setFullYear(now.getFullYear() + num);
            break;
        default:
            now.setMonth(now.getMonth() + num);
            break; // 'm' = months
    }
    return now;
}
function parseArgs(argv) {
    const result = {
        command: '',
        args: [],
        user: '',
        defaultUser: '',
        calendar: 'primary',
        count: 10,
        help: false,
        verbose: false,
        icsFile: '',
        birthdays: false,
        reminders: [],
        noReminders: false,
        timeLimit: '3m',
        title: '',
        location: '',
        startTime: '',
        duration: ''
    };
    const unknown = [];
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
            case '-limit':
            case '--limit':
                result.timeLimit = argv[++i] || '3m';
                break;
            case '-title':
            case '--title':
                result.title = argv[++i] || '';
                break;
            case '-loc':
            case '-location':
            case '--location':
                result.location = argv[++i] || '';
                break;
            case '-start':
            case '--start':
                result.startTime = argv[++i] || '';
                break;
            case '-dur':
            case '-duration':
            case '--duration':
                result.duration = argv[++i] || '';
                break;
            case '-r':
            case '-reminder':
            case '--reminder': {
                const rval = argv[++i] || '';
                if (rval === '0' || rval === 'none') {
                    result.noReminders = true;
                }
                else {
                    for (const part of rval.split(',')) {
                        const reminder = parseReminder(part.trim());
                        if (reminder)
                            result.reminders.push(reminder);
                    }
                }
                break;
            }
            case '-h':
            case '-help':
            case '--help':
            case 'help':
                result.help = true;
                break;
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
                        result.command = arg;
                    }
                }
                else {
                    result.args.push(arg);
                }
        }
        i++;
    }
    if (unknown.length > 0) {
        console.error(`Unknown options: ${unknown.join(', ')}\n`);
        showUsage();
        process.exit(1);
    }
    return result;
}
function resolveUser(cliUser, setAsDefault = false) {
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
async function main() {
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
    // Commands that don't need a user
    if (parsed.command === 'assoc') {
        setupFileAssociation();
        process.exit(0);
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
            const timeMax = parseTimeLimit(parsed.timeLimit).toISOString();
            const token = await getAccessToken(user, false);
            let events = await listEvents(token, parsed.calendar, count, undefined, timeMax);
            const birthdayCount = events.filter(e => e.eventType === 'birthday').length;
            if (!parsed.birthdays) {
                events = events.filter(e => e.eventType !== 'birthday');
            }
            if (events.length === 0) {
                console.log('No upcoming events found.');
            }
            else {
                console.log(`\nUpcoming events (${events.length}):\n`);
                // Build table data
                const rows = [];
                for (const event of events) {
                    const shortId = (event.id || '').slice(0, 8);
                    const start = event.start ? formatDateTime(event.start) : '?';
                    const duration = (event.start && event.end) ? formatDuration(event.start, event.end) : '';
                    const summary = cleanUrls(event.summary || '(no title)') + (event.eventType === 'birthday' ? ' [from contact]' : '');
                    const loc = cleanUrls(event.location || '');
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
                // Print header
                const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join(' ');
                console.log(headerLine);
                console.log(colWidths.map(w => '-'.repeat(w)).join(' '));
                // Print rows — last column not padded to avoid trailing whitespace
                for (const row of rows) {
                    const lastIdx = row.length - 1;
                    const line = row.map((cell, i) => i < lastIdx ? (cell || '').padEnd(colWidths[i]) : (cell || '')).join(' ');
                    console.log(line);
                }
            }
            if (birthdayCount > 0 && !parsed.birthdays) {
                console.log(`\n(${birthdayCount} birthday${birthdayCount > 1 ? 's' : ''} hidden, -b to show)`);
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
            const event = {
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
            if (parsed.noReminders) {
                event.reminders = { useDefault: false, overrides: [] };
            }
            else if (parsed.reminders.length > 0) {
                event.reminders = { useDefault: false, overrides: parsed.reminders };
            }
            const token = await getAccessToken(user, true);
            const created = await createEvent(token, event, parsed.calendar);
            console.log(`\nEvent created: ${created.summary}`);
            console.log(`  When: ${formatDateTime(created.start)} - ${formatDateTime(created.end)}`);
            if (parsed.noReminders) {
                console.log(`  Reminders: none`);
            }
            else if (parsed.reminders.length > 0) {
                const rlist = parsed.reminders.map(r => {
                    const mins = r.minutes;
                    const label = mins >= 1440 ? `${mins / 1440}d` : mins >= 60 ? `${mins / 60}h` : `${mins}m`;
                    return `${label}${r.method === 'email' ? ':email' : ''}`;
                }).join(', ');
                console.log(`  Reminders: ${rlist}`);
            }
            if (created.htmlLink) {
                console.log(`  Link: ${created.htmlLink}`);
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
                const matches = events.filter(e => e.id?.startsWith(idPrefix));
                if (matches.length === 0) {
                    console.error(`${idPrefix}: not found`);
                    continue;
                }
                if (matches.length > 1) {
                    console.error(`${idPrefix}: ambiguous (${matches.length} matches)`);
                    for (const e of matches) {
                        // Show enough ID to distinguish recurring instances (base_date)
                        const displayId = (e.id || '').length > 12 ? e.id.slice(0, 16) : e.id?.slice(0, 8);
                        const cleaned = cleanUrls(e.summary || '');
                        const summary = cleaned.length > 60 ? cleaned.slice(0, 57) + '...' : cleaned;
                        const when = e.start ? formatDateTime(e.start) : '';
                        console.error(`  ${displayId} ${when} ${summary}`);
                    }
                    continue;
                }
                const event = matches[0];
                if (event.eventType === 'birthday' && !parsed.birthdays) {
                    console.log(`Skipped birthday: ${event.summary} (use -birthdays to include)`);
                    continue;
                }
                await deleteEvent(token, event.id, parsed.calendar);
                console.log(`Deleted: ${cleanUrls(event.summary || '')}`);
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
        case 'update': {
            if (parsed.args.length === 0) {
                console.error('Usage: gcal update <id> [-title "..."] [-loc "..."] [-start "..."] [-dur "..."] [-r ...]');
                console.error('Use "gcal list -v" to see event IDs');
                process.exit(1);
            }
            const idPrefix = parsed.args[0];
            const token = await getAccessToken(user, true);
            const events = await listEvents(token, parsed.calendar, 50);
            const matches = events.filter(e => e.id?.startsWith(idPrefix));
            if (matches.length === 0) {
                console.error(`${idPrefix}: not found`);
                process.exit(1);
            }
            if (matches.length > 1) {
                console.error(`${idPrefix}: ambiguous (${matches.length} matches)`);
                for (const e of matches) {
                    const displayId = (e.id || '').length > 12 ? e.id.slice(0, 16) : e.id?.slice(0, 8);
                    const cleaned = cleanUrls(e.summary || '');
                    const summary = cleaned.length > 60 ? cleaned.slice(0, 57) + '...' : cleaned;
                    const when = e.start ? formatDateTime(e.start) : '';
                    console.error(`  ${displayId} ${when} ${summary}`);
                }
                process.exit(1);
            }
            const target = matches[0];
            const body = {};
            const changes = [];
            if (parsed.title) {
                body.summary = parsed.title;
                changes.push(`title → "${parsed.title}"`);
            }
            if (parsed.location) {
                body.location = parsed.location;
                changes.push(`location → "${parsed.location}"`);
            }
            if (parsed.startTime) {
                const newStart = parseDateTime(parsed.startTime);
                const durationMs = parsed.duration
                    ? parseDuration(parsed.duration) * 60 * 1000
                    : (target.end?.dateTime && target.start?.dateTime)
                        ? new Date(target.end.dateTime).getTime() - new Date(target.start.dateTime).getTime()
                        : 60 * 60 * 1000;
                const newEnd = new Date(newStart.getTime() + durationMs);
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                body.start = { dateTime: newStart.toISOString(), timeZone: tz };
                body.end = { dateTime: newEnd.toISOString(), timeZone: tz };
                changes.push(`start → ${formatDateTime(body.start)}`);
                if (parsed.duration)
                    changes.push(`duration → ${parsed.duration}`);
            }
            else if (parsed.duration) {
                // Duration change without start change — shift end time
                if (target.start?.dateTime) {
                    const startMs = new Date(target.start.dateTime).getTime();
                    const newEnd = new Date(startMs + parseDuration(parsed.duration) * 60 * 1000);
                    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                    body.end = { dateTime: newEnd.toISOString(), timeZone: tz };
                    changes.push(`duration → ${parsed.duration}`);
                }
                else {
                    console.error('Cannot change duration of all-day event');
                    process.exit(1);
                }
            }
            if (parsed.noReminders) {
                body.reminders = { useDefault: false, overrides: [] };
                changes.push('reminders → none');
            }
            else if (parsed.reminders.length > 0) {
                body.reminders = { useDefault: false, overrides: parsed.reminders };
                const rlist = parsed.reminders.map(r => {
                    const mins = r.minutes;
                    const label = mins >= 1440 ? `${mins / 1440}d` : mins >= 60 ? `${mins / 60}h` : `${mins}m`;
                    return `${label}${r.method === 'email' ? ':email' : ''}`;
                }).join(', ');
                changes.push(`reminders → ${rlist}`);
            }
            if (changes.length === 0) {
                console.error('No update flags provided. Use -title, -loc, -start, -dur, or -r');
                process.exit(1);
            }
            const updated = await updateEvent(token, target.id, body, parsed.calendar);
            console.log(`\nUpdated: ${cleanUrls(updated.summary || '')}`);
            for (const c of changes) {
                console.log(`  ${c}`);
            }
            break;
        }
        case 'assoc': {
            setupFileAssociation();
            break;
        }
        default:
            console.error(`Unknown command: ${parsed.command}`);
            showUsage();
            process.exit(1);
    }
}
if (import.meta.main) {
    main().then(() => {
        process.exitCode = 0;
    }).catch(e => {
        console.error(`Error: ${e.message}`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=gcal.js.map