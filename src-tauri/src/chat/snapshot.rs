//! Before-state capture, riding the approval hook.
//!
//! `PreToolUse` fires before every `Edit`, `Write` and `MultiEdit` with the
//! target path in `tool_input`, so the bridge that is already blocking the call
//! can capture the file's exact prior content on the way past. One mechanism,
//! two jobs - and it makes tool-call diffs *exact* rather than reconstructed
//! from whatever the working tree happened to look like when a card was opened.
//! That distinction matters most in the case this whole feature exists for:
//! several chats sharing one working tree, where "what the file looks like now"
//! is not evidence of what *this* session changed.
//!
//! **Only the sha is cached, never the bytes.** The content goes into the repo's
//! own object store via `git hash-object -w`, which is content-addressed, shared
//! with git, and already garbage-collected. A session that rewrites a 3MB file
//! forty times grows this cache by forty shas - kilobytes - instead of 120MB.
//! Reading a card back is a `git cat-file` away.
//!
//! Three outcomes, all first-class:
//!
//!   * **A blob sha** - the file existed and its content is now addressable.
//!   * **Absent** - the write creates a new file. Recorded explicitly, because
//!     "no before-state" and "we failed to capture one" must render differently:
//!     the first is a creation diff, the second is an apology.
//!   * **Unavailable** - a folder with no object store to write into. The card
//!     degrades to "open the file" rather than failing the turn.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

/// How many tool calls' before-states one session keeps.
///
/// Generous, because each entry is a sha and a path rather than content, and a
/// long session's early cards are exactly the ones a user scrolls back to.
pub const CACHE_CAP: usize = 500;

/// What was captured for one file before a tool wrote to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BeforeState {
    /// The file existed; its prior content is this blob in the object store.
    Blob { sha: String },
    /// The file did not exist. A creation, not a failure.
    Absent,
    /// No object store to write into (a non-repo folder), or the capture failed.
    /// The card degrades to "diff unavailable, open the file".
    Unavailable,
}

/// One captured file, keyed to the tool call that was about to write it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Captured {
    pub path: String,
    pub before: BeforeState,
}

/// The files a tool call is about to write.
///
/// Only the writing tools. A `Read` has no before-state worth capturing, and
/// capturing one would put the hook's cost on the calls that are most frequent.
pub fn write_targets(tool: &str, input: &Value) -> Vec<String> {
    match tool {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => input
            .get("file_path")
            .and_then(Value::as_str)
            .map(|p| vec![p.to_string()])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Write `path`'s current content into `repo`'s object store and return its sha.
///
/// `git hash-object -w` rather than reading the bytes ourselves: it is the same
/// store git already maintains, so the content is deduplicated against every
/// other copy and swept by the same gc. `--no-filters` keeps the stored bytes
/// byte-identical to what is on disk, so a diff reflects the file rather than
/// what a clean filter would have made of it.
pub fn capture(repo: &Path, path: &str) -> BeforeState {
    if !Path::new(path).exists() {
        return BeforeState::Absent;
    }
    let out = Command::new("git")
        .current_dir(repo)
        .args(["hash-object", "-w", "--no-filters", "--", path])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let sha = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if sha.is_empty() {
                BeforeState::Unavailable
            } else {
                BeforeState::Blob { sha }
            }
        }
        // A non-repo folder has nowhere to put it. Not an error the turn should
        // fail over: the card says the diff is unavailable and offers the file.
        _ => BeforeState::Unavailable,
    }
}

