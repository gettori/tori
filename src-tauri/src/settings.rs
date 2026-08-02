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

/// The bundled Nerd Font first, the platform's own monospace behind it. Sway
/// ships the file (public/fonts, docs/FONTS.md), so this default resolves on a machine with no
/// patched font installed - which is the point: a prompt full of powerline
/// separators and devicons should not depend on what the user happened to
/// `brew install`.
fn default_terminal_font_family() -> String {
    "\"JetBrainsMono Nerd Font Mono\", \"SF Mono\", Menlo, Monaco, monospace".into()
}

/// What this default used to be. An install still carrying it verbatim never
/// chose it - the value is just the old default written out - so it moves to
/// the new one. A user who typed their own family keeps it.
const LEGACY_TERMINAL_FONT_FAMILY: &str = "\"SF Mono\", Menlo, Monaco, monospace";

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

/// The forge integration's kill switch: on by default.
///
/// **Deliberately separate from signing out.** Signing out also stops the
/// network traffic, but it costs the credential, so quieting a misbehaving
/// poller would also disable PR creation, the review surface and merge. This
/// turns off polling and every API call while the token stays in the keychain,
/// which makes it the one cheap way back if the integration misbehaves.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Github {
    pub enabled: bool,
}

impl Default for Github {
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

/// Which surface a single click on a sidebar session opens.
///
/// Chat is the default. `Agent` is the fallback that restores the pre-chat
/// behaviour wholesale: the flip is a real behaviour change to a working tool,
/// so it ships with a way back that is a setting rather than a downgrade.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DefaultSurface {
    #[default]
    Chat,
    Agent,
}

/// Global chat preferences: what a new chat starts with and how the transcript
/// renders.
///
/// **Separate from the per-project `chat` map** rather than nested inside it.
/// Folding both into one `chat` key would change the shape of a field users
/// already have on disk, and a section that fails to deserialize takes the
/// whole file down to defaults with it (`load_from` has no per-section
/// recovery), losing the user's theme over a chat preference.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatDefaults {
    #[serde(default)]
    pub default_surface: DefaultSurface,
    /// Seeds a *new* chat in a project that has no remembered pick of its own;
    /// `chat[project]` wins where it has one.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    /// Render assistant text as it streams. Off replaces the token-by-token
    /// paint with one update per completed block.
    #[serde(default = "yes")]
    pub streaming: bool,
    #[serde(default)]
    pub density: TranscriptDensity,
    /// Lines of tool output shown before a "show all" fold. Zero means no fold.
    #[serde(default = "default_tool_output_lines")]
    pub tool_output_lines: u32,
    /// How long an approval prompt waits before Sway auto-denies it. Sway owns
    /// this timeout so it always fires before claude's own hook timeout can.
    #[serde(default = "default_approval_auto_deny_secs")]
    pub approval_auto_deny_secs: u32,
    /// Show Sway's own injected approval-hook events in the transcript. Off by
    /// default: the matcher is all-tools, so it fires twice per tool call and
    /// would bury the user's own hooks in noise.
    #[serde(default)]
    pub show_sway_hooks: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptDensity {
    #[default]
    Comfortable,
    Compact,
}

fn yes() -> bool {
    true
}
fn default_tool_output_lines() -> u32 {
    20
}
fn default_approval_auto_deny_secs() -> u32 {
    120
}

impl Default for ChatDefaults {
    fn default() -> Self {
        Self {
            default_surface: DefaultSurface::default(),
            model: None,
            effort: None,
            mode: None,
            streaming: true,
            density: TranscriptDensity::default(),
            tool_output_lines: default_tool_output_lines(),
            approval_auto_deny_secs: default_approval_auto_deny_secs(),
            show_sway_hooks: false,
        }
    }
}

