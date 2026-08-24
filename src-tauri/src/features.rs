// A Feature: one shared branch (`feat/<slug>`) checked out as one worktree per
// member repository, recorded in a sidecar so the group has an order, display
// names and a state git cannot express. See [[adr_feature_workspace]] and
// [[concept_feature_workspace]].
//
// Two shapes are load-bearing.
//
//   * **A read reconciles state, never membership.** Unlike `attempts.rs`, a
//     member whose worktree or repo is gone stays in the record with a state
//     naming what is missing, because the UI owes the user a repair action, not
//     a smaller Feature.
//   * **Every access to the file, the reconciling read included, takes the
//     `features` named lock.** The reconcile is a load-compute-save, and a
//     creation loop flipping members on another thread would otherwise have its
//     flips overwritten by a stale copy.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::exec::{common_dir, named_lock, repo_lock};
use crate::owned_state::write_atomically;
use crate::worktree::{branch_exists, branch_has_worktree, create_worktree_in, list_worktrees_body, remote_branch_exists};

/// The member's creation is in flight: recorded before the first `worktree
/// add`, so a crash mid-loop leaves a retryable member, not a lost one.
pub const PENDING: &str = "pending";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MemberState {
    Present,
    /// Also the value a record without a state reads as: the reconcile
    /// rewrites it on the next read anyway.
    #[default]
    WorktreeMissing,
    RepoMissing,
    Failed { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub repo_path: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub state: MemberState,
    #[serde(default)]
    pub order: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feature {
    pub id: String,
    pub name: String,
    /// `feat/<slug>`, frozen at creation; the name stays free to change.
    pub branch: String,
    #[serde(default)]
    pub members: Vec<Member>,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeatureFile {
    #[serde(default)]
    features: Vec<Feature>,
}

/// The file the records live in. A handle rather than a fixed path so every
/// rule below runs against a temp store in tests.
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn default_location() -> Self {
        Self::at(dirs::home_dir().unwrap_or_default().join(".config/sway/features.json"))
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Lenient like every other owned store: a missing or corrupt file is an
    /// empty set, never an error.
    fn load(&self) -> FeatureFile {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn save(&self, file: &FeatureFile) -> Result<(), String> {
        let text = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
        write_atomically(&self.path, &text)
    }

    /// Load, edit, save, under the store's lock.
    fn mutate<T>(&self, f: impl FnOnce(&mut FeatureFile) -> Result<T, String>) -> Result<T, String> {
        let lock = named_lock("features");
        let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut file = self.load();
        let out = f(&mut file)?;
        self.save(&file)?;
        Ok(out)
    }
}

/// The branch slug for a Feature name: `worktree::slugify`'s character rule,
/// then lowercased, runs of `-` collapsed, edges trimmed.
pub fn feature_slug(name: &str) -> Result<String, String> {
    let raw = crate::worktree::slugify(name.trim()).to_ascii_lowercase();
    let mut slug = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c == '-' && slug.ends_with('-') {
            continue;
        }
        slug.push(c);
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        return Err("Feature name has no usable characters".into());
    }
    Ok(slug)
}

pub fn feature_branch(slug: &str) -> String {
    format!("feat/{slug}")
}

pub fn new_id(slug: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{slug}-{nanos:x}")
}

fn canon(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn same_path(a: &str, b: &str) -> bool {
    canon(a) == canon(b)
}

/// Every Feature, each member's `state` refreshed against git. Membership is
/// never changed by a read.
pub fn list_features(store: &Store) -> Vec<Feature> {
    let lock = named_lock("features");
    let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = store.load();
    let mut changed = false;
    for feature in &mut file.features {
        for member in &mut feature.members {
            let next = reconcile_member(member, &feature.branch);
            if next != member.state {
                member.state = next;
                changed = true;
            }
        }
    }
    if changed {
        let _ = store.save(&file);
    }
    file.features
}

/// Three checks, in order: the repo answers git at all, the recorded worktree
/// is on disk and listed, and the listed checkout is still on the Feature
/// branch. A folder deleted without `git worktree prune` is still listed, which
/// is why the disk check is separate from the list.
fn reconcile_member(member: &Member, branch: &str) -> MemberState {
    if !crate::worktree::repo_readable(&member.repo_path) {
        return MemberState::RepoMissing;
    }
    let Some(wt) = member.worktree_path.as_deref() else {
        return match &member.state {
            failed @ MemberState::Failed { .. } => failed.clone(),
            _ => MemberState::WorktreeMissing,
        };
    };
    if !Path::new(wt).is_dir() {
        return MemberState::WorktreeMissing;
    }
    let target = canon(wt);
    let listed = crate::worktree::list_worktrees_body(member.repo_path.clone())
        .ok()
        .and_then(|all| all.into_iter().find(|w| canon(&w.path) == target));
    match listed {
        Some(w) if w.branch == branch => MemberState::Present,
        _ => MemberState::WorktreeMissing,
    }
}

fn feature_mut<'a>(file: &'a mut FeatureFile, feature_id: &str) -> Result<&'a mut Feature, String> {
    file.features
        .iter_mut()
        .find(|f| f.id == feature_id)
        .ok_or_else(|| format!("No Feature with id {feature_id}"))
}

fn member_mut<'a>(feature: &'a mut Feature, repo_path: &str) -> Result<&'a mut Member, String> {
    feature
        .members
        .iter_mut()
        .find(|m| same_path(&m.repo_path, repo_path))
        .ok_or_else(|| format!("{repo_path} is not a member of {}", feature.name))
}

