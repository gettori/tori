//! Every version of a file this editor ever saved, independent of what was
//! committed.
//!
//! Git remembers what you decided to keep. This remembers what you actually
//! had: the edit you made, saved, and replaced ten minutes later without ever
//! staging it is invisible to `git log` and is exactly the thing people go
//! looking for.
//!
//! **Blobs, not trees.** The checkpoint family ([[component_turn_checkpoints]])
//! snapshots the whole worktree at prompt boundaries, which costs a `git add -A`
//! and a `write-tree`. A save happens far more often than a prompt and concerns
//! exactly one file, so the unit here is `git hash-object -w` on that one file:
//! one object write, no index, no tree. Identical content dedups by blob sha,
//! so holding ⌘S changes nothing.
//!
//! **Refs are keyed by worktree.** A bare repo's worktrees share one ref store,
//! so `refs/tori/localhistory/*` would otherwise interleave the timelines of
//! `src/a.ts` in fifteen different checkouts into one list. The key is a hash of
//! the worktree's own toplevel, and a key with no live worktree behind it is
//! what the prune sweep collects.
//!
//! **The path is hashed too**, because a repo-relative path is not a legal ref
//! path: a leading-dot component, a `.lock` suffix and a `..` sequence are all
//! ordinary filenames and all rejected by `git update-ref`. The cost is that the
//! ref names say nothing on their own, which is acceptable for a family no
//! human reads and every entry of which is reachable from the file it belongs
//! to.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::checkpoint::{git_capture, git_output, git_run, is_git_worktree, relative_to};

/// How many versions of one file are kept. Generous: an entry is one blob, and
/// the reason to open this panel at all is usually "some time this week".
const MAX_PER_FILE: usize = 50;

/// How long an entry survives. Local history answers "what did I have recently";
/// past this, what you want is a commit.
const MAX_AGE_MS: u64 = 14 * 24 * 60 * 60 * 1000;

const FAMILY: &str = "refs/tori/localhistory";

/// One saved version, as the timeline lists it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// When it was saved, epoch milliseconds. Also its ref's last segment.
    pub ts: u64,
    /// The blob holding the bytes, for reading and diffing.
    pub blob: String,
    pub size: u64,
}

/// A short, filename-safe digest.
///
/// FNV-1a spelled out rather than `DefaultHasher`, which `search.rs` uses for
/// the same shape of job: std states plainly that its hasher's algorithm is
/// unspecified and its output must not be relied on across releases. That is
/// fine for a cache key inside one run and wrong here, where the digest *names
/// a ref* that has to still resolve after a toolchain upgrade. A hash that
/// changed underneath would orphan every timeline in the repo at once, and the
/// worktree sweep would then collect them, so the loss would be silent and
/// total.
///
/// Never a security boundary: a collision merges two files' timelines, which is
/// visible and harmless, rather than leaking anything.
fn digest(value: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// The worktree this repo path belongs to, as a key.
///
/// From `--show-toplevel` rather than the path handed in, so the same worktree
/// reached through a subdirectory or a symlinked parent keys the same way and
/// does not start a second timeline for the same file.
fn worktree_key(repo: &str) -> Option<String> {
    let top = git_capture(repo, &["rev-parse", "--show-toplevel"]).ok()?;
    if top.is_empty() {
        return None;
    }
    Some(digest(&top))
}

fn ref_prefix(wt: &str, path_key: &str) -> String {
    format!("{FAMILY}/{wt}/{path_key}/")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Every entry under a prefix, newest first.
fn entries_under(repo: &str, prefix: &str) -> Vec<HistoryEntry> {
    let out = match git_capture(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname) %(objectsize)",
            prefix,
        ],
    ) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    let mut entries: Vec<HistoryEntry> = out
        .lines()
        .filter_map(|line| {
            let mut parts = line.split(' ');
            let name = parts.next()?;
            let blob = parts.next()?;
            let size = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let ts = name.strip_prefix(prefix)?.parse().ok()?;
            Some(HistoryEntry {
                ts,
                blob: blob.to_string(),
                size,
            })
        })
        .collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.ts));
    entries
}

