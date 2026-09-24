---
summary: a worker asks like any session; its spawner sees the question in session.wait and settles it with ask.answer
status: current
updated: 2026-09-24
source: plan "tori mcp: the MCP front on the socket" (phase 9, revised after phase 8) on branch orchestrator; commits 928f500e, a375fb7a; src-tauri/src/rpc/table.rs (WORKER_REFUSAL); src-tauri/src/rpc/states.rs (wait_settled); src-tauri/src/rpc/methods.rs (session_wait); the approval exception from plan "Approval gate for background sessions" (gettori/tori#203) on branch orchestrator, commits 277c772e, 66dbe76d and 4f3069ce
---

# A worker's questions bubble up to its spawner

## Context

A session spawned by a chat session is a worker: a claude session handing a codex session a review, or a task that may need the user's input on the way. Autopilot will be one more spawner of this kind. When autopilot is off, though, the worker still has to reach a person. Some of the time that person is watching the worker's tab, and some of the time they only watch the spawner.

## Decision

A worker asks like any session. `ask.create` is open to it, and the card lands in the worker's own panel. The spawner learns of the question through `session.wait {id, timeout}`. That call returns as soon as the worker stops `working`, with `{id, state, question, last}`: `question` is the worker's pending ask, `last` its latest assistant text. The spawner can relay the question through its own `ask` and settle the worker's with `ask.answer {id, answer}`, which also drops the card. Whichever side answers first settles the same ask.

Only `session.spawn` and `session.steer` are refused to a worker, with "a worker never spawns or steers; finish your turn and your spawner reads it". It is also refused `session.wait` and `ask.answer`, since it has no workers of its own. The refusal lives in the method table, so the CLI and the MCP tool list are trimmed together.

## Alternatives rejected

- **Refuse `ask` to workers and have them end the turn with the question in prose.** This was the first cut. It is a convention carried in a refusal string, which three harnesses would each have to follow, and a user watching the worker's tab gets no card to answer.
- **Wake the spawner with a synthetic user turn when a worker finishes.** That would let something other than the user start a turn in a foreground chat. The spawner waits instead, when it chooses to.
- **A `--worker` flag at spawn.** One more flag to forget. The spawn itself is the mark: a chat principal's spawn records it, and a session's end or `rpc::revoke` clears it.

## Consequences

- Autopilot is just a spawner that waits. Nothing here changes when it arrives.
- A permission pending in the worker (`can_use_tool`, ACP `request_permission`) shows in `session.wait` only as `needs_you` with `question: null`. Routing it to the spawner is the gate in [[adr_a_background_session_needs_a_tori_gate]].
- **An approval ask is the exception.** An ask carrying an `approval` is the user's alone: `ask.answer` refuses it for every socket caller, the spawner included, so no agent approves its own worker's post. Its card is mirrored into the worker's root background chat instead, so the user answers it where they are looking. See [[adr_a_background_session_needs_a_tori_gate]].
- An ask the worker's harness cancels still leaves its card up until someone answers it, and nobody reads that answer.
- Worker marks live in `SessionStates` and do not survive a Tori restart.

## Related

- [[component_tori_mcp]]: the tools a worker gets and the ones it does not
- [[component_app_socket]]: `session.wait`, `ask.answer` and the worker mark
- [[adr_autopilot_is_a_session_not_a_state_machine]]: the spawner this was shaped for
- [[adr_a_background_session_needs_a_tori_gate]]: where a worker's permission prompts go next
- [[concept_blocking_tool_call_ceiling]]: why the MCP tools wait 240s at most
