//! The autopilot's watcher: worker events in, one short wake line per item out,
//! sent as a new turn once the autopilot is idle. It never calls a model or reads
//! a transcript. See [[adr_autopilot_is_a_session_not_a_state_machine]].

use std::collections::{BTreeMap, HashMap};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::runner::{RunnerState, Status};
use super::states::SessionStates;
use crate::autopilot::AutopilotStore;

// A turn that ends and another that starts at once is the agent carrying on.
const IDLE_DEBOUNCE: Duration = Duration::from_secs(10);
// `pr` and `idle` can flap, and every wake is a paid turn.
const REPEAT_WINDOW: Duration = Duration::from_secs(5 * 60);
// A send the autopilot never opened a turn for must not hold every later wake.
const SENT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_WAIT: Duration = Duration::from_secs(60);
const STALL_REREAD: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Target {
    Item(String),
    // A worker no item names yet.
    Session(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum What {
    Question,
    Permission,
    NeedsYou,
    Ended(String),
    Pr(String),
    Idle(String),
    Stalled,
}

impl What {
    fn kind(&self) -> &'static str {
        match self {
            What::Question => "question",
            What::Permission => "permission",
            What::NeedsYou => "needs_you",
            What::Ended(_) => "ended",
            What::Pr(_) => "pr",
            What::Idle(_) => "idle",
            What::Stalled => "stalled",
        }
    }

    fn capped(&self) -> bool {
        matches!(self, What::Pr(_) | What::Idle(_))
    }

    fn text(&self) -> String {
        match self {
            What::Ended(detail) | What::Pr(detail) | What::Idle(detail) => format!("{} ({detail})", self.kind()),
            _ => self.kind().to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Line {
    session: Option<String>,
    whats: Vec<What>,
}

impl Line {
    fn merge(&mut self, session: Option<String>, what: What) {
        if session.is_some() {
            self.session = session;
        }
        match self.whats.iter_mut().find(|w| w.kind() == what.kind()) {
            Some(held) => *held = what,
            None => self.whats.push(what),
        }
    }
}

pub fn render(batch: &[(Target, Line)]) -> String {
    let lines = batch.iter().map(|(target, line)| {
        let whats = line.whats.iter().map(What::text).collect::<Vec<_>>().join(", ");
        match (target, &line.session) {
            (Target::Item(item), Some(session)) => format!("item {item}: {whats}, session {session}"),
            (Target::Item(item), None) => format!("item {item}: {whats}"),
            (Target::Session(session), _) => format!("session {session}: {whats}"),
        }
    });
    lines.collect::<Vec<_>>().join("\n")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pilot {
    Off,
    Busy,
    Idle,
}

impl Pilot {
    fn of(state: RunnerState) -> Self {
        match state {
            RunnerState::Off | RunnerState::Error => Pilot::Off,
            RunnerState::Starting | RunnerState::Working => Pilot::Busy,
            RunnerState::Idle => Pilot::Idle,
        }
    }
}

struct Track {
    target: Target,
    in_turn: bool,
    last: Instant,
    // A question or permission is open, so the silence is the user's.
    asking: bool,
    stalled: bool,
    idle: Option<(Instant, String)>,
}

impl Track {
    fn stall_due(&self, stall: Duration) -> Option<Instant> {
        (self.in_turn && !self.asking && !self.stalled).then(|| self.last + stall)
    }
}

type Capped = (Target, &'static str);

// Time is passed in, so the tests never wait on a clock.
pub struct Core {
    tracks: HashMap<String, Track>,
    pending: BTreeMap<Target, Line>,
    held: BTreeMap<Capped, (Option<String>, What)>,
    last_sent: HashMap<Capped, Instant>,
    pilot: (Pilot, Option<String>),
    sent: Option<Instant>,
}

impl Default for Core {
    fn default() -> Self {
        Self {
            tracks: HashMap::new(),
            pending: BTreeMap::new(),
            held: BTreeMap::new(),
            last_sent: HashMap::new(),
            pilot: (Pilot::Off, None),
            sent: None,
        }
    }
}

fn word(value: &Value) -> String {
    value.as_str().map_or_else(|| value.to_string(), str::to_string)
}

impl Core {
    fn target_of(&self, id: &str) -> Option<Target> {
        self.tracks.get(id).map(|t| t.target.clone())
    }

    pub fn observe(&mut self, id: &str, target: Target, event: &Value, now: Instant) {
        let track = self.tracks.entry(id.to_string()).or_insert_with(|| Track {
            target: target.clone(),
            in_turn: false,
            last: now,
            asking: false,
            stalled: false,
            idle: None,
        });
        track.target = target.clone();
        let what = match event["kind"].as_str().unwrap_or_default() {
            "session.turn_started" => {
                (track.in_turn, track.last, track.stalled, track.idle) = (true, now, false, None);
                None
            }
            "session.turn_ended" => {
                track.in_turn = false;
                track.idle = Some((now + IDLE_DEBOUNCE, word(&event["outcome"])));
                None
            }
            "session.question" => {
                track.asking = true;
                Some(What::Question)
            }
            "session.permission" => {
                track.asking = true;
                Some(What::Permission)
            }
            "session.needs_you" => Some(What::NeedsYou),
            "session.ended" => {
                self.tracks.remove(id);
                Some(What::Ended(word(&event["reason"])))
            }
            _ => None,
        };
        if let Some(what) = what {
            self.queue(target, Some(id.to_string()), what, now);
        }
    }

    pub fn pr(&mut self, target: Target, session: Option<String>, detail: String, now: Instant) {
        self.queue(target, session, What::Pr(detail), now);
    }

    pub fn touch(&mut self, id: &str, now: Instant) {
        if let Some(track) = self.tracks.get_mut(id) {
            (track.last, track.asking, track.stalled) = (now, false, false);
        }
    }

    fn queue(&mut self, target: Target, session: Option<String>, what: What, now: Instant) {
        if self.pilot.0 == Pilot::Off {
            return;
        }
        if what.capped() {
            let key = (target.clone(), what.kind());
            if self.last_sent.get(&key).is_some_and(|at| now.duration_since(*at) < REPEAT_WINDOW) {
                self.held.insert(key, (session, what));
                return;
            }
            self.last_sent.insert(key, now);
        }
        self.pending.entry(target).or_default().merge(session, what);
    }

    pub fn set_pilot(&mut self, state: RunnerState, session: Option<String>) {
        let next = (Pilot::of(state), session);
        if next == self.pilot {
            return;
        }
        self.pilot = next;
        self.sent = None;
        if self.pilot.0 == Pilot::Off {
            self.pending.clear();
            self.held.clear();
        }
    }

    pub fn tick(&mut self, now: Instant, stall: Duration) {
        let mut due = Vec::new();
        for (id, track) in &mut self.tracks {
            if let Some((_, outcome)) = track.idle.take_if(|(at, _)| *at <= now) {
                due.push((track.target.clone(), id.clone(), What::Idle(outcome)));
            }
            if track.stall_due(stall).is_some_and(|at| at <= now) {
                track.stalled = true;
                due.push((track.target.clone(), id.clone(), What::Stalled));
            }
        }
        for (target, id, what) in due {
            self.queue(target, Some(id), what, now);
        }
        let expired: Vec<Capped> =
            self.held.keys().filter(|key| self.last_sent.get(*key).is_none_or(|at| now.duration_since(*at) >= REPEAT_WINDOW)).cloned().collect();
        for key in expired {
            if let Some((session, what)) = self.held.remove(&key) {
                self.last_sent.insert(key.clone(), now);
                self.pending.entry(key.0).or_default().merge(session, what);
            }
        }
        self.last_sent.retain(|_, at| now.duration_since(*at) < REPEAT_WINDOW);
        if self.sent.is_some_and(|at| now.duration_since(at) >= SENT_TIMEOUT) {
            self.sent = None;
        }
    }

    pub fn take(&mut self, now: Instant) -> Option<Vec<(Target, Line)>> {
        if self.pilot.0 != Pilot::Idle || self.sent.is_some() || self.pending.is_empty() {
            return None;
        }
        self.sent = Some(now);
        Some(std::mem::take(&mut self.pending).into_iter().collect())
    }

    // `sent` stays, so a dead session is retried on `SENT_TIMEOUT` rather than in a loop.
    pub fn requeue(&mut self, batch: Vec<(Target, Line)>) {
        for (target, mut line) in batch {
            if let Some(newer) = self.pending.remove(&target) {
                newer.whats.into_iter().for_each(|what| line.merge(newer.session.clone(), what));
            }
            self.pending.insert(target, line);
        }
    }

    pub fn next_deadline(&self, stall: Duration) -> Option<Instant> {
        let tracks = self.tracks.values().flat_map(|t| [t.idle.as_ref().map(|(at, _)| *at), t.stall_due(stall)]).flatten();
        let held = self.held.keys().filter_map(|key| self.last_sent.get(key).map(|at| *at + REPEAT_WINDOW));
        let sent = self.sent.map(|at| at + SENT_TIMEOUT);
        tracks.chain(held).chain(sent).min()
    }
}

type StatusOf = Box<dyn Fn() -> Status + Send + Sync>;

pub struct Watcher {
    core: Mutex<Core>,
    nudge: Sender<()>,
    states: Arc<SessionStates>,
    store: Arc<AutopilotStore>,
    status: StatusOf,
}

impl Watcher {
    pub fn new(states: Arc<SessionStates>, store: Arc<AutopilotStore>, status: StatusOf) -> (Arc<Self>, Receiver<()>) {
        let (nudge, rx) = mpsc::channel();
        (Arc::new(Self { core: Mutex::new(Core::default()), nudge, states, store, status }), rx)
    }

    fn core(&self) -> MutexGuard<'_, Core> {
        self.core.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn nudge(&self) {
        let _ = self.nudge.send(());
    }

    // Looked up before the core is locked, so the core never holds the store's
    // or the states' lock. A worker the core already tracks stays watched after
    // its spawner mark goes, which happens before its `session.ended`.
    fn found(&self, id: &str) -> Option<Target> {
        let autopilot = (self.status)().session?;
        if id == autopilot {
            return None;
        }
        if let Some(item) = self.store.item_for_session(id) {
            return Some(Target::Item(item));
        }
        (self.states.spawner_of(id).as_deref() == Some(autopilot.as_str())).then(|| Target::Session(id.to_string()))
    }

    pub fn session_event(&self, id: &str, event: &Value) {
        let found = self.found(id);
        let mut core = self.core();
        let Some(target) = found.or_else(|| core.target_of(id)) else { return };
        core.observe(id, target, event, Instant::now());
        drop(core);
        self.nudge();
    }

    pub fn pr_event(&self, url: Option<&str>, checked_out_in: Option<&str>, ids: &[String], event: &Value) {
        let mut targets: BTreeMap<Target, Option<String>> =
            self.store.items_for_pr(url, checked_out_in).into_iter().map(|(item, session)| (Target::Item(item), session)).collect();
        let found: Vec<(String, Option<Target>)> = ids.iter().map(|id| (id.clone(), self.found(id))).collect();
        let mut core = self.core();
        for (id, target) in found {
            if let Some(target) = target.or_else(|| core.target_of(&id)) {
                targets.entry(target).or_insert(Some(id));
            }
        }
        if targets.is_empty() {
            return;
        }
        let detail = pr_detail(event);
        let now = Instant::now();
        for (target, session) in targets {
            core.pr(target, session, detail.clone(), now);
        }
        drop(core);
        self.nudge();
    }

    pub fn touch(&self, id: &str) {
        self.core().touch(id, Instant::now());
    }

    // Sleeps until the next deadline or a nudge, so quiet workers cost nothing.
    pub fn run(&self, rx: Receiver<()>, deliver: impl Fn(&str, String) -> Result<(), String>, stall_of: impl Fn() -> Duration) {
        let (mut stall, mut read_at) = (stall_of(), Instant::now());
        loop {
            let now = Instant::now();
            if now.duration_since(read_at) >= STALL_REREAD {
                (stall, read_at) = (stall_of(), now);
            }
            let status = (self.status)();
            let batch = {
                let mut core = self.core();
                core.set_pilot(status.state, status.session.clone());
                core.tick(now, stall);
                core.take(now)
            };
            if let (Some(batch), Some(session)) = (batch, &status.session) {
                if let Err(e) = deliver(session, render(&batch)) {
                    eprintln!("tori: autopilot wake not delivered: {e}");
                    self.core().requeue(batch);
                }
            }
            let next = self.core().next_deadline(stall);
            let wait = next.map_or(MAX_WAIT, |at| at.saturating_duration_since(Instant::now())).min(MAX_WAIT);
            match rx.recv_timeout(wait) {
                Err(RecvTimeoutError::Disconnected) => return,
                _ => while rx.try_recv().is_ok() {},
            }
        }
    }
}

fn pr_detail(event: &Value) -> String {
    let pr = &event["pull_request"];
    let mut parts = Vec::new();
    if let Some(number) = pr["number"].as_u64() {
        parts.push(format!("#{number} {}", word(&pr["state"])));
    }
    for field in ["checks", "review"] {
        if let Some(value) = event[field].as_str() {
            parts.push(format!("{field} {value}"));
        }
    }
    parts.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const STALL: Duration = Duration::from_secs(20 * 60);

    fn event(kind: &str) -> Value {
        json!({ "kind": kind })
    }

    fn item(id: &str) -> Target {
        Target::Item(id.into())
    }

    fn idle_core() -> Core {
        let mut core = Core::default();
        core.set_pilot(RunnerState::Idle, Some("pilot".into()));
        core
    }

    fn lines(core: &mut Core, now: Instant) -> String {
        core.take(now).map(|batch| render(&batch)).unwrap_or_default()
    }

    fn mins(n: u64) -> Duration {
        Duration::from_secs(n * 60)
    }

    #[test]
    fn ordinary_work_classifies_to_nothing() {
        let (mut core, now) = (idle_core(), Instant::now());
        for kind in ["session.started", "session.turn_started", "session.checkpoint", "session.state"] {
            core.observe("w", item("i1"), &event(kind), now);
        }
        assert_eq!(core.take(now), None);
    }

    #[test]
    fn a_question_and_its_needs_you_are_one_line() {
        let (mut core, now) = (idle_core(), Instant::now());
        core.observe("w", item("i1"), &event("session.question"), now);
        core.observe("w", item("i1"), &event("session.needs_you"), now);
        assert_eq!(lines(&mut core, now), "item i1: question, needs_you, session w");
    }

    #[test]
    fn a_worker_with_no_item_yet_is_named_by_its_session() {
        let (mut core, now) = (idle_core(), Instant::now());
        core.observe("w", Target::Session("w".into()), &event("session.question"), now);
        assert_eq!(lines(&mut core, now), "session w: question");
    }

    #[test]
    fn a_turn_end_wakes_as_idle_unless_the_next_turn_starts_within_the_debounce() {
        let (mut core, now) = (idle_core(), Instant::now());
        core.observe("w", item("i1"), &json!({ "kind": "session.turn_ended", "outcome": "completed" }), now);
        core.observe("w", item("i1"), &event("session.turn_started"), now + Duration::from_secs(3));
        core.tick(now + Duration::from_secs(11), STALL);
        assert_eq!(core.take(now), None, "the agent carried on");

        core.observe("w", item("i1"), &json!({ "kind": "session.turn_ended", "outcome": "completed" }), now);
        core.tick(now + Duration::from_secs(9), STALL);
        assert_eq!(core.take(now), None, "still inside the debounce");
        core.tick(now + Duration::from_secs(10), STALL);
        assert_eq!(lines(&mut core, now), "item i1: idle (completed), session w");
    }

    #[test]
    fn a_silent_turn_stalls_once_per_silence() {
        let (mut core, start) = (idle_core(), Instant::now());
        core.observe("w", item("i1"), &event("session.turn_started"), start);
        core.tick(start + mins(21), STALL);
        assert_eq!(lines(&mut core, start + mins(21)), "item i1: stalled, session w");
        core.set_pilot(RunnerState::Working, Some("pilot".into()));
        core.set_pilot(RunnerState::Idle, Some("pilot".into()));

        core.tick(start + mins(40), STALL);
        assert_eq!(core.take(start + mins(40)), None, "still the same silence");

        core.touch("w", start + mins(41));
        core.tick(start + mins(62), STALL);
        assert_eq!(lines(&mut core, start + mins(62)), "item i1: stalled, session w", "a new silence");
    }

    #[test]
    fn waiting_on_an_answer_is_not_a_stall() {
        let (mut core, start) = (idle_core(), Instant::now());
        core.observe("w", item("i1"), &event("session.turn_started"), start);
        core.observe("w", item("i1"), &event("session.question"), start + mins(1));
        let _ = core.take(start + mins(1));
        core.set_pilot(RunnerState::Working, Some("pilot".into()));
        core.set_pilot(RunnerState::Idle, Some("pilot".into()));
        core.tick(start + mins(26), STALL);
        assert_eq!(core.take(start + mins(26)), None);
    }

    #[test]
    fn a_repeating_pr_wakes_once_then_once_more_with_its_latest_state() {
        let (mut core, start) = (idle_core(), Instant::now());
        core.pr(item("i1"), None, "checks pending".into(), start);
        assert_eq!(lines(&mut core, start), "item i1: pr (checks pending)");
        core.set_pilot(RunnerState::Working, Some("pilot".into()));
        core.set_pilot(RunnerState::Idle, Some("pilot".into()));

        core.pr(item("i1"), None, "checks failure".into(), start + mins(1));
        core.pr(item("i1"), None, "checks success".into(), start + mins(2));
        core.tick(start + mins(3), STALL);
        assert_eq!(core.take(start + mins(3)), None, "held inside the window");
        core.tick(start + mins(5), STALL);
        assert_eq!(lines(&mut core, start + mins(5)), "item i1: pr (checks success)");
    }

    #[test]
    fn questions_are_never_held_by_the_window() {
        let (mut core, start) = (idle_core(), Instant::now());
        core.observe("w", item("i1"), &event("session.question"), start);
        assert!(!lines(&mut core, start).is_empty());
        core.set_pilot(RunnerState::Working, Some("pilot".into()));
        core.set_pilot(RunnerState::Idle, Some("pilot".into()));
        core.observe("w", item("i1"), &event("session.question"), start + mins(2));
        assert_eq!(lines(&mut core, start + mins(2)), "item i1: question, session w");
    }

    #[test]
    fn wakes_during_one_autopilot_turn_go_out_as_one_send() {
        let (mut core, now) = (Core::default(), Instant::now());
        core.set_pilot(RunnerState::Working, Some("pilot".into()));
        for n in 0..10 {
            core.observe(&format!("w{n}"), item(&format!("i{n}")), &event("session.question"), now);
        }
        assert_eq!(core.take(now), None, "held while it works");
        core.set_pilot(RunnerState::Idle, Some("pilot".into()));
        let batch = core.take(now).expect("sent once it is idle");
        assert_eq!(render(&batch).lines().count(), 10);
        assert_eq!(core.take(now), None, "nothing left, and nothing sent twice");
    }

    #[test]
    fn wakes_while_off_are_dropped() {
        let (mut core, now) = (Core::default(), Instant::now());
        core.observe("w", item("i1"), &event("session.question"), now);
        core.set_pilot(RunnerState::Idle, Some("pilot".into()));
        assert_eq!(core.take(now), None);

        core.observe("w", item("i1"), &event("session.question"), now);
        core.set_pilot(RunnerState::Off, None);
        core.set_pilot(RunnerState::Idle, Some("pilot-2".into()));
        assert_eq!(core.take(now), None, "a stop drops what was pending");
    }

    #[test]
    fn a_send_with_no_turn_lets_the_next_batch_out_after_the_timeout() {
        let (mut core, now) = (idle_core(), Instant::now());
        core.observe("a", item("i1"), &event("session.question"), now);
        assert!(core.take(now).is_some());
        core.observe("b", item("i2"), &event("session.question"), now + Duration::from_secs(1));
        core.tick(now + Duration::from_secs(20), STALL);
        assert_eq!(core.take(now + Duration::from_secs(20)), None, "the first send may still open its turn");
        core.tick(now + Duration::from_secs(30), STALL);
        assert_eq!(lines(&mut core, now + Duration::from_secs(30)), "item i2: question, session b");
    }

    #[test]
    fn a_failed_send_keeps_the_batch() {
        let (mut core, now) = (idle_core(), Instant::now());
        core.observe("w", item("i1"), &event("session.question"), now);
        let batch = core.take(now).unwrap();
        core.observe("w", item("i1"), &json!({ "kind": "session.ended", "reason": "died" }), now);
        core.requeue(batch);
        core.tick(now + SENT_TIMEOUT, STALL);
        assert_eq!(lines(&mut core, now + SENT_TIMEOUT), "item i1: question, ended (died), session w");
    }

    fn store(name: &str) -> (Arc<AutopilotStore>, std::path::PathBuf) {
        let dir = crate::autopilot::tests::temp_dir(name);
        (Arc::new(AutopilotStore::open(dir.clone(), Box::new(|_| {}))), dir)
    }

    fn watcher(states: Arc<SessionStates>, store: Arc<AutopilotStore>) -> Arc<Watcher> {
        let status = Box::new(|| Status {
            state: RunnerState::Idle,
            session: Some("pilot".into()),
            agent: None,
            cwd: None,
            error: None,
            since: None,
        });
        let (watcher, _rx) = Watcher::new(states, store, status);
        watcher.core().set_pilot(RunnerState::Idle, Some("pilot".into()));
        watcher
    }

    fn pending(watcher: &Watcher) -> String {
        lines(&mut watcher.core(), Instant::now())
    }

    #[test]
    fn a_worker_is_watched_by_its_spawner_before_any_item_names_it() {
        let (store, dir) = store("watcher-spawner");
        let states = Arc::new(SessionStates::default());
        states.mark_worker("w", "pilot");
        let watcher = watcher(states, store);
        watcher.session_event("w", &event("session.question"));
        watcher.session_event("stranger", &event("session.question"));
        watcher.session_event("pilot", &event("session.question"));
        assert_eq!(pending(&watcher), "session w: question");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_done_items_session_is_no_longer_watched() {
        use crate::autopilot::{Kind, Patch, Source, State, Target as Key};
        let (store, dir) = store("watcher-done");
        let key = Key::Key { kind: Kind::Review, source: Source::Pr { number: 7, repo: "o/r".into() }, project: "/p".into() };
        let made = store.update(key, Patch { session: Some("w".into()), state: Some(State::Done), ..Patch::default() }).unwrap();
        assert_eq!(made.state, State::Done);
        let watcher = watcher(Arc::new(SessionStates::default()), store);
        watcher.session_event("w", &event("session.question"));
        assert_eq!(pending(&watcher), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pr_change_after_the_worker_ended_still_wakes_its_item() {
        use crate::autopilot::{Kind, Patch, Source, Target as Key};
        let (store, dir) = store("watcher-pr");
        let ship = Key::Key { kind: Kind::Ship, source: Source::Issue { key: "12".into(), project: "/p".into() }, project: "/p".into() };
        let url = "https://github.com/o/r/pull/9";
        let shipped = store.update(ship, Patch { pr_url: Some(url.into()), ..Patch::default() }).unwrap();
        let review = Key::Key { kind: Kind::Review, source: Source::Pr { number: 4, repo: "O/R".into() }, project: "/p".into() };
        let reviewed = store.update(review, Patch::default()).unwrap();
        let watcher = watcher(Arc::new(SessionStates::default()), store);

        let moved = json!({ "pull_request": { "number": 9, "state": "open" }, "checks": "failure", "review": "none" });
        watcher.pr_event(Some(url), None, &[], &moved);
        assert_eq!(pending(&watcher), format!("item {}: pr (#9 open; checks failure; review none)", shipped.id));

        watcher.core().set_pilot(RunnerState::Working, Some("pilot".into()));
        watcher.core().set_pilot(RunnerState::Idle, Some("pilot".into()));
        let theirs = json!({ "pull_request": { "number": 4, "state": "open" }, "checks": "success", "review": "approved" });
        watcher.pr_event(Some("https://github.com/o/r/pull/4"), None, &[], &theirs);
        assert_eq!(pending(&watcher), format!("item {}: pr (#4 open; checks success; review approved)", reviewed.id));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
