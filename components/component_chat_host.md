---
summary: spawns one long lived harness child per session and renders its own permission and question prompts, deciding nothing
status: current
updated: 2026-09-04
source: src-tauri/src/chat/{mod,model,transport,claude,claude_transport,acp_transport,acp,acp_sessions,ownership,host,commands,approval,snapshot,pacing,history,mcp}.rs
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

**The command side of neutrality gained its own check.** An event Sway cannot map
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
honestly: nothing here addresses **two live Sways**, which race the file with no
cross-process lock and drop the loser's claim by last-writer-wins. See
[[lesson_a_cut_settles_only_what_was_measured]] and
[[gotcha_a_truncating_write_under_a_lenient_reader_loses_data_silently]].

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

## Related

- [[component_chat_panel]] - the Solid half this feeds
- [[concept_subagent_lanes]] - the lane model these events and files feed
- [[component_agent_adapter_registry]] - where the `[chat]` transport table lives
- [[component_pty_host]] - the older per-session process host whose concurrency shape this copies
- [[concept_inline_agent_question]] - the question that rides the permission wire and leaves as its own event
- [[concept_pretooluse_capture_hook]] · [[concept_transport_neutral_event_model]] · [[component_acp_transport]] · [[concept_harness_capability_tiers]]
