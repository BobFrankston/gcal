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
/** Use credentials from gcards (shared OAuth app) */
export const CREDENTIALS_FILE = path.join(path.dirname(APP_DIR), 'gcards', 'credentials.json');
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
/** Format datetime for display - yyyy-mm-dd HH:mm format */
export function formatDateTime(dt) {
    if (dt.date) {
        return dt.date; // Already yyyy-mm-dd
    }
    if (dt.dateTime) {
        const d = new Date(dt.dateTime);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
    }
    return '(no time)';
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
/** Parse natural date/time strings */
export function parseDateTime(input) {
    const now = new Date();
    const lower = input.toLowerCase().trim();
    // Handle relative dates
    if (lower === 'today') {
        return now;
    }
    if (lower === 'tomorrow') {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        return d;
    }
    // Handle "tomorrow 2pm" or "tomorrow at 2pm"
    const relMatch = lower.match(/^(today|tomorrow)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (relMatch) {
        const [, rel, hour, min, ampm] = relMatch;
        const d = new Date(now);
        if (rel === 'tomorrow')
            d.setDate(d.getDate() + 1);
        let h = parseInt(hour);
        if (ampm?.toLowerCase() === 'pm' && h < 12)
            h += 12;
        if (ampm?.toLowerCase() === 'am' && h === 12)
            h = 0;
        d.setHours(h, parseInt(min || '0'), 0, 0);
        return d;
    }
    // Handle weekday names
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayMatch = lower.match(/^(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (dayMatch) {
        const [, next, day, hour, min, ampm] = dayMatch;
        const targetDay = weekdays.indexOf(day.toLowerCase());
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
        return d;
    }
    // Try native Date parsing
    const parsed = new Date(input);
    if (!isNaN(parsed.getTime())) {
        return parsed;
    }
    throw new Error(`Cannot parse date/time: ${input}`);
}
/** Timestamp for logging */
export function ts() {
    const now = new Date();
    return `[${now.toTimeString().slice(0, 8)}]`;
}
//# sourceMappingURL=gutils.js.map