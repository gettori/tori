---
summary: each autopilot start is a new session id plus the brief; the old id's workers, holds and mirrored cards are rebound
status: current
updated: 2026-09-24
source: plan "Autopilot session and the cockpit (#205)" on branch orchestrator, issue gettori/tori#205; commit eff34ef6; src-tauri/src/rpc/runner.rs, src-tauri/src/rpc/asks.rs (rebind_session), src-tauri/src/rpc/states.rs (rebind_spawner)
---

# Every autopilot start is a fresh session

## Context

The autopilot is a chat session ([[adr_autopilot_is_a_session_not_a_state_machine]]). It starts on a switch, on app launch when left on, and after a crash. Its memory is on disk ([[component_autopilot_store]]), and the brief's first instruction is to read that state and reconcile. But other things name its session id: workers record it as their spawner, holds and approvals are bound to it ([[adr_a_background_session_needs_a_tori_gate]]), and worker approval cards are mirrored into it through `shown_in`.

## Decision

Every start mints a new session id and delivers the brief. The runner records `previous -> current` in `runner.json` and moves the previous id's `spawned_by` entries, holds and `shown_in` entries to the new id. Retired ids stay mapped, so a worker resumed after a relaunch still resolves to the current autopilot.

## Alternatives rejected

- **Resume the same session, even after a crash.** Keeps every id stable with no rebind, but the context grows with every restart, and a crash can leave a transcript that does not resume, which then needs a fresh session fallback anyway.
- **Leave worker links to the reconcile in #209.** Less code now, but until #209 lands a restart would orphan in flight workers and approvals, and "a restart is a non event" would be false.

## Consequences

- The context is always small and a broken transcript never blocks a start.
- Anything new that names the autopilot's session id must be added to the rebind, or it is orphaned on the next start.
- The rebind moves ids but not live connections: a card is re-sent with `ask.show` so the new panel draws it.

## Related

- [[component_autopilot_runner]]: where it happens
- [[adr_autopilot_stores_decisions_and_derives_facts]]: why the state survives a fresh session
