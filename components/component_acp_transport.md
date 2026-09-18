---
summary: ACP transport drives up to 30 agents through one module with no per-agent Rust, one OS thread per session on smol
status: current
updated: 2026-09-04
source: "\"Defer permissions to the harness, and grow to four harnesses\" (phases 4, 5, 6 and 8, branch `chat-fix`); crate `agent-client-protocol` 2.0.0, wire protocol v1; switch answers: plan \"Confirm an ACP mode or model switch from the agent's own answer\" (branch `bugfix-260903`, issue 164, commit 1aedc0b)"
---

# ACP transport

**Location:** `src-tauri/src/chat/` (key files: `acp_transport.rs`, `acp.rs`, `acp_sessions.rs`)

Tori's second `AgentTransport`, speaking the Agent Client Protocol to any agent that implements it. Three bundled adapters ride it today (OpenCode, Gemini, Codex) and roughly thirty more are launchable from the catalog, all through this one module with no Rust per agent. It is what makes [[adr_harness_breadth]]'s "a new harness is a TOML file" claim true.

## Responsibilities

- Spawn the agent, handshake, open and load sessions, stream a turn, map every `session/update` onto an existing `ChatEvent`, and park the agent's permission question until the user answers it.
- **It does not add a `ChatEvent` variant.** Four phases and two protocols made demands on the event model and none of them needed one - see [[concept_transport_neutral_event_model]].
- **It does not decide anything the agent can decide.** Permissions, modes and models are the agent's; Tori renders them. See `tori-harness-owns-permissions`.
- **It declines `fs` and `terminal` client capabilities.** Agents do their own I/O. An agent that asks anyway must still be *answered*, or it hangs.
- It does not steer. ACP has no mid-turn delivery, so `steer` returns an error rather than queueing, because a queued turn is indistinguishable upstream from a steer that landed.

## Key files & entry points

- `acp_transport.rs:421` — the connection: `Client::builder().on_receive_notification(..).on_receive_request(..).connect_with(ByteStreams::new(stdin, stdout), ..)`, whose closure holds a **long-lived** `ConnectionTo<Agent>`.
- `acp_transport.rs:74` — `Command`, the channel the sync trait methods feed. `:100` `ConfigOption`, `:177` `Switch`, `:126` `Shared`.
- `acp_transport.rs:497` — `respond_permission`; `:547` `set_model`; `:591` `child_pid`.
- `acp.rs:129`–`:248` — the mapping from a `SessionConfigOption` set to models, modes and effort levels. See [[concept_acp_config_options]].
- `acp.rs:325` — `map_update`; `:443` `file_edits`, which turns a `tool_call` diff block into a `FileEdit` carrying a real before-state.
- `acp_sessions.rs` — the locator store. See [[concept_acp_session_locator]].

## How it is wired, and the three traps it is shaped around

**One dedicated OS thread per session runs `block_on`.** The crate is on the smol stack (`async-io`, `async-process`, `futures-lite`, `blocking`) rather than tokio, 44 new crates in total, so this is the cheaper of the two outcomes: no second global runtime beside Tauri's.

**Tori spawns the child itself and hands the SDK the pipes.** `AcpAgent::from_str("opencode acp")` would have the SDK spawn it, which bypasses `transport::build_command` and therefore `env::augmented_path()` — the same PATH trap `pty.rs` exists for. Spawning it here also keeps the pid, which the ownership registry needs and which the SDK's connect path never hands back.

**A parked responder cannot be answered twice, by ownership rather than by a check.** `Responder::respond(self, ..)` is synchronous and consumes `self`, so a permission question parks in a `Mutex<HashMap<String, Parked>>` holding the responder itself. Answering *is* consuming it.

**The turn id and the permission-request id must not share a counter.** They did in the first draft, so a question asked mid-turn re-stamped every later update with a turn id no turn ever had, splitting one turn into two in the transcript. The turn is held explicitly in `Shared::current_turn` and `a_permission_request_does_not_renumber_the_running_turn` pins it.

## Connections

- Implements the `AgentTransport` trait beside `claude_transport.rs`; the factory in `chat/commands.rs` chooses on `ChatTransport`.
- Reads its per-agent overrides from the adapter TOML — see [[component_agent_adapter_registry]].
- Governed by [[adr_harness_breadth]].
- Publishes its floor through [[concept_harness_capability_tiers]]; the per-agent half arrives at `initialize`.

## Testing

Nine live tests, all `#[ignore]`d, driving real agents: handshake, streaming turn, tool call, permission round trip, session reopen and replay, and one per bundled adapter driven entirely from its own TOML. **They must run `--test-threads=1`**: `acp_sessions::use_dir_for_tests` is a process-global override. The Codex one is flaky against the real model, roughly one deadline expiry in three runs.

The switch-answer path (`switch_events`) is a pure function and is unit tested only: neither measured agent refuses a mode it publishes, so the refusal, mismatch and silent-answer shapes cannot be provoked live.

## What the catalogue work added

- `set_config_option` joined the transport trait, so a control Tori has no bespoke picker for can still be switched ([[concept_generic_config_mirror]]). Claude's arm errors rather than succeeding silently.
- `ChatEvent::ConfigOptions` is emitted behind `SessionStarted`, from `session/update`'s `ConfigOptionUpdate` (previously unhandled) and from every switch answer, always carrying the agent's whole option set.
- `switch_events` reads each `set_config_option` answer: the whole set goes out first (it is how the store confirms an ACP pick, see [[concept_acp_config_options]]), then a mode that did not take is `ModeRefused` for all three shapes (an error, an answer naming another mode, an answer naming no mode), while a model keeps a plain `SessionError`. The `session/set_mode` fallback's error is `ModeRefused` too.
- `initialize_request` and `new_session_request` are `pub` and **shared with the catalogue probe** rather than copied. A probe that handshook with different client capabilities would be measuring an agent Tori never actually runs.

## Related

- [[component_catalog_probe]] — the other caller of this module's handshake
- [[concept_generic_config_mirror]] — what the transport now forwards and re-renders
- [[concept_acp_agent_quirks]] — the measured gap between the spec and each agent, harvested before this was written
- [[concept_acp_config_options]] — how a model, mode or effort switch actually travels
- [[concept_acp_session_locator]] — how a session with no file on disk gets one
- [[component_acp_catalog]] — the launch commands for agents this could drive but has not
- [[concept_transport_neutral_event_model]] — the claim this module was the fourth and fifth test of
- [[gotcha_async_process_command_from_does_not_carry_stdio_settings_across]]
