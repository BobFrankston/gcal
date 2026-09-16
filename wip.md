
## Done, awaiting npmglobalize: add-time conflict gate + busy-by-default (2026-09-16, Claude Code Fable 5.1)

Bob: "check for conflicts when adding appointments and default to marking the times as busy unless I add -free or the text says it".
Plan (gcal.ts + glib/aihelper.ts):
1. checkProximity returns count of overlapping *busy* existing events (free ones reported as "OVERLAPS (free)").
2. `add` explicit mode: transparency defaults to 'opaque'; on busy conflict prompt "Create anyway? [y/N]".
3. `add` AI mode: ExtractedEvent gains `free?: boolean` (prompt tells Claude to set it when text says free/tentative/optional/FYI); transparency = -free/-busy flag, else extracted.free, else opaque. Conflict → confirm prompt defaults to No, no auto-yes timer.
4. Usage text, README, .commitmsg updated. update/resched keep warning-only behaviour (not in scope).
Status: all four steps implemented, compiled clean (npx -p typescript@5.7.3 tsc), .commitmsg written. Not committed/published — Bob runs npmglobalize. Not live-tested against the API (needs a real overlapping slot); explicit + AI paths reviewed by reading. rmfmail's prompt copy not synced.
