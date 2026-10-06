//! The autopilot's own session: started, stopped and restarted by Rust, so it
//! runs with no tab open. See [[adr_autopilot_is_a_session_not_a_state_machine]].
//!
//! A start resumes the last session unless it died; see
//! [[adr_every_autopilot_start_is_a_fresh_session]]. A fresh id takes over what
//! the earlier one held (its workers, its holds, the approval cards mirrored to
//! it), and `runner.json` keeps the ids it retired so a worker resumed after a
//! relaunch still finds its way back.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::asks::Asks;
use super::bridge::Bridge;
use super::events::{now_ms, EndReason, TurnBy};
use super::hub::{Channel, Hub};
use super::states::SessionStates;
use crate::agents::ChatTransport;
use crate::autopilot::State as ItemState;
use crate::chat::commands::{spawn_session, SpawnRequest};
use crate::chat::host::ChatState;
use crate::chat::model::{ChatEvent, ContentBlock, Extra, SlashCommand};
use crate::owned_state::write_atomically;

const BRIEF: &str = "resources/autopilot/brief.md";
// An ACP agent answers `session/new` before it can take a model or a turn.
const STARTED_TIMEOUT: Duration = Duration::from_secs(60);
const RETIRED_KEPT: usize = 20;
// A resumed transcript holds the brief it started with, and a compaction
// summarizes the brief away, so both are sent the brief as it is now.
const RESUMED: &str = "Tori stopped you and has now resumed this session. This brief replaces the one earlier in \
this chat. Start again from its first step.";
const COMPACTED: &str = "Tori compacted this chat. Here is your brief again; it holds over anything the summary \
says. Nothing changed for me, so do not run its opening steps or tell me anything: end this turn without a message.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunnerState {
    Off,
    Starting,
    Idle,
    Working,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunnerError {
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub state: RunnerState,
    pub session: Option<String>,
    pub agent: Option<String>,
    // Where the session runs, for a view that attaches to it.
    pub cwd: Option<String>,
    pub error: Option<RunnerError>,
}

impl Status {
    fn off() -> Self {
        Self {
            state: RunnerState::Off,
            session: None,
            agent: None,
            cwd: None,
            error: None,
        }
    }

    // Keeps the session that failed, so its transcript can still be read.
    fn failed(self, title: &str, detail: String) -> Self {
        Self {
            state: RunnerState::Error,
            error: Some(RunnerError {
                title: title.into(),
                detail,
            }),
            ..self
        }
    }
}

#[derive(Debug, PartialEq)]
enum AfterEnd {
    Restart,
    Fail,
    Off,
}

// Only a death restarts: `Closed` is a stop or app exit, `Killed` a person's choice.
fn after_end(reason: EndReason, deaths_before: u32) -> AfterEnd {
    match (reason, deaths_before) {
        (EndReason::Died, 0) => AfterEnd::Restart,
        (EndReason::Died, _) => AfterEnd::Fail,
        _ => AfterEnd::Off,
    }
}

