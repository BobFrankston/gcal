# @bobfrankston/gcal

Google Calendar **and** Google Tasks CLI tools. Two binaries (`gcal`, `gtask`) shipped together — they share OAuth credentials, scopes, and token files, so you authenticate once.

## Installation

```bash
npm install -g @bobfrankston/gcal
```

Provides:
- `gcal`  — Google Calendar
- `gtask` — Google Tasks

Both share OAuth client credentials with `gcards` (`%APPDATA%\gcards\credentials.json`).

## gcal — Google Calendar

```bash
gcal <file.ics>            # Import ICS file (file association)
gcal <command> [options]
gcal help <command>        # Detailed help for one command
```

### Commands

| Command | Description |
|---------|-------------|
| `list [n]` | List upcoming n events (default: 10) |
| `add <title> <when> [duration]` | Add event (explicit) |
| `add "<free text>"` | Add event (AI-parsed) |
| `add -clip` | Add event from clipboard (AI-parsed) |
| `add` | Add event interactively |
| `del \| delete <id> [id2...]` | Delete event(s) by ID prefix |
| `remind <id> <dur> [dur2...]` | Add reminder(s) |
| `resched <id> <when> [duration]` | Reschedule (preserves duration) |
| `snooze <id> [when]` | Snooze (default `+1d`) |
| `import <file.ics>` | Import events from ICS |
| `calendars` | List available calendars |
| `assoc` | Set up `.ics` file association (Windows) |
| `help [command]` | Show help |

### Options

| Flag | Description |
|------|-------------|
| `-u`, `-user <email>` | Set / use default Google account |
| `-c`, `-calendar <id>` | Calendar ID (default: primary) |
| `-n <count>` | Number of events to list |
| `-v`, `-verbose` | Show event IDs and links |
| `-b`, `-birthdays` | Include birthday events |
| `-clip` | Read from clipboard (for `add`) |
| `-r`, `-reminder <dur>` | Add popup reminder (e.g. `30m`, `1h`); repeatable |
| `-since <date>` | Start listing from `<date>` |
| `-till <date>` | End listing at `<date>` |
| `-all` | Delete all instances of recurring event |

### Examples

```bash
gcal meeting.ics
gcal list
gcal list -since "10 days ago"
gcal list -since "april 1" -till "may 1"
gcal add "Dentist" "Friday 3pm" "1h"
gcal add "Lunch" "1/14/2026 12:00" "1h"
gcal add "Dentist appointment Friday 3pm for 1 hour"
gcal add -clip
gcal add "Dentist" "Friday 3pm" -r 30m
gcal remind abc12345 30m
gcal resched abc12345 "next friday 3pm"
gcal snooze abc12345 +1w
gcal -u bob@gmail.com
```

### Reschedule / snooze notes

`resched` and `snooze` find events up to 30 days in the past by default (so stale reminders remain findable). Widen with `-since <date>`. For timed events, if `<when>` lacks a time-of-day (e.g. `tomorrow`), the original time is preserved. All-day events stay all-day. Relative offsets `+1d` / `+1w` / `+1h` / `+1m` advance from the event's current start.

### Windows file association

```bash
gcal assoc        # Sets up .ics → gcal
```

On first run, gcal offers to set this up. Run `gcal assoc` anytime to (re)configure.

## gtask — Google Tasks

```bash
gtask <command> [options]
gtask help <command>
```

### Commands

| Command | Description |
|---------|-------------|
| `add <title> [when]` | Add a task (optional due date — date-only) |
| `list` | List open tasks |
| `lists` | List all tasklists |
| `done <id>` | Mark task completed |
| `undone <id>` | Reopen a completed task |
| `del <id>` | Delete a task |
| `edit <id> [-t title] [-when date] [-n notes]` | Update fields |
| `clear` | Remove all completed tasks from list |
| `move <id> -l <list>` | Move task to another tasklist |
| `help [command]` | Show help |

### Options

| Flag | Description |
|------|-------------|
| `-u`, `-user <email>` | Google account |
| `-l`, `-list <name\|id>` | Tasklist (default: primary) |
| `-n`, `-notes <text>` | Notes for `add` / `edit` |
| `-t`, `-title <text>` | New title for `edit` |
| `-when <date>` | New due date for `edit` |
| `-a`, `-all` | Include completed tasks in `list` |

### Examples

```bash
gtask add "Write report"
gtask add "Write report" friday
gtask add "Pay bills" "april 30" -n "rent + utilities"
gtask add "Call plumber" tomorrow -l Errands
gtask list
gtask list -l Errands
gtask list -a
gtask done abc12345
gtask edit abc12345 -when "next monday"
gtask move abc12345 -l Personal
gtask clear -l Errands
```

### Notes on Google Tasks

- **Due dates are date-only.** The Tasks API stores RFC3339 timestamps, but the Google UI ignores time-of-day. `gtask` writes midnight UTC.
- **No reminders.** Tasks have no notification mechanism in the API. Reminders only appear if you create the task through the Calendar UI's task-with-time feature.
- **No recurrence.** Recurring tasks aren't exposed via the API.
- **Hierarchy is flat.** One level of subtasks via `move?parent=`. Not currently surfaced by `gtask`.

## Shared OAuth

Both tools request the combined scope set `calendar + tasks` (read or write depending on operation). The first time you run either tool after upgrading, Google prompts once for the new combined consent; afterward both share `token.json` / `token-write.json`.

## License

MIT
