use std::path::PathBuf;

use serde::Serialize;

const MARK: &str = "# added by Tori: the tori command";

#[derive(Serialize)]
pub struct ShellPath {
    on: bool,
    profile: String,
    dir: String,
}

fn profile() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let file = match crate::env::login_shell().ends_with("bash") {
        true => ".bash_profile",
        false => ".zprofile",
    };
    Some(home.join(file))
}

fn dir() -> String {
    crate::rpc::daemon::paths().cli_link_dir.to_string_lossy().into_owned()
}

fn line(dir: &str) -> String {
    format!("export PATH=\"{dir}:$PATH\" {MARK}")
}

fn without_ours(text: &str) -> String {
    let kept: Vec<&str> = text.lines().filter(|l| !l.contains(MARK)).collect();
    match kept.is_empty() {
        true => String::new(),
        false => format!("{}\n", kept.join("\n")),
    }
}

fn status() -> Result<ShellPath, String> {
    let path = profile().ok_or("no HOME to find a shell profile in")?;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    Ok(ShellPath {
        on: text.lines().any(|l| l.contains(MARK)),
        profile: path.to_string_lossy().into_owned(),
        dir: dir(),
    })
}

#[tauri::command]
pub fn shell_path_status() -> Result<ShellPath, String> {
    status()
}

#[tauri::command]
pub fn shell_path_set(on: bool) -> Result<ShellPath, String> {
    let path = profile().ok_or("no HOME to find a shell profile in")?;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    if !on && !text.contains(MARK) {
        return status();
    }
    let mut next = without_ours(&text);
    if on {
        next.push_str(&line(&dir()));
        next.push('\n');
    }
    if next != text {
        std::fs::write(&path, next).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    status()
}
