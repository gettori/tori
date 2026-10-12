//! The last day of what needed you, for the Inbox's Needs you tab and the
//! phone's. Rows come from the same composed dots presence reads, and stay as
//! history once answered.
//!
//! A row is answered when its session stops needing you, or, for a finished
//! turn or a pull request, once you look at the session. Rows still open when
//! Tori starts are answered at load: the presence that could clear them died
//! with the last run, and a session still blocked raises a fresh row anyway.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::chat::model::Verdict;
use crate::presence::{Live, Reason};

const KEEP_MS: u64 = 24 * 60 * 60 * 1000;
// Rows since the last look outlive the day, so a weekend away still shows.
const KEEP_UNSEEN_MS: u64 = 7 * KEEP_MS;

pub const CHANGED_EVENT: &str = "needs-you://changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Permission,
    Question,
    Budget,
    Waiting,
    WorkerQuestion,
    Done,
    PullRequest,
}

impl Kind {
    fn blocks(self) -> bool {
        !matches!(self, Kind::Done | Kind::PullRequest)
    }

    // A worker's question is the same block whether or not its spawner is
    // open to relay it, so the spawner closing raises no second row.
    fn same_block(self, other: Kind) -> bool {
        let plain = |k| if k == Kind::WorkerQuestion { Kind::Question } else { k };
        plain(self) == plain(other)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub ts: u64,
    /// `None` for a pull request row, which belongs to a branch.
    pub session: Option<String>,
    pub folder: String,
    pub branch: Option<String>,
    pub project: String,
    pub title: String,
    pub kind: Kind,
    pub resolved_at: Option<u64>,
    /// A pull request row whose attention has since fallen, so the next red
    /// check is a new row rather than this one coming back.
    #[serde(default)]
    pub settled: bool,
    /// Hosted by a chat, which can bring its waiting card into view.
    #[serde(default)]
    pub chat: bool,
}

impl Event {
    fn open(&self) -> bool {
        self.resolved_at.is_none()
    }
}

/// One branch unit as the forge poll reported it.
#[derive(Debug, Clone, PartialEq)]
pub struct Unit {
    pub folder: String,
    pub branch: Option<String>,
    pub project: String,
    pub attention: bool,
}

/// What one composition saw.
pub struct Tick<'a> {
    pub live: &'a [Live],
    pub finished: &'a [String],
    /// Workers whose spawner relays them.
    pub relayed: &'a HashSet<String>,
    /// Sessions on screen in a focused window.
    pub watched: &'a HashSet<String>,
    pub units: &'a [Unit],
}

#[derive(Debug, Clone, PartialEq)]
pub enum LogOp {
    Add(Event),
    Resolve(String),
    Settle(String),
}

/// A turn's verification, kept per session for the digest.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Checked {
    pub ts: u64,
    pub verdict: Verdict,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Log {
    events: Vec<Event>,
    #[serde(default)]
    looked_at: Option<u64>,
    #[serde(default)]
    verdicts: BTreeMap<String, Checked>,
}

/// What the digest reads out of the log, before lines are counted.
#[derive(Debug, Clone, PartialEq)]
pub struct LogRead {
    pub since: u64,
    pub as_of: u64,
    pub done: Vec<Event>,
    pub waiting: Vec<Event>,
    pub verdicts: BTreeMap<String, Checked>,
}

impl Log {
    fn keeps(&self, ts: u64, now: u64) -> bool {
        ts + KEEP_MS > now || self.looked_at.is_some_and(|m| ts >= m && ts + KEEP_UNSEEN_MS > now)
    }

    fn prune(&mut self, now: u64) -> bool {
        let before = (self.events.len(), self.verdicts.len());
        let events = std::mem::take(&mut self.events);
        self.events = events.into_iter().filter(|e| self.keeps(e.ts, now)).collect();
        let verdicts = std::mem::take(&mut self.verdicts);
        self.verdicts = verdicts.into_iter().filter(|(_, c)| self.keeps(c.ts, now)).collect();
        (self.events.len(), self.verdicts.len()) != before
    }

    /// Never moves back, and never past now.
    pub fn looked(&mut self, at: u64, now: u64) -> bool {
        let next = self.looked_at.map_or(at, |m| m.max(at)).min(now);
        let changed = self.looked_at != Some(next);
        self.looked_at = Some(next);
        changed
    }

