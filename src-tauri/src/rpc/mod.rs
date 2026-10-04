//! The app level socket: one JSON-RPC protocol per Tori process, which the CLI,
//! the MCP server and later a WebSocket are all fronts on. See
//! [[adr_one_protocol_several_fronts]].
//!
//! Found two ways. A process Tori spawns gets `TORI_SOCK` and `TORI_CALLER` in
//! its env; anything else reads the `rpc.json` bridge file, the same shape and
//! the same lifetime rule as the askpass one in `crate::credential`.

pub mod approvals;
pub mod asks;
pub mod awake;
pub mod auth;
pub mod bridge;
pub mod devices;
pub mod client;
pub mod dots;
pub mod events;
pub mod frame;
pub mod hub;
pub mod methods;
pub mod pairing;
pub mod pr_wake;
pub mod pr_watch;
pub mod quotas;
pub mod remote;
pub mod runner;
pub mod server;
pub mod states;
pub mod table;
pub mod transport;
pub mod ws;
pub mod watcher;

use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

use crate::autopilot::AutopilotStore;
use asks::{Ask, Asks};
use auth::{Caller, Children, Credential};
use bridge::{Bridge, REPLY_TIMEOUT, REQUEST_EVENT};
use events::{session_event, Place};
use hub::{Channel, Hub};
use quotas::Quotas;
use remote::Remote;
use runner::Runner;
use serde_json::{json, Value};
use server::{Server, AUTH_TIMEOUT};
use states::{Held, SessionStates, Source};
use transport::{Transport, UnixTransport};
use watcher::Watcher;

pub const ENV_SOCK: &str = "TORI_SOCK";
// Not `TORI_TOKEN`: codex's shell tool carries default excludes for names like
// `*TOKEN*`, `*KEY*` and `*SECRET*`, and an agent's shell has to see this one.
pub const ENV_CALLER: &str = "TORI_CALLER";

static SOCKET: OnceLock<(String, Arc<Children>)> = OnceLock::new();
static CLI_DIR: OnceLock<PathBuf> = OnceLock::new();
static ASKS: OnceLock<Arc<Asks>> = OnceLock::new();
static RUNNER: OnceLock<Arc<Runner>> = OnceLock::new();
static WATCHER: OnceLock<Arc<Watcher>> = OnceLock::new();
// For modules with no Tauri state in reach: the checkpoint writer, the forge
// poll, the quota push.
static EVENTS: OnceLock<(Arc<Hub>, Arc<SessionStates>)> = OnceLock::new();

pub struct RpcState {
    transport: Arc<UnixTransport>,
    remote: Arc<Remote>,
    pub hub: Arc<Hub>,
    states: Arc<SessionStates>,
    bridge: Arc<Bridge>,
    asks: Arc<Asks>,
    pub autopilot: Arc<AutopilotStore>,
    pub runner: Arc<Runner>,
    devices: Arc<devices::Devices>,
    quotas: Quotas,
}

impl RpcState {
    /// Called at exit. The bridge file goes only if it still names this
    /// instance, so quitting one of two running copies leaves the other findable.
    pub fn shutdown(&self) {
        let path = bridge_path();
        let ours = self.transport.sock_path().to_string_lossy();
        if crate::credential::socket_in_file(&path).is_some_and(|(sock, _)| sock == ours) {
            let _ = std::fs::remove_file(path);
        }
        self.remote.stop();
        self.transport.shutdown();
    }
}

// The webview is not a socket subscriber, so the channel is mirrored to it.
fn autopilot_publisher(hub: &Arc<Hub>, app: &AppHandle) -> Box<dyn Fn(Value) + Send + Sync> {
    let (hub, app) = (hub.clone(), app.clone());
    Box::new(move |event| {
        let _ = app.emit("autopilot://changed", &event);
        hub.publish(&Channel::Autopilot, event);
    })
}

// The Settings pane is not a socket subscriber, so it hears about devices here.
const DEVICES_EVENT: &str = "remote://devices";

fn devices_changed(app: &AppHandle, ended: Option<pairing::Ended>) {
    let _ = app.emit(DEVICES_EVENT, json!({ "ended": ended }));
}

