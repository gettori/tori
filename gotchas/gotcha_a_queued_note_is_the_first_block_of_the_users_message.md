---
summary: a note queued with note_for_next_turn goes out ahead of what the user typed, so a first-block reader sees Tori markup unless it splits
status: current
updated: 2026-10-03
source: branch topic-metadata; src-tauri/src/rpc/events.rs (split_notes); src-tauri/src/chat/host.rs (send, split_user_notes); src-tauri/src/sessions.rs (extract_text, clean_title); src-tauri/src/chat/history.rs
---

# A queued note is the first block of the user's message

Don't read the first text block of a user message as what the user typed. `ChatHost::send` puts every note queued with `note_for_next_turn` ahead of the user's blocks, so a Topic chat's first message opens with `<tori kind="topic">`. Read raw, the session gets no title (the title path skips text starting with `<`), the replayed bubble shows markup, and the ACP echo no longer matches the bubble the panel drew, so it draws twice. Go through `events::split_notes`, which peels leading notes off a block or off one joined string, as `split_user_notes`, `history.rs`, `extract_text` and `clean_title` do. Why: the note has to reach the agent, and the user's message is the only thing every transport sends.

## Related

- [[concept_tori_notes]]: the marker and the queue
- [[concept_topic_home_chat_note]]: the note that made this common
- [[component_chat_host]]: `send` and `wrap`
