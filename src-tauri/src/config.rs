// Tori config. Projects are DISCOVERED from the filesystem, not declared:
// the user lists base "roots" (default `~/Projects`); each `<root>/<space>/<project>`
// folder becomes a project, one space per first-level dir. Extra out-of-root
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
    // Per-space metadata overlay (`[[space]]` tables), merged onto discovered
    // spaces by name. Currently just an icon; the filesystem stays the source of
    // truth for which spaces exist.
    #[serde(default)]
    space: Vec<SpaceMeta>,
    // Per-project metadata overlay (`[[project_meta]]` tables), merged onto
    // discovered projects by path. A separate table from the legacy `[[project]]`
    // above, whose `space` key is required: an icon-only entry written there
    // would fail to parse and take the whole config down with it.
    #[serde(default)]
    project_meta: Vec<ProjectMeta>,
    // User-chosen order of root spaces, by name. Listed names sort first in this
    // order; unlisted (e.g. freshly created) spaces keep discovery order after.
    // Pinned ("Other") spaces are never reordered by this.
    #[serde(default)]
    space_order: Vec<String>,
}

// One `[[space]]` overlay entry: metadata keyed by the space's name (its folder
// name). An absent field (or an absent entry) means "not chosen", which for the
// colour is not the same as "no colour": the UI derives one from the name.
#[derive(Deserialize)]
struct SpaceMeta {
    name: String,
    #[serde(default)]
    icon: Option<String>,
    /// A swatch name from the space colour set; tints the window's background
    /// wash. See `src/utils/spaceTint.ts`.
    #[serde(default)]
    color: Option<String>,
}

