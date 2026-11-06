// The rescue's parent is HEAD, so its commits stay reachable too. The metadata
// rides in the message, since the worktree's admin dir (where a sidecar would
// live) goes with the folder.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::AppHandle;

use crate::ui::Ui;
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
    let mut args = vec!["rev-list".to_string(), "-n1".into()];
    args.extend(held_by_no_ref("HEAD", deleted_branch));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    Ok(!git(folder, &args)?.is_empty())
}

// Tori's own refs are left out, since a rescue is dropped once restored.
fn held_by_no_ref(rev: &str, deleted_branch: Option<&str>) -> Vec<String> {
    let mut args = vec![rev.to_string(), "--not".into()];
    if let Some(branch) = deleted_branch {
        args.push(format!("--exclude={branch}"));
    }
    args.extend(["--branches", "--remotes", "--tags"].map(String::from));
    args
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
    let name = format!("{REFS}{}-{}", now_ms(), &commit[..commit.len().min(8)]);
    git(folder, &["update-ref", &name, &commit, ""])?;
    Ok(Some(name))
}

const KEEP_FOR_MS: u128 = 30 * 24 * 60 * 60 * 1000;

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn ids(repo: &Path) -> Vec<String> {
    git(repo, &["for-each-ref", "--format=%(refname)", REFS])
        .unwrap_or_default()
        .lines()
        .filter_map(|r| r.strip_prefix(REFS))
        .map(str::to_string)
        .collect()
}

fn kept_at(id: &str) -> Option<u128> {
    id.split_once('-')?.0.parse().ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rescued {
    id: String,
    branch: Option<String>,
    worktree: String,
    deleted_at: u64,
    operation: Option<String>,
    files: Vec<String>,
    commits: Vec<String>,
    skipped: Vec<String>,
}

#[derive(Default)]
struct Trailers {
    worktree: String,
    branch: Option<String>,
    operation: Option<String>,
    skipped: Vec<String>,
}

fn trailers(message: &str) -> Trailers {
    let mut t = Trailers::default();
    for line in message.lines() {
        let Some((key, value)) = line.split_once(": ") else {
            continue;
        };
        let value = value.to_string();
        match key {
            "Tori-Worktree" => t.worktree = value,
            "Tori-Branch" => t.branch = Some(value),
            "Tori-Operation" => t.operation = Some(value),
            "Tori-Skipped" => t.skipped.push(value),
            _ => {}
        }
    }
    t
}

fn lines(text: String) -> Vec<String> {
    text.lines().filter(|l| !l.is_empty()).map(str::to_string).collect()
}

fn read(repo: &Path, id: &str) -> Option<Rescued> {
    let name = format!("{REFS}{id}");
    let t = trailers(&git(repo, &["log", "-1", "--format=%B", &name]).ok()?);
    let files = git(
        repo,
        &["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", &name],
    )
    .unwrap_or_default();
    let mut args = vec!["log".to_string(), "--format=%s".into(), "--max-count=50".into()];
    args.extend(held_by_no_ref(&format!("{name}^"), None));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let commits = git(repo, &args).unwrap_or_default();
    Some(Rescued {
        id: id.to_string(),
        branch: t.branch,
        worktree: t.worktree,
        deleted_at: kept_at(id).unwrap_or_default() as u64,
        operation: t.operation,
        files: lines(files),
        commits: lines(commits),
        skipped: t.skipped,
    })
}

#[tauri::command(async)]
pub fn rescue_list(repo: String) -> Vec<Rescued> {
    let repo = Path::new(&repo);
    let mut out: Vec<Rescued> = ids(repo).iter().filter_map(|id| read(repo, id)).collect();
    out.sort_by_key(|r| std::cmp::Reverse(r.deleted_at));
    out
}

#[tauri::command(async)]
pub fn rescue_counts(repos: Vec<String>) -> HashMap<String, usize> {
    repos
        .into_iter()
        .filter_map(|repo| {
            let n = ids(Path::new(&repo)).len();
            (n > 0).then_some((repo, n))
        })
        .collect()
}

fn expire(repo: &Path, now: u128) {
    for id in ids(repo) {
        if kept_at(&id).is_some_and(|at| now.saturating_sub(at) > KEEP_FOR_MS) {
            let _ = git(repo, &["update-ref", "-d", &format!("{REFS}{id}")]);
        }
    }
}

pub fn sweep() {
    let now = now_ms();
    for dir in crate::config::project_dirs() {
        expire(&dir, now);
    }
}

fn free_name(repo: &str, first: String) -> String {
    let taken = |name: &str| crate::worktree::branch_exists(repo, name);
    if !taken(&first) {
        return first;
    }
    (2..)
        .map(|n| format!("{first}-{n}"))
        .find(|name| !taken(name))
        .unwrap_or(first)
}

// The original name only when taking it moves nothing: a branch at another
// commit, or one checked out elsewhere, is someone's newer work.
fn restored_branch(repo: &str, wanted: Option<&str>, head: &str, id: &str) -> String {
    let Some(wanted) = wanted else {
        return free_name(repo, format!("restored-{}", id.rsplit('-').next().unwrap_or(id)));
    };
    if !crate::worktree::branch_exists(repo, wanted) {
        return wanted.to_string();
    }
    let tip = git(
        Path::new(repo),
        &["rev-parse", "--verify", &format!("refs/heads/{wanted}")],
    );
    if tip.as_deref() == Ok(head) && !crate::worktree::branch_has_worktree(repo, wanted) {
        return wanted.to_string();
    }
    free_name(repo, format!("{wanted}-restored"))
}

pub(crate) fn restore(repo: &str, id: &str) -> Result<PathBuf, String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || id.is_empty() {
        return Err(format!("\"{id}\" is not a kept copy."));
    }
    let root = Path::new(repo);
    let name = format!("{REFS}{id}");
    let commit = git(root, &["rev-parse", "--verify", &format!("{name}^{{commit}}")])
        .map_err(|_| "This copy is gone: it was restored or it expired.".to_string())?;
    let head = git(root, &["rev-parse", "--verify", "-q", &format!("{commit}^")]).map_err(|_| {
        "This copy was kept before the first commit, so there is no branch to restore it on.".to_string()
    })?;
    let t = trailers(&git(root, &["log", "-1", "--format=%B", &commit])?);
    crate::worktree::prune_worktrees(repo);
    let branch = restored_branch(repo, t.branch.as_deref(), &head, id);
    let container = crate::topics::topic_container(repo)?;
    let new_branch = !crate::worktree::branch_exists(repo, &branch);
    let (target, created) = crate::worktree::add_worktree_in(repo, &branch, &container, Some(&head), true)?;
    if !created {
        return Err(format!("{branch} already has a worktree at {}.", target.display()));
    }
    // Unstaged on purpose: the copy never recorded what was staged.
    let written = git(&target, &["read-tree", "-u", "--reset", &commit]).and_then(|_| git(&target, &["reset", "-q"]));
    if let Err(e) = written {
        let _ = git(root, &["worktree", "remove", "--force", &target.to_string_lossy()]);
        if new_branch {
            let _ = git(root, &["branch", "-D", &branch]);
        }
        return Err(format!("Could not write the kept files, so nothing was restored: {e}"));
    }
    crate::setup::on_created(repo, &target);
    let _ = git(root, &["update-ref", "-d", &name, &commit]);
    Ok(target)
}

