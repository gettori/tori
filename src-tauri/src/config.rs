// Sway config. Projects are DISCOVERED from the filesystem, not declared:
// the user lists base "roots" (default `~/Projects`); each `<root>/<group>/<project>`
// folder becomes a project, grouped by its first-level dir. Extra out-of-root
// project folders can be added explicitly. A legacy `[[project]]` table is still
// honored (folded in as explicit paths) so old configs keep working.
//
// Per project we probe git once (cached by the project dir's mtime AND its HEAD,
// so a checkout invalidates it) to classify it and enumerate its branch-units:
//   - worktree : a bare container with per-branch worktree folders (one unit each)
//   - plain    : a normal repo (one unit per local branch, sharing the dir)
//   - plain-dir: a non-git folder (a single unit)
//   - incomplete: a `.bare` with zero worktrees (a cleanable stub)

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Deserialize, Default)]
struct RawConfig {
    #[serde(default)]
    discovery: RawDiscovery,
    // Legacy schema: explicit project declarations. Migrated (non-destructively)
    // into explicit extra paths so old configs are never silently dropped.
    #[serde(default)]
    project: Vec<RawProject>,
}

#[derive(Deserialize, Default)]
struct RawDiscovery {
    /// Base folders scanned as `<root>/<group>/<project>`.
    #[serde(default)]
    roots: Vec<String>,
    /// Folder names skipped during the scan (in addition to dotfiles).
    #[serde(default)]
    ignore: Vec<String>,
    /// Explicit out-of-root project folders.
    #[serde(default)]
    paths: Vec<String>,
}

// `name` is intentionally omitted: discovery derives the project name from the
// folder basename, so a legacy entry's declared name is ignored on migration.
#[derive(Deserialize)]
struct RawProject {
    group: String,
    path: String,
}

/// How a project folder relates to git. Serialized kebab-case for the frontend.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectKind {
    Worktree,
    Plain,
    PlainDir,
    Incomplete,
}

/// One selectable unit under a project: a worktree folder, a branch of a plain
/// repo, the folder itself (plain-dir), or a cleanable stub (incomplete).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchUnit {
    pub label: String,
    pub folder_path: String,
    pub branch: Option<String>,
    pub kind: ProjectKind,
    /// Only meaningful for plain repos (the checked-out branch); false otherwise.
    pub is_current: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub path: String,
    pub branch_units: Vec<BranchUnit>,
}

#[derive(Serialize, Clone)]
pub struct Group {
    pub name: String,
    // The group's directory, so the UI can mkdir a new project folder under it.
    pub path: String,
    pub projects: Vec<Project>,
}