pub fn start(app: AppHandle) -> std::io::Result<RpcState> {
    let transport = Arc::new(UnixTransport::bind()?);
    let token = crate::chat::approval::random_token();
    let hub = Arc::new(Hub::default());
    {
        let app = app.clone();
        hub.watch_devices(Box::new(move || devices_changed(&app, None)));
    }
    let children = Arc::new(Children::default());
    let states = Arc::new(SessionStates::default());
    let devices = Arc::new(devices::Devices::open(devices_path()));
    let pairing = {
        let app = app.clone();
        Arc::new(pairing::Pairing::new(Box::new(move |ended| devices_changed(&app, Some(ended)))))
    };
    let emitter = app.clone();
    let bridge = Arc::new(Bridge::new(
        Box::new(move |request| emitter.emit(REQUEST_EVENT, request).map_err(|e| e.to_string())),
        REPLY_TIMEOUT,
    ));
    let asks = Arc::new(Asks::with_holds(crate::autopilot::dir().join("holds.json"), autopilot_publisher(&hub, &app)));
    let autopilot = Arc::new(
        AutopilotStore::open(crate::autopilot::dir(), autopilot_publisher(&hub, &app))
            .on_closed(withdraw_holds(asks.clone(), bridge.clone())),
    );
    let runner = Arc::new(Runner::new(
        app.clone(),
        hub.clone(),
        states.clone(),
        asks.clone(),
        bridge.clone(),
        crate::autopilot::dir(),
    ));
    start_watcher(&app, &states, &autopilot, &runner);
    let tell = app.clone();
    pr_watch::on_polled_moved(Box::new(move || {
        let _ = tell.emit("pr_watch://changed", ());
    }));
    start_pr_wake(&app, &states);
    start_composer(&app, &hub, &states, &autopilot);
    let server = Arc::new(Server {
        hub: hub.clone(),
        backend: Box::new(methods::TauriBackend {
            app,
            states: states.clone(),
            bridge: bridge.clone(),
            asks: asks.clone(),
            autopilot: autopilot.clone(),
            runner: runner.clone(),
            devices: devices.clone(),
        }),
        auth_timeout: AUTH_TIMEOUT,
    });
    let local = Arc::new(Credential::Local { process: token.clone(), children: children.clone() });
    server::serve(transport.clone() as Arc<dyn Transport>, local, server.clone());
    let remote = Arc::new(Remote::new(server, devices.clone(), pairing));
    remote.apply(&crate::settings::remote());

    let sock = transport.sock_path().to_string_lossy().into_owned();
    if let Err(e) = crate::credential::write_bridge(&bridge_path(), &sock, &token) {
        eprintln!("tori: rpc bridge file not written: {e}");
    }
    let _ = SOCKET.set((sock, children));
    let _ = ASKS.set(asks.clone());
    let _ = RUNNER.set(runner.clone());
    let _ = EVENTS.set((hub.clone(), states.clone()));
    match link_cli(transport.sock_path()) {
        Ok(dir) => {
            let _ = CLI_DIR.set(dir);
        }
        Err(e) => eprintln!("tori: cli not linked onto PATH: {e}"),
    }
    Ok(RpcState { transport, remote, hub, states, bridge, asks, autopilot, runner, devices, quotas: Quotas::default() })
}

// What only the webview knows about its tabs, chats and forge poll; every
// composition after this reads it.
#[tauri::command(async)]
pub fn rpc_session_facts(
    chat: tauri::State<crate::chat::host::ChatState>,
    pty: tauri::State<crate::pty::PtyState>,
    facts: dots::Facts,
) {
    let Some(composer) = COMPOSER.get() else { return };
    let chats: HashSet<String> = chat.0.live_sessions().into_iter().map(|(id, _)| id).collect();
    let tabs: HashSet<String> = pty.live_ids().unwrap_or_default().into_iter().collect();
    composer.dots.replace(facts, |tab| tabs.contains(tab), |id| chats.contains(id));
    nudge(Nudge::Compose);
}

pub fn note_pty_activity(tab: &str, state: &str) {
    let activity = match state {
        "active" => dots::Activity::Active,
        _ => dots::Activity::Quiet,
    };
    if COMPOSER.get().is_some_and(|c| c.dots.note_activity(tab, activity)) {
        nudge(Nudge::Compose);
    }
}

pub fn note_running(asked: &[(String, String)], running: &[String]) {
    let Some(composer) = COMPOSER.get() else { return };
    composer.dots.note_running(asked, &running.iter().cloned().collect());
    nudge(Nudge::Compose);
}

// A transcript moved: its tail may have, and a session may have exited.
pub fn sessions_changed() {
    nudge(Nudge::Changed);
}

pub fn nudge_probe() {
    nudge(Nudge::Probe);
}

// The whole set, for a webview that has just loaded and missed every change.
#[tauri::command]
pub fn session_dots() -> Vec<dots::Change> {
    COMPOSER.get().map(|c| c.dots.all()).unwrap_or_default()
}

pub fn session_dot(id: &str) -> (dots::Dot, dots::Certainty) {
    COMPOSER.get().map_or((dots::Dot::None, dots::Certainty::Inferred), |c| c.dots.dot(id))
}

pub fn session_attended(id: &str, dot: dots::Dot) -> bool {
    COMPOSER.get().is_none_or(|c| !c.presence().unattended(id, dot))
}

// What the user is looking at: the selected row and whether the window has
// focus, which only the webview knows.
#[tauri::command(async)]
pub fn rpc_attention(session: Option<String>, focused: bool) {
    let Some(composer) = COMPOSER.get() else { return };
    composer.presence().attend(session, focused);
    nudge(Nudge::Present);
}

// So a socket caller never waits on the webview to notice a session exited.
// Queued rather than run inline, which would put a pgrep on the caller's call.
pub fn refresh_dots_if_stale() {
    if COMPOSER.get().is_some_and(|c| c.dots.probed_at().is_none_or(|at| at.elapsed() >= STALE_PROBE)) {
        nudge(Nudge::Probe);
    }
}

const STALE_PROBE: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(PartialEq)]
enum Nudge {
    Compose,
    Probe,
    Changed,
    Present,
}

static COMPOSER: OnceLock<Arc<Composer>> = OnceLock::new();
static NUDGE: OnceLock<std::sync::Mutex<std::sync::mpsc::Sender<Nudge>>> = OnceLock::new();

fn nudge(what: Nudge) {
    if let Some(tx) = NUDGE.get() {
        let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(what);
    }
}

