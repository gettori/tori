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

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::env::augmented_path;

pub mod managed;
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

/// What `lsp_start` answers: the handle, and this start's
/// `initializationOptions` with every placeholder resolved for that root. The
/// frontend sends these rather than the registry's copy, which cannot know a
/// per-root path.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStarted {
    pub handle: LspHandle,
    pub initialization_options: Option<serde_json::Value>,
}

pub struct LspSession {
    child: Child,
    stdin: ChildStdin,
    // A handle outlives its process: after a stop and a start, a late EOF from
    // the old process must not reap the new one.
    serial: u64,
}

static NEXT_SERIAL: AtomicU64 = AtomicU64::new(0);

const LOG_CAP: usize = 64 * 1024;

type Log = Arc<Mutex<VecDeque<u8>>>;

// Logs are not dropped with their session, because the one worth reading is
// the one that explains why a server just died.
#[derive(Default)]
pub struct LspState {
    sessions: Mutex<HashMap<LspHandle, LspSession>>,
    logs: Mutex<HashMap<LspHandle, Log>>,
}

/// What `lsp://exited` carries. `deliberate` is decided here because only this
/// side knows: `lsp_stop_all` sweeps before the frontend's teardown finishes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspExited {
    pub handle: LspHandle,
    pub status: Option<String>,
    pub deliberate: bool,
}

const EXITED: &str = "lsp://exited";

impl LspState {
    fn stop(&self, handle: &LspHandle) -> Result<Option<LspExited>, String> {
        let session = self.sessions.lock().map_err(|e| e.to_string())?.remove(handle);
        Ok(session.map(|mut s| LspExited {
            handle: handle.clone(),
            status: stop(&mut s),
            deliberate: true,
        }))
    }

    fn stop_all(&self) -> Result<Vec<LspExited>, String> {
        let drained: Vec<_> = self.sessions.lock().map_err(|e| e.to_string())?.drain().collect();
        Ok(drained
            .into_iter()
            .map(|(handle, mut s)| LspExited {
                status: stop(&mut s),
                handle,
                deliberate: true,
            })
            .collect())
    }

    /// A session whose stdout closed. `None` when a deliberate stop already
    /// took it out of the map, since that stop reports it.
    fn reap(&self, handle: &LspHandle, serial: u64) -> Option<LspExited> {
        let mut session = {
            let mut sessions = self.sessions.lock().ok()?;
            if sessions.get(handle)?.serial != serial {
                return None;
            }
            sessions.remove(handle)?
        };
        Some(LspExited {
            handle: handle.clone(),
            status: stop(&mut session),
            deliberate: false,
        })
    }

    fn log(&self, handle: &LspHandle) -> String {
        let tail = self.logs.lock().ok().and_then(|logs| {
            let tail: Vec<u8> = logs.get(handle)?.lock().ok()?.iter().copied().collect();
            Some(tail)
        });
        String::from_utf8_lossy(&tail.unwrap_or_default()).into_owned()
    }

    fn note(&self, handle: &LspHandle, line: &str) {
        let Ok(logs) = self.logs.lock() else { return };
        let Some(log) = logs.get(handle) else { return };
        let Ok(mut tail) = log.lock() else { return };
        tail.extend(line.as_bytes());
        tail.push_back(b'\n');
        let over = tail.len().saturating_sub(LOG_CAP);
        tail.drain(..over);
    }
}

const TSDK_PLACEHOLDER: &str = "${tsdk}";
const BUNDLED_TSDK: &str = "resources/lsp/node_modules/typescript/lib";

/// The `typescript/lib` a Volar-style server should load: the project's own,
/// walking from the server's root up to the project, else Tori's bundled copy.
/// The project's wins so the server's type errors agree with the project's
/// `tsc`; most Astro projects have none, since `astro` does not depend on
/// `typescript`, which is why the bundled copy is not optional.
fn tsdk_for(root: &Path, project: &Path, bundled: Option<PathBuf>) -> Option<PathBuf> {
    // A root outside the project would walk to `/` and could pick up a stray
    // `~/node_modules/typescript`, so the walk is skipped rather than unbounded.
    if root.starts_with(project) {
        let mut dir = Some(root);
        while let Some(current) = dir {
            let lib = current.join("node_modules").join("typescript").join("lib");
            if lib.join("typescript.js").is_file() {
                return Some(lib);
            }
            if current == project {
                break;
            }
            dir = current.parent();
        }
    }
    bundled.filter(|lib| lib.join("typescript.js").is_file())
}

