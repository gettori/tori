// Git queries for the editor: the changed-file list (for a review surface) and
// per-file diff hunks in new-file coordinates (for the CM6 gutter). Both shell
// out to git, like `list_branches` in config.rs. Diffs are taken against HEAD so
// the gutter reflects all uncommitted work (staged + unstaged), matching the
// "uncommitted changes" review surface, not just unstaged edits.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::askpass::{AskpassState, ENV_OP, ENV_SOCK, ENV_TOKEN};
use crate::env::augmented_path;

#[derive(Serialize)]
pub struct GitFileStatus {
    /// Porcelain XY status code, e.g. " M", "??", "A ", "MM". Normalised from
    /// v2's `.`-for-unmodified back to v1's space, so this stays the shape
    /// every consumer already reads.
    status: String,
    /// The file's *current* path, always usable as a pathspec. v1 packed a
    /// rename into the single string `old -> new` and quoted anything
    /// non-ASCII, so neither form matched a real file; `-z` gives the path raw
    /// and puts the rename's other half in `orig_path`.
    path: String,
    /// A rename's source path. `None` for every other record.
    orig_path: Option<String>,
    /// X (index) column is neither ' ' nor '?': this file has staged changes.
    /// Always false for a conflicted file, see `conflicted`.
    staged: bool,
    /// Y (worktree) column is not ' ', or the file is untracked ("??"):
    /// this file has unstaged changes. A file can be both (e.g. "MM").
    /// Always false for a conflicted file, see `conflicted`.
    unstaged: bool,
    /// The file has unmerged index stages: a merge, rebase or stash apply left
    /// it mid-conflict. Read from the **record type** (`u`), not by scanning
    /// the XY code for a `U`. Two of the seven unmerged codes (`AA` both added,
    /// `DD` both deleted) contain no `U` at all, and `DD` is indistinguishable
    /// from an ordinary staged-and-worktree delete once the type is gone.
    conflicted: bool,
}

#[tauri::command]
pub async fn git_status(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    crate::exec::blocking("git_status", move || git_status_body(&project_path)).await
}

pub(crate) fn git_status_body(project_path: &str) -> Result<Vec<GitFileStatus>, String> {
    // `--no-optional-locks`: status opportunistically takes index.lock to save
    // its refresh, and a concurrent stage or commit *fails* on that lock rather
    // than waiting. Reads run outside the repo write lock, so they must not
    // take locks a writer can trip over; re-refreshing later costs less.
    let output = Command::new("git")
        .arg("-C")
        .arg(project_path)
        .args(["--no-optional-locks", "status", "--porcelain=v2", "-z"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // Not a git repo (or no commits): no changes, not an error.
        return Ok(vec![]);
    }

    // `from_utf8_lossy` is load-bearing in a way it was not under v1. v1 quoted
    // anything non-ASCII, so its output was valid UTF-8 by construction and
    // nothing was ever lost here; `-z` emits paths as raw bytes, so a filename
    // that is not valid UTF-8 now becomes U+FFFD and stops matching a real
    // file. That is no worse than v1 (whose quoted form did not match either),
    // and carrying bytes end-to-end would mean changing this command's type,
    // so it stays lossy - deliberately, and only for a path that was already
    // unaddressable.
    Ok(parse_status(&String::from_utf8_lossy(&output.stdout)))
}

/// One entry from an XY code and a path. `xy` arrives in v2 spelling (`.` for
/// unmodified); it is normalised here so `status`, `staged` and `unstaged` all
/// keep the meaning they had under v1.
///
/// `conflicted` comes from the record type, and when it is set the other two
/// flags are cleared: an unmerged path has three index stages rather than one
/// staged version, and both `git commit` and `git restore --staged` refuse it.
/// Reading `UU`'s two non-space columns as "staged and unstaged" would list the
/// file in both sections and offer it actions git will not perform.
fn status_entry(xy: &str, path: &str, orig_path: Option<String>, conflicted: bool) -> GitFileStatus {
    let mut chars = xy.chars();
    let norm = |c: Option<char>| match c {
        Some('.') | None => ' ',
        Some(c) => c,
    };
    let x = norm(chars.next());
    let y = norm(chars.next());
    GitFileStatus {
        status: format!("{x}{y}"),
        path: path.to_string(),
        orig_path,
        staged: !conflicted && x != ' ' && x != '?',
        unstaged: !conflicted && y != ' ',
        conflicted,
    }
}

/// Parse `git status --porcelain=v2 -z`.
///
/// v2 is a *typed-record* format rather than v1's fixed two-column line: the
/// leading character says which record follows, and only then is the layout
/// known. Two consequences drive this reader.
///
/// With `-z` every record is NUL-terminated and paths arrive **raw** - no
/// quoting, no escaping - which is the whole point: v1 quoted a non-ASCII name
/// and packed a rename as `old -> new`, and both produced a `path` that matched
/// no file, so the diff for one came back empty.
///
/// And a rename (record `2`) spends *two* NUL fields, the new path then the
/// original, so the reader pulls the next field instead of splitting a line.
fn parse_status(text: &str) -> Vec<GitFileStatus> {
    let mut files = Vec::new();
    let mut records = text.split('\0').filter(|r| !r.is_empty());
    while let Some(rec) = records.next() {
        let Some((kind, rest)) = rec.split_once(' ') else {
            continue; // a `# branch.*` header, or trailing noise
        };
        match kind {
            // Untracked has no XY of its own, so it keeps v1's "??" - the code
            // the panel already styles as untracked.
            "?" => files.push(status_entry("??", rest, None, false)),
            // Ignored only appears under `--ignored`, which this does not pass.
            // Skipped rather than listed: an ignored file is not a change.
            "!" => {}
            "1" | "2" | "u" => {
                // How many space-separated fields precede the path. A path may
                // itself contain spaces, so the split is counted, never greedy.
                let leading = match kind {
                    "1" => 7,  // XY sub mH mI mW hH hI
                    "2" => 8,  // XY sub mH mI mW hH hI Xscore
                    _ => 9,    // XY sub m1 m2 m3 mW h1 h2 h3
                };
                let mut parts = rest.splitn(leading + 1, ' ');
                let xy = parts.next().unwrap_or_default();
                let Some(path) = parts.nth(leading - 1) else { continue };
                let orig = if kind == "2" { records.next().map(str::to_string) } else { None };
                files.push(status_entry(xy, path, orig, kind == "u"));
            }
            _ => {}
        }
    }
    files
}

/// Stage `paths` (`git add --`). A no-op on an empty list.
#[tauri::command]
pub async fn git_stage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    crate::exec::git_write("git_stage", project_path.clone(), move || git_stage_body(project_path, paths)).await
}

pub(crate) fn git_stage_body(project_path: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_run(&project_path, &args)
}

/// Unstage `paths` back to the working tree (`git restore --staged --`),
/// leaving worktree edits untouched. A no-op on an empty list.
#[tauri::command]
pub async fn git_unstage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    crate::exec::git_write("git_unstage", project_path.clone(), move || git_unstage_body(project_path, paths)).await
}

pub(crate) fn git_unstage_body(project_path: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_run(&project_path, &args)
}

/// The 1-based line range `start..=end` of a file, as the given diff mode's
/// "new" side sees it. Backs the review panel's "n unchanged lines" expander:
/// the diff itself carries only a few lines of context, so revealing the gap
/// between two hunks means reading the file.
///
/// The mode matters. A partially-staged file's Staged section compares
/// index-vs-HEAD, so its unchanged lines are the *index's*, not the working
/// tree's; reading the worktree there would show lines the user has not staged.
#[tauri::command(async)]
pub fn git_file_slice(
    project_path: String,
    file: String,
    mode: Option<DiffMode>,
    start: usize,
    end: usize,
) -> Result<Vec<String>, String> {
    if start == 0 || end < start {
        return Ok(vec![]);
    }

    let content = if mode.unwrap_or_default() == DiffMode::Staged {
        let output = Command::new("git")
            .arg("-C")
            .arg(&project_path)
            .args(["show", &format!(":{}", file)])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Ok(vec![]);
        }
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        let full = Path::new(&project_path).join(&file);
        std::fs::read_to_string(full).map_err(|e| e.to_string())?
    };

    // Clamp rather than error: the file can legitimately be shorter than the
    // range the panel computed if it changed since the diff was taken.
    Ok(content
        .lines()
        .skip(start - 1)
        .take(end - start + 1)
        .map(str::to_string)
        .collect())
}