/// Detach the record only. The worktree stays on disk; removing it is the
/// existing `remove_worktree` flow's job, with its own guards.
pub fn remove_member(store: &Store, feature_id: &str, repo_path: &str) -> Result<(), String> {
    store.mutate(|file| {
        let feature = feature_mut(file, feature_id)?;
        let before = feature.members.len();
        feature.members.retain(|m| !same_path(&m.repo_path, repo_path));
        if feature.members.len() == before {
            return Err(format!("{repo_path} is not a member of {}", feature.name));
        }
        Ok(())
    })
}

/// `repo_paths` in the wanted order; members it does not name keep their
/// relative order after the named ones.
pub fn reorder_members(store: &Store, feature_id: &str, repo_paths: &[String]) -> Result<(), String> {
    store.mutate(|file| {
        let feature = feature_mut(file, feature_id)?;
        let rank = |m: &Member| {
            repo_paths
                .iter()
                .position(|p| same_path(p, &m.repo_path))
                .unwrap_or(repo_paths.len())
        };
        feature.members.sort_by_key(|m| (rank(m), m.order));
        for (i, m) in feature.members.iter_mut().enumerate() {
            m.order = i as u32;
        }
        Ok(())
    })
}

pub fn rename_member(store: &Store, feature_id: &str, repo_path: &str, display_name: &str) -> Result<(), String> {
    let display_name = display_name.trim();
    if display_name.is_empty() {
        return Err("Display name is empty".into());
    }
    store.mutate(|file| {
        member_mut(feature_mut(file, feature_id)?, repo_path)?.display_name = display_name.to_string();
        Ok(())
    })
}

/// The name only. The slug, and with it every member's branch, was frozen at
/// creation: renaming branches across repos is a git op this store never runs.
pub fn rename_feature(store: &Store, feature_id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Feature name is empty".into());
    }
    store.mutate(|file| {
        feature_mut(file, feature_id)?.name = name.to_string();
        Ok(())
    })
}

/// The record only. Worktrees and branches stay exactly as they are.
pub fn delete_feature(store: &Store, feature_id: &str) -> Result<(), String> {
    store.mutate(|file| {
        let before = file.features.len();
        file.features.retain(|f| f.id != feature_id);
        if file.features.len() == before {
            return Err(format!("No Feature with id {feature_id}"));
        }
        Ok(())
    })
}

// --- creation ---

