/**
 * Google Tasks API types.
 * https://developers.google.com/tasks/reference/rest
 */

export interface TaskList {
    kind?: string;
    id?: string;
    etag?: string;
    title?: string;
    updated?: string;
    selfLink?: string;
}

export interface TaskListsResponse {
    kind?: string;
    etag?: string;
    nextPageToken?: string;
    items?: TaskList[];
}

export interface TaskLink {
    type?: string;
    description?: string;
    link?: string;
}

export interface Task {
    kind?: string;
    id?: string;
    etag?: string;
    title?: string;
    updated?: string;
    selfLink?: string;
    parent?: string;
    position?: string;
    notes?: string;
    status?: 'needsAction' | 'completed';
    due?: string;        /** RFC3339 — date-only in practice; time component is ignored by the UI. */
    completed?: string;  /** RFC3339 timestamp, set when status='completed'. */
    deleted?: boolean;
    hidden?: boolean;
    links?: TaskLink[];
}

export interface TasksResponse {
    kind?: string;
    etag?: string;
    nextPageToken?: string;
    items?: Task[];
}
