// Turn-level checkpoints (Finding E): a snapshot of the full working tree at
// each prompt boundary, so per-turn diffs and per-file revert work
// agent-agnostically, from ground truth (the tree itself), not the
// transcript's account of what it did - closing the "Bash-driven writes are
// invisible to path-argument parsing" gap (Finding B).
//
// Mechanism: `git add -A` against a *persistent per-session* scratch index
// (`~/.config/sway/checkpoint-index/<sessionId>`, kept warm across snapshots
// for git's stat-cache, same trick the grimoire baseline refs use), then
// `write-tree`. The resulting tree is never committed and the user's real
// index/staging is never touched. Snapshots are named by the triggering
// prompt's transcript timestamp and anchored under
// `refs/sway/checkpoint/<sessionId>/<promptTs>` so they survive gc; a repeat
// snapshot whose tree is identical to the nearest earlier one is skipped (no
// new ref), so an idle turn or a duplicate trigger doesn't bloat the ref list.
//
// A turn's diff is tree-vs-tree between the checkpoint at its own prompt
// boundary and the checkpoint at the *next* prompt boundary; the latest turn
// (no next prompt yet) diffs against a live, unpersisted snapshot instead, so
// an in-progress turn's diff still reflects the disk right now.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// The well-known SHA-1 empty-tree object id (no parent needed for a
/// never-before-snapshotted session's first turn).
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn checkpoint_index_path(session_id: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/sway/checkpoint-index")
        .join(session_id)
}

fn is_git_worktree(repo: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

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

fn git_capture(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Raw (untrimmed) stdout, for unified-diff text where leading/trailing lines
/// matter.
fn git_output(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `git add -A` + `write-tree` against a session's persistent scratch index
/// (never the user's real index). Creates the index's parent dir on first use.
fn write_tree_scratch(repo: &str, index_path: &Path) -> Result<String, String> {
    if let Some(parent) = index_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let index_str = index_path.to_string_lossy().into_owned();
    let add = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["add", "-A"])
        .env("GIT_INDEX_FILE", &index_str)
        .output()
        .map_err(|e| e.to_string())?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }
    let tree = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["write-tree"])
        .env("GIT_INDEX_FILE", &index_str)
        .output()
        .map_err(|e| e.to_string())?;
    if !tree.status.success() {
        return Err(String::from_utf8_lossy(&tree.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&tree.stdout).trim().to_string())
}

fn ref_prefix(session_id: &str) -> String {
    format!("refs/sway/checkpoint/{session_id}/")
}

fn ref_name(session_id: &str, prompt_ts: u64) -> String {
    format!("{}{}", ref_prefix(session_id), prompt_ts)
}

/// Every existing checkpoint ref for this session, `(prompt_ts, tree)`,
/// ascending by `prompt_ts`.
fn list_checkpoints(repo: &str, session_id: &str) -> Vec<(u64, String)> {
    let prefix = ref_prefix(session_id);
    let out = match Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["for-each-ref", "--format=%(refname) %(objectname)", &prefix])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let mut entries: Vec<(u64, String)> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (name, tree) = line.split_once(' ')?;
            let ts: u64 = name.strip_prefix(&prefix)?.parse().ok()?;
            Some((ts, tree.to_string()))
        })
        .collect();
    entries.sort_by_key(|(ts, _)| *ts);
    entries
}

fn tree_at_or_before(checkpoints: &[(u64, String)], ts: u64) -> String {
    checkpoints
        .iter()
        .rev()
        .find(|(t, _)| *t <= ts)
        .map(|(_, tree)| tree.clone())
        .unwrap_or_else(|| EMPTY_TREE.to_string())
}

fn tree_after(
    repo: &str,
    session_id: &str,
    checkpoints: &[(u64, String)],
    ts: u64,
) -> Result<String, String> {
    if let Some((_, tree)) = checkpoints.iter().find(|(t, _)| *t > ts) {
        return Ok(tree.clone());
    }
    // The latest turn has no following prompt boundary yet: diff against a
    // live, unpersisted snapshot so an in-progress turn's diff stays current.
    write_tree_scratch(repo, &checkpoint_index_path(session_id))
}

