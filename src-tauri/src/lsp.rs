// TS/JS language server host. Spawns the bundled typescript-language-server via
// the user's system `node` (resolved through the augmented PATH, since a
// GUI-launched process lacks Volta/Homebrew on PATH) and bridges LSP JSON-RPC
// to the frontend: stdout frames are de-framed and pushed over a Channel;
// `lsp_send` re-frames outgoing messages onto the server's stdin.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use tauri::ipc::Channel;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

use crate::env::augmented_path;

#[derive(Default)]
pub struct LspState(pub Mutex<Option<LspSession>>);

pub struct LspSession {
    child: Child,
    stdin: ChildStdin,
}

const SERVER_REL: &str = "resources/lsp/node_modules/typescript-language-server/lib/cli.mjs";

/// Locate the bundled server entry: the packaged resource first, then the dev
/// source tree on the build machine (so `tauri dev` works without bundling).
fn server_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = app.path().resolve(SERVER_REL, BaseDirectory::Resource) {
        if p.exists() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/")).join(SERVER_REL);
    if dev.exists() {
        return Some(dev);
    }
    None
}

#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    state: State<LspState>,
    project_path: String,
    on_message: Channel<String>,
) -> Result<(), String> {
    // Replace any running server (e.g. a project switch).
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
        }
    }

    let server = server_path(&app)
        .ok_or("language server not found (run `pnpm lsp:install`)")?;

    let mut child = Command::new("node")
        .arg(&server)
        .arg("--stdio")
        .current_dir(&project_path)
        .env("PATH", augmented_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn node for the language server: {e}"))?;

    let stdout = child.stdout.take().ok_or("language server has no stdout")?;
    let stdin = child.stdin.take().ok_or("language server has no stdin")?;

    // Read LSP frames (Content-Length header + body) and forward each JSON body
    // string over the channel. Exits on EOF when the server stops.
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
            let _ = on_message.send(String::from_utf8_lossy(&body).into_owned());
        }
    });

    *state.0.lock().map_err(|e| e.to_string())? = Some(LspSession { child, stdin });
    Ok(())
}

#[tauri::command]
pub fn lsp_send(state: State<LspState>, message: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().ok_or("language server not started")?;
    let header = format!("Content-Length: {}\r\n\r\n", message.len());
    session
        .stdin
        .write_all(header.as_bytes())
        .map_err(|e| e.to_string())?;
    session
        .stdin
        .write_all(message.as_bytes())
        .map_err(|e| e.to_string())?;
    session.stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn lsp_stop(state: State<LspState>) -> Result<(), String> {
    if let Some(mut old) = state.0.lock().map_err(|e| e.to_string())?.take() {
        let _ = old.child.kill();
    }
    Ok(())
}
