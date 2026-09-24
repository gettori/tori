---
summary: an autopilot start resumes the last session unless it died or the agent changed; a fresh id rebinds the old id's workers, holds and cards
status: current
updated: 2026-09-25
source: plan "Autopilot session and the cockpit (#205)" on branch orchestrator, issue gettori/tori#205; commit eff34ef6; amended on branch orchestrator for the ticket flow (#207); src-tauri/src/rpc/runner.rs (launch, resumable, mark_died), src-tauri/src/rpc/asks.rs (rebind_session), src-tauri/src/rpc/states.rs (rebind_spawner)
---

# An autopilot start resumes, unless the last session died

The slug is from the first version of this decision, when every start was fresh.

## Context

The autopilot is a chat session ([[adr_autopilot_is_a_session_not_a_state_machine]]). It starts on a switch, on app launch when left on, and after a crash. Its memory is on disk ([[component_autopilot_store]]), and the brief's first instruction is to read that state and reconcile. But other things name its session id: workers record it as their spawner, holds and approvals are bound to it ([[adr_a_background_session_needs_a_tori_gate]]), and worker approval cards are mirrored into it through `shown_in`.

At first every start was a fresh session. In use that emptied the cockpit's conversation on every switch on, and dropped whatever the user had told the autopilot in passing that never reached the store.

## Decision

A start resumes `runner.json`'s current session when it ended cleanly (a stop, an app exit, a kill) and the autopilot's agent is the one it ran on. It gets a short `<tori kind="resume">` note to rerun the brief's opening steps, not the brief again.

A fresh session is minted after a death, when the agent changed, and when a resume fails to start. A fresh start delivers the brief, records `previous -> current` in `runner.json` and moves the previous id's `spawned_by` entries, holds and `shown_in` entries to the new id. Retired ids stay mapped, so a worker resumed after a relaunch still resolves to the current autopilot. A resume keeps its id, so nothing moves.

## Alternatives rejected

- **A fresh session on every start.** The first version. The context stays small and a broken transcript never blocks a start, but the conversation is lost on every switch on.
- **Resume even after a crash.** A death can leave a transcript that does not resume, and a resume that dies again spends the one restart. A death always starts fresh.
- **A "new voyage" action to clear it by hand.** Another control, for a growth that compaction already handles. Not built until the growth hurts.
- **Leave worker links to the reconcile in #209.** Less code, but a fresh start would orphan in flight workers and approvals.

## Consequences

- The autopilot's context grows across days until the agent compacts it.
- A resume that fails before it opens falls back to a fresh start in the same launch. One that dies after it opens is a death, so the restart is fresh.
- `runner.json` records the agent and whether the current session died; a file without them starts fresh once.
- Anything new that names the autopilot's session id must be added to the rebind, or it is orphaned on the next fresh start.
- The rebind moves ids but not live connections: a card is re-sent with `ask.show` so the new panel draws it.

## Related

- [[component_autopilot_runner]]: where it happens
- [[adr_autopilot_stores_decisions_and_derives_facts]]: why the state survives a fresh session
