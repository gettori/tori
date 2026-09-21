// The project's own formatter, found the way the formatter itself finds its
// config: by walking up from the file.
//
// Tori does not ask the user which formatter to use, because the project has
// already answered. A repo with a `biome.json` formats with Biome and a repo
// with a `.prettierrc` formats with Prettier, and one with neither gets nothing
// from here at all - the editor falls back to the language server's own
// formatting, which is what it did before this module existed.
//
// Two formatters only, and both are driven over stdin/stdout rather than by
// being pointed at the file. Formatting on save has to act on what is in the
// buffer, which is by definition not what is on disk yet; a CLI told to fix a
// file in place would format the version the user is about to overwrite.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

/// Long enough for a cold `prettier` (node start plus a large file), short
/// enough that a wedged formatter cannot hold a save open forever. Deliberately
/// longer than `env::PROBE_TIMEOUT`, which sizes a `--version` probe.
const FORMAT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Formatter {
    Biome,
    Prettier,
}

impl Formatter {
    /// The binary's name, which is also its directory name under
    /// `node_modules/.bin`.
    fn program(self) -> &'static str {
        match self {
            Formatter::Biome => "biome",
            Formatter::Prettier => "prettier",
        }
    }

    /// How each one is told which file it is reading, so it can pick a parser
    /// and apply the right overrides. The two spell it differently by one
    /// hyphen, which is exactly the kind of thing to pin in a test.
    fn stdin_args(self, path: &str) -> Vec<String> {
        match self {
            Formatter::Biome => {
                vec!["format".into(), "--stdin-file-path".into(), path.into()]
            }
            Formatter::Prettier => vec!["--stdin-filepath".into(), path.into()],
        }
    }
}

/// A formatter, and the directory whose config named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    pub formatter: Formatter,
    /// The directory the config was found in. Both the formatter's working
    /// directory and where `node_modules/.bin` is looked for first.
    pub dir: PathBuf,
}

const BIOME_CONFIGS: [&str; 2] = ["biome.json", "biome.jsonc"];

/// Whether `dir` holds a Prettier config.
///
/// Matched by prefix rather than by a list of exact names: Prettier accepts
/// `.prettierrc` with any of eight extensions and `prettier.config` with five,
/// the set grows, and a name this list had not caught would silently mean "no
/// formatter" - which reads as a project that does not format.
fn has_prettier_config(dir: &Path) -> bool {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(".prettierrc") || name.starts_with("prettier.config.") {
                return true;
            }
        }
    }
    // `package.json`'s own `prettier` key, which is where a project that wants
    // no extra dotfile puts it.
    let pkg = dir.join("package.json");
    std::fs::read_to_string(pkg)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|v| v.get("prettier").is_some())
}

fn detect_in(dir: &Path) -> Option<Formatter> {
    if BIOME_CONFIGS.iter().any(|name| dir.join(name).is_file()) {
        return Some(Formatter::Biome);
    }
    has_prettier_config(dir).then_some(Formatter::Prettier)
}

/// The formatter for `file`, or `None` when the project does not have one.
///
/// Walks up from the file's own directory, nearest wins, stopping at
/// `project_root` (inclusive). Within one directory Biome wins, because a repo
/// holding both configs is one that has migrated and left the old file behind;
/// the newer tool is the one being run in CI.
///
/// Stopping at the project root is what keeps a stray `~/.prettierrc` from
/// silently reformatting every file in a project that never asked for it - and
/// that floor only exists if the root is actually above the file. A file from
/// outside the project (a Shared-tree tab) or a call with no project at all
/// would otherwise never meet the stop condition and walk all the way to `/`,
/// which is the same failure by a different route.
pub fn detect(file: &Path, project_root: &Path) -> Option<Detected> {
    if project_root.as_os_str().is_empty() || !file.starts_with(project_root) {
        return None;
    }
    let mut dir = file.parent()?;
    loop {
        if let Some(formatter) = detect_in(dir) {
            return Some(Detected { formatter, dir: dir.to_path_buf() });
        }
        if dir == project_root {
            return None;
        }
        dir = dir.parent()?;
    }
}

