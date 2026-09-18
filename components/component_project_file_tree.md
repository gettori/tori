---
summary: FileTree sections by Feature member, each root fenced for fs writes; deletes go through a Disposer to Trash, never rm
status: current
updated: 2026-08-28
source: "Editor Wave 6: the IDE surface (personal/tori, branch `wave-6`); Phase 1, issue #48; commits 5386ef8 + cfab50e; multi-root sections, per-member watchers and expanded persistence from Features phase 3: unified file explorer across member roots (branch `feature-workspace`, issue #155); commits 8e5d0c3, 4f852b0, 7580a41, 76b20bd; the row menu heading from Repository identity on tabs, breadcrumbs, quick-open and menus (issue #158), Phase 5, commit `c422394`"
---

# Project file tree (editable, multi-root)

**Location:** `src/panels/Editor/FileTree/FileTree.tsx`, `src/panels/Editor/renameTabs.ts`, `src/utils/treeExpanded.ts`, `src-tauri/src/fs.rs`

The editor's file tree stopped being a read-only listing. It creates, renames, trashes, drag-moves and multi-selects, with a fuzzy filter, collapse-all and compact folders; it is the sweep origin every path-keyed store in the pane has to follow; and it now draws **one section per Feature member**, each with its own containment boundary, watcher, filter results and restored expanded set.

## Responsibilities

- **Mutations under the workspace root**, through `fs_mkdir` / `fs_delete` / `fs_rename`, which are containment-scoped. The plan believed re-rooting them was "the whole backend half of #48"; in fact `ensure_inside_named` was already root-parameterised and `search.rs` already used it. Only the private `ensure_inside` wrapper hard-wired the `"shared folder"` noun, so the change was that wrapper plus a `noun: Option<String>` on three commands.
- **Deletes go to the Trash, never a hard `rm`.** The `trash` crate at 5.2.6 with `default-features = false` (the defaults exist for listing and restoring and pull `chrono`; only `trash::delete` is needed), routed through a `Disposer` trait so tests use a recorder. The load-bearing assertion is negative: the file must still exist after the command, which fails loudly if a `remove_file` ever creeps back in.
- **Drag-move, disambiguated from the existing mention gesture.** `DRAG_PATH_MIME` is set by the tab strip too and consumed by the chat composer and the terminal as a file *mention*, so it cannot also mean "move". `TREE_MOVE_MIME` marks the tree's own drags; an unmarked drag is not accepted, and `effectAllowed: "copyMove"` keeps both meanings available for the drop target to choose.
- **A drop on a file row targets that file's directory**, not the tree root. Without it the row falls through to the background handler and a file dropped beside a deeply nested sibling flies to the top of the project.
- **Reveal-active-file is a broadcast, not a path-chasing loop.** Every node reacts to the target independently, so a lazily-loaded chain opens itself as it mounts. The target's own row clears the target, or collapse-all then re-expand would replay the whole cascade.
- **Rename propagation is `renameTabs.ts`**, the pure sibling of `purgeTabs.ts`. A rename is not a removal, so nothing closes: tabs repoint and `CodeEditor` rekeys its buffer map, so unsaved text and undo history come along. `repoint` is shared by both, so "under" has one definition everywhere.
- **Does NOT** run `git mv`, touch the index, or reload the whole tree on a mutation beyond the affected directory.

## One tree, many containment roots

`FileTree` takes `roots?: TreeRoot[]` (`FileTree.tsx:615`, `{ path, label, tint?, state? }`) beside the original `root: string | null`. One entry, or the plain `root` prop, renders exactly as it always did: no header, no chip, toolbar create intact. Only the Editor's files pane ever passes more than one; the shared and docs panes are untouched.

- **`RootSection` (`FileTree.tsx:634`) is the unit of containment.** It owns one root's listing, its `mounted` map, its `EditCtx`, its `list_project_files` answer, its `fs://changed` subscription and its drop background. `FileTree` keeps only what is genuinely shared: the filter text, the selection, the reveal target and the collapse nonce. Every fs mutation a row makes is fenced to its own section's root, which is what keeps a Feature's members from writing into each other.
- **Sections iterate over path strings, never root objects.** `<For each={rootPaths()}>` with each section looking its own meta up by path. `features://changed` fires once per member during creation and a resource hands back fresh objects each time, so a keyed `For` over those objects would remount every section on every tick and throw away what each one had open. A test re-renders with a structurally equal but referentially new array and asserts no re-listing.
- **Create moved into the section header.** With sections on screen a toolbar create button has no way to say which root it means. The toolbar keeps New File / New Folder for a lone root only, reached through a `SectionApi` (`:626`) the section registers on mount.
- **A cross-root drag is refused with a toast before any invoke.** The backend would reject it anyway, and the two ends sit in different member repos whose histories are not one move to make.
- **An unusable member renders header plus state badge and a repair action** instead of a tree, keyed by `worktreePath ?? repoPath` so a member with nothing on disk is still addressable; that key is what `onRetry` hands back and what `Editor.tsx` passes to `retry_member`. The badge spells its reason out rather than hiding it in a `title`: a tooltip is invisible to a keyboard user, and `src/test/interactiveTitle.test.ts` pins the count of raw `title=` attributes.
- **The filter runs per root and keeps section grouping**, each section ranking its own hits under its own cap, so a large repo cannot crowd a small one off a globally ranked list.
- **A repaired member never changes path**, so its section never remounts to notice. The first listing hangs off the usable transition rather than `onMount`, and that transition needs an explicit `was !== true` guard: see [[lesson_a_solid_effect_inherits_the_change_rate_of_what_it_reads]].
- **One section reports the switch's tree leg**, the active member's, keyed on the workspace key so a Feature's span is keyed the same way its tabs are. Absent a `settleKey` no leg is reported at all, which is what stopped the shared and docs panes reporting one that could never match. A section that comes back collapsed closes the leg without reading, or the span would time out on a listing that never runs ([[gotcha_a_switch_span_whose_kind_the_settle_legs_never_admitted_times_out_silently]]).

