---
summary: text Tori writes into a chat is wrapped in <tori kind="...">, drawn as a centred Tori row with an info card, never as the user's
status: current
updated: 2026-10-03
source: branch orchestrator for gettori/tori#207, commits e44ef711, 290849c4, c6b82754; src-tauri/src/rpc/events.rs (from_tori); src/utils/toriNote.ts; src/panels/Chat/ToriNote.tsx; src/panels/Chat/MessageList.tsx; branch topic-metadata, src-tauri/src/rpc/events.rs (split_notes), src-tauri/src/chat/host.rs (note_for_next_turn, split_user_notes)
---

# Tori notes

Tori puts text into chats it does not own a side of: the autopilot's brief, the watcher's wakes, a resume, a steer from another session. Sent as a plain user turn, each read as if the user had typed it. A Tori note is that text in a marker, so every reader can tell it apart.

## How it works

- `events::from_tori(kind, from, text)` wraps it as `<tori kind="..." from="...">`, the text on its own lines, `</tori>`. Kinds today are `brief` (`runner.rs`), `wake` (the watcher in `rpc/mod.rs`), `resume` (`runner.rs`), and `steer` from a chat caller, with `from` naming the sender.
- Kinds added for Topics: `topic` (the Topic's note, at spawn, resume and after a compaction) and `topic-changed` (after a Topic change), plus `compacted` from the runner.
- A note can also wait: `ChatHost::note_for_next_turn` queues it and `send` puts it ahead of the user's next message, so it never starts a turn of its own. A newer `topic` or `topic-changed` replaces an older one still waiting, and the queue dies with the session.
- A queued note travels inside the user's message, so it is split off wherever that message is read: `split_user_notes` in `ChatHost::wrap` (live, the ACP echo and the mirror log), `history.rs` (replay) and `extract_text` and `clean_title` in `sessions.rs` (titles). All go through `events::split_notes`, which also peels a note joined into one string ([[gotcha_a_queued_note_is_the_first_block_of_the_users_message]]).
- On a transport that does not echo sent turns, `send` draws each drained note itself. The panel's `userMessage` reducer puts a note that lands while its bubble awaits the turn above that bubble, the order the agent read them in, which also keeps "Rewind to here" on the bubble.
- `toriNote(blocks)` in `src/utils/toriNote.ts` parses a user message back into `{kind, from, body}`.
- `MessageList` draws a note as `ToriNoteRow`: centred, the Tori sail from `src-tauri/icons/tray.png` masked in the text colour, a label per kind ("Tori started the autopilot with its brief", "Tori resumed the autopilot", "Tori: a worker reports ...", "From <session>"), and an (i) button opening the body at the column's full width.
- `threadFrom` skips notes in the popup's short thread, and `clean_title` in `sessions.rs` strips the marker so a session is not titled by its brief.
- The brief tells the autopilot that a message in the marker is from Tori, not from the user.

## Why it is this way

A marker in the text rather than a new event kind: the agent has to read it too, and every transport already carries user text. Parsing it at render keeps old transcripts working, since an unmarked brief just draws as before.

## Related

- [[component_autopilot_cockpit]]: where most notes are read
- [[component_autopilot_watcher]]: the wakes
- [[component_autopilot_runner]]: the brief and the resume
- [[concept_topic_home_chat_note]]: the `topic` notes
- [[gotcha_a_queued_note_is_the_first_block_of_the_users_message]]: why every reader splits notes off