/// Whether this repo already has the commit `sha` in its object store.
fn has_commit(project_path: &str, sha: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(project_path)
        .args(["cat-file", "-e", &format!("{sha}^{{commit}}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Make a pull request's head commit readable locally.
///
/// The PR's own file contents come from **layer 1**, the git protocol, not from
/// the API: the head ref is one the forge publishes (`refs/pull/{n}/head` on
/// GitHub, `refs/merge-requests/{n}/head` on GitLab, which is why the caller
/// passes it in) and `git fetch` reaches it with the credentials the askpass
/// bridge already handles. That is
/// what makes expanding a collapsed region in a PR diff cost zero API quota,
/// and it is the difference between a gap expander that works and one that has
/// to be governed by the same rate budget as everything else.
///
/// Fetched with **no destination ref**. A Tori-owned `refs/tori/pr/{n}` would
/// keep the commit reachable, but nothing would ever remove it, so a reviewer
/// would accumulate one pinned tree per pull request read, permanently, in
/// their own repo. Git already shields freshly fetched objects from prune for
/// `gc.pruneExpire`, which is the whole of what is needed to read them.
///
/// Split like [`push_branch`] so the network path carries the bridge and the
/// test can drive the same body: everything that talks to a remote goes through
/// [`git_command`], never a bare `Command`, because a `git` with no askpass and
/// no TTY does not fail politely.
///
/// The `has_commit` check first is not an optimisation. The common case is a PR
/// on a branch checked out right here, and going to the network to re-learn a
/// commit already in the object store is a round trip spent on nothing.
/// The fetch itself, built but not run, so a test can read back what it would
/// have done: which refspec, and whether the bridge is wired.
fn pr_head_fetch_command(
    repo: &str,
    head_ref: &str,
    sock: &Path,
    token: &str,
) -> (Command, Option<crate::credential::Registered>) {
    let op_id = next_op_id();
    let mut cmd = git_command(repo, &op_id, sock, token);
    let bridge = crate::credential::bridge(&mut cmd, repo, "origin", &op_id);
    cmd.args(["fetch", "--no-tags", "origin", head_ref]);
    (cmd, bridge)
}

pub fn fetch_pr_head(
    repo: &str,
    head_ref: &str,
    sha: &str,
    sock: &Path,
    token: &str,
) -> Result<(), String> {
    if !sha.is_empty() && has_commit(repo, sha) {
        return Ok(());
    }
    let (mut cmd, _bridge) = pr_head_fetch_command(repo, head_ref, sock, token);
    let out = crate::git_health::run(&mut cmd)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn git_fetch_pr_head(
    state: State<AskpassState>,
    project_path: String,
    number: u64,
    sha: String,
) -> Result<(), String> {
    let inner = state.0.clone();
    // Resolved before the repo lock: working out the head ref reads the repo's
    // own origin, which takes that same lock.
    let head_ref = crate::forge::commands::pr_head_ref(&project_path, number);
    let lock = crate::exec::repo_lock(&project_path);
    let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    fetch_pr_head(&project_path, &head_ref, &sha, inner.sock_path(), inner.token())
}

/// The 1-based line range `start..=end` of a file **as of one commit**.
///
/// The companion to [`git_file_slice`] for a diff that is not about the working
/// tree. A pull request's head is usually not checked out, so reading the file
/// from disk there would show whatever happens to be in the editor's copy: the
/// right line numbers over the wrong content, which is worse than showing
/// nothing because it looks exactly like an answer.
#[tauri::command(async)]
pub fn git_blob_slice(
    project_path: String,
    rev: String,
    file: String,
    start: usize,
    end: usize,
) -> Result<Vec<String>, String> {
    if start == 0 || end < start {
        return Ok(vec![]);
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["show", &format!("{rev}:{file}")])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        // Git's own sentence: "path does not exist in ..." says which half is
        // missing, where a silent empty list is a click that does nothing.
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let content = String::from_utf8_lossy(&output.stdout);
    // Clamp rather than error, as `git_file_slice` does: the range was computed
    // from a patch, and a patch does not say how long the file is.
    Ok(content
        .lines()
        .skip(start - 1)
        .take(end - start + 1)
        .map(str::to_string)
        .collect())
}

/// Stage or unstage a subset of a file's hunks, never touching the working
/// tree (`git apply --cached`).
///
/// The two directions read different diffs and must never mix: staging takes
/// hunks from worktree-vs-index and applies forward, unstaging takes them from
/// index-vs-HEAD and applies in reverse. `reverse` picks both at once so a
/// caller cannot pair the wrong source with the wrong direction.
///
/// `fingerprints` is the content hash the UI rendered for each selected hunk.
/// The diff is re-read here and every fingerprint re-checked before anything is
/// applied, because indices alone are not stable: an agent writing to the file
/// between render and click renumbers the hunks, and a positional apply would
/// then stage the wrong one. A mismatch applies nothing and says so.
///
/// `context` must be the `-U<n>` the UI rendered with: hunk boundaries (and so
/// fingerprints) depend on it, since a wider context merges nearby changes into
/// one hunk.
#[tauri::command]
pub async fn git_apply_hunks(project_path: String, file: String, hunk_indices: Vec<usize>, fingerprints: Vec<String>, reverse: bool, context: Option<u32>) -> Result<(), String> {
    crate::exec::git_write("git_apply_hunks", project_path.clone(), move || git_apply_hunks_body(project_path, file, hunk_indices, fingerprints, reverse, context)).await
}

pub(crate) fn git_apply_hunks_body(
    project_path: String,
    file: String,
    hunk_indices: Vec<usize>,
    fingerprints: Vec<String>,
    reverse: bool,
    context: Option<u32>,
) -> Result<(), String> {
    if hunk_indices.len() != fingerprints.len() {
        return Err("Hunk selection is malformed".into());
    }
    if hunk_indices.is_empty() {
        return Ok(());
    }

    // An untracked file has no index entry, so worktree-vs-index shows nothing
    // to build a patch from. Intent-to-add creates the empty entry; the hunk
    // header and body come out identical to the --no-index diff the panel
    // displayed, so the fingerprints still match.
    if reverse {
        // Unstaging only ever touches files already in the index.
    } else if is_untracked(&project_path, &file)? {
        git_run(&project_path, &["add", "-N", "--", &file])?;
    }

    let mode = if reverse { DiffMode::Staged } else { DiffMode::Unstaged };
    let patch = selected_patch(
        &project_path,
        &file,
        &hunk_indices,
        &fingerprints,
        mode,
        reverse,
        context,
        "The diff changed, refreshed. Nothing was staged.",
    )?;
    git_apply(&project_path, &patch, true, reverse)
}

/// Stage or unstage a subset of the *lines* of one hunk.
///
/// The same contract as `git_apply_hunks` one level finer: same two directions,
/// same source diffs, same fingerprint proof that the hunk on screen is the hunk
/// on disk. Only the patch is narrower, and `patch::build_line_patch` owns what
/// "narrower" means for each direction.
///
/// A whole-hunk apply is not this with every line listed. It stays its own
/// command because it is the common case and because its patch is the hunk
/// verbatim, with nothing rebuilt that could be rebuilt wrongly.
#[tauri::command]
pub async fn git_apply_lines(project_path: String, file: String, hunk_index: usize, fingerprint: String, lines: Vec<usize>, reverse: bool, context: Option<u32>) -> Result<(), String> {
    crate::exec::git_write("git_apply_lines", project_path.clone(), move || git_apply_lines_body(project_path, file, hunk_index, fingerprint, lines, reverse, context)).await
}

pub(crate) fn git_apply_lines_body(
    project_path: String,
    file: String,
    hunk_index: usize,
    fingerprint: String,
    lines: Vec<usize>,
    reverse: bool,
    context: Option<u32>,
) -> Result<(), String> {
    if lines.is_empty() {
        return Err("No lines selected".into());
    }
    if reverse {
        // Unstaging only ever touches files already in the index.
    } else if is_untracked(&project_path, &file)? {
        git_run(&project_path, &["add", "-N", "--", &file])?;
    }

    let mode = if reverse { DiffMode::Staged } else { DiffMode::Unstaged };
    let parsed = checked_patch(
        &project_path,
        &file,
        &[hunk_index],
        std::slice::from_ref(&fingerprint),
        mode,
        context,
        "The diff changed, refreshed. Nothing was staged.",
    )?;
    let patch = crate::patch::build_line_patch(&parsed, hunk_index, &lines, reverse)?;
    git_apply(&project_path, &patch, true, reverse)
}

/// Re-read `file`'s diff in `mode` and prove every selected hunk is still the
/// one whose fingerprint the UI rendered.
///
/// A hunk index is only meaningful against the exact diff it came from, so every
/// caller re-derives the fingerprints rather than trusting the number. `stale` is
/// what to say when they no longer match, which differs by caller because it has
/// to name what did *not* happen.
fn checked_patch(
    project_path: &str,
    file: &str,
    hunk_indices: &[usize],
    fingerprints: &[String],
    mode: DiffMode,
    context: Option<u32>,
    stale: &str,
) -> Result<crate::patch::FilePatch, String> {
    let text = git_diff_text(project_path.to_string(), file.to_string(), context, Some(mode), None)?;
    let parsed = crate::patch::parse_patch(&text);
    for (&i, expected) in hunk_indices.iter().zip(fingerprints) {
        let actual = parsed.hunks.get(i).ok_or_else(|| stale.to_string())?;
        if &actual.fingerprint != expected {
            return Err(stale.to_string());
        }
    }
    Ok(parsed)
}

/// `checked_patch` plus the whole-hunk patch built from it. Shared by staging
/// and discarding, which differ only in direction and in what they call stale.
#[allow(clippy::too_many_arguments)]
fn selected_patch(
    project_path: &str,
    file: &str,
    hunk_indices: &[usize],
    fingerprints: &[String],
    mode: DiffMode,
    reverse: bool,
    context: Option<u32>,
    stale: &str,
) -> Result<String, String> {
    let parsed = checked_patch(project_path, file, hunk_indices, fingerprints, mode, context, stale)?;
    crate::patch::build_patch(&parsed, hunk_indices, reverse)
}

/// What a discard did: the backstop it took first (the recovery route, which the
/// UI names), and the paths it rewrote and removed, so open buffers reconcile
/// through the same channel a checkpoint revert uses.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DiscardOutcome {
    pub backstop_ts: u64,
    /// Flattened, so the wire shape stays `{backstop_ts, restored, deleted}`
    /// while "which paths changed on disk" has one definition shared with
    /// `backstop::backstop_restore_*`. Both feed the same `onReverted` channel,
    /// so a field added to one must reach the other.
    #[serde(flatten)]
    pub changed: crate::backstop::RestoreOutcome,
}

const STALE_DISCARD: &str = "The diff changed, refreshed. Nothing was discarded.";

/// Resolve a repo-relative path for deletion, refusing anything that leaves the
/// worktree.
///
/// Everywhere else here a path is handed to git after `--`, and git confines it
/// to the repository itself. Discard is the only path that deletes through the
/// filesystem directly, where `..` or an absolute path would simply escape, so
/// the confinement git was providing has to be re-established explicitly.
pub(crate) fn inside_repo(project_path: &str, file: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(project_path).map_err(|e| e.to_string())?;
    let target = root.join(file);
    // The file must still exist to be canonicalised, so the parent is what gets
    // resolved: that is enough, since the last component cannot be `..` without
    // the parent check already having caught the escape.
    let parent = target.parent().ok_or("That path has no parent directory.")?;
    let parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !parent.starts_with(&root) {
        return Err("That path is outside this folder.".into());
    }
    Ok(parent.join(target.file_name().ok_or("That path names no file.")?))
}

/// Do these fingerprints belong to the file's *staged* diff?
///
/// Only asked once a discard has already failed to match the unstaged diff. The
/// generic "the diff changed" would be true but useless there: nothing changed,
/// the hunk was picked from the Staged section, and the fix is one click.
fn matches_staged_diff(project_path: &str, file: &str, fingerprints: &[String], context: Option<u32>) -> bool {
    let Ok(text) = git_diff_text(project_path.to_string(), file.to_string(), context, Some(DiffMode::Staged), None) else {
        return false;
    };
    let parsed = crate::patch::parse_patch(&text);
    !parsed.hunks.is_empty()
        && fingerprints
            .iter()
            .all(|f| parsed.hunks.iter().any(|h| &h.fingerprint == f))
}

/// Throw away a subset of a file's **unstaged** hunks, rewriting the file on
/// disk and leaving the index alone.
///
/// This is the one apply path that is not `--cached`, and the only destructive
/// one: staging and unstaging shuffle the index, and the worktree is always
/// recoverable from it. A discard is the user's edits going away for good, so it
/// takes a backstop first (`backstop::take`) and reports its timestamp back as
/// the recovery route.
///
/// Unstaged-only by construction. Staged hunks are reached by unstaging them
/// first, which keeps the destructive path narrow: one source diff, one
/// direction, no mode argument a caller could pair wrongly.
#[tauri::command]
pub async fn git_discard_hunks(project_path: String, file: String, hunk_indices: Vec<usize>, fingerprints: Vec<String>, context: Option<u32>) -> Result<DiscardOutcome, String> {
    crate::exec::git_write("git_discard_hunks", project_path.clone(), move || git_discard_hunks_body(project_path, file, hunk_indices, fingerprints, context)).await
}

pub(crate) fn git_discard_hunks_body(
    project_path: String,
    file: String,
    hunk_indices: Vec<usize>,
    fingerprints: Vec<String>,
    context: Option<u32>,
) -> Result<DiscardOutcome, String> {
    if hunk_indices.len() != fingerprints.len() {
        return Err("Hunk selection is malformed".into());
    }
    if hunk_indices.is_empty() {
        return Err("No hunks selected".into());
    }
    if is_conflicted(&project_path, &file)? {
        return Err(CONFLICTED.into());
    }

    // An untracked file is all additions, so git emits exactly one hunk for it
    // whatever the context width. "Discard that hunk" and "discard that file"
    // are therefore the same request, and deleting it is the honest reading:
    // there is no index entry to reverse-apply a partial patch against.
    if is_untracked(&project_path, &file)? {
        let abs = inside_repo(&project_path, &file)?;
        // Still fingerprint-checked, even though the patch is never used. The
        // check is what proves the file has not moved under the rendered view,
        // and deleting on a stale one would destroy contents the user never saw
        // - a worse outcome than the partial apply the check exists to prevent.
        selected_patch(
            &project_path,
            &file,
            &hunk_indices,
            &fingerprints,
            DiffMode::Unstaged,
            true,
            context,
            STALE_DISCARD,
        )?;
        let record = crate::backstop::take(&project_path, &format!("Discard {file}"))?;
        std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
        return Ok(DiscardOutcome {
            backstop_ts: record.ts,
            changed: crate::backstop::RestoreOutcome { restored: Vec::new(), deleted: vec![file] },
        });
    }

    // Validated before the backstop, so a refused discard leaves no snapshot
    // behind: an undo list full of changes that never happened is worse than
    // none, because it makes the entries that matter harder to find.
    let patch = selected_patch(
        &project_path,
        &file,
        &hunk_indices,
        &fingerprints,
        DiffMode::Unstaged,
        true,
        context,
        STALE_DISCARD,
    )
    .map_err(|e| {
        if e == STALE_DISCARD && matches_staged_diff(&project_path, &file, &fingerprints, context) {
            "That change is staged. Unstage it first, then discard it.".to_string()
        } else {
            e
        }
    })?;

    let record = crate::backstop::take(
        &project_path,
        &format!(
            "Discard {} hunk{} in {file}",
            hunk_indices.len(),
            if hunk_indices.len() == 1 { "" } else { "s" }
        ),
    )?;
    git_apply(&project_path, &patch, false, true)?;
    Ok(DiscardOutcome {
        backstop_ts: record.ts,
        changed: crate::backstop::RestoreOutcome { restored: vec![file], deleted: Vec::new() },
    })
}

/// Throw away the working-tree changes to whole `files`: `git restore` for a
/// tracked file, deletion for an untracked one (git has nothing to restore it
/// from). Takes one backstop covering the lot.
///
/// Scoped to the unstaged side, matching the Changes section the control lives
/// in: a file's staged content is left exactly as it is.
#[tauri::command]
pub async fn git_discard_files(project_path: String, files: Vec<String>) -> Result<DiscardOutcome, String> {
    crate::exec::git_write("git_discard_files", project_path.clone(), move || git_discard_files_body(project_path, files)).await
}

pub(crate) fn git_discard_files_body(project_path: String, files: Vec<String>) -> Result<DiscardOutcome, String> {
    if files.is_empty() {
        return Err("No files selected".into());
    }
    // Split before anything is touched, and let a failed probe stop the whole
    // operation: guessing "tracked" on a git error would send an untracked file
    // to `git restore`, which cannot restore it and would report a confusing
    // pathspec error instead of the real problem.
    let mut untracked = Vec::new();
    let mut tracked = Vec::new();
    for f in &files {
        if is_conflicted(&project_path, f)? {
            return Err(CONFLICTED.into());
        }
        if is_untracked(&project_path, f)? {
            // Resolved before the backstop so an escaping path is refused while
            // refusing is still free.
            inside_repo(&project_path, f)?;
            untracked.push(f.clone());
        } else {
            tracked.push(f.clone());
        }
    }

    let record = crate::backstop::take(
        &project_path,
        &format!(
            "Discard {} file{}",
            files.len(),
            if files.len() == 1 { "" } else { "s" }
        ),
    )?;

    if !tracked.is_empty() {
        let mut args: Vec<&str> = vec!["restore", "--"];
        args.extend(tracked.iter().map(String::as_str));
        git_run(&project_path, &args)?;
    }
    for f in &untracked {
        match std::fs::remove_file(inside_repo(&project_path, f)?) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(DiscardOutcome {
        backstop_ts: record.ts,
        changed: crate::backstop::RestoreOutcome { restored: tracked, deleted: untracked },
    })
}

/// True when `file` has unmerged index stages, i.e. it is mid-conflict.
///
/// Discard has no meaning on one: there is no single "what it was" to go back
/// to, and `git restore` refuses an unmerged path anyway, so asking would only
/// trade a clear sentence for a raw pathspec error after a backstop had already
/// been written.
///
/// Conflicts now have their own section and no Discard control, so this is no
/// longer reachable by clicking the obvious thing. It stays because the panel
/// acts on the status it last read: a merge or rebase started in the terminal
/// makes a file unmerged without the row under the pointer changing, and the
/// path that then arrives here is a conflicted one from a list that predates it.
fn is_conflicted(project_path: &str, file: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(project_path)
        .args(["ls-files", "-u", "--", file])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

const CONFLICTED: &str = "That file has merge conflicts. Resolve them first, then discard what is left.";

/// True when git does not track `file` at all (no index entry).
fn is_untracked(project_path: &str, file: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(project_path)
        .args(["ls-files", "--", file])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

/// Feed `patch` to `git apply` on stdin.
///
/// `cached` picks what it touches, and that is the whole safety story here.
/// With it, the apply is index-only and the working tree cannot be disturbed at
/// all, so staging is unconditionally safe. Without it, the patch rewrites the
/// file on disk, which only discard does and only after taking a backstop.
/// Either way git apply is all-or-nothing: a patch that no longer fits is
/// rejected outright, never applied half-way.
fn git_apply(project_path: &str, patch: &str, cached: bool, reverse: bool) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut cmd = Command::new("git");
    // No --unidiff-zero: the panel always diffs with real context, and that
    // flag exists to disable the context checks a zero-context patch cannot
    // satisfy. Keeping them on means a patch that no longer fits is rejected
    // rather than applied somewhere plausible-looking.
    cmd.arg("-C").arg(project_path).arg("apply");
    if cached {
        cmd.arg("--cached");
    }
    if reverse {
        cmd.arg("--reverse");
    }
    let mut child = cmd
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    child
        .stdin
        .as_mut()
        .ok_or("Could not write the patch to git")?
        .write_all(patch.as_bytes())
        .map_err(|e| e.to_string())?;

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if err.is_empty() {
        "git could not apply the selected hunks; nothing changed.".into()
    } else {
        err
    })
}

// --- stash ---------------------------------------------------------------

/// One entry from `git stash list`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct StashEntry {
    /// `stash@{0}`. The handle every other stash command takes, and the only
    /// stable way to name an entry: the index shifts as entries are pushed and
    /// dropped, so the panel must re-list rather than remember.
    pub selector: String,
    /// The stash commit itself, for the commit view: a stash is a merge of HEAD
    /// with the index, so the commit diff's first-parent framing reads as the
    /// worktree changes it holds.
    pub sha: String,
    /// The user's own text, colons intact.
    pub message: String,
    /// The branch it was taken on, when git recorded one.
    pub branch: Option<String>,
    pub relative_date: String,
    /// Commit time as unix seconds, for the panel's own short form of the age.
    pub committed_at: i64,
}

/// Split a stash subject into its branch and the message the user actually
/// wrote.
///
/// git writes `On <branch>: <message>` for a stash made with `-m`, and
/// `WIP on <branch>: <sha> <subject>` for one made without. Both split on the
/// **first** `": "` only: a stash message routinely contains colons
/// ("fix: the thing"), and a greedy split would silently truncate it at the
/// first one.
fn split_stash_subject(subject: &str) -> (Option<String>, String) {
    let Some((head, rest)) = subject.split_once(": ") else {
        return (None, subject.to_string());
    };
    match head.strip_prefix("WIP on ").or_else(|| head.strip_prefix("On ")) {
        Some(branch) => (Some(branch.to_string()), rest.to_string()),
        // An unfamiliar prefix is not ours to reinterpret: a subject we cannot
        // parse is shown whole rather than cut at a colon that meant nothing.
        None => (None, subject.to_string()),
    }
}

/// Every stash, newest first (git's own order).
#[tauri::command(async)]
pub fn git_stash_list(project_path: String) -> Result<Vec<StashEntry>, String> {
    // NUL-delimited fields, so neither a colon nor a newline in the message can
    // split one entry into two. The stream is flat: five fields per entry.
    let out = git_capture(
        &project_path,
        &["stash", "list", "-z", "--format=%gd%x00%H%x00%s%x00%cr%x00%ct"],
    )?;
    let fields: Vec<&str> = out.split('\0').collect();
    Ok(fields
        .chunks_exact(5)
        .map(|c| {
            let (branch, message) = split_stash_subject(c[2]);
            StashEntry {
                selector: c[0].to_string(),
                sha: c[1].to_string(),
                message,
                branch,
                relative_date: c[3].to_string(),
                committed_at: c[4].trim().parse().unwrap_or(0),
            }
        })
        .collect())
}

/// `stash@{N}` and nothing else.
///
/// The selector reaches git as a bare argument, not after `--`, so a value like
/// `--all` would be read as an option rather than as a stash. Every caller takes
/// its selector straight from `git_stash_list`, so anything else is a bug at
/// best.
fn valid_selector(selector: &str) -> bool {
    selector
        .strip_prefix("stash@{")
        .and_then(|r| r.strip_suffix('}'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Stash the working tree. Returns whether an entry was actually created.
///
/// `include_untracked` defaults **off**, matching `git stash` itself. On is the
/// more surprising behaviour of the two: it sweeps up files git has never seen,
/// which for a typical project means build output and local scratch files, so it
/// is the caller's explicit choice rather than a convenience default.
///
/// A clean tree is not an error to git, which prints "No local changes to save"
/// and exits 0. Counting entries rather than reading that sentence keeps the
/// answer true regardless of git's locale.
#[tauri::command]
pub async fn git_stash_push(
    project_path: String,
    message: Option<String>,
    include_untracked: Option<bool>,
    staged: Option<bool>,
) -> Result<bool, String> {
    crate::exec::git_write("git_stash_push", project_path.clone(), move || {
        git_stash_push_body(project_path, message, include_untracked, staged)
    })
    .await
}

pub(crate) fn git_stash_push_body(
    project_path: String,
    message: Option<String>,
    include_untracked: Option<bool>,
    staged: Option<bool>,
) -> Result<bool, String> {
    let before = git_stash_list(project_path.clone())?.len();

    let mut args: Vec<&str> = vec!["stash", "push"];
    // `--staged` stashes the index alone and leaves the worktree, so it is
    // exclusive with `-u`: there are no untracked files in an index.
    if staged.unwrap_or(false) {
        args.push("--staged");
    } else if include_untracked.unwrap_or(false) {
        args.push("-u");
    }
    let message = message.unwrap_or_default();
    let trimmed = message.trim();
    if !trimmed.is_empty() {
        args.extend(["-m", trimmed]);
    }
    git_run(&project_path, &args)?;

    Ok(git_stash_list(project_path)?.len() > before)
}

/// What a stash apply put back, so open buffers reconcile through the same
/// channel a checkpoint revert and a discard use.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct StashOutcome {
    pub restored: Vec<String>,
    pub deleted: Vec<String>,
}

/// Apply a stash, optionally popping it.
///
/// The file list is read **before** applying: `pop` consumes the entry, so
/// afterwards there is nothing left to ask. A conflicting apply fails and
/// surfaces git's own message, which says which files are in the way.
#[tauri::command]
pub async fn git_stash_apply(project_path: String, selector: String, pop: Option<bool>) -> Result<StashOutcome, String> {
    crate::exec::git_write("git_stash_apply", project_path.clone(), move || git_stash_apply_body(project_path, selector, pop)).await
}

pub(crate) fn git_stash_apply_body(
    project_path: String,
    selector: String,
    pop: Option<bool>,
) -> Result<StashOutcome, String> {
    if !valid_selector(&selector) {
        return Err("That is not a stash.".into());
    }
    // `--include-untracked` is safe on an entry that has none: it simply
    // reports nothing extra, so the list is complete either way.
    //
    // `--no-renames` is load-bearing, not tidiness. Rename detection is on by
    // default, and under `-z` a rename spends **three** fields (`R100`, old,
    // new) where every other change spends two, so pairing them blindly would
    // desync and report a filename as a status from there on. It is also the
    // truer answer for this caller: laying such a stash down really does create
    // one path and remove the other, which is what an open buffer needs told.
    let names = git_capture(
        &project_path,
        &[
            "stash",
            "show",
            "--include-untracked",
            "--no-renames",
            "--name-status",
            "-z",
            &selector,
        ],
    )?;
    let fields: Vec<&str> = names.split('\0').collect();
    let mut restored = Vec::new();
    let mut deleted = Vec::new();
    for pair in fields.chunks_exact(2) {
        // A stash can record a deletion, so applying one removes a file.
        if pair[0].starts_with('D') {
            deleted.push(pair[1].to_string());
        } else {
            restored.push(pair[1].to_string());
        }
    }

    git_run(
        &project_path,
        &["stash", if pop.unwrap_or(false) { "pop" } else { "apply" }, &selector],
    )?;
    Ok(StashOutcome { restored, deleted })
}

/// Drop a stash. Destructive and **not** backstopped: the entry is not in the
/// working tree, so a backstop (a snapshot of that tree) would not contain it
/// and could not bring it back. The confirm says so rather than implying a
/// safety net that does not exist.
#[tauri::command]
pub async fn git_stash_drop(project_path: String, selector: String) -> Result<(), String> {
    crate::exec::git_write("git_stash_drop", project_path.clone(), move || git_stash_drop_body(project_path, selector)).await
}

pub(crate) fn git_stash_drop_body(project_path: String, selector: String) -> Result<(), String> {
    if !valid_selector(&selector) {
        return Err("That is not a stash.".into());
    }
    git_run(&project_path, &["stash", "drop", &selector])
}

/// Commit whatever is currently staged with `message`. Refuses an empty
/// message locally rather than letting git reject it (clearer error text).
///
/// `amend` rewrites HEAD instead of adding a commit, so it is the one path here
/// that needs nothing staged: amending only the message is a normal thing to
/// want. Whether that rewrite is safe (has HEAD been pushed?) is the caller's
/// question, not this one's - see `amendRewritesPushed` in
/// `src/utils/commitMessage.ts`.
#[tauri::command]
pub async fn git_commit(
    project_path: String,
    message: String,
    amend: Option<bool>,
    signoff: Option<bool>,
) -> Result<(), String> {
    crate::exec::git_write("git_commit", project_path.clone(), move || {
        git_commit_body(project_path, message, amend, signoff)
    })
    .await
}

pub(crate) fn git_commit_body(
    project_path: String,
    message: String,
    amend: Option<bool>,
    signoff: Option<bool>,
) -> Result<(), String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message is empty".into());
    }
    let mut args = vec!["commit"];
    if amend.unwrap_or(false) {
        args.push("--amend");
    }
    if signoff.unwrap_or(false) {
        args.push("--signoff");
    }
    args.extend(["-m", message]);
    git_run(&project_path, &args)
}

/// HEAD's full commit message, for prefilling the editor when amend is toggled
/// on. An unborn HEAD has no message to read, and that is not an error here:
/// the toggle simply has nothing to prefill, so failure reads as empty.
#[tauri::command(async)]
pub fn git_head_message(project_path: String) -> Result<String, String> {
    Ok(git_capture(&project_path, &["log", "-1", "--format=%B"]).unwrap_or_default())
}

/// One row of the commit log.
#[derive(Serialize, Debug, PartialEq)]
pub struct LogEntry {
    /// Full sha. What a commit-detail view is opened by; never shown as is.
    pub sha: String,
    /// git's own abbreviation, which is what the row shows. Taken from git
    /// rather than sliced here, because the length it needs to stay unambiguous
    /// grows with the repo and only git knows where that line currently sits.
    pub short: String,
    pub subject: String,
    pub author: String,
    pub relative_date: String,
    /// Committer time as unix seconds, for the panel's own short form of the
    /// age. The same date `%cr` words, for the reason given on LOG_FORMAT.
    pub committed_at: i64,
    /// The branch, tag and HEAD names pointing at this commit, in git's order
    /// (`HEAD -> main` first, then the rest). Empty for the overwhelming
    /// majority of commits, which is the case the parse has to get right.
    pub refs: Vec<String>,
    /// Full shas of this commit's parents: one for an ordinary commit, two or
    /// more for a merge, none for a root. What the graph draws its lanes from,
    /// and the reason it cannot be derived from the row order alone.
    pub parents: Vec<String>,
    /// On HEAD but not on its upstream. The graph paints these apart, since
    /// "not pushed yet" is the one thing about a commit you can still change.
    pub unpushed: bool,
    /// On a local branch but not on the base branch: the branch's own work,
    /// which the sidebar graph draws in its own hue above the trunk's.
    pub off_base: bool,
}

/// Eight NUL-terminated fields per commit. NUL rather than any printable
/// separator because a subject, an author name and a ref name can all contain
/// almost anything else; and `-z` on the command side so the *records* are
/// NUL-terminated too, leaving one flat stream to chunk.
///
/// The *author* name (`%an`) is paired with the *committer* date (`%cr`) on
/// purpose. Who wrote it does not change when history is replayed, but when it
/// was written does not describe where it sits: after a rebase the author date
/// of the top commit can be months old, and "3 months ago" beside the tip of a
/// branch you just rebased is a lie about the branch, not a fact about the
/// commit.
const LOG_FORMAT: &str = "--format=%H%x00%h%x00%s%x00%an%x00%cr%x00%ct%x00%D%x00%P";

/// Split `%D` back into names. git joins them with ", ", which no ref name can
/// contain (git refuses a space in one), so the split cannot cut a name in half.
fn parse_refs(decorations: &str) -> Vec<String> {
    decorations
        .split(", ")
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(str::to_string)
        .collect()
}

/// Parse the flat `-z` stream. A trailing empty field is left over by the final
/// record's terminator; `chunks_exact` drops it, along with any partial record
/// a truncated stream would end in.
fn parse_log(
    text: &str,
    unpushed: &std::collections::HashSet<String>,
    off_base: &std::collections::HashSet<String>,
) -> Vec<LogEntry> {
    let fields: Vec<&str> = text.split('\0').collect();
    fields
        .chunks_exact(8)
        .map(|c| LogEntry {
            sha: c[0].to_string(),
            short: c[1].to_string(),
            subject: c[2].to_string(),
            author: c[3].to_string(),
            relative_date: c[4].to_string(),
            committed_at: c[5].trim().parse().unwrap_or(0),
            refs: parse_refs(c[6]),
            // `%P` is space-separated full shas, empty for a root commit.
            parents: c[7].split_whitespace().map(str::to_string).collect(),
            unpushed: unpushed.contains(c[0]),
            off_base: off_base.contains(c[0]),
        })
        .collect()
}

/// Shas on HEAD that the upstream does not have. Empty when there is no
/// upstream, which is not the same as "everything is pushed": a branch with
/// nowhere to push to has nothing to be ahead of, and painting every commit as
/// unpushed there would make the colour mean nothing.
fn unpushed_shas(repo: &str) -> std::collections::HashSet<String> {
    git_capture(repo, &["rev-list", "@{u}..HEAD"])
        .map(|out| out.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default()
}

/// Shas on a local branch (or a detached HEAD) that the base branch does not
/// have: the work above the `master` pill, which is what a branch is. Empty
/// without a base (no origin, or no conventional trunk on it), where every
/// commit would qualify and the colour would say nothing.
fn off_base_shas(repo: &str) -> std::collections::HashSet<String> {
    let Ok(Some(base)) = git_default_base_branch(repo.to_string()) else {
        return Default::default();
    };
    let base_ref = format!("refs/remotes/origin/{base}");
    git_capture(repo, &["rev-list", "HEAD", "--branches", "--not", &base_ref])
        .map(|out| out.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default()
}

/// How many commits sit between HEAD and the point it left the base branch, so
/// a graph can widen its page until the base is on it.
///
/// The merge base rather than the base's tip: on a branch cut a while ago the
/// tip has moved on and is no ancestor of HEAD, so counting to it would answer
/// for a commit `git log HEAD` is never going to print. Zero whenever the
/// question has no answer (no base, no remote-tracking ref, no shared history),
/// which leaves the caller on its own page size.
#[tauri::command(async)]
pub fn git_base_offset(project_path: String) -> Result<u32, String> {
    let Ok(Some(base)) = git_default_base_branch(project_path.clone()) else {
        return Ok(0);
    };
    let base_ref = format!("refs/remotes/origin/{base}");
    let Ok(merge_base) = git_capture(&project_path, &["merge-base", "HEAD", &base_ref]) else {
        return Ok(0);
    };
    let range = format!("{merge_base}..HEAD");
    Ok(git_capture(&project_path, &["rev-list", "--count", &range])
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0))
}

/// How many commits one page holds when the caller does not say.
const LOG_PAGE: u32 = 100;

/// A page of history, newest first: the whole branch, or one file's own.
///
/// With `file` set the page is that path's history through `--follow`, which is
/// the only way to see a file's life before it was renamed - git stores no such
/// link, it re-detects the rename at each step, so nothing but `--follow` can
/// answer "where did this file come from".
///
/// An unborn HEAD (a repo with no commits yet) is an empty log, not an error:
/// `git log` exits non-zero there, and a fresh `bare_init` worktree is exactly
/// that state. The check is `rev-parse --verify`, not the wording of git's
/// complaint, which is localised.
#[tauri::command(async)]
pub fn git_log(
    project_path: String,
    skip: Option<u32>,
    limit: Option<u32>,
    file: Option<String>,
    all: Option<bool>,
) -> Result<Vec<LogEntry>, String> {
    match git_capture(&project_path, &["rev-parse", "--quiet", "--verify", "HEAD"]) {
        // `--quiet` silences exactly one failure, "HEAD names no commit", and
        // says nothing on stderr for it. Anything with a complaint attached
        // (not a repo, folder gone) is a real error and stays one.
        Err(complaint) if complaint.is_empty() => return Ok(Vec::new()),
        Err(complaint) => return Err(complaint),
        Ok(_) => {}
    }
    let skip = format!("--skip={}", skip.unwrap_or(0));
    let limit = format!("--max-count={}", limit.unwrap_or(LOG_PAGE));
    let mut args = vec!["log", "-z", LOG_FORMAT, &skip, &limit];
    // The three ref kinds rather than `--all`, which would also walk the
    // stash refs and put every stash in the graph as a stray merge.
    if all.unwrap_or(false) {
        args.extend_from_slice(&["--branches", "--remotes", "--tags"]);
    }
    if let Some(path) = file.as_deref() {
        // `--follow` takes exactly one pathspec, and it must come after `--`.
        args.extend_from_slice(&["--follow", "--", path]);
    }
    let out = git_capture(&project_path, &args)?;
    Ok(parse_log(&out, &unpushed_shas(&project_path), &off_base_shas(&project_path)))
}

/// `git diff --numstat`, summed. Binary files count as a file and no lines.
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct DiffStat {
    pub files: u32,
    pub insertions: u32,
    pub deletions: u32,
}

/// What a commit would hold: the index with `staged`, the working tree without.
/// `--numstat` rather than `--shortstat`, whose wording follows the locale.
#[tauri::command(async)]
pub fn git_diff_stat(project_path: String, staged: Option<bool>) -> Result<DiffStat, String> {
    let mut args = vec!["diff", "--numstat"];
    if staged.unwrap_or(false) {
        args.push("--cached");
    }
    let out = git_capture(&project_path, &args)?;
    Ok(parse_numstat(&out))
}

fn parse_numstat(text: &str) -> DiffStat {
    let mut stat = DiffStat::default();
    for line in text.lines() {
        let mut cols = line.split('\t');
        let (Some(ins), Some(del)) = (cols.next(), cols.next()) else { continue };
        stat.files += 1;
        stat.insertions += ins.trim().parse::<u32>().unwrap_or(0);
        stat.deletions += del.trim().parse::<u32>().unwrap_or(0);
    }
    stat
}

/// The commit HEAD names, or "" on an unborn branch.
///
/// Its own command rather than the first entry of `git_log` because it is read
/// on every HEAD-moving event and everything derived from committed history
/// caches against it: `rev-parse` is one cheap answer where a log page is a
/// hundred.
#[tauri::command(async)]
pub fn git_head_sha(project_path: String) -> Result<String, String> {
    match git_capture(&project_path, &["rev-parse", "--quiet", "--verify", "HEAD"]) {
        // Same reading as `git_log`: `--quiet` says nothing on stderr for an
        // unborn HEAD, and anything with a complaint attached is a real error.
        Err(complaint) if complaint.is_empty() => Ok(String::new()),
        Err(complaint) => Err(complaint),
        Ok(sha) => Ok(sha),
    }
}

/// One file's place in a commit.
#[derive(Serialize, Debug, PartialEq)]
pub struct CommitFile {
    /// The path as of this commit. For a delete, the path that went away.
    pub path: String,
    /// Where it came from, for a rename or a copy. Carried because the patch
    /// needs it too: pathspec-limited rename detection only pairs the two sides
    /// when *both* are in the pathspec, and asking for the new path alone turns
    /// a rename into a whole-file addition.
    pub old_path: Option<String>,
    /// git's status letter with its similarity score stripped: A, M, D, R, C, T.
    pub status: String,
}

/// Everything a commit tab shows above its diffs.
#[derive(Serialize, Debug, PartialEq)]
pub struct CommitDetail {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub relative_date: String,
    /// Full shas, first-parent first. Two or more means a merge, which is what
    /// the header says and what the diff framing below is chosen for.
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub files: Vec<CommitFile>,
}

const COMMIT_META_FORMAT: &str =
    "--format=%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%cr%x00%P%x00%D";

/// The framing that answers a commit's three awkward shapes with one command.
///
/// `--root` gives the first commit a diff against nothing, rather than nothing
/// at all. `-m --first-parent` gives a merge one diff against the branch it
/// landed on, where plain `git show` gives a merge the *combined* diff, which is
/// empty for a clean merge, and nearly every merge is clean. `-M` finds renames,
/// so a moved file is one row instead of a delete standing beside an addition.
const COMMIT_DIFF_ARGS: &[&str] = &[
    "diff-tree",
    "-r",
    "-m",
    "--first-parent",
    "--root",
    "-M",
    "--no-commit-id",
];

/// A commit id, and nothing that could be read as an option. Tab ids are strings
/// and so is `--output=/etc/passwd`; the sha reaching a command line has to be
/// proven to be a sha first.
fn valid_object_name(sha: &str) -> bool {
    (7..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// Parse `--name-status -z`. A rename or copy record spends *three* fields
/// (`R094`, old, new) where every other record spends two, so the reader pulls
/// the extra field rather than splitting into fixed-size chunks.
fn parse_commit_files(text: &str) -> Vec<CommitFile> {
    let mut out = Vec::new();
    let mut fields = text.split('\0');
    while let Some(code) = fields.next() {
        // The stream's own terminator leaves a trailing empty field.
        let Some(letter) = code.chars().next() else {
            continue;
        };
        if letter == 'R' || letter == 'C' {
            let (Some(old), Some(path)) = (fields.next(), fields.next()) else {
                break;
            };
            out.push(CommitFile {
                path: path.to_string(),
                old_path: Some(old.to_string()),
                status: letter.to_string(),
            });
        } else {
            let Some(path) = fields.next() else { break };
            out.push(CommitFile {
                path: path.to_string(),
                old_path: None,
                status: letter.to_string(),
            });
        }
    }
    out
}

fn parse_commit_meta(text: &str, files: Vec<CommitFile>) -> Option<CommitDetail> {
    let fields: Vec<&str> = text.split('\0').collect();
    let c = fields.chunks_exact(9).next()?;
    Some(CommitDetail {
        sha: c[0].to_string(),
        short: c[1].to_string(),
        subject: c[2].to_string(),
        // `%b` keeps the blank line that separated it from the subject.
        body: c[3].trim_end().to_string(),
        author: c[4].to_string(),
        email: c[5].to_string(),
        relative_date: c[6].to_string(),
        parents: c[7].split_whitespace().map(str::to_string).collect(),
        refs: parse_refs(c[8]),
        files,
    })
}

/// One commit's metadata and the files it touched.
#[tauri::command(async)]
pub fn git_commit_detail(project_path: String, sha: String) -> Result<CommitDetail, String> {
    if !valid_object_name(&sha) {
        return Err(format!("Not a commit id: {}", sha));
    }
    let meta = git_capture(&project_path, &["log", "-1", "-z", COMMIT_META_FORMAT, &sha])?;
    let mut args: Vec<&str> = COMMIT_DIFF_ARGS.to_vec();
    args.extend_from_slice(&["--name-status", "-z", &sha]);
    let names = git_capture(&project_path, &args)?;
    parse_commit_meta(&meta, parse_commit_files(&names))
        .ok_or_else(|| format!("Could not read commit {}", sha))
}

/// One file's patch within a commit. `old_path` comes straight back from
/// `git_commit_detail`; without it a renamed file reads as an addition of the
/// whole file (see `CommitFile::old_path`).
///
/// Run directly rather than through `git_capture` because a patch's last line
/// can legitimately be a context line that is nothing but a space, and trimming
/// the output would drop it.
#[tauri::command(async)]
pub fn git_commit_file_diff(
    project_path: String,
    sha: String,
    file: String,
    old_path: Option<String>,
    context: Option<u32>,
) -> Result<String, String> {
    if !valid_object_name(&sha) {
        return Err(format!("Not a commit id: {}", sha));
    }
    let unified = format!("-U{}", context.unwrap_or(3));
    let mut args: Vec<&str> = COMMIT_DIFF_ARGS.to_vec();
    args.extend_from_slice(&["--no-color", &unified, "-p", &sha, "--", &file]);
    if let Some(old) = old_path.as_deref() {
        args.push(old);
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Which two trees a diff compares. A partially-staged ("MM") file has a row in
/// both the Staged and Changes sections, and one comparison cannot describe
/// both: the Staged row needs index-vs-HEAD, the Changes row worktree-vs-index.
#[derive(Deserialize, Default, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DiffMode {
    /// Worktree vs HEAD: all uncommitted work, staged or not. The default,
    /// because it is what the gutter and the session diff both want (see the
    /// module header) - staging a file must not blank its gutter marks.
    #[default]
    Head,
    /// Index vs HEAD: exactly what a commit would contain right now.
    Staged,
    /// Worktree vs index: what is still unstaged.
    Unstaged,
}

impl DiffMode {
    /// The revision selector for this comparison. Everything else about the
    /// command (paths, --no-color, -U) is shared.
    fn args(self) -> &'static [&'static str] {
        match self {
            DiffMode::Head => &["HEAD"],
            DiffMode::Staged => &["--cached", "HEAD"],
            DiffMode::Unstaged => &[],
        }
    }

    /// Whether an empty result should fall back to showing an untracked file as
    /// all-additions. Meaningless for `Staged`: an untracked file is by
    /// definition absent from the index, so "nothing staged" is the true answer.
    fn shows_untracked(self) -> bool {
        self != DiffMode::Staged
    }
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
    /// 1-based first removed line in the old file. 0 for a pure addition.
    old_start: u32,
    /// The removed lines themselves, without their `-` prefix. Empty for a pure
    /// addition.
    removed: Vec<String>,
}

/// Parse a unified-diff range token like "12,3" or "12" (count defaults to 1).
fn parse_range(s: &str) -> (u32, u32) {
    let mut parts = s.splitn(2, ',');
    let start = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let count = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1);
    (start, count)
}

#[tauri::command]
pub async fn git_diff_file(project_path: String, file: String, mode: Option<DiffMode>) -> Result<Vec<DiffHunk>, String> {
    crate::exec::blocking("git_diff_file", move || git_diff_file_body(project_path, file, mode)).await
}

pub(crate) fn git_diff_file_body(project_path: String, file: String, mode: Option<DiffMode>) -> Result<Vec<DiffHunk>, String> {
    let mode = mode.unwrap_or_default();
    // -U0: hunk headers carry exact ranges, no surrounding context to walk.
    let output = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff"])
        .args(mode.args())
        .args(["--no-color", "-U0", "--", &file])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // No HEAD yet, untracked file, or not a repo: no hunks.
        return Ok(vec![]);
    }

    Ok(parse_hunks(&String::from_utf8_lossy(&output.stdout)))
}

/// Raw unified diff text for a single file, for the inline review view.
/// Untracked files have no diff against a tree, so fall back to showing the
/// whole file as additions (`git diff --no-index /dev/null <file>`).
///
/// `context` sets `-U<n>`; the review panel asks for more than git's default 3
/// so its "n unchanged lines" collapse has something real to hide and to reveal
/// on expand. Omitted means git's default. `mode` picks which two trees are
/// compared, defaulting to worktree-vs-HEAD.
///
/// `ignore_whitespace` adds `-w`. The staging commands always re-derive the
/// diff without it, so hunks read this way are for looking at, not staging.
#[tauri::command(async)]
pub fn git_diff_text(
    project_path: String,
    file: String,
    context: Option<u32>,
    mode: Option<DiffMode>,
    ignore_whitespace: Option<bool>,
) -> Result<String, String> {
    let mode = mode.unwrap_or_default();
    let unified: Vec<String> = context.map(|n| format!("-U{}", n)).into_iter().collect();
    let whitespace: &[&str] = if ignore_whitespace.unwrap_or(false) { &["-w"] } else { &[] };

    let output = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff"])
        .args(mode.args())
        .args(["--no-color"])
        .args(&unified)
        .args(whitespace)
        .args(["--", &file])
        .output()
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if (output.status.success() && !text.trim().is_empty()) || !mode.shows_untracked() {
        return Ok(text);
    }
    // Under -w an empty diff of a tracked file means only whitespace changed.
    if output.status.success() && !whitespace.is_empty() && !is_untracked(&project_path, &file)? {
        return Ok(text);
    }

    // Untracked (or no HEAD): diff against an empty tree so new files still show.
    let untracked = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff", "--no-color", "--no-index"])
        .args(&unified)
        .args(whitespace)
        .args(["--", "/dev/null", &file])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&untracked.stdout).into_owned())
}

fn parse_hunks(text: &str) -> Vec<DiffHunk> {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    // Which hunk the body lines below belong to. Cleared at each file header,
    // because a removed line reading "-- a/f" is indistinguishable from one,
    // and only the lines after an `@@` are content.
    let mut open: Option<usize> = None;
    for line in text.lines() {
        if line.starts_with("diff --git ") {
            open = None;
            continue;
        }
        // Hunk header: @@ -old_start,old_count +new_start,new_count @@
        let Some(rest) = line.strip_prefix("@@ ") else {
            if let Some(at) = open {
                if let Some(removed) = line.strip_prefix('-') {
                    hunks[at].removed.push(removed.to_string());
                }
            }
            continue;
        };
        open = None;
        let mut tokens = rest.split_whitespace();
        let (Some(minus), Some(plus)) = (tokens.next(), tokens.next()) else {
            continue;
        };
        if !minus.starts_with('-') || !plus.starts_with('+') {
            continue;
        }
        let (old_start, old_count) = parse_range(&minus[1..]);
        let (new_start, new_count) = parse_range(&plus[1..]);
        let kind = if old_count == 0 {
            "added"
        } else if new_count == 0 {
            "deleted"
        } else {
            "modified"
        };
        open = Some(hunks.len());
        hunks.push(DiffHunk {
            kind: kind.to_string(),
            start: new_start,
            count: new_count,
            old_start: if old_count == 0 { 0 } else { old_start },
            removed: Vec::new(),
        });
    }
    hunks
}

/// Switch the shared working tree to `branch` (plain repos only; the frontend
/// gates this). git checkout is atomic: on a dirty/conflicting tree it fails and
/// leaves the tree untouched, so surfacing stderr is enough to never half-switch.
#[tauri::command]
pub async fn git_checkout(repo_path: String, branch: String) -> Result<(), String> {
    crate::exec::git_write("git_checkout", repo_path.clone(), move || git_checkout_body(repo_path, branch)).await
}

pub(crate) fn git_checkout_body(repo_path: String, branch: String) -> Result<(), String> {
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

/// Whether git has a usable author identity (both `user.name` and `user.email`, any
/// scope), so an initial commit won't fail with "Author identity unknown".
fn has_git_identity(repo: &str) -> bool {
    let set = |key: &str| {
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["config", "--get", key])
            .output()
            .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
            .unwrap_or(false)
    };
    set("user.name") && set("user.email")
}

/// Core of `git_init` without the app event, so it is unit-testable: `git init`
/// (optional initial branch via symbolic-ref, portable across git versions) and
/// a scaffolded .gitignore when none exists. Refuses an existing repo. Returns
/// whether an initial commit was made (false when git has no identity).
fn do_init(dir: &Path, branch: Option<&str>) -> Result<bool, String> {
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
    // Born the branch with an empty root commit so the repo is immediately usable:
    // the branch shows by name (not a nameless folder unit) and new branches can be
    // created off it. Skipped when git has no author identity, so init never
    // hard-fails; discovery still shows the unborn branch by name, and the UI warns.
    if !has_git_identity(&path) {
        return Ok(false);
    }
    git_run(&path, &["commit", "--allow-empty", "-q", "-m", "Initial commit"])?;
    Ok(true)
}

/// Initialize a git repo in a plain-dir project (optional initial branch),
/// scaffolding a default .gitignore. Re-discovers (plain-dir becomes plain).
/// Returns whether an initial commit was made, so the UI can warn when a missing
/// git identity left the repo unborn.
#[tauri::command]
pub async fn git_init(app: AppHandle, project_path: String, branch: Option<String>) -> Result<bool, String> {
    crate::exec::git_write("git_init", project_path.clone(), move || git_init_body(app, project_path, branch)).await
}

pub(crate) fn git_init_body(app: AppHandle, project_path: String, branch: Option<String>) -> Result<bool, String> {
    let committed = do_init(Path::new(&project_path), branch.as_deref())?;
    crate::exec::forget_common_dir(&project_path);
    let _ = app.emit("config://changed", ());
    Ok(committed)
}

/// Capture the trimmed stdout of `git -C <repo> <args>`, or an error with stderr.
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

/// Core of `bare_init` without the app event, so it is unit-testable. Turns an
/// existing plain-dir folder into a bare+worktree layout *in place* (no clone): a
/// `.bare` bare repo, a `.git` pointer file, and one initial worktree on an unborn
/// `<branch>` (blank = git's default). The result is a usable worktree container
/// with no commits yet, so a remote can be added and fetched later (like `git init`
/// then "Add Origin"). Existing files in the folder are untouched. Refuses a folder
/// that is already a git repo.
fn do_bare_init(dir: &Path, branch: Option<&str>) -> Result<(), String> {
    if dir.join(".git").exists() || dir.join(".bare").exists() {
        return Err("This folder is already a git repository.".into());
    }
    let path = dir.to_string_lossy().into_owned();
    let branch = branch.map(str::trim).filter(|b| !b.is_empty());
    if let Some(b) = branch {
        if b.contains('/') || b.contains(char::is_whitespace) || b.starts_with('-') {
            return Err("Invalid branch name".into());
        }
    }

    // 1. A bare repo under `.bare` (relative to the folder, created by init).
    match branch {
        Some(b) => git_run(&path, &["init", "--bare", "-q", "-b", b, ".bare"])?,
        None => git_run(&path, &["init", "--bare", "-q", ".bare"])?,
    }
    // 2. The `.git` pointer so the folder resolves to `.bare` as its git dir.
    std::fs::write(dir.join(".git"), "gitdir: ./.bare\n").map_err(|e| e.to_string())?;
    // 3. The initial worktree on the default branch, unborn (--orphan needs no
    //    commit), named after the branch. Read the default when none was given.
    let def = match branch {
        Some(b) => b.to_string(),
        None => git_capture(&path, &["symbolic-ref", "--short", "HEAD"])?,
    };
    git_run(&path, &["worktree", "add", "--orphan", "-b", &def, &def])?;
    Ok(())
}

/// Bootstrap a bare+worktree layout in an existing plain-dir folder (optional
/// initial branch). Re-discovers (plain-dir becomes a worktree container).
#[tauri::command]
pub async fn bare_init(app: AppHandle, project_path: String, branch: Option<String>) -> Result<(), String> {
    crate::exec::git_write("bare_init", project_path.clone(), move || bare_init_body(app, project_path, branch)).await
}

pub(crate) fn bare_init_body(app: AppHandle, project_path: String, branch: Option<String>) -> Result<(), String> {
    do_bare_init(Path::new(&project_path), branch.as_deref())?;
    crate::exec::forget_common_dir(&project_path);
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Add the `origin` remote, or update its URL if it already exists.
#[tauri::command]
pub async fn git_remote_add(app: AppHandle, project_path: String, url: String) -> Result<(), String> {
    crate::exec::git_write("git_remote_add", project_path.clone(), move || git_remote_add_body(app, project_path, url)).await
}

pub(crate) fn git_remote_add_body(app: AppHandle, project_path: String, url: String) -> Result<(), String> {
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

/// One remote's URL, or None when the repo has no such remote.
pub(crate) fn remote_url(repo: &str, remote: &str) -> Result<Option<String>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["remote", "get-url", remote])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None);
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!url.is_empty()).then_some(url))
}

