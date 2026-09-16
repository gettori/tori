---
summary: a worktree switch is not backend or script time, it is one animation frame paying for panes reparenting stage hosts
status: current
updated: 2026-08-20
source: "The reveal path: verify the mismatch switch, then decide what it costs (personal/sway, branch `unified-tab-bar`), Phases 1 to 3, commits 6b0867b, be27425, dab0114, `src/utils/perfTrace.ts`, `src/utils/perfRecipe.ts`, `scripts/trace-report.mjs`"
---

# What a worktree switch actually spends its time on

Four separate theories about why a worktree switch costs what it costs were held
in turn, and three of them were wrong. This page is the measured answer, so the
fourth is not re-derived from scratch. The instrument is
[[concept_release_profile_tracing]]; this is what it found.

**The short version: it is not script.** On a build where a switch paints in
232ms, no invoke, no CodeMirror state work and no JavaScript on the path
accounts for more than a fifth of it. The rest is the renderer laying out and
painting surfaces that changed parent.

## The anatomy

A switch span runs from the click to a double-rAF after the workspace flip. The
`ws:flip` mark splits it in two, and the second half is the larger one:

| row | flip at | flip to paint | paint |
| --- | --- | --- | --- |
| `warm-ab` (no editor open) | 7-21 | 43-83 | 63-91 |
| `mismatch-control` (editor open, same shape) | 42-62 | 101-106 | 148-163 |
| `mismatch` (editor open, shape differs) | 44-74 | 175-199 | 232-264 |

What is *not* in there, all measured rather than assumed:

- **Not queue wait.** 1.5-1.8ms median across ~930 invokes per run, p90 2.5ms.
- **Not backend work.** Body durations are flat across all three rows (median
  26-41ms, max 42-63ms). They do not grow with the editor or with the shape.
- **Not CodeMirror state work.** `cm:setstate` to `cm:setstate-end` is 1-11ms,
  and the whole `cm:swap` to `cm:swapped` interval is 22-31ms.
- **Not the editor view being rebuilt.** Phase 3 removed the rebuild entirely
  (see [[component_cm6_editor]]) and the row did not move.

What *is* in there is the frame after the panes adopt their stage hosts, and it
scales with how many panes reparent:

| leg | panes adopting hosts | `pane:adopt` to `pane:refit` | paint |
| --- | --- | --- | --- |
| to the unsplit worktree | 1 | 89-95 | 146-214 |
| to the split one | 2 | 109-139 | 232-276 |

One animation frame, 100-130ms of it, with nothing scripted running inside it.
No mark can subdivide it, which is the finding rather than a limitation: it is
renderer layout and paint of surfaces that moved between pane wrappers
([[concept_shell_hosted_tabs]]).

## The instrument that found it

`traceMark(name)` stamps a named point on the open span; the marks ride out on
the switch line as a `marks` array and `trace-report.mjs` prints them as a
timeline with per-step deltas. Marks say **which code a main-thread block was
in**, which no invoke line can: an invoke only says when the backend answered
and when JS heard it, so a blocked main thread already shows up as a cluster of
callbacks landing together, with nothing naming the blocker.

Marks are placed at seams, not on hot paths: the workspace flip, the CodeMirror
swap path, a view attaching or being adopted, a pane adopting its hosts, the
terminal reveal and fit, and both frames of a tab span. A mark outside a span
costs one comparison and is dropped.

## Why the earlier readings were wrong

**Phase 1's per-invoke table looked like backend saturation** and was not. Nine
commands all answered at exactly +120ms, which reads as a queue. Joining the
`body` lines shows the backend had answered by +52 to +59ms; the uniform +120
was the main thread flushing every pending callback at once, after it was free
again. A cluster of identical arrival times is a *starved main thread*, not a
busy backend. Compare
[[lesson_paint_that_equals_the_last_invoke_is_starvation]].

**Phase 2 inferred the shape penalty was two CodeMirror view rebuilds per
switch**, because the marks showed exactly two `cm:attach` on a mismatch switch
and zero on the control. The inference was reasonable and wrong: phase 3 removed
both rebuilds and the number stayed where it was.

## Related

- [[concept_release_profile_tracing]] - the instrument
- [[component_perf_trace_harness]] - how to run it
- [[lesson_a_same_state_control_row]] - why the control row above is the whole result
- [[concept_shell_hosted_tabs]] - the stage hosts that reparent
- [[component_cm6_editor]] - the view that stopped being rebuilt
- [[concept_webgl_context_lru]] - the other thing the census watches across a switch
- [[gotcha_a_switch_span_whose_kind_the_settle_legs_never_admitted_times_out_silently]] - a span kind the settle legs never admitted, which reads in the report as a slow switch
- [[concept_feature_workspace]] - the second switch kind, which waits on the same tree and git legs