/// `options` with every `${tsdk}` inside a string replaced by the resolved
/// `typescript/lib`. A config without the placeholder passes through untouched
/// and never resolves anything. Returns the path used, for the session log.
fn resolve_tsdk(
    options: Option<&serde_json::Value>,
    root: &Path,
    project: &Path,
    bundled: Option<PathBuf>,
) -> Result<(Option<serde_json::Value>, Option<PathBuf>), String> {
    fn mentions(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::String(s) => s.contains(TSDK_PLACEHOLDER),
            serde_json::Value::Array(items) => items.iter().any(mentions),
            serde_json::Value::Object(map) => map.values().any(mentions),
            _ => false,
        }
    }
    fn substitute(value: &serde_json::Value, tsdk: &str) -> serde_json::Value {
        match value {
            serde_json::Value::String(s) => serde_json::Value::String(s.replace(TSDK_PLACEHOLDER, tsdk)),
            serde_json::Value::Array(items) => {
                serde_json::Value::Array(items.iter().map(|v| substitute(v, tsdk)).collect())
            }
            serde_json::Value::Object(map) => {
                serde_json::Value::Object(map.iter().map(|(k, v)| (k.clone(), substitute(v, tsdk))).collect())
            }
            other => other.clone(),
        }
    }

    let Some(options) = options else {
        return Ok((None, None));
    };
    if !mentions(options) {
        return Ok((Some(options.clone()), None));
    }
    let tsdk = tsdk_for(root, project, bundled).ok_or_else(|| {
        format!(
            "no TypeScript for `{TSDK_PLACEHOLDER}`: this project has no node_modules/typescript and Tori's bundled copy is missing (run `pnpm lsp:install`)"
        )
    })?;
    let resolved = substitute(options, &tsdk.to_string_lossy());
    Ok((Some(resolved), Some(tsdk)))
}

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
fn command_for(app: &AppHandle, server: &LspServer, root: &Path, project: &Path) -> Result<Command, String> {
    match &server.launch {
        Launch::BundledNode { entry, args } => {
            let path = bundled_entry(app, entry)
                .ok_or_else(|| format!("{}: bundled server not found (run `pnpm lsp:install`)", server.id))?;
            let mut cmd = Command::new("node");
            cmd.arg(path).args(args);
            Ok(cmd)
        }
        Launch::Path { program, args } => {
            // The login-shell PATH, never the GUI process PATH: a server
            // installed via rustup/mise/asdf is invisible to a naive lookup
            // from a Finder-launched app, and reporting it missing would send
            // the user chasing a problem that is not there.
            let path = crate::env::resolve_binary(program)
                .ok_or_else(|| format!("{}: `{program}` was not found on your PATH", server.id))?;
            let mut cmd = Command::new(path);
            cmd.args(args);
            Ok(cmd)
        }
        Launch::ProjectBin { program, args } => {
            let path = crate::format::project_bin(program, root, project).ok_or_else(|| {
                format!(
                    "{}: `{program}` is not installed in this project or on your PATH",
                    server.id
                )
            })?;
            let mut cmd = Command::new(path);
            cmd.args(args);
            Ok(cmd)
        }
        Launch::Managed { .. } => managed::command(server, &managed::servers_dir()),
    }
}

/// Spawn a server rooted at `root`, returning the session plus its stdout and
/// stderr.
fn spawn_session(mut cmd: Command, root: &str) -> Result<(LspSession, ChildStdout, ChildStderr), String> {
    let mut child = cmd
        .current_dir(root)
        .env("PATH", augmented_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn the language server: {e}"))?;

    let stdout = child.stdout.take().ok_or("language server has no stdout")?;
    let stderr = child.stderr.take().ok_or("language server has no stderr")?;
    let stdin = child.stdin.take().ok_or("language server has no stdin")?;
    let serial = NEXT_SERIAL.fetch_add(1, Ordering::Relaxed);
    Ok((LspSession { child, stdin, serial }, stdout, stderr))
}

/// Keep the last `LOG_CAP` bytes of `stderr` in `log`. A server that is never
/// read from blocks once the pipe fills, so this drains it whether or not
/// anyone ever asks for the log.
fn pump_log<R: Read + Send + 'static>(mut stderr: R, log: Log) {
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            let n = match stderr.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            let Ok(mut tail) = log.lock() else { return };
            tail.extend(&buf[..n]);
            let over = tail.len().saturating_sub(LOG_CAP);
            tail.drain(..over);
        }
    });
}

/// Read LSP frames (Content-Length header + body) off `stdout` and hand each
/// JSON body to `sink`. Calls `on_eof` when the stream ends, i.e. when the
/// server stops.
///
/// Generic over the sink so the framing can be tested against a plain pipe,
/// with no Tauri `Channel` and no real language server involved.
fn pump_frames<R: Read + Send + 'static>(
    stdout: R,
    sink: impl Fn(String) + Send + 'static,
    on_eof: impl FnOnce() + Send + 'static,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        'frames: loop {
            let mut content_length = 0usize;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break 'frames,
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
                break;
            }
            sink(String::from_utf8_lossy(&body).into_owned());
        }
        on_eof();
    });
}

/// Stop a session: signal it, then reap it. Returns how it ended.
///
/// The `wait` is not optional bookkeeping. `kill` only delivers the signal, so
/// without reaping, every stopped server stays a zombie for as long as Tori
/// runs, and a session-per-root registry stops far more servers than the old
/// one-server host ever did.
fn stop(session: &mut LspSession) -> Option<String> {
    let _ = session.child.kill();
    session.child.wait().ok().map(|s| s.to_string())
}

