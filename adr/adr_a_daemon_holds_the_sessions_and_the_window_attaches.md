---
summary: sessions run in `tori daemon`, the same binary; the window attaches over a link, quit leaves it, an update waits for idle
status: current
updated: 2026-10-15
source: gettori/tickets#24 plan "Session host: agents outlive the window", branch phase-1-block-3, commits ed0255e3 to 806eb9a1; src-tauri/src/rpc/{daemon,window,office,launchd}.rs
---

# A daemon holds the sessions and the window attaches

**Every PTY, chat, the composer, the method table, the Autopilot and the remote front run in `tori daemon`, a mode of the app binary. The window is a client: it attaches over a unix socket link, proxies its commands, and reads PTY bytes over a raw attach stream.** Quitting, crashing or updating the window leaves every session going, and a relaunch reattaches to them as left. See [[component_tori_daemon]].

## Considered Options

- **A library crate plus a `torid` binary** (rejected): a second artifact to sign, and its own Keychain grant ([[gotcha_an_unsigned_rebuild_prompts_again_for_the_same_keychain_item]]). The same binary in `tori daemon` mode reads the Keychain itself.
- **The webview dials the daemon** (rejected): a token in the webview and a frontend rewrite. The app proxies instead, and PTY bytes go over their own attach stream, not base64 in JSON frames (heavy, and past the 256 KiB line cap).
- **One connection per command class** (rejected): every new command would pick a lane. The window connection is its own kind instead: each request dispatched on its own thread, replies out of order, bounded by bytes (16 MB) rather than the CLI's 256-line drop.
- **Quit stops the daemon** (rejected until #38 adds a prompt): it would protect only against crashes and updates.
- **An update restarts the daemon at once** (rejected): it kills turns in flight. An unforceable wait was rejected too, since an Autopilot can hold it for days. So a release daemon restarts when no session is working, and **Restart now** forces it.
- **A dev LaunchAgent** (rejected): `cargo` rewrites the binary on every build, so a pinned path runs whatever was built last. A dev build spawns its daemon itself and restarts it on any build mismatch.
- **Tauri in the daemon** (rejected): notifications, tray and badge come from the attached window (`present`); with none, the phone and `session.wait` carry needs-you.
- **Eager resume after a daemon crash** (rejected): it starts agents nobody asked for. A chat that died comes back `open` and resumes on the next send, or when steered.

## Consequences

- **Builds compare by build id, not version**, since a rebuild keeps the version. A release window on the same link `PROTOCOL` attaches to an older daemon and asks it to restart when idle; another protocol shows "Restart needed".
- **Shells do not survive a daemon restart.** Keeping a PTY across an exec is out of scope; an on-screen shell tab closes as when its shell exits.
- **`rpc.json` is readable by every process of the user**, so `Principal::Local` means the same uid, not the app. Only Local may be the window or attach to a PTY, which stops sessions, workers and devices and nothing more; #39's sandbox is where the file leaves an agent's reach.
- **Git writes from two processes share one `flock`** in the repo's common dir (`exec::repo_lock`, `src-tauri/src/exec.rs:141`), since the checkpoint snapshot runs where the chat runs and the app's own git stays in the app.
- **The webview bridge is gone.** [[adr_socket_asks_the_webview_until_rust_owns_state]] predicted that moving state into Rust would leave the wire unchanged, and it did.

## Related

- [[component_tori_daemon]]: the process, its link and its lifecycle
- [[component_app_socket]]: the protocol the daemon serves
- [[adr_lazy_tab_attachment]]: why a relaunch reattaches held tabs
- [[adr_one_protocol_several_fronts]]: the fronts the daemon now hosts
- [[component_remote_front]]: Remote listening with the app quit
