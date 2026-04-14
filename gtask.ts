#!/usr/bin/env node
/**
 * gtask - Google Tasks CLI tool
 * Sibling to gcal. Shares OAuth credentials, scopes, and token files.
 */

import { createInterface } from 'readline/promises';
import {
    loadConfig, saveConfig, parseDateTime, formatYMD, normalizeUser
} from './glib/gutils.js';
import { setupAbortHandler, getAccessToken } from './glib/goauth.js';
import {
    listTaskLists, listTasks, createTask, patchTask, deleteTask,
    moveTask, clearCompleted, resolveTaskList
} from './glib/tasksapi.js';
import type { Task } from './glib/tasktypes.js';

import pkg from './package.json' with { type: 'json' };
const VERSION: string = pkg.version;

interface ParsedArgs {
    command: string;
    args: string[];
    user: string;
    list: string;        /** -l <listname|id> */
    notes: string;       /** -n <notes> */
    title: string;       /** -t <title> for edit */
    when: string;        /** -when <date> for edit */
    showAll: boolean;    /** -a: include completed */
    help: boolean;
    helpCmd: string;     /** `gtask help <cmd>` */
}

const USAGE_SUMMARY = `gtask v${VERSION} - Google Tasks CLI

Usage: gtask <command> [options]
       gtask help <command>     Detailed help for a command

Commands:
  add <title> [when]           Add a task (optional due date)
  list                         List open tasks
  lists                        List all tasklists
  done <id>                    Mark task completed (id prefix)
  undone <id>                  Reopen a completed task
  del <id>                     Delete a task
  edit <id> [-t title] [-when date] [-n notes]
  clear                        Remove all completed tasks from list
  move <id> -l <list>          Move task to another tasklist
  help [command]               Show help

Global options:
  -u, -user <email>            Set / use Google account
  -l, -list <name|id>          Tasklist (default: primary)
`;

const USAGE: Record<string, string> = {
    add: `gtask add <title> [when] [-l <list>] [-n <notes>]
  Add a task. <when> is an optional due date (date-only; time is ignored
  by Google Tasks). Wrap multi-word titles in quotes.

  Examples:
    gtask add "Write report"
    gtask add "Write report" friday
    gtask add "Pay bills" "april 30" -n "rent + utilities"
    gtask add "Call plumber" tomorrow -l Errands
`,
    list: `gtask list [-l <list>] [-a] [-since <date>] [-till <date>]
  List open tasks in a tasklist.
  -a              Include completed tasks
  -since <date>   Only tasks due from <date> forward
  -till <date>    Only tasks due up to <date>

  Examples:
    gtask list
    gtask list -l Errands
    gtask list -a
    gtask list -since "april 1" -till "may 1"
`,
    lists: `gtask lists
  Show all tasklists with their IDs.
`,
    done: `gtask done <id>
  Mark a task completed. <id> is a prefix of the task's ID (as shown by
  gtask list).

  Example:
    gtask done abc12345
`,
    undone: `gtask undone <id>
  Reopen a completed task (sets status back to needsAction).
  Note: requires -a on a previous list, or knowing the id.
`,
    del: `gtask del <id> [-l <list>]
  Delete a task by id prefix.
`,
    edit: `gtask edit <id> [-t <title>] [-when <date>] [-n <notes>] [-l <list>]
  Update fields of an existing task. Only supplied fields change.

  Examples:
    gtask edit abc12345 -t "Write final report"
    gtask edit abc12345 -when "next monday"
    gtask edit abc12345 -n "draft attached"
`,
    clear: `gtask clear [-l <list>]
  Permanently remove all completed tasks from a tasklist.
`,
    move: `gtask move <id> -l <destination-list>
  Move a task to a different tasklist.
`,
    help: `gtask help [command]
  Show summary, or detailed help for a single command.
`
};

function showUsage(cmd?: string): void {
    if (cmd && USAGE[cmd]) {
        console.log(USAGE[cmd]);
        return;
    }
    if (cmd) {
        console.error(`Unknown command: ${cmd}\n`);
    }
    console.log(USAGE_SUMMARY);
}