/// Where a member's worktree goes. A bare container takes it directly, the
/// way every other worktree there is laid out; a plain repo gets it under
/// `.sway/worktrees`, kept out of the repo by `.git/info/exclude`.
pub(crate) fn feature_container(repo: &str) -> Result<PathBuf, String> {
    // A vanished repo lists as empty, which would read as "plain" and create
    // `.sway/worktrees` at a path that no longer holds a repository.
    if !crate::worktree::repo_readable(repo) {
        return Err(format!("{repo} is not a git repository"));
    }
    let is_container = list_worktrees_body(repo.to_string())?.iter().any(|w| w.is_bare);
    if is_container {
        return Ok(PathBuf::from(repo));
    }
    crate::git::exclude_from_repo(repo, crate::workspace_settings::SWAY_DIR);
    let (sway, worktrees) = crate::fs::FEATURE_WORKTREES;
    let dir = Path::new(repo).join(sway).join(worktrees);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

fn repo_display_name(repo: &str) -> String {
    Path::new(repo)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo.to_string())
}

/// Two paths naming one repository (a worktree and its main checkout share a
/// common dir) are one member: the same branch cannot be checked out twice.
fn same_repo(a: &str, b: &str) -> bool {
    common_dir(a) == common_dir(b)
}

fn pending_member(repo: &str, order: u32) -> Member {
    Member {
        repo_path: repo.to_string(),
        display_name: repo_display_name(repo),
        worktree_path: None,
        state: MemberState::Failed { reason: PENDING.into() },
        order,
    }
}

/// Create one member's worktree and flip its record. The repo lock covers the
/// git work only; the store is re-loaded under its own lock for the flip, so
/// a concurrent read never overwrites this member with a stale copy.
fn build_member(store: &Store, feature_id: &str, repo: &str, branch: &str) -> Result<(), String> {
    let outcome = {
        let lock = repo_lock(repo);
        let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        feature_container(repo).and_then(|c| create_worktree_in(repo, branch, &c))
    };
    store.mutate(|file| {
        let member = member_mut(feature_mut(file, feature_id)?, repo)?;
        match outcome {
            Ok(path) => {
                member.worktree_path = Some(path.to_string_lossy().into_owned());
                member.state = MemberState::Present;
            }
            Err(reason) => member.state = MemberState::Failed { reason },
        }
        Ok(())
    })
}

fn load_feature(store: &Store, feature_id: &str) -> Result<Feature, String> {
    let lock = named_lock("features");
    let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = store.load();
    feature_mut(&mut file, feature_id).map(|f| f.clone())
}

/// Record first, then one worktree per member in order. A member that fails
/// stays recorded as `Failed` with git's reason and the loop moves on, so the
/// Feature exists even when one repo has a colliding folder.
pub fn create_feature(store: &Store, name: &str, repos: &[String]) -> Result<Feature, String> {
    let name = name.trim();
    let slug = feature_slug(name)?;
    let branch = feature_branch(&slug);
    if repos.is_empty() {
        return Err("A Feature needs at least one repository".into());
    }
    for (i, repo) in repos.iter().enumerate() {
        if repos[..i].iter().any(|seen| same_repo(seen, repo)) {
            return Err(format!("{repo} is listed twice"));
        }
    }

    let id = new_id(&slug);
    store.mutate(|file| {
        if let Some(taken) = file.features.iter().find(|f| f.branch == branch) {
            return Err(format!("Feature \"{}\" already uses {branch}", taken.name));
        }
        file.features.push(Feature {
            id: id.clone(),
            name: name.to_string(),
            branch: branch.clone(),
            members: repos.iter().enumerate().map(|(i, r)| pending_member(r, i as u32)).collect(),
            created_at: crate::owned_state::now_ms(),
        });
        Ok(())
    })?;

    for repo in repos {
        build_member(store, &id, repo, &branch)?;
    }
    load_feature(store, &id)
}

