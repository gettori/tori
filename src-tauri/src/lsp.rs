// Language server host. Spawns the servers described by `lsp/registry.rs` and
// bridges their LSP JSON-RPC to the frontend: stdout frames are de-framed and
// pushed over a Channel; `lsp_send` re-frames outgoing messages onto the
// server's stdin.
//
// Sessions are keyed by **(server id, root)**, not by server id alone. A
// monorepo with `packages/a/tsconfig.json` and `packages/b/tsconfig.json`
// resolves two different roots for the same server, and one shared session
// would answer `b`'s requests from `a`'s compiler config: the same
// wrong-project failure the frontend's `isUnderPath` guard already exists to
// prevent, only harder to see.
//
// Root resolution lives here rather than in the frontend, and `lsp_start`
// returns the handle it resolved. Recomputing `(server_id, root)` in
// TypeScript would mean two implementations of the same marker walk, and any
// disagreement between them pairs a client with the wrong server silently.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

use crate::env::augmented_path;

pub mod registry;
pub mod schemastore;

use registry::{Launch, LspServer};

/// Identifies one running server session. Returned by `lsp_start` and handed
/// back to `lsp_send`/`lsp_stop`; the frontend never constructs one itself.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHandle {
    pub server_id: String,
    pub root: String,
}

pub struct LspSession {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct LspState(pub Mutex<HashMap<LspHandle, LspSession>>);

/// Locate a bundled server entry: the packaged resource first, then the dev
/// source tree on the build machine (so `tauri dev` works without bundling).
fn bundled_entry(app: &AppHandle, rel: &str) -> Option<PathBuf> {
    if let Ok(p) = app.path().resolve(rel, BaseDirectory::Resource) {
        if p.exists() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/")).join(rel);
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// Build the spawn command for a server, resolving whichever executable its
/// launch kind implies.
fn command_for(app: &AppHandle, server: &LspServer) -> Result<Command, String> {
    match &server.launch {
        Launch::BundledNode { entry, args } => {
            let path = bundled_entry(app, entry).ok_or_else(|| {
                format!("{}: bundled server not found (run `pnpm lsp:install`)", server.id)
            })?;
            let mut cmd = Command::new("node");
            cmd.arg(path).args(args);
            Ok(cmd)
        }
        Launch::Path { program, args } => {
            // The login-shell PATH, never the GUI process PATH: a server
            // installed via rustup/mise/asdf is invisible to a naive lookup
            // from a Finder-launched app, and reporting it missing would send
            // the user chasing a problem that is not there.
            let path = crate::env::resolve_binary(program).ok_or_else(|| {
                format!("{}: `{program}` was not found on your PATH", server.id)
            })?;
            let mut cmd = Command::new(path);
            cmd.args(args);
            Ok(cmd)
        }
    }
}

/// Spawn a server rooted at `root`, returning the session plus its stdout.
fn spawn_session(mut cmd: Command, root: &str) -> Result<(LspSession, std::process::ChildStdout), String> {
    let mut child = cmd
        .current_dir(root)
        .env("PATH", augmented_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn the language server: {e}"))?;

    let stdout = child.stdout.take().ok_or("language server has no stdout")?;
    let stdin = child.stdin.take().ok_or("language server has no stdin")?;
    Ok((LspSession { child, stdin }, stdout))
}

/// Read LSP frames (Content-Length header + body) off `stdout` and hand each
/// JSON body to `sink`. Returns when the stream reaches EOF, i.e. when the
/// server stops.
///
/// Generic over the sink so the framing can be tested against a plain pipe,
/// with no Tauri `Channel` and no real language server involved.
fn pump_frames<R: Read + Send + 'static>(stdout: R, sink: impl Fn(String) + Send + 'static) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut content_length = 0usize;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
                let header = line.trim_end();
                if header.is_empty() {
                    break; // blank line ends the header block
                }
                if let Some(rest) = header.strip_prefix("Content-Length:") {
                    content_length = rest.trim().parse().unwrap_or(0);
                }
            }
            if content_length == 0 {
                continue;
            }
            let mut body = vec![0u8; content_length];
            if reader.read_exact(&mut body).is_err() {
                return;
            }
            sink(String::from_utf8_lossy(&body).into_owned());
        }
    });
}

