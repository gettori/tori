---
summary: spawns one long lived harness child per session and renders its own permission and question prompts, deciding nothing
status: current
updated: 2026-09-25
source: src-tauri/src/chat/{mod,model,transport,claude,claude_transport,acp_transport,acp,acp_sessions,ownership,host,commands,approval,snapshot,pacing,history,mcp}.rs; gettori/tori#199 commits 25551855, 3a04d580, 52615c71; gettori/tori#205 commits eff34ef6, 4b309f03; waiting registry from gettori/tori#207, commits 1b7e479d, 4cd91a8f
---

# Chat host (Rust)

**Location:** `src-tauri/src/chat/` (key files: `mod.rs`, `model.rs`, `transport.rs`, `claude.rs`, `claude_transport.rs`, `acp_transport.rs`, `acp.rs`, `acp_sessions.rs`, `ownership.rs`, `host.rs`, `commands.rs`, `approval.rs`, `snapshot.rs`, `pacing.rs`, `history.rs`, `mcp.rs`)

The backend half of the chat surface: it spawns a harness as a long-lived child, normalizes its output into [[concept_transport_neutral_event_model]], owns session identity, and **renders the harness's own permission question rather than asking one of its own**.

**Two transports now, not one.** `claude_transport.rs` drives `claude` over `stream-json`; [[component_acp_transport]] drives every ACP agent. The factory in `commands.rs` chooses on `ChatTransport`, and `host.rs` is unchanged by the second one.

## Responsibilities

- Spawn, feed and reap one child process per chat session; hold stdin open for the life of the session.
- Map each harness's wire frames to `ChatEvent` and accept `ChatCommand` back.
- Own session identity: refuse a second driver for an id already claimed.
- Route a permission question to whichever transport raised it, own the deadline for answering it, and capture before-states. **It decides no tool call.** `rules.rs` is deleted, and the plumbing every owned store shares moved out to `src-tauri/src/owned_state.rs`.
- Serve transcript backfill and MCP config.
- **Not** the UI's business: nothing below `commands.rs` mentions Tauri, which is what lets the whole lifecycle be tested headlessly.

## Key files & entry points

Layering is one-directional and documented in `mod.rs`:

`model` → `transport` → {`claude`, `claude_transport`, `ownership`} → `host` → `commands`

- `model.rs` - the neutral `ChatEvent` / `ChatCommand` enums and their exhaustiveness guards.
- `claude.rs` - `ClaudeMapper`, the only module that knows Claude's frame names. Stateful because `system/init` re-emits every turn.
- `transport.rs` / `claude_transport.rs` - the harness-neutral seam and its one implementation. `StartSpec` carries an env map from day one so multi-account later touches no call sites.
- `ownership.rs` - the claim table plus `reap_on_startup` for orphans.
- `host.rs` - the process map and the swappable emit sink.
- `commands.rs` - the Tauri surface; thin by design, every command resolves an adapter, checks ownership, and hands off.
- `mcp.rs` - Claude's MCP config across three scopes ([[concept_mcp_config_scopes]]).

## Notable decisions

- **The sink is an injected closure, not a `Channel`.** `pty.rs` uses `Arc<Mutex<Option<Channel>>>`, but a transport referencing `Channel` could only be tested inside a Tauri app. `Emit = Box<dyn Fn(ChatEvent) + Send + Sync>` behind the same swappable slot preserves the rewire semantics of [[gotcha_tauri_channel_pty_output_needs_a_swappable_sink]] and is why live-process tests exist at all. `chat_spawn` wraps the real `Channel` at the command boundary and nowhere else.
- **Death handling is one path.** The host wraps every caller's emit closure; a fatal event flowing through that wrapper drops the map entry and releases the claim, however the child died.
- **One long-lived child per session, settled by measurement.** Early probes exiting after one turn were caused by closing stdin, not by the CLI.
- **The harness binary is resolved at spawn time** from `settings.harness.path`, so changing it in Settings applies to the next session without a restart.
- **No blanket `allow(dead_code)`.** Phase 1's was removed as promised and immediately surfaced three genuinely unused items. Keep it gone.

## Steer, and the claims file's durability (2026-07-29)

**`steer` is a transport verb of its own**, not a second caller of `send`.
`ClaudeTransport::send` flushes and `take()`s a queued mode or model switch
before writing the turn frame, so reusing it for a mid-turn message would apply a
switch the UI had promised would wait for the next turn, and consume it. So
`AgentTransport` grew `steer`, `ChatCommand` grew `Steer`, and `chat_steer` sits
beside `chat_send`, writing the identical `user` frame and nothing else. See
[[concept_mid_turn_steer]].