struct Composer {
    app: AppHandle,
    hub: Arc<Hub>,
    states: Arc<SessionStates>,
    autopilot: Arc<AutopilotStore>,
    dots: dots::Dots,
    // Index rows per session, and every id already looked up, so a session with
    // no transcript yet does not re-walk the index on every composition.
    metas: std::sync::Mutex<(HashMap<String, dots::Meta>, HashSet<String>)>,
    presence: std::sync::Mutex<crate::presence::Presence>,
}

impl Composer {
    fn presence(&self) -> std::sync::MutexGuard<'_, crate::presence::Presence> {
        self.presence.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn probe(&self) {
        let want = self.dots.to_probe();
        let refs = want.iter().map(|(id, agent)| crate::sessions::SessionRef { id: id.clone(), agent: agent.clone() }).collect();
        let running = crate::sessions::running_now(&self.app.state::<crate::chat::host::ChatState>().0.registry, refs);
        self.dots.note_running(&want, &running.into_iter().collect());
    }

    // One at a time, so the events two compositions publish never interleave.
    fn compose(&self, reindex: bool) {
        let mut metas = self.metas.lock().unwrap_or_else(|e| e.into_inner());
        let wanted = self.dots.wants_meta();
        if reindex || wanted.iter().any(|id| !metas.1.contains(id)) {
            let all = crate::sessions::all_sessions(&self.app.state::<crate::sessions::SessionIndex>());
            let rows = all
                .into_iter()
                .filter(|m| wanted.contains(&m.id))
                .map(|m| {
                    let name = m.name.filter(|n| !n.is_empty()).unwrap_or(m.title);
                    (m.id.clone(), dots::Meta { agent: m.agent, path: m.path, branch: m.branch, cwd: m.cwd, name })
                })
                .collect();
            *metas = (rows, wanted.into_iter().collect());
        }
        let spaces = OnceCell::new();
        let topics = OnceCell::new();
        let home_of = |at: &str, branch: Option<&str>| {
            let spaces = spaces.get_or_init(|| crate::unit_home::spaces(&self.app.state::<crate::config::ProjectIndex>()));
            crate::unit_home::home_of(spaces, topics.get_or_init(crate::unit_home::topics), at, branch)
        };
        let tail_blocked = |id: &str, meta: &dots::Meta| {
            crate::sessions::session_tail_state_body(id.to_string(), meta.path.clone(), meta.agent.clone())
                .is_ok_and(|t| t == crate::sessions::TailState::BlockedCandidate)
        };
        let (reports, changes) = self.dots.compose_all(&metas.0, home_of, tail_blocked);

        let chats: HashSet<String> = self.app.state::<crate::chat::host::ChatState>().0.live_sessions().into_iter().map(|(id, _)| id).collect();
        let tabs: HashSet<String> = self.app.state::<crate::pty::PtyState>().live_ids().unwrap_or_default().into_iter().collect();
        let projects = OnceCell::new();
        let place_of = |folder: &str| Place {
            project: events::project_of(folder, projects.get_or_init(crate::config::discovered_project_dirs)),
            folder: Some(folder.to_string()),
        };
        let alive = |id: &str, held: &Held| match held.source {
            Source::Chat => chats.contains(id),
            Source::Pty => held.tab.as_ref().is_some_and(|tab| tabs.contains(tab)),
        };
        for event in self.states.replace(reports, place_of, alive) {
            let id = event["id"].as_str().unwrap_or_default().to_string();
            publish_session(&self.hub, &self.autopilot, &id, event);
        }
        // Straight to the hub: a dot is not something the runner or the
        // watcher acts on, and a red check reaches them as `session.pr`.
        for change in &changes {
            let place = if change.folder.is_empty() { Place::default() } else { place_of(&change.folder) };
            let event = session_event("session.dot", &change.id, &place, json!({ "dot": change.dot, "certainty": change.certainty }));
            self.hub.publish_session(&change.id, event);
        }
        if !changes.is_empty() {
            let _ = self.app.emit("sessions://dots", &changes);
        }
    }

    // After every composition, so an edge is only ever a dot that changed.
    fn present(&self) {
        let mut live = self.dots.live();
        let spaces = crate::unit_home::spaces(&self.app.state::<crate::config::ProjectIndex>());
        let topics = crate::unit_home::topics();
        let metas = self.metas.lock().unwrap_or_else(|e| e.into_inner());
        for l in &mut live {
            if l.name.is_empty() {
                l.name = metas.0.get(&l.id).map(|m| m.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| l.id.clone());
            }
            l.project = crate::unit_home::project_name(&spaces, &l.folder);
            if let (true, Some(t)) = (l.project.is_empty(), crate::unit_home::topic_of(&topics, &l.folder)) {
                l.project = t.name.clone();
            }
        }
        drop(metas);
        let chats: HashSet<String> = live.iter().filter(|l| l.chat).map(|l| l.id.clone()).collect();
        let pilot = RUNNER.get().is_some_and(|r| {
            matches!(r.status().state, runner::RunnerState::Starting | runner::RunnerState::Idle | runner::RunnerState::Working)
        });
        // Released before the OS calls: building the tray's menu waits on the
        // main thread, which may itself be waiting on this lock.
        let (edges, quiet, (tray, badge)) = {
            let mut presence = self.presence();
            let edges = presence.step(&live);
            let quiet: HashSet<String> = live
                .iter()
                .filter(|l| crate::presence::relayed(l.spawner.as_deref(), &chats, pilot) || presence.suppressed(l))
                .map(|l| l.id.clone())
                .collect();
            (edges, quiet, presence.surface(&live))
        };
        for id in &edges.cleared {
            crate::presence::withdraw_notification(&self.app, id);
        }
        if !edges.rose.is_empty() || !edges.finished.is_empty() {
            let alerts = crate::presence::decide(edges, &quiet, &crate::settings::get_settings().notifications);
            for l in live.iter().filter(|l| alerts.needs_you.contains(&l.id)) {
                crate::presence::notify_session(self.app.clone(), l, crate::presence::needs_you_body(l), true);
            }
            // No click wait: a turn finishes far more often than one blocks,
            // and a wait parks a thread for as long as the notification stays.
            for l in live.iter().filter(|l| alerts.finished.contains(&l.id)) {
                crate::presence::notify_session(self.app.clone(), l, crate::presence::finished_body(l), false);
            }
            if alerts.needs_you_sound {
                crate::sound::play(&self.app, crate::sound::Sound::NeedsYou);
            }
            if alerts.finished_sound {
                crate::sound::play(&self.app, crate::sound::Sound::TurnFinished);
            }
        }
        if let Some((tooltip, entries)) = tray {
            let _ = crate::presence::set_tray(&self.app, &tooltip, &entries);
        }
        if let Some(count) = badge {
            let _ = crate::presence::set_badge_count(&self.app, count);
        }
    }
}