/// Put a freshly spawned session in the map, unless another start won the race
/// for the same handle while we were spawning.
///
/// Returns whether `session` was installed. When it was not, the loser is
/// **killed here**, not dropped: `std::process::Child` has no `Drop` that stops
/// the process, so overwriting the map entry would leave a second language
/// server running with nothing able to reach it. For rust-analyzer that is an
/// orphan indexing a project at full tilt until the user logs out.
fn install_session(sessions: &mut HashMap<LspHandle, LspSession>, handle: &LspHandle, mut session: LspSession) -> bool {
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
#[tauri::command(async)]
pub fn lsp_start(
    app: AppHandle,
    state: State<LspState>,
    server_id: String,
    file_path: String,
    project_path: String,
    on_message: Channel<String>,
) -> Result<LspStarted, String> {
    let server = registry::find(&server_id).ok_or_else(|| format!("no lsp server registered as `{server_id}`"))?;
    let project = Path::new(&project_path);
    let root = registry::root_for(server, Path::new(&file_path), project);
    // Before the trust gate, so a missing server fails as missing, not as a trust
    // prompt. No lock: a login-shell lookup is too slow to hold every other send
    // behind, and `install_session` settles two starts that race to one handle.
    let cmd = command_for(&app, server, &root, project)?;
    crate::trust::gate(server, project)?;
    // After both, so an uninstalled server still fails as `not_installed`.
    let (initialization_options, tsdk) = resolve_tsdk(
        server.initialization_options.as_ref(),
        &root,
        project,
        bundled_entry(&app, BUNDLED_TSDK),
    )
    .map_err(|e| format!("{}: {e}", server.id))?;

    let handle = LspHandle {
        server_id: server_id.clone(),
        root: root.to_string_lossy().into_owned(),
    };

    let exit_handle = handle.clone();
    let started = start_session(
        &state,
        &handle,
        cmd,
        move |body| {
            let _ = on_message.send(body);
        },
        move |serial| {
            if let Some(exited) = app.state::<LspState>().reap(&exit_handle, serial) {
                let _ = app.emit(EXITED, exited);
            }
        },
    )?;
    if let (true, Some(tsdk)) = (started, tsdk) {
        state.note(&handle, &format!("tori: typescript.tsdk = {}", tsdk.display()));
    }
    Ok(LspStarted {
        handle,
        initialization_options,
    })
}

/// Spawn and install a session for `handle`, unless one is already live.
///
/// The pumps start only once the session is in the map. A server that dies on
/// launch, as a rustup proxy with no component does, would otherwise reach EOF
/// before it was installed, and the dead session would then answer every later
/// start.
fn start_session(
    state: &LspState,
    handle: &LspHandle,
    cmd: Command,
    sink: impl Fn(String) + Send + 'static,
    on_eof: impl FnOnce(u64) + Send + 'static,
) -> Result<bool, String> {
    if state.sessions.lock().map_err(|e| e.to_string())?.contains_key(handle) {
        return Ok(false);
    }

    let (session, stdout, stderr) = spawn_session(cmd, &handle.root)?;
    let serial = session.serial;
    let log = Log::default();
    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if !install_session(&mut sessions, handle, session) {
            return Ok(false);
        }
        state
            .logs
            .lock()
            .map_err(|e| e.to_string())?
            .insert(handle.clone(), log.clone());
    }
    pump_log(stderr, log);
    pump_frames(stdout, sink, move || on_eof(serial));
    Ok(true)
}

#[tauri::command]
pub fn lsp_send(state: State<LspState>, handle: LspHandle, message: String) -> Result<(), String> {
    let mut guard = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = guard
        .get_mut(&handle)
        .ok_or_else(|| format!("{} is not running at {}", handle.server_id, handle.root))?;
    write_frame(&mut session.stdin, &message)
}

#[tauri::command(async)]
pub fn lsp_stop(app: AppHandle, state: State<LspState>, handle: LspHandle) -> Result<(), String> {
    if let Some(exited) = state.stop(&handle)? {
        let _ = app.emit(EXITED, exited);
    }
    Ok(())
}

/// Stop every running session. What a project switch calls: the old project's
/// servers are all wrong at once, and there is no per-handle bookkeeping the
/// caller would have to keep in step.
#[tauri::command(async)]
pub fn lsp_stop_all(app: AppHandle, state: State<LspState>) -> Result<(), String> {
    for exited in state.stop_all()? {
        let _ = app.emit(EXITED, exited);
    }
    Ok(())
}

/// The tail of a server's stderr, still there after the server has exited.
#[tauri::command]
pub fn lsp_log(state: State<LspState>, handle: LspHandle) -> String {
    state.log(&handle)
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

/// Where this build's settings schemas live, or `None` if they are not there.
///
/// The frontend pairs this directory with the filenames in
/// `utils/toriSettingsFiles.ts` and sends the result as more
/// `json/schemaAssociations`. Only the *path* comes from here, because
/// resolving a bundled resource is the one part of the job that needs to know
/// whether this is a packaged app or a `cargo run`, and `bundled_entry` already
/// answers that for the language servers next door.
///
/// `None` rather than a guess: a missing resource directory costs completion in
/// two files, and inventing a path for the server to fail to read would turn
/// that into an error with nothing behind it.
/// `async` for `lsp_health`'s reason, which resolves the same bundled paths: a
/// synchronous command runs on the main thread, and `bundled_entry` touches the
/// filesystem. One stat is nothing next to Phase 5's fetch, but the reason this
/// is a convention is that nobody weighs it call by call.
#[tauri::command]
pub async fn lsp_schema_dir(app: AppHandle) -> Option<String> {
    bundled_entry(&app, "resources/schemas").map(|p| p.to_string_lossy().into_owned())
}

// --- health ---

/// Per-server install state, mirroring `crate::health::AgentHealth` so the
/// Settings cards read the same way for a language server as for an agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHealth {
    pub id: String,
    pub label: String,
    /// A secondary is a linter beside the language's own server.
    pub role: registry::Role,
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
    /// Named in `lsp.disabled`, the user's or the workspace's.
    pub disabled: bool,
    /// Named only in the workspace's list, which the user's settings cannot
    /// switch back on.
    pub disabled_by_workspace: bool,
    /// Whether it starts depends on the project, so a probe from Settings,
    /// which has no project, cannot say it is missing. A key reads as
    /// `pyproject.toml [tool.ruff]`.
    pub activation_markers: Vec<String>,
    /// Launched from the project's own install before the PATH, so a probe
    /// from Settings, which has no project, cannot say it is missing.
    pub runs_per_project: bool,
    /// How to install it, for a server its own toolchain manages.
    pub hint: Option<String>,
    /// The version Tori can install on this machine.
    pub available_version: Option<String>,
    /// The version of Tori's own copy, when that is the one that runs: a copy
    /// on the login PATH wins, and then this is `None`.
    pub installed_version: Option<String>,
    /// Its toolchain's commands to update and to remove it, for a hint server
    /// that is found. A wrong guess about how it got installed fails in the
    /// terminal it runs in.
    pub update: Option<String>,
    pub uninstall: Option<String>,
}

