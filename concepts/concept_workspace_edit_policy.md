---
summary: applyWorkspaceEdit is one applier with precheck, onDirty and beforeWrite hooks, as callers differ only in policy
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth (personal/tori, branch `wave-7`); Phase 1 (commits c4750d7, cec4058), Phases 2-3 (5155ea8, 630d36a, 952c547); `src/panels/Editor/workspaceEdit.ts`, `serverEdits.ts`, `batchWrite.ts`, `codeActionCommand.ts`, `lspRename.ts`"
---

# Applying a WorkspaceEdit: one applier, three policy hooks

Every language feature that *changes* files receives the same thing: a `WorkspaceEdit`, in one of two shapes, possibly touching files no tab has open. Before wave 7 the only code that could apply one lived inside `renameAcross`, tangled with rename's own policy. Extracting it revealed that what differs between callers is not mechanics but **policy**, so `applyWorkspaceEdit` takes an `ApplyPolicy` carrying three hooks and nothing else varies. Rename is now those three hooks plus a git backstop; its 36 existing tests passed unchanged through the extraction.

## How it works

`applyWorkspaceEdit(edit, deps, policy)` handles both the `changes` map and the `documentChanges` array, and the **ordering is the load-bearing part** (the same rule [[concept_lsp_workspace_bridge]] states): flatten the edit, materialise *every* file it names into the server's document set, and only then build the `WorkspaceMapping`. A mapping snapshots `startDocs` at construction, so a file materialised after it exists is a file the mapping cannot place.

The three hooks:

- **`precheck`** — refuse before anything is asked. Rename uses it for "this is a multi-file change in a folder that is not a repository, so no backstop is available".
- **`onDirty`** — what to do about a background buffer with unsaved edits. The interactive path asks; the server-initiated path refuses.
- **`beforeWrite`** — the last gate before the first byte. Rename takes its git snapshot here; `serverEdits` reads its expiry flag here.

Writes go through `batchWrite.ts` (`writeFilesSuppressingEcho`), which was lifted out of `lspRenameCommand.ts` when a second caller needed it: importing it back would have made `lspClient → lspRenameCommand → lspClient`. Writes happen before dispatches, so a buffer and the file underneath it never disagree mid-apply.

**Resource operations are refused**, and the refusal takes the whole edit with it. Applying only the text half of an edit that assumes a created file leaves those edits sitting against a tree where it never happened.

## Why it's this way

**The refusal is the backstop, not the defence.** Declaring `workspaceEdit.documentChanges` *without* `resourceOperations` is what stops a conformant server sending create/rename/delete at all. The check in the applier covers the servers that send them anyway.

**A server-initiated edit may never open a modal.** The server is *blocked* on the answer. Where the interactive path asks "may I save this for you", `serverEdits.ts` answers `{"applied": false}` with a `failureReason` and explains in a toast. This is the whole shape of the module.

**A UI deadline is not a request timeout, and they point in opposite directions.** `serverEdits` bounds its answer at **2 s**; `request_timeout_ms` is 20 s for TypeScript and 90 s for rust-analyzer and measures how long Tori is willing to wait for a *server*. Using the latter here would leave a server blocked for a minute and a half on a question about the user's own dirty buffer. The same 2 s bound is used by `organizeOnSave.ts` and by the completion resolve, each for its own version of "a person is waiting".

**A deadline that abandons its loser has to stop it cooperatively.** The first version raced a promise against a timer, answered `applied: false` at 2 s, and let the losing apply run on: an apply that was merely slow (2.1 s) would then write files *behind* an answer saying nothing changed. `beforeWrite` reading an `expired` flag the timer sets is what makes the abandonment real, and it is pinned by a test confirmed to fail without it.

## Related

- [[concept_lsp_workspace_bridge]] — the materialise-before-mapping ordering this depends on, and where `WorkspaceMapping` comes from
- [[concept_server_request_router]] — how a server-initiated `workspace/applyEdit` reaches this at all
- [[component_code_actions]] — the interactive caller, with the same three hooks and different sentences
- [[gotcha_workspacemapping_snapshots_startdocs_at_construction]] — the trap the ordering exists for
- [[gotcha_a_whole_document_replace_collapses_every_position_map]] — the neighbouring one
