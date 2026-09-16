---
summary: a Feature groups one worktree per member repo under one workspace key, and every store picks wsKey, activeRoot or roots
status: current
updated: 2026-08-28
source: "Features: design the multi-repo workspace and open the epic (personal/sway, branch `feature-workspace`, issue #151, phases #152 to #160); Features phase 0: the Feature record, reconciliation and worktree creation (#152, commits 4f9c5ab, dc20290, d654cc9); Features phase 1: Spaces | Features switcher, Feature list and creation dialog (#153, commits e99bef5, 514787a, c559862); Features phase 2: Feature selection, the wsKey split and restore (#154, commits 7ef9670, 282e06f, ccae71d); Features phase 3: unified file explorer across member roots (#155, commits 8e5d0c3, 4f852b0, 7580a41, 76b20bd); Features phase 4: unified search across member roots (#156, commits 92d697f, ec71908, 9c7ce7a); Features phase 5: unified changes and the git slot map (#157, commits 9658cff, 41b8ab3, 9687380, 3a7e890); Features phase 6: repository identity on tabs, breadcrumbs, quick-open and menus (#158, commits a7e2797, b1ac5f2, 6183eae, 12fe232, 809c85b, c422394); Features phase 7: Feature lifecycle, member management and repair (#159, commits 774704d, ef3779b, ede61ff, 70756f3); Features phase 8: the right panel modes inside a Feature (#160, commits 6aa93fb, e01f0cf and phase 3 on the same branch), `src/utils/features.ts:108`, `src/utils/purgeWorkspace.ts`, `src-tauri/src/sessions.rs:550`, `src-tauri/src/features.rs`, `src-tauri/src/worktree.rs:252`, `src-tauri/src/fs.rs:521`, `src/App.tsx:278`, `src/panels/Editor/Editor.tsx:371,777,1072`, `src/panels/Terminal/Terminal.tsx:424,454`, `src/utils/gitActions.ts:67,191`, `src-tauri/src/attempts.rs:116`"
---

# Feature workspace: a cross-repository context selected as one workspace key

