// Global user settings: ~/.config/sway/settings.json (JSONC, like VS Code).
// Read with json5 (comment-tolerant), written as pretty JSON. Separate from
// sway.toml, which is project *discovery* config; this is user preferences
// (appearance, typography, checkpoints). Mirrors config.rs's watcher + the pure
// core / thin wrapper split so the load/save logic is unit-testable off-disk
// (see the repo's "pure core for global stores" lesson).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

pub struct SettingsWatch(pub Mutex<Option<RecommendedWatcher>>);

impl Default for SettingsWatch {
    fn default() -> Self {
        SettingsWatch(Mutex::new(None))
    }
}

fn settings_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/sway/settings.json")
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    /// Bundled theme id, e.g. "sway-dark".
    pub theme: String,
    /// The VS Code-era `importPath`, read so the migration can name the file it
    /// dropped in a one-time notice. `skip_serializing` is what actually drops
    /// the key from settings.json: the next save writes the field out of
    /// existence, and nothing in the app can set it again.
    #[serde(rename = "importPath", default, skip_serializing)]
    pub legacy_import_path: Option<String>,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: "sway-dark".into(),
            legacy_import_path: None,
        }
    }
}

/// Ids persisted by the VS Code-theme era, mapped on read so an install keeps
/// the theme it chose. `"import"` has no equivalent - the import path is gone -
/// so it lands on the default rather than on a name nothing resolves.
///
/// Mapping on read rather than rewriting the file means a user who never opens
/// Settings is still migrated, and the rewrite happens whenever they next save.
fn migrate_theme_id(id: &str) -> Option<&'static str> {
    match id {
        "dark-plus" | "import" => Some("sway-dark"),
        "light-plus" => Some("sway-light"),
        _ => None,
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Typography {
    pub ui_font_family: String,
    pub ui_font_size: u16,
    pub editor_font_family: String,
    pub editor_font_size: u16,
    // Serde defaults so settings files written before terminal typography existed
    // still parse (they fall back to the default family/size).
    #[serde(default = "default_terminal_font_family")]
    pub terminal_font_family: String,
    #[serde(default = "default_terminal_font_size")]
    pub terminal_font_size: u16,
    pub line_height: f32,
}

fn default_terminal_font_family() -> String {
    "\"SF Mono\", Menlo, Monaco, monospace".into()
}

fn default_terminal_font_size() -> u16 {
    15
}

impl Default for Typography {
    fn default() -> Self {
        Self {
            ui_font_family:
                "\"Inter\", -apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif"
                    .into(),
            ui_font_size: 15,
            editor_font_family: "\"SF Mono\", Menlo, Monaco, monospace".into(),
            editor_font_size: 15,
            terminal_font_family: default_terminal_font_family(),
            terminal_font_size: 15,
            line_height: 1.5,
        }
    }
}

/// Turn-level checkpoints (Finding E): on by default, a global escape hatch
/// for a user who doesn't want a scratch-index snapshot taken per prompt.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoints {
    pub enabled: bool,
}

impl Default for Checkpoints {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// What a chat session should reopen with, remembered per project.
///
/// **Per project rather than global** because the answer is a property of the
/// work: a repo where every turn edits code wants a different model and effort
/// than one where chat is mostly questions, and a single global setting would
/// make each project's last choice overwrite the others'.
///
/// `model` holds the `--model` **value** (`sonnet`, `opus`), never the resolved
/// id the session reports back. The value is what the flag takes, and it
/// survives a model being re-resolved to a different id; storing the resolved
/// id would restore a pick the CLI cannot be given.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatPrefs {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub appearance: Appearance,
    #[serde(default)]
    pub typography: Typography,
    #[serde(default)]
    pub checkpoints: Checkpoints,
    /// Keyed by project path. Untyped as a map rather than a list so a project
    /// that has never been opened simply has no entry, instead of needing one
    /// written before the first pick can be stored.
    #[serde(default)]
    pub chat: std::collections::HashMap<String, ChatPrefs>,
}

// --- pure core (explicit path, no globals), unit-tested off-disk ---

