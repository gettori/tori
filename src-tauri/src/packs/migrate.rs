// Agents and debuggers keep a bundled id as a recorded override rather than
// becoming `<id>-custom`: accounts, profile homes and session records name an
// agent by id, and F5's targets name the bundled debuggers by theirs.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::{installed, Kind};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub moved: Vec<Moved>,
    pub skipped: Vec<Skipped>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub kind: Kind,
    pub from: String,
    pub to: String,
    /// The bundled id the file carried before it became `<id>-custom`.
    pub renamed_from: Option<String>,
    /// Kept under its bundled id as a recorded override.
    pub is_override: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

static REPORT: OnceLock<Option<Report>> = OnceLock::new();

/// Move the old folders, once per launch. Before anything reads a pack or
/// watches the themes folder, so nothing loads from a folder mid-move.
pub fn run() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let _ = REPORT.set(migrate_at(&crate::owned_state::config_dir(), now));
}

pub fn last_report() -> Option<Report> {
    REPORT.get().cloned().flatten()
}

struct Rename {
    kind: Kind,
    from: String,
    to: String,
}

pub(crate) fn migrate_at(config: &Path, now: u64) -> Option<Report> {
    let mut report = Report {
        moved: Vec::new(),
        skipped: Vec::new(),
    };
    let mut renames = Vec::new();
    let installed_path = config.join("packs").join(installed::FILE);
    let mut installed = installed::read_at(&installed_path);
    let mut recorded = false;

    for kind in Kind::ALL {
        let old = config.join(kind.folder());
        let Ok(meta) = std::fs::symlink_metadata(&old) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            report.skipped.push(Skipped {
                path: old.to_string_lossy().into_owned(),
                reason: format!(
                    "a symlink, left in place; move what it points to into packs/{} yourself",
                    kind.folder()
                ),
            });
            continue;
        }
        if !meta.is_dir() {
            continue;
        }
        let new_dir = config.join("packs").join(kind.folder());
        if let Err(e) = std::fs::create_dir_all(&new_dir) {
            report.skipped.push(Skipped {
                path: old.to_string_lossy().into_owned(),
                reason: e.to_string(),
            });
            continue;
        }
        let mut files: Vec<PathBuf> = std::fs::read_dir(&old)
            .map(|entries| entries.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        files.sort();
        for path in files {
            let step = move_file(kind, &path, &new_dir, &mut installed, now);
            match step {
                Ok(Step { moved, rename }) => {
                    recorded |= moved.is_override;
                    report.moved.push(moved);
                    renames.extend(rename);
                }
                Err(reason) => report.skipped.push(Skipped {
                    path: path.to_string_lossy().into_owned(),
                    reason,
                }),
            }
        }
        // `remove_dir` takes only an empty real directory, which is the only
        // kind this should ever take.
        let _ = std::fs::remove_dir(&old);
    }

    if recorded {
        let written = installed
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|i| installed::write_at(&installed_path, i));
        if let Err(e) = written {
            report.skipped.push(Skipped {
                path: installed_path.to_string_lossy().into_owned(),
                reason: e,
            });
        }
    }
    if let Err(e) = rename_in_settings(&config.join("settings.json"), &renames) {
        report.skipped.push(Skipped {
            path: config.join("settings.json").to_string_lossy().into_owned(),
            reason: e,
        });
    }

    (!report.moved.is_empty() || !report.skipped.is_empty()).then_some(report)
}

struct Step {
    moved: Moved,
    rename: Option<Rename>,
}