/// Origin's URL if configured, else None. Lets the UI gate push on a remote.
#[tauri::command(async)]
pub fn git_origin(project_path: String) -> Result<Option<String>, String> {
    remote_url(&project_path, "origin")
}

// --- auth'd / network git via the askpass bridge ---

/// A fresh per-op id. Each network op gets one so its sibling username/password
/// prompts (separate git askpass processes) share a single cancel latch.
fn next_op_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("op-{}-{}", std::process::id(), n)
}

/// Build a `git -C <repo>` command wired to the askpass credential bridge:
/// `GIT_ASKPASS`/`SSH_ASKPASS` point at Tori's own binary (re-exec'd as the
/// helper), `SSH_ASKPASS_REQUIRE=force` makes ssh use it without a TTY (OpenSSH
/// >= 8.4), `GIT_TERMINAL_PROMPT=0` forbids any terminal fallback (fail closed),
/// `LC_ALL=C` keeps prompt wording stable for `kind` parsing, and
/// `StrictHostKeyChecking=accept-new` handles first-contact SSH host keys (TOFU:
/// auto-add an unknown host, still reject a *changed* key). The op id and socket
/// coordinates ride through the env into the helper.
fn git_command(repo: &str, op_id: &str, sock: &Path, token: &str) -> Command {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("git"));
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo);
    cmd.env("GIT_ASKPASS", &exe);
    cmd.env("SSH_ASKPASS", &exe);
    cmd.env("SSH_ASKPASS_REQUIRE", "force");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("LC_ALL", "C");
    cmd.env("GIT_SSH_COMMAND", "ssh -o StrictHostKeyChecking=accept-new");
    cmd.env(ENV_SOCK, sock);
    cmd.env(ENV_TOKEN, token);
    cmd.env(ENV_OP, op_id);
    cmd.env("PATH", augmented_path());
    cmd
}

/// Payload for the background-fetch result events.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    repo: String,
    ok: bool,
    error: String,
    /// A scheduled fetch nobody asked for. Every listener that reloads the world
    /// on this event has to ignore the quiet ones, or a background sweep across
    /// twenty repos becomes twenty full reloads.
    quiet: bool,
    /// When the fetch finished, unix seconds.
    fetched_at: u64,
}

/// When each container was last asked to fetch, keyed by its git common dir.
/// Monotonic, so the floor holds across a clock change.
static LAST_FETCH: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, std::time::Instant>>,
> = std::sync::OnceLock::new();

fn fetch_attempts()
-> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, std::time::Instant>> {
    LAST_FETCH.get_or_init(Default::default)
}

/// Note that a container was asked, without asking whether it was due. The
/// manual fetch calls this so the next sweep does not repeat what you just ran.
fn record_fetch_attempt(common: &Path) {
    fetch_attempts()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(common.to_path_buf(), std::time::Instant::now());
}

/// Take the right to fetch this container, or report that it is too soon. The
/// check and the record are one critical section, so two sweeps racing the same
/// container cannot both get through it.
fn claim_fetch(common: &Path, min_age: std::time::Duration) -> bool {
    let mut attempts = fetch_attempts()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if attempts.get(common).is_some_and(|at| at.elapsed() < min_age) {
        return false;
    }
    attempts.insert(common.to_path_buf(), std::time::Instant::now());
    true
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// Background `git fetch` through the askpass bridge: runs on its own thread with
/// a fresh op id, so credential prompts pop the in-app dialog (no terminal tab)
/// and a cancel aborts the whole op. Emits `git://fetch-done` on success and
/// `git://fetch-error` on failure; both carry the repo path so the UI can
/// correlate. `remote` defaults to `--all`.
#[tauri::command]
pub fn git_fetch(
    app: AppHandle,
    state: State<AskpassState>,
    repo: String,
    remote: Option<String>,
) -> Result<(), String> {
    let inner = state.0.clone();
    let op_id = next_op_id();
    thread::spawn(move || {
        let mut cmd = git_command(&repo, &op_id, inner.sock_path(), inner.token());
        let named = remote.as_deref().map(str::trim).filter(|r| !r.is_empty());
        // Before the subcommand, since `-c` is git's own argument and not the
        // fetch's.
        let _bridge = match named {
            Some(r) => crate::credential::bridge(&mut cmd, &repo, r, &op_id),
            None => crate::credential::bridge_all(&mut cmd, &repo, &op_id),
        };
        cmd.arg("fetch");
        match named {
            Some(r) => cmd.arg(r),
            None => cmd.arg("--all"),
        };
        // Fetch updates remote-tracking refs in the shared .git, so it queues
        // with every other write on this repo (see exec.rs). Held only for the
        // subprocess, not the emit.
        let (ok, error) = {
            let lock = crate::exec::repo_lock(&repo);
            let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            record_fetch_attempt(&crate::exec::common_dir(&repo));
            match crate::git_health::run(&mut cmd) {
                Ok(o) if o.status.success() => (true, String::new()),
                Ok(o) => (false, String::from_utf8_lossy(&o.stderr).trim().to_string()),
                Err(e) => (false, e),
            }
        };
        let event = if ok { "git://fetch-done" } else { "git://fetch-error" };
        let _ = app.emit(event, FetchResult { repo, ok, error, quiet: false, fetched_at: now_secs() });
    });
    Ok(())
}

/// A `git` that can never ask a human anything. The askpass vars are *unset*
/// rather than merely not set: a parent shell may have exported them, and a
/// fetch on a ten-minute timer must not pop a dialog over what you are doing.
fn quiet_git_command(repo: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo);
    cmd.env_remove("GIT_ASKPASS");
    cmd.env_remove("SSH_ASKPASS");
    cmd.env_remove("SSH_ASKPASS_REQUIRE");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("LC_ALL", "C");
    cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new");
    cmd.env("PATH", augmented_path());
    cmd
}

/// Fetch every repository the sidebar knows, on a schedule, without asking.
///
/// `min_age_secs` is the floor: a container asked more recently than that is
/// left alone, which is what lets the chip click and the Changes refresh call
/// this freely. `only` narrows the sweep to one root's container.
#[tauri::command]
pub fn git_fetch_quiet(
    app: AppHandle,
    index: State<crate::config::ProjectIndex>,
    min_age_secs: u64,
    only: Option<String>,
) -> Result<(), String> {
    let index = index.inner().clone();
    thread::spawn(move || {
        let Ok(config) = crate::config::get_config_body(&index) else {
            return;
        };
        let min_age = std::time::Duration::from_secs(min_age_secs);
        let mut run = |repo: &str| {
            let mut cmd = quiet_git_command(repo);
            cmd.args(["fetch", "--all"]);
            match crate::git_health::run(&mut cmd) {
                Ok(out) if out.status.success() => Ok(()),
                Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
                Err(e) => Err(e),
            }
        };
        for event in quiet_sweep(&config, only.as_deref(), min_age, &mut run) {
            let name = if event.ok { "git://fetch-done" } else { "git://fetch-error" };
            let _ = app.emit(name, event);
        }
    });
    Ok(())
}

