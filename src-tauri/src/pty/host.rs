//! Run by `tori daemon`, so a shell outlives the window.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::{json, Value};

use super::wire::{self, AttachParams, Listed, Spawn, DATA, EXIT, RESIZE};
use crate::env::{augmented_path, login_path_if_captured, login_shell};
use crate::rpc::auth::{Caller, Children};
use crate::rpc::frame::{to_line, write_line, Response, RpcError, INVALID_PARAMS};
use crate::rpc::transport::Stream;

// How long a shell that prints nothing is given before its `init` is judged.
// One that prints is judged once it has been quiet for `INIT_QUIET_MS`.
const INIT_TIMEOUT_MS: u64 = 1000;

// A banner printed before a handover is not a prompt, so a shell that printed
// has to stay quiet this long before its foreground is trusted.
const INIT_QUIET_MS: u64 = 250;

// zsh lends the terminal to every foreground command its rc runs, so another
// process holding it is only refused once it has held it this long.
const INIT_SETTLE_MS: u64 = 5000;
const INIT_POLL_MS: u64 = 25;

// How often a task tab's foreground is read once its command is typed, and how
// many agreeing reads it takes to flip. More than one, because a prompt hook
// that runs `git` borrows the terminal for a moment and is not the task.
const BUSY_POLL: Duration = Duration::from_millis(250);
const BUSY_AGREE: u8 = 2;

// Fallback quiet threshold for a session with no adapter-supplied one (a
// plain shell/command tab). Agent tabs pass their adapter's own
// `pty_quiet_ms` (see agents.rs), empirically measured per agent.
const DEFAULT_QUIET_MS: u64 = 2000;

// How often the activity watcher re-checks a session's last-output time
// against its quiet threshold. Small relative to any real threshold (2s+),
// so the active->quiet transition is detected promptly without busy-looping.
const ACTIVITY_POLL_MS: u64 = 200;
const UNWATCHED_POLL: Duration = Duration::from_secs(1);

// Output coalescing window, roughly a frame. A reader that keeps producing
// costs one IPC send per window instead of one per 8KB read, which is what a
// hidden streaming terminal was paying in full for nobody to look at.
const COALESCE_WINDOW: Duration = Duration::from_millis(16);

// Ceiling on how much one send carries, so a fast producer flushes on size
// rather than sitting on a growing buffer for the rest of the window.
const COALESCE_MAX_BYTES: usize = 64 * 1024;

// How long the reader waits for its child's status once the PTY has closed, and
// how often it asks. Polled rather than waited: a blocking `wait` would hold the
// lock `pty_kill` takes on the IPC thread ([[adr_no_sync_ipc_commands]]).
const EXIT_WAIT: Duration = Duration::from_millis(2000);
const EXIT_POLL: Duration = Duration::from_millis(10);

const RING_BYTES: usize = 2 * 1024 * 1024;

/// The PTY writer, shared between `pty_write` and the init-delivery threads.
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// The child process, shared so the reader thread can read its exit status
/// after EOF while `pty_kill` can still reach the same handle to kill it.
type SharedChild = Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>;

/// The master, shared so the seeder can read the terminal's foreground through
/// it. Never the slave: macOS answers `tcgetpgrp` on a reopened slave with
/// ENOTTY, and any slave fd Tori holds keeps the reader from seeing EOF.
type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;

// Chunks of up to 8 KB read ahead of a stalled stream.
const READ_AHEAD: usize = 32;

