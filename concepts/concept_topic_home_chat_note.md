---
summary: a Topic home chat is told its Topic as a queued Tori note at spawn, resume, compaction and every change; outside worktrees adopt on refresh
status: needs-verification
updated: 2026-10-03
source: branch topic-metadata; src-tauri/src/topic_home.rs (note, told, tell_home_chats, HomeLaunch); src-tauri/src/chat/commands.rs (spawn_session); src-tauri/src/rpc/mod.rs (tell_session, retell_topic); src-tauri/src/topics.rs (list_and_adopt, announce_and_tell)
---

# Topic home chat note

A chat started in a Topic's home folder reaches every member through `--add-dir`, but nothing it loads says which members are read only or where the worktrees are. `TOPIC.md` holds that and no agent reads it. So Tori tells the chat itself: the same text, rendered by `topic_home::note`, sent as a `<tori kind="topic">` note with the user's first message and again whenever it may have gone stale. The write guard still enforces the rules; the note means the agent knows them before a write is refused.

## How it works

- **Spawn and resume.** `launch_for` builds `HomeLaunch.note`, and `spawn_session` queues it after a successful spawn with `note_for_next_turn`. A remount returns before that, so it never queues twice. Spawns are lazy, so the note always rides the next send.
- **After a change.** Every mutating Topic command takes `told(topic)` before and calls `tell_home_chats` after. It tells only when `note` changed, grants new roots first, and sends the whole note as `topic-changed`, granted or not. Record-only commands go through `announce_and_tell`; a reorder uses plain `announce` and tells nobody.
- **Delivery.** `tell_session` steers into a running turn and queues for an idle chat. A steer the transport refuses (ACP) falls back to the queue.
- **After a compaction.** `Lifecycle::observe` publishes `session.compacted` with its `trigger`, and the publisher in `lib.rs` calls `retell_topic`. An `auto` compaction is told mid turn, off the event thread. A `manual` one (`/compact`) is queued, since that turn ends at once and a steer would start a turn of its own.
- **Changes git made.** The `list_topics` command runs `list_and_adopt` and tells home chats of any Topic whose note no longer matches the stored record: a deleted worktree folder, or a worktree made outside promote. The second is adopted from the listing the reconcile already made: a reference member whose repo has a non-main worktree on the Topic branch becomes a worktree member, `settle` adopts the folder, and `topics://promoted` moves the Topic's tabs. The plain `list_topics` function still never changes membership.

## Why it is this way

- **A note rather than files or hooks.** `CLAUDE.md` and `AGENTS.md` in the home would pass metadata off as project instructions. A `SessionStart` hook is Claude only. MCP server instructions are fixed at initialize. A `topic_info` tool needs the agent to know to call it. The note queue sits above the transport, so every agent gets it.
- **Visible.** It reuses the Tori row, so nothing is sent behind the user's back.
- **Always on resume.** Reading the last note back to send only a changed one would need a reader per transport.
- **Adoption has no watcher.** A worktree made in Tori's own UI fires `config://changed`, so it is adopted at once. One made in a terminal waits for the next refresh, or the refused write points the chat at promote, which adopts the same worktree.
- **Unverified.** That a steer at an auto compaction lands in the running turn on Claude was not checked against a live session.

## Related

- [[concept_tori_notes]]: the marker, the queue and the row
- [[gotcha_a_queued_note_is_the_first_block_of_the_users_message]]: what every reader of the user's message has to split
- [[concept_socket_event_vocabulary]]: `session.compacted`
- [[component_chat_host]]: `note_for_next_turn`, `send`, `wrap`
