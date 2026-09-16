---
summary: an async fetch keyed on a fast changing selection can resolve stale and overwrite fresh data, guard with a request id
status: current
updated: 2026-07-18
source: "Session worklog: status dot, touched files, panels (personal/sway, branch `topbar`); `src/panels/LeftSidebar/LeftSidebar.tsx` (`touchedCountFor`), `src/panels/Editor/SessionPanel.tsx` (`requestFor`), `src/panels/Editor/TranscriptViewer.tsx` (`requestFor`); see [[component_session_worklog]]"
---

# A request bound to a fast-changing selection needs a latest-request-wins guard

Do NOT fire an async fetch keyed on "the currently selected thing" (a session, a tab) without a guard that discards the response if the selection has since moved on. Why: a slower fetch for the *previous* selection can resolve **after** a faster fetch for the *new* one, silently overwriting correct data with stale data for the wrong item — no error, no crash, just a wrong number or wrong transcript on screen. The fix is a module-local `let requestFor: string | null` set to the request's key right before the call, checked against the current key after the `await` before calling any setter. Hit three times in one ticket: `LeftSidebar.tsx`'s `loadTouchedCount` (switching selected sessions), `SessionPanel.tsx`'s `refreshTouched`/`refreshCollisions`, and `TranscriptViewer.tsx`'s `loadLatest`/`loadOlder` (switching transcript tabs) — the second and third were caught only by self-review, not by testing, since the race needs a fast double-switch to manifest.
