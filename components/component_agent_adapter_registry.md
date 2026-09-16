---
summary: a third agent is only a TOML file, since single variant enums make an unparseable transcript shape unreachable
status: current
updated: 2026-08-15
source: "Adapter registry, pulse, presence, checkpoints (personal/sway, branch `topbar`); Phase 1; Prove the adapter: opencode + claude hooks (personal/sway, branch `topbar`); Phases 2-3; v0.1 features: status indicators, search, input layer (personal/sway, branch `topbar`); Phase 3; `src-tauri/src/agents.rs`, `ADAPTERS.md`"
---

# Agent adapter registry

**Location:** `src-tauri/src/agents.rs`, `src-tauri/agents/claude.toml`, `src-tauri/src/hooks.rs`, `src/utils/agents.ts`, `ADAPTERS.md`

Claude and pi were hardcoded branches throughout the backend (`Terminal.tsx`'s spawn/resume, `sessions.rs`'s parser dispatch, `session_pattern`'s pgrep templates). This component pulls all of that into a single data-driven registry so a third agent is a TOML file, not a new `if agent == "..."` at five call sites. It is the foundation the rest of this plan's phases (pulse, presence, checkpoints) were deliberately built agent-neutral against. **Schema v1 is now stable**, validated by three adapters with genuinely different transcript conventions: claude/pi (one jsonl file per session) and opencode (every session's messages/parts live as rows in one shared SQLite DB — see `discovery.backend` below).

## One bundled adapter (2026-07-31)

pi and opencode were unbundled (branch `navigation`, phase 8, commit e6d98c2).
**The mechanism is untouched; only its contents shrank.** `build_registry_from`
still loops over bundled adapters and still reads every `*.toml` in
`~/.config/sway/agents/`, and two tests pin exactly that: `claude` is the only
bundled id, and a user TOML naming a fresh id registers *beside* it rather than
replacing it.

`ParserKind` and `Discovery` are now **single-variant enums**, and three
one-armed `match`es (`extract_touched_files`, `parse_transcript_turns`,
`session_prompt_tail`) are what make that load-bearing. They look like no-ops and
are not: adding a variant fails to compile at each site, so a transcript shape
Sway cannot parse is unreachable from a config string. `discovery.backend`
accepts `"file"` only.

`AgentId` on the frontend is an **open alias over `string`**, deliberately not a
union of the ids that ship - see [[lesson_narrowing_a_type_can_entrench_a_bug]].
`agentIdForProgram(program)` maps a spawned binary back to its adapter id
(checking the chat binary too), because a tab records what it *launched* while
every backend probe wants the id.

What pi and opencode taught survives in `ADAPTERS.md` as guidance rather than as
adapters: measure `needs_you` against a real PTY capture (two unrelated failure
modes defeat the join - tools that never gate, and a TUI that never goes quiet),
and a database-backed agent needs a new parser kind *and* a new discovery
backend ([[concept_locator_scheme_for_db_backed_sessions]], kept as the worked
example).

## Responsibilities

- **`AgentAdapter`** (resolved, in-memory): id, label, launch spec (`{id}`/`{file}` placeholders across program/base-args/yolo/resume-args), `discovery` (a `Discovery` enum, `File{dir, filename_regex}` | `Sqlite{db_path}` — see below), parser kind (`claude_jsonl` | `pi_jsonl` | `opencode_sqlite`, a closed Rust enum — parsing logic stays code, only its *selection* is data), running-pattern template, `verified_against` (the agent CLI version this adapter's conventions were captured against, echoed in `ADAPTERS.md`), and capability flags (`needs_you`, `pty_quiet_ms`, `hooks`).
- **`discovery.backend`**: `"file"` (default, claude/pi) walks a session-transcript directory tree matching `filename_pattern`'s named `id` capture. `"sqlite"` (opencode) has no per-session file at all — `db_path` points at one shared DB covering *every* project on the machine; the session id lives in a DB column. Sway opens this DB **strictly read-only**; deleting a session shells out to the agent's own CLI (`opencode session delete <id>`) rather than a raw SQL statement, since the schema's foreign keys aren't cascade-safe without `PRAGMA foreign_keys=ON`.
- **`capabilities.hooks`**: whether a verified hook-driven status mechanism exists for this agent (see [[component_claude_hooks_status]]), overriding the transcript-tail join ([[concept_needs_you_floor]]) as the authoritative working/needs-you source when a hook fires. Not generically TOML-authorable — turning it on for a new agent needs matching Rust code, the same way a new `parser.kind` needs code. Only `claude.toml` sets it.
- **`capabilities.context_window`** (Phase 3): drives [[component_command_palette]]'s sidebar sibling, the per-session context meter. An untagged Rust enum, `ContextWindow::Fixed(u64) | PerModel(HashMap<String, u64>)` — a plain number applies to every model this adapter launches, or a per-model table with a reserved `"default"` key as the fallback (`ContextWindow::resolve`, mirrored on the frontend as `resolveContextWindow`). Additive/optional, no schema version bump. Only `claude.toml` declares one (`default = 200000`, `"claude-sonnet-4-5" = 1000000` for its 1M-token beta window) — `pi`/`opencode` ship without it since there's no adapter-verified figure for them, and the meter simply doesn't render rather than guessing.
- **Loading & merge**: bundled `claude.toml`/`pi.toml`/`opencode.toml` are `include_str!`-embedded (no Tauri resource bundling needed); user files load from `~/.config/sway/agents/*.toml` at startup (not live-watched — restart to pick up changes) and merge bundled-then-user into a process-wide `OnceLock` registry (`agents::registry()`).
- **Override semantics**: a user file whose id matches a built-in **whole-replaces** it. A broken override (missing required fields, bad `schema_version`, an unknown parser kind) **keeps the previous entry and logs loudly** — never a silent disappearance, but also never a silent fallback that masks the error.
- **Validation**: `schema_version = 1` required (unknown versions rejected), required top-level fields checked collectively (all missing fields named in one error, not one-at-a-time), `filename_pattern` must have a named `id` capture (matched via the `regex` crate — already a transitive dependency, so this cost nothing new), parser kind checked against the closed enum, `discovery.backend` checked against `"file" | "sqlite"` with backend-specific required fields (`dir`/`filename_pattern` vs `db_path`).

## Key files & entry points

- `src-tauri/src/agents.rs:57` — the `AgentAdapter` struct; `agents.rs:49` — the `Discovery` enum.
- `src-tauri/src/agents.rs:190` — `load_adapter_str`, raw-TOML → validated adapter.
- `src-tauri/src/agents.rs:272` — user adapter dir (`~/.config/sway/agents`).
- `src-tauri/src/agents.rs:363` — `parser_kind_for`, the lookup other modules call instead of branching on the agent string themselves.
- `src/utils/agents.ts` — the frontend mirror (snake_case fields matching the Rust JSON shape 1:1), a Solid signal cache (`ensureAgentsLoaded`/`agents`/`findAgent`) seeded with a fallback identical to the bundled TOML (must be kept in sync by hand — caught missing the opencode entry in Phase 2 self-review).
- `ADAPTERS.md` — the schema reference, now versioned stable (v1).

## Connections

- Consumed by [[component_session_worklog]] — `sessions.rs`'s parser dispatch, `session_pattern`, and detail/touched/transcript commands now take an `agent_id` and look up behavior via `agents::find`/`parser_kind_for` instead of branching on `"claude" | "pi"` literals; the `Discovery::Sqlite` branch delegates to `opencode.rs` via the locator scheme.
- Consumed by [[concept_needs_you_floor]] — the `needs_you`/`pty_quiet_ms`/`hooks` capability fields gate that join per adapter.
- Consumed by [[component_claude_hooks_status]] — `agent_hook_launch_args`/`session_tail_state` both branch on `AgentAdapter.hooks`.
- Consumed by [[component_turn_checkpoints]] indirectly — checkpoints are agent-agnostic by construction (they observe the working tree, not the transcript), but the prompt-boundary trigger reuses the same per-agent parser dispatch this registry drives.
- `Terminal.tsx`'s spawn/resume/`agentInit` and the split-button's launch/labels read from `findAgent(...)` instead of hardcoded `"claude" | "pi"` branches; `spawnSession`/`focusOrResume` are now `async` to also await `agent_hook_launch_args` before building `init`. The dropdown's curated two-branch shape (offer "switch to claude" / "yolo variants") is **deliberately left as-is**, not generalized to N agents.
- `Toolbar.tsx`'s "Open in Ghostty" resume button was **not** switched to pick `program` from the registry — it still hardcodes `["--resume", sessionId]` (claude's flag shape), so doing so would launch `pi` with claude's resume flag and break pi resume via Ghostty. Left untouched pending a real decision on that button's pi support.

## Schema v3: the `[accounts]` table (2026-08-14)

`home_env`, `login_args`, `logout_args`, `whoami_args`, `whoami_kind`, `supports_isolation`, `home_default`. Only `claude` claims isolation, and `only_a_measured_adapter_claims_account_isolation` asserts that exact list, so adding a table by copy-paste fails until somebody says who measured it. See [[adr_credential_custody]].

**The bug this bump nearly shipped, and the rule that replaced it.** `[chat]` was gated on `raw.schema_version < SCHEMA_VERSION`. That is indistinguishable from "less than the version `[chat]` needs" while only one optional table exists, and wrong the instant a second one lands: bumping to 3 would have rejected the `[chat]` table in **every v2 adapter in the world**, three of the four bundled ones included. Replaced with per-table minimums (`CHAT_MIN_VERSION`, `ACCOUNTS_MIN_VERSION`), which are facts about a table and never move. **A version gate must name the version the feature needs, not the newest version that exists.** Pinned by `a_v2_adapter_keeps_its_chat_table_after_the_v3_bump`.

Two tests were silently invalidated by the bump, both caught by running them rather than by reading: `bad_schema_version_is_rejected` asserted `schema_version = 3` is rejected (true by accident, then false), and now derives `SCHEMA_VERSION + 1` so it cannot rot again; and one matched on the literal string `"schema_version = 2"` that the reworded error no longer contains.

`whoami_args` is refused without a `whoami_kind`, the same shape as the discovery/parser/running triple, because three harnesses answer "are you signed in" in three shapes: Claude's JSON, Codex's exit code, OpenCode's credential count. `home_default` is `#[serde(skip)]`, on the same boundary `discovery` already sits on, so the TS mirror and `bundled.json` are untouched by it.

## Schema v2: the `[chat]` transport table (2026-07-28)

Schema v2 adds an optional `[chat]` table declaring a structured transport: `transport` (a closed Rust enum, so a TOML naming one with no implementation is a build error), `base_args`, `session_id_args`, `resume_args`, `fork_args`, `model_args`, `effort_args`, `mode_args`, `add_dir_args`, plus `[[chat.models]]` / `[[chat.modes]]` / `[[chat.effort]]` tables. An adapter without the table keeps working exactly as v1; only claude declares one today. This is what makes a second harness a module plus a TOML table - see [[concept_transport_neutral_event_model]].

**`[running] pattern` must account for the chat transport's arg order.** The original `claude (--resume|-r) {id}` anchored the flag to the program name, which matched a PTY agent tab and **no chat session at all**, since `chat.base_args` come first. Every chat was invisible to `session_running`. Now `claude ([^ ]+ )*(--resume|-r|--session-id) {id}`. Third-party adapter authors are warned in `ADAPTERS.md`; the trap is [[gotcha_a_pgrep_running_pattern_must_allow_for_the_chat_transports_base_args]].

## Related

- [[component_chat_host]] - the consumer of the `[chat]` table.
- [[concept_needs_you_floor]] — built directly on this registry's capability fields.
- [[concept_locator_scheme_for_db_backed_sessions]] — kept as the worked example of what a DB-backed adapter would cost; the code itself is gone.
- [[lesson_narrowing_a_type_can_entrench_a_bug]] — why `AgentId` stays open.
- [[lesson_a_test_can_pass_because_its_fixture_stopped_parsing]] — found unbundling pi.
- [[component_claude_hooks_status]] — the `hooks` capability's implementation.
- [[gotcha_encoded_claude_dir_name_is_lossy]] — the discovery-dir convention this registry's `Discovery::File` variant encodes.
- [[gotcha_a_toml_key_after_a_table_header_belongs_to_that_table]] — hit writing `opencode.toml`'s `verified_against`.
- [[component_usage_pipeline]] - the `[usage]` table's consumer: which rungs an adapter declares a read path for.
