---
summary: rows in perf-budgets.json are measured by cargo test and pnpm test; counts exact, bytes fail over or 10% under, never ms
status: current
updated: 2026-10-04
source: "Gate performance with deterministic budgets in tests (personal/tori, branch `determinstic-budget-in-tests`, gettori/tickets#6); `perf-budgets.json`, `src-tauri/src/perf_budgets.rs`, `src/test/perfBudgets.ts`, `src/appPerfBudgets.test.tsx`, `src-tauri/src/exec.rs` (`git_spawns_under`); commits 048f1138, c2b709bb"
---

# Performance budgets

A performance regression in Tori used to be found by feel, because the only
instrument was [[component_perf_trace_harness]], which measures a release build
and gates nothing. The budgets are the gate beside it: one table of rows, each a
name, a number and a reason, measured inside the normal test suites. A change
that grows a payload, adds an invoke to a switch or adds a git process to a
refresh fails `cargo test` or `pnpm test` locally. Raising a budget means
editing its row and its reason, which shows up in review.

## How it works

`perf-budgets.json` at the repo root is the single table. A row is
`{ name, runtime: "rust" | "webview", unit: "count" | "bytes", budget, reason }`.
Each runtime reads it, measures every row tagged with its own runtime, and runs
the same comparison (`drift` in both `src-tauri/src/perf_budgets.rs` and
`src/test/perfBudgets.ts`):

- `count` must equal the budget exactly, in either direction.
- `bytes` fails above the budget, and also when it falls 10% or more under it,
  so a win forces the row down instead of leaving slack for the next regression.
- A row nobody measures fails, and a measurement with no row fails, so the
  table and the measurers cannot drift apart.

Seven rows today:

- `chat_history.bytes.*` (rust): the reply for three generated claude
  transcripts (small, 2000 turns, one 5 MB tool output that must stay cut near
  `TOOL_OUTPUT_CAP`). Measured through `history_reply`, the function the
  `chat_history` command itself calls.
- `git.spawns.sidebar.cold` / `.warm` (rust): git processes for one sidebar
  refresh, `get_config`'s project probe plus `git_branch_sync_many`, on a fixture
  of one worktree container and one plain repo. Counted by a test-only map in
  `exec.rs` keyed by repo path, bumped wherever `git_in` builds a command.
  Keyed rather than thread local because the probe and the batch run git on
  worker threads; a test reads only the paths under its own tempdir.
- `invokes.switch.worktree` / `.tab` (webview): invokes fired by one warm
  worktree switch and one tab switch, with the real App, sidebar, terminal and
  editor panels mounted and only the xterm, CodeMirror and chat views stubbed.
  Runs under fake timers; `settle()` advances 1 s at a time (which also runs
  frames) until the invoke count holds for two rounds, and throws if it never
  does. A test repeats each switch 20 times to prove the count is stable.

Every row was proven able to fail before it was trusted: dropping the output
cut, making `cached_probe` always miss, and adding a stray invoke on the switch
path (direct and behind a frame) each turned its row red.

## Why it is this way

- **Counts and bytes, never milliseconds.** A timing seen only across runs is
  machine noise, and a gate that flakes gets ignored.
- **In the normal suites, not a separate command.** The counts are cheap and
  deterministic; a separate command only fails when someone remembers it.
- **One shared JSON** so a raise shows up in one reviewed place. Per runtime
  constants were typed and commentable but split the table in two.
- **Real panels for the switch rows.** The stubbed App harnesses count only the
  shell's invokes; see [[lesson_a_gate_only_sees_the_configuration_the_test_builds]].

The warm git row has a known blind spot: the batch gets no rows on a warm
refresh because `branchSync.ts` only asks about rows it has not drawn. That rule
lives in the webview, so a change to it does not move this row.

## Related

- [[component_perf_trace_harness]] - the release build instrument this gates beside
- [[lesson_a_gate_that_cannot_fail_is_not_a_gate]] - why every row has a negative control
- [[lesson_a_gate_only_sees_the_configuration_the_test_builds]] - why the measurers call the shipped functions and mount real panels
- [[gotcha_the_git_gate_guard_reads_a_test_only_module_as_shipped]] - why the git fixture builds through `git_in`
- [[gotcha_mtime_cache_must_key_on_dir_mtime_and_head]] - the cache the warm git row pins
- [[gotcha_reverting_a_mutation_with_git_checkout_restores_head_not_your_work]] - how the negative controls were restored
