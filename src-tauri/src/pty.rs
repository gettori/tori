// PTY host. Multiple concurrent sessions keyed by a string id (the Claude
// session id, or a generated id for a fresh session). Each session streams
// raw bytes to the frontend tagged with its id, so one xterm instance per
// session receives only its own output.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::env::{augmented_path, login_path_if_captured, login_shell};

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

#[derive(Default)]
pub struct PtyState(pub Mutex<HashMap<String, Session>>);

impl PtyState {
    /// Every live tab id, sorted. Keyed by **frontend tab id**, unlike
    /// `ChatHost::live_ids`, which answers in session ids.
    pub fn live_ids(&self) -> Result<Vec<String>, String> {
        let guard = self.0.lock().map_err(|e| e.to_string())?;
        let mut ids: Vec<String> = guard.keys().cloned().collect();
        ids.sort();
        Ok(ids)
    }

    /// Tab ids of every live agent tab running one `(agent, profile)` pair.
    ///
    /// The second table the removal guard asks, and it cannot be replaced by the
    /// claim registry: a **fresh** agent tab holds no claim until its session id
    /// exists (see `pty_spawn`), so a guard built on claims alone would delete
    /// the home of an account with an agent running in it.
    pub fn live_agent_tabs(&self, agent: &str, profile: &str) -> Vec<String> {
        let guard = match self.0.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let mut ids: Vec<String> = guard
            .iter()
            .filter(|(_, s)| {
                s.agent.as_deref() == Some(agent)
                    && s.profile.as_deref().unwrap_or(crate::accounts::DEFAULT_PROFILE_ID) == profile
            })
            .map(|(id, _)| id.clone())
            .collect();
        // A `HashMap` has no order, and a message naming tabs must not shuffle
        // between two readings of the same state.
        ids.sort();
        ids
    }

    /// What a live tab runs: its agent and account when it is an agent tab, and
    /// the folder it was opened in.
    pub fn identity(&self, tab: &str) -> Option<crate::rpc::methods::Identity> {
        let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let session = guard.get(tab)?;
        Some(crate::rpc::methods::Identity {
            account: session
                .agent
                .as_ref()
                .map(|_| session.profile.clone().unwrap_or_else(|| crate::accounts::DEFAULT_PROFILE_ID.to_string())),
            agent: session.agent.clone(),
            cwd: Some(session.cwd.clone()).filter(|cwd| !cwd.is_empty()),
        })
    }
}

/// Where a session's raw PTY output is streamed. Swappable so a remount/
/// re-subscribe (an idempotent pty_spawn) can rewire output to a fresh channel
/// without restarting the process.
type Sink = Arc<Mutex<Option<Channel<InvokeResponseBody>>>>;

/// The PTY writer, shared between `pty_write` and the init-delivery threads.
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// The child process, shared so the reader thread can read its exit status
/// after EOF while `pty_kill` can still reach the same handle to kill it.
type SharedChild = Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>;

/// The master, shared so the seeder can read the terminal's foreground through
/// it. Never the slave: macOS answers `tcgetpgrp` on a reopened slave with
/// ENOTTY, and any slave fd Tori holds keeps the reader from seeing EOF.
type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;

pub struct Session {
    master: SharedMaster,
    writer: SharedWriter,
    child: SharedChild,
    sink: Sink,
    /// The agent session id this tab claimed, so `pty_kill` can release it.
    /// `None` for a shell/command tab, and for a fresh agent tab whose session
    /// id does not exist yet (see `pty_spawn`).
    claimed_session: Option<String>,
    /// Which agent, and which of its accounts, this tab is running.
    ///
    /// Recorded for **every** agent tab, claimed or not, and that is the whole
    /// reason it is here rather than read off the claim: a fresh agent tab
    /// holds no claim until its session id exists, so a removal guard that
    /// asked the claim registry alone would delete the home of an account with
    /// a live agent in it.
    agent: Option<String>,
    profile: Option<String>,
    cwd: String,
    /// A task tab whose command still holds the terminal. Always false for
    /// every other kind.
    busy: Arc<AtomicBool>,
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
    let out = crate::env::output_with_timeout(
        std::process::Command::new("ps").args(["-o", "ucomm=", "-p", &pid.to_string()]),
    )?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!name.is_empty()).then_some(name)
}

