---
summary: blind_edit::Tracker marks an ACP edit to a file the session never saw, per session in wrap, with the first verdict per call kept
status: current
updated: 2026-10-08
source: "Blind-edit warning plan (branch `phase-1-block-1`, gettori/tickets#27); `src-tauri/src/blind_edit.rs` (`Tracker`, `enabled`), `src-tauri/src/chat/host.rs` (`wrap`, `mark_blind_edits`), `src-tauri/src/chat/commands.rs` (`history_reply`), `src/panels/Chat/chatStore.ts` (`turnBlindEdits`)"
---

# Blind edits

`src-tauri/src/blind_edit.rs` marks an edit to an existing file the session never saw first. The mark rides on the call's `ToolCallCompleted` as `blindEdits`, and the chat shows it on the tool card and at the head of the turn. A fact on the call, never a gate.

## Responsibility

- **Seen, in event order.** A Read or Search call's input paths and locations (Glob excepted). For a search (a Search call, or a command with `rg`, `grep`, `ag` or `ack` among its words), every `path:` that leads an output line. Every word of an Execute command, resolved against the directory of the last `cd` before it. A file the session created or already edited. A Move carries seen status across when any of its paths was seen.
- **Exact paths only.** A directory never covers the files under it, or one `ls` or `find .` would silence the mark for the rest of the session. Matching is lexical, the same `normalize` and `expand` secret watch uses.
- **Blind** means a `FileEdit` of kind `Modified` whose path was not seen when the edit arrived, on a call that then completed `Ok`. A failed or denied call is never marked and does not count as seen. A later read does not clear a mark. Deletes are ignored.
- **ACP only, by construction.** Only `FileEdit` makes an edit, and the Claude adapter emits none. Claude needs no mark anyway: its own Edit and Write refuse a file the agent has not read. `opencode acp` sends no diff block, so it gets no `FileEdit` and no mark either.
- **Not Checkpoints.** Checkpoint turns anchor on a Claude transcript's `promptTs`, ACP logs have none, and Claude never produces a blind edit, so a Checkpoints mark would only ever be empty.

## Interface

- `Tracker::observe(&ChatEvent) -> Vec<String>`: feed every event in order. It returns the blind paths on a completion and is empty otherwise. The tracker never reads the setting.
- Live: `ChatHost::wrap` keeps one tracker per session in `blind`, observes only `ToolCallStarted`, `FileEdit` and `ToolCallCompleted`, **after** the output cut (so a log replay parses the same text), and writes the mark only when `blind_edit::enabled()`. The tracker outlives a rewire and is dropped on close or a fatal event.
- Replay: `ChatHost::mark_blind_edits` runs a fresh tracker over `history_reply`'s events and overwrites every completion's mark, so switching the setting off hides marks the log carries. Not run on `chat_history_page`: pages exist only for Claude transcripts, and a tracker over one page would lack the reads on earlier pages.
- Setting: `blindEdits.enabled` (default on, lenient parse), the Chat pane's "Mark edits made without reading" row.

## Why it is this way

- **First verdict per `tool_use_id` is kept.** A `session/load` (resume, or `replay()` after a webview reload) streams the conversation back through the same tracker. By then the seen set holds the reads that came after each edit, so recomputing would clear every mark. See [[gotcha_an_acp_load_hands_history_back_through_the_live_sink]].
- **Lenient about what counts as seen, strict about paths.** A wrong "edited without reading" is an accusation, see [[concept_evidence_tiered_attribution]]. But leniency that silences the mark entirely (directories) defeats it.

## Related

- [[component_secret_watch]] the stateless sibling whose matcher helpers this reuses
- [[gotcha_a_change_to_live_chat_events_misses_replay]] why marking happens in two places
- [[gotcha_an_acp_load_hands_history_back_through_the_live_sink]] the replay the verdict cache survives
- [[concept_evidence_tiered_attribution]] why the seen set is lenient
- [[component_verification]] the sibling tracker in `wrap` that marks turns