pub type Events = Box<dyn Fn(&'static str, Value) + Send + Sync>;

struct Ring {
    bytes: VecDeque<u8>,
    cap: usize,
}

impl Ring {
    fn new(cap: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            cap,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        let chunk = &chunk[chunk.len().saturating_sub(self.cap)..];
        let over = (self.bytes.len() + chunk.len()).saturating_sub(self.cap);
        self.bytes.drain(..over);
        self.bytes.extend(chunk);
    }

    fn contents(&self) -> Vec<u8> {
        self.bytes.iter().copied().collect()
    }
}

struct Output {
    ring: Ring,
    streams: Vec<(u64, Box<dyn Stream>)>,
    /// Kept after the child goes, so a stream attaching late still hears the end.
    exited: Option<Option<u32>>,
}

impl Output {
    // A blocking write: a reader that falls behind slows the tab, as a slow
    // terminal would, rather than losing bytes or its stream.
    fn send(&mut self, kind: u8, payload: &[u8]) {
        self.streams.retain_mut(|(_, stream)| {
            let sent = wire::write_frame(stream, kind, payload).is_ok();
            if !sent {
                stream.close();
            }
            sent
        });
    }
}

type SharedOutput = Arc<Mutex<Output>>;

struct Pty {
    master: SharedMaster,
    writer: SharedWriter,
    child: SharedChild,
    out: SharedOutput,
    agent: Option<String>,
    profile: Option<String>,
    cwd: String,
    /// A task tab whose command still holds the terminal. Always false for
    /// every other kind.
    busy: Arc<AtomicBool>,
    token: String,
}

impl Pty {
    fn handed_on(&self) -> bool {
        let shell = self.child.lock().ok().and_then(|c| c.process_id());
        let foreground = self.master.lock().ok().and_then(|m| m.process_group_leader());
        matches!((shell, foreground), (Some(shell), Some(fg)) if i64::from(fg) != i64::from(shell))
    }

    fn resize(&self, cols: u16, rows: u16) {
        if let Ok(master) = self.master.lock() {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    fn write(&self, data: &[u8]) {
        if let Ok(mut writer) = self.writer.lock() {
            let _ = writer.write_all(data);
            let _ = writer.flush();
        }
    }
}

/// Last-output tracking for the working/needs-you pulse (Finding A, Tier 2):
/// the reader thread stamps `last_output_at` on every chunk and flips to
/// `active` on a quiet->active transition; a separate watcher thread flips
/// back to quiet once `last_output_at` is older than the session's threshold.
/// Two threads, one lock - kept this simple rather than adding a timeout to
/// the (blocking, OS-level) PTY reader itself.
struct Activity {
    last_output_at: Instant,
    active: bool,
}
type SharedActivity = Arc<Mutex<Activity>>;

#[derive(Clone, Serialize)]
struct ActivityEvent {
    id: String,
    /// "active" | "quiet"
    state: &'static str,
}

/// What `pty://init-refused` carries: the tab, and the command that held its
/// terminal instead of the shell when the init was due.
#[derive(Clone, Serialize)]
struct InitRefused {
    id: String,
    foreground: String,
}

/// What `pty://busy` carries: a task tab, and whether its command still holds
/// the terminal or the shell has its prompt back.
#[derive(Clone, Serialize)]
struct BusyEvent {
    id: String,
    busy: bool,
}

/// What `pty://exit` carries. A `None` code is an *unproven* exit, not a zero:
/// the frontend has to read it as failure, because the output it would close
/// over is exactly the output worth keeping.
#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    code: Option<u32>,
}

/// The child's status, asked for repeatedly rather than waited on. The guard is
/// dropped between polls so `pty_kill` can take the same lock; `limit` and
/// `poll` are parameters so a test can expire the wait without spending 2s.
fn poll_exit_code(child: &SharedChild, limit: Duration, poll: Duration) -> Option<u32> {
    let deadline = Instant::now() + limit;
    loop {
        match child.lock() {
            Ok(mut guard) => match guard.try_wait() {
                Ok(Some(status)) => return Some(status.exit_code()),
                Ok(None) => {}
                Err(_) => return None,
            },
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(poll);
    }
}

/// Called on every PTY read. Stamps `last_output_at` unconditionally, but only
/// returns `Some("active")` on a quiet->active transition (or the first-ever
/// chunk) - a burst of reads while already active (a redrawing spinner)
/// returns `None` each time, which is what keeps `pty://activity` from
/// spamming one event per chunk.
fn note_output(act: &mut Activity) -> Option<&'static str> {
    act.last_output_at = Instant::now();
    if act.active {
        None
    } else {
        act.active = true;
        Some("active")
    }
}

/// Called by the watcher's poll loop. Returns `Some("quiet")` exactly once,
/// on the active->quiet transition (`last_output_at` older than `threshold`);
/// `None` otherwise, including every subsequent poll while already quiet.
fn check_quiet(act: &mut Activity, threshold: Duration) -> Option<&'static str> {
    if act.active && act.last_output_at.elapsed() >= threshold {
        act.active = false;
        Some("quiet")
    } else {
        None
    }
}

/// Drains `rx` into `emit`, concatenating chunks in arrival order and never
/// dropping one, so the frontend's scrollback is byte-identical either way.
///
/// A chunk goes out on arrival whenever the last emit is older than `window`,
/// which is the interactive case: the loop is parked in `recv` and the window
/// closed long ago, so an echoed keystroke pays nothing. Only a producer that
/// is already streaming waits, and only until the window closes or `max` is
/// reached. Returns once the sender is dropped, having emitted the tail.
fn coalesce(rx: Receiver<Vec<u8>>, mut emit: impl FnMut(Vec<u8>), window: Duration, max: usize) {
    let mut pending: Vec<u8> = Vec::new();
    let mut last_emit: Option<Instant> = None;
    let window_closed = |last: Option<Instant>| last.is_none_or(|t| t.elapsed() >= window);

    loop {
        let chunk = if pending.is_empty() {
            match rx.recv() {
                Ok(c) => c,
                Err(_) => break,
            }
        } else {
            let wait = last_emit.map_or(Duration::ZERO, |t| window.saturating_sub(t.elapsed()));
            match rx.recv_timeout(wait) {
                Ok(c) => c,
                Err(RecvTimeoutError::Timeout) => {
                    emit(std::mem::take(&mut pending));
                    last_emit = Some(Instant::now());
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        };
        pending.extend_from_slice(&chunk);
        if pending.len() >= max || window_closed(last_emit) {
            emit(std::mem::take(&mut pending));
            last_emit = Some(Instant::now());
        }
    }
    if !pending.is_empty() {
        emit(pending);
    }
}

/// A task tab's running state as its foreground reads arrive.
struct BusyWatch {
    busy: bool,
    streak: u8,
}

/// Returns the new state once `BUSY_AGREE` reads in a row disagree with the
/// current one, and `None` otherwise.
fn note_foreground(w: &mut BusyWatch, foreign: bool) -> Option<bool> {
    if foreign == w.busy {
        w.streak = 0;
        return None;
    }
    w.streak += 1;
    if w.streak < BUSY_AGREE {
        return None;
    }
    w.streak = 0;
    w.busy = foreign;
    Some(foreign)
}

// Write the seeded `init` command to the shell exactly once. A refusal sets the
// same flag, so nothing can type it after the seeder has said no.
fn deliver_init(writer: &SharedWriter, initialized: &Arc<Mutex<bool>>, init: &str) {
    let mut done = match initialized.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if *done {
        return;
    }
    *done = true;
    if let Ok(mut w) = writer.lock() {
        let _ = w.write_all(init.as_bytes());
        let _ = w.flush();
    }
}

struct SeedTimings {
    silent: Duration,
    quiet: Duration,
    settle: Duration,
    poll: Duration,
}

const SEED_TIMINGS: SeedTimings = SeedTimings {
    silent: Duration::from_millis(INIT_TIMEOUT_MS),
    quiet: Duration::from_millis(INIT_QUIET_MS),
    settle: Duration::from_millis(INIT_SETTLE_MS),
    poll: Duration::from_millis(INIT_POLL_MS),
};

#[derive(Debug, PartialEq)]
enum Seeded {
    Typed,
    Refused(String),
    Gone,
}

struct Seeder {
    writer: SharedWriter,
    initialized: Arc<Mutex<bool>>,
    init: String,
    master: SharedMaster,
    shell_pid: Option<u32>,
    last_output: Arc<Mutex<Option<Instant>>>,
}

impl Seeder {
    fn run(&self, live: impl Fn() -> bool, t: &SeedTimings) -> Seeded {
        let started = Instant::now();
        loop {
            thread::sleep(t.poll);
            if !live() {
                return Seeded::Gone;
            }
            let quiet = match self.last_output.lock().map(|g| *g).unwrap_or(None) {
                None => started.elapsed() >= t.silent,
                Some(at) => at.elapsed() >= t.quiet,
            };
            let settled = started.elapsed() >= t.settle;
            if !quiet && !settled {
                continue;
            }
            match self.foreign_foreground() {
                None => {
                    deliver_init(&self.writer, &self.initialized, &self.init);
                    return Seeded::Typed;
                }
                Some(pgrp) if settled => return self.refuse(pgrp),
                Some(_) => {}
            }
        }
    }

    // Starts busy, since it is only called once the command line is typed.
    fn watch_busy(&self, live: impl Fn() -> bool, busy: &AtomicBool, mut emit: impl FnMut(bool)) {
        let mut watch = BusyWatch { busy: true, streak: 0 };
        while live() {
            thread::sleep(BUSY_POLL);
            if let Some(now) = note_foreground(&mut watch, self.foreign_foreground().is_some()) {
                busy.store(now, Ordering::Relaxed);
                emit(now);
            }
        }
    }

    fn refuse(&self, pgrp: i32) -> Seeded {
        if let Ok(mut done) = self.initialized.lock() {
            *done = true;
        }
        Seeded::Refused(command_name(pgrp).unwrap_or_else(|| format!("process {pgrp}")))
    }

    // A foreground that cannot be read counts as the shell's, so the init is
    // typed as it always was rather than every agent tab being refused.
    fn foreign_foreground(&self) -> Option<i32> {
        let pgrp = self.master.lock().ok()?.process_group_leader()?;
        (i64::from(pgrp) != i64::from(self.shell_pid?)).then_some(pgrp)
    }
}

fn command_name(pid: i32) -> Option<String> {
    let out = crate::env::output_with_timeout(std::process::Command::new("ps").args([
        "-o",
        "ucomm=",
        "-p",
        &pid.to_string(),
    ]))?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!name.is_empty()).then_some(name)
}

fn command_tab(program: &str, args: &[String], login_path: Option<&str>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.env("PATH", login_path.map_or_else(augmented_path, str::to_string));
    cmd
}

pub struct Host {
    ptys: Mutex<HashMap<String, Arc<Pty>>>,
    // The check and the insert in `spawn` have to be one step, or two spawns
    // of one tab both start a shell.
    spawning: Mutex<()>,
    events: Events,
    children: Arc<Children>,
    sock: PathBuf,
    cli_dir: PathBuf,
    next_stream: AtomicU64,
    watched: AtomicBool,
}

impl Host {
    pub fn new(events: Events, children: Arc<Children>, sock: PathBuf, cli_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            ptys: Mutex::default(),
            spawning: Mutex::default(),
            events,
            children,
            sock,
            cli_dir,
            next_stream: AtomicU64::new(0),
            watched: AtomicBool::new(false),
        })
    }

    /// Whether a window is attached to see a dot turn.
    pub fn set_watched(&self, watched: bool) {
        self.watched.store(watched, Ordering::Relaxed);
    }

    fn activity_poll(&self) -> Duration {
        match self.watched.load(Ordering::Relaxed) {
            true => Duration::from_millis(ACTIVITY_POLL_MS),
            false => UNWATCHED_POLL,
        }
    }

    fn ptys(&self) -> MutexGuard<'_, HashMap<String, Arc<Pty>>> {
        self.ptys.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, tab: &str) -> Option<Arc<Pty>> {
        self.ptys().get(tab).cloned()
    }

    fn live(&self, tab: &str) -> bool {
        self.ptys().contains_key(tab)
    }

    fn emit(&self, event: &'static str, payload: impl Serialize) {
        (self.events)(event, json!(payload));
    }

    pub fn list(&self) -> Vec<Listed> {
        let mut tabs: Vec<Listed> = self
            .ptys()
            .iter()
            .map(|(tab, pty)| Listed {
                tab: tab.clone(),
                agent: pty.agent.clone(),
                profile: pty.profile.clone(),
                cwd: pty.cwd.clone(),
                busy: pty.busy.load(Ordering::Relaxed),
                handed_on: pty.handed_on(),
            })
            .collect();
        tabs.sort_by(|a, b| a.tab.cmp(&b.tab));
        tabs
    }

    pub fn tokens(&self) -> HashSet<String> {
        self.ptys().values().map(|pty| pty.token.clone()).collect()
    }

    pub fn write(&self, tab: &str, data: &[u8]) {
        if let Some(pty) = self.get(tab) {
            pty.write(data);
        }
    }

    pub fn resize(&self, tab: &str, cols: u16, rows: u16) {
        if let Some(pty) = self.get(tab) {
            pty.resize(cols, rows);
        }
    }

    pub fn kill(&self, tab: &str) {
        let removed = self.ptys().remove(tab);
        if let Some(pty) = removed {
            if let Ok(mut child) = pty.child.lock() {
                let _ = child.kill();
            }
        }
    }

    pub fn spawn(self: &Arc<Self>, p: Spawn) -> Result<bool, String> {
        let _one = self.spawning.lock().unwrap_or_else(|e| e.into_inner());
        if self.live(&p.tab) {
            return Ok(true);
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: p.rows,
                cols: p.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        // A command tab never meets the user's rc, so one that attaches tmux or
        // execs another shell cannot swallow it, and `pty://exit` is its own status.
        let is_command = p.kind == "command";
        let init = if is_command { None } else { p.init.clone() };
        let mut cmd = if is_command {
            // Not `login_path()`: the probe can take 5 s, and a spawn answers the window.
            command_tab(&p.program, &p.args, login_path_if_captured())
        } else {
            // A login + interactive shell. `-l` re-sources the user's profile so the
            // shell owns PATH, and exiting a seeded agent drops back to this prompt.
            let mut cmd = CommandBuilder::new(login_shell());
            cmd.arg("-l");
            cmd.arg("-i");
            cmd
        };
        cmd.cwd(&p.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "Tori");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        let token = self.children.mint(Caller::Terminal(p.tab.clone()));
        cmd.env(crate::rpc::ENV_SOCK, &self.sock);
        cmd.env(crate::rpc::ENV_CALLER, &token);
        let path = cmd
            .get_env("PATH")
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        cmd.env("PATH", crate::rpc::path_with_dir(&self.cli_dir, &path));
        for (key, value) in &p.env {
            cmd.env(key, value);
        }

        let child = match pair.slave.spawn_command(cmd) {
            Ok(child) => child,
            Err(e) => {
                self.children.revoke_token(&token);
                return Err(e.to_string());
            }
        };
        let child: SharedChild = Arc::new(Mutex::new(child));
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer: SharedWriter = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
        let master: SharedMaster = Arc::new(Mutex::new(pair.master));
        let tab = p.tab.clone();

        // An rc that attaches tmux or execs another program takes the terminal from
        // the shell, and a line typed then lands in whatever took it.
        let track_busy = p.kind == "task";
        let busy = Arc::new(AtomicBool::new(track_busy));
        let last_output = init.as_ref().map(|_| Arc::new(Mutex::new(None::<Instant>)));
        if let (Some(init), Some(last_output)) = (init, last_output.clone()) {
            let seeder = Seeder {
                writer: writer.clone(),
                initialized: Arc::new(Mutex::new(false)),
                init,
                master: master.clone(),
                shell_pid: child.lock().ok().and_then(|c| c.process_id()),
                last_output,
            };
            let (host, tab, busy) = (self.clone(), tab.clone(), busy.clone());
            thread::spawn(move || {
                let live = || host.live(&tab);
                match seeder.run(live, &SEED_TIMINGS) {
                    Seeded::Refused(foreground) => {
                        busy.store(false, Ordering::Relaxed);
                        host.emit(
                            "pty://init-refused",
                            InitRefused {
                                id: tab.clone(),
                                foreground,
                            },
                        );
                    }
                    Seeded::Typed if track_busy => seeder.watch_busy(live, &busy, |busy| {
                        host.emit("pty://busy", BusyEvent { id: tab.clone(), busy });
                    }),
                    _ => {}
                }
            });
        }

        let out: SharedOutput = Arc::new(Mutex::new(Output {
            ring: Ring::new(RING_BYTES),
            streams: Vec::new(),
            exited: None,
        }));
        let activity: SharedActivity = Arc::new(Mutex::new(Activity {
            last_output_at: Instant::now(),
            active: false,
        }));

        // Init and activity stay on the reader, not the coalescer: both are about
        // *when* a byte arrived, and a window's delay would hold the needs-you pulse.
        // Bounded, so a stream that falls behind makes the program wait on its
        // write, as a slow terminal would, rather than queueing without limit.
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(READ_AHEAD);
        let coalesced = out.clone();
        let coalescer = thread::spawn(move || {
            coalesce(
                rx,
                |bytes| {
                    let mut out = coalesced.lock().unwrap_or_else(|e| e.into_inner());
                    out.ring.push(&bytes);
                    out.send(DATA, &bytes);
                },
                COALESCE_WINDOW,
                COALESCE_MAX_BYTES,
            );
        });

        {
            let (host, tab, out, child, activity) =
                (self.clone(), tab.clone(), out.clone(), child.clone(), activity.clone());
            let token = token.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                            if let Some(last) = &last_output {
                                if let Ok(mut at) = last.lock() {
                                    *at = Some(Instant::now());
                                }
                            }
                            if let Ok(mut act) = activity.lock() {
                                if let Some(state) = note_output(&mut act) {
                                    host.emit("pty://activity", ActivityEvent { id: tab.clone(), state });
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
                // Land the tail before the exit, so nothing a listener does on
                // `pty://exit` can overtake the last bytes the process wrote.
                drop(tx);
                let _ = coalescer.join();
                // EOF means nothing holds the slave open any more, so the child is
                // almost always already reaped; the poll covers the race where it is
                // not, and gives up rather than hanging on a process that outlives it.
                let code = poll_exit_code(&child, EXIT_WAIT, EXIT_POLL);
                host.children.revoke_token(&token);
                {
                    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
                    out.exited = Some(code);
                    out.send(EXIT, &wire::exit(code));
                    for (_, stream) in out.streams.drain(..) {
                        stream.close();
                    }
                }
                host.emit("pty://exit", ExitEvent { id: tab, code });
            });
        }

        // Watcher: no read-timeout exists on a blocking PTY reader, so a separate
        // thread polls `last_output_at` to detect the active->quiet transition
        // even when no further byte ever arrives (exactly the needs-you case).
        {
            let (host, tab) = (self.clone(), tab.clone());
            let threshold = Duration::from_millis(p.quiet_ms.unwrap_or(DEFAULT_QUIET_MS));
            thread::spawn(move || loop {
                thread::sleep(host.activity_poll());
                if !host.live(&tab) {
                    break;
                }
                if let Ok(mut act) = activity.lock() {
                    if let Some(state) = check_quiet(&mut act, threshold) {
                        host.emit("pty://activity", ActivityEvent { id: tab.clone(), state });
                    }
                }
            });
        }

        self.ptys().insert(
            tab,
            Arc::new(Pty {
                master,
                writer,
                child,
                out,
                agent: p.agent,
                profile: p.profile,
                cwd: p.cwd,
                busy,
                token,
            }),
        );
        Ok(false)
    }

    pub fn attach(
        &self,
        id: Value,
        p: &AttachParams,
        mut stream: Box<dyn Stream>,
        mut reader: BufReader<Box<dyn Stream>>,
    ) {
        let Some(pty) = self.get(&p.tab) else {
            let refused = Response::err(id, RpcError::new(INVALID_PARAMS, format!("no tab {}", p.tab)));
            let _ = write_line(&mut stream, &to_line(&refused));
            stream.close();
            return;
        };
        let write_half = match stream.try_clone_box() {
            Ok(half) => half,
            Err(e) => {
                let refused = Response::err(id, RpcError::new(INVALID_PARAMS, e.to_string()));
                let _ = write_line(&mut stream, &to_line(&refused));
                stream.close();
                return;
            }
        };
        let key = self.next_stream.fetch_add(1, Ordering::Relaxed);
        let replayed;
        {
            // Under the output lock, so no live byte lands between the ring and the stream.
            let mut out = pty.out.lock().unwrap_or_else(|e| e.into_inner());
            if write_line(&mut stream, &to_line(&Response::ok(id, json!({})))).is_err() {
                return;
            }
            let ring = if p.replay { out.ring.contents() } else { Vec::new() };
            replayed = !ring.is_empty();
            if replayed && wire::write_frame(&mut stream, DATA, &ring).is_err() {
                return;
            }
            if let Some(code) = out.exited {
                let _ = wire::write_frame(&mut stream, EXIT, &wire::exit(code));
                stream.close();
                return;
            }
            out.streams.push((key, write_half));
        }
        if replayed {
            // A size change is what makes a TUI repaint over the replayed bytes.
            pty.resize(p.cols, p.rows.saturating_sub(1).max(1));
        }
        pty.resize(p.cols, p.rows);
        while let Ok(Some((kind, payload))) = wire::read_frame(&mut reader) {
            match kind {
                DATA => pty.write(&payload),
                RESIZE => {
                    if let Some((cols, rows)) = wire::parse_resize(&payload) {
                        pty.resize(cols, rows);
                    }
                }
                _ => {}
            }
        }
        let mut out = pty.out.lock().unwrap_or_else(|e| e.into_inner());
        out.streams.retain(|(at, stream)| {
            let other = *at != key;
            if !other {
                stream.close();
            }
            other
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Activity {
        Activity {
            last_output_at: Instant::now(),
            active: false,
        }
    }

    /// A writer that keeps what was written to it, standing in for the PTY's.
    struct Recorder(Arc<Mutex<Vec<u8>>>);

    impl Write for Recorder {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn recorder() -> (SharedWriter, Arc<Mutex<Vec<u8>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(Recorder(seen.clone()))));
        (writer, seen)
    }

    /// A real child on a PTY, running `sleep`, and the master that keeps it from a hangup.
    fn sleeping() -> (SharedChild, Box<dyn MasterPty + Send>) {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("30");
        let child = Arc::new(Mutex::new(pair.slave.spawn_command(cmd).expect("spawn")));
        (child, pair.master)
    }

    #[test]
    fn the_ring_keeps_the_last_bytes_it_was_given() {
        let mut ring = Ring::new(8);
        ring.push(b"abc");
        ring.push(b"defgh");
        assert_eq!(ring.contents(), b"abcdefgh");
        ring.push(b"ij");
        assert_eq!(ring.contents(), b"cdefghij");
        ring.push(b"0123456789");
        assert_eq!(ring.contents(), b"23456789", "a chunk past the cap keeps its own tail");
    }

    /// One shell line on a real PTY, read to EOF and then polled, which is the
    /// order the reader thread does it in.
    fn ran(line: &str) -> Option<u32> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg(line);
        let child: SharedChild = Arc::new(Mutex::new(pair.slave.spawn_command(cmd).expect("spawn")));
        // Or the master never sees EOF: this process would still hold the slave.
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut buf = [0u8; 1024];
        while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        poll_exit_code(&child, EXIT_WAIT, EXIT_POLL)
    }

    /// "remounting a running task's tab re-subscribes without re-typing the
    /// command": `init` is the seam a task's command line is delivered
    /// through, and the flag makes the first delivery the only one, which is
    /// what lets a re-subscribe spawn no threads and re-type nothing.
    #[test]
    fn init_is_delivered_exactly_once_however_many_callers_arrive() {
        let (writer, seen) = recorder();
        let initialized = Arc::new(Mutex::new(false));
        for _ in 0..5 {
            deliver_init(&writer, &initialized, "npm run dev\n");
        }
        assert_eq!(
            String::from_utf8(seen.lock().unwrap().clone()).unwrap(),
            "npm run dev\n",
            "a second delivery would run the task again in the same shell"
        );
    }

    /// A rapid chunked paste arrives byte-ordered: ordering across chunks is
    /// pty_write staying sync (execution follows IPC arrival), and this pins
    /// the other half, that the writer mutex keeps each chunk whole even when
    /// writers contend, so no interleaving can split a chunk's bytes.
    #[test]
    fn concurrent_chunk_writes_never_split_a_chunk() {
        let (writer, seen) = recorder();
        let mut handles = Vec::new();
        for t in 0..4u8 {
            let writer = writer.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..50u8 {
                    let chunk = format!("<{t}:{i}>");
                    let mut w = writer.lock().unwrap();
                    w.write_all(chunk.as_bytes()).unwrap();
                    w.flush().unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let bytes = seen.lock().unwrap().clone();
        let text = String::from_utf8(bytes).unwrap();
        // Every chunk present exactly once and contiguous; per-writer order kept.
        for t in 0..4u8 {
            let mut last = -1i32;
            for i in 0..50u8 {
                let pos = text.find(&format!("<{t}:{i}>"));
                let pos = pos.expect("chunk missing or split") as i32;
                assert!(pos > last, "writer {t}'s chunks arrived out of order");
                last = pos;
            }
        }
    }

    /// A tab with nothing seeded writes nothing: a plain shell tab must not be
    /// handed a stray newline, which would print a prompt it did not ask for.
    #[test]
    fn a_tab_with_no_init_is_written_nothing() {
        let (writer, seen) = recorder();
        let initialized = Arc::new(Mutex::new(false));
        let init: Option<String> = None;
        if let Some(cmd) = &init {
            deliver_init(&writer, &initialized, cmd);
        }
        assert!(seen.lock().unwrap().is_empty());
    }

    /// "running a command in a shell tab emits active then quiet": the first
    /// chunk transitions quiet->active; once the process has been silent
    /// longer than the threshold, the watcher's check transitions back.
    #[test]
    fn transitions_active_then_quiet_after_threshold() {
        let mut act = fresh();
        assert_eq!(note_output(&mut act), Some("active"));
        assert!(act.active);

        let threshold = Duration::from_millis(50);
        // Not yet quiet: last_output_at was just stamped.
        assert_eq!(check_quiet(&mut act, threshold), None);
        assert!(act.active);

        thread::sleep(threshold + Duration::from_millis(20));
        assert_eq!(check_quiet(&mut act, threshold), Some("quiet"));
        assert!(!act.active);
    }

    /// "no event spam during a spinner redraw": a burst of reads while
    /// already active must fire the transition at most once.
    #[test]
    fn no_spam_while_already_active() {
        let mut act = fresh();
        assert_eq!(note_output(&mut act), Some("active"));
        for _ in 0..50 {
            assert_eq!(note_output(&mut act), None, "a redraw burst must not re-fire 'active'");
        }
    }

    /// A watcher poll while already quiet must not re-fire "quiet" (it only
    /// reports the transition, not the steady state).
    #[test]
    fn no_spam_while_already_quiet() {
        let mut act = fresh();
        let threshold = Duration::from_millis(30);
        note_output(&mut act);
        thread::sleep(threshold + Duration::from_millis(20));
        assert_eq!(check_quiet(&mut act, threshold), Some("quiet"));
        for _ in 0..5 {
            assert_eq!(check_quiet(&mut act, threshold), None, "steady quiet must not re-fire");
        }
    }

    /// A fresh, never-active session (e.g. a command tab that failed to
    /// spawn any output at all) must not spuriously report "quiet" - there
    /// was no "active" transition to reverse.
    #[test]
    fn never_active_never_reports_quiet() {
        let mut act = fresh();
        assert_eq!(check_quiet(&mut act, Duration::from_millis(1)), None);
    }

    /// Runs `coalesce` on a background thread and gives back the emitted
    /// chunks once the sender is dropped, so a test can count sends and
    /// reassemble the stream.
    fn run_coalesce(
        window: Duration,
        max: usize,
        feed: impl FnOnce(&std::sync::mpsc::Sender<Vec<u8>>),
    ) -> Vec<Vec<u8>> {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        let worker = thread::spawn(move || {
            coalesce(rx, |bytes| sink.lock().unwrap().push(bytes), window, max);
        });
        feed(&tx);
        drop(tx);
        worker.join().unwrap();
        let sends = out.lock().unwrap().clone();
        sends
    }

    /// The interactive case: an isolated chunk (a keystroke echo) goes out on
    /// its own, because the window closed long before it arrived. Coalescing
    /// must not put a frame of latency on typing.
    #[test]
    fn an_isolated_chunk_is_emitted_at_once() {
        let sends = run_coalesce(Duration::from_millis(16), 64 * 1024, |tx| {
            for _ in 0..4 {
                tx.send(b"x".to_vec()).unwrap();
                thread::sleep(Duration::from_millis(40));
            }
        });
        assert_eq!(sends.len(), 4, "spaced chunks must not be held for company");
    }

    /// A streaming producer costs sends at the window's rate, not its own, and
    /// the bytes come out concatenated in order: this is the whole point, and
    /// scrollback has to be identical either way.
    #[test]
    fn a_burst_coalesces_and_keeps_every_byte_in_order() {
        let chunks = 200;
        let sends = run_coalesce(Duration::from_millis(16), 64 * 1024, move |tx| {
            for i in 0..chunks {
                tx.send(format!("{i},").into_bytes()).unwrap();
                thread::sleep(Duration::from_micros(200));
            }
        });
        assert!(
            sends.len() < chunks / 4,
            "200 chunks over ~40ms should cost a handful of sends, got {}",
            sends.len()
        );
        let expected: String = (0..chunks).map(|i| format!("{i},")).collect();
        let got = String::from_utf8(sends.concat()).unwrap();
        assert_eq!(got, expected, "coalescing must not reorder or drop a byte");
    }

    /// A producer faster than the window flushes on size instead of sitting on
    /// a buffer that keeps growing.
    #[test]
    fn a_full_buffer_flushes_before_the_window_closes() {
        let max = 4096;
        let sends = run_coalesce(Duration::from_secs(60), max, move |tx| {
            for _ in 0..10 {
                tx.send(vec![b'z'; 1024]).unwrap();
            }
        });
        // A 60s window can only be beaten by the size rule.
        assert!(sends.len() >= 2, "size rule never fired, got {} send(s)", sends.len());
        assert_eq!(sends.concat().len(), 10 * 1024);
        assert!(
            sends.iter().all(|s| s.len() <= max + 1024),
            "a send overran the ceiling"
        );
    }

    /// The tail matters: whatever is pending when the reader thread goes away
    /// is emitted before `coalesce` returns, which is what lets the reader
    /// join it before emitting `pty://exit`.
    #[test]
    fn the_tail_is_emitted_when_the_sender_goes_away() {
        let sends = run_coalesce(Duration::from_secs(60), 64 * 1024, |tx| {
            tx.send(b"first".to_vec()).unwrap();
            tx.send(b"tail".to_vec()).unwrap();
        });
        assert_eq!(String::from_utf8(sends.concat()).unwrap(), "firsttail");
    }

    /// The whole reason `pty://exit` carries a code: a job that finished
    /// cleanly can close itself, and one that did not has to stay on screen.
    /// A bare id cannot tell those apart, so both had to be treated as failure.
    #[test]
    fn the_exit_code_tells_a_clean_run_from_a_failed_one() {
        assert_eq!(ran("exit 0"), Some(0), "a clean run");
        assert_eq!(ran("exit 3"), Some(3), "a failing run keeps its status");
    }

    /// A command tab's program sees the PATH the login probe captured, with no
    /// rc run in between to supply it.
    #[test]
    fn a_command_tab_runs_on_the_login_path() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let cmd = command_tab(
            "sh",
            &["-c".into(), "echo $PATH".into()],
            Some("/tori-login-only/bin:/usr/bin:/bin"),
        );
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut out = Vec::new();
        let mut buf = [0u8; 1024];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            out.extend_from_slice(&buf[..n]);
        }
        let _ = child.wait();
        let out = String::from_utf8_lossy(&out);
        assert!(
            out.contains("/tori-login-only/bin"),
            "the program saw another PATH: {out:?}"
        );
    }

    const FAST: SeedTimings = SeedTimings {
        silent: Duration::from_millis(50),
        quiet: Duration::from_millis(20),
        settle: Duration::from_secs(1),
        poll: Duration::from_millis(5),
    };

    /// A seeder over a real PTY running `program args`, typing into a recorder
    /// so a test can see whether anything was typed at all.
    fn seeded(
        program: &str,
        args: &[&str],
    ) -> (Seeder, Arc<Mutex<Vec<u8>>>, Box<dyn portable_pty::Child + Send + Sync>) {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let (writer, seen) = recorder();
        let seeder = Seeder {
            writer,
            initialized: Arc::new(Mutex::new(false)),
            init: "claude\n".into(),
            master: Arc::new(Mutex::new(pair.master)),
            shell_pid: child.process_id(),
            last_output: Arc::new(Mutex::new(None)),
        };
        (seeder, seen, child)
    }

    /// The tmux case without tmux: `set -m` gives `sleep` a process group of its
    /// own and the terminal with it, which is what an rc that attaches tmux does
    /// to the shell Tori spawned.
    #[test]
    fn a_shell_that_handed_its_terminal_on_is_not_typed_into() {
        let (seeder, seen, mut child) = seeded("/bin/sh", &["-c", "set -m; sleep 5"]);
        let deadline = Instant::now() + Duration::from_secs(2);
        let handed_on = || {
            let fg = seeder.master.lock().unwrap().process_group_leader();
            fg.is_some_and(|p| i64::from(p) != i64::from(seeder.shell_pid.unwrap()))
        };
        while !handed_on() {
            assert!(
                Instant::now() < deadline,
                "sleep never took the terminal, so this proves nothing"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let outcome = seeder.run(|| true, &FAST);
        let _ = child.kill();
        assert_eq!(outcome, Seeded::Refused("sleep".into()));
        assert!(seen.lock().unwrap().is_empty(), "typed into what took the terminal");
    }

    #[test]
    fn a_shell_that_kept_its_terminal_gets_its_init() {
        let (seeder, seen, mut child) = seeded("/bin/sh", &[]);
        let outcome = seeder.run(|| true, &FAST);
        let _ = child.kill();
        assert_eq!(outcome, Seeded::Typed);
        assert_eq!(String::from_utf8(seen.lock().unwrap().clone()).unwrap(), "claude\n");
    }

    /// The check reads the foreground through the master Tori already holds,
    /// never the slave, so a shell that exits with its init still pending
    /// reaches EOF, and so `pty://exit`, all the same.
    #[test]
    fn a_pending_init_does_not_keep_the_terminal_open() {
        let (seeder, _seen, _child) = seeded("/bin/sh", &["-c", "exit 0"]);
        let mut reader = seeder.master.lock().unwrap().try_clone_reader().expect("reader");
        let waiting = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let still = waiting.clone();
        let slow = SeedTimings {
            silent: Duration::from_secs(60),
            settle: Duration::from_secs(60),
            ..FAST
        };
        let pending = thread::spawn(move || seeder.run(|| still.load(std::sync::atomic::Ordering::SeqCst), &slow));

        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut buf = [0u8; 1024];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
            let _ = tx.send(());
        });
        let eof = rx.recv_timeout(Duration::from_secs(5));
        waiting.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(pending.join().unwrap(), Seeded::Gone);
        assert!(eof.is_ok(), "the terminal never closed while an init was pending");
    }

    /// A child still alive when the poll expires has proved nothing, so it
    /// reports no code rather than a zero. Reading that as success would close
    /// a surface over the output somebody needed.
    #[test]
    fn a_child_outliving_the_poll_reports_no_code() {
        let (child, _master) = sleeping();
        let code = poll_exit_code(&child, Duration::from_millis(50), Duration::from_millis(10));
        let _ = child.lock().unwrap().kill();
        assert_eq!(code, None);
    }

    /// The reason the poll exists at all. `pty_kill` takes this lock from the
    /// IPC thread ([[adr_no_sync_ipc_commands]]), so a blocking `wait` here
    /// would freeze every terminal in the app until the child chose to exit.
    #[test]
    fn the_exit_poll_never_blocks_a_kill() {
        let (child, _master) = sleeping();
        let polling = child.clone();
        let poll = thread::spawn(move || poll_exit_code(&polling, EXIT_WAIT, EXIT_POLL));

        thread::sleep(Duration::from_millis(30));
        let start = Instant::now();
        let _ = child.lock().unwrap().kill();
        let waited = start.elapsed();
        let code = poll.join().unwrap();

        assert!(
            waited < Duration::from_millis(500),
            "the kill waited {waited:?} on the poll"
        );
        assert!(code.is_some(), "the poll should reap the killed child, not time out");
    }
}