/// Snapshot the working tree at a prompt boundary (`prompt_ts`, the
/// transcript timestamp of the human message that just arrived). No-op
/// outside a git worktree. Idempotent: a ref already at `prompt_ts` is left
/// alone; a computed tree identical to the nearest earlier checkpoint is not
/// written at all (an idle turn or a duplicate trigger creates no new ref).
/// Returns whether a new ref was created.
#[tauri::command]
pub fn checkpoint_snapshot(session_id: String, repo_path: String, prompt_ts: u64) -> Result<bool, String> {
    if !is_git_worktree(&repo_path) {
        return Ok(false);
    }
    let checkpoints = list_checkpoints(&repo_path, &session_id);
    if checkpoints.iter().any(|(t, _)| *t == prompt_ts) {
        return Ok(false);
    }
    let index_path = checkpoint_index_path(&session_id);
    let tree = write_tree_scratch(&repo_path, &index_path)?;
    let prior = tree_at_or_before(&checkpoints, prompt_ts);
    if prior == tree {
        return Ok(false);
    }
    git_run(&repo_path, &["update-ref", &ref_name(&session_id, prompt_ts), &tree])?;
    Ok(true)
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct CheckpointFile {
    pub path: String,
    /// "added" | "modified" | "deleted"
    pub status: String,
}

fn parse_name_status(text: &str) -> Vec<CheckpointFile> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\t');
            let code = parts.next()?;
            let path = parts.next()?;
            let status = match code.chars().next()? {
                'A' => "added",
                'D' => "deleted",
                _ => "modified",
            };
            Some(CheckpointFile { path: path.to_string(), status: status.to_string() })
        })
        .collect()
}

/// Files that changed during the turn starting at `prompt_ts`: tree-vs-tree
/// between this boundary's checkpoint and the next one (or a live snapshot
/// for the latest, still-open turn).
#[tauri::command]
pub fn checkpoint_turn_files(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
) -> Result<Vec<CheckpointFile>, String> {
    let checkpoints = list_checkpoints(&repo_path, &session_id);
    let before = tree_at_or_before(&checkpoints, prompt_ts);
    let after = tree_after(&repo_path, &session_id, &checkpoints, prompt_ts)?;
    if before == after {
        return Ok(Vec::new());
    }
    let out = git_capture(&repo_path, &["diff", "--name-status", &before, &after])?;
    Ok(parse_name_status(&out))
}

/// Unified diff text for one file within a turn's checkpoint-to-checkpoint
/// range.
#[tauri::command]
pub fn checkpoint_diff_file(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    file: String,
) -> Result<String, String> {
    let checkpoints = list_checkpoints(&repo_path, &session_id);
    let before = tree_at_or_before(&checkpoints, prompt_ts);
    let after = tree_after(&repo_path, &session_id, &checkpoints, prompt_ts)?;
    git_output(&repo_path, &["diff", "--no-color", &before, &after, "--", &file])
}

fn tree_has_file(repo: &str, tree: &str, file: &str) -> Result<bool, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["ls-tree", "--name-only", tree, "--", file])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(out.status.success() && !String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

/// Revert one file to its state *before* the turn starting at `prompt_ts`:
/// edited -> restore the pre-turn blob; created during the turn -> delete it;
/// deleted during the turn -> recreate it from the pre-turn blob. Returns
/// which action was taken ("restored" | "deleted" | "recreated").
#[tauri::command]
pub fn checkpoint_revert_file(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    file: String,
) -> Result<String, String> {
    let checkpoints = list_checkpoints(&repo_path, &session_id);
    let before = tree_at_or_before(&checkpoints, prompt_ts);
    let after = tree_after(&repo_path, &session_id, &checkpoints, prompt_ts)?;
    let existed_before = tree_has_file(&repo_path, &before, &file)?;
    let exists_after = tree_has_file(&repo_path, &after, &file)?;
    let abs = Path::new(&repo_path).join(&file);

    if !existed_before && !exists_after {
        return Err("This file is not part of this turn's checkpoint.".into());
    }
    if !existed_before && exists_after {
        // Created during the turn: undo the creation.
        std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
        return Ok("deleted".into());
    }
    // Edited, or deleted during the turn: restore the pre-turn blob.
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["show", &format!("{before}:{file}")])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&abs, &out.stdout).map_err(|e| e.to_string())?;
    Ok(if exists_after { "restored".into() } else { "recreated".into() })
}