/// One sweep: which containers are due, the fetch itself, and the events that
/// follow. The fetch is a parameter and the events are returned rather than
/// emitted, so a test can watch both without an `AppHandle`.
fn quiet_sweep(
    config: &crate::config::ResolvedConfig,
    only: Option<&str>,
    min_age: std::time::Duration,
    fetch: &mut impl FnMut(&str) -> Result<(), String>,
) -> Vec<FetchResult> {
    use crate::config::ProjectKind;

    let wanted = only.map(crate::exec::common_dir);
    // A Vec, not a map: the events come out in the order the sidebar lists its
    // projects, and one sweep covers few enough containers that the scan costs
    // nothing next to the subprocess at the end of it.
    let mut containers: Vec<(PathBuf, Vec<String>)> = Vec::new();
    for unit in config
        .spaces
        .iter()
        .flat_map(|space| &space.projects)
        .flat_map(|project| &project.branch_units)
    {
        if !matches!(unit.kind, ProjectKind::Worktree | ProjectKind::Plain) {
            continue;
        }
        let common = crate::exec::common_dir(&unit.folder_path);
        if wanted.as_ref().is_some_and(|want| *want != common) {
            continue;
        }
        match containers.iter_mut().find(|(seen, _)| *seen == common) {
            // Every branch of a plain repo is a unit on the *same* folder, so
            // the distinct paths are what the listeners want one event each for.
            Some((_, folders)) => {
                if !folders.contains(&unit.folder_path) {
                    folders.push(unit.folder_path.clone());
                }
            }
            None => containers.push((common, vec![unit.folder_path.clone()])),
        }
    }

    let mut events = Vec::new();
    for (common, folders) in containers {
        // After the dedupe, so a plain repo listing twenty branches costs one
        // probe rather than twenty. An unborn repo has no remote-tracking refs
        // to move, and a folder that stopped being one fails every sweep.
        if !folders
            .iter()
            .any(|f| git_capture(f, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok())
        {
            continue;
        }
        // `try_lock`, never `lock`: a held lock is a manual op mid-flight on
        // this repo, and a read nobody asked for must not queue in front of it.
        let lock = crate::exec::repo_lock(&folders[0]);
        let Ok(_guard) = lock.try_lock() else {
            continue;
        };
        if !claim_fetch(&common, min_age) {
            continue;
        }
        let outcome = fetch(&folders[0]);
        let fetched_at = now_secs();
        for repo in folders {
            events.push(FetchResult {
                repo,
                ok: outcome.is_ok(),
                error: outcome.as_ref().err().cloned().unwrap_or_default(),
                quiet: true,
                fetched_at,
            });
        }
    }
    events
}

/// The remote-tracking ref `branch` follows, in its short spelling
/// (`origin/main`), or None when it tracks nothing.
fn upstream_ref(repo: &str, branch: &str) -> Option<String> {
    git_capture(repo, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", &format!("{branch}@{{u}}")])
        .ok()
        .filter(|name| !name.is_empty())
}

/// Whether `branch` already tracks an upstream in `repo`, so `git_push` knows
/// whether to pass `--set-upstream` on its first push.
fn has_upstream(repo: &str, branch: &str) -> bool {
    upstream_ref(repo, branch).is_some()
}

/// Payload for the background-push result events.
#[derive(Clone, Serialize)]
pub struct PushResult {
    repo: String,
    ok: bool,
    error: String,
}

/// One blocking `git push` through the askpass bridge, with a fresh op id so
/// credential prompts pop the in-app dialog. Passes `--set-upstream` when
/// `branch` tracks nothing yet (its first push).
///
/// Separate from [`git_push`] because two callers need opposite things from the
/// same push: the button wants it off the UI thread and reported by event, while
/// "open a PR" must know whether it succeeded *before* deciding to create one.
/// Sharing the body means the second caller cannot drift from the first on
/// `--set-upstream`, which is the flag a brand-new branch depends on.
pub fn push_branch(repo: &str, remote: &str, branch: &str, sock: &Path, token: &str) -> Result<(), String> {
    let op_id = next_op_id();
    let set_upstream = !has_upstream(repo, branch);
    let mut cmd = git_command(repo, &op_id, sock, token);
    let _bridge = crate::credential::bridge(&mut cmd, repo, remote, &op_id);
    cmd.arg("push");
    if set_upstream {
        cmd.arg("--set-upstream");
    }
    cmd.arg(remote).arg(branch);
    match crate::git_health::run(&mut cmd) {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
        Err(e) => Err(e),
    }
}

/// Background `git push` through the askpass bridge, a sibling of `git_fetch`:
/// runs on its own thread. Emits `git://push-done` on success and
/// `git://push-error` on failure; both carry the repo path so the UI can
/// correlate.
#[tauri::command]
pub fn git_push(
    app: AppHandle,
    state: State<AskpassState>,
    repo: String,
    remote: String,
    branch: String,
) -> Result<(), String> {
    let inner = state.0.clone();
    thread::spawn(move || {
        // Push writes local tracking refs when it lands, so it queues with the
        // repo's other writes for its duration.
        let (ok, error) = {
            let lock = crate::exec::repo_lock(&repo);
            let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match push_branch(&repo, &remote, &branch, inner.sock_path(), inner.token()) {
                Ok(()) => (true, String::new()),
                Err(e) => (false, e),
            }
        };
        let event = if ok { "git://push-done" } else { "git://push-error" };
        let _ = app.emit(event, PushResult { repo, ok, error });
    });
    Ok(())
}

/// Ahead/behind counts of the current branch against its upstream, for the
/// Changes panel header. `has_upstream: false` (branch tracks nothing yet)
/// renders as an "unpushed branch" state rather than 0/0.
#[derive(Serialize)]
pub struct AheadBehind {
    ahead: u32,
    behind: u32,
    has_upstream: bool,
}

#[tauri::command(async)]
pub fn git_ahead_behind(project_path: String) -> Result<AheadBehind, String> {
    // Unborn HEAD or detached: `rev-parse --abbrev-ref HEAD` reports "HEAD"
    // itself rather than erroring, which then simply fails `has_upstream`
    // below - reported as the same "unpushed branch" state.
    let branch = git_capture(&project_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !has_upstream(&project_path, &branch) {
        return Ok(AheadBehind { ahead: 0, behind: 0, has_upstream: false });
    }
    let counts = git_capture(
        &project_path,
        &["rev-list", "--left-right", "--count", &format!("{branch}...{branch}@{{u}}")],
    )?;
    let mut parts = counts.split_whitespace();
    let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok(AheadBehind { ahead, behind, has_upstream: true })
}

/// The PR base branch: `origin/HEAD` when set, else a probe for `origin/main`
/// then `origin/master` (in that order), else None (no origin, or neither
/// conventional branch exists - the UI hides "Open PR" without a base).
#[tauri::command(async)]
pub fn git_default_base_branch(project_path: String) -> Result<Option<String>, String> {
    if let Ok(text) = git_capture(&project_path, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        if let Some(b) = text.strip_prefix("refs/remotes/origin/") {
            return Ok(Some(b.to_string()));
        }
    }
    for candidate in ["main", "master"] {
        let refname = format!("refs/remotes/origin/{candidate}");
        if Command::new("git")
            .arg("-C")
            .arg(&project_path)
            .args(["rev-parse", "--verify", "--quiet", &refname])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return Ok(Some(candidate.to_string()));
        }
    }
    Ok(None)
}

/// Where a branch stands against its upstream. `rewritten` separates the two
/// ways a branch diverges, which want opposite advice: history this side
/// rewrote (rebase, amend) needs a force push, a commit somebody else pushed
/// needs a pull.
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct UpstreamSync {
    ahead: u32,
    behind: u32,
    has_upstream: bool,
    rewritten: bool,
}

/// What the base branch has done since this one left it. `conflicts` is
/// tri-state: `Some([])` is "merges clean", a non-empty list is the paths that
/// would fight, and `None` is "not asked" - git below 2.38, or no shared
/// history to merge across. Reading `None` as clean is what would let a row
/// stay quiet in front of the rebase that hurts.
#[derive(Serialize, Debug, PartialEq)]
pub struct BaseSync {
    name: String,
    behind: u32,
    conflicts: Option<Vec<String>>,
}

/// One branch's whole standing, against both the thing it pushes to and the
/// thing it will merge back into.
#[derive(Serialize, Debug, PartialEq)]
pub struct BranchSync {
    detached: bool,
    dirty: bool,
    /// Committer time of HEAD, unix seconds. Zero on an unborn branch.
    head_committed_at: i64,
    upstream: UpstreamSync,
    base: Option<BaseSync>,
}

/// The whole sync story of the checked-out branch, in one round trip.
///
/// Every probe inside degrades to its zero rather than to an `Err`: this
/// answers for a row that is drawn whether or not the repo cooperates, and a
/// failed `rev-list` in a shallow clone must cost that row its count, not its
/// existence. The one thing that is never faked is `conflicts`, which has a
/// value for "unknown" precisely so the UI can stay silent instead of claiming
/// a clean merge it did not check.
#[tauri::command(async)]
pub fn git_branch_sync(project_path: String) -> Result<BranchSync, String> {
    Ok(branch_sync(&project_path))
}

fn branch_sync(repo: &str) -> BranchSync {
    // `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD`, which answers
    // the literal string "HEAD" when detached and dies on an unborn branch.
    // This one names a branch before its first commit, and fails only when detached.
    let branch = git_capture(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|name| !name.is_empty());
    let sync = BranchSync {
        detached: branch.is_none(),
        dirty: is_dirty(repo),
        head_committed_at: 0,
        upstream: UpstreamSync::default(),
        base: None,
    };
    if git_capture(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() {
        return sync;
    }

    let tracked = branch.as_deref().and_then(|name| upstream_ref(repo, name));
    BranchSync {
        head_committed_at: git_capture(repo, &["log", "-1", "--format=%ct"])
            .ok()
            .and_then(|t| t.parse().ok())
            .unwrap_or(0),
        upstream: match (branch.as_deref(), &tracked) {
            (Some(name), Some(_)) => upstream_sync(repo, name),
            _ => UpstreamSync::default(),
        },
        base: base_sync(repo, branch.as_deref(), tracked.as_deref()),
        ..sync
    }
}

/// Anything uncommitted at all, tracked or not. `--no-optional-locks` for the
/// reason `git_status` states: a read must not take the lock a concurrent
/// commit would fail on.
fn is_dirty(repo: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["--no-optional-locks", "status", "--porcelain", "-z"])
        .output()
        .map(|out| out.status.success() && !out.stdout.is_empty())
        .unwrap_or(false)
}

/// How far back HEAD's reflog is read for `rewritten`: a session's worth of
/// checkouts and rebases, and short enough that a branch which sat where the
/// upstream sits now, long ago, does not read as rewritten forever.
const REFLOG_DEPTH: &str = "-n200";

fn upstream_sync(repo: &str, branch: &str) -> UpstreamSync {
    let range = format!("{branch}...{branch}@{{u}}");
    let counts = git_capture(repo, &["rev-list", "--left-right", "--count", &range]).unwrap_or_default();
    let mut parts = counts.split_whitespace();
    let ahead = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    // Only where the answer means anything. A branch sitting *on* its upstream
    // finds its own tip in its own reflog and would read rewritten forever; one
    // merely behind pays for a reflog read to learn nothing.
    let diverged = ahead > 0 && behind > 0;
    UpstreamSync {
        ahead,
        behind,
        has_upstream: true,
        rewritten: diverged && upstream_tip_in_reflog(repo, branch),
    }
}

/// Whether the upstream's tip is a commit HEAD has stood on before: an amend or
/// a rebase leaves the old tip in the reflog, a push by somebody else does not.
/// A heuristic, not a proof, so the chip says "diverged" either way.
fn upstream_tip_in_reflog(repo: &str, branch: &str) -> bool {
    let Ok(tip) = git_capture(repo, &["rev-parse", &format!("{branch}@{{u}}")]) else {
        return false;
    };
    git_capture(repo, &["log", "-g", "--format=%H", REFLOG_DEPTH, "HEAD"])
        .map(|log| log.lines().any(|sha| sha == tip))
        .unwrap_or(false)
}

fn base_sync(repo: &str, branch: Option<&str>, tracked: Option<&str>) -> Option<BaseSync> {
    let base = git_default_base_branch(repo.to_string()).ok().flatten()?;
    // Two ways the base is already the question the upstream answers: standing
    // on it, or tracking it from somewhere else. Either way a second count of
    // the same distance would draw two chips saying one thing.
    if branch == Some(base.as_str()) {
        return None;
    }
    let base_ref = format!("origin/{base}");
    if tracked == Some(base_ref.as_str()) {
        return None;
    }
    let behind = git_capture(repo, &["rev-list", "--count", &format!("HEAD..refs/remotes/{base_ref}")])
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    Some(BaseSync { name: base, conflicts: base_conflicts(repo, &base_ref, behind), behind })
}

/// Everything a merge's outcome turns on and nothing else, so a row redrawn on
/// every fetch asks git once per actual movement. The container rather than the
/// worktree: two branches in one container already differ in their HEAD sha.
type ConflictKey = (PathBuf, String, String);
static CONFLICTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<ConflictKey, Option<Vec<String>>>>> =
    std::sync::OnceLock::new();

/// Where the cache stops growing. Every key dies the moment either side commits,
/// so past the cap the map goes whole: one round of recomputation, and no
/// eviction order to maintain for entries that were about to expire anyway.
const CONFLICT_CACHE_MAX: usize = 128;

fn base_conflicts(repo: &str, base_ref: &str, behind: u32) -> Option<Vec<String>> {
    conflicts_with(repo, base_ref, behind, merge_tree_conflicts)
}

/// The cache and the two cheap refusals around it, with the merge injected so a
/// test can count how often it actually runs.
fn conflicts_with(
    repo: &str,
    base_ref: &str,
    behind: u32,
    merge: impl FnOnce(&str, &str) -> Option<Vec<String>>,
) -> Option<Vec<String>> {
    // The base is already an ancestor, so the merge is a no-op: clean, known to
    // be clean, and not worth a process to find out.
    if behind == 0 {
        return Some(Vec::new());
    }
    if !crate::git_health::at_least(2, 38) {
        return None;
    }
    let Some(key) = conflict_key(repo, base_ref) else {
        return merge(repo, base_ref);
    };
    let cache = CONFLICTS.get_or_init(Default::default);
    if let Some(hit) = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&key) {
        return hit.clone();
    }
    // Outside the lock: merge-tree is the slow part, and holding the map shut
    // for it would serialise every other row's lookup behind one of them.
    let answer = merge(repo, base_ref);
    let mut map = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if map.len() >= CONFLICT_CACHE_MAX {
        map.clear();
    }
    map.insert(key, answer.clone());
    answer
}

/// None when either side will not resolve, which is the one case that must not
/// be cached: an answer keyed on a sha nobody could read is keyed on nothing.
fn conflict_key(repo: &str, base_ref: &str) -> Option<ConflictKey> {
    let head = git_capture(repo, &["rev-parse", "HEAD"]).ok()?;
    let base = git_capture(repo, &["rev-parse", &format!("refs/remotes/{base_ref}")]).ok()?;
    Some((crate::exec::common_dir(repo), head, base))
}

/// The paths a merge of the base into HEAD would conflict on, without touching
/// the working tree. The 2.38 `--write-tree` exit code is the answer: 0 clean,
/// 1 conflicted with the paths after the oid, anything else unknown, not clean.
fn merge_tree_conflicts(repo: &str, base_ref: &str) -> Option<Vec<String>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["merge-tree", "--write-tree", "--name-only", "--no-messages", base_ref, "HEAD"])
        .output()
        .ok()?;
    match out.status.code() {
        Some(0) => Some(Vec::new()),
        Some(1) => Some(
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .skip(1)
                .map(str::to_string)
                .collect(),
        ),
        _ => None,
    }
}

