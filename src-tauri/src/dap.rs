// Debug adapter host. Spawns the adapters described by `dap/registry.rs` and
// bridges their DAP JSON to the frontend: frames are de-framed and pushed over a
// Channel, `dap_send` re-frames outgoing messages back onto the adapter.
//
// The framing is `lsp.rs`'s, byte for byte (Content-Length header, then body).
// A `stdio` adapter is a language server's pipe pair and nothing more. The
// bundled js-debug, which these notes were written against, differs in every
// other way, and a `tcp` adapter shares the first and last of them:
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

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

use crate::env::augmented_path;

mod cargo;
mod managed;
pub mod registry;

use registry::{DapAdapter, Install, Launch, Resolve};

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
    writer: Box<dyn Write + Send>,
}

struct Server {
    child: Child,
    /// The bundled adapter's socket, removed on stop.
    socket: Option<PathBuf>,
    child_sessions: bool,
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
    /// detachment means quitting Tori does not: without this, closing the window
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
/// workspace path: every other store in Tori is path-keyed, and following that
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
    let path = dir.join(format!("tori-dap-{unique}.sock"));
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

/// The launch program's path on this machine, by the adapter's resolver. The
/// health card asks this too, so a card never reads found for a program a start
/// would not find. `debuggers` is where Tori installs its own.
fn find_program(adapter: &DapAdapter, debuggers: &Path) -> Option<PathBuf> {
    let program = adapter.launch.program();
    match adapter.launch.resolve() {
        Resolve::Path => crate::env::resolve_binary(program),
        Resolve::Xcrun => xcrun_find(program).or_else(|| crate::env::resolve_binary(program)),
        Resolve::Managed => crate::lsp::managed::installed(debuggers, &adapter.id).map(|(bin, _)| bin),
    }
}

fn xcrun_find(program: &str) -> Option<PathBuf> {
    // `xcrun` opens Apple's installer when there are no developer tools, and
    // health asks on every Settings open, so it runs only once `xcode-select`
    // names a developer directory that exists.
    let dir = crate::env::output_with_timeout(Command::new("/usr/bin/xcode-select").arg("-p"))
        .filter(|o| o.status.success())?;
    if !Path::new(String::from_utf8_lossy(&dir.stdout).trim()).is_dir() {
        return None;
    }
    let out = crate::env::output_with_timeout(Command::new("xcrun").args(["-f", program]))?;
    if !out.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    (path.is_absolute() && path.is_file()).then_some(path)
}

/// Spawn an adapter at `root` in its own process group. stdout is always piped:
/// it is the DAP wire for a `stdio` adapter, and `log_stdout` drains it for the
/// others.
fn spawn_adapter(cmd: &mut Command, root: &str, stdin: Stdio) -> Result<Child, String> {
    cmd.current_dir(root)
        // The login-shell PATH, not the GUI process one: the adapter resolves
        // the debuggee's runtime (`node`, `pnpm`) from what it inherits, and a
        // Finder-launched Tori has almost nothing on PATH.
        .env("PATH", augmented_path())
        // Its own process group, so `stop` can take the debuggee with it.
        .process_group(0)
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn the debug adapter: {e}"))
}

/// Drain stdout so a chatty adapter cannot block on a full pipe, and log it
/// (js-debug's readiness line among it) for diagnostics. Nothing waits on this.
fn log_stdout(child: &mut Child) {
    if let Some(out) = child.stdout.take() {
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                eprintln!("[dap] {line}");
            }
        });
    }
}