A Feature groups one Git worktree per member repository, all on `feat/<slug>`, and opens them as one workspace: one tab strip, one explorer with a section per member, one search and one changes view fanned out per member. The design is decided (see [[adr_feature_workspace]]). The record, placement, creation and repair below are implemented in [[component_feature_store]] (#152, #159), the sidebar half in [[component_feature_list]] (#153, #159), and selection, restore, purge and the two-homes rule in [[component_feature_selection]] (#154); how every one of those surfaces says *which repo* a file is from is [[concept_repository_identity]] (#158). The whole member lifecycle (add, remove, reorder, rename, repair, and deleting a Feature with its worktrees offered rather than dropped) landed in #159, and the last three rows of the table in #160, which sorted all 14 right-panel modes into three scopes: [[concept_right_panel_member_scope]]. Every row is landed; the epic is complete.

## How it works

**The record.** `~/.config/sway/features.json` holds `Feature { id, name, branch, members[], createdAt }` with `Member { repoPath, displayName, worktreePath, state, order }` and `state` internally tagged as `present`, `worktree-missing`, `repo-missing`, `failed { reason }`. Out of band like `attached.json`, so a write never loops the toml watcher, and stricter than it: every access, the reconciling read included, takes `named_lock("features")`. `list_features` (`features.rs:155`) reconciles every read with three checks in order, repo readable, recorded path on disk and listed, listed branch equal to the Feature branch, and rewrites `state` only. Unlike `list_attempts` (`attempts.rs:116`), it never removes a member; a missing worktree is a state with a repair action (Recreate, Locate, Remove from Feature). The reason `"pending"` is a sentinel: the TS `memberState` shows it as "Creating" with no action.

**Repair (#159).** `memberState().action` names one of three, and every surface that draws a repair button (the sidebar's member list, the editor's file tree, its Changes sections) takes both the label and the command from that one value, through `REPAIR_LABEL` in `utils/features.ts`. Recreate and Retry run `retry_member`; Locate runs `pick_folder` then `relocate_member`, which is the one write that changes `repo_path`. Both converge, and neither did before: `build_member` adopted a worktree git still lists but that is not on disk, and a moved repo left its worktree administratively broken so the reconcile called it missing at a path that plainly exists. The two fixes are a prune plus an `is_dir` filter, and `git worktree repair` **before** the prune. A Feature always keeps at least one member; removing the last is refused and points at Delete.

**Deleting a Feature (#159).** Two questions, in order. The confirm lists every member with what `worktree_status` says, then, only once `delete_feature` has succeeded and `purgeWorkspace` has run, a sweep offers each worktree Keep or Remove with a per-row branch checkbox that defaults on for a clean row and off for a dirty or unpushed one. A kept worktree stays on `feat/<slug>` and has to remain reachable, which is why a plain repo now lists the worktrees it contains as branch units ([[component_project_discovery]]): without that, "Keep" meant the folder vanished from Sway entirely.

**Placement.** The creation core `create_worktree_in(repo, branch, container)` (`worktree.rs:252`) takes the target directory as a parameter: a bare container passes itself, a plain repo passes `<repo>/.sway/worktrees` (`feature_container`, `features.rs:291`), excluded through `.git/info/exclude` like `.sway/settings.json` and inside the root so `sessions::cwd_matches` holds. Reuse of an existing `feat/<slug>` worktree hands its path back, but the main checkout of a plain repo is the user's own and errors instead. Walkers skip the dir through the parent-child rule `fs::FEATURE_WORKTREES` (`fs.rs:521`, honoured by `is_ignored`, `walk_files`, and `plain_grep` when the dir exists); `git ls-files`, `rg` and the checkpoint snapshot rely on the exclude entry.

**Selection.** `Selection` carries `kind?: "unit" | "feature"` (optional, absent reads as unit, `loadSelection` backfills it), `featureId`, `featureName`, `roots[]` and `activeRoot`. `featureSelection(feature, storedActiveRoot?)` (`features.ts:108`) never refuses: `activeRoot` is the stored root if still present, else the first present, else `null`, and `folderPath` mirrors it (`""` when null) so a consumer nobody re-keyed keeps working. Two helpers split the old single string: `workspaceKey(sel)` is `feature:<id>` or the unit folder and is what every arrangement store keys on; `selectionRoot(sel)` is `activeRoot` or the unit folder, `null` never `""`, and is what git, settings, the watcher and a spawn cwd ask. The panels derive both from `props.selected` themselves. The stored selection is a snapshot the shell re-resolves against `list_features` at startup and on every `config://changed` (latest request wins); the record is truth and the selection only remembers `activeRoot`, so a deleted Feature clears it and a member that appears joins `roots` on the next resolve.

**The consumer table.** Every reader of the old single string gets exactly one of three inputs:

| Consumer | State | Gets | Note |
|---|---|---|---|
| `App.tsx:291 wsKey()` | landed | `wsKey` | `workspaceKey(selected())` |
| `sway.selection.v1` | landed | `wsKey` + `activeRoot` | old objects load as `kind: unit` |
| `sway.panes.v1` (`layoutStore.ts:37`) | landed | `wsKey` | `forgetWorkspace` on purge |
| `sway.tabpanes.v1` (`tabPlacement.ts:31`) | landed | `wsKey` | `forgetWorkspace` on purge |
| Editor tab model (`editorTabStore.ts:22`) and `sway.editor.tabs.v1` | landed | `wsKey` | tab ids stay absolute paths |
| Terminal tab grouping (`terminalTabStore.ts:20`) and `sway.terminalTabs` | landed | `wsKey` | spawn cwd is `activeRoot`; `list_sessions` unioned over `roots[]`; a feature tab click does not focus a sidebar row |
| `sway.fileFrecency`, `sway.bookmarks`, `sway.breakpoints`, `sway.watches`, `sway.debugAttachPorts`, `sway.debugLastTarget`, `sway.taskRuns` | landed | `wsKey` | entries inside stay absolute paths, so the rename and purge sweeps still find them |
| `sway.searchHistory`, `sway.savedSearches` (`SearchPanel.tsx`) | landed | `wsKey` | both entries gained an optional `repos[]` in #156, holding member **repo paths**, absent when unrestricted |
| `sway.treeExpanded.v1` (explorer) | landed | `wsKey` | absolute paths, so the per-member split falls out of the prefix; no per-root dimension needed |
| `Editor.tsx` root effect: `loadWorkspaceSettings` | landed | `activeRoot` | a `null` root clears settings; git moved to its own effect over `roots[]` in #157 |
| `gitActions.ts` (`:67` the slot map, `:191 enterRoots`) | landed | `roots[]` | `Map<root, GitState>`; membership keyed on the same `watchKey` memo as the watcher, a slot leaves only when its member does; see [[concept_per_member_git_slots]] |
| The watcher (`fs_watch_set`) | landed | `roots[]` | its own effect, keyed on the joined root list rather than on `activeRoot` |
| `FileTree` (`FileTree.tsx:936`) | landed | `roots[]` | one section per member, `EditCtx.root` per section, one `fs://changed` subscription each |
| `SearchPanel` (`grepArgs(root, ...)`) | landed | `roots[]` | invoke per member, merge, union `unsupported`, per-member truncation and replace, plus a search-local restriction; see [[concept_member_fan_out]] |
| `ReviewPanel` (Changes) | landed | `roots[]` | one section per member with its own branch, ahead/behind and stage/commit/push; one commit box with an explicit target; Open PR and stashes stay on `activeRoot` |
| Member lifecycle (rename, reorder, repair, remove, delete) | landed (#159) | the record | an uncapped member list under the Feature row owns all of it; see [[component_feature_list]] |
| Problems, Todos, Bookmarks panels | landed (#160) | `roots[]` | one section per member ([[component_member_section]]); a row under no member collects in a trailing "Outside this Feature" group; `problemsHere()` spans the member set, so the tab is offered for an error in the repo you are not looking at |
| Outline, Calls, Session, Debug panels | landed (#160) | the active tab's member | `focusMemberRoot` resolves it, header names it, Debug launches and remembers its target there. Watches are keyed by the **member root**, not `wsKey`: `pausedWorkspace()` compares a session's `projectPath` against it, and one shared list would dissolve the gate |
| `editorState().projectRoot` (palette gating) | landed | the active file's member | redefined in #157 as the repo the editor's git commands act in, resolved through `rootOf` |
| `FeatureItem` change count | landed | `roots[]` | summed per member over the Feature's own worktree roots, not off the slot map as a whole |
| Pull Requests, Tasks, Shared, Docs panels | landed (#160) | `activeRoot` | [[component_member_chip_row]] under the tab strip switches it. Shared and Docs were *hidden* in a Feature before, not merely unpointed: `sharedPath` gated on the selection's `projectKind` (`"feature"`) and `docsPath` built its folder from a `spaceName` of `""`. Both resolve from the active member now |
| Omnibox (`Omnibox.tsx:194,310`) | landed | `roots[]` | `list_project_files` per member in one `Promise.all`, row id `file:<root>:<rel>`, label `<repo>/<rel>` scored as one string, frecency read under `wsKey`; `MAX_RESULTS` per root untyped and global once scored |
| Breadcrumbs (`breadcrumbTrail.ts:57`) | landed | the path's member | first crumb is the member, resolved through `memberFor` and **not** through `activeRoot`, which used to collapse a background member's file to a bare basename |
| Editor and terminal tab strips | landed | the tab's member | a decorative chip before the glyph plus a hidden `srOnly` span making the name `<repo> / <basename>`; `+N` rows spell out `<repo> / <rel path>` |
| `FileTree` row context menu | landed | the section's member | a `role="group"` heading naming the member, carried on `EditCtx` |
| Toolbar (`Toolbar.tsx:37`) | landed | Feature name, active member, chip row, branch | the crumb reads `Feature / member / branch` and falls back to two crumbs when no member is present; the chip row is the `activeRoot` control, and it reads the record through `featureMembers.ts` because the Selection carries only present roots |
| `workspace_settings.rs` overlay | landed | `activeRoot` | no Feature-level overlay |
| `local_history.rs`, `hot_exit.rs`, dirty flags | absolute paths | unchanged | never had a workspace dimension |
| Sessions (`sessions.rs:550 owned_by_listing`) | landed | member folder | a folder never lists cwds under its own `.sway/worktrees/`; `ids_under` and the delete confirm's count (`inclusive: true`) keep the plain prefix |

Rule of thumb: a store that remembers UI arrangement keys on `wsKey`; a surface that asks git or the filesystem a question asks it of `activeRoot` (one repo at a time is right) or of every member of `roots[]` (a listing); nothing keyed by absolute path changes.

**Two homes.** A Feature worktree beside a container is a normal branch unit, so Spaces lists it with an `in <Feature>` chip (one per Feature it belongs to) that opens the Feature with that folder as `activeRoot`; selecting the unit from Spaces shows the unit's own (initially empty) group, and while a Feature is selected no unit row reads as active, not even the active member's. A plain repo's Feature worktree is invisible in Spaces because its branch is not attached ([[adr_attached_branch_model]]). Attribution is a path rule, not a store lookup: a folder never owns a session or a live tab under its own `.sway/worktrees/`, the member folder claims it by prefix (`sessions.rs:550 owned_by_listing`, `features.ts:163 tabUnderFolder`, a live tab carries its `cwd` for this). The exclusion lives in the listing only; `ids_under` and the number a destructive confirm is worded from stay inclusive, because removing the repo kills those agents whoever they belong to ([[lesson_a_display_attribution_rule_leaks_into_a_destructive_count]]).

**Purge.** Deleting a Feature sweeps `feature:<id>` out of the 14 `Record<workspace, ...>` stores (`purgeWorkspace.ts`) and then emits `PURGE_WORKSPACE { workspace, roots }` so every live owner drops the key before its next persist; stored first, event second, because some owners persist on change. It is its own event rather than `PURGE_UNDER_PATH` because the key is not a path. The editor keeps `dirty` and the hot-exit stash for any path another workspace still has open: a member's file is normally open under the member's own unit too.

A Feature is stored under **two** key shapes, so the sweep takes both (#160). The three debug stores key on the member root, not on `feature:<id>`, and survived every delete until the roots were passed in from `FeatureList.remove` (the record is already gone by then, so they cannot be re-read). The member-root half is deliberately narrow: only `sway.watches`, `sway.debugAttachPorts` and `sway.debugLastTarget`, and `dropMemberDebugState` rather than the whole `purgeWorkspaceKey`. Deleting a Feature *offers* each worktree, so a member you keep can be reopened as a branch unit, and its tabs, terminals and tree state are that unit's. See [[lesson_a_folder_scoped_purge_can_sweep_another_owners_state]].

**Creation.** `create_feature` (`features.rs:363`) records first with every member `failed { "pending" }`, then one `create_worktree_in` per member in sequence under that repo's lock, and re-loads the store to flip just that member after each call (never carrying a record across git calls); failures keep git's reason and `retry_member` picks them up. A duplicate slug and a repo listed twice (by common dir) are errors, not adoption. `probe_feature_branch` tells the dialog whether `feat/<slug>` already exists locally, remotely, or has a worktree, so it can prompt adopt or rename before Done. Adopt takes a branch's existing secondary worktree as the member (`build_member`, `features.rs:337`, looks it up before touching the container); a branch checked out in a plain repo's main tree is refused with "checked out in place", never a member pointing at the repo root.

**The sidebar.** The left sidebar has a persisted `Spaces | Features` mode ([[component_feature_list]]); Features mode lists every Feature with a chip per member tinted by its Space and a badge per unusable state, and hosts the creation dialog and the Rename, Add repository and Delete rows. Progress travels on `features://changed`: the pure `create_feature` and `add_member` take an `on_step: &dyn Fn(&Feature)` called after the record write and after each `build_member`, and the command layer emits the whole Feature each time, so chips flip one by one while the Spaces tree, which is not even mounted, is never reloaded; `config://changed` fires once from `settle` at the end. The dialog probes every checked repo per slug and holds Done while a collision is unanswered, which tightens #151's "a name and one repo" so a collision is answered before Done rather than discovered as a failed member.

## Why it's this way

- **A key that is not a path** is what lets one strip hold files from four repos: every workspace-keyed store was designed around a branch-unit folder ([[concept_editor_tab_workspaces]], [[concept_workspace_tab_grouping]]), and `feature:<id>` slots into them without changing their shape. The precedent is [[concept_synthetic_editor_tabs]] carrying `?ws=` inside an id.
- **Reconcile without dropping** because the issue lists "repository unavailable" and "worktree deleted" as states to show, and the attempts drop rule would erase exactly the member that needs a repair action.
- **Fan out rather than new multi-root commands** because the panels need per-member sections, truncation notices and replace targets regardless, so a server-side merge would be undone client-side.
- **Identity always shown** because a strip whose shape changes as basenames collide and un-collide is unreadable with eight repos; VS Code's collision-only suffix was rejected for that reason. What each surface does about it is [[concept_repository_identity]].
- **Removal offers, never deletes** because a worktree holds work; the guards in [[component_worktree_lifecycle]] already exist and the dialog is reused.

## Related

- [[adr_feature_workspace]] - the decision and its rejected alternatives
- [[component_feature_store]] - `features.rs`, the implemented record, reconcile and creation
- [[component_feature_list]] - the sidebar mode, list, creation dialog, context menu (#153) and the row click plus Spaces chip (#154)
- [[component_feature_selection]] - the helpers, App resolve, purge, Toolbar chip row and attribution (#154)
- [[lesson_a_display_attribution_rule_leaks_into_a_destructive_count]] - the undercount the attribution exclusion caused
- [[gotcha_feature_id_is_a_key_not_a_path_so_purge_under_path_never_reaches_it]] - why purge is its own event
- [[gotcha_list_sessions_hides_a_repos_own_sway_worktrees_unless_asked_inclusively]] - the flag a teardown count needs
- [[gotcha_read_selectionroot_never_folderpath_for_git_settings_the_watcher_or_a_spawn]] - the `""` mirror
- [[gotcha_git_worktree_list_answers_empty_for_a_vanished_repo]] - why reconcile asks `repo_readable` first
- [[concept_path_keyed_workspace_stores]] - the stores in the table that move to `feature:<id>`
- [[concept_editor_tab_workspaces]] - the tab model the Feature strip reuses unchanged
- [[concept_workspace_tab_grouping]] - the terminal grouping key the two-homes rule is about
- [[concept_fan_out_attempts]] - the sidecar precedent and the placement lesson (inside the root)
- [[concept_repository_identity]] - every surface that names a file naming its repo too, and `memberFor` as the one resolver (#158)
- [[component_member_chip]] - the chip all of them wear (#158)
- [[concept_member_fan_out]] - invoking a single-root command per member and merging the answers (#156)
- [[concept_per_member_git_slots]] - the same set held as one git slot per member, readable with nothing mounted (#157)
- [[concept_folder_anchored_sessions]] - why a plain repo's worktree must live inside the root
- [[component_worktree_lifecycle]] - the creation core and the removal dialog
- [[component_search_panel]] - the single-root grep the search phase fans out
- [[component_changes_panel]] - the panel that grows member sections
- [[component_project_file_tree]] - the tree that grew member sections, one containment root each
- [[concept_fs_change_pipeline]] - `fs_watch_set`, the N-foreground-roots command a Feature needs
- [[gotcha_a_switch_span_whose_kind_the_settle_legs_never_admitted_times_out_silently]] - why every Feature switch used to write `settled: null`
- [[gotcha_a_persist_effect_derived_from_live_state_erases_everything_not_currently_live]] - the trap to avoid when a Feature's slots are persisted
- [[gotcha_feature_members_are_read_once_per_generation_module_wide]] - why a test cannot swap the `list_features` payload between cases
- [[lesson_labelling_through_present_roots_drops_the_broken_member]] - `roots[]` is for listing, the member record is for naming
