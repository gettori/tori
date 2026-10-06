//! What a test needs to spawn and inspect, on whichever OS it runs.

use std::path::Path;
use std::process::Command;

/// `script` run by the OS shell: `sh -c` on Unix, `cmd /d /c` on Windows.
pub fn shell_command(script: &str) -> Command {
    #[cfg(unix)]
    {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", script]);
        cmd
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/d", "/c", script]);
        cmd
    }
}

/// A child that exits by itself after `secs`.
pub fn sleep_command(secs: u32) -> Command {
    #[cfg(unix)]
    {
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg(secs.to_string());
        cmd
    }
    #[cfg(windows)]
    {
        // `timeout` refuses to run without a console on stdin, and ping waits a
        // second between echoes.
        let mut cmd = Command::new("ping");
        cmd.args(["-n", &(secs + 1).to_string(), "127.0.0.1"]);
        cmd.stdout(std::process::Stdio::null());
        cmd
    }
}

/// Fails unless only this user can reach `path`: no group or other mode bits
/// on Unix. Windows has no mode bits to check, so there it asserts the path is
/// under the user profile, whose ACL is what keeps it private.
pub fn assert_private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let mode = std::fs::metadata(path).unwrap().mode() & 0o777;
        assert_eq!(mode & 0o077, 0, "{} is mode {mode:o}", path.display());
    }
    #[cfg(windows)]
    {
        let profile = dirs::home_dir().expect("a user profile");
        let resolved = crate::platform::fs::canonical(path).unwrap();
        let profile = crate::platform::fs::canonical(&profile).unwrap();
        assert!(
            resolved.starts_with(&profile),
            "{} is outside {}",
            path.display(),
            profile.display()
        );
    }
}