fn start_composer(app: &AppHandle, hub: &Arc<Hub>, states: &Arc<SessionStates>, autopilot: &Arc<AutopilotStore>) {
    let composer = Arc::new(Composer {
        app: app.clone(),
        hub: hub.clone(),
        states: states.clone(),
        autopilot: autopilot.clone(),
        dots: dots::Dots::default(),
        metas: std::sync::Mutex::default(),
        presence: std::sync::Mutex::default(),
    });
    let (tx, rx) = std::sync::mpsc::channel::<Nudge>();
    let _ = NUDGE.set(std::sync::Mutex::new(tx));
    let _ = COMPOSER.set(composer.clone());
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut all = vec![first];
            all.extend(rx.try_iter());
            if all.iter().any(|n| matches!(n, Nudge::Probe | Nudge::Changed)) {
                composer.probe();
            }
            if all.iter().any(|n| *n != Nudge::Present) {
                composer.compose(all.contains(&Nudge::Changed));
            }
            composer.present();
        }
    });
}

/// Tori telling one live chat something it should know: steered into the
/// running turn, or held for the user's next one when the session is idle, so
/// the note never starts a turn of its own.
pub fn tell_session(app: &AppHandle, session: &str, kind: &str, text: &str) -> Result<(), String> {
    let states = &app.state::<RpcState>().states;
    let mid_turn = matches!(
        states.snapshot().get(session),
        Some(states::SessionState::Working | states::SessionState::NeedsYou)
    );
    let text = events::from_tori(kind, None, text);
    let host = &app.state::<crate::chat::host::ChatState>().0;
    if !mid_turn {
        host.note_for_next_turn(session, text);
        return Ok(());
    }
    // An agent that cannot take a message mid-turn (ACP) still hears it, on the
    // user's next one.
    if host.deliver(session, vec![crate::chat::model::ContentBlock::Text { text: text.clone() }], true, events::TurnBy::Local).is_err() {
        host.note_for_next_turn(session, text);
    }
    Ok(())
}

/// A Topic home chat just compacted, and the summary may have dropped what its
/// Topic is. Told again from the record as it is now: into the running turn
/// when the window filled mid-turn, on the next message after a `/compact`,
/// whose turn ends at once and would take a steer as a turn of its own.
pub fn retell_topic(app: &AppHandle, session: &str, mid_turn: bool) {
    let host = &app.state::<crate::chat::host::ChatState>().0;
    let Some((_, cwd)) = host.live_sessions().into_iter().find(|(id, _)| id == session) else { return };
    // Canonical, as the spawn's own lookup is, so a cwd spelled another way
    // still finds its Topic.
    let real = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| p.into());
    let topics = crate::unit_home::topics();
    let Some(topic) = topics.iter().find(|t| t.home.as_deref().is_some_and(|h| real(h) == real(&cwd))) else { return };
    let note = crate::topic_home::note(topic);
    if !mid_turn {
        host.note_for_next_turn(session, events::from_tori("topic", None, &note));
        return;
    }
    // Off the publishing thread, which is the session's own event thread.
    let (app, session) = (app.clone(), session.to_string());
    std::thread::spawn(move || {
        let _ = tell_session(&app, &session, "topic", &note);
    });
}

// A chat stopped by its spend ceiling reports needs_you, so it is held here too.
fn start_pr_wake(app: &AppHandle, states: &Arc<SessionStates>) {
    let (app, states) = (app.clone(), states.clone());
    let host = app.clone();
    let ready = move |session: &str| {
        crate::settings::pr_watch()
            && states.snapshot().get(session) == Some(&states::SessionState::Idle)
            && host.state::<crate::chat::host::ChatState>().0.is_live(session)
    };
    let deliver = move |session: &str, text: String| {
        let host = &app.state::<crate::chat::host::ChatState>().0;
        let text = events::from_tori("pr_watch", None, &text);
        host.deliver(session, vec![crate::chat::model::ContentBlock::Text { text }], false, events::TurnBy::Watcher)
    };
    pr_wake::start(ready, deliver);
}

