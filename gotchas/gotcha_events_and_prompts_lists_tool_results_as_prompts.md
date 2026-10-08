---
summary: events_and_prompts lists every user-role record as a prompt, tool results included, so it is no turn boundary on its own
status: current
updated: 2026-10-08
source: "Provenance plan, gettori/tickets#25 (branch phase-1-block-1), phase provenance-core; src-tauri/src/chat/history.rs:48 (events_and_prompts pushes a prompt for every turn whose role is user)"
---

# events_and_prompts lists tool results as prompts

Do NOT treat `events_and_prompts`'s prompt list as human prompts. A claude transcript files each tool result as a user-role record, and the replay pushes a prompt for every user-role record, so a turn with ten tool calls shows up as eleven "prompts". Why: anything that snaps to the nearest prompt or groups calls by prompt lands on a tool result instead of the turn. Filter to entries whose first event is a `UserMessage`, or cut by time as [[gotcha_a_checkpoint_turn_spans_many_transcript_prompts]] does. `verification::session_turns` groups by this list and may be splitting turns the same way; not checked.

## Related

- [[concept_who_wrote_an_interval]] where this was met
- [[gotcha_a_claude_transcript_replay_has_no_turn_completed]] the other way the replay's turns are not the live ones