    pub fn note_verdict(&mut self, session: &str, verdict: Verdict, now: u64) {
        self.verdicts.insert(session.to_string(), Checked { ts: now, verdict });
    }

    /// `since` defaults to the mark, or a day back before any look.
    pub fn since(&self, since: Option<u64>, now: u64) -> LogRead {
        let since = since.or(self.looked_at).unwrap_or(now.saturating_sub(KEEP_MS));
        let mut done: Vec<Event> = self
            .events
            .iter()
            .filter(|e| e.kind == Kind::Done && e.ts > since)
            .cloned()
            .collect();
        done.sort_by_key(|e| e.ts);
        let waiting = self
            .events()
            .into_iter()
            .filter(|e| e.open() && e.kind.blocks())
            .collect();
        let verdicts = self
            .verdicts
            .iter()
            .filter(|(_, c)| c.ts > since)
            .map(|(id, c)| (id.clone(), *c))
            .collect();
        LogRead {
            since,
            as_of: now,
            done,
            waiting,
            verdicts,
        }
    }

    fn sweep(&mut self, now: u64) -> bool {
        let mut changed = false;
        for e in self.events.iter_mut().filter(|e| e.open()) {
            e.resolved_at = Some(now);
            changed = true;
        }
        changed
    }

    pub fn apply(&mut self, ops: Vec<LogOp>, now: u64) -> bool {
        let changed = !ops.is_empty();
        for op in ops {
            match op {
                LogOp::Add(e) => self.events.push(e),
                LogOp::Resolve(id) => {
                    if let Some(e) = self.events.iter_mut().find(|e| e.id == id && e.open()) {
                        e.resolved_at = Some(now);
                    }
                }
                LogOp::Settle(id) => {
                    if let Some(e) = self.events.iter_mut().find(|e| e.id == id) {
                        e.settled = true;
                        e.resolved_at.get_or_insert(now);
                    }
                }
            }
        }
        changed
    }

    /// Newest first.
    pub fn events(&self) -> Vec<Event> {
        let mut out = self.events.clone();
        out.sort_by_key(|e| std::cmp::Reverse(e.ts));
        out
    }

    /// Answer a session's finished turns and a branch's pull request rows. A
    /// plain repo's branches share a folder, so the branch narrows it when known.
    pub fn seen(&self, session: Option<&str>, folder: Option<&str>, branch: Option<&str>) -> Vec<LogOp> {
        self.events
            .iter()
            .filter(|e| e.open() && !e.kind.blocks())
            .filter(|e| match e.kind {
                Kind::Done => session.is_some() && e.session.as_deref() == session,
                _ => {
                    folder.is_some_and(|f| e.folder == f)
                        && (branch.is_none() || e.branch.is_none() || e.branch.as_deref() == branch)
                }
            })
            .map(|e| LogOp::Resolve(e.id.clone()))
            .collect()
    }
}

fn kind_of(reason: Reason, relayed: bool) -> Option<Kind> {
    Some(match reason {
        Reason::Approval => Kind::Permission,
        Reason::Question if relayed => Kind::WorkerQuestion,
        Reason::Question => Kind::Question,
        Reason::Budget => Kind::Budget,
        Reason::Waiting => Kind::Waiting,
        Reason::Forge => return None,
    })
}

fn row(live: &Live, kind: Kind, now: u64) -> Event {
    Event {
        id: uuid::Uuid::new_v4().to_string(),
        ts: now,
        session: Some(live.id.clone()),
        folder: live.folder.clone(),
        branch: live.branch.clone(),
        project: live.project.clone(),
        title: live.name.clone(),
        kind,
        resolved_at: None,
        settled: false,
        chat: live.chat,
    }
}

