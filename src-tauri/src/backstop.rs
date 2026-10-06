// Worktree-identity backstops: a snapshot of the whole working tree taken
// immediately before a mechanical, destructive change (discard first, later
// stash and conflict resolution), so the change stays reversible even though it
// never becomes a commit.
//
// `checkpoint.rs` already writes something it calls a backstop, but those are
// keyed by *session*: they exist because a turn was reverted, and they live
// under `refs/tori/checkpoint/<sessionId>/`. A discard is something the user
// does with their own hands. There may be no session at all, and there is
// certainly no prompt boundary, so a session-keyed ref is the wrong home for it.
//
// The hard part here is ownership, not storage. `refs/tori/*` lives in the
// repository's *common* dir, which every worktree of a bare repo shares (only
// `refs/worktree/*` is per-worktree), so the ref itself cannot say which
// worktree took it. Worktree *names* cannot say either, because they are
// recycled: create `wave-2`, remove it, recreate it, and the new one would
// inherit the old one's backstops and offer to restore a tree it has never seen.
//
// So the ref stores only the tree, as a gc anchor, and the record that *owns* it
// lives in a sidecar under the worktree's **own** git dir
// (`.bare/worktrees/<name>/tori/`), which `git worktree remove` deletes along
// with everything else in that directory. Listing reads the sidecar and never
// the refs, so a worktree can only ever see its own backstops, and a recreated
// worktree of the same name starts with an empty sidecar and a freshly minted id
// and inherits nothing. `backstop_prune` sweeps the refs whose sidecar is gone.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::checkpoint::{
    count_lines, git_output, parse_name_status, parse_raw_change, write_blob_to_disk, write_tree_scratch,
    CheckpointFile,
};

/// How many backstops one worktree keeps. Each costs a tree object and a ref,
/// and a tree that shares almost every blob with its neighbours is cheap, so the
/// bound is about keeping the timeline readable rather than about disk.
const RETENTION: usize = 20;

