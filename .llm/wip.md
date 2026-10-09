# gcal — AI working state

## Pending: commit/publish two .ics import fixes (2026-07-24)

Both in `importIcsFile` (gcal.ts), compiled but not yet committed or published:
1. Attendee `MAILTO:` prefix now stripped case-insensitively (`/^mailto:/i`) — uppercase `MAILTO:` from older ICS generators was sent verbatim to Google, causing 400 "Invalid attendee email".
2. Import failures now print the underlying API error message instead of just the event summary.

Next step: Bob runs npmglobalize when ready — it handles compile, commit, and install (AI must not run npm version/publish or commit manually for releases).

## DONE 2026-09-22: birthdays point at Google Contacts, not the calendar (Claude Code, Fable 5.1)

Bob: the 2026-09-21 -birthday implementation (standalone `eventType: birthday` calendar
event) was wrong; a birthday belongs on the person's Google Contact and Calendar shows it
from there. His gfix `birthday` extract (strips birthdays out of contacts into a CSV) was
a one-time cleanup of legacy data, not a live conflict.

Final shape (after two turns of simplification the same day):
- `gcal add "<name>" "<date>" -birthday` and AI-mode birthdays WRITE NOTHING. They print
  the date to enter and a clickable https://contacts.google.com/search/<name> link; -open
  opens it. del refuses a contact-derived birthday and prints its
  https://contacts.google.com/person/<id> link. -r/-cal rejected with -birthday.
- URL forms verified in Chrome 2026-09-22: /search/<name> lists matches with an Edit
  button each; /person/<id> shows the contact with "Add birthday" on it; /person/<id>/edit
  is a 404.
- A full People API write (search → pick → PATCH birthdays, via new gcards primitives)
  was built and live-tested first, then dropped at Bob's direction ("so few birthdays ...
  just tell me to use Google Contacts and provide a clickable URL"). gcards was reverted
  to its pre-session state (its new glib/contact.ts sits in gcards/cruft/ if ever wanted);
  the gcards dependency was removed from gcal. Finding from that work, NOT fixed: gcard.ts
  getContact() returns null on ANY error, and mergeInto then PATCHes with no etag.
- Compiled with global tsc 6.0.3 (clean). Usage, README, .commitmsg updated.

Known pre-existing bug spotted (NOT fixed, out of scope): parseDateTimeRange("1950-03-05")
returns Mar 4 1950 — ISO date parsed as UTC then shifted to local. "3/5/1950" and
"march 5, 1950" are fine.

Next: Bob runs npmglobalize in gcal when ready. rmfmail's copy of the extraction prompt
(birthday field) is still not synced. Nothing committed by me.
