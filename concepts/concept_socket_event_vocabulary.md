---
summary: every socket event shares one envelope; each kind is published where Rust already sees it, pushed from the webview only where it owns the state
status: current
updated: 2026-09-23
source: gettori/tori#199 on branch orchestrator; commits 25551855, 3a04d580, 52615c71; src-tauri/src/rpc/{events,states,quotas,mod}.rs; src-tauri/src/chat/host.rs (Lifecycle); src-tauri/src/forge/status.rs (Published); src/utils/sessionActivity.ts (socketReports)
---

# Socket event vocabulary

What the app socket ([[component_app_socket]]) says happened, for the watcher, the phone and `tori events`. Every session event is `{kind, id, project, folder, ts}` plus fields of its own, and goes on both `sessions` and `session:<id>`. Account events go on `accounts`. Nothing is computed twice: each kind is published at the one place Tori already notices it.

## How it works

| kind | fields | published from | covers |
|---|---|---|---|
| `session.started` | `agent` (chat) | chat: `Lifecycle::started`; PTY: `SessionStates::replace` on a new `source: pty` id | both |
| `session.ended` | `reason`: `closed`, `killed`, `died` (chat only) | chat: `Lifecycle::ended`; PTY: `replace` once the tab's PTY is gone | both |
| `session.state` | `state` | `replace`, every move | both |
| `session.needs_you` | | `replace`, rising edge into `needs_you` | both |
| `session.turn_started` | `turn_id`, `by` | `Lifecycle::observe` in `ChatHost::wrap` | chat |
| `session.turn_ended` | `turn_id`, `outcome` | same | chat |
| `session.question` | `tool_use_id` or `ask_id`, `questions` | `observe` on `QuestionRequest`; `ask.create` after its card shows | chat |
| `session.permission` | `tool_use_id`, `tool_name`, `detail` | `observe` on `PermissionRequest` | chat |
| `session.checkpoint` | `turn`, `prompt_ts` | `checkpoint_snapshot_body`, only after `update-ref` | both |
| `session.pr` | `branch`, `ids`, `pull_request`, `checks`, `review` (no single `id`) | `forge_unit_statuses` through `status::moved_since_published` | branch |
| `account.quota` | `agent`, `account`, `windows` | `rpc_quota`, pushed by `recordReadings` | account |

- **`by`** is `"user"`, `{"session": id}`, `{"tab": id}`, `"local"` or `"agent"`. `deliver` records it before a send, only when the delivery starts a turn; the next `TurnStarted` consumes it and `TurnCompleted` clears it, so a steer into a running turn is never credited to the next one.
- **`detail`** is one line from the tool input (command, file path, path, url or pattern, 200 chars), never the input: a Write carries the whole file.
- **Place is resolved once per session.** `Place::of` reads the config and lists the discovery root, so `Lifecycle` resolves it at start and `SessionStates` caches it per id. Folders are compared with `events::same_folder`, never as strings ([[concept_one_directory_two_spellings]]).
- **Modules with no Tauri state** reach the hub through `rpc::publish_checkpoint` and `rpc::publish_pr`, which do nothing before the socket is up.

## Why it is this way

- **Chat gets everything, a PTY tab part of it.** A fresh PTY tab has no session id in Rust, a terminal question cannot be told from a permission prompt, turn timing there is poll bound, and a steer is indistinguishable from typing. #212 builds the tab to session binding that would close this.
- **Nothing before `SessionStarted`.** An ACP load or a replaying rewire hands the conversation back through the live sink first ([[gotcha_an_acp_load_hands_history_back_through_the_live_sink]]).
- **Absence from the webview's list is not an end.** A reload restores tabs per workspace on first visit, so `replace` keeps an absent session until its chat child or PTY tab is really gone ([[lesson_absence_from_a_whole_list_push_is_not_an_end]]).
- **A branch's first sighting only seeds.** Otherwise launch sends one `session.pr` per branch. The last-published map is apart from the forge TTL cache, so an expiry or `invalidate_repo` never reads as a change. A branch checked out nowhere sends empty `ids`, since the project folder's sessions are on another branch.
- **`needs_you` means the agent is blocked.** The sidebar dot also lights for forge attention; `socketReports` leaves that out because `session.pr` already carries it.
- **Events carry no id.** A client on both `sessions` and `session:<id>` sees each twice, and should subscribe to one.

## Related

- [[component_app_socket]] - the hub, `SessionStates` and the publish helpers
- [[component_chat_host]] - `Lifecycle`, where chat events are noticed
- [[adr_socket_asks_the_webview_until_rust_owns_state]] - why quota and state are pushed rather than asked
- [[adr_one_protocol_several_fronts]] - why every event goes on the one app level socket
- [[component_tori_cli]] - `tori events`, the first subscriber