fn git_run(repo: &str, args: &[&str]) -> Result<(), String> {
    let out = crate::exec::git_in(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

fn git_capture(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = crate::exec::git_in(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn is_git_worktree(repo: &str) -> bool {
    git_capture(repo, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Ok("true")
}

/// This worktree's own admin directory: `.bare/worktrees/<name>` for a linked
/// worktree, `<repo>/.git` for the main one. Deliberately *not* the common dir,
/// which is the whole point of the sidecar.
fn sidecar_dir(repo: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(git_capture(repo, &["rev-parse", "--absolute-git-dir"])?).join("tori"))
}

/// The identity token minted the first time this worktree takes a backstop.
/// Nothing derives it from the worktree's name or path, so a removed-and-
/// recreated worktree gets a different one, which is exactly what stops it
/// inheriting the old refs.
fn worktree_id(dir: &Path) -> Result<String, String> {
    let path = dir.join("id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Creation time plus pid. Two Tori processes racing to mint an id for the
    // same worktree would leave one set of refs unclaimed, which `backstop_prune`
    // sweeps; no record is lost, because a record names its tree directly.
    let id = format!("{nanos:x}-{:x}", std::process::id());
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(&path, &id).map_err(|e| e.to_string())?;
    Ok(id)
}

fn records_path(dir: &Path) -> PathBuf {
    dir.join("backstops.json")
}

/// The scratch index lives in the sidecar too, so git's stat-cache stays warm
/// per worktree and the file dies with the worktree like everything else here.
fn index_path(dir: &Path) -> PathBuf {
    dir.join("backstop-index")
}

fn ref_prefix(id: &str) -> String {
    format!("refs/tori/discard/{id}/")
}

fn ref_name(id: &str, ts: u64) -> String {
    format!("{}{}", ref_prefix(id), ts)
}

/// One backstop, as the taking worktree recorded it.
///
/// `tree` is what restore actually reads; the ref exists only to keep that tree
/// reachable. Keeping the oid in the record means a re-minted worktree id
/// (see `worktree_id`) orphans refs but never orphans a restorable snapshot.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BackstopRecord {
    /// Epoch **seconds**, matching the prompt-boundary timestamps the rest of
    /// the timeline is keyed by, so the two kinds of row sort together.
    pub ts: u64,
    pub tree: String,
    /// The worktree this was taken in, canonicalised. Checked on restore, so a
    /// record that somehow travels (a copied git dir, a moved worktree) refuses
    /// rather than writing one worktree's files into another.
    pub worktree_path: String,
    /// HEAD at snapshot time; `""` for an unborn HEAD.
    pub head: String,
    /// What was about to happen, e.g. "Discard 3 hunks in src/a.ts". Shown on
    /// the row, which is the only thing distinguishing one backstop from another.
    pub label: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RestoreOutcome {
    /// Repo-relative paths the restore rewrote, and paths it removed, so open
    /// buffers on those files can reload rather than saving over the restore.
    pub restored: Vec<String>,
    pub deleted: Vec<String>,
}

fn canonical(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

fn read_records(dir: &Path) -> Vec<BackstopRecord> {
    std::fs::read_to_string(records_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_records(dir: &Path, records: &[BackstopRecord]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(records).map_err(|e| e.to_string())?;
    std::fs::write(records_path(dir), json).map_err(|e| e.to_string())
}

fn head_now(repo: &str) -> String {
    git_capture(repo, &["rev-parse", "HEAD"]).unwrap_or_default()
}

/// Take a backstop of the working tree as it is right now.
///
/// The crate-internal entry point: discard, stash and conflict resolution all
/// call this before touching a file, so every one of them is undoable from the
/// timeline. Returns the record, whose `ts` is what a later restore is keyed by.
pub(crate) fn take(repo: &str, label: &str) -> Result<BackstopRecord, String> {
    if !is_git_worktree(repo) {
        return Err("This folder isn't a git repository, so it can't be backed up.".into());
    }
    let dir = sidecar_dir(repo)?;
    let id = worktree_id(&dir)?;
    let tree = write_tree_scratch(repo, &index_path(&dir))?;

    let mut records = read_records(&dir);
    records.sort_by_key(|r| r.ts);
    let mut ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    // Monotonic past the newest record, not merely free of collisions. Two
    // discards inside the same second would otherwise share a ref name and the
    // second would overwrite the first. Worse, retention prunes the *oldest*
    // ts, so a collision-only rule would hand the freed low slot to the next
    // backstop, which retention would then drop again as the oldest the instant
    // it was written: the snapshot the user is about to need most, gone.
    if let Some(newest) = records.last() {
        ts = ts.max(newest.ts + 1);
    }

    git_run(repo, &["update-ref", &ref_name(&id, ts), &tree])?;
    let record = BackstopRecord {
        ts,
        tree,
        worktree_path: canonical(repo),
        head: head_now(repo),
        label: label.to_string(),
    };
    records.push(record.clone());
    prune_to_retention(repo, &id, &mut records);
    write_records(&dir, &records)?;
    Ok(record)
}

/// Drop everything past the retention bound, oldest first, deleting each ref as
/// it goes so the ref list stops growing rather than just the listing.
fn prune_to_retention(repo: &str, id: &str, records: &mut Vec<BackstopRecord>) {
    while records.len() > RETENTION {
        let dropped = records.remove(0);
        let _ = git_run(repo, &["update-ref", "-d", &ref_name(id, dropped.ts)]);
    }
}

/// Which worktree a `ts` belongs to, from where this one is standing.
enum Found {
    Mine(BackstopRecord),
    /// A ref exists at that timestamp, but under another worktree's id. Named
    /// separately so the refusal can say *why* rather than "not found".
    Foreign,
    Missing,
}

fn find(repo: &str, dir: &Path, ts: u64) -> Found {
    if let Some(rec) = read_records(dir).into_iter().find(|r| r.ts == ts) {
        return Found::Mine(rec);
    }
    let listed = git_capture(repo, &["for-each-ref", "--format=%(refname)", "refs/tori/discard/"]).unwrap_or_default();
    let suffix = format!("/{ts}");
    if listed.lines().any(|name| name.ends_with(&suffix)) {
        return Found::Foreign;
    }
    Found::Missing
}

/// Resolve a `ts` to a restorable record, refusing with a reason that names the
/// actual problem rather than a generic miss.
fn resolve(repo: &str, ts: u64) -> Result<BackstopRecord, String> {
    // Ahead of `sidecar_dir`, which would otherwise answer a non-repo folder
    // with git's own stderr instead of a sentence.
    if !is_git_worktree(repo) {
        return Err("This folder isn't a git repository, so it has no backups.".into());
    }
    let dir = sidecar_dir(repo)?;
    let rec = match find(repo, &dir, ts) {
        Found::Mine(rec) => rec,
        Found::Foreign => {
            return Err("That backup was taken in a different worktree, so it can't be restored here.".into())
        }
        Found::Missing => return Err("There's no backup at that point.".into()),
    };
    if rec.worktree_path != canonical(repo) {
        return Err(format!(
            "That backup was taken in {}, not this folder.",
            rec.worktree_path
        ));
    }
    // The ref is the only thing keeping the tree reachable, so a hand-deleted
    // ref means the snapshot itself may be gone.
    if git_run(repo, &["cat-file", "-e", &format!("{}^{{tree}}", rec.tree)]).is_err() {
        return Err("That backup's snapshot is no longer in the repository.".into());
    }
    Ok(rec)
}

/// Write `target`'s version of every path that differs from the working tree,
/// optionally narrowed to one file. Deletions in `target` become deletions on
/// disk, so a file created after the snapshot goes away again.
fn restore_from(repo: &str, target: &str, only: Option<&str>) -> Result<RestoreOutcome, String> {
    let dir = sidecar_dir(repo)?;
    let current = write_tree_scratch(repo, &index_path(&dir))?;
    let mut args = vec!["diff", "--raw", "--no-abbrev", "--no-renames", &current, target];
    if let Some(file) = only {
        args.push("--");
        args.push(file);
    }
    let raw = git_capture(repo, &args)?;

    let mut restored = Vec::new();
    let mut deleted = Vec::new();
    for line in raw.lines() {
        let Some(change) = parse_raw_change(line) else { continue };
        let abs = Path::new(repo).join(&change.path);
        if change.dst_mode == "000000" {
            match std::fs::remove_file(&abs) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
            deleted.push(change.path);
        } else {
            write_blob_to_disk(repo, &change, &abs)?;
            restored.push(change.path);
        }
    }
    Ok(RestoreOutcome { restored, deleted })
}

/// Take a backstop before a mechanical, multi-file change the user did not type.
///
/// Errors on a non-git folder rather than silently going ahead: the caller has
/// to decide what an un-undoable rewrite is worth, and a `take` that quietly
/// returned nothing would let it write with no way back.
#[tauri::command]
pub async fn backstop_take(repo_path: String, label: String) -> Result<BackstopRecord, String> {
    crate::exec::git_write("backstop_take", repo_path.clone(), move || {
        backstop_take_body(repo_path, label)
    })
    .await
}

pub(crate) fn backstop_take_body(repo_path: String, label: String) -> Result<BackstopRecord, String> {
    take(&repo_path, &label)
}

/// Whether this folder can be backed up at all, so a caller can refuse a
/// multi-file rewrite *before* asking the user to confirm one, rather than
/// discovering it from a failed `backstop_take` halfway through.
#[tauri::command(async)]
pub fn backstop_available(repo_path: String) -> bool {
    is_git_worktree(&repo_path)
}

/// This worktree's backstops, newest last. Reads the sidecar, never the refs,
/// which is what keeps another worktree's backstops out of the list even though
/// the refs themselves are shared.
#[tauri::command(async)]
pub fn backstop_list(repo_path: String) -> Result<Vec<BackstopRecord>, String> {
    if !is_git_worktree(&repo_path) {
        return Ok(Vec::new());
    }
    let dir = sidecar_dir(&repo_path)?;
    let mut records = read_records(&dir);
    records.sort_by_key(|r| r.ts);
    Ok(records)
}

/// What has changed in the working tree since a backstop was taken, which is
/// what restoring it would undo.
///
/// Behind the write lock although it changes no file the user owns: the scratch
/// index it snapshots through is the one `take` writes, and git fails on a
/// held `index.lock` rather than waiting for it.
#[tauri::command]
pub async fn backstop_files(repo_path: String, ts: u64) -> Result<Vec<CheckpointFile>, String> {
    crate::exec::git_write("backstop_files", repo_path.clone(), move || {
        backstop_files_body(repo_path, ts)
    })
    .await
}

pub(crate) fn backstop_files_body(repo_path: String, ts: u64) -> Result<Vec<CheckpointFile>, String> {
    let rec = resolve(&repo_path, ts)?;
    let current = write_tree_scratch(&repo_path, &index_path(&sidecar_dir(&repo_path)?))?;
    if current == rec.tree {
        return Ok(Vec::new());
    }
    let mut files = parse_name_status(&git_capture(
        &repo_path,
        &["diff", "--name-status", &rec.tree, &current],
    )?);
    count_lines(&repo_path, &rec.tree, &current, &mut files);
    Ok(files)
}

/// Unified diff text for one file, from a backstop to the working tree.
#[tauri::command]
pub async fn backstop_diff_file(repo_path: String, ts: u64, file: String) -> Result<String, String> {
    crate::exec::git_write("backstop_diff_file", repo_path.clone(), move || {
        backstop_diff_file_body(repo_path, ts, file)
    })
    .await
}

pub(crate) fn backstop_diff_file_body(repo_path: String, ts: u64, file: String) -> Result<String, String> {
    let rec = resolve(&repo_path, ts)?;
    let current = write_tree_scratch(&repo_path, &index_path(&sidecar_dir(&repo_path)?))?;
    git_output(&repo_path, &["diff", "--no-color", &rec.tree, &current, "--", &file])
}

/// Put the whole working tree back to a backstop.
///
/// Refuses when HEAD has moved since the snapshot. A whole-tree restore across a
/// commit or a branch switch would drag content from a different base back over
/// everything, and unlike the single-file case there is no version of that the
/// user could have meant.
#[tauri::command]
pub async fn backstop_restore_tree(repo_path: String, ts: u64) -> Result<RestoreOutcome, String> {
    crate::exec::git_write("backstop_restore_tree", repo_path.clone(), move || {
        backstop_restore_tree_body(repo_path, ts)
    })
    .await
}

pub(crate) fn backstop_restore_tree_body(repo_path: String, ts: u64) -> Result<RestoreOutcome, String> {
    let rec = resolve(&repo_path, ts)?;
    if rec.head != head_now(&repo_path) {
        return Err(
            "The branch has moved since that backup, so restoring the whole tree would undo commits too. Restore the files you need one at a time."
                .into(),
        );
    }
    restore_from(&repo_path, &rec.tree, None)
}

/// Put one file back to a backstop.
///
/// The blast radius is a single path, so a moved HEAD is a warning rather than a
/// wall: it refuses by default, and `force` goes ahead. That mirrors
/// `checkpoint_revert_file`, where the same trade-off already lives.
#[tauri::command]
pub async fn backstop_restore_file(
    repo_path: String,
    ts: u64,
    file: String,
    force: Option<bool>,
) -> Result<RestoreOutcome, String> {
    crate::exec::git_write("backstop_restore_file", repo_path.clone(), move || {
        backstop_restore_file_body(repo_path, ts, file, force)
    })
    .await
}

pub(crate) fn backstop_restore_file_body(
    repo_path: String,
    ts: u64,
    file: String,
    force: Option<bool>,
) -> Result<RestoreOutcome, String> {
    let rec = resolve(&repo_path, ts)?;
    if rec.head != head_now(&repo_path) && !force.unwrap_or(false) {
        return Err(
            "The branch has moved since that backup, so this file's contents come from a different commit.".into(),
        );
    }
    restore_from(&repo_path, &rec.tree, Some(&file))
}

/// Delete every `refs/tori/discard/` ref whose worktree no longer exists.
///
/// The sidecar dies with `git worktree remove`, but the refs live in the shared
/// common dir and outlive it, so without this sweep a long-lived bare repo would
/// accumulate the refs of every worktree it ever had. A ref is live when some
/// worktree's sidecar still claims its id. Returns how many were removed.
#[tauri::command]
pub async fn backstop_prune(repo_path: String) -> Result<usize, String> {
    crate::exec::git_write("backstop_prune", repo_path.clone(), move || {
        backstop_prune_body(repo_path)
    })
    .await
}

pub(crate) fn backstop_prune_body(repo_path: String) -> Result<usize, String> {
    if !is_git_worktree(&repo_path) {
        return Ok(0);
    }
    let listed = git_capture(&repo_path, &["worktree", "list", "--porcelain"])?;
    let live: Vec<String> = listed
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        // A worktree that has never taken a backstop has no sidecar and no id,
        // and claims nothing. That is correct: it owns no refs either.
        .filter_map(|path| sidecar_dir(path).ok())
        .filter_map(|dir| std::fs::read_to_string(dir.join("id")).ok())
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();

    let refs = git_capture(
        &repo_path,
        &["for-each-ref", "--format=%(refname)", "refs/tori/discard/"],
    )?;
    let mut removed = 0;
    for name in refs.lines() {
        let Some(rest) = name.strip_prefix("refs/tori/discard/") else {
            continue;
        };
        let Some((id, _)) = rest.rsplit_once('/') else { continue };
        if live.iter().any(|l| l == id) {
            continue;
        }
        if git_run(&repo_path, &["update-ref", "-d", name]).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, Ordering};

    fn git(dir: &Path, args: &[&str]) {
        let out = crate::platform::process::command("git")
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

    /// A repo with one commit, so HEAD is born and `git worktree add` works.
    fn tmp_repo() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori_backstop_test_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        std::fs::write(dir.join("seed.txt"), "seed\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "seed"]);
        dir
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    // --- task 1: the snapshot leaves the user's index alone ----------------

    #[test]
    fn a_snapshot_writes_a_tree_ref_without_touching_the_real_index() {
        let dir = tmp_repo();
        let repo = s(&dir);
        // Something staged, and something not. The staged half is the hazard:
        // a snapshot that ran `git add -A` against the real index would swallow
        // the unstaged half into the user's commit.
        std::fs::write(dir.join("staged.txt"), "staged\n").unwrap();
        git(&dir, &["add", "staged.txt"]);
        std::fs::write(dir.join("loose.txt"), "loose\n").unwrap();
        let before = git_capture(&repo, &["diff", "--cached", "--name-only"]).unwrap();

        let rec = take(&repo, "test").unwrap();

        assert_eq!(
            git_capture(&repo, &["diff", "--cached", "--name-only"]).unwrap(),
            before,
            "the user's staging is untouched"
        );
        assert_eq!(before, "staged.txt");
        // The ref anchors the tree, and the tree holds the unstaged file too.
        let listed = git_capture(&repo, &["for-each-ref", "--format=%(objectname)", "refs/tori/discard/"]).unwrap();
        assert_eq!(listed, rec.tree);
        let names = git_capture(&repo, &["ls-tree", "--name-only", "-r", &rec.tree]).unwrap();
        assert!(
            names.contains("loose.txt"),
            "the snapshot spans the whole tree: {names}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- task 2 and 3: identity, not name ---------------------------------

    #[test]
    fn a_recreated_worktree_of_the_same_name_inherits_no_backstops() {
        let dir = tmp_repo();
        let wt = dir.join("wt");
        git(&dir, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
        let side = s(&wt);

        std::fs::write(wt.join("a.txt"), "one\n").unwrap();
        take(&side, "first").unwrap();
        assert_eq!(backstop_list(side.clone()).unwrap().len(), 1);

        // Removed and recreated under the *same name*, which is the case a
        // name-keyed scheme would get wrong.
        git(&dir, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
        git(&dir, &["worktree", "add", "-q", "-B", "side", wt.to_str().unwrap()]);

        assert!(
            backstop_list(side.clone()).unwrap().is_empty(),
            "the sidecar went with the worktree, so the new one starts empty"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn another_worktrees_backstop_is_neither_listed_nor_restorable() {
        let dir = tmp_repo();
        let a = s(&dir);
        let wt = dir.join("wt-b");
        git(&dir, &["worktree", "add", "-q", "-b", "b", wt.to_str().unwrap()]);
        let b = s(&wt);

        std::fs::write(dir.join("a.txt"), "from a\n").unwrap();
        let rec = take(&a, "in a").unwrap();

        assert!(
            backstop_list(b.clone()).unwrap().is_empty(),
            "A's backstop is invisible from B even though the ref is shared"
        );
        // Hand-forcing A's timestamp from B: refused, and the reason says why.
        let err = backstop_restore_tree_body(b.clone(), rec.ts).unwrap_err();
        assert!(err.contains("different worktree"), "unhelpful refusal: {err}");

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- task 4: restore ---------------------------------------------------

    #[test]
    fn a_file_deleted_after_a_snapshot_comes_back_byte_identical() {
        let dir = tmp_repo();
        let repo = s(&dir);
        let body = "alpha\nbeta\r\ngamma\n\u{00e9}\n";
        std::fs::write(dir.join("doomed.txt"), body).unwrap();
        let rec = take(&repo, "before the discard").unwrap();

        std::fs::remove_file(dir.join("doomed.txt")).unwrap();
        // And a file that did not exist at snapshot time, which the restore
        // should take back off disk.
        std::fs::write(dir.join("later.txt"), "later\n").unwrap();

        let out = backstop_restore_tree_body(repo.clone(), rec.ts).unwrap();

        assert_eq!(std::fs::read_to_string(dir.join("doomed.txt")).unwrap(), body);
        assert!(out.restored.contains(&"doomed.txt".to_string()));
        assert!(out.deleted.contains(&"later.txt".to_string()));
        assert!(!dir.join("later.txt").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restoring_one_file_leaves_the_rest_of_the_tree_alone() {
        let dir = tmp_repo();
        let repo = s(&dir);
        std::fs::write(dir.join("one.txt"), "original\n").unwrap();
        std::fs::write(dir.join("two.txt"), "original\n").unwrap();
        let rec = take(&repo, "before").unwrap();

        std::fs::write(dir.join("one.txt"), "clobbered\n").unwrap();
        std::fs::write(dir.join("two.txt"), "deliberate\n").unwrap();

        let out = backstop_restore_file_body(repo.clone(), rec.ts, "one.txt".into(), None).unwrap();

        assert_eq!(out.restored, ["one.txt"]);
        assert_eq!(std::fs::read_to_string(dir.join("one.txt")).unwrap(), "original\n");
        assert_eq!(
            std::fs::read_to_string(dir.join("two.txt")).unwrap(),
            "deliberate\n",
            "a single-file restore is not a tree restore"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_tree_restore_is_refused_once_head_has_moved() {
        let dir = tmp_repo();
        let repo = s(&dir);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        let rec = take(&repo, "before").unwrap();

        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "moved on"]);
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();

        let err = backstop_restore_tree_body(repo.clone(), rec.ts).unwrap_err();
        assert!(err.contains("branch has moved"), "unhelpful refusal: {err}");
        // One file at a time still works, with force, because the blast radius
        // is a single path the user named.
        backstop_restore_file_body(repo.clone(), rec.ts, "a.txt".into(), Some(true)).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- task 5: pruning ---------------------------------------------------

    #[test]
    fn backstops_stop_accumulating_past_the_retention_bound() {
        let dir = tmp_repo();
        let repo = s(&dir);
        for i in 0..RETENTION + 5 {
            std::fs::write(dir.join("a.txt"), format!("{i}\n")).unwrap();
            take(&repo, &format!("take {i}")).unwrap();
        }

        let records = backstop_list(repo.clone()).unwrap();
        assert_eq!(records.len(), RETENTION);
        assert_eq!(records.last().unwrap().label, format!("take {}", RETENTION + 4));
        let refs = git_capture(&repo, &["for-each-ref", "--format=%(refname)", "refs/tori/discard/"]).unwrap();
        assert_eq!(
            refs.lines().count(),
            RETENTION,
            "the refs are dropped with the records, not just hidden from the list"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pruning_drops_the_refs_of_a_worktree_that_is_gone() {
        let dir = tmp_repo();
        let main = s(&dir);
        let wt = dir.join("wt-c");
        git(&dir, &["worktree", "add", "-q", "-b", "c", wt.to_str().unwrap()]);
        let side = s(&wt);

        std::fs::write(dir.join("a.txt"), "main\n").unwrap();
        take(&main, "main's").unwrap();
        std::fs::write(wt.join("b.txt"), "side\n").unwrap();
        take(&side, "side's").unwrap();
        let all = |repo: &str| {
            git_capture(repo, &["for-each-ref", "--format=%(refname)", "refs/tori/discard/"])
                .unwrap()
                .lines()
                .count()
        };
        assert_eq!(all(&main), 2);

        git(&dir, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
        assert_eq!(
            all(&main),
            2,
            "the refs are shared, so removal alone leaves them behind"
        );

        assert_eq!(backstop_prune_body(main.clone()).unwrap(), 1);
        assert_eq!(all(&main), 1, "only the departed worktree's ref went");
        assert_eq!(backstop_list(main.clone()).unwrap().len(), 1, "main keeps its own");

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- the command surface ------------------------------------------------

    #[test]
    fn taking_a_backstop_by_command_records_a_ref_and_a_sidecar_entry() {
        let dir = tmp_repo();
        let repo = s(&dir);
        std::fs::write(dir.join("a.ts"), "const before = 1\n").unwrap();

        let rec = backstop_take_body(repo.clone(), "Rename `before` in 3 files".into()).unwrap();

        assert_eq!(rec.label, "Rename `before` in 3 files");
        // Listed, so the timeline can offer it, and the ref exists so the tree
        // it names survives gc.
        let listed = backstop_list(repo.clone()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].ts, rec.ts);
        let refs = git_capture(&repo, &["for-each-ref", "--format=%(refname)", "refs/tori/discard/"]).unwrap();
        assert_eq!(refs.lines().count(), 1);

        // And it actually restores: the whole point of taking one before a
        // mechanical rewrite.
        std::fs::write(dir.join("a.ts"), "const after = 1\n").unwrap();
        backstop_restore_tree_body(repo.clone(), rec.ts).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.ts")).unwrap(), "const before = 1\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_plain_folder_reports_no_backstop_and_refuses_to_take_one() {
        // Tori opens folders that are not repositories. A caller has to be able
        // to ask *before* it offers the user an operation it could not undo,
        // rather than finding out from a failed take partway through.
        let dir = std::env::temp_dir().join(format!("tori_backstop_plain_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let plain = s(&dir);

        assert!(!backstop_available(plain.clone()));
        let err = backstop_take_body(plain.clone(), "whatever".into()).unwrap_err();
        assert!(err.contains("isn't a git repository"), "{err}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_repository_reports_a_backstop_is_available() {
        let dir = tmp_repo();
        assert!(backstop_available(s(&dir)));
        std::fs::remove_dir_all(&dir).ok();
    }
}
