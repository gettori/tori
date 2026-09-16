---
summary: nine per workspace stores split into what you did, which expires, and what you chose, which never does, both get swept
status: current
updated: 2026-08-26
source: "Editor Wave 6: the IDE surface (personal/sway, branch `wave-6`); Phases 2, 3, 9, 15, issues #49 / #52 / #57 / #51; commits ca93f99, 354ee01, 3cbbde1, b622f33; `src/utils/jumpList.ts`, `src/utils/frecency.ts`, `src/panels/Editor/reopenStack.ts`, `src/utils/bookmarks.ts`, `src-tauri/src/local_history.rs`; joined by Editor wave 8: the debugger (DAP) (branch `wave-8`), Phases 6, 9, 5; `src/utils/breakpoints.ts`, `src/utils/watches.ts`, `src/utils/debugTargets.ts`; ninth member from Features phase 3: unified file explorer across member roots (branch `feature-workspace`, issue #155, phase 4, commit 76b20bd); `src/utils/treeExpanded.ts`"
---

# Path-keyed per-workspace stores, and the sweeps they must join

Wave 6 added five collections that record something about a *file path*, bucketed by branch-unit workspace: the navigation jump list, the frecency scores behind the pickers, the reopen-closed-tab stack, bookmarks, and local history. They are separate modules with separate contracts, but they share one hazard, and the wave learned it the expensive way: **a path-keyed collection that does not follow Phase 1's rename and trash is a collection that points at files which no longer exist.**

## How it works

- **Every one of them is swept.** `mapPaths` / `mapPathsIn` (`jumpList.ts:152`, `bookmarks.ts:133` and the equivalents) take the path semantics from the caller (`repoint`, `isUnderPath`), so "under" has exactly one definition across the pane and the tree. Local history is the Rust side of the same idea: `local_history_rename` and `local_history_forget`.
- **The sweep sits above the handler's early return.** A place can be in the jump list without a tab still holding it open, so a sweep gated behind "is there a tab for this?" misses precisely the entries nobody is looking at.
- **A rename that lands on an already-tracked path merges rather than replaces**, in frecency. Forgetting the smaller record is the only outcome that silently loses work.
- **Dropping the entry the cursor stands on moves the cursor to the newest survivor before it**, not to whatever slid into the slot, or Back would walk forwards.
- **Frecency is multiplicative** (`frecency.ts:58`): `weight * 0.5 ** (age / halfLife)`, with `EDIT_WEIGHT = 4` and a three-day half-life. Age discounts the whole record rather than being one term summed with the counts, which is what makes "edited once this morning" beat "opened twenty times a fortnight ago" with no tuning.
- **Counts plus one `lastAt`, not a log.** Per-event timestamps would be more accurate and are not worth their keep; the consequence is that one recent open re-dates a file's whole history, the same trade zoxide makes.

## Why it's this way

**The contract split is what decides a store's caps, and it is the useful question to ask of a new one.** A store that records what you *did* is automatic, capped, ordered by recency and allowed to expire: the jump list (capped), frecency (decayed), the reopen stack (20 paths), search history (50 entries), local history (50 versions or 14 days). A store that records what you *chose* is named, uncapped, never reordered and gone only when deleted: bookmarks, saved searches. Same shape of data, opposite contracts, and conflating them produces either a bookmark that expires or a history list nobody can walk.

**A cap should be sized to what the entry costs.** `reopenStack.ts` holds paths, so twenty is free and reopening the twentieth still works, it just reads the file fresh instead of handing back undo history; `closedBuffers` holds documents, so eight is a memory question. Dedup on re-close matters in the same way: two entries for one file make the second ⌘⇧T appear to do nothing.

**The sweep discipline was learned, not designed.** Phase 2's self-review found the jump list was the one path-keyed collection not following the tree's edits, after `followRename` and `purgeUnder` already synced tabs, active ids, dirty flags and stash entries. Phase 3 then shipped both of its sweeps *with* the feature rather than after it, and Phase 9 and Phase 15 did the same. Adding a sixth collection means adding it to both sweeps in the same commit.

## Related

- [[component_project_file_tree]] — the rename and trash these stores must follow.
- [[component_editor_navigation]] — the jump list's own surface and recording rules.
- [[concept_local_history_blobs]] — the fifth member, and the only one on the Rust side.
- [[concept_editor_tab_workspaces]] — the per-workspace bucketing key they all borrow.
- [[lesson_a_test_that_passes_against_the_broken_code]] — how the bookmark sweep's data-loss bug hid from its first test.
- [[concept_feature_workspace]] - the `feature:<id>` key these stores take when a Feature is selected; paths inside stay absolute so the sweeps are unchanged.

## Wave 8 added three more, and one of them is keyed twice

Breakpoints (`breakpoints.ts`), watch expressions (`watches.ts`) and the remembered attach port and last target (`debugTargets.ts`) are the same shape: pure, workspace-keyed, localStorage-backed, returning the same object on a no-op. Breakpoints are path-keyed within the workspace and so join the rename/trash sweep; the other two are not path-keyed and do not.

The new wrinkle is that **a watch's *answer* has to be keyed by workspace as well as by expression**. `orders.length` means one thing in one worktree and nothing in another, and an answer cached on the text alone shows one project's value in another project's list. The evaluation is additionally gated on the paused session's own `projectPath`, so a stop in one workspace never answers another's list. See [[component_debug_panel]].

## The ninth: what the tree has open

`sway.treeExpanded.v1` (`src/utils/treeExpanded.ts`) records the explorer's
expanded directories. It is the first of the family to hold **two lists per
workspace**, because the two defaults differ: a directory starts shut, so the
open ones are what gets recorded, and a section header starts open, so only the
closed ones are. Collapsing them into one list of open paths would have made a
Feature member that joins later arrive hidden rather than open.

Entries are absolute paths, so which member a directory belongs to falls out of
its prefix: `wsKey` alone is a sufficient key and no compound key is needed. It
joins `followRename`, `purgeUnder`, `WORKSPACE_STORES` and `purgeWorkspaceKey`
in the same commit as the feature, per the rule above, which takes the purge
sweep from 13 stores to 14.

**Its live layer is module-level, and that is what makes a `touched` set
unnecessary.** The plan called for the tab store's merge-on-write discipline
(carry through every workspace this run has not touched, see
[[gotcha_a_persist_effect_derived_from_live_state_erases_everything_not_currently_live]]).
The tab store needs it because its live state is a component's, holding only
what this run opened. This one follows `breakpoints.ts` + `debugBreakpoints.ts`
instead: pure helpers plus one module-level signal loaded whole at startup and
written back whole. A store that never narrows to the visible workspace has
nothing to erase and nothing to merge against. It also lets `Editor.tsx`'s
rename and purge sweeps reach it with no tree mounted, which a
component-level signal could not.

## Related, cont.

- [[component_project_file_tree]] - the ninth store's owner, and the rename and trash the other eight follow.
- [[lesson_pure_core_for_global_stores]] - the split the ninth store is shaped by.