/// The formatter binary: the project's own copy first, the login PATH behind
/// it.
///
/// Order matters and is not a preference. A repo pins its formatter's version
/// in `package.json` precisely so everyone's output matches; a globally
/// installed Prettier one major behind would reformat the whole file on the
/// first save and put the diff in somebody's pull request.
fn resolve(formatter: Formatter, from: &Path, project_root: &Path) -> Option<PathBuf> {
    project_bin(formatter.program(), from, project_root)
}

/// `program` from the nearest `node_modules/.bin` between `from` and
/// `project_root`, else the login PATH. The resolver behind both a formatter and
/// a `project_bin` language server.
pub fn project_bin(program: &str, from: &Path, project_root: &Path) -> Option<PathBuf> {
    let mut dir = Some(from);
    while let Some(current) = dir {
        let candidate = current.join("node_modules/.bin").join(program);
        if candidate.is_file() {
            return Some(candidate);
        }
        if current == project_root {
            break;
        }
        dir = current.parent();
    }
    crate::env::resolve_binary(program)
}

/// Run `program` over `input`, returning its stdout.
///
/// Not `env::output_with_timeout`, which nulls stdin on purpose (a probe that
/// blocks on a prompt should see EOF). Here stdin *is* the document, so this
/// writes it and closes the pipe, on a thread: a formatter whose output outruns
/// the pipe buffer blocks on write while this process blocks on the stdin
/// write, and the two would deadlock waiting on each other.
fn run(program: &Path, args: &[String], cwd: &Path, input: &str) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("PATH", crate::env::augmented_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", program.display()))?;
    let pid = child.id();

    let mut stdin = child.stdin.take().ok_or("the formatter took no input")?;
    let owned = input.to_string();
    let writer = std::thread::spawn(move || {
        use std::io::Write;
        // The error is deliberately dropped: a formatter that rejects the
        // document closes stdin early, and a broken pipe here is that refusal,
        // not a separate failure. What it actually said comes back on stderr.
        let _ = stdin.write_all(owned.as_bytes());
    });

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    let output = match rx.recv_timeout(FORMAT_TIMEOUT) {
        Ok(result) => result.map_err(|e| e.to_string())?,
        Err(_) => {
            let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
            let _ = writer.join();
            return Err(format!(
                "{} did not finish within {} seconds",
                program.display(),
                FORMAT_TIMEOUT.as_secs()
            ));
        }
    };
    let _ = writer.join();

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{} exited with {}", program.display(), output.status)
        } else {
            stderr
        });
    }
    String::from_utf8(output.stdout).map_err(|_| "the formatter returned invalid UTF-8".into())
}

/// What a format attempt produced.
///
/// `text` is **always** something safe to write: the formatter's output when it
/// succeeded, and the caller's own input in every other case. There is no shape
/// of this struct that asks the caller to decide whether the text is usable,
/// because the failure that matters is a half-formatted file on disk.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormatResult {
    pub text: String,
    /// Which formatter ran. `None` means the project has none, which is the
    /// signal to fall back to the language server's own formatting.
    pub formatter: Option<Formatter>,
    /// What a detected formatter said when it refused. The text is unchanged.
    pub error: Option<String>,
}

impl FormatResult {
    fn none(text: String) -> Self {
        Self { text, formatter: None, error: None }
    }
}