// rustup links a proxy for tools whose component is not installed, and that proxy
// only prints an error and exits. `--version` cannot tell, since a working server
// may refuse the flag (sourcekit-lsp exits 64 on it), so ask rustup itself.
fn missing_rustup_component(path: &Path) -> Option<String> {
    let rustup = path.with_file_name("rustup");
    if path == rustup || !same_file(path, &rustup) {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().into_owned();
    let out = crate::env::output_with_timeout(Command::new(&rustup).arg("which").arg(&name))?;
    (!out.status.success())
        .then(|| format!("`{name}` on your PATH is rustup's proxy, and the {name} component is not installed."))
}

// Metadata rather than the paths: rustup links its proxies as symlinks on some
// installs and hard links on others.
fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(a), std::fs::metadata(b)) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
    }
}

/// Build one server's health card.
///
/// `bundled_entry_missing` is passed in rather than resolved here so this stays
/// free of `AppHandle` and testable off a real Tauri app.
fn check(
    server: &LspServer,
    bundled_entry_missing: bool,
    installed: Option<(PathBuf, managed::Installed)>,
) -> LspHealth {
    let program = server.launch.program().to_string();
    let on_path = crate::env::resolve_binary(&program);
    let proxy_gap = on_path.as_deref().and_then(missing_rustup_component);
    // Tori's copy only counts when nothing on the PATH shadows it, and its
    // version comes from the manifest: `--version` on a script started without
    // its runtime would report nothing.
    let installed = installed.filter(|_| on_path.is_none());
    let (resolved, version) = match (on_path, &installed) {
        (Some(path), _) => {
            let version = crate::health::run_version(&path);
            (Some(path), version)
        }
        (None, Some((bin, manifest))) => (Some(bin.clone()), Some(manifest.version.clone())),
        (None, None) => (None, None),
    };

    let detail = bundled_entry_missing
        .then(|| "the bundled server is not installed (run `pnpm lsp:install`)".to_string())
        .or(proxy_gap);

    // A server is only runnable when *everything* it needs is present. A
    // bundled server needs its interpreter and its entry script, and reporting
    // it found on the strength of the interpreter alone would send the user
    // chasing a problem that is not the one they have. Same rule `health.rs`
    // states for agents, applied to the second thing a server can be missing.
    let (update, uninstall) = match &server.install {
        Some(registry::Install::Hint { update, uninstall, .. }) if resolved.is_some() && detail.is_none() => {
            (update.clone(), uninstall.clone())
        }
        _ => (None, None),
    };

    let status = match (&resolved, &detail) {
        (None, _) | (Some(_), Some(_)) => crate::health::BinaryStatus::NotFound,
        (Some(_), None) => crate::health::compare(version.as_deref(), server.verified_against.as_deref()),
    };

    LspHealth {
        id: server.id.clone(),
        label: server.label.clone(),
        role: server.role,
        program,
        status,
        path: resolved.map(|p| p.to_string_lossy().into_owned()),
        version,
        verified_against: server.verified_against.clone(),
        extensions: server.languages.keys().cloned().collect(),
        detail,
        override_path: server.is_override().then(|| server.source.clone()),
        disabled: false,
        disabled_by_workspace: false,
        activation_markers: server
            .activation_markers
            .iter()
            .cloned()
            .chain(
                server
                    .activation_keys
                    .iter()
                    .map(|k| format!("{} [{}]", k.file, k.path.join("."))),
            )
            .collect(),
        runs_per_project: matches!(server.launch, Launch::ProjectBin { .. }),
        hint: match &server.install {
            Some(registry::Install::Hint { text, .. }) => Some(text.clone()),
            _ => None,
        },
        available_version: server
            .install
            .as_ref()
            .and_then(|i| i.available_version())
            .map(str::to_string),
        installed_version: installed.map(|(_, manifest)| manifest.version),
        update,
        uninstall,
    }
}

