# @bobfrankston/gcal

Google Calendar CLI tool with ICS import support.

## Installation

```bash
npm install -g @bobfrankston/gcal
```

## Usage

```bash
gcal [command] [options]
```

## Options

| Flag | Description |
|------|-------------|
| `-u`, `-user <email>` | Google account (one-time) |
| `-defaultUser <email>` | Set default user |
| `-c`, `-calendar <id>` | Calendar ID (default: primary) |
| `-n <count>` | Number of events to list |
| `-v`, `-verbose` | Show event IDs and links |
| `-b`, `-birthdays` | Include birthday events (hidden by default) |

## Features

- Google Calendar integration
- ICS file import support
- OAuth authentication
- CLI interface
- Birthday events filtered by default (from Google Contacts)

## License

MIT
