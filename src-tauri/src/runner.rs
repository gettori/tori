// A command tab's login shell outlives the command, so the command reports for
// itself: this runner script (typed as ` sh '<path>'`, one short line whatever
// the command is) runs it and prints `ESC ] 8791 ; <nonce> ; <code> BEL`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The OSC number the runner reports on. Mirrored by `COMMAND_EXIT_OSC` in
/// `src/panels/Terminal/commandExit.ts`.
pub const REPORT_OSC: u32 = 8791;

/// Where runners live. Each is deleted by the runner itself on exit; the
/// startup sweep covers the ones a crash left behind.
pub fn run_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/run")
}

pub struct Runner {
    pub path: PathBuf,
    pub nonce: String,
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Unique per spawn within this process and across runs. Not a secret: the
/// threat it answers is a replayed log, not a forgery.
fn mint_nonce() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}-{:x}-{:x}", nanos, std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
}

/// One shell word, whatever is in it. Single quotes are the only quoting that
/// disables every other character, and a literal quote becomes `'\''`.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// No raw ESC in the body: `printf` builds it at run time. The INT trap reads
/// `$?` rather than assuming 130 (a command that caught Ctrl-C and exited 0 is
/// reported as 0) and clears itself first, so a second Ctrl-C cannot report twice.
pub fn script(program: &str, args: &[String], nonce: &str) -> String {
    let words = std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(sh_quote)
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        concat!(
            "#!/bin/sh\n",
            "# Written by Sway for one command tab. Deletes itself when done.\n",
            "report() {{ printf '\\033]{osc};%s;%s\\007' {nonce} \"$1\"; }}\n",
            "trap 'c=$?; trap - INT; report \"$c\"; rm -f -- \"$0\"; exit \"$c\"' INT\n",
            "{words}\n",
            "c=$?\n",
            "trap - INT\n",
            "report \"$c\"\n",
            "rm -f -- \"$0\"\n",
            "exit \"$c\"\n",
        ),
        osc = REPORT_OSC,
        nonce = sh_quote(nonce),
        words = words,
    )
}

/// What the login shell is told to type. The leading space keeps the line out
/// of history for shells configured to ignore space-led commands; the rest is
/// one short path, however long the command behind it is.
pub fn init_line(path: &Path) -> String {
    format!(" sh {}\n", sh_quote(&path.to_string_lossy()))
}

/// Write a runner for `program args` into `dir`. Owner-only, since the command
/// line may carry a clone URL with a token in it.
pub fn write_runner_in(dir: &Path, program: &str, args: &[String]) -> Result<Runner, String> {
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let nonce = mint_nonce();
    let path = dir.join(format!("{nonce}.sh"));
    let mut open = fs::OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let mut file = open.open(&path).map_err(|e| format!("write {}: {e}", path.display()))?;
    file.write_all(script(program, args, &nonce).as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(Runner { path, nonce })
}

pub fn write_runner(program: &str, args: &[String]) -> Result<Runner, String> {
    write_runner_in(&run_dir(), program, args)
}

/// Remove every runner in `dir`. Called once at startup: a runner that is still
/// on disk then belongs to a process that died with the previous app instance.
pub fn sweep_stale_runners_in(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "sh") {
            let _ = fs::remove_file(&path);
        }
    }
}

