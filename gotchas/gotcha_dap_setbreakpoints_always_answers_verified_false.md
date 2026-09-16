---
summary: DAP setBreakpoints always answers verified false even for bound breakpoints, drive the marker from breakpoint events
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP), Phase 1 spike (personal/sway, branch `wave-8`); `src/utils/debugBreakpoints.ts`; commit 70fa87c"
---

# DAP `setBreakpoints` always answers `verified: false`

Do NOT drive a verified/unverified breakpoint marker from the `setBreakpoints` response. Every response measured came back `verified: false, message: "breakpoint.provisionalBreakpoint"`, including for breakpoints that then bound and stopped the program. Bound state comes from `breakpoint` change events instead. Why: the response is the obvious source and it is never true, so a marker built on it is permanently hollow and looks like a broken breakpoint.
