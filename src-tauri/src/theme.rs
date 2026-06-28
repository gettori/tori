// Read the user's active VS Code theme so Sway's own chrome can match it.
// VS Code settings/themes are JSONC (comments, trailing commas), so we parse
// with json5.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn settings_path() -> PathBuf {
    home().join("Library/Application Support/Code/User/settings.json")
}

fn extensions_dir() -> PathBuf {
    home().join(".vscode/extensions")
}

fn read_value(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    json5::from_str(&text).ok()
}

#[derive(Serialize, Default)]
pub struct ThemeColors {
    pub kind: Option<String>,
    pub colors: HashMap<String, String>,
}

/// Collect a theme file's `colors`, following `include` (base first so the
/// including file wins).
fn collect(path: &Path, out: &mut HashMap<String, String>, kind: &mut Option<String>) {
    let Some(v) = read_value(path) else {
        return;
    };
    if let Some(inc) = v.get("include").and_then(|i| i.as_str()) {
        if let Some(dir) = path.parent() {
            collect(&dir.join(inc), out, kind);
        }
    }
    if kind.is_none() {
        if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
            *kind = Some(t.to_string());
        }
    }
    if let Some(colors) = v.get("colors").and_then(|c| c.as_object()) {
        for (k, val) in colors {
            if let Some(s) = val.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
}

/// Find a contributed theme's file path by its label (or id).
fn find_theme_path(label: &str) -> Option<PathBuf> {
    for e in std::fs::read_dir(extensions_dir()).ok()?.flatten() {
        let Some(pkg) = read_value(&e.path().join("package.json")) else {
            continue;
        };
        let themes = pkg
            .get("contributes")
            .and_then(|c| c.get("themes"))
            .and_then(|t| t.as_array());
        let Some(arr) = themes else { continue };
        for t in arr {
            let l = t
                .get("label")
                .or_else(|| t.get("id"))
                .and_then(|x| x.as_str());
            if l == Some(label) {
                if let Some(p) = t.get("path").and_then(|p| p.as_str()) {
                    return Some(e.path().join(p.trim_start_matches("./")));
                }
            }
        }
    }
    None
}

fn apply_customizations(colors: &mut HashMap<String, String>, settings: &Value, label: &str) {
    let Some(cc) = settings
        .get("workbench.colorCustomizations")
        .and_then(|c| c.as_object())
    else {
        return;
    };
    for (k, val) in cc {
        if k.starts_with('[') {
            continue;
        }
        if let Some(s) = val.as_str() {
            colors.insert(k.clone(), s.to_string());
        }
    }
    // Theme-scoped overrides, e.g. "[GitHub Dark Dimmed]": { ... }.
    if let Some(scoped) = cc.get(&format!("[{label}]")).and_then(|x| x.as_object()) {
        for (k, val) in scoped {
            if let Some(s) = val.as_str() {
                colors.insert(k.clone(), s.to_string());
            }
        }
    }
}

#[tauri::command]
pub fn get_theme_colors() -> Result<ThemeColors, String> {
    let settings = read_value(&settings_path()).unwrap_or(Value::Null);
    let label = settings
        .get("workbench.colorTheme")
        .and_then(|t| t.as_str())
        .unwrap_or("Default Dark Modern")
        .to_string();

    let mut colors = HashMap::new();
    let mut kind = None;
    if let Some(path) = find_theme_path(&label) {
        collect(&path, &mut colors, &mut kind);
    }
    apply_customizations(&mut colors, &settings, &label);

    Ok(ThemeColors { kind, colors })
}
