// The rescue's parent is HEAD, so its commits stay reachable too. The metadata
// rides in the message, since the worktree's admin dir (where a sidecar would
// live) goes with the folder.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::worktree::{operation, tree_dirty, Operation, OperationKind};

pub(crate) const REFS: &str = "refs/tori/rescue/";

// Past this a file is left out and named: one stray dump or recording would
// make the delete slow and stay pinned in the object store.
pub(crate) const LARGE_FILE: u64 = 50 * 1024 * 1024;

fn git(folder: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::exec::git_in(folder)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn head(folder: &Path) -> Option<String> {
    git(folder, &["rev-parse", "--verify", "-q", "HEAD"])
        .ok()
        .filter(|h| !h.is_empty())
}

fn has_work(folder: &Path, deleted_branch: Option<&str>, op: Option<&Operation>) -> Result<bool, String> {
    if op.is_some() || tree_dirty(folder)? {
        return Ok(true);
    }
    if head(folder).is_none() {
        return Ok(false);
    }
    // Tori's own refs are left out, since a rescue is dropped once restored.
    let mut args = vec!["rev-list".to_string(), "-n1".into(), "HEAD".into(), "--not".into()];
    if let Some(branch) = deleted_branch {
        args.push(format!("--exclude={branch}"));
    }
    args.extend(["--branches", "--remotes", "--tags"].map(String::from));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    Ok(!git(folder, &args)?.is_empty())
}

pub(crate) fn keeps_copy(folder: &Path, deleted_branch: Option<&str>) -> bool {
    crate::worktree::repo_readable(&folder.to_string_lossy())
        && has_work(folder, deleted_branch, operation(folder).as_ref()).unwrap_or(false)
}

pub(crate) fn large_files(folder: &Path) -> Vec<String> {
    let listed = |args: &[&str]| {
        crate::exec::git_in(folder)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| o.stdout)
            .unwrap_or_default()
    };
    let mut out: Vec<String> = [
        listed(&["ls-files", "-z", "--others", "--exclude-standard"]),
        listed(&["ls-files", "-z", "--modified"]),
    ]
    .iter()
    .flat_map(|bytes| bytes.split(|b| *b == 0))
    .filter(|name| !name.is_empty())
    .map(|name| String::from_utf8_lossy(name).into_owned())
    .filter(|name| std::fs::symlink_metadata(folder.join(name)).is_ok_and(|m| m.is_file() && m.len() > LARGE_FILE))
    .collect();
    out.sort();
    out.dedup();
    out
}

fn snapshot(folder: &Path, head: Option<&str>, skipped: &[String]) -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let index = std::env::temp_dir().join(format!("tori-rescue-{}-{nanos}", std::process::id()));
    let run = |args: &[String]| {
        let out = crate::exec::git_in(folder)
            .args(args)
            .env("GIT_INDEX_FILE", &index)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let result = (|| {
        // Seeded from HEAD, or a tracked file that matches `.gitignore` would
        // drop out of the tree.
        if head.is_some() {
            run(&["read-tree".into(), "HEAD".into()])?;
        }
        let mut add: Vec<String> = ["add", "-A", "--", "."].map(String::from).to_vec();
        add.extend(skipped.iter().map(|p| format!(":(exclude,literal){p}")));
        run(&add)?;
        run(&["write-tree".into()])
    })();
    let _ = std::fs::remove_file(&index);
    result
}

fn describe(op: &Operation) -> String {
    let kind = match op.kind {
        OperationKind::Rebase => "rebase",
        OperationKind::Merge => "merge",
        OperationKind::CherryPick => "cherry-pick",
        OperationKind::Revert => "revert",
    };
    match (op.step, op.total) {
        (Some(step), Some(total)) => format!("{kind} {step}/{total}"),
        _ => kind.to_string(),
    }
}

fn message(folder: &Path, branch: Option<&str>, op: Option<&Operation>, skipped: &[String]) -> String {
    let name = folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut trailers = vec![format!("Tori-Worktree: {}", folder.display())];
    if let Some(branch) = branch {
        trailers.push(format!("Tori-Branch: {branch}"));
    }
    if let Some(op) = op {
        trailers.push(format!("Tori-Operation: {}", describe(op)));
    }
    trailers.extend(skipped.iter().map(|p| format!("Tori-Skipped: {p}")));
    format!("Rescued {name} before it was deleted\n\n{}\n", trailers.join("\n"))
}

