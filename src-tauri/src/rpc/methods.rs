//! `sessions.list` and `session.tail`, read from the same stores the sidebar and
//! the chat panel read.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::asks::{Asks, Waited};
use super::auth::{Caller, Principal};
use super::bridge::Bridge;
use super::events::{project_of, TurnBy};
use super::frame::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, REFUSED};
use super::server::{
    AskParams, AskWaitParams, Backend, BudgetParams, CheckpointParams, CheckpointsParams, ListParams, OpenParams, SpawnParams, SteerParams, TailParams,
    WorktreeParams,
};
use super::states::{SessionState, SessionStates};
use crate::chat::commands::{history_source, read_history};
use crate::chat::host::ChatState;
use crate::chat::model::{cap_output, ChatEvent, ContentBlock};
use crate::chat::ownership::Registry;
use crate::sessions::{cwd_matches, listed_sessions, SessionIndex, SessionMeta};

const DEFAULT_LIST_LIMIT: usize = 50;
const DEFAULT_TAIL_LIMIT: usize = 50;
const DEFAULT_ASK_WAIT: u64 = 60;

#[derive(Serialize)]
struct Row {
    #[serde(flatten)]
    meta: SessionMeta,
    live: bool,
    // `None` for a live session the webview has not reported yet.
    state: Option<SessionState>,
}

/// A session this Tori is running right now, joined from the claims (agent) and
/// the chat host (cwd). A terminal tab's agent has no cwd here.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Live {
    pub agent: String,
    pub cwd: String,
}

fn live_row(id: &str, live: &Live, now: u64) -> SessionMeta {
    SessionMeta {
        id: id.to_string(),
        path: String::new(),
        cwd: live.cwd.clone(),
        branch: String::new(),
        title: String::new(),
        last_active: now,
        created_at: now,
        name: None,
        agent: live.agent.clone(),
        profile: None,
        profile_label: None,
    }
}

/// Indexed rows stamped `live`, with live sessions the index has not seen yet
/// (no transcript written) put first, since they are the newest there are.
fn list(
    indexed: Vec<SessionMeta>,
    live: &BTreeMap<String, Live>,
    states: &HashMap<String, SessionState>,
    params: &ListParams,
    now: u64,
) -> Vec<Value> {
    let seen: HashSet<&str> = indexed.iter().map(|m| m.id.as_str()).collect();
    let fresh: Vec<SessionMeta> = live
        .iter()
        .filter(|(id, _)| !seen.contains(id.as_str()))
        .map(|(id, l)| live_row(id, l, now))
        .filter(|m| params.cwd.as_deref().is_none_or(|folder| cwd_matches(&m.cwd, folder)))
        .collect();
    fresh
        .into_iter()
        .chain(indexed)
        .map(|meta| {
            // A PTY agent tab that started fresh holds no claim, so the
            // webview's report is the only thing saying it is live.
            let state = states.get(&meta.id).copied();
            let live = live.contains_key(&meta.id) || state.is_some();
            Row { state: state.or((!live).then_some(SessionState::Ended)), live, meta }
        })
        .filter(|row| !params.live.unwrap_or(false) || row.live)
        .take(params.limit.unwrap_or(DEFAULT_LIST_LIMIT))
        .filter_map(|row| serde_json::to_value(row).ok())
        .collect()
}

/// The last `limit` events with every tool output capped. Capped here rather
/// than through `ChatHost::cut_outputs`, which would store the full outputs in
/// a live session's small cache and evict the ones the panel is holding.
fn tail(mut events: Vec<ChatEvent>, limit: usize) -> Vec<ChatEvent> {
    let keep = events.len().saturating_sub(limit);
    let mut tail = events.split_off(keep);
    for event in &mut tail {
        if let ChatEvent::ToolCallCompleted { output: Some(output), output_truncated, .. } = event {
            if let Some(cut) = cap_output(output) {
                *output = cut;
                *output_truncated = true;
            }
        }
    }
    tail
}

