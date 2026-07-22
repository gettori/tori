// Global user settings: ~/.config/sway/settings.json (JSONC, like VS Code).
// Read with json5 (comment-tolerant), written as pretty JSON. Separate from
// sway.toml, which is project *discovery* config; this is user preferences
// (appearance, typography, layout). Mirrors config.rs's watcher + the pure
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
    /// Bundled theme id (e.g. "dark-plus") or "import" when a file is loaded.
    pub theme: String,
    /// Absolute path of the imported theme file, when `theme == "import"`.
    pub import_path: Option<String>,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: "dark-plus".into(),
            import_path: None,
        }
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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    /// "comfortable" | "compact".
    pub density: String,
    /// Corner radius in px.
    pub radius: u16,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            density: "comfortable".into(),
            radius: 5,
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

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub appearance: Appearance,
    #[serde(default)]
    pub typography: Typography,
    #[serde(default)]
    pub layout: Layout,
    #[serde(default)]
    pub checkpoints: Checkpoints,
}

// --- pure core (explicit path, no globals), unit-tested off-disk ---

/// Read settings from `path`. A missing or unparseable file yields defaults; a
/// partial file fills the missing sections from defaults (`#[serde(default)]`).
fn load_from(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| json5::from_str::<Settings>(&t).ok())
        .unwrap_or_default()
}

fn save_to(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
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
        assert_eq!(s.layout, Layout::default());
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
        s.layout.radius = 12;
        s.appearance.theme = "light-plus".into();
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p), s);
        std::fs::remove_file(&p).ok();
    }
}