#[tauri::command]
pub async fn rescue_restore(app: AppHandle, repo: String, id: String) -> Result<String, String> {
    let project = repo.clone();
    let target = crate::exec::git_write("rescue_restore", repo.clone(), move || restore(&repo, &id)).await?;
    let path = target.to_string_lossy().into_owned();
    let _ = crate::sessions::adopt(&path);
    Ui::from(&app).emit("config://changed", ());
    crate::run::start_after_setup(project, target);
    Ok(path)
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

    fn delete(repo: &Path, wt: &Path) -> String {
        crate::worktree::do_remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), true).unwrap();
        let kept = rescues(repo);
        assert_eq!(kept.len(), 1, "{kept:?}");
        kept[0].strip_prefix(REFS).unwrap().to_string()
    }

    fn branch_of(folder: &Path) -> String {
        sh(folder, &["rev-parse", "--abbrev-ref", "HEAD"])
    }

    #[test]
    fn a_free_branch_at_the_kept_head_is_checked_out_again() {
        let dir = tmp();
        let wt = repo_with_feat(&dir);
        let repo = dir.join("repo");
        std::fs::write(wt.join("a.txt"), "edited\n").unwrap();
        let id = delete(&repo, &wt);

        let back = restore(repo.to_str().unwrap(), &id).unwrap();
        assert_eq!(branch_of(&back), "feat");
        assert_eq!(std::fs::read_to_string(back.join("a.txt")).unwrap(), "edited\n");
        assert_eq!(sh(&back, &["status", "--porcelain"]), "M a.txt", "unstaged");
        assert!(rescues(&repo).is_empty(), "the copy is dropped once restored");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_deleted_branch_is_made_again_at_the_kept_head() {
        let dir = tmp();
        let wt = repo_with_feat(&dir);
        let repo = dir.join("repo");
        std::fs::write(wt.join("a.txt"), "more\n").unwrap();
        sh(&wt, &["commit", "-qam", "more"]);
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        crate::worktree::remove_worktree_deleting(repo.to_str().unwrap(), wt.to_str().unwrap(), true, Some("feat"))
            .unwrap();
        sh(&repo, &["branch", "-D", "feat"]);
        let listed = rescue_list(repo.to_string_lossy().into_owned());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].branch.as_deref(), Some("feat"));
        assert_eq!(listed[0].commits, ["more", "feat"], "no branch holds either now");

        let back = restore(repo.to_str().unwrap(), &listed[0].id).unwrap();
        assert_eq!(branch_of(&back), "feat");
        assert_eq!(sh(&repo, &["rev-parse", "feat"]), head);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_branch_that_moved_on_gets_a_restored_sibling() {
        let dir = tmp();
        let wt = repo_with_feat(&dir);
        let repo = dir.join("repo");
        let before = sh(&repo, &["rev-parse", "feat"]);
        sh(&wt, &["-c", "core.editor=true", "rebase", "main"]);
        std::fs::write(wt.join("a.txt"), "resolved\n").unwrap();
        std::fs::write(wt.join("new.txt"), "untracked\n").unwrap();
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        let id = delete(&repo, &wt);
        let listed = rescue_list(repo.to_string_lossy().into_owned());
        assert_eq!(listed[0].operation.as_deref(), Some("rebase 1/1"));
        assert_eq!(listed[0].files, ["a.txt", "new.txt"]);
        sh(
            &repo,
            &["worktree", "add", "-q", dir.join("again").to_str().unwrap(), "feat"],
        );

        let back = restore(repo.to_str().unwrap(), &id).unwrap();
        assert_eq!(branch_of(&back), "feat-restored");
        assert_eq!(sh(&back, &["rev-parse", "HEAD"]), head);
        assert_eq!(sh(&repo, &["rev-parse", "feat"]), before, "the original is untouched");
        assert_eq!(std::fs::read_to_string(back.join("a.txt")).unwrap(), "resolved\n");
        assert_eq!(std::fs::read_to_string(back.join("new.txt")).unwrap(), "untracked\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn setup_reads_the_restored_files_and_the_checkout_hook_still_runs() {
        let dir = tmp();
        let wt = repo_with_feat(&dir);
        let repo = dir.join("repo");
        std::fs::write(wt.join("package.json"), "{\"restored\":true}\n").unwrap();
        let id = delete(&repo, &wt);
        let hooked = dir.join("hooked");
        let hook = repo.join(".git/hooks/post-checkout");
        std::fs::write(&hook, format!("#!/bin/sh\necho fired >> '{}'\n", hooked.display())).unwrap();
        std::fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        // Set in the repo, or a global `core.hooksPath` would skip `.git/hooks`.
        sh(
            &repo,
            &["config", "core.hooksPath", repo.join(".git/hooks").to_str().unwrap()],
        );
        let seen = dir.join("seen");
        let repo_s = repo.to_string_lossy().into_owned();
        crate::setup::seam(
            HashMap::from([(
                repo_s.clone(),
                crate::settings::WorktreePrefs {
                    setup_command: format!("cat package.json > '{}'", seen.display()),
                    setup_wait: false,
                    ..Default::default()
                },
            )]),
            dir.join("logs"),
        );

        let back = restore(&repo_s, &id).unwrap();
        let ran = crate::setup::wait(&back, std::time::Duration::from_secs(10)).unwrap();
        assert_eq!(ran.state, crate::setup::State::Done);
        assert_eq!(std::fs::read_to_string(&seen).unwrap(), "{\"restored\":true}\n");
        assert_eq!(std::fs::read_to_string(&hooked).unwrap(), "fired\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_copy_older_than_thirty_days_is_dropped() {
        let dir = tmp();
        let wt = repo_with_feat(&dir);
        let repo = dir.join("repo");
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        let now = now_ms();
        let day = 24 * 60 * 60 * 1000;
        sh(&repo, &["update-ref", &format!("{REFS}{}-old", now - 31 * day), &head]);
        sh(&repo, &["update-ref", &format!("{REFS}{}-new", now - 29 * day), &head]);

        expire(&repo, now);
        assert_eq!(rescues(&repo), [format!("{REFS}{}-new", now - 29 * day)]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
