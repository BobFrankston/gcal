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
| `show <id>` | Show full details for an event (`-json` for raw JSON) |
| `add <title> <when> [duration]` | Add event (explicit) |
| `add "<free text>"` | Add event (AI-parsed) |
| `add -clip` | Add event from clipboard text — or image, if there is no text (AI-parsed) |
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
| `-c`, `-cal`, `-calendar <name>` | Calendar to use (default: primary). Case-insensitive partial match on calendar name or ID, e.g. `-cal family`; errors if ambiguous |
| `-n <count>` | Number of events to list |
| `-v`, `-verbose` | Show event IDs and links |
| `-b`, `-birthday` | Birthdays: include them in `list`/`del`; on `add`, create a birthday event (see below) |
| `-clip` | Read from clipboard — text, or an image if there is no text (for `add`) |
| `-r`, `-reminder <dur>` | Add popup reminder (e.g. `30m`, `1h`); repeatable |
| `-since <date>` | Start listing from `<date>` |
| `-till <date>` | End listing at `<date>` |
| `-all` | Delete all instances of recurring event |
| `-json` | Output raw JSON (for `show`) |

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
gcal add "Ann's birthday" "mar 5" -birthday
gcal add "Ann's birthday is March 5"
gcal show abc12345
gcal show abc12345 -json
gcal remind abc12345 30m
gcal resched abc12345 "next friday 3pm"
gcal snooze abc12345 +1w
gcal -u bob@gmail.com
```

### Clipboard images

`gcal add -clip` prefers clipboard **text**. When the clipboard has no text, it
reads an **image** instead — a screenshot of an invitation, email, flyer, or an
image file copied in Explorer — and extracts the event(s) from it. Large images
are downscaled (long edge 1568px, JPEG if still oversized) before being sent.

```bash
# Win+Shift+S to snip an event flyer, then:
gcal add -clip
```

Windows works out of the box. macOS needs [`pngpaste`](https://github.com/jcsalterego/pngpaste)
(`brew install pngpaste`); Linux needs `wl-paste` (Wayland) or `xclip` (X11).

### Conflict / proximity warnings

When adding or rescheduling a timed event, `gcal` prints a warning for any existing event that **overlaps** the new slot or falls within **1 hour before or after** it. An overlapping event that is itself marked free is listed with "(free)".

On `add`, a real conflict — the new event is busy and it overlaps an existing busy event — asks **"Create anyway? [y/N]"**. The default is No and the 60-second auto-yes does not apply. A `-free` event never asks. On `update` and `resched` the warnings are informational only.

### Busy vs free

New events show as **busy** unless you pass `-free`, or (in AI mode) the text says so — "free", "not busy", "tentative", "optional", "FYI", "hold", and the like set the event to free. `-free`/`-busy` on the command line always win over the text.

### Birthdays

`gcal add "<title>" "<date>" -birthday` creates a real Google **birthday event** (`eventType: birthday`) rather than a plain event with "birthday" in the title. Google files it under its Birthdays layer, repeats it every year (a February 29 birthday falls on the last day of February), shows it as free, and keeps it private. Only the title, the date and `-r` reminders apply; `-rrule`, `-busy`, a duration/day count, `-loc` and `-note` are rejected. In AI mode the text itself decides: "Ann's birthday is March 5" or "Joe was born 1950-03-05" becomes a birthday (a birthday *party* at a given time stays an ordinary timed event); `-birthday` forces it.

`list` hides birthdays unless you pass `-b`/`-birthday`. Shown birthdays are tagged `[birthday]`, or `[birthday, from contact]` for the ones Google derives from your contacts. `del` needs `-b` too, as a guard.

Google's timing rules: the date of a birthday linked to a contact cannot be changed through the API; only its title, color and reminders can.

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
