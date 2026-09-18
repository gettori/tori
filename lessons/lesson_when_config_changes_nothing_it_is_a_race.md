---
summary: four source map config variants changed a breakpoint's binding not at all, since js-debug resolves maps after exit
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP) (personal/tori, branch `wave-8`); Phase 1 spike; epic #69; `src/utils/debugTargets.ts:63`; commit 2a77eac"
---

# When four config variants change nothing, stop tuning config

## What happened

A breakpoint set in a `.ts` file never bound when debugging a short TypeScript program, and the same breakpoint bound fine against a long-running one. Everything about it looked like a source-map configuration problem, so the spike tested four variants of `outFiles` and `resolveSourceMapLocations` across two program lifetimes. **All four made no difference at all**, in either direction. Meanwhile the defaults worked perfectly for the long-running target, and vitest's esbuild-transformed `.ts` mapped correctly with no build step and no `outFiles` whatsoever.

## Why

It was never a configuration problem. js-debug resolves a source map *asynchronously* after the target starts, and a short-lived program runs to completion before the resolution finishes. There is no window in which the breakpoint can be registered against the mapped location, so it is not that the map is wrong, it is that the program is already gone.

The fix is `stopOnEntry: true` plus an immediate auto-continue: the entry pause **creates** the window. With it, the short TS target stops at `src/index.ts:6` with correct locals.

The signal was in the data the whole time. Two axes were varied (config and lifetime) and only one of them moved the outcome. Four negative results on the same axis is not four inconclusive experiments, it is one conclusive one about that axis.

## What to do next time

**When several variations of one input all produce the same result, treat that axis as ruled out and go looking for a timing or lifetime difference instead of tuning harder.** Vary the axis that is not in the config: how long the thing lives, when it starts, what finishes first. Write the negative result down explicitly ("four variants, no difference") rather than moving on quietly, because the negative result is the finding.

The corollary for planning: this invalidated a task that had already been written into a later phase in terms of `outFiles`. A spike that measures before the phases run is what let that be corrected on paper instead of in code.

## Related

- [[component_debug_launch]], where `stopOnEntry` lives and why it is launch-only
- [[lesson_fix_the_kill_threshold_before_measuring]], the discipline this spike ran under
- [[concept_dap_session_tree]], the other assumption the same spike overturned