/// What one composition changes in the log. A pull request row follows its
/// unit's attention, not the dot, since a red check only raises the dot while
/// nothing moves and would otherwise come back after every turn.
pub fn log_ops(log: &Log, tick: &Tick, now: u64) -> Vec<LogOp> {
    let mut ops = Vec::new();
    let mut ids = HashSet::new();
    let blocked: Vec<(&Live, Kind)> = tick
        .live
        .iter()
        .filter(|l| ids.insert(l.id.as_str()))
        .filter_map(|l| {
            let kind = kind_of(l.reason?, tick.relayed.contains(&l.id))?;
            Some((l, kind))
        })
        .collect();
    let open_block = |id: &str| {
        log.events
            .iter()
            .find(|e| e.open() && e.kind.blocks() && e.session.as_deref() == Some(id))
    };
    for (l, kind) in &blocked {
        match open_block(&l.id) {
            Some(e) if e.kind.same_block(*kind) => {}
            Some(e) => {
                ops.push(LogOp::Resolve(e.id.clone()));
                ops.push(LogOp::Add(row(l, *kind, now)));
            }
            None => ops.push(LogOp::Add(row(l, *kind, now))),
        }
    }
    for e in log.events.iter().filter(|e| e.open() && e.kind.blocks()) {
        if !blocked.iter().any(|(l, _)| e.session.as_deref() == Some(l.id.as_str())) {
            ops.push(LogOp::Resolve(e.id.clone()));
        }
    }

    for l in tick.live.iter().filter(|l| tick.finished.contains(&l.id)) {
        if tick.relayed.contains(&l.id) {
            continue;
        }
        let mut done = row(l, Kind::Done, now);
        if tick.watched.contains(&l.id) {
            done.resolved_at = Some(now);
        }
        ops.push(LogOp::Add(done));
    }

    for l in tick.live.iter().filter(|l| tick.watched.contains(&l.id)) {
        ops.extend(log.seen(Some(&l.id), Some(&l.folder), l.branch.as_deref()));
    }

    let mut units = HashSet::new();
    for u in tick.units.iter().filter(|u| units.insert((&u.folder, &u.branch))) {
        let current = log
            .events
            .iter()
            .find(|e| e.kind == Kind::PullRequest && !e.settled && e.folder == u.folder && e.branch == u.branch);
        match (u.attention, current) {
            (true, None) => ops.push(LogOp::Add(Event {
                id: uuid::Uuid::new_v4().to_string(),
                ts: now,
                session: None,
                folder: u.folder.clone(),
                branch: u.branch.clone(),
                project: u.project.clone(),
                title: u.branch.clone().unwrap_or_else(|| folder_name(&u.folder)),
                kind: Kind::PullRequest,
                resolved_at: None,
                settled: false,
                chat: false,
            })),
            (false, Some(e)) => ops.push(LogOp::Settle(e.id.clone())),
            _ => {}
        }
    }
    ops
}

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned())
}

fn store_path() -> PathBuf {
    crate::owned_state::config_dir().join("needs_you.json")
}

/// No file is an empty log. One that will not parse is set aside as `.bad`.
fn load_from(path: &Path, now: u64) -> Log {
    let mut log = match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
            let _ = std::fs::rename(path, path.with_extension("json.bad"));
            Log::default()
        }),
        Err(_) => Log::default(),
    };
    let pruned = log.prune(now);
    if log.sweep(now) || pruned {
        let _ = save_to(path, &log);
    }
    log
}

fn save_to(path: &Path, log: &Log) -> Result<(), String> {
    let text = serde_json::to_string_pretty(log).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(path, &text)
}

// Loaded once per run, so the sweep at load is the restart's and no later read.
static LOG: Mutex<Option<Log>> = Mutex::new(None);
// The sweep at load answers every block, and only a composition raises the
// ones still standing, so the digest is not worth opening before it.
static COMPOSED: AtomicBool = AtomicBool::new(false);

fn with_log<R>(f: impl FnOnce(&mut Log, u64) -> (R, bool)) -> R {
    let now = crate::owned_state::now_ms();
    let path = store_path();
    let mut held = LOG.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let log = held.get_or_insert_with(|| load_from(&path, now));
    let pruned = log.prune(now);
    let (out, changed) = f(log, now);
    if changed || pruned {
        let _ = save_to(&path, log);
    }
    out
}

/// Fold one composition in. True when a row changed, and on the first one.
pub fn record(tick: &Tick) -> bool {
    let first = !COMPOSED.swap(true, Ordering::Relaxed);
    with_log(|log, now| {
        let ops = log_ops(log, tick, now);
        let changed = log.apply(ops, now);
        (changed || first, changed)
    })
}

pub fn composed() -> bool {
    COMPOSED.load(Ordering::Relaxed)
}

