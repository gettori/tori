---
summary: a Claude transcript replay mints a turn id per record and sends no TurnCompleted, so a per-turn mark must group by prompt
status: current
updated: 2026-10-08
source: "Verification badge plan (branch `phase-1-block-1`, gettori/tickets#26); `src-tauri/src/chat/history.rs` (turn ids from `TURN_PREFIX` and a counter), `src-tauri/src/verification.rs` (`mark_history`)"
---

# A Claude transcript replay has no TurnCompleted

Live, a turn is bracketed: its events share one turn id and it ends with `TurnCompleted`. A Claude chat reopened from its transcript is not. `history.rs` mints a fresh turn id for every transcript record and emits no `TurnCompleted` at all. So anything that closes a turn on `TurnCompleted`, or groups a turn's calls by turn id, finds either nothing to close or one "turn" per record on reopen, while the mirror log of an ACP session works fine and hides the bug.

Group by prompt instead: a `UserMessage` with a new turn id starts a turn, and the mark anchors on the turn id of the first reply event (text, thinking or a tool call) after it, which is the id the chat's turn head is keyed on. Close the last turn at the end of the history. Tell the two shapes apart by whether the history holds any `TurnCompleted`.

## Related

- [[component_verification]] `mark_history`, which does both
- [[gotcha_a_change_to_live_chat_events_misses_replay]] the replay path this lives on
- [[gotcha_replay_turn_ids_shift_between_two_reads]] why the minted ids cannot be matched across parses
