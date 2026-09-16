---
summary: implements the askpass credential bridge, a re-exec'd helper over a Unix socket, so backgrounded git can prompt in app
status: current
updated: 2026-07-10
source: Askpass credential bridge for backgrounded git (personal/sway, branch code-mirror-6); commit 3fff674
---

# Askpass bridge

**Location:** `src-tauri/src/askpass.rs`, the auth'd section of `src-tauri/src/git.rs`, `src/components/AskpassDialog.tsx` (mounted in `src/App.tsx`)

The module that lets a backgrounded git op prompt for credentials in-app. It implements [[concept_askpass_bridge]]: a re-exec'd helper, a Unix-socket server, the auth'd git commands, and the frontend dialog.

## Responsibilities

- **Helper mode** (`askpass.rs`): `is_helper()` (marker = `SWAY_ASKPASS_SOCK` present) and `run_helper()` - read the prompt from `argv[1]`, `helper_exchange()` over the socket, write **only** the answer to stdout, exit 0; any error → nothing on stdout, non-zero. Entered from `run()` in `lib.rs` before Tauri init.
- **Socket server** (`askpass.rs`): `start(emit)` binds a `0700` short-path socket under `$TMPDIR` (fails soft with an `Err` if the path would exceed the 104-byte `sun_path` limit, so the app still runs), mints a `/dev/urandom` token, and spawns an accept loop (thread per connection). `handle_request` authenticates the token, honours the cancel latch, classifies username-vs-secret, emits `askpass://prompt`, and blocks on an mpsc `recv_timeout` (300 s) for the resolution. `resolve(id, value)` answers a prompt; `value: None` latches the op cancelled. `askpass_respond` is the Tauri command the frontend calls. `AskpassState` is the managed handle.
- **Auth'd git** (`git.rs`): `git_command(repo, op_id, sock, token)` builds a `git -C` Command wired with `GIT_ASKPASS`/`SSH_ASKPASS`=current_exe, `SSH_ASKPASS_REQUIRE=force`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new`, the `SWAY_ASKPASS_*` coordinates, and the augmented PATH. `git_fetch(repo, remote?)` runs it on a thread with a fresh `op_id`, emitting `git://fetch-done` / `git://fetch-error`. `git_has_credential_helper(repo)` reports whether caching is configured.
- **Frontend dialog** (`AskpassDialog.tsx`): listens for `askpass://prompt`, **queues** prompts (concurrent/sequential each show in turn), renders masked input for `kind=password` (plain for username) with a token-not-password hint, and calls `askpass_respond(id, value)` on submit or `askpass_respond(id, null)` on cancel. Mounted once app-wide in `App.tsx`.

## Key entry points

- `askpass.rs` — `is_helper`, `run_helper`, `helper_exchange`, `start`, `handle_request`, `resolve`, `askpass_respond`, `classify`, `AskpassInner`/`AskpassState`, `PromptEvent`.
- `git.rs` — `git_command`, `git_fetch`, `git_has_credential_helper`, `next_op_id`.
- `AskpassDialog.tsx` — the queued credential modal (reuses the `PromptModal` CSS + a new `.modal-hint`).

## Testability

`start(emit)` takes the fan-out closure as a `Box<dyn Fn>`, so tests inject a recorder and drive concurrent connections, wrong-token refusal, latched-cancel, and timeout without a Tauri app. See [[lesson_offline_askpass_e2e]].

## Connections

- Implements [[concept_askpass_bridge]]; extends the `git.rs` hub of [[component_project_discovery]].
- `git_fetch` no longer backs a user-facing "Fetch All" button. It is the **background fetch behind Add Branch / Add Worktree**: opening that picker (on a repo with an origin) kicks `git_fetch`, and its `git://fetch-done`/`git://fetch-error` events drive a guarded live-fold of remote branches into the same picker (see [[gotcha_a_fire_and_forget_backend_event_feeding_a_modal_must_be_identity_and_open_guarded]] and [[gotcha_dont_encode_a_picker_items_kind_in_its_display_string]]).
- Shares `env::augmented_path` with [[component_pty_host]] / [[component_lsp_host]].

## Related

- [[gotcha_darwin_caps_unix_socket_paths_at_104_bytes]]
- [[gotcha_git_calls_askpass_once_per_field_as_separate_processes]]
- [[gotcha_ssh_askpass_needs_require_force_and_only_fires_without_a_tty]]