/// Stop a session: signal it, then reap it.
///
/// The `wait` is not optional bookkeeping. `kill` only delivers the signal, so
/// without reaping, every stopped server stays a zombie for as long as Sway
/// runs, and a session-per-root registry stops far more servers than the old
/// one-server host ever did.
fn stop(session: &mut LspSession) {
    let _ = session.child.kill();
    let _ = session.child.wait();
}

/// Put a freshly spawned session in the map, unless another start won the race
/// for the same handle while we were spawning.
///
/// Returns whether `session` was installed. When it was not, the loser is
/// **killed here**, not dropped: `std::process::Child` has no `Drop` that stops
/// the process, so overwriting the map entry would leave a second language
/// server running with nothing able to reach it. For rust-analyzer that is an
/// orphan indexing a project at full tilt until the user logs out.
fn install_session(
    sessions: &mut HashMap<LspHandle, LspSession>,
    handle: &LspHandle,
    mut session: LspSession,
) -> bool {
    if sessions.contains_key(handle) {
        // The session already in the map is the one whose frames a live
        // subscriber is reading, so it is the one that survives.
        stop(&mut session);
        return false;
    }
    sessions.insert(handle.clone(), session);
    true
}

/// Frame a message onto a server's stdin.
fn write_frame(stdin: &mut ChildStdin, message: &str) -> Result<(), String> {
    let header = format!("Content-Length: {}\r\n\r\n", message.len());
    stdin.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    stdin.write_all(message.as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Start (or reuse) the server for `server_id` at the root resolved for
/// `file_path`, returning the handle that addresses it.
///
/// Reuse is by handle: a second file under the same resolved root gets the
/// running session rather than a respawn, while a file that resolves to a
/// different root gets its own.
#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    state: State<LspState>,
    server_id: String,
    file_path: String,
    project_path: String,
    on_message: Channel<String>,
) -> Result<LspHandle, String> {
    let server =
        registry::find(&server_id).ok_or_else(|| format!("no lsp server registered as `{server_id}`"))?;

    let root = registry::root_for(server, Path::new(&file_path), Path::new(&project_path));
    let handle = LspHandle {
        server_id: server_id.clone(),
        root: root.to_string_lossy().into_owned(),
    };

    {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        if guard.contains_key(&handle) {
            return Ok(handle);
        }
    }

    // The lock is deliberately not held across the spawn: `command_for` can
    // resolve a binary through a login shell, which is far too slow to block
    // every other session's sends behind. The cost is that two concurrent
    // starts for one handle can both get here, which `install_session`
    // settles.
    let cmd = command_for(&app, server)?;
    let (session, stdout) = spawn_session(cmd, &handle.root)?;
    pump_frames(stdout, move |body| {
        let _ = on_message.send(body);
    });

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    install_session(&mut guard, &handle, session);
    Ok(handle)
}

#[tauri::command]
pub fn lsp_send(state: State<LspState>, handle: LspHandle, message: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let session = guard
        .get_mut(&handle)
        .ok_or_else(|| format!("{} is not running at {}", handle.server_id, handle.root))?;
    write_frame(&mut session.stdin, &message)
}

#[tauri::command]
pub fn lsp_stop(state: State<LspState>, handle: LspHandle) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().map_err(|e| e.to_string())?.remove(&handle) {
        stop(&mut session);
    }
    Ok(())
}

/// Stop every running session. What a project switch calls: the old project's
/// servers are all wrong at once, and there is no per-handle bookkeeping the
/// caller would have to keep in step.
#[tauri::command]
pub fn lsp_stop_all(state: State<LspState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    for (_, mut session) in guard.drain() {
        stop(&mut session);
    }
    Ok(())
}

/// Every registered server, for the frontend's extension-to-server map and the
/// Settings health cards.
#[tauri::command]
pub fn lsp_registry() -> Vec<LspServer> {
    registry::registry().to_vec()
}

