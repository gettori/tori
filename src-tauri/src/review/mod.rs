//! The review inbox: sessions whose finished work nobody has read yet, ordered
//! by how risky that work looks.
//!
//! A mark records what was reviewed: the time and the tree the session's
//! worktree held. Work after it is the diff from that tree to the live one,
//! narrowed to the session's own writes, plus the transcript signals of every
//! turn that started after it. A session never marked counts from the moment
//! this store was first created, so an install starts with an empty inbox.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::chat::model::Verdict;
use crate::checkpoint::CheckpointFile;
use crate::sessions::{SessionIndex, SessionMeta};

mod paths;
mod scope;

const CHANGED_EVENT: &str = "review://changed";

const SECRET_READ_POINTS: u32 = 30;
const FAILED_POINTS: u32 = 25;
const BLIND_EDIT_POINTS: u32 = 10;
const UNVERIFIED_POINTS: u32 = 10;
const DELETED_TESTS_POINTS: u32 = 25;
const SENSITIVE_PATH_POINTS: u32 = 20;
const DEPENDENCY_POINTS: u32 = 15;
const OUTSIDE_SCOPE_POINTS: u32 = 15;
const SHARED_FILE_POINTS: u32 = 10;
const BASE_CONFLICT_POINTS: u32 = 20;
const WORKTREE_OVERLAP_POINTS: u32 = 15;
const LINES_CAP: u32 = 30;

/// What a reviewer signs off on. Only a session for now; a PR or a batch of
/// PRs joins as another variant with its own key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReviewUnit {
    Session { id: String },
}

