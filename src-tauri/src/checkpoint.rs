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

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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

/// A backstop's ref carries a `.backstop` suffix after the timestamp, so the
/// timeline can label it without a side table; `parse_ref_segment` reads it
/// back. A plain prompt-boundary snapshot has no suffix.
const KIND_BACKSTOP: &str = "backstop";

fn backstop_ref_name(session_id: &str, ts: u64) -> String {
    format!("{}{}.{}", ref_prefix(session_id), ts, KIND_BACKSTOP)
}

/// `"1700.backstop"` -> `(1700, "backstop")`; `"1700"` -> `(1700, "")`.
fn parse_ref_segment(segment: &str) -> Option<(u64, String)> {
    match segment.split_once('.') {
        Some((ts, kind)) => Some((ts.parse().ok()?, kind.to_string())),
        None => Some((segment.parse().ok()?, String::new())),
    }
}

#[derive(Clone, Debug)]
struct Checkpoint {
    ts: u64,
    tree: String,
    /// "" for a prompt-boundary snapshot, "backstop" for the pre-revert
    /// safety snapshot `checkpoint_revert_tree` writes.
    kind: String,
}

/// Every existing checkpoint ref for this session, ascending by `ts`.
fn list_checkpoints(repo: &str, session_id: &str) -> Vec<Checkpoint> {
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
    let mut entries: Vec<Checkpoint> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (name, tree) = line.split_once(' ')?;
            let (ts, kind) = parse_ref_segment(name.strip_prefix(&prefix)?)?;
            Some(Checkpoint { ts, tree: tree.to_string(), kind })
        })
        .collect();
    entries.sort_by_key(|c| c.ts);
    entries
}

fn tree_at_or_before(checkpoints: &[Checkpoint], ts: u64) -> String {
    checkpoints
        .iter()
        .rev()
        .find(|c| c.ts <= ts)
        .map(|c| c.tree.clone())
        .unwrap_or_else(|| EMPTY_TREE.to_string())
}

