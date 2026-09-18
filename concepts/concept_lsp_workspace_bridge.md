---
summary: one CodeMirror view swaps states for many files, so headless snapshots and buffer before disk reach unopened files
status: current
updated: 2026-08-03
source: "Editor wave 4: language intelligence foundations (personal/tori, branch `wave-4`); Phase 3 (commit c5dac84), Phase 4 (commit 7d4ff3a); `src/panels/Editor/toriWorkspace.ts`, `lspRename.ts`, `liveBuffers.ts`"
---

# The workspace bridge: one editor view, many files a server holds open

`@codemirror/lsp-client` is written against an editor where every open file has its own `EditorView`. Tori has **one** view and swaps `EditorState`s through it, so the library's `DefaultWorkspace.displayFile` returns null for everything not currently on screen, and every cross-file operation silently does nothing. `ToriWorkspace` is the adapter that closes that gap. It is what turns go-to-definition, find-references and rename from same-file features into real ones. See [[gotcha_lsp_client_assumes_one_editor_view_per_file]].

## How it works

- **A file the server has open need not be on screen, or in any view at all.** The workspace tracks two kinds: view-backed (the one shown) and **headless** (a snapshot of text the server was told about). `requestFile(uri)` materialises a headless file on demand, which is what lets a rename reach a file the user never opened.

- **Buffer before disk, always.** `requestFile` resolves content from `CodeEditor`'s buffer map first and from disk only as a fallback, reached through the registered-accessor `liveBuffers`. A dirty background tab is viewless, unsaved, and absent from any on-disk state; reading it from disk would hand the server a version of the file that exists nowhere and then apply edits against it.

- **A tab leaving the screen becomes headless; it is not closed.** `didClose` on every tab switch would send every later question about that file back to disk. What makes the snapshot safe is an invariant of Tori's own design: **a background buffer cannot be typed into**, because typing needs a view. So a snapshot stays accurate until the file changes underneath it, which is exactly what `fileChanged` covers.

- **`fileChanged` reports a *change*, not a reopen.** A `didClose`/`didOpen` pair would be simpler and is wrong: `WorkspaceMapping` maps positions *through* the reported `ChangeSet`, and a reopen offers none. The changes are computed by trimming the common prefix and suffix ([[gotcha_a_whole_document_replace_collapses_every_position_map]]), with surrogate pairs guarded so a trim cannot cut a character in half. This lives in `docDiff.ts` because format-on-save needs the same thing for an unrelated reason (a full replace moves the caret on every save).

- **Headless files have a lifecycle, and an operation can freeze it.** They are LRU-bounded and swept with `didClose` once an operation completes, but `retainMapping()` defers eviction while held. A rename that materialises past the bound would otherwise `didClose` its own earlier targets partway through and then write against files the server no longer has open.

- **Nothing is keyed on a URI string; everything is keyed on the path behind it.** `pathToUri` percent-encodes with `encodeURIComponent`; `vscode-uri`, which most servers use, escapes a smaller set. The same file therefore has two spellings. `getFile`, `requestFile`, `openFile` and `displayFile` all decode first. A `ToriFile` still *carries* the URI it was created with, because `WorkspaceMapping` is keyed by `file.uri` internally.

## Ordering is the load-bearing part

**Materialise every file before the mapping is constructed, never inside it.** `WorkspaceMapping` snapshots `startDocs` in its constructor and `mapPosition` **throws** for any URI absent from that snapshot ([[gotcha_workspacemapping_snapshots_startdocs_at_construction]]). So the obvious `withMapping`-wrapped rename fails on exactly the unopened files the feature exists to reach.

`ToriWorkspace.joinActiveMappings` seeds a live mapping with any file materialised under it, because the library's own `findReferences` builds its mapping *before* asking the workspace for a single file and offers no hook — without it, clicking a reference in a file that was not already open does nothing and reports nothing, inside a promise. That is a **guarded reach into library internals, not a contract to build on**: every access is defensive and a library reshape degrades to the throw it already had. Tori's own rename must still materialise first on its own.

## Why not the library's rename

`doRename` is synchronous where it needs to be async: at `lsp-client/dist/index.js:1213` it does `getFile(uri); if (!lspChanges.length || !file) continue`, so no `Workspace` override can materialise an unopened file in time. It skips every file the user has not already opened, silently. Tori ships its own command at `Prec.highest` so the library's F2 cannot be reached ([[gotcha_lsp_clients_dorename_is_sync_where_it_needs_to_be_async]]).

The rename's own asymmetry follows from this design: **the file on screen is dispatched into, every other file is written**, because the active buffer's undo history is the one the user can actually reach. That is why the result toast has to say the undo covers saved files only, and why a working-tree backstop is taken before the first write ([[concept_worktree_backstops]]).

## Related

- [[component_lsp_host]] — the sessions this workspace is attached to, one per `(server_id, root)`.
- [[component_cm6_editor]] — the single-view, swapped-state editor that made the adapter necessary.
- [[concept_lsp_capability_contract]] — the other half of talking to a server correctly.
- [[concept_filesystem_source_of_truth]] — why disk is the fallback rather than the authority.
- [[gotcha_lsp_client_assumes_one_editor_view_per_file]]