impl ReviewUnit {
    fn key(&self) -> String {
        match self {
            Self::Session { id } => format!("session:{id}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SignalKind {
    Lines,
    SecretRead,
    Failed,
    BlindEdit,
    Unverified,
    DeletedTests,
    SensitivePath,
    Dependencies,
    OutsideScope,
    SharedFile,
    BaseConflict,
    WorktreeOverlap,
    NoCheckpoints,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub kind: SignalKind,
    pub count: u32,
    pub points: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItem {
    pub unit: ReviewUnit,
    pub project: String,
    pub folder: String,
    pub agent: String,
    pub title: String,
    pub summary: Option<String>,
    pub score: u32,
    pub signals: Vec<Signal>,
    /// The first unreviewed turn's checkpoint, where the timeline opens.
    pub from_ts: Option<u64>,
    /// The latest prompt seen, which a mark must not be older than.
    pub to_ts: u64,
    pub running: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Mark {
    ts: u64,
    tree: Option<String>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
struct Store {
    installed_at: u64,
    #[serde(default)]
    marks: BTreeMap<String, Mark>,
}

impl Store {
    fn mark_of(&self, unit: &ReviewUnit) -> Mark {
        self.marks.get(&unit.key()).cloned().unwrap_or(Mark {
            ts: self.installed_at,
            tree: None,
        })
    }
}

static STORE_LOCK: Mutex<()> = Mutex::new(());

fn store_path() -> PathBuf {
    crate::owned_state::config_dir().join("reviewed.json")
}

/// No file is a first run, which starts the clock now. A file that will not
/// parse is set aside as `.bad` and starts from zero, so every session lists
/// rather than any unreviewed work being hidden by a guess.
fn load_from(path: &Path, now: u64) -> Store {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let store = Store {
                installed_at: now,
                marks: BTreeMap::new(),
            };
            let _ = save_to(path, &store);
            return store;
        }
        Err(_) => return Store::default(),
    };
    match serde_json::from_str(&text) {
        Ok(store) => store,
        Err(_) => {
            let _ = std::fs::rename(path, path.with_extension("json.bad"));
            let store = Store::default();
            let _ = save_to(path, &store);
            store
        }
    }
}

fn save_to(path: &Path, store: &Store) -> Result<(), String> {
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(path, &text)
}

fn now_secs() -> u64 {
    crate::owned_state::now_ms() / 1000
}

/// Drop a deleted session's mark, so the store does not grow forever.
pub(crate) fn forget_session(id: &str) {
    forget_in(&store_path(), id);
}

fn forget_in(path: &Path, id: &str) {
    let _held = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut store = load_from(path, now_secs());
    if store
        .marks
        .remove(&ReviewUnit::Session { id: id.to_string() }.key())
        .is_some()
    {
        let _ = save_to(path, &store);
    }
}

/// What the transcript says about the turns after a mark.
#[derive(Debug, Default, Clone, PartialEq)]
struct TurnSignals {
    code_turns: u32,
    failed: u32,
    unverified: u32,
    secret_reads: u32,
    blind_edits: u32,
}

fn lines_points(lines: u32) -> u32 {
    ((3.0 * f64::from(lines + 1).log2()).round() as u32).min(LINES_CAP)
}

#[derive(Debug, Default, Clone, PartialEq)]
struct SpanSignals {
    lines: u32,
    files: paths::FileSignals,
    outside: u32,
}

fn score(span: Option<&SpanSignals>, turns: &TurnSignals, radar: crate::radar::SessionSignals) -> (u32, Vec<Signal>) {
    let mut signals = Vec::new();
    let mut add = |kind, count: u32, points| {
        if count > 0 {
            signals.push(Signal { kind, count, points });
        }
    };
    add(SignalKind::SecretRead, turns.secret_reads, SECRET_READ_POINTS);
    add(SignalKind::Failed, turns.failed, FAILED_POINTS);
    add(SignalKind::BlindEdit, turns.blind_edits, BLIND_EDIT_POINTS);
    add(SignalKind::Unverified, turns.unverified, UNVERIFIED_POINTS);
    add(SignalKind::BaseConflict, radar.conflicts, BASE_CONFLICT_POINTS);
    add(SignalKind::WorktreeOverlap, radar.overlaps, WORKTREE_OVERLAP_POINTS);
    match span {
        Some(span) => {
            add(SignalKind::DeletedTests, span.files.deleted_tests, DELETED_TESTS_POINTS);
            add(SignalKind::SensitivePath, span.files.sensitive, SENSITIVE_PATH_POINTS);
            add(SignalKind::Dependencies, span.files.dependencies, DEPENDENCY_POINTS);
            add(SignalKind::OutsideScope, span.outside, OUTSIDE_SCOPE_POINTS);
            add(SignalKind::SharedFile, span.files.shared, SHARED_FILE_POINTS);
            add(SignalKind::Lines, span.lines, lines_points(span.lines));
        }
        None => add(SignalKind::NoCheckpoints, 1, 0),
    }
    (signals.iter().map(|s| s.points).sum(), signals)
}

fn turn_signals(session: &SessionMeta, after: u64) -> TurnSignals {
    let cwd = Some(session.cwd.as_str()).filter(|c| !c.is_empty());
    let later = |ts: Option<u64>| ts.is_some_and(|ts| ts > after);
    let mut out = TurnSignals::default();
    for turn in crate::chat::commands::verified_turns(&session.id, &session.agent, cwd) {
        if later(turn.prompt_ts) {
            out.code_turns += 1;
        }
        match turn.verdict {
            Verdict::Failed if later(turn.prompt_ts) => out.failed += 1,
            Verdict::Unverified if later(turn.prompt_ts) => out.unverified += 1,
            _ => {}
        }
    }
    out.secret_reads = crate::chat::commands::secret_turns(&session.id, &session.agent, cwd)
        .iter()
        .filter(|t| later(t.prompt_ts))
        .count() as u32;
    out.blind_edits = crate::chat::commands::blind_turns(&session.id, &session.agent, cwd)
        .iter()
        .filter(|t| later(t.prompt_ts))
        .map(|t| t.paths.len() as u32)
        .sum();
    out
}

fn implicit_before(points: &[(u64, String, bool)], mark: u64) -> Option<(String, u64)> {
    let boundaries = || points.iter().filter(|(_, _, backstop)| !backstop);
    boundaries()
        .rfind(|(ts, _, _)| *ts <= mark)
        .or_else(|| boundaries().next())
        .map(|(ts, tree, _)| (tree.clone(), *ts))
}

fn first_turn_after(points: &[(u64, String, bool)], mark: u64) -> Option<u64> {
    let boundaries = || points.iter().filter(|(_, _, backstop)| !backstop);
    boundaries()
        .find(|(ts, _, _)| *ts > mark)
        .or_else(|| boundaries().rfind(|(ts, _, _)| *ts <= mark))
        .map(|(ts, _, _)| *ts)
}

type SpanKey = (String, String, String, String, u64);

/// Span diffs by the two trees they compare. A tree pair never changes its
/// answer, so nothing here is ever invalidated, only dropped when full.
#[derive(Default)]
struct SpanCache {
    entries: HashMap<SpanKey, Vec<CheckpointFile>>,
    misses: usize,
}

const SPAN_CACHE_CAP: usize = 512;

impl SpanCache {
    fn span(
        &mut self,
        repo: &str,
        session: &str,
        before: &str,
        after: &str,
        since: u64,
        others: &[String],
    ) -> Result<Vec<CheckpointFile>, String> {
        let key = (
            repo.to_string(),
            session.to_string(),
            before.to_string(),
            after.to_string(),
            since,
        );
        if let Some(files) = self.entries.get(&key) {
            return Ok(files.clone());
        }
        self.misses += 1;
        let files = crate::checkpoint::session_span(repo, session, before, after, since, others)?;
        if self.entries.len() >= SPAN_CACHE_CAP {
            self.entries.clear();
        }
        self.entries.insert(key, files.clone());
        Ok(files)
    }
}

static SPANS: std::sync::LazyLock<Mutex<SpanCache>> = std::sync::LazyLock::new(Mutex::default);

fn own_span(
    session: &SessionMeta,
    mark: &Mark,
    others: &[String],
    spans: &Mutex<SpanCache>,
) -> Option<(Vec<CheckpointFile>, Option<u64>)> {
    let repo = session.cwd.as_str();
    if !crate::checkpoint::is_git_worktree(repo) {
        return None;
    }
    let points = crate::checkpoint::checkpoint_points(repo, &session.id);
    let (before, since) = match &mark.tree {
        Some(tree) => (tree.clone(), mark.ts),
        None => implicit_before(&points, mark.ts)?,
    };
    let after = crate::checkpoint::live_tree(repo, &session.id).ok()?;
    let files = spans
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .span(repo, &session.id, &before, &after, since, others)
        .ok()?;
    Some((files, first_turn_after(&points, mark.ts)))
}

/// A session's unreviewed work as the inbox measures it: the two trees, when
/// the mark was set, and the files the session itself changed between them.
pub(crate) struct Span {
    pub session: SessionMeta,
    pub since: u64,
    pub after: String,
    pub before: String,
    pub files: Vec<CheckpointFile>,
}

pub(crate) fn span_now(index: &SessionIndex, id: &str) -> Result<Span, String> {
    let store = {
        let _held = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        load_from(&store_path(), now_secs())
    };
    let sessions = crate::sessions::listed_sessions(index, None);
    let session = sessions
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    let repo = session.cwd.as_str();
    if !crate::checkpoint::is_git_worktree(repo) {
        return Err("This session is not in a git worktree, so there is no diff to review.".into());
    }
    let mark = store.mark_of(&ReviewUnit::Session { id: id.to_string() });
    let points = crate::checkpoint::checkpoint_points(repo, id);
    let (before, since) = match &mark.tree {
        Some(tree) => (tree.clone(), mark.ts),
        None => implicit_before(&points, mark.ts)
            .ok_or_else(|| "This session has no checkpoint to review from.".to_string())?,
    };
    let after = crate::checkpoint::live_tree(repo, id)?;
    let others: Vec<String> = sessions
        .iter()
        .filter(|s| s.id != id && crate::rpc::events::same_folder(&s.cwd, repo))
        .map(|s| s.id.clone())
        .collect();
    let files = SPANS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .span(repo, id, &before, &after, since, &others)?;
    Ok(Span {
        session,
        since,
        after,
        before,
        files,
    })
}

fn span_signals(
    session: &SessionMeta,
    project: &str,
    files: &[CheckpointFile],
    scopes: &Mutex<scope::ScopeCache>,
) -> SpanSignals {
    let repo = Path::new(&session.cwd);
    let (rules, _) = crate::secret_watch::current();
    let in_repo = crate::checkpoint::git_capture(&session.cwd, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    let named = scopes.lock().unwrap_or_else(std::sync::PoisonError::into_inner).named(
        &session.id,
        repo,
        in_repo.trim(),
        || crate::chat::commands::first_prompt(&session.id, &session.agent),
        || scope::linked_issue_body(project, &session.branch),
    );
    SpanSignals {
        lines: files.iter().map(|f| f.added + f.removed).sum(),
        files: paths::file_signals(files, repo, &rules),
        outside: scope::outside(files, &named),
    }
}

struct Transcript {
    last_ts: u64,
    turns: TurnSignals,
    summary: Option<String>,
}

fn transcript_of(session: &SessionMeta, after: u64) -> Option<Transcript> {
    let tail = crate::sessions::session_prompt_tail_body(session.path.clone(), session.agent.clone()).ok()?;
    if tail.last_ts <= after {
        return None;
    }
    Some(Transcript {
        last_ts: tail.last_ts,
        turns: turn_signals(session, after),
        summary: crate::chat::commands::last_reply(&session.id, &session.agent),
    })
}

fn item(
    session: &SessionMeta,
    project: &str,
    mark: &Mark,
    transcript: Transcript,
    others: &[String],
    spans: &Mutex<SpanCache>,
    scopes: &Mutex<scope::ScopeCache>,
) -> Option<ReviewItem> {
    let own = own_span(session, mark, others, spans);
    let span = own
        .as_ref()
        .map(|(files, _)| span_signals(session, project, files, scopes));
    let wrote = match &span {
        Some(span) => span.lines > 0,
        None => transcript.turns.code_turns > 0,
    };
    if !wrote {
        return None;
    }
    let radar = crate::radar::session_signals(&session.id, &session.cwd);
    let (score, signals) = score(span.as_ref(), &transcript.turns, radar);
    Some(ReviewItem {
        unit: ReviewUnit::Session { id: session.id.clone() },
        project: project.to_string(),
        folder: session.cwd.clone(),
        agent: session.agent.clone(),
        title: session.name.clone().unwrap_or_else(|| session.title.clone()),
        summary: transcript.summary,
        score,
        signals,
        from_ts: own.and_then(|(_, from)| from),
        to_ts: transcript.last_ts,
        running: crate::rpc::session_running(&session.id),
    })
}

fn waiting_in(folder: &str) -> bool {
    crate::worktree::worktree_status_body(folder.to_string()).is_ok_and(|s| s.dirty || s.unpushed)
}

fn order(items: &mut [ReviewItem]) {
    items.sort_by(|a, b| b.score.cmp(&a.score).then(b.to_ts.cmp(&a.to_ts)));
}

fn inbox(
    sessions: Vec<SessionMeta>,
    store: &Store,
    spans: &Mutex<SpanCache>,
    scopes: &Mutex<scope::ScopeCache>,
) -> Vec<ReviewItem> {
    let projects = crate::config::discovered_project_dirs();
    let mut waiting: HashMap<String, bool> = HashMap::new();
    let mut items = Vec::new();
    for session in &sessions {
        let Some(project) = crate::rpc::events::project_of(&session.cwd, &projects) else {
            continue;
        };
        let mark = store.mark_of(&ReviewUnit::Session { id: session.id.clone() });
        if session.last_active <= mark.ts {
            continue;
        }
        if !*waiting
            .entry(session.cwd.clone())
            .or_insert_with(|| waiting_in(&session.cwd))
        {
            continue;
        }
        let Some(transcript) = transcript_of(session, mark.ts) else {
            continue;
        };
        let others: Vec<String> = sessions
            .iter()
            .filter(|s| s.id != session.id && crate::rpc::events::same_folder(&s.cwd, &session.cwd))
            .map(|s| s.id.clone())
            .collect();
        items.extend(item(session, &project, &mark, transcript, &others, spans, scopes));
    }
    order(&mut items);
    items
}

/// Every session with unreviewed work in a dirty or unpushed worktree, riskiest
/// first.
#[tauri::command(async)]
pub fn review_inbox(index: State<SessionIndex>) -> Vec<ReviewItem> {
    inbox_now(&index)
}

pub(crate) fn inbox_now(index: &SessionIndex) -> Vec<ReviewItem> {
    let store = {
        let _held = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        load_from(&store_path(), now_secs())
    };
    let sessions = crate::sessions::listed_sessions(index, None);
    inbox(sessions, &store, &SPANS, &scope::SCOPES)
}

/// Mark a unit reviewed up to `to_ts`, the latest prompt the reviewer saw.
/// Refused while the session is mid-turn, and when a prompt arrived since.
#[tauri::command(async)]
pub fn review_mark(app: AppHandle, index: State<SessionIndex>, unit: ReviewUnit, to_ts: u64) -> Result<(), String> {
    mark_now(&app, &index, unit, to_ts)
}

pub(crate) fn mark_now(app: &AppHandle, index: &SessionIndex, unit: ReviewUnit, to_ts: u64) -> Result<(), String> {
    let ReviewUnit::Session { id } = &unit;
    let session = crate::sessions::listed_sessions(index, None)
        .into_iter()
        .find(|s| s.id == *id)
        .ok_or_else(|| format!("no session {id}"))?;
    mark(&session, &unit, to_ts, crate::rpc::session_running(id), &store_path())?;
    let _ = app.emit(CHANGED_EVENT, ());
    crate::rpc::publish_reviewed(id, &session.cwd);
    Ok(())
}

fn mark(session: &SessionMeta, unit: &ReviewUnit, to_ts: u64, running: bool, path: &Path) -> Result<(), String> {
    if running {
        return Err("The session is still working. Mark it reviewed once its turn ends.".into());
    }
    let last = crate::sessions::session_prompt_tail_body(session.path.clone(), session.agent.clone())
        .map(|t| t.last_ts)
        .unwrap_or(0);
    if last > to_ts {
        return Err("The session has a newer turn than the one shown. Look again before marking it.".into());
    }
    let tree = crate::checkpoint::is_git_worktree(&session.cwd)
        .then(|| crate::checkpoint::live_tree(&session.cwd, &session.id).ok())
        .flatten();
    let _held = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut store = load_from(path, now_secs());
    store.marks.insert(
        unit.key(),
        Mark {
            ts: now_secs().max(to_ts),
            tree,
        },
    );
    save_to(path, &store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tmp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tori_review_{tag}_{}_{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    fn repo() -> (PathBuf, String) {
        let dir = tmp_dir("repo");
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        std::fs::write(dir.join("README.md"), "base\n").unwrap();
        let sid = format!("review-{}", dir.file_name().unwrap().to_string_lossy());
        (dir, sid)
    }

    fn session(id: &str, cwd: &Path) -> SessionMeta {
        SessionMeta {
            id: id.into(),
            path: cwd.join("missing.jsonl").to_string_lossy().into_owned(),
            cwd: cwd.to_string_lossy().into_owned(),
            branch: "main".into(),
            title: "a task".into(),
            last_active: 2_000_000_000,
            created_at: 0,
            name: None,
            agent: "claude".into(),
            profile: None,
            profile_label: None,
        }
    }

    fn transcript(turns: TurnSignals) -> Transcript {
        Transcript {
            last_ts: 1_760_000_900,
            turns,
            summary: Some("done".into()),
        }
    }

    fn lines(text: usize) -> String {
        (0..text).map(|i| format!("line {i}\n")).collect()
    }

    fn touched(sid: &str, ts: u64, tool: &str, files: &[PathBuf]) {
        crate::checkpoint::checkpoint_note_touched(
            sid.into(),
            ts,
            tool.into(),
            files.iter().map(|f| f.to_string_lossy().into_owned()).collect(),
        )
        .unwrap();
    }

    fn line_count(item: &ReviewItem) -> Option<u32> {
        item.signals
            .iter()
            .find(|s| s.kind == SignalKind::Lines)
            .map(|s| s.count)
    }

    fn cleanup(dir: &Path, ids: &[&str]) {
        std::fs::remove_dir_all(dir).ok();
        for id in ids {
            crate::checkpoint::checkpoint_prune_body(dir.to_string_lossy().into_owned(), id.to_string()).ok();
        }
    }

    #[test]
    fn the_store_round_trips_seeds_once_and_sets_a_corrupt_file_aside() {
        let dir = tmp_dir("store");
        let path = dir.join("reviewed.json");

        let first = load_from(&path, 1_760_000_000);
        assert_eq!(first.installed_at, 1_760_000_000, "a first run starts the clock");
        let unit = ReviewUnit::Session { id: "s1".into() };
        assert_eq!(first.mark_of(&unit).ts, 1_760_000_000);

        let mut store = load_from(&path, 1_760_009_999);
        assert_eq!(store.installed_at, 1_760_000_000, "a second run does not seed again");
        store.marks.insert(
            unit.key(),
            Mark {
                ts: 1_760_000_500,
                tree: Some("abc".into()),
            },
        );
        save_to(&path, &store).unwrap();
        assert_eq!(load_from(&path, 0), store);

        forget_in(&path, "s1");
        assert!(
            load_from(&path, 0).marks.is_empty(),
            "a deleted session's mark is pruned"
        );

        std::fs::write(&path, "{ torn").unwrap();
        let after = load_from(&path, 1_760_009_999);
        assert_eq!(
            after.installed_at, 0,
            "a corrupt file lists everything rather than seeding"
        );
        assert!(dir.join("reviewed.json.bad").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_secret_read_outranks_a_much_bigger_clean_change() {
        let span = |lines| SpanSignals {
            lines,
            ..Default::default()
        };
        let (risky, risky_signals) = score(
            Some(&span(42)),
            &TurnSignals {
                code_turns: 1,
                secret_reads: 1,
                ..Default::default()
            },
            Default::default(),
        );
        let (big, _) = score(
            Some(&span(1_850)),
            &TurnSignals {
                code_turns: 6,
                ..Default::default()
            },
            Default::default(),
        );
        assert!(risky > big, "{risky} vs {big}");
        assert_eq!(lines_points(1_850), LINES_CAP, "lines alone stop at the cap");
        assert_eq!(
            risky_signals.iter().map(|s| s.kind).collect::<Vec<_>>(),
            vec![SignalKind::SecretRead, SignalKind::Lines]
        );
    }

    #[test]
    fn base_conflicts_and_worktree_overlaps_each_score_once_with_their_count() {
        let turns = TurnSignals {
            code_turns: 1,
            ..Default::default()
        };
        let radar = crate::radar::SessionSignals {
            conflicts: 3,
            overlaps: 2,
        };
        let (total, signals) = score(None, &turns, radar);
        let of = |kind| signals.iter().find(|s| s.kind == kind).map(|s| (s.count, s.points));
        assert_eq!(of(SignalKind::BaseConflict), Some((3, BASE_CONFLICT_POINTS)));
        assert_eq!(of(SignalKind::WorktreeOverlap), Some((2, WORKTREE_OVERLAP_POINTS)));
        assert_eq!(total, BASE_CONFLICT_POINTS + WORKTREE_OVERLAP_POINTS);

        let (_, off) = score(None, &turns, Default::default());
        assert!(
            off.iter()
                .all(|s| !matches!(s.kind, SignalKind::BaseConflict | SignalKind::WorktreeOverlap)),
            "a switched-off radar reports zeros, and zeros draw no chip: {off:?}"
        );
    }

    #[test]
    fn a_shell_only_session_is_listed_with_its_own_lines() {
        let (dir, sid) = repo();
        crate::checkpoint::checkpoint_snapshot_body(sid.clone(), dir.to_string_lossy().into_owned(), 100).unwrap();
        std::fs::write(dir.join("gen.rs"), lines(120)).unwrap();
        touched(&sid, 100, "Bash", &[]);

        let spans = Mutex::new(SpanCache::default());
        let scopes = Mutex::new(scope::ScopeCache::default());
        let mark = Mark { ts: 50, tree: None };
        let row = item(
            &session(&sid, &dir),
            "/p",
            &mark,
            transcript(TurnSignals::default()),
            &[],
            &spans,
            &scopes,
        )
        .expect("a heredoc write is still work to read");
        assert_eq!(line_count(&row), Some(120));
        assert_eq!(row.from_ts, Some(100));
        cleanup(&dir, &[&sid]);
    }

    #[test]
    fn two_sessions_in_one_worktree_each_count_their_own_lines() {
        let (dir, a) = repo();
        let b = format!("{a}-b");
        let repo = dir.to_string_lossy().into_owned();
        crate::checkpoint::checkpoint_snapshot_body(a.clone(), repo.clone(), 100).unwrap();
        crate::checkpoint::checkpoint_snapshot_body(b.clone(), repo.clone(), 100).unwrap();
        std::fs::write(dir.join("a.rs"), lines(30)).unwrap();
        std::fs::write(dir.join("b.rs"), lines(400)).unwrap();
        touched(&a, 100, "Edit", &[dir.join("a.rs")]);
        touched(&b, 100, "Edit", &[dir.join("b.rs")]);

        let spans = Mutex::new(SpanCache::default());
        let mark = Mark { ts: 50, tree: None };
        let row = |id: &str, other: &str, spans: &Mutex<SpanCache>| {
            let scopes = Mutex::new(scope::ScopeCache::default());
            item(
                &session(id, &dir),
                "/p",
                &mark,
                transcript(TurnSignals::default()),
                &[other.to_string()],
                spans,
                &scopes,
            )
            .unwrap()
        };
        assert_eq!(line_count(&row(&a, &b, &spans)), Some(30));
        assert_eq!(line_count(&row(&b, &a, &spans)), Some(400));

        let misses = spans.lock().unwrap().misses;
        row(&a, &b, &spans);
        assert_eq!(
            spans.lock().unwrap().misses,
            misses,
            "nothing moved, so no diff ran again"
        );
        cleanup(&dir, &[&a, &b]);
    }

    #[test]
    fn a_mark_holds_back_what_was_read_and_the_next_change_brings_the_row_back() {
        let (dir, sid) = repo();
        let repo_path = dir.to_string_lossy().into_owned();
        crate::checkpoint::checkpoint_snapshot_body(sid.clone(), repo_path.clone(), 100).unwrap();
        std::fs::write(dir.join("a.rs"), lines(200)).unwrap();
        touched(&sid, 100, "Edit", &[dir.join("a.rs")]);

        let store_dir = tmp_dir("mark");
        let store = store_dir.join("reviewed.json");
        let unit = ReviewUnit::Session { id: sid.clone() };
        let me = session(&sid, &dir);
        assert!(
            mark(&me, &unit, 1_760_000_900, true, &store).is_err(),
            "a running session cannot be marked"
        );
        mark(&me, &unit, 1_760_000_900, false, &store).unwrap();
        let held = load_from(&store, 0).mark_of(&unit);
        assert!(held.tree.is_some());

        let spans = Mutex::new(SpanCache::default());
        let scopes = Mutex::new(scope::ScopeCache::default());
        let quiet = item(
            &me,
            "/p",
            &held,
            transcript(TurnSignals::default()),
            &[],
            &spans,
            &scopes,
        );
        assert!(quiet.is_none(), "nothing new since the mark");

        crate::checkpoint::checkpoint_snapshot_body(sid.clone(), repo_path, held.ts + 10).unwrap();
        std::fs::write(dir.join("b.rs"), lines(15)).unwrap();
        touched(&sid, held.ts + 10, "Edit", &[dir.join("b.rs")]);
        let back = item(
            &me,
            "/p",
            &held,
            transcript(TurnSignals::default()),
            &[],
            &spans,
            &scopes,
        )
        .expect("a new turn's write brings the row back");
        assert_eq!(line_count(&back), Some(15), "scored over the new turn only");
        std::fs::remove_dir_all(&store_dir).ok();
        cleanup(&dir, &[&sid]);
    }

    #[test]
    fn a_session_without_checkpoints_is_judged_by_its_code_turns() {
        let dir = tmp_dir("plain");
        let me = session("plain-1", &dir);
        let spans = Mutex::new(SpanCache::default());
        let scopes = Mutex::new(scope::ScopeCache::default());
        let mark = Mark { ts: 50, tree: None };
        assert!(item(
            &me,
            "/p",
            &mark,
            transcript(TurnSignals::default()),
            &[],
            &spans,
            &scopes
        )
        .is_none());
        let row = item(
            &me,
            "/p",
            &mark,
            transcript(TurnSignals {
                code_turns: 2,
                unverified: 2,
                ..Default::default()
            }),
            &[],
            &spans,
            &scopes,
        )
        .unwrap();
        assert!(row.signals.iter().any(|s| s.kind == SignalKind::NoCheckpoints));
        assert_eq!(line_count(&row), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_pushed_clean_branch_is_not_waiting() {
        let (dir, _) = repo();
        std::fs::write(dir.join("a.rs"), "one\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "one"]);
        let remote = tmp_dir("remote");
        git(&remote, &["init", "-q", "--bare"]);
        git(&dir, &["remote", "add", "origin", &remote.to_string_lossy()]);
        git(&dir, &["push", "-q", "-u", "origin", "main"]);
        let folder = dir.to_string_lossy().into_owned();
        assert!(!waiting_in(&folder));
        std::fs::write(dir.join("a.rs"), "two\n").unwrap();
        assert!(waiting_in(&folder), "a dirty tree waits");
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&remote).ok();
    }

    #[test]
    fn a_fixture_repo_fires_each_file_signal_once() {
        let (dir, a) = repo();
        let b = format!("{a}-b");
        let repo_path = dir.to_string_lossy().into_owned();
        std::fs::create_dir_all(dir.join("tests")).unwrap();
        std::fs::write(dir.join("tests/inbox_test.rs"), lines(40)).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]\n").unwrap();
        crate::checkpoint::checkpoint_snapshot_body(a.clone(), repo_path.clone(), 100).unwrap();
        crate::checkpoint::checkpoint_snapshot_body(b.clone(), repo_path, 100).unwrap();

        std::fs::remove_file(dir.join("tests/inbox_test.rs")).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]\n[dependencies]\nserde = \"1\"\n").unwrap();
        std::fs::create_dir_all(dir.join(".github/workflows")).unwrap();
        std::fs::write(dir.join(".github/workflows/ci.yml"), "on: push\n").unwrap();
        let written = [
            dir.join("tests/inbox_test.rs"),
            dir.join("Cargo.toml"),
            dir.join(".github/workflows/ci.yml"),
        ];
        touched(&a, 100, "Edit", &written);
        touched(&b, 100, "Edit", &[dir.join("Cargo.toml")]);

        let spans = Mutex::new(SpanCache::default());
        let scopes = Mutex::new(scope::ScopeCache::default());
        let row = item(
            &session(&a, &dir),
            "/p",
            &Mark { ts: 50, tree: None },
            transcript(TurnSignals::default()),
            std::slice::from_ref(&b),
            &spans,
            &scopes,
        )
        .unwrap();
        let count = |kind| row.signals.iter().find(|s| s.kind == kind).map(|s| s.count);
        assert_eq!(count(SignalKind::DeletedTests), Some(1));
        assert_eq!(count(SignalKind::Dependencies), Some(1));
        assert_eq!(count(SignalKind::SensitivePath), Some(1));
        assert_eq!(count(SignalKind::SharedFile), Some(1));
        assert_eq!(count(SignalKind::OutsideScope), None, "the session named nothing");
        cleanup(&dir, &[&a, &b]);
    }
}
