---
summary: rpc/watcher.rs wakes the autopilot from worker events, one line per item, one turn once idle, capped, no tokens
status: current
updated: 2026-09-25
source: plan "Watcher: wake the autopilot only for something actionable (#206)" on branch orchestrator, issue gettori/tori#206; src-tauri/src/rpc/watcher.rs, src-tauri/src/rpc/mod.rs (start_watcher, publish_session, publish_pr), src-tauri/src/chat/host.rs (is_progress), src-tauri/src/chat/commands.rs (mark_spawned_worker); gettori/tori#210 on branch orchestrator, plan 'Assigned pickup: poll my issues and review requests, queue them, start on ask or auto (#210)'
---

# Autopilot watcher

`src-tauri/src/rpc/watcher.rs` turns worker events into short wake lines and sends them to the autopilot as a new turn. It never calls a model or reads a transcript.

## Responsibility

It owns deciding which worker events are worth a paid turn, and when that turn goes out. It does not own the autopilot's state ([[component_autopilot_runner]]), the queue ([[component_autopilot_store]]) or what the autopilot does with a wake (the brief).

- **Who is watched.** A session whose spawner mark (`SessionStates::spawner_of`) is the runner's current session, plus the session of any open item (`AutopilotStore::item_for_session`). `chat_spawn` sets the mark before the child starts, since `session.spawn` only learns the id after the spawn, so a worker asking at once is still heard. A session the core already tracks stays watched after its mark goes ([[gotcha_a_workers_spawner_mark_is_gone_before_its_session_ended]]).
- **What wakes.** `question`, `permission`, `needs_you`, `ended (reason)`, `pr (#n state; checks; review)`, `idle (outcome)` when a worker's turn ends and no turn starts within 10 s, and `stalled` when a worker is in a turn with no progress for `settings.autopilot.stall_minutes` (default 20). `proposed (ask|auto)` and `dropped (<why>)` for items assigned pickup made or closed, fed by `Watcher::picked` from the `autopilot_pickup` command. Turn starts, checkpoints and state moves never wake.
- **Stall clock.** Progress is `is_progress` in `ChatHost`'s `Lifecycle` (text, thinking, tool calls, file edits, subagents, turn edges), stamped through `rpc::watcher_touch`. A question or permission pauses it until the next progress, so waiting on the user is not a stall. It fires once per silence.
- **One line per target.** Keyed by item, or by session for a worker no item names yet; a later event of the same kind replaces the earlier one in the line. Format: `item <id>: <whats>, session <sid>` or `session <sid>: <whats>`.
- **Caps.** `pr` and `idle` go out at most once per target per 5 minutes. A repeat inside the window is held, latest state wins, and goes out when the window ends. Questions, permissions, ends, stalls, proposals and drops are never capped.
- **PR events** match items by PR key (`Source::Pr`, or `pr_url` parsed) or by the worktree the branch is checked out in, not only by the event's live `ids`, so a PR change after the worker ended still wakes its item.

## Delivery

The runner's state decides: off or error drops everything (the next start reconciles from `autopilot.state`), starting or working holds, idle sends the whole batch as one turn with `ChatHost::deliver(mid_turn: false, TurnBy::Watcher)`. Never a steer, since ACP refuses one ([[concept_mid_turn_steer]]). After a send nothing more goes until the runner's state changes or 30 s pass with no turn, and a failed send is requeued under that same timeout rather than retried in a loop.

It runs on its own thread, never inside a publish callback. The thread sleeps until the next deadline (debounce, stall, cap window, send timeout) or a nudge: every watched event and every `Runner::set` nudges it. So a quiet autopilot costs nothing.

## Interface

- `Watcher::new(states, store, status)`, started by `rpc::start_watcher`, held in the `WATCHER` static.
- `session_event` from `rpc::publish_session`, `pr_event` from `rpc::publish_pr`, `touch` from `rpc::watcher_touch`, `nudge` from `rpc::nudge_watcher`.
- `Core` is the pure part with time passed in; its tests cover every rule above.

## Related

- [[adr_autopilot_is_a_session_not_a_state_machine]]: why a watcher that spends no tokens exists
- [[component_autopilot_runner]]: the state delivery follows
- [[component_autopilot_store]]: the items a wake is labelled with
- [[concept_socket_event_vocabulary]]: the events it reads, and `by: "watcher"`
- [[adr_a_workers_questions_bubble_up_to_its_spawner]]: why the autopilot no longer waits on workers
- [[concept_tori_notes]]: how a wake is marked and drawn
- [[adr_assigned_pickup_rides_the_forge_poll_tick]]: the pickup the item wakes come from
- [[component_pr_watch]]: a sibling that copies these delivery rules for any chat watching a pull request