fn move_file(
    kind: Kind,
    path: &Path,
    new_dir: &Path,
    installed: &mut Result<installed::Installed, String>,
    now: u64,
) -> Result<Step, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a plain file, left in place".into());
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let is_pack = path.extension().and_then(|e| e.to_str()) == Some(kind.ext());
    let text = is_pack.then(|| std::fs::read_to_string(path).ok()).flatten();
    let id = text.as_deref().and_then(|t| pack_id(kind, t));

    let moved = |to: &Path, renamed_from: Option<String>, is_override: bool| Moved {
        kind,
        from: path.to_string_lossy().into_owned(),
        to: to.to_string_lossy().into_owned(),
        renamed_from,
        is_override,
    };
    let free = |target: &Path| {
        if target.exists() {
            Err(format!("{} already exists, left in place", target.display()))
        } else {
            Ok(())
        }
    };

    match (id, text) {
        (Some(id), Some(text)) if super::is_bundled(kind, &id) && keeps_its_id(kind) => {
            let installed = installed
                .as_mut()
                .map_err(|e| format!("not recorded as an override: {e}"))?;
            let target = new_dir.join(format!("{id}.{}", kind.ext()));
            free(&target)?;
            std::fs::rename(path, &target).map_err(|e| e.to_string())?;
            installed.record(installed::Record {
                kind,
                id: id.clone(),
                sha256: super::sha256(&text),
                source: installed::Source::Override,
                packs_commit: None,
                installed_at: now,
                bundled_sha256: super::snapshot::sha256(kind.folder(), &id).map(str::to_string),
            });
            Ok(Step {
                moved: moved(&target, None, true),
                rename: None,
            })
        }
        (Some(id), Some(text)) if super::is_bundled(kind, &id) => {
            let to = format!("{id}-custom");
            let target = new_dir.join(format!("{to}.{}", kind.ext()));
            free(&target)?;
            let rewritten = rename_id(kind, &text, &to)?;
            crate::owned_state::write_atomically(&target, &rewritten)?;
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
            Ok(Step {
                moved: moved(&target, Some(id.clone()), false),
                rename: Some(Rename { kind, from: id, to }),
            })
        }
        (id, _) => {
            // Named after its id where the id is one, so the stem rule holds.
            let file = match id.filter(|id| super::check_id(id, "").is_ok()) {
                Some(id) => format!("{id}.{}", kind.ext()),
                None => name,
            };
            let target = new_dir.join(file);
            free(&target)?;
            std::fs::rename(path, &target).map_err(|e| e.to_string())?;
            Ok(Step {
                moved: moved(&target, None, false),
                rename: None,
            })
        }
    }
}

fn keeps_its_id(kind: Kind) -> bool {
    matches!(kind, Kind::Agents | Kind::Dap)
}

fn pack_id(kind: Kind, text: &str) -> Option<String> {
    match kind {
        Kind::Themes => serde_json::from_str::<serde_json::Value>(text).ok()?["id"]
            .as_str()
            .map(str::to_string),
        _ => toml::from_str::<toml::Table>(text)
            .ok()?
            .get("id")?
            .as_str()
            .map(str::to_string),
    }
}

// Edited in place rather than re-serialized, so the file's comments survive.
fn rename_id(kind: Kind, text: &str, to: &str) -> Result<String, String> {
    if kind == Kind::Themes {
        let mut value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        value["id"] = to.into();
        if let Some(label) = value["label"].as_str() {
            value["label"] = format!("{label} (custom)").into();
        }
        return serde_json::to_string_pretty(&value)
            .map(|t| t + "\n")
            .map_err(|e| e.to_string());
    }
    let mut doc: toml_edit::Document = text.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;
    let mut set = |key: &str, value: String| {
        if let Some(v) = doc.get_mut(key).and_then(|i| i.as_value_mut()) {
            let decor = v.decor().clone();
            *v = value.into();
            *v.decor_mut() = decor;
        }
    };
    set("id", to.to_string());
    if let Some(label) = toml::from_str::<toml::Table>(text)
        .ok()
        .and_then(|t| t.get("label").and_then(|l| l.as_str()).map(str::to_string))
    {
        set("label", format!("{label} (custom)"));
    }
    Ok(doc.to_string())
}

