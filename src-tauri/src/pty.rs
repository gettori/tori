// PTY host. Multiple concurrent sessions keyed by a string id (the Claude
// session id, or a generated id for a fresh session). Each session streams
// raw bytes to the frontend tagged with its id, so one xterm instance per
// session receives only its own output.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct PtyState(pub Mutex<HashMap<String, Session>>);

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Clone, Serialize)]
struct Output {
    id: String,
    data: String,
}

/// Build a PATH that includes the user's common bin dirs, since a GUI-launched
/// process inherits a minimal PATH that often lacks ~/.local/bin (where claude
/// lives), Homebrew, and volta.
fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = vec![
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/.volta/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
    ];
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    parts.join(":")
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
) -> Result<(), String> {
    // If a session with this id already exists, leave it running (idempotent).
    {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        if guard.contains_key(&id) {
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

    let mut cmd = CommandBuilder::new(&program);
    for a in &args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("PATH", augmented_path());

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    let emit_id = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app_handle.emit(
                        "pty://output",
                        Output {
                            id: emit_id.clone(),
                            data: STANDARD.encode(&buf[..n]),
                        },
                    );
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
        },
    );
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(session) = guard.get_mut(&id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())?;
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