/// Delete a branch on its remote (`git push <remote> --delete <ref>`) through the
/// askpass bridge, so credential prompts pop the in-app dialog. The remote and the
/// remote-side ref are resolved from the *local* branch's tracking config, so a
/// branch pushed under a different name still deletes the right ref; a branch that
/// tracks nothing errors. Synchronous: the caller (the worktree-remove dialog)
/// awaits the result to report success or failure. Emits `config://changed`.
#[tauri::command(async)]
pub fn delete_remote_branch(
    app: AppHandle,
    state: State<AskpassState>,
    repo: String,
    branch: String,
) -> Result<(), String> {
    let (remote, refname) = crate::worktree::resolve_remote_branch(Path::new(&repo), &branch)
        .ok_or("This branch has no remote branch to delete.")?;
    let inner = state.0.clone();
    let op_id = next_op_id();
    let mut cmd = git_command(&repo, &op_id, inner.sock_path(), inner.token());
    // A push naming one remote, so the same rule as `push_branch`.
    let _bridge = crate::credential::bridge(&mut cmd, &repo, &remote, &op_id);
    cmd.args(["push", &remote, "--delete", &refname]);
    let out = {
        let lock = crate::exec::repo_lock(&repo);
        let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        crate::git_health::run(&mut cmd)?
    };
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Whether a login here is answered without prompting: Tori's own helper for a
/// host with the switch on, else a `credential.helper` in any scope. With
/// neither, git re-prompts every op (nothing is cached), so the UI warns once.
#[tauri::command(async)]
pub fn git_has_credential_helper(repo: String) -> Result<bool, String> {
    // Warning about a missing helper here would send the user to configure
    // something that already works.
    if crate::credential::answers_fetch(&repo) {
        return Ok(true);
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["config", "--get", "credential.helper"])
        .output()
        .map_err(|e| e.to_string())?;
    let value = String::from_utf8_lossy(&out.stdout);
    Ok(out.status.success() && !value.trim().is_empty())
}

/// Keep a Tori working directory out of the repo, in the repo's own ignore file
/// rather than the user's `.gitignore`.
///
/// `.git/info/exclude` is the right home: these directories are Tori's business,
/// and writing one into a tracked `.gitignore` would put it in the user's next
/// commit and then in everyone else's checkout. Nothing tracked is touched, and
/// a teammate who never runs Tori sees nothing.
///
/// Idempotent, and silent on every failure: a repo that cannot be excluded still
/// works, it just shows the directory as untracked.
pub(crate) fn exclude_from_repo(root: &str, dir: &str) {
    let Ok(out) = Command::new("git").arg("-C").arg(root).args(["rev-parse", "--git-dir"]).output() else {
        return;
    };
    if !out.status.success() {
        return;
    }
    let git_dir = Path::new(root).join(String::from_utf8_lossy(&out.stdout).trim());
    let exclude = git_dir.join("info/exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    let entry = format!("{dir}/");
    // Both spellings count as already there: a user who wrote the bare name by
    // hand has said the same thing, and a second line would only be noise.
    if existing.lines().any(|l| l.trim() == entry || l.trim() == dir) {
        return;
    }
    if std::fs::create_dir_all(git_dir.join("info")).is_err() {
        return;
    }
    let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    let _ = std::fs::write(&exclude, format!("{existing}{sep}{entry}\n"));
}


// --- integrate, undo, branches -------------------------------------------
//
// The commands behind the Changes tab's menu and the palette's `Git:` entries.
// Same two rules as everything above: a write takes the repo's lock through
// `exec::git_write`, and anything that touches the network goes through
// `git_command` so a credential prompt reaches the askpass bridge instead of
// hanging on a TTY that is not there.

/// A background network op's outcome, carried on its event. Same three fields
/// as `FetchResult` and `PushResult`, kept separate for the same reason they
/// are: one event per operation, so a listener cannot mistake a failed pull for
/// a failed fetch.
#[derive(Clone, Serialize)]
pub struct PullResult {
    pub repo: String,
    pub ok: bool,
    pub error: String,
}

/// The remote a bare `git pull` here would talk to: the current branch's
/// upstream, which is the only place git resolves one from.
fn pull_remote(repo: &str) -> Option<String> {
    let branch = git_capture(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let remote = git_capture(repo, &["config", "--get", &format!("branch.{branch}.remote")]).ok()?;
    (!remote.is_empty()).then_some(remote)
}

/// Background `git pull`, a sibling of `git_fetch` and `git_push`. Emits
/// `git://pull-done` or `git://pull-error`.
///
/// `--no-rebase` is passed explicitly on the merge path rather than left to the
/// default: `pull.rebase` is a very common global setting, and a menu entry
/// that says Pull and silently rebases because of one is the kind of surprise
/// that costs an afternoon.
#[tauri::command]
pub fn git_pull(
    app: AppHandle,
    state: State<AskpassState>,
    repo: String,
    rebase: Option<bool>,
) -> Result<(), String> {
    let inner = state.0.clone();
    let op_id = next_op_id();
    thread::spawn(move || {
        let mut cmd = git_command(&repo, &op_id, inner.sock_path(), inner.token());
        let _bridge =
            pull_remote(&repo).and_then(|r| crate::credential::bridge(&mut cmd, &repo, &r, &op_id));
        cmd.arg("pull");
        cmd.arg(if rebase.unwrap_or(false) { "--rebase" } else { "--no-rebase" });
        let (ok, error) = {
            let lock = crate::exec::repo_lock(&repo);
            let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match crate::git_health::run(&mut cmd) {
                Ok(o) if o.status.success() => (true, String::new()),
                // A pull that stopped on a conflict reports through the file
                // list like a merge does, so its stderr is the whole of what
                // this has to say about it.
                Ok(o) => (false, String::from_utf8_lossy(&o.stderr).trim().to_string()),
                Err(e) => (false, e),
            }
        };
        let event = if ok { "git://pull-done" } else { "git://pull-error" };
        let _ = app.emit(event, PullResult { repo, ok, error });
    });
    Ok(())
}

/// What an integrate attempt did. A conflict is an outcome, not a failure: the
/// working tree now holds the unmerged stages the Changes panel is there to
/// resolve, so it answers `Ok` and says so.
#[derive(Serialize, Debug, PartialEq)]
pub struct IntegrateOutcome {
    pub conflicted: bool,
    /// git's own account, for a toast. Empty when it went in cleanly.
    pub message: String,
}

/// True when the index holds unmerged stages.
fn has_unmerged(repo: &str) -> bool {
    git_capture(repo, &["ls-files", "--unmerged"]).is_ok_and(|s| !s.trim().is_empty())
}

/// Run one integrate subcommand and read a conflict apart from a refusal.
fn integrate(repo: &str, args: &[&str]) -> Result<IntegrateOutcome, String> {
    match git_run(repo, args) {
        Ok(()) => Ok(IntegrateOutcome { conflicted: false, message: String::new() }),
        Err(e) if has_unmerged(repo) => Ok(IntegrateOutcome { conflicted: true, message: e }),
        Err(e) => Err(e),
    }
}

/// Merge `branch` into the current one.
#[tauri::command]
pub async fn git_merge(
    project_path: String,
    branch: String,
    no_ff: Option<bool>,
) -> Result<IntegrateOutcome, String> {
    crate::exec::git_write("git_merge", project_path.clone(), move || {
        let mut args = vec!["merge"];
        if no_ff.unwrap_or(false) {
            args.push("--no-ff");
        }
        args.push(&branch);
        integrate(&project_path, &args)
    })
    .await
}

/// Replay the current branch onto `onto`.
#[tauri::command]
pub async fn git_rebase(project_path: String, onto: String) -> Result<IntegrateOutcome, String> {
    crate::exec::git_write("git_rebase", project_path.clone(), move || {
        integrate(&project_path, &["rebase", &onto])
    })
    .await
}

/// Abandon whatever merge, rebase, cherry-pick or revert is in progress.
///
/// The op is read from the repo rather than passed in: the caller's idea of
/// what is running comes from a poll, and aborting the wrong one is either a
/// no-op error or, worse, an abort of something the user did not mean.
#[tauri::command]
pub async fn git_abort(project_path: String) -> Result<(), String> {
    crate::exec::git_write("git_abort", project_path.clone(), move || {
        let op = crate::conflict::git_conflict_op(project_path.clone())?;
        let args: &[&str] = match op {
            crate::conflict::ConflictOp::Merge => &["merge", "--abort"],
            crate::conflict::ConflictOp::Rebase => &["rebase", "--abort"],
            crate::conflict::ConflictOp::CherryPick => &["cherry-pick", "--abort"],
            crate::conflict::ConflictOp::Revert => &["revert", "--abort"],
            crate::conflict::ConflictOp::None => return Err("Nothing to abort".into()),
        };
        git_run(&project_path, args)
    })
    .await
}

/// Undo the last commit, keeping its changes staged.
///
/// A root commit has no parent to reset onto, and `HEAD~1` fails there rather
/// than doing something sensible. Deleting the ref is the equivalent: the tree
/// and index survive, and the branch goes back to unborn.
#[tauri::command]
pub async fn git_undo_last_commit(project_path: String) -> Result<(), String> {
    crate::exec::git_write("git_undo_last_commit", project_path.clone(), move || {
        if git_capture(&project_path, &["rev-parse", "--verify", "HEAD~1"]).is_ok() {
            git_run(&project_path, &["reset", "--soft", "HEAD~1"])
        } else {
            git_run(&project_path, &["update-ref", "-d", "HEAD"])
        }
    })
    .await
}

/// Create a branch, optionally from a named start point, optionally checking it
/// out. Refuses to check out over a dirty tree, which git would do silently for
/// files the two sides agree on.
#[tauri::command]
pub async fn git_branch_create(
    project_path: String,
    name: String,
    from: Option<String>,
    checkout: Option<bool>,
) -> Result<(), String> {
    crate::exec::git_write("git_branch_create", project_path.clone(), move || {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("Branch name is empty".into());
        }
        let start = from.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let mut args = vec![if checkout.unwrap_or(false) { "checkout" } else { "branch" }];
        if checkout.unwrap_or(false) {
            args.push("-b");
        }
        args.push(&name);
        if let Some(s) = start {
            args.push(s);
        }
        git_run(&project_path, &args)
    })
    .await
}

/// Rename a branch. `-m` rather than `-M`: clobbering an existing name is a
/// different decision, and this one has no way to ask.
#[tauri::command]
pub async fn git_branch_rename(project_path: String, from: String, to: String) -> Result<(), String> {
    crate::exec::git_write("git_branch_rename", project_path.clone(), move || {
        let to = to.trim().to_string();
        if to.is_empty() {
            return Err("Branch name is empty".into());
        }
        git_run(&project_path, &["branch", "-m", &from, &to])
    })
    .await
}

/// Delete a branch. Unforced by default, so git's own "not fully merged"
/// refusal is what the caller has to answer for.
#[tauri::command]
pub async fn git_branch_delete(
    project_path: String,
    branch: String,
    force: Option<bool>,
) -> Result<(), String> {
    crate::exec::git_write("git_branch_delete", project_path.clone(), move || {
        git_run(&project_path, &["branch", if force.unwrap_or(false) { "-D" } else { "-d" }, &branch])
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One fixture per porcelain-v2 record type, in the exact spelling real
    /// `git status --porcelain=v2 -z` emits (captured from a scratch repo).
    /// `\0` terminates every record, and the rename spends two of them.
    #[test]
    fn status_parses_every_record_type() {
        let out = concat!(
            "# branch.head main\0",
            "1 .M N... 100644 100644 100644 aaa bbb src/App.tsx\0",
            "1 M. N... 100644 100644 100644 aaa bbb staged.rs\0",
            "1 MM N... 100644 100644 100644 aaa bbb both.rs\0",
            "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt\0old name.txt\0",
            // A copy is the same record type as a rename, differing only in the
            // score field, so it must take the same two-field path.
            "2 C. N... 100644 100644 100644 aaa bbb C100 copy.txt\0source.txt\0",
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.rs\0",
            // Both-deleted: an unmerged code with no `U` in it, and identical to
            // an ordinary staged-plus-worktree delete once the record type is
            // thrown away. The reason `conflicted` is read from the type.
            "u DD N... 100644 100644 100644 100644 aaa bbb ccc gone.rs\0",
            "? new.txt\0",
            "! ignored.log\0",
        );
        let files = parse_status(out);
        let by_path = |p: &str| files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("missing {p}"));

        // The `#` header and the ignored file are both skipped, so the count is
        // the eight records that describe an actual change.
        assert_eq!(files.len(), 8, "header and ignored records must not be listed");
        assert!(files.iter().all(|f| f.path != "ignored.log"));

        // v2's `.` normalises back to v1's space, so these codes are unchanged
        // from what every consumer already reads.
        let unstaged = by_path("src/App.tsx");
        assert_eq!((unstaged.status.as_str(), unstaged.staged, unstaged.unstaged), (" M", false, true));
        let staged = by_path("staged.rs");
        assert_eq!((staged.status.as_str(), staged.staged, staged.unstaged), ("M ", true, false));
        let both = by_path("both.rs");
        assert_eq!((both.status.as_str(), both.staged, both.unstaged), ("MM", true, true));
        let untracked = by_path("new.txt");
        assert_eq!((untracked.status.as_str(), untracked.staged, untracked.unstaged), ("??", false, true));

        // A rename keeps the new path as the pathspec and the old one beside
        // it, rather than v1's unusable "old -> new" single string. The space
        // in the name is the reason the field split is counted, not greedy.
        let renamed = by_path("new name.txt");
        assert_eq!(renamed.status, "R ");
        assert_eq!(renamed.orig_path.as_deref(), Some("old name.txt"));
        assert!(renamed.staged && !renamed.unstaged);

        // A conflicted file is its own thing, not a staged one: three index
        // stages is not a staged version, and every action either section
        // offers is one git refuses on an unmerged path.
        let conflict = by_path("conflict.rs");
        assert_eq!(conflict.status, "UU");
        assert!(conflict.conflicted);
        assert!(!conflict.staged && !conflict.unstaged);
        let both_deleted = by_path("gone.rs");
        assert!(both_deleted.conflicted, "`DD` is unmerged, and has no `U` to scan for");
        assert!(!both_deleted.staged && !both_deleted.unstaged);

        // Nothing else claims to be conflicted, in particular not the `MM` file
        // whose two non-space columns look the same at a glance.
        assert!(files.iter().filter(|f| f.path != "conflict.rs" && f.path != "gone.rs").all(|f| !f.conflicted));

        // A copy carries its source the same way, so the pairing cannot be
        // keyed on the score field.
        let copied = by_path("copy.txt");
        assert_eq!(copied.orig_path.as_deref(), Some("source.txt"));

        // Everything except the two-path records leaves `orig_path` empty.
        assert!(files
            .iter()
            .filter(|f| f.path != "new name.txt" && f.path != "copy.txt")
            .all(|f| f.orig_path.is_none()));
    }

    #[test]
    fn a_real_conflict_is_its_own_state_until_it_is_marked_resolved() {
        // The fixture above is a captured string; this is git's own output, so
        // the record type really is what a mid-merge repo emits.
        let dir = repo_with_two_branches();
        git(&dir, &["checkout", "-q", "feature"]);
        std::fs::write(dir.join("f.txt"), "theirs\n").unwrap();
        git(&dir, &["commit", "-qam", "theirs"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("f.txt"), "ours\n").unwrap();
        git(&dir, &["commit", "-qam", "ours"]);
        // Deliberately fails, leaving f.txt unmerged in the index.
        Command::new("git").arg("-C").arg(&dir).args(["merge", "feature"]).output().unwrap();
        let p = dir.to_string_lossy().into_owned();

        let conflicted = git_status_body(&p).unwrap();
        let f = conflicted.iter().find(|f| f.path == "f.txt").expect("f.txt is listed");
        assert!(f.conflicted);
        assert!(!f.staged && !f.unstaged, "a conflict is in neither section");

        // Marking it resolved is an ordinary `git add`, and from that moment the
        // file is an ordinary staged change: one index stage, no `u` record.
        git(&dir, &["add", "f.txt"]);
        let resolved = git_status_body(&p).unwrap();
        let f = resolved.iter().find(|f| f.path == "f.txt").expect("f.txt is still listed");
        assert!(!f.conflicted);
        assert!(f.staged);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_rename_reports_both_paths_and_a_diffable_pathspec() {
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("before.txt"), "one\ntwo\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "add before.txt"]);
        git(&dir, &["mv", "before.txt", "after.txt"]);
        let p = dir.to_string_lossy().into_owned();

        let files = git_status_body(&p).unwrap();
        let renamed = files.iter().find(|f| f.orig_path.is_some()).expect("expected a rename entry");
        assert_eq!(renamed.path, "after.txt");
        assert_eq!(renamed.orig_path.as_deref(), Some("before.txt"));

        // The point of the migration: the reported path is a real pathspec, so
        // asking for its diff returns something. Under v1 this path was the
        // literal "before.txt -> after.txt", which matched no file and gave an
        // empty diff.
        let diff = git_diff_text(p, renamed.path.clone(), None, Some(DiffMode::Staged), None).unwrap();
        assert!(!diff.is_empty(), "a renamed file's diff must not come back empty");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn z_output_carries_awkward_names_raw() {
        // v1 quoted a non-ASCII name ("na\303\257ve.txt") and left a spaced one
        // to be guessed at. `-z` emits both raw, which is what makes them
        // usable as pathspecs - asserted here by staging via the reported path.
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("naïve.txt"), "x").unwrap();
        std::fs::write(dir.join("two words.txt"), "y").unwrap();
        let p = dir.to_string_lossy().into_owned();

        let files = git_status_body(&p).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"naïve.txt"), "got {paths:?}");
        assert!(paths.contains(&"two words.txt"), "got {paths:?}");
        assert!(paths.iter().all(|p| !p.contains('"')), "no path should arrive quoted: {paths:?}");

        git_stage_body(p.clone(), vec!["naïve.txt".into(), "two words.txt".into()]).unwrap();
        let after = git_status_body(&p).unwrap();
        let staged: Vec<&str> = after.iter().filter(|f| f.staged).map(|f| f.path.as_str()).collect();
        assert!(staged.contains(&"naïve.txt") && staged.contains(&"two words.txt"), "got {staged:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hunks_classify_added_modified_deleted() {
        // -U0 headers: added (old count 0), modified, pure deletion (new count 0).
        let diff = "\
diff --git a/f b/f
--- a/f
+++ b/f
@@ -0,0 +1,3 @@
+one
+two
+three
@@ -10,2 +11,2 @@
-old ten
-old eleven
+new eleven
+new twelve
@@ -20,3 +20,0 @@
-gone a
--- still a removed line
-gone c
\\ No newline at end of file
";
        let hunks = parse_hunks(diff);
        assert_eq!(hunks.len(), 3);
        assert_eq!((hunks[0].kind.as_str(), hunks[0].start, hunks[0].count), ("added", 1, 3));
        assert_eq!((hunks[1].kind.as_str(), hunks[1].start, hunks[1].count), ("modified", 11, 2));
        assert_eq!((hunks[2].kind.as_str(), hunks[2].start, hunks[2].count), ("deleted", 20, 0));

        assert_eq!(hunks[0].old_start, 0);
        assert!(hunks[0].removed.is_empty(), "an addition removes nothing: {:?}", hunks[0].removed);
        assert_eq!(hunks[1].old_start, 10);
        assert_eq!(hunks[1].removed, vec!["old ten", "old eleven"]);
        assert_eq!(hunks[2].old_start, 20);
        assert_eq!(hunks[2].removed, vec!["gone a", "-- still a removed line", "gone c"]);
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
        let dir = std::env::temp_dir().join(format!("tori_checkout_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        std::fs::write(dir.join("f.txt"), "v1").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        git(&dir, &["branch", "feature"]);
        dir
    }

    /// A local repo (on `main`, one commit) with `origin` set to a bare repo,
    /// nothing pushed yet. Returns (local, remote).
    fn repo_with_remote() -> (PathBuf, PathBuf) {
        let remote = empty_tmp();
        git(&remote, &["init", "--bare", "-q"]);
        let local = repo_with_two_branches();
        git(&local, &["checkout", "-q", "main"]);
        git(&local, &["remote", "add", "origin", &remote.to_string_lossy()]);
        (local, remote)
    }

    #[test]
    fn has_upstream_reflects_push_state() {
        let (local, remote) = repo_with_remote();
        let p = local.to_string_lossy().into_owned();
        assert!(!has_upstream(&p, "main"));
        git(&local, &["push", "-u", "origin", "main"]);
        assert!(has_upstream(&p, "main"));
        std::fs::remove_dir_all(&local).ok();
        std::fs::remove_dir_all(&remote).ok();
    }

    #[test]
    fn ahead_behind_tracks_unpushed_then_pushed_commits() {
        let (local, remote) = repo_with_remote();
        let p = local.to_string_lossy().into_owned();

        let before = git_ahead_behind(p.clone()).unwrap();
        assert!(!before.has_upstream);

        git(&local, &["push", "-u", "origin", "main"]);
        let synced = git_ahead_behind(p.clone()).unwrap();
        assert!(synced.has_upstream);
        assert_eq!((synced.ahead, synced.behind), (0, 0));

        std::fs::write(local.join("f.txt"), "v2").unwrap();
        git(&local, &["commit", "-aqm", "more"]);
        let ahead = git_ahead_behind(p).unwrap();
        assert_eq!((ahead.ahead, ahead.behind), (1, 0));

        std::fs::remove_dir_all(&local).ok();
        std::fs::remove_dir_all(&remote).ok();
    }

    #[test]
    fn default_base_branch_falls_back_to_probing_origin_main() {
        let (local, remote) = repo_with_remote();
        let p = local.to_string_lossy().into_owned();
        git(&local, &["push", "-u", "origin", "main"]);

        // No origin/HEAD symref set yet - falls back to the origin/main probe.
        assert_eq!(git_default_base_branch(p.clone()).unwrap().as_deref(), Some("main"));

        // An explicit origin/HEAD symref is read directly.
        git(&local, &["remote", "set-head", "origin", "main"]);
        assert_eq!(git_default_base_branch(p).unwrap().as_deref(), Some("main"));

        std::fs::remove_dir_all(&local).ok();
        std::fs::remove_dir_all(&remote).ok();
    }

    #[test]
    fn default_base_branch_none_without_origin() {
        let dir = repo_with_two_branches();
        let p = dir.to_string_lossy().into_owned();
        assert_eq!(git_default_base_branch(p).unwrap(), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A local repo whose `main` is pushed to `origin`, standing on a `feat`
    /// branch cut from it: the shape every base question needs.
    fn repo_on_feature() -> (PathBuf, PathBuf) {
        let (local, remote) = repo_with_remote();
        git(&local, &["push", "-q", "-u", "origin", "main"]);
        git(&local, &["checkout", "-qb", "feat"]);
        (local, remote)
    }

    /// Put one commit on `main` and push it, so `origin/main` moves ahead of
    /// `feat` while `feat` stays where it was. The push updates the
    /// remote-tracking ref itself, so nothing here has to fetch.
    fn move_base(local: &Path, file: &str, body: &str) {
        git(local, &["checkout", "-q", "main"]);
        std::fs::write(local.join(file), body).unwrap();
        git(local, &["add", "."]);
        git(local, &["commit", "-qm", "base moves on"]);
        git(local, &["push", "-q", "origin", "main"]);
        git(local, &["checkout", "-q", "feat"]);
    }

    fn commit_file(dir: &Path, file: &str, body: &str) {
        std::fs::write(dir.join(file), body).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", file]);
    }

    fn scrub(dirs: &[&Path]) {
        for dir in dirs {
            std::fs::remove_dir_all(dir).ok();
        }
    }

    fn sync_of(dir: &Path) -> BranchSync {
        branch_sync(&dir.to_string_lossy())
    }

    #[test]
    fn branch_sync_has_nothing_to_say_when_everything_matches() {
        let (local, remote) = repo_on_feature();
        git(&local, &["push", "-q", "-u", "origin", "feat"]);

        let sync = sync_of(&local);
        assert!(!sync.detached && !sync.dirty);
        assert!(sync.head_committed_at > 0, "HEAD has a commit time");
        assert_eq!(
            sync.upstream,
            UpstreamSync { ahead: 0, behind: 0, has_upstream: true, rewritten: false }
        );
        // The base is named even with nothing to report, so a caller can tell
        // "level with main" from "there is no main".
        assert_eq!(
            sync.base,
            Some(BaseSync { name: "main".into(), behind: 0, conflicts: Some(vec![]) })
        );
        scrub(&[&local, &remote]);
    }

    #[test]
    fn branch_sync_counts_commits_the_upstream_has_and_we_do_not() {
        let (local, remote) = repo_on_feature();
        git(&local, &["push", "-q", "-u", "origin", "feat"]);
        commit_file(&local, "later.txt", "later");
        git(&local, &["push", "-q", "origin", "feat"]);
        git(&local, &["reset", "--hard", "-q", "HEAD~1"]);

        let sync = sync_of(&local);
        assert_eq!((sync.upstream.ahead, sync.upstream.behind), (0, 1));
        scrub(&[&local, &remote]);
    }

    #[test]
    fn branch_sync_calls_a_rewrite_of_our_own_history_rewritten() {
        let (local, remote) = repo_on_feature();
        commit_file(&local, "work.txt", "work");
        git(&local, &["push", "-q", "-u", "origin", "feat"]);
        std::fs::write(local.join("work.txt"), "work, reworded").unwrap();
        git(&local, &["commit", "-aq", "--amend", "-m", "work, reworded"]);

        let sync = sync_of(&local);
        assert_eq!((sync.upstream.ahead, sync.upstream.behind), (1, 1));
        assert!(sync.upstream.rewritten, "the amended-away commit is still the upstream's tip");
        scrub(&[&local, &remote]);
    }

    #[test]
    fn branch_sync_calls_somebody_elses_push_not_rewritten() {
        let (local, remote) = repo_on_feature();
        commit_file(&local, "work.txt", "work");
        git(&local, &["push", "-q", "-u", "origin", "feat"]);
        commit_file(&local, "mine.txt", "mine");

        // A second clone, so the commit that lands on the upstream is one this
        // repo's reflog has never seen.
        let other = empty_tmp();
        git(&other, &["clone", "-q", "--branch", "feat", &remote.to_string_lossy(), "."]);
        commit_file(&other, "theirs.txt", "theirs");
        git(&other, &["push", "-q", "origin", "feat"]);
        git(&local, &["fetch", "-q", "origin"]);

        let sync = sync_of(&local);
        assert_eq!((sync.upstream.ahead, sync.upstream.behind), (1, 1));
        assert!(!sync.upstream.rewritten, "we have never stood where the upstream now points");
        scrub(&[&local, &remote, &other]);
    }

    #[test]
    fn branch_sync_reports_a_base_that_moved_without_touching_our_files() {
        let (local, remote) = repo_on_feature();
        commit_file(&local, "g.txt", "feature only");
        move_base(&local, "f.txt", "base only");

        let base = sync_of(&local).base.expect("main is the base");
        assert_eq!((base.name.as_str(), base.behind), ("main", 1));
        assert_eq!(base.conflicts, Some(vec![]), "different files, so the merge is clean");
        scrub(&[&local, &remote]);
    }

    #[test]
    fn branch_sync_names_the_files_a_base_move_would_fight_over() {
        let (local, remote) = repo_on_feature();
        commit_file(&local, "f.txt", "our version");
        move_base(&local, "f.txt", "their version");

        let base = sync_of(&local).base.expect("main is the base");
        assert_eq!(base.behind, 1);
        assert_eq!(base.conflicts, Some(vec!["f.txt".to_string()]));
        scrub(&[&local, &remote]);
    }

    #[test]
    fn branch_sync_leaves_the_base_out_while_standing_on_it() {
        let (local, remote) = repo_with_remote();
        git(&local, &["push", "-q", "-u", "origin", "main"]);

        let sync = sync_of(&local);
        assert!(sync.upstream.has_upstream);
        assert_eq!(sync.base, None, "main against main is the upstream's question");
        scrub(&[&local, &remote]);
    }

    #[test]
    fn branch_sync_reads_a_detached_head_as_tracking_nothing() {
        let (local, remote) = repo_on_feature();
        git(&local, &["checkout", "-q", "--detach", "HEAD"]);

        let sync = sync_of(&local);
        assert!(sync.detached);
        assert_eq!(sync.upstream, UpstreamSync::default());
        scrub(&[&local, &remote]);
    }

    #[test]
    fn branch_sync_answers_for_an_unborn_branch_instead_of_failing() {
        let dir = empty_tmp();
        git(&dir, &["init", "-q"]);

        let sync = sync_of(&dir);
        assert!(!sync.detached, "an unborn HEAD still names its branch");
        assert_eq!(sync.head_committed_at, 0);
        assert_eq!(sync.upstream, UpstreamSync::default());
        assert_eq!(sync.base, None);
        scrub(&[&dir]);
    }

    /// A config holding exactly these units, so a sweep can be driven without
    /// a config file, a root, or discovery.
    fn config_of(units: Vec<crate::config::BranchUnit>) -> crate::config::ResolvedConfig {
        crate::config::ResolvedConfig {
            path: String::new(),
            roots: vec![],
            spaces: vec![crate::config::Space {
                name: "work".into(),
                path: String::new(),
                projects: vec![crate::config::Project {
                    name: "p".into(),
                    path: String::new(),
                    branch_units: units,
                    icon: None,
                    icon_file: None,
                    favicon: None,
                }],
                icon: None,
                color: None,
            }],
        }
    }

    fn unit(folder: &Path, kind: crate::config::ProjectKind) -> crate::config::BranchUnit {
        crate::config::BranchUnit {
            label: "u".into(),
            folder_path: folder.to_string_lossy().into_owned(),
            branch: Some("main".into()),
            kind,
            is_current: false,
        }
    }

    /// Runs one sweep with the real floor bypassed, counting the fetches and
    /// returning the events. Every sweep test needs the same three lines.
    fn sweep(
        config: &crate::config::ResolvedConfig,
        only: Option<&str>,
        min_age: std::time::Duration,
    ) -> (usize, Vec<FetchResult>) {
        let mut runs = 0;
        let events = quiet_sweep(config, only, min_age, &mut |_| {
            runs += 1;
            Ok(())
        });
        (runs, events)
    }

    const NO_FLOOR: std::time::Duration = std::time::Duration::ZERO;

    #[test]
    fn a_quiet_sweep_fetches_a_container_once_and_tells_every_worktree_of_it() {
        let (local, remote) = repo_on_feature();
        let second = local.with_extension("wt");
        git(&local, &["worktree", "add", "-q", "-b", "other", &second.to_string_lossy(), "feat"]);

        let config = config_of(vec![
            unit(&local, crate::config::ProjectKind::Worktree),
            unit(&second, crate::config::ProjectKind::Worktree),
        ]);
        let (runs, events) = sweep(&config, None, NO_FLOOR);

        assert_eq!(runs, 1, "two worktrees share one common dir, so one fetch");
        assert_eq!(events.len(), 2, "but each folder is a row that wants telling");
        assert!(events.iter().all(|e| e.ok && e.quiet));
        assert!(events.iter().any(|e| e.repo == local.to_string_lossy()));
        assert!(events.iter().any(|e| e.repo == second.to_string_lossy()));

        git(&local, &["worktree", "remove", "--force", &second.to_string_lossy()]);
        scrub(&[&local, &remote, &second]);
    }

    #[test]
    fn a_plain_repos_branches_share_one_fetch_and_one_event() {
        let (local, remote) = repo_with_remote();
        git(&local, &["push", "-q", "-u", "origin", "main"]);
        // Three attached branches, all reported on the same folder path.
        let config = config_of(vec![
            unit(&local, crate::config::ProjectKind::Plain),
            unit(&local, crate::config::ProjectKind::Plain),
            unit(&local, crate::config::ProjectKind::Plain),
        ]);
        let (runs, events) = sweep(&config, None, NO_FLOOR);

        assert_eq!(runs, 1);
        assert_eq!(events.len(), 1, "one folder is one row, however many branches hang off it");
        scrub(&[&local, &remote]);
    }

    #[test]
    fn a_sweep_passes_over_folders_that_are_not_repos_to_fetch() {
        let plain_dir = empty_tmp();
        let unborn = empty_tmp();
        git(&unborn, &["init", "-q"]);

        let config = config_of(vec![
            unit(&plain_dir, crate::config::ProjectKind::PlainDir),
            // A repo kind, but with no commit: nothing to bring up to date.
            unit(&unborn, crate::config::ProjectKind::Worktree),
        ]);
        let (runs, events) = sweep(&config, None, NO_FLOOR);

        assert_eq!((runs, events.len()), (0, 0));
        scrub(&[&plain_dir, &unborn]);
    }

    #[test]
    fn a_second_sweep_inside_the_floor_fetches_nothing() {
        let (local, remote) = repo_on_feature();
        let config = config_of(vec![unit(&local, crate::config::ProjectKind::Worktree)]);

        assert_eq!(sweep(&config, None, NO_FLOOR).0, 1);
        let (runs, events) = sweep(&config, None, std::time::Duration::from_secs(90));
        assert_eq!((runs, events.len()), (0, 0), "asked seconds ago, so not due");

        scrub(&[&local, &remote]);
    }

    #[test]
    fn a_sweep_steps_around_a_repo_somebody_else_is_writing() {
        let (local, remote) = repo_on_feature();
        let config = config_of(vec![unit(&local, crate::config::ProjectKind::Worktree)]);

        let lock = crate::exec::repo_lock(&local.to_string_lossy());
        let held = lock.lock().unwrap();
        let (runs, events) = sweep(&config, None, NO_FLOOR);
        assert_eq!((runs, events.len()), (0, 0), "a manual op holds this repo");
        drop(held);

        // And it is not skipped for good: the next sweep takes it.
        assert_eq!(sweep(&config, None, NO_FLOOR).0, 1);
        scrub(&[&local, &remote]);
    }

    #[test]
    fn only_narrows_the_sweep_to_one_containers_units() {
        let (one, one_remote) = repo_on_feature();
        let (two, two_remote) = repo_on_feature();
        let config = config_of(vec![
            unit(&one, crate::config::ProjectKind::Worktree),
            unit(&two, crate::config::ProjectKind::Worktree),
        ]);

        let (runs, events) = sweep(&config, Some(&two.to_string_lossy()), NO_FLOOR);
        assert_eq!(runs, 1);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].repo, two.to_string_lossy());

        scrub(&[&one, &one_remote, &two, &two_remote]);
    }

    #[test]
    fn the_quiet_command_can_never_ask_a_human_anything() {
        let cmd = quiet_git_command("/repo");
        let envs: std::collections::HashMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(k, v)| {
                (k.to_string_lossy().into_owned(), v.map(|s| s.to_string_lossy().into_owned()))
            })
            .collect();

        // Cleared, not merely absent: an inherited one would still be used.
        assert_eq!(envs.get("GIT_ASKPASS"), Some(&None));
        assert_eq!(envs.get("SSH_ASKPASS"), Some(&None));
        assert_eq!(envs.get("SSH_ASKPASS_REQUIRE"), Some(&None));
        assert_eq!(envs.get("GIT_TERMINAL_PROMPT").unwrap().as_deref(), Some("0"));
        assert_eq!(envs.get("LC_ALL").unwrap().as_deref(), Some("C"));
        let ssh = envs.get("GIT_SSH_COMMAND").unwrap().as_deref().unwrap();
        assert!(ssh.contains("BatchMode=yes"), "ssh must not sit at a prompt: {ssh}");
        assert!(ssh.contains("StrictHostKeyChecking=accept-new"), "{ssh}");
        // No bridge coordinates at all, which is what `git_command` exists to set.
        assert!(!envs.contains_key(ENV_SOCK));
        assert!(!envs.contains_key(ENV_TOKEN));
    }

    #[test]
    fn conflicts_are_asked_once_per_worktree_not_once_per_call() {
        let (local, remote) = repo_on_feature();
        commit_file(&local, "f.txt", "ours");
        move_base(&local, "f.txt", "theirs");
        // A linked worktree shares `local`'s common dir, so only its HEAD tells
        // the two apart. Its own commit is what gives it one.
        let second = local.with_extension("wt");
        git(&local, &["worktree", "add", "-q", "-b", "other", &second.to_string_lossy(), "feat"]);
        commit_file(&second, "h.txt", "theirs alone");

        let runs = std::cell::Cell::new(0u32);
        let ask = |dir: &Path| {
            conflicts_with(&dir.to_string_lossy(), "origin/main", 1, |_, _| {
                runs.set(runs.get() + 1);
                Some(vec!["f.txt".to_string()])
            })
        };

        assert_eq!(ask(&local), Some(vec!["f.txt".to_string()]), "git 2.38+ and a resolvable base");
        assert_eq!(ask(&second), Some(vec!["f.txt".to_string()]));
        ask(&local);
        ask(&second);
        assert_eq!(runs.get(), 2, "four calls, two distinct HEADs");

        git(&local, &["worktree", "remove", "--force", &second.to_string_lossy()]);
        scrub(&[&local, &remote, &second]);
    }

    #[test]
    fn branch_sync_has_no_upstream_and_no_base_without_an_origin() {
        let dir = repo_with_two_branches();

        let sync = sync_of(&dir);
        assert_eq!(sync.upstream, UpstreamSync::default());
        assert_eq!(sync.base, None);
        scrub(&[&dir]);
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
    fn status_reports_staged_and_unstaged_flags() {
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("f.txt"), "v2").unwrap(); // unstaged edit
        std::fs::write(dir.join("new.txt"), "x").unwrap(); // untracked
        let p = dir.to_string_lossy().into_owned();
        let files = git_status_body(&p).unwrap();

        let f = files.iter().find(|f| f.path == "f.txt").unwrap();
        assert!(!f.staged && f.unstaged);
        let n = files.iter().find(|f| f.path == "new.txt").unwrap();
        assert!(!n.staged && n.unstaged);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn partially_staged_file_reports_both_flags() {
        // Stage an edit, then edit again on top: git's "MM" - staged AND
        // unstaged at once, the case the Staged/Changes sections must both
        // list this file for.
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("f.txt"), "v2").unwrap();
        let p = dir.to_string_lossy().into_owned();
        git_stage_body(p.clone(), vec!["f.txt".into()]).unwrap();
        std::fs::write(dir.join("f.txt"), "v3").unwrap();

        let files = git_status_body(&p).unwrap();
        let f = files.iter().find(|f| f.path == "f.txt").unwrap();
        assert!(f.staged && f.unstaged);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_without_identity_surfaces_stderr() {
        // No local `user.name`/`user.email` configured, and this repo's
        // ambient env carries none either (git() only sets it per-invocation
        // via process env, not persisted to config): the commit fails and
        // git's stderr is surfaced rather than a blank error.
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("new.txt"), "x").unwrap();
        let p = dir.to_string_lossy().into_owned();
        git_stage_body(p.clone(), vec!["new.txt".into()]).unwrap();

        let _ = Command::new("git")
            .arg("-C")
            .arg(&p)
            .args(["config", "--local", "--unset-all", "user.name"])
            .output();
        let _ = Command::new("git")
            .arg("-C")
            .arg(&p)
            .args(["config", "--local", "--unset-all", "user.email"])
            .output();

        if has_git_identity(&p) {
            // Ambient global identity is configured on this machine/CI - the
            // no-identity case can't be exercised without touching global
            // config, so skip rather than assert a false failure.
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        let err = git_commit_body(p, "won't work".into(), None, None).expect_err("commit without identity must fail");
        assert!(!err.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stage_then_unstage_flips_the_split() {
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("new.txt"), "x").unwrap();
        let p = dir.to_string_lossy().into_owned();

        git_stage_body(p.clone(), vec!["new.txt".into()]).unwrap();
        let staged = git_status_body(&p).unwrap();
        let f = staged.iter().find(|f| f.path == "new.txt").unwrap();
        assert!(f.staged && !f.unstaged);

        git_unstage_body(p.clone(), vec!["new.txt".into()]).unwrap();
        let unstaged = git_status_body(&p).unwrap();
        let f = unstaged.iter().find(|f| f.path == "new.txt").unwrap();
        assert!(!f.staged && f.unstaged);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stage_accepts_a_dash_prefixed_filename() {
        // `--` before paths (D4): a filename starting with '-' must not be
        // parsed as a git flag.
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("-weird.txt"), "x").unwrap();
        let p = dir.to_string_lossy().into_owned();

        git_stage_body(p.clone(), vec!["-weird.txt".into()]).unwrap();
        let files = git_status_body(&p).unwrap();
        let f = files.iter().find(|f| f.path == "-weird.txt").unwrap();
        assert!(f.staged);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_requires_a_message_and_clears_the_stage() {
        let dir = repo_with_two_branches();
        git(&dir, &["config", "user.name", "t"]);
        git(&dir, &["config", "user.email", "t@t.test"]);
        std::fs::write(dir.join("new.txt"), "x").unwrap();
        let p = dir.to_string_lossy().into_owned();
        git_stage_body(p.clone(), vec!["new.txt".into()]).unwrap();

        let err = git_commit_body(p.clone(), "   ".into(), None, None).expect_err("empty message must be refused");
        assert!(!err.is_empty());

        git_commit_body(p.clone(), "add new.txt".into(), None, None).unwrap();
        let files = git_status_body(&p).unwrap();
        assert!(files.iter().all(|f| f.path != "new.txt"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn amend_replaces_head_and_keeps_a_multi_paragraph_body() {
        let dir = repo_with_two_branches();
        git(&dir, &["config", "user.name", "t"]);
        git(&dir, &["config", "user.email", "t@t.test"]);
        let p = dir.to_string_lossy().into_owned();
        let count = |d: &Path| {
            let out = Command::new("git")
                .arg("-C")
                .arg(d)
                .args(["rev-list", "--count", "HEAD"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };

        std::fs::write(dir.join("new.txt"), "x").unwrap();
        git_stage_body(p.clone(), vec!["new.txt".into()]).unwrap();
        git_commit_body(p.clone(), "add new.txt".into(), None, None).unwrap();
        let before = count(&dir);

        // A subject, a blank line, and a body that itself contains a blank line:
        // the shape `composeCommitMessage` produces and `%B` must give back.
        let msg = "add new.txt\n\nwhy this was needed\n\nand a second paragraph";
        git_commit_body(p.clone(), msg.into(), Some(true), None).unwrap();

        assert_eq!(count(&dir), before, "amend must rewrite HEAD, not add a commit");
        assert_eq!(git_head_message(p).unwrap().trim(), msg);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn head_message_is_empty_on_an_unborn_head() {
        let dir = empty_tmp();
        git(&dir, &["init", "-q"]);
        assert_eq!(git_head_message(dir.to_string_lossy().into_owned()).unwrap(), "");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn checkout_switches_branch_on_clean_tree() {
        let dir = repo_with_two_branches();
        assert_eq!(current_branch(&dir), "main");
        git_checkout_body(dir.to_string_lossy().into_owned(), "feature".into()).unwrap();
        assert_eq!(current_branch(&dir), "feature");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn checkout_surfaces_error_and_does_not_switch() {
        let dir = repo_with_two_branches();
        let err = git_checkout_body(dir.to_string_lossy().into_owned(), "nope".into())
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
        let dir = std::env::temp_dir().join(format!("tori_init_test_{n}_{seq}"));
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
    fn bare_init_makes_worktree_container_in_place() {
        let dir = empty_tmp();
        // A pre-existing file must survive the in-place bootstrap.
        std::fs::write(dir.join("README.txt"), "hi").unwrap();
        do_bare_init(&dir, Some("main")).unwrap();

        // The layout: a `.bare` repo, a `.git` pointer, and a `main` worktree.
        assert!(dir.join(".bare").is_dir());
        assert_eq!(std::fs::read_to_string(dir.join(".git")).unwrap(), "gitdir: ./.bare\n");
        assert!(dir.join("main").is_dir());
        assert_eq!(std::fs::read_to_string(dir.join("README.txt")).unwrap(), "hi");

        // Discovery sees a bare container with exactly one (non-bare) worktree on an
        // unborn `main`, and no remote yet (add origin later).
        let list = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["worktree", "list", "--porcelain"])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&list.stdout);
        assert!(text.contains("bare"));
        assert!(text.contains("branch refs/heads/main"));
        let head = Command::new("git")
            .arg("-C")
            .arg(dir.join("main"))
            .args(["symbolic-ref", "--short", "HEAD"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "main");

        // Re-running is refused (already a git repo).
        assert!(do_bare_init(&dir, None).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bare_init_defaults_branch_when_blank() {
        let dir = empty_tmp();
        do_bare_init(&dir, None).unwrap();
        // Whatever git's default is, the worktree folder is named after it and the
        // pointer + bare repo exist.
        assert!(dir.join(".bare").is_dir());
        let def = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["symbolic-ref", "--short", "HEAD"])
            .output()
            .unwrap();
        let def = String::from_utf8_lossy(&def.stdout).trim().to_string();
        assert!(!def.is_empty());
        assert!(dir.join(&def).is_dir());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_fetch_with_no_git_on_path_names_the_fix() {
        let empty = std::env::temp_dir().join(format!("tori-no-git-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let mut cmd = git_command("/repo", "op-1", Path::new("/tmp/tori-akp-x/s"), "tok");
        cmd.arg("fetch").env("PATH", &empty);
        let ready = || crate::git_health::GitHealth::Ready { path: "/usr/bin/git".into(), version: None };
        let err = crate::git_health::run_with(&mut cmd, ready).unwrap_err();
        std::fs::remove_dir_all(&empty).ok();
        assert_eq!(err, crate::git_health::MISSING);
    }

    #[test]
    fn git_command_sets_askpass_bridge_env() {
        use std::ffi::OsStr;
        let sock = Path::new("/tmp/tori-akp-x/s");
        let cmd = git_command("/repo", "op-1", sock, "tok");
        let envs: std::collections::HashMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|s| s.to_string_lossy().into_owned()),
                )
            })
            .collect();
        // Fail-closed + locale-stable + bridge coordinates all present.
        assert_eq!(envs.get("GIT_TERMINAL_PROMPT").unwrap().as_deref(), Some("0"));
        assert_eq!(envs.get("LC_ALL").unwrap().as_deref(), Some("C"));
        assert_eq!(envs.get("SSH_ASKPASS_REQUIRE").unwrap().as_deref(), Some("force"));
        assert_eq!(envs.get(ENV_SOCK).unwrap().as_deref(), Some("/tmp/tori-akp-x/s"));
        assert_eq!(envs.get(ENV_TOKEN).unwrap().as_deref(), Some("tok"));
        assert_eq!(envs.get(ENV_OP).unwrap().as_deref(), Some("op-1"));
        assert!(envs.contains_key("GIT_ASKPASS"));
        assert!(envs.contains_key("SSH_ASKPASS"));
        assert!(envs
            .get("GIT_SSH_COMMAND")
            .unwrap()
            .as_deref()
            .unwrap()
            .contains("accept-new"));
        // current_exe resolved to something non-empty for GIT_ASKPASS.
        let exe = envs.get("GIT_ASKPASS").unwrap().as_deref().unwrap();
        assert!(!exe.is_empty());
        let _ = OsStr::new(exe);
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

    // ---- hunk-level staging (git_apply_hunks) ----------------------------
    //
    // These drive real `git apply --cached`. The patch offset maths and the
    // apply direction are the two things that corrupt an index silently rather
    // than failing, so they are checked against git itself, not just asserted
    // about in isolation (patch.rs covers the pure rebuild).

    /// A repo whose committed f.txt has 20 numbered lines, with line 2 and
    /// line 19 edited in the worktree: far enough apart to stay two hunks at
    /// -U3, so "stage one of two" is meaningful.
    fn repo_with_two_hunks() -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tori_hunk_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let base: Vec<String> = (1..=20).map(|i| format!("line {i}")).collect();
        std::fs::write(dir.join("f.txt"), base.join("\n") + "\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);

        let mut edited = base.clone();
        edited[1] = "line 2 EDITED".into();
        edited[18] = "line 19 EDITED".into();
        std::fs::write(dir.join("f.txt"), edited.join("\n") + "\n").unwrap();
        dir
    }

    fn status_of(dir: &Path, file: &str) -> String {
        let out = Command::new("git")
            .arg("-C").arg(dir)
            .args(["status", "--porcelain", "--", file])
            .output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    /// The file's content as currently staged in the index.
    fn indexed(dir: &Path, file: &str) -> String {
        let out = Command::new("git")
            .arg("-C").arg(dir)
            .args(["show", &format!(":{file}")])
            .output().unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn hunks_of(p: &str, file: &str, mode: DiffMode) -> crate::patch::FilePatch {
        let text = git_diff_text(p.into(), file.into(), Some(3), Some(mode), None).unwrap();
        crate::patch::parse_patch(&text)
    }

    #[test]
    fn an_indentation_only_change_has_no_hunks_when_whitespace_is_ignored() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let mut lines: Vec<String> = (1..=20).map(|i| format!("line {i}")).collect();
        lines[4] = format!("    {}", lines[4]);
        std::fs::write(dir.join("f.txt"), lines.join("\n") + "\n").unwrap();

        let shown = git_diff_text(p.clone(), "f.txt".into(), Some(3), Some(DiffMode::Unstaged), None).unwrap();
        assert_eq!(crate::patch::parse_patch(&shown).hunks.len(), 1);
        let ignored = git_diff_text(p, "f.txt".into(), Some(3), Some(DiffMode::Unstaged), Some(true)).unwrap();
        assert!(ignored.trim().is_empty(), "{ignored}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stages_one_hunk_of_two_leaving_the_file_partially_staged() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        assert_eq!(parsed.hunks.len(), 2, "expected two separate hunks at -U3");

        // Stage only the second hunk (line 19).
        git_apply_hunks_body(p.clone(), "f.txt".into(), vec![1], vec![parsed.hunks[1].fingerprint.clone()], false, Some(3)).unwrap();

        assert_eq!(status_of(&dir, "f.txt"), "MM f.txt");
        let staged = indexed(&dir, "f.txt");
        assert!(staged.contains("line 19 EDITED"), "the selected hunk should be staged");
        assert!(!staged.contains("line 2 EDITED"), "the unselected hunk must not be staged");
        // The working tree keeps both edits: --cached never touches it.
        let worktree = std::fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(worktree.contains("line 2 EDITED") && worktree.contains("line 19 EDITED"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stages_the_first_hunk_at_the_right_offset() {
        // The first hunk is the one whose *new*-side offset shifts when the
        // second is dropped, so a naive rebuild misplaces it.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks_body(p.clone(), "f.txt".into(), vec![0], vec![parsed.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        let staged = indexed(&dir, "f.txt");
        assert!(staged.contains("line 2 EDITED"));
        assert!(!staged.contains("line 19 EDITED"));
        // Nothing else moved: still 20 lines, line 19 still original.
        assert_eq!(staged.lines().count(), 20);
        assert!(staged.lines().nth(18).unwrap().contains("line 19"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn walks_the_file_from_unstaged_to_fully_staged_one_hunk_at_a_time() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();

        let first = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks_body(p.clone(), "f.txt".into(), vec![0], vec![first.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();
        assert_eq!(status_of(&dir, "f.txt"), "MM f.txt");

        // Re-read: staging renumbered the remaining unstaged hunks.
        let rest = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        assert_eq!(rest.hunks.len(), 1);
        git_apply_hunks_body(p.clone(), "f.txt".into(), vec![0], vec![rest.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        assert_eq!(status_of(&dir, "f.txt"), "M  f.txt", "fully staged, nothing left unstaged");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unstaging_a_hunk_reverses_exactly_that_hunk() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["add", "f.txt"]);
        assert_eq!(status_of(&dir, "f.txt"), "M  f.txt");

        // Now unstage only the line-19 hunk, from the index-vs-HEAD diff.
        let staged_hunks = hunks_of(&p, "f.txt", DiffMode::Staged);
        assert_eq!(staged_hunks.hunks.len(), 2);
        git_apply_hunks_body(p.clone(), "f.txt".into(), vec![1], vec![staged_hunks.hunks[1].fingerprint.clone()], true, Some(3)).unwrap();

        let staged = indexed(&dir, "f.txt");
        assert!(staged.contains("line 2 EDITED"), "the untouched hunk stays staged");
        assert!(!staged.contains("line 19 EDITED"), "the reversed hunk left the index");
        assert_eq!(staged.lines().count(), 20);
        // The worktree still has both edits.
        let worktree = std::fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(worktree.contains("line 19 EDITED"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_two_sections_of_a_partially_staged_file_do_not_cross_contaminate() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let unstaged = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks_body(p.clone(), "f.txt".into(), vec![0], vec![unstaged.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        // "MM": one hunk in each section, and each section sees only its own.
        let staged = hunks_of(&p, "f.txt", DiffMode::Staged);
        let remaining = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        assert_eq!(staged.hunks.len(), 1);
        assert_eq!(remaining.hunks.len(), 1);
        assert!(staged.hunks[0].body.iter().any(|l| l.contains("line 2 EDITED")));
        assert!(remaining.hunks[0].body.iter().any(|l| l.contains("line 19 EDITED")));
        // Different content, so different fingerprints: an index reused across
        // the two sections could never silently match.
        assert_ne!(staged.hunks[0].fingerprint, remaining.hunks[0].fingerprint);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stale_fingerprint_refuses_and_stages_nothing() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let err = git_apply_hunks_body(
            p.clone(), "f.txt".into(), vec![1], vec!["deadbeef".into()], false, Some(3),
        ).unwrap_err();
        assert!(err.contains("diff changed"), "got: {err}");
        assert_eq!(status_of(&dir, "f.txt"), " M f.txt", "nothing may be staged");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_out_of_range_index_refuses_rather_than_panicking() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let err = git_apply_hunks_body(
            p.clone(), "f.txt".into(), vec![9], vec!["deadbeef".into()], false, Some(3),
        ).unwrap_err();
        assert!(err.contains("diff changed"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_malformed_selection_refuses() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        // Indices and fingerprints must correspond one-to-one.
        assert!(git_apply_hunks_body(p, "f.txt".into(), vec![0, 1], vec!["x".into()], false, Some(3)).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stages_one_hunk_of_an_untracked_file_via_intent_to_add() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let lines: Vec<String> = (1..=20).map(|i| format!("new {i}")).collect();
        std::fs::write(dir.join("n.txt"), lines.join("\n") + "\n").unwrap();
        assert_eq!(status_of(&dir, "n.txt"), "?? n.txt");

        // An untracked file is one all-additions hunk; staging it is the whole
        // file, but it must go through intent-to-add rather than failing.
        let parsed = hunks_of(&p, "n.txt", DiffMode::Unstaged);
        assert_eq!(parsed.hunks.len(), 1);
        git_apply_hunks_body(p.clone(), "n.txt".into(), vec![0], vec![parsed.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        assert!(indexed(&dir, "n.txt").contains("new 20"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// One file, one hunk, three consecutive lines rewritten, so a line
    /// selection inside it can leave changes on either side of what it takes.
    fn repo_with_one_dense_hunk() -> PathBuf {
        let dir = repo_with_two_hunks();
        let mut lines: Vec<String> = (1..=20).map(|i| format!("line {i}")).collect();
        std::fs::write(dir.join("d.txt"), lines.join("\n") + "\n").unwrap();
        git(&dir, &["add", "d.txt"]);
        git(&dir, &["commit", "-q", "-m", "dense"]);
        for i in [8, 9, 10] {
            lines[i] = format!("line {} EDITED", i + 1);
        }
        std::fs::write(dir.join("d.txt"), lines.join("\n") + "\n").unwrap();
        dir
    }

    #[test]
    fn stages_two_lines_of_a_hunk_and_leaves_the_rest_unstaged() {
        let dir = repo_with_one_dense_hunk();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "d.txt", DiffMode::Unstaged);
        assert_eq!(parsed.hunks.len(), 1, "the three edits are one hunk at -U3");
        let body = &parsed.hunks[0].body;
        // Take the removal and addition of line 9 only.
        let del = body.iter().position(|l| l == "-line 9").unwrap();
        let add = body.iter().position(|l| l == "+line 9 EDITED").unwrap();

        git_apply_lines_body(
            p.clone(), "d.txt".into(), 0, parsed.hunks[0].fingerprint.clone(),
            vec![del, add], false, Some(3),
        ).unwrap();

        assert_eq!(status_of(&dir, "d.txt"), "MM d.txt");
        let staged = indexed(&dir, "d.txt");
        assert!(staged.contains("line 9 EDITED"), "the selected line should be staged");
        assert!(!staged.contains("line 10 EDITED"), "its neighbours must not be");
        assert!(!staged.contains("line 11 EDITED"));
        assert_eq!(staged.lines().count(), 20, "no line was added or lost");
        // The documented ordering: the two removals left as context sit ahead
        // of the addition, because git's diff puts the whole removal run first.
        assert_eq!(staged.lines().nth(8).unwrap(), "line 10");
        assert_eq!(staged.lines().nth(9).unwrap(), "line 11");
        assert_eq!(staged.lines().nth(10).unwrap(), "line 9 EDITED");
        // --cached: the worktree still has all three edits.
        let worktree = std::fs::read_to_string(dir.join("d.txt")).unwrap();
        assert!(worktree.contains("line 10 EDITED") && worktree.contains("line 11 EDITED"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stages_a_selection_that_skips_a_change_in_its_middle() {
        // The split case: the rebuilt patch's two selected runs are held
        // together by the change between them, demoted to context. If that were
        // dropped instead, or the hunk split in two, git would reject the patch
        // or apply it at the wrong offset.
        let dir = repo_with_one_dense_hunk();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "d.txt", DiffMode::Unstaged);
        let body = &parsed.hunks[0].body;
        let pick: Vec<usize> = ["-line 9", "+line 9 EDITED", "-line 11", "+line 11 EDITED"]
            .iter()
            .map(|want| body.iter().position(|l| l == want).unwrap())
            .collect();

        git_apply_lines_body(
            p.clone(), "d.txt".into(), 0, parsed.hunks[0].fingerprint.clone(),
            pick, false, Some(3),
        ).unwrap();

        let staged = indexed(&dir, "d.txt");
        assert!(staged.contains("line 9 EDITED") && staged.contains("line 11 EDITED"));
        assert!(!staged.contains("line 10 EDITED"), "the skipped change stays unstaged");
        assert_eq!(staged.lines().count(), 20);
        // The change it skipped is still the original line, carried through as
        // the context that holds the two selected runs together.
        assert_eq!(staged.lines().nth(8).unwrap(), "line 10");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn staging_an_addition_without_its_removal_leaves_both_lines_in_the_index() {
        let dir = repo_with_one_dense_hunk();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "d.txt", DiffMode::Unstaged);
        let add = parsed.hunks[0].body.iter().position(|l| l == "+line 9 EDITED").unwrap();

        git_apply_lines_body(
            p.clone(), "d.txt".into(), 0, parsed.hunks[0].fingerprint.clone(),
            vec![add], false, Some(3),
        ).unwrap();

        let staged = indexed(&dir, "d.txt");
        assert_eq!(staged.lines().count(), 21, "the old line was kept and the new one added");
        assert_eq!(staged.lines().nth(8).unwrap(), "line 9");
        assert_eq!(staged.lines().nth(11).unwrap(), "line 9 EDITED");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unstages_one_line_of_a_staged_hunk() {
        let dir = repo_with_one_dense_hunk();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["add", "d.txt"]);
        let staged_hunks = hunks_of(&p, "d.txt", DiffMode::Staged);
        let body = &staged_hunks.hunks[0].body;
        let del = body.iter().position(|l| l == "-line 10").unwrap();
        let add = body.iter().position(|l| l == "+line 10 EDITED").unwrap();

        git_apply_lines_body(
            p.clone(), "d.txt".into(), 0, staged_hunks.hunks[0].fingerprint.clone(),
            vec![del, add], true, Some(3),
        ).unwrap();

        let staged = indexed(&dir, "d.txt");
        assert!(!staged.contains("line 10 EDITED"), "the reversed line left the index");
        assert!(staged.contains("line 9 EDITED") && staged.contains("line 11 EDITED"));
        assert_eq!(staged.lines().count(), 20);
        // The worktree keeps every edit either way.
        assert!(std::fs::read_to_string(dir.join("d.txt")).unwrap().contains("line 10 EDITED"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stale_fingerprint_refuses_a_line_apply_and_stages_nothing() {
        let dir = repo_with_one_dense_hunk();
        let p = dir.to_string_lossy().into_owned();
        let err = git_apply_lines_body(
            p.clone(), "d.txt".into(), 0, "deadbeef".into(), vec![1], false, Some(3),
        ).unwrap_err();
        assert!(err.contains("diff changed"), "got: {err}");
        assert_eq!(status_of(&dir, "d.txt"), " M d.txt", "nothing may be staged");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_line_selection_refuses() {
        let dir = repo_with_one_dense_hunk();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "d.txt", DiffMode::Unstaged);
        assert!(git_apply_lines_body(
            p, "d.txt".into(), 0, parsed.hunks[0].fingerprint.clone(), vec![], false, Some(3),
        ).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unstaging_part_of_a_newly_added_file_refuses_without_touching_the_index() {
        // A file not in HEAD has no old contents for a partial reverse to land
        // on, and git says so rather than half-applying. Reachable from the UI
        // (a new file's Staged row expands like any other), so what matters is
        // that it fails loudly and leaves the index alone.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("n.txt"), "a\nb\nc\n").unwrap();
        git(&dir, &["add", "n.txt"]);
        let staged = hunks_of(&p, "n.txt", DiffMode::Staged);

        let err = git_apply_lines_body(
            p.clone(), "n.txt".into(), 0, staged.hunks[0].fingerprint.clone(),
            vec![0], true, Some(3),
        ).unwrap_err();
        assert!(err.contains("depends on old contents"), "got: {err}");
        assert_eq!(indexed(&dir, "n.txt"), "a\nb\nc\n", "the index must be untouched");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn staging_lines_of_an_untracked_file_goes_through_intent_to_add() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("n.txt"), "alpha\nbeta\ngamma\n").unwrap();
        let parsed = hunks_of(&p, "n.txt", DiffMode::Unstaged);

        // Only the first of the three added lines.
        git_apply_lines_body(
            p.clone(), "n.txt".into(), 0, parsed.hunks[0].fingerprint.clone(),
            vec![0], false, Some(3),
        ).unwrap();

        let staged = indexed(&dir, "n.txt");
        assert_eq!(staged, "alpha\n", "one line staged, the rest still untracked work");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_untracked_fallback_and_intent_to_add_agree_on_the_fingerprint() {
        // The panel renders an untracked file from the --no-index fallback, but
        // staging re-diffs it after `git add -N`. The preambles differ; the
        // hunk header and body must not, or every untracked stage would be
        // refused as stale.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("n.txt"), "alpha\nbeta\n").unwrap();

        let displayed = hunks_of(&p, "n.txt", DiffMode::Unstaged);
        git(&dir, &["add", "-N", "--", "n.txt"]);
        let after_add_n = hunks_of(&p, "n.txt", DiffMode::Unstaged);
        assert_eq!(displayed.hunks[0].fingerprint, after_add_n.hunks[0].fingerprint);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn diff_modes_describe_different_trees_for_a_partially_staged_file() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks_body(p.clone(), "f.txt".into(), vec![0], vec![parsed.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        let head = git_diff_text(p.clone(), "f.txt".into(), Some(3), Some(DiffMode::Head), None).unwrap();
        let staged = git_diff_text(p.clone(), "f.txt".into(), Some(3), Some(DiffMode::Staged), None).unwrap();
        let unstaged = git_diff_text(p.clone(), "f.txt".into(), Some(3), Some(DiffMode::Unstaged), None).unwrap();

        // vs HEAD sees both edits; each of the other two sees exactly one.
        assert!(head.contains("line 2 EDITED") && head.contains("line 19 EDITED"));
        assert!(staged.contains("line 2 EDITED") && !staged.contains("line 19 EDITED"));
        assert!(unstaged.contains("line 19 EDITED") && !unstaged.contains("line 2 EDITED"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn omitting_the_mode_keeps_the_vs_head_behaviour_existing_callers_rely_on() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["add", "f.txt"]);
        // Staged, so worktree-vs-index is empty but vs-HEAD is not. The gutter
        // and the session diff both depend on still seeing the change here.
        let default = git_diff_text(p.clone(), "f.txt".into(), None, None, None).unwrap();
        assert!(default.contains("line 2 EDITED"), "default mode must stay vs HEAD");
        assert!(!git_diff_file_body(p, "f.txt".into(), None).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_slice_returns_the_requested_1_based_inclusive_range() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let lines = git_file_slice(p, "f.txt".into(), Some(DiffMode::Unstaged), 5, 7).unwrap();
        assert_eq!(lines, vec!["line 5", "line 6", "line 7"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_slice_reads_the_index_in_staged_mode_not_the_worktree() {
        // The distinction that matters for a partially-staged file: the Staged
        // section's unchanged lines are the index's, and showing the worktree's
        // there would display lines the user has not staged.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks_body(p.clone(), "f.txt".into(), vec![0], vec![parsed.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        // Line 19 is edited in the worktree but not in the index.
        let staged = git_file_slice(p.clone(), "f.txt".into(), Some(DiffMode::Staged), 19, 19).unwrap();
        let worktree = git_file_slice(p, "f.txt".into(), Some(DiffMode::Unstaged), 19, 19).unwrap();
        assert_eq!(staged, vec!["line 19"]);
        assert_eq!(worktree, vec!["line 19 EDITED"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_blob_slice_reads_the_commit_not_whatever_is_on_disk() {
        // The whole reason this exists beside `git_file_slice`. A PR's head is
        // usually not checked out, so reading the file from disk would give the
        // right line numbers over the wrong content, which looks exactly like an
        // answer.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let head = String::from_utf8_lossy(
            &Command::new("git").arg("-C").arg(&dir).args(["rev-parse", "HEAD"]).output().unwrap().stdout,
        )
        .trim()
        .to_string();

        // Line 2 is edited in the worktree and untouched in the commit.
        let committed = git_blob_slice(p.clone(), head, "f.txt".into(), 2, 2).unwrap();
        let on_disk = git_file_slice(p, "f.txt".into(), Some(DiffMode::Unstaged), 2, 2).unwrap();
        assert_eq!(committed, vec!["line 2"]);
        assert_eq!(on_disk, vec!["line 2 EDITED"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_pr_head_already_in_the_object_store_is_never_fetched() {
        // This repo has no `origin` at all, so a build that fetched
        // unconditionally fails here rather than quietly spending a round trip
        // per expanded gap on a branch that is checked out right now.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let sock = Path::new("/tmp/tori-akp-x/s");
        let head = String::from_utf8_lossy(
            &Command::new("git").arg("-C").arg(&dir).args(["rev-parse", "HEAD"]).output().unwrap().stdout,
        )
        .trim()
        .to_string();

        fetch_pr_head(&p, "refs/pull/7/head", &head, sock, "tok")
            .expect("a local commit needs no remote");

        // And a sha this repo has never seen does go to the network, which with
        // no remote configured is where it fails. `GIT_TERMINAL_PROMPT=0` from
        // `git_command` is what makes that a failure rather than a hang.
        assert!(
            fetch_pr_head(
                &p,
                "refs/pull/7/head",
                "0123456789abcdef0123456789abcdef01234567",
                sock,
                "tok",
            )
            .is_err(),
            "an absent commit must be fetched",
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fetching_a_pr_head_goes_through_the_bridge_and_leaves_no_ref_behind() {
        let (cmd, _bridge) =
            pr_head_fetch_command("/repo", "refs/pull/7/head", Path::new("/tmp/tori-akp-x/s"), "tok");

        // Everything that talks to a remote goes through the bridge, or a
        // private repo with no agent leaves git nothing to ask and no terminal
        // to ask on: at best a confusing error, at worst ssh blocking the
        // command thread behind a spinner that never stops
        // (`concept_askpass_bridge`).
        let envs: std::collections::HashMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|s| s.to_string_lossy().into_owned())))
            .collect();
        assert_eq!(envs.get("GIT_TERMINAL_PROMPT").unwrap().as_deref(), Some("0"));
        assert_eq!(envs.get(ENV_SOCK).unwrap().as_deref(), Some("/tmp/tori-akp-x/s"));
        assert!(envs.contains_key("GIT_ASKPASS"));

        // And no destination ref. One would keep the commit reachable and
        // nothing would ever remove it, so a reviewer would collect a pinned
        // tree per pull request read, permanently, in their own repo.
        let args: Vec<String> =
            cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.contains(&"refs/pull/7/head".to_string()), "got {args:?}");
        assert!(
            !args.iter().any(|a| a.contains("refs/pull/7/head:")),
            "a destination refspec pins the commit forever: {args:?}",
        );
    }

    #[test]
    fn file_slice_clamps_a_range_past_the_end_of_the_file() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let lines = git_file_slice(p, "f.txt".into(), Some(DiffMode::Unstaged), 18, 900).unwrap();
        assert_eq!(lines.len(), 3, "20-line file, so 18..20");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_slice_rejects_a_degenerate_range_rather_than_panicking() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        assert!(git_file_slice(p.clone(), "f.txt".into(), None, 0, 5).unwrap().is_empty());
        assert!(git_file_slice(p, "f.txt".into(), None, 9, 3).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A repo whose committed g.txt has 60 lines, with lines 10, 30 and 50
    /// edited: three hunks at default context, far enough apart that skipping
    /// the middle one exercises the offset accumulation.
    fn repo_with_three_hunks() -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tori_hunk3_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let base: Vec<String> = (1..=60).map(|i| format!("line {i}")).collect();
        std::fs::write(dir.join("g.txt"), base.join("\n") + "\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);

        let mut edited = base.clone();
        for i in [9usize, 29, 49] {
            edited[i] = format!("line {} EDITED", i + 1);
        }
        std::fs::write(dir.join("g.txt"), edited.join("\n") + "\n").unwrap();
        dir
    }

    #[test]
    fn stages_two_hunks_skipping_the_one_between_them() {
        // The case the offset accumulation exists for: hunk 1 is dropped, so
        // hunk 2's new-side start must shift by hunk 0's drift alone. Get this
        // wrong and git applies the right lines in the wrong place.
        let dir = repo_with_three_hunks();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "g.txt", DiffMode::Unstaged);
        assert_eq!(parsed.hunks.len(), 3);

        git_apply_hunks_body(
            p.clone(), "g.txt".into(), vec![0, 2],
            vec![parsed.hunks[0].fingerprint.clone(), parsed.hunks[2].fingerprint.clone()],
            false, Some(3),
        ).unwrap();

        let staged = indexed(&dir, "g.txt");
        assert_eq!(staged.lines().count(), 60, "no lines gained or lost");
        assert_eq!(staged.lines().nth(9).unwrap(), "line 10 EDITED");
        assert_eq!(staged.lines().nth(29).unwrap(), "line 30", "the skipped hunk stays unstaged");
        assert_eq!(staged.lines().nth(49).unwrap(), "line 50 EDITED");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unstages_two_hunks_skipping_the_one_between_them() {
        // Same, in reverse: the new side is the source here, so the *old* side
        // is what accumulates drift.
        let dir = repo_with_three_hunks();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["add", "g.txt"]);

        let parsed = hunks_of(&p, "g.txt", DiffMode::Staged);
        assert_eq!(parsed.hunks.len(), 3);
        git_apply_hunks_body(
            p.clone(), "g.txt".into(), vec![0, 2],
            vec![parsed.hunks[0].fingerprint.clone(), parsed.hunks[2].fingerprint.clone()],
            true, Some(3),
        ).unwrap();

        let staged = indexed(&dir, "g.txt");
        assert_eq!(staged.lines().count(), 60);
        assert_eq!(staged.lines().nth(9).unwrap(), "line 10", "reversed out of the index");
        assert_eq!(staged.lines().nth(29).unwrap(), "line 30 EDITED", "the skipped hunk stays staged");
        assert_eq!(staged.lines().nth(49).unwrap(), "line 50");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn staging_hunks_that_change_the_line_count_keeps_later_hunks_aligned() {
        // Insertions and deletions of different sizes, so the running delta is
        // non-zero and unequal between hunks.
        let dir = repo_with_three_hunks();
        let p = dir.to_string_lossy().into_owned();
        let mut lines: Vec<String> = (1..=60).map(|i| format!("line {i}")).collect();
        // Hunk A: insert two lines after line 10. Hunk B (later): delete line 50.
        lines.remove(49);
        lines.splice(10..10, ["inserted a".to_string(), "inserted b".to_string()]);
        std::fs::write(dir.join("g.txt"), lines.join("\n") + "\n").unwrap();

        let parsed = hunks_of(&p, "g.txt", DiffMode::Unstaged);
        let all: Vec<usize> = (0..parsed.hunks.len()).collect();
        let fps: Vec<String> = parsed.hunks.iter().map(|h| h.fingerprint.clone()).collect();
        git_apply_hunks_body(p.clone(), "g.txt".into(), all, fps, false, Some(3)).unwrap();

        // Staging every hunk must reproduce the worktree exactly.
        assert_eq!(indexed(&dir, "g.txt"), std::fs::read_to_string(dir.join("g.txt")).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- discard (git_discard_hunks / git_discard_files) ------------------
    //
    // The one apply path that is not `--cached`, so unlike staging a mistake
    // here destroys work rather than shuffling the index. Every test asserts
    // both halves: that the intended change went away, and that nothing else
    // did - especially the index, which a stray `--cached` would eat.

    fn worktree(dir: &Path, file: &str) -> String {
        std::fs::read_to_string(dir.join(file)).unwrap()
    }

    #[test]
    fn discards_one_hunk_and_leaves_the_other_and_the_index_alone() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        assert_eq!(parsed.hunks.len(), 2);

        let out = git_discard_hunks_body(
            p.clone(),
            "f.txt".into(),
            vec![1],
            vec![parsed.hunks[1].fingerprint.clone()],
            Some(3),
        )
        .unwrap();

        let after = worktree(&dir, "f.txt");
        assert!(after.contains("line 2 EDITED"), "the untouched hunk survives");
        assert!(!after.contains("line 19 EDITED"), "the discarded hunk is gone");
        // The whole point of dropping --cached: this writes the file, not the
        // index, so a partially-staged file's staging must be exactly as it was.
        assert_eq!(status_of(&dir, "f.txt"), " M f.txt");
        assert_eq!(out.changed.restored, ["f.txt"]);
        assert!(out.changed.deleted.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_discard_is_recoverable_from_the_backstop_it_took() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let before = worktree(&dir, "f.txt");
        let parsed = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        let all: Vec<usize> = (0..parsed.hunks.len()).collect();
        let fps: Vec<String> = parsed.hunks.iter().map(|h| h.fingerprint.clone()).collect();

        let out = git_discard_hunks_body(p.clone(), "f.txt".into(), all, fps, Some(3)).unwrap();
        assert_ne!(worktree(&dir, "f.txt"), before, "the discard really happened");

        crate::backstop::backstop_restore_tree_body(p, out.backstop_ts).unwrap();
        assert_eq!(worktree(&dir, "f.txt"), before, "byte-identical to before the discard");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stale_fingerprint_refuses_and_discards_nothing() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let before = worktree(&dir, "f.txt");

        let err = git_discard_hunks_body(
            p.clone(),
            "f.txt".into(),
            vec![0],
            vec!["deadbeef".into()],
            Some(3),
        )
        .unwrap_err();

        assert!(err.contains("Nothing was discarded"), "unhelpful refusal: {err}");
        assert_eq!(worktree(&dir, "f.txt"), before);
        // A refused discard leaves no backstop: an undo list full of changes
        // that never happened buries the entries that matter.
        assert!(crate::backstop::backstop_list(p).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discarding_a_staged_hunk_says_to_unstage_it_first() {
        // A partially-staged (MM) file: hunk 0 staged, hunk 1 still loose.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let unstaged = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks_body(
            p.clone(),
            "f.txt".into(),
            vec![0],
            vec![unstaged.hunks[0].fingerprint.clone()],
            false,
            Some(3),
        )
        .unwrap();
        assert_eq!(status_of(&dir, "f.txt"), "MM f.txt");

        // Now aim a discard at the *staged* half. It cannot be reverse-applied
        // from the unstaged diff, and "the diff changed" would be a lie.
        let staged = hunks_of(&p, "f.txt", DiffMode::Staged);
        let err = git_discard_hunks_body(
            p.clone(),
            "f.txt".into(),
            vec![0],
            vec![staged.hunks[0].fingerprint.clone()],
            Some(3),
        )
        .unwrap_err();

        assert!(err.contains("Unstage it first"), "unhelpful refusal: {err}");
        assert_eq!(status_of(&dir, "f.txt"), "MM f.txt", "nothing moved");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_untracked_files_only_hunk_is_the_whole_file() {
        // Not a plan-shaped "three-hunk untracked file": one cannot exist. An
        // untracked file is all additions, so git emits exactly one hunk for it
        // at any context width, and discarding that hunk is deleting the file.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let body: Vec<String> = (1..=40).map(|i| format!("new {i}")).collect();
        std::fs::write(dir.join("fresh.txt"), body.join("\n") + "\n").unwrap();

        let parsed = hunks_of(&p, "fresh.txt", DiffMode::Unstaged);
        assert_eq!(parsed.hunks.len(), 1, "an untracked file is one hunk, always");

        let out = git_discard_hunks_body(
            p.clone(),
            "fresh.txt".into(),
            vec![0],
            vec![parsed.hunks[0].fingerprint.clone()],
            Some(3),
        )
        .unwrap();

        assert!(!dir.join("fresh.txt").exists());
        assert_eq!(out.changed.deleted, ["fresh.txt"]);
        // And it is still recoverable, which is what makes deleting acceptable.
        crate::backstop::backstop_restore_tree_body(p, out.backstop_ts).unwrap();
        assert_eq!(worktree(&dir, "fresh.txt"), body.join("\n") + "\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_discard_restores_a_tracked_file_and_deletes_an_untracked_one() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("fresh.txt"), "brand new\n").unwrap();

        let out = git_discard_files_body(p.clone(), vec!["f.txt".into(), "fresh.txt".into()]).unwrap();

        assert_eq!(status_of(&dir, "f.txt"), "", "tracked file is back to the index");
        assert!(!dir.join("fresh.txt").exists(), "untracked file is gone");
        assert_eq!(out.changed.restored, ["f.txt"]);
        assert_eq!(out.changed.deleted, ["fresh.txt"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stale_fingerprint_refuses_to_delete_an_untracked_file() {
        // The untracked branch deletes rather than reverse-applying, so it never
        // uses the patch it builds. It must still build it: without the check, a
        // file rewritten between render and click is deleted with contents the
        // user never saw, which is worse than the partial apply the check exists
        // to prevent.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("fresh.txt"), "brand new\n").unwrap();

        let err = git_discard_hunks_body(
            p.clone(),
            "fresh.txt".into(),
            vec![0],
            vec!["deadbeef".into()],
            Some(3),
        )
        .unwrap_err();

        assert!(err.contains("Nothing was discarded"), "unhelpful refusal: {err}");
        assert!(dir.join("fresh.txt").exists(), "the file is still there");
        assert!(crate::backstop::backstop_list(p).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_path_that_escapes_the_worktree_is_refused() {
        // Every other path here is handed to git after `--`, which confines it
        // to the repo. Discard deletes through the filesystem directly, where
        // `..` simply escapes, so the confinement has to be re-established.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let outside = dir.parent().unwrap().join("tori_escape_probe.txt");
        std::fs::write(&outside, "not yours\n").unwrap();

        let err = git_discard_files_body(p, vec!["../tori_escape_probe.txt".into()]).unwrap_err();

        assert!(err.contains("outside this folder"), "unhelpful refusal: {err}");
        assert!(outside.exists(), "the file outside the repo is untouched");
        std::fs::remove_file(&outside).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discard_refuses_a_conflicted_file_rather_than_erroring_from_git() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["checkout", "-q", "--", "f.txt"]);
        git(&dir, &["checkout", "-q", "-b", "side"]);
        std::fs::write(dir.join("f.txt"), "side\n").unwrap();
        git(&dir, &["commit", "-qam", "side"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("f.txt"), "main\n").unwrap();
        git(&dir, &["commit", "-qam", "main"]);
        // Merge deliberately fails, leaving f.txt unmerged in the index.
        Command::new("git").arg("-C").arg(&dir).args(["merge", "side"]).output().unwrap();

        let err = git_discard_files_body(p.clone(), vec!["f.txt".into()]).unwrap_err();
        assert!(err.contains("merge conflicts"), "unhelpful refusal: {err}");
        // And no backstop was written for the refusal.
        assert!(crate::backstop::backstop_list(p).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_discard_handles_several_files_under_one_backstop() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("g.txt"), "committed\n").unwrap();
        git(&dir, &["add", "g.txt"]);
        git(&dir, &["commit", "-qm", "add g"]);
        std::fs::write(dir.join("g.txt"), "edited\n").unwrap();
        std::fs::write(dir.join("fresh.txt"), "brand new\n").unwrap();

        let out = git_discard_files_body(
            p.clone(),
            vec!["f.txt".into(), "g.txt".into(), "fresh.txt".into()],
        )
        .unwrap();

        assert_eq!(out.changed.restored, ["f.txt", "g.txt"]);
        assert_eq!(out.changed.deleted, ["fresh.txt"]);
        assert_eq!(std::fs::read_to_string(dir.join("g.txt")).unwrap(), "committed\n");
        // One snapshot for the batch, and it takes all three back at once.
        assert_eq!(crate::backstop::backstop_list(p.clone()).unwrap().len(), 1);
        crate::backstop::backstop_restore_tree_body(p, out.backstop_ts).unwrap();
        assert_eq!(worktree(&dir, "g.txt"), "edited\n");
        assert_eq!(worktree(&dir, "fresh.txt"), "brand new\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- stash ------------------------------------------------------------

    #[test]
    fn a_stash_message_keeps_its_colons() {
        // `git stash list`'s default line is "stash@{0}: On main: <message>",
        // so a naive split on ":" truncates "fix: the thing" at the first one.
        // Real messages are full of colons, so this is the normal case, not an
        // edge case.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["stash", "push", "-q", "-m", "fix: the thing: with colons"]);

        let list = git_stash_list(p).unwrap();

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message, "fix: the thing: with colons");
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[0].selector, "stash@{0}");
        assert!(!list[0].relative_date.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stash_made_without_a_message_reads_as_gits_own_wip_subject() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["stash", "push", "-q"]);

        let list = git_stash_list(p).unwrap();

        // "WIP on main: <sha> <subject>" - the branch comes off, the rest stays
        // whole rather than being cut at the colon after the sha.
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert!(list[0].message.contains("init"), "got: {}", list[0].message);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unfamiliar_subject_is_shown_whole_rather_than_cut() {
        // Nothing in git guarantees these two prefixes forever, and a subject
        // we cannot parse is better shown intact than truncated at a colon that
        // meant nothing.
        assert_eq!(split_stash_subject("some: other: shape"), (None, "some: other: shape".into()));
        assert_eq!(split_stash_subject("no separator"), (None, "no separator".into()));
        assert_eq!(
            split_stash_subject("On feat/x: a: b"),
            (Some("feat/x".into()), "a: b".into())
        );
    }

    #[test]
    fn untracked_files_stay_put_unless_the_flag_is_on() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("scratch.txt"), "local only\n").unwrap();

        assert!(git_stash_push_body(p.clone(), Some("tracked only".into()), None, None).unwrap());

        // The default sweeps up tracked edits and leaves everything git has
        // never seen exactly where it is.
        assert!(dir.join("scratch.txt").exists(), "untracked file was taken");
        assert_eq!(status_of(&dir, "f.txt"), "");

        // With the flag on, the same file goes.
        assert!(git_stash_push_body(p.clone(), Some("everything".into()), Some(true), None).unwrap());
        assert!(!dir.join("scratch.txt").exists(), "untracked file was left behind");
        assert_eq!(git_stash_list(p).unwrap().len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stashing_a_clean_tree_reports_that_nothing_was_stashed() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["checkout", "-q", "--", "f.txt"]);

        // git prints "No local changes to save" and exits 0, so success alone
        // does not mean an entry exists.
        assert!(!git_stash_push_body(p.clone(), Some("nothing".into()), None, None).unwrap());
        assert!(git_stash_list(p).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn applying_a_stash_names_the_files_it_touched() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        // A modification and a deletion, so both halves of the outcome are real.
        std::fs::write(dir.join("gone.txt"), "doomed\n").unwrap();
        git(&dir, &["add", "gone.txt"]);
        git(&dir, &["commit", "-qm", "add gone"]);
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        git(&dir, &["rm", "-q", "--cached", "gone.txt"]);
        git_stash_push_body(p.clone(), Some("wip".into()), None, None).unwrap();

        let out = git_stash_apply_body(p.clone(), "stash@{0}".into(), Some(true)).unwrap();

        assert_eq!(out.restored, ["f.txt"]);
        assert_eq!(out.deleted, ["gone.txt"]);
        // Popped, so the entry is consumed - which is exactly why the file list
        // has to be read before the apply rather than after.
        assert!(git_stash_list(p).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stashed_rename_reports_both_paths_and_not_a_filename_as_a_status() {
        // Rename detection is on by default, and under -z a rename spends three
        // fields where everything else spends two. Pairing them blindly desyncs
        // and hands `onReverted` a status string where a path belongs - and it
        // acts on those paths. Same shape as the porcelain v2 rename record.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["checkout", "-q", "--", "f.txt"]);
        git(&dir, &["mv", "f.txt", "renamed.txt"]);
        // A second file, so a desync would visibly swallow it.
        std::fs::write(dir.join("other.txt"), "edited\n").unwrap();
        git(&dir, &["add", "other.txt"]);
        git_stash_push_body(p.clone(), Some("a rename".into()), None, None).unwrap();

        let out = git_stash_apply_body(p.clone(), "stash@{0}".into(), Some(true)).unwrap();

        let mut restored = out.restored.clone();
        restored.sort();
        assert_eq!(restored, ["other.txt", "renamed.txt"]);
        assert_eq!(out.deleted, ["f.txt"]);
        // Nothing that is obviously a status code leaked into the path lists.
        for path in out.restored.iter().chain(out.deleted.iter()) {
            assert!(path.contains('.'), "{path:?} looks like a status, not a path");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_conflicting_pop_surfaces_gits_reason_and_keeps_the_stash() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git_stash_push_body(p.clone(), Some("wip".into()), None, None).unwrap();
        // Edit the same file, so the stash cannot be laid back down over it.
        std::fs::write(dir.join("f.txt"), "something else entirely\n").unwrap();

        let err = git_stash_apply_body(p.clone(), "stash@{0}".into(), Some(true)).unwrap_err();

        assert!(err.contains("f.txt"), "the error should name the file: {err}");
        // A failed pop must not consume the entry, or the work is gone.
        assert_eq!(git_stash_list(p).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn drop_removes_one_entry_and_leaves_the_rest() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git_stash_push_body(p.clone(), Some("first".into()), None, None).unwrap();
        std::fs::write(dir.join("f.txt"), "second round\n").unwrap();
        git_stash_push_body(p.clone(), Some("second".into()), None, None).unwrap();

        git_stash_drop_body(p.clone(), "stash@{0}".into()).unwrap();

        let list = git_stash_list(p).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message, "first");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_selector_that_is_not_a_stash_is_refused_before_git_sees_it() {
        // The selector is a bare argument, not a pathspec after `--`, so an
        // option-shaped value would be read as an option.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git_stash_push_body(p.clone(), Some("keep me".into()), None, None).unwrap();

        for bad in ["--all", "stash@{0} --quiet", "refs/heads/main", "stash@{}", ""] {
            assert!(
                git_stash_drop_body(p.clone(), bad.into()).is_err(),
                "accepted {bad:?}"
            );
        }
        assert_eq!(git_stash_list(p).unwrap().len(), 1, "nothing was dropped");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_discard_leaves_the_staged_half_of_a_partially_staged_file() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let unstaged = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks_body(
            p.clone(),
            "f.txt".into(),
            vec![0],
            vec![unstaged.hunks[0].fingerprint.clone()],
            false,
            Some(3),
        )
        .unwrap();

        git_discard_files_body(p, vec!["f.txt".into()]).unwrap();

        // "Discard" lives in the Changes section, so it means the unstaged
        // side. Eating the staged half too would be a different, larger promise
        // than the button makes.
        assert_eq!(status_of(&dir, "f.txt"), "M  f.txt");
        assert!(worktree(&dir, "f.txt").contains("line 2 EDITED"));
        assert!(!worktree(&dir, "f.txt").contains("line 19 EDITED"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- Commit log ---------------------------------------------------------

    /// The exact spelling `git log -z --format=…` emits, captured from a real
    /// repo: eight NUL-terminated fields per commit, the final record
    /// terminated like the rest (so the split leaves a trailing empty field),
    /// and `%D` empty for a commit nothing points at - which is nearly every
    /// commit in a real history, and the case a naive split would misread.
    #[test]
    fn log_parses_a_decorated_commit_and_an_undecorated_one() {
        let out = concat!(
            "3071c3a4410166c58587\0 3071c3a\0Let work be put aside\0",
            "Sk Arif\011 minutes ago\01700000000\0HEAD -> wave-2, origin/wave-2, tag: v1.2\0",
            "b42b4942daffcbee3d28 aaaa1111bbbb2222cccc\0",
            "b42b4942daffcbee3d28\0b42b494\0fix: a subject with a comma, and a colon\0",
            "Sk Arif\054 minutes ago\01700000000\0\0\0",
        );
        let unpushed = ["3071c3a4410166c58587".to_string()].into_iter().collect();
        let off_base = ["3071c3a4410166c58587".to_string(), "b42b4942daffcbee3d28".to_string()]
            .into_iter()
            .collect();
        let log = parse_log(out, &unpushed, &off_base);

        assert_eq!(log.len(), 2, "the trailing terminator must not add a record");
        assert_eq!(log[0].sha, "3071c3a4410166c58587");
        assert_eq!(log[0].short, " 3071c3a");
        assert_eq!(log[0].author, "Sk Arif");
        assert_eq!(log[0].relative_date, "11 minutes ago");
        assert_eq!(log[0].committed_at, 1_700_000_000);
        assert_eq!(log[0].refs, ["HEAD -> wave-2", "origin/wave-2", "tag: v1.2"]);
        // Two parents: `%P` is space-separated, so a merge is the case that
        // proves the field is split rather than taken whole.
        assert_eq!(log[0].parents, ["b42b4942daffcbee3d28", "aaaa1111bbbb2222cccc"]);
        assert!(log[0].unpushed);

        // The one the verify asks for: no decorations at all is an empty list,
        // not a list holding one empty name.
        assert!(log[1].refs.is_empty(), "an undecorated commit has no refs");
        // A root commit has no parents, which is the other empty-field case.
        assert!(log[1].parents.is_empty(), "a root commit has no parents");
        assert!(!log[1].unpushed);
        // Pushed and still the branch's own: the two sets are read apart.
        assert!(log[1].off_base);
        // And the comma in its subject stayed in the subject.
        assert_eq!(log[1].subject, "fix: a subject with a comma, and a colon");
    }

    #[test]
    fn log_reads_a_real_history_newest_first_and_pages_through_it() {
        let dir = repo_with_two_hunks(); // one commit, "init"
        let p = dir.to_string_lossy().into_owned();
        for n in 2..=4 {
            std::fs::write(dir.join(format!("{n}.txt")), "x").unwrap();
            git(&dir, &["add", "."]);
            git(&dir, &["commit", "-q", "-m", &format!("commit {n}")]);
        }
        git(&dir, &["tag", "v1"]);

        let all = git_log(p.clone(), None, None, None, None).unwrap();
        assert_eq!(
            all.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
            ["commit 4", "commit 3", "commit 2", "init"],
        );
        assert_eq!(all[0].author, "t");
        assert!(!all[0].relative_date.is_empty());
        assert!(all[0].sha.starts_with(&all[0].short), "short must abbreviate the full sha");
        // HEAD, the branch and the tag all land on the newest commit; the ones
        // behind it are decorated by nothing.
        assert!(all[0].refs.iter().any(|r| r == "tag: v1"), "refs were {:?}", all[0].refs);
        assert!(all[1].refs.is_empty());

        let page = git_log(p.clone(), Some(1), Some(2), None, None).unwrap();
        assert_eq!(
            page.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
            ["commit 3", "commit 2"],
        );
        // Past the end is an empty page, not an error.
        assert!(git_log(p, Some(99), Some(2), None, None).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn log_of_a_repo_with_no_commits_is_empty_rather_than_an_error() {
        // What a fresh `bare_init` worktree looks like: a real repo on an
        // unborn branch, where `git log` itself exits non-zero.
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tori_log_unborn_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);

        assert_eq!(git_log(dir.to_string_lossy().into_owned(), None, None, None, None).unwrap(), vec![]);
        // A folder that is not a repo at all still reports the real failure.
        assert!(git_log(dir.join("nope").to_string_lossy().into_owned(), None, None, None, None).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_files_parse_a_rename_beside_ordinary_records() {
        // A rename spends three fields where everything else spends two, so a
        // fixed-size chunker desyncs from the first rename onward and every path
        // after it is read out of the wrong slot. Same shape as the Phase 2
        // status parser, and the same reason to pin it.
        let text = "M\0src/a.ts\0R094\0old/name.ts\0new/name.ts\0A\0docs/b.md\0D\0gone.txt\0";
        let files = parse_commit_files(text);

        assert_eq!(
            files,
            vec![
                CommitFile { path: "src/a.ts".into(), old_path: None, status: "M".into() },
                CommitFile {
                    path: "new/name.ts".into(),
                    old_path: Some("old/name.ts".into()),
                    status: "R".into(),
                },
                CommitFile { path: "docs/b.md".into(), old_path: None, status: "A".into() },
                CommitFile { path: "gone.txt".into(), old_path: None, status: "D".into() },
            ],
        );
    }

    /// A repo whose history holds the three shapes a commit view has to survive:
    /// a root commit, a merge, and a rename carrying an edit.
    fn repo_with_awkward_history() -> std::path::PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tori_commit_detail_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@t"]);
        git(&dir, &["config", "user.name", "t"]);

        std::fs::write(dir.join("big.txt"), (1..=20).map(|i| format!("{i}\n")).collect::<String>()).unwrap();
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "root"]);

        git(&dir, &["checkout", "-q", "-b", "side"]);
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "side work"]);

        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("a.txt"), "a\nsecond\n").unwrap();
        git(&dir, &["commit", "-q", "-am", "grow a"]);
        git(&dir, &["merge", "-q", "--no-ff", "side", "-m", "merge side"]);

        git(&dir, &["mv", "big.txt", "moved.txt"]);
        std::fs::write(dir.join("moved.txt"), (1..=21).map(|i| format!("{i}\n")).collect::<String>()).unwrap();
        git(&dir, &["commit", "-q", "-am", "rename with edit\n\nand a body paragraph"]);
        dir
    }

    fn sha_of(dir: &std::path::Path, rev: &str) -> String {
        git_capture(&dir.to_string_lossy(), &["rev-parse", rev]).unwrap()
    }

    #[test]
    fn commit_detail_of_a_merge_diffs_against_the_branch_it_landed_on() {
        // The verify: a merge must not render an empty diff. `git show`'s own
        // default (the combined diff) is empty for a clean merge, which is
        // nearly every merge, so the framing is the whole test.
        let dir = repo_with_awkward_history();
        let p = dir.to_string_lossy().into_owned();
        let merge = sha_of(&dir, "HEAD^");

        let detail = git_commit_detail(p.clone(), merge.clone()).unwrap();
        assert_eq!(detail.subject, "merge side");
        assert_eq!(detail.parents.len(), 2, "a merge names both parents");
        let paths: Vec<&str> = detail.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"b.txt"), "the merge brought b.txt in, files were {paths:?}");

        let patch = git_commit_file_diff(p, merge, "b.txt".into(), None, Some(3)).unwrap();
        assert!(patch.contains("+b"), "the merge's diff was empty: {patch:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_detail_pairs_a_rename_into_one_row_and_diffs_it_as_a_move() {
        let dir = repo_with_awkward_history();
        let p = dir.to_string_lossy().into_owned();
        let head = sha_of(&dir, "HEAD");

        let detail = git_commit_detail(p.clone(), head.clone()).unwrap();
        assert_eq!(detail.subject, "rename with edit");
        assert_eq!(detail.body, "and a body paragraph");
        assert_eq!(detail.parents.len(), 1);
        assert_eq!(
            detail.files,
            vec![CommitFile {
                path: "moved.txt".into(),
                old_path: Some("big.txt".into()),
                status: "R".into(),
            }],
            "a move is one row, not a delete standing beside an addition",
        );

        // Both paths go to git, which is what makes it read as a move; the new
        // path alone comes back as an addition of all 21 lines.
        let moved = git_commit_file_diff(p.clone(), head.clone(), "moved.txt".into(), Some("big.txt".into()), Some(3))
            .unwrap();
        assert!(moved.contains("rename from big.txt"), "{moved}");
        assert!(moved.contains("+21"), "the edit inside the rename is missing: {moved}");

        let alone = git_commit_file_diff(p, head, "moved.txt".into(), None, Some(3)).unwrap();
        assert!(alone.contains("new file mode"), "{alone}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_detail_of_the_root_commit_shows_its_files_as_additions() {
        // Without `--root` the first commit diffs against nothing at all, and a
        // repo's oldest commit is exactly the one a reader scrolls back to.
        let dir = repo_with_awkward_history();
        let p = dir.to_string_lossy().into_owned();
        let root = git_capture(&p, &["rev-list", "--max-parents=0", "HEAD"]).unwrap();

        let detail = git_commit_detail(p.clone(), root.clone()).unwrap();
        assert!(detail.parents.is_empty());
        let mut statuses: Vec<&str> = detail.files.iter().map(|f| f.status.as_str()).collect();
        statuses.dedup();
        assert_eq!(statuses, ["A"], "files were {:?}", detail.files);

        let patch = git_commit_file_diff(p, root, "a.txt".into(), None, Some(3)).unwrap();
        assert!(patch.contains("+a"), "the root commit's diff was empty: {patch:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_log_follows_the_file_across_a_rename() {
        // The verify: a renamed file shows the commits from before the rename.
        // Nothing in git links the two paths; `--follow` re-detects the rename
        // at each step, which is why the flag and not a path lookup.
        let dir = repo_with_awkward_history();
        let p = dir.to_string_lossy().into_owned();

        let followed = git_log(p.clone(), None, None, Some("moved.txt".into()), None).unwrap();
        let subjects: Vec<&str> = followed.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["rename with edit", "root"]);

        // Without it, the file's life starts at the commit that named it.
        let plain = git_log(p, None, None, Some("a.txt".into()), None).unwrap();
        assert_eq!(
            plain.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
            ["grow a", "root"],
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_commit_id_that_is_really_an_option_is_refused_before_git_sees_it() {
        let dir = repo_with_awkward_history();
        let p = dir.to_string_lossy().into_owned();

        for bad in ["--output=/tmp/pwned", "HEAD", "", "abc"] {
            assert!(
                git_commit_detail(p.clone(), bad.into()).is_err(),
                "{bad:?} reached git",
            );
            assert!(git_commit_file_diff(p.clone(), bad.into(), "a.txt".into(), None, None).is_err());
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