## The row menu names its member

A right-click menu opened over one member's `src/index.ts` said nothing about which repo it was about to rename inside. Inside a Feature the menu now leads with a heading carrying the member name, through `MenuItem`'s `{ heading }` variant ([[component_menu]]).

Two choices worth keeping:

- **The name rides on `EditCtx`, not down the recursion.** `TreeNode` is recursive and already threads nine props; `EditCtx` is per-section, already carries the display `noun`, and is the exact thing the menu is gated on (`disabled={!props.ctx}`), so the menu can only exist where the name does.
- **The Feature gate is the label itself.** A lone root is synthesised as `{ path, repoPath: path, label: "" }`, so `props.meta().label || undefined` already means "inside a Feature": non-empty for a real member record, empty for the single-root files pane and for Docs and Shared. No `headed` check, which would also have been wrong for a one-member Feature.

## What the tree remembers

Expansion was never persisted: every `TreeNode` owned a local `open` signal, so reopening a workspace collapsed it back to its roots. It now lives in `src/utils/treeExpanded.ts` under `tori.treeExpanded.v1`, the ninth member of [[concept_path_keyed_workspace_stores]].

- **Two lists per workspace**, `dirs` and `closed`, because the defaults differ: a directory starts shut so the open ones are recorded, a section header starts open so only the closed ones are. One flat list of open paths would have made a member that joins a Feature later arrive hidden.
- **Entries are absolute paths**, so which member a directory belongs to falls out of its prefix and `wsKey` alone is a sufficient key.
- **Reveal is transient and recorded nowhere.** A persisted walk would re-open, on the next mount, the chain the user has since closed by hand. Collapse-all is therefore two things: the recorded directories cleared in one call, and the old nonce broadcast, which is all that can reach a transient.
- **Only the files pane persists.** A `persistKey` prop is what says so; a pane without one takes a fresh `session:<n>` bucket per mount, so the shared and docs trees still expand while the save skips them and neither can be cleared by the other's collapse-all.

## Key files & entry points

- `src/panels/Editor/FileTree/FileTree.tsx` — `TreeNode` (`:336`), `TreeRoot` (`:615`), `SectionApi` (`:626`), `RootSection` (`:634`), `FileTree` (`:936`); `applyRename` (which calls `local_history_rename` *after* `fs_rename`) and `deleteEntry` (which calls `local_history_forget` *before* `fs_delete`).
- `src/utils/treeExpanded.ts` — the store: `mapExpandedPaths` (`:56`), `isDirOpen` / `setDirOpen` (`:140`), `collapseDirs` (`:154`), `isSectionOpen` / `setSectionOpen` (`:162`), `dropWorkspaceExpanded` (`:175`), `mapExpandedFiles` (`:181`).
- `src/panels/Editor/renameTabs.ts` — `repoint` and the tab/buffer follow-through.
- `src-tauri/src/fs.rs` — `ensure_inside_named`, the `Disposer` seam, `fs_mkdir` / `fs_delete` / `fs_rename`, and `fs_watch_set` (`:694`).
- Tests: `FileTree.test.tsx` (including the two ordering tests: history carried on rename, forget before delete), `FileTree.stories.tsx`, `src/utils/treeExpanded.test.ts`, `src/panels/Editor/featureRoot.test.tsx`.

## Connections

- Feeds [[concept_path_keyed_workspace_stores]] — every one of the nine must join `followRename` and `purgeUnder`, and this is where both fire.
- Feeds [[concept_local_history_blobs]] — the Rust half of the same follow-through, with the two directory cases running in opposite directions.
- Implements the explorer row of [[concept_feature_workspace]]'s consumer table; the sections are the members [[component_feature_selection]] resolves.
- Consumes [[concept_fs_change_pipeline]] — one subscription per section, filtered on the burst's own `root`.
- Hosted by [[component_cm6_editor]] — the tree is one of the pane's left-hand modes.
- Governed by [[concept_editor_tab_workspaces]] — a rename must not break the path-keyed maps that model rests on.

## Related

- [[concept_repository_identity]] - the rule the heading obeys, and the four other surfaces that obey it

- [[concept_design_token_system]] — the drop target, focus ring and selection reuse `--accent-subtle`, `--accent-fg` and `--tree-row-active`; section chips take the Space hue as one custom property, and `check-tokens.mjs` rejects a hex literal outside the token layer, so the stories tint through `spaceHue`.
- [[gotcha_ensure_inside_returns_the_callers_unresolved_path]] — the macOS `/var` symlink trap in its tests.
- [[gotcha_fs_read_dir_shells_out_to_git_check_ignore]] — why compaction and any eager listing cost more than they look.
- [[gotcha_a_portalled_component_is_not_inside_renders_container]] — the Editor's right pane is portalled, so a section test queries `document`.

## Known gaps

- The tree tie-breaks filter matches on path length **locally**, because `fuzzyScore` does not penalise length and QuickOpen and the sidebar share it; a shared fix would change ranking in three places at once.
- Compaction costs one `readDir` per child directory to see whether a chain continues (gitignored folders skipped, chain capped at 8).
- A reload no longer forces its directory open. It could not: a watcher burst reloads every mounted directory, so an opening reload expanded every collapsed row on screen every time a file changed. The two callers that do want it open (New File / New Folder in a row's menu, and a drop onto a shut folder) say so explicitly.
- One deliberate single-root drift: the drop highlight paints the section body rather than the whole panel frame. The body is the panel minus the toolbar, so it reads the same.
