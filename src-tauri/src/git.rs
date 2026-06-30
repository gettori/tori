// Git queries for the editor: the changed-file list (for a review surface) and
// per-file diff hunks in new-file coordinates (for the CM6 gutter). Both shell
// out to git, like `list_branches` in config.rs. Diffs are taken against HEAD so
// the gutter reflects all uncommitted work (staged + unstaged), matching the
// "uncommitted changes" review surface, not just unstaged edits.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
pub struct GitFileStatus {
    /// Porcelain XY status code, e.g. " M", "??", "A ", "MM".
    status: String,
    path: String,
}

#[tauri::command]
pub fn git_status(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // Not a git repo (or no commits): no changes, not an error.
        return Ok(vec![]);
    }

    Ok(parse_status(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_status(text: &str) -> Vec<GitFileStatus> {
    let mut files = Vec::new();
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        files.push(GitFileStatus {
            status: line[..2].to_string(),
            path: line[3..].to_string(),
        });
    }
    files
}

#[derive(Serialize)]
pub struct DiffHunk {
    /// "added" | "modified" | "deleted".
    kind: String,
    /// 1-based first affected line in the new file. For a pure deletion this is
    /// the line after which content was removed (git's convention).
    start: u32,
    /// New-file lines affected; 0 for a pure deletion.
    count: u32,
}

/// Parse a unified-diff range token like "12,3" or "12" (count defaults to 1).
fn parse_range(s: &str) -> (u32, u32) {
    let mut parts = s.splitn(2, ',');
    let start = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let count = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1);
    (start, count)
}

#[tauri::command]
pub fn git_diff_file(project_path: String, file: String) -> Result<Vec<DiffHunk>, String> {
    // -U0: hunk headers carry exact ranges, no surrounding context to walk.
    let output = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff", "HEAD", "--no-color", "-U0", "--", &file])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // No HEAD yet, untracked file, or not a repo: no hunks.
        return Ok(vec![]);
    }

    Ok(parse_hunks(&String::from_utf8_lossy(&output.stdout)))
}

/// Raw unified diff text vs HEAD for a single file, for the inline review view.
/// Untracked files have no diff vs HEAD, so fall back to showing the whole file
/// as additions (`git diff --no-index /dev/null <file>`).
#[tauri::command]
pub fn git_diff_text(project_path: String, file: String) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff", "HEAD", "--no-color", "--", &file])
        .output()
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() && !text.trim().is_empty() {
        return Ok(text);
    }

    // Untracked (or no HEAD): diff against an empty tree so new files still show.
    let untracked = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff", "--no-color", "--no-index", "--", "/dev/null", &file])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&untracked.stdout).into_owned())
}

fn parse_hunks(text: &str) -> Vec<DiffHunk> {
    let mut hunks = Vec::new();
    for line in text.lines() {
        // Hunk header: @@ -old_start,old_count +new_start,new_count @@
        let Some(rest) = line.strip_prefix("@@ ") else {
            continue;
        };
        let mut tokens = rest.split_whitespace();
        let (Some(minus), Some(plus)) = (tokens.next(), tokens.next()) else {
            continue;
        };
        if !minus.starts_with('-') || !plus.starts_with('+') {
            continue;
        }
        let (_, old_count) = parse_range(&minus[1..]);
        let (new_start, new_count) = parse_range(&plus[1..]);
        let kind = if old_count == 0 {
            "added"
        } else if new_count == 0 {
            "deleted"
        } else {
            "modified"
        };
        hunks.push(DiffHunk {
            kind: kind.to_string(),
            start: new_start,
            count: new_count,
        });
    }
    hunks
}

/// Switch the shared working tree to `branch` (plain repos only; the frontend
/// gates this). git checkout is atomic: on a dirty/conflicting tree it fails and
/// leaves the tree untouched, so surfacing stderr is enough to never half-switch.
#[tauri::command]
pub fn git_checkout(repo_path: String, branch: String) -> Result<(), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["checkout", &branch])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

// --- plain-dir git lifecycle (init / remote / origin) ---

