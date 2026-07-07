/**
 * Shared utilities for gcal tools
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
export const APP_DIR = path.dirname(import.meta.dirname); // Parent of glib/
/** Get the app directory (%APPDATA%\gcal or ~/.config/gcal) */
export function getAppDir() {
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || os.homedir(), 'gcal');
    }
    return path.join(os.homedir(), '.config', 'gcal');
}
/** Get the data directory (app directory/data, or local data/ symlink for dev) */
export function getDataDir() {
    const localData = path.join(APP_DIR, 'data');
    if (fs.existsSync(localData)) {
        return localData;
    }
    return path.join(getAppDir(), 'data');
}
export const DATA_DIR = getDataDir();
export const CONFIG_FILE = path.join(getAppDir(), 'config.json');
/** OAuth credentials shipped with the package */
export const CREDENTIALS_FILE = path.join(APP_DIR, 'gcal-credentials.json');
export function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        }
        catch (e) {
            throw new Error(`Failed to parse ${CONFIG_FILE}: ${e.message}`);
        }
    }
    return {};
}
export function saveConfig(config) {
    const appDir = getAppDir();
    if (!fs.existsSync(appDir)) {
        fs.mkdirSync(appDir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
export function getUserPaths(user) {
    const userDir = path.join(DATA_DIR, user);
    return {
        userDir,
        eventsDir: path.join(userDir, 'events'),
        tokenFile: path.join(userDir, 'token.json'),
        tokenWriteFile: path.join(userDir, 'token-write.json'),
        syncTokenFile: path.join(userDir, 'sync-token.json'),
        configFile: path.join(userDir, 'config.json')
    };
}
export function ensureUserDir(user) {
    const paths = getUserPaths(user);
    if (!fs.existsSync(paths.userDir)) {
        fs.mkdirSync(paths.userDir, { recursive: true });
    }
    if (!fs.existsSync(paths.eventsDir)) {
        fs.mkdirSync(paths.eventsDir, { recursive: true });
    }
}
export function normalizeUser(user) {
    return user.toLowerCase().split(/[+@]/)[0].replace(/\./g, '');
}
export function getAllUsers() {
    if (!fs.existsSync(DATA_DIR)) {
        return [];
    }
    return fs.readdirSync(DATA_DIR)
        .filter(f => {
        const fullPath = path.join(DATA_DIR, f);
        return fs.statSync(fullPath).isDirectory() && !f.startsWith('.');
    });
}
export function matchUsers(pattern) {
    const allUsers = getAllUsers();
    const normalizedPattern = pattern.toLowerCase();
    return allUsers.filter(user => user.toLowerCase().includes(normalizedPattern));
}
export function resolveUser(cliUser, setAsDefault = false) {
    if (cliUser && cliUser !== 'default') {
        const normalized = normalizeUser(cliUser);
        const matches = matchUsers(normalized);
        if (matches.length === 1) {
            const matched = matches[0];
            console.log(`Matched '${cliUser}' to existing user: ${matched}`);
            if (setAsDefault) {
                const config = loadConfig();
                config.lastUser = matched;
                saveConfig(config);
            }
            return matched;
        }
        else if (matches.length > 1) {
            console.error(`Ambiguous user '${cliUser}' matches multiple users: ${matches.join(', ')}`);
            console.error('Please be more specific.');
            process.exit(1);
        }
        if (!cliUser.includes('@')) {
            console.error(`New user '${cliUser}' must be specified as an email address (e.g., ${cliUser}@gmail.com)`);
            process.exit(1);
        }
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
    const allUsers = getAllUsers();
    if (allUsers.length === 1) {
        const onlyUser = allUsers[0];
        console.log(`Auto-selected only user: ${onlyUser}`);
        config.lastUser = onlyUser;
        saveConfig(config);
        return onlyUser;
    }
    if (allUsers.length > 1) {
        console.error(`Multiple users exist: ${allUsers.join(', ')}`);
        console.error('Use -u <name> to select one.');
    }
    else {
        console.error('No user specified. Use -u <email> on first run (e.g., your Gmail address).');
    }
    process.exit(1);
}
const WEEKDAY_ABBR = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** Format datetime for display - "dow yyyy-mm-dd HH:mm" (or "dow yyyy-mm-dd" for all-day) */
export function formatDateTime(dt) {
    if (dt.date) {
        const dow = WEEKDAY_ABBR[parseAllDay(dt.date).getDay()];
        return `${dow} ${dt.date}`;
    }
    if (dt.dateTime) {
        const d = new Date(dt.dateTime);
        const dow = WEEKDAY_ABBR[d.getDay()];
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        return `${dow} ${yyyy}-${mm}-${dd} ${hh}:${min}`;
    }
    return '(no time)';
}
/** Offset (ms) of an IANA timezone from UTC at a given instant. */
function tzOffsetMs(utcMs, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(utcMs));
    const get = (t) => Number(parts.find(p => p.type === t)?.value);
    const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return wallAsUtc - utcMs;
}
/**
 * Convert a bare wall-clock string ("YYYY-MM-DDTHH:mm[:ss]", no offset) in an
 * IANA timezone to the actual UTC instant. Strings that already carry an
 * offset (Z or +hh:mm) fall through to normal Date parsing.
 */
export function zonedWallClockToDate(dateTime, timeZone) {
    const m = dateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m)
        return new Date(dateTime);
    const wallAsUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    let offset = tzOffsetMs(wallAsUtc, timeZone);
    // Refine once in case the first guess straddles a DST transition
    const offset2 = tzOffsetMs(wallAsUtc - offset, timeZone);
    if (offset2 !== offset)
        offset = offset2;
    return new Date(wallAsUtc - offset);
}
/** Format duration in hours (e.g., "1.5 hrs", "2 hrs", "30 min") */
export function formatDuration(start, end) {
    if (start.date || end.date) {
        return ''; // All-day event
    }
    if (!start.dateTime || !end.dateTime) {
        return '';
    }
    const startMs = new Date(start.dateTime).getTime();
    const endMs = new Date(end.dateTime).getTime();
    const mins = (endMs - startMs) / 60000;
    if (mins === 0)
        return '';
    if (mins < 60) {
        return `${mins} min`;
    }
    const hrs = mins / 60;
    if (hrs === Math.floor(hrs)) {
        return `${hrs} hr${hrs !== 1 ? 's' : ''}`;
    }
    return `${hrs.toFixed(1)} hrs`;
}
/** Parse duration string like "1h", "30m", "1h30m" to minutes */
export function parseDuration(duration) {
    let minutes = 0;
    const hourMatch = duration.match(/(\d+)h/i);
    const minMatch = duration.match(/(\d+)m/i);
    if (hourMatch)
        minutes += parseInt(hourMatch[1]) * 60;
    if (minMatch)
        minutes += parseInt(minMatch[1]);
    if (!hourMatch && !minMatch) {
        minutes = parseInt(duration) || 60; // Default 60 minutes
    }
    return minutes;
}
/** Parse natural date/time strings.
 *  opts.preferFuture: a bare time (no date) that has already passed today rolls to tomorrow. */
export function parseDateTime(input, opts) {
    const now = new Date();
    const lower = input.toLowerCase().trim()
        .replace(/\bnoon\b/g, '12pm')
        .replace(/\bmidnight\b/g, '12am');
    // Handle relative dates
    if (lower === 'today') {
        return now;
    }
    if (lower === 'tomorrow') {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        return d;
    }
    if (lower === 'yesterday') {
        const d = new Date(now);
        d.setDate(d.getDate() - 1);
        return d;
    }
    // Handle "N days/weeks/months/years ago"
    const agoMatch = lower.match(/^(\d+)\s+(day|week|month|year)s?\s+ago$/);
    if (agoMatch) {
        const [, n, unit] = agoMatch;
        const amount = parseInt(n);
        const d = new Date(now);
        switch (unit) {
            case 'day':
                d.setDate(d.getDate() - amount);
                break;
            case 'week':
                d.setDate(d.getDate() - amount * 7);
                break;
            case 'month':
                d.setMonth(d.getMonth() - amount);
                break;
            case 'year':
                d.setFullYear(d.getFullYear() - amount);
                break;
        }
        return d;
    }
    // Handle future intervals: "1 week", "2 days", "in 3 months", "3 months from now"
    const futureMatch = lower.match(/^(?:in\s+)?(\d+)\s+(day|week|month|year)s?(?:\s+from\s+now)?$/);
    if (futureMatch) {
        const [, n, unit] = futureMatch;
        const amount = parseInt(n);
        const d = new Date(now);
        switch (unit) {
            case 'day':
                d.setDate(d.getDate() + amount);
                break;
            case 'week':
                d.setDate(d.getDate() + amount * 7);
                break;
            case 'month':
                d.setMonth(d.getMonth() + amount);
                break;
            case 'year':
                d.setFullYear(d.getFullYear() + amount);
                break;
        }
        return d;
    }
    // Handle shorthand future intervals: "+1w", "+2d", "+3h", "+30m"
    const shortMatch = lower.match(/^\+(\d+)([dwhm])$/);
    if (shortMatch) {
        const [, n, unit] = shortMatch;
        const amount = parseInt(n);
        const d = new Date(now);
        switch (unit) {
            case 'd':
                d.setDate(d.getDate() + amount);
                break;
            case 'w':
                d.setDate(d.getDate() + amount * 7);
                break;
            case 'h':
                d.setHours(d.getHours() + amount);
                break;
            case 'm':
                d.setMinutes(d.getMinutes() + amount);
                break;
        }
        return d;
    }
    // Handle "tomorrow 2pm" or "yesterday at 2pm" etc.
    const relMatch = lower.match(/^(today|tomorrow|yesterday)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (relMatch) {
        const [, rel, hour, min, ampm] = relMatch;
        const d = new Date(now);
        if (rel === 'tomorrow')
            d.setDate(d.getDate() + 1);
        else if (rel === 'yesterday')
            d.setDate(d.getDate() - 1);
        let h = parseInt(hour);
        if (ampm?.toLowerCase() === 'pm' && h < 12)
            h += 12;
        if (ampm?.toLowerCase() === 'am' && h === 12)
            h = 0;
        d.setHours(h, parseInt(min || '0'), 0, 0);
        return d;
    }
    // Handle weekday names (full or 3-letter abbrev: sun/mon/tue/wed/thu/fri/sat)
    const weekdayAbbr = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const dayMatch = lower.match(/^(next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (dayMatch) {
        const [, next, day, hour, min, ampm] = dayMatch;
        const targetDay = weekdayAbbr.indexOf(day.toLowerCase().slice(0, 3));
        const d = new Date(now);
        let daysUntil = targetDay - d.getDay();
        if (daysUntil <= 0 || next)
            daysUntil += 7;
        d.setDate(d.getDate() + daysUntil);
        let h = parseInt(hour);
        if (ampm?.toLowerCase() === 'pm' && h < 12)
            h += 12;
        if (ampm?.toLowerCase() === 'am' && h === 12)
            h = 0;
        d.setHours(h, parseInt(min || '0'), 0, 0);
        return d;
    }
    // Handle weekday name alone: "wed", "next wed", "friday" -> that day at midnight
    const dayOnlyMatch = lower.match(/^(next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/i);
    if (dayOnlyMatch) {
        const [, next, day] = dayOnlyMatch;
        const targetDay = weekdayAbbr.indexOf(day.toLowerCase().slice(0, 3));
        const d = new Date(now);
        let daysUntil = targetDay - d.getDay();
        if (daysUntil <= 0 || next)
            daysUntil += 7;
        d.setDate(d.getDate() + daysUntil);
        d.setHours(0, 0, 0, 0);
        return d;
    }
    // Handle month names: "jan 15", "jan 15 2026", "jan 15 3pm", "january 15 2026 3pm"
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthMatch = lower.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:\s+(\d{4}))?(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
    if (monthMatch) {
        const [, month, day, year, hour, min, ampm] = monthMatch;
        const monthIndex = months.findIndex(m => month.toLowerCase().startsWith(m));
        const d = new Date(parseInt(year || now.getFullYear().toString()), monthIndex, parseInt(day));
        if (hour) {
            let h = parseInt(hour);
            if (ampm?.toLowerCase() === 'pm' && h < 12)
                h += 12;
            if (ampm?.toLowerCase() === 'am' && h === 12)
                h = 0;
            d.setHours(h, parseInt(min || '0'), 0, 0);
        }
        else {
            d.setHours(0, 0, 0, 0);
        }
        if (!isNaN(d.getTime())) {
            return d;
        }
    }
    // Handle explicit date/time formats: "MM/DD/YYYY HH:mm" or "YYYY-MM-DD HH:mm"
    const dateTimeMatch = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (dateTimeMatch) {
        const [, month, day, year, hour, min] = dateTimeMatch;
        const d = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(min));
        if (!isNaN(d.getTime())) {
            return d;
        }
    }
    const isoDateTimeMatch = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (isoDateTimeMatch) {
        const [, year, month, day, hour, min] = isoDateTimeMatch;
        const d = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(min));
        if (!isNaN(d.getTime())) {
            return d;
        }
    }
    // Handle time only (HH:mm) - assume today
    const timeMatch = input.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
        const [, hour, min] = timeMatch;
        const d = new Date(now);
        d.setHours(parseInt(hour), parseInt(min), 0, 0);
        if (opts?.preferFuture && d.getTime() <= now.getTime())
            d.setDate(d.getDate() + 1);
        return d;
    }
    // Handle time with am/pm (2pm, 10am, 2:30pm) - assume today
    const ampmMatch = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
    if (ampmMatch) {
        const [, hour, min, ampm] = ampmMatch;
        let h = parseInt(hour);
        if (ampm === 'pm' && h < 12)
            h += 12;
        if (ampm === 'am' && h === 12)
            h = 0;
        const d = new Date(now);
        d.setHours(h, parseInt(min || '0'), 0, 0);
        if (opts?.preferFuture && d.getTime() <= now.getTime())
            d.setDate(d.getDate() + 1);
        return d;
    }
    // Try native Date parsing
    const parsed = new Date(input);
    if (!isNaN(parsed.getTime())) {
        return parsed;
    }
    throw new Error(`Cannot parse date/time: ${input}`);
}
/** True if input string contains a time-of-day component (e.g. "3pm", "15:30", "at 3") */
export function hasTimeComponent(input) {
    const lower = input.toLowerCase();
    return /\d{1,2}:\d{2}/.test(lower) || /\d{1,2}\s*(am|pm)\b/.test(lower) || /\bat\s+\d/.test(lower) || /\b(noon|midnight)\b/.test(lower);
}
/** True if input is a bare time of day with no date (e.g. "2:30pm", "14:30", "noon") */
function isTimeOnly(input) {
    const lower = input.toLowerCase().trim()
        .replace(/\bnoon\b/g, '12pm')
        .replace(/\bmidnight\b/g, '12am');
    return /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.test(lower) || /^(\d{1,2}):(\d{2})$/.test(lower);
}
/** Parse a single date/time or a date/time range like "june 13 1pm to 2:30pm".
 *  Recognized separators: "to", "until", "till", "-", "–", "—" (surrounded by spaces).
 *  When the end is a bare time, it inherits the start's date (rolling to the next
 *  day if the end falls at or before the start). Returns end=null when no range. */
export function parseDateTimeRange(input, opts) {
    // Spaced words/dashes, or an unspaced hyphen right after am/pm ("1pm-2:30pm").
    // The am/pm anchor keeps ISO dates like "2026-06-13" from being split.
    const sep = input.match(/\s+(?:to|until|till|-|–|—)\s+|\s*[–—]\s*|(?<=[ap]m)\s*-\s*(?=\d)/i);
    if (!sep) {
        return { start: parseDateTime(input, opts), end: null };
    }
    const startStr = input.slice(0, sep.index).trim();
    const endStr = input.slice(sep.index + sep[0].length).trim();
    const start = parseDateTime(startStr, opts);
    let end;
    if (isTimeOnly(endStr)) {
        const t = parseDateTime(endStr);
        end = new Date(start);
        end.setHours(t.getHours(), t.getMinutes(), 0, 0);
        if (end.getTime() <= start.getTime()) {
            end.setDate(end.getDate() + 1); // overnight, e.g. "11pm to 1am"
        }
    }
    else {
        end = parseDateTime(endStr);
    }
    return { start, end };
}
/** Parse "YYYY-MM-DD" to a local Date at midnight (avoids UTC shift) */
export function parseAllDay(dateStr) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    return new Date(y, mo - 1, d);
}
/** Format a Date as "YYYY-MM-DD" in local time */
export function formatYMD(d) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
}
/** Timestamp for logging */
export function ts() {
    const now = new Date();
    return `[${now.toTimeString().slice(0, 8)}]`;
}
//# sourceMappingURL=gutils.js.map