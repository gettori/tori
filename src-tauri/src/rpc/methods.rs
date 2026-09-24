//! `sessions.list` and `session.tail`, read from the same stores the sidebar and
//! the chat panel read.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::approvals::{Approval, Approvals, Draft};
use super::asks::{Ask, Asks, By, NotAnswered, Waited};
use super::auth::{Caller, Principal};
use super::bridge::Bridge;
use super::events::{project_of, same_folder, TurnBy};
use super::frame::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, REFUSED};
use super::server::{
    AskAnswerParams, AskParams, AskWaitParams, Backend, BudgetParams, CheckpointDiffParams, CheckpointParams, CheckpointsParams, HoldResolveParams, IssueGetParams, PendingParams, SessionAnswerParams,
    IssuesAssignedParams, ItemUpdateParams, LinkBranchParams, ProjectSetParams, ListParams, OpenParams, PrCreateParams, PrMergeParams, ReviewSubmitParams, SpawnParams,
    SteerParams, TailParams, WaitParams, WorktreeParams,
};
use super::states::{SessionState, SessionStates};
use super::table::CallerKind;
use crate::autopilot::{AutopilotStore, Contract, Observed};
use crate::issues::Issue;
use crate::chat::commands::{history_source, read_history};
use crate::chat::host::{ChatState, Waiting};
use crate::chat::model::{cap_output, ChatEvent, ContentBlock};
use crate::chat::ownership::Registry;
use crate::sessions::{cwd_matches, listed_sessions, SessionIndex, SessionMeta};

const DEFAULT_LIST_LIMIT: usize = 50;
const DEFAULT_TAIL_LIMIT: usize = 50;
const DEFAULT_ASK_WAIT: u64 = 60;
const DEFAULT_SESSION_WAIT: u64 = 60;

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

/// The main agent's text from the latest turn that has any, whole.
fn last_assistant_text(events: &[ChatEvent]) -> Option<String> {
    let main = |event: &ChatEvent| match event {
        ChatEvent::TextDelta { turn_id, text, agent_id: None, .. } => Some((turn_id.clone(), text.clone())),
        _ => None,
    };
    let (last_turn, _) = events.iter().rev().find_map(main)?;
    let text: String = events.iter().filter_map(main).filter(|(turn, _)| *turn == last_turn).map(|(_, text)| text).collect();
    Some(text)
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

fn spawns_background(states: &SessionStates, principal: &Principal, asked: bool) -> bool {
    asked || matches!(principal, Principal::Session(Caller::Chat(spawner)) if states.is_background(spawner))
}

fn record_spawn(states: &SessionStates, principal: &Principal, id: &str, background: bool) {
    if background {
        states.mark_background(id);
    }
    if let Principal::Session(Caller::Chat(spawner)) = principal {
        states.mark_worker(id, spawner);
    }
}

fn pending_rows(session: &str, asks: Vec<Ask>, native: Vec<Waiting>) -> Vec<Value> {
    let asks = asks.into_iter().filter(|ask| ask.session == session);
    let mut rows: Vec<Value> =
        asks.map(|ask| json!({ "kind": "ask", "id": ask.id, "text": ask.question, "options": ask.options })).collect();
    rows.extend(native.into_iter().filter_map(|waiting| serde_json::to_value(waiting).ok()));
    rows
}

fn answers_for(caller: &Principal, spawner: Option<String>, session: &str) -> Result<(), RpcError> {
    match (caller, spawner) {
        (Principal::Session(Caller::Chat(caller)), Some(spawner)) if *caller == spawner => Ok(()),
        _ => Err(refused(format!("only the session that spawned {session} answers for it"))),
    }
}

#[derive(Debug, Default, PartialEq)]
struct Picks {
    agent: Option<String>,
    account: Option<String>,
    model: Option<String>,
}

// A contract's account and model belong to its agent, so they fill in only when
// the session runs that agent, or the contract names none.
fn fill_picks(given: Picks, contract: Option<&Contract>, me: &Identity) -> Picks {
    let empty = Contract::default();
    let contract = contract.unwrap_or(&empty);
    let agent = given.agent.or_else(|| contract.agent.clone()).or_else(|| me.agent.clone());
    let contract_applies = contract.agent.is_none() || contract.agent == agent;
    let account = given
        .account
        .or_else(|| contract_applies.then(|| contract.account.clone()).flatten())
        .or_else(|| if agent == me.agent { me.account.clone() } else { None });
    let model = given.model.or_else(|| contract_applies.then(|| contract.model.clone()).flatten());
    Picks { agent, account, model }
}

fn refused(message: String) -> RpcError {
    RpcError::new(REFUSED, message)
}

fn forge_refused(e: crate::forge::ForgeError) -> RpcError {
    refused(e.to_string())
}

fn gated_by_approval(
    approvals: &Approvals,
    background: Option<&str>,
    wanted: &Approval,
    approval_id: Option<&str>,
    call: impl FnOnce() -> Result<Value, RpcError>,
) -> Result<Value, RpcError> {
    let Some(session) = background else { return call() };
    let id = approvals.reserve(approval_id, session, wanted).map_err(|why| {
        let action = wanted.draft.action();
        refused(format!(
            "{action} from a background session needs an approval for {} in {}: {why}. Call ask_create (`tori ask \
             --approval` from a shell) with `approval` set to this action and its exact draft, then pass the approval_id \
             an Approve answer returns",
            wanted.draft.target(),
            wanted.project
        ))
    })?;
    let outcome = call();
    // Kept when the call fails: a refusal from the host changed nothing, so it should not cost a second approval.
    match outcome {
        Ok(_) => approvals.spend(&id),
        Err(_) => approvals.release(&id),
    }
    outcome
}

fn to_json<T: Serialize>(value: T) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
}