/// Health for every registered server. Not memoized the way `agent_health` is:
/// the sweep is two subprocesses at most, and a user who installs
/// rust-analyzer while Tori is open should see the card change on the next
/// Settings open rather than after a restart.
#[tauri::command]
pub async fn lsp_health(app: AppHandle, root: Option<String>) -> Vec<LspHealth> {
    let user = crate::settings::get_settings().lsp.disabled;
    let disabled = disabled_servers(user.clone(), root.as_deref());
    let servers_dir = managed::servers_dir();
    registry::registry()
        .iter()
        .map(|server| {
            let missing = match &server.launch {
                Launch::BundledNode { entry, .. } => bundled_entry(&app, entry).is_none(),
                Launch::Path { .. } | Launch::ProjectBin { .. } | Launch::Managed { .. } => false,
            };
            let installed = managed::installed(&servers_dir, &server.id);
            LspHealth {
                disabled: disabled.contains(&server.id),
                disabled_by_workspace: disabled.contains(&server.id) && !user.contains(&server.id),
                ..check(server, missing, installed)
            }
        })
        .collect()
}

/// Install Tori's own copy of a `managed` server, or replace it with the
/// version this build pins.
#[tauri::command(async)]
pub fn lsp_install(server_id: String) -> Result<(), String> {
    let server = registry::find(&server_id).ok_or_else(|| format!("no lsp server registered as `{server_id}`"))?;
    managed::install(server, &managed::servers_dir()).map(|_| ())
}

/// Remove Tori's own copy of a server.
#[tauri::command(async)]
pub fn lsp_uninstall(server_id: String) -> Result<(), String> {
    registry::find(&server_id).ok_or_else(|| format!("no lsp server registered as `{server_id}`"))?;
    managed::remove(&managed::servers_dir(), &server_id)
}

/// Which servers should run for one file, by id.
#[derive(Debug, Serialize)]
pub struct Resolution {
    pub primary: Option<String>,
    pub secondaries: Vec<String>,
}

/// The servers `file_path` gets once activation markers and `lsp.disabled`
/// have had their say. See `registry::resolve`.
#[tauri::command(async)]
pub fn lsp_resolve(file_path: String, project_path: String) -> Resolution {
    let disabled = disabled_servers(crate::settings::get_settings().lsp.disabled, Some(&project_path));
    let (primary, secondaries) = registry::resolve(
        registry::registry(),
        Path::new(&file_path),
        Path::new(&project_path),
        &disabled,
    );
    Resolution {
        primary: primary.map(|s| s.id.clone()),
        secondaries: secondaries.iter().map(|s| s.id.clone()).collect(),
    }
}

