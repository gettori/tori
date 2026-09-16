---
summary: a foreground subagent never streams its report live, so replaying the session shows strictly more than watching it did
status: current
updated: 2026-09-04
source: plan "Subagent lanes in the chat panel" (phases 0, 2b and 4), branch `bugfix-260903`; `dev/fixtures/claude/{permission-subagent,subagent-parallel,subagent-background}.jsonl`; `dev/fixtures/sessions/subagent-{foreground,background}/`; `src-tauri/src/chat/claude.rs::map_assistant`; `src-tauri/src/chat/history.rs::a_reopened_session_offers_the_lanes_the_live_run_showed`; commits `d1bdc8f`, `4321b45`
---

# A foreground subagent's report is only on disk

The plan was drafted on "live is rich, replay is thin": watching a subagent shows everything and reopening the session recovers what it can. Measured, that is backwards in the one place it matters, and it was wrong twice in a row for two different reasons.

## What was measured

A throwaway probe replayed each captured stream and printed every frame carrying `parent_tool_use_id`:

- `permission-subagent` and `subagent-parallel`, both **foreground**: the call and its result, and nothing else.
- `subagent-background`: the call, its result, **and** a closing `assistant/text`.

A subagent never streams, in any of the three. Its whole live footprint is `assistant/tool_use`, `user/tool_result` and, only when it was backgrounded, one whole `assistant` frame carrying its report.

## Why it was wrong twice

**First, the mapper threw away what did arrive.** `claude.rs` mapped every `assistant` frame to nothing, on the sound reasoning that its content already arrived as stream deltas. True of the main agent, false of a subagent, which does not stream. So a nested call reached the store only as its `tool_result`: a card with `name: null` and no input. A whole phase existed to turn `Some("assistant") => Vec::new()` into a `map_assistant` guarded on `parent_tool_use_id`, and everything else followed from that one line.

**Then, the file turned out to hold the part the wire never sends.** The `Agent` call's `toolUseResult` carries the report as `content`, and `<sid>/subagents/agent-<id>.jsonl` carries the subagent's whole conversation. So reopening a foreground lane shows strictly **more** than watching it did.

## What it cost, and what it bought

It cost a phase inserted mid-plan (2b) and a reordering: reopen parity moved ahead of the blocked-lane work, because the measurement had moved the feature's weight there. It bought a parity test that asserts the right thing. The obvious assertion, "the reopened lane equals the live lane", is false in the correct direction and would have been fixed by weakening it until it passed. Instead each pair of fixtures is the **same run captured twice**, the stream and the files the CLI wrote for it, and the test asserts a superset with the one extra row named:

```
permission-subagent  live ["tool"]          replay ["tool", "text"]
subagent-background  live ["tool", "text"]  replay ["tool", "text"]
```

Two captures of two different runs would only have proved each shape self-consistent.

## The general shape

Two recordings of one event are not two copies. Before writing a parity assertion between a live channel and a stored one, replay both for the same run and diff them, because which side is thinner is a measurement and not a property of "live" and "stored". The direction of the inequality is the finding; asserting equality just deletes it.

## Related

- [[concept_subagent_lanes]] - the feature this measurement shaped
- [[lesson_debug_the_harness_before_recording_the_outcome]] - the sibling rule about the probe itself
- [[lesson_pin_a_vocabulary_not_a_sequence]] - how these fixtures are re-verified
- [[gotcha_a_backgrounded_subagents_ending_arrives_as_a_message_under_the_users_own_role]] - the other half of the disk story
