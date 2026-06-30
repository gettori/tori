// Git worktree management, so a branch can get its own working directory.
// A worktree "project" is a `.bare` container holding per-branch worktree folders
// (see [[concept_folder_anchored_sessions]] / [[component_project_discovery]]).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

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

/// Symlink each top-level entry of `<container>/.link/` into a freshly created
/// worktree, skipping names the worktree already has (a branch tracking the file
/// is never clobbered). Bare-container convention; a no-op when `.link/` is absent.
fn link_shared(container: &Path, worktree: &Path) {
    let link_dir = container.join(".link");
    let Ok(entries) = std::fs::read_dir(&link_dir) else {
        return; // no .link/ convention here
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
/// bases it on origin's default. Folder name is collision-safe (see
/// `pick_worktree_folder`); shared `.link/` files are linked in afterward.
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
        // New branch: refresh origin so its default is current (best-effort: a
        // repo without a remote simply has no fetch to do), then base off it.
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
        if let Some(def) = origin_default(&repo_path) {
            args.push(format!("origin/{def}"));
        }
        let argrefs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_ok(&repo_path, &argrefs)?;
    }

    link_shared(&container, &target);
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Is the worktree dirty in a way that should block removal? Tracked
/// modifications and genuine untracked files count; an untracked symlink that
/// points into the sibling `.link/` does NOT (we created it and it is a
/// regenerable pointer to a shared file, not user work). Without this exception a
/// freshly created worktree that linked any `.link/` file would read as dirty and
/// could never be removed. See [[gotchas#link-symlinks-read-as-untracked]].
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
    let link_canon = worktree
        .parent()
        .map(|c| c.join(".link"))
        .and_then(|d| std::fs::canonicalize(d).ok());

    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix("?? ") {
            // An untracked entry: a .link symlink is not dirt, anything else is.
            if let Some(ref lc) = link_canon {
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
/// `.link`-aware rule the removal itself enforces.
#[tauri::command]
pub fn worktree_dirty(path: String) -> Result<bool, String> {
    tree_dirty(Path::new(&path))
}

/// Remove a worktree and prune its stale admin entry. Refuses a dirty tree (real
/// work) via `tree_dirty`, so nothing is deleted then. `--force` is used only
/// once that check passes, to drop the regenerable `.link/` symlinks git would
/// otherwise treat as untracked. The live-use guard (running agents, open editor)
/// runs in the UI before this is called.
#[tauri::command]
pub fn remove_worktree(app: AppHandle, repo_path: String, worktree_path: String) -> Result<(), String> {
    if tree_dirty(Path::new(&worktree_path))? {
        return Err("This worktree has uncommitted changes; commit or discard them first.".into());
    }
    git_ok(&repo_path, &["worktree", "remove", "--force", &worktree_path])?;
    let _ = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["worktree", "prune"])
        .output();
    let _ = app.emit("config://changed", ());
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
        let link = container.join(".link");
        std::fs::create_dir_all(&link).unwrap();
        std::fs::write(link.join(".env"), "SECRET=1").unwrap();
        std::fs::write(link.join("config.toml"), "x=1").unwrap();

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
        assert_eq!(std::fs::read_link(wt.join("config.toml")).unwrap(), link.join("config.toml"));

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
        // A linked .link/ file shows as untracked but must NOT count as dirty.
        std::fs::create_dir_all(cont.join(".link")).unwrap();
        std::fs::write(cont.join(".link/.env"), "x").unwrap();
        std::os::unix::fs::symlink(cont.join(".link/.env"), wt.join(".env")).unwrap();
        assert!(!tree_dirty(&wt).unwrap(), "a .link symlink alone is not dirty");

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
    fn link_shared_noop_without_link_dir() {
        let tmp = unique_tmp();
        let container = tmp.join("proj");
        let wt = container.join("main");
        std::fs::create_dir_all(&wt).unwrap();
        link_shared(&container, &wt); // must not panic or create anything
        assert_eq!(std::fs::read_dir(&wt).unwrap().count(), 0);
        std::fs::remove_dir_all(&tmp).ok();
    }
}
