/**
 * Google Tasks API wrapper. Mirrors the calendar API helpers in gcal.ts.
 */

import { apiFetch } from './goauth.js';
import type { Task, TaskList, TasksResponse, TaskListsResponse } from './tasktypes.js';

const TASKS_API_BASE = 'https://tasks.googleapis.com/tasks/v1';

export async function listTaskLists(accessToken: string): Promise<TaskList[]> {
    const url = `${TASKS_API_BASE}/users/@me/lists?maxResults=100`;
    const res = await apiFetch(url, accessToken);
    if (!res.ok) {
        throw new Error(`Failed to list tasklists: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as TaskListsResponse;
    return data.items || [];
}

export interface ListTasksOptions {
    showCompleted?: boolean;
    showHidden?: boolean;
    dueMin?: string;       /** RFC3339 */
    dueMax?: string;
    completedMin?: string;
    completedMax?: string;
    maxResults?: number;
}

export async function listTasks(
    accessToken: string,
    tasklistId = '@default',
    opts: ListTasksOptions = {}
): Promise<Task[]> {
    const params = new URLSearchParams({
        maxResults: String(opts.maxResults ?? 100),
        showCompleted: String(opts.showCompleted ?? false),
        showHidden: String(opts.showHidden ?? false)
    });
    if (opts.dueMin) params.set('dueMin', opts.dueMin);
    if (opts.dueMax) params.set('dueMax', opts.dueMax);
    if (opts.completedMin) params.set('completedMin', opts.completedMin);
    if (opts.completedMax) params.set('completedMax', opts.completedMax);

    const url = `${TASKS_API_BASE}/lists/${encodeURIComponent(tasklistId)}/tasks?${params}`;
    const res = await apiFetch(url, accessToken);
    if (!res.ok) {
        throw new Error(`Failed to list tasks: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as TasksResponse;
    return data.items || [];
}

export async function createTask(
    accessToken: string,
    task: Task,
    tasklistId = '@default'
): Promise<Task> {
    const url = `${TASKS_API_BASE}/lists/${encodeURIComponent(tasklistId)}/tasks`;
    const res = await apiFetch(url, accessToken, {
        method: 'POST',
        body: JSON.stringify(task)
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to create task: ${res.status} ${errText}`);
    }
    return await res.json() as Task;
}

export async function patchTask(
    accessToken: string,
    taskId: string,
    patch: Partial<Task>,
    tasklistId = '@default'
): Promise<Task> {
    const url = `${TASKS_API_BASE}/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`;
    const res = await apiFetch(url, accessToken, {
        method: 'PATCH',
        body: JSON.stringify(patch)
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to update task: ${res.status} ${errText}`);
    }
    return await res.json() as Task;
}

export async function deleteTask(
    accessToken: string,
    taskId: string,
    tasklistId = '@default'
): Promise<void> {
    const url = `${TASKS_API_BASE}/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`;
    const res = await apiFetch(url, accessToken, { method: 'DELETE' });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to delete task: ${res.status} ${errText}`);
    }
}

export async function moveTask(
    accessToken: string,
    taskId: string,
    fromListId: string,
    toListId?: string,
    parent?: string,
    previous?: string
): Promise<Task> {
    const params = new URLSearchParams();
    if (toListId) params.set('destinationTasklist', toListId);
    if (parent) params.set('parent', parent);
    if (previous) params.set('previous', previous);

    const url = `${TASKS_API_BASE}/lists/${encodeURIComponent(fromListId)}/tasks/${encodeURIComponent(taskId)}/move`
        + (params.toString() ? `?${params}` : '');
    const res = await apiFetch(url, accessToken, { method: 'POST' });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to move task: ${res.status} ${errText}`);
    }
    return await res.json() as Task;
}

export async function clearCompleted(
    accessToken: string,
    tasklistId = '@default'
): Promise<void> {
    const url = `${TASKS_API_BASE}/lists/${encodeURIComponent(tasklistId)}/clear`;
    const res = await apiFetch(url, accessToken, { method: 'POST' });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to clear completed: ${res.status} ${errText}`);
    }
}

/** Resolve a tasklist by name, id, or '@default'. Case-insensitive title match. */
export async function resolveTaskList(
    accessToken: string,
    nameOrId: string
): Promise<TaskList> {
    if (!nameOrId || nameOrId === '@default') {
        const lists = await listTaskLists(accessToken);
        const def = lists[0];
        if (!def) throw new Error('No tasklists found');
        return def;
    }
    const lists = await listTaskLists(accessToken);
    const lower = nameOrId.toLowerCase();
    const byTitle = lists.find(l => (l.title || '').toLowerCase() === lower);
    if (byTitle) return byTitle;
    const byId = lists.find(l => l.id === nameOrId);
    if (byId) return byId;
    throw new Error(`Tasklist not found: ${nameOrId}`);
}
