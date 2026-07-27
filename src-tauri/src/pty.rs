// PTY host. Multiple concurrent sessions keyed by a string id (the Claude
// session id, or a generated id for a fresh session). Each session streams
// raw bytes to the frontend tagged with its id, so one xterm instance per
// session receives only its own output.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::env::{augmented_path, login_shell};

// How long to wait before force-seeding an agent tab's `init` command if the
// shell has produced no output yet. A shell that prints a prompt/banner trips
// the first-chunk path well before this; the timer only covers a silent shell.
const INIT_TIMEOUT_MS: u64 = 1000;

// Fallback quiet threshold for a session with no adapter-supplied one (a
// plain shell/command tab). Agent tabs pass their adapter's own
// `pty_quiet_ms` (see agents.rs), empirically measured per agent.
const DEFAULT_QUIET_MS: u64 = 2000;

// How often the activity watcher re-checks a session's last-output time
// against its quiet threshold. Small relative to any real threshold (2s+),
// so the active->quiet transition is detected promptly without busy-looping.
const ACTIVITY_POLL_MS: u64 = 200;

#[derive(Default)]
pub struct PtyState(pub Mutex<HashMap<String, Session>>);

/// Where a session's raw PTY output is streamed. Swappable so a remount/
/// re-subscribe (an idempotent pty_spawn) can rewire output to a fresh channel
/// without restarting the process.
type Sink = Arc<Mutex<Option<Channel<InvokeResponseBody>>>>;

/// The PTY writer, shared between `pty_write` and the init-delivery threads.
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: SharedWriter,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    sink: Sink,
    /// The agent session id this tab claimed, so `pty_kill` can release it.
    /// `None` for a shell/command tab, and for a fresh agent tab whose session
    /// id does not exist yet (see `pty_spawn`).
    claimed_session: Option<String>,
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

// Write the seeded `init` command to the shell exactly once. Both the reader's
// first-output-chunk trigger and the fallback timer call this; the shared flag
// makes whichever fires first the sole delivery, so a re-subscribe (which spawns
// no new threads) can never re-inject it.
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
    // "shell" | "agent" | "command". Shell/agent tabs host a login shell (the
    // agent is seeded via `init`); command tabs (clone/bootstrap) spawn the
    // program directly so a failure leaves a visible, inspectable dead tab.
    kind: String,
    // Agent tabs: the command line to type into the shell once, after it is
    // ready (e.g. "claude --resume <id>\n"). Delivered backend-once.
    init: Option<String>,
    // Quiet threshold (ms) for this session's pty://activity transitions; an
    // agent tab passes its adapter's own `pty_quiet_ms`, a shell/command tab
    // omits it and gets `DEFAULT_QUIET_MS`.
    quiet_ms: Option<u64>,
    // The agent session this tab is resuming, and which adapter it belongs to.
    // Both `None` for a shell/command tab, and for a *fresh* agent tab: its
    // session id does not exist until the agent writes a transcript, so there is
    // nothing to claim and nothing that could conflict. A resume is the case
    // that can corrupt, and it is the case that carries these.
    session_id: Option<String>,
    agent_id: Option<String>,
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
                // A PTY agent tab's child is a login shell, not the agent, so
                // its pid would never match the adapter's running pattern.
                // Recording it would make the orphan check answer "gone" for a
                // session that is in fact running.
                child_pid: None,
                sway_pid: std::process::id(),
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

    let cmd = if kind == "command" {
        // Direct spawn: the tab shows the program's own output and stays put on
        // failure. Needs the augmented PATH since no login shell runs to set it.
        let mut cmd = CommandBuilder::new(&program);
        for a in &args {
            cmd.arg(a);
        }
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("PATH", augmented_path());
        cmd
    } else {
        // Shell-hosted tab: a login + interactive shell. `-l` re-sources the
        // user's profile so the shell owns PATH (no augmented_path needed), and
        // exiting a seeded agent drops back to this live prompt.
        let mut cmd = CommandBuilder::new(login_shell());
        cmd.arg("-l");
        cmd.arg("-i");
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd
    };

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: SharedWriter =
        Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));

    let initialized = Arc::new(Mutex::new(false));

    // Fallback timer: seed `init` after a grace period even if the shell printed
    // nothing (a silent rc). Races the reader's first-chunk path; `initialized`
    // makes it exactly-once. Skipped when there is no init to deliver.
    if let Some(init_cmd) = init.clone() {
        let timer_writer = writer.clone();
        let timer_initialized = initialized.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(INIT_TIMEOUT_MS));
            deliver_init(&timer_writer, &timer_initialized, &init_cmd);
        });
    }

    let sink: Sink = Arc::new(Mutex::new(Some(on_output)));
    let reader_sink = sink.clone();
    let reader_writer = writer.clone();
    let reader_initialized = initialized.clone();
    let reader_init = init.clone();
    let app_handle = app.clone();
    let emit_id = id.clone();

    let activity: SharedActivity = Arc::new(Mutex::new(Activity { last_output_at: Instant::now(), active: false }));
    let reader_activity = activity.clone();
    let reader_activity_app = app.clone();
    let reader_activity_id = id.clone();

    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Stream raw bytes over the current channel (no base64, no
                    // global broadcast). A swapped-out channel just drops output
                    // until the next subscriber arrives.
                    if let Ok(guard) = reader_sink.lock() {
                        if let Some(ch) = guard.as_ref() {
                            let _ = ch.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
                        }
                    }
                    // First real output means the shell is up: seed the agent
                    // command now (once, guarded), well before the timer.
                    if let Some(init_cmd) = &reader_init {
                        deliver_init(&reader_writer, &reader_initialized, init_cmd);
                    }
                    if let Ok(mut act) = reader_activity.lock() {
                        if let Some(state) = note_output(&mut act) {
                            let _ = reader_activity_app
                                .emit("pty://activity", ActivityEvent { id: reader_activity_id.clone(), state });
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit("pty://exit", emit_id.clone());
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
                }
            }
        });
    }

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    guard.insert(
        id,
        Session {
            master: pair.master,
            writer,
            child,
            sink,
            claimed_session,
        },
    );
    Ok(PtySpawnResult { ownership: None })
}

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
    if let Some(mut session) = guard.remove(&id) {
        let _ = session.child.kill();
        // Give the session id back, or closing an agent tab would leave it
        // permanently unopenable until Sway restarts.
        if let Some(session_id) = &session.claimed_session {
            chat.0.registry.release(session_id, &id);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Activity {
        Activity { last_output_at: Instant::now(), active: false }
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
}
