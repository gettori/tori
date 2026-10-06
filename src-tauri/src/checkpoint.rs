// Turn-level checkpoints (Finding E): a snapshot of the full working tree at
// each prompt boundary, so per-turn diffs and per-file revert work
// agent-agnostically, from ground truth (the tree itself), not the
// transcript's account of what it did - closing the "Bash-driven writes are
// invisible to path-argument parsing" gap (Finding B).
//
// Mechanism: `git add -A` against a *persistent per-session* scratch index
// (`~/.config/tori/checkpoint-index/<sessionId>`, kept warm across snapshots
// for git's stat-cache, same trick the grimoire baseline refs use), then
// `write-tree`. The resulting tree is never committed and the user's real
// index/staging is never touched. Snapshots are named by the triggering
// prompt's transcript timestamp and anchored under
// `refs/tori/checkpoint/<sessionId>/<promptTs>` so they survive gc; a repeat
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
use std::process::Stdio;

use serde::{Deserialize, Serialize};

/// The well-known SHA-1 empty-tree object id (no parent needed for a
/// never-before-snapshotted session's first turn).
pub(crate) const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// One per repository as well as per session: a Topic chat snapshots several
// member repos, and one shared index would be rebuilt from scratch on every
// switch and locked by two snapshots at once.
fn checkpoint_index_path(session_id: &str, repo: &str) -> PathBuf {
    crate::owned_state::config_dir()
        .join("checkpoint-index")
        .join(format!("{session_id}-{:016x}", crate::owned_state::path_hash(repo)))
}

fn legacy_index_path(session_id: &str) -> PathBuf {
    crate::owned_state::config_dir()
        .join("checkpoint-index")
        .join(session_id)
}

// A session from before indexes were keyed per repository keeps its warm
// index rather than paying a cold `git add -A`, and leaves no file behind.
fn adopt_legacy_index(session_id: &str, repo: &str) {
    let keyed = checkpoint_index_path(session_id, repo);
    if !keyed.exists() {
        let _ = std::fs::rename(legacy_index_path(session_id), keyed);
    }
}

pub(crate) fn remove_indexes(session_id: &str) {
    let _ = std::fs::remove_file(legacy_index_path(session_id));
    let dir = crate::owned_state::config_dir().join("checkpoint-index");
    let keyed = format!("{session_id}-");
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ours = name
            .strip_prefix(&keyed)
            .is_some_and(|h| h.len() == 16 && h.chars().all(|c| c.is_ascii_hexdigit()));
        if ours {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// --- per-turn attribution -------------------------------------------------
//
// The snapshot above is a whole-tree `git add -A`, which was exact while a
// worktree had at most one live agent and stopped being exact the moment several
// chats could share one. Two sessions editing in the same interval both see the
// other's files in "changes this turn", because the tree cannot say who wrote
// what.
//
// Chat narrows that gap with a measurement rather than a heuristic:
// `ToolCallCompleted` carries the paths that session wrote, *for the tools that
// name them*. Those sets are recorded here per (session, turn) alongside the
// tool names, so the tree still decides *what changed* while the events decide
// *whose change it was*.
//
// The tool names are what keep the measurement honest. A `Bash` heredoc writes
// files no path parse will ever see, so the recorded set is a lower bound, not
// an inventory. Grading each turn `Complete` / `Partial` / `Unmeasured` is how
// the reader knows which of the three it is holding - see `attributed_files`.
//
// Written to disk rather than held in memory because the timeline browses turns
// from earlier runs, and an in-memory set would make attribution silently
// degrade to the old behaviour after a restart - the worst kind of regression,
// since it looks identical to working.

/// Where a session's per-turn touched-file sets live. One file per turn, named
/// by the same `prompt_ts` that names the turn's checkpoint ref, so the two
/// cannot drift apart.
fn attribution_path(session_id: &str, prompt_ts: u64) -> PathBuf {
    crate::owned_state::config_dir()
        .join("checkpoint-touched")
        .join(session_id)
        .join(format!("{prompt_ts}.json"))
}

/// One turn's record: which tools ran, and which paths they reported writing.
///
/// The tools are recorded as well as the paths because the two answer different
/// questions. The paths say what this session wrote; the tool names say whether
/// that list can be believed to be *complete*, since a `Bash` heredoc writes
/// files no path parse will ever see.
///
/// Both fields default, so a record written by a later version that adds a
/// field still reads. Refusing it would grade the turn `Unmeasured`, which is
/// the *unfiltered* branch: version skew must not silently reopen the hole this
/// grading exists to close.
#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
struct Touched {
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    files: Vec<String>,
}

/// A record written before tool names were recorded: a bare array of paths.
/// Still read, never written; see `attribution_state` for why it can only ever
/// be `Partial`.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredTouched {
    Current(Touched),
    Legacy(Vec<String>),
}

/// Tools whose write targets `files_touched` can read off the result frame, so
/// a turn made only of these has a *complete* file list.
///
/// An allowlist rather than a denylist, because the fail-safe direction is to
/// call an unrecognised tool unparseable: an MCP server, a `Task` subagent or a
/// new built-in can all write files through a path Tori cannot see, and calling
/// such a turn `complete` would reinstate exactly the silent drop this list
/// exists to prevent.
const PATH_PARSEABLE_TOOLS: &[&str] = &[
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "Read",
    "Glob",
    "Grep",
    "LS",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
];

/// How much of a turn's writing the recorded file list actually accounts for.
/// Surfaced to the UI per file as `CheckpointFile::unattributed` rather than
/// per turn, because what a caller can act on is which files are in doubt.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AttributionState {
    /// Every tool in the turn reported its own paths, so the list is exhaustive.
    Complete,
    /// At least one tool wrote through a path Tori cannot parse. The list is a
    /// lower bound on what this session wrote.
    Partial,
    /// Nothing was recorded at all: a PTY session, or a turn from before
    /// attribution existed. Not "wrote nothing" - "not measured".
    Unmeasured,
}

/// Record that `session_id` ran `tool` during the turn at `prompt_ts`, writing
/// `files`.
///
/// Additive: a turn makes many tool calls and each reports its own name and
/// paths, so this merges rather than replaces. Paths are stored exactly as the
/// events carry them (absolute), and normalized against the repo only at read
/// time, where the repo root is known.
///
/// **A tool with no paths is still recorded.** That is the whole point of
/// naming the tool: a `Bash` call reports nothing, and a turn that returns
/// early on an empty path list leaves no trace that the shell ran at all, which
/// is indistinguishable from a PTY turn and lands in the unfiltered branch.
#[tauri::command(async)]
pub fn checkpoint_note_touched(
    session_id: String,
    prompt_ts: u64,
    tool: String,
    files: Vec<String>,
) -> Result<(), String> {
    // Load-modify-save on the touched store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("touched");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let before = read_touched(&session_id, prompt_ts);
    let mut rec = before.clone().unwrap_or_default();
    rec.tools.push(tool);
    rec.tools.sort();
    rec.tools.dedup();
    rec.files.extend(files);
    rec.files.sort();
    rec.files.dedup();
    // A turn repeats tools far more often than it reaches new files, so most
    // calls after the first of a kind merge to exactly what is already on disk.
    // Rewriting the file for those is churn on every tool call of every turn.
    if before.as_ref() == Some(&rec) {
        return Ok(());
    }
    let path = attribution_path(&session_id, prompt_ts);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&rec).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    // The turn is registered even when it added no path, so the ordinals stay
    // the session's own turn numbering rather than a count of the turns that
    // happened to write something.
    note_touched_index(&session_id, prompt_ts, &rec.files);
    Ok(())
}

/// The reverse of the per-turn records: which turns touched a given path.
///
/// The per-turn files answer "what did turn N write", which is the question the
/// timeline asks. Attributing a *line* asks the opposite: "which turns wrote
/// this file", and answering that from the per-turn files means opening every
/// one of them - 200 reads to find the 3 that matter, on every file you open.
///
/// `turns` is **append-only and unsorted**, so an index into it never moves;
/// `files` holds those indices. A turn's ordinal ("turn 12 of this session") is
/// its rank once `turns` is sorted, computed at read time.
#[derive(Serialize, Deserialize, Default, Debug)]
struct TouchedIndex {
    turns: Vec<u64>,
    files: HashMap<String, Vec<u32>>,
}

fn touched_index_path(session_id: &str) -> PathBuf {
    crate::owned_state::config_dir()
        .join("checkpoint-touched")
        .join(session_id)
        .join("index.json")
}