// Edited as JSON rather than through `Settings`, so a file this build cannot
// fully read is left alone instead of being rewritten as defaults.
fn rename_in_settings(path: &Path, renames: &[Rename]) -> Result<(), String> {
    if renames.is_empty() {
        return Ok(());
    }
    let mut value: serde_json::Value = match std::fs::read_to_string(path) {
        Ok(text) => json5::from_str(&text).map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(e.to_string()),
    };
    if !value.is_object() {
        return Err("settings.json is not an object".into());
    }
    for r in renames {
        match r.kind {
            Kind::Lsp => switch_off(&mut value, "lsp", r),
            Kind::Formatters => {
                switch_off(&mut value, "format", r);
                if let Some(map) = value["format"]["byExtension"].as_object_mut() {
                    for v in map.values_mut().filter(|v| v.as_str() == Some(r.from.as_str())) {
                        *v = r.to.clone().into();
                    }
                }
            }
            Kind::Themes => {
                if value["appearance"]["theme"].as_str() == Some(r.from.as_str()) {
                    value["appearance"]["theme"] = r.to.clone().into();
                }
            }
            Kind::Dap | Kind::Agents => {}
        }
    }
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(path, &text)
}

fn switch_off(settings: &mut serde_json::Value, section: &str, rename: &Rename) {
    if !settings[section].is_object() {
        settings[section] = serde_json::json!({});
    }
    if !settings[section]["disabled"].is_array() {
        settings[section]["disabled"] = serde_json::json!([]);
    }
    let Some(list) = settings[section]["disabled"].as_array_mut() else {
        return;
    };
    let has = |list: &Vec<serde_json::Value>, id: &str| list.iter().any(|v| v.as_str() == Some(id));
    let was_off = has(list, &rename.from);
    if !was_off {
        list.push(rename.from.clone().into());
    }
    if was_off && !has(list, &rename.to) {
        list.push(rename.to.clone().into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-packs-migrate-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const MINE: &str = "schema_version = 1\nid = \"mine\"\n";

    fn bundled(kind: Kind, id: &str) -> &'static str {
        super::super::snapshot::text(kind.folder(), id).unwrap()
    }

    fn settings(config: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(config.join("settings.json")).unwrap()).unwrap()
    }

    #[test]
    fn a_plain_file_moves_and_the_old_folder_goes() {
        let config = scratch("plain");
        std::fs::create_dir_all(config.join("lsp")).unwrap();
        std::fs::write(config.join("lsp/mine.toml"), MINE).unwrap();

        let report = migrate_at(&config, 1).expect("a move is reported");
        assert_eq!(report.moved.len(), 1);
        assert_eq!(
            std::fs::read_to_string(config.join("packs/lsp/mine.toml")).unwrap(),
            MINE
        );
        assert!(!config.join("lsp").exists());
        assert!(report.skipped.is_empty());
    }

    #[test]
    fn a_second_run_says_nothing() {
        let config = scratch("twice");
        std::fs::create_dir_all(config.join("dap")).unwrap();
        std::fs::write(config.join("dap/mine.toml"), MINE).unwrap();

        assert!(migrate_at(&config, 1).is_some());
        assert!(migrate_at(&config, 1).is_none());
    }

    #[test]
    fn a_collision_is_skipped_and_reported() {
        let config = scratch("collision");
        std::fs::create_dir_all(config.join("lsp")).unwrap();
        std::fs::create_dir_all(config.join("packs/lsp")).unwrap();
        std::fs::write(config.join("lsp/mine.toml"), MINE).unwrap();
        std::fs::write(config.join("packs/lsp/mine.toml"), "id = \"mine\"\n# theirs").unwrap();

        let report = migrate_at(&config, 1).unwrap();
        assert_eq!(report.skipped.len(), 1);
        assert!(report.skipped[0].path.ends_with("lsp/mine.toml"));
        assert!(config.join("lsp/mine.toml").exists(), "left in place");
        assert!(std::fs::read_to_string(config.join("packs/lsp/mine.toml"))
            .unwrap()
            .contains("theirs"));
    }

    #[test]
    fn a_symlinked_folder_is_left_and_reported() {
        let config = scratch("symlink");
        let elsewhere = config.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("mine.toml"), MINE).unwrap();
        std::os::unix::fs::symlink(&elsewhere, config.join("lsp")).unwrap();

        let report = migrate_at(&config, 1).unwrap();
        assert!(report.moved.is_empty());
        assert!(report.skipped[0].reason.contains("symlink"));
        assert!(std::fs::symlink_metadata(config.join("lsp"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(elsewhere.join("mine.toml").exists());
    }

    #[test]
    fn a_bundled_lsp_id_becomes_custom_and_the_bundled_one_is_switched_off() {
        let config = scratch("lsp-bundled");
        std::fs::create_dir_all(config.join("lsp")).unwrap();
        let text = format!("# my own eslint\n{}", bundled(Kind::Lsp, "eslint"));
        std::fs::write(config.join("lsp/eslint.toml"), &text).unwrap();

        let report = migrate_at(&config, 1).unwrap();
        assert_eq!(report.moved[0].renamed_from.as_deref(), Some("eslint"));
        let moved = std::fs::read_to_string(config.join("packs/lsp/eslint-custom.toml")).unwrap();
        assert!(moved.starts_with("# my own eslint\n"), "the comment survives");
        let table: toml::Table = toml::from_str(&moved).unwrap();
        assert_eq!(table["id"].as_str(), Some("eslint-custom"));
        assert!(table["label"].as_str().unwrap().ends_with(" (custom)"));
        assert_eq!(settings(&config)["lsp"]["disabled"], serde_json::json!(["eslint"]));
    }

    #[test]
    fn a_custom_name_already_taken_is_skipped() {
        let config = scratch("custom-taken");
        std::fs::create_dir_all(config.join("lsp")).unwrap();
        std::fs::create_dir_all(config.join("packs/lsp")).unwrap();
        std::fs::write(config.join("lsp/eslint.toml"), bundled(Kind::Lsp, "eslint")).unwrap();
        std::fs::write(config.join("packs/lsp/eslint-custom.toml"), "x").unwrap();

        let report = migrate_at(&config, 1).unwrap();
        assert!(report.skipped[0].reason.contains("eslint-custom.toml"));
        assert!(config.join("lsp/eslint.toml").exists());
        assert!(
            !config.join("settings.json").exists(),
            "nothing renamed, nothing switched off"
        );
    }

    #[test]
    fn a_bundled_theme_id_moves_the_selected_theme_with_it() {
        let config = scratch("theme");
        std::fs::create_dir_all(config.join("themes")).unwrap();
        std::fs::write(config.join("themes/dracula.json"), bundled(Kind::Themes, "dracula")).unwrap();
        std::fs::write(config.join("settings.json"), r#"{"appearance":{"theme":"dracula"}}"#).unwrap();

        migrate_at(&config, 1).unwrap();
        let theme: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(config.join("packs/themes/dracula-custom.json")).unwrap())
                .unwrap();
        assert_eq!(theme["id"], "dracula-custom");
        assert!(theme["label"].as_str().unwrap().ends_with(" (custom)"));
        assert_eq!(settings(&config)["appearance"]["theme"], "dracula-custom");
        assert!(settings(&config).get("lsp").is_none(), "themes have no disabled list");
    }

    #[test]
    fn a_bundled_agent_keeps_its_id_as_a_recorded_override() {
        let config = scratch("agent");
        std::fs::create_dir_all(config.join("agents")).unwrap();
        let text = bundled(Kind::Agents, "claude").replace("label = \"Claude\"", "label = \"Mine\"");
        std::fs::write(config.join("agents/claude.toml"), &text).unwrap();

        let report = migrate_at(&config, 7).unwrap();
        assert!(report.moved[0].is_override);
        let record = installed::read_at(&config.join("packs/installed.json")).unwrap();
        let claude = record.find(Kind::Agents, "claude").unwrap();
        assert_eq!(claude.source, installed::Source::Override);
        assert_eq!(claude.sha256, super::super::sha256(&text));
        assert_eq!(claude.installed_at, 7);
        assert_eq!(
            claude.bundled_sha256.as_deref(),
            super::super::snapshot::sha256("agents", "claude")
        );
        assert!(!config.join("settings.json").exists(), "an agent is never switched off");
    }
}
