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
    /// Whether the "your imported VS Code theme was dropped" notice has fired.
    /// Same reasoning as `onboarding_shown`: shown-once state, not preference.
    #[serde(default)]
    pub theme_import_notice_shown: bool,
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
    let Some(discovery) = &adapter.discovery else {
        // A protocol-backed adapter keeps nothing here to walk. Sway's own
        // record of what its protocol said is the equivalent evidence, and it
        // is the right one to use: a user whose only agent is an ACP one has
        // still used Sway, and greeting them with onboarding would say
        // otherwise.
        return crate::chat::acp_sessions::all().iter().any(|s| s.agent == adapter.id);
    };
    match discovery {
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
    }
}

fn should_show_with(state: &State, adapters: &[AgentAdapter]) -> bool {
    !state.onboarding_shown && !adapters.iter().any(has_any_session)
}

/// What first-run onboarding should actually say.
///
/// Separate from [`should_show_with`], and deliberately so: *whether* to greet
/// somebody is a question about their sessions, and *what to say* is a question
/// about their machine. Folding the binary check into the predicate would
/// change who sees onboarding at all, which is a different feature and a
/// regression for the user who has Sway working already.
///
/// The copy this drives used to be one fixed line telling the user to check
/// "which ones it found below". On a machine with nothing installed that is
/// advice to go look at four rows of "not found", which reads as Sway being
/// broken rather than as a step the user has not taken yet.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OnboardingContent {
    /// No adapter's binary resolves. Carries the agent names so the greeting
    /// can say what to install rather than only that something is missing.
    NoAgent { supported: Vec<String> },
    /// At least one agent resolves, so Sway has something to drive and the
    /// first-run copy is about Sway rather than about installing anything.
    FirstRun,
}

/// Pure core: `installed` answers whether an adapter's binary resolved, so this
/// is tested without a PATH and without spawning anything.
fn content_with(adapters: &[AgentAdapter], installed: impl Fn(&str) -> bool) -> OnboardingContent {
    if adapters.iter().any(|a| installed(&a.id)) {
        return OnboardingContent::FirstRun;
    }
    OnboardingContent::NoAgent {
        supported: adapters.iter().map(|a| a.label.clone()).collect(),
    }
}

// --- thin wrappers over the real path ---

/// Read state.json. Shared so other one-time notices (the dropped theme import
/// in settings.rs) persist their flag in the same file rather than growing a
/// second one, or worse, landing in settings.json.
pub(crate) fn load_state() -> State {
    load_from(&state_path())
}

pub(crate) fn save_state(state: &State) -> Result<(), String> {
    save_to(&state_path(), state)
}

/// Whether first-run onboarding should open. Scans every adapter's discovery
/// location, so this is safe to call at launch without racing anything.
#[tauri::command]
pub async fn onboarding_should_show() -> bool {
    should_show_with(&load_from(&state_path()), agents::registry())
}

/// What the first-run greeting should say on this machine.
///
/// Reads the health sweep rather than resolving binaries again, so opening
/// onboarding costs nothing extra: `agent_health` has usually already run for
/// the Agents cards, and if it has not, this fills the same cache the cards
/// then read.
#[tauri::command]
pub async fn onboarding_content() -> OnboardingContent {
    let health = crate::health::agent_health().await;
    let found: std::collections::HashSet<&str> = health
        .iter()
        .filter(|h| h.status != crate::health::BinaryStatus::NotFound)
        .map(|h| h.id.as_str())
        .collect();
    content_with(agents::registry(), |id| found.contains(id))
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
        a.discovery = Some(Discovery::File {
            dir: dir.to_path_buf(),
            filename_regex: regex::Regex::new(r"^(?P<id>.+)\.jsonl$").unwrap(),
        });
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

    // --- what the greeting says, which is a separate question from whether it
    //     shows at all ---

    /// The case the old fixed copy got wrong: telling somebody to check which
    /// CLIs Sway found, when it found none, points them at four rows of "not
    /// found" and reads as Sway being broken.
    #[test]
    fn a_machine_with_no_agent_is_told_what_to_install() {
        let dir = tmp_dir("content-none");
        let adapters = [adapter_at(&dir)];
        let content = content_with(&adapters, |_| false);
        match content {
            OnboardingContent::NoAgent { supported } => {
                assert!(!supported.is_empty(), "the guidance has to name the agents");
                assert_eq!(supported, adapters.iter().map(|a| a.label.clone()).collect::<Vec<_>>());
            }
            other => panic!("expected NoAgent, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_installed_agent_is_enough_for_the_ordinary_greeting() {
        let dir = tmp_dir("content-some");
        let adapters = [adapter_at(&dir)];
        let installed_id = adapters[0].id.clone();
        assert_eq!(
            content_with(&adapters, |id| id == installed_id),
            OnboardingContent::FirstRun
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The content branch must not become a second show/hide gate. A user with
    /// no agent installed still sees onboarding; they just see different
    /// words in it.
    #[test]
    fn the_content_branch_does_not_change_who_sees_onboarding() {
        let dir = tmp_dir("content-gate");
        let adapters = [adapter_at(&dir)];
        assert!(
            should_show_with(&State::default(), &adapters),
            "a fresh user with no sessions sees onboarding whatever is installed"
        );
        assert!(matches!(
            content_with(&adapters, |_| false),
            OnboardingContent::NoAgent { .. }
        ));
        std::fs::remove_dir_all(&dir).ok();
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