#[derive(Serialize, Clone)]
pub struct ResolvedConfig {
    pub path: String,
    // The configured base folders (expanded). Empty + no groups => first run.
    pub roots: Vec<String>,
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

/// Cached git probe per project dir, invalidated when the dir or its HEAD changes.
struct ProbeEntry {
    dir_mtime: SystemTime,
    head_mtime: SystemTime,
    units: Vec<BranchUnit>,
}

#[derive(Default)]
pub struct ProjectIndex(Mutex<HashMap<PathBuf, ProbeEntry>>);

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

fn basename(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// No project is seeded: a fresh config has no roots, which the UI detects as a
// first run and offers a folder picker (see add_root). Projects are discovered
// from the roots the user adds; legacy `[[project]]` tables are still honored.
const SAMPLE: &str = r#"# Sway config. Projects are discovered from your base folders.
# Add a base folder from the app, or declare roots here:
#
# [discovery]
# roots  = ["~/Projects"]   # base folders scanned as <root>/<group>/<project>
# ignore = ["node_modules"] # folder names to skip (dotfiles are always skipped)
# paths  = []               # explicit out-of-root project folders
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

// --- git probing ---

fn run_git(path: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The repo's default branch (e.g. `main`), via origin/HEAD. None if unset.
fn default_branch(path: &Path) -> Option<String> {
    let text = run_git(path, &["symbolic-ref", "refs/remotes/origin/HEAD"])?;
    text.trim()
        .strip_prefix("refs/remotes/origin/")
        .map(|s| s.to_string())
}

struct WtEntry {
    path: String,
    branch: Option<String>,
    bare: bool,
}

fn parse_worktrees(text: &str) -> Vec<WtEntry> {
    let mut out = Vec::new();
    let mut cur: Option<WtEntry> = None;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(e) = cur.take() {
                out.push(e);
            }
            cur = Some(WtEntry {
                path: p.to_string(),
                branch: None,
                bare: false,
            });
        } else if line == "bare" {
            if let Some(e) = cur.as_mut() {
                e.bare = true;
            }
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(e) = cur.as_mut() {
                e.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            }
        } else if line == "detached" {
            if let Some(e) = cur.as_mut() {
                e.branch = Some("(detached)".to_string());
            }
        }
    }
    if let Some(e) = cur.take() {
        out.push(e);
    }
    out
}

/// Branch-units for a plain repo: one per local branch, all sharing the repo dir.
fn plain_branch_units(path: &Path) -> Vec<BranchUnit> {
    let mut units = Vec::new();
    if let Some(text) = run_git(path, &["branch", "--format=%(refname:short)\t%(HEAD)"]) {
        for line in text.lines() {
            let mut parts = line.splitn(2, '\t');
            let name = parts.next().unwrap_or("").trim().to_string();
            let current = parts.next().map(|h| h.trim() == "*").unwrap_or(false);
            if name.is_empty() {
                continue;
            }
            units.push(BranchUnit {
                label: name.clone(),
                folder_path: path.to_string_lossy().into_owned(),
                branch: Some(name),
                kind: ProjectKind::Plain,
                is_current: current,
            });
        }
    }
    // A repo with no branches yet still shows its folder as a single plain unit.
    if units.is_empty() {
        units.push(BranchUnit {
            label: basename(path),
            folder_path: path.to_string_lossy().into_owned(),
            branch: None,
            kind: ProjectKind::Plain,
            is_current: false,
        });
    }
    units
}

/// Classify a project folder and enumerate its branch-units.
fn probe_project(path: &Path) -> Vec<BranchUnit> {
    let Some(text) = run_git(path, &["worktree", "list", "--porcelain"]) else {
        // Not a git repo at all.
        return vec![BranchUnit {
            label: basename(path),
            folder_path: path.to_string_lossy().into_owned(),
            branch: None,
            kind: ProjectKind::PlainDir,
            is_current: false,
        }];
    };

    let entries = parse_worktrees(&text);
    let has_bare = entries.iter().any(|e| e.bare);
    let real: Vec<WtEntry> = entries.into_iter().filter(|e| !e.bare).collect();

    if !has_bare {
        // A normal repo: branch-units are its local branches.
        return plain_branch_units(path);
    }

    // A bare container. With no worktrees it is a cleanable stub.
    if real.is_empty() {
        return vec![BranchUnit {
            label: basename(path),
            folder_path: path.to_string_lossy().into_owned(),
            branch: None,
            kind: ProjectKind::Incomplete,
            is_current: false,
        }];
    }

    // A worktree project: one unit per worktree folder, default branch first.
    let def = default_branch(path);
    let mut units: Vec<BranchUnit> = real
        .into_iter()
        .map(|w| BranchUnit {
            label: w
                .branch
                .clone()
                .unwrap_or_else(|| basename(Path::new(&w.path))),
            folder_path: w.path,
            branch: w.branch,
            kind: ProjectKind::Worktree,
            is_current: false,
        })
        .collect();
    units.sort_by(|a, b| {
        let ad = def.is_some() && a.branch.as_deref() == def.as_deref();
        let bd = def.is_some() && b.branch.as_deref() == def.as_deref();
        bd.cmp(&ad).then_with(|| a.label.cmp(&b.label))
    });
    units
}

fn mtime_of(path: &Path) -> SystemTime {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// HEAD mtime: `.git/HEAD` for a plain repo, `.bare/HEAD` for a worktree
/// container. Changes on checkout, so it invalidates the cached branch/isCurrent.
fn head_mtime(path: &Path) -> SystemTime {
    for cand in [path.join(".git/HEAD"), path.join(".bare/HEAD")] {
        if cand.exists() {
            return mtime_of(&cand);
        }
    }
    SystemTime::UNIX_EPOCH
}

/// Probe a project, reusing the cached result when neither the dir nor HEAD moved.
fn cached_probe(index: &ProjectIndex, path: &Path) -> Vec<BranchUnit> {
    let dir_mtime = mtime_of(path);
    let head_mtime = head_mtime(path);
    let mut cache = match index.0.lock() {
        Ok(c) => c,
        Err(_) => return probe_project(path),
    };
    if let Some(e) = cache.get(path) {
        if e.dir_mtime == dir_mtime && e.head_mtime == head_mtime {
            return e.units.clone();
        }
    }
    let units = probe_project(path);
    cache.insert(
        path.to_path_buf(),
        ProbeEntry {
            dir_mtime,
            head_mtime,
            units: units.clone(),
        },
    );
    units
}

// --- discovery ---

/// `(group, path)` for an explicit out-of-root path; group = parent dir name.
fn extra_group_and_path(raw_path: &str) -> (String, PathBuf) {
    let p = PathBuf::from(expand_tilde(raw_path));
    let group = p
        .parent()
        .and_then(|x| x.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    (group, p)
}

/// Index of the group named `name` in `groups`, creating an (initially empty)
/// entry anchored at `path` when absent. Empty group dirs are surfaced too, so a
/// freshly created group is selectable before it holds any project.
fn ensure_group_idx(groups: &mut Vec<Group>, name: &str, path: &Path) -> usize {
    if let Some(i) = groups.iter().position(|g| g.name == name) {
        return i;
    }
    groups.push(Group {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        projects: Vec::new(),
    });
    groups.len() - 1
}

fn resolve(raw: RawConfig, index: &ProjectIndex) -> ResolvedConfig {
    let skip = |name: &str| name.starts_with('.') || raw.discovery.ignore.iter().any(|i| i == name);
    let roots: Vec<String> = raw.discovery.roots.iter().map(|r| expand_tilde(r)).collect();

    let mut groups: Vec<Group> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new(); // project dedup (canonical)
    let mut seen_paths: HashSet<PathBuf> = HashSet::new(); // cache eviction (raw)

    let mut add_project = |groups: &mut Vec<Group>, gi: usize, ppath: PathBuf| {
        let canon = ppath.canonicalize().unwrap_or_else(|_| ppath.clone());
        if !seen.insert(canon) {
            return; // reachable via several roots/paths: keep the first
        }
        seen_paths.insert(ppath.clone());
        let project = Project {
            name: basename(&ppath),
            path: ppath.to_string_lossy().into_owned(),
            branch_units: cached_probe(index, &ppath),
        };
        groups[gi].projects.push(project);
    };

    // 1. Roots scanned as <root>/<group>/<project>; empty group dirs registered.
    for root in &roots {
        let root = PathBuf::from(root);
        let Ok(group_dirs) = std::fs::read_dir(&root) else {
            continue;
        };
        for g in group_dirs.flatten() {
            let gpath = g.path();
            if !gpath.is_dir() || skip(&basename(&gpath)) {
                continue;
            }
            let gi = ensure_group_idx(&mut groups, &basename(&gpath), &gpath);
            if let Ok(projects) = std::fs::read_dir(&gpath) {
                for p in projects.flatten() {
                    let ppath = p.path();
                    if ppath.is_dir() && !skip(&basename(&ppath)) {
                        add_project(&mut groups, gi, ppath);
                    }
                }
            }
        }
    }

    // 2. Explicit extra paths: discovery.paths (group from parent dir) + legacy
    // [[project]] entries (keeping their declared group).
    let mut extra: Vec<(String, PathBuf)> = Vec::new();
    for p in &raw.discovery.paths {
        extra.push(extra_group_and_path(p));
    }
    for p in &raw.project {
        extra.push((p.group.clone(), PathBuf::from(expand_tilde(&p.path))));
    }
    for (gname, ppath) in extra {
        let group_path = ppath.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| ppath.clone());
        let gi = ensure_group_idx(&mut groups, &gname, &group_path);
        add_project(&mut groups, gi, ppath);
    }

    // Evict cache entries for projects that no longer exist.
    if let Ok(mut cache) = index.0.lock() {
        cache.retain(|k, _| seen_paths.contains(k));
    }

    ResolvedConfig {
        path: config_path().to_string_lossy().into_owned(),
        roots,
        groups,
    }
}

#[tauri::command]
pub fn get_config(index: State<ProjectIndex>) -> Result<ResolvedConfig, String> {
    let text = ensure_config()?;
    let raw: RawConfig = toml::from_str(&text).map_err(|e| e.to_string())?;
    Ok(resolve(raw, &index))
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

// --- first-run onboarding + create group/folder ---

/// Native macOS folder picker (dependency-free, via osascript). Returns the
/// chosen folder, or None when the user cancels (so the UI can stay put).
#[tauri::command]
pub fn pick_folder() -> Result<Option<String>, String> {
    let out = Command::new("osascript")
        .args([
            "-e",
            "POSIX path of (choose folder with prompt \"Choose a base folder for your projects\")",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None); // cancelled
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    Ok(Some(path.trim_end_matches('/').to_string()))
}

/// Add `path` to `[discovery].roots` in the given toml text, preserving other
/// keys (including legacy `[[project]]`). Idempotent: no duplicate root.
fn insert_root(text: &str, path: &str) -> Result<String, String> {
    let mut doc: toml::Table = toml::from_str(text).map_err(|e| e.to_string())?;
    let discovery = doc
        .entry("discovery")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    let dt = discovery
        .as_table_mut()
        .ok_or("`discovery` is not a table")?;
    let roots = dt
        .entry("roots")
        .or_insert_with(|| toml::Value::Array(Vec::new()));
    let arr = roots.as_array_mut().ok_or("`roots` is not an array")?;
    if !arr.iter().any(|v| v.as_str() == Some(path)) {
        arr.push(toml::Value::String(path.to_string()));
    }
    toml::to_string_pretty(&doc).map_err(|e| e.to_string())
}

/// Append a base folder to `[discovery].roots`, preserving other config keys.
#[tauri::command]
pub fn add_root(app: AppHandle, path: String) -> Result<(), String> {
    let p = path.trim().trim_end_matches('/').to_string();
    if p.is_empty() {
        return Err("Empty path".into());
    }
    let serialized = insert_root(&ensure_config()?, &p)?;
    std::fs::write(config_path(), serialized).map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Reject names that would escape or hide the target dir.
fn valid_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Name is empty".into());
    }
    if n.contains('/') || n.contains('\\') {
        return Err("Name cannot contain a slash".into());
    }
    if n.starts_with('.') {
        return Err("Name cannot start with a dot".into());
    }
    Ok(n.to_string())
}

/// mkdir a new group under a root. Returns the created dir.
#[tauri::command]
pub fn add_group(app: AppHandle, root: String, name: String) -> Result<String, String> {
    let n = valid_name(&name)?;
    let dir = PathBuf::from(expand_tilde(&root)).join(&n);
    if dir.exists() {
        return Err(format!("\"{n}\" already exists"));
    }
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", ()); // explicit re-discovery
    Ok(dir.to_string_lossy().into_owned())
}

/// mkdir a new project folder under a group. Returns the created dir.
#[tauri::command]
pub fn add_folder(app: AppHandle, group_path: String, name: String) -> Result<String, String> {
    let n = valid_name(&name)?;
    let dir = PathBuf::from(&group_path).join(&n);
    if dir.exists() {
        return Err(format!("\"{n}\" already exists"));
    }
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", ()); // explicit re-discovery
    Ok(dir.to_string_lossy().into_owned())
}

/// Explicitly ask the UI to re-discover (emits the same event the watchers do).
#[tauri::command]
pub fn rediscover(app: AppHandle) -> Result<(), String> {
    app.emit("config://changed", ()).map_err(|e| e.to_string())
}

#[derive(Default)]
pub struct RootWatch(pub Mutex<Option<RecommendedWatcher>>);

/// Shallow watch of the configured roots (and their immediate group dirs) so
/// folders created outside the app surface without a restart. The config-file
/// watcher only sees the toml itself, never filesystem creates under the roots.
/// Deliberately non-recursive (one extra level) to avoid watching deep trees.
#[tauri::command]
pub fn roots_watch_start(
    app: AppHandle,
    state: State<RootWatch>,
    roots: Vec<String>,
) -> Result<(), String> {
    let app_handle = app.clone();
    let last = Arc::new(Mutex::new(Instant::now()));
    let debounce = last.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_err() {
            return;
        }
        // Coalesce bursts (a create often fires several events).
        if let Ok(mut l) = debounce.lock() {
            if l.elapsed().as_millis() < 600 {
                return;
            }
            *l = Instant::now();
        }
        let _ = app_handle.emit("config://changed", ());
    })
    .map_err(|e| e.to_string())?;

    for root in &roots {
        let rp = PathBuf::from(expand_tilde(root));
        if !rp.is_dir() {
            continue;
        }
        let _ = watcher.watch(&rp, RecursiveMode::NonRecursive); // new groups
        if let Ok(entries) = std::fs::read_dir(&rp) {
            for e in entries.flatten() {
                let gp = e.path();
                if gp.is_dir() && !basename(&gp).starts_with('.') {
                    let _ = watcher.watch(&gp, RecursiveMode::NonRecursive); // new projects
                }
            }
        }
    }

    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn unique_tmp() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("sway_cfg_test_{n}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t.test")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t.test")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A plain repo on `branch` with one commit.
    fn init_repo(dir: &Path, branch: &str) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]);
        git(dir, &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")]);
        std::fs::write(dir.join("README.md"), "hi").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", "init"]);
    }

    fn raw(roots: &[&str], ignore: &[&str], paths: &[&str], legacy: &[(&str, &str)]) -> RawConfig {
        RawConfig {
            discovery: RawDiscovery {
                roots: roots.iter().map(|s| s.to_string()).collect(),
                ignore: ignore.iter().map(|s| s.to_string()).collect(),
                paths: paths.iter().map(|s| s.to_string()).collect(),
            },
            project: legacy
                .iter()
                .map(|(g, p)| RawProject {
                    group: g.to_string(),
                    path: p.to_string(),
                })
                .collect(),
        }
    }

    fn group<'a>(cfg: &'a ResolvedConfig, name: &str) -> Option<&'a Group> {
        cfg.groups.iter().find(|g| g.name == name)
    }

    fn project<'a>(cfg: &'a ResolvedConfig, grp: &str, proj: &str) -> &'a Project {
        group(cfg, grp)
            .unwrap_or_else(|| panic!("group {grp} missing"))
            .projects
            .iter()
            .find(|p| p.name == proj)
            .unwrap_or_else(|| panic!("project {grp}/{proj} missing"))
    }

    #[test]
    fn discovery_kinds_and_dedup() {
        let tmp = unique_tmp();
        let root = tmp.join("Projects");
        let personal = root.join("personal");

        // plain repo: main + feature, feature checked out.
        let plain = personal.join("plainrepo");
        init_repo(&plain, "main");
        git(&plain, &["branch", "feature"]);
        git(&plain, &["checkout", "-q", "feature"]);

        // non-git folder.
        std::fs::create_dir_all(personal.join("plaindir")).unwrap();

        // hidden dir holding a would-be project: must be skipped.
        std::fs::create_dir_all(personal.join(".hidden/secret")).unwrap();

        // ignored group.
        std::fs::create_dir_all(root.join("node_modules/junk")).unwrap();

        // a source repo to seed bare clones from.
        let src = tmp.join("src");
        init_repo(&src, "main");

        // worktree project: a .bare container with one worktree.
        let wt = personal.join("wtproj");
        std::fs::create_dir_all(&wt).unwrap();
        git(
            &tmp,
            &[
                "clone",
                "-q",
                "--bare",
                src.to_str().unwrap(),
                wt.join(".bare").to_str().unwrap(),
            ],
        );
        std::fs::write(wt.join(".git"), "gitdir: ./.bare\n").unwrap();
        git(
            &wt,
            &["worktree", "add", "-q", wt.join("main").to_str().unwrap(), "main"],
        );

        // incomplete: a .bare with no worktrees.
        let stub = personal.join("stub");
        std::fs::create_dir_all(&stub).unwrap();
        git(
            &tmp,
            &[
                "clone",
                "-q",
                "--bare",
                src.to_str().unwrap(),
                stub.join(".bare").to_str().unwrap(),
            ],
        );
        std::fs::write(stub.join(".git"), "gitdir: ./.bare\n").unwrap();

        // out-of-root explicit project.
        let extra_repo = tmp.join("Outside/extra/extrarepo");
        init_repo(&extra_repo, "main");

        let index = ProjectIndex::default();
        let cfg = resolve(
            raw(
                &[root.to_str().unwrap()],
                &["node_modules"],
                // extrarepo (out of root) + plainrepo again (duplicate of a discovered one)
                &[extra_repo.to_str().unwrap(), plain.to_str().unwrap()],
                &[],
            ),
            &index,
        );

        // Groups: personal + extra; node_modules ignored.
        assert!(group(&cfg, "personal").is_some());
        assert!(group(&cfg, "extra").is_some());
        assert!(group(&cfg, "node_modules").is_none());

        // personal projects: no dotdir, the four real folders only.
        let mut names: Vec<&str> = group(&cfg, "personal")
            .unwrap()
            .projects
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        names.sort();
        assert_eq!(names, vec!["plaindir", "plainrepo", "stub", "wtproj"]);

        // Dedup: plainrepo (discovered + explicit) appears exactly once.
        let plain_count = cfg
            .groups
            .iter()
            .flat_map(|g| &g.projects)
            .filter(|p| p.name == "plainrepo")
            .count();
        assert_eq!(plain_count, 1);

        // out-of-root explicit path appears once, under its parent-named group.
        assert_eq!(group(&cfg, "extra").unwrap().projects.len(), 1);

        // plain kind: a unit per branch, feature current.
        let pr = project(&cfg, "personal", "plainrepo");
        assert!(pr.branch_units.iter().all(|u| u.kind == ProjectKind::Plain));
        let feat = pr
            .branch_units
            .iter()
            .find(|u| u.branch.as_deref() == Some("feature"))
            .unwrap();
        assert!(feat.is_current);
        let main = pr
            .branch_units
            .iter()
            .find(|u| u.branch.as_deref() == Some("main"))
            .unwrap();
        assert!(!main.is_current);

        // plain-dir kind: a single unit.
        let pd = project(&cfg, "personal", "plaindir");
        assert_eq!(pd.branch_units.len(), 1);
        assert_eq!(pd.branch_units[0].kind, ProjectKind::PlainDir);

        // worktree kind: units point at worktree folders, never the .bare node.
        let wtp = project(&cfg, "personal", "wtproj");
        assert!(!wtp.branch_units.is_empty());
        assert!(wtp.branch_units.iter().all(|u| u.kind == ProjectKind::Worktree));
        assert!(wtp.branch_units.iter().all(|u| !u.folder_path.ends_with(".bare")));
        assert!(wtp.branch_units.iter().any(|u| u.folder_path.ends_with("main")));

        // incomplete kind: a single cleanable stub.
        let st = project(&cfg, "personal", "stub");
        assert_eq!(st.branch_units.len(), 1);
        assert_eq!(st.branch_units[0].kind, ProjectKind::Incomplete);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn legacy_migration_yields_exactly_those_projects() {
        let tmp = unique_tmp();
        // Two repos exist, but only one is declared in legacy config.
        let declared = tmp.join("work/declared");
        let other = tmp.join("work/other");
        init_repo(&declared, "main");
        init_repo(&other, "main");

        // No discovery section at all; just a legacy [[project]].
        let index = ProjectIndex::default();
        let cfg = resolve(
            raw(&[], &[], &[], &[("teamx", declared.to_str().unwrap())]),
            &index,
        );

        // Exactly the declared project, under its declared group, nothing else.
        assert_eq!(cfg.groups.len(), 1);
        assert_eq!(cfg.groups[0].name, "teamx");
        assert_eq!(cfg.groups[0].projects.len(), 1);
        assert_eq!(cfg.groups[0].projects[0].name, "declared");
        // The default ~/Projects root must NOT kick in when legacy paths exist.
        assert!(group(&cfg, "other").is_none());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn checkout_invalidates_cached_probe() {
        let tmp = unique_tmp();
        let root = tmp.join("Projects");
        let repo = root.join("personal/repo");
        init_repo(&repo, "main");
        git(&repo, &["branch", "feature"]);
        git(&repo, &["checkout", "-q", "feature"]);

        let index = ProjectIndex::default();
        let roots = [root.to_str().unwrap()];

        let cfg1 = resolve(raw(&roots, &[], &[], &[]), &index);
        let cur1 = project(&cfg1, "personal", "repo")
            .branch_units
            .iter()
            .find(|u| u.is_current)
            .and_then(|u| u.branch.clone());
        assert_eq!(cur1.as_deref(), Some("feature"));

        // Switch the checkout; HEAD's mtime changes, so the cache must refresh.
        git(&repo, &["checkout", "-q", "main"]);
        let cfg2 = resolve(raw(&roots, &[], &[], &[]), &index);
        let cur2 = project(&cfg2, "personal", "repo")
            .branch_units
            .iter()
            .find(|u| u.is_current)
            .and_then(|u| u.branch.clone());
        assert_eq!(cur2.as_deref(), Some("main"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn empty_group_dir_is_surfaced() {
        let tmp = unique_tmp();
        let root = tmp.join("Projects");
        // A group folder with no project subdirs (just created from the UI).
        std::fs::create_dir_all(root.join("newgroup")).unwrap();
        let index = ProjectIndex::default();
        let cfg = resolve(raw(&[root.to_str().unwrap()], &[], &[], &[]), &index);
        let g = group(&cfg, "newgroup").expect("empty group should appear");
        assert!(g.projects.is_empty());
        assert!(g.path.ends_with("newgroup")); // path lets the UI add a folder under it
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn valid_name_rejects_traversal_and_hidden() {
        assert!(valid_name("feature").is_ok());
        assert!(valid_name("  spaced  ").is_ok()); // trimmed
        assert!(valid_name("").is_err());
        assert!(valid_name("a/b").is_err());
        assert!(valid_name("a\\b").is_err());
        assert!(valid_name("..").is_err()); // leading dot
        assert!(valid_name(".hidden").is_err());
    }

    #[test]
    fn insert_root_adds_once_and_preserves_legacy() {
        // Empty config: creates [discovery].roots with the path.
        let out = insert_root("", "/Users/x/Projects").unwrap();
        assert!(out.contains("/Users/x/Projects"));
        // Idempotent: re-inserting the same root does not duplicate it.
        let again = insert_root(&out, "/Users/x/Projects").unwrap();
        assert_eq!(again.matches("/Users/x/Projects").count(), 1);
        // A legacy [[project]] table survives the rewrite.
        let legacy = "[[project]]\nname = \"a\"\ngroup = \"g\"\npath = \"/p/a\"\n";
        let merged = insert_root(legacy, "/r").unwrap();
        assert!(merged.contains("[[project]]"));
        assert!(merged.contains("/p/a"));
        assert!(merged.contains("/r"));
    }
}
