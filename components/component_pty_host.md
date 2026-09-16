---
summary: one Rust PTY per session streams raw bytes over a swappable per session Channel, and pty commands stay sync by design
status: current
updated: 2026-08-20
source: Sway build plan, commits 3c2cde1 (spike), ed8d189 (multi-session); CM6 migration, commits 0221967 (addons/WebGL), 7dad6fa (Channel transport), 5c8c6d7 (clickable paths), 3813946 (drag-to-`@path`); Per-workspace terminal sessions, shell-hosted agents, and plain shell tabs (branch `topbar`), commits fe02de4 (shell hosting), 3e8acd6 (live-tab surface); Worktree and tab switching at native speed (branch `unified-tab-bar`), phase 5 chunk coalescing (commit 565dbf9), phase 2 concurrency class (commit d8714d0)
---

# PTY host

**Location:** `src-tauri/src/pty.rs` (frontend: `src/panels/Terminal/TerminalView.tsx`, `src/panels/Terminal/Terminal.tsx`)

The Rust PTY host runs a login shell (and, inside it, the Claude/pi TUI) in a pseudo-terminal and streams its raw bytes to xterm.js in the frontend. It supports multiple concurrent sessions keyed by a string id, so several shells/agents can be open at once and switched instantly as tabs. See [[concept_shell_hosted_tabs]] for *why* every tab is a shell and [[concept_workspace_tab_grouping]] for how tabs are grouped and shown.

## Responsibilities

- Spawn one session per id via `portable-pty`. The **`kind`** param decides what runs:
  - `"command"` → spawn `program`+`args` directly (clone/bootstrap `git`/`sh`), with `env::augmented_path` set, so a failure leaves a visible dead tab.
  - `"shell"` / `"agent"` → spawn the user's **login+interactive shell** (`env::login_shell()` → `$SHELL` or `/bin/zsh`, run `-l -i`); no explicit PATH, since `-l` re-sources the profile and the shell owns PATH. An **agent** tab additionally seeds an `init` command (e.g. `claude --resume <id>\n`).
- Deliver `init` **backend-once** (never from the frontend, which re-subscribes on every remount): a shared `Arc<Mutex<bool>>` (`initialized`) guards `deliver_init`, called from **both** the reader thread's first output chunk **and** a fallback timer (`INIT_TIMEOUT_MS = 1000`ms) — whichever fires first wins. The re-subscribe fast-path returns before any thread/init runs, so a remount can never re-inject. Readiness is a heuristic, not a shell-integration handshake; tty input buffering holds the typed command until the shell reaches its prompt, so an early timer fire is harmless.
- Stream output over a **per-session `tauri::ipc::Channel<InvokeResponseBody>`** as raw bytes (`InvokeResponseBody::Raw`, no base64, no global broadcast). The session holds a swappable `Arc<Mutex<Option<Channel>>>` **sink** the reader thread sends to, so an idempotent re-`pty_spawn` (a remount) rewires the new channel instead of going blank. Exit stays the low-volume global `pty://exit` event.
- Accept input (`pty_write`), resize (`pty_resize`), and teardown (`pty_kill`, which SIGKILLs the child and drops the map entry). The writer is a shared `Arc<Mutex<Box<dyn Write>>>` (`SharedWriter`) so `pty_write` and the two init threads share it.
- Does NOT parse or interpret the TUI; it is a byte pipe. It does NOT persist sessions (that is the agent's jsonl).

## Key files & entry points

- `src-tauri/src/pty.rs` — `pty_spawn(... kind, init, on_output: Channel)` (idempotent per id; swaps the sink on re-spawn), `deliver_init`, `pty_write`, `pty_resize`, `pty_kill`.
- `src-tauri/src/env.rs` — `login_shell()` (resolve `$SHELL`, zsh fallback) and `augmented_path()` (command tabs only).
- `src/panels/Terminal/TerminalView.tsx` — one xterm bound to one PTY id; passes `kind`+`init` to `pty_spawn`; loads the web-links/search/unicode11/clipboard/serialize addons + the WebGL renderer (DOM fallback on GL context loss); a `Channel` receives output; a `registerLinkProvider` turns `file:line:col` into editor opens; a drop handler inserts a dragged file as `@relpath`. Prints `[process exited]` for **command** tabs only.
- `src/panels/Terminal/Terminal.tsx` — the tab model (`kind`, `workspace`, soft `sessionId`, `init`), per-workspace grouping, and the `kind`-branched `pty://exit` split. See [[concept_workspace_tab_grouping]].

## Connections

- Realises [[concept_shell_hosted_tabs]] — the login-shell hosting + backend-once `init` are this component's mechanism.
- Grouped/shown by [[concept_workspace_tab_grouping]] — the frontend tab model on top of these sessions.
- Serves [[concept_filesystem_source_of_truth]] — turns a discovered session id into a running terminal.
- Fed by [[component_session_scanner]] — the session id and cwd come from the scan.
- Glues to [[component_cm6_editor]] — clickable paths emit `OPEN_IN_EDITOR`; dropped tree rows/tabs become `@relpath` (shared `src/utils/events.ts` contract).
- Command tabs spawn with `env::augmented_path` (shared with [[component_lsp_host]]); shell/agent tabs let the login shell own PATH.
- Terminal tabs are rendered by the shared [[component_overflow_tab_bar]]; its identity-preserving reorder keeps running PTYs from being torn down.
- Governed by [[adr_stack_choice]] (Tauri + `portable-pty`) and [[adr_cm6_editor]] (same-origin glue + Channel transport).

## Related

- [[gotcha_gui_launched_processes_inherit_a_minimal_path]] — why command tabs still set the augmented PATH.
- [[gotcha_tauri_channel_pty_output_needs_a_swappable_sink]] — why the sink is swappable.
- [[gotcha_a_command_seeded_into_a_shell_is_re_parsed_quote_its_args]] — why an agent tab's `init` args are shell-quoted.

## Chunk coalescing

`coalesce()` sits between the reader thread and the output channel, with a
**16ms / 64KB window per session**. A chunk goes out on arrival whenever the
last send is older than the window, so an echoed keystroke pays nothing; only a
producer already streaming waits, and only until the window closes or the
buffer fills. The reader thread keeps the init-delivery and activity work,
because both are about *when* a byte arrived and holding them would delay the
needs-you pulse (see [[concept_needs_you_floor]]).

`pty://exit` had to start waiting for the coalescer. A command tab prints
"[process exited]" on that event, so without joining the coalescer thread after
dropping the sender, the exit line can overtake the last bytes the process
wrote.

## The PTY family stays sync on the IPC thread, deliberately

When the backend sweep moved every blocking command off the IPC thread, the
whole `pty` family stayed sync **by design**, and this is worth not "fixing":
`pty_write` byte ordering is IPC arrival ordering, and `pty_spawn`'s
check-then-insert is only safe single-threaded (a concurrent remount would
double-spawn the shell). See [[adr_no_sync_ipc_commands]] and
[[lesson_the_ipc_thread_was_also_the_lock]].

## Related

- [[concept_webgl_context_lru]] - caps the GL contexts these terminals hold
- [[adr_no_sync_ipc_commands]] - why this component is the exception to the rule