pub(crate) fn keep(folder: &Path, deleted_branch: Option<&str>) -> Result<Option<String>, String> {
    if !crate::worktree::repo_readable(&folder.to_string_lossy()) {
        return Ok(None);
    }
    let op = operation(folder);
    if !has_work(folder, deleted_branch, op.as_ref())? {
        return Ok(None);
    }
    let head = head(folder);
    let skipped = large_files(folder);
    let tree = snapshot(folder, head.as_deref(), &skipped)?;
    let branch = op
        .as_ref()
        .and_then(|o| o.replaying.clone())
        .or_else(|| crate::git::current_branch(&folder.to_string_lossy()));
    let text = message(folder, branch.as_deref(), op.as_ref(), &skipped);
    let mut args = vec!["commit-tree", "--no-gpg-sign", tree.as_str()];
    if let Some(h) = head.as_deref() {
        args.extend(["-p", h]);
    }
    args.extend(["-m", text.as_str()]);
    let out = crate::exec::git_in(folder)
        .args(&args)
        .env("GIT_AUTHOR_NAME", "Tori")
        .env("GIT_AUTHOR_EMAIL", "rescue@tori.invalid")
        .env("GIT_COMMITTER_NAME", "Tori")
        .env("GIT_COMMITTER_EMAIL", "rescue@tori.invalid")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let commit = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let name = format!("{REFS}{ms}-{}", &commit[..commit.len().min(8)]);
    git(folder, &["update-ref", &name, &commit, ""])?;
    Ok(Some(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn tmp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tori-rescue-test-{n}-{}", SEQ.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        // Canonical, so the folder the rescue names matches git's own spelling.
        std::fs::canonicalize(dir).unwrap()
    }

    fn repo_with_feat(dir: &Path) -> std::path::PathBuf {
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.email", "t@t.t"]);
        sh(&repo, &["config", "user.name", "t"]);
        sh(&repo, &["config", "commit.gpgsign", "false"]);
        let commit = |text: &str| {
            std::fs::write(repo.join("a.txt"), text).unwrap();
            sh(&repo, &["add", "a.txt"]);
            sh(&repo, &["commit", "-q", "-m", text]);
        };
        commit("base\n");
        sh(&repo, &["checkout", "-q", "-b", "feat"]);
        commit("feat\n");
        sh(&repo, &["checkout", "-q", "main"]);
        commit("main\n");
        let wt = dir.join("wt");
        sh(&repo, &["worktree", "add", "-q", wt.to_str().unwrap(), "feat"]);
        wt
    }

    fn rescues(repo: &Path) -> Vec<String> {
        let out = sh(repo, &["for-each-ref", "--format=%(refname)", REFS]);
        out.lines().map(str::to_string).collect()
    }

    #[test]
    fn a_worktree_deleted_mid_rebase_keeps_its_commits_and_resolved_files() {
        let dir = tmp();
        let wt = repo_with_feat(&dir);
        let repo = dir.join("repo");
        sh(&wt, &["-c", "core.editor=true", "rebase", "main"]);
        std::fs::write(wt.join("a.txt"), "resolved\n").unwrap();
        std::fs::write(wt.join("new.txt"), "untracked\n").unwrap();
        let head = sh(&wt, &["rev-parse", "HEAD"]);

        crate::worktree::do_remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), true).unwrap();

        assert!(!wt.exists());
        let kept = rescues(&repo);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(sh(&repo, &["rev-parse", &format!("{}^", kept[0])]), head);
        assert_eq!(sh(&repo, &["show", &format!("{}:a.txt", kept[0])]), "resolved");
        assert_eq!(sh(&repo, &["show", &format!("{}:new.txt", kept[0])]), "untracked");
        let msg = sh(&repo, &["log", "-1", "--format=%B", &kept[0]]);
        assert!(msg.contains("Tori-Branch: feat"), "{msg}");
        assert!(msg.contains("Tori-Operation: rebase 1/1"), "{msg}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commits_only_the_deleted_branch_held_are_kept() {
        let dir = tmp();
        let wt = repo_with_feat(&dir);
        let repo = dir.join("repo");
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        assert_eq!(keep(&wt, None).unwrap(), None, "feat still holds them");

        sh(&repo, &["update-ref", &format!("{REFS}old"), &head]);
        let kept = keep(&wt, Some("feat")).unwrap().expect("feat is about to go");
        assert_eq!(sh(&repo, &["rev-parse", &format!("{kept}^")]), head);
        assert_eq!(
            rescues(&repo).len(),
            2,
            "an older rescue does not count as holding them"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_rescue_that_cannot_be_written_stops_the_delete() {
        let dir = tmp();
        let wt = repo_with_feat(&dir);
        let repo = dir.join("repo");
        std::fs::write(wt.join("a.txt"), "dirty\n").unwrap();
        std::fs::create_dir_all(repo.join(".git/refs/tori")).unwrap();
        std::fs::write(repo.join(".git/refs/tori/rescue"), "").unwrap();

        let err = crate::worktree::do_remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), true)
            .expect_err("the ref cannot be created under a file");
        assert!(err.contains("was not deleted"), "{err}");
        assert!(wt.join("a.txt").exists(), "the folder stays");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_large_file_is_left_out_and_named() {
        let dir = tmp();
        let wt = repo_with_feat(&dir);
        let repo = dir.join("repo");
        std::fs::File::create(wt.join("dump.bin"))
            .unwrap()
            .set_len(LARGE_FILE + 1)
            .unwrap();
        std::fs::write(wt.join("small.txt"), "kept\n").unwrap();
        assert_eq!(large_files(&wt), ["dump.bin"]);

        let kept = keep(&wt, None).unwrap().expect("dirty");
        assert_eq!(sh(&repo, &["show", &format!("{kept}:small.txt")]), "kept");
        assert_eq!(sh(&repo, &["cat-file", "-t", &format!("{kept}:dump.bin")]), "");
        let msg = sh(&repo, &["log", "-1", "--format=%B", &kept]);
        assert!(msg.contains("Tori-Skipped: dump.bin"), "{msg}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
