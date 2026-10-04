---
summary: a release build trace rig with marks and a mismatch pass control row, run deliberately and never gating anything
status: current
updated: 2026-08-20
source: "Worktree and tab switching at native speed (personal/tori, branch `unified-tab-bar`), Phases 1 and 7, commits 4b8287f, 267fc4a; The reveal path: verify the mismatch switch, then decide what it costs (same branch), Phases 1 to 4, commits 6b0867b, be27425, dab0114, c2b6526"
---

# Performance trace harness

**Location:** `src-tauri/src/trace.rs`, `src/utils/perfTrace.ts`, `src/utils/tracedCore.ts`, `src/utils/perfRecipe.ts`, `scripts/trace-report.mjs` (wired at `src/index.tsx`, `src/App.tsx`, aliased in `vite.config.ts`)

The measurement rig for the shipped release build: two trace writers, a
self-driving degradation recipe, and a report script that joins them. It turns
"switching feels slow" into a reproducible table with paint, settled, queue
wait, and per-invoke thread attribution. See
[[concept_release_profile_tracing]] for the mechanism and why it has this
shape.

## Responsibilities

- Write correlated backend and frontend traces to `~/.config/tori/trace/`,
  only when asked by env var.
- Drive the app through a fixed sequence so the slow state is reproducible.
- Report the rows the targets are read from.
- It does **not** gate anything; this is a debugging tool that is run
  deliberately. Counts and bytes that should fail a change are gated in the
  normal test suites instead, by [[concept_perf_budgets]].

## Key files & entry points

- `src-tauri/src/trace.rs` - `traced` wraps `generate_handler!`, one `cmd` line
  per command with IPC arrival, return, thread id.
- `src/utils/tracedCore.ts` - the build-time invoke seam, aliased over
  `@tauri-apps/api/core` by `vite.config.ts` in production builds only.
- `src/utils/perfTrace.ts` - spans, the `done` latch, `traceNote`, flush.
- `src/utils/perfRecipe.ts` - the scripted recipe; runs only when both
  `TORI_TRACE` and `TORI_RECIPE` are set.
- `scripts/trace-report.mjs` - joins both files; `--invokes` for every call.

## What it grew (2026-08-20)

- **Marks.** `traceMark(name)` stamps a named point on the open span, emitted as
  a `marks` array on the switch line and printed as a timeline with per-step
  deltas. This is what turns "the main thread was blocked" into "it was blocked
  here", which no invoke line can say. See [[concept_switch_cost_anatomy]].
- **The `mismatch` pass**, run idle between `tab-clicks` and `stream-start`:
  opens a file in worktree A, splits a pane, moves a terminal into it, then A/Bs
  against unsplit worktree B, and restores what it changed. It takes a
  **same-shape control switch first**, on the same surfaces, which is the row
  that made the result readable at all ([[lesson_a_same_state_control_row]]).
- **A positive control on the surfaces, not the wrappers.** Across a mismatch
  switch the `[data-stage-host]` elements must be the **same objects** while the
  `.pane` wrappers are different ones; across the control switch all four are
  identical. Wrappers differ between a 2-pane and a 1-pane workspace by
  construction, so asserting on them proves nothing.
- **State checks that can fail.** A named sentinel line in the terminal rather
  than a hash of the visible window (reflow legitimately rewraps), and for the
  editor the **first visible line** rather than the pixel offset (a split halves
  the pane and the document rewraps). The caret sits at 10% of the document and
  the scroll at 60%, deliberately different, so a caret-centred restore cannot
  pass by accident.
- **`editorProbe`** enumerates **every** editor stage host with the view inside
  it. Probing only the first one is how a split's unmeasured view went unnoticed.
- **A `validity` block** in the report: null paints, the max intra-pass gap
  between consecutive switch starts, and a verdict. Gaps are per-pass and skip
  each pass's first switch, because the recipe's own scripted pauses between
  passes run to seconds.
- **A tab span arms its paint at the click**, so `raf1` and `raf2` are marked:
  its number is the handler plus two frames, and reading it as one number hides
  which half moved.

## How to run it

```
pnpm tauri build --bundles app
rm -rf ~/.config/tori/trace
TORI_TRACE=1 TORI_RECIPE=6x4x3 \
  src-tauri/target/release/bundle/macos/Tori.app/Contents/MacOS/tori
node scripts/trace-report.mjs
```

`TORI_RECIPE` is `<worktrees>x<terminals-each>x<ab-rounds>`. The app drives
itself and exits on its own. `TORI_TRACE=1` alone traces manual clicking.

**Keep the window frontmost for the whole run.** See
[[lesson_an_occluded_window_reports_no_paint]].

## Connections

- Measures [[concept_command_execution_tiers]] - the `cmd` vs `body` lines
- Records the census behind [[concept_webgl_context_lru]] - `liveWebglContexts`
- Governed by [[adr_no_sync_ipc_commands]] - the rule its numbers justified

## Related

- [[concept_release_profile_tracing]] - the mechanism
- [[concept_perf_budgets]] - the gating sibling: counts and bytes held in `cargo test` and `pnpm test`
- [[concept_switch_cost_anatomy]] - what it found, so it is not re-derived
- [[lesson_a_same_state_control_row]] - why the control row is in the same run
- [[lesson_a_redundant_write_was_load_bearing]] - the census beside the latency number earning its keep
- [[concept_trusted_input_verification]] - the other harness; tab clicks here go through the real strip because its gesture guard checks in-flight state, not trustedness
- [[gotcha_the_tauri_internals_invoke_cannot_be_hooked_at_runtime]] - why the seam is build-time
