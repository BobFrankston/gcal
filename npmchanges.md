# npm Publish Changes

## v0.1.78 — 2026-09-11

- Accept -cal as alias for -c/-calendar; document partial-match calendar selection in usage and README (2026-09-11)

## v0.1.79 — 2026-09-16

- add: check for conflicts before creating. checkProximity now returns the count of overlapping BUSY events (free ones listed as "(free)", not counted). A busy new event overlapping a busy existing one asks "Create anyway? [y/N]" — default No, no 60s auto-yes. A -free event never asks. Explicit and AI modes both. (2026-09-16)
- add: events default to busy (transparency=opaque) unless -free, or in AI mode the text says so — ExtractedEvent gained `free?: boolean`, extraction prompt sets it for "free"/"tentative"/"optional"/"FYI"/"hold". -free/-busy flags override the text. Output now always prints "Shows as: busy|free". (2026-09-16)
- checkProximity: a failed conflict lookup now prints a warning instead of silently returning. (2026-09-16)
- Note: rmfmail's copy of the extraction prompt (mailx-service extractEventGcalStyle) was NOT updated; sync when convenient. (2026-09-16)

## v0.1.80 — 2026-09-22

- add -birthday (alias of -b/-birthdays; one flag): `gcal add "<title>" "<date>" -birthday` creates a Google birthday event (eventType birthday, birthdayProperties.type birthday, all-day one day, RRULE:FREQ=YEARLY — Feb 29 uses BYMONTH=2;BYMONTHDAY=-1 — visibility private, transparency transparent, reminders kept). Google files it under its Birthdays layer. -rrule, -busy, -loc, -note and a day count are rejected. No conflict check (all-day, free). (2026-09-21)
- add AI mode: ExtractedEvent gained `birthday?: boolean`; the prompt sets it for "X's birthday is <date>" / "born on" (a birthday party at a time stays a timed event). -birthday forces it. Birthday events are built from the date part only. rmfmail's prompt copy NOT synced. (2026-09-21)
- list: birthdays tagged "[birthday]", or "[birthday, from contact]" when birthdayProperties.contact is set (was "[from contact]" for all). types.ts: BirthdayProperties added. Usage + README (new "Birthdays" section) updated. Live-tested add (explicit + AI) → list -b → del -b -all. (2026-09-21)