/// Re-run one member's creation. A `Present` member simply re-resolves to the
/// worktree it already has.
pub fn retry_member(store: &Store, feature_id: &str, repo: &str) -> Result<Feature, String> {
    let feature = load_feature(store, feature_id)?;
    if !feature.members.iter().any(|m| same_path(&m.repo_path, repo)) {
        return Err(format!("{repo} is not a member of {}", feature.name));
    }
    build_member(store, feature_id, repo, &feature.branch)?;
    load_feature(store, feature_id)
}

/// Append a pending member, then build it: one call ends with a member the
/// user can open, or a `Failed` one with the reason.
pub fn add_member(store: &Store, feature_id: &str, repo: &str) -> Result<Feature, String> {
    let branch = store.mutate(|file| {
        let feature = feature_mut(file, feature_id)?;
        if feature.members.iter().any(|m| same_repo(&m.repo_path, repo)) {
            return Err(format!("{repo} is already a member of {}", feature.name));
        }
        let order = feature.members.len() as u32;
        feature.members.push(pending_member(repo, order));
        Ok(feature.branch.clone())
    })?;
    build_member(store, feature_id, repo, &branch)?;
    load_feature(store, feature_id)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchProbe {
    pub local: bool,
    pub remote: bool,
    pub has_worktree: bool,
}

/// What `feat/<slug>` already is in `repo`, so a dialog can say "will reuse"
/// or "checked out in place" before anything runs.
pub fn probe_feature_branch(repo: &str, slug: &str) -> BranchProbe {
    let branch = feature_branch(slug);
    BranchProbe {
        local: branch_exists(repo, &branch),
        remote: remote_branch_exists(repo, &branch),
        has_worktree: branch_has_worktree(repo, &branch),
    }
}

pub mod commands {
    use std::path::Path;

    use tauri::{AppHandle, Emitter, State};

    use super::{BranchProbe, Feature, MemberState, Store};
    use crate::config::ProjectIndex;
    use crate::exec::blocking;

    /// After a worktree-creating call: adopt the new folders, drop the cached
    /// probes so discovery sees them, and refresh the tree once.
    fn settle(app: &AppHandle, index: &ProjectIndex, feature: &Feature) {
        for m in &feature.members {
            index.evict(Path::new(&m.repo_path));
            if let (MemberState::Present, Some(path)) = (&m.state, &m.worktree_path) {
                let _ = crate::sessions::adopt(path);
            }
        }
        let _ = app.emit("config://changed", ());
    }

    #[tauri::command]
    pub async fn list_features() -> Result<Vec<Feature>, String> {
        blocking("list_features", || Ok(super::list_features(&Store::default_location()))).await
    }

    #[tauri::command]
    pub async fn create_feature(
        app: AppHandle,
        index: State<'_, ProjectIndex>,
        name: String,
        members: Vec<String>,
    ) -> Result<Feature, String> {
        let index = index.inner().clone();
        blocking("create_feature", move || {
            let feature = super::create_feature(&Store::default_location(), &name, &members)?;
            settle(&app, &index, &feature);
            Ok(feature)
        })
        .await
    }

    #[tauri::command]
    pub async fn retry_member(
        app: AppHandle,
        index: State<'_, ProjectIndex>,
        feature_id: String,
        repo_path: String,
    ) -> Result<Feature, String> {
        let index = index.inner().clone();
        blocking("retry_member", move || {
            let feature = super::retry_member(&Store::default_location(), &feature_id, &repo_path)?;
            settle(&app, &index, &feature);
            Ok(feature)
        })
        .await
    }

    #[tauri::command]
    pub async fn add_member(
        app: AppHandle,
        index: State<'_, ProjectIndex>,
        feature_id: String,
        repo_path: String,
    ) -> Result<Feature, String> {
        let index = index.inner().clone();
        blocking("add_member", move || {
            let feature = super::add_member(&Store::default_location(), &feature_id, &repo_path)?;
            settle(&app, &index, &feature);
            Ok(feature)
        })
        .await
    }

    #[tauri::command]
    pub async fn remove_member(feature_id: String, repo_path: String) -> Result<(), String> {
        blocking("remove_member", move || super::remove_member(&Store::default_location(), &feature_id, &repo_path)).await
    }

    #[tauri::command]
    pub async fn reorder_members(feature_id: String, repo_paths: Vec<String>) -> Result<(), String> {
        blocking("reorder_members", move || super::reorder_members(&Store::default_location(), &feature_id, &repo_paths)).await
    }

    #[tauri::command]
    pub async fn rename_member(feature_id: String, repo_path: String, display_name: String) -> Result<(), String> {
        blocking("rename_member", move || {
            super::rename_member(&Store::default_location(), &feature_id, &repo_path, &display_name)
        })
        .await
    }

    #[tauri::command]
    pub async fn rename_feature(feature_id: String, name: String) -> Result<(), String> {
        blocking("rename_feature", move || super::rename_feature(&Store::default_location(), &feature_id, &name)).await
    }

    #[tauri::command]
    pub async fn delete_feature(feature_id: String) -> Result<(), String> {
        blocking("delete_feature", move || super::delete_feature(&Store::default_location(), &feature_id)).await
    }

    #[tauri::command]
    pub async fn probe_feature_branch(repo_path: String, slug: String) -> Result<BranchProbe, String> {
        blocking("probe_feature_branch", move || Ok(super::probe_feature_branch(&repo_path, &slug))).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::owned_state::now_ms;
    use std::process::Command;

    fn unique_tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sway-features-{}-{seq}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        // git reports resolved paths, and macOS resolves `/var` to `/private/var`.
        std::fs::canonicalize(dir).unwrap()
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo(dir: &Path) -> String {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.email", "t@t"]);
        git(dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "first"]);
        dir.to_string_lossy().into_owned()
    }

    fn member(repo_path: &str, worktree_path: Option<&str>, state: MemberState) -> Member {
        Member {
            repo_path: repo_path.to_string(),
            display_name: "m".into(),
            worktree_path: worktree_path.map(String::from),
            state,
            order: 0,
        }
    }

    fn feature(id: &str, members: Vec<Member>) -> Feature {
        Feature {
            id: id.into(),
            name: id.into(),
            branch: feature_branch(id),
            members,
            created_at: 1,
        }
    }

    fn store_with(tmp: &Path, features: Vec<Feature>) -> Store {
        let store = Store::at(tmp.join("features.json"));
        store.save(&FeatureFile { features }).unwrap();
        store
    }

    #[test]
    fn round_trips_and_tolerates_an_empty_file_and_unknown_fields() {
        let tmp = unique_tmp();
        let store = Store::at(tmp.join("features.json"));
        assert!(store.load().features.is_empty(), "a missing file is an empty set");

        std::fs::write(&store.path, "").unwrap();
        assert!(store.load().features.is_empty(), "an empty file is an empty set");

        let full = feature(
            "auth",
            vec![
                member("/r/a", Some("/r/a/.sway/worktrees/auth"), MemberState::Present),
                member("/r/b", None, MemberState::Failed { reason: "pending".into() }),
            ],
        );
        store.save(&FeatureFile { features: vec![full.clone()] }).unwrap();
        assert_eq!(store.load().features, vec![full]);

        std::fs::write(
            &store.path,
            r#"{"features":[{"id":"x","name":"X","branch":"feat/x","members":[{"repoPath":"/r","mood":"?"}],"future":1}]}"#,
        )
        .unwrap();
        let loaded = store.load().features;
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].members[0].worktree_path, None);
        assert_eq!(loaded[0].members[0].state, MemberState::WorktreeMissing);
        assert_eq!(loaded[0].created_at, 0);

        let text = std::fs::read_to_string(&store.path).unwrap();
        assert!(text.contains("\"repoPath\""), "the wire format is camelCase");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn slug_lowercases_collapses_and_rejects_empty() {
        assert_eq!(feature_slug("Auth Flow").unwrap(), "auth-flow");
        assert_eq!(feature_slug("  Payments!!  v2 ").unwrap(), "payments-v2");
        assert_eq!(feature_slug("keep_dots.and-dashes").unwrap(), "keep_dots.and-dashes");
        assert!(feature_slug("!!!").is_err());
        assert!(feature_slug("").is_err());
        assert_eq!(feature_branch("auth"), "feat/auth");
        assert!(new_id("auth").starts_with("auth-"));
    }

    #[test]
    fn a_deleted_repo_reads_as_repo_missing_and_stays_in_the_file() {
        let tmp = unique_tmp();
        let gone = tmp.join("gone");
        let repo_path = repo(&gone);
        let wt = tmp.join("wt");
        git(&gone, &["worktree", "add", "-q", "-b", "feat/f", &wt.to_string_lossy()]);
        let store = store_with(&tmp, vec![feature("f", vec![member(&repo_path, Some(&wt.to_string_lossy()), MemberState::Present)])]);

        std::fs::remove_dir_all(&gone).unwrap();
        let listed = list_features(&store);
        assert_eq!(listed[0].members[0].state, MemberState::RepoMissing);
        assert_eq!(store.load().features[0].members.len(), 1, "a read never drops a member");
        assert_eq!(store.load().features[0].members[0].state, MemberState::RepoMissing);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_folder_deleted_without_prune_reads_as_worktree_missing() {
        let tmp = unique_tmp();
        let r = tmp.join("r");
        let repo_path = repo(&r);
        let wt = tmp.join("wt");
        let wt_str = wt.to_string_lossy().into_owned();
        git(&r, &["worktree", "add", "-q", "-b", "feat/f", &wt_str]);
        let store = store_with(&tmp, vec![feature("f", vec![member(&repo_path, Some(&wt_str), MemberState::WorktreeMissing)])]);

        assert_eq!(list_features(&store)[0].members[0].state, MemberState::Present, "a live worktree on the branch is present");

        std::fs::remove_dir_all(&wt).unwrap();
        assert_eq!(list_features(&store)[0].members[0].state, MemberState::WorktreeMissing);
        assert_eq!(store.load().features[0].members[0].state, MemberState::WorktreeMissing, "and the file was written back");
        assert_eq!(store.load().features[0].members[0].worktree_path.as_deref(), Some(wt_str.as_str()), "only state changes");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_worktree_switched_off_the_branch_reads_as_worktree_missing() {
        let tmp = unique_tmp();
        let r = tmp.join("r");
        let repo_path = repo(&r);
        let wt = tmp.join("wt");
        let wt_str = wt.to_string_lossy().into_owned();
        git(&r, &["worktree", "add", "-q", "-b", "feat/f", &wt_str]);
        let store = store_with(&tmp, vec![feature("f", vec![member(&repo_path, Some(&wt_str), MemberState::Present)])]);

        git(&wt, &["checkout", "-q", "-b", "other"]);
        assert_eq!(list_features(&store)[0].members[0].state, MemberState::WorktreeMissing);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_pending_member_stays_failed_until_it_has_a_worktree() {
        let tmp = unique_tmp();
        let repo_path = repo(&tmp.join("r"));
        let pending = MemberState::Failed { reason: "pending".into() };
        let store = store_with(&tmp, vec![feature("f", vec![member(&repo_path, None, pending.clone())])]);
        assert_eq!(list_features(&store)[0].members[0].state, pending);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn remove_member_detaches_the_record_and_leaves_the_worktree() {
        let tmp = unique_tmp();
        let r = tmp.join("r");
        let repo_path = repo(&r);
        let wt = tmp.join("wt");
        let wt_str = wt.to_string_lossy().into_owned();
        git(&r, &["worktree", "add", "-q", "-b", "feat/f", &wt_str]);
        let store = store_with(&tmp, vec![feature("f", vec![member(&repo_path, Some(&wt_str), MemberState::Present)])]);

        remove_member(&store, "f", &repo_path).unwrap();
        assert!(store.load().features[0].members.is_empty());
        assert!(wt.join("a.txt").is_file(), "the worktree is untouched");
        assert!(remove_member(&store, "f", &repo_path).is_err(), "a second removal names the absent member");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn feature_container_is_the_bare_container_or_an_excluded_sway_dir() {
        let tmp = unique_tmp();
        let src = tmp.join("src");
        repo(&src);
        let cont = tmp.join("cont");
        std::fs::create_dir_all(&cont).unwrap();
        let out = Command::new("git")
            .args(["clone", "-q", "--bare", src.to_str().unwrap(), cont.join(".bare").to_str().unwrap()])
            .output()
            .unwrap();
        assert!(out.status.success());
        std::fs::write(cont.join(".git"), "gitdir: ./.bare\n").unwrap();
        let cont_s = cont.to_string_lossy().into_owned();
        assert_eq!(feature_container(&cont_s).unwrap(), cont);

        let plain = tmp.join("plain");
        let plain_s = repo(&plain);
        assert_eq!(feature_container(&plain_s).unwrap(), plain.join(".sway/worktrees"));
        assert!(plain.join(".sway/worktrees").is_dir());
        let exclude = || std::fs::read_to_string(plain.join(".git/info/exclude")).unwrap_or_default();
        assert_eq!(exclude().lines().filter(|l| *l == ".sway/").count(), 1);
        feature_container(&plain_s).unwrap();
        assert_eq!(exclude().lines().filter(|l| *l == ".sway/").count(), 1, "idempotent");

        let gone = tmp.join("gone");
        let gone_s = repo(&gone);
        std::fs::remove_dir_all(&gone).unwrap();
        assert!(feature_container(&gone_s).is_err());
        assert!(!gone.exists(), "nothing is created where the repo used to be");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn create_feature_records_first_and_keeps_going_past_a_failed_member() {
        let tmp = unique_tmp();
        let a = repo(&tmp.join("a"));
        let b = repo(&tmp.join("b"));
        let c = repo(&tmp.join("c"));
        // Both folder names the picker would try are taken in b.
        std::fs::create_dir_all(tmp.join("b/.sway/worktrees/x")).unwrap();
        std::fs::create_dir_all(tmp.join("b/.sway/worktrees/feat-x")).unwrap();
        let store = Store::at(tmp.join("features.json"));

        let f = create_feature(&store, "X", &[a.clone(), b.clone(), c.clone()]).unwrap();
        assert_eq!(f.branch, "feat/x");
        assert!(f.id.starts_with("x-"));
        let states: Vec<_> = f.members.iter().map(|m| &m.state).collect();
        assert_eq!(states[0], &MemberState::Present);
        assert!(matches!(states[1], MemberState::Failed { reason } if reason.contains("refusing to overwrite")), "{:?}", states[1]);
        assert_eq!(states[2], &MemberState::Present);
        assert_eq!(f.members.iter().map(|m| m.order).collect::<Vec<_>>(), [0, 1, 2]);
        assert_eq!(f.members[0].display_name, "a");
        let wt_a = PathBuf::from(f.members[0].worktree_path.as_deref().unwrap());
        assert_eq!(wt_a, tmp.join("a/.sway/worktrees/x"));
        assert!(wt_a.join("a.txt").is_file());
        assert_eq!(f.members[1].worktree_path, None);

        // The record is what a reader sees between members: the reconcile agrees.
        let listed = list_features(&store);
        assert_eq!(listed[0].members.iter().map(|m| m.state.clone()).collect::<Vec<_>>(), f.members.iter().map(|m| m.state.clone()).collect::<Vec<_>>());

        // The plain repo stays clean and its walkers do not see the worktree.
        let status = Command::new("git").arg("-C").arg(&a).args(["status", "--porcelain"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&status.stdout).trim(), "");
        let files = crate::fs::list_project_files_body(a.clone()).unwrap();
        assert!(files.iter().all(|p| !p.contains(".sway/worktrees")), "{files:?}");
        let hits = crate::search::grep_project(a.clone(), "one".into(), crate::search::SearchOptions::default(), 50).unwrap();
        assert!(!hits.matches.is_empty());
        assert!(hits.matches.iter().all(|m| !m.path.contains(".sway/worktrees")));

        // Guards: same slug, same repo twice, a worktree of a member is the member.
        assert!(create_feature(&store, "x", std::slice::from_ref(&a)).unwrap_err().contains("already uses feat/x"));
        assert!(create_feature(&store, "Y", &[a.clone(), a.clone()]).unwrap_err().contains("listed twice"));
        let wt_a_s = wt_a.to_string_lossy().into_owned();
        assert!(create_feature(&store, "Y", &[a.clone(), wt_a_s]).unwrap_err().contains("listed twice"));
        assert!(create_feature(&store, "Z", &[]).is_err());
        assert_eq!(store.load().features.len(), 1, "a rejected create leaves no record");

        // Retry flips the failed member once the collision is gone.
        std::fs::remove_dir_all(tmp.join("b/.sway/worktrees/x")).unwrap();
        std::fs::remove_dir_all(tmp.join("b/.sway/worktrees/feat-x")).unwrap();
        let f = retry_member(&store, &f.id, &b).unwrap();
        assert_eq!(f.members[1].state, MemberState::Present);
        assert_eq!(f.members[1].worktree_path.as_deref(), Some(tmp.join("b/.sway/worktrees/x").to_str().unwrap()));
        assert!(retry_member(&store, &f.id, &c).is_ok(), "a present member re-resolves");
        assert!(retry_member(&store, &f.id, "/nope").is_err());

        // add_member ends present with a worktree on disk.
        let d = repo(&tmp.join("d"));
        let f = add_member(&store, &f.id, &d).unwrap();
        assert_eq!(f.members.len(), 4);
        assert_eq!(f.members[3].order, 3);
        assert_eq!(f.members[3].state, MemberState::Present);
        assert!(tmp.join("d/.sway/worktrees/x/a.txt").is_file());
        assert!(add_member(&store, &f.id, &d).unwrap_err().contains("already a member"));

        let probe = probe_feature_branch(&d, "x");
        assert_eq!(probe, BranchProbe { local: true, remote: false, has_worktree: true });
        let fresh = repo(&tmp.join("e"));
        assert_eq!(probe_feature_branch(&fresh, "x"), BranchProbe { local: false, remote: false, has_worktree: false });
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn reorder_rename_and_delete_touch_only_the_record() {
        let tmp = unique_tmp();
        let store = store_with(
            &tmp,
            vec![feature(
                "f",
                vec![
                    Member { order: 0, ..member("/r/a", None, MemberState::WorktreeMissing) },
                    Member { order: 1, ..member("/r/b", None, MemberState::WorktreeMissing) },
                    Member { order: 2, ..member("/r/c", None, MemberState::WorktreeMissing) },
                ],
            )],
        );

        reorder_members(&store, "f", &["/r/c".to_string()]).unwrap();
        let members = store.load().features[0].members.clone();
        assert_eq!(members.iter().map(|m| m.repo_path.as_str()).collect::<Vec<_>>(), ["/r/c", "/r/a", "/r/b"]);
        assert_eq!(members.iter().map(|m| m.order).collect::<Vec<_>>(), [0, 1, 2]);

        rename_member(&store, "f", "/r/a", " Backend ").unwrap();
        assert_eq!(store.load().features[0].members[1].display_name, "Backend");
        assert!(rename_member(&store, "f", "/r/a", "  ").is_err());

        rename_feature(&store, "f", "Auth v2").unwrap();
        let f = store.load().features[0].clone();
        assert_eq!(f.name, "Auth v2");
        assert_eq!(f.branch, "feat/f", "the branch is frozen");

        assert!(delete_feature(&store, "nope").is_err());
        delete_feature(&store, "f").unwrap();
        assert!(store.load().features.is_empty());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
