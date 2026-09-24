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
pub mod server;
pub mod states;
pub mod table;
pub mod transport;

use std::cell::OnceCell;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Emitter};

use crate::autopilot::AutopilotStore;
use asks::{Ask, Asks};
use auth::{Caller, Children, Credential};
use bridge::{Bridge, REPLY_TIMEOUT, REQUEST_EVENT};
use events::{session_event, Place};
use hub::{Channel, Hub};
use quotas::Quotas;
use serde_json::{json, Value};
use server::{Server, AUTH_TIMEOUT};
use states::{Held, Reported, SessionStates, Source};
use transport::{Transport, UnixTransport};

pub const ENV_SOCK: &str = "TORI_SOCK";
// Not `TORI_TOKEN`: codex's shell tool carries default excludes for names like
// `*TOKEN*`, `*KEY*` and `*SECRET*`, and an agent's shell has to see this one.
pub const ENV_CALLER: &str = "TORI_CALLER";

static SOCKET: OnceLock<(String, Arc<Children>)> = OnceLock::new();
static CLI_DIR: OnceLock<PathBuf> = OnceLock::new();
static ASKS: OnceLock<Arc<Asks>> = OnceLock::new();
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

pub fn start(app: AppHandle) -> std::io::Result<RpcState> {
    let transport = Arc::new(UnixTransport::bind()?);
    let token = crate::chat::approval::random_token();
    let hub = Arc::new(Hub::default());
    let children = Arc::new(Children::default());
    let states = Arc::new(SessionStates::default());
    let asks = Arc::new(Asks::default());
    let autopilot_hub = hub.clone();
    let autopilot = Arc::new(AutopilotStore::open(
        crate::autopilot::dir(),
        Box::new(move |event| autopilot_hub.publish(&Channel::Autopilot, event)),
    ));
    let emitter = app.clone();
    let bridge = Arc::new(Bridge::new(
        Box::new(move |request| emitter.emit(REQUEST_EVENT, request).map_err(|e| e.to_string())),
        REPLY_TIMEOUT,
    ));
    let server = Arc::new(Server {
        credential: Credential { process: token.clone(), children: children.clone() },
        hub: hub.clone(),
        backend: Box::new(methods::TauriBackend {
            app,
            states: states.clone(),
            bridge: bridge.clone(),
            asks: asks.clone(),
            autopilot: autopilot.clone(),
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
    let _ = EVENTS.set((hub.clone(), states.clone()));
    match link_cli(transport.sock_path()) {
        Ok(dir) => {
            let _ = CLI_DIR.set(dir);
        }
        Err(e) => eprintln!("tori: cli not linked onto PATH: {e}"),
    }
    Ok(RpcState { transport, hub, states, bridge, asks, autopilot, quotas: Quotas::default() })
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

// An item whose session ended keeps its stored state, but what the autopilot sees of it changed.
pub fn publish_session(hub: &Hub, autopilot: &AutopilotStore, id: &str, event: Value) {
    let ended = event["kind"] == "session.ended";
    hub.publish_session(id, event);
    if ended {
        autopilot.session_ended(id);
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
    for id in &ids {
        hub.publish(&Channel::Session(id.clone()), event.clone());
    }
    hub.publish(&Channel::Sessions, event);
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
}
