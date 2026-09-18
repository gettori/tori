---
summary: a paused debuggee's variablesReference answers the old value after a write, so trust the write's own reply
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP) (personal/tori, branch `wave-8`); Phases 7-9; epic #69; `src/utils/debugVariables.ts:264`, `src/utils/debugWatch.ts:162`; commits 4d396a8, 1c1fbf6"
---

# A pause is a snapshot, and its references go stale in place

Everything a stopped program tells you is a reading taken at one instant, and DAP gives you no event when a reading expires. A `variablesReference` is not a pointer into the debuggee, it is a handle onto a snapshot: it keeps answering, and what it answers keeps being the old value. The whole variables/watch layer is built around that, and the two rules it produces are **trust the write's own response, not a re-read** and **stamp every request with the pause it was asked under**.

## How it works

**Measured against js-debug 1.117.** After a successful `setVariable` that changes `count` from 3 to 42:

- `evaluate` on `count` answers `42`, the truth.
- Re-reading the container answers `3`.
- Re-requesting `scopes` and reading the *fresh* container still answers `3`.

So the response body of `setVariable` is the only fresh reading available for the row that was written, and `setVariableValue` (`src/utils/debugVariables.ts:264`) takes it and collapses that row rather than re-fetching. A write's effect on *sibling* rows is simply invisible until the next stop, which is why `refreshWatches()` is called after a write as well as on every frame change: `evaluate` is the one thing that is current, so watches are the surface that can tell the truth about a written variable.

**Generation counters, not cancellation.** Every in-flight `variables` / `evaluate` reply carries the generation it was asked under, and a reply that lands after the program stepped is dropped. Its references are already dead, and rendering it would show the previous frame's values under the current frame's name. `debugVariables.ts` and `debugWatch.ts` each hold their own counter; a paged fetch checks it between the named and indexed halves as well as at the end.

**Nothing is auto-expanded.** Children are fetched on expand, never on stop, both because a Global scope is enormous and because a snapshot you never asked for is a request whose answer you cannot use.

## Why it's this way

Because the alternative reads as a bug in the user's program. A variables tree that re-reads after a write shows the old number next to a write that succeeded, and the natural conclusion is that the write did not take. Trusting the response body is not an optimisation, it is the only way to be correct.

And because a debugger's UI is one race away from lying. Between asking for a scope and getting it, the user can step; between asking for a watch and getting it, a worker can hit a breakpoint. Without a generation stamp every one of those lands as a plausible, wrong value with no way to tell.

## Related

- [[component_debug_panel]], the tree, the watches and the hover built on this
- [[concept_dap_session_tree]], the other measured shape of a run
- [[gotcha_a_dap_scope_reference_is_a_snapshot_of_its_pause]]
- [[gotcha_a_request_bound_to_a_fast_changing_selection_needs_a_latest_request_wins_guard]], the same rule, met earlier in a different surface
