
## Done, awaiting npmglobalize: add-time conflict gate + busy-by-default (2026-09-16, Claude Code Fable 5.1)

Bob: "check for conflicts when adding appointments and default to marking the times as busy unless I add -free or the text says it".
Plan (gcal.ts + glib/aihelper.ts):
1. checkProximity returns count of overlapping *busy* existing events (free ones reported as "OVERLAPS (free)").
2. `add` explicit mode: transparency defaults to 'opaque'; on busy conflict prompt "Create anyway? [y/N]".
3. `add` AI mode: ExtractedEvent gains `free?: boolean` (prompt tells Claude to set it when text says free/tentative/optional/FYI); transparency = -free/-busy flag, else extracted.free, else opaque. Conflict → confirm prompt defaults to No, no auto-yes timer.
4. Usage text, README, .commitmsg updated. update/resched keep warning-only behaviour (not in scope).
Status: all four steps implemented, compiled clean (npx -p typescript@5.7.3 tsc), .commitmsg written. Not committed/published — Bob runs npmglobalize. Not live-tested against the API (needs a real overlapping slot); explicit + AI paths reviewed by reading. rmfmail's prompt copy not synced.

## In progress: -birthday on add (2026-09-21, Claude Code Fable 5.1)

Bob: "have -birthday for flag that purpose. Birthdays would also be placed on the appropriate calendar."
Google API (event-types guide, verified 2026-09-21): eventType 'birthday' must be all-day exactly 1 day,
recurrence RRULE:FREQ=YEARLY (Feb 29: FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1), visibility private,
transparency transparent, birthdayProperties.type 'birthday'; only colorId/summary/reminders otherwise.
Google shows these under its "Birthdays" layer — that is the "appropriate calendar".
Plan:
1. parseArgs: -birthday/--birthday join -b/-birthdays (one flag `birthdays`: list shows them, add creates one).
2. gcal.ts makeBirthdayEvent(title, day, reminders) used by explicit + AI add. Explicit: reject -rrule/-busy/day count>1.
3. aihelper ExtractedEvent.birthday?: boolean + prompt rule; AI add uses date part.
4. list: "[from contact]" only when birthdayProperties.contact, else "[birthday]".
5. types.ts birthdayProperties. Usage, README, .commitmsg. Compile npx -p typescript@5.7.3 tsc. Live test add→list→del.
Status: DONE 2026-09-21 21:40 — compiled clean (npx -p typescript@5.7.3 tsc); live-tested explicit add, AI add ("X's birthday is March 7"), list -b tag, show -json (eventType/birthdayProperties/transparent/private all as sent), del -b -all; test events removed and verified gone. .commitmsg written. Bob runs npmglobalize.
Open: -cal works in AI mode (global flag) but birthday-on-non-primary-calendar untested. Creation line says "every year" but not "all day" — Bob asked about all-day marking; the event IS all-day (start.date), wording change not made pending his answer. parseDateTimeRange("march 5", preferFuture) returned 2026-03-05 (past) — harmless for a yearly series, pre-existing, untouched.