pub struct TauriBackend {
    pub app: AppHandle,
    pub states: Arc<SessionStates>,
    pub bridge: Arc<Bridge>,
    pub asks: Arc<Asks>,
    pub autopilot: Arc<AutopilotStore>,
    pub runner: Arc<super::runner::Runner>,
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

    fn project(&self, principal: &Principal, given: Option<String>) -> Result<String, RpcError> {
        let callers =
            || self.identity(principal).cwd.and_then(|cwd| project_of(&cwd, &crate::config::discovered_project_dirs()));
        or_callers(given, callers, "project")
    }

    fn create_worktree(&self, principal: &Principal, params: WorktreeParams) -> Result<String, RpcError> {
        let project = self.project(principal, params.project)?;
        let create = crate::worktree::create_worktree(self.app.clone(), project, params.branch, params.from);
        tauri::async_runtime::block_on(create).map_err(refused)
    }

    fn remember_issue(&self, project: &str, branch: &str, issue: &Issue, path: &str) -> Result<(), RpcError> {
        crate::issues::store::record(project, branch, issue.into())
            .map_err(|e| refused(format!("the worktree is at {path}, but remembering its issue failed: {e}")))?;
        let _ = self.app.emit("config://changed", ());
        Ok(())
    }

    fn wait_for_answer(&self, id: &str, timeout: Option<u64>) -> Result<Value, RpcError> {
        match self.asks.wait(id, std::time::Duration::from_secs(timeout.unwrap_or(DEFAULT_ASK_WAIT))) {
            Waited::Answered { answer, approval_id: None } => Ok(json!({ "id": id, "answer": answer })),
            Waited::Answered { answer, approval_id: Some(approval_id) } => {
                Ok(json!({ "id": id, "answer": answer, "approval_id": approval_id }))
            }
            Waited::Pending => Ok(json!({ "id": id, "answer": null })),
            Waited::Unknown => Err(RpcError::new(INVALID_PARAMS, format!("no ask {id}, or its answer was already read"))),
        }
    }

    fn background_session<'a>(&self, principal: &'a Principal) -> Option<&'a str> {
        match principal {
            Principal::Session(Caller::Chat(id)) if self.states.is_background(id) => Some(id),
            _ => None,
        }
    }

    fn gated_outward(
        &self,
        principal: &Principal,
        project: Option<String>,
        draft: Draft,
        approval_id: Option<&str>,
        call: impl FnOnce(&str) -> Result<Value, RpcError>,
    ) -> Result<Value, RpcError> {
        let wanted = Approval { project: self.project(principal, project)?, draft };
        gated_by_approval(&self.asks.approvals, self.background_session(principal), &wanted, approval_id, || call(&wanted.project))
    }

    fn agent_of(&self, id: &str) -> Option<String> {
        if let Some(live) = self.live().remove(id).filter(|l| !l.agent.is_empty()) {
            return Some(live.agent);
        }
        listed_sessions(&self.app.state::<SessionIndex>(), None).into_iter().find(|m| m.id == id).map(|m| m.agent)
    }
}