/// The harness binary this install drives.
///
/// `path` overrides discovery. Empty means "use the discovered one", which is
/// the normal case; an override is for a user running a build that is not on
/// the login shell's PATH.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Harness {
    #[serde(default)]
    pub path: Option<String>,
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
    #[serde(default)]
    pub github: Github,
    #[serde(default)]
    pub chat_defaults: ChatDefaults,
    #[serde(default)]
    pub harness: Harness,
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
    // Same "map on read" shape as the theme migration, and for the same reason:
    // a user who never opens Settings still gets the bundled font, and the file
    // is rewritten whenever they next save.
    if settings.typography.terminal_font_family == LEGACY_TERMINAL_FONT_FAMILY {
        settings.typography.terminal_font_family = default_terminal_font_family();
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

/// The user's harness binary override, if they set a non-empty one.
///
/// Read from disk at each call rather than cached: the setting's whole purpose
/// is to point at a different binary, and requiring a restart to try one would
/// make it useless for exactly the debugging it exists for. A blank string is
/// treated as unset so clearing the field in the UI restores discovery.
pub fn harness_override() -> Option<String> {
    let path = load_from(&settings_path()).harness.path?;
    let trimmed = path.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
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

    #[test]
    fn the_github_kill_switch_defaults_on_and_survives_an_older_settings_file() {
        // A settings file written before this field existed must not read as
        // "integration off": the default has to come from `Github::default`,
        // not from the absence of the key.
        let p = tmp_file();
        std::fs::write(&p, r#"{"appearance":{}}"#).unwrap();
        assert!(load_from(&p).github.enabled, "a file with no github section is enabled");

        // And an explicit off survives the round trip, or the kill switch would
        // silently re-arm the integration on every restart.
        let mut s = load_from(&p);
        s.github.enabled = false;
        save_to(&p, &s).unwrap();
        assert!(!load_from(&p).github.enabled);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn chat_defaults_and_harness_round_trip_through_the_file() {
        let p = tmp_file();
        let s = Settings {
            chat_defaults: ChatDefaults {
                default_surface: DefaultSurface::Agent,
                model: Some("opus".into()),
                effort: Some("high".into()),
                mode: Some("plan".into()),
                streaming: false,
                density: TranscriptDensity::Compact,
                tool_output_lines: 5,
                approval_auto_deny_secs: 30,
                show_sway_hooks: true,
            },
            harness: Harness { path: Some("/opt/claude".into()) },
            ..Default::default()
        };
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p), s, "every chat and harness field survived the round trip");
    }

    /// Sway now bundles JetBrainsMono Nerd Font Mono, so the terminal default
    /// names it. An install still carrying the previous default never chose
    /// that value - it is just the old default written to disk - so it moves,
    /// the same way a VS Code-era theme id does.
    #[test]
    fn the_old_terminal_font_default_moves_to_the_bundled_one() {
        let p = tmp_file();
        std::fs::write(
            &p,
            r#"{ "typography": { "uiFontFamily": "Inter", "uiFontSize": 15,
                 "editorFontFamily": "\"SF Mono\", Menlo, Monaco, monospace", "editorFontSize": 15,
                 "terminalFontFamily": "\"SF Mono\", Menlo, Monaco, monospace", "terminalFontSize": 15,
                 "lineHeight": 1.5 } }"#,
        )
        .unwrap();
        let back = load_from(&p);
        assert_eq!(back.typography.terminal_font_family, default_terminal_font_family());
        assert!(back.typography.terminal_font_family.contains("JetBrainsMono Nerd Font Mono"));
        // Only the terminal moves: the editor's identical value was left alone
        // on purpose, since nothing bundled changes what an editor should use.
        assert_eq!(back.typography.editor_font_family, "\"SF Mono\", Menlo, Monaco, monospace");
        let _ = std::fs::remove_file(&p);
    }

    /// A family the user typed is theirs. The migration matches the old default
    /// verbatim precisely so it cannot touch a real choice - including one that
    /// merely mentions the same fonts in a different order.
    #[test]
    fn a_chosen_terminal_font_is_left_alone() {
        let p = tmp_file();
        std::fs::write(&p, r#"{ "typography": { "uiFontFamily": "Inter", "uiFontSize": 15,
             "editorFontFamily": "Menlo", "editorFontSize": 15,
             "terminalFontFamily": "Menlo, \"SF Mono\", monospace", "terminalFontSize": 15,
             "lineHeight": 1.5 } }"#).unwrap();
        assert_eq!(load_from(&p).typography.terminal_font_family, "Menlo, \"SF Mono\", monospace");
        let _ = std::fs::remove_file(&p);
    }

    /// A settings file written before these sections existed must still load,
    /// and must land on the documented defaults rather than on zeroes.
    #[test]
    fn a_file_without_the_new_sections_loads_on_the_documented_defaults() {
        let p = tmp_file();
        std::fs::write(&p, r#"{ "appearance": { "theme": "sway-dark" } }"#).unwrap();
        let back = load_from(&p);
        // Chat is the default surface: this is the flip.
        assert_eq!(back.chat_defaults.default_surface, DefaultSurface::Chat);
        // `#[serde(default)]` on a bool would give `false`; these have to come
        // from the explicit defaults or streaming silently ships off.
        assert!(back.chat_defaults.streaming);
        assert_eq!(back.chat_defaults.tool_output_lines, 20);
        assert_eq!(back.chat_defaults.approval_auto_deny_secs, 120);
        // Sway's own hook noise stays folded until asked for.
        assert!(!back.chat_defaults.show_sway_hooks);
        assert_eq!(back.harness.path, None);
        // And the section it did carry is untouched.
        assert_eq!(back.appearance.theme, "sway-dark");
    }

    /// A partially-written section fills only its missing fields, so hand-editing
    /// one key does not reset the rest to defaults.
    #[test]
    fn a_partial_chat_section_keeps_its_siblings_on_defaults() {
        let p = tmp_file();
        std::fs::write(&p, r#"{ "chatDefaults": { "defaultSurface": "agent" } }"#).unwrap();
        let back = load_from(&p);
        assert_eq!(back.chat_defaults.default_surface, DefaultSurface::Agent);
        assert!(back.chat_defaults.streaming);
        assert_eq!(back.chat_defaults.tool_output_lines, 20);
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
