// Debug adapter host. Spawns the adapter described by `dap/registry.rs` and
// bridges its DAP JSON to the frontend: socket frames are de-framed and pushed
// over a Channel, `dap_send` re-frames outgoing messages back onto the socket.
//
// The framing is `lsp.rs`'s, byte for byte (Content-Length header, then body).
// Nothing else about the transport is:
//
//   - **The adapter listens; we dial in.** `dapDebugServer.js <socket-path>`
//     binds a socket and waits, so there is no stdin/stdout pair to frame over.
//     It prints a readiness line, which this host logs and does not wait for:
//     the string is unversioned English, and gating on it would turn a reworded
//     line into a permanent hang. The connect retries instead, which measured
//     6 attempts over ~106ms on the machine this was written on. An immediate
//     single connect failed every time, so the retry is the mechanism, not a
//     safety net.
//
//   - **One adapter process hosts many sessions.** js-debug asks the client to
//     start a child session (the `startDebugging` reverse request) and expects
//     that child to arrive as a *second connection to the same server*, so a
//     session is a connection and not a process. Even a one-file launch is two
//     sessions: the root coordinates and never stops, the child is where
//     execution actually pauses. `dap_start` spawns a server and opens its
//     first session; `dap_connect` opens the rest.
//
//   - **The adapter owns its debuggee, so stopping is a process-group kill.**
//     A language server has no children. A debug adapter's whole job is to have
//     one, and killing only the adapter orphans the debuggee (js-debug ships a
//     `watchdog.js` and a `terminateProcess.sh` precisely because this is not
//     simple). Spawning into its own process group makes the group the unit of
//     cleanup, and it gets the launch/attach distinction right for free: a
//     launched target is a descendant and dies with the group, while an
//     attached one was started by the user, is in no group of ours, and cannot
//     be touched. The graceful half (DAP `terminate`, then `disconnect` with
//     `terminateDebuggee` set per target kind) is protocol, so it belongs to the
//     frontend; this layer stays transport-only the way `lsp.rs` does.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

use crate::env::augmented_path;

pub mod registry;

use registry::DapAdapter;

/// How long to keep retrying the connect before calling the adapter dead.
/// Measured cold-start is ~106ms; this is wide enough for a loaded machine and
/// short enough that a genuinely broken adapter reports rather than hangs.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(20);

/// Identifies one adapter process. The frontend gets this back from `dap_start`
/// and hands it to `dap_connect` to open sibling sessions on the same server.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapServerId(pub String);

/// Identifies one session, i.e. one connection to one adapter process.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapHandle {
    pub server: DapServerId,
    pub session: String,
}

struct Session {
    /// The write half. The read half lives in the pump thread.
    stream: UnixStream,
}

struct Server {
    child: Child,
    socket: PathBuf,
    sessions: HashMap<String, Session>,
}

/// Private field: `Server` is module-private, and everything outside this
/// module now goes through `shutdown` or a command, so exposing it would only
/// leak a type callers cannot name.
#[derive(Default)]
pub struct DapState(Mutex<HashMap<DapServerId, Server>>);

