---
summary: `tori daemon` holds the socket, PTYs, chats and office; the window's Link attaches; launchd, exit 75, 5 failed starts
status: current
updated: 2026-10-15
source: gettori/tickets#24 plan "Session host: agents outlive the window", branch phase-1-block-3, commits ed0255e3 to 806eb9a1; src-tauri/src/rpc/{daemon,window,office,launchd}.rs; src/components/DaemonPill/DaemonPill.tsx
---

# Tori daemon

`src-tauri/src/rpc/daemon.rs` is `tori daemon`, the process every session runs in. `window.rs` is the app's side of the link to it. Why it exists: [[adr_a_daemon_holds_the_sessions_and_the_window_attaches]].

## Responsibility

- **The socket.** It `flock`s `run/daemon.lock`, binds `run/tori.sock` in a dir it checks is its own and `0700` (`private_dir`, `daemon.rs:110`), or a short `/tmp` path past 104 bytes ([[gotcha_darwin_caps_unix_socket_paths_at_104_bytes]]), and writes `rpc.json`. It handshakes before capturing the login PATH; spawns wait on the capture.
- **What it hosts.** The PTY host ([[component_pty_host]]), the chat host (`chat/serve.rs`, [[component_chat_host]]), the Composer (`rpc/composer.rs`: dots, `SessionStates`, presence), and the office (`rpc/office.rs`): the `Server` with `DaemonBackend`, asks, the Autopilot store, runner and watcher, the radar, quotas, a daemon askpass, adoptable chats, and the remote front ([[component_remote_front]]). `host_office` (`daemon.rs:765`) builds the office only in `run`, after the chats.
- **Dispatch.** Every front's request goes to one `table`, the office's `Server`, set by `host_office`; before that, a request is refused with "the daemon is still starting" (`dispatch`, `daemon.rs:818`). `sessions.list` and `session.wait` are answered from the Composer either way. Test daemons set a stub table with `serve()`.
- **It does not own** the window's UI state, the forge poll, or notifications (it sends `present` and the window draws them).

## The window link

`Link` (`window.rs`) connects, or starts the daemon (`spawn_daemon`: launchd in a release build, a detached child in dev), registers with `window {token, build, instance}`, and reconnects with backoff. Only `Principal::Local` may register, one window at a time, and registering rotates the process token in `rpc.json`.

- **App to daemon:** `office {op, args}` (every Tauri command whose store moved, through `office_call` and `office_tell`), `chat {method, args}` (the `Chats` proxy in `chat/client.rs`), `pty.spawn`, `pty.list`, `pty.write|resize|kill`, `mint`, `facts`, `attention`, `running`, `sessions_changed`, `probe`, `askpass.resolve`, `restart`, `restart_when_idle`, `shutdown`. The window also publishes on its own `Hub`, which is relayed upstream.
- **Daemon to window:** `emit {event, payload}` (a `Ui` event for the webview), `chat.event`, `states`, `dots`, `present`, `askpass.prompt`, `needs_you.changed`, the `pty://` events, and one request, `screen`, for `window.open`. The window answers that by emitting `window://open`, and refuses until the webview has called `window_listening`.
- **PTY bytes** never ride the link: `open_attach` (`window.rs:527`) opens a socket connection whose first line is `pty.attach`, then frames ([[component_pty_host]]). `tori attach` uses the same handshake.

## Lifecycle

- **launchd** (`launchd.rs`): a release build writes `~/Library/LaunchAgents/app.gettori.tori.daemon.plist` (`RunAtLoad`, `KeepAlive.SuccessfulExit=false`, stderr to `run/daemon.log`), rewrites it when the binary path moves, and `bootstrap`s and `kickstart`s it.
- **Exit codes:** 75 (`launchd::RESTART`) means replace me, so launchd relaunches; 0 means another daemon is running or it gave up, so launchd leaves it down; a crash relaunches.
- **Failed starts:** each start bumps `<config>/daemon-starts`; 20 s up clears it (`SETTLED`). At `GIVE_UP_AFTER = 5` it exits 0, and so does a count it cannot write. The window shows **Daemon stopped after 5 failed starts** with Try again (`daemon_restart_now` clears the count).
- **Updates:** a release window of another build on the same `PROTOCOL` attaches and asks `restart_when_idle`; `Office::sessions_moved` emits `daemon://update-waiting {sessions}` and restarts at zero working. A daemon too old to know the method answers METHOD_NOT_FOUND and is shut down at once. Another protocol is `Status::RestartNeeded`. Restart now is `launchctl kickstart -k`.
- **Uninstall:** `tori daemon --uninstall` writes `<config>/daemon-off`, boots the agent out, removes the plist and `rpc.json`. The marker stops an open window from installing it again; the pill offers Start.
- **After a crash or restart** the window remounts each chat tab that was live and is no longer held as `open` with `resume` (`remountAsOpen` in `Terminal.tsx`); `session.steer` revives a chat that is not live (`DaemonBackend::revive`, `methods.rs:861`).

## Related

- [[adr_a_daemon_holds_the_sessions_and_the_window_attaches]]: the decision and its alternatives
- [[component_app_socket]]: the protocol and method table it serves
- [[component_tori_cli]]: `tori attach` and `tori daemon --uninstall`
- [[gotcha_a_forked_child_holds_every_fd_until_exec_a_flock_included]]: why a fresh daemon can find the lock still held
- [[gotcha_macos_refuses_setsockopt_on_a_socket_the_peer_closed]]: why `open_attach` reads the reply before clearing its timeout
