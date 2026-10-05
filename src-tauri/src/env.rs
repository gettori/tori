// A PATH that includes the user's common bin dirs. A GUI-launched process
// inherits a minimal PATH that often lacks ~/.local/bin, ~/.cargo/bin,
// ~/.volta/bin (where node/claude live), and Homebrew. Every subprocess Tori
// spawns (PTY, external editors, the language server) uses this so binaries
// resolve the same way they do in the user's shell.

use std::path::{Path, PathBuf};

// The user's login shell, so PTY tabs spawn a real interactive shell (which
// re-sources the user's profile, and thus owns PATH itself). Falls back to zsh,
// the macOS default, when $SHELL is unset (e.g. an unusual launch environment).
pub fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into())
}

// --- login-shell PATH (agent binary resolution) ---
//
// `augmented_path` guesses at the common bin dirs; that is fine for spawning a
// subprocess (a wrong guess just means one more dir searched) but not for
// *reporting* whether an agent CLI is installed, where a false "not found" is a
// lie to the user. An agent installed via nvm/asdf/mise lives in a dir only the
// login shell knows about, so health checks resolve against the real login
// PATH, captured once per app run, and never against the GUI process PATH.
//
// The capture is sentinel-delimited: an rc file that prints a banner, a version
// notice, or a "you have mail" line would otherwise be indistinguishable from
// the PATH itself. We take only what sits between the markers, so rc-file noise
// on either side cannot corrupt the value.

const SENTINEL_BEGIN: &str = "<<<";
const SENTINEL_END: &str = ">>>";

/// Every probe here runs a third-party binary we know nothing about. One that
/// blocks (an agent CLI prompting for auth on `--version`, an rc file waiting
/// on a lock) must not become an unbounded wait: `agent_health` memoizes its
/// sweep, so a single hang would strand every later caller on the same
/// in-flight compute. Generous enough that a slow-but-working shell still
/// makes it.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Run `cmd`, giving up (and killing the child) after `timeout`.
///
/// The wait happens on a worker thread rather than a `try_wait` poll loop, so
/// the child's stdout is drained continuously: a process that outruns the pipe
/// buffer blocks on write, and a poll loop that never reads would deadlock
/// exactly the verbose-banner case this guards. On timeout we kill by pid,
/// which also unblocks that thread.
pub fn output_with_timeout(cmd: &mut std::process::Command) -> Option<std::process::Output> {
    use std::process::Stdio;

    let child = cmd
        // No stdin: a prompt should hit EOF and exit, not wait on a terminal
        // that this process can never give it.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let pid = child.id();

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(PROBE_TIMEOUT) {
        Ok(result) => result.ok(),
        Err(_) => {
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .status();
            None
        }
    }
}

/// Extract the sentinel-delimited value from a login shell's stdout. Pure, so
/// the noise cases (banner before, motd after, markers missing, empty value)
/// are unit-testable without spawning a shell.
fn extract_sentinel(stdout: &str) -> Option<String> {
    let start = stdout.find(SENTINEL_BEGIN)? + SENTINEL_BEGIN.len();
    let rest = &stdout[start..];
    let end = rest.find(SENTINEL_END)?;
    let value = &rest[..end];
    (!value.trim().is_empty()).then(|| value.to_string())
}

fn capture_login_path() -> Option<String> {
    let out = output_with_timeout(
        std::process::Command::new(login_shell())
            .args(["-lic", &format!("printf '{SENTINEL_BEGIN}%s{SENTINEL_END}' \"$PATH\"")]),
    )?;
    extract_sentinel(&String::from_utf8_lossy(&out.stdout))
}

static LOGIN_PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// The user's login-shell PATH, captured once on first use. `None` when the
/// shell could not be run or its output carried no usable sentinel value; in
/// that case callers fall back to a per-binary `command -v` probe rather than
/// silently consulting the (wrong) GUI process PATH.
pub fn login_path() -> Option<&'static str> {
    LOGIN_PATH.get_or_init(capture_login_path).as_deref()
}

pub fn login_path_if_captured() -> Option<&'static str> {
    LOGIN_PATH.get().and_then(|p| p.as_deref())
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Ask the login shell itself where `program` lives. The fallback path when
/// `login_path` came back `None`: slower (one shell per binary) but it asks the
/// only authority that is always right.
fn probe_binary(program: &str) -> Option<PathBuf> {
    // Single-quote the program and escape any embedded quote, so an adapter's
    // `launch.program` can never break out into the probe command.
    let quoted = format!("'{}'", program.replace('\'', r"'\''"));
    let out = output_with_timeout(
        std::process::Command::new(login_shell()).args(["-lic", &format!("command -v -- {quoted}")]),
    )?;
    let line = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    let path = PathBuf::from(line);
    path.is_absolute().then_some(path).filter(|p| is_executable(p))
}

