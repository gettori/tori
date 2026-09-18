---
summary: diff `-U` context width also sets hunk boundaries, widening it to collapse unchanged regions coarsens hunk staging too
status: current
updated: 2026-07-20
source: "Editor upgrades: diff polish, hunk staging, diagnostics (personal/tori, phases 1-2); commits d1a6844, 01f0196; `src/panels/Editor/ReviewPanel.tsx` (`DIFF_CONTEXT`), `src/utils/diffView.ts` (`hunkGaps`)"
---

# Diff context width and hunk granularity are the same knob

## What happened

Phase 1 added "collapse unchanged regions" to the Changes panel. Git's default `-U3` leaves no unchanged middle *inside* a hunk to collapse, so the panel asked for `-U24` and collapsed back down in the UI. That shipped and worked. Phase 2 then added hunk-level staging onto the same rendered hunks — and the two features turned out to be in direct conflict, because **`-U` decides where hunk boundaries fall**. Measured on a 60-line file with three edits 20 lines apart: **3 separately-stageable hunks at `-U3` and `-U8`, but 1 un-splittable hunk at `-U24`.** On real code, most edits are within ~48 lines of each other, so `-U24` would have made hunk staging useless while looking fine in a demo.

## Why

Git merges two changes into one hunk when the gap between them is at most `2 × context` lines. Widening the context to manufacture collapsible material therefore coarsens the staging unit by exactly the same amount. The two features want opposite ends of one dial, and nothing in either feature's own tests would reveal it: the collapse tests pass at `-U24`, the staging tests pass at `-U3`, and each is correct in isolation.

## What to do next time

- **Treat `-U` as a semantic choice about the staging unit, not a display preference.** Anything that renders hunks the user can *act on* should diff at git's default, so a rendered hunk is exactly what `git add -p` would stage. Users already have expectations here; a coarser unit is a silent behaviour change.
- **Recover unchanged context out-of-band instead of inflating the diff.** The resolution was `hunkGaps` (`src/utils/diffView.ts`): compute the untouched ranges *between* hunks from their line spans, and read them back from the file on expand via `git_file_slice`. That is the GitHub model, and it makes both features correct at once.
- **When a gap-reader is mode-aware, keep it mode-aware.** `git_file_slice` reads the **index** in staged mode, not the worktree: a partially-staged file's Staged section compares index-vs-HEAD, so showing worktree lines there would display content the user has not staged.
- **Generally:** when two features touch one parameter, check whether that parameter carries meaning for both before tuning it for one. The conflict here surfaced only because staging was built on the same rendered hunks; had it used its own diff, the mismatch between what was displayed and what was staged would have been worse and much harder to see.

## Related

- [[concept_hunk_level_staging]] — the staging mechanism this granularity feeds.
- [[component_changes_panel]] — where `DIFF_CONTEXT` and `hunkGaps` live.