function parseArgs(argv: string[]): ParsedArgs {
    const result: ParsedArgs = {
        command: '',
        args: [],
        user: '',
        list: '',
        notes: '',
        title: '',
        when: '',
        showAll: false,
        help: false,
        helpCmd: ''
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
            case '-l':
            case '-list':
            case '--list':
                result.list = argv[++i] || '';
                break;
            case '-n':
            case '-notes':
            case '--notes':
                result.notes = argv[++i] || '';
                break;
            case '-t':
            case '-title':
            case '--title':
                result.title = argv[++i] || '';
                break;
            case '-when':
            case '--when':
                result.when = argv[++i] || '';
                break;
            case '-a':
            case '-all':
            case '--all':
                result.showAll = true;
                break;
            case '-h':
            case '-help':
            case '--help':
                result.help = true;
                break;
            case '-V':
            case '-version':
            case '--version':
                console.log(`gtask v${VERSION}`);
                process.exit(0);
            default:
                if (arg.startsWith('-')) {
                    unknown.push(arg);
                } else if (!result.command) {
                    result.command = arg;
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

    if (result.command === 'help') {
        result.help = true;
        result.helpCmd = result.args[0] || '';
    }

    return result;
}

function resolveUser(cliUser: string): string {
    if (cliUser) return normalizeUser(cliUser);
    const config = loadConfig();
    return config.lastUser || '';
}

function dueToYMD(due: string | undefined): string {
    if (!due) return '';
    return due.slice(0, 10);
}

function formatTaskRow(t: Task): string[] {
    const id = (t.id || '').slice(0, 8);
    const status = t.status === 'completed' ? '*' : ' ';
    const due = dueToYMD(t.due);
    const title = t.title || '(no title)';
    const notes = (t.notes || '').replace(/\n/g, ' ').slice(0, 60);
    return [status, id, due, title, notes];
}

function printTaskTable(tasks: Task[]): void {
    if (tasks.length === 0) {
        console.log('No tasks.');
        return;
    }
    const headers = [' ', 'ID', 'Due', 'Title', 'Notes'];
    const rows = tasks.map(formatTaskRow);
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map(r => (r[i] || '').length))
    );
    const last = headers.length - 1;
    const pad = (s: string, i: number) => i === last ? s : s.padEnd(widths[i]);
    console.log(headers.map(pad).join('  '));
    console.log(widths.map(w => '-'.repeat(w)).join('  '));
    for (const r of rows) {
        console.log(r.map((c, i) => pad(c || '', i)).join('  '));
    }
}

/** Build a date-only RFC3339 due value (Google ignores the time portion). */
function buildDue(whenArg: string): string {
    const d = parseDateTime(whenArg);
    return `${formatYMD(d)}T00:00:00.000Z`;
}

async function findTask(
    accessToken: string,
    tasklistId: string,
    idPrefix: string,
    includeCompleted: boolean
): Promise<Task> {
    const tasks = await listTasks(accessToken, tasklistId, {
        showCompleted: includeCompleted,
        showHidden: includeCompleted,
        maxResults: 100
    });
    const matches = tasks.filter(t => t.id?.startsWith(idPrefix));
    if (matches.length === 0) throw new Error(`${idPrefix}: not found`);
    if (matches.length > 1) {
        const list = matches.map(t => `  ${(t.id || '').slice(0, 8)} - ${t.title}`).join('\n');
        throw new Error(`${idPrefix}: ambiguous (${matches.length} matches)\n${list}`);
    }
    return matches[0];
}

