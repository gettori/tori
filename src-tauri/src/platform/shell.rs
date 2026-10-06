//! Shells, PATH, and what counts as an executable.

use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(unix)]
pub const PATH_SEP: char = ':';
#[cfg(windows)]
pub const PATH_SEP: char = ';';

#[cfg(unix)]
pub fn default_shell() -> String {
    #[cfg(target_os = "macos")]
    const FALLBACK: &str = "/bin/zsh";
    #[cfg(not(target_os = "macos"))]
    const FALLBACK: &str = "/bin/sh";
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| FALLBACK.into())
}

// The shell a terminal tab starts: PowerShell 7 when installed, then Windows
// PowerShell, which every Windows 10 and 11 ships, then `cmd`.
#[cfg(windows)]
pub fn default_shell() -> String {
    if let Some(pwsh) = std::env::var("PATH").ok().and_then(|p| resolve_binary("pwsh", &p)) {
        return pwsh.to_string_lossy().into_owned();
    }
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let powershell = Path::new(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    if powershell.is_file() {
        return powershell.to_string_lossy().into_owned();
    }
    std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into())
}

// `script` run by the user's login shell, which sources their profile and so
// knows the PATH their rc files build. `None` on Windows, where a GUI process
// already inherits the user's PATH from the registry and there is no login
// shell to ask.
#[cfg(unix)]
pub fn login_shell_command(script: &str) -> Option<Command> {
    let mut cmd = Command::new(default_shell());
    cmd.args(["-lic", script]);
    Some(cmd)
}

#[cfg(windows)]
pub fn login_shell_command(_script: &str) -> Option<Command> {
    None
}

#[cfg(windows)]
fn path_extensions() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| e.starts_with('.'))
        .map(str::to_ascii_lowercase)
        .collect()
}

#[cfg(unix)]
pub fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

// A file whose extension is in `PATHEXT`, which is all Windows has for an
// executable bit. `.ps1` is not in the default list, so an npm shim resolves to
// its `.cmd` twin, which runs under any execution policy.
#[cfg(windows)]
pub fn is_executable(path: &Path) -> bool {
    let has_ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
        .is_some_and(|e| path_extensions().contains(&e));
    has_ext && path.is_file()
}

// The full path of `program` found on `path`, extension included on Windows,
// so a caller can tell a `.cmd` shim from an `.exe` before spawning it.
pub fn resolve_binary(program: &str, path: &str) -> Option<PathBuf> {
    let dirs = path.split(PATH_SEP).filter(|dir| !dir.is_empty());
    #[cfg(unix)]
    let found = dirs
        .map(|dir| Path::new(dir).join(program))
        .find(|candidate| is_executable(candidate));
    #[cfg(windows)]
    let found = {
        let exts = path_extensions();
        let named = Path::new(program)
            .extension()
            .is_some_and(|e| exts.contains(&format!(".{}", e.to_string_lossy().to_ascii_lowercase())));
        dirs.flat_map(|dir| {
            let base = Path::new(dir).join(program);
            let mut candidates = Vec::new();
            if named {
                candidates.push(base.clone());
            }
            candidates.extend(exts.iter().map(|e| PathBuf::from(format!("{}{e}", base.display()))));
            candidates
        })
        .find(|candidate| is_executable(candidate))
    };
    found
}

// A command that prints `message` to stderr and exits with `code`, standing in
// for one that must not run. Arguments a caller appends are never executed.
#[cfg(unix)]
pub fn refusing_command(message: &'static str, code: u8) -> Command {
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", &format!("echo \"$0\" >&2; exit {code}"), message]);
    cmd
}

// The script goes in raw so the trailing `rem` swallows whatever arguments the
// caller appends; quoted, `cmd` would hand them to `exit`. `message` is a
// `'static` literal because it lands in a `cmd` line unescaped.
#[cfg(windows)]
pub fn refusing_command(message: &'static str, code: u8) -> Command {
    use std::os::windows::process::CommandExt;
    debug_assert!(message.chars().all(|c| c.is_ascii_alphanumeric() || c == ' '));
    let mut cmd = Command::new("cmd.exe");
    cmd.args(["/d", "/c"])
        .raw_arg(format!("echo {message} 1>&2 & exit /b {code} & rem"));
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_binary(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        #[cfg(unix)]
        let bin = {
            use std::os::unix::fs::PermissionsExt;
            let bin = dir.join(name);
            std::fs::write(&bin, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            bin
        };
        #[cfg(windows)]
        let bin = {
            let bin = dir.join(format!("{name}.cmd"));
            std::fs::write(&bin, "@echo off\r\n").unwrap();
            bin
        };
        bin
    }

    #[test]
    fn a_binary_is_found_only_on_the_path_that_holds_it() {
        let root = std::env::temp_dir().join(format!("tori-platform-shell-{}", std::process::id()));
        let bin = fixture_binary(&root.join("bin"), "some-agent-cli");
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();

        let path = format!("{}{PATH_SEP}{}", empty.display(), root.join("bin").display());
        assert_eq!(resolve_binary("some-agent-cli", &path), Some(bin));
        assert_eq!(resolve_binary("some-agent-cli", &empty.to_string_lossy()), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn is_executable_rejects_dirs_and_plain_files() {
        let file = std::env::temp_dir().join(format!("tori-platform-plain-{}.txt", std::process::id()));
        std::fs::write(&file, "not executable").unwrap();
        assert!(!is_executable(&file));
        assert!(!is_executable(&std::env::temp_dir()));
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn a_refused_command_fails_with_its_message_and_never_runs_its_arguments() {
        let marker = std::env::temp_dir().join(format!("tori-platform-refused-{}", std::process::id()));
        let out = refusing_command("untrusted", 128)
            .arg(format!("echo ran > {}", marker.display()))
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(128));
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "untrusted");
        assert!(!marker.exists());
    }
}
