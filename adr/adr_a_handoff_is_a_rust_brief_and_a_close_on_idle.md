---
summary: session.handoff briefs the new agent in Rust plus a session ref, closes the old one only once idle, keeps its spawner
status: current
updated: 2026-10-27
source: gettori/tickets#46 on branch agents-launching-agents, plan "Agents launching agents: wait reasons, check, handoff, loop", commit 7fefbcd6; src-tauri/src/rpc/methods.rs (session_handoff, handoff_brief, inherited_spawner, close_when_idle, may_hand_off); src-tauri/src/rpc/states.rs (wait_closable, handed_to)
---

# A handoff is a Rust brief and a close on idle

## Context

`tori handoff <id> --to <agent>` moves a live chat's work to another agent in the same folder. The usual reason is that the old session is out of room: its context is nearly full, or its account hit a limit. A session also has to be able to hand itself over from inside its own turn, through the MCP tool, and the session it replaces may be someone's worker.

## Decision

The brief is built in Rust from the old session's history: its first prompt, its last reply, what it was waiting on, its `session.check` verdict and diff stat, the caller's note, and a `[Session: x]` reference written as the same `ref_note` a Ref block is sent as, so the new agent pages the rest with `session_history`. Each quoted part is capped at 4000 chars.

The new session is spawned through the ordinary `spawn` path as the old session's spawner (`inherited_spawner`), or as `Local` when it had none, so `record_spawn` makes it that spawner's worker and background follows the spawner.

The old session is closed on a detached thread once `SessionStates::wait_closable` sees it idle. Never while it waits on a question or permission, and never on the request thread.

A session the autopilot holds is refused, the autopilot included, unlike a steer.

## Alternatives rejected

- **Have the old session summarise itself as a last turn.** Richer, but it spends a turn, and it fails exactly when a handoff is most needed: at a usage limit or a full context.
- **Refuse while the old session is working.** A self-handoff always is working, inside its own tool call, so it could never hand itself over.
- **Interrupt, then close.** Cuts off the tool reply of a self-handoff, and drops a question the user is about to answer.
- **Rebind the autopilot item to the new session.** Puts item bookkeeping into a socket path that otherwise knows nothing of items. Refusing is the smaller rule.

## Consequences

- A spawner's `session.wait` on the old id answers `ended` with `handed_to`, and the spawner may answer the new session as its own worker.
- When `to` is the spawner's own agent, `fill_picks` also hands the new session the spawner's model and mode, read-only included.
- A close at an idle between turns drops a message queued for the old session's next turn.
- `handed_to` is never pruned: one entry per handoff for the daemon's life.

## Related

- [[component_app_socket]]: the `session.handoff` row and `SessionStates`
- [[component_tori_cli]]: `tori handoff`
- [[adr_a_workers_questions_bubble_up_to_its_spawner]]: why a worker's handoff stays a worker
- [[gotcha_a_workers_spawner_mark_is_gone_before_its_session_ended]]: the end ordering a spawner lookup has to live with
- [[component_chat_host]]: `ChatHost::close`, which the detached thread calls
