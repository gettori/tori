---
summary: a shipped build with no devtools is measured by two correlated json lines traces joined by a correlation id per invoke
status: current
updated: 2026-08-20
source: Worktree and tab switching at native speed (personal/tori, branch `unified-tab-bar`), Phase 1, commit 4b8287f, `src-tauri/src/trace.rs`, `src/utils/perfTrace.ts`, `src/utils/tracedCore.ts`
---

# Measuring a release build that has no devtools

Tori's release bundle has no devtools (the `devtools` feature is absent from
`src-tauri/Cargo.toml` and `tauri.conf.json`), so any performance claim about
the shipped app has to be measured without a console. The answer is two
JSON-lines files under `~/.config/tori/trace/`, written by both sides of the
IPC boundary and joined afterwards by a correlation id. This is what made
"the switch is slow" into a table of numbers with named causes.

## How it works

- **Toggle.** `TORI_TRACE=1` read at backend startup and exposed to the
  frontend via a command. Without it neither file is written, so the
  instrumentation ships in the binary and costs nothing unasked.
- **Backend.** `trace::traced` wraps `generate_handler!`, stamping IPC arrival,
  handler return and thread id for every command as a `{"t":"cmd"}` line.
  `exec::blocking` adds a `{"t":"body"}` line for the real work. See
  [[concept_command_execution_tiers]] for why both exist.
- **Frontend.** Each invoke carries a correlation id in the argument map as
  `__toriTrace`, so **queue wait is `backend.enter - js.call`**, subtracted
  rather than guessed. That single number is what distinguishes "the command
  was slow" from "the command was waiting".
- **Both sides use wall-clock epoch ms**, because `Instant` and
  `performance.now()` share no origin.
- **Endpoints are separate.** `paint` is a double-rAF after the workspace flip;
  `settled` is tree listing plus git status rendered. Reporting one number
  hides which half is slow.
- **Marks are the third record** (added 2026-08-20). `traceMark(name)` stamps a
  named point on the open span and it rides out on the switch line. Invokes say
  *when* the backend answered and when JS heard it, so a blocked main thread
  shows up as a cluster of callbacks landing together with nothing naming the
  blocker; a mark says which code the block was in. Callers are seams on the
  switch path, never hot paths, and a mark outside a span costs one comparison
  and is dropped. A callback that lands after the next switch opened is stamped
  on **its own** span rather than the current one.
- **A tab span arms its paint at the click**, not at a flip, because there is no
  flip effect to observe. So a tab row is "the handler plus two frames", and
  both frames are marked so the two halves can be told apart.
- **`scripts/trace-report.mjs`** joins the two files into a row per switch plus
  a per-invoke breakdown (`--invokes` for all of them), the marks timeline with
  per-step deltas, and a validity verdict.

## Why it's this way

**The invoke hook has to be build-time.** Installing it at runtime is not
possible: `__TAURI_INTERNALS__.invoke` is a readonly property and
`__TAURI_INTERNALS__` is itself a non-configurable global, so neither assigning
to it nor shadowing its object works. The seam that does work is
`vite.config.ts` aliasing every `@tauri-apps/api/core` import to
`src/utils/tracedCore.ts`, production build only, which is why the ~300 suites
that `vi.mock("@tauri-apps/api/core")` keep mocking exactly what they always
did. See [[gotcha_the_tauri_internals_invoke_cannot_be_hooked_at_runtime]].

**The profile is pinned** because a number without one is not comparable:
`pnpm tauri build --bundles app`, Cargo's default `release`, the Vite
production build. Every row in the plan's baseline and after tables names it.

**Spans carry a `done` latch.** Four paths reach `emit` and a fired timer
cannot be unfired, so a span could otherwise be written twice when it settled
in the same tick it timed out.

## Related

- [[component_perf_trace_harness]] - the files and the scripted recipe
- [[concept_command_execution_tiers]] - the `cmd` vs `body` distinction
- [[concept_switch_cost_anatomy]] - what it found once marks were added
- [[lesson_paint_that_equals_the_last_invoke_is_starvation]] - the first thing this instrument found
- [[lesson_an_occluded_window_reports_no_paint]] - how to invalidate a run
- [[adr_no_sync_ipc_commands]] - the decision these measurements drove
