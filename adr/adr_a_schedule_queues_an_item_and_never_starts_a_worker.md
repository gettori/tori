---
summary: a firing queues a ship item and wakes the autopilot; own file, one open run per schedule, pause derived
status: current
updated: 2026-10-21
source: gettori/tickets#43 on branch scheduled-runs, plan "Scheduled runs"; commits 0cdcf86b, ee900c1d, f5e7ccb4; interview and adversary passes on the plan, 2026-10-21
---

# A schedule queues an item and never starts a worker

## Context

gettori/tickets#43 asked for "every weekday at 7, bump deps and open a PR": a cron that turns into ordinary autopilot work under the project's contract, missed firings run once on wake, and a pause after three failed runs. The daemon (#24) already outlives the window, so a clock there fires with the window closed.

## Decision

- **A firing writes a `queued` ship item and wakes the autopilot.** The session starts it like an auto pick, under the brief, the contract and the approvals. With the autopilot off, the item waits for the next start.
- **Schedules live in their own `schedules.json`**, held in the same store as the queue so the item and the stamped slot are written under one lock.
- **One open run per schedule.** A firing that finds the schedule's last run open (or, for an issue schedule, any open item on that issue) is skipped, the slot spent, with a note on the open item.
- **Paused is derived** from the runs: the last three since `resumed_at` all `failed`. A PR closed unmerged is failed by the autopilot, not by `settle`.
- **Removing a schedule follows pickup's rule**: queued work closes, running work only gets a note.
- **Only a person resumes.** `autopilot.schedule.resume` refuses agent sessions; the Cockpit's Resume goes through a Tauri command.

## Alternatives rejected

- **Rust spawns the worker at the slot.** Fires with the autopilot off, but puts judgment in Rust and skips the brief ([[adr_autopilot_is_a_session_not_a_state_machine]]).
- **A schedule as a `Kind` in `queue.json`**, as the ticket worded it. A never-ending item every queue reader, the brief included, would have to skip.
- **Stacking or replacing an open run.** Two dependency bumps race on the same files; failing the old one kills work an approval away from done.
- **A stored `paused` flag or `notified_at`.** Facts the runs already say ([[adr_autopilot_stores_decisions_and_derives_facts]]); the cost is one repeat wake after a daemon restart.
- **Counting every non-`done` end as a failure.** A second definition; `failed` is the one the autopilot and a hand close already write.

## Consequences

- A firing while the autopilot is off leaves a stale run queued until the next start; the next slot is skipped while it waits.
- The skip note replaces the open item's status note.
- Turning the autopilot feature on fires a slot missed while it was off, once, like waking from sleep.

## Related

- [[component_autopilot_schedules]]: the implementation
- [[adr_issue_sources_live_on_the_contract]]: the removal rule this copies
