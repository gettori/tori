---
summary: editor tabs key per branch unit workspace while buffers stay global, closing a tab is the only thing that discards one
status: current
updated: 2026-08-05
source: "Editor wave 1: close out the fundamentals (personal/tori, branch `wave-1-4`); Phase 2, issue #14; commit 87fcfe7; `src/panels/Editor/Editor.tsx:152`, `src/utils/editorTabPersist.ts`, `src/panels/Editor/purgeTabs.ts`"
---

# Editor tabs belong to a workspace, buffers outlive the strip

Editor tabs were one flat global list, so a file opened in worktree A stayed open after switching to worktree B, where it usually does not exist. They are now keyed by branch-unit folder — the same grouping key [[concept_workspace_tab_grouping]] uses for terminal tabs — so switching swaps the strip and coming back restores the one you left, across a relaunch as well. The subtle half is that the *tabs* are per workspace while the *buffers* are not: `CodeEditor` is handed the union of every workspace's open paths, because a buffer thrown away is unsaved work thrown away.

## How it works

- **Two maps keyed by workspace**, `tabsByWs` and `activeByWs` (`Editor.tsx:152`), read through `tabs()` / `activeId()` accessors so every existing call site still reads as if there were one list. `ws()` derives from `root()` rather than reading `props.selected` a second time; the two differ only in how each spells "nothing selected" (`""` versus `null`).
- **A tab belongs to the workspace selected when it was opened**, including Docs-tree and `.shared/` files that live outside any project root. That is what gives those files somewhere predictable to land instead of nowhere.
- **`openPaths` carries the union**, so `evictClosed` fires only on an explicit tab close. Handing it the visible strip would discard a background workspace's buffers — unsaved edits included — with none of `closeTab`'s discard confirm.
- **The mount gates on the union too**, and visibility rides on the existing `hidden` prop. See [[lesson_a_mount_gate_is_a_destroy_gate]]: this is where the real hazard was.
- **Persistence** (`editorTabPersist.ts`) stores `{[workspace]: {paths, active, savedAt}}` under `tori.editor.tabs.v1`, 30 paths per workspace, 30-day staleness. `toStore` refuses to write under an empty workspace key — the bucket tabs opened before a selection resolves would land in — and that refusal lives in the pure module so it is tested rather than asserted in a comment.
- **Restore is per workspace, on first visit, automatic**, and lazy: it sets descriptors, and only the active tab's buffer is built by `CodeEditor`'s own swap. Paths are probed with `file_exists` first and a path that cannot be probed is treated as gone, since a tab whose buffer can only ever report that it failed to open is worse than no tab.
- **`purgeTabsUnder`** (`purgeTabs.ts`) sweeps every workspace when a space is deleted, not only the visible one, and reports the removed paths so the caller can clear the state it keys by path.

## Why it's this way

**The active tab is stored as a path, not an index.** An index silently points at the wrong file the moment the existence prune drops a deleted path from ahead of it. Paths are stable across a relaunch, so nothing is lost by it.

**Restore is automatic, unlike the terminal's** ([[component_tab_restore]] offers, per workspace, and waits). That asymmetry is deliberate: the terminal's offer exists because a relaunch must never silently spawn agent processes. Opening a file spawns nothing, so the ceremony would only cost a click.

**Dirty flags and preview choices stay keyed by absolute path** with no workspace dimension, because a path names exactly one file across every workspace. That invariant is exactly why a non-file tab has to carry its workspace inside its own id: see [[concept_synthetic_editor_tabs]].
- [[concept_feature_workspace]] - a Feature reuses this model unchanged under the key `feature:<id>`, one strip for files from every member.

**The restore guard counts *file* tabs, not tabs** (2026-08-02). "This workspace already has tabs, do not paste last run's strip over them" was written when every tab was a file. A synthetic tab opened from the sidebar lands while the restore's `file_exists` probes are still in flight, so counting all tabs aborted the restore. Restored tabs are now appended after whatever is already open, with an already-chosen active tab outranking the stored one.

## A rename repoints the strip; a scratch is just a file (2026-08-05, wave 6)

Two additions, both of which fit the model rather than extending it.

**`renameTabs.ts` is the pure sibling of `purgeTabs.ts`.** A rename is not a
removal, so nothing closes: tabs repoint, `CodeEditor` rekeys its buffer map so
unsaved text and undo history come along, and the jump list, frecency, bookmarks
and reopen stack follow through the same sweep. `repoint` is shared by both
modules, so "under" has exactly one definition across the tree and the pane. See
[[component_project_file_tree]] and [[concept_path_keyed_workspace_stores]].

**Scratch buffers are ordinary files** at `~/.config/tori/scratch/Untitled-N`,
bucketed by the workspace selected when ⌘N was pressed, exactly like every other
tab. Because the path is absolute, `toStore`, the `file_exists` probe,
`dirtyStash` and the fs commands all serve them unchanged. The number is the
**lowest free** `Untitled-N`, not highest-plus-one, so a promoted or closed
scratch gives its number back; `create_new` rather than `create` is load-bearing,
since the name comes from a listing taken a moment earlier and truncating a
scratch somebody is still typing into is the one outcome worth ruling out.

**Save-as is a rename with a write in front of it**, and the ordering is the
safety: write the bytes, emit `FILE_RENAMED`, then remove the old file. A failed
write leaves the untitled buffer where it was, and removing the scratch before
the new file exists is the one sequence that could lose the text. It is general
rather than scratch-only (on a real file it is a copy the tab follows, which is
what Save As means everywhere); the scratch-specific part is one line, that only
a scratch loses its original. Known asymmetry: Save-as does not run
format-on-save, unlike `saveActive`, because fixing it means routing the write
through `CodeEditor`, which owns `formatForSave`.

## Related

- [[component_cm6_editor]] — the pane that owns the model.
- [[component_project_file_tree]] — the rename and trash the strip follows.
- [[concept_path_keyed_workspace_stores]] — the other four collections that follow the same sweep.
- [[lesson_the_file_is_the_witness_not_the_buffer]] — why closing an untouched scratch stats the file rather than asking the buffer.
- [[lesson_a_mount_gate_is_a_destroy_gate]] — the near-miss this design's mount gate created and then closed.
- [[concept_workspace_tab_grouping]] — the same grouping key, one pane over.
- [[component_tab_restore]] — the terminal-side precedent, and why this one does not offer.
- [[concept_synthetic_editor_tabs]] - the `tori://` ids that share this strip without naming a file.
