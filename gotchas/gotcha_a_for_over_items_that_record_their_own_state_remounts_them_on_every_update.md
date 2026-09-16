---
summary: a For keyed by object identity remounts a row when your code replaces it to record state, killing a live TerminalView
status: current
updated: 2026-09-03
source: "plan \"Jobs: transient command terminals leave the tab model\" (personal/sway, branch `bugfix-260903`), Phase 2 self-review; `src/panels/Jobs/Jobs.tsx`, pinned by `src/panels/Jobs/jobSurfaces.test.tsx` (both deleted in `d4a59d3`; the same rule is why `commandStatus` is a signal keyed by id and never a field on `OpenTerm`, `src/panels/Terminal/commandStatus.ts:16`) (\"stays on screen on a non-zero code, wearing it\"); commit `3a9f882`"
---

# A For over items that record their own state remounts them on every update

Do NOT render a `<For>` over objects your own code replaces to record a state change, when the rows own something destructible. Why: `<For>` keys by object identity, so `setJobs(jobs().map(j => j.id === id ? {...j, state} : j))` disposes and rebuilds that row. A job's row holds a `TerminalView`, whose `onCleanup` calls `pty_kill`, so recording "this job failed" killed the process and wiped the output the failure exists to show. Iterate the ids (`<For each={jobs().map(j => j.id)}>`) and read the immutable fields once, untracked; a string id is stable across every state change. Distinct from the two entries above: there is no reorder and no recomputed group, only the item saying what happened to it.
