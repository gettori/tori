---
summary: a lane strip switches which subagent transcript you read but never where the composer sends, every lane survives reopen
status: current
updated: 2026-09-04
source: plan "Subagent lanes in the chat panel" (phases 0 to 6), branch `bugfix-260903`; `src/panels/Chat/chatStore.ts` (`laneOf`, `rootLane`, `laneStrip`, `blockedLanes`), `src/panels/Chat/LaneStrip.tsx`, `src-tauri/src/chat/claude.rs` (`attribute_to_lane`, `map_assistant`), `src-tauri/src/chat/history.rs` (`expand_subagent`), `src-tauri/src/sessions.rs` (`subagent_transcripts`); commits `f156dc9`, `4321b45`, `785aa61`, `d1bdc8f`, `27c1f4a`, `b58191b`, `a98e363`
---

# Subagent lanes

A strip above the composer, one chip per subagent the main agent launched, that you switch into with a click or `Opt+N` to read that subagent's own transcript, and that survives closing and reopening the session. It changes what you are reading and never where the composer sends.

## The two ids, and the one frame that joins them

A subagent has two identities on Claude's wire and they are used in different places:

- `task_id`, which its `control_request/can_use_tool` carries as `agent_id`.
- `tool_use_id`, the `Agent` call that launched it, which its nested frames point at through `parent_tool_use_id`.

`system/task_started` is the **only** frame carrying both. Miss it and neither the subagent's permission prompt nor its nested calls can be attributed to anything. The tool is named `Agent`, not `Task`.

**And not every task on that channel is a subagent.** A backgrounded `Bash` announces itself the same way with `task_type: "local_bash"`, so only `local_agent` opens a lane and only `local_agent` claims its call. See [[gotcha_not_every_task_on_claudes_task_channel_is_a_subagent]].

## A lane is a field on the row, not a side map

`agentId` sits on `ToolItem`, `QuestionItem`, `TextItem` and `ThinkingItem`; `laneOf(item)` answers for every kind in one place and states the invariant. `visibleItems(items, showAllHooks, lane)` filters on it, so a lane is a view of the one append-only `items` array rather than a second store to keep in step.

The lane is **not** a field on the events, though. `ToolCallStarted` and friends have ninety-odd construction sites across ten files, nearly all of which would name `None` forever because ACP has no subagents. So `SubagentCall { agent_id, tool_use_id }` is emitted **beside** the call, from the one place that sees both a frame's `parent_tool_use_id` and the events it produced. The two deltas are different: a nested `assistant` frame is not streamed, so `TextDelta` and `ThinkingDelta` do carry `agent_id` and it is stamped in passing by `attribute_to_lane`.

## Root-resolution, so the strip stays a list

Depth is derived from the wire, not from `meta.json`'s `spawnDepth`, which is replay-only. Live, a lane's parent is `laneOfCall[subagentStarted.toolUseId]`: if the `Agent` call that launched it was itself announced against a lane, this is a depth-2 agent. `noteLane` stores the **root**, so a chain of any depth collapses to one strip entry and every row lands in exactly one lane.

Both paths that stamp a row have to root-resolve or the collapse is only half done. `appendText` originally stored the immediate `agentId` while `noteLane` resolved a card's, which put a depth-2 agent's paragraph in a lane nothing shows.

## Two sources, and they do not carry the same thing

- **Live** gives a subagent's tool calls plus its lifecycle and totals (`task_progress`, `task_updated`, `task_notification`). A subagent never streams.
- **On disk** the session transcript holds no `task_*` frames and none of the subagent's turns. Each one gets `<sid>/subagents/agent-<id>.jsonl` plus `agent-<id>.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`), beside the session file rather than inside it.

Reopening therefore shows **more** than watching did for a foreground subagent, because its closing report is only ever on disk. See [[lesson_a_foreground_subagents_report_is_only_on_disk]]. The sidecars are spliced into the turn that launched them, never into turns of their own: turn headers the live run never made would offer "rewind to here" on a boundary nobody typed.

## What the strip shows, and how long it shows it

One figure per chip, and everything except "running" says itself in words rather than in six pixels of colour:

| State | Tone | Figure |
|---|---|---|
| running | `--success-fg` | elapsed |
| waiting on you | `--brand-default` | `waiting` |
| completed | `--fg-subtle` | tokens |
| anything else | `--danger-fg` | the agent's own word |

`async_launched` is the one exception to "not completed reads as trouble": it is what a reopened session finds on a backgrounded call whose ending was never written, so it takes the idle tone. The `main` chip is not a status at all; it wears the working agent's own hue, orange for Claude, the way its tab already does.

**Every lane stays for the life of the session**, in start order, and a new one appears after the ones already there. The chips wrap onto more lines rather than shrinking, so the strip is a row that grows.

It did not start that way, and the rule it replaced is worth recording because it looked right. A lane used to *retire* from the strip once it `completed` and its `Agent` card settled, on the reasoning that the card was then the way back in. It is a way **in**. The strip is the only way back **out**: retiring the last lane took the `main` chip with it, because the strip only renders when a lane exists, so a reader who had opened a lane from its card was left inside it with nothing to click. The invariant is now stated as a test: any lane you can be reading is a lane the strip can take you out of.

## Background tasks share the row and not the contract

The agent's other background work gets a second group on the same strip, labelled `Background`, rendered as **text rather than buttons**. A shell task has no transcript, so a chip that opened one would open nothing; `selectLane` refuses it too, and the tool card that started it offers no way in.

It also has the opposite lifecycle. A lane stays for the session because it is a record you can still read; a background task is dropped from the strip the moment it ends, because its record is its own tool card and a finished chip would say the same thing twice. So the row answers two questions at once: which conversations can I read, and what is still running that is not on screen.

## A blocked subagent surfaces in main

`visibleItems` keeps a laned row when the reader is in main and the row is blocking (a call awaiting approval, or an unanswered question). One row, two places it can appear, never both at once. A prompt landing in a lane nobody is looking at stalls the session with nothing on screen explaining why. The card carries a button into the lane it came from, and `QuestionCard`'s existing "from a subagent" line becomes that button.

An interrupt settles every lane still claiming to work. A turn that merely `errored` does not: the child is alive in that case and a backgrounded subagent outlives the turn that launched it.

## Decisions worth carrying

- **The strip is the way out, the card is a way in.** `ToolCallCard` still offers "Read what this subagent did" on the call that launched a lane, because that starts from where the launch actually happened, which is what a reader scrolling the transcript has in front of them. It is no longer the only route.
- **The strip switches what you read, never what you type.** Sway has no channel to a subagent; only the main agent can message one. Disabling the composer in a lane was rejected because "kill agent B" is the thing you most want to type while watching agent B. Published as `subagents: observable`, see [[concept_harness_capability_tiers]].
- **The Diff view never follows the lane.** It answers "what did this session do to my files", which is the question asked before committing, so narrowing it to one agent would let a subagent's edit disappear from a view a user trusts to be complete. `SessionDiffView` is handed `state.items`, not the lane-filtered list.
- **Flat strip, depth 1 only.** Deeper agents render as cards inside their ancestor's lane, so the strip stays a list instead of becoming a tree.
- **No dollar figure per subagent.** The lifecycle channel reports tokens, a tool count and an elapsed time; it reports no cost, and a second token accumulator beside the CLI's own would give one subagent two numbers that drift.

## Related

- [[lesson_a_foreground_subagents_report_is_only_on_disk]] - the measurement that reshaped two phases
- [[concept_transport_neutral_event_model]] - the three events and where the lane rides
- [[component_chat_panel]] - the strip, the filter and the cards
- [[component_chat_host]] - the mapper and the sidecar reader
- [[concept_harness_capability_tiers]] - how the capability is published
- [[concept_diff_as_transcript]] - the view that stays session-wide
- [[concept_spend_ceilings]] - the ceiling a background subagent's turn has to reach
- [[gotcha_a_backgrounded_subagents_ending_arrives_as_a_message_under_the_users_own_role]]
- [[gotcha_a_factory_returning_jsx_freezes_a_row_built_from_a_store_object_mutated_in_place]]
