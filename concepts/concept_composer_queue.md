---
summary: the chat queue holds content blocks per entry, comes back parked from a per-session file, and a queued steer leaves only once it lands
status: current
updated: 2026-10-05
source: plan "Queue upgrades: blocks, queue key, row actions, edit, persist" (personal/tori, branch `steer-message-uprades`, ticket gettori/tickets#8); `src/panels/Chat/chatStore.ts:1950,1982,2019,2045`; `src/panels/Chat/ChatView.tsx:1328,1387,1493`; `src/panels/Chat/queuePersist.ts`; `src-tauri/src/chat/queue_store.rs`; `src/utils/chatCompose.ts:232,526`
---

# The composer queue

What a chat holds for its next turn. While a turn runs, Enter steers it when the agent can take input mid-turn ([[concept_mid_turn_steer]]) and Option+Enter queues instead. Each entry is a whole message: its text and its labelled attachments ([[concept_labelled_attachments]]), so an attachment-only message is a valid entry. Rows can be reordered, removed, steered into the running turn or opened in the composer for editing, and the queue survives a reload or a relaunch, coming back parked.

## How it works

**An entry is `{ id, blocks, held?, steering? }`.** `enqueue` (`chatStore.ts:1950`) takes the composer's chips along with the text, so two queued messages can never disagree about which one carries a file. `held` is the autopilot-exempt first prompt and rides `chat_send_held`; `queueParked` is the other "held", a queue waiting on the user after a stop or a restore, and `queueRestored` picks which of the two the strip says.

**A queued steer stays queued until it lands.** `beginSteer` (`:2045`) marks the entry `steering`, `steerQueued` (`ChatView.tsx:1387`) sends its blocks through the same probe gate and `chat_steer` as a typed steer, and `endSteer` removes it only on `sent`. While marked, `oldestQueued` (`:1982`), and so `pendingFlush`, Cmd+Shift+Enter, steer-now and edit, all skip it. A refused steer clears the mark and loses nothing, and a turn ending mid-steer cannot flush the same message as a new turn. `steerQueued` checks `stopped()` itself, see [[gotcha_sendblocks_does_not_check_the_spend_ceiling]].

**Editing borrows the composer.** `startQueueEdit` (`ChatView.tsx:1493`) moves the draft and chips aside with `stashComposer` (`chatCompose.ts:232`, a temporary aside, not the [[concept_prompt_stash]]), loads the entry's text and its refs back as chips (labels kept), and the Composer routes submit to a save while `editing` is set. Save and cancel both put the stash back. If the entry leaves the queue mid-edit, what was typed is kept: as the draft when the stash was empty, in recall history otherwise.

**Persistence is one file per session.** `chat_queue_load`/`chat_queue_save` keep `chat-queues/<session>.json` under the config dir (`queue_store.rs`, atomic writes, ids limited to a bare file name). `queuePersist.ts` runs every write for a session through one promise chain, never writes `steering`, and skips a queue identical to the last one written. ChatView writes nothing until its load resolves ([[gotcha_a_persist_effect_derived_from_live_state_erases_everything_not_currently_live]]). A restored queue is parked and re-ided ([[gotcha_a_restored_queue_entry_needs_a_fresh_id_since_nextid_restarts_each_run]]). Closing the tab drops the file, as does `delete_session`.

**Sends wait for the numbering.** `numberingSettled` (`ChatView.tsx:1328`) is `labelsSeeded && queueLoaded`. A restored entry's labels are raised with `raiseLabels` (`chatCompose.ts:526`), which is `seedLabels` without marking the key seeded, so whichever of history and the queue lands first, nothing goes out until both have.

## Why it is this way

**Steer stays the default.** A queue-or-steer setting was rejected: the composer already says what Enter will do and what a steer costs, and one explicit key is smaller than a setting.

**A file per session, not localStorage.** localStorage would leave orphans on session delete and share its quota with tab restore. The backend owns the file so `delete_session` can take it with the session.

**Parked on restore.** The same rule as after a stop: a queue nobody watched being typed must not fire by itself.

## Related

- [[concept_mid_turn_steer]]: the steer path a row reuses
- [[concept_labelled_attachments]]: the labels an entry carries
- [[concept_prompt_stash]]: the global parked-draft store, which Cmd+S leaves alone while a queued entry is edited
- [[concept_spend_ceilings]]: why the flush and every steer check the ceiling
- [[gotcha_a_restored_queue_entry_needs_a_fresh_id_since_nextid_restarts_each_run]]
- [[gotcha_a_persist_effect_derived_from_live_state_erases_everything_not_currently_live]]