impl DapState {
    /// Stop every adapter and everything it launched.
    ///
    /// Called on app exit, and this one is not optional the way it would be for
    /// a language server. An adapter is spawned into *its own process group* so
    /// that stopping it takes its launched debuggee down too, and that same
    /// detachment means quitting Sway does not: without this, closing the window
    /// leaves the adapter, the program being debugged and js-debug's watchdog
    /// all running, with nothing on screen left that could name them.
    pub fn shutdown(&self) {
        let Ok(mut guard) = self.0.lock() else { return };
        for (_, mut server) in guard.drain() {
            stop(&mut server);
        }
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id(prefix: &str) -> String {
    format!("{prefix}{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

/// Darwin copies a socket path into `sockaddr_un.sun_path`, 104 bytes.
const SUN_PATH_MAX: usize = 104;

/// A socket path short enough for `sun_path`.
///
/// The name is short and random and is deliberately **not** derived from the
/// workspace path: every other store in Sway is path-keyed, and following that
/// habit here would produce a socket that binds on shallow projects and fails
/// with `ENAMETOOLONG` on deep ones.
///
/// The length is *checked* rather than merely kept short, following
/// `askpass::start`: a pathological `$TMPDIR` is the one input that can still
/// blow the budget, and an unchecked over-long path fails at `bind` with an
/// error that names nothing. Failing here says which path and how long.
fn socket_path() -> Result<PathBuf, String> {
    socket_path_in(&std::env::temp_dir())
}

/// The half that takes its directory, so the over-long case is testable without
/// mutating `TMPDIR` out from under every other test in the process.
fn socket_path_in(dir: &std::path::Path) -> Result<PathBuf, String> {
    let unique = format!("{}-{}", std::process::id(), next_id("s"));
    let path = dir.join(format!("sway-dap-{unique}.sock"));
    let len = path.as_os_str().len();
    if len >= SUN_PATH_MAX {
        return Err(format!(
            "the debug adapter socket path is {len} bytes, over the {SUN_PATH_MAX}-byte limit: {}",
            path.display()
        ));
    }
    Ok(path)
}

/// Locate the bundled adapter entry: the packaged resource first, then the dev
/// source tree (so `tauri dev` works without bundling), mirroring `lsp.rs`.
fn bundled_entry(app: &AppHandle, rel: &str) -> Option<PathBuf> {
    if let Ok(p) = app.path().resolve(rel, BaseDirectory::Resource) {
        if p.exists() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/dap/")).join(rel);
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// Spawn the adapter, listening on `socket`, in its own process group.
fn spawn_adapter(entry: &PathBuf, socket: &PathBuf, root: &str) -> Result<Child, String> {
    let mut child = Command::new("node")
        .arg(entry)
        .arg(socket)
        .current_dir(root)
        // The login-shell PATH, not the GUI process one: the adapter resolves
        // the debuggee's runtime (`node`, `pnpm`) from what it inherits, and a
        // Finder-launched Sway has almost nothing on PATH.
        .env("PATH", augmented_path())
        // Its own process group, so `stop` can take the debuggee with it.
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn the debug adapter: {e}"))?;

    // Drain stdout so a chatty adapter cannot block on a full pipe, and log the
    // readiness line for diagnostics. Nothing waits on this.
    if let Some(out) = child.stdout.take() {
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                eprintln!("[dap] {line}");
            }
        });
    }
    Ok(child)
}

/// Dial the adapter, retrying until it has bound its socket.
///
/// Split out and generic over nothing so the timing behaviour is testable
/// against a plain `UnixListener` with no adapter and no `node` involved.
fn connect_retry(socket: &PathBuf, timeout: Duration) -> Result<UnixStream, String> {
    let start = Instant::now();
    loop {
        match UnixStream::connect(socket) {
            Ok(s) => return Ok(s),
            Err(e) => {
                if start.elapsed() >= timeout {
                    return Err(format!(
                        "the debug adapter did not accept a connection within {}s: {e}",
                        timeout.as_secs()
                    ));
                }
                thread::sleep(CONNECT_RETRY_DELAY);
            }
        }
    }
}

/// Read DAP frames off `stream` and hand each JSON body to `sink`. Returns at
/// EOF, i.e. when the session's connection closes.
///
/// Generic over the reader and the sink so the framing is testable against a
/// plain pipe, exactly as `lsp::pump_frames` is.
fn pump_frames<R: Read + Send + 'static>(stream: R, sink: impl Fn(String) + Send + 'static) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
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

/// Frame a message onto a session's socket.
fn write_frame(stream: &mut UnixStream, message: &str) -> Result<(), String> {
    let header = format!("Content-Length: {}\r\n\r\n", message.len());
    stream.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    stream.write_all(message.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())
}

/// Stop a server: kill its whole process group, reap it, and remove the socket.
///
/// The group kill is what takes a launched debuggee down with the adapter. The
/// `wait` is not optional bookkeeping: `kill` only delivers the signal, so
/// without reaping every stopped adapter stays a zombie for as long as Sway
/// runs.
fn stop(server: &mut Server) {
    let pid = server.child.id();
    // Negative pid means "the group", which the adapter leads because it was
    // spawned with `process_group(0)`. Shelling out to `kill` keeps this
    // dependency-free; `libc` is not a direct dependency of this crate.
    let _ = Command::new("kill")
        .arg("-KILL")
        .arg(format!("-{pid}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = server.child.kill();
    let _ = server.child.wait();
    let _ = std::fs::remove_file(&server.socket);
}

/// Start an adapter for `adapter_id` at the root resolved for `file_path`, and
/// open its first session.
#[tauri::command]
pub async fn dap_start(
    app: AppHandle,
    state: State<'_, DapState>,
    adapter_id: String,
    file_path: String,
    project_path: String,
    on_message: Channel<String>,
) -> Result<DapHandle, String> {
    let adapter: &DapAdapter = registry::find(&adapter_id)
        .ok_or_else(|| format!("no debug adapter registered as `{adapter_id}`"))?;

    let root = registry::root_for(
        adapter,
        std::path::Path::new(&file_path),
        std::path::Path::new(&project_path),
    );
    let root = root.to_string_lossy().into_owned();

    let entry = bundled_entry(&app, &adapter.entry)
        .ok_or_else(|| format!("{adapter_id}: bundled adapter not found (run `pnpm dap:install`)"))?;

    let socket = socket_path()?;
    let child = spawn_adapter(&entry, &socket, &root)?;
    let stream = match connect_retry(&socket, CONNECT_TIMEOUT) {
        Ok(s) => s,
        Err(e) => {
            // The adapter is up but unreachable; do not leak it.
            let mut dying = Server { child, socket: socket.clone(), sessions: HashMap::new() };
            stop(&mut dying);
            return Err(e);
        }
    };

    let handle = DapHandle {
        server: DapServerId(next_id("dap")),
        session: next_id("sess"),
    };
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    pump_frames(reader, move |body| {
        let _ = on_message.send(body);
    });

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let server = guard.entry(handle.server.clone()).or_insert(Server {
        child,
        socket,
        sessions: HashMap::new(),
    });
    server.sessions.insert(handle.session.clone(), Session { stream });
    Ok(handle)
}

/// Open another session on a server that is already running.
///
/// This is what answers `startDebugging`: js-debug matches the child to its
/// pending target by the `__pendingTargetId` in the *launch config the frontend
/// sends over this new connection*, so it has to be another connection to the
/// same process, not a new adapter.
#[tauri::command]
pub async fn dap_connect(
    state: State<'_, DapState>,
    server: DapServerId,
    on_message: Channel<String>,
) -> Result<DapHandle, String> {
    let socket = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard
            .get(&server)
            .ok_or_else(|| format!("debug adapter {} is not running", server.0))?
            .socket
            .clone()
    };

    // Not holding the lock across the connect: it is a retry loop, and blocking
    // every other session's sends behind it would stall the whole tree.
    let stream = connect_retry(&socket, CONNECT_TIMEOUT)?;
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    pump_frames(reader, move |body| {
        let _ = on_message.send(body);
    });

    let handle = DapHandle { server: server.clone(), session: next_id("sess") };
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let Some(entry) = guard.get_mut(&server) else {
        // The server was stopped while we were connecting; drop the stream
        // rather than registering a session nothing can reach.
        return Err(format!("debug adapter {} stopped while connecting", server.0));
    };
    entry.sessions.insert(handle.session.clone(), Session { stream });
    Ok(handle)
}

#[tauri::command]
pub async fn dap_send(
    state: State<'_, DapState>,
    handle: DapHandle,
    message: String,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let session = guard
        .get_mut(&handle.server)
        .and_then(|s| s.sessions.get_mut(&handle.session))
        .ok_or_else(|| format!("debug session {} is not running", handle.session))?;
    write_frame(&mut session.stream, &message)
}

/// Stop one adapter and everything it launched.
#[tauri::command]
pub async fn dap_stop(state: State<'_, DapState>, server: DapServerId) -> Result<(), String> {
    if let Some(mut s) = state.0.lock().map_err(|e| e.to_string())?.remove(&server) {
        stop(&mut s);
    }
    Ok(())
}

/// Stop every adapter. What a project switch and app quit call, for the reason
/// `lsp_stop_all` exists: the old project's sessions are all wrong at once, and
/// a debuggee left running holds ports and files nobody can see.
#[tauri::command]
pub async fn dap_stop_all(state: State<'_, DapState>) -> Result<(), String> {
    state.shutdown();
    Ok(())
}

/// Every registered adapter, for the frontend's extension map and the Settings
/// health card.
#[tauri::command]
pub fn dap_registry() -> Vec<DapAdapter> {
    registry::registry().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;

    /// A listener that accepts one connection and echoes frames back, so the
    /// transport is testable with no adapter and no `node` on the machine.
    fn echo_listener(delay: Duration) -> (PathBuf, thread::JoinHandle<()>) {
        let socket = socket_path().expect("a short socket path");
        let path = socket.clone();
        let handle = thread::spawn(move || {
            thread::sleep(delay);
            let listener = UnixListener::bind(&path).expect("bind");
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 || stream.write_all(&buf[..n]).is_err() {
                        return;
                    }
                }
            }
        });
        (socket, handle)
    }

    fn recv(rx: &mpsc::Receiver<String>) -> String {
        rx.recv_timeout(Duration::from_secs(5)).expect("no frame arrived")
    }

    #[test]
    fn a_framed_message_round_trips_over_the_socket() {
        let (socket, _srv) = echo_listener(Duration::ZERO);
        let mut stream = connect_retry(&socket, CONNECT_TIMEOUT).unwrap();
        let (tx, rx) = mpsc::channel();
        pump_frames(stream.try_clone().unwrap(), move |b| {
            let _ = tx.send(b);
        });

        write_frame(&mut stream, r#"{"seq":1,"type":"request"}"#).unwrap();
        assert_eq!(recv(&rx), r#"{"seq":1,"type":"request"}"#);
        std::fs::remove_file(&socket).ok();
    }

    #[test]
    fn frames_are_split_on_content_length_not_on_newlines() {
        let (socket, _srv) = echo_listener(Duration::ZERO);
        let mut stream = connect_retry(&socket, CONNECT_TIMEOUT).unwrap();
        let (tx, rx) = mpsc::channel();
        pump_frames(stream.try_clone().unwrap(), move |b| {
            let _ = tx.send(b);
        });

        // A body carrying a blank line and CRLFs must not be mistaken for a
        // header block: only Content-Length decides where the body ends.
        let body = "{\"a\":\"x\\r\\n\\r\\ny\"}";
        write_frame(&mut stream, body).unwrap();
        write_frame(&mut stream, r#"{"b":2}"#).unwrap();
        assert_eq!(recv(&rx), body);
        assert_eq!(recv(&rx), r#"{"b":2}"#);
        std::fs::remove_file(&socket).ok();
    }

    /// The measured reality: the adapter is not listening when it is spawned.
    #[test]
    fn a_connect_waits_for_a_listener_that_is_not_up_yet() {
        let (socket, _srv) = echo_listener(Duration::from_millis(500));

        // The naive implementation, and why it is not the one shipped.
        assert!(
            UnixStream::connect(&socket).is_err(),
            "nothing is listening yet, so an immediate connect must fail"
        );

        let started = Instant::now();
        let mut stream = connect_retry(&socket, CONNECT_TIMEOUT).expect("retry connects");
        assert!(started.elapsed() >= Duration::from_millis(400), "it did not actually wait");

        let (tx, rx) = mpsc::channel();
        pump_frames(stream.try_clone().unwrap(), move |b| {
            let _ = tx.send(b);
        });
        write_frame(&mut stream, r#"{"late":1}"#).unwrap();
        assert_eq!(recv(&rx), r#"{"late":1}"#);
        std::fs::remove_file(&socket).ok();
    }

    /// A listener that never prints anything still connects: the readiness line
    /// is diagnostics, not the gate.
    #[test]
    fn a_silent_listener_still_connects() {
        let (socket, _srv) = echo_listener(Duration::from_millis(100));
        assert!(connect_retry(&socket, CONNECT_TIMEOUT).is_ok());
        std::fs::remove_file(&socket).ok();
    }

    #[test]
    fn a_connect_that_never_succeeds_times_out_instead_of_hanging() {
        let socket = socket_path().unwrap(); // nothing ever binds this
        let started = Instant::now();
        let err = connect_retry(&socket, Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("did not accept a connection"), "got {err}");
        assert!(started.elapsed() < Duration::from_secs(5), "it hung instead of giving up");
    }

    /// Darwin's `sun_path` is 104 bytes and a GUI app's `$TMPDIR` already spends
    /// about half of it, so the name may not grow with the workspace path.
    #[test]
    fn a_socket_path_stays_short_whatever_the_workspace_is_called() {
        let path = socket_path().expect("the real $TMPDIR fits");
        let len = path.as_os_str().len();
        assert!(len < SUN_PATH_MAX, "{} is {len} bytes, at sun_path's limit", path.display());

        // Two calls never collide, which is what lets one Sway run many sessions.
        assert_ne!(socket_path().unwrap(), socket_path().unwrap());

        // And the guard actually rejects, rather than being a check that only
        // ever sees paths that fit. A pathological `$TMPDIR` is the one input
        // that can still blow the budget.
        let pathological = PathBuf::from(format!("/var/folders/{}", "x".repeat(90)));
        let err = socket_path_in(&pathological).expect_err("an over-long path must be refused");
        assert!(err.contains("over the 104-byte limit"), "got {err}");
    }

    /// Is `pid` alive? `kill -0` signals nothing and only reports reachability.
    fn alive(pid: u32) -> bool {
        Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Stand in for an adapter that launched a debuggee: a group leader with a
    /// long-lived child, spawned exactly the way `spawn_adapter` spawns.
    fn group_with_child() -> (Server, u32) {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 30 & echo $!; wait")
            .process_group(0)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn group leader");
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let grandchild: u32 = line.trim().parse().expect("child pid");
        let server = Server { child, socket: socket_path().unwrap(), sessions: HashMap::new() };
        (server, grandchild)
    }

    /// The orphan case. Killing only the adapter would leave the debuggee
    /// holding its port and its files with nothing on screen referring to it.
    #[test]
    fn stopping_a_server_takes_its_whole_process_group_with_it() {
        let (mut server, debuggee) = group_with_child();
        let adapter = server.child.id();
        assert!(alive(adapter) && alive(debuggee), "fixture did not start");

        stop(&mut server);

        // Give the signal a moment to land on the group.
        for _ in 0..50 {
            if !alive(debuggee) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(adapter), "the adapter survived stop");
        assert!(!alive(debuggee), "pid {debuggee} was launched by the adapter and outlived it");
    }

    /// The attach case, which falls out of the same mechanism rather than
    /// needing a flag: a target the user started is in no process group of
    /// ours, so a group kill cannot reach it. Killing it would destroy a
    /// process Sway never started.
    #[test]
    fn stopping_a_server_cannot_touch_a_process_it_did_not_start() {
        let mut independent = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn independent target");
        let target = independent.id();

        let (mut server, _) = group_with_child();
        stop(&mut server);
        thread::sleep(Duration::from_millis(200));

        assert!(alive(target), "an attached target must survive the adapter being stopped");
        let _ = independent.kill();
        let _ = independent.wait();
    }

    /// App exit. Not a duplicate of `dap_stop_all`: that is a command the
    /// frontend calls on a project switch, and a window closing never reaches
    /// it, so the same sweep has to hang off the run loop's `Exit` too.
    #[test]
    fn shutting_down_stops_every_adapter_and_everything_they_launched() {
        let state = DapState::default();
        let mut debuggees = Vec::new();
        let mut adapters = Vec::new();
        {
            let mut guard = state.0.lock().unwrap();
            for i in 0..2 {
                let (server, debuggee) = group_with_child();
                adapters.push(server.child.id());
                debuggees.push(debuggee);
                guard.insert(DapServerId(format!("dap-shutdown-{i}")), server);
            }
        }

        state.shutdown();

        for _ in 0..50 {
            if debuggees.iter().all(|pid| !alive(*pid)) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        for pid in &adapters {
            assert!(!alive(*pid), "adapter {pid} survived shutdown");
        }
        for pid in &debuggees {
            assert!(!alive(*pid), "debuggee {pid} outlived the app");
        }
        // Drained, not merely stopped: a second shutdown must not try to reap
        // a child that has already been waited on.
        assert!(state.0.lock().unwrap().is_empty());
    }

    /// The wiring, which no unit test can reach: `shutdown` existing and never
    /// being called on exit is exactly the leak it was written to prevent.
    #[test]
    fn app_exit_shuts_the_dap_state_down() {
        let lib = include_str!("lib.rs");
        let after = lib.split("RunEvent::Exit").nth(1).expect("an exit handler in lib.rs");
        let handler = &after[..after.len().min(500)];
        assert!(
            handler.contains("DapState") && handler.contains("shutdown"),
            "app exit must call DapState::shutdown; adapters are in their own process group \
             and do not die with the app. Handler was: {handler:?}"
        );
    }

    /// `kill` only delivers the signal. Without the `wait`, every stopped
    /// adapter stays a zombie for as long as Sway runs.
    #[test]
    fn stopping_a_server_reaps_it_rather_than_leaving_a_zombie() {
        let (mut server, _) = group_with_child();
        let pid = server.child.id();
        stop(&mut server);

        // A zombie still answers `kill -0`, so ask the process table what state
        // it is in rather than whether it is reachable.
        let out = Command::new("ps").args(["-o", "state=", "-p", &pid.to_string()]).output();
        let state = out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        assert!(!state.starts_with('Z'), "pid {pid} was left a zombie (state {state:?})");
    }

    /// A stopped server leaves nothing for a late `dap_connect` to dial, so a
    /// child session cannot attach to a corpse and sit there connected to a
    /// transport no frame will ever reach.
    #[test]
    fn stopping_a_server_removes_its_socket() {
        let (socket, _srv) = echo_listener(Duration::ZERO);
        connect_retry(&socket, CONNECT_TIMEOUT).unwrap();
        assert!(socket.exists());

        let (mut server, _) = group_with_child();
        server.socket = socket.clone();
        stop(&mut server);

        assert!(!socket.exists(), "the socket outlived the server that bound it");
        assert!(connect_retry(&socket, Duration::from_millis(200)).is_err());
    }

    #[test]
    fn a_handle_serializes_camel_case_for_the_frontend() {
        let handle = DapHandle {
            server: DapServerId("dap1".into()),
            session: "sess2".into(),
        };
        let json = serde_json::to_string(&handle).unwrap();
        assert_eq!(json, r#"{"server":"dap1","session":"sess2"}"#);
        assert_eq!(serde_json::from_str::<DapHandle>(&json).unwrap(), handle);
    }

    /// js-debug is a CommonJS bundle and ships no `package.json`, so node
    /// resolves the module system by walking up from the entry script. Inside
    /// this repo that walk reaches Sway's own `package.json`, finds
    /// `"type": "module"`, loads the adapter as ESM, and it dies on its first
    /// `require()` with "Dynamic require of \"fs\" is not supported".
    ///
    /// A boundary `package.json` beside the manifest stops the walk. It is
    /// tracked rather than written by the installer so that reinstalling, or
    /// wiping the extracted tree, cannot lose it.
    #[test]
    fn the_adapter_has_a_commonjs_boundary_inside_this_esm_package() {
        let root: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).unwrap();
        // If Sway ever stops being an ESM package this guard is moot, but it is
        // one today and that is what breaks the adapter.
        assert_eq!(root["type"], "module", "this test exists because the repo is ESM");

        let boundary: serde_json::Value =
            serde_json::from_str(include_str!("../resources/dap/package.json"))
                .expect("resources/dap/package.json parses");
        assert_eq!(
            boundary["type"], "commonjs",
            "the adapter is CommonJS and will not load without this boundary"
        );
    }

    /// The transport, driven against the **real adapter** rather than an echo
    /// listener.
    ///
    /// Every other test here proves the framing against `UnixListener`, which
    /// was written to answer and therefore always does. That is exactly the
    /// shape of failure this codebase has been bitten by before (a handshake
    /// that succeeds while the feature is silent), so this one asks js-debug
    /// itself and asserts a non-empty answer: a real `initialize` response
    /// carrying real capabilities.
    ///
    /// Skips rather than fails when the adapter is not installed, because the
    /// extracted bundle is gitignored and a fresh checkout has not run
    /// `pnpm dap:install` yet.
    #[test]
    fn the_real_adapter_answers_a_framed_initialize() {
        let entry = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/dap/"))
            .join(&registry::find("js-debug").unwrap().entry);
        if !entry.exists() {
            eprintln!("skipping: {} not installed (run `pnpm dap:install`)", entry.display());
            return;
        }

        let socket = socket_path().unwrap();
        let child = spawn_adapter(&entry, &socket, "/tmp");
        let Ok(child) = child else {
            eprintln!("skipping: node is not runnable here");
            return;
        };
        let mut server = Server { child, socket: socket.clone(), sessions: HashMap::new() };

        let mut stream = connect_retry(&socket, CONNECT_TIMEOUT).expect("the real adapter accepts");
        let (tx, rx) = mpsc::channel();
        pump_frames(stream.try_clone().unwrap(), move |b| {
            let _ = tx.send(b);
        });

        write_frame(
            &mut stream,
            r#"{"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"js-debug","clientID":"sway","linesStartAt1":true,"columnsStartAt1":true}}"#,
        )
        .unwrap();

        let reply = recv(&rx);
        let v: serde_json::Value = serde_json::from_str(&reply).expect("a JSON frame");
        assert_eq!(v["type"], "response", "got {reply}");
        assert_eq!(v["command"], "initialize");
        assert_eq!(v["success"], true);
        // Non-empty, not merely well-formed: an adapter that answered with no
        // capabilities at all would satisfy every assertion above.
        let caps = v["body"].as_object().expect("initialize returns capabilities");
        assert!(!caps.is_empty(), "the adapter advertised nothing: {reply}");

        stop(&mut server);
    }

    /// Every command this module defines has to be *registered*, or it does not
    /// exist to the frontend. Forgetting the line in `lib.rs` compiles cleanly
    /// and the caller sees a rejected promise, which for a debugger reads as
    /// "the debugger does not work" with nothing pointing at the cause.
    #[test]
    fn every_command_here_is_registered_with_the_app() {
        // Only the half above `#[cfg(test)]`: scanning the whole file means
        // scanning *this* function, whose own source mentions the attribute it
        // searches for.
        let module = include_str!("dap.rs").split("#[cfg(test)]").next().unwrap();
        let lib = include_str!("lib.rs");

        let defined: Vec<&str> = module
            .split("#[tauri::command]")
            .skip(1)
            .filter_map(|after| {
                let sig = after.split("fn ").nth(1)?;
                Some(sig.split(['(', '<', ' ']).next()?.trim())
            })
            .collect();

        assert!(
            defined.len() >= 6,
            "the parse found no commands, so this test proves nothing: {defined:?}"
        );
        let missing: Vec<&&str> =
            defined.iter().filter(|name| !lib.contains(&format!("dap::{name},"))).collect();
        assert!(missing.is_empty(), "add these to `generate_handler!` in lib.rs: {missing:?}");
    }

    /// The adapter has to be *bundled*, not merely present on this machine.
    ///
    /// `bundled_entry` falls back to `CARGO_MANIFEST_DIR`, so an adapter missing
    /// from `tauri.conf.json` resolves perfectly in every dev run and every test
    /// here, and is simply absent from the packaged app.
    #[test]
    fn the_debug_adapter_is_bundled_as_a_resource() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let resources = conf["bundle"]["resources"].as_array().expect("bundle.resources is a list");
        let listed: Vec<&str> = resources.iter().filter_map(|r| r.as_str()).collect();
        assert!(
            listed.iter().any(|r| r.starts_with("resources/dap/")),
            "the dap directory must be bundled, got {listed:?}"
        );

        // And the install step has to run before a build, or the bundle ships
        // a manifest describing an adapter that is not there.
        let build = conf["build"].as_object().expect("build");
        for key in ["beforeDevCommand", "beforeBuildCommand"] {
            let cmd = build[key].as_str().unwrap_or_default();
            assert!(cmd.contains("dap:install"), "{key} must run dap:install, got {cmd:?}");
        }
    }
}
