---
summary: js-debug fires initialized more than once, a second configuration pass resends setBreakpoints and wipes the first set
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP), Phase 1 spike (personal/tori, branch `wave-8`); `src/utils/dapSessions.ts:298`; commit 1e72ae1"
---

# js-debug emits `initialized` more than once per session

Do NOT run the configuration sequence on every `initialized` event. The second pass re-sends `setBreakpoints`, which *replaces* that file's set, and at that moment js-debug answers `[]`, silently wiping the provisional breakpoints the first pass registered. Configure exactly once per session (`configureOnce`). Why: the symptom is a breakpoint that simply never fires, with no error anywhere, so it reads as a source-map or a binding problem rather than as a handshake one.
