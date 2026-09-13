// Git worktree management, so a branch can get its own working directory.
// A worktree "project" is a `.bare` container holding per-branch worktree folders
// (see [[concept_folder_anchored_sessions]] / [[component_project_discovery]]).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Directory under a bare container holding files shared into every worktree
/// (symlinked at creation, managed from the Shared in worktrees page). A
/// bare-container convention; absent until the first shared file is added.
pub(crate) const SHARED_DIR: &str = ".shared";

/// Where a container keeps its shared entries, existing or not. Spelled once so
/// `shared.rs` and the linker below cannot disagree about the folder's name.
pub(crate) fn shared_dir(container: &Path) -> PathBuf {
    container.join(SHARED_DIR)
}

#[derive(Serialize)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
    /// The porcelain `bare` record: the container's own `.bare`, not a checkout.
    #[serde(skip)]
    pub is_bare: bool,
}

/// Can git read this path as a repository? `list_worktrees_body` answers an
/// empty list for both "no worktrees" and "not a repo", so a caller that must
/// tell a vanished repo from an empty one asks this first.
pub(crate) fn repo_readable(repo: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--git-dir"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn list_worktrees(repo_path: String) -> Result<Vec<Worktree>, String> {
    crate::exec::blocking("list_worktrees", move || list_worktrees_body(repo_path)).await
}

pub(crate) fn list_worktrees_body(repo_path: String) -> Result<Vec<Worktree>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(vec![]);
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let mut result = Vec::new();
    let mut cur_path: Option<String> = None;
    let mut cur_branch = String::new();
    let mut cur_bare = false;
    let mut first = true;

    let flush = |path: &mut Option<String>, branch: &mut String, bare: &mut bool, first: &mut bool, out: &mut Vec<Worktree>| {
        if let Some(p) = path.take() {
            out.push(Worktree {
                path: p,
                branch: std::mem::take(branch),
                is_main: *first,
                is_bare: std::mem::take(bare),
            });
            *first = false;
        }
    };

    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            // New record begins; flush the previous.
            flush(&mut cur_path, &mut cur_branch, &mut cur_bare, &mut first, &mut result);
            cur_path = Some(p.to_string());
            cur_branch = String::new();
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = b.trim_start_matches("refs/heads/").to_string();
        } else if line == "detached" {
            cur_branch = "(detached)".to_string();
        } else if line == "bare" {
            cur_bare = true;
        }
    }
    flush(&mut cur_path, &mut cur_branch, &mut cur_bare, &mut first, &mut result);
    result.retain(worked_in);
    Ok(result)
}

/// A checkout in a hidden folder is infrastructure, not a branch anyone works
/// in. Scribe's `/wiki-init` puts `.wiki` on an orphan branch and checks it out
/// beside the worktrees, so git lists it like any other: unfiltered it becomes a
/// branch row in the sidebar and a fourth place every shared file is missing
/// from.
///
/// The bare record is exempt, since callers ask for it by name, and so is the
/// main one: a repo cloned into a hidden folder (`~/.dotfiles`) is still a repo
/// someone opened on purpose.
fn worked_in(w: &Worktree) -> bool {
    w.is_bare
        || w.is_main
        || !Path::new(&w.path)
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

// --- helpers ---

fn git_ok(repo: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Drop admin entries whose folder is gone. Best-effort: a repo that cannot run
/// it is one the caller is about to fail on anyway.
///
/// Worth its own name because git keeps listing a worktree deleted outside Sway,
/// and `list_worktrees_body` does not parse the `prunable` field that would say
/// so. Every caller that reads the list to decide whether a worktree exists has
/// to prune first, or it adopts a folder that is not there.
pub(crate) fn prune_worktrees(repo: &str) {
    let _ = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "prune"])
        .output();
}

