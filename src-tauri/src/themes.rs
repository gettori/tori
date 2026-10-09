// User theme palettes: ~/.config/tori/packs/themes/*.json.
//
// This module does STRUCTURAL validation only - serde plus `Palette::validate`
// (schemaVersion, required keys, every value a hex string). It deliberately
// does not measure legibility: the contrast gate reads *roles*, and roles do
// not exist until roles.ts derives them, so gating here would mean a second
// implementation of alpha()/mix()/variants() free to drift from the first. The
// frontend runs the gate on whatever this hands over, before anything paints
// (see the Decisions in adr_theme_palette_roles).
//
// Discovery mirrors agents.rs: read the directory, validate each file, and log
// a broken one loudly rather than swallowing it. It differs in one way - there
// is no `OnceLock` registry, because themes are live-watched (`themes_watch_start`,
// mirroring settings.rs) and every call re-reads the directory.

use std::path::Path;
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::packs::{self, Kind, LoadError};
use crate::palette::Palette;

pub struct ThemesWatch(pub Mutex<Option<RecommendedWatcher>>);

impl Default for ThemesWatch {
    fn default() -> Self {
        ThemesWatch(Mutex::new(None))
    }
}

/// A validated palette plus the file it came from. The picker shows the path so
/// a user with two files claiming one id can see which one is in effect.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedTheme {
    pub palette: Palette,
    pub source: String,
}

/// Everything the directory yielded: the themes that validated, and a named
/// error for each file that did not. The errors travel to the frontend rather
/// than only to stderr - a theme that silently fails to appear is
/// indistinguishable from one the user forgot to save.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserThemes {
    pub themes: Vec<LoadedTheme>,
    pub errors: Vec<String>,
}

const REQUIRED_TOP_LEVEL: [&str; 5] = ["schemaVersion", "id", "label", "appearance", "colors"];

/// Parse + validate one palette JSON source. `source` labels the origin in every
/// error message. Names every missing top-level field in one message rather than
/// only the first, the way a bare serde error would.
pub(crate) fn load_theme_str(text: &str, source: &str) -> Result<Palette, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if let Some(object) = value.as_object() {
        let missing: Vec<&str> = REQUIRED_TOP_LEVEL
            .iter()
            .filter(|k| !object.contains_key(**k))
            .copied()
            .collect();
        if !missing.is_empty() {
            return Err(format!("{source}: missing required field(s): {}", missing.join(", ")));
        }
    } else {
        return Err(format!("{source}: a theme file must be a JSON object"));
    }

    let palette: Palette = serde_json::from_value(value).map_err(|e| format!("{source}: {e}"))?;

    let problems = palette.validate();
    if !problems.is_empty() {
        return Err(format!("{source}: {}", problems.join("; ")));
    }
    crate::packs::check_id(&palette.id, source)?;
    Ok(palette)
}

/// Every `*.json` in `dir`, in filename order, and an error for each file
/// refused, never silently dropped.
fn load_themes_from(dir: &Path) -> (Vec<LoadedTheme>, Vec<LoadError>) {
    let installed = packs::installed_beside(dir);
    let mut themes = Vec::new();
    let mut errors = Vec::new();
    for path in packs::user_files(dir, Kind::Themes) {
        match packs::load_user_file(Kind::Themes, &path, &installed, load_theme_str, |p| &p.id) {
            Ok(palette) => themes.push(LoadedTheme {
                palette,
                source: path.to_string_lossy().into_owned(),
            }),
            Err(e) => errors.push(e),
        }
    }
    (themes, errors)
}

#[tauri::command(async)]
pub fn list_user_themes() -> UserThemes {
    let (themes, errors) = load_themes_from(&packs::kind_dir(Kind::Themes));
    let out = UserThemes {
        themes,
        errors: errors.iter().map(|e| format!("{}: {}", e.file, e.message)).collect(),
    };
    packs::report(Kind::Themes, errors);
    out
}