/// What to send a server whose config sets `schema_associations`.
///
/// Empty is a normal answer, not an error: offline, or with a catalog that will
/// not parse, JSON files edit exactly as they did before any of this existed.
/// The work behind this happens once per process however many times it is
/// called (see `schemastore::associations`).
///
/// `async` for the reason `check_for_update` and `model_context_caps` are: on a
/// cold cache this fetches, and a synchronous command runs on the main thread,
/// so the first JSON file opened on a fresh machine would freeze the window for
/// as long as the request took.
#[tauri::command]
pub async fn lsp_schema_associations() -> Vec<schemastore::SchemaAssociation> {
    schemastore::associations().to_vec()
}

// --- health ---

/// Per-server install state, mirroring `crate::health::AgentHealth` so the
/// Settings cards read the same way for a language server as for an agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHealth {
    pub id: String,
    pub label: String,
    /// The binary that has to exist on this machine: the server itself for a
    /// `path` server, `node` for a bundled one.
    pub program: String,
    pub status: crate::health::BinaryStatus,
    pub path: Option<String>,
    pub version: Option<String>,
    pub verified_against: Option<String>,
    /// Extensions this server claims, for the card's chips.
    pub extensions: Vec<String>,
    /// What is wrong beyond a missing `program`, when anything is. Today the
    /// one case is a bundled server whose entry script was never installed:
    /// `node` resolves fine, so probing the program alone would report the
    /// card healthy while every `lsp_start` fails.
    pub detail: Option<String>,
    /// Path of the user TOML overriding this server, when one is loaded.
    pub override_path: Option<String>,
}

/// Build one server's health card.
///
/// `bundled_entry_missing` is passed in rather than resolved here so this stays
/// free of `AppHandle` and testable off a real Tauri app.
fn check(server: &LspServer, bundled_entry_missing: bool) -> LspHealth {
    let program = server.launch.program().to_string();
    let resolved = crate::env::resolve_binary(&program);
    let version = resolved.as_deref().and_then(crate::health::run_version);

    let detail = bundled_entry_missing
        .then(|| "the bundled server is not installed (run `pnpm lsp:install`)".to_string());

    // A server is only runnable when *everything* it needs is present. A
    // bundled server needs its interpreter and its entry script, and reporting
    // it found on the strength of the interpreter alone would send the user
    // chasing a problem that is not the one they have. Same rule `health.rs`
    // states for agents, applied to the second thing a server can be missing.
    let status = match (&resolved, &detail) {
        (None, _) | (Some(_), Some(_)) => crate::health::BinaryStatus::NotFound,
        (Some(_), None) => {
            crate::health::compare(version.as_deref(), server.verified_against.as_deref())
        }
    };

    LspHealth {
        id: server.id.clone(),
        label: server.label.clone(),
        program,
        status,
        path: resolved.map(|p| p.to_string_lossy().into_owned()),
        version,
        verified_against: server.verified_against.clone(),
        extensions: server.languages.keys().cloned().collect(),
        detail,
        override_path: server.is_override().then(|| server.source.clone()),
    }
}

