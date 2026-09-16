# npm Publish Changes

## v0.1.78 — 2026-09-11

- Accept -cal as alias for -c/-calendar; document partial-match calendar selection in usage and README (2026-09-11)

## v0.1.79 — 2026-09-16

- add: check for conflicts before creating. checkProximity now returns the count of overlapping BUSY events (free ones listed as "(free)", not counted). A busy new event overlapping a busy existing one asks "Create anyway? [y/N]" — default No, no 60s auto-yes. A -free event never asks. Explicit and AI modes both. (2026-09-16)
- add: events default to busy (transparency=opaque) unless -free, or in AI mode the text says so — ExtractedEvent gained `free?: boolean`, extraction prompt sets it for "free"/"tentative"/"optional"/"FYI"/"hold". -free/-busy flags override the text. Output now always prints "Shows as: busy|free". (2026-09-16)
- checkProximity: a failed conflict lookup now prints a warning instead of silently returning. (2026-09-16)
- Note: rmfmail's copy of the extraction prompt (mailx-service extractEventGcalStyle) was NOT updated; sync when convenient. (2026-09-16)

