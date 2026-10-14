//! The app level socket: one JSON-RPC protocol per Tori process, which the CLI,
//! the MCP server and later a WebSocket are all fronts on. See
//! [[adr_one_protocol_several_fronts]].
//!
//! Found two ways. A process Tori spawns gets `TORI_SOCK` and `TORI_CALLER` in
//! its env; anything else reads the `rpc.json` bridge file the daemon writes.

pub mod approvals;
pub mod asks;
pub mod auth;
pub mod awake;
pub mod bridge;
pub mod client;
pub mod composer;
pub mod daemon;
pub mod devices;
pub mod dots;
pub mod events;
pub mod frame;
pub mod hub;
pub mod launchd;
pub mod methods;
pub mod office;
pub mod outbox;
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
pub mod watcher;
pub mod window;
pub mod ws;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

use crate::autopilot::AutopilotStore;
use asks::Asks;
use auth::Caller;
use bridge::{Bridge, REPLY_TIMEOUT, REQUEST_EVENT};
use events::{session_event, Place};
use hub::{Channel, Hub};
use runner::Runner;
use serde_json::{json, Value};
use states::SessionStates;
use watcher::Watcher;
use window::{Link, Status};

pub const ENV_SOCK: &str = "TORI_SOCK";
// Not `TORI_TOKEN`: codex's shell tool carries default excludes for names like
// `*TOKEN*`, `*KEY*` and `*SECRET*`, and an agent's shell has to see this one.
pub const ENV_CALLER: &str = "TORI_CALLER";

static SOCKET: OnceLock<String> = OnceLock::new();
static LINK: OnceLock<Arc<Link>> = OnceLock::new();
static CLI_DIR: OnceLock<PathBuf> = OnceLock::new();
// Set in the daemon alone, which owns what they hold.
static ASKS: OnceLock<Arc<Asks>> = OnceLock::new();
static RUNNER: OnceLock<Arc<Runner>> = OnceLock::new();
static WATCHER: OnceLock<Arc<Watcher>> = OnceLock::new();
static OFFICE: OnceLock<Arc<office::Office>> = OnceLock::new();
// For modules with no Tauri state in reach: the checkpoint writer, the forge
// poll, the quota push.
static EVENTS: OnceLock<(Arc<Hub>, Arc<SessionStates>)> = OnceLock::new();

pub(crate) fn set_stores(asks: Arc<Asks>, runner: Arc<Runner>, hub: Arc<Hub>, states: Arc<SessionStates>) {
    let _ = ASKS.set(asks);
    let _ = RUNNER.set(runner);
    let _ = EVENTS.set((hub, states));
}

pub(crate) fn set_watcher(watcher: Arc<Watcher>) {
    let _ = WATCHER.set(watcher);
}

pub(crate) fn set_office(office: Arc<office::Office>) {
    let _ = OFFICE.set(office);
}

pub(crate) fn office() -> Option<&'static Arc<office::Office>> {
    OFFICE.get()
}

pub(crate) fn rate_limit_heard(session: &str, event: &crate::chat::model::ChatEvent) {
    if let Some(office) = OFFICE.get() {
        office.rate_limit(session, event);
    }
}

pub(crate) fn watcher_started(item: &crate::autopilot::Item) {
    if let Some(watcher) = WATCHER.get() {
        watcher.started(item);
    }
}

pub(crate) fn watcher_picked(picked: &[crate::autopilot::Item]) {
    if let Some(watcher) = WATCHER.get() {
        watcher.picked(picked);
    }
}

const OFFICE_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

pub fn office_call(op: &str, args: Value) -> Result<Value, String> {
    daemon_wait("office", json!({ "op": op, "args": args }), OFFICE_WAIT)
}

pub fn office_call_as<T: serde::de::DeserializeOwned>(op: &str, args: Value) -> Result<T, String> {
    serde_json::from_value(office_call(op, args)?).map_err(|e| e.to_string())
}