fn command_tab(program: &str, args: &[String], login_path: Option<&str>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.env("PATH", login_path.map_or_else(augmented_path, str::to_string));
    cmd
}

/// The result of asking to open a PTY tab.
///
/// `ownership` is `None` for every tab that never took a claim - a shell tab, a
/// command tab, a fresh agent tab whose session id does not exist yet, and a
/// remount of a tab we already hold - and `Some(refusal)` when the claim was
/// declined and nothing was spawned. A granted claim also reports `None`: there
/// is nothing for the caller to do about it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnResult {
    pub ownership: Option<crate::chat::ownership::ClaimOutcome>,
}

// Sync like the rest of the pty family: the IPC thread is what serializes a
// remount's re-subscribe against a concurrent spawn of the same id (the
// check-then-insert below is only safe single-threaded), and the body is an
// openpty plus a posix_spawn, a few milliseconds at worst.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    // "shell" | "agent" | "command" | "task". A command tab is `program args`
    // itself; every other kind is a login shell, and an agent/task is seeded
    // through `init`.
    kind: String,
    // Agent/task tabs: the command line to type into the shell once, after it is
    // ready (e.g. "claude --resume <id>\n"). Delivered backend-once. Ignored
    // for a command tab, which has no shell to type into.
    init: Option<String>,
    // Quiet threshold (ms) for this session's pty://activity transitions; an
    // agent tab passes its adapter's own `pty_quiet_ms`, a shell/command tab
    // omits it and gets `DEFAULT_QUIET_MS`.
    quiet_ms: Option<u64>,
    // Extra environment for this tab's process, on top of whatever it inherits.
    // Empty for every ordinary tab; a sign-in tab carries the profile's home
    // variable, which is the whole mechanism of signing in to a second account:
    // the agent writes its credentials wherever this points, so a login tab
    // spawned without it would sign the user in to the account they already had.
    env: Option<Vec<(String, String)>>,
    // The agent session this tab is resuming, and which adapter it belongs to.
    // Both `None` for a shell/command tab, and for a *fresh* agent tab: its
    // session id does not exist until the agent writes a transcript, so there is
    // nothing to claim and nothing that could conflict. A resume is the case
    // that can corrupt, and it is the case that carries these.
    session_id: Option<String>,
    agent_id: Option<String>,
    // Which account of `agent_id` this tab runs as, `None` for the default
    // profile. Recorded rather than acted on: the env that makes it true was
    // resolved by the caller and arrives above.
    profile: Option<String>,
    on_output: Channel<InvokeResponseBody>,
    chat: State<crate::chat::host::ChatState>,
) -> Result<PtySpawnResult, String> {
    // If a session with this id already exists, rewire its output to the new
    // channel (a remount/re-subscribe) and leave the process running.
    {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(session) = guard.get(&id) {
            *session.sink.lock().map_err(|e| e.to_string())? = Some(on_output);
            return Ok(PtySpawnResult { ownership: None });
        }
    }

    // Ownership, enforced here rather than by a separate command a caller could
    // forget: an agent session driven by two processes at once appends both
    // sides of a diverging conversation to one transcript, measured, with no
    // lock and no error from the CLI. Deliberately *after* the re-subscribe
    // return above, so a tab remount is not mistaken for a second opener.
    let mut claimed_session = None;
    if let (Some(session_id), Some(agent_id)) = (&session_id, &agent_id) {
        use crate::chat::ownership::{Claim, ClaimOutcome, Surface};
        let outcome = chat.0.registry.claim(
            session_id,
            Claim {
                surface: Surface::PtyAgent,
                tab_id: id.clone(),
                agent: agent_id.clone(),
                profile: profile.clone().unwrap_or_else(|| {
                    crate::accounts::DEFAULT_PROFILE_ID.to_string()
                }),
                // A PTY agent tab's child is a login shell, not the agent, so
                // its pid would never match the adapter's running pattern.
                // Recording it would make the orphan check answer "gone" for a
                // session that is in fact running.
                child_pid: None,
                tori_pid: std::process::id(),
            },
        );
        match outcome {
            ClaimOutcome::Granted { .. } => claimed_session = Some(session_id.clone()),
            // A refusal is a value, not an error string, exactly as `chat_spawn`
            // reports one: the frontend can only offer "go to the tab holding
            // it" or "end the leftover process" if it is told which tab and
            // which pid, and it cannot parse either back out of a message.
            // Nothing is spawned either way, so the corruption stays blocked.
            refused => return Ok(PtySpawnResult { ownership: Some(refused) }),
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // A command tab never meets the user's rc, so one that attaches tmux or
    // execs another shell cannot swallow it, and `pty://exit` is its own status.
    let is_command = kind == "command";
    let init = if is_command { None } else { init };
    let mut cmd = if is_command {
        // Not `login_path()`: this is the IPC thread, and the probe can take 5 s.
        command_tab(&program, &args, login_path_if_captured())
    } else {
        // A login + interactive shell. `-l` re-sources the user's profile so the
        // shell owns PATH, and exiting a seeded agent drops back to this prompt.
        let mut cmd = CommandBuilder::new(login_shell());
        cmd.arg("-l");
        cmd.arg("-i");
        cmd
    };
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("TERM_PROGRAM", "Tori");
    cmd.env("TERM_PROGRAM_VERSION", app.package_info().version.to_string());
    let rpc_env = crate::rpc::child_env(crate::rpc::auth::Caller::Terminal(id.clone()));
    for (key, value) in crate::credential::spawn_env().into_iter().chain(rpc_env.clone()) {
        cmd.env(key, value);
    }
    let path = cmd.get_env("PATH").map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    cmd.env("PATH", crate::rpc::path_with_cli(&path));

    // Applied last, so a caller pointing an agent at a different home wins over
    // anything set above.
    for (key, value) in env.into_iter().flatten() {
        cmd.env(key, value);
    }

    let spawned = pair.slave.spawn_command(cmd).map_err(|e| e.to_string());
    if spawned.is_err() {
        crate::rpc::revoke_env(&rpc_env);
    }
    if is_command && spawned.is_err() {
        // A command that never started has still ended, and `pty://exit` is the
        // only place its verdict is read; 127 is what a shell reports here.
        let _ = app.emit("pty://exit", ExitEvent { id: id.clone(), code: Some(127) });
    }
    let child: SharedChild = Arc::new(Mutex::new(spawned?));
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: SharedWriter =
        Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    let master: SharedMaster = Arc::new(Mutex::new(pair.master));

    // An rc that attaches tmux or execs another program takes the terminal from
    // the shell, and a line typed then lands in whatever took it.
    let track_busy = kind == "task";
    let busy = Arc::new(AtomicBool::new(track_busy));
    let last_output = init.as_ref().map(|_| Arc::new(Mutex::new(None::<Instant>)));
    if let (Some(init), Some(last_output)) = (init.clone(), last_output.clone()) {
        let seeder = Seeder {
            writer: writer.clone(),
            initialized: Arc::new(Mutex::new(false)),
            init,
            master: master.clone(),
            shell_pid: child.lock().ok().and_then(|c| c.process_id()),
            last_output,
        };
        let seed_app = app.clone();
        let seed_id = id.clone();
        let seed_busy = busy.clone();
        thread::spawn(move || {
            let live = || seed_app.state::<PtyState>().0.lock().map(|g| g.contains_key(&seed_id)).unwrap_or(false);
            match seeder.run(&live, &SEED_TIMINGS) {
                Seeded::Refused(foreground) => {
                    seed_busy.store(false, Ordering::Relaxed);
                    let _ = seed_app.emit("pty://init-refused", InitRefused { id: seed_id.clone(), foreground });
                }
                Seeded::Typed if track_busy => seeder.watch_busy(&live, &seed_busy, |busy| {
                    let _ = seed_app.emit("pty://busy", BusyEvent { id: seed_id.clone(), busy });
                }),
                _ => {}
            }
        });
    }

    let sink: Sink = Arc::new(Mutex::new(Some(on_output)));
    let reader_last_output = last_output;
    let app_handle = app.clone();
    let emit_id = id.clone();
    let reader_child = child.clone();

    let activity: SharedActivity = Arc::new(Mutex::new(Activity { last_output_at: Instant::now(), active: false }));
    let reader_activity = activity.clone();
    let reader_activity_app = app.clone();
    let reader_activity_id = id.clone();

    // The reader hands bytes to a coalescer rather than to the channel, so the
    // rate of IPC sends is the window's rather than the producer's. The reader
    // itself keeps the init and activity work: both are about *when* a byte
    // arrived, and holding them for a window would delay the needs-you pulse.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let coalesce_sink = sink.clone();
    let coalescer = thread::spawn(move || {
        coalesce(
            rx,
            |bytes| {
                // Stream raw bytes over the current channel (no base64, no
                // global broadcast). A swapped-out channel just drops output
                // until the next subscriber arrives.
                if let Ok(guard) = coalesce_sink.lock() {
                    if let Some(ch) = guard.as_ref() {
                        let _ = ch.send(InvokeResponseBody::Raw(bytes));
                    }
                }
            },
            COALESCE_WINDOW,
            COALESCE_MAX_BYTES,
        );
    });

    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                    if let Some(last) = &reader_last_output {
                        if let Ok(mut at) = last.lock() {
                            *at = Some(Instant::now());
                        }
                    }
                    if let Ok(mut act) = reader_activity.lock() {
                        if let Some(state) = note_output(&mut act) {
                            let _ = reader_activity_app
                                .emit("pty://activity", ActivityEvent { id: reader_activity_id.clone(), state });
                            crate::rpc::note_pty_activity(&reader_activity_id, state);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        // Land the tail before the exit event, so nothing a listener does on
        // `pty://exit` can overtake the last bytes the process wrote.
        drop(tx);
        let _ = coalescer.join();
        // EOF means nothing holds the slave open any more, so the child is
        // almost always already reaped; the poll covers the race where it is
        // not, and gives up rather than hanging on a process that outlives it.
        let code = poll_exit_code(&reader_child, EXIT_WAIT, EXIT_POLL);
        // A tab restarted under the same id may already hold a fresh token, so
        // only this spawn's one goes.
        crate::rpc::revoke_env(&rpc_env);
        let _ = app_handle.emit("pty://exit", ExitEvent { id: emit_id, code });
    });

    // Watcher: no read-timeout exists on a blocking PTY reader, so a separate
    // thread polls `last_output_at` to detect the active->quiet transition
    // even when no further byte ever arrives (exactly the needs-you case).
    // Stops once the session is gone from PtyState (killed, or the reader
    // above already exited and the session was removed).
    {
        let watch_activity = activity.clone();
        let watch_app = app.clone();
        let watch_id = id.clone();
        let threshold = Duration::from_millis(quiet_ms.unwrap_or(DEFAULT_QUIET_MS));
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(ACTIVITY_POLL_MS));
            let still_live = watch_app
                .state::<PtyState>()
                .0
                .lock()
                .map(|g| g.contains_key(&watch_id))
                .unwrap_or(false);
            if !still_live {
                break;
            }
            if let Ok(mut act) = watch_activity.lock() {
                if let Some(state) = check_quiet(&mut act, threshold) {
                    let _ = watch_app.emit("pty://activity", ActivityEvent { id: watch_id.clone(), state });
                    crate::rpc::note_pty_activity(&watch_id, state);
                }
            }
        });
    }

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    guard.insert(
        id,
        Session {
            master,
            writer,
            child,
            sink,
            claimed_session,
            agent: agent_id,
            profile,
            cwd,
            busy,
        },
    );
    Ok(PtySpawnResult { ownership: None })
}