/// Health for every registered server. Not memoized the way `agent_health` is:
/// the sweep is two subprocesses at most, and a user who installs
/// rust-analyzer while Sway is open should see the card change on the next
/// Settings open rather than after a restart.
#[tauri::command]
pub async fn lsp_health(app: AppHandle) -> Vec<LspHealth> {
    registry::registry()
        .iter()
        .map(|server| {
            let missing = match &server.launch {
                Launch::BundledNode { entry, .. } => bundled_entry(&app, entry).is_none(),
                Launch::Path { .. } => false,
            };
            check(server, missing)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// `cat` copies stdin to stdout byte for byte, so a framed message written
    /// to it comes back as the identical frame. That makes it an exact echo
    /// server for the transport, with nothing to install and nothing to commit:
    /// these tests run on a machine with no rust-analyzer and no `node`.
    fn echo_server() -> Command {
        Command::new("cat")
    }

    fn start_echo(root: &str) -> (LspSession, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel();
        let (session, stdout) = spawn_session(echo_server(), root).unwrap();
        pump_frames(stdout, move |body| {
            let _ = tx.send(body);
        });
        (session, rx)
    }

    fn recv(rx: &mpsc::Receiver<String>) -> String {
        rx.recv_timeout(Duration::from_secs(5)).expect("no frame arrived")
    }

    #[test]
    fn a_framed_message_round_trips_through_the_transport() {
        let (mut session, rx) = start_echo("/");
        write_frame(&mut session.stdin, r#"{"jsonrpc":"2.0","id":1}"#).unwrap();
        assert_eq!(recv(&rx), r#"{"jsonrpc":"2.0","id":1}"#);
        let _ = session.child.kill();
    }

    #[test]
    fn frames_are_split_on_content_length_not_on_newlines() {
        let (mut session, rx) = start_echo("/");
        // A body containing a blank line and CRLFs must not be mistaken for a
        // header block: only Content-Length decides where the body ends.
        let body = "{\"a\":\"x\\r\\n\\r\\ny\"}";
        write_frame(&mut session.stdin, body).unwrap();
        write_frame(&mut session.stdin, r#"{"b":2}"#).unwrap();
        assert_eq!(recv(&rx), body);
        assert_eq!(recv(&rx), r#"{"b":2}"#);
        let _ = session.child.kill();
    }

    #[test]
    fn two_sessions_of_one_server_at_two_roots_are_independently_addressable() {
        let mut map: HashMap<LspHandle, LspSession> = HashMap::new();
        let a = LspHandle { server_id: "demo".into(), root: "/".into() };
        let b = LspHandle { server_id: "demo".into(), root: "/tmp".into() };

        let (sa, rx_a) = start_echo(&a.root);
        let (sb, rx_b) = start_echo(&b.root);
        map.insert(a.clone(), sa);
        map.insert(b.clone(), sb);

        // Same server id, two live sessions: the composite key is what keeps
        // them apart. Keyed by id alone, one would have evicted the other.
        assert_eq!(map.len(), 2);

        write_frame(&mut map.get_mut(&a).unwrap().stdin, r#"{"to":"a"}"#).unwrap();
        write_frame(&mut map.get_mut(&b).unwrap().stdin, r#"{"to":"b"}"#).unwrap();
        assert_eq!(recv(&rx_a), r#"{"to":"a"}"#);
        assert_eq!(recv(&rx_b), r#"{"to":"b"}"#);

        // Each message went to exactly one session, not to both.
        assert!(rx_a.recv_timeout(Duration::from_millis(200)).is_err());
        assert!(rx_b.recv_timeout(Duration::from_millis(200)).is_err());

        // Stopping one leaves the other serving.
        let mut stopped = map.remove(&a).unwrap();
        let _ = stopped.child.kill();
        write_frame(&mut map.get_mut(&b).unwrap().stdin, r#"{"still":"here"}"#).unwrap();
        assert_eq!(recv(&rx_b), r#"{"still":"here"}"#);

        for (_, mut s) in map.drain() {
            let _ = s.child.kill();
        }
    }

    #[test]
    fn the_handle_is_what_addresses_a_session() {
        let mut map: HashMap<LspHandle, LspSession> = HashMap::new();
        let handle = LspHandle { server_id: "demo".into(), root: "/".into() };
        let (session, rx) = start_echo(&handle.root);
        map.insert(handle.clone(), session);

        // A handle rebuilt from its own fields addresses the same session:
        // this is what lets the frontend hold the value `lsp_start` returned
        // and hand it back later.
        let same = LspHandle { server_id: "demo".into(), root: "/".into() };
        write_frame(&mut map.get_mut(&same).unwrap().stdin, r#"{"ok":1}"#).unwrap();
        assert_eq!(recv(&rx), r#"{"ok":1}"#);

        // A different root is a different session, and simply is not there.
        let other = LspHandle { server_id: "demo".into(), root: "/tmp".into() };
        assert!(map.get_mut(&other).is_none());

        for (_, mut s) in map.drain() {
            let _ = s.child.kill();
        }
    }

    #[test]
    fn the_reader_thread_ends_when_the_server_does() {
        let (mut session, rx) = start_echo("/");
        let _ = session.child.kill();
        let _ = session.child.wait();
        // Sender dropped at EOF, so the channel closes rather than hanging.
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_err());
    }

    #[test]
    fn health_reports_one_card_per_registered_server() {
        let cards =
            registry::registry().iter().map(|s| check(s, false)).collect::<Vec<_>>();
        assert_eq!(cards.len(), registry::registry().len());

        let ts = cards.iter().find(|c| c.id == "typescript").expect("bundled TS server");
        // A bundled server's dependency is the interpreter, not the entry
        // script: the script ships with the app, `node` does not.
        assert_eq!(ts.program, "node");
        assert!(ts.extensions.contains(&"ts".to_string()));

        let rs = cards.iter().find(|c| c.id == "rust").expect("bundled Rust server");
        assert_eq!(rs.program, "rust-analyzer");

        // The invariant that must hold on every machine, whatever is
        // installed: a card only says "not found" when something really is
        // missing, and it never shows a path for a server it calls missing
        // unless it also says what else is wrong.
        for card in &cards {
            if card.status == crate::health::BinaryStatus::NotFound {
                assert!(
                    card.path.is_none() || card.detail.is_some(),
                    "{} says not-found while showing {:?} and explaining nothing",
                    card.id,
                    card.path
                );
            } else {
                assert!(card.path.is_some(), "{} is runnable with no path", card.id);
            }
            // No config declares `verified_against`, so nothing can report
            // drift; an unknown version must render neutral, never as a
            // warning about a healthy install.
            if card.verified_against.is_none() {
                assert_ne!(card.status, crate::health::BinaryStatus::VersionDrift);
            }
        }
    }

    #[test]
    fn a_bundled_server_with_no_entry_installed_is_not_reported_healthy() {
        let ts = registry::find("typescript").unwrap();

        // `node` resolves on this machine, so probing the program alone would
        // call this healthy. It is not: without the entry script every
        // `lsp_start` fails, and a card that says "found" sends the user
        // chasing the wrong problem.
        let missing = check(ts, true);
        assert_eq!(missing.status, crate::health::BinaryStatus::NotFound);
        assert!(
            missing.detail.as_deref().unwrap_or_default().contains("lsp:install"),
            "the card must say how to fix it, got {:?}",
            missing.detail
        );

        // With the entry present the same server stops reporting a problem.
        let present = check(ts, false);
        assert!(present.detail.is_none());
        assert_ne!(present.status, crate::health::BinaryStatus::NotFound);

        // A `path` server has no entry script, so it can never be in this state.
        assert!(check(registry::find("rust").unwrap(), false).detail.is_none());
    }

    #[test]
    fn a_racing_start_kills_the_loser_instead_of_leaking_it() {
        let mut map: HashMap<LspHandle, LspSession> = HashMap::new();
        let handle = LspHandle { server_id: "demo".into(), root: "/".into() };

        let (winner, rx) = start_echo(&handle.root);
        assert!(install_session(&mut map, &handle, winner));

        // A second start raced us to the same handle and spawned its own
        // server. Dropping it would leave it running unreachable, since
        // `Child` has no `Drop` that stops the process.
        let (loser, _loser_rx) = start_echo(&handle.root);
        let loser_pid = loser.child.id();
        assert!(!install_session(&mut map, &handle, loser), "the racer must not be installed");

        // The loser is actually dead, not merely forgotten.
        let reaped = Command::new("kill")
            .arg("-0")
            .arg(loser_pid.to_string())
            .status()
            .expect("kill -0");
        assert!(!reaped.success(), "pid {loser_pid} is still alive after losing the race");

        // And the winner is untouched: still the one in the map, still serving.
        assert_eq!(map.len(), 1);
        write_frame(&mut map.get_mut(&handle).unwrap().stdin, r#"{"alive":1}"#).unwrap();
        assert_eq!(recv(&rx), r#"{"alive":1}"#);

        for (_, mut s) in map.drain() {
            let _ = s.child.kill();
        }
    }

    #[test]
    fn a_handle_serializes_camel_case_for_the_frontend() {
        let handle = LspHandle { server_id: "typescript".into(), root: "/p".into() };
        let json = serde_json::to_string(&handle).unwrap();
        assert_eq!(json, r#"{"serverId":"typescript","root":"/p"}"#);
        // Round-trips, so the frontend can hand back exactly what it was given.
        assert_eq!(serde_json::from_str::<LspHandle>(&json).unwrap(), handle);
    }
}
