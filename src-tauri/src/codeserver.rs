// Manages a single code-server process (real VS Code in a webview). Started on
// demand, bound to localhost with auth disabled; the frontend points an iframe
// at http://127.0.0.1:<port>/?folder=<project> and switches folders via the
// query string. Killed when the app exits.

use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::State;

#[derive(Default)]
pub struct CodeServer(pub Mutex<Option<Running>>);

pub struct Running {
    child: Child,
    port: u16,
}

impl CodeServer {
    /// Kill the running process, if any. Called on app exit.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut r) = guard.take() {
                let _ = r.child.kill();
            }
        }
    }
}

fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = vec![
        format!("{home}/.local/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
    ];
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    parts.join(":")
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port) // listener dropped here, freeing the port for code-server
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn vscode_user_dir() -> PathBuf {
    home().join("Library/Application Support/Code/User")
}

fn sway_user_data_dir() -> PathBuf {
    home().join(".local/share/sway/code-server")
}

/// Point `link` at `target` (replacing whatever is there). Used to make
/// code-server's settings/keybindings/snippets live-mirror the real VS Code.
fn relink(target: &Path, link: &Path) {
    if !target.exists() {
        return;
    }
    if let Ok(meta) = link.symlink_metadata() {
        if meta.is_dir() && !meta.file_type().is_symlink() {
            let _ = std::fs::remove_dir_all(link);
        } else {
            let _ = std::fs::remove_file(link);
        }
    }
    let _ = symlink(target, link);
}

/// Prepare a sway-managed code-server user-data-dir whose settings are
/// symlinked to the user's installed VS Code. Returns that dir.
fn prepare_user_data() -> PathBuf {
    let data = sway_user_data_dir();
    let user = data.join("User");
    let _ = std::fs::create_dir_all(&user);

    let src = vscode_user_dir();
    relink(&src.join("settings.json"), &user.join("settings.json"));
    relink(&src.join("keybindings.json"), &user.join("keybindings.json"));
    relink(&src.join("snippets"), &user.join("snippets"));
    data
}

fn wait_ready(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// Ensure code-server is running and return its base URL (no trailing slash).
#[tauri::command]
pub fn code_server_url(state: State<CodeServer>) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    // Reuse a live instance if its port still accepts connections.
    if let Some(r) = guard.as_ref() {
        if TcpStream::connect(("127.0.0.1", r.port)).is_ok() {
            return Ok(format!("http://127.0.0.1:{}", r.port));
        }
    }

    let port = free_port()?;
    let user_data = prepare_user_data();
    let extensions_dir = home().join(".vscode/extensions");

    let child = Command::new("code-server")
        .env("PATH", augmented_path())
        .arg("--auth")
        .arg("none")
        .arg("--disable-telemetry")
        .arg("--disable-update-check")
        .arg("--bind-addr")
        .arg(format!("127.0.0.1:{port}"))
        .arg("--user-data-dir")
        .arg(&user_data)
        .arg("--extensions-dir")
        .arg(&extensions_dir)
        .spawn()
        .map_err(|e| format!("failed to start code-server (is it installed?): {e}"))?;

    if !wait_ready(port, Duration::from_secs(20)) {
        return Err("code-server did not become ready in time".into());
    }

    *guard = Some(Running { child, port });
    Ok(format!("http://127.0.0.1:{port}"))
}
