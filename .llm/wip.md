# gcal — AI working state

## Pending: commit/publish two .ics import fixes (2026-07-24)

Both in `importIcsFile` (gcal.ts), compiled but not yet committed or published:
1. Attendee `MAILTO:` prefix now stripped case-insensitively (`/^mailto:/i`) — uppercase `MAILTO:` from older ICS generators was sent verbatim to Google, causing 400 "Invalid attendee email".
2. Import failures now print the underlying API error message instead of just the event summary.

Next step: Bob runs npmglobalize when ready — it handles compile, commit, and install (AI must not run npm version/publish or commit manually for releases).
