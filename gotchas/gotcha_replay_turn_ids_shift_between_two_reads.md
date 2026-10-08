---
summary: replay turn and synthetic tool ids share a counter subagent expansion advances; never match them across parses
status: current
updated: 2026-10-08
source: "Open a chat with a bounded tail of history (personal/tori, branch `open-chat-with-bound`); `src-tauri/src/chat/history.rs` (`events_and_prompts`, `expand_subagent`, `TURN_PREFIX`, `TOOL_PREFIX`)"
---

# Replay turn ids shift between two reads

Do NOT key anything that has to survive a second read on a replayed `turn_id` (`hist-turn-N`) or a synthetic tool id (`hist-tool-N`). Why: both come from one `seq` that `expand_subagent` also advances, so a subagent finishing between two reads, or a turn appended above, renumbers everything after it. The prompt's transcript timestamp is stable, which is why the history cursor is `promptTs` plus an offset.

## Related

- [[component_history_tail]]: the cursor built around this
- [[gotcha_a_claude_transcript_replay_has_no_turn_completed]]: where the per-record ids come from
- [[adr_chat_opens_on_a_bounded_tail]]: the rejected index cursor
