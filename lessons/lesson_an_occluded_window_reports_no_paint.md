---
summary: a hidden window makes every double rAF measurement report null paint, which reads like a catastrophic regression
status: current
updated: 2026-08-20
source: Worktree and tab switching at native speed (personal/sway, branch `unified-tab-bar`), Phases 5 and 7, commits 565dbf9, 267fc4a, `src/utils/perfRecipe.ts`
---

# An occluded window reports no paint, and it looks exactly like a regression

## What happened

Three consecutive recipe runs in phase 5 produced `paint: null` on every row,
each taking many times longer than normal, and were read as a catastrophic
regression before anyone noticed the app window had gone behind another one.
Phase 7 then lost a fourth run to the same thing: the first-visit pass logged
three null spans and a 124-second gap, followed by a 470/2022ms "recovery" row
that would have looked like a real data point in isolation.

## Why

`paint` and `settled` are double-rAF measurements. An occluded window gets no
frames, so the callback never fires and every switch sits until its 8s timeout.
The failure mode is nasty because it is **partially convincing**: only the
passes that ran while the window was hidden are affected, the rest of the run
agrees with a good run, and the recovery row after the window returns carries a
plausible-looking number that is pure artifact.

## What to do next time

**Keep the window frontmost for the whole run, and treat any `paint: null` as
an invalid run rather than a slow one.** This is now written into
`src/utils/perfRecipe.ts`'s doc comment so it is read where the recipe is read.

When a run is partially contaminated, **discard the affected pass and say so**
rather than discarding the whole run or quietly keeping the recovery row.
Phase 7 reported three runs and used runs 2 and 3 as the matched pair for
exactly this reason.

More generally: before believing a large regression, ask what in the
environment could produce that exact signature. A number that is null or
order-of-magnitude off is more often the harness than the code. Compare
[[lesson_debug_the_harness_before_recording_the_outcome]].

## Related

- [[component_perf_trace_harness]] - the recipe and how to run it
- [[concept_release_profile_tracing]] - why the endpoints are double-rAF
- [[lesson_paint_that_equals_the_last_invoke_is_starvation]] - the other way a paint number lies