// What a method falls back to when a param is left out. All empty for a
// process Tori did not start, so that caller has to pass everything.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct Identity {
    pub agent: Option<String>,
    pub account: Option<String>,
    pub cwd: Option<String>,
}

fn chat_identity(registry: &Registry, live: &[(String, String)], id: &str) -> Identity {
    Identity {
        agent: registry.agent_of(id),
        account: registry.profile_of(id),
        cwd: live.iter().find(|(live_id, _)| live_id == id).map(|(_, cwd)| cwd.clone()),
    }
}

// `given`, else the caller's own, else an error naming the flag to pass.
pub fn or_callers(given: Option<String>, callers: impl FnOnce() -> Option<String>, flag: &str) -> Result<String, RpcError> {
    given.or_else(callers).ok_or_else(|| {
        RpcError::new(INVALID_PARAMS, format!("pass --{flag}: the caller has no {flag} of its own to default to"))
    })
}

fn same_folder(a: &str, b: &str) -> bool {
    cwd_matches(a, b) && cwd_matches(b, a)
}

fn refused(message: String) -> RpcError {
    RpcError::new(REFUSED, message)
}

pub struct TauriBackend {
    pub app: AppHandle,
    pub states: Arc<SessionStates>,
    pub bridge: Arc<Bridge>,
    pub asks: Arc<Asks>,
}

impl TauriBackend {
    fn live(&self) -> BTreeMap<String, Live> {
        let host = &self.app.state::<ChatState>().0;
        let mut live: BTreeMap<String, Live> = host
            .registry
            .held_here()
            .into_iter()
            .map(|(id, agent)| (id, Live { agent, cwd: String::new() }))
            .collect();
        for (id, cwd) in host.live_sessions() {
            live.entry(id).or_default().cwd = cwd;
        }
        live
    }

    pub fn identity(&self, principal: &Principal) -> Identity {
        match principal {
            Principal::Local => Identity::default(),
            Principal::Session(Caller::Terminal(tab)) => {
                self.app.state::<crate::pty::PtyState>().identity(tab).unwrap_or_default()
            }
            Principal::Session(Caller::Chat(id)) => {
                let host = &self.app.state::<ChatState>().0;
                chat_identity(&host.registry, &host.live_sessions(), id)
            }
        }
    }

    fn session_cwd(&self, id: &str) -> Result<String, RpcError> {
        let host = &self.app.state::<ChatState>().0;
        host.live_sessions()
            .into_iter()
            .find(|(live, _)| live == id)
            .map(|(_, cwd)| cwd)
            .or_else(|| {
                listed_sessions(&self.app.state::<SessionIndex>(), None).into_iter().find(|m| m.id == id).map(|m| m.cwd)
            })
            .filter(|cwd| !cwd.is_empty())
            .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("no session {id}")))
    }

    fn checkpoint(&self, id: &str, turn: usize) -> Result<(String, u64), RpcError> {
        let cwd = self.session_cwd(id)?;
        let list = crate::checkpoint::checkpoint_list(cwd.clone(), id.to_string()).map_err(refused)?;
        let entry = turn.checked_sub(1).and_then(|i| list.get(i)).ok_or_else(|| {
            RpcError::new(INVALID_PARAMS, format!("no turn {turn}: {id} has {} checkpoints", list.len()))
        })?;
        Ok((cwd, entry.prompt_ts))
    }

    // Other live sessions writing in `cwd`, which a revert would pull the floor
    // out from under.
    fn others_in(&self, cwd: &str, id: &str, principal: &Principal) -> Vec<String> {
        let host = &self.app.state::<ChatState>().0;
        let mut others: Vec<String> =
            host.live_sessions().into_iter().filter(|(live, at)| live != id && same_folder(at, cwd)).map(|(live, _)| live).collect();
        let ptys = self.app.state::<crate::pty::PtyState>();
        let own_tab = match principal {
            Principal::Session(Caller::Terminal(tab)) => Some(tab.as_str()),
            _ => None,
        };
        for tab in ptys.live_ids().unwrap_or_default() {
            let here = ptys.identity(&tab).is_some_and(|i| i.agent.is_some() && i.cwd.is_some_and(|at| same_folder(&at, cwd)));
            if here && Some(tab.as_str()) != own_tab {
                others.push(format!("terminal tab {tab}"));
            }
        }
        others
    }

    fn create_worktree(&self, principal: &Principal, params: WorktreeParams) -> Result<String, RpcError> {
        let callers =
            || self.identity(principal).cwd.and_then(|cwd| project_of(&cwd, &crate::config::discovered_project_dirs()));
        let project = or_callers(params.project, callers, "project")?;
        let create = crate::worktree::create_worktree(self.app.clone(), project, params.branch, params.from);
        tauri::async_runtime::block_on(create).map_err(refused)
    }

    fn wait_for_answer(&self, id: &str, timeout: Option<u64>) -> Result<Value, RpcError> {
        match self.asks.wait(id, std::time::Duration::from_secs(timeout.unwrap_or(DEFAULT_ASK_WAIT))) {
            Waited::Answered(answer) => Ok(json!({ "id": id, "answer": answer })),
            Waited::Pending => Ok(json!({ "id": id, "answer": null })),
            Waited::Unknown => Err(RpcError::new(INVALID_PARAMS, format!("no ask {id}, or its answer was already read"))),
        }
    }

    fn agent_of(&self, id: &str) -> Option<String> {
        if let Some(live) = self.live().remove(id).filter(|l| !l.agent.is_empty()) {
            return Some(live.agent);
        }
        listed_sessions(&self.app.state::<SessionIndex>(), None).into_iter().find(|m| m.id == id).map(|m| m.agent)
    }
}

