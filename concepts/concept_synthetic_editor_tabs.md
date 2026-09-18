---
summary: non file editor views get a tori:// id carrying its own workspace, since path keyed maps assume one file per workspace
status: current
updated: 2026-08-27
source: "Editor wave 2: git depth (personal/tori, branch `wave-2`); Phase 6 (commit fecf42d), extended by Phases 7 and 11; two more kinds from Editor Wave 6: the IDE surface (branch `wave-6`), Phases 11 and 15, commits 48af914 and b622f33; `src/utils/syntheticTabs.ts`, `src/panels/Editor/purgeTabs.ts`, `src/panels/Editor/Editor.tsx`; a seventh kind from Editor wave 8: the debugger (DAP) (branch `wave-8`), Phase 7; `src/utils/debugStack.ts:90`; the `ws=`-is-not-always-a-folder correction from Features phase 4 (#156), branch `feature-workspace`, phase 3, commit 9c7ce7a"
---

# Synthetic editor tabs: a `tori://` id that carries its workspace

The editor pane hosts views that are not files: a commit log, a commit's diff, a three-way conflict view. They ride the existing tab strip through ids of the form `tori://<kind>[/<arg>]?ws=<workspace>`, with both fields percent-encoded so an arg containing `?` or `/` cannot be read back as another field.

## How it works

- **`syntheticId(kind, workspace, arg)` mints them and `tabScopePath` reads them back**, answering the workspace for a synthetic view and the path for a file. For six of the seven kinds that one function is all `purgeTabsUnder` needs, so purging works on both kinds without knowing about either. `tori://search` is the exception, below.
- **Excluded from persistence, LSP attach and fs watching.** A `tori://` id names no file, so a restore must not resurrect it as a file tab and no language server should ever be asked about it.
- **An unparseable synthetic id is scoped to nothing and survives a purge.** Deliberate: purging is destructive and skips the dirty prompt, so the safe failure direction is to leave the tab. Unreachable in practice, since every id comes from `syntheticId`.
- **`activeFileTab` gates everything that is about a file**: the image, Markdown and SVG predicates read a suffix, so a workspace folder named `notes.md` would otherwise give a log tab a preview toggle.
- **The command registry grew an `editorTab` requirement** alongside `editorFile`. "Close editor tab" needs a *tab*; save, preview, go-to-line, stage and unstage need a *file*, and Editor publishes `activePath: null` for a synthetic one so they correctly refuse.

## Why it's this way

**The workspace is in the id for two reasons, and only one of them was obvious.** Purging was the stated one: `purgeTabsUnder` sweeps by path prefix, so a bare `tori://log` would be invisible to it and survive the deletion of the space it belonged to.

The other is **uniqueness**. `dirty`, `previewOn` and `CodeEditor`'s buffer map are all keyed by path with no workspace dimension, on the documented grounds that a path names exactly one file across every workspace ([[concept_editor_tab_workspaces]]). A bare `tori://log` breaks that invariant, because two branch-units' log tabs would collide on one key and each would see the other's state.

**Opening one from the sidebar raced the tab restore**, and the fix generalises. `openCommitLog` selects the branch-unit and opens the tab in the same breath, so the tab lands while `restoreWorkspace`'s `file_exists` probes are still in flight, and the restore's "this workspace already has tabs, do not paste last run's strip over them" guard aborted. It now counts *file* tabs only (`openFileTabs`) and appends restored tabs after whatever is already open, with an already-chosen active tab outranking the stored one.

## Two more kinds, and the counter-example (2026-08-05, wave 6)

`tori://search/<query>?ws=` (an editable results buffer,
[[concept_editable_search_results]]) and `tori://localhistory/<path>?ws=` (a
file's save timeline, [[concept_local_history_blobs]]) joined the family, both
reached from the tab context menu and both titled through `syntheticTabs.ts`.

The useful part is the **third** thing wave 6 built and did *not* make synthetic.
Scratch buffers (#58) are backed by real files under
`~/.config/tori/scratch/Untitled-N`, which is an absolute path, so `toStore`
keeps them, the restore's `file_exists` probe finds them alive, `dirtyStash`
picks them up and `fs_read_file`/`fs_write_file` serve them, with **no branch
added to any of them**. A `tori://scratch/…` id would have needed one in each,
and because `toStore` drops synthetic ids on purpose, an untitled tab built on
one could never have survived a relaunch at all.

So the rule this page implies is worth stating outright: **mint a synthetic id
when the view is not a file; do not mint one when it merely has no file yet.**
The results buffer is the first (no path, no language server, rules no file
buffer has); a scratch is the second.

## The `ws=` field is a workspace, and a workspace is not always a folder (2026-08-27, #156)

This page used to say that `tabScopePath` is the one reader of `ws=` and that it answers a folder. Both stopped being true for `tori://search` when a results buffer grew to span a whole Feature.

The tab now keys on `wsKey` rather than on a root, because Open means "the result set on screen" and one buffer covers every member ([[concept_editable_search_results]]). Inside a Feature `wsKey` is `feature:<id>`, which is a key and not a path ([[concept_feature_workspace]]), so `tabScopePath` answers something that is under no folder at all. Two consequences, and the second is the one that was nearly missed:

- **The folder purge asks the document, not the id.** `purgeTabsUnder` takes a `rootsOf` resolver, defaulting to `searchBufferRoots`, and a buffer any of whose members falls under the purged folder is dropped. Dropped rather than trimmed: the line map is fixed at build time and the buffer forbids a line-count change, so a partly invalidated document cannot be repaired into an honest one. The resolver is a parameter rather than a direct import so `purgeTabs.ts` stays testable without the buffer store; a buffer that is gone (evicted, or never opened here) falls back to `tabScopePath`, which errs towards keeping the tab.
- **The tab tooltip asks it too.** `tabTitle` reads the same field, and a self-review found it quietly handing the user `feature:<id>` where it used to name a folder. It answers with the buffer's own roots instead. The general rule: when a field's meaning narrows, look for **every** reader of it, not the one the ticket named.

## `tori://dapsource`, the kind whose content has no file at all

A debug frame can point at code that exists on no disk: a bundled dependency, an `eval`, node's own internals. DAP's rule is that **`sourceReference > 0` beats `path`**, even when a path is given, and js-debug really does send node frames as `path: "<node_internals>/internal/modules/cjs/loader"` *with* a live reference, so reading the path first opens a tab on a file that has never existed. The content comes back from a `source` request and opens read-only.

Its arg is keyed by **session id as well as reference number**, because two runs hand out the same small reference numbers for different code and a tab keyed on the number alone would show one run's source under another's name. The fetched text is kept rather than re-fetched, since a session's `sourceReference` dies with the session and a tab left open after the run should still read as what was stepped through. See [[component_debug_panel]].

## Related

- [[concept_editor_tab_workspaces]] - the per-workspace tab model these ids join, and the path-keyed maps they must not collide in.
- [[component_commit_history]] - the first two kinds, `tori://log` and `tori://commit`.
- [[concept_three_way_conflict_model]] - the third kind, `tori://conflict`.
- [[concept_editable_search_results]] - `tori://search`, why it is not a file buffer, and why its `ws=` is a key rather than a folder.
- [[concept_feature_workspace]] - where `feature:<id>` comes from, and the `wsKey` versus `activeRoot` split behind it.
- [[concept_local_history_blobs]] - `tori://localhistory`, the sibling of the git file-history tab.
- [[concept_command_registry]] - where the `editorTab` versus `editorFile` split lives.
- [[component_debug_panel]] - `tori://dapsource`, and why its content outlives the session that produced it.