fn read_touched_index(session_id: &str) -> Option<TouchedIndex> {
    let text = std::fs::read_to_string(touched_index_path(session_id)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Fold one turn's paths into the session's index. Called from
/// `checkpoint_note_touched` on the path where the record actually changed, so
/// a repeated tool call costs nothing here either.
///
/// A failure is swallowed rather than returned: the index is a lookup shortcut
/// over records that are already on disk, and failing the tool call that was
/// merely *noting* a write would be a much worse trade than losing attribution
/// for one turn.
fn note_touched_index(session_id: &str, prompt_ts: u64, files: &[String]) {
    let mut index = read_touched_index(session_id).unwrap_or_default();
    // A turn calls the same tools over and over, so most calls after the first
    // reach exactly what is already indexed.
    if !fold_into_index(&mut index, prompt_ts, files) {
        return;
    }
    write_touched_index(session_id, &index);
}

/// Add one turn and its paths to an index in memory. Returns whether anything
/// actually moved, so the caller can skip the write.
fn fold_into_index(index: &mut TouchedIndex, prompt_ts: u64, files: &[String]) -> bool {
    let mut changed = false;
    let at = match index.turns.iter().position(|t| *t == prompt_ts) {
        Some(i) => i as u32,
        None => {
            index.turns.push(prompt_ts);
            changed = true;
            (index.turns.len() - 1) as u32
        }
    };
    for file in files {
        let entry = index.files.entry(file.clone()).or_default();
        if !entry.contains(&at) {
            entry.push(at);
            changed = true;
        }
    }
    changed
}

fn write_touched_index(session_id: &str, index: &TouchedIndex) {
    let path = touched_index_path(session_id);
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_string(index) {
        let _ = std::fs::write(&path, json);
    }
}

/// One turn that wrote a file, and where it sits in its session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TouchedTurn {
    pub session_id: String,
    pub prompt_ts: u64,
    /// 1-based position among the turns this session has recorded, so the
    /// widget can say "turn 12" rather than an epoch timestamp.
    pub ordinal: usize,
}

/// Every turn of `session_id` that wrote `abs_file`, oldest first.
///
/// One file read. A session with no index answers empty rather than falling
/// back to a scan: the scan is the cost this exists to avoid, and a session that
/// predates the index is exactly the case where it would run every time.
/// `rebuild_touched_index` covers that case once, at open.
pub(crate) fn turns_touching(session_id: &str, abs_file: &str) -> Vec<TouchedTurn> {
    let Some(index) = read_touched_index(session_id) else {
        return Vec::new();
    };
    let Some(at) = index.files.get(abs_file) else {
        return Vec::new();
    };
    let mut order: Vec<u64> = index.turns.clone();
    order.sort_unstable();
    let mut out: Vec<TouchedTurn> = at
        .iter()
        .filter_map(|i| index.turns.get(*i as usize).copied())
        .map(|ts| TouchedTurn {
            session_id: session_id.to_string(),
            prompt_ts: ts,
            ordinal: order.iter().position(|t| *t == ts).map(|i| i + 1).unwrap_or(0),
        })
        .collect();
    out.sort_by_key(|t| t.prompt_ts);
    out
}

/// Build the index from the per-turn records for a session that has none.
///
/// The one place the 200-read scan is allowed, and it happens once per session
/// ever: without it every session recorded before the index existed would report
/// no agent lines at all, which looks exactly like "the agent wrote nothing".
pub(crate) fn rebuild_touched_index(session_id: &str) {
    if touched_index_path(session_id).exists() {
        return;
    }
    let Some(dir) = attribution_path(session_id, 0).parent().map(|p| p.to_path_buf()) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let mut turns: Vec<u64> = entries
        .flatten()
        .filter_map(|e| {
            e.file_name()
                .to_str()
                .and_then(|n| n.strip_suffix(".json"))
                .and_then(|n| n.parse().ok())
        })
        .collect();
    turns.sort_unstable();
    if turns.is_empty() {
        return;
    }
    let mut index = TouchedIndex::default();
    for ts in turns {
        let Some(rec) = read_touched(session_id, ts) else {
            continue;
        };
        fold_into_index(&mut index, ts, &rec.files);
    }
    write_touched_index(session_id, &index);
}

/// A session's record for one turn, or `None` when there is no readable one.
/// `None` is the PTY case and every turn from before this existed - see
/// `attributed_files` for why that means "do not filter".
fn read_touched(session_id: &str, prompt_ts: u64) -> Option<Touched> {
    let text = std::fs::read_to_string(attribution_path(session_id, prompt_ts)).ok()?;
    match serde_json::from_str::<StoredTouched>(&text).ok()? {
        StoredTouched::Current(rec) => Some(rec),
        StoredTouched::Legacy(files) => Some(Touched {
            tools: Vec::new(),
            files,
        }),
    }
}

/// Grade the turn's record. A record with no tools named is either the legacy
/// shape or a turn whose tools went unreported; either way its completeness is
/// unknown, and unknown is graded `Partial` rather than `Complete` so the
/// honest branch is the default one.
fn attribution_state(rec: Option<&Touched>) -> AttributionState {
    let Some(rec) = rec else {
        return AttributionState::Unmeasured;
    };
    if !rec.tools.is_empty() && rec.tools.iter().all(|t| PATH_PARSEABLE_TOOLS.contains(&t.as_str())) {
        AttributionState::Complete
    } else {
        AttributionState::Partial
    }
}

/// Repo-relative form of an absolute path, for comparing against `git diff`
/// output. A path outside the repo has no relative form and is dropped: it
/// cannot appear in the tree diff anyway.
pub(crate) fn relative_to(repo: &str, path: &str) -> Option<String> {
    Path::new(path)
        .strip_prefix(repo)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

pub(crate) fn is_git_worktree(repo: &str) -> bool {
    crate::exec::git_in(repo)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

pub(crate) fn git_run(repo: &str, args: &[&str]) -> Result<(), String> {
    let out = crate::exec::git_in(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

pub(crate) fn git_capture(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = crate::exec::git_in(repo)
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
pub(crate) fn git_output(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = crate::exec::git_in(repo)
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
pub(crate) fn write_tree_scratch(repo: &str, index_path: &Path) -> Result<String, String> {
    if let Some(parent) = index_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let index_str = index_path.to_string_lossy().into_owned();
    // No pathspec, deliberately, and the attempts directory is kept out by its
    // ignore entry alone.
    //
    // An earlier version excluded it with `-- . :(exclude).tori-attempts`, on
    // the theory that gitignore stops a file entering the index without stopping
    // git walking the tree to discover that. **Measured, and that is not how git
    // behaves**: an ignored *directory* is pruned, not descended. A repo with
    // 4000 ignored files added in 34ms against 200ms for the same files tracked.
    // The pathspec also broke this outright, since an exclude matching only
    // ignored paths makes `git add` error rather than skip - so a fanned-out
    // project's every snapshot would have failed. See
    // [[gotchas#an-exclude-pathspec-over-ignored-paths-fails-git-add]].
    let add = crate::exec::git_in(repo)
        .args(["add", "-A"])
        .env("GIT_INDEX_FILE", &index_str)
        .output()
        .map_err(|e| e.to_string())?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }
    let tree = crate::exec::git_in(repo)
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
    format!("refs/tori/checkpoint/{session_id}/")
}

fn ref_name(session_id: &str, prompt_ts: u64) -> String {
    format!("{}{}", ref_prefix(session_id), prompt_ts)
}

/// A backstop's ref carries a `.backstop` suffix after the timestamp, so the
/// timeline can label it without a side table; `parse_ref_segment` reads it
/// back. A plain prompt-boundary snapshot has no suffix.
///
/// The checkpoint the revert was heading for follows as a second suffix, which
/// is what lets the row say "before revert to 00:04". A backstop written
/// before that existed has none.
const KIND_BACKSTOP: &str = "backstop";

fn backstop_ref_name(session_id: &str, ts: u64, target: u64) -> String {
    format!("{}{}.{}.{}", ref_prefix(session_id), ts, KIND_BACKSTOP, target)
}

/// `"1700.backstop.1650"` -> `(1700, "backstop", Some(1650))`;
/// `"1700.backstop"` -> `(1700, "backstop", None)`; `"1700"` -> `(1700, "", None)`.
fn parse_ref_segment(segment: &str) -> Option<(u64, String, Option<u64>)> {
    let Some((ts, rest)) = segment.split_once('.') else {
        return Some((segment.parse().ok()?, String::new(), None));
    };
    match rest.split_once('.') {
        Some((kind, target)) => Some((ts.parse().ok()?, kind.to_string(), target.parse().ok())),
        None => Some((ts.parse().ok()?, rest.to_string(), None)),
    }
}

// A Topic chat runs in the Topic's home, which is no repository, so a call
// made there runs once per worktree member and answers with absolute paths.
fn worktree_members(at: &str) -> Option<Vec<String>> {
    let topics = crate::unit_home::topics();
    let topic = crate::topic_home::topic_at_home(&topics, at)?;
    let mut members: Vec<&crate::topics::Member> = topic
        .members
        .iter()
        .filter(|m| m.mode == crate::topics::MemberMode::Worktree)
        .collect();
    members.sort_by_key(|m| m.order);
    Some(
        members
            .into_iter()
            .filter_map(|m| crate::topics::member_root(m).map(str::to_string))
            .collect(),
    )
}

// A member that joined later has only the empty tree to compare against,
// which would read as the turn adding every file it holds.
fn covering<'a>(roots: &'a [String], session_id: &str, ts: u64) -> Vec<&'a String> {
    roots
        .iter()
        .filter(|r| list_checkpoints(r, session_id).iter().any(|c| c.ts <= ts))
        .collect()
}

fn absolute(root: &str, path: &str) -> String {
    Path::new(root).join(path).to_string_lossy().into_owned()
}

// The longest root wins, so a member nested in another answers for itself.
fn in_member(roots: &[String], file: &str) -> Result<(String, String), String> {
    roots
        .iter()
        .filter_map(|r| relative_to(r, file).map(|rel| (r.clone(), rel)))
        .max_by_key(|(r, _)| r.len())
        .ok_or_else(|| format!("{file} is in none of this Topic's worktrees."))
}

#[derive(Clone, Debug)]
struct Checkpoint {
    ts: u64,
    tree: String,
    /// "" for a prompt-boundary snapshot, "backstop" for the pre-revert
    /// safety snapshot `checkpoint_revert_tree` writes.
    kind: String,
    /// The checkpoint a backstop was taken on the way to.
    target: Option<u64>,
}

/// Every existing checkpoint ref for this session, ascending by `ts`.
fn list_checkpoints(repo: &str, session_id: &str) -> Vec<Checkpoint> {
    let prefix = ref_prefix(session_id);
    let out = match crate::exec::git_in(repo)
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
            let (ts, kind, target) = parse_ref_segment(name.strip_prefix(&prefix)?)?;
            Some(Checkpoint {
                ts,
                tree: tree.to_string(),
                kind,
                target,
            })
        })
        .collect();
    entries.sort_by_key(|c| c.ts);
    entries
}

/// Every tree this session has snapshotted, ascending by timestamp.
///
/// Backstops are included. A backstop is a real intermediate state of the tree,
/// and a line walk that skipped it would carry line numbers across a change
/// nothing in its plan accounts for.
pub(crate) fn checkpoint_trees(repo: &str, session_id: &str) -> Vec<(u64, String)> {
    list_checkpoints(repo, session_id)
        .into_iter()
        .map(|c| (c.ts, c.tree))
        .collect()
}

fn tree_at_or_before(checkpoints: &[Checkpoint], ts: u64) -> String {
    checkpoints
        .iter()
        .rev()
        .find(|c| c.ts <= ts)
        .map(|c| c.tree.clone())
        .unwrap_or_else(|| EMPTY_TREE.to_string())
}

fn tree_after(repo: &str, session_id: &str, checkpoints: &[Checkpoint], ts: u64) -> Result<String, String> {
    if let Some(c) = checkpoints.iter().find(|c| c.ts > ts) {
        return Ok(c.tree.clone());
    }
    // The latest turn has no following prompt boundary yet: diff against a
    // live, unpersisted snapshot so an in-progress turn's diff stays current.
    write_tree_scratch(repo, &checkpoint_index_path(session_id, repo))
}

/// Snapshot the working tree at a prompt boundary (`prompt_ts`, the
/// transcript timestamp of the human message that just arrived). No-op
/// outside a git worktree. Idempotent: a ref already at `prompt_ts` is left
/// alone; a computed tree identical to the nearest earlier checkpoint is not
/// written at all (an idle turn or a duplicate trigger creates no new ref).
/// Returns whether a new ref was created.
#[tauri::command]
pub async fn checkpoint_snapshot(session_id: String, repo_path: String, prompt_ts: u64) -> Result<bool, String> {
    crate::exec::git_write("checkpoint_snapshot", repo_path.clone(), move || {
        checkpoint_snapshot_body(session_id, repo_path, prompt_ts)
    })
    .await
}

pub(crate) fn checkpoint_snapshot_body(session_id: String, repo_path: String, prompt_ts: u64) -> Result<bool, String> {
    match worktree_members(&repo_path) {
        Some(roots) => snapshot_members(&session_id, &repo_path, &roots, prompt_ts),
        None => snapshot_one(session_id, repo_path, prompt_ts),
    }
}

fn snapshot_members(session_id: &str, home: &str, roots: &[String], prompt_ts: u64) -> Result<bool, String> {
    let mut turn = None;
    let mut failed = None;
    for root in roots {
        let lock = crate::exec::repo_lock(root);
        let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match write_snapshot(session_id, root, prompt_ts) {
            Ok(t) => turn = turn.max(t),
            Err(e) => failed = failed.or(Some(e)),
        }
    }
    if let Some(turn) = turn {
        crate::rpc::publish_checkpoint(session_id, home, turn, prompt_ts);
    }
    match failed {
        Some(e) if turn.is_none() => Err(e),
        _ => Ok(turn.is_some()),
    }
}

fn snapshot_one(session_id: String, repo_path: String, prompt_ts: u64) -> Result<bool, String> {
    let turn = write_snapshot(&session_id, &repo_path, prompt_ts)?;
    if let Some(turn) = turn {
        crate::rpc::publish_checkpoint(&session_id, &repo_path, turn, prompt_ts);
    }
    Ok(turn.is_some())
}

fn write_snapshot(session_id: &str, repo_path: &str, prompt_ts: u64) -> Result<Option<usize>, String> {
    if !is_git_worktree(repo_path) {
        return Ok(None);
    }
    let checkpoints = list_checkpoints(repo_path, session_id);
    if checkpoints.iter().any(|c| c.ts == prompt_ts) {
        return Ok(None);
    }
    adopt_legacy_index(session_id, repo_path);
    let tree = write_tree_scratch(repo_path, &checkpoint_index_path(session_id, repo_path))?;
    let prior = tree_at_or_before(&checkpoints, prompt_ts);
    if prior == tree {
        return Ok(None);
    }
    git_run(repo_path, &["update-ref", &ref_name(session_id, prompt_ts), &tree])?;
    Ok(Some(checkpoints.iter().filter(|c| c.ts < prompt_ts).count() + 1))
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct CheckpointFile {
    pub path: String,
    /// "added" | "modified" | "deleted"
    pub status: String,
    /// Lines the span added to and took from this file. Both zero for a binary
    /// file, which git counts no lines for.
    pub added: u32,
    pub removed: u32,
    /// Another live session also reported writing this file in an overlapping
    /// turn.
    ///
    /// Surfaced rather than resolved, because there is no honest way to resolve
    /// it: both sessions really did write the file, and picking one would be a
    /// guess presented as a fact. A revert of a shared file is the dangerous
    /// case, so it is marked here and confirmed at the point of revert.
    #[serde(default)]
    pub shared_with: Vec<String>,
    /// The tree says this file changed during the turn and *no* session claims
    /// it. Only ever set on a `Partial` turn, where the most likely author is
    /// this session's own unparseable write (a `Bash` heredoc) - likely, not
    /// known, which is why it is listed as a candidate rather than asserted,
    /// and why revert refuses it by default.
    #[serde(default)]
    pub unattributed: bool,
}

pub(crate) fn parse_name_status(text: &str) -> Vec<CheckpointFile> {
    text.lines()
        .filter_map(|line| {
            let (code, path) = line.split_once('\t')?;
            let status = match code.chars().next()? {
                'A' => "added",
                'D' => "deleted",
                _ => "modified",
            };
            Some(CheckpointFile {
                path: path.to_string(),
                status: status.to_string(),
                added: 0,
                removed: 0,
                shared_with: Vec::new(),
                unattributed: false,
            })
        })
        .collect()
}

/// Fill in each file's line counts from one `git diff --numstat` over the same
/// two trees the list came from.
///
/// A failure leaves the counts at zero rather than failing the list: the counts
/// decorate the rows, and the rows are what a revert is decided from.
pub(crate) fn count_lines(repo: &str, before: &str, after: &str, files: &mut [CheckpointFile]) {
    if files.is_empty() {
        return;
    }
    let Ok(out) = git_capture(repo, &["diff", "--numstat", "--no-renames", before, after]) else {
        return;
    };
    let counts: HashMap<&str, (u32, u32)> = out
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let added = parts.next()?.parse().unwrap_or(0);
            let removed = parts.next()?.parse().unwrap_or(0);
            Some((parts.next()?, (added, removed)))
        })
        .collect();
    for f in files {
        if let Some((added, removed)) = counts.get(f.path.as_str()) {
            f.added = *added;
            f.removed = *removed;
        }
    }
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
        return write_tree_scratch(repo, &checkpoint_index_path(session_id, repo));
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
#[tauri::command(async)]
/// `others` names the sessions sharing this worktree, so a file more than one
/// of them wrote is marked rather than silently attributed to whichever asked.
pub fn checkpoint_turn_files(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    cumulative: Option<bool>,
    others: Option<Vec<String>>,
) -> Result<Vec<CheckpointFile>, String> {
    let Some(roots) = worktree_members(&repo_path) else {
        return turn_files_one(repo_path, session_id, prompt_ts, cumulative, others);
    };
    let mut out = Vec::new();
    for root in covering(&roots, &session_id, prompt_ts) {
        for mut f in turn_files_one(root.clone(), session_id.clone(), prompt_ts, cumulative, others.clone())? {
            f.path = absolute(root, &f.path);
            out.push(f);
        }
    }
    Ok(out)
}

fn turn_files_one(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    cumulative: Option<bool>,
    others: Option<Vec<String>>,
) -> Result<Vec<CheckpointFile>, String> {
    let checkpoints = list_checkpoints(&repo_path, &session_id);
    let before = tree_at_or_before(&checkpoints, prompt_ts);
    let after = diff_after(&repo_path, &session_id, &checkpoints, prompt_ts, cumulative)?;
    if before == after {
        return Ok(Vec::new());
    }
    let out = git_capture(&repo_path, &["diff", "--name-status", &before, &after])?;
    let mut files = attributed_files(
        &repo_path,
        &session_id,
        prompt_ts,
        parse_name_status(&out),
        &others.unwrap_or_default(),
    );
    count_lines(&repo_path, &before, &after, &mut files);
    Ok(files)
}

/// Narrow a whole-tree diff to what *this* session wrote, and mark what it
/// shares with another.
///
/// The tree says what changed; the session's own tool calls say what it wrote.
/// How the two combine depends on how much of the turn the tool calls actually
/// account for:
///
/// | State | Branch |
/// |---|---|
/// | `Complete` | filter the tree diff to the reported paths |
/// | `Partial` | the reported paths, **plus** tree changes no session claims |
/// | `Unmeasured` | do not filter at all |
///
/// `Partial` is the case a path parse cannot cover: a `Bash` heredoc really did
/// change a file and named it nowhere. Filtering it away drops the write from
/// the turn (and from revert); keeping the whole tree diff claims the other
/// session's concurrent edits. Consulting the *other* sessions' recorded sets
/// splits the difference honestly: a change no one claims is this turn's best
/// candidate, and is marked `unattributed` rather than asserted.
///
/// **A turn with no recorded set is not filtered.** That is a PTY session, or
/// any turn from before attribution existed, and an empty set there means "not
/// measured", never "wrote nothing" - filtering on it would silently blank out
/// every historical turn's file list.
fn attributed_files(
    repo: &str,
    session_id: &str,
    prompt_ts: u64,
    changed: Vec<CheckpointFile>,
    others: &[String],
) -> Vec<CheckpointFile> {
    let rec = read_touched(session_id, prompt_ts);
    let state = attribution_state(rec.as_ref());
    if state == AttributionState::Unmeasured {
        return changed;
    }
    let mine: std::collections::HashSet<String> = rec
        .iter()
        .flat_map(|r| r.files.iter())
        .filter_map(|p| relative_to(repo, p))
        .collect();

    // Only sessions whose own turn overlaps this one can share a file, so each
    // other session is checked at the turn it had running at `prompt_ts`.
    let other_sets: Vec<(String, std::collections::HashSet<String>)> = others
        .iter()
        .filter(|id| id.as_str() != session_id)
        .filter_map(|id| {
            let ts = overlapping_turn(id, prompt_ts)?;
            touched_set(repo, id, ts).map(|set| (id.clone(), set))
        })
        .collect();

    let claimed_by_another = |path: &str| other_sets.iter().any(|(_, set)| set.contains(path));

    changed
        .into_iter()
        .filter(|f| mine.contains(&f.path) || (state == AttributionState::Partial && !claimed_by_another(&f.path)))
        .map(|mut f| {
            f.unattributed = !mine.contains(&f.path);
            f.shared_with = other_sets
                .iter()
                .filter(|(_, set)| set.contains(&f.path))
                .map(|(id, _)| id.clone())
                .collect();
            f
        })
        .collect()
}

/// A session's recorded writes for one turn, repo-relative, or `None` when
/// nothing was recorded (see `attributed_files` for why the two differ).
fn touched_set(repo: &str, session_id: &str, prompt_ts: u64) -> Option<std::collections::HashSet<String>> {
    let rec = read_touched(session_id, prompt_ts)?;
    Some(rec.files.iter().filter_map(|p| relative_to(repo, p)).collect())
}

/// Everything `session_id` recorded writing from the turn at `from` onward,
/// repo-relative. `None` when it recorded nothing at all, which means "not
/// measured" and leaves the revert unscoped (see `checkpoint_revert_tree`).
///
/// Cumulative because reverting *to* a boundary undoes every turn after it, so
/// scoping to only that one turn's writes would leave the later turns' files
/// untouched and the revert half-applied.
fn touched_since(repo: &str, session_id: &str, from: u64) -> Option<std::collections::HashSet<String>> {
    let dir = attribution_path(session_id, 0).parent()?.to_path_buf();
    let mut out = std::collections::HashSet::new();
    let mut saw_any = false;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let Some(ts) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.strip_suffix(".json"))
            .and_then(|n| n.parse::<u64>().ok())
        else {
            continue;
        };
        if ts < from {
            continue;
        }
        let Some(rec) = read_touched(session_id, ts) else {
            continue;
        };
        saw_any = true;
        out.extend(rec.files.iter().filter_map(|p| relative_to(repo, p)));
    }
    saw_any.then_some(out)
}