/// Format `text` as the project's formatter would, addressed as `path`.
///
/// Never fails as a command. A missing binary, a syntax error, a formatter that
/// hangs: all come back as the original text plus a sentence to show, because
/// the alternative is a save that either silently does nothing or writes half a
/// file. The caller's fallback ladder reads off `formatter`: `None` means try
/// the language server instead.
#[tauri::command(async)]
pub fn format_document(path: String, text: String, project_path: String) -> FormatResult {
    let file = Path::new(&path);
    let root = Path::new(&project_path);
    let Some(detected) = detect(file, root) else {
        return FormatResult::none(text);
    };
    let Some(program) = resolve(detected.formatter, &detected.dir, root) else {
        return FormatResult {
            formatter: Some(detected.formatter),
            error: Some(format!(
                "`{}` is configured here but is not installed, so nothing was formatted.",
                detected.formatter.program()
            )),
            text,
        };
    };
    let args = detected.formatter.stdin_args(&path);
    match run(&program, &args, &detected.dir, &text) {
        Ok(formatted) => FormatResult {
            text: formatted,
            formatter: Some(detected.formatter),
            error: None,
        },
        Err(message) => FormatResult {
            text,
            formatter: Some(detected.formatter),
            error: Some(message),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_tree() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori_format_test_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// A stand-in formatter, so the plumbing (stdin in, stdout out, stderr and
    /// exit status on refusal) is tested without needing Biome or Prettier
    /// installed. Same trick as the LSP suite's `/bin/cat` echo server.
    fn stub(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn a_biome_config_names_biome() {
        let root = tmp_tree();
        touch(&root.join("biome.json"), "{}");
        touch(&root.join("src/a.ts"), "");
        let found = detect(&root.join("src/a.ts"), &root).unwrap();
        assert_eq!(found.formatter, Formatter::Biome);
        assert_eq!(found.dir, root);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn every_prettier_config_spelling_is_recognised() {
        // The list grows, and a spelling this missed would read as a project
        // that does not format rather than as an unrecognised file.
        for name in [
            ".prettierrc",
            ".prettierrc.json",
            ".prettierrc.yaml",
            ".prettierrc.js",
            ".prettierrc.mjs",
            "prettier.config.js",
            "prettier.config.mjs",
            "prettier.config.ts",
        ] {
            let root = tmp_tree();
            touch(&root.join(name), "{}");
            touch(&root.join("a.ts"), "");
            assert_eq!(
                detect(&root.join("a.ts"), &root).map(|d| d.formatter),
                Some(Formatter::Prettier),
                "{name} should name Prettier"
            );
            std::fs::remove_dir_all(&root).ok();
        }
    }

    #[test]
    fn package_json_can_carry_the_prettier_config_itself() {
        let root = tmp_tree();
        touch(&root.join("package.json"), r#"{"name":"x","prettier":{"semi":false}}"#);
        touch(&root.join("a.ts"), "");
        assert_eq!(
            detect(&root.join("a.ts"), &root).map(|d| d.formatter),
            Some(Formatter::Prettier)
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_package_json_without_the_key_names_nothing() {
        // Every JS project has a package.json; only the `prettier` key means
        // anything, and treating the file's presence as the signal would format
        // every repo on the machine.
        let root = tmp_tree();
        touch(&root.join("package.json"), r#"{"name":"x","scripts":{}}"#);
        touch(&root.join("a.ts"), "");
        assert_eq!(detect(&root.join("a.ts"), &root), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_bare_directory_has_no_formatter() {
        let root = tmp_tree();
        touch(&root.join("a.ts"), "");
        assert_eq!(detect(&root.join("a.ts"), &root), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_nearest_config_wins() {
        // A monorepo package that formats differently from the repo around it.
        let root = tmp_tree();
        touch(&root.join("biome.json"), "{}");
        touch(&root.join("packages/a/.prettierrc"), "{}");
        touch(&root.join("packages/a/src/x.ts"), "");
        let found = detect(&root.join("packages/a/src/x.ts"), &root).unwrap();
        assert_eq!(found.formatter, Formatter::Prettier);
        assert_eq!(found.dir, root.join("packages/a"));
        // And a file outside that package still gets the repo's own.
        assert_eq!(
            detect(&root.join("tools/y.ts"), &root).map(|d| d.formatter),
            Some(Formatter::Biome)
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn biome_wins_a_directory_holding_both() {
        // A migrated repo that left the old dotfile behind. The newer tool is
        // the one CI is running.
        let root = tmp_tree();
        touch(&root.join("biome.json"), "{}");
        touch(&root.join(".prettierrc"), "{}");
        touch(&root.join("a.ts"), "");
        assert_eq!(
            detect(&root.join("a.ts"), &root).map(|d| d.formatter),
            Some(Formatter::Biome)
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_walk_stops_at_the_project_root() {
        // Otherwise a stray ~/.prettierrc reformats every file in a project
        // that never asked for one.
        let outer = tmp_tree();
        touch(&outer.join(".prettierrc"), "{}");
        let root = outer.join("repo");
        touch(&root.join("src/a.ts"), "");
        assert_eq!(detect(&root.join("src/a.ts"), &root), None);
        std::fs::remove_dir_all(&outer).ok();
    }

    #[test]
    fn a_file_from_outside_the_project_gets_no_formatter() {
        // A Shared-tree tab: a real file that is not under the open project. It
        // never meets the stop condition, so without the ancestry check the
        // walk runs past it to `/` and picks up whatever config lives there.
        let outer = tmp_tree();
        touch(&outer.join(".prettierrc"), "{}");
        let root = outer.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        touch(&outer.join("elsewhere/notes.ts"), "");
        assert_eq!(detect(&outer.join("elsewhere/notes.ts"), &root), None);
        std::fs::remove_dir_all(&outer).ok();
    }

    #[test]
    fn no_project_means_no_formatter_rather_than_a_walk_to_the_root() {
        // What the editor sends when no workspace is selected. An empty root is
        // a prefix of every path, so the walk would have no floor at all.
        let root = tmp_tree();
        touch(&root.join("biome.json"), "{}");
        touch(&root.join("a.ts"), "");
        assert_eq!(detect(&root.join("a.ts"), Path::new("")), None);
        let out = format_document(
            root.join("a.ts").to_string_lossy().into(),
            "const  x=1\n".into(),
            String::new(),
        );
        assert_eq!(out, FormatResult::none("const  x=1\n".into()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn each_formatter_is_told_the_file_its_own_way() {
        // One hyphen apart, and getting it wrong means the formatter picks its
        // parser off nothing and reformats a .ts file as whatever it guesses.
        assert_eq!(
            Formatter::Biome.stdin_args("/p/a.ts"),
            vec!["format".to_string(), "--stdin-file-path".to_string(), "/p/a.ts".to_string()]
        );
        assert_eq!(
            Formatter::Prettier.stdin_args("/p/a.ts"),
            vec!["--stdin-filepath".to_string(), "/p/a.ts".to_string()]
        );
    }

    #[test]
    fn the_projects_own_binary_is_preferred_over_the_login_path() {
        // A repo pins its formatter's version so everyone's output matches; a
        // global copy one major behind would reformat the whole file on the
        // first save.
        let root = tmp_tree();
        let local = stub(&root.join("node_modules/.bin"), "prettier", "cat");
        assert_eq!(resolve(Formatter::Prettier, &root, &root), Some(local));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_project_copy_beats_a_login_path_copy_of_the_same_program() {
        // `sh` is on every PATH, so the project copy winning is the order, not luck.
        let root = tmp_tree();
        let local = stub(&root.join("node_modules/.bin"), "sh", "exit 0");
        assert_eq!(project_bin("sh", &root, &root), Some(local));
        let bare = tmp_tree();
        assert_eq!(project_bin("sh", &bare, &bare), crate::env::resolve_binary("sh"));
        assert!(project_bin("sh", &bare, &bare).is_some());
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&bare).ok();
    }

    #[test]
    fn a_nested_package_falls_back_to_the_repos_binary() {
        // The usual monorepo layout: one hoisted install at the root.
        let root = tmp_tree();
        let hoisted = stub(&root.join("node_modules/.bin"), "biome", "cat");
        std::fs::create_dir_all(root.join("packages/a")).unwrap();
        assert_eq!(
            resolve(Formatter::Biome, &root.join("packages/a"), &root),
            Some(hoisted)
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_run_sends_the_buffer_in_and_takes_the_result_out() {
        let root = tmp_tree();
        let upper = stub(&root, "upper", "tr '[:lower:]' '[:upper:]'");
        assert_eq!(run(&upper, &[], &root, "hello\n").unwrap(), "HELLO\n");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_run_carries_a_document_larger_than_a_pipe_buffer() {
        // The deadlock this guards: a formatter whose output fills the pipe
        // blocks on write while the parent blocks writing stdin. 512 KB is well
        // past the 64 KB macOS gives a pipe.
        let root = tmp_tree();
        let echo = stub(&root, "echo-all", "cat");
        let big = "x".repeat(512 * 1024);
        assert_eq!(run(&echo, &[], &root, &big).unwrap().len(), big.len());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_refusal_comes_back_as_what_the_formatter_said() {
        let root = tmp_tree();
        let angry = stub(&root, "angry", "echo 'a.ts:3:1 expected }' >&2\nexit 2");
        let err = run(&angry, &[], &root, "broken").unwrap_err();
        assert!(err.contains("expected }"), "got {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_silent_failure_still_says_something() {
        // Nothing on stderr and a non-zero exit is still a refusal, and "" is
        // not a message anyone can act on.
        let root = tmp_tree();
        let mute = stub(&root, "mute", "exit 3");
        let err = run(&mute, &[], &root, "x").unwrap_err();
        assert!(err.contains("exited with"), "got {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_wedged_formatter_cannot_hold_a_save_open_forever() {
        let root = tmp_tree();
        let slow = stub(&root, "slow", "sleep 60");
        let start = std::time::Instant::now();
        let err = run(&slow, &[], &root, "x").unwrap_err();
        assert!(err.contains("did not finish"), "got {err}");
        assert!(start.elapsed() < FORMAT_TIMEOUT * 2, "took {:?}", start.elapsed());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_project_with_no_formatter_returns_the_text_untouched() {
        let root = tmp_tree();
        touch(&root.join("a.ts"), "");
        let out = format_document(
            root.join("a.ts").to_string_lossy().into(),
            "const  x=1\n".into(),
            root.to_string_lossy().into(),
        );
        assert_eq!(out, FormatResult::none("const  x=1\n".into()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_configured_but_uninstalled_formatter_names_itself_and_changes_nothing() {
        // The state a fresh clone is in before `npm install`. Silently doing
        // nothing here would read as "this project has no formatter".
        let root = tmp_tree();
        touch(&root.join("biome.json"), "{}");
        touch(&root.join("a.ts"), "");
        // A `node_modules/.bin/biome` that is a directory, not a binary: the
        // shape of a broken install, and enough to keep the real (possibly
        // installed) `biome` on this machine out of the test.
        std::fs::create_dir_all(root.join("node_modules/.bin/biome")).unwrap();
        let out = format_document(
            root.join("a.ts").to_string_lossy().into(),
            "const  x=1\n".into(),
            root.to_string_lossy().into(),
        );
        assert_eq!(out.formatter, Some(Formatter::Biome));
        assert_eq!(out.text, "const  x=1\n");
        assert!(out.error.unwrap().contains("not installed"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_detected_formatter_runs_and_its_output_comes_back() {
        let root = tmp_tree();
        touch(&root.join(".prettierrc"), "{}");
        touch(&root.join("a.ts"), "");
        stub(&root.join("node_modules/.bin"), "prettier", "tr -d ' '");
        let out = format_document(
            root.join("a.ts").to_string_lossy().into(),
            "const  x = 1\n".into(),
            root.to_string_lossy().into(),
        );
        assert_eq!(out.formatter, Some(Formatter::Prettier));
        assert_eq!(out.error, None);
        assert_eq!(out.text, "constx=1\n");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_formatter_that_refuses_leaves_the_text_byte_identical() {
        // The one thing this must never do is write half a file. A syntax error
        // mid-edit is the common case, not the exotic one.
        let root = tmp_tree();
        touch(&root.join(".prettierrc"), "{}");
        touch(&root.join("a.ts"), "");
        stub(&root.join("node_modules/.bin"), "prettier", "echo 'unexpected token' >&2\nexit 2");
        let original = "const x = {\n";
        let out = format_document(
            root.join("a.ts").to_string_lossy().into(),
            original.into(),
            root.to_string_lossy().into(),
        );
        assert_eq!(out.text, original);
        assert_eq!(out.error.as_deref(), Some("unexpected token"));
        std::fs::remove_dir_all(&root).ok();
    }
}