pub(crate) fn in_daemon() -> bool {
    IN_DAEMON.get().is_some()
}

pub(crate) fn office_tell(op: &str, args: Value) {
    daemon_tell("office", json!({ "op": op, "args": args }));
}

pub struct RpcState {
    link: Arc<Link>,
    pub states: Arc<SessionStates>,
    bridge: Arc<Bridge>,
}

impl RpcState {
    /// Called at exit. The daemon, its socket and the bridge file stay.
    pub fn shutdown(&self) {
        self.link.close();
    }
}

// What the window shows when the daemon cannot be reached, kept for a webview
// that loads after the event went out.
const DAEMON_EVENT: &str = "daemon://status";
static DAEMON_STATUS: std::sync::Mutex<Option<Status>> = std::sync::Mutex::new(None);

fn daemon_status_emitter(app: &AppHandle) -> Box<dyn Fn(&Status) + Send + Sync> {
    let app = app.clone();
    Box::new(move |status| {
        *DAEMON_STATUS.lock().unwrap_or_else(|e| e.into_inner()) = Some(status.clone());
        let _ = app.emit(DAEMON_EVENT, status);
        if *status == Status::Connected {
            // Off the link's thread, which is the one that reads the answer.
            let app = app.clone();
            std::thread::spawn(move || crate::pty::resync(&app));
            retell_facts();
        }
    })
}

// What the daemon tells the window: tab and chat events, and the calls its host
// makes into state that still lives here.
fn daemon_events(app: &AppHandle, states: &Arc<SessionStates>) -> window::OnEvent {
    let (app, states) = (app.clone(), states.clone());
    Box::new(move |event, p| {
        let text = |key: &str| p[key].as_str().unwrap_or_default().to_string();
        match event {
            "chat.event" => app.state::<crate::chat::host::ChatState>().0.route(p),
            "emit" if text("event") == crate::topics::EVICT_EVENT => {
                let index = app.state::<crate::config::ProjectIndex>();
                for repo in p["payload"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    index.evict(std::path::Path::new(repo));
                }
            }
            "emit" => {
                let _ = app.emit(&text("event"), p["payload"].clone());
            }
            "askpass.prompt" => {
                let mut prompt = p.clone();
                prompt["id"] = json!(p["id"].as_u64().unwrap_or_default() | office::DAEMON_PROMPT);
                let _ = app.emit("askpass://prompt", prompt);
            }
            "states" => {
                if let Ok(next) = serde_json::from_value(p.clone()) {
                    states.mirror(next);
                }
            }
            "dots" => {
                let _ = app.emit("sessions://dots", p);
            }
            "present" => present_later(&app, p.clone()),
            "needs_you.changed" => {
                let _ = app.emit(crate::needs_you_log::CHANGED_EVENT, ());
            }
            _ => crate::pty::heard(&app, event, p),
        }
    })
}

// Set by `daemon::run` alone, so a test that starts a daemon in process keeps
// the app's behaviour.
pub(crate) struct InDaemon {
    pub hub: Arc<Hub>,
    pub children: Arc<auth::Children>,
    pub states: Arc<SessionStates>,
    pub sock: String,
}

static IN_DAEMON: OnceLock<InDaemon> = OnceLock::new();

pub(crate) fn run_as_daemon(role: InDaemon, cli_dir: PathBuf) {
    let _ = CLI_DIR.set(cli_dir);
    let _ = IN_DAEMON.set(role);
}

const CHAT_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

pub fn daemon_chat(method: &str, args: Value) -> Result<Value, String> {
    let link = LINK.get().ok_or("the daemon link is not up")?;
    link.request("chat", json!({ "method": method, "args": args }), CHAT_WAIT)
        .map_err(|e| e.message)
}