impl Backend for TauriBackend {
    fn kind(&self, principal: &Principal) -> CallerKind {
        match principal {
            Principal::Session(Caller::Chat(id)) if self.states.is_worker(id) => CallerKind::Worker,
            other => CallerKind::of(other),
        }
    }

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

    fn session_wait(&self, params: WaitParams) -> Result<Value, RpcError> {
        let host = &self.app.state::<ChatState>().0;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(params.timeout.unwrap_or(DEFAULT_SESSION_WAIT));
        let state = loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match self.states.wait_settled(&params.id, left) {
                Some(state) => break state,
                // Live but not yet in the webview's first report after its spawn.
                None if host.is_live(&params.id) && !left.is_zero() => std::thread::sleep(std::time::Duration::from_millis(200)),
                None if host.is_live(&params.id) => break SessionState::Working,
                None => return Err(RpcError::new(INVALID_PARAMS, format!("no live session {}", params.id))),
            }
        };
        let last = self.agent_of(&params.id).and_then(|agent| {
            let from = history_source(&params.id, &agent);
            last_assistant_text(&read_history(&params.id, &from, &agent, None))
        });
        Ok(json!({ "id": params.id, "state": state, "question": self.asks.pending_for(&params.id), "last": last }))
    }

    fn session_pending(&self, params: PendingParams) -> Result<Value, RpcError> {
        let native = self.app.state::<ChatState>().0.waiting(&params.id);
        Ok(Value::Array(pending_rows(&params.id, self.asks.pending(), native)))
    }

    fn session_answer(&self, principal: &Principal, params: SessionAnswerParams) -> Result<Value, RpcError> {
        // A retired autopilot id stands for the current one.
        let spawner = self.states.spawner_of(&params.session).map(|s| super::current_spawner(&s));
        answers_for(principal, spawner, &params.session)?;
        let host = &self.app.state::<ChatState>().0;
        host.settle(&params.session, &params.id, &params.answer.into_list()).map_err(|e| RpcError::new(INVALID_PARAMS, e))?;
        Ok(json!({ "answered": params.id }))
    }

    fn worktree_new(&self, principal: &Principal, params: WorktreeParams) -> Result<Value, RpcError> {
        let project = self.project(principal, params.project)?;
        // Asked before the worktree exists, so a bad key leaves nothing behind.
        let issue = params.issue.map(|key| crate::issues::commands::get(&project, &key)).transpose().map_err(forge_refused)?;
        let branch = params.branch.trim().to_string();
        let created = WorktreeParams { branch: branch.clone(), project: Some(project.clone()), from: params.from, issue: None };
        let path = self.create_worktree(principal, created)?;
        if let Some(issue) = issue {
            self.remember_issue(&project, &branch, &issue, &path)?;
        }
        Ok(json!({ "path": path }))
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

    fn checkpoint_diff(&self, params: CheckpointDiffParams) -> Result<Value, RpcError> {
        let (cwd, ts) = self.checkpoint(&params.id, params.turn)?;
        if let Some(to) = params.to.filter(|to| *to != params.turn) {
            let (_, to_ts) = self.checkpoint(&params.id, to)?;
            let (files, diff) = crate::checkpoint::checkpoint_range_diff(&cwd, &params.id, ts, to_ts).map_err(refused)?;
            return Ok(json!({ "files": files, "diff": diff }));
        }
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
                self.create_worktree(principal, WorktreeParams { branch, project: params.project.clone(), from: params.from, issue: None })?
            }
            None => or_callers(params.folder, || me.cwd.clone(), "folder")?,
        };
        // Left out everywhere, the webview picks the folder's remembered agent and account.
        let project = params.project.or_else(|| project_of(&folder, &crate::config::discovered_project_dirs()));
        let contract = project.and_then(|project| self.autopilot.contract(&project));
        let given = Picks { agent: params.agent, account: params.account, model: params.model };
        let Picks { agent, account, model } = fill_picks(given, contract.as_ref(), &me);
        let background = spawns_background(&self.states, principal, params.background.unwrap_or(false));
        let request = json!({
            "folder": folder,
            "agent": agent,
            "account": account,
            "model": model,
            "effort": params.effort,
            "prompt": params.prompt,
            "attach": attach,
            "background": background,
            "spawner": match principal {
                Principal::Session(Caller::Chat(spawner)) if background => Some(spawner.clone()),
                _ => None,
            },
        });
        let mut spawned = self.bridge.request("session.spawn", request)?;
        if let Some(id) = spawned["id"].as_str() {
            record_spawn(&self.states, principal, id, background);
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

    fn ask_create(&self, session: &str, params: AskParams) -> Result<Value, RpcError> {
        let principal = Principal::Session(Caller::Chat(session.to_string()));
        let approval = match params.approval {
            Some(draft) => Some(Approval { project: self.project(&principal, params.project)?, draft }),
            None => None,
        };
        if let Some(item) = &params.item {
            if approval.is_none() {
                return Err(RpcError::new(INVALID_PARAMS, "item goes with an approval: only an approval holds an item up"));
            }
            if !self.autopilot.has(item) {
                return Err(RpcError::new(INVALID_PARAMS, format!("no autopilot item {item}")));
            }
        }
        let mirror = self.states.root_background(session);
        let ask = self.asks.create(session.to_string(), params.question, params.options.unwrap_or_default(), approval, mirror, params.item);
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

    fn ask_answer(&self, params: AskAnswerParams) -> Result<Value, RpcError> {
        match self.asks.answer(&params.id, params.answer, By::Socket) {
            Ok(()) => {}
            Err(NotAnswered::Unknown) => {
                return Err(RpcError::new(INVALID_PARAMS, format!("no ask {}, or it was already answered", params.id)))
            }
            Err(NotAnswered::UsersOnly) => {
                return Err(refused(format!("{} asks for an approval, which only the user gives, on its card in Tori", params.id)))
            }
        }
        let _ = self.bridge.request("ask.close", json!({ "id": params.id }));
        Ok(json!({}))
    }

    fn issues_assigned(&self, principal: &Principal, params: IssuesAssignedParams) -> Result<Value, RpcError> {
        let project = self.project(principal, params.project)?;
        to_json(crate::issues::commands::assigned(&project, params.refresh.unwrap_or(false)).map_err(forge_refused)?)
    }

    fn issue_get(&self, principal: &Principal, params: IssueGetParams) -> Result<Value, RpcError> {
        let project = self.project(principal, params.project)?;
        to_json(crate::issues::commands::get(&project, &params.key).map_err(forge_refused)?)
    }

    fn issue_link_branch(&self, principal: &Principal, params: LinkBranchParams) -> Result<Value, RpcError> {
        let project = self.project(principal, params.project)?;
        let branch = params.branch.trim();
        let outcome = crate::issues::commands::link(&project, &params.key, branch, params.base.as_deref())
            .map_err(forge_refused)?;
        Ok(json!({ "branch": branch, "outcome": outcome }))
    }

    fn pr_create(&self, principal: &Principal, params: PrCreateParams) -> Result<Value, RpcError> {
        let draft = params.draft();
        let req = crate::forge::CreatePr {
            title: params.title,
            body: params.body,
            head: params.head,
            base: params.base,
            draft: params.draft.unwrap_or(false),
        };
        self.gated_outward(principal, params.project, draft, params.approval_id.as_deref(), |project| {
            to_json(crate::forge::commands::create_pr(project, &req).map_err(forge_refused)?)
        })
    }

    fn review_submit(&self, principal: &Principal, params: ReviewSubmitParams) -> Result<Value, RpcError> {
        let draft = params.draft();
        let comments = params.comments.unwrap_or_default();
        self.gated_outward(principal, params.project, draft, params.approval_id.as_deref(), |project| {
            crate::forge::commands::submit_review(project, params.number, params.event, &params.body, &comments)
                .map_err(forge_refused)?;
            Ok(json!({}))
        })
    }

    fn pr_merge(&self, principal: &Principal, params: PrMergeParams) -> Result<Value, RpcError> {
        let draft = params.draft();
        self.gated_outward(principal, params.project, draft, params.approval_id.as_deref(), |project| {
            crate::forge::commands::merge(project, params.number, params.method, Some(&params.head_sha)).map_err(forge_refused)?;
            Ok(json!({}))
        })
    }

    fn autopilot_state(&self) -> Result<Value, RpcError> {
        let mut state = super::server::autopilot_state(&self.autopilot, self.asks.holds(), |items| {
            let reported = self.states.snapshot().into_iter().filter(|(_, state)| *state != SessionState::Ended).map(|(id, _)| id);
            let chats = self.app.state::<ChatState>().0.live_sessions().into_iter().map(|(id, _)| id);
            let prs = crate::autopilot::open_prs(items)
                .into_iter()
                .filter_map(|(project, numbers)| {
                    let fetch = |numbers: &[u64]| crate::forge::commands::pull_request_states(&project, numbers);
                    let states = self.autopilot.pr_states.get(&project, &numbers, fetch)?;
                    Some((project, states))
                })
                .collect();
            Observed { live: reported.chain(chats).collect(), worktrees: crate::autopilot::list_worktrees(items), prs }
        })?;
        state["runner"] = json!(self.runner.status());
        Ok(state)
    }

    fn autopilot_item_update(&self, principal: &Principal, params: ItemUpdateParams) -> Result<Value, RpcError> {
        let project = match params.id {
            Some(_) => params.project.clone(),
            None => Some(self.project(principal, params.project.clone())?),
        };
        params.apply(&self.autopilot, project)
    }

    fn autopilot_project_set(&self, principal: &Principal, params: ProjectSetParams) -> Result<Value, RpcError> {
        let project = self.project(principal, params.project.clone())?;
        params.apply(&self.autopilot, project)
    }

    fn autopilot_hold_resolve(&self, params: HoldResolveParams) -> Result<Value, RpcError> {
        let resolved = super::server::hold_resolve(&self.asks, &params.id)?;
        let _ = self.bridge.request("ask.close", json!({ "id": params.id }));
        Ok(resolved)
    }

    fn autopilot_start(&self) -> Result<Value, RpcError> {
        let status = self.runner.start().map_err(refused)?;
        Ok(json!(status))
    }

    fn autopilot_stop(&self) -> Result<Value, RpcError> {
        let status = self.runner.stop().map_err(refused)?;
        Ok(json!(status))
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

    fn delta(turn: &str, text: &str, agent_id: Option<&str>) -> ChatEvent {
        ChatEvent::TextDelta { session_id: "s1".into(), turn_id: turn.into(), text: text.into(), agent_id: agent_id.map(String::from) }
    }

    #[test]
    fn the_last_message_is_the_latest_turns_main_agent_text_joined() {
        let events = vec![
            delta("t1", "first ", None),
            delta("t1", "answer", None),
            delta("t2", "sec", None),
            delta("t2", "ond", None),
            delta("t2", "a subagent's aside", Some("sub-1")),
        ];
        assert_eq!(last_assistant_text(&events).as_deref(), Some("second"));
        assert_eq!(last_assistant_text(&[delta("t3", "only a subagent", Some("sub-1"))]), None);
        assert_eq!(last_assistant_text(&[]), None);
    }

    #[test]
    fn a_background_session_spawns_background_children_whatever_they_ask() {
        let states = SessionStates::default();
        states.mark_background("autopilot");
        let autopilot = Principal::Session(Caller::Chat("autopilot".into()));
        assert!(spawns_background(&states, &autopilot, false));
        record_spawn(&states, &autopilot, "worker", spawns_background(&states, &autopilot, false));
        assert!(states.is_background("worker") && states.is_worker("worker"));
        let foreground = Principal::Session(Caller::Chat("mine".into()));
        assert!(!spawns_background(&states, &foreground, false));
        assert!(spawns_background(&states, &foreground, true));
        assert!(!spawns_background(&states, &Principal::Local, false));
    }

    #[test]
    fn only_a_spawn_by_a_chat_makes_a_worker() {
        let states = SessionStates::default();
        record_spawn(&states, &Principal::Session(Caller::Chat("boss".into())), "by-chat", false);
        record_spawn(&states, &Principal::Session(Caller::Terminal("t1".into())), "by-tab", true);
        record_spawn(&states, &Principal::Local, "by-local", false);
        assert!(states.is_worker("by-chat"));
        assert!(!states.is_worker("by-tab") && !states.is_worker("by-local"));
        assert!(states.background().contains("by-tab"));
    }

    fn pr_draft() -> Approval {
        Approval {
            project: "/p".into(),
            draft: Draft::PrCreate { head: "1-x".into(), base: "main".into(), title: "T".into(), body: "B".into(), draft: false },
        }
    }

    fn opened() -> Result<Value, RpcError> {
        Ok(json!({ "number": 12 }))
    }

    #[test]
    fn a_background_pr_create_without_an_approval_is_refused_naming_what_it_needs() {
        let approvals = Approvals::default();
        let ran = std::cell::Cell::new(false);
        let err = gated_by_approval(&approvals, Some("s1"), &pr_draft(), None, || {
            ran.set(true);
            opened()
        })
        .unwrap_err();
        assert_eq!(err.code, REFUSED);
        for named in ["pr.create", "a pull request from 1-x into main", "/p", "no approval_id", "ask_create"] {
            assert!(err.message.contains(named), "{named} missing from: {}", err.message);
        }
        assert!(!ran.get(), "the forge is never reached");
    }

    #[test]
    fn a_background_pr_create_with_its_approval_reaches_the_forge_once() {
        let approvals = Approvals::default();
        let id = approvals.grant("s1", pr_draft());
        assert_eq!(gated_by_approval(&approvals, Some("s1"), &pr_draft(), Some(&id), opened).unwrap(), json!({ "number": 12 }));
        let again = gated_by_approval(&approvals, Some("s1"), &pr_draft(), Some(&id), opened).unwrap_err();
        assert!(again.message.contains("already spent"), "{}", again.message);
    }

    #[test]
    fn a_foreground_pr_create_reaches_the_forge_without_an_approval() {
        let approvals = Approvals::default();
        assert!(gated_by_approval(&approvals, None, &pr_draft(), None, opened).is_ok());
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

    #[test]
    fn pending_lists_a_tori_ask_a_native_question_and_a_permission_with_their_ids() {
        let ask = |id: &str, session: &str| Ask {
            id: id.into(),
            session: session.into(),
            question: "ship it?".into(),
            options: vec!["yes".into()],
            approval: None,
            shown_in: Vec::new(),
            item: None,
        };
        let question = crate::chat::model::ChatQuestion {
            question: "Which one?".into(),
            header: "Pick".into(),
            multi_select: false,
            options: Vec::new(),
        };
        let native = vec![
            Waiting::Question { id: "toolu_q".into(), request_id: "r1".into(), agent_id: None, questions: vec![question] },
            Waiting::Permission {
                id: "toolu_p".into(),
                request_id: "r2".into(),
                agent_id: None,
                tool: "Bash".into(),
                detail: Some("ls".into()),
            },
        ];
        let rows = pending_rows("w1", vec![ask("ask-1", "w1"), ask("ask-2", "other")], native);
        let kinds: Vec<(&str, &str)> = rows.iter().map(|r| (r["kind"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
        assert_eq!(kinds, [("ask", "ask-1"), ("question", "toolu_q"), ("permission", "toolu_p")]);
        assert_eq!(rows[0]["text"], "ship it?");
        assert_eq!(rows[2]["tool"], "Bash");
        assert!(rows[1].get("request_id").is_none(), "the host's request id stays inside: {}", rows[1]);
    }

    #[test]
    fn only_the_spawner_answers_for_a_worker() {
        let chat = |id: &str| Principal::Session(Caller::Chat(id.into()));
        assert!(answers_for(&chat("pilot"), Some("pilot".into()), "w1").is_ok());
        for (caller, spawner) in [(chat("other"), Some("pilot".into())), (chat("pilot"), None), (Principal::Local, Some("pilot".into()))] {
            let err = answers_for(&caller, spawner, "w1").unwrap_err();
            assert_eq!(err.code, REFUSED, "{}", err.message);
        }
    }

    #[test]
    fn spawn_picks_fill_from_the_contract_and_an_explicit_value_wins() {
        let me = Identity { agent: Some("claude".into()), account: Some("work".into()), cwd: None };
        let s = |v: &str| Some(v.to_string());
        let contract = Contract { agent: s("codex"), account: s("team"), model: s("gpt-5"), ..Default::default() };

        let filled = fill_picks(Picks::default(), Some(&contract), &me);
        assert_eq!(filled, Picks { agent: s("codex"), account: s("team"), model: s("gpt-5") });

        let explicit = Picks { agent: None, account: None, model: s("gpt-5-mini") };
        assert_eq!(fill_picks(explicit, Some(&contract), &me).model, s("gpt-5-mini"));

        let other_agent = Picks { agent: s("claude"), ..Default::default() };
        let filled = fill_picks(other_agent, Some(&contract), &me);
        assert_eq!(filled, Picks { agent: s("claude"), account: s("work"), model: None }, "codex's model is not claude's");

        let any_agent = Contract { model: s("opus"), ..Default::default() };
        assert_eq!(fill_picks(Picks::default(), Some(&any_agent), &me).model, s("opus"));

        assert_eq!(fill_picks(Picks::default(), None, &me), Picks { agent: s("claude"), account: s("work"), model: None });
    }
}
