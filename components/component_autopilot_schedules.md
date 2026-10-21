---
summary: schedules.json beside the queue; a daemon clock queues one ship item per due slot, skips while open, pauses after 3
status: current
updated: 2026-10-21
source: gettori/tickets#43 on branch scheduled-runs, plan "Scheduled runs"; commits 0cdcf86b, ee900c1d, f5e7ccb4; src-tauri/src/autopilot/schedules.rs; src-tauri/src/autopilot.rs (plan_firings, paused_by, fire_due); src-tauri/src/rpc/office.rs (start_clock)
---

# Autopilot schedules

`src-tauri/src/autopilot/schedules.rs` holds the schedule type and the cron math; the store and the clock that fire them sit in `autopilot.rs` and `rpc/office.rs`. Why it is shaped this way: [[adr_a_schedule_queues_an_item_and_never_starts_a_worker]].

## Responsibility

- **The schedule.** `Schedule {id, name, project, cron, what: Prompt{text} | Issue{key}, created, last_slot, resumed_at}` in `schedules.json`, held in `AutopilotStore` beside the items so a firing writes the item and stamps the slot under one lock. A file that does not parse loads empty and refuses writes, the queue's rule. An issue key is stored canonical against the project's origin.
- **The cron.** `croner` 4 with seconds and years disallowed, five fields in the Mac's local time (`chrono::Local`). `due`, `next_run` and `next_slot` are generic over `TimeZone`; the tests use a hand-written Oslo zone for DST. croner already fires a repeated hour once and a skipped hour at most once.
- **Firing.** `plan_firings` takes, per schedule, the latest slot after `last_slot` (else `created`), so a Mac that slept through several fires once, and a new schedule never fires for a slot before it existed. The slot is stamped whether the run was queued or skipped. A run is a `queued` ship item with `Source::Schedule {schedule, issue}`, the name as `title` and the prompt (or `Work on issue <key>.`) as `contract`.
- **Skip.** A firing is skipped while an open item holds the work (`holds_work`): the schedule's own run, `taken_over` included, or for an issue schedule any open item on that issue. The open item gets the note "skipped a run of <name> while this one is open", once per text. Pickup's `same_work` leaves an issue alone while an open scheduled run holds it.
- **Pause.** `paused_by` answers the run that paused a schedule: its last three runs created after `resumed_at`, all `failed`. Never stored. A paused schedule's slot is still stamped, so the clock does not spin. `announced_pauses` (memory) makes each pause wake the autopilot once per daemon run.
- **Remove.** Fails the schedule's run only while it is `proposed` or `queued`; a running one gets the note "schedule removed" and keeps going ([[adr_issue_sources_live_on_the_contract]]).

It does not decide what a run does: the autopilot starts it from the brief like an auto pick, and fails one whose PR closed unmerged.

## The clock

`start_clock` in `rpc/office.rs` runs in the daemon. Each pass, while `settings.autopilot.available`, it calls `fire_due(now)` and hands the queued runs and new pauses to the watcher (`scheduled (<name>)`, `paused (<name> after 3 failed runs)`, [[component_autopilot_watcher]]). It then waits on `wait_for_schedules` until the soonest slot, at most a minute, at least a second: a sleeping Mac stops the timer, so the cap is what notices a missed slot on wake. A pass that did not fire (feature off, a write failed) waits the full minute, or a past slot would spin it. Writing a schedule or closing a scheduled run sets `clock_wake` ([[gotcha_a_clock_asleep_until_the_next_slot_misses_a_slot_added_just_before]]).

## Interface

- Store: `schedules()` (rows with `next_run` and `paused`), `add_schedule`, `remove_schedule`, `resume_schedule`, `fire_due(now) -> Fired {queued, paused}`, `next_slot()`, `wait_for_schedules(timeout)`. Each write publishes `autopilot.changed` with `schedule` (a row) or `schedule_removed` (an id).
- Socket rows: `autopilot.schedule.list` (anyone, not devices), `.add` and `.remove` (not workers), `.resume` (Local and Terminal only, so the autopilot cannot resume what paused). CLI `tori autopilot schedule add|list|remove|resume` ([[component_tori_cli]]); MCP tools from the same rows.
- Tauri: `autopilot_schedules`, `autopilot_schedule_resume`, through office ops, for the Cockpit's Tide table ([[component_autopilot_cockpit]]).

## Related

- [[component_autopilot_store]]: the store schedules live in
- [[adr_autopilot_stores_decisions_and_derives_facts]]: why paused is derived
- [[adr_autopilot_is_a_session_not_a_state_machine]]: why a firing wakes the session instead of starting work
- [[gotcha_inside_a_tori_session_the_cli_reaches_the_release_daemon_through_tori_sock]]: how to test the clock live