// The workspace list only adds. A repo ships its own `.tori/settings.json`, and
// letting that file switch back on a server the user turned off would hand the
// choice to the repo.
fn disabled_servers(user: Vec<String>, root: Option<&str>) -> HashSet<String> {
    let mut ids: HashSet<String> = user.into_iter().collect();
    if let Some(root) = root.filter(|r| !r.is_empty()) {
        let overlay = crate::workspace_settings::get_workspace_settings(root.to_string());
        if let Some(list) = overlay.pointer("/lsp/disabled").and_then(|v| v.as_array()) {
            ids.extend(list.iter().filter_map(|v| v.as_str()).map(str::to_string));
        }
    }
    ids
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
        let (session, stdout, _stderr) = spawn_session(echo_server(), root).unwrap();
        pump_frames(
            stdout,
            move |body| {
                let _ = tx.send(body);
            },
            || {},
        );
        (session, rx)
    }

    fn recv(rx: &mpsc::Receiver<String>) -> String {
        rx.recv_timeout(Duration::from_secs(5)).expect("no frame arrived")
    }

    fn alive(pid: u32) -> bool {
        Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    /// Start `cmd` the way `lsp_start` does, with every EOF's `reap` sent back.
    fn start_reaped(state: &Arc<LspState>, handle: &LspHandle, cmd: Command) -> mpsc::Receiver<Option<LspExited>> {
        let (tx, rx) = mpsc::channel();
        let (reaper, h) = (state.clone(), handle.clone());
        start_session(
            state,
            handle,
            cmd,
            |_| {},
            move |serial| {
                let _ = tx.send(reaper.reap(&h, serial));
            },
        )
        .unwrap();
        rx
    }

    fn pid_of(state: &LspState, handle: &LspHandle) -> u32 {
        state.sessions.lock().unwrap()[handle].child.id()
    }

    fn sh(script: &str) -> Command {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script);
        cmd
    }

    fn wait_for_log(state: &LspState, handle: &LspHandle, done: impl Fn(&str) -> bool) -> String {
        for _ in 0..500 {
            let log = state.log(handle);
            if done(&log) {
                return log;
            }
            thread::sleep(Duration::from_millis(10));
        }
        state.log(handle)
    }

    #[test]
    fn stderr_is_kept_as_a_bounded_tail_that_outlives_the_server() {
        let state = Arc::new(LspState::default());
        let handle = LspHandle {
            server_id: "demo".into(),
            root: "/".into(),
        };

        let _exits = start_reaped(&state, &handle, sh("echo 'booting demo' >&2; exec cat"));
        let log = wait_for_log(&state, &handle, |l| l.contains("booting demo"));
        assert!(
            log.contains("booting demo"),
            "stderr on start never reached the log: {log:?}"
        );
        state.stop(&handle).unwrap();

        // A restart of the handle starts a fresh log, and a flood keeps only its tail.
        let exits = start_reaped(
            &state,
            &handle,
            sh("echo first >&2; head -c 1048576 /dev/zero | tr '\\0' x >&2; echo last >&2"),
        );
        assert!(
            exits.recv_timeout(Duration::from_secs(10)).unwrap().is_some(),
            "the flood never exited"
        );
        let log = wait_for_log(&state, &handle, |l| l.ends_with("last\n"));
        assert!(log.ends_with("last\n"), "the tail is missing its last line");
        assert!(log.len() <= LOG_CAP, "kept {} bytes", log.len());
        assert!(!log.contains("first") && !log.contains("booting demo"));
        assert!(
            !state.sessions.lock().unwrap().contains_key(&handle),
            "the log is read after the session is gone"
        );
    }

    #[test]
    fn a_crashed_server_is_reaped_reported_and_respawned_on_the_next_start() {
        let state = Arc::new(LspState::default());
        let handle = LspHandle {
            server_id: "demo".into(),
            root: "/".into(),
        };
        let exits = start_reaped(&state, &handle, echo_server());
        let pid = pid_of(&state, &handle);

        Command::new("kill").arg("-9").arg(pid.to_string()).status().unwrap();
        let exited = exits
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .expect("a crash is reported");
        assert_eq!(exited.handle, handle);
        assert!(!exited.deliberate);
        assert!(
            exited.status.is_some_and(|s| s.contains("signal")),
            "the status says how it died"
        );
        // `kill -0` succeeds on a zombie, so failing here means it was reaped.
        assert!(!alive(pid), "pid {pid} is still in the process table");

        let _exits = start_reaped(&state, &handle, echo_server());
        let fresh = pid_of(&state, &handle);
        assert_ne!(fresh, pid, "the start after a crash reused the dead session");
        assert!(alive(fresh));
        state.stop(&handle).unwrap();
    }

    #[test]
    fn a_deliberate_stop_is_reported_as_one_and_never_as_a_crash() {
        let state = Arc::new(LspState::default());
        let handle = LspHandle {
            server_id: "demo".into(),
            root: "/".into(),
        };
        let exits = start_reaped(&state, &handle, echo_server());
        let pid = pid_of(&state, &handle);

        let exited = state.stop(&handle).unwrap().expect("a live session reports its stop");
        assert!(exited.deliberate);
        assert!(!alive(pid));
        assert!(
            exits.recv_timeout(Duration::from_secs(5)).unwrap().is_none(),
            "the EOF after a stop reported a crash"
        );

        let _exits = start_reaped(&state, &handle, echo_server());
        let all = state.stop_all().unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].deliberate);
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
        let a = LspHandle {
            server_id: "demo".into(),
            root: "/".into(),
        };
        let b = LspHandle {
            server_id: "demo".into(),
            root: "/tmp".into(),
        };

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
        let handle = LspHandle {
            server_id: "demo".into(),
            root: "/".into(),
        };
        let (session, rx) = start_echo(&handle.root);
        map.insert(handle.clone(), session);

        // A handle rebuilt from its own fields addresses the same session:
        // this is what lets the frontend hold the value `lsp_start` returned
        // and hand it back later.
        let same = LspHandle {
            server_id: "demo".into(),
            root: "/".into(),
        };
        write_frame(&mut map.get_mut(&same).unwrap().stdin, r#"{"ok":1}"#).unwrap();
        assert_eq!(recv(&rx), r#"{"ok":1}"#);

        // A different root is a different session, and simply is not there.
        let other = LspHandle {
            server_id: "demo".into(),
            root: "/tmp".into(),
        };
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
        let cards = registry::registry()
            .iter()
            .map(|s| check(s, false, None))
            .collect::<Vec<_>>();
        assert_eq!(cards.len(), registry::registry().len());

        let ts = cards.iter().find(|c| c.id == "typescript").expect("bundled TS server");
        // A bundled server's dependency is the interpreter, not the entry
        // script: the script ships with the app, `node` does not.
        assert_eq!(ts.program, "node");
        assert!(ts.extensions.contains(&"ts".to_string()));

        let rs = cards.iter().find(|c| c.id == "rust").expect("bundled Rust server");
        assert_eq!(rs.program, "rust-analyzer");

        // Settings has no project to find the project's own `biome` in.
        let biome = cards.iter().find(|c| c.id == "biome").expect("bundled Biome config");
        assert!(biome.runs_per_project);

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
        let missing = check(ts, true, None);
        assert_eq!(missing.status, crate::health::BinaryStatus::NotFound);
        assert!(
            missing.detail.as_deref().unwrap_or_default().contains("lsp:install"),
            "the card must say how to fix it, got {:?}",
            missing.detail
        );

        // With the entry present the same server stops reporting a problem.
        let present = check(ts, false, None);
        assert!(present.detail.is_none());
        assert_ne!(present.status, crate::health::BinaryStatus::NotFound);

        // A `path` server has no entry script, so it can never be in this state.
        // It can carry a detail of its own (a rustup proxy with no component),
        // which depends on the machine, so only this one is ruled out.
        let rust = check(registry::find("rust").unwrap(), false, None);
        assert!(!rust.detail.unwrap_or_default().contains("lsp:install"));
    }

    #[test]
    fn a_racing_start_kills_the_loser_instead_of_leaking_it() {
        let mut map: HashMap<LspHandle, LspSession> = HashMap::new();
        let handle = LspHandle {
            server_id: "demo".into(),
            root: "/".into(),
        };

        let (winner, rx) = start_echo(&handle.root);
        assert!(install_session(&mut map, &handle, winner));

        // A second start raced us to the same handle and spawned its own
        // server. Dropping it would leave it running unreachable, since
        // `Child` has no `Drop` that stops the process.
        let (loser, _loser_rx) = start_echo(&handle.root);
        let loser_pid = loser.child.id();
        assert!(
            !install_session(&mut map, &handle, loser),
            "the racer must not be installed"
        );

        // The loser is actually dead, not merely forgotten.
        let reaped = Command::new("kill")
            .arg("-0")
            .arg(loser_pid.to_string())
            .status()
            .expect("kill -0");
        assert!(
            !reaped.success(),
            "pid {loser_pid} is still alive after losing the race"
        );

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
        let handle = LspHandle {
            server_id: "typescript".into(),
            root: "/p".into(),
        };
        let json = serde_json::to_string(&handle).unwrap();
        assert_eq!(json, r#"{"serverId":"typescript","root":"/p"}"#);
        // Round-trips, so the frontend can hand back exactly what it was given.
        assert_eq!(serde_json::from_str::<LspHandle>(&json).unwrap(), handle);

        let started = LspStarted {
            handle,
            initialization_options: Some(serde_json::json!({ "typescript": { "tsdk": "/lib" } })),
        };
        assert_eq!(
            serde_json::to_string(&started).unwrap(),
            r#"{"handle":{"serverId":"typescript","root":"/p"},"initializationOptions":{"typescript":{"tsdk":"/lib"}}}"#
        );
    }

    /// Every command this module defines has to be *registered*, or it does not
    /// exist to the frontend.
    ///
    /// Forgetting the line in `lib.rs` compiles cleanly, and the caller of the
    /// missing command sees a rejected promise. `toriSettingsAssociations`
    /// catches that and answers "no schemas", so an unregistered
    /// `lsp_schema_dir` would look exactly like a build that ships none: the
    /// settings file validates nothing and says nothing about why.
    #[test]
    fn every_command_here_is_registered_with_the_app() {
        // Only the half above `#[cfg(test)]`. Scanning the whole file means
        // scanning *this* function, whose own source mentions the attribute it
        // searches for and yields a fragment of this parser as a command name.
        let module = include_str!("lsp.rs").split("#[cfg(test)]").next().unwrap();
        let lib = include_str!("lib.rs");

        // The prefix, not the exact attribute: `#[tauri::command(async)]` is a
        // registered command too.
        let defined: Vec<&str> = module
            .split("#[tauri::command")
            .skip(1)
            .filter_map(|after| {
                // The name follows the attribute, past an optional `async`.
                let sig = after.split("fn ").nth(1)?;
                Some(sig.split(['(', '<', ' ']).next()?.trim())
            })
            .collect();

        assert!(
            defined.len() >= 8,
            "the parse found no commands, so this test proves nothing: {defined:?}"
        );
        let missing: Vec<&&str> = defined
            .iter()
            .filter(|name| !lib.contains(&format!("lsp::{name},")))
            .collect();
        assert!(
            missing.is_empty(),
            "add these to `generate_handler!` in lib.rs: {missing:?}"
        );
    }

    /// The settings schemas have to be *bundled*, not merely present.
    ///
    /// `bundled_entry` falls back to `CARGO_MANIFEST_DIR`, so a schema missing
    /// from `tauri.conf.json` resolves perfectly in every dev run and every test
    /// here, and is simply absent from the packaged app - where the failure is
    /// silent, because a schema the server cannot read is a file it validates
    /// nothing against rather than an error it reports.
    #[test]
    fn the_settings_schemas_are_bundled_as_resources() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let resources = conf["bundle"]["resources"]
            .as_array()
            .expect("bundle.resources is a list");
        let listed: Vec<&str> = resources.iter().filter_map(|r| r.as_str()).collect();
        assert!(
            listed.iter().any(|r| r.starts_with("resources/schemas/")),
            "the schemas directory must be bundled, got {listed:?}"
        );

        // And every schema the frontend names is actually in the tree it points
        // at, since an association naming a file that is not there is the same
        // silence one more time.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/schemas");
        for name in ["tori-settings.schema.json", "tori-workspace-settings.schema.json"] {
            let path = dir.join(name);
            let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            serde_json::from_str::<serde_json::Value>(&text)
                .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));
        }
    }

    #[test]
    fn a_disabled_server_is_left_out_and_a_disabled_primary_hands_over() {
        let project = std::env::temp_dir().join(format!("tori_lsp_disabled_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&project);
        let file = project.join("src/a.ts");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::create_dir_all(project.join(".tori")).unwrap();
        std::fs::write(project.join("eslint.config.js"), "").unwrap();
        std::fs::write(project.join("deno.json"), "{}").unwrap();
        std::fs::write(
            project.join(".tori/settings.json"),
            r#"{ "lsp": { "disabled": ["eslint"] } }"#,
        )
        .unwrap();

        let config = |id: &str, extra: &str| {
            registry::load_server_str(
                &format!(
                    "schema_version = 1\nid = \"{id}\"\nlabel = \"{id}\"\nroot_markers = [\".git\"]\n{extra}\n\
                     [languages]\nts = \"typescript\"\n[launch]\nkind = \"path\"\nprogram = \"{id}\"\n"
                ),
                id,
            )
            .unwrap()
        };
        let servers = [
            registry::load_server_str(include_str!("../lsp/typescript.toml"), "bundled:typescript").unwrap(),
            config(
                "eslint",
                "role = \"secondary\"\nactivation_markers = [\"eslint.config.js\"]",
            ),
            config("deno", "activation_markers = [\"deno.json\"]"),
        ];
        let root = project.to_string_lossy().into_owned();

        let disabled = disabled_servers(vec!["deno".to_string()], Some(&root));
        assert!(
            disabled.contains("eslint") && disabled.contains("deno"),
            "the workspace adds to the user's list"
        );

        let (primary, secondaries) = registry::resolve(&servers, &file, &project, &disabled);
        assert_eq!(primary.map(|s| s.id.as_str()), Some("typescript"));
        assert!(secondaries.is_empty());
    }

    // --- `${tsdk}` resolution ---

    fn tsdk_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori_lsp_tsdk_{}_{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A `typescript/lib` with the one file Volar's loader looks for.
    fn fake_tsdk(under: &Path) -> PathBuf {
        let lib = under.join("node_modules").join("typescript").join("lib");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("typescript.js"), "").unwrap();
        lib
    }

    fn astro_options() -> serde_json::Value {
        serde_json::json!({ "typescript": { "tsdk": "${tsdk}" }, "contentIntellisense": false })
    }

    fn tsdk_in(options: &serde_json::Value) -> &str {
        options["typescript"]["tsdk"].as_str().unwrap()
    }

    #[test]
    fn the_projects_own_typescript_wins_over_the_bundled_copy() {
        let dir = tsdk_dir("project_wins");
        let project = dir.join("project");
        let own = fake_tsdk(&project);
        let bundled = fake_tsdk(&dir.join("bundled"));

        let (resolved, used) =
            resolve_tsdk(Some(&astro_options()), &project.join("src"), &project, Some(bundled)).unwrap();
        assert_eq!(tsdk_in(resolved.as_ref().unwrap()), own.to_string_lossy());
        assert_eq!(used, Some(own));
        // Everything beside the placeholder is carried through as written.
        assert_eq!(resolved.unwrap()["contentIntellisense"], serde_json::Value::Bool(false));
    }

    #[test]
    fn without_a_project_typescript_the_bundled_copy_is_used() {
        let dir = tsdk_dir("bundled");
        let project = dir.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let bundled = fake_tsdk(&dir.join("bundled"));

        let (resolved, used) = resolve_tsdk(Some(&astro_options()), &project, &project, Some(bundled.clone())).unwrap();
        assert_eq!(tsdk_in(resolved.as_ref().unwrap()), bundled.to_string_lossy());
        assert_eq!(used, Some(bundled));
    }

    #[test]
    fn neither_typescript_is_an_error_naming_the_install_step() {
        let dir = tsdk_dir("neither");
        let project = dir.join("project");
        std::fs::create_dir_all(&project).unwrap();
        // A bundled directory with no `typescript.js` in it counts as missing.
        let empty = dir.join("empty");
        std::fs::create_dir_all(&empty).unwrap();

        let err = resolve_tsdk(Some(&astro_options()), &project, &project, Some(empty)).unwrap_err();
        assert!(err.contains("pnpm lsp:install"), "{err}");
    }

    #[test]
    fn a_root_outside_the_project_does_not_walk() {
        let dir = tsdk_dir("outside");
        let project = dir.join("project");
        std::fs::create_dir_all(&project).unwrap();
        // A typescript above the root that the walk would reach if unbounded.
        let elsewhere = dir.join("elsewhere");
        fake_tsdk(&elsewhere);
        let root = elsewhere.join("deeper");
        std::fs::create_dir_all(&root).unwrap();
        let bundled = fake_tsdk(&dir.join("bundled"));

        let (_, used) = resolve_tsdk(Some(&astro_options()), &root, &project, Some(bundled.clone())).unwrap();
        assert_eq!(used, Some(bundled));
    }

    #[test]
    fn options_without_the_placeholder_pass_through_and_resolve_nothing() {
        let dir = tsdk_dir("passthrough");
        let options = serde_json::json!({ "preferences": { "importModuleSpecifier": "relative" } });
        // No typescript anywhere: a config that never asked must not fail.
        let (resolved, used) = resolve_tsdk(Some(&options), &dir, &dir, None).unwrap();
        assert_eq!(resolved, Some(options));
        assert_eq!(used, None);

        let (resolved, used) = resolve_tsdk(None, &dir, &dir, None).unwrap();
        assert_eq!((resolved, used), (None, None));
    }

    /// The placeholder the doc's schema block shows is the one the resolver
    /// fills, so the two cannot drift apart.
    #[test]
    fn the_documented_tsdk_placeholder_resolves() {
        let doc = include_str!("../../docs/LSP-SERVERS.md");
        let after = doc
            .split("\n## Schema\n")
            .nth(1)
            .expect("the doc must have a Schema section");
        let start = after
            .find("```toml")
            .expect("the Schema section must show a toml block")
            + 7;
        let block = &after[start..][..after[start..].find("```").expect("unterminated toml block")];
        let server = registry::load_server_str(block, "LSP-SERVERS.md schema").unwrap();

        let dir = tsdk_dir("documented");
        let bundled = fake_tsdk(&dir.join("bundled"));
        let (resolved, used) = resolve_tsdk(
            server.initialization_options.as_ref(),
            &dir,
            &dir,
            Some(bundled.clone()),
        )
        .unwrap();
        assert_eq!(used, Some(bundled.clone()));
        assert_eq!(tsdk_in(resolved.as_ref().unwrap()), bundled.to_string_lossy());
    }
}