#[tauri::command(async)]
pub fn daemon_restart_now() -> Result<(), String> {
    daemon::set_failed_starts(0).map_err(|e| e.to_string())?;
    launchd::turn_on();
    if launchd::managed() {
        launchd::start(&daemon::paths().log)?;
        return launchd::restart_now();
    }
    daemon_tell("restart", json!({}));
    Ok(())
}

#[tauri::command]
pub fn daemon_status() -> Option<Status> {
    DAEMON_STATUS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

// The webview is not a socket subscriber, so the channel is mirrored to it.
fn screen(bridge: &Arc<Bridge>) -> window::Answers {
    let bridge = bridge.clone();
    window::Answers {
        hub: Arc::new(Hub::default()),
        call: Arc::new(|_, req| {
            Err(frame::RpcError::new(
                frame::REFUSED,
                format!("the window answers no {}", req.method),
            ))
        }),
        screen: Arc::new(move |method, params| bridge.request(method, params)),
    }
}

pub fn start(app: AppHandle) -> std::io::Result<RpcState> {
    let paths = daemon::paths();
    let states = Arc::new(SessionStates::default());
    let emitter = app.clone();
    let bridge = Arc::new(Bridge::new(
        Box::new(move |request| emitter.emit(REQUEST_EVENT, request).map_err(|e| e.to_string())),
        REPLY_TIMEOUT,
    ));
    let answers = screen(&bridge);
    let hub = answers.hub.clone();
    let on_status = daemon_status_emitter(&app);
    let on_event = daemon_events(&app, &states);

    // Derived, not asked for, so a spawn has its env before the link is up.
    let _ = SOCKET.set(paths.sock.to_string_lossy().into_owned());
    let _ = CLI_DIR.set(paths.cli_link_dir.clone());
    let link = Link::start(answers, paths, true, on_status, on_event);
    let _ = LINK.set(link.clone());
    let _ = EVENTS.set((hub.clone(), states.clone()));
    Ok(RpcState { link, states, bridge })
}

// What only the webview knows about its tabs, chats and forge poll, and what
// it is looking at. Kept, so a daemon that restarts under the window hears it again.
static TOLD: std::sync::Mutex<Option<(Value, Value)>> = std::sync::Mutex::new(None);

fn told(change: impl FnOnce(&mut (Value, Value))) {
    let mut told = TOLD.lock().unwrap_or_else(|e| e.into_inner());
    change(told.get_or_insert_with(|| (json!({}), json!({ "session": null, "focused": true }))));
}

fn retell_facts() {
    let Some((facts, attention)) = TOLD.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
        return;
    };
    daemon_tell("facts", facts);
    daemon_tell("attention", attention);
}

#[tauri::command]
pub fn rpc_session_facts(facts: Value) {
    told(|t| t.0 = facts.clone());
    daemon_tell("facts", facts);
}

// The selected row and whether the window has focus, which only the webview knows.
#[tauri::command]
pub fn rpc_attention(session: Option<String>, focused: bool) {
    let attention = json!({ "session": session, "focused": focused });
    told(|t| t.1 = attention.clone());
    daemon_tell("attention", attention);
}

pub fn sessions_changed() {
    daemon_tell("sessions_changed", json!({}));
}

#[tauri::command(async)]
pub fn session_dots() -> Value {
    daemon_request("dots", json!({})).unwrap_or_else(|_| json!([]))
}

// The daemon's reply as it came, so a long list is never parsed here and
// written out again.
#[tauri::command(async)]
pub fn list_sessions(folder: String, inclusive: Option<bool>) -> Result<tauri::ipc::Response, String> {
    let link = LINK.get().ok_or("the daemon link is not up")?;
    link.request_raw(
        "list_sessions",
        json!({ "folder": folder, "inclusive": inclusive }),
        DAEMON_WAIT,
    )
    .map(tauri::ipc::Response::new)
    .map_err(|e| e.message)
}