/// Whether a person is kept out of `session` while the autopilot drives it: an
/// in flight item names it, or the autopilot spawned it and no item names it
/// yet. `spawner` is already resolved, so a retired autopilot id reads as the
/// current one. A worker whose item closed is released.
pub fn locks(pilot: &Status, item: Option<ItemState>, spawner: Option<&str>) -> bool {
    if !matches!(
        pilot.state,
        RunnerState::Starting | RunnerState::Idle | RunnerState::Working
    ) {
        return false;
    }
    match item {
        Some(state) => matches!(state, ItemState::Running | ItemState::WaitingOnYou),
        None => spawner.is_some() && spawner == pilot.session.as_deref(),
    }
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
struct RunnerFile {
    #[serde(default)]
    current: Option<String>,
    #[serde(default)]
    previous: Option<String>,
    #[serde(default)]
    retired: Vec<String>,
    // The agent the current session runs on; another agent cannot resume it.
    #[serde(default)]
    agent: Option<String>,
    // The current session ended in a death, so its transcript may not resume.
    #[serde(default)]
    died: bool,
}

impl RunnerFile {
    fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn resumable(&self, agent: &str) -> Option<String> {
        self.current
            .clone()
            .filter(|_| !self.died && self.agent.as_deref() == Some(agent))
    }

    // The id the new session replaces, if there was one.
    fn start(&mut self, id: &str, agent: &str) -> Option<String> {
        self.died = false;
        self.agent = Some(agent.to_string());
        let previous = self.current.replace(id.to_string());
        if let Some(prev) = &previous {
            self.retired.retain(|r| r != prev);
            self.retired.push(prev.clone());
            let over = self.retired.len().saturating_sub(RETIRED_KEPT);
            self.retired.drain(..over);
        }
        self.previous = previous.clone();
        previous
    }
}

fn resolve(file: &RunnerFile, spawner: &str) -> String {
    match &file.current {
        Some(current) if file.retired.iter().any(|r| r == spawner) => current.clone(),
        _ => spawner.to_string(),
    }
}

// The runner's session's context, read off the events its sink sees.
#[derive(Debug, Default)]
struct Gauge {
    model: Option<String>,
    used: Option<u64>,
    window: Option<u64>,
    can_compact: bool,
    compacting: bool,
    rebrief: bool,
    rebriefed: bool,
}

impl Gauge {
    fn see(&mut self, event: &ChatEvent) {
        match event {
            ChatEvent::SessionStarted {
                model, slash_commands, ..
            } => {
                self.model = Some(model.clone());
                self.learn(slash_commands);
            }
            ChatEvent::SessionReady { slash_commands, .. } => self.learn(slash_commands),
            ChatEvent::SlashCommands { commands, .. } => self.learn(commands),
            ChatEvent::Usage { usage, extra, .. } => {
                self.used = Some(usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens);
                self.compacting = false;
                if let Some(size) = extra.get("contextWindow").and_then(Value::as_u64).filter(|s| *s > 0) {
                    self.window = Some(size);
                }
            }
            ChatEvent::TurnCompleted { extra, .. } => {
                if let Some(window) = reported_window(extra, self.model.as_deref()) {
                    self.window = Some(window);
                }
            }
            ChatEvent::Compacted { post_tokens, .. } => self.used = *post_tokens,
            _ => {}
        }
    }

    // An empty list is a catalogue that did not come, not one without `compact`.
    fn learn(&mut self, commands: &[SlashCommand]) {
        if !commands.is_empty() {
            self.can_compact = commands.iter().any(|c| c.name.trim_start_matches('/') == "compact");
        }
    }

    fn due(&self, at: Option<u32>) -> bool {
        let (Some(at), Some(used), Some(window)) = (at, self.used, self.window) else {
            return false;
        };
        self.can_compact && !self.compacting && used * 100 >= u64::from(at) * window
    }
}

// Claude's `modelUsage` names every model a turn billed, side work included, so
// the session's own model is looked up first; the largest window stands in when
// its id is spelled differently there.
fn reported_window(extra: &Extra, model: Option<&str>) -> Option<u64> {
    let usage = extra.get("modelUsage")?.as_object()?;
    let window = |v: &Value| v["contextWindow"].as_u64().filter(|w| *w > 0);
    let named = model.and_then(|m| {
        usage
            .iter()
            .find(|(id, v)| id.as_str() == m || v["canonicalModel"].as_str() == Some(m))
            .and_then(|(_, v)| window(v))
    });
    named.or_else(|| usage.values().filter_map(window).max())
}

struct Inner {
    status: Status,
    deaths: u32,
}

pub struct Runner {
    app: AppHandle,
    hub: Arc<Hub>,
    states: Arc<SessionStates>,
    asks: Arc<Asks>,
    bridge: Arc<Bridge>,
    dir: PathBuf,
    inner: Mutex<Inner>,
    gauge: Arc<Mutex<Gauge>>,
}

impl Runner {
    pub fn new(
        app: AppHandle,
        hub: Arc<Hub>,
        states: Arc<SessionStates>,
        asks: Arc<Asks>,
        bridge: Arc<Bridge>,
        dir: PathBuf,
    ) -> Self {
        Self {
            app,
            hub,
            states,
            asks,
            bridge,
            dir,
            inner: Mutex::new(Inner {
                status: Status::off(),
                deaths: 0,
            }),
            gauge: Arc::default(),
        }
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn gauge(&self) -> MutexGuard<'_, Gauge> {
        self.gauge.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn session_dir(&self) -> PathBuf {
        self.dir.join("session")
    }

    fn file_path(&self) -> PathBuf {
        self.dir.join("runner.json")
    }

    pub fn status(&self) -> Status {
        self.inner().status.clone()
    }

    fn set(&self, status: Status) {
        self.inner().status = status.clone();
        self.hub.publish(
            &Channel::Autopilot,
            json!({ "kind": "autopilot.status", "runner": status, "ts": now_ms() }),
        );
        let _ = self.app.emit("autopilot://status", &status);
        super::nudge_watcher();
    }

    /// Turn it on. A manual start clears a previous error and its death count.
    pub fn start(self: &Arc<Self>) -> Result<Status, String> {
        crate::settings::set_autopilot_enabled(true)?;
        let running = {
            let mut inner = self.inner();
            inner.deaths = 0;
            matches!(
                inner.status.state,
                RunnerState::Starting | RunnerState::Idle | RunnerState::Working
            )
        };
        if !running {
            self.launch();
        }
        Ok(self.status())
    }

    /// Turn it off. State on disk and every worker stay as they are.
    pub fn stop(&self) -> Result<Status, String> {
        crate::settings::set_autopilot_enabled(false)?;
        let session = self.inner().status.session.clone();
        self.set(Status::off());
        if let Some(id) = session {
            self.app.state::<ChatState>().0.close(&id, EndReason::Closed)?;
        }
        Ok(self.status())
    }

    pub fn autostart(self: &Arc<Self>) {
        let picks = crate::settings::autopilot();
        if picks.available && picks.enabled {
            self.launch();
        }
    }

    /// A lifecycle event from the app socket; only the runner's own session matters.
    pub fn observe(self: &Arc<Self>, id: &str, event: &Value) {
        if self.inner().status.session.as_deref() != Some(id) {
            return;
        }
        match event["kind"].as_str() {
            Some("session.turn_started") => self.set_turn(id, RunnerState::Working),
            Some("session.turn_ended") => {
                if !self.rebrief(id) && !self.compact(id) {
                    self.set_turn(id, RunnerState::Idle);
                }
            }
            Some("session.ended") => {
                let reason = serde_json::from_value(event["reason"].clone()).unwrap_or(EndReason::Closed);
                self.ended(id, reason);
            }
            _ => {}
        }
    }

    // Decided before the runner reads idle, so the watcher's batch waits behind
    // the compaction instead of racing it. Sent off the publishing thread.
    fn compact(self: &Arc<Self>, id: &str) -> bool {
        {
            let mut gauge = self.gauge();
            // A compaction that left the context over the mark would otherwise
            // compact and rebrief forever.
            if std::mem::take(&mut gauge.rebriefed) || !gauge.due(crate::settings::autopilot().compact_at) {
                return false;
            }
            gauge.compacting = true;
            gauge.rebrief = true;
        }
        self.deliver_off_thread(id, "/compact".into(), |gauge| {
            gauge.compacting = false;
            gauge.rebrief = false;
        });
        true
    }

    // Before idle, so the watcher's batch lands after the brief.
    fn rebrief(self: &Arc<Self>, id: &str) -> bool {
        if !std::mem::take(&mut self.gauge().rebrief) {
            return false;
        }
        let Ok(brief) = self.brief() else {
            return false;
        };
        self.gauge().rebriefed = true;
        self.deliver_off_thread(
            id,
            super::events::from_tori("compacted", None, &format!("{COMPACTED}\n\n{brief}")),
            |_| {},
        );
        true
    }

    fn deliver_off_thread(self: &Arc<Self>, id: &str, text: String, on_error: fn(&mut Gauge)) {
        let runner = self.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            let text = vec![ContentBlock::Text { text }];
            if runner
                .app
                .state::<ChatState>()
                .0
                .deliver(&id, text, false, TurnBy::Local)
                .is_err()
            {
                on_error(&mut runner.gauge());
                if runner.is_current(&id) {
                    runner.set_turn(&id, RunnerState::Idle);
                }
            }
        });
    }

    fn set_turn(&self, id: &str, state: RunnerState) {
        let status = self.status();
        self.set(Status {
            state,
            session: Some(id.to_string()),
            error: None,
            ..status
        });
    }

    fn ended(self: &Arc<Self>, id: &str, reason: EndReason) {
        let next = {
            let mut inner = self.inner();
            let next = after_end(reason, inner.deaths);
            if reason == EndReason::Died {
                inner.deaths += 1;
            }
            next
        };
        if reason == EndReason::Died {
            self.mark_died(id);
        }
        match next {
            AfterEnd::Restart => self.launch(),
            AfterEnd::Fail => self.set(self.status().failed(
                "The autopilot stopped twice",
                "Its session died, was restarted, and died again. Restart it to try once more.".into(),
            )),
            AfterEnd::Off => self.set(Status::off()),
        }
    }

    /// The autopilot a worker's recorded spawner stands for now: a retired
    /// autopilot id means the current one.
    pub fn resolve_spawner(&self, spawner: &str) -> String {
        resolve(&RunnerFile::load(&self.file_path()), spawner)
    }

    // On a thread of its own: an ACP agent can take a minute to open, and a
    // restart comes from the publishing thread while the old session is still
    // being torn down.
    fn launch(self: &Arc<Self>) {
        let agent = crate::settings::autopilot().agent;
        let resume = RunnerFile::load(&self.file_path()).resumable(&agent);
        let id = resume.clone().unwrap_or_else(new_session_id);
        let cwd = Some(self.session_dir().to_string_lossy().into_owned());
        self.set(Status {
            state: RunnerState::Starting,
            session: Some(id.clone()),
            agent: Some(agent),
            cwd,
            error: None,
        });
        let runner = self.clone();
        std::thread::spawn(move || {
            let mut id = id;
            let mut result = runner.launch_as(&id, resume.is_some());
            if result.is_err() && resume.is_some() && runner.is_current(&id) {
                id = runner.start_fresh_instead(&id);
                result = runner.launch_as(&id, false);
            }
            if let Err(detail) = result {
                if runner.is_current(&id) {
                    runner.set(runner.status().failed("The autopilot could not start", detail));
                }
            }
        });
    }

    // A resume that failed falls back to a fresh session. The status names the
    // new id first, so the old one's end is not read as the autopilot's.
    fn start_fresh_instead(&self, old: &str) -> String {
        let fresh = new_session_id();
        self.set(Status {
            session: Some(fresh.clone()),
            ..self.status()
        });
        let _ = self.app.state::<ChatState>().0.close(old, EndReason::Closed);
        fresh
    }

    fn mark_died(&self, id: &str) {
        let path = self.file_path();
        let mut file = RunnerFile::load(&path);
        if file.current.as_deref() != Some(id) {
            return;
        }
        file.died = true;
        if let Ok(text) = serde_json::to_string_pretty(&file) {
            let _ = write_atomically(&path, &text);
        }
    }

    fn is_current(&self, id: &str) -> bool {
        self.inner().status.session.as_deref() == Some(id)
    }

    fn launch_as(&self, id: &str, resume: bool) -> Result<(), String> {
        let brief = self.brief()?;
        let picks = crate::settings::autopilot();
        let agent_id = picks.agent.clone();
        let adapter = crate::agents::find(&agent_id).ok_or_else(|| format!("unknown agent {agent_id}"))?;
        let transport = adapter
            .chat
            .as_ref()
            .ok_or_else(|| format!("{} has no chat transport", adapter.label))?
            .transport;
        let acp = matches!(transport, ChatTransport::Acp);

        if !resume {
            let path = self.file_path();
            let mut file = RunnerFile::load(&path);
            if let Some(previous) = file.start(id, &agent_id) {
                self.rebind(&previous, id);
            }
            std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
            write_atomically(&path, &serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?)?;
        }

        let cwd = self.session_dir();
        std::fs::create_dir_all(&cwd).map_err(|e| format!("could not make {}: {e}", cwd.display()))?;

        let (started_tx, started_rx) = mpsc::channel();
        let started_tx = Mutex::new(Some(started_tx));
        *self.gauge() = Gauge::default();
        let gauge = self.gauge.clone();
        let host = &self.app.state::<ChatState>().0;
        let spawned = spawn_session(
            host,
            SpawnRequest {
                session_id: id.to_string(),
                tab_id: format!("autopilot-{id}"),
                agent_id,
                cwd: cwd.to_string_lossy().into_owned(),
                resume,
                fork_from: None,
                profile: picks.profile.clone(),
                // An ACP pick is a request after open, sent below.
                model: if acp { None } else { picks.model.clone() },
                mode: None,
                effort: if acp { None } else { picks.effort.clone() },
                extra_dirs: Vec::new(),
                visible: false,
                background: true,
                spawner: None,
            },
            Box::new(move |event| {
                gauge.lock().unwrap_or_else(|e| e.into_inner()).see(&event);
                if matches!(event, ChatEvent::SessionStarted { .. }) {
                    if let Some(tx) = started_tx.lock().ok().and_then(|mut tx| tx.take()) {
                        let _ = tx.send(());
                    }
                }
            }),
        )?;
        if spawned.spawned.is_none() {
            return Err(format!("the session id was refused: {:?}", spawned.ownership));
        }
        // Stopped while it was starting: `stop` found nothing to close yet.
        if !self.is_current(id) {
            return host.close(id, EndReason::Closed);
        }
        if acp {
            started_rx
                .recv_timeout(STARTED_TIMEOUT)
                .map_err(|_| "the agent never opened its session".to_string())?;
            if let Some(model) = &picks.model {
                host.set_model(id, model, picks.effort.clone())?;
            }
        }
        let text = if resume {
            super::events::from_tori("resume", None, &format!("{RESUMED}\n\n{brief}"))
        } else {
            super::events::from_tori("brief", None, &brief)
        };
        host.deliver(id, vec![ContentBlock::Text { text }], false, TurnBy::Local)
    }

    fn brief(&self) -> Result<String, String> {
        let from_bundle = self
            .app
            .path()
            .resolve(BRIEF, tauri::path::BaseDirectory::Resource)
            .ok()
            .filter(|p| p.exists());
        let path = from_bundle.unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/")).join(BRIEF));
        std::fs::read_to_string(&path).map_err(|e| format!("could not read the brief at {}: {e}", path.display()))
    }

    // What the old id held moves to the new one. The webview keeps asks by id,
    // so each moved card is shown again with its new panels.
    fn rebind(&self, from: &str, to: &str) {
        for ask in rebind(&self.states, &self.asks, from, to) {
            let _ = self.bridge.request("ask.show", json!(ask));
        }
    }
}