/// Sync by design, and it must stay that way: keystrokes are fire-and-forget,
/// so their byte order is exactly IPC arrival order run inline. Moving this to
/// the blocking pool would let two chunks of one paste race (see exec.rs).
#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(session) = guard.get(&id) {
        let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
        writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(session) = guard.get(&id) {
        session
            .master
            .lock()
            .map_err(|e| e.to_string())?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(
    state: State<PtyState>,
    chat: State<crate::chat::host::ChatState>,
    id: String,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(session) = guard.remove(&id) {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
        // Give the session id back, or closing an agent tab would leave it
        // permanently unopenable until Tori restarts.
        if let Some(session_id) = &session.claimed_session {
            chat.0.registry.release(session_id, &id);
        }
    }
    Ok(())
}

/// Every PTY session this process still holds, by **frontend tab id**, sorted.
///
/// The counterpart to `chat_live_sessions`, which answers in session ids. A
/// reload loses the tabs but not the processes, so a restore matches its stored
/// tab ids against this to know which ones only need rewiring.
#[tauri::command]
pub fn pty_live_ids(state: State<PtyState>) -> Result<Vec<String>, String> {
    state.live_ids()
}

/// Task tabs whose command still holds the terminal, by **frontend tab id**,
/// sorted. `pty://busy` carries every change after this.
#[tauri::command]
pub fn pty_busy_ids(state: State<PtyState>) -> Result<Vec<String>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let mut ids: Vec<String> =
        guard.iter().filter(|(_, s)| s.busy.load(Ordering::Relaxed)).map(|(id, _)| id.clone()).collect();
    ids.sort();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Activity {
        Activity { last_output_at: Instant::now(), active: false }
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

    /// A real PTY running `sleep`, so the state holds a session shaped exactly
    /// like a spawned one. `pty_spawn` itself needs an `AppHandle` and a
    /// `Channel`, neither of which exists in a unit test.
    fn live_session(claimed_session: Option<&str>) -> Session {
        agent_session(claimed_session, None, None)
    }

    /// A live tab, optionally on a named agent and account.
    fn agent_session(claimed_session: Option<&str>, agent: Option<&str>, profile: Option<&str>) -> Session {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("30");
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        let writer: Box<dyn Write + Send> = pair.master.take_writer().expect("writer");
        Session {
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(child)),
            sink: Arc::new(Mutex::new(None)),
            claimed_session: claimed_session.map(str::to_string),
            agent: agent.map(str::to_string),
            profile: profile.map(str::to_string),
            cwd: String::new(),
            busy: Arc::new(AtomicBool::new(false)),
        }
    }

    /// One shell line on a real PTY, read to EOF and then polled, which is the
    /// order the reader thread does it in.
    fn ran(line: &str) -> Option<u32> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
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

    /// The listing a restore matches terminal tabs against answers in **tab
    /// ids**, never the session id a tab happens to have claimed. Chat answers
    /// the other half in session ids (`ChatHost::live_ids`), so the two sets
    /// stay disjoint and a restore can match each surface by its own key.
    #[test]
    fn live_ids_are_tab_ids_not_the_sessions_those_tabs_claimed() {
        let state = PtyState::default();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert("tab-shell".into(), live_session(None));
            guard.insert("tab-agent".into(), live_session(Some("s-claimed")));
        }

        let ids = state.live_ids().unwrap();
        // Killed before the asserts, so a failing one does not leave the
        // children running for the rest of the suite.
        for session in state.0.lock().unwrap().drain().map(|(_, s)| s) {
            let _ = session.child.lock().unwrap().kill();
        }

        assert_eq!(ids, vec!["tab-agent", "tab-shell"], "sorted tab ids");
        assert!(!ids.iter().any(|id| id == "s-claimed"), "a claimed session id must not appear in the tab listing");
    }

    /// The removal guard's second table. A **fresh** agent tab holds no claim
    /// until its session id exists, so this listing is the only thing that can
    /// stop an account's home being deleted out from under one.
    #[test]
    fn a_tab_identity_is_its_folder_and_for_an_agent_tab_its_account() {
        use crate::rpc::methods::Identity;
        let state = PtyState::default();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert("shell".into(), Session { cwd: "/p".into(), ..live_session(None) });
            guard.insert("agent".into(), Session { cwd: "/p/wt".into(), ..agent_session(None, Some("claude"), None) });
        }
        assert_eq!(state.identity("shell"), Some(Identity { agent: None, account: None, cwd: Some("/p".into()) }));
        assert_eq!(
            state.identity("agent"),
            Some(Identity {
                agent: Some("claude".into()),
                account: Some(crate::accounts::DEFAULT_PROFILE_ID.into()),
                cwd: Some("/p/wt".into()),
            })
        );
        assert_eq!(state.identity("closed"), None);
    }

    #[test]
    fn live_agent_tabs_names_only_the_agent_and_account_asked_about() {
        let state = PtyState::default();
        {
            let mut guard = state.0.lock().unwrap();
            // A fresh fonn agent tab: no claimed session, and the case this
            // whole accessor exists for.
            guard.insert("tab-fresh-fonn".into(), agent_session(None, Some("claude"), Some("fonn")));
            guard.insert(
                "tab-resumed-fonn".into(),
                agent_session(Some("s-1"), Some("claude"), Some("fonn")),
            );
            guard.insert("tab-default".into(), agent_session(None, Some("claude"), None));
            guard.insert("tab-other-agent".into(), agent_session(None, Some("codex"), Some("fonn")));
            guard.insert("tab-shell".into(), live_session(None));
        }

        let fonn = state.live_agent_tabs("claude", "fonn");
        let default = state.live_agent_tabs("claude", "default");
        for session in state.0.lock().unwrap().drain().map(|(_, s)| s) {
            let _ = session.child.lock().unwrap().kill();
        }

        assert_eq!(fonn, vec!["tab-fresh-fonn", "tab-resumed-fonn"]);
        // A tab that recorded no profile ran on the login the user already had.
        assert_eq!(default, vec!["tab-default"]);
        // Another agent's tab is not this account's, and a bare shell runs no
        // agent at all, so neither can block a removal.
        assert!(!fonn.iter().any(|id| id == "tab-other-agent" || id == "tab-shell"));
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
        assert!(sends.iter().all(|s| s.len() <= max + 1024), "a send overran the ceiling");
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
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let cmd = command_tab("sh", &["-c".into(), "echo $PATH".into()], Some("/tori-login-only/bin:/usr/bin:/bin"));
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
        assert!(out.contains("/tori-login-only/bin"), "the program saw another PATH: {out:?}");
    }

    const FAST: SeedTimings = SeedTimings {
        silent: Duration::from_millis(50),
        quiet: Duration::from_millis(20),
        settle: Duration::from_secs(1),
        poll: Duration::from_millis(5),
    };

    /// A seeder over a real PTY running `program args`, typing into a recorder
    /// so a test can see whether anything was typed at all.
    fn seeded(program: &str, args: &[&str]) -> (Seeder, Arc<Mutex<Vec<u8>>>, Box<dyn portable_pty::Child + Send + Sync>) {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
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
            assert!(Instant::now() < deadline, "sleep never took the terminal, so this proves nothing");
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
        let slow = SeedTimings { silent: Duration::from_secs(60), settle: Duration::from_secs(60), ..FAST };
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
        let session = live_session(None);
        let code =
            poll_exit_code(&session.child, Duration::from_millis(50), Duration::from_millis(10));
        let _ = session.child.lock().unwrap().kill();
        assert_eq!(code, None);
    }

    /// The reason the poll exists at all. `pty_kill` takes this lock from the
    /// IPC thread ([[adr_no_sync_ipc_commands]]), so a blocking `wait` here
    /// would freeze every terminal in the app until the child chose to exit.
    #[test]
    fn the_exit_poll_never_blocks_a_kill() {
        let session = live_session(None);
        let polling = session.child.clone();
        let poll = thread::spawn(move || poll_exit_code(&polling, EXIT_WAIT, EXIT_POLL));

        thread::sleep(Duration::from_millis(30));
        let start = Instant::now();
        let _ = session.child.lock().unwrap().kill();
        let waited = start.elapsed();
        let code = poll.join().unwrap();

        assert!(waited < Duration::from_millis(500), "the kill waited {waited:?} on the poll");
        assert!(code.is_some(), "the poll should reap the killed child, not time out");
    }
}