#[derive(serde::Deserialize)]
struct Shown {
    withdraw: Vec<String>,
    needs_you: Vec<crate::presence::Live>,
    finished: Vec<crate::presence::Live>,
    needs_you_sound: bool,
    finished_sound: bool,
    tray: Option<(String, Vec<crate::presence::TrayEntry>)>,
    badge: Option<usize>,
}

static PRESENTER: OnceLock<std::sync::Mutex<std::sync::mpsc::Sender<Value>>> = OnceLock::new();

// Off the link's reader, in order: building the tray's menu waits on the main
// thread, which may itself be waiting on a reply this reader has to deliver.
fn present_later(app: &AppHandle, shown: Value) {
    let tx = PRESENTER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Value>();
        let app = app.clone();
        std::thread::spawn(move || {
            while let Ok(shown) = rx.recv() {
                present(&app, &shown);
            }
        });
        std::sync::Mutex::new(tx)
    });
    let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(shown);
}

fn present(app: &AppHandle, shown: &Value) {
    let Ok(shown) = serde_json::from_value::<Shown>(shown.clone()) else {
        return;
    };
    for id in &shown.withdraw {
        crate::presence::withdraw_notification(app, id);
    }
    for l in &shown.needs_you {
        crate::presence::notify_session(app.clone(), l, crate::presence::needs_you_body(l), true);
    }
    // No click wait: a turn finishes far more often than one blocks, and a
    // wait parks a thread for as long as the notification stays.
    for l in &shown.finished {
        crate::presence::notify_session(app.clone(), l, crate::presence::finished_body(l), false);
    }
    if shown.needs_you_sound {
        crate::sound::play(app, crate::sound::Sound::NeedsYou);
    }
    if shown.finished_sound {
        crate::sound::play(app, crate::sound::Sound::TurnFinished);
    }
    if let Some((tooltip, entries)) = shown.tray {
        let _ = crate::presence::set_tray(app, &tooltip, &entries);
    }
    if let Some(count) = shown.badge {
        let _ = crate::presence::set_badge_count(app, count);
    }
}

/// Tori telling one live chat something it should know: steered into the
/// running turn, or held for the user's next one when the session is idle, so
/// the note never starts a turn of its own.
pub fn tell_session(desk: &crate::desk::Desk, session: &str, kind: &str, text: &str) -> Result<(), String> {
    let mid_turn = matches!(
        desk.states.snapshot().get(session),
        Some(states::SessionState::Working | states::SessionState::NeedsYou)
    );
    let text = events::from_tori(kind, None, text);
    let host = &desk.chats.host;
    if !mid_turn {
        host.note_for_next_turn(session, text);
        return Ok(());
    }
    // An agent that cannot take a message mid-turn (ACP) still hears it, on the
    // user's next one.
    if host
        .deliver(
            session,
            vec![crate::chat::model::ContentBlock::Text { text: text.clone() }],
            true,
            events::TurnBy::Local,
        )
        .is_err()
    {
        host.note_for_next_turn(session, text);
    }
    Ok(())
}

pub fn spawn_review(folder: &str, project: &str, prompt: String) -> Result<String, String> {
    let spawned = office_call(
        "spawn_review",
        json!({ "folder": folder, "project": project, "prompt": prompt }),
    )?;
    spawned
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "the daemon started no session".to_string())
}

pub fn session_mid_turn(app: &AppHandle, session: &str) -> bool {
    matches!(
        app.state::<RpcState>().states.snapshot().get(session),
        Some(states::SessionState::Working | states::SessionState::NeedsYou)
    )
}

pub fn session_live(app: &AppHandle, session: &str) -> bool {
    app.state::<crate::chat::host::ChatState>().0.is_live(session)
}

pub fn steer_idle(app: &AppHandle, session: &str, kind: &str, text: &str) -> Result<(), String> {
    if session_mid_turn(app, session) {
        return Err(format!("{session} is mid-turn"));
    }
    let text = events::from_tori(kind, None, text);
    app.state::<crate::chat::host::ChatState>().0.deliver(
        session,
        vec![crate::chat::model::ContentBlock::Text { text }],
        false,
        events::TurnBy::Local,
    )
}