/// The last day only: older rows are kept for the digest, not for Needs you.
pub fn list() -> Vec<Event> {
    with_log(|log, now| {
        let day: Vec<Event> = log.events().into_iter().filter(|e| e.ts + KEEP_MS > now).collect();
        (day, false)
    })
}

pub fn since(since: Option<u64>) -> LogRead {
    with_log(|log, now| (log.since(since, now), false))
}

/// True when the mark moved.
pub fn looked(at: u64) -> bool {
    with_log(|log, now| {
        let changed = log.looked(at, now);
        (changed, changed)
    })
}

pub fn note_verdict(session: &str, verdict: Verdict) {
    with_log(|log, now| {
        log.note_verdict(session, verdict, now);
        ((), true)
    });
}

/// True when a row changed.
pub fn seen(session: Option<&str>, folder: Option<&str>, branch: Option<&str>) -> bool {
    with_log(|log, now| {
        let ops = log.seen(session, folder, branch);
        let changed = log.apply(ops, now);
        (changed, changed)
    })
}

#[tauri::command]
pub fn needs_you_list() -> Vec<Event> {
    list()
}

#[tauri::command]
pub fn needs_you_seen(app: tauri::AppHandle, session: Option<String>, folder: Option<String>, branch: Option<String>) {
    if seen(session.as_deref(), folder.as_deref(), branch.as_deref()) {
        crate::rpc::publish_needs_you(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::dots::Dot;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tmp_dir() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tori_needs_you_{}_{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn live(id: &str, reason: Option<Reason>) -> Live {
        Live {
            id: id.into(),
            dot: if reason.is_some() { Dot::NeedsYou } else { Dot::Solid },
            name: format!("{id} name"),
            project: "repo".into(),
            folder: "/p/repo".into(),
            chat: true,
            visible: false,
            spawner: None,
            done_at: 0,
            reason,
            branch: Some("fix".into()),
        }
    }

    struct World {
        live: Vec<Live>,
        finished: Vec<String>,
        relayed: HashSet<String>,
        watched: HashSet<String>,
        units: Vec<Unit>,
    }

    impl World {
        fn new(live: Vec<Live>) -> Self {
            Self {
                live,
                finished: Vec::new(),
                relayed: HashSet::new(),
                watched: HashSet::new(),
                units: Vec::new(),
            }
        }

        fn step(&self, log: &mut Log, now: u64) {
            let tick = Tick {
                live: &self.live,
                finished: &self.finished,
                relayed: &self.relayed,
                watched: &self.watched,
                units: &self.units,
            };
            let ops = log_ops(log, &tick, now);
            log.apply(ops, now);
        }
    }

    fn unit(attention: bool) -> Unit {
        Unit {
            folder: "/p/repo".into(),
            branch: Some("fix".into()),
            project: "repo".into(),
            attention,
        }
    }

    fn kinds(log: &Log) -> Vec<(Kind, bool)> {
        let mut events = log.events.clone();
        events.sort_by_key(|e| e.ts);
        events.iter().map(|e| (e.kind, e.open())).collect()
    }

    #[test]
    fn a_block_is_one_row_until_it_clears() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("c", Some(Reason::Approval))]);
        w.step(&mut log, 1);
        w.step(&mut log, 2);
        assert_eq!(kinds(&log), [(Kind::Permission, true)]);
        w.live = vec![live("c", None)];
        w.step(&mut log, 3);
        assert_eq!(kinds(&log), [(Kind::Permission, false)]);
        assert_eq!(log.events[0].title, "c name");
    }

    #[test]
    fn an_approval_turning_into_a_question_is_two_rows() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("c", Some(Reason::Approval))]);
        w.step(&mut log, 1);
        w.live = vec![live("c", Some(Reason::Question))];
        w.step(&mut log, 2);
        assert_eq!(kinds(&log), [(Kind::Permission, false), (Kind::Question, true)]);
    }

    #[test]
    fn a_session_that_goes_away_answers_its_row() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("t", Some(Reason::Waiting))]);
        w.step(&mut log, 1);
        w.live.clear();
        w.step(&mut log, 2);
        assert_eq!(kinds(&log), [(Kind::Waiting, false)]);
    }

    #[test]
    fn a_relayed_question_is_a_worker_question_and_its_spawner_closing_adds_nothing() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("w", Some(Reason::Question))]);
        w.relayed.insert("w".into());
        w.step(&mut log, 1);
        w.relayed.clear();
        w.step(&mut log, 2);
        assert_eq!(kinds(&log), [(Kind::WorkerQuestion, true)]);
    }

    #[test]
    fn a_forge_raise_is_not_a_block() {
        let mut log = Log::default();
        World::new(vec![live("t", Some(Reason::Forge))]).step(&mut log, 1);
        assert!(log.events.is_empty());
    }

    #[test]
    fn a_finished_turn_is_a_row_answered_by_looking() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("c", None)]);
        w.finished = vec!["c".into()];
        w.step(&mut log, 1);
        w.finished.clear();
        w.step(&mut log, 2);
        assert_eq!(kinds(&log), [(Kind::Done, true)]);
        w.watched.insert("c".into());
        w.step(&mut log, 3);
        assert_eq!(kinds(&log), [(Kind::Done, false)]);
    }

    #[test]
    fn a_turn_finishing_while_watched_is_already_answered() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("c", None)]);
        w.finished = vec!["c".into()];
        w.watched.insert("c".into());
        w.step(&mut log, 1);
        assert_eq!(kinds(&log), [(Kind::Done, false)]);
    }

    #[test]
    fn an_autopilot_workers_finished_turn_adds_no_row() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("w", None)]);
        w.finished = vec!["w".into()];
        w.relayed.insert("w".into());
        w.step(&mut log, 1);
        assert!(log.events.is_empty());
    }

    #[test]
    fn a_red_branch_across_three_turns_is_one_row() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("c", Some(Reason::Forge))]);
        w.units = vec![unit(true)];
        for turn in 0..3 {
            w.live = vec![live("c", None)];
            w.step(&mut log, turn * 10 + 1);
            w.live = vec![live("c", Some(Reason::Forge))];
            w.step(&mut log, turn * 10 + 2);
        }
        assert_eq!(kinds(&log), [(Kind::PullRequest, true)]);
        assert_eq!(log.events[0].title, "fix");
    }

    #[test]
    fn a_pull_request_row_answered_by_looking_stays_one_row_until_green() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("c", None)]);
        w.units = vec![unit(true)];
        w.step(&mut log, 1);
        w.watched.insert("c".into());
        w.step(&mut log, 2);
        w.watched.clear();
        w.step(&mut log, 3);
        assert_eq!(kinds(&log), [(Kind::PullRequest, false)]);
        w.units = vec![unit(false)];
        w.step(&mut log, 4);
        assert!(log.events[0].settled);
        w.units = vec![unit(true)];
        w.step(&mut log, 5);
        assert_eq!(kinds(&log), [(Kind::PullRequest, false), (Kind::PullRequest, true)]);
    }

    #[test]
    fn green_answers_an_open_pull_request_row() {
        let mut log = Log::default();
        let mut w = World::new(Vec::new());
        w.units = vec![unit(true)];
        w.step(&mut log, 1);
        w.units = vec![unit(false)];
        w.step(&mut log, 2);
        assert_eq!(kinds(&log), [(Kind::PullRequest, false)]);
    }

    #[test]
    fn seen_answers_a_sessions_finished_turns_and_its_folders_pull_requests_only() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("c", Some(Reason::Approval)), live("d", None)]);
        w.finished = vec!["d".into()];
        w.units = vec![unit(true)];
        w.step(&mut log, 1);
        let ops = log.seen(Some("d"), Some("/p/repo"), Some("fix"));
        log.apply(ops, 2);
        let open: Vec<Kind> = log.events.iter().filter(|e| e.open()).map(|e| e.kind).collect();
        assert_eq!(open, [Kind::Permission]);
    }

    #[test]
    fn looking_at_one_branch_leaves_another_branchs_pull_request_open() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("c", None)]);
        w.units = vec![
            unit(true),
            Unit {
                branch: Some("other".into()),
                ..unit(true)
            },
        ];
        w.step(&mut log, 1);
        w.watched.insert("c".into());
        w.step(&mut log, 2);
        let open: Vec<Option<&str>> = log
            .events
            .iter()
            .filter(|e| e.open())
            .map(|e| e.branch.as_deref())
            .collect();
        assert_eq!(open, [Some("other")]);
    }

    #[test]
    fn a_unit_reported_twice_is_one_row() {
        let mut log = Log::default();
        let mut w = World::new(Vec::new());
        w.units = vec![unit(true), unit(true)];
        w.step(&mut log, 1);
        assert_eq!(kinds(&log), [(Kind::PullRequest, true)]);
    }

    #[test]
    fn a_saved_log_reads_back_pruned_with_open_rows_answered() {
        let dir = tmp_dir();
        let path = dir.join("needs_you.json");
        let mut log = Log::default();
        World::new(vec![live("old", Some(Reason::Waiting))]).step(&mut log, 1);
        World::new(vec![
            live("old", Some(Reason::Waiting)),
            live("new", Some(Reason::Question)),
        ])
        .step(&mut log, KEEP_MS + 5);
        save_to(&path, &log).unwrap();

        let now = KEEP_MS + 10;
        let back = load_from(&path, now);
        assert_eq!(back.events.len(), 1);
        assert_eq!(back.events[0].session.as_deref(), Some("new"));
        assert_eq!(back.events[0].resolved_at, Some(now));
        let on_disk: Log = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk.events, back.events);
    }

    #[test]
    fn a_corrupt_log_is_set_aside_and_starts_empty() {
        let dir = tmp_dir();
        let path = dir.join("needs_you.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load_from(&path, 1).events.is_empty());
        assert!(dir.join("needs_you.json.bad").exists());
    }

    #[test]
    fn a_missing_log_is_empty() {
        assert!(load_from(&tmp_dir().join("needs_you.json"), 1).events.is_empty());
    }

    const HOUR: u64 = 60 * 60 * 1000;

    #[test]
    fn the_mark_survives_a_reload_and_never_moves_back() {
        let path = tmp_dir().join("needs_you.json");
        let mut log = Log::default();
        assert!(log.looked(50, 100));
        assert!(!log.looked(40, 100));
        assert!(log.looked(500, 100), "never past now");
        save_to(&path, &log).unwrap();
        assert_eq!(load_from(&path, 200).looked_at, Some(100));
    }

    #[test]
    fn rows_since_the_mark_outlive_the_day_until_the_mark_moves() {
        let mut log = Log::default();
        let now = 10 * KEEP_MS;
        World::new(vec![live("c", Some(Reason::Waiting))]).step(&mut log, now - 30 * HOUR);
        log.looked(now - 40 * HOUR, now);
        log.prune(now);
        assert_eq!(log.events.len(), 1);
        log.looked(now - 20 * HOUR, now);
        log.prune(now);
        assert!(log.events.is_empty());
    }

    #[test]
    fn rows_since_the_mark_still_drop_after_a_week() {
        let mut log = Log::default();
        let now = 10 * KEEP_MS;
        World::new(vec![live("c", Some(Reason::Waiting))]).step(&mut log, now - 8 * KEEP_MS);
        log.looked(now - 9 * KEEP_MS, now);
        log.prune(now);
        assert!(log.events.is_empty());
    }

    #[test]
    fn since_reads_finished_turns_after_the_mark_and_every_open_block() {
        let mut log = Log::default();
        let mut w = World::new(vec![live("old", Some(Reason::Approval)), live("a", None)]);
        w.finished = vec!["a".into()];
        w.step(&mut log, 10);
        log.looked(20, 20);
        log.note_verdict("a", Verdict::Failed, 15);
        w.step(&mut log, 30);
        log.note_verdict("a", Verdict::Verified, 35);
        let read = log.since(None, 40);
        assert_eq!(read.since, 20);
        assert_eq!(read.done.iter().map(|e| e.ts).collect::<Vec<_>>(), [30]);
        assert_eq!(read.waiting.len(), 1);
        assert_eq!(read.waiting[0].session.as_deref(), Some("old"));
        assert_eq!(read.verdicts["a"].verdict, Verdict::Verified);
        assert_eq!(
            log.since(Some(5), 40).done.len(),
            2,
            "an open tab keeps the since it opened with"
        );
    }

    #[test]
    fn before_any_look_since_is_a_day_back() {
        assert_eq!(Log::default().since(None, KEEP_MS + 7).since, 7);
    }
}
