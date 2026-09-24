---
summary: ChatHost::ended revokes the worker mark before it publishes session.ended, so a spawner lookup misses the end
status: current
updated: 2026-09-24
source: plan "Watcher: wake the autopilot only for something actionable (#206)" on branch orchestrator; src-tauri/src/chat/host.rs (Lifecycle::ended), src-tauri/src/rpc/mod.rs (revoke), src-tauri/src/rpc/watcher.rs (Watcher::found)
---

# A worker's spawner mark is gone before its session.ended

Don't decide whether a `session.ended` is about a worker by asking `SessionStates::spawner_of`. `Lifecycle::ended` calls `rpc::revoke` first, which runs `forget_worker`, and only then publishes `session.ended`. By the time a subscriber sees the end, the mark is already gone. Why: revoking first stops a dead chat's token and asks from being used, and that ordering is right for them.

The watcher keeps its own record of every session it has seen and falls back to it when the lookup misses. The start has the opposite race: `session.spawn` records the mark only after the spawn returns, so `chat_spawn` marks a background worker before its child starts.

## Related

- [[component_autopilot_watcher]]: where the fallback lives
- [[component_chat_host]]: `Lifecycle` and its ordering
- [[gotcha_a_chat_childs_fatal_event_can_arrive_before_spawn_inserts_its_entry]]: the other lifecycle ordering trap
