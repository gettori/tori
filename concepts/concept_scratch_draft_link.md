---
summary: a draft lifted into a scratch tab has one writer, the editor, and the link and its file die on send, close or edit here
status: current
updated: 2026-09-07
source: "plan \"Chat composer Tier 1: spell check, safe sends, draft tooling\" (personal/tori, branch `composer-260907`, merged into `logo-update-260907`), phase 4 . `src/panels/Chat/composerScratch.ts:20` . `src-tauri/src/scratch.rs:86` . commit `8e8579e`"
---

# A draft edited in a scratch tab has one writer

A long prompt can be lifted out of the composer into a real editor tab and written there, but only one surface may write it at a time. While the link stands the editor owns the text and the composer is read only; the composer keeps the send. The link is per composer key, it ends on send, on the tab closing or on "edit here", and the scratch file is removed in every one of those cases, because the draft store already holds the text.

## How it works

`openDraftInEditor` (`composerScratch.ts:20`) asks the backend for a new scratch file, writes the draft into it, records the path against the composer key (`chatCompose.ts:257`), and emits `OPEN_IN_EDITOR`. The composer's textarea goes `readOnly` and its hint line names the tab.

Two reports come back out of the editor, both new:

- `EDITOR_FILE_SAVED { path, contents }` fires in `CodeEditor.tsx:878`, straight after the write and therefore **after** organize-on-save and format-on-save have rewritten the text. `mirrorSaved` copies it into the draft when the path is the linked one and ignores every other save.
- `EDITOR_TAB_CLOSED { path }` is not emitted from `closeTab`. It comes from one effect in `Editor.tsx:413` that diffs the union of `tabsByWs` paths across renders, so every removal path reports (close, `forceCloseFile`, a folder purge) while a workspace switch, which only hides tabs, reports nothing.

Closing from the composer's side needs a third event, because `EDITOR_CLOSE_TAB` acts on the active tab and cannot name a file. `EDITOR_CLOSE_PATH { path, discard? }` closes the tab holding a path, with `discard` routing to the editor's existing `forceCloseFile`. Before emitting it, `unlinkScratch` reads the editor's current buffer through `liveBufferText` and puts that in the draft, so unsaved text is carried rather than lost and no discard dialog appears. `onSend` does the same substitution for the outgoing message. The file then goes through `scratch_remove` (`scratch.rs:86`), which canonicalizes and refuses anything not directly under the scratch directory.

## Why it's this way

**Two writers lose data.** The first cut let the composer stay editable while linked, so a word typed there was silently overwritten by the next save. Read only is the smallest rule that makes the mirror safe, and the send has to stay in the composer because that is where the session, the attachments and the queue live.

**The close event names a file, not the active tab.** The composer has no idea which tab is active, and the tab it cares about is usually not.

**Removal, not the Trash.** Every other delete in the app trashes, which is right for a user's file. A scratch created for one prompt is not: the text is already in the draft store, so a copy in the Trash after every send is litter. `scratch_remove` exists rather than reusing `fs_delete` for that reason, and it is path-scoped so it can never reach past the scratch folder.

**Not covered by the link.** A reload drops it, leaving an ordinary scratch tab and the last mirrored draft, which is the honest degradation. A tab closed from the editor's own button while dirty still shows the editor's discard confirm, because that close is the user's, not the composer's.

## Related

- [[component_chat_panel]] - the composer half, and the rest of the Tier 1 work this shipped with
- [[component_cm6_editor]] - the editor that now reports its saves and closes
- [[concept_safe_send]] - the insert-only rule this obeys; nothing here sends by itself
- [[concept_synthetic_editor_tabs]] - why a scratch is a real file with a real path rather than a synthetic id
- [[gotcha_a_test_that_dispatches_window_events_cannot_be_a_test_ts]] - the trap its unit test hit
