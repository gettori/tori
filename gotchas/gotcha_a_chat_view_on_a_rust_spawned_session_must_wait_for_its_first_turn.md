---
summary: mounting a ChatView on a Rust spawned session while it is still starting races two chat_spawn calls and starts a second child
status: current
updated: 2026-09-24
source: plan "Autopilot session and the cockpit (#205)" on branch orchestrator, issue gettori/tori#205; commit 4b309f03; src/utils/autopilotStore.ts (attachable), src/panels/Autopilot/Cockpit.tsx
---

# A ChatView on a Rust spawned session must wait for its first turn

Do NOT mount a `ChatView` for a session Rust is still spawning. Its own `chat_spawn` on the same id races the Rust spawn: whichever lands second finds no entry yet and starts a second child, instead of rewiring the first. Why: a second `chat_spawn` only rewires when the id is already live in `ChatHost`, and during `starting` it is not. Gate the mount on the session having started a turn (`attachable`: the runner is `idle` or `working`).

## Related

- [[component_autopilot_cockpit]]
- [[component_chat_host]]
- [[component_autopilot_runner]]