/// The turn `other_session` had open at `at`: the latest turn it *recorded
/// writes for* at or before that moment.
///
/// Read from the attribution files rather than from that session's checkpoint
/// refs, because a checkpoint is skipped when it would duplicate the previous
/// tree - so a session can legitimately have written files during a turn that
/// has no ref of its own. Keying off the refs made the shared-file marker
/// silently empty in exactly that case.
fn overlapping_turn(other_session: &str, at: u64) -> Option<u64> {
    let dir = attribution_path(other_session, 0).parent()?.to_path_buf();
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            e.file_name()
                .to_str()
                .and_then(|n| n.strip_suffix(".json"))
                .and_then(|n| n.parse::<u64>().ok())
        })
        .filter(|ts| *ts <= at)
        .max()
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct CheckpointEntry {
    pub prompt_ts: u64,
    /// "" for a prompt-boundary snapshot, "backstop" for a pre-revert one.
    pub kind: String,
    /// The checkpoint a backstop was taken on the way to, when its ref says.
    pub target_ts: Option<u64>,
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
    let mut child = crate::exec::git_in(repo)
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

/// Every session with a checkpoint in this repository, so the timeline can
/// list more than the one that happens to be selected.
///
/// The refs live in the common dir, which every worktree of a bare repo
/// shares, so this names sessions from sibling worktrees too. The caller keeps
/// the ones whose folder is the one on screen; nothing here can tell.
#[tauri::command(async)]
pub fn checkpoint_sessions(repo_path: String) -> Result<Vec<String>, String> {
    const ROOT: &str = "refs/tori/checkpoint/";
    let roots = worktree_members(&repo_path).unwrap_or_else(|| vec![repo_path]);
    let mut ids = std::collections::BTreeSet::new();
    for root in roots.iter().filter(|r| is_git_worktree(r)) {
        let refs = git_capture(root, &["for-each-ref", "--format=%(refname)", ROOT])?;
        ids.extend(
            refs.lines()
                .filter_map(|name| name.strip_prefix(ROOT)?.rsplit_once('/'))
                .map(|(id, _)| id.to_string()),
        );
    }
    Ok(ids.into_iter().collect())
}

/// The session's checkpoints as an ordered timeline: prompt timestamp, kind,
/// how many files the turn starting there touched, and roughly how many bytes
/// it wrote. Empty (never an error) outside a git worktree or for a session
/// that has never snapshotted, so a non-repo folder simply shows no timeline.
#[tauri::command(async)]
pub fn checkpoint_list(repo_path: String, session_id: String) -> Result<Vec<CheckpointEntry>, String> {
    let Some(roots) = worktree_members(&repo_path) else {
        return list_one(repo_path, session_id);
    };
    let mut turns: std::collections::BTreeMap<(u64, String), CheckpointEntry> = Default::default();
    for root in &roots {
        for e in list_one(root.clone(), session_id.clone())? {
            let turn = turns.entry((e.prompt_ts, e.kind.clone())).or_insert(CheckpointEntry {
                file_count: 0,
                bytes: 0,
                ..e.clone()
            });
            turn.file_count += e.file_count;
            turn.bytes += e.bytes;
        }
    }
    Ok(turns.into_values().collect())
}

fn list_one(repo_path: String, session_id: String) -> Result<Vec<CheckpointEntry>, String> {
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
            target_ts: cp.target,
            file_count,
            bytes: blobs.iter().filter_map(|b| sizes.get(b)).sum(),
        })
        .collect())
}