/// Remove every checkpoint ref and the scratch index file for a session,
/// called on session delete/archive so `refs/sway/checkpoint/*` doesn't grow
/// unbounded.
#[tauri::command]
pub fn checkpoint_prune(repo_path: String, session_id: String) -> Result<(), String> {
    let prefix = ref_prefix(&session_id);
    if let Ok(out) = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["for-each-ref", "--format=%(refname)", &prefix])
        .output()
    {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let _ = Command::new("git")
                    .arg("-C")
                    .arg(&repo_path)
                    .args(["update-ref", "-d", line])
                    .output();
            }
        }
    }
    let _ = std::fs::remove_file(checkpoint_index_path(&session_id));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
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
        assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
    }

    fn tmp_repo() -> (PathBuf, String) {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sway_checkpoint_test_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let session_id = format!("sess-{n}-{seq}");
        (dir, session_id)
    }

    fn cleanup(dir: &Path, session_id: &str) {
        std::fs::remove_dir_all(dir).ok();
        std::fs::remove_file(checkpoint_index_path(session_id)).ok();
    }

    #[test]
    fn snapshot_captures_untracked_files() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let created = checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        assert!(created);
        let checkpoints = list_checkpoints(&repo, &sid);
        assert_eq!(checkpoints.len(), 1);
        assert!(tree_has_file(&repo, &checkpoints[0].1, "a.txt").unwrap());
        cleanup(&dir, &sid);
    }

    #[test]
    fn snapshot_excludes_ignored_paths() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.join("ignored.txt"), "junk").unwrap();
        std::fs::write(dir.join("kept.txt"), "keep").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        let checkpoints = list_checkpoints(&repo, &sid);
        assert!(tree_has_file(&repo, &checkpoints[0].1, "kept.txt").unwrap());
        assert!(!tree_has_file(&repo, &checkpoints[0].1, "ignored.txt").unwrap());
        cleanup(&dir, &sid);
    }

    #[test]
    fn snapshot_never_touches_the_real_index() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("real.txt"), "v1").unwrap();
        git(&dir, &["add", "real.txt"]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        std::fs::write(dir.join("untracked.txt"), "x").unwrap();
        let before_status = git_capture(&repo, &["status", "--porcelain"]).unwrap();

        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();

        let after_status = git_capture(&repo, &["status", "--porcelain"]).unwrap();
        assert_eq!(before_status, after_status, "the user's real index/staging must be untouched");
        cleanup(&dir, &sid);
    }

    #[test]
    fn unchanged_tree_creates_no_new_ref() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        assert!(checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap());
        // No file changes since the last snapshot: the next boundary is a no-op.
        assert!(!checkpoint_snapshot(sid.clone(), repo.clone(), 200).unwrap());
        assert_eq!(list_checkpoints(&repo, &sid).len(), 1);
        cleanup(&dir, &sid);
    }

    #[test]
    fn changed_tree_creates_a_new_ref() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("a.txt"), "hello world").unwrap();
        assert!(checkpoint_snapshot(sid.clone(), repo.clone(), 200).unwrap());
        assert_eq!(list_checkpoints(&repo, &sid).len(), 2);
        cleanup(&dir, &sid);
    }

    #[test]
    fn non_repo_folder_snapshots_nothing_without_error() {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sway_not_a_repo_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        let sid = format!("sess-plain-{n}-{seq}");
        let repo = dir.to_string_lossy().into_owned();
        let result = checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        assert!(!result);
        assert!(list_checkpoints(&repo, &sid).is_empty());
        cleanup(&dir, &sid);
    }

    #[test]
    fn turn_diff_includes_a_file_written_after_the_boundary() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("bash_written.txt"), "written by a shell redirect").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 200).unwrap();

        let files = checkpoint_turn_files(repo.clone(), sid.clone(), 100).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "bash_written.txt");
        assert_eq!(files[0].status, "added");
        cleanup(&dir, &sid);
    }

    #[test]
    fn latest_turn_diffs_against_a_live_snapshot() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("mid_turn.txt"), "still running").unwrap();
        // No next prompt boundary yet: the diff still reflects the live tree.
        let files = checkpoint_turn_files(repo.clone(), sid.clone(), 100).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "mid_turn.txt");
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_edited_file_restores_pre_turn_content_only() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "before").unwrap();
        std::fs::write(dir.join("untouched.txt"), "stays").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("a.txt"), "after").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 200).unwrap();

        let action = checkpoint_revert_file(repo.clone(), sid.clone(), 100, "a.txt".into()).unwrap();
        assert_eq!(action, "restored");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "before");
        assert_eq!(std::fs::read_to_string(dir.join("untouched.txt")).unwrap(), "stays");
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_created_file_deletes_it() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("new_file.txt"), "created this turn").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 200).unwrap();

        let action = checkpoint_revert_file(repo.clone(), sid.clone(), 100, "new_file.txt".into()).unwrap();
        assert_eq!(action, "deleted");
        assert!(!dir.join("new_file.txt").exists());
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_deleted_file_recreates_it() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("gone.txt"), "will be deleted").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 200).unwrap();

        let action = checkpoint_revert_file(repo.clone(), sid.clone(), 100, "gone.txt".into()).unwrap();
        assert_eq!(action, "recreated");
        assert_eq!(std::fs::read_to_string(dir.join("gone.txt")).unwrap(), "will be deleted");
        cleanup(&dir, &sid);
    }

    #[test]
    fn prune_removes_all_refs_and_the_scratch_index() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "v1").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("a.txt"), "v2").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 200).unwrap();
        assert_eq!(list_checkpoints(&repo, &sid).len(), 2);
        assert!(checkpoint_index_path(&sid).exists());

        checkpoint_prune(repo.clone(), sid.clone()).unwrap();

        assert!(list_checkpoints(&repo, &sid).is_empty());
        assert!(!checkpoint_index_path(&sid).exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
