// First-run state: the one flag the welcome modal reads, and the file it
// shares with the other shown-once notices.
//
// Whether the modal opens at all is not decided here. That is a question about
// the config (is there a base folder, is there a space), which the frontend
// already reads for the sidebar, so the backend only answers the part it owns:
// has the intro been seen. The flag is set when the user finishes or skips the
// intro, so it cannot repeat once they have.
//
// The flag lives in state.json, not settings.json: settings.json is
// hand-editable user preference, and "have we shown this yet" is app state
// that has no business appearing in it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// The old name is kept as an alias: it recorded the one-line greeting the
    /// intro replaced, and a user who saw that has no need of the intro either.
    #[serde(default, alias = "onboardingShown")]
    pub intro_seen: bool,
    /// Whether the "your imported VS Code theme was dropped" notice has fired.
    /// Same reasoning as `intro_seen`: shown-once state, not preference.
    #[serde(default)]
    pub theme_import_notice_shown: bool,
}

fn state_path() -> PathBuf {
    crate::owned_state::config_dir().join("state.json")
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

/// The slice of `State` the welcome modal reads.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FirstRunState {
    pub intro_seen: bool,
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

#[tauri::command]
pub fn first_run_state() -> FirstRunState {
    FirstRunState { intro_seen: load_state().intro_seen }
}

#[tauri::command(async)]
pub fn first_run_mark_intro_seen() -> Result<(), String> {
    set_intro_seen(true)
}

#[tauri::command(async)]
pub fn first_run_forget_intro() -> Result<(), String> {
    set_intro_seen(false)
}

fn set_intro_seen(seen: bool) -> Result<(), String> {
    let path = state_path();
    let mut state = load_from(&path);
    state.intro_seen = seen;
    save_to(&path, &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("tori-onboarding-{tag}-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_state_file_yields_defaults() {
        let p = std::env::temp_dir().join("tori-state-does-not-exist.json");
        let _ = std::fs::remove_file(&p);
        assert!(!load_from(&p).intro_seen);
    }

    #[test]
    fn marking_the_intro_seen_survives_a_reload() {
        let p = tmp_dir("flag").join("state.json");
        let mut state = load_from(&p);
        assert!(!state.intro_seen);

        // What `first_run_mark_intro_seen` does, against an explicit path.
        state.intro_seen = true;
        save_to(&p, &state).unwrap();
        assert!(load_from(&p).intro_seen);

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    /// A state.json written before the rename still counts: the greeting it
    /// recorded was the intro's predecessor.
    #[test]
    fn the_old_flag_name_still_loads() {
        let p = tmp_dir("alias").join("state.json");
        std::fs::write(&p, r#"{"onboardingShown": true}"#).unwrap();
        assert!(load_from(&p).intro_seen);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn the_other_notice_flag_is_kept_on_save() {
        let p = tmp_dir("keep").join("state.json");
        save_to(&p, &State { intro_seen: false, theme_import_notice_shown: true }).unwrap();
        let mut state = load_from(&p);
        state.intro_seen = true;
        save_to(&p, &state).unwrap();
        assert_eq!(load_from(&p), State { intro_seen: true, theme_import_notice_shown: true });
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }
}
