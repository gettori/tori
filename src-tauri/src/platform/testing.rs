//! What a test needs to spawn and inspect, on whichever OS it runs.

use std::path::Path;
use std::process::Command;

/// `script` run by the OS shell: `sh -c` on Unix, `cmd /d /c` on Windows.
pub fn shell_argv(script: &str) -> Vec<String> {
    #[cfg(unix)]
    let argv = ["/bin/sh", "-c", script];
    #[cfg(windows)]
    let argv = ["cmd.exe", "/d", "/c", script];
    argv.map(str::to_string).to_vec()
}

/// `script` run by a POSIX sh, for a test whose script is written in sh: the
/// Git Bash [`super::shell::posix_command`] runs on Windows.
pub fn sh_argv(script: &str) -> Vec<String> {
    #[cfg(unix)]
    let sh = "/bin/sh".to_string();
    #[cfg(windows)]
    let sh = super::shell::git_bash()
        .expect("Git for Windows is installed")
        .to_string_lossy()
        .into_owned();
    vec![sh, "-c".into(), script.into()]
}

/// An executable `dir/name` that runs `body` under a POSIX sh, standing in for
/// a tool the test cannot assume is installed. On Windows it is `name.cmd`,
/// the shape npm installs, handing the script to Git Bash.
pub fn script_bin(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join(name);
        std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }
    #[cfg(windows)]
    {
        let script = dir.join(format!("{name}.sh"));
        std::fs::write(&script, format!("{body}\n")).unwrap();
        let sh = &sh_argv("")[0];
        let bin = dir.join(format!("{name}.cmd"));
        std::fs::write(&bin, format!("@\"{sh}\" \"%~dp0{name}.sh\" %*\r\n")).unwrap();
        bin
    }
}

/// A program that exits by itself after `secs`.
pub fn sleep_argv(secs: u32) -> Vec<String> {
    #[cfg(unix)]
    let argv = vec!["/bin/sleep".to_string(), secs.to_string()];
    // `timeout` refuses to run without a console on stdin, and ping waits a
    // second between echoes.
    #[cfg(windows)]
    let argv = vec![
        "ping".to_string(),
        "-n".into(),
        (secs + 1).to_string(),
        "127.0.0.1".into(),
    ];
    argv
}

/// [`shell_argv`] as a std command.
pub fn shell_command(script: &str) -> Command {
    command(shell_argv(script))
}

/// [`sh_argv`] as a std command.
pub fn sh_command(script: &str) -> Command {
    command(sh_argv(script))
}

/// [`sleep_argv`] as a std command.
pub fn sleep_command(secs: u32) -> Command {
    let mut cmd = command(sleep_argv(secs));
    cmd.stdout(std::process::Stdio::null());
    cmd
}

fn command(argv: Vec<String>) -> Command {
    let mut cmd = super::process::command(&argv[0]);
    cmd.args(&argv[1..]);
    cmd
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
