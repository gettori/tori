---
summary: a perf control must run in the same pass and state as the row it controls, a gap seen only across runs is machine noise
status: current
updated: 2026-08-20
source: "The reveal path: verify the mismatch switch, then decide what it costs (personal/sway, branch `unified-tab-bar`), Phases 1 and 3, commits 6b0867b, dab0114, `src/utils/perfRecipe.ts`"
---

# The control has to be in the same run, and a gap that moves between runs is not a gap

## What happened

A pass was built to measure the switch path nobody had instrumented: a
shape-mismatch worktree switch, where a pane subtree is disposed and its
surfaces reparented. It measured 232-247ms paint, against 82-83ms for the same
recipe's ordinary warm switch. Read alone, that is a 3x regression on the exact
path a multi-day redesign was gated on.

The pass also took a **same-shape control switch, in the same run, in the same
state**: editor open, same file, same terminals, only the shape not differing.
It measured 229-233ms. Identical.

So the 3x had nothing to do with the shape. It was the cost of having a loaded
CodeMirror view on screen at all, which the ordinary warm row did not have
because the recipe never opened a file. Without the control, the run would have
sent the next phase after the wrong thing.

Then it went the other way. Phase 2, with the recipe's setup changed, measured
`mismatch` at 232-264 against `mismatch-control` at 148-163: an ~85ms gap that
reversed the earlier decision and opened the redesign phase. Phase 3 built the
thing that gap called for, and in its two final runs the same two rows read
232-233 and 232. The gap was gone, on the same build, with no change between
them that touched the path.

## Why

Two different failures, one root: **a comparison is only as good as what varies
between its two halves.**

- Across *rows*, the mismatch row and the warm row differed in two ways at once
  (shape and editor), so the difference could not be attributed to either. The
  control isolates one variable by holding everything else at the value the
  measured row has.
- Across *runs*, the machine is a variable too. Thermal state, another process,
  whatever the window manager is doing. Two rows measured in the same run share
  all of it; two rows measured twenty minutes apart share none of it.

The second failure is the more dangerous one, because a gap between two rows in
one run *looks* controlled. It is controlled for everything except the run.

## What to do next time

- **Put the control in the same run as the thing it controls**, in the same
  state, differing in exactly the variable under test. The mismatch pass takes
  its control switch before it splits the pane, on the same file and the same
  terminals.
- **Before acting on a gap between two rows, reproduce the gap**, not the rows.
  Two valid runs showing both rows is the bar; the phase-2 decision rested on
  one run's gap and phase 3 could not reproduce it.
- **Say which comparisons a table supports.** Both phases wrote into their notes
  that only the within-run relationships were comparable and that the drop in an
  absolute number between builds must not be read as an improvement. Phase 2's
  `mismatch-control` fell from 229-233 to 148-163 across builds while `warm-ab`
  fell by a similar fraction, which is the signature of the machine moving, not
  the code.

## Related

- [[concept_switch_cost_anatomy]] - what the controlled comparison eventually showed
- [[component_perf_trace_harness]] - the recipe that takes the control row
- [[lesson_an_occluded_window_reports_no_paint]] - the other way a run lies to you
- [[lesson_a_cut_settles_only_what_was_measured]] - the neighbouring discipline