/// Watch `~/.config/tori/packs/themes/`; emit `themes://changed` on any write to a
/// `.json` file in it. Idempotent, and mirrors `settings_watch_start`.
#[tauri::command(async)]
pub fn themes_watch_start(app: AppHandle, state: State<ThemesWatch>) -> Result<(), String> {
    let dir = packs::kind_dir(Kind::Themes);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if event
                .paths
                .iter()
                .any(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            {
                let _ = app_handle.emit("themes://changed", ());
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
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A bundled palette as a known-good fixture. It is the same file the
    /// frontend registry imports, so a schema change that breaks the loader
    /// breaks this test rather than only user installs.
    const TORI_DARK: &str = include_str!("../packs/themes/tori-dark.json");

    fn tmp_dir() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("tori_themes_test_{n}_{seq}"))
            .join("themes");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_bundled_palette_loads_through_the_user_theme_path() {
        let p = load_theme_str(TORI_DARK, "test").expect("tori-dark parses");
        assert_eq!(p.id, "tori-dark");
        assert!(p.validate().is_empty());
    }

    #[test]
    fn malformed_json_is_rejected_with_a_named_error() {
        let err = load_theme_str("{ not json ][", "broken.json").unwrap_err();
        assert!(err.contains("broken.json"), "error should name the file: {err}");
    }

    #[test]
    fn a_missing_field_is_named() {
        let err = load_theme_str(r#"{ "schemaVersion": 1, "id": "x" }"#, "t.json").unwrap_err();
        for field in ["label", "appearance", "colors"] {
            assert!(err.contains(field), "error should name missing field `{field}`: {err}");
        }
    }

    #[test]
    fn a_bad_schema_version_is_rejected() {
        let text = TORI_DARK.replacen("\"schemaVersion\": 1", "\"schemaVersion\": 2", 1);
        let err = load_theme_str(&text, "t.json").unwrap_err();
        assert!(
            err.contains("schemaVersion"),
            "error should mention schemaVersion: {err}"
        );
    }

    /// An unknown colour key is a typo, and a typo means the role it was meant
    /// to fill silently keeps the previous theme's value. `deny_unknown_fields`
    /// turns that into an error naming the key.
    #[test]
    fn an_unknown_colour_key_is_rejected() {
        let text = TORI_DARK.replacen("\"canvas\":", "\"canvasss\":", 1);
        let err = load_theme_str(&text, "t.json").unwrap_err();
        assert!(err.contains("canvasss"), "error should name the unknown key: {err}");
    }

    #[test]
    fn the_catalog_fields_load_and_stay_optional() {
        let mut bare: serde_json::Value = serde_json::from_str(TORI_DARK).unwrap();
        for key in ["description", "license", "contributor"] {
            bare.as_object_mut().unwrap().remove(key);
        }
        let bare = bare.to_string();
        let text = bare.replacen(
            "{",
            r#"{ "description": "One line for the card", "license": "MIT", "contributor": { "name": "Ada", "github": "ada" },"#,
            1,
        );
        let with = load_theme_str(&text, "t.json").unwrap();
        assert_eq!(with.description.as_deref(), Some("One line for the card"));
        assert_eq!(with.license.as_deref(), Some("MIT"));
        assert_eq!(with.contributor.map(|c| c.github), Some("ada".to_string()));
        let without = load_theme_str(&bare, "t.json").unwrap();
        assert!(without.description.is_none() && without.contributor.is_none() && without.license.is_none());
    }

    #[test]
    fn an_id_that_could_climb_out_of_its_folder_is_refused() {
        let text = TORI_DARK.replacen("\"tori-dark\"", "\"../x\"", 1);
        assert!(load_theme_str(&text, "t.json").unwrap_err().contains("../x"));
    }

    #[test]
    fn a_non_hex_value_is_rejected_naming_the_key() {
        let text = TORI_DARK.replacen("\"canvas\": \"", "\"canvas\": \"rebeccapurple", 1);
        let err = load_theme_str(&text, "t.json").unwrap_err();
        assert!(err.contains("canvas"), "error should name the bad key: {err}");
    }

    /// One broken file must not take the whole directory with it, which is the
    /// same rule agents.rs applies to a broken adapter.
    #[test]
    fn a_broken_file_is_reported_and_the_others_still_load() {
        let dir = tmp_dir();
        std::fs::write(
            dir.join("mine.json"),
            TORI_DARK.replacen("\"tori-dark\"", "\"mine\"", 1),
        )
        .unwrap();
        std::fs::write(dir.join("bad.json"), "{").unwrap();

        let (themes, errors) = load_themes_from(&dir);
        assert_eq!(themes.len(), 1);
        assert_eq!(themes[0].palette.id, "mine");
        assert_eq!(errors.len(), 1);
        assert!(errors[0].file.ends_with("bad.json") && errors[0].kind == Some(Kind::Themes));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_bundled_id_is_refused_with_the_fix() {
        let dir = tmp_dir();
        std::fs::write(dir.join("tori-dark.json"), TORI_DARK).unwrap();

        let (themes, errors) = load_themes_from(&dir);
        assert!(themes.is_empty());
        assert_eq!(errors[0].fix.as_deref(), Some(packs::FIX_NEW_ID));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_directory_yields_nothing_rather_than_an_error() {
        let dir = std::env::temp_dir().join("tori-themes-does-not-exist");
        let _ = std::fs::remove_dir_all(&dir);
        let (themes, errors) = load_themes_from(&dir);
        assert!(themes.is_empty());
        assert!(errors.is_empty());
    }

    /// Only `.json` is a theme. A README or an editor swapfile in the folder is
    /// not an error to report at the user.
    #[test]
    fn non_json_files_are_ignored_silently() {
        let dir = tmp_dir();
        std::fs::write(dir.join("README.md"), "not a theme").unwrap();
        let (themes, errors) = load_themes_from(&dir);
        assert!(themes.is_empty());
        assert!(errors.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