impl Backend for TauriBackend {
    fn sessions_list(&self, params: ListParams) -> Result<Value, RpcError> {
        let indexed = listed_sessions(&self.app.state::<SessionIndex>(), params.cwd.as_deref());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut rows = list(indexed, &self.live(), &self.states.snapshot(), &params, now);
        let background = self.states.background();
        for row in rows.iter_mut().filter(|row| row["id"].as_str().is_some_and(|id| background.contains(id))) {
            row["background"] = json!(true);
        }
        Ok(Value::Array(rows))
    }

    fn session_tail(&self, params: TailParams) -> Result<Value, RpcError> {
        let agent = match params.agent {
            Some(agent) => agent,
            None => self.agent_of(&params.id).ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("no session {}", params.id)))?,
        };
        let from = history_source(&params.id, &agent);
        let events = tail(read_history(&params.id, &from, &agent, None), params.limit.unwrap_or(DEFAULT_TAIL_LIMIT));
        serde_json::to_value(events).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
    }

    fn caller(&self, principal: &Principal) -> Result<Value, RpcError> {
        let caller = match principal {
            Principal::Local => None,
            Principal::Session(caller) => Some(caller),
        };
        Ok(json!({ "caller": caller, "identity": self.identity(principal) }))
    }

    fn session_steer(&self, principal: &Principal, params: SteerParams) -> Result<Value, RpcError> {
        let host = &self.app.state::<ChatState>().0;
        if !host.is_live(&params.id) {
            let terminal = self.states.snapshot().contains_key(&params.id) || self.live().contains_key(&params.id);
            let message = match terminal {
                true => format!("{} is a terminal session: steer reaches chat sessions only", params.id),
                false => format!("no live session {}", params.id),
            };
            return Err(RpcError::new(INVALID_PARAMS, message));
        }
        // A session waiting on a prompt is still inside its turn.
        let mid_turn = matches!(self.states.snapshot().get(&params.id), Some(SessionState::Working | SessionState::NeedsYou));
        let by = match principal {
            Principal::Local => TurnBy::Local,
            Principal::Session(Caller::Chat(id)) => TurnBy::Session(id.clone()),
            Principal::Session(Caller::Terminal(tab)) => TurnBy::Tab(tab.clone()),
        };
        host.deliver(&params.id, vec![ContentBlock::Text { text: params.text }], mid_turn, by).map_err(refused)?;
        Ok(json!({ "delivered": if mid_turn { "steer" } else { "send" } }))
    }

    fn worktree_new(&self, principal: &Principal, params: WorktreeParams) -> Result<Value, RpcError> {
        Ok(json!({ "path": self.create_worktree(principal, params)? }))
    }

    fn checkpoints_list(&self, params: CheckpointsParams) -> Result<Value, RpcError> {
        let cwd = self.session_cwd(&params.id)?;
        let list = crate::checkpoint::checkpoint_list(cwd, params.id).map_err(refused)?;
        let numbered = list.into_iter().enumerate().map(|(i, entry)| {
            let mut row = serde_json::to_value(entry).unwrap_or_default();
            row["turn"] = json!(i + 1);
            row
        });
        Ok(Value::Array(numbered.collect()))
    }

    fn checkpoint_diff(&self, params: CheckpointParams) -> Result<Value, RpcError> {
        let (cwd, ts) = self.checkpoint(&params.id, params.turn)?;
        let files = crate::checkpoint::checkpoint_turn_files(cwd.clone(), params.id.clone(), ts, None, None).map_err(refused)?;
        let mut diff = String::new();
        for file in &files {
            let one = crate::checkpoint::checkpoint_diff_file(cwd.clone(), params.id.clone(), ts, file.path.clone(), None)
                .map_err(refused)?;
            diff.push_str(&one);
        }
        Ok(json!({ "files": files, "diff": diff }))
    }

    fn checkpoint_revert(&self, principal: &Principal, params: CheckpointParams) -> Result<Value, RpcError> {
        let (cwd, ts) = self.checkpoint(&params.id, params.turn)?;
        let others = self.others_in(&cwd, &params.id, principal);
        if !others.is_empty() && !params.force.unwrap_or(false) {
            let message = format!("other live sessions in {cwd}: {}. Pass --force to revert anyway", others.join(", "));
            return Err(refused(message));
        }
        let revert = crate::checkpoint::checkpoint_revert_tree(cwd, params.id, ts, None);
        let outcome = tauri::async_runtime::block_on(revert).map_err(refused)?;
        serde_json::to_value(outcome).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
    }

    fn session_spawn(&self, principal: &Principal, params: SpawnParams) -> Result<Value, RpcError> {
        let me = self.identity(principal);
        let attach = params.attach.unwrap_or_default();
        if let Some(missing) = attach.iter().find(|path| !Path::new(path).is_file()) {
            return Err(RpcError::new(INVALID_PARAMS, format!("no file {missing}")));
        }
        let folder = match params.new_worktree {
            Some(branch) => {
                self.create_worktree(principal, WorktreeParams { branch, project: params.project, from: params.from })?
            }
            None => or_callers(params.folder, || me.cwd.clone(), "folder")?,
        };
        // Left out, the webview picks the folder's remembered agent and account.
        // The caller's account only carries over to the caller's own agent.
        let agent = params.agent.or(me.agent.clone());
        let account = params.account.or_else(|| if agent == me.agent { me.account } else { None });
        let request = json!({ "folder": folder, "agent": agent, "account": account, "prompt": params.prompt, "attach": attach });
        let mut spawned = self.bridge.request("session.spawn", request)?;
        let background = params.background.unwrap_or(false);
        if let Some(id) = spawned["id"].as_str().filter(|_| background) {
            self.states.mark_background(id);
        }
        spawned["background"] = json!(background);
        Ok(spawned)
    }

    fn window_open(&self, params: OpenParams) -> Result<Value, RpcError> {
        if !Path::new(&params.path).is_file() {
            return Err(RpcError::new(INVALID_PARAMS, format!("no file {}", params.path)));
        }
        self.bridge.request("window.open", json!({ "path": params.path, "line": params.line }))
    }

    fn budget(&self, principal: &Principal, params: BudgetParams) -> Result<Value, RpcError> {
        let me = self.identity(principal);
        let id = params.id.or_else(|| match principal {
            Principal::Session(Caller::Chat(id)) => Some(id.clone()),
            _ => None,
        });
        let folder = match (params.folder, &id) {
            (Some(folder), _) => folder,
            (None, Some(id)) => self.session_cwd(id)?,
            (None, None) => or_callers(None, || me.cwd.clone(), "folder")?,
        };
        let file = crate::chat::usage::load(&crate::chat::usage::usage_path(&folder));
        let session = id.as_ref().map(|id| file.sessions.get(id).cloned().unwrap_or_default());
        let (agent, account) = match &id {
            Some(id) => (self.agent_of(id), self.app.state::<ChatState>().0.registry.profile_of(id)),
            None => (me.agent, me.account),
        };
        let quota = match &agent {
            Some(agent) => self.bridge.request("usage.windows", json!({ "agent": agent, "account": account }))?,
            None => Value::Null,
        };
        Ok(json!({
            "id": id,
            "folder": folder,
            "session": session,
            "project": crate::chat::usage::project_total(&file),
            "budgets": crate::settings::get_settings().budgets,
            "agent": agent,
            "account": account,
            "quota": quota,
        }))
    }

    fn ask_create(&self, principal: &Principal, params: AskParams) -> Result<Value, RpcError> {
        let Principal::Session(Caller::Chat(session)) = principal else {
            return Err(refused("ask shows its card in a chat panel, so only a chat's shell can ask for now".into()));
        };
        let ask = self.asks.create(session.clone(), params.question, params.options.unwrap_or_default());
        if let Err(e) = self.bridge.request("ask.show", json!(ask)) {
            self.asks.forget(&ask.id);
            return Err(e);
        }
        self.app.state::<ChatState>().0.publish(
            session,
            "session.question",
            json!({
                "ask_id": ask.id,
                "questions": [{
                    "question": ask.question,
                    "options": ask.options.iter().map(|label| json!({ "label": label })).collect::<Vec<_>>(),
                }],
            }),
        );
        self.wait_for_answer(&ask.id, params.timeout)
    }

    fn ask_wait(&self, params: AskWaitParams) -> Result<Value, RpcError> {
        self.wait_for_answer(&params.id, params.timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::commands::HistorySource;
    use serde_json::json;

    fn claim(agent: &str, profile: &str) -> crate::chat::ownership::Claim {
        crate::chat::ownership::Claim {
            surface: crate::chat::ownership::Surface::Chat,
            tab_id: "tab".into(),
            child_pid: None,
            tori_pid: std::process::id(),
            agent: agent.into(),
            profile: profile.into(),
        }
    }

    #[test]
    fn a_caller_tori_did_not_start_has_no_project_and_is_told_the_flag() {
        let local = Identity::default();
        let err = or_callers(None, || local.cwd.clone(), "project").unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
        assert!(err.message.contains("--project"), "{}", err.message);
        assert_eq!(or_callers(Some("/p".into()), || local.cwd.clone(), "project").ok().as_deref(), Some("/p"));
    }

    #[test]
    fn a_chat_caller_resolves_to_its_claimed_agent_account_and_live_folder() {
        let dir = std::env::temp_dir().join(format!("tori-rpc-identity-{}", std::process::id()));
        let registry = Registry::at(dir.join("claims.json"));
        registry.claim("s1", claim("codex", "work"));
        let live = vec![("s1".to_string(), "/p/wt".to_string())];
        assert_eq!(
            chat_identity(&registry, &live, "s1"),
            Identity { agent: Some("codex".into()), account: Some("work".into()), cwd: Some("/p/wt".into()) }
        );
        assert_eq!(chat_identity(&registry, &live, "gone"), Identity::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn meta(id: &str, cwd: &str, last_active: u64) -> SessionMeta {
        SessionMeta { last_active, ..live_row(id, &Live { agent: "claude".into(), cwd: cwd.into() }, last_active) }
    }

    fn ids(rows: &[Value]) -> Vec<&str> {
        rows.iter().map(|r| r["id"].as_str().unwrap()).collect()
    }

    fn live(entries: &[(&str, &str)]) -> BTreeMap<String, Live> {
        entries.iter().map(|(id, cwd)| (id.to_string(), Live { agent: "codex".into(), cwd: cwd.to_string() })).collect()
    }

    #[test]
    fn rows_are_stamped_live_and_a_live_session_not_yet_indexed_comes_first() {
        let indexed = vec![meta("a", "/p", 30), meta("b", "/p", 20)];
        let rows = list(indexed, &live(&[("b", "/p"), ("new", "/p/wt")]), &HashMap::new(), &ListParams::default(), 99);
        assert_eq!(ids(&rows), ["new", "a", "b"]);
        assert_eq!(rows.iter().map(|r| r["live"].as_bool().unwrap()).collect::<Vec<_>>(), [true, false, true]);
        assert_eq!((rows[0]["agent"].clone(), rows[0]["cwd"].clone()), (json!("codex"), json!("/p/wt")));
    }

    #[test]
    fn live_only_limit_and_cwd_narrow_the_list() {
        let indexed = vec![meta("a", "/p", 30), meta("b", "/p", 20)];
        let only_live = ListParams { live: Some(true), ..Default::default() };
        assert_eq!(ids(&list(indexed.clone(), &live(&[("b", "/p")]), &HashMap::new(), &only_live, 99)), ["b"]);

        let one = ListParams { limit: Some(1), ..Default::default() };
        assert_eq!(ids(&list(indexed.clone(), &live(&[]), &HashMap::new(), &one, 99)), ["a"]);

        // The indexed rows arrive already narrowed; the fresh live ones are narrowed here.
        let under = ListParams { cwd: Some("/p".into()), ..Default::default() };
        assert_eq!(ids(&list(indexed, &live(&[("x", "/elsewhere"), ("y", "/p/sub")]), &HashMap::new(), &under, 99)), ["y", "a", "b"]);
    }

    fn fixture(name: &str) -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/fixtures/sessions")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn a_transcript_tail_is_the_last_events_in_order() {
        let from = HistorySource::Transcript(fixture("subagent-foreground.jsonl"));
        let all = read_history("s1", &from, "claude", None);
        assert!(all.len() > 2, "the fixture has more than the tail: {}", all.len());
        let last = tail(all.clone(), 2);
        assert_eq!(serde_json::to_value(&last).unwrap(), serde_json::to_value(&all[all.len() - 2..]).unwrap());
        assert_eq!(tail(all.clone(), 10_000).len(), all.len());
    }

    #[test]
    fn a_log_tail_is_the_last_events_in_order() {
        let path = std::env::temp_dir().join(format!("tori-rpc-tail-{}-{:?}.jsonl", std::process::id(), std::thread::current().id()));
        let lines: Vec<String> = ["one", "two", "three"]
            .iter()
            .map(|t| {
                serde_json::to_string(&ChatEvent::UserMessage {
                    session_id: "s1".into(),
                    turn_id: "t1".into(),
                    blocks: vec![crate::chat::model::ContentBlock::Text { text: t.to_string() }],
                })
                .unwrap()
            })
            .collect();
        std::fs::write(&path, lines.join("\n")).unwrap();
        let got = tail(read_history("s1", &HistorySource::Log(path.clone()), "codex", None), 2);
        let _ = std::fs::remove_file(&path);
        let texts: Vec<String> = got.iter().map(|e| serde_json::to_value(e).unwrap()["blocks"][0]["text"].as_str().unwrap().to_string()).collect();
        assert_eq!(texts, ["two", "three"]);
    }

    #[test]
    fn an_unknown_session_tails_to_nothing() {
        assert!(read_history("nope", &HistorySource::Missing, "claude", None).is_empty());
        let missing = std::env::temp_dir().join("tori-rpc-tail-missing.jsonl");
        assert!(read_history("nope", &HistorySource::Log(missing), "codex", None).is_empty());
    }
}
