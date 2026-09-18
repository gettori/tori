---
summary: askpass re execs Tori's own binary as the git credential helper over a private unix socket, failing closed on any error
status: current
updated: 2026-07-19
source: Askpass credential bridge for backgrounded git (personal/tori, branch code-mirror-6); commit 3fff674; `src-tauri/src/askpass.rs`; `git_push` sibling added in Review-to-prompt + commit flow (branch `topbar`); commit 35bc401
---

# Askpass credential bridge

How a **backgrounded** git op (fetch/pull/push with no TTY) obtains credentials through a native in-app dialog instead of hanging or spawning a terminal tab. This is the credential half of [[adr_git_integration_auth]] made real; the editor bridge is still deferred.

## The mechanism

- **Same-binary re-exec as the helper.** `git`/`ssh` ask for credentials by invoking `$GIT_ASKPASS`/`$SSH_ASKPASS` with the prompt as `argv[1]` and reading the answer off stdout. We point those at **Tori's own executable** (`std::env::current_exe`), not a second bundled binary. `run()` checks an env marker (`TORI_ASKPASS_SOCK` present) **before any Tauri/AppKit init** and, if set, runs a **stdout-answer-only** helper path then exits. The app's own process never has the marker (it is set only on the git child `Command`), so the branch is unambiguous. This dodges all the path-resolution/bundling problems of shipping a separate helper.
- **Private Unix-socket transport, no tokio.** The app hosts a `std::os::unix::net::UnixListener` in a `0700` dir under `$TMPDIR`, with a **per-session random token** (`/dev/urandom`). An accept loop spawns a **thread per connection** (mirrors [[component_pty_host]]'s std-thread model). The helper connects, sends one newline-framed JSON `{token, op_id, prompt}`, and reads one response line back.
- **Per-op identity, not per-prompt.** git calls askpass **once per field as a separate process** ("Username for …" then "Password for …"), so one fetch is 2+ helper runs. An `op_id` is threaded env → helper → socket so sibling prompts of one op are correlated. See [[gotcha_git_calls_askpass_once_per_field_as_separate_processes]].
- **Per-op cancel latch.** Cancelling any field (`askpass_respond(id, null)`) inserts the `op_id` into a `cancelled` set; the op's *remaining* field-prompts then return empty immediately without surfacing a second dialog. So cancelling the username prompt aborts the whole fetch, not just one field.
- **Fail-closed on every path.** Wrong/absent token, oversized frame, timeout, cancel, or any error yields an **empty** credential (never a hang). Under `GIT_TERMINAL_PROMPT=0` an empty credential makes git abort cleanly. The helper writes **only** the answer to stdout (diagnostics to stderr); any error prints nothing and exits non-zero.
- **Locale-stable parsing.** git runs under `LC_ALL=C` so prompt wording is stable English, letting the server classify username-vs-secret to drive masked input. See [[gotcha_git_calls_askpass_once_per_field_as_separate_processes]].

## Why this shape

Backgrounded ops (e.g. loading `origin/*` for a remote-branch picker) have no TTY, so the old terminal-tab-for-auth approach could not serve them (and does not scale to a full git UI). One socket bridge serves every future git feature provider-agnostically, because it is just git's own credential mechanism. Secrets transit app memory + the local socket but are **never logged and never persisted** - git's own helper (osxkeychain) owns caching.

## Connections

- Realizes [[adr_git_integration_auth]] (credential half); editor bridge (`GIT_EDITOR`) still deferred.
- Implemented by [[component_askpass]]; the auth'd git commands live alongside [[component_project_discovery]] in `git.rs`.
- `git_push` ([[component_changes_panel]]) is a straight sibling of `git_fetch`: same thread/op-id/`git_command` shape, only the `--set-upstream` decision (a pure `has_upstream` helper) is new.
- Shares the augmented-PATH discipline of [[component_pty_host]] ([[gotcha_gui_launched_processes_inherit_a_minimal_path]]).
- Supersedes the ambient-auth rationale of [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]] (injection-safety + clone-cleanup parts still hold).

## Related

- [[gotcha_darwin_caps_unix_socket_paths_at_104_bytes]]
- [[gotcha_git_calls_askpass_once_per_field_as_separate_processes]]
- [[gotcha_ssh_askpass_needs_require_force_and_only_fires_without_a_tty]]
- [[lesson_offline_askpass_e2e]] - proving the path offline.
