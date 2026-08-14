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
    /// Show Sway's own injected hook events in the transcript. Off by default:
    /// they are plumbing rather than the user's own hooks, and a reader
    /// scanning for their own hook should not have to skip Sway's to find it.
    /// (The stronger version of this - that Sway's hook fired on *every* tool
    /// and so buried the user's - stopped being true when the matcher narrowed
    /// to the write tools.)
    #[serde(default)]
    pub show_sway_hooks: bool,
    /// How many live chats before Sway says the cost is adding up. **Zero means
    /// no cap.**
    ///
    /// A ceiling that warns rather than refuses, for the same reason the
    /// permission gate went: several chats at once is the point of the surface,
    /// and Sway is not the right authority on how many is too many for this
    /// machine or this bill. What it can honestly do is notice, because each
    /// live chat is a streaming child process the user did not necessarily mean
    /// to still have running.
    #[serde(default = "default_max_concurrent_chats")]
    pub max_concurrent_chats: u32,
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
/// Four streaming children is about where a laptop's fans and the token bill
/// both start to be noticeable, and it is comfortably above the two or three a
/// worktree's worth of parallel work actually needs.
fn default_max_concurrent_chats() -> u32 {
    4
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
            show_sway_hooks: false,
            max_concurrent_chats: default_max_concurrent_chats(),
        }
    }
}

/// Spend ceilings, mirroring `Budgets` in `panels/Settings/settingsStore.ts`.
///
/// **`None` means unlimited, and that is the default.** A ceiling nobody asked
/// for that stops an agent mid-task is worse than no ceiling, so all three are
/// opt-in, and `None` is distinct from `Some(0.0)` - the latter is a user asking
/// to be stopped immediately.
///
/// `warn_at_fraction` is the one field that is not an option, so it carries a
/// named default rather than relying on the struct's: a file that sets one
/// ceiling by hand and nothing else would otherwise deserialize the fraction as
/// `0.0` and warn on the first cent. Same trap `EditorDefaults` documents.
///
/// **This section existed on the frontend before it existed here**, so the
/// frontend sent a `budgets` key that serde had no home for and `set_settings`
/// dropped on every save: the ceilings were writable in the panel and gone on
/// the next read.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Budgets {
    /// Ceiling for one chat session, in dollars.
    #[serde(default)]
    pub session_usd: Option<f64>,
    /// Ceiling across every session in one project, in dollars.
    #[serde(default)]
    pub project_usd: Option<f64>,
    /// Stop when a turn's context window passes this percentage.
    #[serde(default)]
    pub context_percent: Option<f64>,
    /// Warn once at this fraction of whichever ceiling is in force.
    #[serde(default = "default_warn_at_fraction")]
    pub warn_at_fraction: f64,
}

fn default_warn_at_fraction() -> f64 {
    0.8
}

impl Default for Budgets {
    fn default() -> Self {
        Self {
            session_usd: None,
            project_usd: None,
            context_percent: None,
            warn_at_fraction: default_warn_at_fraction(),
        }
    }
}

/// Editor behaviour that is a preference rather than a project fact.
///
/// **`format_on_save` defaults off**, even though the project's own config is
/// what decides *which* formatter runs. A repo that carries a `.prettierrc` is
/// not necessarily a repo that is currently formatted, and the first save in
/// one would otherwise rewrite a file the user never touched and put that diff
/// in somebody's pull request. Opting in is cheap; opting out after the fact is
/// a revert.
///
/// `vim_mode` lives here and **not** in `EditorPrefs`: which formatter runs is a
/// property of the repo, but whether `hjkl` moves the caret is a property of the
/// person, and the same person's hands do not change between projects. The
/// editing-comfort switches below are here for the same reason.
///
/// **Each field carries its own default, not just the struct.** A bare
/// `#[serde(default)]` on a `bool` deserializes a *missing* key as `false`, so a
/// hand-edited file that sets one key inside `editorDefaults` would silently
/// turn every on-by-default feature off. The named `default_true` keeps a
/// partial block filling from defaults the same way a missing block does, which
/// is also why `Default` is written out rather than derived.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorDefaults {
    #[serde(default)]
    pub format_on_save: bool,
    /// Ask the language server to organize the file's imports before writing.
    /// Off for `format_on_save`'s reason and one of its own: it deletes imports
    /// nothing references *yet*, which is what a file looks like halfway
    /// through being written.
    #[serde(default)]
    pub organize_imports_on_save: bool,
    /// Draw the language server's lenses (reference counts, implementations)
    /// above the lines they describe. Off because it is the one language
    /// feature nobody asks for: it costs a round trip per file per edit
    /// whether or not anyone reads the answer.
    #[serde(default)]
    pub code_lens: bool,
    #[serde(default)]
    pub vim_mode: bool,
    #[serde(default = "default_true")]
    pub indent_guides: bool,
    #[serde(default)]
    pub soft_wrap: bool,
    #[serde(default)]
    pub render_whitespace: bool,
    #[serde(default = "default_true")]
    pub scroll_past_end: bool,
    #[serde(default)]
    pub rainbow_brackets: bool,
    #[serde(default)]
    pub bracket_pair_guides: bool,
    #[serde(default)]
    pub minimap: bool,
    #[serde(default)]
    pub sticky_scroll: bool,
    #[serde(default = "default_true")]
    pub word_completion: bool,
    #[serde(default = "default_true")]
    pub hot_exit: bool,
    #[serde(default = "default_true")]
    pub compact_folders: bool,
    /// Comma-separated tags the TODO panel looks for. A string rather than a
    /// list because the workspace overlay validates an override by comparing
    /// `typeof` against the default and reports its origin by inequality;
    /// both are exact for a string and neither works on an array.
    #[serde(default = "default_todo_patterns")]
    pub todo_patterns: String,
}

