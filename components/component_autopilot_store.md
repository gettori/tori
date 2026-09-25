---
summary: the autopilot queue and project contracts on disk; reads derive liveness and worktrees, only a merged PR is written back
status: current
updated: 2026-09-25
source: gettori/tori#218 plan "Ticket refs that say where they are, and one way to navigate there", commit 380c7112; gettori/tori#204 on branch orchestrator, plan "Autopilot state on disk"; commits 424a5d26, aa67f28d, 29293fe2, 280f72e8; gettori/tori#205 commit 669596a1; src-tauri/src/autopilot.rs; src-tauri/src/rpc/{mod,methods,server,asks}.rs; gettori/tori#207 commit aca065a5; plan "Autopilot hard lock, release on stop, reconcile on start (#209)" on branch orchestrator, issue gettori/tori#209; commits 28f747ed, 32def50a, f29dfcbd
---

# Autopilot store

`src-tauri/src/autopilot.rs` holds what the autopilot decided, under `~/.config/tori/autopilot/`, so killing Tori and relaunching hands back the same queue.

## Responsibility

It owns `queue.json` (items), `projects.json` (one contract per project) and `log.jsonl` (one line per write). It does **not** own holds: `holds.json` belongs to `Asks` ([[component_app_socket]]). It stores decisions only. Whether an item's session is live and whether its worktree still exists are worked out on every read and never saved ([[adr_autopilot_stores_decisions_and_derives_facts]]).

- **Item**: id, kind `ship|review`, source `issue {key, project}` or `pr {number, repo}`, project, state `proposed|queued|running|waiting_on_you|taken_over|done|failed`, worktree, session, pr_url, note, title, contract, timestamps. `title` is what a cockpit card reads (else "Ship in <project>"), and `contract` the autopilot's short statement of what to build and how it ships; both are optional and serde default, so an older `queue.json` loads, and `note` stays the status line the next update overwrites. `done` and `failed` are terminal.
- **Reference**: every `Row`, and every `autopilot.changed` item, carries a derived `reference` naming the item as `#212 (personal -> tori -> y-test)` (`reference` in `autopilot.rs`). The label is `#N` for a number, else the key as written (`ENG-123`), and a url key reads by the key inside it. The place is space and project read off the path, since Tori lays folders out as `<root>/<space>/<project>`, then the worktree's branch from the listing, else its folder name; a folder outside the root leaves it empty. `url` is the item's own (`Item.url`, optional, what `issues_get` or the forge gave), `pr` comes from `pr_url`, `target` is a `NavTarget` ([[concept_in_app_navigation]]), and `markdown` is the whole thing, percent-encoded, for the autopilot to paste. A full read keeps its worktree listing and root in `Seen`, so an event names its place without a git call; only a worktree the last read did not list asks git.
- **Contract**: `ships: pr|local`, `autonomy: ask_everything|auto_until_outward`, `pickup: ask|auto`, optional agent, account and model. `#[serde(default)]` on the container, so a missing field reads as its cautious default.
- Projects are compared with `same_folder`, never as strings ([[concept_one_directory_two_spellings]]), in the upsert key and in the contract map.

## How a read works

`state(observe)` copies the items under the one lock, then runs `observe` with the lock released. `observe` gathers live session ids (`SessionStates` plus `ChatHost::live_sessions`), git's worktree list per project, and forge PR states. The store then re-locks. `settle` applies to the items as they are *now*, not the copy, so an update that landed during `observe` is neither lost nor waited on. Last, `reconcile` stamps each row with `session_live` and `worktree_gone`.

- An unreadable repo leaves `worktree_gone` unset: `list_worktrees_body` answers an empty list for both, so `repo_readable` is asked first.
- `settle` is the only write a read makes. A merged PR sets its item to `done`. A PR closed without merging only gets a note, because what that means is the autopilot's call.
- A PR is identified by (`owner/name`, number), from `Source::Pr` or parsed from `pr_url` (GitHub `/pull/N`, GitLab `/-/merge_requests/N`), and matched against the answer from the project's origin. A number alone would close an item on another repo's merge.
- `PrStates` caches each project's answer for 30 s. It's a hit only when every number asked for was asked last time, and a failed lookup is not cached.

## How a write works

`update` and `settle` both go through `write`: apply to a copy, `save` once, swap it in, log, release the lock, then publish `autopilot.changed` for each changed item and call `on_closed` for each item that just became terminal. The hook, `rpc::withdraw_holds`, withdraws that item's holds and closes their cards on a spawned thread, so an item update never waits on the webview. The store lock is never held while calling into `Asks`.

A file that exists but doesn't parse (say, written by a newer Tori) loads as empty and refuses every write to *that* file, so it is never overwritten. A broken `projects.json` still lets queue writes through.

## Interface

- `AutopilotStore::open(dir, publish).on_closed(hook)`, built in `rpc::start` and held by `RpcState` and `TauriBackend`.
- `update(Target, Patch)`: `Target::Id`, or `Target::Key {kind, source, project}`, which matches an open item and creates one when there is none. A retry after a crash finds the item it already made, and a closed item's source opens a fresh one.
- `closed_by_hand(session, held)`: a person closed the tab, so a `running|waiting_on_you` item naming the session goes `failed` with note "closed by hand", unless it has a `pr_url` or a pending hold (`held` is the items `Asks::holds` names), which its merge or its answer closes. Called by the `autopilot_closed_by_hand` command from the tab's real close paths, never from a view unmount, and not when a fork or rewind replaces the tab.
- `state_for_session(session)` (an open item over a closed one) and `sessions()`, for the lock in [[component_autopilot_runner]].
- `set_project(project, ContractPatch)`, `state(observe) -> Snapshot {items, projects}`, `session_ended(id)`, `has(id)`.
- `recent_log(limit)`: the last lines of `log.jsonl`, read backwards from the end in 8 KiB chunks since the log only grows; a fragment or a line that does not parse is skipped. The webview reads it through the `autopilot_log` command, and the whole state through `autopilot_state`.
- The `publish` closure `rpc::start` hands in also emits the Tauri event `autopilot://changed`, and so does the holds one, because the webview is not a hub subscriber ([[gotcha_the_webview_is_not_a_hub_subscriber]]).
- Socket methods: `autopilot.state` (anyone), `autopilot.item.update`, `autopilot.project.set`, `autopilot.hold.resolve` (not workers). Front ends: [[component_tori_cli]] and the MCP tools from the same table rows.

## Related

- [[adr_autopilot_stores_decisions_and_derives_facts]]: why only decisions are stored
- [[adr_autopilot_is_a_session_not_a_state_machine]]: the session this store is the memory of
- [[component_app_socket]]: the rows, `Asks` and the holds it persists
- [[concept_socket_event_vocabulary]]: `autopilot.changed`
- [[component_forge_client]]: `pull_request_states`
- [[component_autopilot_cockpit]]: the UI that reads this
- [[component_autopilot_runner]]: the session this is the memory of
- [[lesson_pure_core_for_global_stores]]: the pure `apply`, `reconcile` and `settle`, tested apart from the files
