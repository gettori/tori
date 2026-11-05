use std::path::{Path, PathBuf};

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
    set_in(&path, on, &dir())?;
    status()
}

// A profile that cannot be read is left as it is: writing it back from empty
// would drop everything in it.
fn set_in(path: &Path, on: bool, dir: &str) -> Result<(), String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    if !on && !text.contains(MARK) {
        return Ok(());
    }
    let mut next = without_ours(&text);
    if on {
        next.push_str(&line(dir));
        next.push('\n');
    }
    if next == text {
        return Ok(());
    }
    // Through a symlink to its target, since a profile is often a dotfile link.
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    crate::owned_state::write_atomically(&target, &next).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori-shell-path-{}-{seq}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_profile_that_is_not_text_is_refused_and_left_alone() {
        let dir = tmp_dir();
        let profile = dir.join(".zprofile");
        let bytes = b"export A=1\n\xff\xfe\n";
        std::fs::write(&profile, bytes).unwrap();
        assert!(set_in(&profile, true, "/t/bin").is_err());
        assert_eq!(std::fs::read(&profile).unwrap(), bytes);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_symlinked_profile_keeps_its_link_and_a_missing_one_is_made() {
        let dir = tmp_dir();
        let real = dir.join("dotfiles-zprofile");
        std::fs::write(&real, "export A=1\n").unwrap();
        let profile = dir.join(".zprofile");
        std::os::unix::fs::symlink(&real, &profile).unwrap();
        set_in(&profile, true, "/t/bin").unwrap();
        assert!(std::fs::symlink_metadata(&profile).unwrap().file_type().is_symlink());
        let text = std::fs::read_to_string(&real).unwrap();
        assert!(
            text.starts_with("export A=1\n") && text.contains("/t/bin") && text.contains(MARK),
            "{text}"
        );
        set_in(&profile, false, "/t/bin").unwrap();
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "export A=1\n");

        let fresh = dir.join(".bash_profile");
        set_in(&fresh, true, "/t/bin").unwrap();
        assert!(std::fs::read_to_string(&fresh).unwrap().contains(MARK));
        std::fs::remove_dir_all(&dir).ok();
    }
}