pub fn record_rule_review(
    project: &str,
    repo: &str,
    account: &str,
    review: crate::autopilot::RuleReview,
) -> Result<(), String> {
    let args = json!({ "project": project, "repo": repo, "account": account, "review": review });
    office_call("rule_review", args).map(|_| ())
}

/// A Topic home chat just compacted, and the summary may have dropped what its
/// Topic is. Told again from the record as it is now: into the running turn
/// when the window filled mid-turn, on the next message after a `/compact`,
/// whose turn ends at once and would take a steer as a turn of its own.
pub fn retell_topic(desk: &crate::desk::Desk, session: &str, mid_turn: bool) {
    let host = &desk.chats.host;
    let Some((_, cwd)) = host.live_sessions().into_iter().find(|(id, _)| id == session) else {
        return;
    };
    // Canonical, as the spawn's own lookup is, so a cwd spelled another way
    // still finds its Topic.
    let real = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| p.into());
    let topics = crate::unit_home::topics();
    let Some(topic) = topics
        .iter()
        .find(|t| t.home.as_deref().is_some_and(|h| real(h) == real(&cwd)))
    else {
        return;
    };
    let note = crate::topic_home::note(topic);
    if !mid_turn {
        host.note_for_next_turn(session, events::from_tori("topic", None, &note));
        return;
    }
    // Off the publishing thread, which is the session's own event thread.
    let (desk, session) = (desk.clone(), session.to_string());
    std::thread::spawn(move || {
        let _ = tell_session(&desk, &session, "topic", &note);
    });
}

