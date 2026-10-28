---
summary: rpc/watcher.rs wakes the autopilot from worker events, one line per item, one turn once idle, capped, no tokens
status: current
updated: 2026-10-28
source: plan "Watcher: wake the autopilot only for something actionable (#206)" on branch orchestrator, issue gettori/tori#206; src-tauri/src/rpc/watcher.rs, src-tauri/src/rpc/mod.rs (start_watcher, publish_session, publish_pr), src-tauri/src/chat/host.rs (is_progress), src-tauri/src/chat/commands.rs (mark_spawned_worker); gettori/tori#210 on branch orchestrator, plan 'Assigned pickup: poll my issues and review requests, queue them, start on ask or auto (#210)'; gettori/tickets#43 on branch scheduled-runs, plan "Scheduled runs", commits 0cdcf86b, ee900c1d, f5e7ccb4; gettori/tickets#45 on branch fix-ci-until-green, plan "Fix CI until green, then ask to merge", commits 40193aae, bb56adef, 02c357b4, 04ab48cd; gettori/tickets#46 on branch agents-launching-agents, plan "Agents launching agents: wait reasons, check, handoff, loop", commits 9ad18c06, 78628446, 7fefbcd6, dc61f72c; gettori/tickets#48 on branch cost-per-ticket, plan "Cost per ticket and per pull request, with a projection before queueing", commits 798e6f83, a72dc201, 6374485e, e0acfc08
---

# Autopilot watcher

`src-tauri/src/rpc/watcher.rs` turns worker events into short wake lines and sends them to the autopilot as a new turn. It never calls a model or reads a transcript.

## Responsibility

It owns deciding which worker events are worth a paid turn, and when that turn goes out. It does not own the autopilot's state ([[component_autopilot_runner]]), the queue ([[component_autopilot_store]]) or what the autopilot does with a wake (the brief).

- **Who is watched.** A session whose spawner mark (`SessionStates::spawner_of`) is the runner's current session, plus the session of any open item (`AutopilotStore::item_for_session`). `chat_spawn` sets the mark before the child starts, since `session.spawn` only learns the id after the spawn, so a worker asking at once is still heard. A session the core already tracks stays watched after its mark goes ([[gotcha_a_workers_spawner_mark_is_gone_before_its_session_ended]]).
- **What wakes.** `question`, `permission`, `needs_you`, `ended (reason)`, `pr (#n state; checks; review)`, `idle (outcome)` when a worker's turn ends and no turn starts within 10 s, and `stalled` when a worker is in a turn with no progress for `settings.autopilot.stall_minutes` (default 20). `proposed (ask|auto)` and `dropped (<why>)` for items assigned pickup made or closed, fed by `Watcher::picked` from the `autopilot_pickup` command. `scheduled (<name>)` for a run a schedule queued, and `paused (<name> after 3 failed runs)` on the run that paused its schedule, fed by `Watcher::scheduled` and `Watcher::paused` from the schedule clock ([[component_autopilot_schedules]]). `looped (<entry>)` for each item `autopilot.loop` queued, fed by `Watcher::looped`. `check_failed (<check>, run <id>)`, `checks_passed`, `remark (@who[, verdict])` and `conflicting` for a fix-loop item's own watch, fed by `Watcher::fix_news` from `fix_loop::tick` ([[component_fix_loop]]); `pr_event` drops the `pr (...)` line for an item `pr_watch::item_watched` covers. `over_ceiling (<spent> of <ceiling>)` once per crossing of an item's spend ceiling, fed by `Watcher::spend` from `rpc::spend_heard` after each recorded turn; `Core.told_over_ceiling` forgets an item back under, and everything when the autopilot goes Off ([[concept_spend_attribution]]). Turn starts, checkpoints and state moves never wake.
- **Stall clock.** Progress is `is_progress` in `ChatHost`'s `Lifecycle` (text, thinking, tool calls, file edits, subagents, turn edges), stamped through `rpc::watcher_touch`. A question or permission pauses it until the next progress, so waiting on the user is not a stall. It fires once per silence.
- **One line per target.** Keyed by item, or by session for a worker no item names yet; a later event of the same kind replaces the earlier one in the line. Format: `item <id>: <whats>, session <sid>` or `session <sid>: <whats>`.
- **Caps.** `pr` and `idle` go out at most once per target per 5 minutes. A repeat inside the window is held, latest state wins, and goes out when the window ends. Questions, permissions, ends, stalls, proposals, drops, scheduled runs, loop items and pauses are never capped.
- **PR events** match items by PR key (`Source::Pr`, or `pr_url` parsed) or by the worktree the branch is checked out in, not only by the event's live `ids`, so a PR change after the worker ended still wakes its item.

## Delivery

`take(now, stopped)` sends nothing while the autopilot's session is held at its spend ceiling (`Composer::budget_stopped`, read by `run` each pass); the batch waits and goes once the ceiling is lifted, within `MAX_WAIT`. The runner's state decides: off or error drops everything (the next start reconciles from `autopilot.state`), starting or working holds, idle sends the whole batch as one turn with `ChatHost::deliver(mid_turn: false, TurnBy::Watcher)`. Never a steer, since ACP refuses one ([[concept_mid_turn_steer]]). After a send nothing more goes until the runner's state changes or 30 s pass with no turn, and a failed send is requeued under that same timeout rather than retried in a loop.

It runs on its own thread, never inside a publish callback. The thread sleeps until the next deadline (debounce, stall, cap window, send timeout) or a nudge: every watched event and every `Runner::set` nudges it. So a quiet autopilot costs nothing.

## Interface

- `Watcher::new(states, store, status)`, started by `rpc::start_watcher`, held in the `WATCHER` static.
- `session_event` from `rpc::publish_session`, `pr_event` from `rpc::publish_pr`, `touch` from `rpc::watcher_touch`, `nudge` from `rpc::nudge_watcher`.
- `Core` is the pure part with time passed in; its tests cover every rule above.

## Related

- [[concept_spend_attribution]]: the recorded turn that feeds `over_ceiling`
- [[adr_autopilot_is_a_session_not_a_state_machine]]: why a watcher that spends no tokens exists
- [[component_autopilot_runner]]: the state delivery follows
- [[component_autopilot_store]]: the items a wake is labelled with
- [[concept_socket_event_vocabulary]]: the events it reads, and `by: "watcher"`
- [[adr_a_workers_questions_bubble_up_to_its_spawner]]: why the autopilot no longer waits on workers
- [[concept_tori_notes]]: how a wake is marked and drawn
- [[adr_assigned_pickup_rides_the_forge_poll_tick]]: the pickup the item wakes come from
- [[component_pr_watch]]: a sibling that copies these delivery rules for any chat watching a pull request
