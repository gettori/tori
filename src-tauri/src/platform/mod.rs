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

pub const CLI_NAME: &str = if cfg!(windows) { "tori.exe" } else { "tori" };

// On Windows the console `tori-cli.exe` beside the app, since a shell cannot
// wait on a GUI exe and git, the MCP config and the hooks all run this.
pub fn helper_exe() -> std::io::Result<std::path::PathBuf> {
    let exe = std::env::current_exe()?;
    #[cfg(windows)]
    let exe = exe.with_file_name("tori-cli.exe");
    Ok(exe)
}

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
        "checkpoint.rs",
        "config.rs",
        "crash.rs",
        "dap.rs",
        "forge/token.rs",
        "fs.rs",
        "git.rs",
        "git_health.rs",
        "icons.rs",
        "launch.rs",
        "lsp/managed.rs",
        "lsp/registry.rs",
        "mcp.rs",
        "owned_state.rs",
        "search.rs",
        "shared.rs",
        "update.rs",
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

    // Every source file outside this module, as (path, its non-comment lines).
    fn outside() -> Vec<(String, Vec<String>)> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&root, &root, &mut files);
        files
            .into_iter()
            .filter(|(rel, _)| !rel.starts_with("platform/"))
            .map(|(rel, text)| {
                let code = text
                    .lines()
                    .filter(|l| !l.trim_start().starts_with("//"))
                    .map(str::to_string)
                    .collect();
                (rel, code)
            })
            .collect()
    }

    fn matching(pattern: &str) -> BTreeSet<String> {
        let re = regex::Regex::new(pattern).unwrap();
        outside()
            .into_iter()
            .filter(|(_, code)| code.iter().any(|l| re.is_match(l)))
            .map(|(rel, _)| rel)
            .collect()
    }

    fn offenders() -> BTreeSet<String> {
        matching(concat!(
            r"std::os::unix|",
            r#""/bin/|"#,
            r#"command\("(kill|ps|pgrep|sh|sleep|osascript|open|security|sips)"\)|"#,
            r"\.mode\(0o|ExitStatusExt|libc::|/dev/urandom"
        ))
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

    #[test]
    fn every_spawn_goes_through_platform_command() {
        let found = matching(r"\bCommand::new\(");
        assert!(
            found.is_empty(),
            "these files build a std Command directly, which flashes a console window on Windows; \
             use platform::process::command instead: {found:?}"
        );
    }

    // A bare name reaches the OS lookup, which on Windows finds `name.exe`
    // only, never the `.cmd` shim npm installs. These are real executables on
    // every OS; anything else is spawned by the path `resolve_binary` gave.
    #[test]
    fn a_program_spawned_by_bare_name_is_never_a_shim() {
        const EXES: &[&str] = &["git", "node", "rg", "tar", "curl"];
        let literal = regex::Regex::new(r#"(?:process::command|CommandBuilder::new)\("([^"]+)"\)"#).unwrap();
        let shims: Vec<String> = outside()
            .into_iter()
            .filter(|(rel, _)| !KNOWN.contains(&rel.as_str()))
            .flat_map(|(rel, code)| {
                code.iter()
                    .flat_map(|l| literal.captures_iter(l).map(|c| c[1].to_string()))
                    .filter(|name| !name.starts_with('/') && !EXES.contains(&name.as_str()))
                    .map(|name| format!("{rel}: {name}"))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(
            shims.is_empty(),
            "spawn these by the path platform::shell::resolve_binary returns: {shims:?}"
        );
    }
}