// An item whose session ended keeps its stored state, but what the autopilot
// sees of it changed.
pub fn heard_session(autopilot: &AutopilotStore, id: &str, event: &Value) {
    if let Some(runner) = RUNNER.get() {
        runner.observe(id, event);
    }
    if let Some(watcher) = WATCHER.get() {
        watcher.session_event(id, event);
    }
    if event["kind"] == "session.ended" {
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

#[tauri::command(async)]
pub fn rpc_asks_pending() -> Result<Vec<Value>, String> {
    office_call_as("asks.pending", json!({}))
}

#[tauri::command(async)]
pub fn rpc_ask_answer(id: String, answer: String) -> Result<bool, String> {
    office_call_as("asks.answer", json!({ "id": id, "answer": answer }))
}

pub fn publish_checkpoint(session_id: &str, folder: &str, turn: usize, prompt_ts: u64) {
    let Some(hub) = events_hub() else { return };
    let event = session_event(
        "session.checkpoint",
        session_id,
        &Place::of(folder),
        json!({ "turn": turn, "prompt_ts": prompt_ts }),
    );
    hub.publish_session(session_id, event);
}

// The phone hears the sessions channel, not the webview's `review://changed`.
pub fn publish_reviewed(session_id: &str, folder: &str) {
    let Some((hub, _)) = EVENTS.get() else { return };
    hub.publish_session(
        session_id,
        session_event("session.reviewed", session_id, &Place::of(folder), json!({})),
    );
}

// On `sessions`, which every phone screen already reads and ignores unknown kinds of.
pub fn publish_needs_you(ui: &crate::ui::Ui) {
    ui.emit(crate::needs_you_log::CHANGED_EVENT, ());
    let Some((hub, _)) = EVENTS.get() else { return };
    hub.publish(&Channel::Sessions, json!({ "kind": "needs_you.changed" }));
}

fn events_hub() -> Option<&'static Arc<Hub>> {
    IN_DAEMON
        .get()
        .map(|role| &role.hub)
        .or_else(|| EVENTS.get().map(|(hub, _)| hub))
}

// Serialised only while someone reads `chat:<id>`: this runs on every delta.
pub fn publish_chat(session_id: &str, event: &crate::chat::model::ChatEvent) {
    let Some(hub) = events_hub() else { return };
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
    if IN_DAEMON.get().is_none() {
        let args = json!({ "project": project, "folder": folder, "branch": branch, "checked_out": checked_out, "fields": fields });
        return office_tell("publish_pr", args);
    }
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
pub fn remote_set(remote: crate::settings::Remote) -> Result<Value, String> {
    office_call("remote.set", json!({ "remote": remote }))
}

#[tauri::command(async)]
pub fn remote_status() -> Result<Value, String> {
    office_call("remote.status", json!({}))
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

#[tauri::command(async)]
pub fn pairing_start() -> Result<Value, String> {
    let mut offer = office_call("pairing.start", json!({}))?;
    let uri = offer["uri"].as_str().unwrap_or_default();
    let svg = qrcode::QrCode::new(uri.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .quiet_zone(true)
        .build();
    offer["svg"] = json!(svg);
    Ok(offer)
}

#[tauri::command(async)]
pub fn pairing_cancel() -> Result<(), String> {
    office_call("pairing.cancel", json!({})).map(|_| ())
}

#[tauri::command(async)]
pub fn devices_list() -> Result<Value, String> {
    office_call("devices.list", json!({}))
}

#[tauri::command(async)]
pub fn device_revoke(id: String) -> Result<(), String> {
    office_call("device.revoke", json!({ "id": id })).map(|_| ())
}

// The webview's own switch: not a socket caller, so it goes around the
// `NOT_SESSIONS` rows to the same runner.
#[tauri::command(async)]
pub fn autopilot_start() -> Result<Value, String> {
    office_call("autopilot.start", json!({}))
}

#[tauri::command(async)]
pub fn autopilot_stop() -> Result<Value, String> {
    office_call("autopilot.stop", json!({}))
}

// Async: reading it asks the forge for open pull requests.
#[tauri::command(async)]
pub fn autopilot_state() -> Result<Value, String> {
    office_call("autopilot.state", json!({}))
}

// The contracts alone, without the forge reads a full `autopilot_state` makes.
#[tauri::command(async)]
pub fn autopilot_contracts() -> Result<std::collections::BTreeMap<String, crate::autopilot::Contract>, String> {
    office_call_as("autopilot.contracts", json!({}))
}

// Through the socket's own params, so the editor gets the same refusals a tool does.
#[tauri::command(async)]
pub fn autopilot_project_set(project_path: String, patch: Value) -> Result<Value, String> {
    office_call(
        "autopilot.project_set",
        json!({ "project_path": project_path, "patch": patch }),
    )
}

// Called from the webview's forge poll tick, so it rides that cadence and its
// pause and backoff rather than a clock of its own.
#[tauri::command(async)]
pub fn autopilot_pickup(project_path: String) -> Result<(), String> {
    office_call("autopilot.pickup", json!({ "project_path": project_path })).map(|_| ())
}

#[tauri::command(async)]
pub fn autopilot_log(limit: usize) -> Result<Vec<Value>, String> {
    office_call_as("autopilot.log", json!({ "limit": limit }))
}

#[tauri::command(async)]
pub fn autopilot_status() -> Result<Value, String> {
    office_call("autopilot.status", json!({}))
}

#[tauri::command(async)]
pub fn autopilot_closed_by_hand(session: String) -> Result<(), String> {
    office_call("autopilot.closed_by_hand", json!({ "session": session })).map(|_| ())
}

#[tauri::command(async)]
pub fn autopilot_locked() -> Result<Vec<String>, String> {
    office_call_as("autopilot.locked", json!({}))
}

pub const LOCKED: &str = "locked while the autopilot drives it; stop the autopilot to type";

pub fn is_locked(states: &SessionStates, autopilot: &AutopilotStore, runner: &Runner, session: &str) -> bool {
    let spawner = states.spawner_of(session).map(|s| runner.resolve_spawner(&s));
    runner::locks(
        &runner.status(),
        autopilot.state_for_session(session),
        spawner.as_deref(),
    )
}

// Refused when the lock cannot be read either: the chat is the daemon's, so a
// daemon that does not answer could not take the message anyway.
pub fn refuse_locked(session: &str) -> Result<(), String> {
    match office_call_as::<bool>("locked", json!({ "session": session }))? {
        true => Err(LOCKED.to_string()),
        false => Ok(()),
    }
}

#[tauri::command(async)]
pub fn pr_watch_list() -> Result<Value, String> {
    office_call("pr_watch.list", json!({}))
}

#[tauri::command(async)]
pub fn pr_watch_start(session: String, project: String, number: u64) -> Result<String, String> {
    office_call_as(
        "pr_watch.start",
        json!({ "session": session, "project": project, "number": number }),
    )
}

#[tauri::command(async)]
pub fn pr_watch_stop(session: String, url: String) -> Result<bool, String> {
    office_call_as("pr_watch.stop", json!({ "session": session, "url": url }))
}

#[tauri::command(async)]
pub fn sessions_adoptable() -> Result<Vec<Value>, String> {
    office_call_as("sessions.adoptable", json!({}))
}

#[tauri::command]
pub fn session_adopted(session: String) {
    office_tell("sessions.adopted", json!({ "session": session }));
}

#[tauri::command]
pub fn rpc_quota(agent: String, profile: Option<String>, readings: Vec<quotas::Reading>) {
    office_tell(
        "quota",
        json!({ "agent": agent, "profile": profile, "readings": readings }),
    );
}

/// `path` with the directory holding the `tori` link in front. Unchanged when
/// the socket never came up, since a `tori` that cannot reach anything is worse
/// than none.
pub fn path_with_cli(path: &str) -> String {
    match CLI_DIR.get() {
        Some(dir) => path_with_dir(dir, path),
        None => path.to_string(),
    }
}

pub fn path_with_dir(dir: &std::path::Path, path: &str) -> String {
    if path.is_empty() {
        dir.to_string_lossy().into_owned()
    } else {
        format!("{}:{path}", dir.to_string_lossy())
    }
}

const DAEMON_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

pub fn daemon_request(method: &str, params: Value) -> Result<Value, String> {
    let link = LINK.get().ok_or("the daemon link is not up")?;
    link.request(method, params, DAEMON_WAIT).map_err(|e| e.message)
}

pub fn daemon_wait(method: &str, params: Value, wait: std::time::Duration) -> Result<Value, String> {
    let link = LINK.get().ok_or("the daemon link is not up")?;
    link.request(method, params, wait).map_err(|e| e.message)
}

pub fn daemon_tell(method: &'static str, params: Value) {
    if let Some(link) = LINK.get() {
        link.notify(method, params);
    }
}

pub fn attach_pty(
    tab: &str,
    cols: u16,
    rows: u16,
) -> Result<
    (
        std::os::unix::net::UnixStream,
        std::io::BufReader<std::os::unix::net::UnixStream>,
    ),
    String,
> {
    LINK.get()
        .ok_or("the daemon link is not up")?
        .attach_pty(tab, cols, rows)
}

/// Env for a process Tori spawns, with a token the daemon minted for `caller`.
/// Empty when the daemon is not attached to vouch for it.
pub fn child_env(caller: Caller) -> Vec<(String, String)> {
    if let Some(role) = IN_DAEMON.get() {
        let token = role.children.mint(caller);
        return vec![
            (ENV_SOCK.to_string(), role.sock.clone()),
            (ENV_CALLER.to_string(), token),
        ];
    }
    let (Some(sock), Some(link)) = (SOCKET.get(), LINK.get()) else {
        return Vec::new();
    };
    link.mint(caller)
        .map(|token| vec![(ENV_SOCK.to_string(), sock.clone()), (ENV_CALLER.to_string(), token)])
        .unwrap_or_default()
}

// A chat that ended can no longer show its asks, so they go with its token.
pub fn revoke(caller: &Caller) {
    if let Some(role) = IN_DAEMON.get() {
        role.children.revoke(caller);
        forget_caller(caller);
        return;
    }
    if let Some(link) = LINK.get() {
        link.revoke(caller);
    }
    forget_caller(caller);
}

fn forget_caller(caller: &Caller) {
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
    let agents = [
        table::CallerKind::Terminal,
        table::CallerKind::Chat,
        table::CallerKind::Worker,
    ];
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
    if let Some(role) = IN_DAEMON.get() {
        role.states.mark_worker(session, &current_spawner(spawner));
        return;
    }
    let spawner = current_spawner(spawner);
    if let Some((_, states)) = EVENTS.get() {
        states.mark_worker(session, &spawner);
    }
}

pub fn session_running(session: &str) -> bool {
    EVENTS.get().is_some_and(|(_, states)| states.running(session))
}

pub fn current_spawner(spawner: &str) -> String {
    RUNNER
        .get()
        .map_or_else(|| spawner.to_string(), |r| r.resolve_spawner(spawner))
}

// Called by `chat_spawn` before the child starts, so its first outward call already meets the gate.
pub fn mark_background(session: &str) {
    if let Some(role) = IN_DAEMON.get() {
        role.states.mark_background(session);
        return;
    }
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
    let command = CLI_DIR.get().map_or_else(
        || "tori".to_string(),
        |dir| dir.join("tori").to_string_lossy().into_owned(),
    );
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

pub(crate) fn devices_path() -> PathBuf {
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
        let store = AutopilotStore::open(
            dir.clone(),
            Box::new(move |event| publisher.publish(&Channel::Autopilot, event)),
        );
        let source = Source::Pr {
            number: 7,
            repo: "o/r".into(),
        };
        let target = Target::Key {
            kind: Kind::Review,
            source,
            project: "/p".into(),
            origin: "o/r".into(),
        };
        store
            .update(
                target,
                Patch {
                    session: Some("s1".into()),
                    ..Patch::default()
                },
            )
            .unwrap();
        rx.try_recv().unwrap();

        heard_session(
            &store,
            "s1",
            &session_event("session.ended", "s1", &Place::default(), json!({ "reason": "died" })),
        );
        let event: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(event["params"]["topic"], "autopilot");
        assert_eq!(event["params"]["data"]["kind"], "autopilot.changed");
        assert_eq!(event["params"]["data"]["item"]["session_live"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn merge_approval() -> Option<approvals::Approval> {
        let draft = approvals::Draft::PrMerge {
            number: 7,
            method: crate::forge::MergeMethod::Squash,
            head_sha: "abc".into(),
        };
        Some(approvals::Approval {
            project: "/p".into(),
            draft,
        })
    }

    #[test]
    fn a_hold_changing_reaches_the_autopilot_topic() {
        let hub = Arc::new(Hub::default());
        let (tx, rx) = sync_channel(hub::QUEUE_CAP);
        hub.subscribe(hub.register(tx, Box::new(|| {})), Channel::Autopilot);
        let dir = crate::autopilot::tests::temp_dir("hold-event");
        let publisher = hub.clone();
        let asks = Asks::with_holds(
            dir.join("holds.json"),
            Box::new(move |event| publisher.publish(&Channel::Autopilot, event)),
        );
        let ask = asks.create(
            "s1".into(),
            "merge?".into(),
            vec![],
            merge_approval(),
            None,
            Some("item-1".into()),
        );
        let event: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(event["params"]["data"]["hold"]["ask"], json!(ask.id));
        asks.withdraw(&ask.id);
        let event: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(event["params"]["data"]["cleared"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
