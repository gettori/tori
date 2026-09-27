//! File-based performance tracing, for a release build that has no devtools.
//!
//! Two files under `~/.config/tori/trace/`, both JSON-lines: `backend.jsonl`
//! written here, `frontend.jsonl` written by the web layer through
//! `trace_write`. They are joined after the fact on `id`, which the frontend
//! mints and smuggles into every invoke's argument map as `__toriTrace` (Tauri
//! looks each declared argument up by name, so an extra key is ignored by every
//! command). Queue wait is then `backend.enter - frontend.call`, measured
//! rather than inferred.
//!
//! Both sides stamp wall-clock epoch milliseconds, not a monotonic clock:
//! `Instant` and `performance.now()` have no shared origin, and one process on
//! one machine makes wall clock accurate enough for the tens of milliseconds
//! this is chasing.
//!
//! Off unless `TORI_TRACE` is set to something other than `0` at launch, and
//! read exactly once, so the disabled path is one relaxed atomic load.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static ENABLED: AtomicBool = AtomicBool::new(false);
static BACKEND: OnceLock<Mutex<Option<File>>> = OnceLock::new();
static FRONTEND: OnceLock<Mutex<Option<File>>> = OnceLock::new();

/// Where both trace files live. `~/.config/tori/` is where every other Tori
/// store already is; Tauri's app-data dir is unused in this codebase.
pub fn dir() -> PathBuf {
    crate::owned_state::config_dir().join("trace")
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Wall-clock milliseconds since the epoch, fractional. The frontend's
/// `performance.timeOrigin + performance.now()` is the same quantity.
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Read `TORI_TRACE` and, if set, truncate both trace files so a run's numbers
/// are never read against the previous run's. Called before the Tauri builder,
/// so `trace_config` can answer the frontend the moment it asks.
pub fn init() {
    let on = std::env::var("TORI_TRACE")
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false);
    if !on {
        return;
    }
    let d = dir();
    if let Err(e) = std::fs::create_dir_all(&d) {
        eprintln!("trace: cannot create {}: {e}", d.display());
        return;
    }
    let open = |name: &str| -> Option<File> {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(d.join(name))
            .map_err(|e| eprintln!("trace: cannot open {name}: {e}"))
            .ok()
    };
    let backend = open("backend.jsonl");
    let frontend = open("frontend.jsonl");
    if backend.is_none() || frontend.is_none() {
        return;
    }
    let _ = BACKEND.set(Mutex::new(backend));
    let _ = FRONTEND.set(Mutex::new(frontend));
    ENABLED.store(true, Ordering::Relaxed);
    eprintln!("trace: on, writing to {}", d.display());
}

fn append(slot: &OnceLock<Mutex<Option<File>>>, line: &str) {
    let Some(lock) = slot.get() else { return };
    let Ok(mut guard) = lock.lock() else { return };
    let Some(file) = guard.as_mut() else { return };
    let _ = writeln!(file, "{line}");
}

/// One command's span on the IPC thread. `enter` is IPC arrival, which for a
/// command that runs inline is also body-start; `ret` is when the handler gave
/// the thread back, which for an inline command is body-end and for one that
/// moved off the thread is right after the spawn. Phase 2 is exactly the work
/// of turning the second shape into the common one, so the pair is left raw
/// here and classified by the report.
pub fn command_span(name: &str, id: Option<u64>, enter: f64, ret: f64) {
    let thread = format!("{:?}", std::thread::current().id());
    let id = id.map(|v| v.to_string()).unwrap_or_else(|| "null".into());
    append(
        &BACKEND,
        &format!(
            r#"{{"t":"cmd","id":{id},"name":{},"enter":{enter},"ret":{ret},"thread":{}}}"#,
            json_string(name),
            json_string(&thread),
        ),
    );
}

/// One command body, stamped on whatever thread actually ran it. Bodies moved
/// off the IPC thread by `exec::blocking` have no correlation id of their own
/// (the id lives in the invoke payload the handler consumed); the report joins
/// them to `cmd` lines by name and time window instead.
pub fn body_span(name: &str, enter: f64, ret: f64) {
    let thread = format!("{:?}", std::thread::current().id());
    append(
        &BACKEND,
        &format!(
            r#"{{"t":"body","name":{},"enter":{enter},"ret":{ret},"thread":{}}}"#,
            json_string(name),
            json_string(&thread),
        ),
    );
}

/// Minimal JSON string escaping. Command and thread names are ASCII
/// identifiers in practice; this exists so a stray quote cannot corrupt a line.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The correlation id the frontend put in the argument map, if this invoke
/// carries one. A raw-body request (and anything invoked before the shim is
/// installed) simply has none.
pub fn trace_id_of(body: &tauri::ipc::InvokeBody) -> Option<u64> {
    match body {
        tauri::ipc::InvokeBody::Json(v) => v.get("__toriTrace")?.as_u64(),
        tauri::ipc::InvokeBody::Raw(_) => None,
    }
}

/// Wraps the generated command handler so every invoke is stamped on the way
/// in and out. A free function rather than a `let` binding at the call site:
/// `generate_handler!` expands to a closure generic over the runtime, and only
/// a signature can pin `R` down for it.
pub fn traced<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if !enabled() {
            return handler(invoke);
        }
        let name = invoke.message.command().to_string();
        let id = trace_id_of(invoke.message.payload());
        let enter = now_ms();
        let handled = handler(invoke);
        command_span(&name, id, enter, now_ms());
        handled
    }
}

#[derive(serde::Serialize)]
pub struct TraceConfig {
    pub enabled: bool,
    pub dir: String,
    /// `TORI_RECIPE` verbatim, for the scripted degradation run. Empty means
    /// "trace whatever the user does" rather than "drive the app yourself".
    pub recipe: String,
}

/// Whether to instrument, asked once at startup. The frontend cannot read the
/// env var itself, and a release bundle has no console to be told through.
#[tauri::command]
pub fn trace_config() -> TraceConfig {
    TraceConfig {
        enabled: enabled(),
        dir: dir().to_string_lossy().into_owned(),
        recipe: if enabled() {
            std::env::var("TORI_RECIPE").unwrap_or_default()
        } else {
            String::new()
        },
    }
}

/// Ends the process once the recipe has written its last line. Destroying the
/// window leaves the app running (the PTY and chat hosts keep it alive), and a
/// scripted run that has to be killed from outside cannot report that it
/// finished cleanly. Refuses unless tracing is on, so nothing in an ordinary
/// launch can reach it.
#[tauri::command]
pub fn trace_quit(app: tauri::AppHandle) {
    if !enabled() {
        return;
    }
    app.exit(0);
}

/// The frontend's own trace lines, batched. Pre-serialised JSON: the web layer
/// owns its line shape, and re-encoding it here would only be a second place
/// for the two files' formats to drift apart.
#[tauri::command]
pub fn trace_write(lines: Vec<String>) {
    if !enabled() {
        return;
    }
    for line in lines {
        append(&FRONTEND, &line);
    }
}