fn start_watcher(app: &AppHandle, states: &Arc<SessionStates>, autopilot: &Arc<AutopilotStore>, runner: &Arc<Runner>) {
    let status = runner.clone();
    let (watcher, nudges) = Watcher::new(states.clone(), autopilot.clone(), Box::new(move || status.status()));
    let _ = WATCHER.set(watcher.clone());
    let app = app.clone();
    std::thread::spawn(move || {
        let deliver = |session: &str, text: String| {
            let host = &app.state::<crate::chat::host::ChatState>().0;
            let text = events::from_tori("wake", None, &text);
            host.deliver(session, vec![crate::chat::model::ContentBlock::Text { text }], false, events::TurnBy::Watcher)
        };
        let stall = || std::time::Duration::from_secs(u64::from(crate::settings::autopilot().stall_minutes) * 60);
        watcher.run(nudges, deliver, stall);
    });
}

// The cards close on a thread of their own: the webview's reply can take up to
// `REPLY_TIMEOUT`, and the item update that closed the item should not wait on it.
fn withdraw_holds(asks: Arc<Asks>, bridge: Arc<Bridge>) -> Box<dyn Fn(&str) + Send + Sync> {
    Box::new(move |item| {
        let ids = asks.withdraw_item(item);
        if ids.is_empty() {
            return;
        }
        let bridge = bridge.clone();
        std::thread::spawn(move || {
            for id in ids {
                let _ = bridge.request("ask.close", json!({ "id": id }));
            }
        });
    })
}

// An item whose session ended keeps its stored state, but what the autopilot sees of it changed.
pub fn publish_session(hub: &Hub, autopilot: &AutopilotStore, id: &str, event: Value) {
    let ended = event["kind"] == "session.ended";
    if let Some(runner) = RUNNER.get() {
        runner.observe(id, &event);
    }
    if let Some(watcher) = WATCHER.get() {
        watcher.session_event(id, &event);
    }
    pr_wake::session_event(id, &event);
    hub.publish_session(id, event);
    if ended {
        autopilot.session_ended(id);
    }
}

pub fn nudge_watcher() {
    if let Some(watcher) = WATCHER.get() {
        watcher.nudge();
    }
}

// Work in a session's stream, which is what a stall is the absence of.
pub fn watcher_touch(session: &str) {
    if let Some(watcher) = WATCHER.get() {
        watcher.touch(session);
    }
}

#[tauri::command]
pub fn rpc_reply(rpc: tauri::State<RpcState>, rid: u64, result: Option<serde_json::Value>, error: Option<String>) {
    rpc.bridge.reply(rid, error.map_or(Ok(result.unwrap_or_default()), Err));
}

#[tauri::command]
pub fn rpc_asks_pending(rpc: tauri::State<RpcState>) -> Vec<Ask> {
    rpc.asks.pending()
}

#[tauri::command]
pub fn rpc_ask_answer(rpc: tauri::State<RpcState>, id: String, answer: String) -> bool {
    rpc.asks.answer(&id, answer, asks::By::User).is_ok()
}

pub fn publish_checkpoint(session_id: &str, folder: &str, turn: usize, prompt_ts: u64) {
    let Some((hub, _)) = EVENTS.get() else { return };
    let event = session_event("session.checkpoint", session_id, &Place::of(folder), json!({ "turn": turn, "prompt_ts": prompt_ts }));
    hub.publish_session(session_id, event);
}

// Serialised only while someone reads `chat:<id>`: this runs on every delta.
pub fn publish_chat(session_id: &str, event: &crate::chat::model::ChatEvent) {
    let Some((hub, _)) = EVENTS.get() else { return };
    if !hub.watches_chat(session_id) {
        return;
    }
    if let Ok(data) = serde_json::to_value(event) {
        hub.publish(&Channel::Chat(session_id.to_string()), data);
    }
}

// `ids` are the live sessions in `folder`, possibly none: a review can land
// after the worker that opened the PR has ended. A branch checked out nowhere
// has none, since the sessions in its project's folder are on another branch.
pub fn publish_pr(project: &str, folder: &str, branch: &str, checked_out: bool, fields: Value) {
    let Some((hub, states)) = EVENTS.get() else { return };
    let ids = if checked_out { states.ids_in(folder) } else { Vec::new() };
    let mut event = json!({
        "kind": "session.pr",
        "project": project,
        "folder": folder,
        "branch": branch,
        "ids": ids,
        "ts": events::now_ms(),
    });
    if let (Some(event), Value::Object(fields)) = (event.as_object_mut(), fields) {
        event.extend(fields);
    }
    if let Some(watcher) = WATCHER.get() {
        let url = event["pull_request"]["url"].as_str();
        watcher.pr_event(url, checked_out.then_some(folder), &ids, &event);
    }
    for id in &ids {
        hub.publish(&Channel::Session(id.clone()), event.clone());
    }
    hub.publish(&Channel::Sessions, event);
}

// The remote front's switch, address and port. Only this writes them, so a
// stale settings save cannot turn a network listener on.
#[tauri::command(async)]
pub fn remote_set(rpc: tauri::State<RpcState>, remote: crate::settings::Remote) -> Result<remote::Status, String> {
    crate::settings::set_remote(remote.clone())?;
    Ok(rpc.remote.apply(&remote))
}

#[tauri::command]
pub fn remote_status(rpc: tauri::State<RpcState>) -> remote::Status {
    rpc.remote.status()
}