// One `[[project_meta]]` overlay entry: the icon a user chose for the project at
// `path`. At most one of the two is ever set (choosing either clears the other),
// but both are optional so a hand-edited config with neither is simply ignored
// rather than an error.
#[derive(Deserialize)]
struct ProjectMeta {
    path: String,
    /// A Lucide name from the picker set.
    #[serde(default)]
    icon: Option<String>,
    /// An image on disk, normally a copy in `~/.config/tori/icons`.
    #[serde(default)]
    icon_file: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawDiscovery {
    /// Base folders scanned as `<root>/<space>/<project>`.
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
    // Accept the historical `group = ...` key so configs written before the
    // group→space rename still parse.
    #[serde(alias = "group")]
    space: String,
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
    // True when reached via `[discovery].paths` (a pinned external), not the root.
    pub external: bool,
    // The three icon sources, in the order the sidebar prefers them. The first
    // two come from the `[[project_meta]]` overlay (what the user chose), the
    // third from the project itself; all three absent means the row falls back
    // to a glyph the frontend derives from the path.
    /// A Lucide name (PascalCase) the user picked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// An image the user uploaded, as an absolute path. Only reported when the
    /// file still exists, so a deleted icon degrades to the favicon or the
    /// derived glyph instead of a broken image.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_file: Option<String>,
    /// The favicon found inside the project, as an absolute path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct Space {
    pub name: String,
    // The space's directory, so the UI can mkdir a new project folder under it.
    pub path: String,
    pub projects: Vec<Project>,
    // True for a space assembled from external pins (rendered under "Other"),
    // false for one discovered under the root. Root and external spaces of the
    // same name stay distinct, so "Other" never absorbs a root space.
    pub external: bool,
    // A Lucide icon name (PascalCase) from the `[[space]]` overlay, keyed by name.
    // None means the tile falls back to the name's initial letter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    // A swatch name from the same overlay, tinting the window's wash. None means
    // the frontend derives a hue from the space's name instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ResolvedConfig {
    pub path: String,
    // The configured base folders (expanded). Empty + no spaces => first run.
    pub roots: Vec<String>,
    pub spaces: Vec<Space>,
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

#[derive(Default, Clone)]
pub struct ProjectIndex(std::sync::Arc<Mutex<HashMap<PathBuf, ProbeEntry>>>);

impl ProjectIndex {
    /// Drop the cached probe for `path`, forcing a fresh probe on next discovery.
    /// Attach/detach/delete/new-branch call this after writing the store, so a
    /// re-probe can never re-cache the pre-write branch set.
    pub(crate) fn evict(&self, path: &Path) {
        if let Ok(mut cache) = self.0.lock() {
            cache.remove(path);
        }
    }
}

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/tori/tori.toml")
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
// first run and offers a folder picker (see set_root). Projects are discovered
// from the roots the user adds; legacy `[[project]]` tables are still honored.
const SAMPLE: &str = r#"# Tori config. Projects are discovered from your base folders.
# Add a base folder from the app, or declare roots here:
#
# [discovery]
# roots  = ["~/Projects"]   # base folders scanned as <root>/<space>/<project>
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

// --- attached-branch state (the visible branches of a plain repo) ---
//
// A plain repo would otherwise surface EVERY local branch as a unit. Instead the
// user attaches the branches they care about; the visible set is the attached
// branches PLUS whatever is currently checked out. Stored SEPARATELY from the
// watched tori.toml (writing the toml loops the config watcher), mirroring
// adopted.json (sessions.rs). Keyed by normalized repo path.

fn norm(path: &str) -> String {
    path.trim_end_matches('/').to_string()
}

#[derive(Serialize, Deserialize, Default)]
struct AttachedRepo {
    /// Branch names the user has attached (made visible).
    branches: HashSet<String>,
    /// Seeded once per repo (origin default, else current). Survives detach-to-empty
    /// so a hand-emptied set is never silently re-seeded.
    seeded: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct AttachedState(HashMap<String, AttachedRepo>);

fn attached_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/tori/attached.json")
}

fn load_attached() -> AttachedState {
    std::fs::read_to_string(attached_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_attached(state: &AttachedState) -> Result<(), String> {
    let path = attached_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// The branches attached for `repo` (empty when the repo has no store entry).
fn attached_branches(state: &AttachedState, repo: &Path) -> HashSet<String> {
    state
        .0
        .get(&norm(&repo.to_string_lossy()))
        .map(|r| r.branches.clone())
        .unwrap_or_default()
}

/// The repo's local branch names (empty on a non-repo or an unborn HEAD).
fn local_branches(path: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    if let Some(text) = run_git(path, &["branch", "--format=%(refname:short)"]) {
        for line in text.lines() {
            let n = line.trim();
            if !n.is_empty() {
                out.insert(n.to_string());
            }
        }
    }
    out
}

/// The currently checked-out branch, or None when detached or unborn.
fn current_branch(path: &Path) -> Option<String> {
    run_git(path, &["symbolic-ref", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Refuse an op targeting the current checkout (detach/delete would orphan it).
fn refuse_if_current(path: &Path, branch: &str) -> Result<(), String> {
    if current_branch(path).as_deref() == Some(branch) {
        return Err(format!(
            "\"{branch}\" is the current checkout; switch away first."
        ));
    }
    Ok(())
}

/// Branch-units for a plain repo: the local branches that are attached or
/// currently checked out, all sharing the repo dir (`list_branches ∩ (attached ∪ {current})`).
fn plain_branch_units(path: &Path, attached: &HashSet<String>) -> Vec<BranchUnit> {
    let mut units = Vec::new();
    if let Some(text) = run_git(path, &["branch", "--format=%(refname:short)\t%(HEAD)"]) {
        for line in text.lines() {
            let mut parts = line.splitn(2, '\t');
            let name = parts.next().unwrap_or("").trim().to_string();
            let current = parts.next().map(|h| h.trim() == "*").unwrap_or(false);
            if name.is_empty() {
                continue;
            }
            // Only the current checkout and attached branches are visible.
            if !current && !attached.contains(&name) {
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
    // A repo with no branch refs yet. An unborn HEAD (freshly `git init`ed, no
    // commit) still names its branch via symbolic-ref, so show that by name and as
    // the current checkout, rather than a nameless folder unit. Only a truly
    // headless repo falls back to the folder unit.
    if units.is_empty() {
        match current_branch(path) {
            Some(b) => units.push(BranchUnit {
                label: b.clone(),
                folder_path: path.to_string_lossy().into_owned(),
                branch: Some(b),
                kind: ProjectKind::Plain,
                is_current: true,
            }),
            None => units.push(BranchUnit {
                label: basename(path),
                folder_path: path.to_string_lossy().into_owned(),
                branch: None,
                kind: ProjectKind::Plain,
                is_current: false,
            }),
        }
    }
    units
}

/// A plain repo's secondary worktrees as units, sorted by label. `git worktree
/// list` always names the main worktree first, so everything after it is one a
/// `git worktree add` made, Tori's own `.tori/worktrees/` included.
///
/// Only the ones **inside** the main worktree, which is where `feature_container`
/// puts a plain repo's Feature worktrees. A linked worktree elsewhere is a
/// project in its own right, and listing it here would put a folder outside this
/// project under it, twice over once the sibling is probed too. The containment
/// test runs against git's own path for the main worktree rather than the probed
/// one, so a symlinked root cannot make it silently match nothing.
///
/// A branch already carrying a unit is skipped: a branch attached to the repo
/// dir and checked out elsewhere would otherwise appear twice, and the folder
/// the worktree names is the one that actually holds it.
fn secondary_worktree_units(real: &[WtEntry], plain: &[BranchUnit]) -> Vec<BranchUnit> {
    let Some(main) = real.first() else {
        return Vec::new();
    };
    let inside = format!("{}/", main.path.trim_end_matches('/'));
    let taken: HashSet<&str> = plain.iter().filter_map(|u| u.branch.as_deref()).collect();
    let mut units: Vec<BranchUnit> = real
        .iter()
        .skip(1)
        .filter(|w| w.path.starts_with(&inside))
        .filter(|w| w.branch.as_deref().map(|b| !taken.contains(b)).unwrap_or(true))
        .map(|w| BranchUnit {
            label: w
                .branch
                .clone()
                .unwrap_or_else(|| basename(Path::new(&w.path))),
            folder_path: w.path.clone(),
            branch: w.branch.clone(),
            kind: ProjectKind::Worktree,
            is_current: false,
        })
        .collect();
    units.sort_by(|a, b| a.label.cmp(&b.label));
    units
}

/// Classify a project folder and enumerate its branch-units.
fn probe_project(path: &Path) -> Vec<BranchUnit> {
    // Counts only the single-flight test's own paths: tests run in parallel,
    // and every other test's probes would otherwise race the assertion.
    #[cfg(test)]
    if path.to_string_lossy().contains("probe_flight") {
        PROBE_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
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
        // A normal repo: branch-units are its attached + current branches, plus
        // one unit per secondary worktree. Without that second half a Feature
        // worktree in a plain repo is invisible in Tori: `plain_branch_units`
        // enumerates `git branch` and keeps only the current checkout and the
        // attached names, and the walkers skip `.tori/worktrees`.
        let attached = attached_branches(&load_attached(), path);
        let mut units = plain_branch_units(path, &attached);
        units.extend(secondary_worktree_units(&real, &units));
        return units;
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
///
/// The cache lock is never held across `probe_project` (a subprocess), and a
/// per-path flight lock coalesces concurrent misses: the first caller probes,
/// the rest wait on the flight lock and then hit the entry it wrote. Two
/// `get_config` calls racing through a switch cost one probe, not two.
fn cached_probe(index: &ProjectIndex, path: &Path) -> Vec<BranchUnit> {
    let dir_mtime = mtime_of(path);
    let head_mtime = head_mtime(path);
    let hit = |cache: &HashMap<PathBuf, ProbeEntry>| {
        cache
            .get(path)
            .filter(|e| e.dir_mtime == dir_mtime && e.head_mtime == head_mtime)
            .map(|e| e.units.clone())
    };
    if let Some(units) = index.0.lock().ok().as_deref().and_then(hit) {
        return units;
    }
    let flight = probe_flight(path);
    let _probing = flight.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // Whoever held the flight lock before us has already written the entry.
    if let Some(units) = index.0.lock().ok().as_deref().and_then(hit) {
        return units;
    }
    let units = probe_project(path);
    if let Ok(mut cache) = index.0.lock() {
        cache.insert(
            path.to_path_buf(),
            ProbeEntry {
                dir_mtime,
                head_mtime,
                units: units.clone(),
            },
        );
    }
    units
}

#[cfg(test)]
static PROBE_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// One lock per path being probed. Entries are never removed; the map is
/// bounded by the number of projects the config has ever named.
fn probe_flight(path: &Path) -> std::sync::Arc<Mutex<()>> {
    static FLIGHTS: std::sync::OnceLock<Mutex<HashMap<PathBuf, std::sync::Arc<Mutex<()>>>>> =
        std::sync::OnceLock::new();
    let flights = FLIGHTS.get_or_init(Default::default);
    let mut map = flights.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    map.entry(path.to_path_buf()).or_default().clone()
}

// --- discovery ---

/// `(space, path)` for an explicit out-of-root path; space = parent dir name.
fn extra_space_and_path(raw_path: &str) -> (String, PathBuf) {
    let p = PathBuf::from(expand_tilde(raw_path));
    let space = p
        .parent()
        .and_then(|x| x.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    (space, p)
}

/// Index of the space named `name` in `spaces`, creating an (initially empty)
/// entry anchored at `path` when absent. Empty space dirs are surfaced too, so a
/// freshly created space is selectable before it holds any project.
fn ensure_space_idx(spaces: &mut Vec<Space>, name: &str, path: &Path, external: bool) -> usize {
    // Match on name AND origin so a root space and an external pin sharing a name
    // remain two distinct spaces (root in the main tree, the pin under "Other").
    if let Some(i) = spaces.iter().position(|g| g.name == name && g.external == external) {
        return i;
    }
    spaces.push(Space {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        projects: Vec::new(),
        external,
        icon: None,
        color: None,
    });
    spaces.len() - 1
}

/// The icon for a project: its own if it has one, else the best its worktrees
/// can offer. `icons::cached_project_icon` does the ranking and the memoizing;
/// all this has to know is which directories are in scope.
fn project_favicon(ppath: &Path, units: &[BranchUnit]) -> Option<String> {
    let folders: Vec<PathBuf> = units.iter().map(|u| PathBuf::from(&u.folder_path)).collect();
    crate::icons::cached_project_icon(ppath, &folders)
}

fn resolve(raw: RawConfig, index: &ProjectIndex) -> ResolvedConfig {
    let skip = |name: &str| name.starts_with('.') || raw.discovery.ignore.iter().any(|i| i == name);
    // Single canonical root: a legacy multi-root config collapses to the first on
    // load (not only on explicit reset), so discovery yields one tree, never two.
    let roots: Vec<String> = raw.discovery.roots.iter().take(1).map(|r| expand_tilde(r)).collect();

    let mut spaces: Vec<Space> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new(); // project dedup (canonical)
    let mut seen_paths: HashSet<PathBuf> = HashSet::new(); // cache eviction (raw)

    let mut add_project = |spaces: &mut Vec<Space>, gi: usize, ppath: PathBuf, external: bool| {
        let canon = ppath.canonicalize().unwrap_or_else(|_| ppath.clone());
        if !seen.insert(canon) {
            return; // reachable via several roots/paths: keep the first
        }
        seen_paths.insert(ppath.clone());
        let branch_units = cached_probe(index, &ppath);
        let project = Project {
            name: basename(&ppath),
            path: ppath.to_string_lossy().into_owned(),
            favicon: project_favicon(&ppath, &branch_units),
            branch_units,
            external,
            icon: None,
            icon_file: None,
        };
        spaces[gi].projects.push(project);
    };

    // 1. Roots scanned as <root>/<space>/<project>; empty space dirs registered.
    for root in &roots {
        let root = PathBuf::from(root);
        let Ok(space_dirs) = std::fs::read_dir(&root) else {
            continue;
        };
        for g in space_dirs.flatten() {
            let gpath = g.path();
            if !gpath.is_dir() || skip(&basename(&gpath)) {
                continue;
            }
            let gi = ensure_space_idx(&mut spaces, &basename(&gpath), &gpath, false);
            if let Ok(projects) = std::fs::read_dir(&gpath) {
                for p in projects.flatten() {
                    let ppath = p.path();
                    if ppath.is_dir() && !skip(&basename(&ppath)) {
                        add_project(&mut spaces, gi, ppath, false);
                    }
                }
            }
        }
    }

    // 2. Explicit extra paths: discovery.paths (space from parent dir) + legacy
    // [[project]] entries (keeping their declared space).
    let mut extra: Vec<(String, PathBuf)> = Vec::new();
    for p in &raw.discovery.paths {
        extra.push(extra_space_and_path(p));
    }
    for p in &raw.project {
        extra.push((p.space.clone(), PathBuf::from(expand_tilde(&p.path))));
    }
    for (gname, ppath) in extra {
        let space_path = ppath.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| ppath.clone());
        let gi = ensure_space_idx(&mut spaces, &gname, &space_path, true);
        add_project(&mut spaces, gi, ppath, true);
    }

    // Overlay per-space metadata (icon, colour) from `[[space]]` tables, keyed by
    // name. Keys by name only, so a root space and an external pin sharing a name
    // both receive it (they share the one entry). Blank values are ignored, which
    // is how "not chosen" reaches the frontend as None.
    for meta in &raw.space {
        let icon = meta.icon.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let color = meta.color.as_deref().map(str::trim).filter(|s| !s.is_empty());
        for g in spaces.iter_mut().filter(|g| g.name == meta.name) {
            if let Some(icon) = icon {
                g.icon = Some(icon.to_string());
            }
            if let Some(color) = color {
                g.color = Some(color.to_string());
            }
        }
    }

    // Overlay per-project metadata (icon) from `[[project_meta]]` tables, keyed
    // by path. Canonicalized on both sides once (a pin written through a symlink
    // must still match the discovered project), then matched through one map so
    // a config with many entries stays linear rather than metas × projects.
    if !raw.project_meta.is_empty() {
        let mut by_path: HashMap<PathBuf, (usize, usize)> = HashMap::new();
        for (gi, g) in spaces.iter().enumerate() {
            for (pi, p) in g.projects.iter().enumerate() {
                let pp = PathBuf::from(&p.path);
                by_path.insert(pp.canonicalize().unwrap_or(pp), (gi, pi));
            }
        }
        for meta in &raw.project_meta {
            let want = PathBuf::from(expand_tilde(&meta.path));
            let want = want.canonicalize().unwrap_or(want);
            let Some(&(gi, pi)) = by_path.get(&want) else {
                continue; // an entry for a project that is no longer discovered
            };
            let p = &mut spaces[gi].projects[pi];
            p.icon = meta.icon.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
            // Only report a file that is still there: an icon deleted out from
            // under the config degrades to the favicon (or the derived glyph),
            // never to a broken image in the tree.
            p.icon_file = meta
                .icon_file
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(expand_tilde)
                .filter(|f| Path::new(f).is_file());
        }
    }

    // Apply the user's root-space order (stable): externals sort after all roots
    // and keep their relative order; a listed root sorts by its index in
    // `space_order`; an unlisted root keeps discovery order (all share the max
    // key, and the sort is stable). Only reorders roots, never pinned spaces.
    spaces.sort_by_key(|g| {
        if g.external {
            return (1usize, usize::MAX);
        }
        let idx = raw.space_order.iter().position(|n| n == &g.name).unwrap_or(usize::MAX);
        (0usize, idx)
    });

    // Evict cache entries for projects that no longer exist.
    if let Ok(mut cache) = index.0.lock() {
        cache.retain(|k, _| seen_paths.contains(k));
    }

    ResolvedConfig {
        path: config_path().to_string_lossy().into_owned(),
        roots,
        spaces,
    }
}

#[tauri::command]
pub async fn get_config(index: State<'_, ProjectIndex>) -> Result<ResolvedConfig, String> {
    let index = index.inner().clone();
    crate::exec::blocking("get_config", move || get_config_body(&index)).await
}

fn get_config_body(index: &ProjectIndex) -> Result<ResolvedConfig, String> {
    let text = ensure_config()?;
    let raw: RawConfig = toml::from_str(&text).map_err(|e| e.to_string())?;
    Ok(resolve(raw, index))
}

#[tauri::command]
pub async fn list_branches(path: String) -> Result<Vec<Branch>, String> {
    crate::exec::blocking("list_branches", move || list_branches_body(path)).await
}

pub(crate) fn list_branches_body(path: String) -> Result<Vec<Branch>, String> {
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

/// Remote branches under `origin`, as short names **without** the `origin/`
/// prefix (e.g. `main`, `feature/x`). Excludes the `origin/HEAD` symref. Feeds
/// the Attach Existing Branch picker's live remote-branch fold after a fetch.
#[tauri::command(async)]
pub fn list_remote_branches(repo: String) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // Not a repo, or no remotes fetched yet: nothing to attach, not an error.
        return Ok(vec![]);
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut names = Vec::new();
    for line in text.lines() {
        let short = line.trim();
        // `%(refname:short)` yields `origin/<name>` (and `origin/HEAD` for the symref).
        let Some(name) = short.strip_prefix("origin/") else {
            continue;
        };
        if name.is_empty() || name == "HEAD" {
            continue;
        }
        names.push(name.to_string());
    }
    Ok(names)
}

/// Pure seed step: attach `seed` (only when it is a local branch) exactly once per
/// repo, and never against an empty repo (the flag stays unset so a later probe
/// still seeds). Returns whether the state changed (so the caller persists). Pure,
/// so it is unit-tested directly. Mirrors `do_seed` (sessions.rs).
fn do_seed_attached(
    state: &mut AttachedState,
    key: &str,
    locals: &HashSet<String>,
    seed: Option<&str>,
) -> bool {
    if state.0.get(key).map(|r| r.seeded).unwrap_or(false) || locals.is_empty() {
        return false;
    }
    let entry = state.0.entry(key.to_string()).or_default();
    if let Some(b) = seed {
        if locals.contains(b) {
            entry.branches.insert(b.to_string());
        }
    }
    entry.seeded = true;
    true
}

/// Seed `repo`'s attached set once: attach origin's default branch (else the
/// current checkout), so a freshly discovered repo shows a sensible branch instead
/// of only its checkout. No-op once seeded, or while the repo has no branches yet.
/// Called from `loadConfig`.
#[tauri::command(async)]
pub fn seed_attached(repo: String) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = PathBuf::from(&repo);
    let locals = local_branches(&path);
    let seed = default_branch(&path).or_else(|| current_branch(&path));
    let mut state = load_attached();
    if do_seed_attached(&mut state, &norm(&repo), &locals, seed.as_deref()) {
        save_attached(&state)?;
    }
    Ok(())
}

/// Attach an existing local `branch` to `repo`'s visible set.
/// Order: write store → evict cache → emit `config://changed`.
#[tauri::command(async)]
pub fn attach_branch(
    app: AppHandle,
    index: State<ProjectIndex>,
    repo: String,
    branch: String,
) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // This one also writes to the repository, so it queues with every
    // other git write on the same common dir.
    let repo_lock = crate::exec::repo_lock(&repo);
    let _repo = repo_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = PathBuf::from(&repo);
    if !local_branches(&path).contains(&branch) {
        return Err(format!("No local branch \"{branch}\"."));
    }
    let mut state = load_attached();
    state.0.entry(norm(&repo)).or_default().branches.insert(branch);
    save_attached(&state)?;
    index.evict(&path);
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Create `branch` at HEAD and attach it (the frontend then switches to it, a
/// same-commit checkout that needs no working-tree confirm). Creation is
/// independent of that switch, so the branch appears even if the switch is skipped.
/// Order: create → write store → evict cache → emit.
#[tauri::command(async)]
pub fn new_branch(
    app: AppHandle,
    index: State<ProjectIndex>,
    repo: String,
    branch: String,
) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // This one also writes to the repository, so it queues with every
    // other git write on the same common dir.
    let repo_lock = crate::exec::repo_lock(&repo);
    let _repo = repo_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = PathBuf::from(&repo);
    let name = branch.trim();
    if name.is_empty() {
        return Err("Branch name is empty".into());
    }
    if local_branches(&path).contains(name) {
        return Err(format!("Branch \"{name}\" already exists."));
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["branch", name])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut state = load_attached();
    state
        .0
        .entry(norm(&repo))
        .or_default()
        .branches
        .insert(name.to_string());
    save_attached(&state)?;
    index.evict(&path);
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Detach `branch` from `repo`'s visible set (the git branch is untouched).
/// Refuses the current checkout (it must stay reachable).
/// Order: write store → evict cache → emit.
#[tauri::command(async)]
pub fn detach_branch(
    app: AppHandle,
    index: State<ProjectIndex>,
    repo: String,
    branch: String,
) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // This one also writes to the repository, so it queues with every
    // other git write on the same common dir.
    let repo_lock = crate::exec::repo_lock(&repo);
    let _repo = repo_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = PathBuf::from(&repo);
    refuse_if_current(&path, &branch)?;
    let mut state = load_attached();
    if let Some(entry) = state.0.get_mut(&norm(&repo)) {
        entry.branches.remove(&branch);
    }
    save_attached(&state)?;
    index.evict(&path);
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Delete `branch` from `repo` (`git branch -D`) and prune the store entry.
/// Refuses the current checkout. Order: delete → write store → evict cache → emit.
#[tauri::command(async)]
pub fn delete_branch(
    app: AppHandle,
    index: State<ProjectIndex>,
    repo: String,
    branch: String,
) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // This one also writes to the repository, so it queues with every
    // other git write on the same common dir.
    let repo_lock = crate::exec::repo_lock(&repo);
    let _repo = repo_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = PathBuf::from(&repo);
    refuse_if_current(&path, &branch)?;
    let out = Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["branch", "-D", &branch])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut state = load_attached();
    if let Some(entry) = state.0.get_mut(&norm(&repo)) {
        entry.branches.remove(&branch);
    }
    save_attached(&state)?;
    index.evict(&path);
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Ensure a local branch `name` exists, creating it as a tracking branch off the
/// already-fetched `origin/<name>` when absent. An existing local branch is left
/// as-is (surfaced, never clobbered); a name with no local branch and no fetched
/// remote ref is rejected. Pure (no store/emit), so it is unit-tested directly.
fn ensure_local_tracking(path: &Path, name: &str) -> Result<(), String> {
    if local_branches(path).contains(name) {
        return Ok(()); // already local: attach it, never clobber
    }
    let remote_ref = format!("refs/remotes/origin/{name}");
    let exists = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--verify", "--quiet", &remote_ref])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !exists {
        return Err(format!("No remote branch \"origin/{name}\". Fetch first."));
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["branch", "--track", name, &format!("origin/{name}")])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Attach a remote branch: create a local tracking branch from the already-fetched
/// `origin/<branch>` (a separate op from the auth'd fetch, which runs in a tab),
/// then attach it. Order: create/verify → write store → evict cache → emit.
#[tauri::command(async)]
pub fn attach_remote_branch(
    app: AppHandle,
    index: State<ProjectIndex>,
    repo: String,
    branch: String,
) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // This one also writes to the repository, so it queues with every
    // other git write on the same common dir.
    let repo_lock = crate::exec::repo_lock(&repo);
    let _repo = repo_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = PathBuf::from(&repo);
    let name = branch.trim().trim_start_matches("origin/").to_string();
    if name.is_empty() {
        return Err("Branch name is empty".into());
    }
    ensure_local_tracking(&path, &name)?;
    let mut state = load_attached();
    state.0.entry(norm(&repo)).or_default().branches.insert(name);
    save_attached(&state)?;
    index.evict(&path);
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Install a watcher on the config file's directory. Emits `config://changed`
/// whenever tori.toml is written. Idempotent: re-installing replaces the old one.
#[tauri::command(async)]
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

// --- first-run onboarding + create space/folder ---

/// Native macOS folder picker (dependency-free, via osascript). Returns the
/// chosen folder, or None when the user cancels (so the UI can stay put).
#[tauri::command(async)]
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

/// Replace `[discovery].roots` with exactly `[path]` (the single-root model),
/// preserving other keys (including `paths` and legacy `[[project]]`).
fn replace_root(text: &str, path: &str) -> Result<String, String> {
    let mut doc: toml::Table = toml::from_str(text).map_err(|e| e.to_string())?;
    let discovery = doc
        .entry("discovery")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    let dt = discovery
        .as_table_mut()
        .ok_or("`discovery` is not a table")?;
    dt.insert(
        "roots".into(),
        toml::Value::Array(vec![toml::Value::String(path.to_string())]),
    );
    toml::to_string_pretty(&doc).map_err(|e| e.to_string())
}

/// Clear `[discovery].roots` to an empty array (forget the root), preserving
/// other keys (`paths`, legacy `[[project]]`). A no-op when there is no root.
fn clear_root(text: &str) -> Result<String, String> {
    let mut doc: toml::Table = toml::from_str(text).map_err(|e| e.to_string())?;
    if let Some(dt) = doc.get_mut("discovery").and_then(|d| d.as_table_mut()) {
        dt.insert("roots".into(), toml::Value::Array(Vec::new()));
    }
    toml::to_string_pretty(&doc).map_err(|e| e.to_string())
}

/// Set the single base folder, replacing any existing root(s).
#[tauri::command(async)]
pub fn set_root(app: AppHandle, path: String) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let p = path.trim().trim_end_matches('/').to_string();
    if p.is_empty() {
        return Err("Empty path".into());
    }
    let serialized = replace_root(&ensure_config()?, &p)?;
    std::fs::write(config_path(), serialized).map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Forget the configured root (no on-disk deletion). Returns to the first-run
/// state; `paths` pins and legacy `[[project]]` entries are kept.
#[tauri::command(async)]
pub fn remove_root(app: AppHandle) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let serialized = clear_root(&ensure_config()?)?;
    std::fs::write(config_path(), serialized).map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Append `path` to `[discovery].paths`, preserving other keys. Idempotent.
fn add_path(text: &str, path: &str) -> Result<String, String> {
    let mut doc: toml::Table = toml::from_str(text).map_err(|e| e.to_string())?;
    let discovery = doc
        .entry("discovery")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    let dt = discovery.as_table_mut().ok_or("`discovery` is not a table")?;
    let paths = dt
        .entry("paths")
        .or_insert_with(|| toml::Value::Array(Vec::new()));
    let arr = paths.as_array_mut().ok_or("`paths` is not an array")?;
    if !arr.iter().any(|v| v.as_str() == Some(path)) {
        arr.push(toml::Value::String(path.to_string()));
    }
    toml::to_string_pretty(&doc).map_err(|e| e.to_string())
}

/// Remove `path` from `[discovery].paths`, preserving other keys. No-op if absent.
fn remove_path(text: &str, path: &str) -> Result<String, String> {
    let mut doc: toml::Table = toml::from_str(text).map_err(|e| e.to_string())?;
    if let Some(dt) = doc.get_mut("discovery").and_then(|d| d.as_table_mut()) {
        if let Some(arr) = dt.get_mut("paths").and_then(|p| p.as_array_mut()) {
            arr.retain(|v| v.as_str() != Some(path));
        }
    }
    toml::to_string_pretty(&doc).map_err(|e| e.to_string())
}

/// Is `child` the same as, or nested under, `parent`? Canonical when both exist,
/// else a lexical prefix check on a normalized (trailing-slash-stripped) form.
fn is_inside(child: &str, parent: &str) -> bool {
    let c = std::fs::canonicalize(child).unwrap_or_else(|_| PathBuf::from(child));
    let p = std::fs::canonicalize(parent).unwrap_or_else(|_| PathBuf::from(parent));
    c == p || c.starts_with(&p)
}

/// Pin an out-of-root folder into `[discovery].paths` (the "Other" section).
/// Refuses a path that is the root or nested under it (those belong to the tree),
/// so the pin is always a genuine external, never a duplicate of a root project.
#[tauri::command(async)]
pub fn pin_path(app: AppHandle, path: String) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let p = path.trim().trim_end_matches('/').to_string();
    if p.is_empty() {
        return Err("Empty path".into());
    }
    let text = ensure_config()?;
    let raw: RawConfig = toml::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(root) = raw.discovery.roots.first() {
        if is_inside(&p, &expand_tilde(root)) {
            return Err("That folder is inside your base folder; it already appears in the tree.".into());
        }
    }
    let serialized = add_path(&text, &p)?;
    std::fs::write(config_path(), serialized).map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Unpin an external folder: remove it from `[discovery].paths` (no on-disk
/// deletion). Other pins and the root are untouched.
#[tauri::command(async)]
pub fn unpin_path(app: AppHandle, path: String) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let p = path.trim().trim_end_matches('/').to_string();
    let serialized = remove_path(&ensure_config()?, &p)?;
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

/// Upsert or remove the `[[space]]` overlay entry for `name`, preserving the
/// rest of the file (comments, formatting) via `toml_edit`. Each field is set
/// when given and *removed* when not, so clearing one never leaves a stale
/// value behind; an entry with nothing left in it is pruned, and an emptied
/// array-of-tables is dropped entirely. Pure over the config text so it can be
/// unit-tested without touching the real config.
fn upsert_space_meta(
    text: &str,
    name: &str,
    icon: Option<&str>,
    color: Option<&str>,
) -> Result<String, String> {
    use toml_edit::{value, ArrayOfTables, Document, Item, Table};
    let mut doc: Document = text.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;

    if doc.get("space").is_none() {
        doc["space"] = Item::ArrayOfTables(ArrayOfTables::new());
    }
    let tables = doc["space"]
        .as_array_of_tables_mut()
        .ok_or("`space` is not an array of tables")?;
    let pos = tables
        .iter()
        .position(|t| t.get("name").and_then(|v| v.as_str()) == Some(name));

    if icon.is_none() && color.is_none() {
        if let Some(i) = pos {
            tables.remove(i);
        }
    } else {
        let i = match pos {
            Some(i) => i,
            None => {
                let mut t = Table::new();
                t["name"] = value(name);
                tables.push(t);
                tables.len() - 1
            }
        };
        let t = tables.get_mut(i).unwrap();
        match icon {
            Some(v) => t["icon"] = value(v),
            None => {
                t.remove("icon");
            }
        }
        match color {
            Some(v) => t["color"] = value(v),
            None => {
                t.remove("color");
            }
        }
    }

    // Drop an emptied `[[space]]` so the file has no dangling array key.
    if doc["space"].as_array_of_tables().map(|t| t.is_empty()).unwrap_or(false) {
        doc.remove("space");
    }
    Ok(doc.to_string())
}

/// Upsert or remove the `[[project_meta]]` entry for `path`, preserving the rest
/// of the file via `toml_edit`. The two icon keys are mutually exclusive by
/// construction: whichever the caller does not pass is *removed*, not left
/// behind, so a project can never end up with a stale glyph shadowed by an
/// image (or vice versa). Both `None` prunes the whole entry, which is what
/// "back to automatic" means. Pure over the config text, so it unit-tests
/// without touching the real config.
fn upsert_project_meta(
    text: &str,
    path: &str,
    icon: Option<&str>,
    icon_file: Option<&str>,
) -> Result<String, String> {
    use toml_edit::{value, ArrayOfTables, Document, Item, Table};
    let mut doc: Document = text.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;

    if doc.get("project_meta").is_none() {
        doc["project_meta"] = Item::ArrayOfTables(ArrayOfTables::new());
    }
    let tables = doc["project_meta"]
        .as_array_of_tables_mut()
        .ok_or("`project_meta` is not an array of tables")?;
    let pos = tables
        .iter()
        .position(|t| t.get("path").and_then(|v| v.as_str()) == Some(path));

    if icon.is_none() && icon_file.is_none() {
        if let Some(i) = pos {
            tables.remove(i);
        }
    } else {
        let i = match pos {
            Some(i) => i,
            None => {
                let mut t = Table::new();
                t["path"] = value(path);
                tables.push(t);
                tables.len() - 1
            }
        };
        let t = tables.get_mut(i).unwrap();
        match icon {
            Some(v) => t["icon"] = value(v),
            None => {
                t.remove("icon");
            }
        }
        match icon_file {
            Some(v) => t["icon_file"] = value(v),
            None => {
                t.remove("icon_file");
            }
        }
    }

    // Drop an emptied `[[project_meta]]` so the file has no dangling array key.
    if doc["project_meta"].as_array_of_tables().map(|t| t.is_empty()).unwrap_or(false) {
        doc.remove("project_meta");
    }
    Ok(doc.to_string())
}

/// Read the config, upsert/prune the `[[project_meta]]` entry for `path`, write
/// it back. Both icon values are already trimmed-to-`None` by the caller.
fn write_project_meta(path: &str, icon: Option<&str>, icon_file: Option<&str>) -> Result<(), String> {
    let serialized = upsert_project_meta(&ensure_config()?, path, icon, icon_file)?;
    std::fs::write(config_path(), serialized).map_err(|e| e.to_string())
}

/// The image currently stored for `path`, read back before an overwrite so the
/// superseded copy can be pruned from the icon store. Read failures are silent:
/// a stale file left in `~/.config/tori/icons` is litter, never a broken icon.
fn current_icon_file(path: &str) -> Option<String> {
    let raw: RawConfig = toml::from_str(&ensure_config().ok()?).ok()?;
    raw.project_meta
        .iter()
        .find(|m| expand_tilde(&m.path) == path)
        .and_then(|m| m.icon_file.as_deref())
        .map(expand_tilde)
}

/// Set (or clear) a project's Lucide icon, keyed by its absolute path. An
/// empty/whitespace name normalizes to `None`, which drops the whole overlay
/// entry and returns the row to automatic (favicon, else a derived glyph).
/// Picking a glyph also retires any uploaded image, since the two cannot both
/// be in force. Mirrors `set_space_meta`: write store → emit `config://changed`
/// (the sidebar's listener drives the reload).
#[tauri::command(async)]
pub fn set_project_icon(app: AppHandle, path: String, icon: Option<String>) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let icon = icon.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let previous = current_icon_file(&path);
    write_project_meta(&path, icon, None)?;
    crate::icons::prune_stored(previous.as_deref(), None);
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Copy `source` into the icon store and make it the project's icon, returning
/// the stored path. The copy happens first: a rejected or unreadable pick fails
/// before the config is touched, so a bad upload leaves the previous icon
/// exactly as it was.
#[tauri::command(async)]
pub fn set_project_icon_file(app: AppHandle, path: String, source: String) -> Result<String, String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let stored = crate::icons::store_icon(&path, Path::new(&source))?;
    let previous = current_icon_file(&path);
    write_project_meta(&path, None, Some(&stored))?;
    crate::icons::prune_stored(previous.as_deref(), Some(&stored));
    let _ = app.emit("config://changed", ());
    Ok(stored)
}

/// Read the config, upsert/prune the `[[space]]` entry for `name`, write it
/// back. Both values are already trimmed-to-`None` by the caller.
fn write_space_meta(name: &str, icon: Option<&str>, color: Option<&str>) -> Result<(), String> {
    let serialized = upsert_space_meta(&ensure_config()?, name, icon, color)?;
    std::fs::write(config_path(), serialized).map_err(|e| e.to_string())
}

/// mkdir a new space under a root, optionally recording its icon in one shot.
/// Doing the mkdir + `[[space]]` write + single emit here (rather than a separate
/// edit) avoids a letter→icon flash and a folder-exists-but-metadata-failed
/// window. Returns the created dir.
#[tauri::command(async)]
pub fn add_space(
    app: AppHandle,
    root: String,
    name: String,
    icon: Option<String>,
    color: Option<String>,
) -> Result<String, String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let n = valid_name(&name)?;
    let dir = PathBuf::from(expand_tilde(&root)).join(&n);
    if dir.exists() {
        return Err(format!("\"{n}\" already exists"));
    }
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let icon = icon.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let color = color.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if icon.is_some() || color.is_some() {
        write_space_meta(&n, icon, color)?;
    }
    let _ = app.emit("config://changed", ()); // explicit re-discovery
    Ok(dir.to_string_lossy().into_owned())
}

/// Set (or clear) a space's icon, keyed by name. The edit path only: creates no
/// folder. An empty/whitespace icon normalizes to `None`, pruning the entry.
/// Mirrors `pin_path`: write store → emit `config://changed` (the sidebar's
/// listener drives the reload).
#[tauri::command(async)]
pub fn set_space_meta(
    app: AppHandle,
    name: String,
    icon: Option<String>,
    color: Option<String>,
) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let icon = icon.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let color = color.as_deref().map(str::trim).filter(|s| !s.is_empty());
    write_space_meta(&name, icon, color)?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Set the top-level `space_order` array (root-space names) via `toml_edit`,
/// preserving the rest of the file. An empty list prunes the key. Pure over the
/// config text so it can be unit-tested without touching the real config.
fn write_space_order(text: &str, names: &[String]) -> Result<String, String> {
    use toml_edit::{value, Array, Document};
    let mut doc: Document = text.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;
    if names.is_empty() {
        doc.remove("space_order");
    } else {
        let mut arr = Array::new();
        for n in names {
            arr.push(n.as_str());
        }
        doc["space_order"] = value(arr);
    }
    Ok(doc.to_string())
}

/// Persist the user-chosen order of root spaces (by name). The pinned ("Other")
/// spaces are never included. Mirrors `pin_path`: write store → emit.
#[tauri::command(async)]
pub fn set_space_order(app: AppHandle, names: Vec<String>) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let serialized = write_space_order(&ensure_config()?, &names)?;
    std::fs::write(config_path(), serialized).map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// mkdir a new project folder under a space. Returns the created dir.
#[tauri::command(async)]
pub fn add_folder(app: AppHandle, space_path: String, name: String) -> Result<String, String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let n = valid_name(&name)?;
    let dir = PathBuf::from(&space_path).join(&n);
    if dir.exists() {
        return Err(format!("\"{n}\" already exists"));
    }
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    // Tori created it: adopt so a path reused over old sessions is not historical.
    let _ = crate::sessions::adopt(&dir.to_string_lossy());
    let _ = app.emit("config://changed", ()); // explicit re-discovery
    Ok(dir.to_string_lossy().into_owned())
}

/// Explicitly ask the UI to re-discover (emits the same event the watchers do).
#[tauri::command(async)]
pub fn rediscover(app: AppHandle) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    app.emit("config://changed", ()).map_err(|e| e.to_string())
}

/// Remove an `incomplete` stub: a `.bare` left by a killed bootstrap, with no
/// worktrees. Refuses anything that does not probe as `incomplete`, so a real
/// project can never be deleted through this path (the only UI removal in scope).
#[tauri::command(async)]
pub fn cleanup_incomplete(app: AppHandle, path: String) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let p = PathBuf::from(&path);
    let units = probe_project(&p);
    let is_stub = units.len() == 1 && units[0].kind == ProjectKind::Incomplete;
    if !is_stub {
        return Err("Refusing: not an incomplete stub".into());
    }
    std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Pure guard: given the single collapsed root and a candidate space path, return
/// the space dir to delete or an error. A space is a *direct child* of the root,
/// so we refuse the root itself, `$HOME`, and anything not directly under the root
/// (a project, a nested path, or an outside path). Both sides are canonicalized so
/// a symlinked space resolving outside the root is refused, never followed.
fn do_delete_space(root: Option<&str>, path: &str) -> Result<PathBuf, String> {
    let root = root.ok_or("No base folder configured")?;
    let root_c = std::fs::canonicalize(expand_tilde(root))
        .map_err(|_| "Base folder does not exist".to_string())?;
    let dir_c =
        std::fs::canonicalize(path).map_err(|_| "Space folder does not exist".to_string())?;
    if dir_c == root_c {
        return Err("Refusing to delete the base folder itself".into());
    }
    if let Some(home) = dirs::home_dir() {
        if dir_c == home {
            return Err("Refusing to delete the home folder".into());
        }
    }
    match dir_c.parent() {
        Some(p) if p == root_c => Ok(dir_c),
        _ => Err("Refusing: not a space directly under the base folder".into()),
    }
}

/// Permanently `rm -rf` a root space and everything inside it. Guarded by
/// `do_delete_space` against escaping the base folder; the destructive typed-name
/// confirmation lives in the UI. Non-atomic: a mid-delete failure can leave a
/// partial folder, surfaced as an error. Emits `config://changed` to re-discover.
#[tauri::command(async)]
pub fn delete_space(app: AppHandle, path: String) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let text = ensure_config()?;
    let raw: RawConfig = toml::from_str(&text).map_err(|e| e.to_string())?;
    let dir = do_delete_space(raw.discovery.roots.first().map(|s| s.as_str()), &path)?;
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Pure guard: given the single collapsed root and a candidate plain-folder path,
/// return the folder dir to delete or an error. A plain folder is a *project* (a
/// child of a space), so it must be a strict descendant of the root but never the
/// root, a space directly under it, or `$HOME`. Both sides are canonicalized so a
/// symlink resolving outside the root is refused, never followed. Git-ness is
/// checked by the caller (probe), not here.
fn do_remove_folder(root: Option<&str>, path: &str) -> Result<PathBuf, String> {
    let root = root.ok_or("No base folder configured")?;
    let root_c = std::fs::canonicalize(expand_tilde(root))
        .map_err(|_| "Base folder does not exist".to_string())?;
    let dir_c = std::fs::canonicalize(path).map_err(|_| "Folder does not exist".to_string())?;
    if dir_c == root_c {
        return Err("Refusing to delete the base folder itself".into());
    }
    if let Some(home) = dirs::home_dir() {
        if dir_c == home {
            return Err("Refusing to delete the home folder".into());
        }
    }
    if dir_c.parent() == Some(root_c.as_path()) {
        return Err("Refusing: this is a space, not a folder (use Delete space)".into());
    }
    if !dir_c.starts_with(&root_c) {
        return Err("Refusing: not a folder under the base folder".into());
    }
    Ok(dir_c)
}

/// Permanently `rm -rf` a non-git project folder (a plain-dir). Guarded by
/// `do_remove_folder` against escaping the base folder / hitting a space, and by a
/// `probe_project` re-check that refuses anything git (a repo or worktree
/// container), so tracked work can never be deleted through this path. The
/// typed-name confirmation lives in the UI. Emits `config://changed`.
#[tauri::command(async)]
pub fn remove_folder(app: AppHandle, path: String) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let text = ensure_config()?;
    let raw: RawConfig = toml::from_str(&text).map_err(|e| e.to_string())?;
    let dir = do_remove_folder(raw.discovery.roots.first().map(|s| s.as_str()), &path)?;
    let units = probe_project(&dir);
    let is_plain_dir = units.len() == 1 && units[0].kind == ProjectKind::PlainDir;
    if !is_plain_dir {
        return Err("Refusing: this folder is a git repository".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Permanently `rm -rf` a git *project* folder: a plain repo or a worktree
/// container (with its `.bare` and every worktree). Shares `do_remove_folder`'s
/// location guard (a project is a grandchild of the root, never the root, a space,
/// or `$HOME`), then a `probe_project` re-check that *requires* a git project, so
/// a plain-dir (which has `remove_folder`) or an incomplete stub (which has "Remove
/// stub") never routes here. The typed-name confirmation lives in the UI. Emits
/// `config://changed`.
#[tauri::command(async)]
pub fn remove_project(app: AppHandle, path: String) -> Result<(), String> {
    // Load-modify-save on the config store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("config");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let text = ensure_config()?;
    let raw: RawConfig = toml::from_str(&text).map_err(|e| e.to_string())?;
    let dir = do_remove_folder(raw.discovery.roots.first().map(|s| s.as_str()), &path)?;
    let kind = probe_project(&dir).first().map(|u| u.kind);
    if !matches!(kind, Some(ProjectKind::Plain | ProjectKind::Worktree)) {
        return Err("Refusing: not a git project (a plain repo or worktree container)".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// One direct child of a space folder in the delete preview: a git repo (with its
/// at-risk flags), a plain folder, or a loose file. Non-repo entries carry no flags.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEntry {
    pub name: String,
    pub kind: String, // "repo" | "folder" | "file"
    pub dirty: bool,
    pub unpushed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacePreview {
    pub size_bytes: u64,
    pub entries: Vec<PreviewEntry>,
}

/// Recursive on-disk byte size, not following symlinks (a symlink is neither
/// is_dir nor is_file here, so it is skipped, avoiding cycles).
fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(path) {
        for ent in rd.flatten() {
            match ent.file_type() {
                Ok(ft) if ft.is_dir() => total += dir_size(&ent.path()),
                Ok(ft) if ft.is_file() => total += ent.metadata().map(|m| m.len()).unwrap_or(0),
                _ => {}
            }
        }
    }
    total
}

/// Best-effort at-risk status for a repo folder (plain repo OR worktree container).
/// `None` when it is not a git repo at all. `dirty` = any worktree has porcelain
/// output; `unpushed` = any local branch is ahead of, or has no, upstream (so
/// unpublished work and commits on worktree-less branches both surface).
fn repo_status(path: &Path) -> Option<(bool, bool)> {
    let text = run_git(path, &["worktree", "list", "--porcelain"])?;
    let dirty = parse_worktrees(&text)
        .into_iter()
        .filter(|e| !e.bare)
        .any(|e| {
            run_git(Path::new(&e.path), &["status", "--porcelain"])
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        });
    let unpushed = match run_git(
        path,
        &["for-each-ref", "--format=%(upstream)\t%(upstream:track)", "refs/heads"],
    ) {
        Some(refs) => refs.lines().any(|line| {
            let mut parts = line.splitn(2, '\t');
            let upstream = parts.next().unwrap_or("").trim();
            let track = parts.next().unwrap_or("").trim();
            upstream.is_empty() || track.contains("ahead")
        }),
        None => false,
    };
    Some((dirty, unpushed))
}

/// Enumerate *every* direct child of a space folder (not only discovered projects)
/// so the delete confirmation shows the full blast radius: loose files and non-git
/// folders that discovery skips are still surfaced. Per-repo at-risk flags + total
/// on-disk size drive the dialog.
#[tauri::command(async)]
pub fn space_delete_preview(path: String) -> Result<SpacePreview, String> {
    let dir = PathBuf::from(&path);
    let mut entries: Vec<PreviewEntry> = Vec::new();
    for ent in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = ent.path();
        let name = basename(&p);
        let entry = if p.is_dir() {
            match repo_status(&p) {
                Some((dirty, unpushed)) => PreviewEntry { name, kind: "repo".into(), dirty, unpushed },
                None => PreviewEntry { name, kind: "folder".into(), dirty: false, unpushed: false },
            }
        } else {
            PreviewEntry { name, kind: "file".into(), dirty: false, unpushed: false }
        };
        entries.push(entry);
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(SpacePreview { size_bytes: dir_size(&dir), entries })
}

/// Delete preview for a git *project* folder (plain repo or worktree container).
/// Like `space_delete_preview` for the blast radius, but prepends the project's own
/// repo status as the first entry, so deleting a repo root surfaces *its own*
/// uncommitted / unpushed work (a plain repo's own state, or a worktree container's
/// aggregate), which the children-only space view would miss. Children follow
/// (a worktree container's worktrees + `.bare`, or a plain repo's working tree).
#[tauri::command(async)]
pub fn project_delete_preview(path: String) -> Result<SpacePreview, String> {
    let dir = PathBuf::from(&path);
    let mut entries: Vec<PreviewEntry> = Vec::new();
    // The project itself first: its own at-risk flags, labelled so it reads as the
    // repo root rather than a child.
    if let Some((dirty, unpushed)) = repo_status(&dir) {
        entries.push(PreviewEntry {
            name: format!("{} (repository root)", basename(&dir)),
            kind: "repo".into(),
            dirty,
            unpushed,
        });
    }
    // Then each direct child, sorted. Unlike the space preview, a child is only a
    // "repo" when it is its *own* checkout, i.e. it has a `.git` (a worktree folder
    // has a `.git` file, a nested clone a `.git` dir). Without that gate every plain
    // subdir would `git -C` up into the enclosing repo and be mislabelled a repo. A
    // worktree child reports its *own* dirty (via its status); repo-wide unpushed is
    // already shown once on the root entry, so children leave it false.
    let mut children: Vec<PreviewEntry> = Vec::new();
    for ent in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = ent.path();
        let name = basename(&p);
        let entry = if p.is_dir() {
            if p.join(".git").exists() {
                let dirty = run_git(&p, &["status", "--porcelain"])
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false);
                PreviewEntry { name, kind: "repo".into(), dirty, unpushed: false }
            } else {
                PreviewEntry { name, kind: "folder".into(), dirty: false, unpushed: false }
            }
        } else {
            PreviewEntry { name, kind: "file".into(), dirty: false, unpushed: false }
        };
        children.push(entry);
    }
    children.sort_by(|a, b| a.name.cmp(&b.name));
    entries.extend(children);
    Ok(SpacePreview { size_bytes: dir_size(&dir), entries })
}

#[derive(Default)]
pub struct RootWatch(pub Mutex<Option<RecommendedWatcher>>);

/// Shallow watch of the configured roots (and their immediate space dirs) so
/// folders created outside the app surface without a restart. The config-file
/// watcher only sees the toml itself, never filesystem creates under the roots.
/// Deliberately non-recursive (one extra level) to avoid watching deep trees.
#[tauri::command(async)]
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
        let _ = watcher.watch(&rp, RecursiveMode::NonRecursive); // new spaces
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
        let p = std::env::temp_dir().join(format!("tori_cfg_test_{n}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Concurrent cold probes of one path coalesce to a single subprocess:
    /// the first caller holds the flight lock and probes, the rest wait on it
    /// and then read the entry it wrote. This is the seam `get_config` races
    /// through on every worktree switch.
    #[test]
    fn concurrent_probes_of_one_path_run_one_probe() {
        let dir = unique_tmp().join("probe_flight");
        std::fs::create_dir_all(&dir).unwrap();
        let index = ProjectIndex::default();
        let before = PROBE_CALLS.load(std::sync::atomic::Ordering::SeqCst);
        let mut handles = Vec::new();
        for _ in 0..8 {
            let index = index.clone();
            let dir = dir.clone();
            handles.push(std::thread::spawn(move || cached_probe(&index, &dir)));
        }
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let probes = PROBE_CALLS.load(std::sync::atomic::Ordering::SeqCst) - before;
        assert_eq!(probes, 1, "eight concurrent cold probes must cost one subprocess");
        for r in &results {
            assert_eq!(r.len(), results[0].len());
        }
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

    #[test]
    fn unborn_repo_shows_head_branch_by_name() {
        // A freshly `git init`ed repo with no commit: HEAD is unborn, so `git branch`
        // lists nothing, but probe should still show the branch by name (not a
        // nameless folder unit) and mark it current.
        let dir = unique_tmp();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);

        let units = probe_project(&dir);
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].kind, ProjectKind::Plain);
        assert_eq!(units[0].branch.as_deref(), Some("main"));
        assert_eq!(units[0].label, "main");
        assert!(units[0].is_current);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_remote_branches_strips_prefix_and_drops_head() {
        let dir = unique_tmp();
        init_repo(&dir, "main");
        let head = {
            let out = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        // Fabricate remote-tracking refs (no real remote needed) + the origin/HEAD symref.
        git(&dir, &["update-ref", "refs/remotes/origin/foo", &head]);
        git(&dir, &["update-ref", "refs/remotes/origin/feature/x", &head]);
        git(&dir, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/foo"]);

        let mut got = list_remote_branches(dir.to_string_lossy().into_owned()).unwrap();
        got.sort();
        assert_eq!(got, vec!["feature/x".to_string(), "foo".to_string()]);
        // origin/HEAD is excluded, and names carry no `origin/` prefix.
        assert!(!got.iter().any(|n| n == "HEAD" || n.starts_with("origin/")));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_remote_branches_empty_when_no_remotes() {
        let dir = unique_tmp();
        init_repo(&dir, "main");
        assert!(list_remote_branches(dir.to_string_lossy().into_owned())
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(&dir).ok();
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
                    space: g.to_string(),
                    path: p.to_string(),
                })
                .collect(),
            space: Vec::new(),
            project_meta: Vec::new(),
            space_order: Vec::new(),
        }
    }

    fn space<'a>(cfg: &'a ResolvedConfig, name: &str) -> Option<&'a Space> {
        cfg.spaces.iter().find(|g| g.name == name)
    }

    fn project<'a>(cfg: &'a ResolvedConfig, grp: &str, proj: &str) -> &'a Project {
        space(cfg, grp)
            .unwrap_or_else(|| panic!("space {grp} missing"))
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

        // ignored space.
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

        // Spaces: personal + extra; node_modules ignored.
        assert!(space(&cfg, "personal").is_some());
        assert!(space(&cfg, "extra").is_some());
        assert!(space(&cfg, "node_modules").is_none());

        // personal projects: no dotdir, the four real folders only.
        let mut names: Vec<&str> = space(&cfg, "personal")
            .unwrap()
            .projects
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        names.sort();
        assert_eq!(names, vec!["plaindir", "plainrepo", "stub", "wtproj"]);

        // Dedup: plainrepo (discovered + explicit) appears exactly once.
        let plain_count = cfg
            .spaces
            .iter()
            .flat_map(|g| &g.projects)
            .filter(|p| p.name == "plainrepo")
            .count();
        assert_eq!(plain_count, 1);

        // out-of-root explicit path appears once, under its parent-named space.
        assert_eq!(space(&cfg, "extra").unwrap().projects.len(), 1);

        // plain kind: only the current checkout is visible when nothing is attached
        // (feature is checked out; unattached main is absent).
        let pr = project(&cfg, "personal", "plainrepo");
        assert!(pr.branch_units.iter().all(|u| u.kind == ProjectKind::Plain));
        let feat = pr
            .branch_units
            .iter()
            .find(|u| u.branch.as_deref() == Some("feature"))
            .unwrap();
        assert!(feat.is_current);
        assert!(
            pr.branch_units
                .iter()
                .all(|u| u.branch.as_deref() != Some("main")),
            "unattached main must not surface as a unit"
        );

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
    fn plain_units_show_attached_and_current_only() {
        let tmp = unique_tmp();
        let repo = tmp.join("repo");
        init_repo(&repo, "main"); // on main
        git(&repo, &["branch", "feature"]);
        git(&repo, &["branch", "spare"]);

        // Attach feature only: current (main) + attached (feature) show; spare hidden.
        let attached = HashSet::from(["feature".to_string()]);
        let units = plain_branch_units(&repo, &attached);
        let names: HashSet<&str> = units.iter().filter_map(|u| u.branch.as_deref()).collect();
        assert_eq!(names, HashSet::from(["main", "feature"]));
        assert!(
            units
                .iter()
                .find(|u| u.branch.as_deref() == Some("main"))
                .unwrap()
                .is_current
        );

        // A store entry for a nonexistent branch yields no unit (only current shows).
        let ghost = HashSet::from(["nope".to_string()]);
        let ghost_units = plain_branch_units(&repo, &ghost);
        let names2: HashSet<&str> = ghost_units
            .iter()
            .filter_map(|u| u.branch.as_deref())
            .collect();
        assert_eq!(names2, HashSet::from(["main"]));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn plain_repo_lists_its_tori_worktrees_as_units() {
        // What a Feature leaves behind on Keep: a checkout under `.tori/worktrees`
        // that `git branch` names but `plain_branch_units` filters out, and that
        // the folder walkers skip. Without a unit for it, it is gone from Tori.
        let tmp = unique_tmp();
        let repo = tmp.join("repo");
        init_repo(&repo, "main");
        let wt = repo.join(".tori/worktrees/x");
        git(
            &repo,
            &["worktree", "add", "-q", "-b", "feat/x", wt.to_str().unwrap()],
        );

        let units = probe_project(&repo);
        assert_eq!(units.len(), 2, "{:?}", units.iter().map(|u| &u.label).collect::<Vec<_>>());
        let main = units.iter().find(|u| u.label == "main").unwrap();
        assert_eq!(main.kind, ProjectKind::Plain);
        assert_eq!(main.folder_path, repo.to_string_lossy());
        let feat = units.iter().find(|u| u.label == "feat/x").unwrap();
        assert_eq!(feat.kind, ProjectKind::Worktree);
        assert!(feat.folder_path.ends_with(".tori/worktrees/x"));
        assert!(!feat.is_current);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_worktree_outside_the_repo_is_not_one_of_its_units() {
        // The other half of the rule: only worktrees the repo contains. A linked
        // worktree beside it is a project of its own, and claiming it here would
        // point a unit at a folder outside this project, then list the pair
        // twice once the sibling is probed too.
        let tmp = unique_tmp();
        let repo = tmp.join("repo");
        init_repo(&repo, "main");
        let outside = tmp.join("repo-feature");
        git(
            &repo,
            &["worktree", "add", "-q", "-b", "feature", outside.to_str().unwrap()],
        );

        let units = probe_project(&repo);
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].label, "main");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn plain_units_unborn_head_yields_one_named_current_unit() {
        let tmp = unique_tmp();
        let repo = tmp.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]); // no commits: unborn HEAD, no branch refs

        // The unborn HEAD still names a branch; show it by name and as current,
        // rather than a nameless folder unit.
        let units = plain_branch_units(&repo, &HashSet::new());
        assert_eq!(units.len(), 1);
        assert!(units[0].branch.is_some());
        assert_eq!(units[0].label, units[0].branch.clone().unwrap());
        assert!(units[0].is_current);
        assert_eq!(units[0].kind, ProjectKind::Plain);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn attached_seed_survives_detach_to_empty() {
        let mut state = AttachedState::default();
        let key = "/repo";
        let locals = HashSet::from(["main".to_string(), "feature".to_string()]);

        // Seed once → attaches the default (main), marks seeded.
        assert!(do_seed_attached(&mut state, key, &locals, Some("main")));
        assert!(state.0[key].branches.contains("main"));
        assert!(state.0[key].seeded);

        // Attach feature by hand, then detach everything.
        let e = state.0.get_mut(key).unwrap();
        e.branches.insert("feature".to_string());
        e.branches.remove("main");
        e.branches.remove("feature");
        assert!(state.0[key].branches.is_empty());
        assert!(state.0[key].seeded, "seeded flag must survive detach-to-empty");

        // A second seed is a no-op: the hand-emptied set is never re-seeded.
        assert!(!do_seed_attached(&mut state, key, &locals, Some("main")));
        assert!(state.0[key].branches.is_empty());
    }

    #[test]
    fn seed_attaches_default_and_skips_empty() {
        // A local default branch is attached.
        let mut state = AttachedState::default();
        let locals = HashSet::from(["main".to_string(), "dev".to_string()]);
        assert!(do_seed_attached(&mut state, "/r", &locals, Some("dev")));
        assert!(state.0["/r"].branches.contains("dev"));
        assert_eq!(state.0["/r"].branches.len(), 1);

        // A seed that is not a local branch is ignored, but the repo is still marked
        // seeded (so we do not retry every discovery).
        let mut s2 = AttachedState::default();
        assert!(do_seed_attached(&mut s2, "/r", &locals, Some("origin-only")));
        assert!(s2.0["/r"].branches.is_empty());
        assert!(s2.0["/r"].seeded);

        // An unborn repo (no branches) is not seeded: the flag stays unset.
        let mut s3 = AttachedState::default();
        assert!(!do_seed_attached(&mut s3, "/r", &HashSet::new(), Some("main")));
        assert!(!s3.0.get("/r").map(|r| r.seeded).unwrap_or(false));
    }

    #[test]
    fn ensure_local_tracking_creates_verifies_and_preserves() {
        let tmp = unique_tmp();
        // A "remote" repo with main + feature.
        let remote = tmp.join("remote");
        init_repo(&remote, "main");
        git(&remote, &["branch", "feature"]);

        // Clone it so origin/* tracking refs exist (simulates a prior fetch).
        let clone = tmp.join("clone");
        git(&tmp, &["clone", "-q", remote.to_str().unwrap(), clone.to_str().unwrap()]);

        // A fetched remote branch is created as a local tracking branch.
        assert!(ensure_local_tracking(&clone, "feature").is_ok());
        assert!(local_branches(&clone).contains("feature"));

        // A non-existent remote branch is rejected.
        assert!(ensure_local_tracking(&clone, "ghost").is_err());
        assert!(!local_branches(&clone).contains("ghost"));

        // An already-local branch is surfaced, not clobbered (no error, still there).
        let before = run_git(&clone, &["rev-parse", "feature"]).unwrap();
        assert!(ensure_local_tracking(&clone, "feature").is_ok());
        let after = run_git(&clone, &["rev-parse", "feature"]).unwrap();
        assert_eq!(before, after, "existing local branch must be left untouched");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn refuse_if_current_blocks_checked_out_branch() {
        let tmp = unique_tmp();
        let repo = tmp.join("repo");
        init_repo(&repo, "main"); // on main
        git(&repo, &["branch", "feature"]);

        assert!(refuse_if_current(&repo, "main").is_err()); // current: blocked
        assert!(refuse_if_current(&repo, "feature").is_ok()); // not current: allowed

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

        // Exactly the declared project, under its declared space, nothing else.
        assert_eq!(cfg.spaces.len(), 1);
        assert_eq!(cfg.spaces[0].name, "teamx");
        assert_eq!(cfg.spaces[0].projects.len(), 1);
        assert_eq!(cfg.spaces[0].projects[0].name, "declared");
        // The default ~/Projects root must NOT kick in when legacy paths exist.
        assert!(space(&cfg, "other").is_none());

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
    fn empty_space_dir_is_surfaced() {
        let tmp = unique_tmp();
        let root = tmp.join("Projects");
        // A space folder with no project subdirs (just created from the UI).
        std::fs::create_dir_all(root.join("newspace")).unwrap();
        let index = ProjectIndex::default();
        let cfg = resolve(raw(&[root.to_str().unwrap()], &[], &[], &[]), &index);
        let g = space(&cfg, "newspace").expect("empty space should appear");
        assert!(g.projects.is_empty());
        assert!(g.path.ends_with("newspace")); // path lets the UI add a folder under it
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
    fn space_icon_and_color_overlay_onto_discovered_space() {
        // What `add_space(root, name, icon, color)` writes: a `[[space]]` entry.
        let tmp = unique_tmp();
        let root = tmp.join("Projects");
        std::fs::create_dir_all(root.join("personal")).unwrap();
        let meta = upsert_space_meta("", "personal", Some("Rocket"), Some("Teal")).unwrap();
        let full = format!("[discovery]\nroots = [\"{}\"]\n\n{meta}", root.display());
        let raw: RawConfig = toml::from_str(&full).unwrap();
        let index = ProjectIndex::default();
        let cfg = resolve(raw, &index);
        let g = space(&cfg, "personal").expect("space present");
        assert_eq!(g.icon.as_deref(), Some("Rocket"));
        assert_eq!(g.color.as_deref(), Some("Teal"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_space_that_chose_no_colour_reports_none_so_the_ui_can_derive_one() {
        let tmp = unique_tmp();
        let root = tmp.join("Projects");
        std::fs::create_dir_all(root.join("personal")).unwrap();
        let meta = upsert_space_meta("", "personal", Some("Rocket"), None).unwrap();
        let full = format!("[discovery]\nroots = [\"{}\"]\n\n{meta}", root.display());
        let cfg = resolve(toml::from_str(&full).unwrap(), &ProjectIndex::default());
        assert_eq!(space(&cfg, "personal").unwrap().color, None);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn upsert_space_meta_adds_updates_and_prunes() {
        // Add onto an empty config: creates the `[[space]]` entry.
        let added = upsert_space_meta("", "personal", Some("Rocket"), None).unwrap();
        let c1: RawConfig = toml::from_str(&added).unwrap();
        assert_eq!(c1.space.len(), 1);
        assert_eq!(c1.space[0].name, "personal");
        assert_eq!(c1.space[0].icon.as_deref(), Some("Rocket"));

        // Update the same entry in place, never a duplicate.
        let updated = upsert_space_meta(&added, "personal", Some("Anchor"), None).unwrap();
        let c2: RawConfig = toml::from_str(&updated).unwrap();
        assert_eq!(c2.space.len(), 1);
        assert_eq!(c2.space[0].icon.as_deref(), Some("Anchor"));

        // Preserves comments and other keys (the toml_edit win over to_string_pretty).
        let with_comment = "# my config\n[discovery]\nroots = [\"/r\"]\n";
        let out = upsert_space_meta(with_comment, "work", Some("Box"), None).unwrap();
        assert!(out.contains("# my config"));
        assert!(out.contains("roots"));

        // Clearing both prunes the entry and drops the emptied array.
        let cleared = upsert_space_meta(&updated, "personal", None, None).unwrap();
        let c3: RawConfig = toml::from_str(&cleared).unwrap();
        assert!(c3.space.is_empty());
        assert!(!cleared.contains("[[space]]"));
    }

    #[test]
    fn a_space_keeps_its_icon_and_its_colour_side_by_side() {
        let both = upsert_space_meta("", "personal", Some("Rocket"), Some("Teal")).unwrap();
        let c: RawConfig = toml::from_str(&both).unwrap();
        assert_eq!(c.space.len(), 1);
        assert_eq!(c.space[0].icon.as_deref(), Some("Rocket"));
        assert_eq!(c.space[0].color.as_deref(), Some("Teal"));

        // Clearing ONE leaves the other standing, and does not leave the cleared
        // key behind with a stale value.
        let no_icon = upsert_space_meta(&both, "personal", None, Some("Teal")).unwrap();
        let c2: RawConfig = toml::from_str(&no_icon).unwrap();
        assert_eq!(c2.space.len(), 1);
        assert_eq!(c2.space[0].icon, None);
        assert_eq!(c2.space[0].color.as_deref(), Some("Teal"));
        assert!(!no_icon.contains("icon"));

        // And the entry survives as long as either one is set.
        let no_color = upsert_space_meta(&both, "personal", Some("Rocket"), None).unwrap();
        let c3: RawConfig = toml::from_str(&no_color).unwrap();
        assert_eq!(c3.space[0].color, None);
        assert!(no_color.contains("[[space]]"));
    }

    #[test]
    fn upsert_project_meta_adds_switches_and_prunes() {
        // Add onto an empty config: creates the `[[project_meta]]` entry.
        let added = upsert_project_meta("", "/p/tori", Some("Rocket"), None).unwrap();
        let c1: RawConfig = toml::from_str(&added).unwrap();
        assert_eq!(c1.project_meta.len(), 1);
        assert_eq!(c1.project_meta[0].path, "/p/tori");
        assert_eq!(c1.project_meta[0].icon.as_deref(), Some("Rocket"));

        // Switching to an uploaded image must REMOVE the glyph, not shadow it -
        // a leftover `icon` would resurface the moment the image was cleared.
        let to_file = upsert_project_meta(&added, "/p/tori", None, Some("/i/a.png")).unwrap();
        let c2: RawConfig = toml::from_str(&to_file).unwrap();
        assert_eq!(c2.project_meta.len(), 1);
        assert_eq!(c2.project_meta[0].icon, None);
        assert_eq!(c2.project_meta[0].icon_file.as_deref(), Some("/i/a.png"));

        // And back the other way, in place, still one entry.
        let back = upsert_project_meta(&to_file, "/p/tori", Some("Anchor"), None).unwrap();
        let c3: RawConfig = toml::from_str(&back).unwrap();
        assert_eq!(c3.project_meta.len(), 1);
        assert_eq!(c3.project_meta[0].icon.as_deref(), Some("Anchor"));
        assert_eq!(c3.project_meta[0].icon_file, None);

        // A second project is its own entry, keyed by path.
        let two = upsert_project_meta(&back, "/p/other", Some("Star"), None).unwrap();
        let c4: RawConfig = toml::from_str(&two).unwrap();
        assert_eq!(c4.project_meta.len(), 2);

        // Both cleared ("automatic") prunes that entry, leaving the other.
        let cleared = upsert_project_meta(&two, "/p/tori", None, None).unwrap();
        let c5: RawConfig = toml::from_str(&cleared).unwrap();
        assert_eq!(c5.project_meta.len(), 1);
        assert_eq!(c5.project_meta[0].path, "/p/other");

        // Emptying the last entry drops the dangling array key entirely.
        let none = upsert_project_meta(&cleared, "/p/other", None, None).unwrap();
        assert!(!none.contains("[[project_meta]]"));

        // Comments and unrelated keys survive (the toml_edit win).
        let out = upsert_project_meta("# my config\n[discovery]\nroots = [\"/r\"]\n", "/p/x", Some("Box"), None).unwrap();
        assert!(out.contains("# my config") && out.contains("roots"));
    }

    #[test]
    fn project_meta_overlays_a_chosen_icon_and_drops_a_deleted_image() {
        let tmp = unique_tmp();
        let root = tmp.join("Projects");
        let picked = root.join("personal/picked");
        let missing = root.join("personal/missing");
        std::fs::create_dir_all(&picked).unwrap();
        std::fs::create_dir_all(&missing).unwrap();

        // A real image for one project, a path that does not exist for the other.
        let img = tmp.join("stored.png");
        std::fs::write(&img, b"png").unwrap();

        let mut cfg_in = raw(&[root.to_str().unwrap()], &[], &[], &[]);
        cfg_in.project_meta = vec![
            ProjectMeta {
                path: picked.to_string_lossy().into_owned(),
                icon: Some("Rocket".into()),
                icon_file: None,
            },
            ProjectMeta {
                path: missing.to_string_lossy().into_owned(),
                icon: None,
                icon_file: Some(tmp.join("gone.png").to_string_lossy().into_owned()),
            },
        ];
        let cfg = resolve(cfg_in, &ProjectIndex::default());
        assert_eq!(project(&cfg, "personal", "picked").icon.as_deref(), Some("Rocket"));
        // An icon file deleted out from under the config must not be reported:
        // the row falls back to its derived glyph, never a broken image.
        assert_eq!(project(&cfg, "personal", "missing").icon_file, None);

        // The same entry pointing at a file that IS there is reported as-is.
        let mut raw2 = raw(&[root.to_str().unwrap()], &[], &[], &[]);
        raw2.project_meta = vec![ProjectMeta {
            path: missing.to_string_lossy().into_owned(),
            icon: None,
            icon_file: Some(img.to_string_lossy().into_owned()),
        }];
        let cfg2 = resolve(raw2, &ProjectIndex::default());
        assert_eq!(
            project(&cfg2, "personal", "missing").icon_file,
            Some(img.to_string_lossy().into_owned())
        );

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn favicon_is_found_in_a_plain_repo_and_inside_a_worktree_container() {
        let tmp = unique_tmp();
        let root = tmp.join("Projects");

        // A plain repo answers for itself.
        let plain = root.join("personal/plain");
        init_repo(&plain, "main");
        std::fs::create_dir_all(plain.join("public")).unwrap();
        std::fs::write(plain.join("public/favicon.svg"), "<svg/>").unwrap();

        // A worktree container's root holds only `.bare` + branch folders, so the
        // favicon lives one level down and only the per-unit pass can find it.
        let cont = root.join("personal/cont");
        std::fs::create_dir_all(&cont).unwrap();
        let bare = cont.join(".bare");
        git(&tmp, &["init", "-q", "--bare", bare.to_str().unwrap()]);
        std::fs::write(cont.join(".git"), "gitdir: ./.bare\n").unwrap();
        let seed = tmp.join("seed");
        init_repo(&seed, "main");
        git(&seed, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&seed, &["push", "-q", "origin", "main"]);
        git(&cont, &["worktree", "add", "-q", "main"]);
        std::fs::create_dir_all(cont.join("main/public")).unwrap();
        std::fs::write(cont.join("main/public/favicon.ico"), "ico").unwrap();

        let cfg = resolve(raw(&[root.to_str().unwrap()], &[], &[], &[]), &ProjectIndex::default());
        assert!(project(&cfg, "personal", "plain")
            .favicon
            .as_deref()
            .is_some_and(|f| f.ends_with("public/favicon.svg")));
        assert!(project(&cfg, "personal", "cont")
            .favicon
            .as_deref()
            .is_some_and(|f| f.ends_with("main/public/favicon.ico")));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn write_space_order_sets_updates_and_prunes() {
        let names = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();

        // Set onto a config with a comment: the array is written, comment kept.
        let out = write_space_order("# keep me\n", &names(&["b", "a"])).unwrap();
        assert!(out.contains("# keep me"));
        let c1: RawConfig = toml::from_str(&out).unwrap();
        assert_eq!(c1.space_order, names(&["b", "a"]));

        // Update replaces the whole list in place.
        let out2 = write_space_order(&out, &names(&["a", "b", "c"])).unwrap();
        let c2: RawConfig = toml::from_str(&out2).unwrap();
        assert_eq!(c2.space_order, names(&["a", "b", "c"]));

        // Empty list prunes the key entirely.
        let out3 = write_space_order(&out2, &[]).unwrap();
        assert!(!out3.contains("space_order"));
        let c3: RawConfig = toml::from_str(&out3).unwrap();
        assert!(c3.space_order.is_empty());
    }

    #[test]
    fn space_order_reorders_roots_but_not_pins() {
        // Two root spaces (discovery order alpha, beta) + one pinned space "ext".
        let tmp = unique_tmp();
        let root = tmp.join("Projects");
        std::fs::create_dir_all(root.join("alpha")).unwrap();
        std::fs::create_dir_all(root.join("beta")).unwrap();
        let ext_proj = tmp.join("ext/proj");
        std::fs::create_dir_all(&ext_proj).unwrap();

        // Order beta before alpha; the pinned space is untouched by that.
        let mut raw = raw(
            &[root.to_str().unwrap()],
            &[],
            &[ext_proj.to_str().unwrap()],
            &[],
        );
        raw.space_order = vec!["beta".to_string(), "alpha".to_string()];
        let index = ProjectIndex::default();
        let cfg = resolve(raw, &index);

        let roots: Vec<&str> = cfg
            .spaces
            .iter()
            .filter(|g| !g.external)
            .map(|g| g.name.as_str())
            .collect();
        assert_eq!(roots, vec!["beta", "alpha"]); // reordered
        // The pinned space still appears, after the roots.
        assert!(cfg.spaces.iter().any(|g| g.external && g.name == "ext"));
        let last = cfg.spaces.last().unwrap();
        assert!(last.external, "pinned space sorts after roots");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn replace_root_reduces_to_one_and_preserves_other_keys() {
        // Empty config: creates [discovery].roots with the single path.
        let out = replace_root("", "/Users/x/Projects").unwrap();
        assert!(out.contains("/Users/x/Projects"));
        // A two-root config collapses to exactly the new single root.
        let two = "[discovery]\nroots = [\"/a\", \"/b\"]\npaths = [\"/p/ext\"]\n";
        let one = replace_root(two, "/c").unwrap();
        let cfg: RawConfig = toml::from_str(&one).unwrap();
        assert_eq!(cfg.discovery.roots, vec!["/c".to_string()]);
        // `paths` and legacy [[project]] survive the rewrite.
        assert_eq!(cfg.discovery.paths, vec!["/p/ext".to_string()]);
        let legacy = "[[project]]\nname = \"a\"\nspace = \"g\"\npath = \"/p/a\"\n[discovery]\nroots = [\"/a\", \"/b\"]\n";
        let merged = replace_root(legacy, "/r").unwrap();
        assert!(merged.contains("[[project]]"));
        assert!(merged.contains("/p/a"));
        let mcfg: RawConfig = toml::from_str(&merged).unwrap();
        assert_eq!(mcfg.discovery.roots, vec!["/r".to_string()]);
    }

    #[test]
    fn clear_root_empties_roots_and_preserves_other_keys() {
        let two = "[discovery]\nroots = [\"/a\", \"/b\"]\npaths = [\"/p/ext\"]\n\n[[project]]\nname = \"a\"\nspace = \"g\"\npath = \"/p/a\"\n";
        let cleared = clear_root(two).unwrap();
        let cfg: RawConfig = toml::from_str(&cleared).unwrap();
        assert!(cfg.discovery.roots.is_empty());
        assert_eq!(cfg.discovery.paths, vec!["/p/ext".to_string()]);
        assert_eq!(cfg.project.len(), 1);
        assert_eq!(cfg.project[0].path, "/p/a");
        // No discovery section at all is a clean no-op (still parses, no roots).
        let none = clear_root("").unwrap();
        let ncfg: RawConfig = toml::from_str(&none).unwrap();
        assert!(ncfg.discovery.roots.is_empty());
    }

    #[test]
    fn resolve_tags_root_vs_external_origin() {
        let tmp = unique_tmp();
        let root = tmp.join("Projects");
        init_repo(&root.join("personal/inroot"), "main");
        // An out-of-root pinned project (space = its parent dir name).
        let ext = tmp.join("Outside/work/pinned");
        init_repo(&ext, "main");

        let index = ProjectIndex::default();
        let cfg = resolve(
            raw(&[root.to_str().unwrap()], &[], &[ext.to_str().unwrap()], &[]),
            &index,
        );

        let root_grp = space(&cfg, "personal").expect("root space");
        assert!(!root_grp.external);
        assert!(!root_grp.projects[0].external);

        let other = space(&cfg, "work").expect("external space");
        assert!(other.external);
        assert_eq!(other.projects.len(), 1);
        assert!(other.projects[0].external);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn add_and_remove_path_are_idempotent_and_scoped() {
        // Empty config: creates [discovery].paths with the entry.
        let out = add_path("", "/x/ext").unwrap();
        assert!(out.contains("/x/ext"));
        // Idempotent append.
        let again = add_path(&out, "/x/ext").unwrap();
        assert_eq!(again.matches("/x/ext").count(), 1);
        // A second distinct pin coexists; removing one keeps the other + roots.
        let two = add_path(&add_path("[discovery]\nroots = [\"/r\"]\n", "/x/a").unwrap(), "/x/b").unwrap();
        let cfg2: RawConfig = toml::from_str(&two).unwrap();
        assert_eq!(cfg2.discovery.paths, vec!["/x/a".to_string(), "/x/b".to_string()]);
        let removed = remove_path(&two, "/x/a").unwrap();
        let cfg3: RawConfig = toml::from_str(&removed).unwrap();
        assert_eq!(cfg3.discovery.paths, vec!["/x/b".to_string()]);
        assert_eq!(cfg3.discovery.roots, vec!["/r".to_string()]);
        // Removing an absent path is a clean no-op.
        let noop = remove_path("[discovery]\npaths = [\"/x/b\"]\n", "/nope").unwrap();
        let cfg4: RawConfig = toml::from_str(&noop).unwrap();
        assert_eq!(cfg4.discovery.paths, vec!["/x/b".to_string()]);
    }

    #[test]
    fn is_inside_detects_nesting() {
        let tmp = unique_tmp();
        let root = tmp.join("root");
        let inside = root.join("space/proj");
        let outside = tmp.join("elsewhere/proj");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        assert!(is_inside(inside.to_str().unwrap(), root.to_str().unwrap()));
        assert!(is_inside(root.to_str().unwrap(), root.to_str().unwrap())); // same dir
        assert!(!is_inside(outside.to_str().unwrap(), root.to_str().unwrap()));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn multi_root_config_yields_one_discovered_tree() {
        let tmp = unique_tmp();
        // Two distinct roots, each with its own space/project.
        let root_a = tmp.join("A");
        let root_b = tmp.join("B");
        init_repo(&root_a.join("ga/pa"), "main");
        init_repo(&root_b.join("gb/pb"), "main");

        let index = ProjectIndex::default();
        let cfg = resolve(
            raw(&[root_a.to_str().unwrap(), root_b.to_str().unwrap()], &[], &[], &[]),
            &index,
        );

        // Only the first root is scanned: its space present, the second's absent.
        assert_eq!(cfg.roots.len(), 1);
        assert!(space(&cfg, "ga").is_some());
        assert!(space(&cfg, "gb").is_none());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn delete_space_guard_refuses_and_accepts() {
        let tmp = unique_tmp();
        let root = tmp.join("Projects");
        let space_dir = root.join("personal");
        let nested = space_dir.join("proj");
        let outside = tmp.join("Outside");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let rs = root.to_str().unwrap();
        // A direct child of the root is a space: accepted, returns the canonical dir.
        let ok = do_delete_space(Some(rs), space_dir.to_str().unwrap()).unwrap();
        assert_eq!(ok, std::fs::canonicalize(&space_dir).unwrap());
        // The root itself, a grandchild (a project), and an outside path are refused.
        assert!(do_delete_space(Some(rs), rs).is_err());
        assert!(do_delete_space(Some(rs), nested.to_str().unwrap()).is_err());
        assert!(do_delete_space(Some(rs), outside.to_str().unwrap()).is_err());
        // No configured root, and a non-existent (e.g. tilde-expanded) root, both err.
        assert!(do_delete_space(None, space_dir.to_str().unwrap()).is_err());
        assert!(do_delete_space(Some("~/tori_nonexistent_base_xyz"), space_dir.to_str().unwrap()).is_err());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn remove_folder_guard_refuses_and_accepts() {
        let tmp = unique_tmp();
        let root = tmp.join("Projects");
        let space_dir = root.join("personal");
        let folder = space_dir.join("notes"); // a project (grandchild of root)
        let outside = tmp.join("Outside");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let rs = root.to_str().unwrap();
        // A folder under a space (grandchild of the root) is accepted.
        let ok = do_remove_folder(Some(rs), folder.to_str().unwrap()).unwrap();
        assert_eq!(ok, std::fs::canonicalize(&folder).unwrap());
        // The root itself, a space (direct child of the root), and an outside path
        // are all refused.
        assert!(do_remove_folder(Some(rs), rs).is_err());
        assert!(do_remove_folder(Some(rs), space_dir.to_str().unwrap()).is_err());
        assert!(do_remove_folder(Some(rs), outside.to_str().unwrap()).is_err());
        // No configured root, and a non-existent root, both err.
        assert!(do_remove_folder(None, folder.to_str().unwrap()).is_err());
        assert!(do_remove_folder(Some("~/tori_nonexistent_base_xyz"), folder.to_str().unwrap()).is_err());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn space_delete_preview_classifies_and_flags() {
        let tmp = unique_tmp();
        let grp = tmp.join("personal");
        std::fs::create_dir_all(&grp).unwrap();

        // A bare remote seeded from a source repo, so clones get an up-to-date upstream.
        let src = tmp.join("src");
        init_repo(&src, "main");
        let remote = tmp.join("remote.git");
        git(&tmp, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        git(&src, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&src, &["push", "-q", "origin", "main"]);

        // pushed: clean clone, main tracks origin/main up to date.
        let pushed = grp.join("pushed");
        git(&tmp, &["clone", "-q", remote.to_str().unwrap(), pushed.to_str().unwrap()]);
        // dirty: clone with an uncommitted change to a tracked file.
        let dirty = grp.join("dirty");
        git(&tmp, &["clone", "-q", remote.to_str().unwrap(), dirty.to_str().unwrap()]);
        std::fs::write(dirty.join("README.md"), "changed").unwrap();
        // unpushed: a fresh local repo whose branch has no upstream.
        let unpushed = grp.join("unpushed");
        init_repo(&unpushed, "main");
        // non-git folder and a loose file.
        std::fs::create_dir_all(grp.join("notes")).unwrap();
        std::fs::write(grp.join("todo.txt"), "x").unwrap();

        let preview = space_delete_preview(grp.to_string_lossy().into_owned()).unwrap();
        let find = |name: &str| preview.entries.iter().find(|e| e.name == name).unwrap();

        let p = find("pushed");
        assert_eq!(p.kind, "repo");
        assert!(!p.dirty && !p.unpushed);
        let d = find("dirty");
        assert_eq!(d.kind, "repo");
        assert!(d.dirty && !d.unpushed);
        let u = find("unpushed");
        assert_eq!(u.kind, "repo");
        assert!(u.unpushed);
        assert_eq!(find("notes").kind, "folder");
        assert_eq!(find("todo.txt").kind, "file");
        assert!(preview.size_bytes > 0);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn project_delete_preview_leads_with_repo_root_status() {
        let tmp = unique_tmp();
        // A plain repo (one commit, no upstream = unpushed) with an uncommitted edit
        // (= dirty).
        let proj = tmp.join("app");
        init_repo(&proj, "main");
        std::fs::write(proj.join("README.md"), "changed").unwrap(); // now dirty
        std::fs::create_dir_all(proj.join("src")).unwrap();

        let preview = project_delete_preview(proj.to_string_lossy().into_owned()).unwrap();
        // The first entry is the repo root itself, flagged with its own state.
        let root = &preview.entries[0];
        assert_eq!(root.kind, "repo");
        assert!(root.name.contains("repository root"));
        assert!(root.dirty && root.unpushed);
        // Children follow (the working tree's own contents).
        assert!(preview.entries.iter().any(|e| e.name == "src" && e.kind == "folder"));
        assert!(preview.size_bytes > 0);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn project_delete_preview_flags_worktrees_not_bare() {
        let tmp = unique_tmp();
        // A bare+worktree container with one worktree, in place.
        let proj = tmp.join("wt");
        std::fs::create_dir_all(&proj).unwrap();
        git(&proj, &["init", "--bare", "-q", ".bare"]);
        std::fs::write(proj.join(".git"), "gitdir: ./.bare\n").unwrap();
        git(&proj, &["worktree", "add", "--orphan", "-b", "main", "main"]);

        let preview = project_delete_preview(proj.to_string_lossy().into_owned()).unwrap();
        // The worktree folder (its own `.git` file) is a repo; `.bare` (git plumbing,
        // no inner `.git`) is a plain folder, not mislabelled a repo.
        let main = preview.entries.iter().find(|e| e.name == "main").unwrap();
        assert_eq!(main.kind, "repo");
        let bare = preview.entries.iter().find(|e| e.name == ".bare").unwrap();
        assert_eq!(bare.kind, "folder");

        std::fs::remove_dir_all(&tmp).ok();
    }
}
