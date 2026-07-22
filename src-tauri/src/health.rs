// Adapter health: does the agent CLI this adapter launches actually exist on
// this machine, and does its version match what the adapter was captured
// against? Settings renders one card per adapter from this.
//
// Two rules drive the design, both about not lying to the user:
//
// 1. Resolution goes through the login-shell PATH (`crate::env::resolve_binary`),
//    never the GUI process PATH. An agent installed via nvm/asdf/mise is
//    invisible to a naive `which` from a Finder-launched app, and reporting it
//    "not installed" would send the user chasing a problem that isn't there.
//
// 2. Unknown is its own outcome, not a failure. An agent whose `--version`
//    prints a multi-line banner (or an adapter carrying no `verified_against`)
//    yields `VersionUnknown`, which the card renders as neutral text. Guessing
//    at drift from an unparseable banner would flag healthy setups as broken.
//
// Checks spawn subprocesses, so the command is async (Tauri runs it off the
// main thread) and the whole sweep is cached for the app's lifetime: the
// answer only changes when the user installs something, and a stale card is a
// far smaller cost than a UI that stalls on every Settings open.

use std::path::Path;
use std::sync::OnceLock;

use serde::Serialize;

use crate::agents::{self, AgentAdapter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BinaryStatus {
    /// The launch binary does not resolve on the login PATH.
    NotFound,
    /// Found, but either the CLI's `--version` was unparseable or the adapter
    /// declares no `verified_against` to compare it with. Renders neutral.
    VersionUnknown,
    /// Found, and the version matches what the adapter was captured against.
    VersionMatch,
    /// Found, but running a different version than the adapter was captured
    /// against. The adapter probably still works; it is a warning, not an error.
    VersionDrift,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHealth {
    pub id: String,
    pub label: String,
    /// The adapter's configured launch binary, e.g. `claude`.
    pub program: String,
    pub status: BinaryStatus,
    /// Absolute path the binary resolved to, when found.
    pub path: Option<String>,
    /// Version parsed out of `--version`, when it was parseable.
    pub version: Option<String>,
    /// The version string the adapter declares it was captured against.
    pub verified_against: Option<String>,
    /// Where sessions are discovered from, and whether that path exists yet.
    pub sessions_dir: String,
    pub sessions_dir_exists: bool,
    /// Capability flags, rendered as chips.
    pub hooks: bool,
    pub needs_you: bool,
    /// Path of the user TOML overriding this adapter, when one is loaded.
    pub override_path: Option<String>,
}

/// Pull a version out of a CLI's `--version` output.
///
/// Deliberately strict: a multi-line banner yields `None` rather than a guess
/// scraped off whichever line happened to hold digits first. `None` becomes
/// `VersionUnknown`, which renders neutral, so being wrong here would turn a
/// working install into a false drift warning.
fn parse_version(output: &str) -> Option<String> {
    let mut lines = output.lines().map(str::trim).filter(|l| !l.is_empty());
    let line = lines.next()?;
    if lines.next().is_some() {
        return None;
    }
    line.split_whitespace().find_map(|token| {
        let candidate = token.trim_start_matches('v').trim_matches(|c: char| c == '(' || c == ')');
        let looks_semver = candidate.contains('.')
            && candidate.split('.').all(|part| {
                !part.is_empty() && part.chars().next().is_some_and(|c| c.is_ascii_digit())
            });
        looks_semver.then(|| candidate.to_string())
    })
}

/// Compare a running version against the adapter's `verified_against`. Both
/// sides go through `parse_version` so `"opencode 1.18.3"` compares equal to a
/// CLI printing `"1.18.3"`.
fn compare(running: Option<&str>, verified: Option<&str>) -> BinaryStatus {
    match (running, verified.and_then(parse_version)) {
        (Some(running), Some(verified)) => {
            if running == verified {
                BinaryStatus::VersionMatch
            } else {
                BinaryStatus::VersionDrift
            }
        }
        _ => BinaryStatus::VersionUnknown,
    }
}

fn run_version(path: &Path) -> Option<String> {
    // Bounded: an agent CLI that blocks on `--version` (prompting for auth, say)
    // would otherwise strand the memoized sweep and every later caller with it.
    let out = crate::env::output_with_timeout(
        std::process::Command::new(path).arg("--version"),
    )?;
    // Some CLIs write their version to stderr; take whichever stream spoke.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let text = if stdout.trim().is_empty() {
        String::from_utf8_lossy(&out.stderr).into_owned()
    } else {
        stdout.into_owned()
    };
    parse_version(&text)
}

fn check(adapter: &AgentAdapter) -> AgentHealth {
    let resolved = crate::env::resolve_binary(&adapter.program);
    let version = resolved.as_deref().and_then(run_version);
    let status = match resolved {
        None => BinaryStatus::NotFound,
        Some(_) => compare(version.as_deref(), adapter.verified_against.as_deref()),
    };
    let sessions_dir = adapter.discovery_path();

    AgentHealth {
        id: adapter.id.clone(),
        label: adapter.label.clone(),
        program: adapter.program.clone(),
        status,
        path: resolved.map(|p| p.to_string_lossy().into_owned()),
        version,
        verified_against: adapter.verified_against.clone(),
        sessions_dir: sessions_dir.to_string_lossy().into_owned(),
        sessions_dir_exists: sessions_dir.exists(),
        hooks: adapter.hooks,
        needs_you: adapter.needs_you,
        override_path: adapter.is_override().then(|| adapter.source.clone()),
    }
}

static HEALTH: OnceLock<Vec<AgentHealth>> = OnceLock::new();

/// Health for every registered adapter, computed once per app run.
#[tauri::command]
pub async fn agent_health() -> Vec<AgentHealth> {
    HEALTH.get_or_init(|| agents::registry().iter().map(check).collect()).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_single_line_version() {
        assert_eq!(parse_version("1.18.3\n"), Some("1.18.3".into()));
        assert_eq!(parse_version("opencode 1.18.3"), Some("1.18.3".into()));
        assert_eq!(parse_version("v2.0.1"), Some("2.0.1".into()));
        assert_eq!(parse_version("1.0.0 (Claude Code)"), Some("1.0.0".into()));
        // Leading/trailing blank lines are noise, not a second line.
        assert_eq!(parse_version("\n1.2.3\n\n"), Some("1.2.3".into()));
    }

    #[test]
    fn a_multi_line_banner_is_unknown_not_a_guess() {
        let banner = "Some Agent CLI\nCopyright 2026\nversion 3.1.0\n";
        assert_eq!(parse_version(banner), None);
        // ...and that None must surface as neutral, never as drift.
        assert_eq!(compare(None, Some("3.0.0")), BinaryStatus::VersionUnknown);
    }

    #[test]
    fn output_without_a_version_token_is_unknown() {
        assert_eq!(parse_version("no version here"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn compare_matches_across_the_verified_against_prefix() {
        assert_eq!(compare(Some("1.18.3"), Some("opencode 1.18.3")), BinaryStatus::VersionMatch);
        assert_eq!(compare(Some("1.18.4"), Some("opencode 1.18.3")), BinaryStatus::VersionDrift);
        // An adapter that declares nothing to compare against is never drift.
        assert_eq!(compare(Some("1.18.3"), None), BinaryStatus::VersionUnknown);
    }

    #[test]
    fn a_missing_binary_reports_not_found() {
        // A fake adapter whose launch binary cannot exist on any machine.
        let adapter = agents::test_adapter("sway-nonexistent-agent-binary");
        let health = check(&adapter);
        assert_eq!(health.status, BinaryStatus::NotFound);
        assert!(health.path.is_none());
        assert!(health.version.is_none());
    }

    #[test]
    fn a_binary_on_the_login_path_is_found() {
        // /bin/sh is on every login PATH; resolving it by bare name exercises
        // the same lookup an nvm-installed agent CLI takes.
        let adapter = agents::test_adapter("sh");
        let health = check(&adapter);
        assert_eq!(health.status, BinaryStatus::VersionUnknown, "sh has no --version");
        assert!(health.path.is_some(), "sh should resolve on the login PATH");
    }
}
