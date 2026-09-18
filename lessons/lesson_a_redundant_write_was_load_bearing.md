---
summary: removing a tab click's redundant re-select fixed an invoke storm but intermittently dropped tabs from the strip
status: current
updated: 2026-08-20
source: "The reveal path: verify the mismatch switch, then decide what it costs (personal/tori, branch `unified-tab-bar`), Phase 4, commit c2b6526, `src/panels/LeftSidebar/LeftSidebar.tsx`, `src/App.tsx`, `src/utils/perfTrace.ts`"
---

# The redundant write was load-bearing, and removing it lost tabs

## What happened

Sub-marks on the tab-click span found something the plan had not predicted:
clicking a terminal tab issues 8 to 15 backend invokes. `selectTab` emits
`TERMINAL_TAB_FOCUSED`, the sidebar answers with `focusFromTerminalTab` ->
`selectBranchByFolder` -> `selectUnit` -> `onSelect`, and that writes a **fresh**
`Selection` object naming the worktree that is already selected. `selected` is a
plain signal, so every effect keyed on the root re-runs: git status, branches,
ahead/behind, the workspace settings overlay, a DAP sweep, an fs-watcher
restart, three tree listings. Their callbacks land between the two frames the
paint endpoint measures, which is why they set the p90.

The fix looked like one line. Two variants were built:

- value equality on the `selected` signal, so an identical re-select stops
  notifying;
- an early return in `focusFromTerminalTab` when the folder already matches.

Both worked: zero invokes per click, median 32ms, ten of twelve clicks flat on
the two-frame floor. **And both intermittently lost terminal tabs from the
strip**: 8 tabs instead of 11 after the terminals pass, 1 in the strip instead
of 4, and a later pass aborting for want of a tab it expected. Twice in three
runs with the guard in, zero times in a dozen runs without it.

The terminal hosts were all present either way (24 of them), so the tabs were
created and then not placed. Something on the workspace-selection path is
load-bearing for tab placement. Both variants were reverted.

## Why

A write that produces no *visible* change is not the same as a write that
produces no change. This one re-notified a signal that a dozen effects hang off,
and at least one of them was doing work the tab bookkeeping depended on, in a
way nothing in the code says out loud. The coupling only appears under timing:
it reproduced in two runs of three, not three of three, which is exactly the
profile that makes a change look safe in a quick check.

The cost of shipping it was not "the fix might be wrong". It was "a latency win
traded for a correctness bug that shows up in one session out of three".

## What to do next time

- **Name what depends on a redundant write before deleting it.** Not "nothing
  looks like it uses this", which is what a grep gives you. A signal with many
  subscribers is a broadcast, and the subscriber list is the search.
- **Run the perf harness enough times to see an intermittent regression.** One
  clean run said the fix was good. The census fields (`tabs`, `tab-count`, the
  end counts) are what caught it, and they only caught it because the recipe
  records them every run and a later pass aborts loudly when its fixture is
  missing.
- **A correctness census beside a latency number pays for itself.** The whole
  point of measuring the tab counts on a perf run is this case: the number you
  were optimising got better and something else quietly broke.
- **Write the finding down even when the fix is reverted.** The cause is named,
  measured and reproducible; the next person starts from "why does placement
  depend on the re-select" rather than from the invoke storm.

## Related

- [[gotcha_clicking_a_terminal_tab_re_selects_the_workspace_it_is_already_in]] - the trap in one line
- [[concept_switch_cost_anatomy]] - the instrument that found it
- [[component_perf_trace_harness]] - the census that caught the regression
- [[concept_workspace_tab_grouping]] - the placement this turned out to depend on
- [[lesson_a_solid_effect_inherits_the_change_rate_of_what_it_reads]] - the neighbouring Solid trap