/// Delete refs in one `update-ref` call rather than one process per ref: a
/// prune can span a whole worktree's files.
fn delete_refs(repo: &str, names: &[String]) -> Result<(), String> {
    if names.is_empty() {
        return Ok(());
    }
    use std::io::Write;
    let mut child = crate::exec::git_in(repo)
        .args(["update-ref", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    {
        let stdin = child.stdin.as_mut().ok_or("no stdin")?;
        for name in names {
            writeln!(stdin, "delete {name}").map_err(|e| e.to_string())?;
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Trim one file's timeline to the age and count caps. Runs on every save, so
/// the caps hold from the first entry rather than needing a sweep to catch up.
fn enforce_caps(repo: &str, prefix: &str, now: u64) {
    let entries = entries_under(repo, prefix);
    let doomed: Vec<String> = entries
        .iter()
        .enumerate()
        .filter(|(i, e)| *i >= MAX_PER_FILE || now.saturating_sub(e.ts) > MAX_AGE_MS)
        .map(|(_, e)| format!("{prefix}{}", e.ts))
        .collect();
    let _ = delete_refs(repo, &doomed);
}

/// The prefix a file's entries live under, or `None` when the path is not in a
/// git worktree or not inside this repo.
fn prefix_for(repo: &str, path: &str) -> Option<String> {
    if !is_git_worktree(repo) {
        return None;
    }
    let rel = relative_to(repo, path)?;
    let wt = worktree_key(repo)?;
    Some(ref_prefix(&wt, &digest(&rel)))
}

/// Snapshot a file that was just saved.
///
/// Returns whether a new entry was written: identical content to the newest
/// entry writes nothing, so holding ⌘S or saving a file the formatter left
/// alone costs one `hash-object` and no ref.
///
/// Never an error the caller has to handle: a project that is not a git
/// worktree simply has no local history, which is not a failed save.
#[tauri::command]
pub async fn local_history_note(repo_path: String, path: String) -> Result<bool, String> {
    crate::exec::git_write("local_history_note", repo_path.clone(), move || {
        local_history_note_body(repo_path, path)
    })
    .await
}

pub(crate) fn local_history_note_body(repo_path: String, path: String) -> Result<bool, String> {
    let Some(prefix) = prefix_for(&repo_path, &path) else {
        return Ok(false);
    };
    if !Path::new(&path).is_file() {
        return Ok(false);
    }
    // `--no-filters`, deliberately: this records the bytes that are on disk, so
    // that restoring puts those bytes back. Running the repo's clean filter
    // would store what git *would* commit, and a restore would then hand the
    // file a version of itself it never had.
    let blob = git_capture(&repo_path, &["hash-object", "-w", "--no-filters", "--", &path])?;
    if blob.is_empty() {
        return Err("git hash-object wrote nothing".into());
    }
    let existing = entries_under(&repo_path, &prefix);
    if existing.first().is_some_and(|e| e.blob == blob) {
        return Ok(false);
    }
    let now = now_ms();
    // A second save inside the same millisecond would otherwise overwrite the
    // first, silently losing a version. Stepping past the newest keeps the
    // timeline strictly increasing without a clock the caller has to supply.
    let ts = match existing.first() {
        Some(e) if e.ts >= now => e.ts + 1,
        _ => now,
    };
    git_run(&repo_path, &["update-ref", &format!("{prefix}{ts}"), &blob])?;
    enforce_caps(&repo_path, &prefix, now);
    Ok(true)
}

/// One file's saved versions, newest first. Empty (never an error) outside a
/// git worktree or for a file nothing has saved.
#[tauri::command(async)]
pub fn local_history_list(repo_path: String, path: String) -> Result<Vec<HistoryEntry>, String> {
    let Some(prefix) = prefix_for(&repo_path, &path) else {
        return Ok(Vec::new());
    };
    Ok(entries_under(&repo_path, &prefix))
}

/// The text of one saved version, for the diff view.
///
/// `git_output`, not `git_capture`: the latter trims, and a version whose
/// leading indentation or trailing newline had been shaved off would diff
/// against the file as a change nobody made.
#[tauri::command(async)]
pub fn local_history_read(repo_path: String, blob: String) -> Result<String, String> {
    git_output(&repo_path, &["cat-file", "blob", &blob])
}

/// One saved version against the file as it is now, as a unified diff.
///
/// The working file is hashed into the object database so both sides are blobs
/// and `git diff` can do the work. `--no-index` over a temp file would avoid
/// the write, but it exits 1 whenever the two differ, which is the case this
/// exists to serve. The extra blob is unreferenced and collected by gc, and in
/// the usual case (nothing edited since the last save) it is already the newest
/// entry, so nothing new is written at all.
#[tauri::command(async)]
pub fn local_history_diff(repo_path: String, path: String, ts: u64) -> Result<String, String> {
    let Some(prefix) = prefix_for(&repo_path, &path) else {
        return Ok(String::new());
    };
    let entry = entries_under(&repo_path, &prefix)
        .into_iter()
        .find(|e| e.ts == ts)
        .ok_or("that version is no longer stored")?;
    let current = git_capture(&repo_path, &["hash-object", "-w", "--no-filters", "--", &path])?;
    git_output(&repo_path, &["diff", "--no-color", &entry.blob, &current])
}

/// Put a saved version back on disk.
///
/// A plain file write, never `git checkout` or an index update: the manual-git
/// invariant means restoring a version the user is looking at must not stage
/// anything, and whatever they had already staged has to survive it untouched.
#[tauri::command]
pub async fn local_history_restore(repo_path: String, path: String, ts: u64) -> Result<(), String> {
    crate::exec::git_write("local_history_restore", repo_path.clone(), move || {
        local_history_restore_body(repo_path, path, ts)
    })
    .await
}

pub(crate) fn local_history_restore_body(repo_path: String, path: String, ts: u64) -> Result<(), String> {
    let Some(prefix) = prefix_for(&repo_path, &path) else {
        return Err("this project is not a git worktree, so it has no local history".into());
    };
    let entry = entries_under(&repo_path, &prefix)
        .into_iter()
        .find(|e| e.ts == ts)
        .ok_or("that version is no longer stored")?;
    let bytes = crate::exec::git_in(&repo_path)
        .args(["cat-file", "blob", &entry.blob])
        .output()
        .map_err(|e| e.to_string())?;
    if !bytes.status.success() {
        return Err(String::from_utf8_lossy(&bytes.stderr).trim().to_string());
    }
    std::fs::write(&path, bytes.stdout).map_err(|e| e.to_string())
}

/// Every file under a directory, recursively. Symlinks are not followed: a link
/// out of the tree is not part of what was renamed, and following one could
/// walk the whole disk.
fn files_under(dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            files_under(&entry.path(), out);
        } else if kind.is_file() {
            out.push(entry.path().to_string_lossy().into_owned());
        }
    }
}

/// Carry a file's history to where the file went.
///
/// Called by the rename and drag-move paths: the timeline is keyed by path, so
/// without this a rename orphans every version under a name nothing will ever
/// ask about again. Entries already at the destination are kept and the moved
/// ones merged in, then the caps re-applied, since the destination may have had
/// a history of its own.
///
/// A **directory** rename is the same operation over everything inside it. Read
/// off the destination, which is where the files are by the time this is called:
/// each one's old path is its new path with the moved prefix swapped back, so no
/// listing has to be taken before the move.
#[tauri::command]
pub async fn local_history_rename(repo_path: String, from: String, to: String) -> Result<(), String> {
    crate::exec::git_write("local_history_rename", repo_path.clone(), move || {
        local_history_rename_body(repo_path, from, to)
    })
    .await
}

pub(crate) fn local_history_rename_body(repo_path: String, from: String, to: String) -> Result<(), String> {
    // Resolved once, ahead of any walk: `prefix_for` costs two `git rev-parse`
    // calls, and doing that per file would put several thousand subprocesses on
    // the rename path of a directory of any size.
    if !is_git_worktree(&repo_path) {
        return Ok(());
    }
    let Some(wt) = worktree_key(&repo_path) else {
        return Ok(());
    };
    if Path::new(&to).is_dir() {
        let mut moved = Vec::new();
        files_under(Path::new(&to), &mut moved);
        let base = format!("{to}/");
        for now_at in moved {
            let Some(rest) = now_at.strip_prefix(&base) else {
                continue;
            };
            rename_one(&repo_path, &wt, &format!("{from}/{rest}"), &now_at)?;
        }
        return Ok(());
    }
    rename_one(&repo_path, &wt, &from, &to)
}

/// One file's move, with the worktree key already resolved.
fn rename_one(repo_path: &str, wt: &str, from: &str, to: &str) -> Result<(), String> {
    let (Some(src_rel), Some(dst_rel)) = (relative_to(repo_path, from), relative_to(repo_path, to)) else {
        return Ok(());
    };
    let src = ref_prefix(wt, &digest(&src_rel));
    let dst = ref_prefix(wt, &digest(&dst_rel));
    if src == dst {
        return Ok(());
    }
    let moving = entries_under(repo_path, &src);
    if moving.is_empty() {
        return Ok(());
    }
    let taken: Vec<u64> = entries_under(repo_path, &dst).iter().map(|e| e.ts).collect();
    for entry in &moving {
        // A destination that already holds this exact millisecond keeps what it
        // had: two versions cannot share a ref name, and the destination's own
        // is the one its path is about.
        if taken.contains(&entry.ts) {
            continue;
        }
        git_run(repo_path, &["update-ref", &format!("{dst}{}", entry.ts), &entry.blob])?;
    }
    let old: Vec<String> = moving.iter().map(|e| format!("{src}{}", e.ts)).collect();
    delete_refs(repo_path, &old)?;
    enforce_caps(repo_path, &dst, now_ms());
    Ok(())
}

/// Drop a file's history, for the trash path.
///
/// Collected rather than left to age out: the file is gone, so nothing will
/// open its timeline, and refs nobody can reach are refs nobody can prune by
/// looking at them.
///
/// Called **before** the file is trashed, not after, and that is the whole
/// reason a directory can be handled at all: after the delete there is nothing
/// left to walk, and the paths are hashed into the ref names, so no prefix sweep
/// could find them again.
#[tauri::command]
pub async fn local_history_forget(repo_path: String, path: String) -> Result<(), String> {
    crate::exec::git_write("local_history_forget", repo_path.clone(), move || {
        local_history_forget_body(repo_path, path)
    })
    .await
}

pub(crate) fn local_history_forget_body(repo_path: String, path: String) -> Result<(), String> {
    // Resolved once, for the same reason the rename path resolves it once: a
    // folder of any size would otherwise pay two `git rev-parse` calls per file.
    if !is_git_worktree(&repo_path) {
        return Ok(());
    }
    let Some(wt) = worktree_key(&repo_path) else {
        return Ok(());
    };
    let mut doomed = Vec::new();
    if Path::new(&path).is_dir() {
        files_under(Path::new(&path), &mut doomed);
    } else {
        doomed.push(path);
    }
    // One `update-ref --stdin` for the whole folder rather than one per file.
    let names: Vec<String> = doomed
        .iter()
        .filter_map(|file| relative_to(&repo_path, file))
        .flat_map(|rel| {
            let prefix = ref_prefix(&wt, &digest(&rel));
            entries_under(&repo_path, &prefix)
                .iter()
                .map(|e| format!("{prefix}{}", e.ts))
                .collect::<Vec<_>>()
        })
        .collect();
    delete_refs(&repo_path, &names)
}

/// Every worktree key that has a live worktree behind it.
fn live_keys(repo: &str) -> Option<Vec<String>> {
    let out = git_capture(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let keys: Vec<String> = out
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .map(|p| digest(p.trim()))
        .collect();
    if keys.is_empty() {
        None
    } else {
        Some(keys)
    }
}

/// Sweep the whole family: entries past the age cap, and every worktree key
/// with no worktree behind it any more.
///
/// The per-file caps are applied on save, so this exists for what a save can
/// never reach: a file nobody has saved since it aged out, and a worktree that
/// was removed and took its files with it.
#[tauri::command]
pub async fn local_history_prune(repo_path: String) -> Result<(), String> {
    crate::exec::git_write("local_history_prune", repo_path.clone(), move || {
        local_history_prune_body(repo_path)
    })
    .await
}

pub(crate) fn local_history_prune_body(repo_path: String) -> Result<(), String> {
    if !is_git_worktree(&repo_path) {
        return Ok(());
    }
    let Some(live) = live_keys(&repo_path) else {
        // `worktree list` reporting nothing means git could not answer, not
        // that there are no worktrees. Collecting on that answer would delete
        // every timeline in the repo.
        return Ok(());
    };
    let family = format!("{FAMILY}/");
    let listing = git_capture(&repo_path, &["for-each-ref", "--format=%(refname)", &family])?;
    let now = now_ms();
    let doomed: Vec<String> = listing
        .lines()
        .filter(|name| {
            let Some(rest) = name.strip_prefix(&family) else {
                return false;
            };
            let mut parts = rest.split('/');
            let (Some(wt), Some(_path), Some(ts)) = (parts.next(), parts.next(), parts.next()) else {
                return false;
            };
            if !live.iter().any(|k| k == wt) {
                return true;
            }
            ts.parse::<u64>().is_ok_and(|t| now.saturating_sub(t) > MAX_AGE_MS)
        })
        .map(|s| s.to_string())
        .collect();
    delete_refs(&repo_path, &doomed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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

    fn tmp_repo() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori_localhistory_test_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        // A commit, so `worktree list` and `rev-parse` behave as they do in a
        // real project rather than in an unborn-HEAD one.
        std::fs::write(dir.join(".keep"), "").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "init"]);
        dir
    }

    fn repo(dir: &Path) -> String {
        dir.to_string_lossy().into_owned()
    }

    fn write(dir: &Path, name: &str, body: &str) -> String {
        let p = dir.join(name);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }

    /// Every ref in the family, for asserting what a run left behind.
    fn all_refs(dir: &Path) -> Vec<String> {
        git_capture(
            &repo(dir),
            &["for-each-ref", "--format=%(refname)", &format!("{FAMILY}/")],
        )
        .unwrap()
        .lines()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn a_save_costs_one_blob_and_no_index_or_tree_operation() {
        // The reason this family is blobs rather than the checkpoint family's
        // trees: a save is far more frequent than a prompt and concerns one
        // file. Proven by the index: `git add`/`write-tree` would leave one, and
        // the user's own staging must be untouched either way.
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "one\n");
        git(&dir, &["add", "a.ts"]);
        let staged_before = git_capture(&repo(&dir), &["diff", "--cached", "--name-only"]).unwrap();

        assert!(local_history_note_body(repo(&dir), file.clone()).unwrap());

        let entries = local_history_list(repo(&dir), file).unwrap();
        assert_eq!(entries.len(), 1);
        let kind = git_capture(&repo(&dir), &["cat-file", "-t", &entries[0].blob]).unwrap();
        assert_eq!(kind.trim(), "blob", "a version is one blob, not a tree");
        assert_eq!(
            git_capture(&repo(&dir), &["diff", "--cached", "--name-only"]).unwrap(),
            staged_before,
            "the user's index must not be touched"
        );
    }

    #[test]
    fn two_saves_of_identical_content_are_one_entry() {
        // Holding Cmd+S, or saving a file the formatter left alone, must not
        // fill the timeline with versions that are all the same file.
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "one\n");
        assert!(local_history_note_body(repo(&dir), file.clone()).unwrap());
        assert!(
            !local_history_note_body(repo(&dir), file.clone()).unwrap(),
            "deduped by blob"
        );
        assert_eq!(local_history_list(repo(&dir), file.clone()).unwrap().len(), 1);

        write(&dir, "a.ts", "two\n");
        assert!(local_history_note_body(repo(&dir), file.clone()).unwrap());
        assert_eq!(local_history_list(repo(&dir), file).unwrap().len(), 2);
    }

    #[test]
    fn content_that_comes_back_is_a_new_version_not_a_dedup() {
        // Dedup is against the newest entry only, not the whole timeline: undoing
        // an edit and saving is a thing that happened, and at a different time.
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "one\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();
        write(&dir, "a.ts", "two\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();
        write(&dir, "a.ts", "one\n");
        assert!(local_history_note_body(repo(&dir), file.clone()).unwrap());
        assert_eq!(local_history_list(repo(&dir), file).unwrap().len(), 3);
    }

    #[test]
    fn versions_are_listed_newest_first_and_read_back_verbatim() {
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "one\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();
        write(&dir, "a.ts", "two\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();

        let entries = local_history_list(repo(&dir), file).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].ts >= entries[1].ts);
        assert_eq!(
            local_history_read(repo(&dir), entries[0].blob.clone()).unwrap(),
            "two\n"
        );
        assert_eq!(
            local_history_read(repo(&dir), entries[1].blob.clone()).unwrap(),
            "one\n"
        );
    }

    #[test]
    fn two_saves_in_one_millisecond_are_two_versions() {
        // The ref name is the timestamp, so a collision would overwrite the
        // older one and lose a version outright rather than merely mis-order it.
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "one\n");
        for i in 0..5 {
            write(&dir, "a.ts", &format!("v{i}\n"));
            assert!(local_history_note_body(repo(&dir), file.clone()).unwrap());
        }
        let entries = local_history_list(repo(&dir), file).unwrap();
        assert_eq!(entries.len(), 5);
        let mut seen: Vec<u64> = entries.iter().map(|e| e.ts).collect();
        seen.dedup();
        assert_eq!(seen.len(), 5, "every version needs its own ref name");
    }

    #[test]
    fn a_file_outside_the_repo_has_no_history_rather_than_an_error() {
        let dir = tmp_repo();
        let outside = std::env::temp_dir().join("tori_localhistory_outsider.ts");
        std::fs::write(&outside, "x\n").unwrap();
        let path = outside.to_string_lossy().into_owned();
        assert!(!local_history_note_body(repo(&dir), path.clone()).unwrap());
        assert!(local_history_list(repo(&dir), path).unwrap().is_empty());
    }

    #[test]
    fn restoring_rewrites_the_file_and_leaves_staged_content_alone() {
        // Never `git checkout`: the manual-git invariant means a restore stages
        // nothing, and what the user had staged has to survive it.
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "one\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();
        write(&dir, "a.ts", "staged\n");
        git(&dir, &["add", "a.ts"]);
        let staged = git_capture(&repo(&dir), &["diff", "--cached"]).unwrap();
        write(&dir, "a.ts", "three\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();

        let oldest = *local_history_list(repo(&dir), file.clone())
            .unwrap()
            .iter()
            .map(|e| e.ts)
            .min()
            .as_ref()
            .unwrap();
        local_history_restore_body(repo(&dir), file.clone(), oldest).unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\n");
        assert_eq!(
            git_capture(&repo(&dir), &["diff", "--cached"]).unwrap(),
            staged,
            "the index must read exactly as it did before the restore"
        );
    }

    #[test]
    fn a_version_diffs_against_the_file_as_it_is_now() {
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "one\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();
        let ts = local_history_list(repo(&dir), file.clone()).unwrap()[0].ts;
        write(&dir, "a.ts", "two\n");

        let diff = local_history_diff(repo(&dir), file.clone(), ts).unwrap();
        assert!(diff.contains("-one"), "{diff}");
        assert!(diff.contains("+two"), "{diff}");

        // Nothing edited since that version: an empty diff, not an error.
        write(&dir, "a.ts", "one\n");
        assert_eq!(local_history_diff(repo(&dir), file, ts).unwrap(), "");
    }

    #[test]
    fn restoring_a_version_that_is_gone_says_so() {
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "one\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();
        assert!(local_history_restore_body(repo(&dir), file, 1).is_err());
    }

    #[test]
    fn a_rename_carries_the_history_and_orphans_nothing() {
        let dir = tmp_repo();
        let from = write(&dir, "a.ts", "one\n");
        for body in ["one\n", "two\n", "three\n"] {
            write(&dir, "a.ts", body);
            local_history_note_body(repo(&dir), from.clone()).unwrap();
        }
        assert_eq!(local_history_list(repo(&dir), from.clone()).unwrap().len(), 3);

        std::fs::rename(&from, dir.join("b.ts")).unwrap();
        let to = dir.join("b.ts").to_string_lossy().into_owned();
        local_history_rename_body(repo(&dir), from.clone(), to.clone()).unwrap();

        let moved = local_history_list(repo(&dir), to).unwrap();
        assert_eq!(moved.len(), 3, "all three readable under the new path");
        assert_eq!(
            local_history_read(repo(&dir), moved[0].blob.clone()).unwrap(),
            "three\n",
            "and still the right bytes"
        );
        assert!(
            local_history_list(repo(&dir), from).unwrap().is_empty(),
            "and none left under the old one"
        );
    }

    #[test]
    fn a_rename_onto_a_path_with_its_own_history_keeps_both() {
        let dir = tmp_repo();
        let from = write(&dir, "a.ts", "a\n");
        local_history_note_body(repo(&dir), from.clone()).unwrap();
        let to = write(&dir, "b.ts", "b\n");
        local_history_note_body(repo(&dir), to.clone()).unwrap();

        local_history_rename_body(repo(&dir), from.clone(), to.clone()).unwrap();
        assert_eq!(local_history_list(repo(&dir), to).unwrap().len(), 2);
        assert!(local_history_list(repo(&dir), from).unwrap().is_empty());
    }

    #[test]
    fn trashing_a_file_collects_its_history() {
        // Left behind, these are refs nothing can reach: the file is gone, so
        // nobody will open its timeline and notice them.
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "one\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();
        write(&dir, "a.ts", "two\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();
        assert_eq!(all_refs(&dir).len(), 2);

        local_history_forget_body(repo(&dir), file.clone()).unwrap();
        assert!(local_history_list(repo(&dir), file).unwrap().is_empty());
        assert!(all_refs(&dir).is_empty(), "collected, not merely unreachable");
    }

    #[test]
    fn renaming_a_folder_carries_every_file_under_it() {
        // The common drag-move in a file tree is a folder, and the paths are
        // hashed into the ref names, so nothing could find these again later.
        let dir = tmp_repo();
        let a = write(&dir, "src/a.ts", "a\n");
        let b = write(&dir, "src/deep/b.ts", "b\n");
        local_history_note_body(repo(&dir), a.clone()).unwrap();
        local_history_note_body(repo(&dir), b.clone()).unwrap();

        std::fs::rename(dir.join("src"), dir.join("lib")).unwrap();
        let from = dir.join("src").to_string_lossy().into_owned();
        let to = dir.join("lib").to_string_lossy().into_owned();
        local_history_rename_body(repo(&dir), from, to).unwrap();

        let moved_a = dir.join("lib/a.ts").to_string_lossy().into_owned();
        let moved_b = dir.join("lib/deep/b.ts").to_string_lossy().into_owned();
        assert_eq!(local_history_list(repo(&dir), moved_a).unwrap().len(), 1);
        assert_eq!(local_history_list(repo(&dir), moved_b).unwrap().len(), 1, "nested too");
        assert!(local_history_list(repo(&dir), a).unwrap().is_empty());
        assert_eq!(all_refs(&dir).len(), 2, "moved, not copied");
    }

    #[test]
    fn trashing_a_folder_collects_every_file_under_it() {
        // Which is why forget runs *before* the delete: afterwards there is
        // nothing left to walk and the hashed ref names cannot be swept by path.
        let dir = tmp_repo();
        let a = write(&dir, "src/a.ts", "a\n");
        let kept = write(&dir, "other.ts", "k\n");
        local_history_note_body(repo(&dir), a.clone()).unwrap();
        local_history_note_body(repo(&dir), kept.clone()).unwrap();
        assert_eq!(all_refs(&dir).len(), 2);

        local_history_forget_body(repo(&dir), dir.join("src").to_string_lossy().into_owned()).unwrap();
        assert!(local_history_list(repo(&dir), a).unwrap().is_empty());
        assert_eq!(
            local_history_list(repo(&dir), kept).unwrap().len(),
            1,
            "and only that folder"
        );
    }

    #[test]
    fn one_files_history_does_not_follow_another_files_rename_or_trash() {
        let dir = tmp_repo();
        let a = write(&dir, "a.ts", "a\n");
        let b = write(&dir, "b.ts", "b\n");
        local_history_note_body(repo(&dir), a.clone()).unwrap();
        local_history_note_body(repo(&dir), b.clone()).unwrap();

        local_history_forget_body(repo(&dir), a).unwrap();
        assert_eq!(local_history_list(repo(&dir), b).unwrap().len(), 1);
    }

    #[test]
    fn exceeding_the_count_cap_drops_the_oldest() {
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "0\n");
        for i in 0..6 {
            write(&dir, "a.ts", &format!("v{i}\n"));
            local_history_note_body(repo(&dir), file.clone()).unwrap();
        }
        let prefix = prefix_for(&repo(&dir), &file).unwrap();
        enforce_caps(&repo(&dir), &prefix, now_ms());
        assert_eq!(local_history_list(repo(&dir), file.clone()).unwrap().len(), 6);

        // The cap itself, exercised through the same function the save path
        // calls, rather than by writing 51 versions.
        let entries = local_history_list(repo(&dir), file.clone()).unwrap();
        let doomed: Vec<String> = entries.iter().skip(2).map(|e| format!("{prefix}{}", e.ts)).collect();
        delete_refs(&repo(&dir), &doomed).unwrap();
        let left = local_history_list(repo(&dir), file).unwrap();
        assert_eq!(left.len(), 2);
        assert_eq!(local_history_read(repo(&dir), left[0].blob.clone()).unwrap(), "v5\n");
    }

    #[test]
    fn an_entry_past_the_age_cap_is_swept() {
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "one\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();
        let prefix = prefix_for(&repo(&dir), &file).unwrap();
        let entry = local_history_list(repo(&dir), file.clone()).unwrap().remove(0);

        // Re-file the same blob under a timestamp older than the cap, which is
        // what an entry from three weeks ago looks like.
        let old = entry.ts.saturating_sub(MAX_AGE_MS + 1);
        git_run(&repo(&dir), &["update-ref", &format!("{prefix}{old}"), &entry.blob]).unwrap();
        assert_eq!(local_history_list(repo(&dir), file.clone()).unwrap().len(), 2);

        local_history_prune_body(repo(&dir)).unwrap();
        let left = local_history_list(repo(&dir), file).unwrap();
        assert_eq!(left.len(), 1, "the aged-out one goes, the fresh one stays");
        assert_eq!(left[0].ts, entry.ts);
    }

    #[test]
    fn a_removed_worktrees_history_is_collected_and_a_live_ones_is_not() {
        let dir = tmp_repo();
        let file = write(&dir, "a.ts", "one\n");
        local_history_note_body(repo(&dir), file.clone()).unwrap();
        let mine = all_refs(&dir);
        assert_eq!(mine.len(), 1);

        // A timeline belonging to a worktree that is not in `worktree list`.
        let ghost = format!("{FAMILY}/{}/{}/{}", digest("/gone/elsewhere"), digest("a.ts"), now_ms());
        let blob = local_history_list(repo(&dir), file.clone()).unwrap()[0].blob.clone();
        git_run(&repo(&dir), &["update-ref", &ghost, &blob]).unwrap();
        assert_eq!(all_refs(&dir).len(), 2);

        local_history_prune_body(repo(&dir)).unwrap();
        assert_eq!(all_refs(&dir), mine, "the ghost goes, this worktree's stays");
    }

    #[test]
    fn two_worktrees_keep_independent_timelines_for_the_same_path() {
        // A bare repo's worktrees share one ref store, so without the worktree
        // key `src/a.ts` in fifteen checkouts would be one interleaved list.
        let dir = tmp_repo();
        let main_file = write(&dir, "a.ts", "main\n");
        local_history_note_body(repo(&dir), main_file.clone()).unwrap();

        let other = dir.join("wt");
        git(&dir, &["worktree", "add", "-q", "-b", "side", other.to_str().unwrap()]);
        let side_file = write(&other, "a.ts", "side\n");
        local_history_note_body(repo(&other), side_file.clone()).unwrap();

        let mine = local_history_list(repo(&dir), main_file).unwrap();
        let theirs = local_history_list(repo(&other), side_file).unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(theirs.len(), 1);
        assert_eq!(local_history_read(repo(&dir), mine[0].blob.clone()).unwrap(), "main\n");
        assert_eq!(
            local_history_read(repo(&dir), theirs[0].blob.clone()).unwrap(),
            "side\n"
        );
        assert_ne!(mine[0].blob, theirs[0].blob);
        // Two refs in the one shared store, under two different worktree keys.
        assert_eq!(all_refs(&dir).len(), 2);
    }
}