#[tauri::command(async)]
pub fn remote_interfaces() -> Vec<remote::Interface> {
    remote::interfaces()
}

#[tauri::command(async)]
pub fn remote_tailscale() -> remote::Tailscale {
    remote::tailscale()
}

#[tauri::command(async)]
pub fn tailscale_open() -> Result<(), String> {
    remote::open_tailscale()
}

#[derive(serde::Serialize)]
pub struct PairingOffer {
    #[serde(flatten)]
    offer: pairing::Offer,
    svg: String,
}

#[tauri::command(async)]
pub fn pairing_start(rpc: tauri::State<RpcState>) -> Result<PairingOffer, String> {
    let offer = rpc.remote.start_pairing()?;
    let svg = qrcode::QrCode::new(offer.uri.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .quiet_zone(true)
        .build();
    Ok(PairingOffer { offer, svg })
}

#[tauri::command]
pub fn pairing_cancel(rpc: tauri::State<RpcState>) {
    rpc.remote.cancel_pairing();
}

#[tauri::command]
pub fn devices_list(rpc: tauri::State<RpcState>) -> Vec<Value> {
    let connected = rpc.hub.connected_devices();
    rpc.devices
        .list()
        .into_iter()
        .map(|d| json!({ "id": d.id, "name": d.name, "created_ms": d.created_ms, "connected": connected.contains(&d.id) }))
        .collect()
}

// Revoked in the file first: a connection still being set up checks the file
// after registering, so it cannot slip between the two.
#[tauri::command(async)]
pub fn device_revoke(app: AppHandle, rpc: tauri::State<RpcState>, id: String) -> Result<(), String> {
    rpc.devices.revoke(&id)?;
    rpc.hub.close_device(&id);
    devices_changed(&app, None);
    Ok(())
}

// The webview's own switch: not a socket caller, so it goes around the
// `NOT_SESSIONS` rows to the same runner.
#[tauri::command]
pub fn autopilot_start(rpc: tauri::State<RpcState>) -> Result<runner::Status, String> {
    rpc.runner.start()
}

#[tauri::command]
pub fn autopilot_stop(rpc: tauri::State<RpcState>) -> Result<runner::Status, String> {
    rpc.runner.stop()
}

// Async: reading it asks the forge for open pull requests.
#[tauri::command(async)]
pub fn autopilot_state(app: AppHandle, rpc: tauri::State<RpcState>) -> Result<Value, String> {
    use server::Backend;
    let backend = methods::TauriBackend {
        app,
        states: rpc.states.clone(),
        bridge: rpc.bridge.clone(),
        asks: rpc.asks.clone(),
        autopilot: rpc.autopilot.clone(),
        runner: rpc.runner.clone(),
        devices: rpc.devices.clone(),
    };
    backend.autopilot_state().map_err(|e| e.message)
}

// Called from the webview's forge poll tick, so it rides that cadence and its
// pause and backoff rather than a clock of its own.
#[tauri::command(async)]
pub fn autopilot_pickup(rpc: tauri::State<RpcState>, project_path: String) -> Result<(), String> {
    if !crate::settings::autopilot().available {
        return Ok(());
    }
    let Some(list) = crate::issues::commands::assigned_if_offered(&project_path).map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let cap = crate::issues::github::ASSIGNED_CAP as usize;
    let picked = rpc
        .autopilot
        .pickup(&project_path, &list.repo, &list.account, &list.rows, cap)
        .map_err(|e| e.to_string())?;
    if let Some(watcher) = WATCHER.get() {
        watcher.picked(&picked);
    }
    Ok(())
}

#[tauri::command]
pub fn autopilot_log(rpc: tauri::State<RpcState>, limit: usize) -> Vec<Value> {
    rpc.autopilot.recent_log(limit)
}

#[tauri::command]
pub fn autopilot_status(rpc: tauri::State<RpcState>) -> runner::Status {
    rpc.runner.status()
}

#[tauri::command]
pub fn autopilot_closed_by_hand(rpc: tauri::State<RpcState>, session: String) -> Result<(), String> {
    let held: HashSet<String> = rpc.asks.holds().into_iter().map(|h| h.item).collect();
    rpc.autopilot.closed_by_hand(&session, &held).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn autopilot_locked(rpc: tauri::State<RpcState>) -> Vec<String> {
    let mut sessions: Vec<String> = rpc.autopilot.sessions().into_iter().chain(rpc.states.spawned()).collect();
    sessions.sort();
    sessions.dedup();
    sessions.retain(|id| is_locked(&rpc.states, &rpc.autopilot, &rpc.runner, id));
    sessions
}

pub const LOCKED: &str = "locked while the autopilot drives it; stop the autopilot to type";

pub fn is_locked(states: &SessionStates, autopilot: &AutopilotStore, runner: &Runner, session: &str) -> bool {
    let spawner = states.spawner_of(session).map(|s| runner.resolve_spawner(&s));
    runner::locks(&runner.status(), autopilot.state_for_session(session), spawner.as_deref())
}

// No socket means no autopilot, so nothing is locked.
pub fn refuse_locked(app: &AppHandle, session: &str) -> Result<(), String> {
    let Some(rpc) = app.try_state::<RpcState>() else { return Ok(()) };
    match is_locked(&rpc.states, &rpc.autopilot, &rpc.runner, session) {
        true => Err(LOCKED.to_string()),
        false => Ok(()),
    }
}

#[derive(serde::Serialize)]
pub struct WatchRow {
    session: String,
    url: String,
    project: String,
    branch: String,
}

#[tauri::command]
pub fn pr_watch_list() -> Vec<WatchRow> {
    pr_watch::store()
        .list()
        .into_iter()
        .filter(|w| !w.ended)
        .map(|w| WatchRow { session: w.session, url: w.url, project: w.project, branch: w.branch })
        .collect()
}

#[tauri::command(async)]
pub fn pr_watch_start(rpc: tauri::State<RpcState>, session: String, project: String, number: u64) -> Result<String, String> {
    let item = rpc.autopilot.item_for_session(&session).is_some();
    pr_watch::watch(&session, &project, number, item).map(|w| w.url)
}

#[tauri::command]
pub fn pr_watch_stop(session: String, url: String) -> Result<bool, String> {
    pr_watch::stop(&session, &url)
}

#[tauri::command]
pub fn rpc_quota(rpc: tauri::State<RpcState>, agent: String, profile: Option<String>, readings: Vec<quotas::Reading>) {
    if let Some(windows) = rpc.quotas.record(&agent, profile.as_deref(), readings) {
        let event = json!({
            "kind": "account.quota",
            "agent": agent,
            "account": profile,
            "windows": windows,
            "ts": events::now_ms(),
        });
        rpc.hub.publish(&Channel::Accounts, event);
    }
}

/// A `bin/tori` link beside the socket, so it goes with the socket's private
/// dir at exit and two running copies each put their own binary first.
fn link_cli(sock: &std::path::Path) -> std::io::Result<PathBuf> {
    let dir = sock.parent().unwrap_or(sock).join("bin");
    std::fs::create_dir_all(&dir)?;
    std::os::unix::fs::symlink(std::env::current_exe()?, dir.join("tori"))?;
    Ok(dir)
}

/// `path` with the directory holding the `tori` link in front. Unchanged when
/// the socket never came up, since a `tori` that cannot reach anything is worse
/// than none.
pub fn path_with_cli(path: &str) -> String {
    match CLI_DIR.get() {
        Some(dir) if path.is_empty() => dir.to_string_lossy().into_owned(),
        Some(dir) => format!("{}:{path}", dir.to_string_lossy()),
        None => path.to_string(),
    }
}

/// Env for a process Tori spawns, with a token minted for `caller`. Empty when
/// the socket never came up.
pub fn child_env(caller: Caller) -> Vec<(String, String)> {
    SOCKET
        .get()
        .map(|(sock, children)| {
            vec![(ENV_SOCK.to_string(), sock.clone()), (ENV_CALLER.to_string(), children.mint(caller))]
        })
        .unwrap_or_default()
}

pub fn revoke_env(env: &[(String, String)]) {
    if let Some((_, children)) = SOCKET.get() {
        env.iter().filter(|(key, _)| key == ENV_CALLER).for_each(|(_, token)| children.revoke_token(token));
    }
}

// A chat that ended can no longer show its asks, so they go with its token.
pub fn revoke(caller: &Caller) {
    if let Some((_, children)) = SOCKET.get() {
        children.revoke(caller);
    }
    if let (Caller::Chat(session), Some(asks)) = (caller, ASKS.get()) {
        asks.forget_session(session);
    }
    if let (Caller::Chat(session), Some((_, states))) = (caller, EVENTS.get()) {
        states.forget_worker(session);
    }
}

pub const MCP_SERVER: &str = "tori";

/// The rules pre-allowed in every settings file Tori injects into a claude it
/// launches: Tori's own tools, nothing else, and the user's deny rules still
/// outrank them. A foreground session leaves the outward tools to the harness's
/// prompt; a background one has Tori's approval gate in its place.
pub fn mcp_allow(background: bool) -> Vec<String> {
    if background {
        return vec![format!("mcp__{MCP_SERVER}__*")];
    }
    let agents = [table::CallerKind::Terminal, table::CallerKind::Chat, table::CallerKind::Worker];
    table::METHODS
        .iter()
        .filter(|m| !m.outward && m.callers.iter().any(|k| agents.contains(k)))
        .map(|m| format!("mcp__{MCP_SERVER}__{}", m.name.replace('.', "_")))
        .collect()
}

// Called by `chat_spawn` for a background worker, fresh or resumed. A resumed
// one lost its spawner link with the old process, and a retired autopilot id
// stands for the current autopilot.
pub fn mark_spawned_worker(session: &str, spawner: &str) {
    let spawner = current_spawner(spawner);
    if let Some((_, states)) = EVENTS.get() {
        states.mark_worker(session, &spawner);
    }
}

pub fn current_spawner(spawner: &str) -> String {
    RUNNER.get().map_or_else(|| spawner.to_string(), |r| r.resolve_spawner(spawner))
}

// Called by `chat_spawn` before the child starts, so its first outward call already meets the gate.
pub fn mark_background(session: &str) {
    if let Some((_, states)) = EVENTS.get() {
        states.mark_background(session);
    }
}

/// `["--mcp-config", <path>]` naming `tori mcp`, for a claude Tori launches.
/// One static file for every session: the command is the `bin/tori` link by
/// its full path, so an `env.PATH` in the user's claude settings cannot hide
/// it, and `tori mcp` inherits the child's socket env.
/// Empty if the file cannot be written, so the launch goes on without it.
pub fn mcp_config_args() -> Vec<String> {
    let path = crate::owned_state::config_dir().join("claude-mcp.json");
    let command = CLI_DIR.get().map_or_else(|| "tori".to_string(), |dir| dir.join("tori").to_string_lossy().into_owned());
    let config = json!({ "mcpServers": { MCP_SERVER: { "command": command, "args": ["mcp"] } } });
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&path, format!("{config}\n")));
    match written {
        Ok(()) => vec!["--mcp-config".to_string(), path.to_string_lossy().into_owned()],
        Err(_) => Vec::new(),
    }
}

