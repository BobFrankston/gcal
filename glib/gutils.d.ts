/**
 * Shared utilities for gcal tools
 */
export interface GcalConfig {
    lastUser?: string;
    defaultCalendar?: string;
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
/** Use credentials from gcards (shared OAuth app) */
export declare const CREDENTIALS_FILE: string;
export declare function loadConfig(): GcalConfig;
export declare function saveConfig(config: GcalConfig): void;
export declare function getUserPaths(user: string): UserPaths;
export declare function ensureUserDir(user: string): void;
export declare function normalizeUser(user: string): string;
export declare function getAllUsers(): string[];
export declare function matchUsers(pattern: string): string[];
export declare function resolveUser(cliUser: string, setAsDefault?: boolean): string;
/** Format datetime for display - yyyy-mm-dd HH:mm format */
export declare function formatDateTime(dt: {
    date?: string;
    dateTime?: string;
    timeZone?: string;
}): string;
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
/** Parse natural date/time strings */
export declare function parseDateTime(input: string): Date;
/** Timestamp for logging */
export declare function ts(): string;
//# sourceMappingURL=gutils.d.ts.map