// Launch the user's real tools. Tori orchestrates VSCode and Ghostty rather
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

/// Is there something at `path` worth revealing?
///
/// `symlink_metadata`, so a **dangling** symlink still counts: it is a real
/// entry the user can see and repair in Finder, and following the link would
/// report it missing and offer nothing. Split out from the command so it can be
/// tested without a test run opening Finder windows.
fn check_reveal_target(path: &str) -> Result<(), String> {
    std::fs::symlink_metadata(path)
        .map(|_| ())
        .map_err(|e| format!("cannot reveal {path}: {e}"))
}

/// Reveal a file or folder in Finder, selected in its parent.
#[tauri::command(async)]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    check_reveal_target(&path)?;
    Command::new("open")
        .env("PATH", augmented_path())
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// The command itself is not called here: it opens a Finder window, and a
    /// test suite that rearranges the user's desktop is a test suite nobody
    /// runs. What is testable is the gate in front of it.
    #[test]
    fn reveal_refuses_a_path_with_nothing_at_it_and_accepts_a_broken_link() {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tori_reveal_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();

        let gone = dir.join("gone.md");
        let err = check_reveal_target(&gone.to_string_lossy()).unwrap_err();
        assert!(err.contains("cannot reveal"), "{err}");

        let broken = dir.join("broken.md");
        std::os::unix::fs::symlink(dir.join("nowhere.md"), &broken).unwrap();
        check_reveal_target(&broken.to_string_lossy())
            .expect("a dangling link is still an entry Finder can show");

        std::fs::remove_dir_all(&dir).ok();
    }
}