/// The `tori` link and a socket env minted for `caller`, for an MCP server an
/// agent launches with an explicit command and env. `None` when the socket
/// never came up. The token goes with `revoke(caller)` like the agent's own.
pub fn mcp_launch(caller: Caller) -> Option<(PathBuf, Vec<(String, String)>)> {
    let dir = CLI_DIR.get()?;
    let env = child_env(caller);
    (!env.is_empty()).then(|| (dir.join("tori"), env))
}

pub(crate) fn bridge_path() -> PathBuf {
    crate::owned_state::config_dir().join("rpc.json")
}

fn devices_path() -> PathBuf {
    crate::owned_state::config_dir().join("devices.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autopilot::{Kind, Patch, Source, Target};
    use std::sync::mpsc::sync_channel;

    #[test]
    fn an_items_session_ending_reaches_the_autopilot_topic() {
        let hub = Arc::new(Hub::default());
        let (tx, rx) = sync_channel(hub::QUEUE_CAP);
        hub.subscribe(hub.register(tx, Box::new(|| {})), Channel::Autopilot);
        let dir = crate::autopilot::tests::temp_dir("session-ended");
        let publisher = hub.clone();
        let store = AutopilotStore::open(dir.clone(), Box::new(move |event| publisher.publish(&Channel::Autopilot, event)));
        let source = Source::Pr { number: 7, repo: "o/r".into() };
        let target = Target::Key { kind: Kind::Review, source, project: "/p".into() };
        store.update(target, Patch { session: Some("s1".into()), ..Patch::default() }).unwrap();
        rx.try_recv().unwrap();

        publish_session(&hub, &store, "s1", session_event("session.ended", "s1", &Place::default(), json!({ "reason": "died" })));
        let event: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(event["params"]["topic"], "autopilot");
        assert_eq!(event["params"]["data"]["kind"], "autopilot.changed");
        assert_eq!(event["params"]["data"]["item"]["session_live"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn merge_approval() -> Option<approvals::Approval> {
        let draft = approvals::Draft::PrMerge { number: 7, method: crate::forge::MergeMethod::Squash, head_sha: "abc".into() };
        Some(approvals::Approval { project: "/p".into(), draft })
    }

    #[test]
    fn a_hold_changing_reaches_the_autopilot_topic() {
        let hub = Arc::new(Hub::default());
        let (tx, rx) = sync_channel(hub::QUEUE_CAP);
        hub.subscribe(hub.register(tx, Box::new(|| {})), Channel::Autopilot);
        let dir = crate::autopilot::tests::temp_dir("hold-event");
        let publisher = hub.clone();
        let asks = Asks::with_holds(dir.join("holds.json"), Box::new(move |event| publisher.publish(&Channel::Autopilot, event)));
        let ask = asks.create("s1".into(), "merge?".into(), vec![], merge_approval(), None, Some("item-1".into()));
        let event: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(event["params"]["data"]["hold"]["ask"], json!(ask.id));
        asks.withdraw(&ask.id);
        let event: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(event["params"]["data"]["cleared"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_item_closing_while_its_hold_is_answered_blocks_neither() {
        let dir = crate::autopilot::tests::temp_dir("close-race");
        let asks = Arc::new(Asks::with_holds(dir.join("holds.json"), Box::new(|_| {})));
        let bridge = Arc::new(Bridge::new(Box::new(|_| Err("no webview".into())), std::time::Duration::from_millis(10)));
        let store = Arc::new(AutopilotStore::open(dir.clone(), Box::new(|_| {})).on_closed(withdraw_holds(asks.clone(), bridge)));
        let source = Source::Pr { number: 7, repo: "o/r".into() };
        let item = store.update(Target::Key { kind: Kind::Review, source, project: "/p".into() }, Patch::default()).unwrap().id;
        let ask = asks.create("s1".into(), "merge?".into(), vec![], merge_approval(), None, Some(item.clone())).id;

        let (done_tx, done) = std::sync::mpsc::channel();
        let (closing, answering) = (store.clone(), asks.clone());
        let (item_id, ask_id) = (item.clone(), ask.clone());
        let tx = done_tx.clone();
        std::thread::spawn(move || {
            let state = Patch { state: Some(crate::autopilot::State::Done), ..Patch::default() };
            closing.update(Target::Id(item_id), state).unwrap();
            tx.send(()).unwrap();
        });
        std::thread::spawn(move || {
            let _ = answering.answer(&ask_id, approvals::APPROVE.into(), asks::By::User);
            done_tx.send(()).unwrap();
        });
        for _ in 0..2 {
            done.recv_timeout(std::time::Duration::from_secs(5)).expect("neither side blocks");
        }
        assert!(asks.holds().is_empty(), "a done item holds nothing up");
        let read = asks.wait(&ask, std::time::Duration::ZERO);
        assert_eq!(read, asks::Waited::Answered { answer: asks::WITHDRAWN.into(), approval_id: None }, "whichever landed first");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