pub fn sweep_stale_runners() {
    sweep_stale_runners_in(&run_dir());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    fn temp_run_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sway-runner-test-{tag}-{}", mint_nonce()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn report(nonce: &str, code: u32) -> String {
        format!("\x1b]{REPORT_OSC};{nonce};{code}\x07")
    }

    /// The whole reason the arguments go through `sh_quote`: a clone target
    /// with a space in it used to be safe as argv and would otherwise split
    /// into two words the moment it became shell text.
    #[test]
    fn every_argument_reaches_the_program_as_one_word() {
        let dir = temp_run_dir("quote");
        let weird = "a b$c`d;e'f\"g";
        let r = write_runner_in(&dir, "printf", &["[%s]".into(), weird.into()]).unwrap();
        let out = Command::new("/bin/sh").arg(&r.path).output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert_eq!(stdout, format!("[{weird}]{}", report(&r.nonce, 0)));
        assert!(!r.path.exists(), "the runner deletes itself on a clean exit");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A failing command keeps its status, and the report is what carries it:
    /// the PTY behind the tab is a shell that goes on living.
    #[test]
    fn a_failing_command_reports_its_own_status() {
        let dir = temp_run_dir("fail");
        let r = write_runner_in(&dir, "/bin/sh", &["-c".into(), "exit 3".into()]).unwrap();
        let out = Command::new("/bin/sh").arg(&r.path).output().unwrap();
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&out.stdout), report(&r.nonce, 3));
        assert!(!r.path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// The typed line is one path. The bootstrap is ~480 bytes of script in a
    /// single argument, and the tty's canonical limit is 1024; the line the
    /// shell sees must not scale with what the runner holds.
    #[test]
    fn the_typed_line_is_short_whatever_the_command_is() {
        let dir = temp_run_dir("short");
        let long_script = "x".repeat(480);
        let long_path = format!("/Users/someone/Projects/{}", "deep/".repeat(20));
        let r = write_runner_in(&dir, "sh", &["-c".into(), long_script, "sway".into(), long_path]).unwrap();
        let line = init_line(&r.path);
        assert!(line.len() < 200, "typed line was {} bytes", line.len());
        assert!(line.starts_with(" sh '"), "leading space keeps it out of history: {line:?}");
        assert!(!line.contains('\x1b'));
        assert!(!fs::read_to_string(&r.path).unwrap().contains('\x1b'), "no raw ESC in the file either");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_runner_is_swept_and_other_files_are_left_alone() {
        let dir = temp_run_dir("sweep");
        let stale = dir.join("abc.sh");
        let other = dir.join("notes.txt");
        fs::write(&stale, "#!/bin/sh\n").unwrap();
        fs::write(&other, "keep").unwrap();
        sweep_stale_runners_in(&dir);
        assert!(!stale.exists());
        assert!(other.exists());
        sweep_stale_runners_in(&dir.join("does-not-exist"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Bytes from a PTY master, collected on a thread so the test can wait on
    /// "output contains X" with a deadline instead of blocking on a read.
    struct Tap(Arc<Mutex<Vec<u8>>>);

    impl Tap {
        fn start(mut reader: Box<dyn Read + Send>) -> Tap {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let sink = seen.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    sink.lock().unwrap().extend_from_slice(&buf[..n]);
                }
            });
            Tap(seen)
        }

        fn wait_for(&self, needle: &str, limit: Duration) -> String {
            let deadline = Instant::now() + limit;
            loop {
                let text = String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned();
                if text.contains(needle) {
                    return text;
                }
                assert!(Instant::now() < deadline, "never saw {needle:?}; output so far:\n{text}");
                thread::sleep(Duration::from_millis(20));
            }
        }
    }

    /// The interrupt on a real tty: Ctrl-C lands on the runner's child, the
    /// runner reports 130 and is gone, and the hosting shell (`bash --norc -i`
    /// standing in for the login shell) keeps no trap and a live prompt.
    #[cfg(unix)]
    #[test]
    fn ctrl_c_reports_through_the_runner_and_leaves_the_hosting_shell_clean() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        let dir = temp_run_dir("int");
        let r = write_runner_in(&dir, "sleep", &["30".into()]).unwrap();

        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 120, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/bash");
        cmd.args(["--norc", "--noprofile", "-i"]);
        cmd.env("PS1", "READY$ ");
        cmd.env("TERM", "dumb");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let tap = Tap::start(pair.master.try_clone_reader().unwrap());
        let mut writer = pair.master.take_writer().unwrap();

        tap.wait_for("READY$ ", Duration::from_secs(5));
        writer.write_all(init_line(&r.path).as_bytes()).unwrap();
        // Until the runner is the foreground job. bash echoes the typed line
        // itself, so the echo cannot stand for "started"; a moment is what we
        // have. Generous, since a slow machine only makes the test slower.
        thread::sleep(Duration::from_millis(400));
        writer.write_all(b"\x03").unwrap();
        let text = tap.wait_for(&report(&r.nonce, 130), Duration::from_secs(5));
        assert_eq!(text.matches(&report(&r.nonce, 130)).count(), 1, "reported exactly once");

        // Back at the prompt, and it is still bash: no trap left behind.
        tap.wait_for("READY$ ", Duration::from_secs(5));
        writer.write_all(b"trap -p; echo TRAPS-LISTED; exit\n").unwrap();
        let text = tap.wait_for("TRAPS-LISTED", Duration::from_secs(5));
        let after_report = &text[text.find("130\x07").unwrap()..];
        assert!(!after_report.contains("trap -- "), "the hosting shell kept a trap:\n{after_report}");
        assert!(!r.path.exists(), "the runner deletes itself on interrupt too");
        let _ = child.wait();
        let _ = fs::remove_dir_all(&dir);
    }
}
