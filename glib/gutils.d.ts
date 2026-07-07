/**
 * Shared utilities for gcal tools
 */
export interface GcalConfig {
    lastUser?: string;
    defaultCalendar?: string;
    assocChecked?: boolean;
}
export interface UserPaths {
    userDir: string;
    eventsDir: string;
    tokenFile: string;
    tokenWriteFile: string;
    syncTokenFile: string;
    configFile: string;
}
export declare const APP_DIR: string;
/** Get the app directory (%APPDATA%\gcal or ~/.config/gcal) */
export declare function getAppDir(): string;
/** Get the data directory (app directory/data, or local data/ symlink for dev) */
export declare function getDataDir(): string;
export declare const DATA_DIR: string;
export declare const CONFIG_FILE: string;
/** OAuth credentials shipped with the package */
export declare const CREDENTIALS_FILE: string;
export declare function loadConfig(): GcalConfig;
export declare function saveConfig(config: GcalConfig): void;
export declare function getUserPaths(user: string): UserPaths;
export declare function ensureUserDir(user: string): void;
export declare function normalizeUser(user: string): string;
export declare function getAllUsers(): string[];
export declare function matchUsers(pattern: string): string[];
export declare function resolveUser(cliUser: string, setAsDefault?: boolean): string;
/** Format datetime for display - "dow yyyy-mm-dd HH:mm" (or "dow yyyy-mm-dd" for all-day) */
export declare function formatDateTime(dt: {
    date?: string;
    dateTime?: string;
    timeZone?: string;
}): string;
/**
 * Convert a bare wall-clock string ("YYYY-MM-DDTHH:mm[:ss]", no offset) in an
 * IANA timezone to the actual UTC instant. Strings that already carry an
 * offset (Z or +hh:mm) fall through to normal Date parsing.
 */
export declare function zonedWallClockToDate(dateTime: string, timeZone: string): Date;
/** Format duration in hours (e.g., "1.5 hrs", "2 hrs", "30 min") */
export declare function formatDuration(start: {
    date?: string;
    dateTime?: string;
}, end: {
    date?: string;
    dateTime?: string;
}): string;
/** Parse duration string like "1h", "30m", "1h30m" to minutes */
export declare function parseDuration(duration: string): number;
/** Parse natural date/time strings.
 *  opts.preferFuture: a bare time (no date) that has already passed today rolls to tomorrow. */
export declare function parseDateTime(input: string, opts?: {
    preferFuture?: boolean;
}): Date;
/** True if input string contains a time-of-day component (e.g. "3pm", "15:30", "at 3") */
export declare function hasTimeComponent(input: string): boolean;
/** Parse a single date/time or a date/time range like "june 13 1pm to 2:30pm".
 *  Recognized separators: "to", "until", "till", "-", "–", "—" (surrounded by spaces).
 *  When the end is a bare time, it inherits the start's date (rolling to the next
 *  day if the end falls at or before the start). Returns end=null when no range. */
export declare function parseDateTimeRange(input: string, opts?: {
    preferFuture?: boolean;
}): {
    start: Date;
    end: Date | null;
};
/** Parse "YYYY-MM-DD" to a local Date at midnight (avoids UTC shift) */
export declare function parseAllDay(dateStr: string): Date;
/** Format a Date as "YYYY-MM-DD" in local time */
export declare function formatYMD(d: Date): string;
/** Timestamp for logging */
export declare function ts(): string;
//# sourceMappingURL=gutils.d.ts.map