**The command side of neutrality gained its own check.** An event Tori cannot map
is a gap in the model; a verb a harness cannot serve is normal and permanent.
`neutrality_check.rs` now carries `Support` plus exhaustive `codex_support` /
`acp_support`, pinning that send, interrupt and close stay the shared floor while
`Steer` is refusable, since a trait every verb may refuse describes nothing. See
[[concept_harness_capability_tiers]].

**`ownership.rs` writes its claims file atomically, and did not before.**
`save_claims_to` was a bare `std::fs::write`, which truncates in place, while
every sibling store already used `rules::write_atomically` (write temp, fsync
temp, `rename`, fsync directory). Both readers here end in `unwrap_or_default()`,
so a torn file read back as *no claims at all* and every live session would have
looked unowned to the next opener. The module header now also states its scope
honestly: nothing here addresses **two live Toris**, which race the file with no
cross-process lock and drop the loser's claim by last-writer-wins. See
[[lesson_a_cut_settles_only_what_was_measured]] and
[[gotcha_a_truncating_write_under_a_lenient_reader_loses_data_silently]].

## What a session waits on (2026-09-25)

`wrap` passes every live event through `track_waiting`, which keeps a per session list of the native questions and permissions not yet answered, each with the event that raised it. An entry leaves on its call's `ToolCallCompleted`, on an answer from the tab or the socket (`answer_permission`, `answer_question` and `settle` all forget it), and on `TurnCompleted`, which keeps only a subagent's. `session.question` and `session.permission` carry the host's request id, so the socket can answer by it.

- `waiting()` feeds `session.pending`; `settle(session, id, answers)` is `session.answer`'s way in, and an id not on the list errors "already answered or gone".
- **A view that attaches after the question was asked gets no answerable card from history**: the transcript has the question but not the request id. `chat_waiting` returns the raising events, and `ChatView` replays them after its backfill, so the card it draws can be answered.

## A question is not a permission, and the exits are not symmetric (2026-08-22)

`AskUserQuestion` arrives on the permission wire and leaves as its own thing: `ChatEvent::QuestionRequest` in, `ChatCommand::RespondQuestion` back, `respond_question` on `AgentTransport` carrying the same `Ok(false)` two-route contract `respond_permission` documents. The ACP arm refuses with an `Err` rather than a silent `Ok(true)`, because `elicitation/create` is the wire form that would arrive and it is behind a cargo feature that stays off. See [[concept_inline_agent_question]] and [[adr_askuserquestion_answer_channel]].

Three things this forced in `claude_transport.rs`:

- **`arm_auto_deny` became `park(shared, id, kind, after: Option<Duration>)`.** A permission passes `Some(110s)`; a question passes `None` and no thread is spawned, so there is no timer that could expire. That also made the claim testable at 40ms instead of an untestable 110s wait.
- **`Shared::pending` learned what it is holding**, from `HashSet<String>` to `HashMap<String, Parked>`. Tab close and session end deny everything, but an **interrupt withdraws only questions**: a permission still has a deadline that will settle it, a question has none, and the interrupt is the only thing between an abandoned turn and a child blocked for the life of the process.
- **`parked_questions` holds each outstanding form** so the answer can quote the question and echo its preview. It leaked at EOF while a comment beside the cleanup claimed every per-request map was cleared; writing the "no remembered form" test is what surfaced it.

`chat_answer_question` returns the routing bool where `chat_respond_permission` returns `()`. Not symmetry for its own sake: a stale Allow click is routine and an error toast for it would report a fault where there is only a dead button, but a form filled in after its question was cancelled has to be able to say the answer went nowhere rather than clear itself as though the agent had read it.

## History gained a second reader (2026-09-04)

`history.rs` used to read one file. A Claude session that launches a subagent writes more beside it, and reading them is what makes a lane survive a reopen. See [[concept_subagent_lanes]].

- **The sidecars are found from the transcript's own path**, not rebuilt from the session id: `<path minus .jsonl>/subagents/`, which resolves for both stem shapes `transcript_path` accepts. An ACP session never reaches it, because `transcript_path` answers `None` first.
- **One `push_block` serves both paths.** Live and replay agreeing is the whole point of mapping history to events at all, and two copies of "a `tool_call` becomes a `ToolCallStarted`" would be two places to drift. The parent loop keeps only what is its own: user messages, compaction, and the subagent outcome block.
- **A subagent's turns are not turns.** Its conversation is spliced into the turn holding the `Agent` call that launched it, wherever that call is, recursively, with a cycle guard on the agent id. Turn headers the live run never made would offer "rewind to here" on a boundary nobody typed.
- **`meta.json` records no prompt**, so it is read off the subagent's own first message and then stripped from its rows: nothing can talk to a subagent, so a user row in its lane could only ever be that prompt again.
- **The outcome is summarised at parse time**, the same treatment and for the same reason as `tool_summary`: an `Agent` result quotes the subagent's whole reply back, and none of it survives `SubagentOutcome`.
- **`resolvedModel` was measured and dropped.** No live `task_*` frame carries a model, so a lane field only replay could fill would be a divergence invented by the code meant to close them.

