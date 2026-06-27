// Sway config. The user declares groups/projects in ~/.config/sway/sway.toml.
// Branches are NOT declared: they are discovered live from git per project
// (all branches share the one project working dir).

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Deserialize)]
struct RawConfig {
    #[serde(default)]
    project: Vec<RawProject>,
}

#[derive(Deserialize)]
struct RawProject {
    name: String,
    group: String,
    path: String,
}

#[derive(Serialize, Clone)]
pub struct Project {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
pub struct Group {
    pub name: String,
    pub projects: Vec<Project>,
}

#[derive(Serialize, Clone)]
pub struct ResolvedConfig {
    pub path: String,
    pub groups: Vec<Group>,
}

#[derive(Serialize, Clone)]
pub struct Branch {
    pub name: String,
    pub current: bool,
}

pub struct ConfigWatch(pub Mutex<Option<RecommendedWatcher>>);

impl Default for ConfigWatch {
    fn default() -> Self {
        ConfigWatch(Mutex::new(None))
    }
}

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/sway/sway.toml")
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

const SAMPLE: &str = r#"# Sway config. Declare your projects; branches are discovered from git.
# Each project shares one working dir; all its git branches appear under it.

[[project]]
name = "sway"
group = "personal"
path = "~/Projects/personal/sway"
"#;

fn ensure_config() -> Result<String, String> {
    let path = config_path();
    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, SAMPLE).map_err(|e| e.to_string())?;
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Group the flat project list into ordered groups (first-seen order preserved).
fn resolve(raw: RawConfig) -> ResolvedConfig {
    let mut groups: Vec<Group> = Vec::new();
    for p in raw.project {
        let project = Project {
            name: p.name,
            path: expand_tilde(&p.path),
        };
        match groups.iter_mut().find(|g| g.name == p.group) {
            Some(g) => g.projects.push(project),
            None => groups.push(Group {
                name: p.group,
                projects: vec![project],
            }),
        }
    }
    ResolvedConfig {
        path: config_path().to_string_lossy().into_owned(),
        groups,
    }
}

#[tauri::command]
pub fn get_config() -> Result<ResolvedConfig, String> {
    let text = ensure_config()?;
    let raw: RawConfig = toml::from_str(&text).map_err(|e| e.to_string())?;
    Ok(resolve(raw))
}

#[tauri::command]
pub fn list_branches(path: String) -> Result<Vec<Branch>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["branch", "--format=%(refname:short)\t%(HEAD)"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // Not a git repo (or no commits yet): no branches, not an error.
        return Ok(vec![]);
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut branches = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(2, '\t');
        let name = parts.next().unwrap_or("").trim().to_string();
        let current = parts.next().map(|h| h.trim() == "*").unwrap_or(false);
        if !name.is_empty() {
            branches.push(Branch { name, current });
        }
    }
    Ok(branches)
}

/// Install a watcher on the config file's directory. Emits `config://changed`
/// whenever sway.toml is written. Idempotent: re-installing replaces the old one.
#[tauri::command]
pub fn config_watch_start(app: AppHandle, state: State<ConfigWatch>) -> Result<(), String> {
    let path = config_path();
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let target = path.clone();
    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if event.paths.iter().any(|p| p == &target) {
                let _ = app_handle.emit("config://changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(watcher);
    Ok(())
}
