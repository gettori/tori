// Git worktree management, so a branch can get its own working directory.
// A worktree "project" is a `.bare` container holding per-branch worktree folders
// (see [[concept_folder_anchored_sessions]] / [[component_project_discovery]]).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Directory under a bare container holding files shared into every worktree
/// (symlinked at creation, editable via the Shared tab). A bare-container
/// convention; absent until the first shared file is added.
const SHARED_DIR: &str = ".shared";

#[derive(Serialize)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
}

#[tauri::command]
pub fn list_worktrees(repo_path: String) -> Result<Vec<Worktree>, String> {
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
    let mut first = true;

    let flush = |path: &mut Option<String>, branch: &mut String, first: &mut bool, out: &mut Vec<Worktree>| {
        if let Some(p) = path.take() {
            out.push(Worktree {
                path: p,
                branch: std::mem::take(branch),
                is_main: *first,
            });
            *first = false;
        }
    };

    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            // New record begins; flush the previous.
            flush(&mut cur_path, &mut cur_branch, &mut first, &mut result);
            cur_path = Some(p.to_string());
            cur_branch = String::new();
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = b.trim_start_matches("refs/heads/").to_string();
        } else if line == "detached" {
            cur_branch = "(detached)".to_string();
        }
    }
    flush(&mut cur_path, &mut cur_branch, &mut first, &mut result);
    Ok(result)
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

fn branch_exists(repo: &str, branch: &str) -> bool {
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
fn remote_branch_exists(repo: &str, name: &str) -> bool {
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
fn branch_has_worktree(repo: &str, branch: &str) -> bool {
    list_worktrees(repo.to_string())
        .map(|wts| wts.iter().any(|w| w.branch == *branch))
        .unwrap_or(false)
}

/// Branch's last path segment (`bug/critical` -> `critical`).
fn last_segment(branch: &str) -> &str {
    branch.rsplit('/').next().unwrap_or(branch)
}

/// Sanitized full-branch slug (`bug/critical` -> `bug-critical`); any character
/// that is not alphanumeric / `-` / `_` / `.` becomes `-`.
fn slugify(branch: &str) -> String {
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
fn link_shared(container: &Path, worktree: &Path) {
    let shared_dir = container.join(SHARED_DIR);
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
#[tauri::command]
pub fn create_worktree(app: AppHandle, repo_path: String, branch: String) -> Result<(), String> {
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("Branch name is empty".into());
    }
    let container = PathBuf::from(&repo_path);

    // Already checked out somewhere: reuse it rather than make a duplicate.
    if branch_has_worktree(&repo_path, &branch) {
        return Ok(());
    }

    let folder = pick_worktree_folder(&container, &branch)?;
    let target = container.join(&folder);
    let target_str = target.to_string_lossy().into_owned();

    if branch_exists(&repo_path, &branch) {
        git_ok(&repo_path, &["worktree", "add", &target_str, &branch])?;
    } else {
        // New branch: refresh origin so remote refs are current (best-effort: a
        // repo without a remote simply has no fetch to do), then base off the
        // matching remote branch when one exists (so attaching origin/<name>
        // tracks it), else origin's default, else HEAD.
        let _ = Command::new("git")
            .arg("-C")
            .arg(&repo_path)
            .arg("fetch")
            .output();
        let mut args: Vec<String> = vec![
            "worktree".into(),
            "add".into(),
            "-b".into(),
            branch.clone(),
            target_str.clone(),
        ];
        if let Some(start) = new_branch_start_point(&repo_path, &branch) {
            args.push(start);
        }
        let argrefs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_ok(&repo_path, &argrefs)?;
    }

    link_shared(&container, &target);
    // Sway created this folder: adopt it so reusing a path that held old sessions
    // does not surface them as historical.
    let _ = crate::sessions::adopt(&target_str);
    let _ = app.emit("config://changed", ());
    Ok(())
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
pub fn worktree_dirty(path: String) -> Result<bool, String> {
    tree_dirty(Path::new(&path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub dirty: bool,
    pub unpushed: bool,
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
pub fn worktree_status(path: String) -> Result<WorktreeStatus, String> {
    let p = Path::new(&path);
    Ok(WorktreeStatus { dirty: tree_dirty(p)?, unpushed: branch_unpushed(p) })
}

/// Remove a worktree folder and prune its stale admin entry. Unless `force`, refuses
/// a dirty tree (real work) via `tree_dirty`, so nothing is deleted then; the UI's
/// confirm dialog passes `force` once it has shown the uncommitted/unpushed warning.
/// `git worktree remove --force` is always used, to drop the regenerable `.shared/`
/// symlinks git would otherwise treat as untracked. Shared by `remove_worktree` and
/// the delete-plus-branch variant; it does not emit (the caller does).
fn do_remove_worktree(repo_path: &str, worktree_path: &str, force: bool) -> Result<(), String> {
    if !force && tree_dirty(Path::new(worktree_path))? {
        return Err("This worktree has uncommitted changes; commit or discard them first.".into());
    }
    git_ok(repo_path, &["worktree", "remove", "--force", worktree_path])?;
    let _ = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["worktree", "prune"])
        .output();
    Ok(())
}

/// Remove a worktree, keeping its branch. The live-use teardown (PTYs, editor tabs)
/// runs in the UI before this is called; `force` skips the dirty guard once the
/// confirm dialog has warned about it.
#[tauri::command]
pub fn remove_worktree(
    app: AppHandle,
    repo_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    do_remove_worktree(&repo_path, &worktree_path, force)?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Remove a worktree AND delete its branch (`git branch -D`). The folder is removed
/// first; if the branch delete then fails, the folder is already gone, so we emit
/// and surface an explicit partial-outcome message rather than swallow it. `force`
/// matches `remove_worktree`.
#[tauri::command]
pub fn remove_worktree_and_branch(
    app: AppHandle,
    repo_path: String,
    worktree_path: String,
    branch: String,
    force: bool,
) -> Result<(), String> {
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
