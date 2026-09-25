---
summary: text Tori writes into a chat is wrapped in <tori kind="...">, drawn as a centred Tori row with an info card, never as the user's
status: current
updated: 2026-09-25
source: branch orchestrator for gettori/tori#207, commits e44ef711, 290849c4, c6b82754; src-tauri/src/rpc/events.rs (from_tori); src/utils/toriNote.ts; src/panels/Chat/ToriNote.tsx; src/panels/Chat/MessageList.tsx
---

# Tori notes

Tori puts text into chats it does not own a side of: the autopilot's brief, the watcher's wakes, a resume, a steer from another session. Sent as a plain user turn, each read as if the user had typed it. A Tori note is that text in a marker, so every reader can tell it apart.

## How it works

- `events::from_tori(kind, from, text)` wraps it as `<tori kind="..." from="...">`, the text on its own lines, `</tori>`. Kinds today are `brief` (`runner.rs`), `wake` (the watcher in `rpc/mod.rs`), `resume` (`runner.rs`), and `steer` from a chat caller, with `from` naming the sender.
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