fn git_run(repo: &str, args: &[&str]) -> Result<(), String> {
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

/// A default .gitignore scaffolded on `git init`, excluding the common junk that
/// must never enter the first commit.
const DEFAULT_GITIGNORE: &str = "\
# Dependencies
node_modules/

# Build output
dist/
build/
target/

# Logs
*.log

# Environment
.env
.env.local

# OS / editor cruft
.DS_Store
Thumbs.db
";

/// Core of `git_init` without the app event, so it is unit-testable: `git init`
/// (optional initial branch via symbolic-ref, portable across git versions) and
/// a scaffolded .gitignore when none exists. Refuses an existing repo.
fn do_init(dir: &Path, branch: Option<&str>) -> Result<(), String> {
    if dir.join(".git").exists() {
        return Err("This folder is already a git repository.".into());
    }
    let path = dir.to_string_lossy();
    git_run(&path, &["init", "-q"])?;
    if let Some(b) = branch.map(str::trim).filter(|b| !b.is_empty()) {
        if b.contains('/') || b.contains(char::is_whitespace) || b.starts_with('-') {
            return Err("Invalid branch name".into());
        }
        git_run(&path, &["symbolic-ref", "HEAD", &format!("refs/heads/{b}")])?;
    }
    let gitignore = dir.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, DEFAULT_GITIGNORE).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Initialize a git repo in a plain-dir project (optional initial branch),
/// scaffolding a default .gitignore. Re-discovers (plain-dir becomes plain).
#[tauri::command]
pub fn git_init(app: AppHandle, project_path: String, branch: Option<String>) -> Result<(), String> {
    do_init(Path::new(&project_path), branch.as_deref())?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Add the `origin` remote, or update its URL if it already exists.
#[tauri::command]
pub fn git_remote_add(app: AppHandle, project_path: String, url: String) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Remote URL is empty".into());
    }
    let exists = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["remote", "get-url", "origin"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if exists {
        git_run(&project_path, &["remote", "set-url", "origin", url])?;
    } else {
        git_run(&project_path, &["remote", "add", "origin", url])?;
    }
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Origin's URL if configured, else None. Lets the UI gate push on a remote.
#[tauri::command]
pub fn git_origin(project_path: String) -> Result<Option<String>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["remote", "get-url", "origin"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None);
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!url.is_empty()).then_some(url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_splits_code_and_path() {
        let out = " M src/App.tsx\n?? new.txt\nA  staged.rs\n";
        let files = parse_status(out);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, " M");
        assert_eq!(files[0].path, "src/App.tsx");
        assert_eq!(files[1].status, "??");
        assert_eq!(files[1].path, "new.txt");
        assert_eq!(files[2].status, "A ");
        assert_eq!(files[2].path, "staged.rs");
    }

    #[test]
    fn hunks_classify_added_modified_deleted() {
        // -U0 headers: added (old count 0), modified, pure deletion (new count 0).
        let diff = "\
diff --git a/f b/f
--- a/f
+++ b/f
@@ -0,0 +1,3 @@
@@ -10,2 +11,2 @@
@@ -20,3 +20,0 @@
";
        let hunks = parse_hunks(diff);
        assert_eq!(hunks.len(), 3);
        assert_eq!((hunks[0].kind.as_str(), hunks[0].start, hunks[0].count), ("added", 1, 3));
        assert_eq!((hunks[1].kind.as_str(), hunks[1].start, hunks[1].count), ("modified", 11, 2));
        assert_eq!((hunks[2].kind.as_str(), hunks[2].start, hunks[2].count), ("deleted", 20, 0));
    }

    #[test]
    fn range_defaults_count_to_one() {
        assert_eq!(parse_range("42"), (42, 1));
        assert_eq!(parse_range("42,3"), (42, 3));
    }

    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

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
        assert!(out.status.success(), "git {:?}", args);
    }

    fn repo_with_two_branches() -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("sway_checkout_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        std::fs::write(dir.join("f.txt"), "v1").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        git(&dir, &["branch", "feature"]);
        dir
    }

    fn current_branch(dir: &Path) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn checkout_switches_branch_on_clean_tree() {
        let dir = repo_with_two_branches();
        assert_eq!(current_branch(&dir), "main");
        git_checkout(dir.to_string_lossy().into_owned(), "feature".into()).unwrap();
        assert_eq!(current_branch(&dir), "feature");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn checkout_surfaces_error_and_does_not_switch() {
        let dir = repo_with_two_branches();
        let err = git_checkout(dir.to_string_lossy().into_owned(), "nope".into())
            .expect_err("checkout of a missing branch must fail");
        assert!(!err.is_empty(), "stderr should be surfaced");
        // Never half-switch: the tree stays on the original branch.
        assert_eq!(current_branch(&dir), "main");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn empty_tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sway_init_test_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn init_makes_repo_sets_branch_and_scaffolds_gitignore() {
        let dir = empty_tmp();
        do_init(&dir, Some("main")).unwrap();

        // It is now a repo whose unborn HEAD points at the requested branch
        // (rev-parse --abbrev-ref reports "HEAD" before the first commit, so read
        // the symbolic ref directly).
        assert!(dir.join(".git").exists());
        let head = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["symbolic-ref", "--short", "HEAD"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "main");

        // The scaffolded .gitignore excludes common junk.
        let ignore = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(ignore.contains("node_modules"));

        // Re-initializing is refused (already a repo).
        assert!(do_init(&dir, None).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn init_preserves_an_existing_gitignore() {
        let dir = empty_tmp();
        std::fs::write(dir.join(".gitignore"), "custom-only\n").unwrap();
        do_init(&dir, None).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(".gitignore")).unwrap(), "custom-only\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scaffolded_gitignore_keeps_junk_out_of_the_commit() {
        let dir = empty_tmp();
        do_init(&dir, Some("main")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules/pkg.js"), "x").unwrap();
        std::fs::write(dir.join("real.txt"), "code").unwrap();
        git(&dir, &["add", "-A"]);

        // Only the real file is staged; node_modules is ignored.
        let out = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["diff", "--cached", "--name-only"])
            .output()
            .unwrap();
        let staged = String::from_utf8_lossy(&out.stdout);
        assert!(staged.contains("real.txt"));
        assert!(!staged.contains("node_modules"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn origin_reports_url_only_when_set() {
        let dir = empty_tmp();
        do_init(&dir, Some("main")).unwrap();
        let p = dir.to_string_lossy().into_owned();
        assert_eq!(git_origin(p.clone()).unwrap(), None);
        git(&dir, &["remote", "add", "origin", "https://example.com/x.git"]);
        assert_eq!(git_origin(p).unwrap().as_deref(), Some("https://example.com/x.git"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