## A background session will refuse some tools, and this is not where (2026-09-23)

Not built: gettori/tori#203 plans a Tori level refusal for outward actions from a session flagged `background`. It lives on the protocol's own outward methods and not in `map_control_request`, so "it decides no tool call" stays true of every session a person opened. See [[adr_a_background_session_needs_a_tori_gate]].

## Lifecycle on the app socket (2026-09-23)

`ChatHost` publishes the chat half of [[concept_socket_event_vocabulary]] on the app socket ([[component_app_socket]]). The publisher is a `Publish` closure, `(session id, event)`, set once in `lib.rs` setup through `set_publisher`. A host with none (every test that doesn't set one) publishes nothing.

- **`session.started` fires before `transport.start`, and `session.ended` from three paths:** the fatal branch of `wrap` and a start that returns `Err` (`died`), and `close(id, reason)`. `chat_close` takes the reason from the webview: the sidebar delete says `killed`, a tab unmount and app exit `closed`. A rewire publishes nothing.
- **`Lifecycle` resolves the session's `Place` once, at start**, and every later event reuses it, so `wrap` never reads the config.
- **`Lifecycle::observe` in `wrap` publishes turns, questions and permissions**, but nothing before the session's `SessionStarted`: see [[gotcha_an_acp_load_hands_history_back_through_the_live_sink]]. A rewire that asks for a replay re-arms that gate.
- **Turn origin.** `deliver(id, blocks, mid_turn, by)` records `by` before a send, never for a steer into a running turn; the next `TurnStarted` consumes it, `TurnCompleted` clears it. `ChatHost::publish` lets `ask.create` send `session.question` in the session's envelope.
- **Both are gated on `Lifecycle`'s announced set, not on the session map.** The map can't order them. See [[gotcha_a_chat_childs_fatal_event_can_arrive_before_spawn_inserts_its_entry]].
- `Entry` now keeps the spawn `cwd`, and `live_sessions()` hands `(id, cwd)` to `sessions.list`. `Registry` gained `agent_of` and `held_here`.
- `chat_history`'s body moved into `read_history(session_id, &HistorySource, agent, up_to)`, shared with `session.tail`. The whole read now runs through `exec::blocking`, where before only the ACP log half did.

## Spawned from Rust, and detached (2026-09-24)

- **`spawn_session(host, SpawnRequest, emit)`** is `chat_spawn`'s body, taking any `Emit`; `chat_spawn` is a thin wrapper. [[component_autopilot_runner]] calls it with its own sink. `SpawnRequest` gained `spawner`: on a resume of a background session it re-marks the worker under its spawner, resolved through the runner's alias.
- **`chat_detach(session, tab)`** swaps the sink to a no-op and hides the session, instead of closing it, but only when that tab still drives the session: a keyed remount has already rewired it. The `wrap` stays, so a death still ends the session and publishes. `ChatView` takes a `detach` prop to call it on unmount ([[component_autopilot_cockpit]]).
- A view must not attach while Rust is still spawning: [[gotcha_a_chat_view_on_a_rust_spawned_session_must_wait_for_its_first_turn]].

## Related

- [[component_app_socket]] - where the lifecycle events go, and the second reader of `read_history`
- [[gotcha_a_queued_note_is_the_first_block_of_the_users_message]] - why `wrap` splits notes off a user message
- [[concept_topic_home_chat_note]] - the note queued at spawn for a Topic home chat
- [[concept_socket_event_vocabulary]] - the events `Lifecycle` publishes
- [[gotcha_an_acp_load_hands_history_back_through_the_live_sink]] - why `observe` waits for `SessionStarted`
- [[gotcha_a_turn_sent_from_outside_the_panel_draws_no_user_bubble]] - why `deliver` draws the user bubble itself
- [[gotcha_a_chat_childs_fatal_event_can_arrive_before_spawn_inserts_its_entry]] - why lifecycle is gated on its own set
- [[component_chat_panel]] - the Solid half this feeds
- [[concept_subagent_lanes]] - the lane model these events and files feed
- [[component_agent_adapter_registry]] - where the `[chat]` transport table lives
- [[component_pty_host]] - the older per-session process host whose concurrency shape this copies
- [[concept_inline_agent_question]] - the question that rides the permission wire and leaves as its own event
- [[concept_pretooluse_capture_hook]] · [[concept_transport_neutral_event_model]] · [[component_acp_transport]] · [[concept_harness_capability_tiers]]
- [[adr_a_background_session_needs_a_tori_gate]] - the planned refusal for background sessions, which does not live in this module
- [[gotcha_a_remounted_chat_view_on_a_shared_tab_id_is_detached_by_the_old_one]] - `chat_detach` is keyed by tab id