fn default_true() -> bool {
    true
}

fn default_todo_patterns() -> String {
    "TODO,FIXME,HACK,XXX".to_string()
}

impl Default for EditorDefaults {
    fn default() -> Self {
        Self {
            format_on_save: false,
            organize_imports_on_save: false,
            code_lens: false,
            vim_mode: false,
            indent_guides: true,
            soft_wrap: false,
            render_whitespace: false,
            scroll_past_end: true,
            rainbow_brackets: false,
            bracket_pair_guides: false,
            minimap: false,
            sticky_scroll: false,
            word_completion: true,
            hot_exit: true,
            compact_folders: true,
            todo_patterns: default_todo_patterns(),
        }
    }
}

/// One project's editor overrides. Keyed like `Settings::chat` and for the same
/// reason: whether a save should reformat is a property of the repo, not of the
/// user, and one global answer would make each project's choice overwrite the
/// others'.
///
/// `None` means "no answer here", which falls through to `EditorDefaults` -
/// distinct from `Some(false)`, which is this project saying no.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorPrefs {
    #[serde(default)]
    pub format_on_save: Option<bool>,
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
    pub budgets: Budgets,
    #[serde(default)]
    pub editor_defaults: EditorDefaults,
    #[serde(default)]
    pub harness: Harness,
    /// Keyed by project path. Untyped as a map rather than a list so a project
    /// that has never been opened simply has no entry, instead of needing one
    /// written before the first pick can be stored.
    #[serde(default)]
    pub chat: std::collections::HashMap<String, ChatPrefs>,
    /// Keyed by project path, same shape and same reason as `chat`.
    #[serde(default)]
    pub editor: std::collections::HashMap<String, EditorPrefs>,
}

// --- pure core (explicit path, no globals), unit-tested off-disk ---

/// Read settings from `path`. A missing or unparseable file yields defaults; a
/// partial file fills the missing sections from defaults (`#[serde(default)]`).
/// Move a pre-rename `editor` block into `editorDefaults`.
///
/// The editing-comfort switches shipped as a flat `editor` block of booleans.
/// That key now holds per-project overrides, so an untouched file deserializes
/// `editor` as a map of `EditorPrefs` and **fails** - and `load_from` has no
/// per-section recovery, so the failure takes the theme, the fonts and every
/// other section down to defaults with it. Exactly the hazard `ChatDefaults`
/// documents, arrived at from the other direction.
///
/// Run before deserializing, on the raw JSON, because by the time serde has an
/// opinion the file is already lost. Moved rather than dropped: those booleans
/// are the user's answers, and `editorDefaults` is where that question lives
/// now. An explicit `editorDefaults` key wins, being the newer of the two.
fn migrate_editor_block(mut value: serde_json::Value) -> serde_json::Value {
    let Some(obj) = value.as_object_mut() else {
        return value;
    };
    let Some(editor) = obj.get("editor").and_then(|v| v.as_object()).cloned() else {
        return value;
    };
    // The new shape maps a project path to an object; the old one maps a key to
    // a boolean. A file with neither (an empty block, or one already migrated)
    // says nothing and is left exactly as it is.
    if !editor.values().any(|v| v.is_boolean()) {
        return value;
    }
    let mut defaults = obj
        .get("editorDefaults")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    for (key, v) in &editor {
        if v.is_boolean() {
            defaults.entry(key.clone()).or_insert_with(|| v.clone());
        }
    }
    // A file can hold both shapes at once if it was written across the rename,
    // so the per-project entries that were already there are kept.
    let kept: serde_json::Map<String, serde_json::Value> =
        editor.into_iter().filter(|(_, v)| v.is_object()).collect();
    obj.insert("editorDefaults".into(), serde_json::Value::Object(defaults));
    obj.insert("editor".into(), serde_json::Value::Object(kept));
    value
}

