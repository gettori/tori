---
summary: Cmd+S parks a composer draft in one global Rust-written stash.json; removing an entry sweeps its unshared uploads
status: current
updated: 2026-10-05
source: plan "Prompt stash: park the composer draft and bring it back" (personal/tori, branch `prompt-stash`, ticket gettori/tickets#9); `src-tauri/src/chat/stash_store.rs:62,73,79,90`; `src/panels/Chat/promptStash.ts:88,116`; `src/panels/Chat/Composer.tsx:633,656`; `src/utils/chatCompose.ts:485`
---

# The prompt stash

A place to park a half-written prompt. Cmd+S in a focused chat composer takes the draft and its chips into the stash and empties the box; Cmd+S in an empty box brings the only entry back, or opens a menu over several (newest first, Enter restores, Backspace or the row's x discards). One list for the whole app, at most 20 entries, kept in `stash.json` under the config dir so it outlives a reload and a relaunch. An entry is `{ id, text, chips, at }` and belongs to no provider, session or project. Not to be confused with `stashComposer`, which is the queue edit's temporary aside ([[concept_composer_queue]]).

## How it works

**Rust is the only writer.** `stash_store.rs` exposes `stash_list`, `stash_push`, `stash_take` and `stash_discard`, each a read-modify-write under the `prompt-stash` named lock that answers the new list. `promptStash.ts` keeps the list it was last answered, runs every call through one promise chain, and never saves a list of its own. Entry ids are minted once in the webview (time plus counter) and stay the same on disk, so a take or discard after a relaunch finds its entry.

**Removing an entry sweeps its uploads.** `discard` (`stash_store.rs:79`) and a push past the cap (`:62`, the oldest falls off the front) write the file first, release the lock, then `sweep` (`:90`): the removed entries' holders under the attachments dir are deleted unless a transcript or the stash file still names them. `take` (`:73`) sweeps nothing, since the chips move into a composer. Every stash command is async because the sweep reads every transcript.

**The stash is a holder for the session delete sweep too.** `delete_session` passes `stash.json` as a referrer to `drop_unreferenced`, so a screenshot stashed from a chat survives that chat being deleted ([[component_attachment_store]]).

**Restore is numbered for the tab it lands in.** `restoreEntry` (`promptStash.ts:116`) takes the entry, checks each attachment chip with `checkAttachment` against the target agent (uploads under the attachments dir against its upload kinds, everything else against its mention kinds), then renumbers the kept ones with `relabelInto` (`chatCompose.ts:485`), the same path `seedForSend` uses ([[concept_labelled_attachments]]). A refused chip has its token stripped from the text and goes back into the stash as a chips-only entry, with a toast naming what the agent opens. If anything was typed into the composer while the take was in flight, the whole entry is pushed back untouched and the typing stays.

**A failed stash loses nothing.** `stashDraft` (`:88`) clears the composer first, and if `stash_push` rejects it puts the draft and chips back while the box is still empty, or the text into recall history otherwise.

**When Cmd+S is inert.** The composer ignores it while a queued entry is being edited, while the draft is linked to a scratch tab ([[concept_scratch_draft_link]]), and while a first send is held for a session still opening (`hasAutoSend`). In that last window the draft on show is the held message, and stashing it would send the text without its chips.

## Why it is this way

**One writer, because removal deletes files.** The first draft copied the queue's opaque whole-list save. With discard in Rust and saves from the webview, a stale save could bring back an entry whose uploads had just been swept, and the restored chips would point at deleted files.

**A file, not localStorage.** The backend has to read the stash to keep files alive, and a webview storage reset should not take parked work with it.

**Discard sweeps, rather than leaving files or deleting outright.** A stashed then discarded paste is named by no transcript and would sit on disk forever; deleting without the check could remove a file a fork still sends.

**The x is pointer only.** A listbox option may hold no control of its own, so the menu's discard is an `aria-hidden` target and Backspace is the keyboard path ([[lesson_a_tablist_may_own_nothing_but_tabs]]).

## Related

- [[component_attachment_store]]: the sweep the stash both feeds and is protected by
- [[concept_labelled_attachments]]: the numbering a restore re-applies
- [[concept_composer_queue]]: the other per-composer store, and its unrelated `stashComposer`
- [[concept_scratch_draft_link]]: why a linked draft cannot be stashed
- [[gotcha_a_test_that_dispatches_window_events_cannot_be_a_test_ts]]: why the stash's unit test is a `.test.tsx`
