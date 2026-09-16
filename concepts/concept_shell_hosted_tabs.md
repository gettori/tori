---
summary: every terminal tab is really a login shell seeded once by the backend, so exiting the agent drops to a live prompt
status: current
updated: 2026-09-06
source: "Per-workspace terminal sessions, shell-hosted agents, and plain shell tabs (personal/sway, branch `topbar`); commits fe02de4 (backend + tab model), 25ea740 (+ Terminal button); fourth kind from Editor Wave 6: the IDE surface (branch `wave-6`), Phase 14, issue #56, commit 44d8c99; `src-tauri/src/pty.rs`, `src-tauri/src/env.rs`, `src/panels/Terminal/Terminal.tsx`, `src/panels/Terminal/TerminalView.tsx`; command tabs joined the login-shell model in plan \"Standalone terminals: Sway's own commands as tabs in a Shells workspace\" (branch `standalone-terminals`, issue #166), Phase 1, commit `aadacd3`, _2026-09-06_"
---

# Shell-hosted agent tabs

**Every terminal tab is a login shell.** An agent tab is just that shell seeded with the agent command; a plain shell tab is the same shell left unseeded. This replaces the old model where the PTY spawned the agent directly, so agent-exit killed the tab.

## The four tab kinds

`OpenTerm.kind` (and the `kind` param of `pty_spawn`) is one of:

- **`agent`** — a login shell seeded with an `init` command line (`claude --resume <id>\n`, `pi --session <file>\n`, or a fresh `claude\n`). Exiting the agent (for claude: ctrl+c twice / ctrl+d / `/exit`, since a single ctrl+c is "interrupt") drops to a **live shell prompt**, where you can `ls`, re-run the agent, etc.
- **`shell`** — the same login shell with **no** `init`; a plain terminal (the `+ Terminal` button). Opened in the selected branch-unit folder.
- **`command`** — a clone, bootstrap, install or sign-in. *(2026-09-06)* It is a login shell too now, seeded with ` sh '<runner path>'`, so Ctrl-C leaves the user at a live prompt instead of killing the tab. That costs the PTY's exit code as the command's verdict, which is why the command reports its own on OSC 8791; see [[adr_command_exit_by_runner_osc]]. These tabs live in the `shells:` workspace, not a branch unit ([[component_shells]]).
- **`task`** *(2026-08-05)* — a project task (an npm script, a make target, a just recipe) seeded through the same `init` seam as `agent`. It is **its own kind rather than a `shell` carrying an `init`** for one reason: `tabPersist` restores shell tabs and does not store `init`, so a task tab would come back on relaunch as a bare shell wearing the task's name. `PersistedKind` already excludes `command` because re-running a clone on relaunch would be destructive, and a distinct kind inherits that exclusion. Nothing else branches on it. *(2026-09-06: `pty.rs` still branches on `command`, but only to write that tab a runner script; every kind gets the login shell now. `LeftSidebar`'s live-work count no longer excludes `command` either, since a running clone is a real thing to warn about.)* See [[component_task_runner]].

## Why `init` is a backend-once concern

`pty_spawn` is idempotent: a remount creates a fresh frontend `Channel` and re-subscribes to the still-running shell (see [[component_pty_host]], [[gotcha_tauri_channel_pty_output_needs_a_swappable_sink]]). So **anything that must happen once per process belongs in the backend**, never in a frontend per-mount callback — a frontend seed would re-fire on every re-subscribe and re-type the command. The backend delivers `init` exactly once via a shared `initialized` flag, triggered by the reader's first output chunk **or** a 1s fallback timer (whichever first). It is a **heuristic readiness guess, not a shell-integration handshake**; tty input buffering holds the typed line until the shell reaches its prompt, so it is robust even on a silent or slow rc.

**The corollary, learned when tasks arrived:** because the seam fires once, a tab can never run a *second* command. Re-running means a new tab, and the run ordinal therefore belongs in the tab id. Kill-and-respawn under the same id loses to a race, since `closeId` fires `pty_kill` asynchronously while the fresh mount's `pty_spawn` re-subscribes to a session still in `PtyState`. See [[gotcha_pty_spawns_init_fires_once_so_a_re_run_needs_a_new_tab_id]].

## The `kind`-branched exit split

Two `pty://exit` listeners split by kind:

*(2026-09-06: no longer split. `Terminal.tsx` owns the only `pty://exit` listener and removes any tab whose shell exits, command tabs included, because a command tab's shell now outlives its command and its end really is the tab's end. `TerminalView`'s `[process exited]` line for command tabs is gone; it had become false. A command's own outcome arrives separately, on OSC 8791.)*

Crucially, **agent-exit *within* a live shell emits no event** — only the shell's own exit does. So dropping from claude to the shell is silent (the tab stays); typing `exit` in the shell closes the tab. Detecting agent-exit-within-shell as a status signal is out of scope (`session_running`/pgrep still works for resumed agents).

## PATH ownership

Every tab runs a **login** shell (`-l`), which re-sources the user's profile and thus owns PATH itself, so `claude`/`pi` resolve exactly as they do in a real terminal. *(2026-09-06: command tabs used to be the exception and needed `env::augmented_path`, because no shell ran to set PATH; now that they are shell-hosted too, `augmented_path` is no longer used in `pty.rs` at all. The guessing it did is described in [[gotcha_gui_launched_processes_inherit_a_minimal_path]] and measured properly by [[concept_login_shell_path_capture]].)*

## Connections

- Implemented by [[component_pty_host]] (the Rust `kind`/`init`/`SharedWriter` mechanics).
- The tab model on top (grouping, identity, resume) is [[concept_workspace_tab_grouping]].
- Command tabs group under the synthetic `shells:` key; the surface is [[component_shells]].
- Identity/anchoring of sessions is [[concept_folder_anchored_sessions]].
- [[gotcha_a_command_seeded_into_a_shell_is_re_parsed_quote_its_args]] — the `init` args are shell-quoted.