fn rebind(states: &SessionStates, asks: &Asks, from: &str, to: &str) -> Vec<super::asks::Ask> {
    states.rebind_spawner(from, to);
    asks.rebind_session(from, to)
}

// Claude takes `--session-id` only as a UUID.
fn new_session_id() -> String {
    let mut hex: Vec<char> = crate::platform::ipc::random_id()
        .chars()
        .filter(char::is_ascii_hexdigit)
        .collect();
    hex.resize(32, '0');
    hex[12] = '4';
    hex[16] = ['8', '9', 'a', 'b'][hex[16].to_digit(16).unwrap_or(0) as usize % 4];
    let s: String = hex.into_iter().collect();
    format!(
        "{}-{}-{}-{}-{}",
        &s[0..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_death_restarts_once_and_a_second_one_fails() {
        assert_eq!(after_end(EndReason::Died, 0), AfterEnd::Restart);
        assert_eq!(after_end(EndReason::Died, 1), AfterEnd::Fail);
    }

    #[test]
    fn a_close_or_a_kill_never_restarts() {
        for deaths in [0, 1] {
            assert_eq!(
                after_end(EndReason::Closed, deaths),
                AfterEnd::Off,
                "a stop or app exit"
            );
            assert_eq!(after_end(EndReason::Killed, deaths), AfterEnd::Off);
        }
    }

    fn pilot(state: RunnerState) -> Status {
        Status {
            state,
            session: Some("pilot".into()),
            ..Status::off()
        }
    }

    #[test]
    fn an_in_flight_item_locks_its_session_only_while_the_autopilot_is_on() {
        for on in [RunnerState::Starting, RunnerState::Idle, RunnerState::Working] {
            assert!(locks(&pilot(on), Some(ItemState::Running), None));
            assert!(locks(&pilot(on), Some(ItemState::WaitingOnYou), Some("pilot")));
        }
        for off in [RunnerState::Off, RunnerState::Error] {
            assert!(!locks(&pilot(off), Some(ItemState::Running), Some("pilot")));
        }
    }

    #[test]
    fn a_closed_item_releases_its_worker_even_with_the_autopilot_on() {
        let on = pilot(RunnerState::Idle);
        for closed in [ItemState::Done, ItemState::Failed, ItemState::Queued] {
            assert!(!locks(&on, Some(closed), Some("pilot")), "{closed:?}");
        }
    }

    #[test]
    fn a_worker_no_item_names_is_locked_only_when_the_autopilot_spawned_it() {
        let on = pilot(RunnerState::Working);
        assert!(locks(&on, None, Some("pilot")), "spawned before its item names it");
        assert!(!locks(&on, None, Some("a-foreground-chat")), "another spawner's worker");
        assert!(!locks(&on, None, None), "an ordinary session");
    }

    #[test]
    fn a_retired_spawner_locks_once_resolved_to_the_current_autopilot() {
        let dir = std::env::temp_dir().join(format!("tori-runner-locks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runner.json");
        let mut file = RunnerFile::default();
        file.start("old", "claude");
        file.start("pilot", "claude");
        std::fs::write(&path, serde_json::to_string(&file).unwrap()).unwrap();
        let resolved = resolve(&RunnerFile::load(&path), "old");
        assert!(locks(&pilot(RunnerState::Idle), None, Some(&resolved)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn approval() -> super::super::approvals::Approval {
        let draft = super::super::approvals::Draft::PrMerge {
            number: 7,
            method: crate::forge::MergeMethod::Squash,
            head_sha: "abc".into(),
        };
        super::super::approvals::Approval {
            project: "/p".into(),
            draft,
        }
    }

    // S1 spawned W and held an item; W asked for an approval mirrored to S1.
    // S1 died, and its successor S2 takes over what S1 held.
    fn restart(
        dir: &Path,
        from: &str,
        to: &str,
    ) -> (SessionStates, Asks, super::super::asks::Ask, super::super::asks::Ask) {
        let states = SessionStates::default();
        let asks = Asks::with_holds(dir.join("holds.json"), Box::new(|_| {}));
        states.mark_background(from);
        states.mark_background("w");
        states.mark_worker("w", from);
        let held = asks.create(
            from.into(),
            "merge?".into(),
            vec![],
            Some(approval()),
            None,
            Some("item-1".into()),
        );
        let workers = asks.create(
            "w".into(),
            "merge?".into(),
            vec![],
            Some(approval()),
            states.root_background("w"),
            None,
        );
        asks.forget_session(from);
        states.forget_worker(from);
        states.mark_background(to);
        rebind(&states, &asks, from, to);
        (states, asks, held, workers)
    }

    fn assert_moved(
        states: &SessionStates,
        asks: &Asks,
        held: &super::super::asks::Ask,
        workers: &super::super::asks::Ask,
        to: &str,
    ) {
        assert_eq!(
            states.root_background("w").as_deref(),
            Some(to),
            "the worker's spawner is the new autopilot"
        );
        let mirrored = asks.pending().into_iter().find(|a| a.id == workers.id).unwrap();
        assert!(
            mirrored.shown_in.iter().any(|s| s == to),
            "the worker's card shows in the new autopilot's chat"
        );
        asks.answer(
            &held.id,
            super::super::approvals::APPROVE.into(),
            super::super::asks::By::User,
        )
        .unwrap();
        let super::super::asks::Waited::Answered {
            approval_id: Some(id), ..
        } = asks.wait(&held.id, Duration::ZERO)
        else {
            panic!("no approval id")
        };
        assert!(
            asks.approvals.reserve(Some(&id), to, &approval()).is_ok(),
            "the new autopilot can spend the approval"
        );
    }

    #[test]
    fn a_restart_hands_the_old_sessions_workers_holds_and_cards_to_the_new_one() {
        let dir = crate::autopilot::tests::temp_dir("runner-rebind");
        let (states, asks, held, workers) = restart(&dir, "s1", "s2");
        assert_moved(&states, &asks, &held, &workers, "s2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_relaunch_rebinds_from_the_id_runner_json_kept() {
        let dir = crate::autopilot::tests::temp_dir("runner-relaunch");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runner.json");
        let mut file = RunnerFile::load(&path);
        file.start("s1", "claude");
        write_atomically(&path, &serde_json::to_string(&file).unwrap()).unwrap();

        let mut file = RunnerFile::load(&path);
        let previous = file.start("s2", "claude").expect("the file kept the old id");
        assert_eq!(previous, "s1");
        let (states, asks, held, workers) = restart(&dir, &previous, "s2");
        assert_moved(&states, &asks, &held, &workers, "s2");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