fn tree_after(
    repo: &str,
    session_id: &str,
    checkpoints: &[Checkpoint],
    ts: u64,
) -> Result<String, String> {
    if let Some(c) = checkpoints.iter().find(|c| c.ts > ts) {
        return Ok(c.tree.clone());
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
    if checkpoints.iter().any(|c| c.ts == prompt_ts) {
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

/// The "after" side of a turn's diff. Normally the next prompt boundary (or a
/// live snapshot for the still-open latest turn); with `cumulative`, always
/// the live working tree, which is what the timeline's "workspace since here"
/// view compares against.
fn diff_after(
    repo: &str,
    session_id: &str,
    checkpoints: &[Checkpoint],
    prompt_ts: u64,
    cumulative: Option<bool>,
) -> Result<String, String> {
    if cumulative.unwrap_or(false) {
        return write_tree_scratch(repo, &checkpoint_index_path(session_id));
    }
    tree_after(repo, session_id, checkpoints, prompt_ts)
}

/// Files that changed during the turn starting at `prompt_ts`: tree-vs-tree
/// between this boundary's checkpoint and the next one (or a live snapshot
/// for the latest, still-open turn).
///
/// With `cumulative`, the range instead runs from this boundary to the working
/// tree as it is right now. That span is *not* this session's own work: it
/// also contains the user's edits and any other session's, which is why the UI
/// labels it "workspace since here" rather than attributing it.
#[tauri::command]
pub fn checkpoint_turn_files(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    cumulative: Option<bool>,
) -> Result<Vec<CheckpointFile>, String> {
    let checkpoints = list_checkpoints(&repo_path, &session_id);
    let before = tree_at_or_before(&checkpoints, prompt_ts);
    let after = diff_after(&repo_path, &session_id, &checkpoints, prompt_ts, cumulative)?;
    if before == after {
        return Ok(Vec::new());
    }
    let out = git_capture(&repo_path, &["diff", "--name-status", &before, &after])?;
    Ok(parse_name_status(&out))
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct CheckpointEntry {
    pub prompt_ts: u64,
    /// "" for a prompt-boundary snapshot, "backstop" for a pre-revert one.
    pub kind: String,
    pub file_count: usize,
    /// Approximate: the summed post-turn size of the blobs the turn wrote.
    /// Deletions contribute nothing, so it reads as "how much this turn put
    /// on disk", not as a net delta.
    pub bytes: u64,
}

/// The destination blob id of a `git diff --raw --no-abbrev` line
/// (`:<mode> <mode> <src> <dst> <status>\t<path>`). `None` for a deletion,
/// whose destination is the all-zero id.
fn raw_dst_blob(line: &str) -> Option<String> {
    let dst = line.split_whitespace().nth(3)?;
    if dst.chars().all(|c| c == '0') {
        return None;
    }
    Some(dst.to_string())
}

/// Size every blob id in one `cat-file --batch-check`, rather than a
/// subprocess per file: a long session's timeline touches thousands of blobs
/// and per-file spawns dominate everything else.
fn batch_blob_sizes(repo: &str, ids: &[String]) -> Result<HashMap<String, u64>, String> {
    let mut sizes = HashMap::new();
    if ids.is_empty() {
        return Ok(sizes);
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["cat-file", "--batch-check"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    {
        let mut stdin = child.stdin.take().ok_or("cat-file stdin unavailable")?;
        for id in ids {
            writeln!(stdin, "{id}").map_err(|e| e.to_string())?;
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        // "<id> blob <size>", or "<id> missing" for an id git can't resolve.
        let mut parts = line.split_whitespace();
        let (Some(id), Some(kind), Some(size)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if kind == "blob" {
            if let Ok(n) = size.parse::<u64>() {
                sizes.insert(id.to_string(), n);
            }
        }
    }
    Ok(sizes)
}

/// The session's checkpoints as an ordered timeline: prompt timestamp, kind,
/// how many files the turn starting there touched, and roughly how many bytes
/// it wrote. Empty (never an error) outside a git worktree or for a session
/// that has never snapshotted, so a non-repo folder simply shows no timeline.
#[tauri::command]
pub fn checkpoint_list(repo_path: String, session_id: String) -> Result<Vec<CheckpointEntry>, String> {
    if !is_git_worktree(&repo_path) {
        return Ok(Vec::new());
    }
    let checkpoints = list_checkpoints(&repo_path, &session_id);
    if checkpoints.is_empty() {
        return Ok(Vec::new());
    }
    // Per turn: one `--raw` diff yields both the file count and the post-turn
    // blob ids. The ids are sized afterwards in a single batched `cat-file`.
    let mut per_turn: Vec<(usize, Vec<String>)> = Vec::with_capacity(checkpoints.len());
    for cp in &checkpoints {
        let after = tree_after(&repo_path, &session_id, &checkpoints, cp.ts)?;
        if after == cp.tree {
            per_turn.push((0, Vec::new()));
            continue;
        }
        let raw = git_capture(&repo_path, &["diff", "--raw", "--no-abbrev", &cp.tree, &after])?;
        let blobs: Vec<String> = raw.lines().filter_map(raw_dst_blob).collect();
        per_turn.push((raw.lines().count(), blobs));
    }
    let mut all: Vec<String> = per_turn.iter().flat_map(|(_, b)| b.iter().cloned()).collect();
    all.sort();
    all.dedup();
    let sizes = batch_blob_sizes(&repo_path, &all)?;
    Ok(checkpoints
        .iter()
        .zip(per_turn)
        .map(|(cp, (file_count, blobs))| CheckpointEntry {
            prompt_ts: cp.ts,
            kind: cp.kind.clone(),
            file_count,
            bytes: blobs.iter().filter_map(|b| sizes.get(b)).sum(),
        })
        .collect())
}

/// Unified diff text for one file within a turn's checkpoint-to-checkpoint
/// range.
#[tauri::command]
pub fn checkpoint_diff_file(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    file: String,
    cumulative: Option<bool>,
) -> Result<String, String> {
    let checkpoints = list_checkpoints(&repo_path, &session_id);
    let before = tree_at_or_before(&checkpoints, prompt_ts);
    let after = diff_after(&repo_path, &session_id, &checkpoints, prompt_ts, cumulative)?;
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

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct RevertOutcome {
    /// The pre-revert snapshot's timestamp, so the caller can name it in the
    /// confirm and the timeline can select it. `None` when the working tree
    /// already matched the target and nothing was written.
    pub backstop_ts: Option<u64>,
    /// Repo-relative paths the revert rewrote, and paths it removed, so open
    /// buffers on those files can reload or raise a conflict.
    pub restored: Vec<String>,
    pub deleted: Vec<String>,
}

/// One line of `git diff --raw --no-abbrev --no-renames`:
/// `:<src_mode> <dst_mode> <src_sha> <dst_sha> <status>\t<path>`.
struct RawChange {
    dst_mode: String,
    dst_sha: String,
    path: String,
}

fn parse_raw_change(line: &str) -> Option<RawChange> {
    let (meta, path) = line.split_once('\t')?;
    let mut fields = meta.split_whitespace();
    let _src_mode = fields.next()?;
    let dst_mode = fields.next()?.to_string();
    let _src_sha = fields.next()?;
    let dst_sha = fields.next()?.to_string();
    Some(RawChange { dst_mode, dst_sha, path: path.to_string() })
}

/// Write a blob from the object store to `abs`, honouring the tree's mode:
/// a `120000` entry is a symlink (its blob content is the link target, which
/// must not be written as a regular file), `100755` keeps the exec bit.
fn write_blob_to_disk(repo: &str, change: &RawChange, abs: &Path) -> Result<(), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["cat-file", "blob", &change.dst_sha])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // An existing entry of the wrong shape (file where a symlink belongs, or
    // vice versa) has to go before the right one can be created.
    if abs.symlink_metadata().is_ok() {
        std::fs::remove_file(abs).map_err(|e| e.to_string())?;
    }
    if change.dst_mode == "120000" {
        #[cfg(unix)]
        {
            let target = String::from_utf8_lossy(&out.stdout).into_owned();
            std::os::unix::fs::symlink(target, abs).map_err(|e| e.to_string())?;
            return Ok(());
        }
        #[cfg(not(unix))]
        {
            std::fs::write(abs, &out.stdout).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    std::fs::write(abs, &out.stdout).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if change.dst_mode == "100755" {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(abs, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Snapshot `tree` as a backstop checkpoint stamped now, bumping past any ref
/// already at that second so a fast double-revert can't overwrite the first
/// backstop.
///
/// Epoch **seconds**, matching the prompt-boundary timestamps the rest of the
/// timeline is keyed by (`parse_rfc3339_secs` in sessions.rs). Milliseconds
/// here would put every backstop ~1000x above every real boundary, so each
/// later turn would sort before it and `tree_at_or_before` would resolve the
/// wrong tree.
fn write_backstop(
    repo: &str,
    session_id: &str,
    checkpoints: &[Checkpoint],
    tree: &str,
) -> Result<u64, String> {
    let mut ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    while checkpoints.iter().any(|c| c.ts == ts) {
        ts += 1;
    }
    git_run(repo, &["update-ref", &backstop_ref_name(session_id, ts), tree])?;
    Ok(ts)
}

/// Restore the whole working tree to the checkpoint at `prompt_ts`, after
/// first snapshotting the current state as a labeled backstop checkpoint, so
/// the revert is itself reversible from the timeline.
///
/// Only files that differ between the two trees are touched, and the user's
/// real index is never read or written, so staged-but-unrelated changes keep
/// their staging. Both trees came from `git add -A` against the scratch index,
/// so gitignored paths are absent from each and are never touched.
///
/// The liveness guard lives in the caller, not here: "Executing" is composed
/// from PTY activity and the transcript tail, which only the frontend sees
/// (see `revertGuard` in `src/utils/revertGuard.ts`).
#[tauri::command]
pub fn checkpoint_revert_tree(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
) -> Result<RevertOutcome, String> {
    if !is_git_worktree(&repo_path) {
        return Err("This folder isn't a git repository, so it has no checkpoints.".into());
    }
    let checkpoints = list_checkpoints(&repo_path, &session_id);
    let target = checkpoints
        .iter()
        .find(|c| c.ts == prompt_ts)
        .map(|c| c.tree.clone())
        .ok_or("No checkpoint at that point in the timeline.")?;
    let current = write_tree_scratch(&repo_path, &checkpoint_index_path(&session_id))?;
    if current == target {
        return Ok(RevertOutcome { backstop_ts: None, restored: Vec::new(), deleted: Vec::new() });
    }
    // Backstop before any write: if a later step fails, the pre-revert state
    // is already recoverable from the timeline.
    let backstop_ts = write_backstop(&repo_path, &session_id, &checkpoints, &current)?;

    let raw = git_capture(
        &repo_path,
        &["diff", "--raw", "--no-abbrev", "--no-renames", &current, &target],
    )?;
    let mut restored = Vec::new();
    let mut deleted = Vec::new();
    for line in raw.lines() {
        let Some(change) = parse_raw_change(line) else { continue };
        let abs = Path::new(&repo_path).join(&change.path);
        if change.dst_mode == "000000" {
            // Absent from the target tree: the revert removes it.
            match std::fs::remove_file(&abs) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
            deleted.push(change.path);
        } else {
            write_blob_to_disk(&repo_path, &change, &abs)?;
            restored.push(change.path);
        }
    }
    Ok(RevertOutcome { backstop_ts: Some(backstop_ts), restored, deleted })
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
        assert!(tree_has_file(&repo, &checkpoints[0].tree, "a.txt").unwrap());
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
        assert!(tree_has_file(&repo, &checkpoints[0].tree, "kept.txt").unwrap());
        assert!(!tree_has_file(&repo, &checkpoints[0].tree, "ignored.txt").unwrap());
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
    fn list_returns_checkpoints_in_order_with_per_turn_counts() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        // Turn 1 writes one file, turn 2 writes two, turn 3 is the open turn.
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("b.txt"), "bb").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 200).unwrap();
        std::fs::write(dir.join("c.txt"), "ccc").unwrap();
        std::fs::write(dir.join("d.txt"), "dddd").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 300).unwrap();

        let entries = checkpoint_list(repo.clone(), sid.clone()).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(
            entries.iter().map(|e| e.prompt_ts).collect::<Vec<_>>(),
            vec![100, 200, 300],
            "ascending by prompt timestamp"
        );
        assert_eq!(entries[0].file_count, 1, "turn 100 added b.txt");
        assert_eq!(entries[0].bytes, 2);
        assert_eq!(entries[1].file_count, 2, "turn 200 added c.txt and d.txt");
        assert_eq!(entries[1].bytes, 7);
        // The newest checkpoint is the still-open turn: nothing written since.
        assert_eq!(entries[2].file_count, 0);
        assert!(entries.iter().all(|e| e.kind.is_empty()));
        cleanup(&dir, &sid);
    }

    #[test]
    fn list_in_a_non_repo_folder_is_empty_not_an_error() {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sway_list_not_a_repo_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        let sid = format!("sess-list-plain-{n}-{seq}");
        let repo = dir.to_string_lossy().into_owned();
        assert_eq!(checkpoint_list(repo, sid.clone()).unwrap(), Vec::new());
        cleanup(&dir, &sid);
    }

    #[test]
    fn turn_diff_includes_a_file_written_after_the_boundary() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("bash_written.txt"), "written by a shell redirect").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 200).unwrap();

        let files = checkpoint_turn_files(repo.clone(), sid.clone(), 100, None).unwrap();
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
        let files = checkpoint_turn_files(repo.clone(), sid.clone(), 100, None).unwrap();
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
    fn cumulative_spans_every_turn_since_the_checkpoint() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("turn1.txt"), "one").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 200).unwrap();
        std::fs::write(dir.join("turn2.txt"), "two").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 300).unwrap();
        // An edit by someone other than the agent, after the last boundary.
        std::fs::write(dir.join("by_the_user.txt"), "mine").unwrap();

        // Per-turn stays scoped to its own boundary pair.
        let per_turn = checkpoint_turn_files(repo.clone(), sid.clone(), 100, None).unwrap();
        assert_eq!(per_turn.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["turn1.txt"]);

        // Cumulative runs from that boundary to the working tree, so it also
        // carries later turns *and* the user's own edit - which is exactly why
        // the UI calls it "workspace since here" rather than the session's work.
        let mut cumulative: Vec<String> = checkpoint_turn_files(repo.clone(), sid.clone(), 100, Some(true))
            .unwrap()
            .into_iter()
            .map(|f| f.path)
            .collect();
        cumulative.sort();
        assert_eq!(cumulative, vec!["by_the_user.txt", "turn1.txt", "turn2.txt"]);
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_tree_restores_every_file_and_removes_later_ones() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "v1").unwrap();
        std::fs::write(dir.join("keep.txt"), "same").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        // After the checkpoint: one edit, one brand-new file, one deletion.
        std::fs::write(dir.join("a.txt"), "v2").unwrap();
        std::fs::write(dir.join("added_later.txt"), "should vanish").unwrap();
        std::fs::remove_file(dir.join("keep.txt")).unwrap();

        let out = checkpoint_revert_tree(repo.clone(), sid.clone(), 100).unwrap();

        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "v1");
        assert_eq!(std::fs::read_to_string(dir.join("keep.txt")).unwrap(), "same");
        assert!(!dir.join("added_later.txt").exists(), "a post-checkpoint file is removed");
        assert_eq!(out.deleted, vec!["added_later.txt".to_string()]);
        assert!(out.restored.contains(&"a.txt".to_string()));
        assert!(out.restored.contains(&"keep.txt".to_string()));
        assert!(out.backstop_ts.is_some());
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_tree_backstop_round_trips_to_the_pre_revert_state() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "v1").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("a.txt"), "v2").unwrap();
        std::fs::write(dir.join("b.txt"), "new").unwrap();

        let out = checkpoint_revert_tree(repo.clone(), sid.clone(), 100).unwrap();
        let backstop = out.backstop_ts.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "v1");
        assert!(!dir.join("b.txt").exists());

        // The backstop is a first-class timeline entry, labeled as such.
        let entry = checkpoint_list(repo.clone(), sid.clone())
            .unwrap()
            .into_iter()
            .find(|e| e.prompt_ts == backstop)
            .expect("the backstop appears in the timeline");
        assert_eq!(entry.kind, "backstop");

        // Reverting to it undoes the revert.
        checkpoint_revert_tree(repo.clone(), sid.clone(), backstop).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "v2");
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "new");
        cleanup(&dir, &sid);
    }

    #[test]
    fn backstop_is_stamped_in_seconds_so_later_turns_sort_after_it() {
        // Regression: a backstop stamped in millis lands ~1000x above every
        // real prompt boundary (which is epoch seconds), so every turn taken
        // after a revert would sort *before* the backstop and
        // `tree_at_or_before` would resolve the wrong tree.
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        std::fs::write(dir.join("a.txt"), "v1").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), now - 60).unwrap();
        std::fs::write(dir.join("a.txt"), "v2").unwrap();

        let backstop = checkpoint_revert_tree(repo.clone(), sid.clone(), now - 60)
            .unwrap()
            .backstop_ts
            .unwrap();

        // Same order of magnitude as a real boundary, not a millisecond value.
        assert!(
            backstop.abs_diff(now) < 60,
            "backstop {backstop} should be epoch seconds near {now}"
        );

        // A turn that happens after the revert still sorts last.
        std::fs::write(dir.join("later.txt"), "after the revert").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), now + 30).unwrap();
        let order: Vec<u64> = checkpoint_list(repo.clone(), sid.clone())
            .unwrap()
            .into_iter()
            .map(|e| e.prompt_ts)
            .collect();
        assert_eq!(order, vec![now - 60, backstop, now + 30]);
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_tree_leaves_unrelated_staging_alone() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("reverted.txt"), "v1").unwrap();
        std::fs::write(dir.join("staged.txt"), "staged v1").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();

        // The user stages an edit. A whole-tree revert does rewrite the file
        // on disk (that is the point of a tree revert), but it must never
        // touch the *index*, so the staged snapshot survives intact.
        std::fs::write(dir.join("staged.txt"), "staged v2").unwrap();
        git(&dir, &["add", "staged.txt"]);
        let staged_before = git_capture(&repo, &["diff", "--cached", "--name-only"]).unwrap();
        std::fs::write(dir.join("reverted.txt"), "v2").unwrap();

        checkpoint_revert_tree(repo.clone(), sid.clone(), 100).unwrap();

        assert_eq!(std::fs::read_to_string(dir.join("reverted.txt")).unwrap(), "v1");
        assert_eq!(
            git_capture(&repo, &["diff", "--cached", "--name-only"]).unwrap(),
            staged_before,
            "the same files are still staged"
        );
        assert_eq!(
            git_capture(&repo, &["show", ":staged.txt"]).unwrap(),
            "staged v2",
            "the staged content itself survives the revert"
        );
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_tree_keeps_the_executable_bit() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        let script = dir.join("run.sh");
        std::fs::write(&script, "#!/bin/sh\necho v1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(&script, "#!/bin/sh\necho v2\n").unwrap();

        checkpoint_revert_tree(repo.clone(), sid.clone(), 100).unwrap();

        assert_eq!(std::fs::read_to_string(&script).unwrap(), "#!/bin/sh\necho v1\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&script).unwrap().permissions().mode() & 0o111, 0o111);
        }
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_tree_to_the_current_state_is_a_no_op_without_a_backstop() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "v1").unwrap();
        checkpoint_snapshot(sid.clone(), repo.clone(), 100).unwrap();

        let out = checkpoint_revert_tree(repo.clone(), sid.clone(), 100).unwrap();
        assert_eq!(out.backstop_ts, None, "nothing changed, so nothing to back up");
        assert!(out.restored.is_empty() && out.deleted.is_empty());
        assert_eq!(list_checkpoints(&repo, &sid).len(), 1, "no ref spam");
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_tree_in_a_non_repo_folder_errors_without_touching_disk() {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sway_revert_not_a_repo_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "untouched").unwrap();
        let sid = format!("sess-revert-plain-{n}-{seq}");
        let repo = dir.to_string_lossy().into_owned();
        assert!(checkpoint_revert_tree(repo, sid.clone(), 100).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "untouched");
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
