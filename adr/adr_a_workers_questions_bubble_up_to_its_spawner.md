---
summary: a worker asks like any session; its spawner reads its Tori asks, native questions and permissions and answers them
status: current
updated: 2026-09-25
source: plan "tori mcp: the MCP front on the socket" (phase 9, revised after phase 8) on branch orchestrator; commits 928f500e, a375fb7a; src-tauri/src/rpc/table.rs (WORKER_REFUSAL); src-tauri/src/rpc/states.rs (wait_settled); src-tauri/src/rpc/methods.rs (session_wait); the approval exception from plan "Approval gate for background sessions" (gettori/tori#203) on branch orchestrator, commits 277c772e, 66dbe76d and 4f3069ce; native questions and permissions from plan "Ticket flow: work on #N" (gettori/tori#207), commits 1b7e479d, 4cd91a8f; src-tauri/src/chat/host.rs (track_waiting, settle); src-tauri/src/rpc/methods.rs (session_answer)
---

# A worker's questions bubble up to its spawner

## Context

A session spawned by a chat session is a worker: a claude session handing a codex session a review, or a task that may need the user's input on the way. Autopilot will be one more spawner of this kind. When autopilot is off, though, the worker still has to reach a person. Some of the time that person is watching the worker's tab, and some of the time they only watch the spawner.

## Decision

A worker asks like any session. `ask.create` is open to it, and the card lands in the worker's own panel. The spawner learns of the question through `session.wait {id, timeout}`. That call returns as soon as the worker stops `working`, with `{id, state, question, last}`: `question` is the worker's pending ask, `last` its latest assistant text. The spawner can relay the question through its own `ask` and settle the worker's with `ask.answer {id, answer}`, which also drops the card. Whichever side answers first settles the same ask.

A worker's harness can also stop on a question or a permission of its own (claude's `AskUserQuestion`, `can_use_tool`, ACP `request_permission`), which never becomes a Tori ask. `session.pending {id}` lists everything a session waits on in one shape, `{kind: ask|question|permission, id, text, options | tool + detail}`, and `session.answer {session, id, answer}` settles a native one: a permission takes `allow` or `deny`, a question one answer per question, where an answer matching an option's label picks it and anything else is free text. Only the session's spawner may call it (`resolve_spawner`, so a retired autopilot id counts as the current one); a worker, another session and a Local or Terminal caller are refused, so no shell can allow a background worker's permission. An id that is no longer waiting errors "already answered or gone" rather than reporting success.

For the autopilot the brief decides permissions by the item's contract: `auto_until_outward` lets it allow local actions and tell the user, `ask_everything` relays each one. A push, `gh` or any network write from a worker's shell is always relayed. That line is a brief rule, not Rust, since Rust cannot read shell intent.

Only `session.spawn` and `session.steer` are refused to a worker, with "a worker never spawns or steers; finish your turn and your spawner reads it". It is also refused `session.wait` and `ask.answer`, since it has no workers of its own. The refusal lives in the method table, so the CLI and the MCP tool list are trimmed together.

## Alternatives rejected

- **Refuse `ask` to workers and have them end the turn with the question in prose.** This was the first cut. It is a convention carried in a refusal string, which three harnesses would each have to follow, and a user watching the worker's tab gets no card to answer.
- **Wake the spawner with a synthetic user turn when a worker finishes.** That would let something other than the user start a turn in a foreground chat. The spawner waits instead, when it chooses to.
- **A `--worker` flag at spawn.** One more flag to forget. The spawn itself is the mark: a chat principal's spawn records it, and a session's end or `rpc::revoke` clears it.

## Consequences

- The autopilot does not wait: its watcher wakes it on a worker's question, end or idle, and its brief says never to call `session_wait` ([[component_autopilot_watcher]]). `session.wait` stays for any other spawner.
- `session.wait` still reports a native prompt only as `needs_you` with `question: null`; the spawner reads it with `session.pending`. The registry behind both is in [[component_chat_host]].
- **An approval ask is the exception.** An ask carrying an `approval` is the user's alone: `ask.answer` refuses it for every socket caller, the spawner included, so no agent approves its own worker's post. Its card is mirrored into the worker's root background chat instead, so the user answers it where they are looking. See [[adr_a_background_session_needs_a_tori_gate]].
- An ask the worker's harness cancels still leaves its card up until someone answers it, and nobody reads that answer.
- Worker marks live in `SessionStates` and do not survive a Tori restart.

## Related

- [[component_tori_mcp]]: the tools a worker gets and the ones it does not
- [[component_app_socket]]: `session.wait`, `session.pending`, `session.answer`, `ask.answer` and the worker mark
- [[component_chat_host]]: the registry of native prompts a session waits on
- [[adr_autopilot_is_a_session_not_a_state_machine]]: the spawner this was shaped for
- [[adr_a_background_session_needs_a_tori_gate]]: where a worker's permission prompts go next
- [[concept_blocking_tool_call_ceiling]]: why the MCP tools wait 240s at most
