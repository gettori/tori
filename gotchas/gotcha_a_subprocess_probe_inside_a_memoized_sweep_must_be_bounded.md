---
summary: an unbounded subprocess probe inside a memoized sweep strands the whole cached result when the child hangs
status: current
updated: 2026-07-19
source: "v0.1 release gate: adapter cards, releases, light mode, polish (personal/tori, branch `topbar`); Phase 1; `src-tauri/src/env.rs`"
---

# A subprocess probe inside a memoized sweep must be bounded

Do NOT spawn an agent CLI without a timeout inside a cached/memoized sweep. Why: one hanging binary strands not just its own probe but the whole memoized result and every later caller waiting on it. `env::output_with_timeout` (5s) waits on a worker thread rather than polling `try_wait`, deliberately: polling without draining stdout deadlocks on a child that outruns the pipe buffer, which is exactly the verbose-`--version`-banner case being guarded. Give the child `/dev/null` on stdin too, so a CLI that decides to prompt hits EOF instead of waiting forever on a terminal it can never get.
