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
    /// Syntax foreground per category (keyword/string/comment/...), distilled
    /// from the theme's TextMate `tokenColors`. May be empty if the theme has
    /// none; the frontend then falls back to a built-in palette.
    pub syntax: HashMap<String, String>,
}

/// Collect a theme file's `colors` and TextMate `tokenColors`, following
/// `include` (base first so the including file wins).
fn collect(
    path: &Path,
    out: &mut HashMap<String, String>,
    tokens: &mut HashMap<String, String>,
    kind: &mut Option<String>,
) {
    let Some(v) = read_value(path) else {
        return;
    };
    if let Some(inc) = v.get("include").and_then(|i| i.as_str()) {
        if let Some(dir) = path.parent() {
            collect(&dir.join(inc), out, tokens, kind);
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
    collect_token_colors(&v, tokens);
}

/// Flatten a theme's `tokenColors` array into scope -> foreground, splitting
/// comma- and array-valued scopes. Later rules win (including file overrides
/// base). Rules without a foreground or without a scope (the editor default)
/// are skipped.
fn collect_token_colors(v: &Value, tokens: &mut HashMap<String, String>) {
    let Some(rules) = v.get("tokenColors").and_then(|t| t.as_array()) else {
        return;
    };
    for rule in rules {
        let Some(fg) = rule
            .get("settings")
            .and_then(|s| s.get("foreground"))
            .and_then(|f| f.as_str())
        else {
            continue;
        };
        match rule.get("scope") {
            Some(Value::String(s)) => {
                for sc in s.split(',') {
                    tokens.insert(sc.trim().to_string(), fg.to_string());
                }
            }
            Some(Value::Array(arr)) => {
                for sc in arr.iter().filter_map(|x| x.as_str()) {
                    tokens.insert(sc.trim().to_string(), fg.to_string());
                }
            }
            _ => {}
        }
    }
}

/// Category -> ordered candidate TextMate scopes (most representative first).
const SYNTAX_SCOPES: &[(&str, &[&str])] = &[
    ("keyword", &["keyword", "keyword.control", "storage.type", "storage.modifier"]),
    ("string", &["string", "string.quoted"]),
    ("comment", &["comment"]),
    ("number", &["constant.numeric", "constant.language", "constant"]),
    ("function", &["entity.name.function", "support.function", "meta.function-call"]),
    ("type", &["entity.name.type", "support.type", "support.class", "entity.name.class"]),
    ("variable", &["variable", "variable.other"]),
];

/// Resolve a candidate scope against the flattened token map: exact match first,
/// else the shortest more-specific scope (`keyword` matches `keyword.control`).
fn resolve_scope(tokens: &HashMap<String, String>, candidate: &str) -> Option<String> {
    if let Some(c) = tokens.get(candidate) {
        return Some(c.clone());
    }
    let prefix = format!("{candidate}.");
    tokens
        .iter()
        .filter(|(k, _)| k.starts_with(&prefix))
        .min_by_key(|(k, _)| k.len())
        .map(|(_, v)| v.clone())
}

fn distill_syntax(tokens: &HashMap<String, String>) -> HashMap<String, String> {
    let mut syntax = HashMap::new();
    for (cat, candidates) in SYNTAX_SCOPES {
        for cand in *candidates {
            if let Some(color) = resolve_scope(tokens, cand) {
                syntax.insert((*cat).to_string(), color);
                break;
            }
        }
    }
    syntax
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

/// Read a single theme file (any VS Code theme JSON/JSONC) into ThemeColors,
/// following `include`. Used by the in-app theme import, which lets Sway load a
/// theme without VS Code being installed.
#[tauri::command]
pub fn get_theme_colors_from_path(path: String) -> Result<ThemeColors, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("theme file not found: {path}"));
    }
    let mut colors = HashMap::new();
    let mut tokens = HashMap::new();
    let mut kind = None;
    collect(&p, &mut colors, &mut tokens, &mut kind);
    if colors.is_empty() && tokens.is_empty() {
        return Err(format!("not a readable theme file: {path}"));
    }
    Ok(ThemeColors {
        kind,
        colors,
        syntax: distill_syntax(&tokens),
    })
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
    let mut tokens = HashMap::new();
    let mut kind = None;
    if let Some(path) = find_theme_path(&label) {
        collect(&path, &mut colors, &mut tokens, &mut kind);
    }
    apply_customizations(&mut colors, &settings, &label);

    Ok(ThemeColors {
        kind,
        colors,
        syntax: distill_syntax(&tokens),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distills_categories_with_exact_and_prefix_scopes() {
        let theme = serde_json::json!({
            "tokenColors": [
                { "scope": "comment", "settings": { "foreground": "#6a9955" } },
                // comma-joined scopes share one foreground
                { "scope": "keyword, storage.type", "settings": { "foreground": "#569cd6" } },
                // array scopes
                { "scope": ["string.quoted.double", "string.quoted.single"], "settings": { "foreground": "#ce9178" } },
                // prefix-only: no exact "entity.name.function"
                { "scope": "entity.name.function.ts", "settings": { "foreground": "#dcdcaa" } },
                // no foreground -> ignored
                { "scope": "variable", "settings": { "fontStyle": "italic" } },
            ]
        });
        let mut tokens = HashMap::new();
        collect_token_colors(&theme, &mut tokens);
        let syn = distill_syntax(&tokens);

        assert_eq!(syn.get("comment").map(String::as_str), Some("#6a9955"));
        assert_eq!(syn.get("keyword").map(String::as_str), Some("#569cd6"));
        // "string" resolves via the shortest "string." prefix
        assert_eq!(syn.get("string").map(String::as_str), Some("#ce9178"));
        assert_eq!(syn.get("function").map(String::as_str), Some("#dcdcaa"));
        // variable had no foreground anywhere -> absent (frontend falls back)
        assert!(syn.get("variable").is_none());
    }

    #[test]
    fn imports_an_arbitrary_theme_file_with_colors_and_syntax() {
        let dir = std::env::temp_dir().join(format!("sway-theme-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("my-theme.json");
        std::fs::write(
            &file,
            r##"{
                // JSONC comment tolerated by json5
                "type": "dark",
                "colors": { "editor.background": "#101010", "foreground": "#eeeeee" },
                "tokenColors": [
                    { "scope": "comment", "settings": { "foreground": "#6a9955" } },
                    { "scope": ["keyword", "storage.type"], "settings": { "foreground": "#ff00ff" } }
                ]
            }"##,
        )
        .unwrap();

        let t = get_theme_colors_from_path(file.to_string_lossy().to_string())
            .expect("import must succeed");
        assert_eq!(t.kind.as_deref(), Some("dark"));
        assert_eq!(t.colors.get("editor.background").map(String::as_str), Some("#101010"));
        assert_eq!(t.syntax.get("keyword").map(String::as_str), Some("#ff00ff"));
        assert_eq!(t.syntax.get("comment").map(String::as_str), Some("#6a9955"));

        assert!(get_theme_colors_from_path("/no/such/theme.json".into()).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_tokens_distill_to_empty() {
        let syn = distill_syntax(&HashMap::new());
        assert!(syn.is_empty());
    }

    #[test]
    fn real_theme_loads_without_error() {
        // Environment-dependent: just assert it never errors and report counts.
        let t = get_theme_colors().expect("get_theme_colors must not error");
        eprintln!(
            "real theme: {} chrome colors, {} syntax categories",
            t.colors.len(),
            t.syntax.len()
        );
    }
}