/// Read settings from `path`. A missing or unparseable file yields defaults; a
/// partial file fills the missing sections from defaults (`#[serde(default)]`).
fn load_from(path: &Path) -> Settings {
    let mut settings: Settings = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| json5::from_str::<Settings>(&t).ok())
        .unwrap_or_default();
    if let Some(id) = migrate_theme_id(&settings.appearance.theme) {
        settings.appearance.theme = id.into();
    }
    settings
}

fn save_to(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// The dropped import path, if it has not been reported yet, marking `state` as
/// reported when it returns one. Settings with no import path leave the flag
/// alone, so the notice is never burned on an install that never had a theme
/// to lose.
fn take_notice_with(settings: &Settings, state: &mut crate::onboarding::State) -> Option<String> {
    let path = settings.appearance.legacy_import_path.clone()?;
    if state.theme_import_notice_shown {
        return None;
    }
    state.theme_import_notice_shown = true;
    Some(path)
}

// --- thin wrappers over the real path ---

#[tauri::command]
pub fn get_settings() -> Settings {
    load_from(&settings_path())
}

#[tauri::command]
pub fn set_settings(settings: Settings, app: AppHandle) -> Result<Settings, String> {
    save_to(&settings_path(), &settings)?;
    let _ = app.emit("settings://changed", ());
    Ok(settings)
}

/// The VS Code theme file this install lost, returned exactly once.
///
/// Sway no longer imports VS Code themes, so an install that had one is
/// silently switched to a bundled palette. Silently is the problem: the user
/// picked that file, so they are told once, by name, that it is gone. The flag
/// lives in state.json rather than settings.json for the same reason
/// `onboarding_shown` does - "have we said this yet" is app state, not a
/// preference the user should find in their hand-editable config.
#[tauri::command]
pub fn take_theme_import_notice() -> Option<String> {
    let settings = load_from(&settings_path());
    let mut state = crate::onboarding::load_state();
    let path = take_notice_with(&settings, &mut state)?;
    // A failed write means the notice may repeat on the next launch. Preferred
    // over swallowing it here, which would lose it permanently.
    let _ = crate::onboarding::save_state(&state);
    Some(path)
}

/// Watch the settings file's directory; emit `settings://changed` on any write
/// to settings.json (hand edits or set_settings). Idempotent.
#[tauri::command]
pub fn settings_watch_start(app: AppHandle, state: State<SettingsWatch>) -> Result<(), String> {
    let path = settings_path();
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let target = path.clone();
    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if event.paths.iter().any(|p| p == &target) {
                let _ = app_handle.emit("settings://changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A path unique to each *call*, not just to the process. Every test in one
    /// `cargo test` run shares a pid, so keying on that alone had the tests in
    /// this module racing over a single file: they write, read, and delete the
    /// same path concurrently, so each passed alone and failed together.
    fn tmp_file() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("sway-settings-test-{n}-{seq}.json"))
    }

    /// The picks are keyed per project and hold the `--model` **value**, not
    /// the resolved id the session reports back. A file written before chat
    /// existed has no `chat` key at all, and must still load.
    #[test]
    fn chat_prefs_round_trip_per_project_and_default_to_empty() {
        let p = tmp_file();
        let mut s = Settings::default();
        assert!(s.chat.is_empty());
        s.chat.insert(
            "/repo/a".into(),
            ChatPrefs {
                model: Some("sonnet".into()),
                effort: Some("xhigh".into()),
                mode: Some("plan".into()),
            },
        );
        s.chat.insert(
            "/repo/b".into(),
            ChatPrefs {
                model: Some("haiku".into()),
                ..Default::default()
            },
        );
        save_to(&p, &s).unwrap();

        let back = load_from(&p);
        // Per project, so one repo's choice never overwrites another's.
        assert_eq!(back.chat["/repo/a"].model.as_deref(), Some("sonnet"));
        assert_eq!(back.chat["/repo/a"].effort.as_deref(), Some("xhigh"));
        assert_eq!(back.chat["/repo/b"].model.as_deref(), Some("haiku"));
        assert_eq!(back.chat["/repo/b"].effort, None);
        assert!(!back.chat.contains_key("/repo/c"));

        // A settings file predating this section loads rather than resetting
        // everything else to defaults.
        std::fs::write(&p, r#"{"appearance":{"theme":"sway-dark"}}"#).unwrap();
        assert!(load_from(&p).chat.is_empty());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn missing_file_yields_defaults() {
        let p = std::env::temp_dir().join("sway-settings-does-not-exist.json");
        let _ = std::fs::remove_file(&p);
        assert_eq!(load_from(&p), Settings::default());
    }

    #[test]
    fn invalid_file_yields_defaults_without_panicking() {
        let p = tmp_file();
        std::fs::write(&p, "{ not valid json ][").unwrap();
        assert_eq!(load_from(&p), Settings::default());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn partial_file_fills_missing_sections() {
        let p = tmp_file();
        // JSONC comment + only one section present
        std::fs::write(&p, "{\n  // just typography\n  \"typography\": { \"uiFontSize\": 16, \"uiFontFamily\": \"Inter\", \"editorFontFamily\": \"Fira Code\", \"editorFontSize\": 14, \"lineHeight\": 1.6 }\n}").unwrap();
        let s = load_from(&p);
        assert_eq!(s.typography.ui_font_size, 16);
        assert_eq!(s.appearance, Appearance::default());
        assert_eq!(s.checkpoints, Checkpoints::default());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn checkpoints_default_to_enabled() {
        assert!(Settings::default().checkpoints.enabled);
        assert!(Checkpoints::default().enabled);
    }

    #[test]
    fn save_then_load_round_trips() {
        let p = tmp_file();
        let mut s = Settings::default();
        s.typography.ui_font_size = 12;
        s.appearance.theme = "sway-light".into();
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p), s);
        std::fs::remove_file(&p).ok();
    }

    /// Every id the VS Code-theme era could persist lands on a named Sway
    /// theme. A Light+ install must land on Sway *Light*: mapping it to the
    /// default would silently flip an existing user to dark.
    #[test]
    fn legacy_theme_ids_migrate_on_read() {
        for (old, expected) in [
            ("dark-plus", "sway-dark"),
            ("light-plus", "sway-light"),
            ("import", "sway-dark"),
        ] {
            let p = tmp_file();
            std::fs::write(
                &p,
                format!("{{ \"appearance\": {{ \"theme\": \"{old}\", \"importPath\": \"/x/t.json\" }} }}"),
            )
            .unwrap();
            let s = load_from(&p);
            assert_eq!(s.appearance.theme, expected, "{old} should migrate to {expected}");
            std::fs::remove_file(&p).ok();
        }
    }

    /// The notice names the dropped file exactly once, and a restart (a fresh
    /// read of the same still-unmigrated settings file) does not repeat it.
    #[test]
    fn import_notice_fires_once_and_never_again() {
        let p = tmp_file();
        std::fs::write(&p, "{ \"appearance\": { \"theme\": \"import\", \"importPath\": \"/x/t.json\" } }").unwrap();
        let settings = load_from(&p);
        let mut state = crate::onboarding::State::default();

        assert_eq!(take_notice_with(&settings, &mut state).as_deref(), Some("/x/t.json"));
        assert!(state.theme_import_notice_shown);
        // Second launch: settings.json is untouched, so only the flag stops it.
        assert_eq!(take_notice_with(&load_from(&p), &mut state), None);
        std::fs::remove_file(&p).ok();
    }

    /// An install that never imported a theme must not burn the flag, or a
    /// later hand-edit naming an import path would be silently swallowed.
    #[test]
    fn no_import_path_leaves_the_flag_untouched() {
        let mut state = crate::onboarding::State::default();
        assert_eq!(take_notice_with(&Settings::default(), &mut state), None);
        assert!(!state.theme_import_notice_shown);
    }

    /// The import path survives the read (the one-time notice needs to name it)
    /// but never survives a write.
    #[test]
    fn import_path_is_read_but_never_written_back() {
        let p = tmp_file();
        std::fs::write(&p, "{ \"appearance\": { \"theme\": \"import\", \"importPath\": \"/x/t.json\" } }").unwrap();
        let s = load_from(&p);
        assert_eq!(s.appearance.legacy_import_path.as_deref(), Some("/x/t.json"));

        save_to(&p, &s).unwrap();
        let written = std::fs::read_to_string(&p).unwrap();
        assert!(!written.contains("importPath"), "importPath must be dropped on save: {written}");
        assert!(load_from(&p).appearance.legacy_import_path.is_none());
        std::fs::remove_file(&p).ok();
    }
}