fn load_from(path: &Path) -> Settings {
    let mut settings: Settings = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| json5::from_str::<serde_json::Value>(&t).ok())
        .map(migrate_editor_block)
        .and_then(|v| serde_json::from_value::<Settings>(v).ok())
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
                show_sway_hooks: true,
                max_concurrent_chats: 9,
            },
            harness: Harness { path: Some("/opt/claude".into()) },
            ..Default::default()
        };
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p), s, "every chat and harness field survived the round trip");

        // Under the name the frontend sends, or the round trip only works
        // between this struct and itself - the half of the trap that a
        // `Settings`-to-`Settings` comparison cannot see.
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(raw.contains("\"maxConcurrentChats\": 9"), "written under the key the panel writes");

        // And a file predating the cap reads as the default rather than as
        // zero, which is the value that means "never warn".
        std::fs::write(&p, r#"{"chatDefaults":{"streaming":false}}"#).unwrap();
        assert_eq!(load_from(&p).chat_defaults.max_concurrent_chats, default_max_concurrent_chats());
        let _ = std::fs::remove_file(&p);
    }

    /// The budgets section shipped on the frontend with no home in this struct,
    /// so serde dropped it on the way in and `set_settings` wrote it back out of
    /// existence: the user typed a ceiling, saved, and found the field empty on
    /// the next read. Same silent-total failure `organizeImportsOnSave` guards,
    /// arrived at from the frontend's side.
    #[test]
    fn budgets_round_trip_and_default_to_unlimited() {
        let p = tmp_file();
        std::fs::write(&p, r#"{"appearance":{}}"#).unwrap();
        let loaded = load_from(&p);
        // A file with no budgets section: no ceiling at all, and the warning
        // fraction from its named default rather than from a zeroed field.
        assert_eq!(loaded.budgets.session_usd, None);
        assert_eq!(loaded.budgets.project_usd, None);
        assert_eq!(loaded.budgets.context_percent, None);
        assert_eq!(loaded.budgets.warn_at_fraction, 0.8);

        let mut s = loaded;
        s.budgets = Budgets {
            session_usd: Some(5.5),
            project_usd: Some(20.0),
            context_percent: Some(75.0),
            warn_at_fraction: 0.9,
        };
        save_to(&p, &s).unwrap();
        let back = load_from(&p);
        assert_eq!(back, s, "every ceiling survived the round trip");

        // Written under the names the frontend sends, or the round trip only
        // works between this struct and itself.
        let raw = std::fs::read_to_string(&p).unwrap();
        for key in ["sessionUsd", "projectUsd", "contextPercent", "warnAtFraction"] {
            assert!(raw.contains(key), "{key} missing from {raw}");
        }
        let _ = std::fs::remove_file(&p);
    }

    /// A hand-edited file setting one ceiling must not zero the warning
    /// fraction, and an existing settings file must keep every other section.
    #[test]
    fn a_partial_budgets_section_keeps_the_warning_fraction_and_its_siblings() {
        let p = tmp_file();
        std::fs::write(
            &p,
            r#"{ "appearance": { "theme": "catppuccin-mocha" },
                 "budgets": { "sessionUsd": 3 } }"#,
        )
        .unwrap();
        let back = load_from(&p);
        assert_eq!(back.budgets.session_usd, Some(3.0));
        assert_eq!(back.budgets.warn_at_fraction, 0.8, "the fraction came from its default, not from 0");
        assert_eq!(back.budgets.project_usd, None);
        // And the section that has nothing to do with budgets is untouched: a
        // section that fails to deserialize takes the whole file with it.
        assert_eq!(back.appearance.theme, "catppuccin-mocha");
        let _ = std::fs::remove_file(&p);
    }

    /// `None` is "no ceiling"; `Some(0.0)` is a user asking to be stopped at
    /// once. Serialising them the same way would make the second unreachable.
    #[test]
    fn an_explicit_zero_ceiling_is_not_the_same_as_no_ceiling() {
        let p = tmp_file();
        let mut s = Settings::default();
        s.budgets.session_usd = Some(0.0);
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p).budgets.session_usd, Some(0.0));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn format_on_save_defaults_off_and_a_project_can_answer_for_itself() {
        // A settings file written before this field existed must read as off
        // from the default rather than from the key's absence, and a project
        // saying "no" must be distinguishable from a project saying nothing.
        let p = tmp_file();
        std::fs::write(&p, r#"{"appearance":{}}"#).unwrap();
        let loaded = load_from(&p);
        assert!(!loaded.editor_defaults.format_on_save);
        assert!(loaded.editor.is_empty());

        let mut s = loaded;
        s.editor_defaults.format_on_save = true;
        s.editor.insert("/repo/quiet".into(), EditorPrefs { format_on_save: Some(false) });
        s.editor.insert("/repo/silent".into(), EditorPrefs::default());
        save_to(&p, &s).unwrap();
        let back = load_from(&p);
        assert_eq!(back, s, "both the default and the per-project answers survived");
        assert_eq!(back.editor["/repo/quiet"].format_on_save, Some(false));
        assert_eq!(back.editor["/repo/silent"].format_on_save, None);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn organize_imports_on_save_survives_a_round_trip() {
        // The failure this guards is silent and total: a field the frontend
        // sends but the struct has no home for is dropped by serde on the way
        // in and written back out gone, so the toggle flips, saves, and snaps
        // back on the next read with nothing said. `compactFolders` shipped
        // that way once.
        let p = tmp_file();
        std::fs::write(&p, r#"{"appearance":{}}"#).unwrap();
        let loaded = load_from(&p);
        assert!(
            !loaded.editor_defaults.organize_imports_on_save,
            "a file written before the field existed reads as off from the default"
        );

        let mut s = loaded;
        s.editor_defaults.organize_imports_on_save = true;
        save_to(&p, &s).unwrap();
        let back = load_from(&p);
        assert!(back.editor_defaults.organize_imports_on_save, "and the value written comes back");
        assert_eq!(back, s);

        // Written under its camelCase name, which is what the frontend sends.
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(raw.contains("organizeImportsOnSave"), "serialized under the name the frontend uses");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn code_lens_survives_a_round_trip() {
        // Its own test rather than trust in the one above: this is the fourth
        // key added to `EditorDefaults` since that failure mode was found, and
        // the whole point of the wave-7 four-homes rule is that each home is
        // checked rather than assumed to have been remembered.
        let p = tmp_file();
        std::fs::write(&p, r#"{"appearance":{}}"#).unwrap();
        let loaded = load_from(&p);
        assert!(
            !loaded.editor_defaults.code_lens,
            "a file written before the field existed reads as off, which is also the shipped default"
        );

        let mut s = loaded;
        s.editor_defaults.code_lens = true;
        save_to(&p, &s).unwrap();
        let back = load_from(&p);
        assert!(back.editor_defaults.code_lens, "and the value written comes back");
        assert_eq!(back, s);

        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(raw.contains("codeLens"), "serialized under the name the frontend uses");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn vim_mode_is_a_global_default_with_no_per_project_answer() {
        // Deliberately not in `EditorPrefs`. Which formatter runs is the repo's
        // business; whether `hjkl` moves the caret is the person's, and a
        // per-project vim setting would mean the same hands typing differently
        // in two windows of the same editor.
        let p = tmp_file();
        std::fs::write(&p, r#"{"editorDefaults":{"formatOnSave":true}}"#).unwrap();
        let loaded = load_from(&p);
        assert!(loaded.editor_defaults.format_on_save, "the field that was written survived");
        assert!(!loaded.editor_defaults.vim_mode, "and the one that was not reads as off");

        let mut s = loaded;
        s.editor_defaults.vim_mode = true;
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p), s);
        let _ = std::fs::remove_file(&p);
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

    /// The editing-comfort block is the same shape of trap as `chatDefaults`,
    /// twice over: a file from before wave 5 has no `editor` key at all, and a
    /// hand-edited one may set a single key inside it. Neither may read as
    /// "every on-by-default feature off".
    /// The comfort switches moved from `editor` to `editorDefaults`. A file
    /// written before that move must not cost the user anything, and above all
    /// must not cost them the sections that have nothing to do with it: a
    /// section that fails to deserialize takes the whole file to defaults.
    #[test]
    fn a_pre_rename_editor_block_is_moved_rather_than_lost() {
        let p = tmp_file();
        std::fs::write(
            &p,
            r#"{ "appearance": { "theme": "catppuccin-mocha" },
                 "editor": { "rainbowBrackets": true, "minimap": true, "hotExit": false } }"#,
        )
        .unwrap();

        let back = load_from(&p);

        // The whole point: an unrelated section is untouched by an editor key.
        assert_eq!(back.appearance.theme, "catppuccin-mocha");
        // The answers themselves survive, in their new home.
        assert!(back.editor_defaults.rainbow_brackets);
        assert!(back.editor_defaults.minimap);
        assert!(!back.editor_defaults.hot_exit, "an explicit off is an answer too");
        // A key the old block never carried still lands on its default.
        assert!(back.editor_defaults.indent_guides);
        // And `editor` is now what it means today: per-project, and empty.
        assert!(back.editor.is_empty());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn a_file_written_across_the_rename_keeps_both_halves() {
        let p = tmp_file();
        // Both shapes at once, which is what a file touched either side of the
        // rename looks like. The newer block wins where they disagree, and the
        // per-project entry is not collateral.
        std::fs::write(
            &p,
            r#"{ "editorDefaults": { "minimap": false },
                 "editor": { "minimap": true, "rainbowBrackets": true,
                             "/repo/a": { "formatOnSave": true } } }"#,
        )
        .unwrap();

        let back = load_from(&p);

        assert!(!back.editor_defaults.minimap, "the explicit editorDefaults key wins");
        assert!(back.editor_defaults.rainbow_brackets, "and the old block fills the rest");
        assert_eq!(back.editor.get("/repo/a").and_then(|e| e.format_on_save), Some(true));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn a_current_file_is_left_alone() {
        let p = tmp_file();
        std::fs::write(
            &p,
            r#"{ "editorDefaults": { "minimap": true },
                 "editor": { "/repo/a": { "formatOnSave": false } } }"#,
        )
        .unwrap();

        let back = load_from(&p);

        assert!(back.editor_defaults.minimap);
        assert_eq!(back.editor.get("/repo/a").and_then(|e| e.format_on_save), Some(false));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn the_editor_block_defaults_on_a_legacy_file_and_on_a_partial_one() {
        let p = tmp_file();
        std::fs::write(&p, r#"{ "appearance": { "theme": "sway-dark" } }"#).unwrap();
        let back = load_from(&p);
        assert_eq!(
            back.editor_defaults,
            EditorDefaults::default(),
            "no editorDefaults key at all"
        );
        assert!(back.editor_defaults.indent_guides);
        assert!(back.editor_defaults.scroll_past_end);
        assert!(back.editor_defaults.word_completion);
        assert!(back.editor_defaults.hot_exit);
        // The cosmetic overlays stay off: a stance nobody asked for.
        assert!(!back.editor_defaults.minimap);
        assert!(!back.editor_defaults.rainbow_brackets);

        // One key set by hand must not zero its siblings.
        std::fs::write(&p, r#"{ "editorDefaults": { "minimap": true } }"#).unwrap();
        let back = load_from(&p);
        assert!(back.editor_defaults.minimap);
        assert!(back.editor_defaults.indent_guides, "a sibling key kept its default");
        assert!(back.editor_defaults.hot_exit);
        // And the two that were already in this block before the comfort
        // switches joined it: a partial write must not zero those either.
        assert!(!back.editor_defaults.format_on_save);
        assert!(!back.editor_defaults.vim_mode);

        // And an explicit off survives the round trip, or a user who turned hot
        // exit off would find it re-armed on the next launch.
        let mut s = load_from(&p);
        s.editor_defaults.hot_exit = false;
        save_to(&p, &s).unwrap();
        assert!(!load_from(&p).editor_defaults.hot_exit);
        let _ = std::fs::remove_file(&p);
    }

    /// The one key in this block that is not a switch. A file written before it
    /// existed must come back with the built-in tags rather than an empty
    /// string, which the panel would read as "no tags configured" and show
    /// nothing at all.
    #[test]
    fn todo_patterns_default_to_the_built_in_tags_and_survive_a_round_trip() {
        let p = tmp_file();
        std::fs::write(&p, r#"{ "editorDefaults": { "minimap": true } }"#).unwrap();
        let back = load_from(&p);
        assert_eq!(back.editor_defaults.todo_patterns, "TODO,FIXME,HACK,XXX");

        let mut s = back;
        s.editor_defaults.todo_patterns = "REVIEW,NOTE".to_string();
        save_to(&p, &s).unwrap();
        let back = load_from(&p);
        assert_eq!(back.editor_defaults.todo_patterns, "REVIEW,NOTE");
        // A sibling switch is untouched by writing this one.
        assert!(back.editor_defaults.minimap);

        // An empty list is a real answer: a project that wants no TODO panel
        // must not have the defaults handed back to it on every load.
        s.editor_defaults.todo_patterns = String::new();
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p).editor_defaults.todo_patterns, "");
        let _ = std::fs::remove_file(&p);
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