pub(crate) fn branch_exists(repo: &str, branch: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--verify", &format!("refs/heads/{branch}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Origin's default branch (e.g. `main`) via `origin/HEAD`, None when unset.
fn origin_default(repo: &str) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["symbolic-ref", "refs/remotes/origin/HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .strip_prefix("refs/remotes/origin/")
        .map(|s| s.to_string())
}

/// Does `origin/<name>` exist as a remote-tracking ref? Lets a new worktree base
/// (and track) a remote-only branch instead of origin's default.
pub(crate) fn remote_branch_exists(repo: &str, name: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{name}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Start point for a brand-new branch's worktree: the matching remote branch
/// (so `-b <name> origin/<name>` tracks it) when present, else origin's default
/// (`origin/<default>`), else None so `worktree add -b` bases on HEAD.
fn new_branch_start_point(repo: &str, branch: &str) -> Option<String> {
    if remote_branch_exists(repo, branch) {
        Some(format!("origin/{branch}"))
    } else {
        origin_default(repo).map(|def| format!("origin/{def}"))
    }
}

/// Does `branch` already have a worktree checked out? If so, creation reuses it.
pub(crate) fn branch_has_worktree(repo: &str, branch: &str) -> bool {
    list_worktrees_body(repo.to_string())
        .map(|wts| wts.iter().any(|w| w.branch == *branch))
        .unwrap_or(false)
}

/// Branch's last path segment (`bug/critical` -> `critical`).
fn last_segment(branch: &str) -> &str {
    branch.rsplit('/').next().unwrap_or(branch)
}

/// Sanitized full-branch slug (`bug/critical` -> `bug-critical`); any character
/// that is not alphanumeric / `-` / `_` / `.` becomes `-`.
pub(crate) fn slugify(branch: &str) -> String {
    branch
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .collect()
}

/// Choose the worktree folder name: the branch's last segment, falling back to a
/// sanitized full-branch slug on collision, then erroring (never overwriting) if
/// that also collides.
fn pick_worktree_folder(container: &Path, branch: &str) -> Result<String, String> {
    let seg = last_segment(branch).trim();
    if seg.is_empty() || seg == "." || seg == ".." {
        return Err("Invalid branch name".into());
    }
    if !container.join(seg).exists() {
        return Ok(seg.to_string());
    }
    let slug = slugify(branch);
    if slug != seg && !container.join(&slug).exists() {
        return Ok(slug);
    }
    Err(format!(
        "Both \"{seg}\" and \"{slug}\" already exist; refusing to overwrite."
    ))
}

/// Symlink each top-level entry of `<container>/.shared/` into a freshly created
/// worktree, skipping names the worktree already has (a branch tracking the file
/// is never clobbered). Bare-container convention; a no-op when `.shared/` is absent.
pub(crate) fn link_shared(container: &Path, worktree: &Path) {
    let shared_dir = shared_dir(container);
    let Ok(entries) = std::fs::read_dir(&shared_dir) else {
        return; // no .shared/ convention here
    };
    for e in entries.flatten() {
        let dest = worktree.join(e.file_name());
        // symlink_metadata does not follow, so an existing file OR symlink counts.
        if dest.symlink_metadata().is_ok() {
            continue;
        }
        let _ = std::os::unix::fs::symlink(e.path(), &dest);
    }
}

/// Create a worktree for `branch` under the bare container `repo_path`. Reuses an
/// existing branch (and its worktree if any); for a new branch, fetches first and
/// bases it on `origin/<branch>` when that remote branch exists (tracking it, so
/// attaching a remote branch works), else origin's default. Folder name is
/// collision-safe (see
/// `pick_worktree_folder`); shared `.shared/` files are linked in afterward.
/// Answers the worktree's folder path, so the caller can move the selection onto
/// the thing it just made (a reused worktree answers its existing path).
#[tauri::command]
pub async fn create_worktree(app: AppHandle, repo_path: String, branch: String) -> Result<String, String> {
    crate::exec::git_write("create_worktree", repo_path.clone(), move || create_worktree_body(app, repo_path, branch)).await
}

pub(crate) fn create_worktree_body(app: AppHandle, repo_path: String, branch: String) -> Result<String, String> {
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("Branch name is empty".into());
    }

    // Already checked out somewhere: reuse it rather than make a duplicate.
    if let Some(existing) = list_worktrees_body(repo_path.clone())?.into_iter().find(|w| w.branch == branch) {
        return Ok(existing.path);
    }

    let target = create_worktree_in(&repo_path, &branch, Path::new(&repo_path))?;
    let target_str = target.to_string_lossy().into_owned();
    // Sway created this folder: adopt it so reusing a path that held old sessions
    // does not surface them as historical.
    let _ = crate::sessions::adopt(&target_str);
    let _ = app.emit("config://changed", ());
    Ok(target_str)
}

/// The creation core, parameterised on where the folder goes: `container` is
/// the bare container itself, or `<repo>/.sway/worktrees` for a plain repo. A
/// branch that already has a worktree yields that worktree's path, except the
/// main checkout of a plain repo, which is the user's own and never adopted.
/// No adopt, no emit: the caller decides what the new folder means.
pub(crate) fn create_worktree_in(repo: &str, branch: &str, container: &Path) -> Result<PathBuf, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Branch name is empty".into());
    }
    if let Some(existing) = list_worktrees_body(repo.to_string())?.into_iter().find(|w| w.branch == branch) {
        if existing.is_main && !existing.is_bare {
            return Err(format!("Branch \"{branch}\" is checked out in the repository itself; switch it away first."));
        }
        return Ok(PathBuf::from(existing.path));
    }

    let folder = pick_worktree_folder(container, branch)?;
    let target = container.join(&folder);
    let target_str = target.to_string_lossy().into_owned();

    if branch_exists(repo, branch) {
        git_ok(repo, &["worktree", "add", &target_str, branch])?;
    } else {
        // New branch: refresh origin so remote refs are current (best-effort: a
        // repo without a remote simply has no fetch to do), then base off the
        // matching remote branch when one exists (so attaching origin/<name>
        // tracks it), else origin's default, else HEAD.
        let _ = Command::new("git")
            .arg("-C")
            .arg(repo)
            .arg("fetch")
            .output();
        let mut args: Vec<String> = vec![
            "worktree".into(),
            "add".into(),
            "-b".into(),
            branch.to_string(),
            target_str.clone(),
        ];
        if let Some(start) = new_branch_start_point(repo, branch) {
            args.push(start);
        }
        let argrefs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_ok(repo, &argrefs)?;
    }

    link_shared(container, &target);
    Ok(target)
}

