use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Mutex;

use serde::Serialize;

use crate::install::InstallRoute;

pub const MISSING: &str = "git is not installed, fix it in Settings";

// Always present on macOS: a trampoline into the Command Line Tools that opens
// Apple's installer when they are missing, so it must not be run to find out.
const APPLE_SHIM: &str = "/usr/bin/git";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GitHealth {
    Ready { path: String, version: Option<String> },
    ToolsMissing,
    NotFound,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReport {
    pub health: GitHealth,
    pub install: InstallRoute,
}

fn probe(
    resolve: impl FnOnce() -> Option<PathBuf>,
    tools_present: impl FnOnce() -> bool,
    run_version: impl FnOnce(&Path) -> Option<Output>,
) -> GitHealth {
    let Some(path) = resolve() else {
        return GitHealth::NotFound;
    };
    if path == Path::new(APPLE_SHIM) && !tools_present() {
        return GitHealth::ToolsMissing;
    }
    let out = run_version(&path);
    let stale_tools = out.as_ref().is_some_and(|o| {
        !o.status.success() && String::from_utf8_lossy(&o.stderr).contains("invalid active developer path")
    });
    if stale_tools {
        return GitHealth::ToolsMissing;
    }
    let version = out
        .filter(|o| o.status.success())
        .and_then(|o| crate::health::parse_version(&String::from_utf8_lossy(&o.stdout)));
    GitHealth::Ready {
        path: path.to_string_lossy().into_owned(),
        version,
    }
}

fn developer_tools_present() -> bool {
    crate::env::output_with_timeout(crate::platform::process::command("/usr/bin/xcode-select").arg("-p"))
        .filter(|o| o.status.success())
        .is_some_and(|o| {
            Path::new(String::from_utf8_lossy(&o.stdout).trim())
                .join("usr/bin/git")
                .is_file()
        })
}

fn check() -> GitHealth {
    probe(
        || crate::env::resolve_binary("git"),
        developer_tools_present,
        |path| crate::env::output_with_timeout(crate::platform::process::command(path).arg("--version")),
    )
}

// Only a working git is remembered, so an install made outside Tori counts on
// the very next op instead of after a restart.
static READY: Mutex<Option<GitHealth>> = Mutex::new(None);

fn current() -> GitHealth {
    let mut slot = READY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ready) = slot.as_ref() {
        return ready.clone();
    }
    let fresh = check();
    if matches!(fresh, GitHealth::Ready { .. }) {
        *slot = Some(fresh.clone());
    }
    fresh
}

fn forget() {
    *READY.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Whether the git that will actually run is at least `major.minor`, for the
/// callers that reach for a subcommand younger than the git some machines ship.
///
/// An unparsed `--version`, or no git at all, reads false. A feature gated on
/// this has to have somewhere quiet to go, and guessing yes would send it into
/// a subcommand that answers with a usage error.
pub(crate) fn at_least(major: u32, minor: u32) -> bool {
    let GitHealth::Ready {
        version: Some(version), ..
    } = current()
    else {
        return false;
    };
    let mut parts = version.split('.').map(|part| part.parse::<u32>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0)) >= (major, minor)
}

fn install_route(health: &GitHealth) -> InstallRoute {
    let (program, args) = match health {
        GitHealth::Ready { .. } => return InstallRoute::Undeclared,
        GitHealth::ToolsMissing => ("/usr/bin/xcode-select", vec!["--install"]),
        GitHealth::NotFound => ("brew", vec!["install", "git"]),
    };
    InstallRoute::Terminal {
        program: program.into(),
        args: args.into_iter().map(String::from).collect(),
    }
}

fn report(health: GitHealth) -> GitReport {
    GitReport {
        install: install_route(&health),
        health,
    }
}

pub fn run(cmd: &mut Command) -> Result<Output, String> {
    run_with(cmd, current)
}

pub(crate) fn run_with(cmd: &mut Command, health: impl FnOnce() -> GitHealth) -> Result<Output, String> {
    if !matches!(health(), GitHealth::Ready { .. }) {
        return Err(MISSING.into());
    }
    cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            forget();
            MISSING.into()
        } else {
            e.to_string()
        }
    })
}

#[tauri::command(async)]
pub fn git_health() -> GitReport {
    report(current())
}

#[tauri::command(async)]
pub fn refresh_git_health() -> GitReport {
    forget();
    report(current())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    fn recorded(code: i32, stdout: &str, stderr: &str) -> Output {
        Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn a_working_git_is_ready_with_its_version() {
        let health = probe(
            || Some(PathBuf::from("/opt/homebrew/bin/git")),
            || unreachable!("only the Apple shim needs the tools check"),
            |_| Some(recorded(0, "git version 2.54.0 (Apple Git-157)\n", "")),
        );
        assert_eq!(
            health,
            GitHealth::Ready {
                path: "/opt/homebrew/bin/git".into(),
                version: Some("2.54.0".into())
            }
        );
    }

    #[test]
    fn the_shim_without_tools_is_missing_and_never_run() {
        let health = probe(
            || Some(PathBuf::from(APPLE_SHIM)),
            || false,
            |_| panic!("running the shim opens Apple's installer"),
        );
        assert_eq!(health, GitHealth::ToolsMissing);
    }

    #[test]
    fn a_stale_developer_dir_is_missing_tools() {
        let note = "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun\n";
        let health = probe(
            || Some(PathBuf::from(APPLE_SHIM)),
            || true,
            |_| Some(recorded(1, "", note)),
        );
        assert_eq!(health, GitHealth::ToolsMissing);
    }

    #[test]
    fn no_git_on_the_login_path_is_not_found() {
        let health = probe(|| None, || unreachable!(), |_| unreachable!());
        assert_eq!(health, GitHealth::NotFound);
    }
}