/// Dial a listening adapter, retrying until it accepts.
///
/// Gives up as soon as `exited` reports the adapter gone, so one that never
/// came up, or lost the race for its port, reports at once rather than after
/// the full timeout.
fn dial<T>(
    mut connect: impl FnMut() -> std::io::Result<T>,
    mut exited: impl FnMut() -> Option<ExitStatus>,
    timeout: Duration,
) -> Result<T, String> {
    let start = Instant::now();
    loop {
        match connect() {
            Ok(s) => return Ok(s),
            Err(e) => {
                if let Some(status) = exited() {
                    return Err(format!("the debug adapter exited before accepting a connection ({status})"));
                }
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

/// Dial the bundled adapter's socket, retrying until it has bound it. Also what
/// a child session dials, with no process in hand to watch.
fn connect_retry(socket: &Path, timeout: Duration) -> Result<UnixStream, String> {
    dial(|| UnixStream::connect(socket), || None, timeout)
}

/// A port nothing listens on right now. It is released before the adapter binds
/// it, so another process can take it in between. That race is the price of
/// not reading the port out of the adapter's English stdout, which this host
/// never waits on.
fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("could not pick a port for the debug adapter: {e}"))?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// A started adapter: its process, both halves of its first session, and the
/// socket a child session dials, for the one kind that has one.
struct Started {
    child: Child,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    socket: Option<PathBuf>,
}

/// What a start of `adapter` runs: the bundled script (under `node`) for the
/// socket kind, else the adapter's own program, found by its resolver.
///
/// `bundled` is the one lookup that needs the app: where the bundled script is.
fn locate(adapter: &DapAdapter, bundled: impl FnOnce(&str) -> Option<PathBuf>) -> Result<PathBuf, String> {
    match &adapter.launch {
        Launch::BundledNodeSocket { entry, .. } => bundled(entry)
            .ok_or_else(|| format!("{}: bundled adapter not found (run `pnpm dap:install`)", adapter.id)),
        launch => find_program(adapter, &managed::debuggers_dir()).ok_or_else(|| {
            let program = launch.program();
            // A `managed` launch always has an install, so it never reaches the
            // PATH message.
            match (&adapter.install, launch.resolve()) {
                (Some(_), _) => crate::lsp::managed::NOT_INSTALLED.to_string(),
                (None, Resolve::Xcrun) => format!("{}: `{program}` was not found by xcrun or on your PATH", adapter.id),
                (None, _) => format!("{}: `{program}` was not found on your PATH", adapter.id),
            }
        }),
    }
}

/// Start `adapter` at `root` from what `locate` found, and open its first
/// session.
///
/// Free of Tauri types so every launch kind is testable without an app.
fn start_adapter(adapter: &DapAdapter, root: &str, located: &Path) -> Result<Started, String> {
    match &adapter.launch {
        Launch::BundledNodeSocket { .. } => {
            let socket = socket_path()?;
            let mut child = spawn_adapter(Command::new("node").arg(located).arg(&socket), root, Stdio::null())?;
            log_stdout(&mut child);
            let dialled = dial(|| UnixStream::connect(&socket), || child.try_wait().ok().flatten(), CONNECT_TIMEOUT)
                .and_then(|s| Ok((s.try_clone().map_err(|e| e.to_string())?, s)));
            let (reader, stream) = match dialled {
                Ok(pair) => pair,
                Err(e) => {
                    // The adapter is up but unreachable; do not leak it.
                    stop(&mut Server { child, socket: Some(socket), child_sessions: false, sessions: HashMap::new() });
                    return Err(e);
                }
            };
            Ok(Started { child, reader: Box::new(reader), writer: Box::new(stream), socket: Some(socket) })
        }
        Launch::Stdio { args, .. } => {
            let mut child = spawn_adapter(Command::new(located).args(args), root, Stdio::piped())?;
            let reader = child.stdout.take().ok_or("the debug adapter has no stdout")?;
            let writer = child.stdin.take().ok_or("the debug adapter has no stdin")?;
            Ok(Started { child, reader: Box::new(reader), writer: Box::new(writer), socket: None })
        }
        Launch::Tcp { args, .. } => {
            let port = free_port()?;
            let args = args.iter().map(|a| a.replace("{port}", &port.to_string()));
            let mut child = spawn_adapter(Command::new(located).args(args), root, Stdio::null())?;
            log_stdout(&mut child);
            let dialled =
                dial(|| TcpStream::connect(("127.0.0.1", port)), || child.try_wait().ok().flatten(), CONNECT_TIMEOUT)
                    .and_then(|s| Ok((s.try_clone().map_err(|e| e.to_string())?, s)));
            let (reader, stream) = match dialled {
                Ok(pair) => pair,
                Err(e) => {
                    stop(&mut Server { child, socket: None, child_sessions: false, sessions: HashMap::new() });
                    return Err(e);
                }
            };
            Ok(Started { child, reader: Box::new(reader), writer: Box::new(stream), socket: None })
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

/// Frame a message onto a session's write half.
fn write_frame(writer: &mut impl Write, message: &str) -> Result<(), String> {
    let header = format!("Content-Length: {}\r\n\r\n", message.len());
    writer.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    writer.write_all(message.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

/// Stop a server: kill its whole process group, reap it, and remove the socket.
///
/// The group kill is what takes a launched debuggee down with the adapter. The
/// `wait` is not optional bookkeeping: `kill` only delivers the signal, so
/// without reaping every stopped adapter stays a zombie for as long as Tori
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
    if let Some(socket) = &server.socket {
        let _ = std::fs::remove_file(socket);
    }
}

/// Everything `dap_start` settles before it spawns: the adapter, that it is on,
/// what it runs, that the project is trusted, and its root. Free of Tauri types,
/// so the refusals are testable without an app.
///
/// The program is located before the trust gate, so a missing one fails as
/// missing rather than as a trust prompt, the order `lsp_start` keeps.
fn prepare(
    adapter_id: &str,
    file_path: &str,
    project_path: &str,
    disabled: &[String],
    bundled: impl FnOnce(&str) -> Option<PathBuf>,
    gate: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(&'static DapAdapter, String, PathBuf), String> {
    let adapter = registry::find(adapter_id).ok_or_else(|| format!("no debug adapter registered as `{adapter_id}`"))?;
    if disabled.contains(&adapter.id) {
        return Err(format!("the {} debugger is off. Turn it on in Settings > Debuggers.", adapter.label));
    }
    let located = locate(adapter, bundled)?;
    gate(Path::new(project_path))?;
    let root = registry::root_for(adapter, Path::new(file_path), Path::new(project_path));
    Ok((adapter, root.to_string_lossy().into_owned(), located))
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
    let (adapter, root, located) = prepare(
        &adapter_id,
        &file_path,
        &project_path,
        &crate::settings::get_settings().dap.disabled,
        |rel| bundled_entry(&app, rel),
        crate::trust::gate_project,
    )?;
    let started = start_adapter(adapter, &root, &located)?;

    let handle = DapHandle {
        server: DapServerId(next_id("dap")),
        session: next_id("sess"),
    };
    pump_frames(started.reader, move |body| {
        let _ = on_message.send(body);
    });

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let server = guard.entry(handle.server.clone()).or_insert(Server {
        child: started.child,
        socket: started.socket,
        child_sessions: adapter.child_sessions,
        sessions: HashMap::new(),
    });
    server.sessions.insert(handle.session.clone(), Session { writer: started.writer });
    Ok(handle)
}

/// Where another session on `server` dials in. Only an adapter with
/// `child_sessions` takes a second connection; any other runs one session per
/// process.
fn child_socket(server: &Server) -> Option<&PathBuf> {
    server.socket.as_ref().filter(|_| server.child_sessions)
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
        let running = guard.get(&server).ok_or_else(|| format!("debug adapter {} is not running", server.0))?;
        child_socket(running)
            .ok_or_else(|| format!("debug adapter {} runs one session per process and cannot open another", server.0))?
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
    entry.sessions.insert(handle.session.clone(), Session { writer: Box::new(stream) });
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
    write_frame(&mut session.writer, &message)
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

/// The root a debug run for `file_path` resolves to.
///
/// Exposed as a command, which Phase 2 deliberately did not do. The reason it
/// held then was that a second implementation in TypeScript would be a second
/// answer; that is still true, and this is not one. The launch config's `cwd`
/// has to *be* this value, and it is built before `dap_start` is called, so the
/// alternative was re-deriving the walk in TypeScript, which is the thing the
/// original note was against.
#[tauri::command]
pub async fn dap_root_for(
    adapter_id: String,
    file_path: String,
    project_path: String,
) -> Result<String, String> {
    root_for_adapter(&adapter_id, &file_path, &project_path)
}

/// The synchronous half, so the walk is testable without a runtime. The command
/// above stays `async` for the reason every filesystem-touching command here
/// is: a synchronous one runs on the main thread.
fn root_for_adapter(adapter_id: &str, file_path: &str, project_path: &str) -> Result<String, String> {
    let adapter = registry::find(adapter_id)
        .ok_or_else(|| format!("no debug adapter registered as `{adapter_id}`"))?;
    let root = registry::root_for(
        adapter,
        std::path::Path::new(file_path),
        std::path::Path::new(project_path),
    );
    Ok(root.to_string_lossy().into_owned())
}

/// The interpreter a Python program is debugged on: the nearest `.venv` or
/// `venv` from `root` up to the project, else `python3` on the login PATH. Never
/// Tori's own venv, which holds the adapter and none of the project's packages.
#[tauri::command(async)]
pub fn dap_python(root: String, project_path: String) -> Option<String> {
    crate::format::project_bin("python3", Path::new(&root), Path::new(&project_path))
        .map(|p| p.to_string_lossy().into_owned())
}

/// The environment a launched debuggee should run with.
///
/// A map rather than a bare PATH string so a second variable later is a new key
/// rather than a new command. Today it is one entry, and it is the one that
/// matters: a GUI-launched Tori inherits a minimal PATH, so a debuggee that
/// shells out to `pnpm` fails to find it, which is the trap
/// `gotchas#gui-launched-processes-inherit-a-minimal-path` records.
///
/// The adapter is already spawned with this PATH and js-debug does pass its own
/// environment down, so this is belt *and* braces on purpose: the config saying
/// what it needs is what keeps it true when the adapter's spawn changes.
#[tauri::command]
pub async fn dap_launch_env() -> BTreeMap<String, String> {
    BTreeMap::from([("PATH".to_string(), augmented_path())])
}

// --- health ---

/// Per-adapter install state, mirroring `lsp::LspHealth` so the Settings cards
/// read the same way for a debug adapter as for a language server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapHealth {
    pub id: String,
    pub label: String,
    /// The binary that has to exist on this machine: `node` for the bundled
    /// adapter, which is a script, else the adapter's own program.
    pub program: String,
    pub status: crate::health::BinaryStatus,
    pub path: Option<String>,
    pub version: Option<String>,
    /// The bundled adapter's release, from the installer's manifest. `None` for
    /// an adapter Tori does not bundle.
    pub adapter_version: Option<String>,
    /// Extensions this adapter claims, for the card's chips.
    pub extensions: Vec<String>,
    /// What is wrong beyond a missing `program`: a bundle that was never
    /// installed (`node` resolves fine, so probing the program alone would
    /// report the card healthy while every `dap_start` fails), or Tori's own
    /// install that no longer imports what the launch runs.
    pub detail: Option<String>,
    /// Named in your `dap.disabled`.
    pub disabled: bool,
    /// The version Tori installs, for an adapter it installs itself.
    pub available_version: Option<String>,
    /// The version of Tori's own install, when there is one that runs.
    pub installed_version: Option<String>,
}

/// Build one adapter's health card.
///
/// `entry_missing` and `debuggers` are passed in rather than resolved here so
/// this stays free of `AppHandle` and testable off a real Tauri app and a real
/// home directory, exactly as `lsp::check` is.
fn check(adapter: &DapAdapter, entry_missing: bool, debuggers: &Path) -> DapHealth {
    let program = adapter.launch.program().to_string();
    let resolved = find_program(adapter, debuggers);
    // The package's version, and only once the module the launch runs imports:
    // `python --version` names Python, and says nothing about the adapter.
    let version = match (&adapter.install, resolved.as_deref()) {
        (Some(Install::Pip { package, .. }), Some(python)) => {
            adapter.launch.module().and_then(|module| managed::package_version(python, package, module))
        }
        (_, Some(path)) => crate::health::run_version(path),
        (_, None) => None,
    };
    let managed = adapter.launch.resolve() == Resolve::Managed;

    let detail = if entry_missing {
        Some("the bundled debug adapter is not installed (run `pnpm dap:install`)".to_string())
    } else if managed && resolved.is_some() && version.is_none() {
        Some(format!("Tori's copy of {} no longer runs. Install it again.", adapter.label))
    } else {
        None
    };

    // Runnable means *everything* is present. Reporting found on the strength
    // of `node` alone would send someone chasing a problem they do not have.
    let status = match (&resolved, &detail) {
        (None, _) | (Some(_), Some(_)) => crate::health::BinaryStatus::NotFound,
        (Some(_), None) => crate::health::compare(version.as_deref(), adapter.verified_against.as_deref()),
    };

    DapHealth {
        id: adapter.id.clone(),
        label: adapter.label.clone(),
        program,
        status,
        path: resolved.map(|p| p.to_string_lossy().into_owned()),
        adapter_version: match &adapter.launch {
            Launch::BundledNodeSocket { version, .. } => Some(version.clone()),
            Launch::Stdio { .. } | Launch::Tcp { .. } => None,
        },
        extensions: adapter.languages.keys().cloned().collect(),
        detail,
        disabled: false,
        available_version: adapter.install.as_ref().and_then(Install::available_version).map(str::to_string),
        installed_version: version.clone().filter(|_| managed),
        version,
    }
}

/// Health for every registered adapter. Not memoized, for `lsp_health`'s
/// reason: the sweep is one subprocess, and somebody who runs `pnpm dap:install`
/// while Tori is open should see the card change on the next Settings open.
#[tauri::command]
pub async fn dap_health(app: AppHandle) -> Vec<DapHealth> {
    let disabled = crate::settings::get_settings().dap.disabled;
    let debuggers = managed::debuggers_dir();
    registry::registry()
        .iter()
        .map(|adapter| {
            let entry_missing = match &adapter.launch {
                Launch::BundledNodeSocket { entry, .. } => bundled_entry(&app, entry).is_none(),
                Launch::Stdio { .. } | Launch::Tcp { .. } => false,
            };
            DapHealth { disabled: disabled.contains(&adapter.id), ..check(adapter, entry_missing, &debuggers) }
        })
        .collect()
}

/// Install Tori's own copy of an adapter, or replace it with the version this
/// build pins.
#[tauri::command(async)]
pub fn dap_install(adapter_id: String) -> Result<(), String> {
    let adapter =
        registry::find(&adapter_id).ok_or_else(|| format!("no debug adapter registered as `{adapter_id}`"))?;
    managed::install(adapter, &managed::debuggers_dir()).map(|_| ())
}

/// Remove Tori's own copy of an adapter.
#[tauri::command(async)]
pub fn dap_uninstall(adapter_id: String) -> Result<(), String> {
    registry::find(&adapter_id).ok_or_else(|| format!("no debug adapter registered as `{adapter_id}`"))?;
    crate::lsp::managed::remove(&managed::debuggers_dir(), &adapter_id)
}

/// The binaries of the Cargo package at `root`, for the target picker.
#[tauri::command(async)]
pub fn dap_cargo_bins(root: String, project_path: String) -> Result<Vec<String>, String> {
    crate::trust::gate_project(Path::new(&project_path))?;
    cargo::bins(Path::new(&root))
}

/// Build `bin` in the package at `root` so it can be debugged, sending each
/// line cargo prints to `on_line`. `build_id` is what `dap_cargo_cancel` stops
/// it by.
#[tauri::command(async)]
pub fn dap_cargo_build(
    root: String,
    project_path: String,
    bin: String,
    build_id: String,
    on_line: Channel<String>,
) -> Result<cargo::Built, String> {
    crate::trust::gate_project(Path::new(&project_path))?;
    cargo::build(Path::new(&root), &bin, &build_id, |line| {
        let _ = on_line.send(line.to_string());
    })
}

#[tauri::command]
pub fn dap_cargo_cancel(build_id: String) {
    cargo::cancel(&build_id);
}

/// A program to debug, chosen in a native file picker opened at `root`. `None`
/// when the pick is cancelled, as `pick_icon_file` answers.
#[tauri::command(async)]
pub fn dap_pick_program(root: String) -> Result<Option<String>, String> {
    // `root` travels as an argument rather than inside the script, so no path
    // can break out of the AppleScript string.
    let out = Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "POSIX path of (choose file with prompt \"Choose the program to debug\" default location (POSIX file (item 1 of argv)))",
            "-e",
            "end run",
            &root,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((out.status.success() && !path.is_empty()).then_some(path))
}

#[cfg(test)]
mod test_client;

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

        // Two calls never collide, which is what lets one Tori run many sessions.
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
        let server = Server { child, socket: None, child_sessions: false, sessions: HashMap::new() };
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
    /// process Tori never started.
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
    /// adapter stays a zombie for as long as Tori runs.
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
        server.socket = Some(socket.clone());
        stop(&mut server);

        assert!(!socket.exists(), "the socket outlived the server that bound it");
        assert!(connect_retry(&socket, Duration::from_millis(200)).is_err());
    }

    /// An adapter built from a TOML launch table, for the transport tests.
    fn adapter(launch: &str) -> DapAdapter {
        let text = format!(
            "schema_version = 1\nid = \"echo\"\nlabel = \"Echo\"\nroot_markers = [\".git\"]\n\
             [languages]\necho = \"echo\"\n[launch]\n{launch}\n"
        );
        registry::load_adapter_str(&text, "test").unwrap()
    }

    fn round_trip(started: Started) -> String {
        let Started { child, reader, mut writer, socket } = started;
        let (tx, rx) = mpsc::channel();
        pump_frames(reader, move |b| {
            let _ = tx.send(b);
        });
        write_frame(&mut writer, r#"{"seq":1,"type":"request"}"#).unwrap();
        let echoed = recv(&rx);
        stop(&mut Server { child, socket, child_sessions: false, sessions: HashMap::new() });
        echoed
    }

    #[test]
    fn a_stdio_adapter_round_trips_a_frame_over_its_pipes() {
        let cat = adapter("kind = \"stdio\"\nprogram = \"cat\"");
        let started = start_adapter(&cat, "/tmp", &locate(&cat, |_| None).unwrap()).expect("cat starts");
        assert!(started.socket.is_none());
        assert_eq!(round_trip(started), r#"{"seq":1,"type":"request"}"#);
    }

    /// Echoes one connection on the port in its first argument, standing in
    /// for `dlv dap --listen`. Perl because every Mac has it.
    const TCP_ECHO: &str = r#"$s = IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => $ARGV[0], Listen => 1, ReuseAddr => 1) or die; $c = $s->accept; while (sysread($c, $d, 4096)) { syswrite($c, $d) }"#;

    #[test]
    fn a_tcp_adapter_is_dialled_on_the_port_tori_picked() {
        let echo = adapter(&format!(
            "kind = \"tcp\"\nprogram = \"perl\"\nargs = [\"-MIO::Socket::INET\", \"-e\", '{TCP_ECHO}', \"{{port}}\"]"
        ));
        let located = locate(&echo, |_| None).unwrap();
        let started = start_adapter(&echo, "/tmp", &located).expect("the echo adapter accepts");
        assert_eq!(round_trip(started), r#"{"seq":1,"type":"request"}"#);
    }

    /// A lost port race, or an adapter that never ran, fails as soon as the
    /// process is gone rather than after the full connect timeout.
    #[test]
    fn a_tcp_adapter_that_exits_at_once_fails_well_inside_the_timeout() {
        let gone = adapter("kind = \"tcp\"\nprogram = \"false\"\nargs = [\"{port}\"]");
        let began = Instant::now();
        let err = start_adapter(&gone, "/tmp", &locate(&gone, |_| None).unwrap()).err().expect("nothing ever listens");
        assert!(err.contains("exited before accepting"), "got {err}");
        assert!(began.elapsed() < CONNECT_TIMEOUT / 5, "took {:?}", began.elapsed());
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
    /// this repo that walk reaches Tori's own `package.json`, finds
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
        // If Tori ever stops being an ESM package this guard is moot, but it is
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
        let js = registry::find("js-debug").unwrap();
        let Launch::BundledNodeSocket { entry, .. } = &js.launch else {
            panic!("js-debug should be bundled_node_socket, got {:?}", js.launch);
        };
        if test_client::dev_bundled(entry).is_none() {
            eprintln!("skipping: {entry} not installed (run `pnpm dap:install`)");
            return;
        }
        if crate::env::resolve_binary("node").is_none() {
            eprintln!("skipping: node is not runnable here");
            return;
        }

        let located = locate(js, test_client::dev_bundled).expect("the bundle is installed");
        let started = start_adapter(js, "/tmp", &located).expect("the real adapter accepts");
        let mut writer = started.writer;
        let mut server = Server {
            child: started.child,
            socket: started.socket,
            child_sessions: js.child_sessions,
            sessions: HashMap::new(),
        };
        let (tx, rx) = mpsc::channel();
        pump_frames(started.reader, move |b| {
            let _ = tx.send(b);
        });

        write_frame(
            &mut writer,
            r#"{"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"js-debug","clientID":"tori","linesStartAt1":true,"columnsStartAt1":true}}"#,
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
            .split("#[tauri::command")
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

    /// The health card's whole job: `node` being present is not the same as the
    /// debugger working, and a card that reads healthy while every start fails
    /// sends someone chasing a problem they do not have.
    #[test]
    fn an_uninstalled_bundle_reads_not_found_even_though_node_is_here() {
        let adapter = registry::find("js-debug").expect("js-debug is registered");

        let missing = check(adapter, true, Path::new("/nonexistent"));
        assert!(matches!(missing.status, crate::health::BinaryStatus::NotFound));
        let detail = missing.detail.expect("a missing bundle explains itself");
        // Actionable, not merely negative: the message names the command that
        // fixes it, the way `lsp_health`'s does.
        assert!(detail.contains("dap:install"), "unhelpful detail: {detail}");

        let installed = check(adapter, false, Path::new("/nonexistent"));
        assert!(installed.detail.is_none());
        assert_eq!(installed.program, "node");
        let Launch::BundledNodeSocket { version, .. } = &adapter.launch else { panic!("{:?}", adapter.launch) };
        assert_eq!(installed.adapter_version.as_ref(), Some(version));
        assert!(installed.extensions.contains(&"ts".to_string()));
    }

    #[test]
    fn debugpy_reads_found_only_while_toris_own_venv_runs() {
        use crate::health::BinaryStatus;
        use std::os::unix::fs::PermissionsExt;

        let debugpy = registry::find("debugpy").expect("debugpy is registered");
        let pinned = debugpy.install.as_ref().and_then(Install::available_version).unwrap().to_string();
        let dir = std::env::temp_dir().join(format!("tori-dap-health-{}-{}", std::process::id(), next_id("t")));

        let without = check(debugpy, false, &dir);
        assert!(matches!(without.status, BinaryStatus::NotFound));
        assert_eq!(without.available_version.as_deref(), Some(pinned.as_str()));
        assert_eq!(without.installed_version, None);

        // A stand-in for the venv's interpreter: `script` is its whole behaviour.
        let install = |script: &str| {
            crate::lsp::managed::install_staged(&dir, "debugpy", |staging| {
                let python = staging.join("venv/bin/python");
                std::fs::create_dir_all(python.parent().unwrap()).unwrap();
                std::fs::write(&python, format!("#!/bin/sh\n{script}\n")).unwrap();
                std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
                Ok(crate::lsp::managed::Installed { version: pinned.clone(), bin: "venv/bin/python".into() })
            })
            .unwrap();
        };

        install(&format!("echo {pinned}"));
        let with = check(debugpy, false, &dir);
        assert!(matches!(with.status, BinaryStatus::VersionMatch), "{:?}", with.status);
        assert_eq!(with.path, Some(dir.join("debugpy/venv/bin/python").to_string_lossy().into_owned()));
        assert_eq!(with.installed_version.as_deref(), Some(pinned.as_str()));
        assert!(with.detail.is_none());

        install("exit 1");
        let broken = check(debugpy, false, &dir);
        assert!(matches!(broken.status, BinaryStatus::NotFound));
        assert_eq!(broken.installed_version, None);
        assert!(broken.detail.is_some_and(|d| d.contains("no longer runs")));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_xcrun_adapter_reads_not_found_when_neither_xcrun_nor_the_path_has_it() {
        let mut lldb = registry::find("lldb").expect("lldb is registered").clone();
        let Launch::Stdio { args, resolve, .. } = &lldb.launch else { panic!("{:?}", lldb.launch) };
        assert_eq!(*resolve, Resolve::Xcrun);
        lldb.launch = Launch::Stdio { program: "tori-no-such-lldb-dap".into(), args: args.clone(), resolve: Resolve::Xcrun };

        let health = check(&lldb, false, Path::new("/nonexistent"));
        assert!(matches!(health.status, crate::health::BinaryStatus::NotFound), "{:?}", health.status);
        assert_eq!(health.path, None);
    }

    #[test]
    fn the_launch_env_carries_the_login_shell_path() {
        let env = BTreeMap::from([("PATH".to_string(), augmented_path())]);
        let path = env.get("PATH").expect("PATH");
        // The GUI process's own PATH is the minimal one; a debuggee that shells
        // out to `pnpm` needs the dirs a login shell would have.
        assert!(path.contains("/.volta/bin") || path.contains("/opt/homebrew/bin"), "{path}");
    }

    /// `cwd` for a launch config comes from here, and in a monorepo the wrong
    /// answer costs module resolution and source-map location at once.
    #[test]
    fn the_root_command_answers_the_package_not_the_workspace() {
        let tmp = std::env::temp_dir().join(format!(
            "tori-dap-rootcmd-{}-{}",
            std::process::id(),
            next_id("t")
        ));
        let api = tmp.join("packages/api/src");
        std::fs::create_dir_all(&api).unwrap();
        std::fs::write(tmp.join("package.json"), "{}").unwrap();
        std::fs::write(tmp.join("packages/api/package.json"), "{}").unwrap();
        let file = api.join("x.ts");
        std::fs::write(&file, "").unwrap();

        let root = root_for_adapter(
            "js-debug",
            &file.to_string_lossy(),
            &tmp.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(root, tmp.join("packages/api").to_string_lossy());

        assert!(root_for_adapter("nope", "/a", "/a").is_err());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn an_untrusted_project_is_refused_before_spawning_but_after_a_missing_program() {
        let untrusted = |_: &Path| Err(crate::trust::UNTRUSTED.to_string());
        let found = |_: &str| Some(PathBuf::from("/bundled/dapDebugServer.js"));

        let mut gated = None;
        let refused = prepare("js-debug", "/p/a.ts", "/p", &[], found, |project| {
            gated = Some(project.to_path_buf());
            untrusted(project)
        });
        assert_eq!(refused.err().as_deref(), Some(crate::trust::UNTRUSTED));
        assert_eq!(gated.as_deref(), Some(Path::new("/p")));

        let missing = prepare("js-debug", "/p/a.ts", "/p", &[], |_| None, untrusted).err().unwrap();
        assert!(missing.contains("bundled adapter not found"), "got {missing}");

        let off = prepare("js-debug", "/p/a.ts", "/p", &["js-debug".to_string()], found, untrusted).err().unwrap();
        assert!(off.contains("debugger is off"), "got {off}");
    }
}