/// Read a captured blob back, for a card the user expanded.
pub fn read_back(repo: &Path, sha: &str) -> Option<String> {
    let out = Command::new("git").current_dir(repo).args(["cat-file", "-p", sha]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The unified-diff context width, which is git's default and deliberately so.
///
/// `-U` decides where hunk boundaries fall, so it is the size of the unit the
/// user acts on, not a display preference: widening it to show more context
/// would merge nearby edits into one un-revertable hunk. Same value the Changes
/// panel renders with, so a hunk here is the same hunk there.
/// See [[lesson_diff_context_is_hunk_granularity]].
pub const DIFF_CONTEXT: u32 = 3;

/// A unified diff between a captured before-state and what is on disk now.
///
/// Built out of the object store rather than out of temp files: the before-state
/// is already a blob there, and `git hash-object` puts the current content
/// beside it, so `git diff <blob> <blob>` produces exactly the hunks git itself
/// would - same parser, same granularity, no temp-file paths leaking into the
/// header.
///
/// `None` when there is nothing to diff against (a non-repo folder, an evicted
/// entry, a capture that failed). The card degrades to offering the file rather
/// than erroring, which is the same contract `read_back` has.
pub fn diff_against_now(repo: &Path, before: &BeforeState, path: &str) -> Option<String> {
    let before_sha = match before {
        BeforeState::Blob { sha } => sha.clone(),
        // A creation diffs against nothing, which is an empty blob rather than a
        // missing one: every line reads as added, which is what a creation is.
        BeforeState::Absent => empty_blob(repo)?,
        BeforeState::Unavailable => return None,
    };
    // A file the tool deleted has no current content. Same empty blob, the other
    // way round, so every line reads as removed.
    let after_sha = if Path::new(path).exists() {
        match capture(repo, path) {
            BeforeState::Blob { sha } => sha,
            _ => return None,
        }
    } else {
        empty_blob(repo)?
    };
    if before_sha == after_sha {
        return Some(String::new());
    }

    let out = Command::new("git")
        .current_dir(repo)
        .args(["diff", "--no-color", &format!("-U{DIFF_CONTEXT}"), &before_sha, &after_sha])
        .output()
        .ok()?;
    // `git diff` between two blobs reports difference through stdout, not
    // through a non-zero status, so an empty stdout really does mean no diff.
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The empty blob, written so it is certainly present in this repo's store.
/// Its sha is a constant, but an object that has never been written cannot be
/// diffed against.
fn empty_blob(repo: &Path) -> Option<String> {
    let mut child = Command::new("git")
        .current_dir(repo)
        .args(["hash-object", "-w", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    drop(child.stdin.take());
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

/// One session's before-states, keyed by `tool_use_id` and bounded.
///
/// Bounded even though entries are tiny, because "tiny times unbounded" is still
/// unbounded and a long-running session has no natural end. Oldest-first, since
/// the newest cards are the ones on screen.
#[derive(Debug, Default)]
pub struct SnapshotCache {
    entries: HashMap<String, Vec<Captured>>,
    /// Insertion order, so eviction is oldest-first rather than whatever the
    /// map's iteration order happens to be.
    order: VecDeque<String>,
    cap: usize,
}

impl SnapshotCache {
    pub fn new(cap: usize) -> Self {
        Self { entries: HashMap::new(), order: VecDeque::new(), cap: cap.max(1) }
    }

    pub fn insert(&mut self, tool_use_id: &str, captured: Vec<Captured>) {
        if self.entries.insert(tool_use_id.to_string(), captured).is_none() {
            self.order.push_back(tool_use_id.to_string());
        }
        while self.order.len() > self.cap {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    /// The before-states for a tool call, or `None` if it was never captured or
    /// has been evicted.
    ///
    /// `None` is a normal answer, not an error: the caller renders "diff
    /// unavailable, open the file". An evicted card degrading is strictly better
    /// than an unbounded cache.
    pub fn get(&self, tool_use_id: &str) -> Option<&Vec<Captured>> {
        self.entries.get(tool_use_id)
    }

    /// Every capture, oldest first, as `(tool_use_id, captured)`.
    ///
    /// The order is the whole point: a session's *first* capture of a path is
    /// the state that file was in before this session touched it, which is the
    /// left-hand side an accumulating diff needs. Reading the map directly
    /// would give whatever order it hashed into.
    pub fn in_order(&self) -> Vec<(String, Captured)> {
        let mut out = Vec::new();
        for id in &self.order {
            let Some(caps) = self.entries.get(id) else { continue };
            for c in caps {
                out.push((id.clone(), c.clone()));
            }
        }
        out
    }

    /// Test-only: the product asks about one tool call at a time. No companion
    /// `is_empty`, because nothing would call it - clippy's usual pairing rule
    /// does not apply to a method that only exists for assertions.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

}

/// The new-side line numbers a diff marks as added, in the file's current
/// coordinates.
///
/// New-side rather than old-side because these are compared *across* diffs that
/// share one right-hand side (the file as it is now); only the right-hand
/// coordinates mean the same thing in all of them.
fn changed_new_lines(diff: &str) -> Vec<u32> {
    let mut out = Vec::new();
    for hunk in crate::patch::parse_patch(diff).hunks {
        let mut line = hunk.new_start;
        for body in &hunk.body {
            match body.chars().next() {
                Some('+') => {
                    out.push(line);
                    line += 1;
                }
                // A removal occupies no line on the new side, so it does not
                // advance the counter. A deletion-only hunk therefore claims no
                // lines, which is correct: there is nothing left to attribute.
                Some('-') => {}
                _ => line += 1,
            }
        }
    }
    out
}

/// One file's whole-session diff, plus which tool call each hunk came from.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccumulatedDiff {
    /// Unified diff from the session's earliest before-state for this file to
    /// the file as it is now. For a single-session worktree with no manual
    /// edits, this is the same change `git diff` reports between the session's
    /// first and last checkpoint.
    pub diff: String,
    /// Whether the session created the file.
    pub created: bool,
    /// One entry per hunk of `diff`, in the same order: the call whose write
    /// those lines last came from, or `None` when no call claims them (a manual
    /// edit, or a call whose before-state was evicted).
    pub hunk_tool_use_ids: Vec<Option<String>>,
    /// Every call that wrote this file, oldest first.
    pub tool_use_ids: Vec<String>,
}

/// Accumulate one file's session-long diff and attribute its hunks.
///
/// `calls` is every capture for this path, oldest first. The diff spans the
/// first of them to the file's current content, so a line rewritten four times
/// appears once, at its final value.
///
/// Attribution reads the same span from each call in turn. A line still
/// differing from what call `i` saw is a line some call at or after `i` wrote,
/// so taking the *last* call whose view still differs names the write that
/// actually produced the text on screen. The consequence, accepted rather than
/// hidden: a line two calls edited is credited only to the later one.
pub fn accumulate(repo: &Path, path: &str, calls: &[(String, BeforeState)]) -> Option<AccumulatedDiff> {
    let (_, first) = calls.first()?;
    let diff = diff_against_now(repo, first, path)?;

    let mut owner: HashMap<u32, String> = HashMap::new();
    for (id, before) in calls {
        let Some(d) = diff_against_now(repo, before, path) else { continue };
        for line in changed_new_lines(&d) {
            owner.insert(line, id.clone());
        }
    }
    // Rank by call order so a hunk spanning two calls' lines reports the later
    // one, matching what the line-level rule already does.
    let rank: HashMap<&str, usize> =
        calls.iter().enumerate().map(|(i, (id, _))| (id.as_str(), i)).collect();

    let hunk_tool_use_ids = crate::patch::parse_patch(&diff)
        .hunks
        .iter()
        .map(|hunk| {
            let mut line = hunk.new_start;
            let mut best: Option<&str> = None;
            for body in &hunk.body {
                match body.chars().next() {
                    Some('+') => {
                        if let Some(id) = owner.get(&line) {
                            if best.is_none_or(|b| rank.get(id.as_str()) > rank.get(b)) {
                                best = Some(id);
                            }
                        }
                        line += 1;
                    }
                    Some('-') => {}
                    _ => line += 1,
                }
            }
            best.map(str::to_string)
        })
        .collect();

    Some(AccumulatedDiff {
        diff,
        created: matches!(first, BeforeState::Absent),
        hunk_tool_use_ids,
        tool_use_ids: calls.iter().map(|(id, _)| id.clone()).collect(),
    })
}

/// Capture every file a tool call is about to write.
pub fn capture_all(repo: &Path, tool: &str, input: &Value) -> Vec<Captured> {
    write_targets(tool, input)
        .into_iter()
        .map(|path| {
            let before = capture(repo, &path);
            Captured { path, before }
        })
        .collect()
}

/// What the UI is told when the diff it rendered no longer describes the file.
///
/// One string for both the missing-index and the wrong-fingerprint case, because
/// they mean the same thing to a user: the hunk you clicked is not the hunk that
/// is there now, so nothing was touched.
const STALE: &str = "The file changed since this diff was rendered. Nothing was reverted.";

/// Undo one hunk of a tool call's diff, in the working tree.
///
/// The diff is recomputed here rather than taken from the caller: a card can sit
/// open while the agent writes the file again, and a positional apply against a
/// stale render would revert a region the user never looked at. `fingerprint` is
/// the hash the UI rendered, re-derived from the fresh diff by the same parser
/// the Changes panel stages with ([[concept_hunk_level_staging]]); a mismatch
/// applies nothing.
///
/// Reverse-applied to the working tree rather than to the index: this is an undo
/// of an edit the user can see, not a staging operation, and `--cached` would
/// leave the file on disk exactly as the agent wrote it.
///
/// Returns `"deleted"` when the whole file went away, `"reverted"` otherwise.
pub fn revert_hunk(
    repo: &Path,
    before: &BeforeState,
    path: &str,
    hunk_index: usize,
    fingerprint: &str,
) -> Result<&'static str, String> {
    let text = diff_against_now(repo, before, path)
        .ok_or_else(|| "No before-state was captured for this call, so there is nothing to revert to.".to_string())?;
    if text.is_empty() {
        return Err("This file already matches its state before the call.".into());
    }
    let parsed = crate::patch::parse_patch(&text);
    let hunk = parsed.hunks.get(hunk_index).ok_or_else(|| STALE.to_string())?;
    if hunk.fingerprint != fingerprint {
        return Err(STALE.into());
    }

    // A file this call created is undone by deleting it, not by reverse-applying
    // its one hunk: the "before" of a creation is the file's absence, and a
    // reverse apply would leave an empty file, which is a different thing.
    if matches!(before, BeforeState::Absent) && parsed.hunks.len() == 1 {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
        return Ok("deleted");
    }

    let rel = relative_to(repo, path)?;
    // The diff is blob-vs-blob, so its preamble names two shas. `git apply`
    // resolves the file out of that preamble, so it has to name the real path or
    // the patch would target a file called `<sha>`.
    let mut selected = parsed.clone();
    selected.preamble = vec![format!("--- a/{rel}"), format!("+++ b/{rel}")];
    let patch = crate::patch::build_patch(&selected, &[hunk_index], true)?;
    apply_reverse(repo, &patch)?;
    Ok("reverted")
}

/// `path` as `repo` sees it, refusing anything outside the tree: a tool can
/// legitimately write outside the workspace, but a patch we apply must not.
fn relative_to(repo: &Path, path: &str) -> Result<String, String> {
    Path::new(path)
        .strip_prefix(repo)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| format!("{path} is outside this workspace, so it cannot be reverted from here."))
}

/// Feed a reverse patch to `git apply` on stdin, in the working tree.
fn apply_reverse(repo: &Path, patch: &str) -> Result<(), String> {
    use std::io::Write;
    let mut child = Command::new("git")
        .current_dir(repo)
        .args(["apply", "--reverse", "--whitespace=nowarn", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or_else(|| "git apply took no input".to_string())?
        .write_all(patch.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if stderr.is_empty() { STALE.to_string() } else { stderr })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sway-snap-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ok = Command::new("git").current_dir(&dir).args(["init", "-q"]).status().unwrap();
        assert!(ok.success());
        dir
    }

    /// Only the changed lines, so two diffs of the same change compare equal
    /// even though their headers name different blobs.
    fn changed_lines(diff: &str) -> Vec<String> {
        diff.lines()
            .filter(|l| (l.starts_with('+') || l.starts_with('-')) && !l.starts_with("+++") && !l.starts_with("---"))
            .map(str::to_string)
            .collect()
    }

    fn git_out(repo: &std::path::Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(repo)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t.test")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t.test")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// The diff view's contract. Three writes to one file across a session
    /// accumulate into **one** diff, and for a single-session worktree with no
    /// manual edits that diff is the same change `git diff` reports between the
    /// session's first and last checkpoint.
    ///
    /// The per-call diffs cannot say this: a line rewritten three times appears
    /// three times across them, at values that no longer exist on disk.
    #[test]
    fn an_accumulated_diff_matches_git_between_the_first_and_last_checkpoint() {
        let repo = temp_repo("accumulate");
        let file = repo.join("a.txt");
        std::fs::write(&file, "one\ntwo\nthree\nfour\n").unwrap();
        let path = file.to_string_lossy().into_owned();
        git_out(&repo, &["add", "-A"]);
        let first_tree = git_out(&repo, &["write-tree"]);

        // Three calls, each capturing what the previous left behind. Line two is
        // rewritten twice, so its intermediate value must not survive.
        let mut calls = Vec::new();
        calls.push(("call-1".to_string(), capture(&repo, &path)));
        std::fs::write(&file, "one\nTWO\nthree\nfour\n").unwrap();
        calls.push(("call-2".to_string(), capture(&repo, &path)));
        std::fs::write(&file, "one\nTWO-FINAL\nthree\nfour\n").unwrap();
        calls.push(("call-3".to_string(), capture(&repo, &path)));
        std::fs::write(&file, "one\nTWO-FINAL\nthree\nFOUR\n").unwrap();

        git_out(&repo, &["add", "-A"]);
        let last_tree = git_out(&repo, &["write-tree"]);

        let acc = accumulate(&repo, &path, &calls).expect("the session captured this file");
        let expected = git_out(&repo, &["diff", "--no-color", "-U3", &first_tree, &last_tree, "--", "a.txt"]);

        assert_eq!(changed_lines(&acc.diff), changed_lines(&expected));
        assert!(!acc.diff.contains("+TWO\n"), "the intermediate value is not on disk: {}", acc.diff);
        assert_eq!(acc.tool_use_ids, ["call-1", "call-2", "call-3"]);
        assert!(!acc.created);
    }

    /// A hunk is credited to the call that produced the text on screen, not to
    /// the first call that happened to touch the file.
    #[test]
    fn a_hunk_is_credited_to_the_call_whose_write_still_stands() {
        let repo = temp_repo("attribute");
        let file = repo.join("b.txt");
        // Two edit sites far enough apart to land in separate hunks.
        let mut original = vec!["top"];
        original.extend(std::iter::repeat_n("filler", 20));
        original.push("bottom");
        std::fs::write(&file, format!("{}\n", original.join("\n"))).unwrap();
        let path = file.to_string_lossy().into_owned();

        let mut calls = Vec::new();
        calls.push(("call-top".to_string(), capture(&repo, &path)));
        let mut now = original.clone();
        now[0] = "TOP";
        std::fs::write(&file, format!("{}\n", now.join("\n"))).unwrap();

        calls.push(("call-bottom".to_string(), capture(&repo, &path)));
        let last = now.len() - 1;
        now[last] = "BOTTOM";
        std::fs::write(&file, format!("{}\n", now.join("\n"))).unwrap();

        let acc = accumulate(&repo, &path, &calls).unwrap();
        assert_eq!(acc.hunk_tool_use_ids.len(), 2, "two edit sites, two hunks: {}", acc.diff);
        assert_eq!(acc.hunk_tool_use_ids[0].as_deref(), Some("call-top"));
        assert_eq!(
            acc.hunk_tool_use_ids[1].as_deref(),
            Some("call-bottom"),
            "the second hunk is the second call's work, though both calls' diffs contain it"
        );
    }

    /// A file the session created reads as a creation, and every line is the
    /// creating call's.
    #[test]
    fn a_created_file_accumulates_as_a_creation() {
        let repo = temp_repo("created");
        let file = repo.join("new.txt");
        let path = file.to_string_lossy().into_owned();

        let calls = vec![("call-1".to_string(), capture(&repo, &path))];
        assert_eq!(calls[0].1, BeforeState::Absent);
        std::fs::write(&file, "fresh\n").unwrap();

        let acc = accumulate(&repo, &path, &calls).unwrap();
        assert!(acc.created);
        assert!(acc.diff.contains("+fresh"), "{}", acc.diff);
        assert_eq!(acc.hunk_tool_use_ids, [Some("call-1".to_string())]);
    }

    /// The card's whole job: two edits to one file in one turn are two
    /// *different* diffs, each against the state that call actually found.
    /// A card that diffed against HEAD would show the same thing twice.
    #[test]
    fn two_sequential_edits_render_two_distinct_diffs() {
        let repo = temp_repo("two-diffs");
        let file = repo.join("a.txt");
        std::fs::write(&file, "one\ntwo\nthree\n").unwrap();
        let path = file.to_string_lossy().into_owned();

        // First call captures, then writes.
        let before_1 = capture(&repo, &path);
        std::fs::write(&file, "one\nTWO\nthree\n").unwrap();
        let diff_1 = diff_against_now(&repo, &before_1, &path).unwrap();

        // Second call captures what the first left behind.
        let before_2 = capture(&repo, &path);
        std::fs::write(&file, "one\nTWO\nTHREE\n").unwrap();
        let diff_2 = diff_against_now(&repo, &before_2, &path).unwrap();

        assert!(diff_1.contains("-two") && diff_1.contains("+TWO"), "{diff_1}");
        assert!(!diff_1.contains("THREE"), "the first diff cannot know about the second edit: {diff_1}");
        assert!(diff_2.contains("-three") && diff_2.contains("+THREE"), "{diff_2}");
        assert!(!diff_2.contains("+TWO"), "the second diff is against what the first left: {diff_2}");
        assert_ne!(diff_1, diff_2);
    }

    /// A creation is every line added, not a failure and not an empty diff.
    #[test]
    fn a_creation_diffs_against_nothing_and_reads_as_all_added() {
        let repo = temp_repo("creation");
        let file = repo.join("new.txt");
        let path = file.to_string_lossy().into_owned();

        let before = capture(&repo, &path);
        assert_eq!(before, BeforeState::Absent);
        std::fs::write(&file, "hello\n").unwrap();

        let diff = diff_against_now(&repo, &before, &path).unwrap();
        assert!(diff.contains("+hello"), "{diff}");
        assert!(!diff.contains("-hello"), "{diff}");
    }

    /// A tool that wrote the same bytes back produces an empty diff, which is
    /// different from having no diff to show.
    #[test]
    fn an_unchanged_file_is_an_empty_diff_not_an_unavailable_one() {
        let repo = temp_repo("unchanged");
        let file = repo.join("same.txt");
        std::fs::write(&file, "x\n").unwrap();
        let path = file.to_string_lossy().into_owned();

        let before = capture(&repo, &path);
        assert_eq!(diff_against_now(&repo, &before, &path), Some(String::new()));
    }

    /// A folder with no object store has nothing to diff against. The card says
    /// so and offers the file rather than failing the turn.
    #[test]
    fn an_unavailable_capture_has_no_diff_rather_than_an_error() {
        let repo = temp_repo("unavailable");
        assert_eq!(diff_against_now(&repo, &BeforeState::Unavailable, "/nope.txt"), None);
    }

    /// `-U` is the size of the unit the user reverts, so it has to be git's own
    /// default: widening it merges nearby edits into one un-revertable hunk.
    /// See [[lesson_diff_context_is_hunk_granularity]].
    #[test]
    fn the_context_width_is_gits_default_so_a_hunk_is_what_git_would_stage() {
        assert_eq!(DIFF_CONTEXT, 3);
    }

    /// A file with two edits far enough apart to be two hunks at `-U3`.
    fn two_hunk_edit(name: &str) -> (std::path::PathBuf, std::path::PathBuf, BeforeState) {
        let repo = temp_repo(name);
        let file = repo.join("a.txt");
        let original: String = (1..=20).map(|n| format!("line {n}\n")).collect();
        std::fs::write(&file, &original).unwrap();
        let path = file.to_string_lossy().into_owned();
        let before = capture(&repo, &path);
        let edited = original.replace("line 3\n", "LINE THREE\n").replace("line 17\n", "LINE SEVENTEEN\n");
        std::fs::write(&file, edited).unwrap();
        (repo, file, before)
    }

    fn hunks_of(repo: &Path, before: &BeforeState, path: &str) -> crate::patch::FilePatch {
        crate::patch::parse_patch(&diff_against_now(repo, before, path).unwrap())
    }

    /// The point of per-hunk revert: one region goes back, the rest of the
    /// call's work stays. A whole-file restore would take both.
    #[test]
    fn reverting_one_hunk_restores_that_region_and_leaves_the_other() {
        let (repo, file, before) = two_hunk_edit("revert-one-hunk");
        let path = file.to_string_lossy().into_owned();
        let parsed = hunks_of(&repo, &before, &path);
        assert_eq!(parsed.hunks.len(), 2, "the fixture must produce two hunks to be testing anything");

        let outcome = revert_hunk(&repo, &before, &path, 0, &parsed.hunks[0].fingerprint).unwrap();
        assert_eq!(outcome, "reverted");

        let now = std::fs::read_to_string(&file).unwrap();
        assert!(now.contains("line 3\n"), "the reverted region is back: {now}");
        assert!(!now.contains("LINE THREE"), "{now}");
        assert!(now.contains("LINE SEVENTEEN\n"), "the other hunk is untouched: {now}");
    }

    /// The second hunk's coordinates are the ones in the fresh diff, so
    /// reverting it must not need the first to have gone first.
    #[test]
    fn reverting_the_second_hunk_alone_lands_at_the_right_offset() {
        let (repo, file, before) = two_hunk_edit("revert-second-hunk");
        let path = file.to_string_lossy().into_owned();
        let parsed = hunks_of(&repo, &before, &path);

        revert_hunk(&repo, &before, &path, 1, &parsed.hunks[1].fingerprint).unwrap();

        let now = std::fs::read_to_string(&file).unwrap();
        assert!(now.contains("line 17\n"), "{now}");
        assert!(now.contains("LINE THREE\n"), "the first hunk is untouched: {now}");
    }

    /// A card can sit open while the agent writes the file again. The hash the
    /// UI rendered is checked against a fresh diff, and a mismatch writes
    /// nothing rather than reverting whatever now sits at that index.
    #[test]
    fn a_stale_fingerprint_reverts_nothing() {
        let (repo, file, before) = two_hunk_edit("stale-fingerprint");
        let path = file.to_string_lossy().into_owned();
        let content = std::fs::read_to_string(&file).unwrap();

        let err = revert_hunk(&repo, &before, &path, 0, "deadbeef").unwrap_err();
        assert!(err.contains("Nothing was reverted"), "{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), content, "the file must be byte-identical");
    }

    /// An index past the end of the fresh diff is the same failure as a bad
    /// hash: the render the click came from is gone.
    #[test]
    fn a_hunk_index_past_the_end_reverts_nothing() {
        let (repo, file, before) = two_hunk_edit("stale-index");
        let path = file.to_string_lossy().into_owned();
        let err = revert_hunk(&repo, &before, &path, 9, "whatever").unwrap_err();
        assert!(err.contains("Nothing was reverted"), "{err}");
    }

    /// The "before" of a creation is the file's absence, so undoing it is a
    /// delete. Reverse-applying the hunk would leave an empty file, which is a
    /// state the tool call never found.
    #[test]
    fn reverting_the_only_hunk_of_a_created_file_deletes_it() {
        let repo = temp_repo("revert-creation");
        let file = repo.join("new.txt");
        let path = file.to_string_lossy().into_owned();
        let before = capture(&repo, &path);
        std::fs::write(&file, "hello\nworld\n").unwrap();

        let parsed = hunks_of(&repo, &before, &path);
        let outcome = revert_hunk(&repo, &before, &path, 0, &parsed.hunks[0].fingerprint).unwrap();
        assert_eq!(outcome, "deleted");
        assert!(!file.exists(), "undoing a creation removes the file");
    }

    /// A tool may legitimately write outside the workspace; a patch we apply
    /// may not. Refused by name rather than applied relative to the wrong root.
    #[test]
    fn a_path_outside_the_workspace_is_refused() {
        let repo = temp_repo("revert-outside");
        let outside = std::env::temp_dir().join(format!("sway-outside-{}.txt", std::process::id()));
        std::fs::write(&outside, "one\ntwo\n").unwrap();
        let path = outside.to_string_lossy().into_owned();
        let before = capture(&repo, &path);
        std::fs::write(&outside, "one\nTWO\n").unwrap();

        let parsed = hunks_of(&repo, &before, &path);
        let err = revert_hunk(&repo, &before, &path, 0, &parsed.hunks[0].fingerprint).unwrap_err();
        assert!(err.contains("outside this workspace"), "{err}");
        let _ = std::fs::remove_file(&outside);
    }

    /// Nothing was captured, so there is no state to go back to. Said plainly
    /// rather than reverting to whatever the file happens to contain.
    #[test]
    fn reverting_without_a_before_state_says_so() {
        let repo = temp_repo("revert-unavailable");
        let err = revert_hunk(&repo, &BeforeState::Unavailable, "/nope.txt", 0, "x").unwrap_err();
        assert!(err.contains("nothing to revert"), "{err}");
    }

    #[test]
    fn only_the_writing_tools_have_capture_targets() {
        assert_eq!(write_targets("Edit", &json!({"file_path": "/a.rs"})), vec!["/a.rs"]);
        assert_eq!(write_targets("Write", &json!({"file_path": "/a.rs"})), vec!["/a.rs"]);
        assert_eq!(write_targets("MultiEdit", &json!({"file_path": "/a.rs"})), vec!["/a.rs"]);
        // A read has no before-state worth the hook's time.
        assert!(write_targets("Read", &json!({"file_path": "/a.rs"})).is_empty());
        assert!(write_targets("Bash", &json!({"command": "rm /a.rs"})).is_empty());
    }

    /// **The load-bearing property.** Two edits to one file in one turn must
    /// produce two *different* shas, or the second card would show the first
    /// card's before-state and the diff would be wrong.
    #[test]
    fn two_sequential_edits_to_one_file_produce_two_distinct_shas() {
        let repo = temp_repo("two-edits");
        let file = repo.join("a.rs");
        std::fs::write(&file, "fn main() {}\n").unwrap();

        let first = capture(&repo, file.to_str().unwrap());
        std::fs::write(&file, "fn main() { println!(\"hi\"); }\n").unwrap();
        let second = capture(&repo, file.to_str().unwrap());

        match (&first, &second) {
            (BeforeState::Blob { sha: a }, BeforeState::Blob { sha: b }) => {
                assert_ne!(a, b, "each edit must capture its own before-state");
                assert_eq!(read_back(&repo, a).as_deref(), Some("fn main() {}\n"));
                assert_eq!(read_back(&repo, b).as_deref(), Some("fn main() { println!(\"hi\"); }\n"));
            }
            other => panic!("expected two blobs, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A write to a file that does not exist yet is a **creation**, recorded
    /// explicitly. Conflating it with a failed capture would render an apology
    /// where a creation diff belongs.
    #[test]
    fn a_write_to_a_new_file_records_absent_rather_than_failing() {
        let repo = temp_repo("new-file");
        let missing = repo.join("does-not-exist-yet.rs");
        assert_eq!(capture(&repo, missing.to_str().unwrap()), BeforeState::Absent);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A folder with no object store falls back rather than failing the turn.
    #[test]
    fn a_non_git_folder_degrades_to_unavailable_rather_than_failing() {
        let dir = std::env::temp_dir().join(format!("sway-snap-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.rs");
        std::fs::write(&file, "hello\n").unwrap();

        assert_eq!(capture(&dir, file.to_str().unwrap()), BeforeState::Unavailable);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The memory claim, measured rather than asserted: a session rewriting a
    /// large file many times must grow the cache by shas, not by content.
    #[test]
    fn rewriting_a_large_file_forty_times_grows_the_cache_by_kilobytes() {
        let repo = temp_repo("large");
        let file = repo.join("big.txt");
        let mut cache = SnapshotCache::new(CACHE_CAP);

        // Capture *then* write, which is the order the hook runs in: the
        // before-state belongs to the call that is about to overwrite it.
        // 3MB of distinct content each round, so nothing dedupes away.
        std::fs::write(&file, "seed".repeat(750_000)).unwrap();
        for i in 0..40 {
            let captured = capture_all(&repo, "Write", &json!({"file_path": file.to_str().unwrap()}));
            cache.insert(&format!("toolu_{i}"), captured);
            std::fs::write(&file, format!("r{i}-").repeat(750_000)).unwrap();
        }

        assert_eq!(cache.len(), 40);
        let held: usize = (0..40)
            .filter_map(|i| cache.get(&format!("toolu_{i}")))
            .flatten()
            .map(|c| c.path.len() + match &c.before {
                BeforeState::Blob { sha } => sha.len(),
                _ => 0,
            })
            .sum();
        assert!(held < 20_000, "the cache should hold kilobytes of shas and paths, held {held} bytes");

        // And the content really is retrievable, so holding only shas cost
        // nothing. The last call's before-state is what round 38 wrote, which is
        // exactly the "what did *this* call change" question a card asks.
        let last = cache.get("toolu_39").unwrap();
        match &last[0].before {
            BeforeState::Blob { sha } => {
                let content = read_back(&repo, sha).expect("the blob should still be readable");
                assert!(content.starts_with("r38-"), "expected round 38's content, got {:.8}", content);
            }
            other => panic!("expected a blob, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// Bounded even though entries are tiny, because a long session has no
    /// natural end. Oldest-first, since the newest cards are on screen.
    #[test]
    fn filling_past_the_cap_evicts_oldest_first_and_keeps_the_newest() {
        let mut cache = SnapshotCache::new(3);
        for i in 0..5 {
            cache.insert(
                &format!("toolu_{i}"),
                vec![Captured { path: format!("/f{i}"), before: BeforeState::Absent }],
            );
        }
        assert_eq!(cache.len(), 3);
        assert!(cache.get("toolu_0").is_none(), "the oldest should be evicted");
        assert!(cache.get("toolu_1").is_none());
        for i in 2..5 {
            assert!(cache.get(&format!("toolu_{i}")).is_some(), "toolu_{i} should still render");
        }
    }

    /// An evicted card degrades to the fallback rather than throwing, which is
    /// the same path a non-repo folder takes.
    #[test]
    fn an_evicted_entry_reads_as_missing_rather_than_erroring() {
        let mut cache = SnapshotCache::new(1);
        cache.insert("old", vec![Captured { path: "/a".into(), before: BeforeState::Absent }]);
        cache.insert("new", vec![Captured { path: "/b".into(), before: BeforeState::Absent }]);
        assert_eq!(cache.get("old"), None, "an evicted card renders the fallback");
        assert!(cache.get("new").is_some());
    }

    /// Re-inserting the same id must not double-count it in the eviction order,
    /// or the cap would evict live entries early.
    #[test]
    fn reinserting_an_id_does_not_corrupt_the_eviction_order() {
        let mut cache = SnapshotCache::new(2);
        cache.insert("a", vec![Captured { path: "/a".into(), before: BeforeState::Absent }]);
        cache.insert("a", vec![Captured { path: "/a2".into(), before: BeforeState::Absent }]);
        cache.insert("b", vec![Captured { path: "/b".into(), before: BeforeState::Absent }]);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get("a").unwrap()[0].path, "/a2", "the newer capture should win");
        assert!(cache.get("b").is_some());
    }

    /// A sha for content the store never had must read back as `None`, so a
    /// stale card degrades rather than rendering someone else's bytes.
    #[test]
    fn reading_back_an_unknown_sha_is_none() {
        let repo = temp_repo("unknown-sha");
        assert_eq!(read_back(&repo, "0000000000000000000000000000000000000000"), None);
        let _ = std::fs::remove_dir_all(&repo);
    }
}
