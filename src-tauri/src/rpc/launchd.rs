//! A dev build skips launchd: `cargo` rewrites the binary on every build, and an
//! agent pinned to that path would run whatever was built last.

use std::path::{Path, PathBuf};
use std::process::Command;

pub const LABEL: &str = "app.gettori.tori.daemon";

/// Exit codes launchd reads: `KeepAlive` relaunches only on a failure, so a
/// daemon that is replaced exits with this, and one that finds another already
/// running, or gives up, exits 0 and stays down.
pub const RESTART: i32 = 75;

pub const OFF: &str = "the daemon was uninstalled; Tori starts it again only when asked";

pub fn managed() -> bool {
    !cfg!(debug_assertions)
}

fn plist_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist"))
    })
}

fn domain() -> String {
    // SAFETY: getuid has no preconditions and cannot fail.
    format!("gui/{}", unsafe { libc::getuid() })
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn plist(exe: &Path, log: &Path) -> String {
    let (exe, log) = (escape(&exe.to_string_lossy()), escape(&log.to_string_lossy()));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardErrorPath</key>
  <string>{log}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
"#
    )
}

fn launchctl(args: &[&str]) -> Result<(), String> {
    let out = Command::new("/bin/launchctl")
        .args(args)
        .output()
        .map_err(|e| format!("launchctl: {e}"))?;
    match out.status.success() {
        true => Ok(()),
        false => Err(format!(
            "launchctl {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )),
    }
}

fn loaded() -> bool {
    launchctl(&["print", &format!("{}/{LABEL}", domain())]).is_ok()
}

// Written by `--uninstall`, so a window still open does not put it back.
fn off_path() -> PathBuf {
    crate::owned_state::config_dir().join("daemon-off")
}

pub fn is_off() -> bool {
    off_path().exists()
}

pub fn turn_on() {
    let _ = std::fs::remove_file(off_path());
}

pub fn start(log: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if is_off() {
        return Err(OFF.into());
    }
    let exe = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|e| e.to_string())?;
    let path = plist_path().ok_or("no HOME to put a LaunchAgent in")?;
    let wanted = plist(&exe, log);
    if std::fs::read_to_string(&path).ok().as_deref() != Some(wanted.as_str()) {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        std::fs::write(&path, &wanted).map_err(|e| format!("{}: {e}", path.display()))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).map_err(|e| e.to_string())?;
        let _ = launchctl(&["bootout", &format!("{}/{LABEL}", domain())]);
    }
    if !loaded() {
        launchctl(&["bootstrap", &domain(), &path.to_string_lossy()])?;
    }
    launchctl(&["kickstart", &format!("{}/{LABEL}", domain())])
}

pub fn restart_now() -> Result<(), String> {
    launchctl(&["kickstart", "-k", &format!("{}/{LABEL}", domain())])
}

pub fn uninstall() -> Result<(), String> {
    std::fs::write(off_path(), "").map_err(|e| format!("{}: {e}", off_path().display()))?;
    if loaded() {
        launchctl(&["bootout", &format!("{}/{LABEL}", domain())])?;
    }
    if let Some(path) = plist_path().filter(|p| p.exists()) {
        std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(())
}