/// Is the worktree dirty in a way that should block removal? Tracked
/// modifications and genuine untracked files count; an untracked symlink that
/// points into the sibling `.shared/` does NOT (we created it and it is a
/// regenerable pointer to a shared file, not user work). Without this exception a
/// freshly created worktree that linked any `.shared/` file would read as dirty and
/// could never be removed. See [[gotchas#shared-symlinks-read-as-untracked-and-block-worktree-removal]].
fn tree_dirty(worktree: &Path) -> Result<bool, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let shared_canon = worktree
        .parent()
        .map(|c| c.join(SHARED_DIR))
        .and_then(|d| std::fs::canonicalize(d).ok());

    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix("?? ") {
            // An untracked entry: a .shared symlink is not dirt, anything else is.
            if let Some(ref lc) = shared_canon {
                let p = worktree.join(name);
                let is_link = p.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);
                if is_link {
                    if let Ok(target) = std::fs::canonicalize(&p) {
                        if target.starts_with(lc) {
                            continue;
                        }
                    }
                }
            }
            return Ok(true);
        }
        // Any tracked change (M/A/D/R/...).
        return Ok(true);
    }
    Ok(false)
}

/// Friendly pre-check before removal (the UI surfaces a clear message). Same
/// `.shared`-aware rule the removal itself enforces.
#[tauri::command]
pub async fn worktree_dirty(path: String) -> Result<bool, String> {
    crate::exec::blocking("worktree_dirty", move || worktree_dirty_body(path)).await
}