async function main(): Promise<void> {
    setupAbortHandler();
    const parsed = parseArgs(process.argv.slice(2));

    if (parsed.user) {
        const normalized = normalizeUser(parsed.user);
        const config = loadConfig();
        config.lastUser = normalized;
        saveConfig(config);
        console.log(`Default user set to: ${normalized}`);
        if (!parsed.command) process.exit(0);
    }

    if (parsed.help) {
        showUsage(parsed.helpCmd);
        process.exit(0);
    }

    if (!parsed.command) {
        showUsage();
        process.exit(1);
    }

    const user = resolveUser(parsed.user);
    if (!user) {
        console.error('No user configured. Use -u <email> to set default user.');
        process.exit(1);
    }

    switch (parsed.command) {
        case 'lists': {
            const token = await getAccessToken(user, false);
            const lists = await listTaskLists(token);
            console.log(`\nTasklists (${lists.length}):\n`);
            for (const l of lists) {
                console.log(`  ${l.title}`);
                console.log(`    ID: ${l.id}`);
            }
            break;
        }

        case 'list': {
            const token = await getAccessToken(user, false);
            const tl = await resolveTaskList(token, parsed.list);
            const tasks = await listTasks(token, tl.id!, {
                showCompleted: parsed.showAll,
                showHidden: parsed.showAll,
                maxResults: 100
            });
            console.log(`\n${tl.title} (${tasks.length}):\n`);
            printTaskTable(tasks);
            break;
        }

        case 'add': {
            if (parsed.args.length < 1) {
                showUsage('add');
                process.exit(1);
            }
            const [title, when] = parsed.args;
            const task: Task = { title };
            if (when) task.due = buildDue(when);
            if (parsed.notes) task.notes = parsed.notes;

            const token = await getAccessToken(user, true);
            const tl = await resolveTaskList(token, parsed.list);
            const created = await createTask(token, task, tl.id!);
            console.log(`\nTask created in ${tl.title}: ${created.title}`);
            if (created.due) console.log(`  Due: ${dueToYMD(created.due)}`);
            if (created.notes) console.log(`  Notes: ${created.notes}`);
            console.log(`  ID: ${(created.id || '').slice(0, 8)}`);
            break;
        }

        case 'done': {
            if (parsed.args.length < 1) { showUsage('done'); process.exit(1); }
            const token = await getAccessToken(user, true);
            const tl = await resolveTaskList(token, parsed.list);
            const task = await findTask(token, tl.id!, parsed.args[0], false);
            const updated = await patchTask(token, task.id!, { status: 'completed' }, tl.id!);
            console.log(`Completed: ${updated.title}`);
            break;
        }

        case 'undone':
        case 'reopen': {
            if (parsed.args.length < 1) { showUsage('undone'); process.exit(1); }
            const token = await getAccessToken(user, true);
            const tl = await resolveTaskList(token, parsed.list);
            const task = await findTask(token, tl.id!, parsed.args[0], true);
            const updated = await patchTask(
                token, task.id!,
                { status: 'needsAction', completed: null as unknown as undefined },
                tl.id!
            );
            console.log(`Reopened: ${updated.title}`);
            break;
        }

        case 'del':
        case 'delete': {
            if (parsed.args.length < 1) { showUsage('del'); process.exit(1); }
            const token = await getAccessToken(user, true);
            const tl = await resolveTaskList(token, parsed.list);
            const task = await findTask(token, tl.id!, parsed.args[0], parsed.showAll);
            await deleteTask(token, task.id!, tl.id!);
            console.log(`Deleted: ${task.title}`);
            break;
        }

        case 'edit': {
            if (parsed.args.length < 1) { showUsage('edit'); process.exit(1); }
            const patch: Partial<Task> = {};
            if (parsed.title) patch.title = parsed.title;
            if (parsed.when) patch.due = buildDue(parsed.when);
            if (parsed.notes) patch.notes = parsed.notes;
            if (Object.keys(patch).length === 0) {
                console.error('Nothing to change. Provide -t, -when, or -n.');
                process.exit(1);
            }
            const token = await getAccessToken(user, true);
            const tl = await resolveTaskList(token, parsed.list);
            const task = await findTask(token, tl.id!, parsed.args[0], parsed.showAll);
            const updated = await patchTask(token, task.id!, patch, tl.id!);
            console.log(`Updated: ${updated.title}`);
            if (patch.due) console.log(`  Due: ${dueToYMD(updated.due)}`);
            if (patch.notes) console.log(`  Notes: ${updated.notes}`);
            break;
        }

        case 'clear': {
            const token = await getAccessToken(user, true);
            const tl = await resolveTaskList(token, parsed.list);
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const ans = (await rl.question(`Clear all completed tasks from "${tl.title}"? [y/N] `)).trim().toLowerCase();
            rl.close();
            if (ans !== 'y' && ans !== 'yes') {
                console.log('Cancelled.');
                break;
            }
            await clearCompleted(token, tl.id!);
            console.log(`Cleared completed tasks from ${tl.title}.`);
            break;
        }

        case 'move': {
            if (parsed.args.length < 1 || !parsed.list) { showUsage('move'); process.exit(1); }
            const token = await getAccessToken(user, true);
            const lists = await listTaskLists(token);
            const dest = lists.find(l =>
                (l.title || '').toLowerCase() === parsed.list.toLowerCase() || l.id === parsed.list
            );
            if (!dest) {
                console.error(`Destination tasklist not found: ${parsed.list}`);
                process.exit(1);
            }
            // Source: must locate task across all lists since we don't know which
            let srcList = '';
            let task: Task | undefined;
            for (const l of lists) {
                const ts = await listTasks(token, l.id!, { showCompleted: true, showHidden: true });
                const m = ts.find(t => t.id?.startsWith(parsed.args[0]));
                if (m) { task = m; srcList = l.id!; break; }
            }
            if (!task) {
                console.error(`${parsed.args[0]}: not found in any tasklist`);
                process.exit(1);
            }
            const moved = await moveTask(token, task.id!, srcList, dest.id);
            console.log(`Moved "${moved.title}" to ${dest.title}`);
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
