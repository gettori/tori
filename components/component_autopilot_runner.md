---
summary: rpc/runner.rs owns the autopilot session: resumes it unless it died, one restart only on a death, status from turn events
status: current
updated: 2026-10-04
source: plan "Autopilot session and the cockpit (#205)" on branch orchestrator, issue gettori/tori#205; commits eff34ef6, 4b309f03, 7dfdc1a9; src-tauri/src/rpc/runner.rs, src-tauri/src/rpc/mod.rs, src-tauri/src/settings.rs, src-tauri/resources/autopilot/brief.md; plan "Autopilot hard lock, release on stop, reconcile on start (#209)" on branch orchestrator, issue gettori/tori#209; commits 28f747ed, 32def50a, f29dfcbd; plan "Autopilot brief: liaison rule, outcomes in my nouns (#211)" on branch orchestrator, issue gettori/tori#211; plan "Run a setup command when a worktree is created" on branch setup-command, ticket gettori/tickets#2
---

# Autopilot runner

`src-tauri/src/rpc/runner.rs` starts, stops and restarts the autopilot's chat session from Rust, with no tab open.

## Responsibility

It owns the one autopilot session: spawning it, knowing its state, and handing its links on when it is replaced. It does **not** own what the autopilot decided (that is [[component_autopilot_store]]) or how anything is drawn ([[component_autopilot_cockpit]]).

- **Start** writes `settings.autopilot.enabled = true`, resets the death count and launches unless one is running. **Stop** writes `enabled = false`, sets `off`, then closes the session with `Closed`. Only these two write `enabled`: `set_settings` keeps the file's value over the frontend's copy, the same rule as `forge.picks`, so a stale save from the panel cannot flip it.
- **Launch** resumes `runner.json`'s current id when it did not die and runs on the same agent, else mints a fresh one ([[adr_every_autopilot_start_is_a_fresh_session]]). It sets `starting` with the agent and cwd and runs the rest on a thread: an ACP agent can take a minute to open. A fresh start records the id and agent in `runner.json`, rebinds the previous id's links and delivers the bundled `resources/autopilot/brief.md`; a resume delivers the same brief behind a `RESUMED` line saying it replaces the one in the transcript, so a brief edit reaches a resumed autopilot too. Both go through `chat::commands::spawn_session` with `background: true`, `visible: false`, cwd `~/.config/tori/autopilot/session/` ([[component_chat_host]]). A resume that fails to start falls back to a fresh id, closing the old one after the status names the new. A stop that lands mid start closes the session once it spawns. A death sets `died` in `runner.json`, so the restart is fresh.
- **The model pick.** For claude, model and effort go in argv. For an ACP agent they are not argv: the runner's own sink waits (up to 60 s) for `SessionStarted`, then calls `set_model`, before delivering the brief.
- **Compaction.** When a turn ends past `settings.autopilot.compact_at` percent of the context window, the runner sends `/compact` and sets `rebrief`. The turn end after it delivers the brief again as a `compacted` Tori note, behind a `COMPACTED` line telling the autopilot not to rerun its opening steps or message me, since a summary drops the brief's rules. The turn end after that brief never compacts (`rebriefed`), or a compaction that left the context over the mark would loop. Both land before the runner reads idle, so the watcher's batch waits behind them.
- **Restart** happens only on a `died` end, and only once; a second death sets `error {title, detail}` and keeps the dead session id so its transcript can be read. `closed` and `killed` never restart, so app shutdown neither restarts nor touches `enabled`. A manual start resets the count.
- **Autostart** at launch when `enabled` is set and the feature is on (`settings.autopilot.available`, the Settings switch), called from `lib.rs` after the state is managed.
- **The picks** live in `settings.autopilot` (`agent`, `profile`, `model`, `effort`). `agent` is a `String` whose serde default, `null` and `""` all read as claude, so the default lives in Rust alone. `profile` is in the tab spelling (`null` is the default account), which is what `chat_spawn` takes.

- **A worker's install.** The brief's "A new worktree's setup" section has the autopilot read `setup` off `worktree_new`: call again while `running`, and tell the worker in its prompt when the setup `failed` (with the log) or was `skipped` for a fork ([[component_worktree_setup]]).

## The lock

`runner::locks(status, item_state, spawner)` is the one predicate: while the runner is `starting|idle|working`, a session is locked when an item in `running|waiting_on_you` names it, or when the autopilot spawned it (spawner resolved through `resolve_spawner`) and no item names it at all. A closed item releases its worker even with the autopilot on. `rpc::is_locked` feeds it from the store and `SessionStates`; `chat_send`, `chat_steer`, `chat_interrupt` and `session.steer` from anyone but the current autopilot refuse a locked session with `rpc::LOCKED`. The webview reads the set through `autopilot_locked`, re-read on `autopilot://status`, `autopilot://changed` and each worker spawn, and never computes the lock itself. `rpc::start` fails soft, so the check uses `try_state` and no socket locks nothing.

A tab's held first prompt goes through `chat_send_held`, which skips the check, not through `deliver` ([[gotcha_deliver_draws_the_user_message_itself]]).

## Status

`Status {state: off|starting|idle|working|error, session, agent, cwd, error}`. A Rust spawned session has no tab, so no webview report gives it a state; the runner derives it from `Lifecycle` events instead: `rpc::publish_session` hands each one to `observe` (turn started is `working`, turn ended is `idle`, ended goes to the restart rule). It reaches `publish_session` through the `RUNNER` static, because that function's test has no `AppHandle`.

Status goes out twice: as the socket kind `autopilot.status` on the `autopilot` channel (never inside `autopilot.changed`, which every consumer reads as an item), and as the Tauri event `autopilot://status` for the webview.

## runner.json and the rebind

`~/.config/tori/autopilot/runner.json` holds `current`, `previous` and up to 20 `retired` ids. On each start the previous id's `spawned_by` entries (`SessionStates::rebind_spawner`), its holds' `ask.session` and every `shown_in` entry (`Asks::rebind_session`, which re-sends `ask.show` for moved cards) move to the new id. `resolve_spawner` maps any retired id to the current one, which is how a worker resumed from a tab restore record after a relaunch (the record carries `spawner`, and `chat_spawn` calls `mark_spawned_worker`, which it does for a fresh background worker too) still bubbles up to the live autopilot.

## Interface

- Tauri: `autopilot_start`, `autopilot_stop`, `autopilot_status`. The webview is not a socket caller, so these go around the socket rows to the same runner.
- Socket: `autopilot.start`, `autopilot.stop`, restricted to `NOT_SESSIONS` (Local and Terminal) so no agent session can switch it on ([[component_app_socket]]). `autopilot.state` carries `runner`. CLI: `tori autopilot start|stop`.

## Related

- [[adr_autopilot_is_a_session_not_a_state_machine]]: why the autopilot is a session at all
- [[adr_every_autopilot_start_is_a_fresh_session]]: resume or fresh, and the rebind
- [[adr_a_background_session_needs_a_tori_gate]]: what `background: true` buys
- [[component_autopilot_cockpit]]: what draws the status
- [[gotcha_a_chat_view_on_a_rust_spawned_session_must_wait_for_its_first_turn]]: why the view attaches late
- [[gotcha_a_frontend_settings_key_with_no_rust_field_is_dropped_on_save]]: why `autopilot` exists on both sides
- [[component_autopilot_watcher]]: follows the status; every `set` nudges it
- [[component_worktree_setup]]: the setup status a worker's worktree reports