pub(crate) fn worktree_dirty_body(path: String) -> Result<bool, String> {
    tree_dirty(Path::new(&path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub dirty: bool,
    pub unpushed: bool,
    pub has_remote: bool,
}

/// The `(remote, ref)` a branch pushes to, from its tracking config
/// (`branch.<b>.remote` + `branch.<b>.merge`), or None when it tracks nothing. The
/// ref is the branch name on the remote (which can differ from the local name). Run
/// against any path in the repo (a worktree resolves to the shared config).
pub(crate) fn branch_push_target(repo: &Path, branch: &str) -> Option<(String, String)> {
    let cfg = |key: String| {
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["config", "--get", &key])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let remote = cfg(format!("branch.{branch}.remote"))?;
    let merge = cfg(format!("branch.{branch}.merge"))?;
    let refname = merge.strip_prefix("refs/heads/").unwrap_or(&merge).to_string();
    Some((remote, refname))
}

/// Whether a ref exists in `repo`.
fn ref_exists(repo: &Path, refname: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--verify", "--quiet", refname])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// The `(remote, ref)` to delete for a branch, or None when no remote branch is
/// known. Prefers the branch's tracking config (so a differently-named upstream
/// still resolves), then falls back to a same-named remote-tracking ref (origin
/// first) for a branch that was pushed but never set up to track, which is why the
/// config-only check missed it.
pub(crate) fn resolve_remote_branch(repo: &Path, branch: &str) -> Option<(String, String)> {
    if let Some(target) = branch_push_target(repo, branch) {
        return Some(target);
    }
    let remotes = Command::new("git")
        .arg("-C")
        .arg(repo)
        .arg("remote")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_default();
    // Origin first, then the rest, so the common case resolves to origin.
    let ordered = remotes
        .iter()
        .filter(|r| *r == "origin")
        .chain(remotes.iter().filter(|r| *r != "origin"));
    for remote in ordered {
        if ref_exists(repo, &format!("refs/remotes/{remote}/{branch}")) {
            return Some((remote.clone(), branch.to_string()));
        }
    }
    None
}

/// The worktree's currently checked-out branch, or None for a detached/unborn HEAD.
fn branch_at(path: &Path) -> Option<String> {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// True when this worktree's checked-out branch has commits not on its remote: it
/// is ahead of its upstream, or has no upstream at all (a local-only branch) while
/// carrying at least one commit. A detached / unborn HEAD has nothing to push.
fn branch_unpushed(worktree: &Path) -> bool {
    let cap = |args: &[&str]| {
        Command::new("git")
            .arg("-C")
            .arg(worktree)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    // Detached or unborn HEAD: nothing meaningful to push.
    if cap(&["symbolic-ref", "--quiet", "--short", "HEAD"]).is_none() {
        return false;
    }
    match cap(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) {
        // Has an upstream: unpushed when at least one commit is ahead of it.
        Some(_) => cap(&["rev-list", "--count", "@{upstream}..HEAD"])
            .and_then(|s| s.parse::<u64>().ok())
            .map(|n| n > 0)
            .unwrap_or(false),
        // No upstream: unpushed if the branch has any commit at all.
        None => cap(&["rev-parse", "--verify", "--quiet", "HEAD"]).is_some(),
    }
}

/// Removal-preview status for a worktree: uncommitted changes (`.shared`-aware) and
/// unpushed commits, so the confirm dialog can warn about work about to be lost.
#[tauri::command]
pub async fn worktree_status(path: String) -> Result<WorktreeStatus, String> {
    crate::exec::blocking("worktree_status", move || worktree_status_body(path)).await
}

pub(crate) fn worktree_status_body(path: String) -> Result<WorktreeStatus, String> {
    let p = Path::new(&path);
    let has_remote = branch_at(p).and_then(|b| resolve_remote_branch(p, &b)).is_some();
    Ok(WorktreeStatus { dirty: tree_dirty(p)?, unpushed: branch_unpushed(p), has_remote })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    pub unpushed: bool,
    pub has_remote: bool,
}

/// True when a *named* branch (not necessarily checked out) has commits not on its
/// remote: ahead of its upstream, or no upstream at all (local-only). When it tracks
/// a remote but that ref is not fetched locally (so the count can't be computed), we
/// assume unpushed, warning rather than missing unsaved commits.
fn named_branch_unpushed(repo: &Path, branch: &str) -> bool {
    if branch_push_target(repo, branch).is_none() {
        return true; // local-only branch
    }
    let count = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-list", "--count", &format!("{branch}@{{upstream}}..{branch}")])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    match count {
        Some(s) => s.parse::<u64>().map(|n| n > 0).unwrap_or(true),
        None => true, // upstream configured but not fetched: can't verify, so warn
    }
}

/// Removal-preview status for a plain-repo branch (not a worktree): whether it has
/// unpushed commits and whether it tracks a remote branch (so the confirm dialog can
/// warn, and offer to delete the remote branch too).
#[tauri::command]
pub async fn branch_status(repo: String, branch: String) -> Result<BranchStatus, String> {
    crate::exec::blocking("branch_status", move || branch_status_body(repo, branch)).await
}

pub(crate) fn branch_status_body(repo: String, branch: String) -> Result<BranchStatus, String> {
    let p = Path::new(&repo);
    Ok(BranchStatus {
        unpushed: named_branch_unpushed(p, &branch),
        has_remote: resolve_remote_branch(p, &branch).is_some(),
    })
}

/// Remove a worktree folder and prune its stale admin entry. Unless `force`, refuses
/// a dirty tree (real work) via `tree_dirty`, so nothing is deleted then; the UI's
/// confirm dialog passes `force` once it has shown the uncommitted/unpushed warning.
/// `git worktree remove --force` is always used, to drop the regenerable `.shared/`
/// symlinks git would otherwise treat as untracked. Shared by `remove_worktree` and
/// the delete-plus-branch variant; it does not emit (the caller does).
pub(crate) fn do_remove_worktree(repo_path: &str, worktree_path: &str, force: bool) -> Result<(), String> {
    if !force && tree_dirty(Path::new(worktree_path))? {
        return Err("This worktree has uncommitted changes; commit or discard them first.".into());
    }
    git_ok(repo_path, &["worktree", "remove", "--force", worktree_path])?;
    prune_worktrees(repo_path);
    Ok(())
}

/// Remove a worktree, keeping its branch. The live-use teardown (PTYs, editor tabs)
/// runs in the UI before this is called; `force` skips the dirty guard once the
/// confirm dialog has warned about it.
#[tauri::command(async)]
pub fn remove_worktree(
    app: AppHandle,
    repo_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    let lock = crate::exec::repo_lock(&repo_path);
    let _repo = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    do_remove_worktree(&repo_path, &worktree_path, force)?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Remove a worktree AND delete its branch (`git branch -D`). The folder is removed
/// first; if the branch delete then fails, the folder is already gone, so we emit
/// and surface an explicit partial-outcome message rather than swallow it. `force`
/// matches `remove_worktree`.
#[tauri::command(async)]
pub fn remove_worktree_and_branch(
    app: AppHandle,
    repo_path: String,
    worktree_path: String,
    branch: String,
    force: bool,
) -> Result<(), String> {
    let lock = crate::exec::repo_lock(&repo_path);
    let _repo = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    do_remove_worktree(&repo_path, &worktree_path, force)?;
    let del = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["branch", "-D", &branch])
        .output()
        .map_err(|e| e.to_string())?;
    // The folder is gone regardless of the branch outcome: refresh the tree now.
    let _ = app.emit("config://changed", ());
    if !del.status.success() {
        let stderr = String::from_utf8_lossy(&del.stderr).trim().to_string();
        return Err(format!(
            "Worktree folder removed, but branch \"{branch}\" was not deleted: {stderr}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        // A per-process counter so parallel tests never share a dir (nanos alone
        // can collide between two tests that start in the same instant).
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sway-wt-test-{n}-{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn folder_name_uses_segment_then_slug_then_errors() {
        let tmp = unique_tmp();

        // No collision: the last segment.
        assert_eq!(pick_worktree_folder(&tmp, "bug/critical").unwrap(), "critical");

        // Segment taken: fall back to the full-branch slug.
        std::fs::create_dir(tmp.join("auth")).unwrap();
        assert_eq!(pick_worktree_folder(&tmp, "feature/auth").unwrap(), "feature-auth");

        // Both taken: a clean error, never an overwrite.
        std::fs::create_dir(tmp.join("bugfix-auth")).unwrap();
        assert!(pick_worktree_folder(&tmp, "bugfix/auth").is_err());

        // A bare name with no slash uses itself when free.
        assert_eq!(pick_worktree_folder(&tmp, "main").unwrap(), "main");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn slugify_replaces_separators() {
        assert_eq!(slugify("bug/critical"), "bug-critical");
        assert_eq!(slugify("feature/a b"), "feature-a-b");
        assert_eq!(slugify("keep_dots.and-dashes"), "keep_dots.and-dashes");
    }

    #[test]
    fn link_shared_symlinks_and_skips_existing() {
        let tmp = unique_tmp();
        let container = tmp.join("proj");
        let shared = container.join(".shared");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(shared.join(".env"), "SECRET=1").unwrap();
        std::fs::write(shared.join("config.toml"), "x=1").unwrap();

        let wt = container.join("main");
        std::fs::create_dir_all(&wt).unwrap();
        // A branch already tracks .env: it must not be clobbered.
        std::fs::write(wt.join(".env"), "tracked").unwrap();

        link_shared(&container, &wt);

        // .env stays the tracked regular file (not a symlink).
        let env_meta = std::fs::symlink_metadata(wt.join(".env")).unwrap();
        assert!(!env_meta.file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "tracked");

        // config.toml is freshly symlinked into the worktree.
        let cfg_meta = std::fs::symlink_metadata(wt.join("config.toml")).unwrap();
        assert!(cfg_meta.file_type().is_symlink());
        assert_eq!(std::fs::read_link(wt.join("config.toml")).unwrap(), shared.join("config.toml"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    fn git(dir: &Path, args: &[&str]) {
        Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    }

    #[test]
    fn tree_dirty_ignores_link_symlinks_but_not_real_work() {
        let tmp = unique_tmp();
        // A source repo on `main` to seed a bare clone from.
        let src = tmp.join("src");
        std::fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q"]);
        git(&src, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&src, &["config", "user.email", "t@t.t"]);
        git(&src, &["config", "user.name", "t"]);
        std::fs::write(src.join("a.txt"), "hi").unwrap();
        git(&src, &["add", "."]);
        git(&src, &["commit", "-qm", "init"]);

        // A bare container with one worktree (the layout create_worktree produces).
        let cont = tmp.join("cont");
        std::fs::create_dir_all(&cont).unwrap();
        Command::new("git")
            .args(["clone", "-q", "--bare", src.to_str().unwrap(), cont.join(".bare").to_str().unwrap()])
            .output()
            .unwrap();
        std::fs::write(cont.join(".git"), "gitdir: ./.bare\n").unwrap();
        git(&cont, &["worktree", "add", "-q", "main", "main"]);

        let wt = cont.join("main");
        // A linked .shared/ file shows as untracked but must NOT count as dirty.
        std::fs::create_dir_all(cont.join(".shared")).unwrap();
        std::fs::write(cont.join(".shared/.env"), "x").unwrap();
        std::os::unix::fs::symlink(cont.join(".shared/.env"), wt.join(".env")).unwrap();
        assert!(!tree_dirty(&wt).unwrap(), "a .shared symlink alone is not dirty");

        // A genuine untracked file makes it dirty.
        std::fs::write(wt.join("scratch.txt"), "work").unwrap();
        assert!(tree_dirty(&wt).unwrap(), "a real untracked file is dirty");

        // A tracked modification is dirty too.
        std::fs::remove_file(wt.join("scratch.txt")).unwrap();
        std::fs::write(wt.join("a.txt"), "changed").unwrap();
        assert!(tree_dirty(&wt).unwrap(), "a tracked edit is dirty");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn branch_unpushed_tracks_ahead_and_no_upstream() {
        let tmp = unique_tmp();
        let src = tmp.join("src");
        std::fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q"]);
        git(&src, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&src, &["config", "user.email", "t@t.t"]);
        git(&src, &["config", "user.name", "t"]);
        std::fs::write(src.join("a.txt"), "hi").unwrap();
        git(&src, &["add", "."]);
        git(&src, &["commit", "-qm", "init"]);

        // A bare container with a `main` worktree tracking origin/main.
        let cont = tmp.join("cont");
        std::fs::create_dir_all(&cont).unwrap();
        Command::new("git")
            .args(["clone", "-q", "--bare", src.to_str().unwrap(), cont.join(".bare").to_str().unwrap()])
            .output()
            .unwrap();
        std::fs::write(cont.join(".git"), "gitdir: ./.bare\n").unwrap();
        git(&cont, &["config", "user.email", "t@t.t"]);
        git(&cont, &["config", "user.name", "t"]);
        // A bare clone has no remote-tracking refs; set the standard refspec and
        // fetch so origin/main exists (what the bootstrap does).
        git(&cont, &["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
        git(&cont, &["fetch", "-q", "origin"]);
        git(&cont, &["worktree", "add", "-q", "main", "main"]);
        let wt = cont.join("main");
        // set-upstream so main tracks origin/main.
        git(&wt, &["branch", "--set-upstream-to=origin/main", "main"]);
        assert!(!branch_unpushed(&wt), "up to date with upstream is not unpushed");

        // A local commit puts it ahead of origin/main.
        std::fs::write(wt.join("a.txt"), "changed").unwrap();
        git(&wt, &["commit", "-qam", "local work"]);
        assert!(branch_unpushed(&wt), "ahead of upstream is unpushed");

        // A brand-new local branch with a commit and no upstream is unpushed.
        git(&wt, &["worktree", "add", "-q", "-b", "feature", "../feature"]);
        let feat = cont.join("feature");
        std::fs::write(feat.join("b.txt"), "new").unwrap();
        git(&feat, &["add", "."]);
        git(&feat, &["commit", "-qm", "feature work"]);
        assert!(branch_unpushed(&feat), "a local-only branch is unpushed");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn resolve_remote_branch_uses_config_then_tracking_ref() {
        let tmp = unique_tmp();
        // A remote with a `main` branch to clone from.
        let src = tmp.join("src");
        std::fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q"]);
        git(&src, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&src, &["config", "user.email", "t@t.t"]);
        git(&src, &["config", "user.name", "t"]);
        std::fs::write(src.join("a.txt"), "hi").unwrap();
        git(&src, &["add", "."]);
        git(&src, &["commit", "-qm", "init"]);
        let remote = tmp.join("remote.git");
        git(&tmp, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        git(&src, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&src, &["push", "-q", "origin", "main"]);

        // A clone: main tracks origin/main (config present).
        let repo = tmp.join("repo");
        git(&tmp, &["clone", "-q", remote.to_str().unwrap(), repo.to_str().unwrap()]);
        assert_eq!(
            resolve_remote_branch(&repo, "main"),
            Some(("origin".to_string(), "main".to_string())),
            "a tracking branch resolves via config",
        );

        // A branch pushed WITHOUT -u: no tracking config, but origin/feat exists.
        git(&repo, &["checkout", "-q", "-b", "feat"]);
        std::fs::write(repo.join("b.txt"), "x").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "feat"]);
        git(&repo, &["push", "-q", "origin", "feat"]); // no -u, so no branch.feat.merge
        assert!(
            branch_push_target(&repo, "feat").is_none(),
            "no tracking config for a plain push",
        );
        assert_eq!(
            resolve_remote_branch(&repo, "feat"),
            Some(("origin".to_string(), "feat".to_string())),
            "still resolves via the remote-tracking ref",
        );

        // A purely local branch has no remote to delete.
        git(&repo, &["checkout", "-q", "-b", "local-only"]);
        assert_eq!(resolve_remote_branch(&repo, "local-only"), None);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn new_branch_start_point_prefers_matching_remote_then_default() {
        let tmp = unique_tmp();
        // A source repo with `main` plus a `feature` branch to fetch.
        let src = tmp.join("src");
        std::fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q"]);
        git(&src, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&src, &["config", "user.email", "t@t.t"]);
        git(&src, &["config", "user.name", "t"]);
        std::fs::write(src.join("a.txt"), "hi").unwrap();
        git(&src, &["add", "."]);
        git(&src, &["commit", "-qm", "init"]);
        git(&src, &["branch", "feature"]);

        // A container with origin populated into refs/remotes/origin/* (what the
        // real fetch does), plus origin/HEAD so origin_default resolves.
        let cont = tmp.join("cont");
        std::fs::create_dir_all(&cont).unwrap();
        git(&cont, &["init", "-q"]);
        git(&cont, &["remote", "add", "origin", src.to_str().unwrap()]);
        git(&cont, &["fetch", "-q", "origin"]);
        git(&cont, &["remote", "set-head", "origin", "main"]);
        let cont_s = cont.to_string_lossy().into_owned();

        // A branch matching a remote tracks it; anything else falls to the default.
        assert_eq!(new_branch_start_point(&cont_s, "feature").as_deref(), Some("origin/feature"));
        assert_eq!(new_branch_start_point(&cont_s, "brand-new").as_deref(), Some("origin/main"));
        assert!(remote_branch_exists(&cont_s, "feature"));
        assert!(!remote_branch_exists(&cont_s, "brand-new"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_bare_container_lists_its_bare_entry_and_a_deleted_dir_is_unreadable() {
        let tmp = unique_tmp();
        let src = tmp.join("src");
        std::fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q"]);
        git(&src, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&src, &["config", "user.email", "t@t.t"]);
        git(&src, &["config", "user.name", "t"]);
        std::fs::write(src.join("a.txt"), "hi").unwrap();
        git(&src, &["add", "."]);
        git(&src, &["commit", "-qm", "init"]);
        assert!(list_worktrees_body(src.to_string_lossy().into_owned()).unwrap().iter().all(|w| !w.is_bare));

        let cont = tmp.join("cont");
        std::fs::create_dir_all(&cont).unwrap();
        Command::new("git")
            .args(["clone", "-q", "--bare", src.to_str().unwrap(), cont.join(".bare").to_str().unwrap()])
            .output()
            .unwrap();
        std::fs::write(cont.join(".git"), "gitdir: ./.bare\n").unwrap();
        git(&cont, &["worktree", "add", "-q", "main", "main"]);
        let cont_s = cont.to_string_lossy().into_owned();
        let listed = list_worktrees_body(cont_s.clone()).unwrap();
        assert_eq!(listed.iter().filter(|w| w.is_bare).count(), 1, "exactly one bare record: {:?}", listed.iter().map(|w| &w.path).collect::<Vec<_>>());
        assert!(listed.iter().any(|w| !w.is_bare && w.branch == "main"));

        assert!(repo_readable(&cont_s));
        assert!(repo_readable(&src.to_string_lossy()));
        std::fs::remove_dir_all(&src).unwrap();
        assert!(!repo_readable(&src.to_string_lossy()), "a deleted dir is not a repo");
        assert!(list_worktrees_body(src.to_string_lossy().into_owned()).unwrap().is_empty(), "which list alone cannot tell from empty");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn create_worktree_in_fills_a_plain_repo_container_and_never_adopts_main() {
        // Canonical up front: git lists resolved paths and macOS resolves /var.
        let tmp = std::fs::canonicalize(unique_tmp()).unwrap();
        let repo = tmp.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&repo, &["config", "user.email", "t@t.t"]);
        git(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("a.txt"), "hi").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "init"]);
        let repo_s = repo.to_string_lossy().into_owned();
        let container = repo.join(".sway/worktrees");
        std::fs::create_dir_all(&container).unwrap();
        crate::git::exclude_from_repo(&repo_s, ".sway");

        let made = create_worktree_in(&repo_s, "feat/x", &container).unwrap();
        assert_eq!(made, container.join("x"));
        assert!(made.join("a.txt").is_file());
        let status = Command::new("git").arg("-C").arg(&repo).args(["status", "--porcelain"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&status.stdout).trim(), "", "the plain repo stays clean");

        // A second call reuses the worktree it made.
        assert_eq!(create_worktree_in(&repo_s, "feat/x", &container).unwrap(), made);

        // The branch checked out in place is the user's checkout, not a reuse.
        let err = create_worktree_in(&repo_s, "main", &container).unwrap_err();
        assert!(err.contains("checked out in the repository itself"), "{err}");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn link_shared_noop_without_shared_dir() {
        let tmp = unique_tmp();
        let container = tmp.join("proj");
        let wt = container.join("main");
        std::fs::create_dir_all(&wt).unwrap();
        link_shared(&container, &wt); // must not panic or create anything
        assert_eq!(std::fs::read_dir(&wt).unwrap().count(), 0);
        std::fs::remove_dir_all(&tmp).ok();
    }
}
