//! Every difference between macOS, Windows and Linux lives here, and nowhere
//! else in the crate.
//!
//! The contract:
//!
//! - Code outside this module never names `std::os::unix` or
//!   `std::os::windows`, never spawns a Unix tool (`sh`, `kill`, `ps`, `pgrep`,
//!   `sleep`, `open`, `osascript`, `security`, `sips`), and never sets a file
//!   mode. It calls the function here that says what it wants instead. The
//!   gate test below enforces this, test modules included.
//! - Each function has one arm per OS. Where Unix behaviour is the same on
//!   macOS and Linux the arm is `cfg(unix)`; where only macOS has an
//!   implementation, Linux gets an explicit stub that errors naming #21.
//! - Paths leave the backend through [`fs::display`] (forward slashes) and
//!   become keys through [`fs::canonical`], so the frontend never sees a
//!   backslash and one folder never has two spellings.

pub mod fs;
pub mod ipc;
pub mod native;
pub mod process;
pub mod shell;
#[cfg(test)]
pub mod testing;

#[cfg(test)]
mod gate {
    use std::collections::BTreeSet;
    use std::path::Path;

    /// Files that still call around this module, from the Windows inventory.
    /// Each migration phase deletes its entries; the list ends empty.
    const KNOWN: &[&str] = &[
        "accounts.rs",
        "agent_config.rs",
        "attempts.rs",
        "auth.rs",
        "catalog_probe.rs",
        "chat/acp_transport.rs",
        "chat/claude_transport.rs",
        "chat/commands.rs",
        "chat/host.rs",
        "chat/ownership.rs",
        "chat/transport.rs",
        "checkpoint.rs",
        "config.rs",
        "crash.rs",
        "dap.rs",
        "dap/cargo.rs",
        "env.rs",
        "exec.rs",
        "forge/token.rs",
        "format.rs",
        "fs.rs",
        "git.rs",
        "git_health.rs",
        "icons.rs",
        "launch.rs",
        "lsp.rs",
        "lsp/managed.rs",
        "lsp/registry.rs",
        "mcp.rs",
        "owned_state.rs",
        "pty.rs",
        "rpc/mod.rs",
        "search.rs",
        "sessions.rs",
        "setup.rs",
        "shared.rs",
        "update.rs",
        "usage_probe.rs",
        "worktree.rs",
    ];

    fn sources(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                sources(&path, root, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.push((rel, std::fs::read_to_string(&path).unwrap()));
            }
        }
    }

    fn offenders() -> BTreeSet<String> {
        let unix_only = regex::Regex::new(concat!(
            r"std::os::unix|",
            r#""/bin/|"#,
            r#"Command::new\("(kill|ps|pgrep|sh|sleep|osascript|open|security|sips)"\)|"#,
            r"\.mode\(0o|ExitStatusExt|libc::|/dev/urandom"
        ))
        .unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&root, &root, &mut files);
        files
            .into_iter()
            .filter(|(rel, _)| !rel.starts_with("platform/"))
            .filter(|(_, text)| {
                text.lines()
                    .any(|l| !l.trim_start().starts_with("//") && unix_only.is_match(l))
            })
            .map(|(rel, _)| rel)
            .collect()
    }

    #[test]
    fn unix_only_calls_stay_inside_platform() {
        let found = offenders();
        let known: BTreeSet<String> = KNOWN.iter().map(|s| s.to_string()).collect();
        let new: Vec<_> = found.difference(&known).collect();
        assert!(
            new.is_empty(),
            "these files call a Unix-only API outside platform/, use the platform module instead: {new:?}"
        );
        let cleaned: Vec<_> = known.difference(&found).collect();
        assert!(
            cleaned.is_empty(),
            "these files no longer call around platform/, delete them from KNOWN: {cleaned:?}"
        );
    }
}
