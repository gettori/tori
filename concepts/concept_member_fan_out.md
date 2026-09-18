---
summary: a Feature fans a single root command out per member and merges in TypeScript, never keying on a bare relative path
status: current
updated: 2026-08-28
source: "Features phase 4: unified search across member roots (#156), branch `feature-workspace`, phases 1 to 3, commits 92d697f, ec71908, 9c7ce7a, `src/utils/searchOptions.ts` (`mergeSearchResults`), `src/panels/Editor/SearchPanel.tsx`, `src/utils/featureMembers.ts`"
---

# Fanning a single-root command out over a Feature's members

A Feature is several repos selected as one workspace ([[concept_feature_workspace]]), and every backend command Tori owns takes exactly one root. [[adr_feature_workspace]] decided they stay that way: the panel invokes once per member and merges the answers in TypeScript. `SearchPanel` is the first panel to do it end to end, so the shape it landed on is the one Changes (#157), the omnibox (#158) and the Problems/Todos/Bookmarks panels (#160) are meant to copy.

## How it works

- **One call per member, in parallel, folded into one section each.** `mergeSearchResults` (`searchOptions.ts:150`) takes the legs and returns `{ sections, unsupported }`. A leg carries a result or an error, never both, and a leg never throws: `grepRoot` catches so one unreadable repo cannot blank the members that answered.
- **Section order is member order, not completion order.** The merge maps over the legs as they were issued. A panel whose sections reshuffle because one member's grep was quicker is a panel you have to re-read after every keystroke.
- **The section list iterates the members, not the results.** A member with no usable worktree never runs a command and so has no result to iterate, yet its header is the only place its state gets said. Same shape as `FileTree`'s section list, for the same reason. It is also skipped rather than invoked: its section path is the *repo* folder, and running the command there would search the user's own checkout instead of the Feature.
- **The budget is per root.** `MAX_RESULTS` is 500 each, not 500 shared, because truncation is reported per section anyway and a shared cap would let one noisy member starve the rest.
- **Capabilities union across the searched roots only.** `unionUnsupported` takes the union rather than the intersection: an option one member would silently ignore is an option whose result set is a lie for that member. Only roots that answered contribute, and a restriction narrows the set the union is taken over, so a toggle is never greyed out on behalf of a repo the current call will not touch.
- **One generation counter guards the whole fan-out**, not each leg. `searchGen` is bumped once per user-caused batch and checked after `Promise.all`, so a slower earlier batch resolving last sets nothing. The capability probe carries its own counter for the same reason.
- **A watcher event re-runs only the root it names.** `fs://changed` carries a root, so `refreshRoots` re-greps that one and merges its section back over the others. Re-running the whole fan-out would cost one call per member per debounce window in exactly the Feature that has an agent writing in one of them.
- **Nothing is keyed on a bare relative path.** See below; this is the rule the rest of the pattern rests on.

## Why it's this way

**A per-root failure is a per-section error, and only an all-failed fan-out clears the panel.** With one root that is the old behaviour exactly. With several, the members that answered still hold the honest answer, and blanking them because a third repo lost its permissions reports a failure that did not happen to the results it did happen to.

**Relative paths collide across members, and that is the ordinary case rather than an edge one.** A frontend/backend Feature holds `src/index.ts` twice. Every site that selects among merged results has to key on `(root, path)`: the replace targets, the dirty-buffer filter, the results document's marks, its collected edits, the file group headers. The failure mode when it does not is silent and destructive, because the wrong file is a real file that a write succeeds against. When a message names a file to the user, it needs the member too: "1 skipped (unsaved changes)" over a Feature names neither the file you can see twice on screen nor the repo to go and save it in.

**The merge lives beside the helpers it feeds, not in a new module.** `mergeSearchResults` sits in `searchOptions.ts` next to `replaceTargets` and `truncationNotice`, which consume its sections. A pure module is what makes the ordering, the union and the error folding testable without a mounted panel.

**A multi-root backend command was rejected twice**, in #151 and again here. The panel needs per-member sections, per-member truncation and per-member write targets whatever the backend returns, so the merge has to exist in TypeScript regardless. A command that returned them would be a second place for the same decisions to live.

**Identity is `repoPath`, not `path`.** `MemberRoot.path` is the worktree when there is one and the repo otherwise, so a Recreate relocates it. Anything persisted (the search restriction is the first) keys on `repoPath` and resolves back to the members present now. See [[gotcha_a_members_path_moves_only_repopath_survives_a_recreate]].

## Where a store, not a merge, was needed (2026-08-27, #157)

Changes was the first panel told to copy this, and it copied most of it: one section per member in member order, the section list iterating the members rather than the results so an unusable one still gets a header, per-member actions, a rooted `fs://changed` refreshing only the member it names. Two things it could not take from here.

**Git is held, not fetched on demand.** The Changes panel is unmounted whenever the right pane shows anything else, and the command palette still has to answer "is anything staged" with it closed. So the per-member answers live in a module store, one slot per root, rather than in a merge the panel computes while mounted: [[concept_per_member_git_slots]]. Search has no such reader, which is why a pure `mergeSearchResults` was enough there.

**A write needs one member, not the union.** A search reads every member at once; a commit happens in exactly one. So the panel carries an explicit target and says on screen which member the box is committing in, and the palette's git commands resolve the member from the active file. A fan-out that only reads never has to answer "which one", and every fan-out that writes does.

## The three list panels, and where the scoping differs (2026-08-28, #160)

Problems, TODOs and Bookmarks were the last panels told to copy this, and the copy is closer than Changes' was: no store, no write target, just sections. What they added is a shared band, [[component_member_section]], and one grouping rule, `groupByMemberRoot`, both in `featureMembers.ts` beside `memberFor` so they share `rootOf`'s longest-match with the tree.

**TODOs is the fan-out proper.** One `grep_project` per member, `Promise.all`, one `scanGen` guard over the batch, a per-root section carrying its own cap and its own error, and a rooted `fs://changed` that re-greps only the member it names. It also re-checks the dirty set against the live members at flush time, because a member can leave the Feature inside the debounce window and grepping a root nothing draws is work whose answer is dropped on the way back in.

**Problems and Bookmarks do not fan out at all**, and that is the interesting half. Their data is already whole-Feature: the diagnostics store spans every warm project, and the bookmark store keys on `feature:<id>`. So the pattern they take is the *presentation* half, and the scoping question inverts. A fan-out cannot produce a row belonging to no member; a shared store can, and the two panels answer differently:

- **Bookmarks keeps it**, in a trailing "Outside this Feature" section. Its store is Feature-scoped, so a row under no member genuinely belongs here: removing a repository keeps its worktree by default and those files are still on disk.
- **Problems drops it**, by pre-scoping to the member roots. Its store spans every warm project, so it cannot tell a Feature's departed member from another workspace entirely, and a trailing bucket would leak someone else's errors.

**Availability spans the set, not the active member.** `problemsHere()` tests every root. Gating the tab on `activeRoot` would hide the section the panel exists to show, which is the error in the repo you are not currently looking at.

## Related

- [[concept_right_panel_member_scope]] - which modes fan out, which follow the file, and which follow the pointer.
- [[component_member_section]] - the band the three list panels draw.
- [[concept_feature_workspace]] - the workspace this fans out over, and the consumer table saying which readers get `roots[]`.
- [[concept_per_member_git_slots]] - the same shape held in a store, for the readers that need it with nothing mounted.
- [[adr_feature_workspace]] - the decision that single-root commands are fanned out and merged in TS.
- [[component_search_panel]] - the first panel to implement this end to end.
- [[concept_editable_search_results]] - the document the merged set opens into, and where `(root, path)` shows up again as a line map.
- [[concept_fs_change_pipeline]] - the rooted `fs://changed` event the per-root refresh reads.
- [[gotcha_a_request_bound_to_a_fast_changing_selection_needs_a_latest_request_wins_guard]] - the guard the fan-out applies to a batch rather than a call.
- [[lesson_a_reset_key_must_name_what_changed]] - what went wrong keying an effect on the searched root set.
