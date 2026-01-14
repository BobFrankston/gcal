/**
 * Google Calendar API types
 */

/** Google Calendar Event */
export interface GoogleEvent {
    kind?: string;
    etag?: string;
    id?: string;
    status?: string;
    htmlLink?: string;
    created?: string;
    updated?: string;
    summary?: string;
    description?: string;
    location?: string;
    colorId?: string;
    creator?: {
        id?: string;
        email?: string;
        displayName?: string;
        self?: boolean;
    };
    organizer?: {
        id?: string;
        email?: string;
        displayName?: string;
        self?: boolean;
    };
    start?: EventDateTime;
    end?: EventDateTime;
    endTimeUnspecified?: boolean;
    recurrence?: string[];
    recurringEventId?: string;
    originalStartTime?: EventDateTime;
    transparency?: string;
    visibility?: string;
    iCalUID?: string;
    sequence?: number;
    attendees?: EventAttendee[];
    attendeesOmitted?: boolean;
    hangoutLink?: string;
    conferenceData?: ConferenceData;
    reminders?: {
        useDefault?: boolean;
        overrides?: EventReminder[];
    };
    source?: {
        url?: string;
        title?: string;
    };
    attachments?: EventAttachment[];
    eventType?: string;
}

export interface EventDateTime {
    date?: string;       /** Date in YYYY-MM-DD format (all-day event) */
    dateTime?: string;   /** RFC3339 timestamp with timezone */
    timeZone?: string;   /** IANA timezone */
}

export interface EventAttendee {
    id?: string;
    email?: string;
    displayName?: string;
    organizer?: boolean;
    self?: boolean;
    resource?: boolean;
    optional?: boolean;
    responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
    comment?: string;
    additionalGuests?: number;
}

export interface EventReminder {
    method?: 'email' | 'popup';
    minutes?: number;
}

export interface EventAttachment {
    fileUrl?: string;
    title?: string;
    mimeType?: string;
    iconLink?: string;
    fileId?: string;
}

export interface ConferenceData {
    createRequest?: {
        requestId?: string;
        conferenceSolutionKey?: { type?: string };
        status?: { statusCode?: string };
    };
    entryPoints?: {
        entryPointType?: string;
        uri?: string;
        label?: string;
        pin?: string;
        accessCode?: string;
        meetingCode?: string;
        passcode?: string;
        password?: string;
    }[];
    conferenceSolution?: {
        key?: { type?: string };
        name?: string;
        iconUri?: string;
    };
    conferenceId?: string;
    signature?: string;
    notes?: string;
}

/** Google Calendar list entry */
export interface CalendarListEntry {
    kind?: string;
    etag?: string;
    id?: string;
    summary?: string;
    description?: string;
    location?: string;
    timeZone?: string;
    summaryOverride?: string;
    colorId?: string;
    backgroundColor?: string;
    foregroundColor?: string;
    hidden?: boolean;
    selected?: boolean;
    accessRole?: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
    defaultReminders?: EventReminder[];
    notificationSettings?: {
        notifications?: {
            type?: string;
            method?: string;
        }[];
    };
    primary?: boolean;
    deleted?: boolean;
    conferenceProperties?: {
        allowedConferenceSolutionTypes?: string[];
    };
}

/** Events list response from API */
export interface EventsListResponse {
    kind?: string;
    etag?: string;
    summary?: string;
    description?: string;
    updated?: string;
    timeZone?: string;
    accessRole?: string;
    defaultReminders?: EventReminder[];
    nextPageToken?: string;
    nextSyncToken?: string;
    items?: GoogleEvent[];
}

/** Calendar list response from API */
export interface CalendarListResponse {
    kind?: string;
    etag?: string;
    nextPageToken?: string;
    nextSyncToken?: string;
    items?: CalendarListEntry[];
}
