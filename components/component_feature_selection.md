---
summary: turns a Feature click into a workspace keyed feature id, with a generation cache so a switch costs two calls not four
status: current
updated: 2026-08-26
source: "Features phase 2: Feature selection, the wsKey split and restore (personal/tori, branch `feature-workspace`, issue #154), commits 7ef9670, 282e06f, ccae71d; the shared member list from Features phase 3 (#155, phase 2, commit 4f852b0)"
---

# Feature selection: the code that opens a Feature as one workspace

**Location:** `src/utils/features.ts` (helpers), `src/utils/featureMembers.ts` (the tinted member list), `src/App.tsx` (resolve, active root, purge), `src/utils/purgeWorkspace.ts`, `src/components/Toolbar/Toolbar.tsx` (chip row), `src/panels/LeftSidebar/LeftSidebar.tsx` (chip in Spaces, deselect rules), `src-tauri/src/sessions.rs` (attribution)

Everything between a Feature record ([[component_feature_store]]) and the panels: how a click becomes a `Selection` keyed `feature:<id>`, how that key reaches every per-workspace store while git, settings and spawns keep asking one folder, how the selection survives a relaunch and a changed record, and how the key is swept out of every store when the Feature is deleted. The mechanism is described in [[concept_feature_workspace]]; this page is where it lives.

## Responsibilities

