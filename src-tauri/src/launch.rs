// Launch the user's real tools. Sway orchestrates VSCode and Ghostty rather
// than embedding approximations of them.

use std::path::Path;
use std::process::Command;

use crate::env::augmented_path;

/// Open a project folder in VSCode, or jump to a specific file/line.
#[tauri::command(async)]
pub fn open_in_vscode(
    path: String,
    file: Option<String>,
    line: Option<u32>,
) -> Result<(), String> {
    let mut cmd = Command::new("code");
    cmd.env("PATH", augmented_path());
    match file {
        Some(f) => {
            let target = match line {
                Some(l) => format!("{f}:{l}"),
                None => f,
            };
            cmd.arg("-g").arg(target);
        }
        None => {
            cmd.arg(&path);
        }
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn ghostty_bin() -> String {
    let app = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
    if Path::new(app).exists() {
        app.to_string()
    } else {
        "ghostty".to_string()
    }
}

/// Open a new Ghostty window in `cwd` running `program args...`
/// (e.g. `claude --resume <id>`). On macOS the launch form is
/// `ghostty --working-directory=<cwd> -e <program> <args...>`
/// (`+new-window` is Linux/GTK-only).
#[tauri::command(async)]
pub fn open_in_ghostty(
    cwd: String,
    program: String,
    args: Vec<String>,
) -> Result<(), String> {
    let mut cmd = Command::new(ghostty_bin());
    cmd.env("PATH", augmented_path());
    cmd.arg(format!("--working-directory={cwd}"));
    cmd.arg("-e").arg(&program);
    for a in &args {
        cmd.arg(a);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}
