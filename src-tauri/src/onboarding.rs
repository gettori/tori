// First-run onboarding: open Settings on the Agents cards once, for a user who
// has nothing yet, so their first sight of Sway explains what it needs rather
// than an empty sidebar.
//
// The gate is deliberately two conditions, not one:
//
// 1. Zero sessions discovered, decided by *scanning* every adapter's discovery
//    location here in the backend. This is a complete, synchronous answer, not
//    a "is the frontend's list empty yet?" check at t=0, which would race the
//    async scan and show onboarding to an existing user whose sessions simply
//    had not loaded. It reads the real directories, so a cold mtime cache
//    cannot make a populated setup look empty either.
//
// 2. A persisted `onboarding_shown` flag, set the moment it displays. So a
//    fresh user who opens Sway, reads the cards, and creates nothing still
//    sees it exactly once rather than on every launch until they happen to
//    start a session.
//
// The flag lives in state.json, not settings.json: settings.json is
// hand-editable user preference, and "have we shown this yet" is app state
// that has no business appearing in it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::agents::{self, AgentAdapter, Discovery};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default)]
    pub onboarding_shown: bool,
}

fn state_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/state.json")
}

// --- pure core (explicit path, no globals), unit-tested off-disk ---

fn load_from(path: &Path) -> State {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<State>(&t).ok())
        .unwrap_or_default()
}

fn save_to(path: &Path, state: &State) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Does this adapter have at least one session on disk? Stops at the first
/// hit: we only need existence, never the count, so a user with thousands of
/// transcripts pays for one directory entry.
fn has_any_session(adapter: &AgentAdapter) -> bool {
    match &adapter.discovery {
        // Mirrors the sessions.rs layout: <dir>/<project slug>/<id>.jsonl.
        // Files sitting directly in `dir` count too, so an adapter with a flat
        // layout is not reported empty.
        Discovery::File { dir, filename_regex } => {
            let matches = |p: &Path| {
                p.file_name().and_then(|n| n.to_str()).is_some_and(|n| filename_regex.is_match(n))
            };
            let Ok(entries) = std::fs::read_dir(dir) else {
                return false;
            };
            entries.flatten().any(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    std::fs::read_dir(&path)
                        .map(|inner| inner.flatten().any(|f| matches(&f.path())))
                        .unwrap_or(false)
                } else {
                    matches(&path)
                }
            })
        }
        // An empty DB file is created by opencode on first run, so existence
        // alone would be a false positive; a real session gives it size.
        Discovery::Sqlite { db_path } => {
            std::fs::metadata(db_path).map(|m| m.len() > 0).unwrap_or(false)
        }
    }
}

fn should_show_with(state: &State, adapters: &[AgentAdapter]) -> bool {
    !state.onboarding_shown && !adapters.iter().any(has_any_session)
}

// --- thin wrappers over the real path ---

/// Whether first-run onboarding should open. Scans every adapter's discovery
/// location, so this is safe to call at launch without racing anything.
#[tauri::command]
pub async fn onboarding_should_show() -> bool {
    should_show_with(&load_from(&state_path()), agents::registry())
}

/// Record that onboarding has been shown. Called the moment it displays, not
/// when it is dismissed: a user who quits mid-welcome has still seen it.
#[tauri::command]
pub fn onboarding_mark_shown() -> Result<(), String> {
    let path = state_path();
    let mut state = load_from(&path);
    state.onboarding_shown = true;
    save_to(&path, &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("sway-onboarding-{tag}-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An adapter discovering sessions from `dir` rather than the real `~`.
    fn adapter_at(dir: &Path) -> AgentAdapter {
        let mut a = agents::test_adapter("x");
        a.discovery = Discovery::File {
            dir: dir.to_path_buf(),
            filename_regex: regex::Regex::new(r"^(?P<id>.+)\.jsonl$").unwrap(),
        };
        a
    }

    #[test]
    fn missing_state_file_yields_defaults() {
        let p = std::env::temp_dir().join("sway-state-does-not-exist.json");
        let _ = std::fs::remove_file(&p);
        assert!(!load_from(&p).onboarding_shown);
    }

    #[test]
    fn shows_once_then_never_again() {
        let p = tmp_dir("flag").join("state.json");
        let empty = tmp_dir("flag-sessions");
        let adapters = vec![adapter_at(&empty)];

        let mut state = load_from(&p);
        assert!(should_show_with(&state, &adapters), "fresh user with no sessions sees it");

        // What `onboarding_mark_shown` does, against an explicit path.
        state.onboarding_shown = true;
        save_to(&p, &state).unwrap();
        assert!(
            !should_show_with(&load_from(&p), &adapters),
            "second launch does not, even though still no session exists"
        );

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
        std::fs::remove_dir_all(&empty).ok();
    }

    #[test]
    fn an_existing_user_never_sees_it() {
        // A populated sessions dir in the real nested layout: one transcript
        // is enough, and it is found by scanning, not by a warm cache.
        let dir = tmp_dir("existing");
        let project = dir.join("-Users-someone-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("abc-123.jsonl"), "{}\n").unwrap();

        assert!(!should_show_with(&State::default(), &[adapter_at(&dir)]));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_flat_layout_session_also_counts() {
        let dir = tmp_dir("flat");
        std::fs::write(dir.join("abc-123.jsonl"), "{}\n").unwrap();
        assert!(!should_show_with(&State::default(), &[adapter_at(&dir)]));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unrelated_files_do_not_count_as_sessions() {
        let dir = tmp_dir("noise");
        let project = dir.join("some-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("README.md"), "not a session").unwrap();

        assert!(should_show_with(&State::default(), &[adapter_at(&dir)]));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_discovery_dir_is_simply_empty() {
        let dir = std::env::temp_dir().join("sway-onboarding-absent-dir");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(should_show_with(&State::default(), &[adapter_at(&dir)]));
    }
}
