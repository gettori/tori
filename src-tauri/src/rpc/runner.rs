//! The autopilot's own session: started, stopped and restarted by Rust, so it
//! runs with no tab open. See [[adr_autopilot_is_a_session_not_a_state_machine]].
//!
//! Every start is a fresh session id. What an earlier id held (its workers, its
//! holds, the approval cards mirrored to it) moves to the new one, and
//! `runner.json` keeps the ids it retired so a worker resumed after a relaunch
//! still finds its way back.

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
use crate::chat::commands::{spawn_session, SpawnRequest};
use crate::chat::host::ChatState;
use crate::chat::model::{ChatEvent, ContentBlock};
use crate::owned_state::write_atomically;

const BRIEF: &str = "resources/autopilot/brief.md";
// An ACP agent answers `session/new` before it can take a model or a turn.
const STARTED_TIMEOUT: Duration = Duration::from_secs(60);
const RETIRED_KEPT: usize = 20;

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
        Self { state: RunnerState::Off, session: None, agent: None, cwd: None, error: None }
    }

    // Keeps the session that failed, so its transcript can still be read.
    fn failed(self, title: &str, detail: String) -> Self {
        Self { state: RunnerState::Error, error: Some(RunnerError { title: title.into(), detail }), ..self }
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

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
struct RunnerFile {
    #[serde(default)]
    current: Option<String>,
    #[serde(default)]
    previous: Option<String>,
    #[serde(default)]
    retired: Vec<String>,
}

impl RunnerFile {
    fn load(path: &Path) -> Self {
        std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    // The id the new session replaces, if there was one.
    fn start(&mut self, id: &str) -> Option<String> {
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
}

impl Runner {
    pub fn new(app: AppHandle, hub: Arc<Hub>, states: Arc<SessionStates>, asks: Arc<Asks>, bridge: Arc<Bridge>, dir: PathBuf) -> Self {
        Self { app, hub, states, asks, bridge, dir, inner: Mutex::new(Inner { status: Status::off(), deaths: 0 }) }
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
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
        self.hub.publish(&Channel::Autopilot, json!({ "kind": "autopilot.status", "runner": status, "ts": now_ms() }));
        let _ = self.app.emit("autopilot://status", &status);
        super::nudge_watcher();
    }

    /// Turn it on. A manual start clears a previous error and its death count.
    pub fn start(self: &Arc<Self>) -> Result<Status, String> {
        crate::settings::set_autopilot_enabled(true)?;
        let running = {
            let mut inner = self.inner();
            inner.deaths = 0;
            matches!(inner.status.state, RunnerState::Starting | RunnerState::Idle | RunnerState::Working)
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
        if crate::settings::autopilot().enabled {
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
            Some("session.turn_ended") => self.set_turn(id, RunnerState::Idle),
            Some("session.ended") => {
                let reason = serde_json::from_value(event["reason"].clone()).unwrap_or(EndReason::Closed);
                self.ended(reason);
            }
            _ => {}
        }
    }

    fn set_turn(&self, id: &str, state: RunnerState) {
        let status = self.status();
        self.set(Status { state, session: Some(id.to_string()), error: None, ..status });
    }

    fn ended(self: &Arc<Self>, reason: EndReason) {
        let next = {
            let mut inner = self.inner();
            let next = after_end(reason, inner.deaths);
            if reason == EndReason::Died {
                inner.deaths += 1;
            }
            next
        };
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
        let file = RunnerFile::load(&self.file_path());
        match file.current {
            Some(current) if file.retired.iter().any(|r| r == spawner) => current,
            _ => spawner.to_string(),
        }
    }

    // On a thread of its own: an ACP agent can take a minute to open, and a
    // restart comes from the publishing thread while the old session is still
    // being torn down.
    fn launch(self: &Arc<Self>) {
        let id = new_session_id();
        let agent = crate::settings::autopilot().agent;
        let cwd = Some(self.session_dir().to_string_lossy().into_owned());
        self.set(Status { state: RunnerState::Starting, session: Some(id.clone()), agent: Some(agent), cwd, error: None });
        let runner = self.clone();
        std::thread::spawn(move || {
            if let Err(detail) = runner.launch_as(&id) {
                if runner.is_current(&id) {
                    runner.set(runner.status().failed("The autopilot could not start", detail));
                }
            }
        });
    }

    fn is_current(&self, id: &str) -> bool {
        self.inner().status.session.as_deref() == Some(id)
    }

    fn launch_as(&self, id: &str) -> Result<(), String> {
        let brief = self.brief()?;
        let picks = crate::settings::autopilot();
        let agent_id = picks.agent.clone();
        let adapter = crate::agents::find(&agent_id).ok_or_else(|| format!("unknown agent {agent_id}"))?;
        let transport = adapter.chat.as_ref().ok_or_else(|| format!("{} has no chat transport", adapter.label))?.transport;
        let acp = matches!(transport, ChatTransport::Acp);

        let path = self.file_path();
        let mut file = RunnerFile::load(&path);
        if let Some(previous) = file.start(id) {
            self.rebind(&previous, id);
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        write_atomically(&path, &serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?)?;

        let cwd = self.session_dir();
        std::fs::create_dir_all(&cwd).map_err(|e| format!("could not make {}: {e}", cwd.display()))?;

        let (started_tx, started_rx) = mpsc::channel();
        let started_tx = Mutex::new(Some(started_tx));
        let host = &self.app.state::<ChatState>().0;
        let spawned = spawn_session(
            host,
            SpawnRequest {
                session_id: id.to_string(),
                tab_id: format!("autopilot-{id}"),
                agent_id,
                cwd: cwd.to_string_lossy().into_owned(),
                resume: false,
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
            started_rx.recv_timeout(STARTED_TIMEOUT).map_err(|_| "the agent never opened its session".to_string())?;
            if let Some(model) = &picks.model {
                host.set_model(id, model, picks.effort.clone())?;
            }
        }
        host.deliver(id, vec![ContentBlock::Text { text: brief }], false, TurnBy::Local)
    }

    fn brief(&self) -> Result<String, String> {
        let from_bundle = self.app.path().resolve(BRIEF, tauri::path::BaseDirectory::Resource).ok().filter(|p| p.exists());
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
    let mut hex: Vec<char> = crate::chat::approval::random_token().chars().filter(char::is_ascii_hexdigit).collect();
    hex.resize(32, '0');
    hex[12] = '4';
    hex[16] = ['8', '9', 'a', 'b'][hex[16].to_digit(16).unwrap_or(0) as usize % 4];
    let s: String = hex.into_iter().collect();
    format!("{}-{}-{}-{}-{}", &s[0..8], &s[8..12], &s[12..16], &s[16..20], &s[20..32])
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
            assert_eq!(after_end(EndReason::Closed, deaths), AfterEnd::Off, "a stop or app exit");
            assert_eq!(after_end(EndReason::Killed, deaths), AfterEnd::Off);
        }
    }

    fn approval() -> super::super::approvals::Approval {
        let draft = super::super::approvals::Draft::PrMerge {
            number: 7,
            method: crate::forge::MergeMethod::Squash,
            head_sha: "abc".into(),
        };
        super::super::approvals::Approval { project: "/p".into(), draft }
    }

    // S1 spawned W and held an item; W asked for an approval mirrored to S1.
    // S1 died, and its successor S2 takes over what S1 held.
    fn restart(dir: &Path, from: &str, to: &str) -> (SessionStates, Asks, super::super::asks::Ask, super::super::asks::Ask) {
        let states = SessionStates::default();
        let asks = Asks::with_holds(dir.join("holds.json"), Box::new(|_| {}));
        states.mark_background(from);
        states.mark_background("w");
        states.mark_worker("w", from);
        let held = asks.create(from.into(), "merge?".into(), vec![], Some(approval()), None, Some("item-1".into()));
        let workers = asks.create("w".into(), "merge?".into(), vec![], Some(approval()), states.root_background("w"), None);
        asks.forget_session(from);
        states.forget_worker(from);
        states.mark_background(to);
        rebind(&states, &asks, from, to);
        (states, asks, held, workers)
    }

    fn assert_moved(states: &SessionStates, asks: &Asks, held: &super::super::asks::Ask, workers: &super::super::asks::Ask, to: &str) {
        assert_eq!(states.root_background("w").as_deref(), Some(to), "the worker's spawner is the new autopilot");
        let mirrored = asks.pending().into_iter().find(|a| a.id == workers.id).unwrap();
        assert!(mirrored.shown_in.iter().any(|s| s == to), "the worker's card shows in the new autopilot's chat");
        asks.answer(&held.id, super::super::approvals::APPROVE.into(), super::super::asks::By::User).unwrap();
        let super::super::asks::Waited::Answered { approval_id: Some(id), .. } = asks.wait(&held.id, Duration::ZERO) else {
            panic!("no approval id")
        };
        assert!(asks.approvals.reserve(Some(&id), to, &approval()).is_ok(), "the new autopilot can spend the approval");
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
        file.start("s1");
        write_atomically(&path, &serde_json::to_string(&file).unwrap()).unwrap();

        let mut file = RunnerFile::load(&path);
        let previous = file.start("s2").expect("the file kept the old id");
        assert_eq!(previous, "s1");
        let (states, asks, held, workers) = restart(&dir, &previous, "s2");
        assert_moved(&states, &asks, &held, &workers, "s2");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
