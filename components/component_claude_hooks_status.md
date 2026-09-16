---
summary: claude hooks under settings give ground truth status for claude sessions, overriding the quiet PTY plus tail guess
status: current
updated: 2026-08-14
source: "Prove the adapter: opencode + claude hooks (personal/sway, branch `topbar`); Phases 1, 3; `src-tauri/src/hooks.rs`"
---

# Claude hooks status

**Location:** `src-tauri/src/hooks.rs`, `src-tauri/src/sessions.rs` (`session_tail_state`), `src/panels/Terminal/Terminal.tsx` (`hookArgs`), `src/panels/LeftSidebar/LeftSidebar.tsx` (archive/delete cleanup)

Replaces the [[concept_needs_you_floor|needs-you floor]]'s quiet-PTY x pending-tool_use *guess* with claude's own ground-truth signal, for claude sessions only. claude's CLI can be told (via `--settings`) to run a shell command on specific lifecycle events; this component injects that config at launch, scoped to Sway-launched sessions, and consumes the resulting status files as authoritative.

## Responsibilities

- **Injection (`agent_hook_launch_args`)**: writes a settings JSON (wiring `UserPromptSubmit`/`PreToolUse`/`Notification`/`Stop` to one shared shell command) to a fixed file, `~/.config/sway/claude-hooks-settings.json`, and returns `["--settings", <path>]` — only for an adapter with `capabilities.hooks = true` (claude today). `--settings <path>` is non-invasive — claude's default `--settings-sources user,project,local` stays active, so this *layers on top of* `~/.claude/settings.json` rather than replacing it; verified byte-identical md5 before/after a real `claude -p` run with the flag injected. `Terminal.tsx`'s `spawnSession`/`focusOrResume` both `await` this and append the result to the launch args before building `init` — this is what scopes it to Sway-launched sessions: an externally-typed `claude` never receives the flag, confirmed empirically (`claude -p` with no `--settings` produces no status file). **A file path, not inline JSON, is load-bearing**: the launch command is typed into the tab's login shell one byte at a time, and a macOS PTY in canonical mode silently truncates a single line beyond the kernel's line-discipline buffer — the first version passed the ~2KB settings blob inline and it landed on an unclosed quote, hanging every claude launch (the typed command was visible but never executed, caught live by the user, not in review). See [[gotcha_a_ptys_canonical_mode_truncates_a_single_long_typed_line]].
- **The status-writer command**: one shell one-liner shared by all four hook entries. Reads the JSON payload on stdin, extracts only `session_id`/`hook_event_name` via `grep -o`/`sed -E` (no jq/node/python dependency — POSIX tools only), and writes `{"event":"<name>","at":<epoch>}` to `~/.config/sway/hooks-status/<session_id>.json`. Deliberately never persists prompt text or tool input to disk. A defensive `case "$sid" in */*|"") sid="";; esac` guard rejects a `session_id` containing `/` before it's concatenated into the destination path (claude's ids are UUIDs, so this should never trip — added during self-review as defense-in-depth for the grep-based, not-a-real-parser extraction).
- **Consumption (`status_for`)**: maps a recognized event to a `TailState` — `Notification` (claude's own "I need you" signal, a permission prompt or an idle nudge) → `blocked-candidate`; `UserPromptSubmit`/`PreToolUse` → `working`; `Stop` → `done`. An unrecognized event, or no file at all, yields `None` — the caller (`session_tail_state`) falls back to the transcript-tail join, so a missing/stale/unexpected signal degrades to the pre-existing behavior rather than asserting a status it can't back up.
- **Cleanup**: `hooks_status_prune(session_id)` (a bare `remove_file`, harmless no-op for a non-hook-tracked id) is called from the frontend at the same two call sites as `checkpoint_prune` — archive and delete. `prune_stale` runs once at app startup (`lib.rs`'s `.setup()`): a status file naming a session that no longer exists, or one whose `at` predates that session's own last transcript activity (the hook stopped firing — a crash, or a resume that dropped `--settings`), is removed so it can't pin a dot at a stale status. Cheap no-op when `hooks-status/` is empty/missing — never forces the session-index walk needlessly.

## Key files & entry points

- `src-tauri/src/hooks.rs:88` — `prune_stale`.
- `src-tauri/src/hooks.rs:126` — `status_writer_command`, the shared shell one-liner.
- `src-tauri/src/hooks.rs:144` — `claude_settings_json`.
- `src-tauri/src/hooks.rs:163` — `agent_hook_launch_args` (`#[tauri::command]`).
- `src-tauri/src/sessions.rs:1413` — `session_tail_state`'s hooks-first branch.
- `src-tauri/src/lib.rs` — `mod hooks;`, the `.setup()` startup sweep, invoke-handler registrations.

## Not the chat capture hook (2026-08-14)

There are now **two** `--settings` injections into claude and they are separate
mechanisms with separate lifetimes. This one is the older: it wires four
lifecycle events to a status-writer for **terminal** sessions, and it is
untouched by the chat work. The other is
[[concept_pretooluse_capture_hook]], which a chat session spawns with, matched to
the write tools only, and which exists to capture before-states.

The distinction became worth stating when the chat one **stopped deciding
anything**. Both write JSON to stdout and both are Sway's; only the chat one is
in claude's permission chain, and it now emits no `permissionDecision` at all so
the harness keeps the question. A reader who conflates them will look for a
permission story in `hooks.rs`, where there has never been one.

## Connections

- Gated by [[component_agent_adapter_registry]]'s `AgentAdapter.hooks` capability — `agent_hook_launch_args` and `session_tail_state` both check it before doing anything. Of the four bundled adapters, **claude is still the only `hooks = true`**; codex, gemini and opencode all declare false, and pi is no longer bundled.
- Overrides [[concept_needs_you_floor]]'s tail join for claude specifically. Every other bundled adapter stays on the tail join, and the three ACP ones also cap at working — see that page's `needs_you` note.
- `Terminal.tsx`'s `spawnSession`/`focusOrResume` became `async` (previously `spawnSession` was sync) to await the injected args before building `init`.

## Related

- [[concept_needs_you_floor]] — the join this overrides.
- [[component_agent_adapter_registry]] — the capability flag this reads.
- [[concept_pretooluse_capture_hook]] — the other `--settings` injection, which is not this one.