/// Unified diff text for one file within a turn's checkpoint-to-checkpoint
/// range.
#[tauri::command(async)]
pub fn checkpoint_diff_file(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    file: String,
    cumulative: Option<bool>,
) -> Result<String, String> {
    let Some(roots) = worktree_members(&repo_path) else {
        return diff_file_one(repo_path, session_id, prompt_ts, file, cumulative);
    };
    let (root, rel) = in_member(&roots, &file)?;
    diff_file_one(root, session_id, prompt_ts, rel, cumulative)
}

fn diff_file_one(
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

/// The files and unified diff from the tree before the turn at `from_ts` to
/// the tree after the turn at `to_ts`, narrowed to the files some turn in that
/// span attributes to this session, the same way a single turn's list is.
pub fn checkpoint_range_diff(
    repo_path: &str,
    session_id: &str,
    from_ts: u64,
    to_ts: u64,
) -> Result<(Vec<CheckpointFile>, String), String> {
    let Some(roots) = worktree_members(repo_path) else {
        return range_diff_one(repo_path, session_id, from_ts, to_ts, false);
    };
    let mut files = Vec::new();
    let mut diff = String::new();
    for root in covering(&roots, session_id, from_ts) {
        let (f, d) = range_diff_one(root, session_id, from_ts, to_ts, true)?;
        files.extend(f.into_iter().map(|f| CheckpointFile {
            path: absolute(root, &f.path),
            ..f
        }));
        diff.push_str(&d);
    }
    Ok((files, diff))
}

fn range_diff_one(
    repo_path: &str,
    session_id: &str,
    from_ts: u64,
    to_ts: u64,
    absolute: bool,
) -> Result<(Vec<CheckpointFile>, String), String> {
    let checkpoints = list_checkpoints(repo_path, session_id);
    let before = tree_at_or_before(&checkpoints, from_ts);
    let after = tree_after(repo_path, session_id, &checkpoints, to_ts)?;
    let mut mine = std::collections::HashSet::new();
    for turn in checkpoints.iter().filter(|c| (from_ts..=to_ts).contains(&c.ts)) {
        let files = checkpoint_turn_files(repo_path.to_string(), session_id.to_string(), turn.ts, None, None)?;
        mine.extend(files.into_iter().map(|f| f.path));
    }
    let files: Vec<CheckpointFile> =
        parse_name_status(&git_capture(repo_path, &["diff", "--name-status", &before, &after])?)
            .into_iter()
            .filter(|f| mine.contains(&f.path))
            .collect();
    if files.is_empty() {
        return Ok((files, String::new()));
    }
    // Across several members, a hunk has to say whose file it is.
    let prefixes = [
        format!("--src-prefix=a{repo_path}/"),
        format!("--dst-prefix=b{repo_path}/"),
    ];
    let mut args = vec!["diff", "--no-color"];
    if absolute {
        args.extend(prefixes.iter().map(String::as_str));
    }
    args.extend([before.as_str(), after.as_str(), "--"]);
    args.extend(files.iter().map(|f| f.path.as_str()));
    let diff = git_output(repo_path, &args)?;
    Ok((files, diff))
}

fn tree_has_file(repo: &str, tree: &str, file: &str) -> Result<bool, String> {
    let out = crate::exec::git_in(repo)
        .args(["ls-tree", "--name-only", tree, "--", file])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(out.status.success() && !String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

/// Whether reverting `file` for this turn would undo a change this session
/// never established it made: the turn is graded, and the file is not among the
/// paths it reported. False for an unmeasured turn, which has no attribution to
/// contradict.
fn is_unattributed(repo: &str, session_id: &str, prompt_ts: u64, file: &str) -> bool {
    let rec = read_touched(session_id, prompt_ts);
    if attribution_state(rec.as_ref()) == AttributionState::Unmeasured {
        return false;
    }
    !rec.iter()
        .flat_map(|r| r.files.iter())
        .filter_map(|p| relative_to(repo, p))
        .any(|p| p == file)
}

/// Revert one file to its state *before* the turn starting at `prompt_ts`:
/// edited -> restore the pre-turn blob; created during the turn -> delete it;
/// deleted during the turn -> recreate it from the pre-turn blob. Returns
/// which action was taken ("restored" | "deleted" | "recreated").
///
/// **Refuses an unattributed file unless `force`.** On a partial turn the list
/// includes changes no session claims, on the reasoning that this session's own
/// shell write is the likeliest author - likeliest, not established. If the
/// author was in fact a live agent in the same folder, reverting undoes work in
/// flight, and the backstop restores the bytes but not that agent's belief
/// about them. So the default is to refuse and name the file; `force` is the
/// separate per-file confirmation the caller collects.
#[tauri::command]
pub async fn checkpoint_revert_file(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    file: String,
    force: Option<bool>,
) -> Result<String, String> {
    crate::exec::git_write("checkpoint_revert_file", repo_path.clone(), move || {
        checkpoint_revert_file_body(repo_path, session_id, prompt_ts, file, force)
    })
    .await
}

pub(crate) fn checkpoint_revert_file_body(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    file: String,
    force: Option<bool>,
) -> Result<String, String> {
    let Some(roots) = worktree_members(&repo_path) else {
        return revert_file_one(repo_path, session_id, prompt_ts, file, force);
    };
    let (root, rel) = in_member(&roots, &file)?;
    let lock = crate::exec::repo_lock(&root);
    let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    revert_file_one(root, session_id, prompt_ts, rel, force)
}

fn revert_file_one(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    file: String,
    force: Option<bool>,
) -> Result<String, String> {
    if !force.unwrap_or(false) && is_unattributed(&repo_path, &session_id, prompt_ts, &file) {
        return Err(format!(
            "\"{file}\" changed during this turn, but nothing recorded which session wrote it. Reverting it may undo another agent's work in this folder. Confirm this file on its own to revert it anyway."
        ));
    }
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
    let out = crate::exec::git_in(&repo_path)
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
    Ok(if exists_after {
        "restored".into()
    } else {
        "recreated".into()
    })
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
pub(crate) struct RawChange {
    pub(crate) dst_mode: String,
    dst_sha: String,
    pub(crate) path: String,
}

pub(crate) fn parse_raw_change(line: &str) -> Option<RawChange> {
    let (meta, path) = line.split_once('\t')?;
    let mut fields = meta.split_whitespace();
    let _src_mode = fields.next()?;
    let dst_mode = fields.next()?.to_string();
    let _src_sha = fields.next()?;
    let dst_sha = fields.next()?.to_string();
    Some(RawChange {
        dst_mode,
        dst_sha,
        path: path.to_string(),
    })
}

/// Write a blob from the object store to `abs`, honouring the tree's mode:
/// a `120000` entry is a symlink (its blob content is the link target, which
/// must not be written as a regular file), `100755` keeps the exec bit.
pub(crate) fn write_blob_to_disk(repo: &str, change: &RawChange, abs: &Path) -> Result<(), String> {
    let out = crate::exec::git_in(repo)
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
    target: u64,
) -> Result<u64, String> {
    let mut ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    while checkpoints.iter().any(|c| c.ts == ts) {
        ts += 1;
    }
    git_run(repo, &["update-ref", &backstop_ref_name(session_id, ts, target), tree])?;
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
/// Undo a turn.
///
/// **Scoped to what this session actually wrote**, when it recorded that. The
/// tree snapshot spans the whole worktree, so a bare tree-vs-tree restore in a
/// worktree with two live chats would roll back the *other* session's
/// concurrent edits as a side effect of undoing this one's turn - silently, and
/// with no way for the user to have known.
///
/// `shared` names files another session also wrote, which the caller has already
/// confirmed with the user: they are reverted, but only because that decision
/// was made above rather than here.
///
/// A turn with no recorded set is unscoped, exactly as before. That is the PTY
/// case, where the tree is the only evidence there is.
///
/// Scoping to the recorded set also means a partial turn's **unattributed**
/// candidates are left on disk: they are listed in `checkpoint_turn_files` so
/// the caller can name them, and reverted only one at a time through
/// `checkpoint_revert_file`'s `force`, never in bulk here.
pub async fn checkpoint_revert_tree(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    shared: Option<Vec<String>>,
) -> Result<RevertOutcome, String> {
    crate::exec::git_write("checkpoint_revert_tree", repo_path.clone(), move || {
        checkpoint_revert_tree_body(repo_path, session_id, prompt_ts, shared)
    })
    .await
}

pub(crate) fn checkpoint_revert_tree_body(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    shared: Option<Vec<String>>,
) -> Result<RevertOutcome, String> {
    match worktree_members(&repo_path) {
        Some(roots) => revert_members(&session_id, &roots, prompt_ts, &shared.unwrap_or_default()),
        None => revert_tree_one(repo_path, session_id, prompt_ts, shared, true),
    }
}

fn revert_members(
    session_id: &str,
    roots: &[String],
    prompt_ts: u64,
    shared: &[String],
) -> Result<RevertOutcome, String> {
    let roots = covering(roots, session_id, prompt_ts);
    if roots.is_empty() {
        return Err("No worktree in this Topic has a checkpoint at that point in the timeline.".into());
    }
    // Checked for every member before any is written, so a member that cannot
    // be reverted stops the rewind rather than leaving it half applied.
    if let Some(root) = roots.iter().find(|r| !is_git_worktree(r)) {
        return Err(format!(
            "{root} isn't a git repository any more, so nothing was rewound."
        ));
    }
    let mut out = RevertOutcome {
        backstop_ts: None,
        restored: Vec::new(),
        deleted: Vec::new(),
    };
    for root in roots {
        let here = shared.iter().filter_map(|f| relative_to(root, f)).collect();
        let lock = crate::exec::repo_lock(root);
        let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let one = revert_tree_one(root.clone(), session_id.to_string(), prompt_ts, Some(here), false)?;
        out.backstop_ts = out.backstop_ts.or(one.backstop_ts);
        out.restored.extend(one.restored.iter().map(|p| absolute(root, p)));
        out.deleted.extend(one.deleted.iter().map(|p| absolute(root, p)));
    }
    Ok(out)
}

fn revert_tree_one(
    repo_path: String,
    session_id: String,
    prompt_ts: u64,
    shared: Option<Vec<String>>,
    exact: bool,
) -> Result<RevertOutcome, String> {
    if !is_git_worktree(&repo_path) {
        return Err("This folder isn't a git repository, so it has no checkpoints.".into());
    }
    let checkpoints = list_checkpoints(&repo_path, &session_id);
    let target = checkpoints
        .iter()
        .rev()
        // A member's snapshot at `prompt_ts` is skipped when it had not
        // changed, which leaves the earlier tree as its state then.
        .find(|c| if exact { c.ts == prompt_ts } else { c.ts <= prompt_ts })
        .map(|c| c.tree.clone())
        .ok_or("No checkpoint at that point in the timeline.")?;
    let current = write_tree_scratch(&repo_path, &checkpoint_index_path(&session_id, &repo_path))?;
    if current == target {
        return Ok(RevertOutcome {
            backstop_ts: None,
            restored: Vec::new(),
            deleted: Vec::new(),
        });
    }
    // Backstop before any write: if a later step fails, the pre-revert state
    // is already recoverable from the timeline.
    let backstop_ts = write_backstop(&repo_path, &session_id, &checkpoints, &current, prompt_ts)?;

    let raw = git_capture(
        &repo_path,
        &["diff", "--raw", "--no-abbrev", "--no-renames", &current, &target],
    )?;
    // The turn's attributed set, cumulative over every turn from `prompt_ts`
    // onward: reverting *to* a boundary undoes everything since, so the scope is
    // everything this session wrote since, not just its next turn.
    let mine = touched_since(&repo_path, &session_id, prompt_ts);
    let shared: std::collections::HashSet<String> = shared.unwrap_or_default().into_iter().collect();

    let mut restored = Vec::new();
    let mut deleted = Vec::new();
    for line in raw.lines() {
        let Some(change) = parse_raw_change(line) else { continue };
        // Another session's concurrent edit to a file this one never touched is
        // left exactly where it is. Without this the undo would reach across
        // sessions and nothing on screen would have said so.
        if let Some(mine) = &mine {
            if !mine.contains(&change.path) && !shared.contains(&change.path) {
                continue;
            }
        }
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
    Ok(RevertOutcome {
        backstop_ts: Some(backstop_ts),
        restored,
        deleted,
    })
}

fn prune_refs(repo_path: &str, session_id: &str) {
    let Ok(out) = crate::exec::git_in(repo_path)
        .args(["for-each-ref", "--format=%(refname)", &ref_prefix(session_id)])
        .output()
    else {
        return;
    };
    if !out.status.success() {
        return;
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let _ = crate::exec::git_in(repo_path).args(["update-ref", "-d", line]).output();
    }
}

/// Remove every checkpoint ref and the scratch index file for a session,
/// called on session delete/archive so `refs/tori/checkpoint/*` doesn't grow
/// unbounded.
#[tauri::command]
pub async fn checkpoint_prune(repo_path: String, session_id: String) -> Result<(), String> {
    crate::exec::git_write("checkpoint_prune", repo_path.clone(), move || {
        checkpoint_prune_body(repo_path, session_id)
    })
    .await
}

pub(crate) fn checkpoint_prune_body(repo_path: String, session_id: String) -> Result<(), String> {
    // Every member, references too: a reference is the repo's own checkout,
    // which shares its ref store with the worktree it may once have been.
    let topics = crate::unit_home::topics();
    let roots = match crate::topic_home::topic_at_home(&topics, &repo_path) {
        Some(topic) => crate::topic_home::roots_of(topic),
        None => vec![repo_path],
    };
    for root in &roots {
        prune_refs(root, &session_id);
    }
    remove_indexes(&session_id);
    // The per-turn attribution sets go with the refs they are named after.
    // Left behind, they would attribute a future session that happened to reuse
    // the id, and they are meaningless without the checkpoints anyway.
    if let Some(dir) = attribution_path(&session_id, 0).parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

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

    fn tmp_repo() -> (PathBuf, String) {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori_checkpoint_test_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let session_id = format!("sess-{n}-{seq}");
        (dir, session_id)
    }

    fn cleanup(dir: &Path, session_id: &str) {
        std::fs::remove_dir_all(dir).ok();
        remove_indexes(session_id);
        if let Some(d) = attribution_path(session_id, 0).parent() {
            std::fs::remove_dir_all(d).ok();
        }
    }

    #[test]
    fn a_files_turns_are_found_without_opening_every_turns_record() {
        // 200 turns, three of which wrote the file. The lookup costs one read,
        // proven by deleting every per-turn record first: an answer that still
        // arrives cannot have come from scanning them.
        let (dir, session) = tmp_repo();
        let file = dir.join("a.ts").to_string_lossy().into_owned();
        let other = dir.join("b.ts").to_string_lossy().into_owned();
        for i in 0..200u64 {
            let wrote = if i == 3 || i == 77 || i == 150 { &file } else { &other };
            checkpoint_note_touched(session.clone(), 1000 + i, "Edit".into(), vec![wrote.clone()]).unwrap();
        }
        let records = attribution_path(&session, 0).parent().unwrap().to_path_buf();
        for entry in std::fs::read_dir(&records).unwrap().flatten() {
            if entry.file_name() != "index.json" {
                std::fs::remove_file(entry.path()).unwrap();
            }
        }

        let turns = turns_touching(&session, &file);

        assert_eq!(
            turns.iter().map(|t| t.prompt_ts).collect::<Vec<_>>(),
            vec![1003, 1077, 1150]
        );
        // The session's own numbering, not a count of the three: the widget says
        // "turn 4", and turn 4 is what the timeline calls it too.
        assert_eq!(turns[0].ordinal, 4);
        assert_eq!(turns[2].ordinal, 151);
        assert!(turns_touching(&session, &dir.join("never.ts").to_string_lossy()).is_empty());
        cleanup(&dir, &session);
    }

    #[test]
    fn a_session_recorded_before_the_index_existed_is_indexed_once_on_demand() {
        // Without this every session from before this feature reads as having
        // written nothing, which looks exactly like an agent that wrote nothing.
        let (dir, session) = tmp_repo();
        let file = dir.join("a.ts").to_string_lossy().into_owned();
        checkpoint_note_touched(session.clone(), 1000, "Edit".into(), vec![file.clone()]).unwrap();
        checkpoint_note_touched(session.clone(), 2000, "Edit".into(), vec![file.clone()]).unwrap();
        std::fs::remove_file(touched_index_path(&session)).unwrap();
        assert!(turns_touching(&session, &file).is_empty(), "no index, no answer");

        rebuild_touched_index(&session);

        assert_eq!(turns_touching(&session, &file).len(), 2);
        cleanup(&dir, &session);
    }

    #[test]
    fn a_turn_that_named_no_file_still_takes_its_place_in_the_numbering() {
        // A Bash-only turn writes nothing this can see, but it is still a turn:
        // skipping it would shift every later turn's number by one.
        let (dir, session) = tmp_repo();
        let file = dir.join("a.ts").to_string_lossy().into_owned();
        checkpoint_note_touched(session.clone(), 1000, "Bash".into(), vec![]).unwrap();
        checkpoint_note_touched(session.clone(), 2000, "Edit".into(), vec![file.clone()]).unwrap();

        assert_eq!(turns_touching(&session, &file)[0].ordinal, 2);
        cleanup(&dir, &session);
    }

    /// Each tool call a capture's turn made, as `(tool name, reported paths)`,
    /// paired by `tool_use_id` the same way the chat panel pairs them: the name
    /// arrives only on the start event and the paths only on the completion.
    ///
    /// Driven from the real captures rather than hand-written literals, so what
    /// the tests assert about attribution is what `claude` actually reports.
    fn recorded_calls(fixtures: &[&str]) -> Vec<(String, Vec<String>)> {
        use crate::chat::model::ChatEvent;
        let mut names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut out = Vec::new();
        for fixture in fixtures {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("dev/fixtures/claude")
                .join(format!("{fixture}.jsonl"));
            let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            let mut mapper = crate::chat::claude::ClaudeMapper::new("s1");
            for line in raw.lines().filter(|l| !l.trim().is_empty()) {
                let frame: serde_json::Value = serde_json::from_str(line).expect("fixture line is json");
                for ev in mapper.map(&frame) {
                    match ev {
                        ChatEvent::ToolCallStarted { tool_use_id, name, .. } => {
                            names.insert(tool_use_id, name);
                        }
                        ChatEvent::ToolCallCompleted { tool_use_id, files, .. } => {
                            out.push((names.get(&tool_use_id).cloned().unwrap_or_default(), files));
                        }
                        _ => {}
                    }
                }
            }
        }
        out
    }

    // --- per-turn attribution, the concurrent-worktree case ----------------
    //
    // The hazard these pin: a whole-tree `git add -A` snapshot cannot say which
    // of two live sessions wrote a file, so before attribution each session's
    // "changes this turn" included the other's edits.

    /// One turn writing file A through `Edit` and file B through `Bash`.
    ///
    /// `edit-call.jsonl` reports its target on `tool_use_result`; `bash-call.jsonl`
    /// reports nothing at all, because a shell write has no path argument to
    /// parse. Both files really changed, so both belong in the turn's list.
    /// Filtering the tree diff down to the reported paths **drops file B**,
    /// which is the bug this phase exists to close.
    #[test]
    fn a_turn_mixing_edit_and_bash_lists_both_files() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("probe.txt"), "alpha\nbeta\ngamma\n").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();

        // File A, rewritten by `Edit`; file B, written by the shell.
        std::fs::write(dir.join("probe.txt"), "alpha\ndelta\ngamma\n").unwrap();
        std::fs::write(dir.join("from-bash.txt"), "tori-probe\n").unwrap();

        for (tool, files) in recorded_calls(&["edit-call", "bash-call"]) {
            let abs = files
                .iter()
                .map(|p| dir.join(p).to_string_lossy().into_owned())
                .collect();
            checkpoint_note_touched(sid.clone(), 100, tool, abs).unwrap();
        }

        let files = checkpoint_turn_files(repo.clone(), sid.clone(), 100, Some(true), None).unwrap();
        let mut names: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        names.sort();
        assert_eq!(
            names,
            ["from-bash.txt", "probe.txt"],
            "the shell-written file changed during this turn and no other session claims it"
        );

        cleanup(&dir, &sid);
    }

    /// A turn whose only tool was `Bash` recorded nothing at all before, which
    /// is indistinguishable from a PTY turn - so it took the unfiltered branch
    /// and presented a *concurrent session's* edits as its own.
    #[test]
    fn a_bash_only_turn_is_recorded_rather_than_leaving_no_trace() {
        let (dir, sid) = tmp_repo();

        for (tool, files) in recorded_calls(&["bash-call"]) {
            assert!(files.is_empty(), "a shell call reports no path, which is the point");
            checkpoint_note_touched(sid.clone(), 100, tool, files).unwrap();
        }

        let rec = read_touched(&sid, 100).expect("the shell call left a record");
        assert_eq!(rec.tools, ["Bash"]);
        assert!(rec.files.is_empty());
        assert_eq!(attribution_state(Some(&rec)), AttributionState::Partial);

        cleanup(&dir, &sid);
    }

    /// The three grades, each from the evidence that produces it.
    #[test]
    fn attribution_grades_a_turn_by_the_tools_it_ran() {
        let (dir, sid) = tmp_repo();

        // A PTY turn, or any turn from before attribution existed.
        assert_eq!(
            attribution_state(read_touched(&sid, 100).as_ref()),
            AttributionState::Unmeasured
        );

        // Every tool reported its own paths.
        checkpoint_note_touched(
            sid.clone(),
            100,
            "Edit".into(),
            vec![dir.join("a.txt").to_string_lossy().into_owned()],
        )
        .unwrap();
        assert_eq!(
            attribution_state(read_touched(&sid, 100).as_ref()),
            AttributionState::Complete
        );

        // One shell call is enough to make the whole turn a lower bound.
        checkpoint_note_touched(sid.clone(), 100, "Bash".into(), vec![]).unwrap();
        assert_eq!(
            attribution_state(read_touched(&sid, 100).as_ref()),
            AttributionState::Partial
        );

        cleanup(&dir, &sid);
    }

    /// A record written before tool names existed cannot claim completeness: it
    /// was produced by the code that could not see a shell write in the first
    /// place, so grading it `Complete` would assert exactly what was never
    /// measured.
    #[test]
    fn a_pre_tool_name_record_grades_partial_rather_than_complete() {
        let (dir, sid) = tmp_repo();
        let path = attribution_path(&sid, 100);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"["/tmp/a.txt"]"#).unwrap();

        let rec = read_touched(&sid, 100).expect("the old shape is still readable");
        assert_eq!(rec.files, ["/tmp/a.txt"]);
        assert_eq!(attribution_state(Some(&rec)), AttributionState::Partial);

        cleanup(&dir, &sid);
    }

    /// The partial branch, with a second chat in the same worktree.
    ///
    /// A change no session claims is this turn's own unparseable write and is
    /// listed, marked. A change the *other* session claims stays out, exactly as
    /// under the complete branch - "partial" widens the list to unowned files,
    /// never to owned ones.
    #[test]
    fn a_partial_turn_claims_only_files_no_other_session_owns() {
        let (dir, a) = tmp_repo();
        let b = format!("{a}-b");
        let repo = dir.to_string_lossy().into_owned();

        checkpoint_snapshot_body(a.clone(), repo.clone(), 100).unwrap();
        checkpoint_snapshot_body(b.clone(), repo.clone(), 100).unwrap();

        std::fs::write(dir.join("edited-by-a.txt"), "from a").unwrap();
        std::fs::write(dir.join("shell-written.txt"), "from a's heredoc").unwrap();
        std::fs::write(dir.join("edited-by-b.txt"), "from b").unwrap();

        // A's turn: one `Edit` it can name, one `Bash` it cannot.
        checkpoint_note_touched(
            a.clone(),
            100,
            "Edit".into(),
            vec![dir.join("edited-by-a.txt").to_string_lossy().into_owned()],
        )
        .unwrap();
        checkpoint_note_touched(a.clone(), 100, "Bash".into(), vec![]).unwrap();
        // B's turn, entirely path-parseable.
        checkpoint_note_touched(
            b.clone(),
            100,
            "Edit".into(),
            vec![dir.join("edited-by-b.txt").to_string_lossy().into_owned()],
        )
        .unwrap();

        let for_a = checkpoint_turn_files(repo.clone(), a.clone(), 100, Some(true), Some(vec![b.clone()])).unwrap();
        let mut names: Vec<_> = for_a.iter().map(|f| f.path.as_str()).collect();
        names.sort();
        assert_eq!(names, ["edited-by-a.txt", "shell-written.txt"]);
        assert!(!for_a.iter().find(|f| f.path == "edited-by-a.txt").unwrap().unattributed);
        assert!(
            for_a
                .iter()
                .find(|f| f.path == "shell-written.txt")
                .unwrap()
                .unattributed,
            "likely a's shell write, but nothing established it - so it is marked, not asserted"
        );

        cleanup(&dir, &a);
        cleanup(&dir, &b);
    }

    /// A whole-tree revert is scoped to what the session *recorded* writing, so
    /// a partial turn's unattributed candidate is left on disk rather than
    /// undone on a guess.
    #[test]
    fn a_tree_revert_leaves_an_unattributed_file_alone() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("mine.txt"), "before").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "base"]);
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();

        std::fs::write(dir.join("mine.txt"), "after").unwrap();
        std::fs::write(dir.join("who-wrote-this.txt"), "nobody claims this").unwrap();
        checkpoint_note_touched(
            sid.clone(),
            100,
            "Edit".into(),
            vec![dir.join("mine.txt").to_string_lossy().into_owned()],
        )
        .unwrap();
        checkpoint_note_touched(sid.clone(), 100, "Bash".into(), vec![]).unwrap();

        let out = checkpoint_revert_tree_body(repo.clone(), sid.clone(), 100, None).unwrap();
        assert_eq!(out.restored, ["mine.txt"]);
        assert!(out.deleted.is_empty());
        assert!(
            dir.join("who-wrote-this.txt").exists(),
            "an unowned change may be a live agent's; the backstop restores bytes, not its context"
        );

        cleanup(&dir, &sid);
    }

    /// The per-file revert refuses the same file, and takes it only when the
    /// caller answers for that file specifically.
    #[test]
    fn a_file_revert_refuses_an_unattributed_file_until_it_is_forced() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();

        std::fs::write(dir.join("who-wrote-this.txt"), "nobody claims this").unwrap();
        checkpoint_note_touched(sid.clone(), 100, "Bash".into(), vec![]).unwrap();

        let refused = checkpoint_revert_file_body(repo.clone(), sid.clone(), 100, "who-wrote-this.txt".into(), None);
        assert!(
            refused.unwrap_err().contains("who-wrote-this.txt"),
            "the refusal names the file"
        );
        assert!(dir.join("who-wrote-this.txt").exists());

        let forced =
            checkpoint_revert_file_body(repo.clone(), sid.clone(), 100, "who-wrote-this.txt".into(), Some(true))
                .unwrap();
        assert_eq!(forced, "deleted");
        assert!(!dir.join("who-wrote-this.txt").exists());

        cleanup(&dir, &sid);
    }

    /// Two chats editing different files in one worktree each see only their own.
    #[test]
    fn two_sessions_in_one_worktree_each_see_only_their_own_files() {
        let (dir, a) = tmp_repo();
        let b = format!("{a}-b");
        let repo = dir.to_string_lossy().into_owned();

        // Both sessions open a turn at the same boundary.
        checkpoint_snapshot_body(a.clone(), repo.clone(), 100).unwrap();
        checkpoint_snapshot_body(b.clone(), repo.clone(), 100).unwrap();

        // Each writes its own file, and each reports what it wrote.
        std::fs::write(dir.join("a.txt"), "from a").unwrap();
        std::fs::write(dir.join("b.txt"), "from b").unwrap();
        checkpoint_note_touched(
            a.clone(),
            100,
            "Edit".into(),
            vec![dir.join("a.txt").to_string_lossy().into_owned()],
        )
        .unwrap();
        checkpoint_note_touched(
            b.clone(),
            100,
            "Edit".into(),
            vec![dir.join("b.txt").to_string_lossy().into_owned()],
        )
        .unwrap();

        let for_a = checkpoint_turn_files(repo.clone(), a.clone(), 100, Some(true), Some(vec![b.clone()])).unwrap();
        let for_b = checkpoint_turn_files(repo.clone(), b.clone(), 100, Some(true), Some(vec![a.clone()])).unwrap();

        assert_eq!(for_a.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt"]);
        assert_eq!(for_b.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["b.txt"]);
        // Disjoint work is not shared work.
        assert!(for_a[0].shared_with.is_empty());
        assert!(for_b[0].shared_with.is_empty());

        cleanup(&dir, &a);
        cleanup(&dir, &b);
    }

    /// The case the plan calls out by name: both sessions wrote the same file.
    /// It must appear in **both** turns, marked, rather than being silently
    /// attributed to whichever asked first - both of them really did write it,
    /// and picking one would be a guess presented as a fact.
    #[test]
    fn a_file_both_sessions_wrote_appears_in_both_with_a_shared_marker() {
        let (dir, a) = tmp_repo();
        let b = format!("{a}-b");
        let repo = dir.to_string_lossy().into_owned();

        checkpoint_snapshot_body(a.clone(), repo.clone(), 100).unwrap();
        checkpoint_snapshot_body(b.clone(), repo.clone(), 100).unwrap();

        std::fs::write(dir.join("shared.txt"), "both touched this").unwrap();
        std::fs::write(dir.join("only-a.txt"), "just a").unwrap();
        let shared = dir.join("shared.txt").to_string_lossy().into_owned();
        checkpoint_note_touched(
            a.clone(),
            100,
            "Edit".into(),
            vec![shared.clone(), dir.join("only-a.txt").to_string_lossy().into_owned()],
        )
        .unwrap();
        checkpoint_note_touched(b.clone(), 100, "Edit".into(), vec![shared.clone()]).unwrap();

        let for_a = checkpoint_turn_files(repo.clone(), a.clone(), 100, Some(true), Some(vec![b.clone()])).unwrap();
        let for_b = checkpoint_turn_files(repo.clone(), b.clone(), 100, Some(true), Some(vec![a.clone()])).unwrap();

        let a_shared = for_a
            .iter()
            .find(|f| f.path == "shared.txt")
            .expect("shared file present for a");
        let b_shared = for_b
            .iter()
            .find(|f| f.path == "shared.txt")
            .expect("shared file present for b");
        assert_eq!(a_shared.shared_with, vec![b.clone()]);
        assert_eq!(b_shared.shared_with, vec![a.clone()]);
        // The file only one of them wrote is not marked.
        let a_only = for_a
            .iter()
            .find(|f| f.path == "only-a.txt")
            .expect("a's own file present");
        assert!(a_only.shared_with.is_empty());
        assert!(!for_b.iter().any(|f| f.path == "only-a.txt"));

        cleanup(&dir, &a);
        cleanup(&dir, &b);
    }

    /// A turn nothing recorded is **not** filtered. That is every PTY session
    /// and every turn from before attribution existed; treating an empty set as
    /// "wrote nothing" would blank out their file lists entirely, which looks
    /// exactly like a working feature reporting no changes.
    #[test]
    fn a_turn_with_no_recorded_writes_falls_back_to_the_whole_tree_diff() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("untracked-by-events.txt"), "written by a PTY agent").unwrap();

        let files = checkpoint_turn_files(repo.clone(), sid.clone(), 100, Some(true), None).unwrap();
        assert_eq!(
            files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["untracked-by-events.txt"]
        );

        cleanup(&dir, &sid);
    }

    /// The tree still decides *what* changed. A file the session reported
    /// writing but which ended the turn identical to how it started is not in
    /// the diff, so it is not in the list either - the events narrow the tree's
    /// answer, they do not replace it.
    #[test]
    fn attribution_narrows_the_tree_diff_rather_than_replacing_it() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("unchanged.txt"), "same").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();

        // Reported as written, but rewritten with identical content.
        std::fs::write(dir.join("unchanged.txt"), "same").unwrap();
        checkpoint_note_touched(
            sid.clone(),
            100,
            "Edit".into(),
            vec![dir.join("unchanged.txt").to_string_lossy().into_owned()],
        )
        .unwrap();

        let files = checkpoint_turn_files(repo.clone(), sid.clone(), 100, Some(true), None).unwrap();
        assert!(files.is_empty(), "a file whose content did not change is not a change");

        cleanup(&dir, &sid);
    }

    #[test]
    fn recorded_writes_accumulate_across_a_turns_tool_calls() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("one.txt"), "1").unwrap();
        std::fs::write(dir.join("two.txt"), "2").unwrap();

        // A turn makes many tool calls; each reports only its own paths.
        checkpoint_note_touched(
            sid.clone(),
            100,
            "Edit".into(),
            vec![dir.join("one.txt").to_string_lossy().into_owned()],
        )
        .unwrap();
        checkpoint_note_touched(
            sid.clone(),
            100,
            "Edit".into(),
            vec![dir.join("two.txt").to_string_lossy().into_owned()],
        )
        .unwrap();

        let files = checkpoint_turn_files(repo.clone(), sid.clone(), 100, Some(true), None).unwrap();
        let mut names: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        names.sort();
        assert_eq!(names, ["one.txt", "two.txt"]);

        cleanup(&dir, &sid);
    }

    #[test]
    fn snapshot_captures_untracked_files() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let created = checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
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
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
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

        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();

        let after_status = git_capture(&repo, &["status", "--porcelain"]).unwrap();
        assert_eq!(
            before_status, after_status,
            "the user's real index/staging must be untouched"
        );
        cleanup(&dir, &sid);
    }

    #[test]
    fn unchanged_tree_creates_no_new_ref() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        assert!(checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap());
        // No file changes since the last snapshot: the next boundary is a no-op.
        assert!(!checkpoint_snapshot_body(sid.clone(), repo.clone(), 200).unwrap());
        assert_eq!(list_checkpoints(&repo, &sid).len(), 1);
        cleanup(&dir, &sid);
    }

    #[test]
    fn changed_tree_creates_a_new_ref() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("a.txt"), "hello world").unwrap();
        assert!(checkpoint_snapshot_body(sid.clone(), repo.clone(), 200).unwrap());
        assert_eq!(list_checkpoints(&repo, &sid).len(), 2);
        cleanup(&dir, &sid);
    }

    #[test]
    fn non_repo_folder_snapshots_nothing_without_error() {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori_not_a_repo_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        let sid = format!("sess-plain-{n}-{seq}");
        let repo = dir.to_string_lossy().into_owned();
        let result = checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
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
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("b.txt"), "bb").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 200).unwrap();
        std::fs::write(dir.join("c.txt"), "ccc").unwrap();
        std::fs::write(dir.join("d.txt"), "dddd").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 300).unwrap();

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
        let dir = std::env::temp_dir().join(format!("tori_list_not_a_repo_{n}_{seq}"));
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
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("bash_written.txt"), "written by a shell redirect").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 200).unwrap();

        let files = checkpoint_turn_files(repo.clone(), sid.clone(), 100, None, None).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "bash_written.txt");
        assert_eq!(files[0].status, "added");
        cleanup(&dir, &sid);
    }

    #[test]
    fn latest_turn_diffs_against_a_live_snapshot() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("mid_turn.txt"), "still running").unwrap();
        // No next prompt boundary yet: the diff still reflects the live tree.
        let files = checkpoint_turn_files(repo.clone(), sid.clone(), 100, None, None).unwrap();
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
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("a.txt"), "after").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 200).unwrap();

        let action = checkpoint_revert_file_body(repo.clone(), sid.clone(), 100, "a.txt".into(), None).unwrap();
        assert_eq!(action, "restored");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "before");
        assert_eq!(std::fs::read_to_string(dir.join("untouched.txt")).unwrap(), "stays");
        cleanup(&dir, &sid);
    }

    /// The blast radius the whole-tree snapshot used to have. Reverting session
    /// A's turn must leave session B's concurrent edits to *other* files exactly
    /// where they are - the snapshot spans the worktree, so without scoping the
    /// undo silently rolls back work nobody asked it to.
    #[test]
    fn reverting_one_session_leaves_another_sessions_files_untouched() {
        let (dir, a) = tmp_repo();
        let b = format!("{a}-b");
        let repo = dir.to_string_lossy().into_owned();

        std::fs::write(dir.join("a.txt"), "a before").unwrap();
        std::fs::write(dir.join("b.txt"), "b before").unwrap();
        checkpoint_snapshot_body(a.clone(), repo.clone(), 100).unwrap();

        // Both sessions write in the same interval; each reports its own paths.
        std::fs::write(dir.join("a.txt"), "a after").unwrap();
        std::fs::write(dir.join("b.txt"), "b after").unwrap();
        checkpoint_note_touched(
            a.clone(),
            100,
            "Edit".into(),
            vec![dir.join("a.txt").to_string_lossy().into_owned()],
        )
        .unwrap();
        checkpoint_note_touched(
            b.clone(),
            100,
            "Edit".into(),
            vec![dir.join("b.txt").to_string_lossy().into_owned()],
        )
        .unwrap();

        let out = checkpoint_revert_tree_body(repo.clone(), a.clone(), 100, None).unwrap();
        assert_eq!(out.restored, ["a.txt"]);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a before");
        // B's concurrent edit survives, which is the whole point.
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "b after");

        cleanup(&dir, &a);
        cleanup(&dir, &b);
    }

    /// A shared file is reverted only when the caller passes it, which it does
    /// after confirming with the user. Left out, it is treated like any other
    /// file this session does not solely own.
    #[test]
    fn a_shared_file_is_reverted_only_when_the_caller_confirmed_it() {
        let (dir, a) = tmp_repo();
        let b = format!("{a}-b");
        let repo = dir.to_string_lossy().into_owned();

        std::fs::write(dir.join("shared.txt"), "before").unwrap();
        checkpoint_snapshot_body(a.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("shared.txt"), "after").unwrap();

        let shared_abs = dir.join("shared.txt").to_string_lossy().into_owned();
        checkpoint_note_touched(a.clone(), 100, "Edit".into(), vec![shared_abs.clone()]).unwrap();
        checkpoint_note_touched(b.clone(), 100, "Edit".into(), vec![shared_abs]).unwrap();

        // Confirmed: it comes back.
        let out = checkpoint_revert_tree_body(repo.clone(), a.clone(), 100, Some(vec!["shared.txt".into()])).unwrap();
        assert_eq!(out.restored, ["shared.txt"]);
        assert_eq!(std::fs::read_to_string(dir.join("shared.txt")).unwrap(), "before");

        cleanup(&dir, &a);
        cleanup(&dir, &b);
    }

    /// A PTY session records nothing, so its revert stays unscoped - the tree is
    /// the only evidence there is, and scoping on an empty set would make revert
    /// silently do nothing.
    #[test]
    fn a_session_that_recorded_nothing_reverts_the_whole_tree_as_before() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("f.txt"), "before").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("f.txt"), "after").unwrap();

        let out = checkpoint_revert_tree_body(repo.clone(), sid.clone(), 100, None).unwrap();
        assert_eq!(out.restored, ["f.txt"]);
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "before");

        cleanup(&dir, &sid);
    }

    /// Reverting *to* a boundary undoes every turn after it, so the scope has to
    /// span them. Scoping to only the target turn's own writes would leave later
    /// turns' files on disk and the revert half-applied.
    #[test]
    fn reverting_to_a_boundary_scopes_across_every_later_turn() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("one.txt"), "before").unwrap();
        std::fs::write(dir.join("two.txt"), "before").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();

        // Turn at 100 wrote one.txt; a later turn at 200 wrote two.txt.
        std::fs::write(dir.join("one.txt"), "after").unwrap();
        checkpoint_note_touched(
            sid.clone(),
            100,
            "Edit".into(),
            vec![dir.join("one.txt").to_string_lossy().into_owned()],
        )
        .unwrap();
        std::fs::write(dir.join("two.txt"), "after").unwrap();
        checkpoint_note_touched(
            sid.clone(),
            200,
            "Edit".into(),
            vec![dir.join("two.txt").to_string_lossy().into_owned()],
        )
        .unwrap();

        let out = checkpoint_revert_tree_body(repo.clone(), sid.clone(), 100, None).unwrap();
        let mut restored = out.restored.clone();
        restored.sort();
        assert_eq!(restored, ["one.txt", "two.txt"]);

        cleanup(&dir, &sid);
    }

    #[test]
    fn a_rewind_puts_the_tree_back_exactly_as_the_checkpoint_recorded_it() {
        // The file list coming back right is not the same as the bytes coming
        // back right. Compared tree-to-tree, so a restore that wrote the wrong
        // content, or left a file the turn created behind, fails here instead
        // of looking correct in `restored`.
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("kept.txt"), "before").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        let target = list_checkpoints(&repo, &sid)
            .into_iter()
            .find(|c| c.ts == 100)
            .unwrap()
            .tree;

        // A turn that edited one file and created another.
        std::fs::write(dir.join("kept.txt"), "after").unwrap();
        std::fs::write(dir.join("made.txt"), "new").unwrap();
        checkpoint_note_touched(
            sid.clone(),
            100,
            "Edit".into(),
            vec![
                dir.join("kept.txt").to_string_lossy().into_owned(),
                dir.join("made.txt").to_string_lossy().into_owned(),
            ],
        )
        .unwrap();

        checkpoint_revert_tree_body(repo.clone(), sid.clone(), 100, None).unwrap();

        let now = write_tree_scratch(&repo, &checkpoint_index_path(&sid, &repo)).unwrap();
        assert_eq!(now, target);
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_created_file_deletes_it() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("new_file.txt"), "created this turn").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 200).unwrap();

        let action = checkpoint_revert_file_body(repo.clone(), sid.clone(), 100, "new_file.txt".into(), None).unwrap();
        assert_eq!(action, "deleted");
        assert!(!dir.join("new_file.txt").exists());
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_deleted_file_recreates_it() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("gone.txt"), "will be deleted").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 200).unwrap();

        let action = checkpoint_revert_file_body(repo.clone(), sid.clone(), 100, "gone.txt".into(), None).unwrap();
        assert_eq!(action, "recreated");
        assert_eq!(
            std::fs::read_to_string(dir.join("gone.txt")).unwrap(),
            "will be deleted"
        );
        cleanup(&dir, &sid);
    }

    #[test]
    fn cumulative_spans_every_turn_since_the_checkpoint() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("turn1.txt"), "one").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 200).unwrap();
        std::fs::write(dir.join("turn2.txt"), "two").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 300).unwrap();
        // An edit by someone other than the agent, after the last boundary.
        std::fs::write(dir.join("by_the_user.txt"), "mine").unwrap();

        // Per-turn stays scoped to its own boundary pair.
        let per_turn = checkpoint_turn_files(repo.clone(), sid.clone(), 100, None, None).unwrap();
        assert_eq!(
            per_turn.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["turn1.txt"]
        );

        // Cumulative runs from that boundary to the working tree, so it also
        // carries later turns *and* the user's own edit - which is exactly why
        // the UI calls it "workspace since here" rather than the session's work.
        let mut cumulative: Vec<String> = checkpoint_turn_files(repo.clone(), sid.clone(), 100, Some(true), None)
            .unwrap()
            .into_iter()
            .map(|f| f.path)
            .collect();
        cumulative.sort();
        assert_eq!(cumulative, vec!["by_the_user.txt", "turn1.txt", "turn2.txt"]);
        cleanup(&dir, &sid);
    }

    #[test]
    fn a_range_is_the_diff_between_its_outer_trees() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("base.txt"), "0").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("turn1.txt"), "one").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 200).unwrap();
        std::fs::write(dir.join("base.txt"), "2").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 300).unwrap();
        std::fs::write(dir.join("turn3.txt"), "three").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 400).unwrap();
        let trees = checkpoint_trees(&repo, &sid);

        let (files, diff) = checkpoint_range_diff(&repo, &sid, 100, 200).unwrap();
        let expected = git_output(&repo, &["diff", "--no-color", &trees[0].1, &trees[2].1]).unwrap();
        assert_eq!(diff, expected);
        let mut paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["base.txt", "turn1.txt"]);

        let (_, one) = checkpoint_range_diff(&repo, &sid, 100, 100).unwrap();
        assert_eq!(
            one,
            checkpoint_diff_file(repo.clone(), sid.clone(), 100, "turn1.txt".into(), None).unwrap()
        );
        cleanup(&dir, &sid);
    }

    #[test]
    fn revert_tree_restores_every_file_and_removes_later_ones() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "v1").unwrap();
        std::fs::write(dir.join("keep.txt"), "same").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        // After the checkpoint: one edit, one brand-new file, one deletion.
        std::fs::write(dir.join("a.txt"), "v2").unwrap();
        std::fs::write(dir.join("added_later.txt"), "should vanish").unwrap();
        std::fs::remove_file(dir.join("keep.txt")).unwrap();

        let out = checkpoint_revert_tree_body(repo.clone(), sid.clone(), 100, None).unwrap();

        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "v1");
        assert_eq!(std::fs::read_to_string(dir.join("keep.txt")).unwrap(), "same");
        assert!(
            !dir.join("added_later.txt").exists(),
            "a post-checkpoint file is removed"
        );
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
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("a.txt"), "v2").unwrap();
        std::fs::write(dir.join("b.txt"), "new").unwrap();

        let out = checkpoint_revert_tree_body(repo.clone(), sid.clone(), 100, None).unwrap();
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
        checkpoint_revert_tree_body(repo.clone(), sid.clone(), backstop, None).unwrap();
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
        checkpoint_snapshot_body(sid.clone(), repo.clone(), now - 60).unwrap();
        std::fs::write(dir.join("a.txt"), "v2").unwrap();

        let backstop = checkpoint_revert_tree_body(repo.clone(), sid.clone(), now - 60, None)
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
        checkpoint_snapshot_body(sid.clone(), repo.clone(), now + 30).unwrap();
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
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();

        // The user stages an edit. A whole-tree revert does rewrite the file
        // on disk (that is the point of a tree revert), but it must never
        // touch the *index*, so the staged snapshot survives intact.
        std::fs::write(dir.join("staged.txt"), "staged v2").unwrap();
        git(&dir, &["add", "staged.txt"]);
        let staged_before = git_capture(&repo, &["diff", "--cached", "--name-only"]).unwrap();
        std::fs::write(dir.join("reverted.txt"), "v2").unwrap();

        checkpoint_revert_tree_body(repo.clone(), sid.clone(), 100, None).unwrap();

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
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(&script, "#!/bin/sh\necho v2\n").unwrap();

        checkpoint_revert_tree_body(repo.clone(), sid.clone(), 100, None).unwrap();

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
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();

        let out = checkpoint_revert_tree_body(repo.clone(), sid.clone(), 100, None).unwrap();
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
        let dir = std::env::temp_dir().join(format!("tori_revert_not_a_repo_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "untouched").unwrap();
        let sid = format!("sess-revert-plain-{n}-{seq}");
        let repo = dir.to_string_lossy().into_owned();
        assert!(checkpoint_revert_tree_body(repo, sid.clone(), 100, None).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "untouched");
        cleanup(&dir, &sid);
    }

    #[test]
    fn prune_removes_all_refs_and_the_scratch_index() {
        let (dir, sid) = tmp_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "v1").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("a.txt"), "v2").unwrap();
        checkpoint_snapshot_body(sid.clone(), repo.clone(), 200).unwrap();
        assert_eq!(list_checkpoints(&repo, &sid).len(), 2);
        assert!(checkpoint_index_path(&sid, &repo).exists());

        checkpoint_prune_body(repo.clone(), sid.clone()).unwrap();

        assert!(list_checkpoints(&repo, &sid).is_empty());
        assert!(!checkpoint_index_path(&sid, &repo).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    fn two_members() -> (PathBuf, PathBuf, String, Vec<String>) {
        let (api, sid) = tmp_repo();
        let (web, _) = tmp_repo();
        for dir in [&api, &web] {
            std::fs::write(dir.join("a.txt"), "before").unwrap();
        }
        let roots = [&api, &web].map(|d| d.to_string_lossy().into_owned()).to_vec();
        (api, web, sid, roots)
    }

    #[test]
    fn a_topic_turn_touching_two_members_checkpoints_each() {
        let (api, web, sid, roots) = two_members();
        assert!(snapshot_members(&sid, "/topic-home", &roots, 100).unwrap());
        for dir in [&api, &web] {
            std::fs::write(dir.join("a.txt"), "after").unwrap();
            let file = dir.join("a.txt").to_string_lossy().into_owned();
            checkpoint_note_touched(sid.clone(), 100, "Edit".into(), vec![file]).unwrap();
        }
        assert!(snapshot_members(&sid, "/topic-home", &roots, 200).unwrap());

        for root in &roots {
            assert_eq!(
                list_checkpoints(root, &sid).iter().map(|c| c.ts).collect::<Vec<_>>(),
                [100, 200]
            );
        }
        let files: Vec<String> = roots
            .iter()
            .flat_map(|r| {
                turn_files_one(r.clone(), sid.clone(), 100, None, None)
                    .unwrap()
                    .into_iter()
                    .map(|f| absolute(r, &f.path))
            })
            .collect();
        assert_eq!(files, roots.iter().map(|r| absolute(r, "a.txt")).collect::<Vec<_>>());
        cleanup(&api, &sid);
        cleanup(&web, &sid);
    }

    #[test]
    fn reverting_a_two_member_turn_restores_both() {
        let (api, web, sid, roots) = two_members();
        snapshot_members(&sid, "/topic-home", &roots, 100).unwrap();
        std::fs::write(api.join("a.txt"), "after").unwrap();
        std::fs::write(web.join("made.txt"), "new").unwrap();
        let wrote = [api.join("a.txt"), web.join("made.txt")].map(|p| p.to_string_lossy().into_owned());
        checkpoint_note_touched(sid.clone(), 100, "Edit".into(), wrote.to_vec()).unwrap();

        let outcome = revert_members(&sid, &roots, 100, &[]).unwrap();

        assert_eq!(std::fs::read_to_string(api.join("a.txt")).unwrap(), "before");
        assert!(!web.join("made.txt").exists());
        assert_eq!(
            (outcome.restored, outcome.deleted),
            (vec![wrote[0].clone()], vec![wrote[1].clone()])
        );
        cleanup(&api, &sid);
        cleanup(&web, &sid);
    }
}
