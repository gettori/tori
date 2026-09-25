---
summary: assigned pickup runs on the webview's forge poll tick, files items for the brief to start, and closes only what it picked
status: current
updated: 2026-09-25
source: gettori/tori#210 on branch orchestrator, plan 'Assigned pickup: poll my issues and review requests, queue them, start on ask or auto (#210)'; src-tauri/src/autopilot.rs (plan_pickup, AutopilotStore::pickup); src-tauri/src/rpc/mod.rs (autopilot_pickup); src/utils/forgeStatus.ts (pollProject)
---

# Assigned pickup rides the forge poll tick

## Context

#210 asked the autopilot to pick up issues and review requests assigned to me, "in Rust next to `refresh.rs`, on the existing forge poll cadence, never a new timer". That could not all hold: `forge/refresh.rs` is GitLab token renewal, and the only forge cadence is the webview's `pollNow` ([[concept_forge_rate_budget]]), with its pause, backoff and `forge.enabled` kill switch.

## Decision

- `pollProject` in `forgeStatus.ts` invokes the Tauri command `autopilot_pickup` for each project a tick polls. Rust returns at once while the feature is off, else reads the list through `issues::commands::assigned_if_offered` and applies it with `AutopilotStore::pickup`.
- It runs whenever the feature is available, with the autopilot on or off, so a start finds what was assigned meanwhile.
- Rust only files items: `proposed` under `pickup: ask`, `queued` under `auto`, and always `proposed` on a project's first tick. The brief starts them, under `limits.max_workers` from `autopilot.state` (`settings.autopilot.max_workers`, kept one under the live chats cap). Nothing in Rust refuses a spawn over it.
- An item that leaves a complete list from the account that picked it closes `done` and `gone_upstream`, and the watcher wakes the autopilot with `dropped`, so the brief steers the worker to stop. A declined item is not proposed again until it has left the list and come back.

## Alternatives rejected

- **A Rust thread with its own 120 s loop**: works with no webview, but it is a second clock that ignores the webview's pause and backoff, the thing the ticket said not to add.
- **Poll only while the autopilot runs**: fewer requests, but assignments stay invisible until a start.
- **Rust spawns the worker under `auto`**: faster, but it duplicates the brief's worktree, link and contract steps ([[adr_autopilot_is_a_session_not_a_state_machine]]).
- **`session.spawn` refuses at the cap**: a hard stop a miscounting model cannot overshoot, rejected for the same reason `maxConcurrentChats` warns rather than refuses.
- **Match open items only, as `Target::Key` does**: a declined item would come back every tick.
- **Treat a first tick's backlog as new**: under `auto` it queues everything already assigned, unattended.
- **Close on any complete list**: an account switch would end every picked item, since another login's `@me` is someone else.

## Consequences

- Pickup needs the window alive and the project watched in the sidebar, like the status chips.
- A project whose backlog was empty on its first tick proposes its first real assignment once even under `auto`, since "first" is derived from the items rather than stored.
- A list at GitHub's search cap closes nothing ([[gotcha_an_assigned_list_at_the_search_cap_proves_nothing_missing]]).
- The brief owns starting queued work, on start and whenever a worker's item closes, so an edit there also goes into `RESUMED` ([[gotcha_a_resumed_autopilot_keeps_the_brief_it_started_with]]).

## Related

- [[component_autopilot_store]]: `plan_pickup` and the two item fields
- [[component_autopilot_watcher]]: the `proposed` and `dropped` wakes
- [[component_issue_source]]: `assigned_if_offered` and the gate
- [[concept_forge_rate_budget]]: the tick this rides
- [[component_autopilot_cockpit]]: where proposed rows show
