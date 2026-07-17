// PTY host. Multiple concurrent sessions keyed by a string id (the Claude
// session id, or a generated id for a fresh session). Each session streams
// raw bytes to the frontend tagged with its id, so one xterm instance per
// session receives only its own output.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use crate::env::{augmented_path, login_shell};

// How long to wait before force-seeding an agent tab's `init` command if the
// shell has produced no output yet. A shell that prints a prompt/banner trips
// the first-chunk path well before this; the timer only covers a silent shell.
const INIT_TIMEOUT_MS: u64 = 1000;

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
    on_output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    // If a session with this id already exists, rewire its output to the new
    // channel (a remount/re-subscribe) and leave the process running.
    {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(session) = guard.get(&id) {
            *session.sink.lock().map_err(|e| e.to_string())? = Some(on_output);
            return Ok(());
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
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit("pty://exit", emit_id.clone());
    });

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    guard.insert(
        id,
        Session {
            master: pair.master,
            writer,
            child,
            sink,
        },
    );
    Ok(())
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
pub fn pty_kill(state: State<PtyState>, id: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = guard.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}
