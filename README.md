# @bobfrankston/gcal

Google Calendar CLI tool with ICS import support.

## Installation

```bash
npm install -g @bobfrankston/gcal
```

## Usage

```bash
gcal <file.ics>                    Import ICS file (file association)
gcal <command> [options]           Run command
```

## Commands

| Command | Description |
|---------|-------------|
| `list [n]` | List upcoming n events (default: 10) |
| `add <title> <when> [duration]` | Add event (explicit args) |
| `add` | Add event (type description interactively) |
| `add "free text description"` | Add event (AI parses single text arg) |
| `add -clip` | Add event from clipboard text (AI-parsed) |
| `del\|delete <id> [id2...]` | Delete event(s) by ID (prefix match) |
| `remind <id> <dur> [dur2...]` | Add reminder(s) to existing event |
| `import <file.ics>` | Import events from ICS file |
| `calendars` | List available calendars |
| `assoc` | Set up .ics file association (Windows) |
| `help` | Show help |

## Options

| Flag | Description |
|------|-------------|
| `-u`, `-user <email>` | Set default Google account |
| `-c`, `-calendar <id>` | Calendar ID (default: primary) |
| `-n <count>` | Number of events to list |
| `-v`, `-verbose` | Show event IDs and links |
| `-b`, `-birthdays` | Include birthday events (hidden by default) |
| `-clip` | Read from clipboard (for add command) |
| `-r`, `-reminder <dur>` | Add popup reminder (e.g., 30m, 1h); repeatable |
| `-all` | Delete all instances of recurring event |

## Examples

```bash
gcal meeting.ics                        # Import ICS file
gcal list                               # List next 10 events
gcal add "Dentist" "Friday 3pm" "1h"
gcal add "Lunch" "1/14/2026 12:00" "1h"
gcal add "Meeting" "tomorrow 10:00"
gcal add "Appointment" "jan 15 2pm"
gcal add "Dentist appointment Friday 3pm for 1 hour"
gcal add -clip                          # Add from clipboard text
gcal add "Dentist" "Friday 3pm" -r 30m  # Add with 30-min reminder
gcal remind abc12345 30m                # Add 30-min reminder to event
gcal add                                # Type event description
gcal -u bob@gmail.com                   # Set default user
```

## File Association (Windows)

```bash
gcal assoc    # Sets up .ics → gcal automatically
```

On first run, gcal will offer to set this up. Run `gcal assoc` anytime to (re)configure it.

## License

MIT
