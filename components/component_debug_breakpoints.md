---
summary: breakpoints bind from live events not the setBreakpoints response, which always answers verified false
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP) (personal/sway, branch `wave-8`); Phase 6; epic #69, sub-issue #72; commit 70fa87c"
---

# Debug breakpoints: a pure store, a mapped gutter, and one sync

**Location:** `src/utils/breakpoints.ts`, `src/utils/debugBreakpoints.ts`, `src/panels/Editor/breakpointGutter.ts`

Three files with one split, the same one `bookmarks.ts` and `bookmarkGutter.ts` established: **the rules about a list are testable without a debug run, and the wire is not.** `breakpoints.ts` is the pure workspace-keyed store (toggle, per-file listing, dropping an emptied file and workspace, same object on a no-op). `debugBreakpoints.ts` is the live half that syncs to sessions and holds bound state. `breakpointGutter.ts` is the CodeMirror column.

## The store and the gutter

Workspace-keyed and localStorage-backed, joining [[concept_path_keyed_workspace_stores]] alongside bookmarks and watches. A toggle that changes nothing returns the same store object, so nothing downstream re-renders.

The gutter carries a `RangeSet` **mapped through edits**, so ten lines inserted above a breakpoint leave it naming the same code line rather than the same number. A spacer marker keeps the column from collapsing when a file has no breakpoints, and the breakpoint column sits left of nothing and right of the bookmark column.

## Bound state comes from events, not from the response

**`setBreakpoints` always answers `verified: false`.** Phase 1 measured every response coming back `verified: false, message: "breakpoint.provisionalBreakpoint"`, including for breakpoints that then bound and stopped the program. The response therefore cannot drive a verified/unverified marker; that comes from `breakpoint` change events. See [[gotcha_dap_setbreakpoints_always_answers_verified_false]].

## A breakpoint in a dirty buffer is pending, not armed

The store holds line numbers, and an unsaved buffer's line numbers describe code the adapter cannot see. Rather than arming a breakpoint against stale lines, a dirty buffer's breakpoints render as pending and the resync runs **after** the on-save edit pipeline. Visibly refusing to arm beats silently debugging the wrong line.

## Sync cost, measured

A toggle sends one `setBreakpoints` **per session**, and a session tree is not small: **214 sessions on the measured `pnpm test` run**. It is correct (every leaf must learn about the change) and it is the known cost of the shape; nothing coalesces it today.

## Key files & entry points

- `src/utils/breakpoints.ts`, the pure store, mirroring `bookmarks.ts`
- `src/utils/debugBreakpoints.ts:90`, `toggleBreakpointAt`: write, then push to every session
- `src/panels/Editor/breakpointGutter.ts`, the gutter and its mapped `RangeSet`

## Connections

- Mirrors `bookmarks.ts` + `bookmarkGutter.ts`, same pure/live split, same gutter shape
- Pushes through [[component_debug_session_tree]]
- Rendered beside [[component_cm6_editor]]'s other gutters

## Related

- [[concept_path_keyed_workspace_stores]], the store family it joins
- [[lesson_pure_core_for_global_stores]], why the rules are a separate file
- [[gotcha_dap_setbreakpoints_always_answers_verified_false]]
- [[gotcha_js_debug_emits_initialized_more_than_once_per_session]], the other way a breakpoint silently never fires
- [[gotcha_a_cm6_gutter_marker_needs_startside_1_or_the_line_you_just_typed_inherits_its_neighbours_blame]]

## Does NOT

Support conditional, hit-count or logpoint breakpoints, configure exception breakpoints, or arm a breakpoint whose buffer is unsaved.