- The helpers, `src/utils/features.ts:108-166`. `featureSelection(feature, storedActiveRoot?)` never refuses: `roots` are the present members in order, `activeRoot` the stored one if still present, else the first, else `null`, and `folderPath`/`projectPath` mirror `activeRoot` as `""` when null. `workspaceKey(sel)` is `feature:<id>` for a Feature and `folderPath` for a unit; `selectionRoot(sel)` is `activeRoot` or `folderPath`, returning `null` and never the `""` mirror; `workspaceFolders(ws, sel)` expands a `feature:<id>` key to the selected Feature's roots (an unselected Feature expands to nothing). `ownsCwd` and `tabUnderFolder` are the attribution rule below.
- The shell, `src/App.tsx:291` `wsKey = workspaceKey(selected())`, `:446 setActiveRoot` (updates `activeRoot`, `folderPath`, `projectPath` on a feature selection and persists), `:459 resolveFeatureSelection` (re-resolves a stored feature selection against `list_features` at mount and on every `config://changed`, latest request wins; a deleted Feature clears the selection). `loadSelection` backfills `kind: "unit"`, and `kind` is optional on `Selection` because 28 test files build literals.
- The panels derive their own key: `Editor.tsx` `ws()`/`root()` and `Terminal.tsx` `activeWorkspace()` call `workspaceKey`/`selectionRoot` on `props.selected`. Terminal `:350 listSessionsFor(ws)` unions `list_sessions` over `workspaceFolders`; `spawnSession` takes a trailing `workspace` param so the sidebar's `NEW_SESSION` path (a unit) is unchanged; `:233 selectTab` skips `TERMINAL_TAB_FOCUSED` for a feature tab because the sidebar cannot map the key to a row. `SearchPanel` keys history and saved searches on a `workspace` prop.
- Purge on delete. `src/utils/purgeWorkspace.ts` lists the 13 `Record<workspace, ...>` localStorage stores, rewrites them without the key, then emits `PURGE_WORKSPACE { workspace }` (`utils/events.ts`); live owners drop the key so a later persist does not write it back: App (`forgetWorkspace` in `layout/layoutStore.ts:118` and `layout/tabPlacement.ts:329`), Editor `:1590 purgeWorkspaceKey` (tabs, jumps, closed, frecency, bookmarks, attach ports, last targets, breakpoints, watches; `dirty` and the hot-exit stash are kept for any path another workspace still has open), Terminal (closes the key's tabs and marks it touched for `mergeStore`), TasksPanel and SearchPanel. `FeatureList.tsx:124 remove` purges, then `onDeleted`.
- **The tinted member list, `src/utils/featureMembers.ts`.** One `TintedMember` carries the member, its section key (`worktreePath ?? repoPath`, so a member with nothing on disk is still addressable), its label, its `MemberStateSummary`, and both forms of the Space tint: `hue` for a tree section, `style` for the two chip custom properties. The module is split in half. `tintedMembers(feature, spaces)` (`:57`) is pure and is what the presentational `FeatureItem` uses, since the sidebar hands it `spaces` as a prop. `createFeatureMembers(featureId)` (`:101`) is the live half, for the Toolbar and the Editor: `list_features` + `get_config`, refetched on `features://changed` and `config://changed`.
- **The live half is deduped at module scope**, one `list_features` and one `get_config` per generation however many consumers ask, through a generation counter and per-generation promise caching. Without it the Toolbar and the Editor each held a live pair and a Feature switch cost four commands where it used to cost two, on exactly the path being instrumented. The trade is two event listeners installed once and never removed.
- The Toolbar chip row, `Toolbar.tsx:37`: reads the record through `createFeatureMembers` because the Selection only carries present roots and the badges need every member; a present chip calls `onActiveRoot`, the rest are disabled `Tooltip as="button"` wearing their state.
- Two homes in Spaces, `LeftSidebar.tsx`: the sidebar holds its own `features` signal for the `in <Feature>` chip on a member unit row (`:2152 featuresAt`), the chip opens the Feature with that folder active, `:2144 unitSelected` refuses a feature Selection so no unit reads active, and `:965 dropSelectionUnder` moves a Feature's active root to the next present member when a folder goes away, clearing only when none remains.
- Attribution, `sessions.rs:550 owned_by_listing` and `features.ts:156 ownsCwd`: a folder never owns cwds under its own `.tori/worktrees/`, the member folder claims them by prefix. Applied in the listing path (`filter_sort`, `folder_historical`) and in the sidebar's live-tab attribution; `ids_under` and the destructive count (`LeftSidebar.tsx:557 countRunningAgents`, `list_sessions { inclusive: true }`) stay on the plain prefix rule.
- Does NOT unify search or changes across members (#156, #157; the explorer landed with #155, see [[component_project_file_tree]]), put chips on tabs (#158), manage members (#159), or give the History panel a Feature view: `sessionStore` is still folder-keyed, so History counts 0 for a Feature (#160). Feature rows have no keyboard path (the unit rows' pattern).

## Key files & entry points

- `src/utils/features.ts:108` `featureSelection`, `:128` `workspaceKey`, `:136` `selectionRoot`, `:156` `ownsCwd`, `:163` `tabUnderFolder`
- `src/App.tsx:291` `wsKey`, `:446` `setActiveRoot`, `:459` `resolveFeatureSelection`, `:478` the `PURGE_WORKSPACE` listener
- `src/utils/purgeWorkspace.ts:9` `WORKSPACE_STORES`, `purgeWorkspace`, `storesHolding`
- `src/panels/Terminal/Terminal.tsx:350` `listSessionsFor`; `src/panels/Editor/Editor.tsx:1590` `purgeWorkspaceKey`
- `src/utils/featureMembers.ts:57` `tintedMembers`, `:101` `createFeatureMembers`
- `src/components/Toolbar/Toolbar.tsx:37` the chip row
- `src/panels/LeftSidebar/LeftSidebar.tsx:557` `countRunningAgents`, `:965` `dropSelectionUnder`, `:2144` `unitSelected`, `:2152` `featuresAt`
- `src-tauri/src/sessions.rs:550` `owned_by_listing`, `:592` `list_sessions(folder, inclusive)`
- Tests: `src/utils/features.test.ts`, `src/utils/featureMembers.test.ts`, `src/appFeatureSelection.test.tsx`, `src/panels/Editor/featureRoot.test.tsx`, `src/panels/Terminal/featureWorkspace.test.tsx`, `src/panels/LeftSidebar/featureSelect.test.tsx`, `featureDeselect.test.tsx`, `featureChip.test.tsx`, `src/components/Toolbar/Toolbar.test.tsx`, `sessions::tests::listing_never_claims_a_repos_own_feature_worktrees`

## Connections

- Depends on [[component_feature_store]] for the record and `list_features`, and on [[component_feature_list]] for the click that starts it.
- Used by every store in [[concept_path_keyed_workspace_stores]] through `wsKey`, and by [[component_editor_stores]] and [[component_session_stores]] through `selectionRoot`.
- Governed by [[adr_feature_workspace]].

## Related

- [[concept_feature_workspace]] - the mechanism and the consumer table this implements
- [[component_project_file_tree]] - the third consumer of the tinted member list, one section per member
- [[lesson_a_display_attribution_rule_leaks_into_a_destructive_count]] - the undercount the attribution rule caused
- [[gotcha_feature_id_is_a_key_not_a_path_so_purge_under_path_never_reaches_it]] - why purge is its own event
- [[gotcha_list_sessions_hides_a_repos_own_tori_worktrees_unless_asked_inclusively]] - the flag a teardown count needs
- [[gotcha_read_selectionroot_never_folderpath_for_git_settings_the_watcher_or_a_spawn]] - the `""` mirror
- [[gotcha_a_request_bound_to_a_fast_changing_selection_needs_a_latest_request_wins_guard]] - `resolveFeatureSelection`'s counter