/// Search a colon-separated PATH for an executable named `program`. Pure, so
/// the lookup that matters most (a binary living only in a dir the GUI process
/// never sees, e.g. an nvm shim dir) is testable without a real login shell.
fn resolve_in_path(program: &str, path: &str) -> Option<PathBuf> {
    path.split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(program))
        .find(|candidate| is_executable(candidate))
}

/// Absolute path of `program` as the user's login shell would resolve it, or
/// `None` when it is not installed. Never consults the GUI process PATH.
pub fn resolve_binary(program: &str) -> Option<PathBuf> {
    if program.contains('/') {
        let path = expand_tilde(program);
        return is_executable(&path).then_some(path);
    }
    match login_path() {
        Some(path) => resolve_in_path(program, path),
        None => probe_binary(program),
    }
}

fn expand_tilde(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => PathBuf::from(path),
    }
}

/// PATH for a child that runs the user's own tools (an agent session, its
/// hooks). The login PATH when the startup probe has it, since a dir only the
/// user's rc adds is invisible to `augmented_path`.
pub fn session_path() -> String {
    login_path_if_captured().map_or_else(augmented_path, str::to_string)
}

pub fn augmented_path() -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentinel_extraction_survives_rc_file_noise() {
        // The whole point of the markers: a chatty rc file on either side.
        assert_eq!(
            extract_sentinel("nvm: v20.11.0\n<<</usr/bin:/bin>>>You have mail.\n"),
            Some("/usr/bin:/bin".to_string())
        );
        assert_eq!(extract_sentinel("<<</usr/bin>>>"), Some("/usr/bin".to_string()));
    }

    #[test]
    fn sentinel_extraction_rejects_unusable_output() {
        // No markers at all (shell failed, or printf was shadowed).
        assert_eq!(extract_sentinel("/usr/bin:/bin"), None);
        // Opening marker only: a truncated capture is not a PATH.
        assert_eq!(extract_sentinel("<<</usr/bin"), None);
        // Present but empty, which would resolve every binary to "not found".
        assert_eq!(extract_sentinel("<<<>>>"), None);
        assert_eq!(extract_sentinel("<<<   >>>"), None);
    }

    #[test]
    fn a_binary_only_on_the_login_path_is_found() {
        // The nvm case: the agent CLI lives in a dir the GUI process PATH has
        // never heard of, so only the captured login PATH can resolve it.
        use std::os::unix::fs::PermissionsExt;
        let nvm_like = std::env::temp_dir().join(format!("tori-nvm-test-{}/bin", std::process::id()));
        std::fs::create_dir_all(&nvm_like).unwrap();
        let agent = nvm_like.join("some-agent-cli");
        std::fs::write(&agent, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();

        let login = format!("/usr/bin:{}", nvm_like.display());
        assert_eq!(resolve_in_path("some-agent-cli", &login), Some(agent));
        // Absent that dir, the same binary is invisible: the exact false
        // "not installed" this resolution path exists to prevent.
        assert_eq!(resolve_in_path("some-agent-cli", "/usr/bin:/bin"), None);

        std::fs::remove_dir_all(nvm_like.parent().unwrap()).ok();
    }

    #[test]
    fn a_hanging_child_is_killed_rather_than_waited_on_forever() {
        let start = std::time::Instant::now();
        // `sleep 60` far outlives PROBE_TIMEOUT: the call must give up early.
        let out = output_with_timeout(std::process::Command::new("/bin/sleep").arg("60"));
        assert!(out.is_none(), "a timed-out probe yields no output");
        assert!(
            start.elapsed() < PROBE_TIMEOUT * 2,
            "should return around the timeout, took {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn a_prompt_reading_stdin_sees_eof_instead_of_hanging() {
        // stdin is /dev/null, so a child that reads it terminates on its own.
        let out = output_with_timeout(&mut std::process::Command::new("/bin/cat"))
            .expect("cat should exit at EOF, well inside the timeout");
        assert!(out.stdout.is_empty());
    }

    #[test]
    fn output_with_timeout_returns_a_fast_child_normally() {
        let out = output_with_timeout(std::process::Command::new("/bin/echo").arg("hi")).expect("echo succeeds");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
    }

    #[test]
    fn resolve_binary_honours_an_absolute_path() {
        assert_eq!(resolve_binary("/bin/sh"), Some(PathBuf::from("/bin/sh")));
        assert_eq!(resolve_binary("/bin/definitely-not-a-real-binary"), None);
    }

    #[test]
    fn is_executable_rejects_dirs_and_plain_files() {
        let file = std::env::temp_dir().join(format!("tori-env-test-{}", std::process::id()));
        std::fs::write(&file, "not executable").unwrap();
        assert!(!is_executable(&file));
        assert!(!is_executable(&std::env::temp_dir()));
        assert!(is_executable(Path::new("/bin/sh")));
        std::fs::remove_file(&file).ok();
    }
}
