//! The app level socket: one JSON-RPC protocol per Tori process, which the CLI,
//! the MCP server and later a WebSocket are all fronts on. See
//! [[adr_one_protocol_several_fronts]].
//!
//! Found two ways. A process Tori spawns gets `TORI_SOCK` and `TORI_CALLER` in
//! its env; anything else reads the `rpc.json` bridge file, the same shape and
//! the same lifetime rule as the askpass one in `crate::credential`.

pub mod approvals;
pub mod asks;
pub mod auth;
pub mod bridge;
pub mod client;
pub mod events;
pub mod frame;
pub mod hub;
pub mod methods;
pub mod quotas;
pub mod runner;
pub mod server;
pub mod states;
pub mod table;
pub mod transport;
pub mod watcher;

use std::cell::OnceCell;
use std::collections::HashSet;
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
use runner::Runner;
use serde_json::{json, Value};
use server::{Server, AUTH_TIMEOUT};
use states::{Held, Reported, SessionStates, Source};
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
    pub hub: Arc<Hub>,
    states: Arc<SessionStates>,
    bridge: Arc<Bridge>,
    asks: Arc<Asks>,
    pub autopilot: Arc<AutopilotStore>,
    pub runner: Arc<Runner>,
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

pub fn start(app: AppHandle) -> std::io::Result<RpcState> {
    let transport = Arc::new(UnixTransport::bind()?);
    let token = crate::chat::approval::random_token();
    let hub = Arc::new(Hub::default());
    let children = Arc::new(Children::default());
    let states = Arc::new(SessionStates::default());
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
    let server = Arc::new(Server {
        credential: Credential { process: token.clone(), children: children.clone() },
        hub: hub.clone(),
        backend: Box::new(methods::TauriBackend {
            app,
            states: states.clone(),
            bridge: bridge.clone(),
            asks: asks.clone(),
            autopilot: autopilot.clone(),
            runner: runner.clone(),
        }),
        auth_timeout: AUTH_TIMEOUT,
    });
    server::serve(transport.clone() as Arc<dyn Transport>, server);

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
    Ok(RpcState { transport, hub, states, bridge, asks, autopilot, runner, quotas: Quotas::default() })
}

// Async so resolving a new session's project, which reads the config and lists
// the discovery root, stays off the main thread.
#[tauri::command(async)]
pub fn rpc_session_states(
    rpc: tauri::State<RpcState>,
    chat: tauri::State<crate::chat::host::ChatState>,
    pty: tauri::State<crate::pty::PtyState>,
    states: Vec<Reported>,
) {
    let chats: HashSet<String> = chat.0.live_sessions().into_iter().map(|(id, _)| id).collect();
    let tabs: HashSet<String> = pty.live_ids().unwrap_or_default().into_iter().collect();
    let projects = OnceCell::new();
    let place_of = |folder: &str| Place {
        project: events::project_of(folder, projects.get_or_init(crate::config::discovered_project_dirs)),
        folder: Some(folder.to_string()),
    };
    let alive = |id: &str, held: &Held| match held.source {
        Source::Chat => chats.contains(id),
        Source::Pty => held.tab.as_ref().is_some_and(|tab| tabs.contains(tab)),
    };
    for event in rpc.states.replace(states, place_of, alive) {
        let id = event["id"].as_str().unwrap_or_default().to_string();
        publish_session(&rpc.hub, &rpc.autopilot, &id, event);
    }
}

fn start_watcher(app: &AppHandle, states: &Arc<SessionStates>, autopilot: &Arc<AutopilotStore>, runner: &Arc<Runner>) {
    let status = runner.clone();
    let (watcher, nudges) = Watcher::new(states.clone(), autopilot.clone(), Box::new(move || status.status()));
    let _ = WATCHER.set(watcher.clone());
    let app = app.clone();
    std::thread::spawn(move || {
        let deliver = |session: &str, text: String| {
            let host = &app.state::<crate::chat::host::ChatState>().0;
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
    };
    backend.autopilot_state().map_err(|e| e.message)
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
    table::METHODS.iter().filter(|m| !m.outward).map(|m| format!("mcp__{MCP_SERVER}__{}", m.name.replace('.', "_"))).collect()
}

// Called by `chat_spawn` for a background worker, fresh or resumed. A resumed
// one lost its spawner link with the old process, and a retired autopilot id
// stands for the current autopilot.
pub fn mark_spawned_worker(session: &str, spawner: &str) {
    let spawner = RUNNER.get().map_or_else(|| spawner.to_string(), |r| r.resolve_spawner(spawner));
    if let Some((_, states)) = EVENTS.get() {
        states.mark_worker(session, &spawner);
    }
}

// Called by `chat_spawn` before the child starts, so its first outward call already meets the gate.
pub fn mark_background(session: &str) {
    if let Some((_, states)) = EVENTS.get() {
        states.mark_background(session);
    }
}

/// `["--mcp-config", <path>]` naming `tori mcp`, for a claude Tori launches.
/// One static file for every session: `tori` resolves through the `bin/tori`
/// link on the child's PATH and `tori mcp` inherits the child's socket env.
/// Empty if the file cannot be written, so the launch goes on without it.
pub fn mcp_config_args() -> Vec<String> {
    let path = dirs::home_dir().unwrap_or_default().join(".config/tori/claude-mcp.json");
    let config = json!({ "mcpServers": { MCP_SERVER: { "command": "tori", "args": ["mcp"] } } });
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
    dirs::home_dir().unwrap_or_default().join(".config/tori/rpc.json")
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
