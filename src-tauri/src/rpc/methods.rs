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
    AskAnswerParams, AskParams, AskWaitParams, Backend, TopicPromoteParams, Before, BudgetParams, HistoryParams, InfoParams, InterruptParams, LogParams, ModeParams, ModelParams, ProjectIconParams, UnitsGitParams, UnitsPrParams, UnitsSyncParams, DEFAULT_LOG_LIMIT, CheckpointDiffParams, CheckpointParams, CheckpointsParams, HoldResolveParams, IssueGetParams, MintParams, PendingParams, PrGetParams, SessionAnswerParams,
    IssuesAssignedParams, ItemUpdateParams, LinkBranchParams, ProjectSetParams, ListParams, OpenParams, PrCreateParams, PrMergeParams, ReviewSubmitParams, SpawnParams,
    SteerParams, TailParams, WaitParams, WorktreeParams,
};
use super::states::{SessionState, SessionStates};
use super::table::CallerKind;
use crate::autopilot::{AutopilotStore, Contract, Observed};
use crate::issues::Issue;
use crate::chat::commands::{history_source, read_history, read_with_prompts, HistorySource};
use crate::chat::host::{ChatState, Waiting};
use crate::chat::model::{cap_output, ChatEvent, ContentBlock, PermissionMode};
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
    cap_outputs(&mut tail);
    tail
}

fn cap_outputs(events: &mut [ChatEvent]) {
    for event in events {
        if let ChatEvent::ToolCallCompleted { output: Some(output), output_truncated, .. } = event {
            if let Some(cut) = cap_output(output) {
                *output = cut;
                *output_truncated = true;
            }
        }
    }
}

type Read = Arc<(Vec<ChatEvent>, Vec<(u64, usize)>)>;

// A client pages one session back a page at a time, so its last read is kept
// until the file under it changes rather than mapped again for every page.
static LAST_READ: std::sync::Mutex<Option<(String, Option<(std::time::SystemTime, u64)>, Read)>> = std::sync::Mutex::new(None);

fn read_cached(id: &str, from: &HistorySource, agent: &str) -> Read {
    let path = match from {
        HistorySource::Transcript(path) => Some(Path::new(path)),
        HistorySource::Log(path) => Some(path.as_path()),
        HistorySource::Missing => None,
    };
    let stamp = path.and_then(|p| std::fs::metadata(p).ok()).and_then(|m| Some((m.modified().ok()?, m.len())));
    let mut last = LAST_READ.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, _, read)) = last.as_ref().filter(|(at, was, _)| at == id && stamp.is_some() && *was == stamp) {
        return read.clone();
    }
    let read: Read = Arc::new(read_with_prompts(id, from, agent));
    *last = Some((id.to_string(), stamp, read.clone()));
    read
}

const DEFAULT_HISTORY_TURNS: usize = 10;
const PAGE_EVENTS: usize = 500;

/// One page of `total` events, as the range it covers and the cursor for the
/// page before it. `prompts` holds each prompt's timestamp and first event.
///
/// Whole turns while they fit, since a page that splits a turn can split a tool
/// call from its result. A turn bigger than a page is walked by event instead.
fn history_page(prompts: &[(u64, usize)], total: usize, before: Option<&Before>, limit: usize) -> (std::ops::Range<usize>, Option<Before>) {
    // Each turn as (its prompt's ts, first event); what precedes the first
    // prompt is a turn with no prompt. An empty one is dropped. A ts no later
    // than the one before is bumped past it, or a cursor could name two turns.
    let mut spans: Vec<(Option<u64>, usize)> = vec![(None, 0)];
    let mut latest = None;
    for &(ts, at) in prompts {
        if spans.last().is_some_and(|s| s.1 == at) {
            spans.pop();
        }
        let ts = latest.map_or(ts, |l: u64| ts.max(l + 1));
        latest = Some(ts);
        spans.push((Some(ts), at));
    }
    let end_of = |i: usize| spans.get(i + 1).map_or(total, |s| s.1);
    let before_span = |i: usize| spans[i].0.filter(|_| spans[i].1 > 0).map(Before::Turn);
    let span_of = |ts: Option<u64>| match ts {
        None => Some(0),
        Some(t) => spans.iter().position(|s| s.0.is_some_and(|ts| ts >= t)),
    };
    let walk = |i: usize, end: usize| {
        let start = spans[i].1.max(end.saturating_sub(PAGE_EVENTS));
        let next = match start > spans[i].1 {
            true => Some(Before::Event { ts: spans[i].0, event: start - spans[i].1 }),
            false => before_span(i),
        };
        (start..end, next)
    };

    let end = match before {
        Some(Before::Event { ts, event }) => {
            let Some(i) = span_of(*ts) else { return (0..0, None) };
            return walk(i, (spans[i].1 + event).min(end_of(i)));
        }
        Some(Before::Turn(ts)) => span_of(Some(*ts)).map_or(total, |i| spans[i].1),
        None => total,
    };
    let Some(last) = spans.iter().rposition(|s| s.1 < end) else { return (0..0, None) };
    let mut first = None;
    for i in (0..=last).rev().take(limit.max(1)) {
        if end - spans[i].1 > PAGE_EVENTS {
            break;
        }
        first = Some(i);
    }
    match first {
        Some(i) => (spans[i].1..end, before_span(i)),
        None => walk(last, end),
    }
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

// `https://<host>/<owner>/<name>/issues/<n>`, GitLab's `/-/issues/<n>`, or
// `<owner>/<name>#<n>`: the repo, lowercased, and the issue's key.
fn issue_ref(key: &str) -> Option<(String, String)> {
    web_ref(key, &["/issues/"])
}

fn pr_ref(key: &str) -> Option<(String, String)> {
    web_ref(key, &["/pull/", "/merge_requests/"])
}

fn web_ref(key: &str, kinds: &[&str]) -> Option<(String, String)> {
    let key = key.trim().trim_end_matches('/');
    let (repo, number) = match key.split_once('#') {
        Some((repo, number)) => (repo, number),
        None => {
            let (before, number) = kinds.iter().find_map(|kind| key.rsplit_once(kind))?;
            let before = before.strip_suffix("/-").unwrap_or(before);
            let path = before.split_once("://").map_or(before, |(_, path)| path);
            (path.split_once('/')?.1, number)
        }
    };
    number.parse::<u64>().ok()?;
    repo.contains('/').then(|| (repo.to_lowercase(), number.to_string()))
}

fn project_for_repo(repo: &str, dirs: &[std::path::PathBuf], origin: impl Fn(&str) -> Option<String>) -> Result<String, RpcError> {
    let matches: Vec<String> = dirs
        .iter()
        .map(|dir| dir.to_string_lossy().into_owned())
        .filter(|dir| {
            let parsed = origin(dir).and_then(|url| crate::forge::remote::parse(&url).ok());
            parsed.is_some_and(|r| format!("{}/{}", r.repo.owner, r.repo.repo).to_lowercase() == repo)
        })
        .collect();
    match matches.as_slice() {
        [one] => Ok(one.clone()),
        [] => Err(RpcError::new(INVALID_PARAMS, format!("no project here has {repo} as its origin: pass project"))),
        many => Err(RpcError::new(INVALID_PARAMS, format!("several projects have {repo} as their origin, pass one as project: {}", many.join(", ")))),
    }
}

// Only a device is a person on the socket; any other caller could be an agent
// approving its own post.
fn answered_by(principal: &Principal) -> By {
    match principal {
        Principal::Device(_) => By::Device,
        _ => By::Socket,
    }
}

// An ask lists wherever its card shows, so a worker's approval lists under its root too.
fn pending_rows(session: &str, asks: Vec<Ask>, native: Vec<Waiting>) -> Vec<Value> {
    let asks = asks.into_iter().filter(|ask| ask.session == session || ask.shown_in.iter().any(|s| s == session));
    let mut rows: Vec<Value> = asks
        .map(|ask| {
            let mut row = json!({ "kind": "ask", "id": ask.id, "session": ask.session, "text": ask.question, "options": ask.options });
            if let Some(approval) = ask.approval {
                row["approval"] = json!(approval);
            }
            row
        })
        .collect();
    rows.extend(native.into_iter().filter_map(|waiting| serde_json::to_value(waiting).ok()));
    rows
}

// Only the autopilot steers a session it has locked; a person stops it first.
fn may_steer(caller: &Principal, locked: bool, autopilot: Option<&str>) -> Result<(), RpcError> {
    match caller {
        _ if !locked => Ok(()),
        Principal::Session(Caller::Chat(id)) if Some(id.as_str()) == autopilot => Ok(()),
        _ => Err(refused(super::LOCKED.to_string())),
    }
}

// A chat's text arrives as a Tori note naming it; a person's, as typed.
fn steered(principal: &Principal, text: String) -> (TurnBy, String) {
    match principal {
        Principal::Local | Principal::Device(_) => (TurnBy::Local, text),
        Principal::Session(Caller::Chat(from)) => (TurnBy::Session(from.clone()), super::events::from_tori("steer", Some(from), &text)),
        Principal::Session(Caller::Terminal(tab)) => (TurnBy::Tab(tab.clone()), text),
    }
}

fn answers_for(caller: &Principal, spawner: Option<String>, session: &str) -> Result<(), RpcError> {
    match (caller, spawner) {
        (Principal::Session(Caller::Chat(caller)), Some(spawner)) if *caller == spawner => Ok(()),
        // A paired device is a person at the prompt, for any session.
        (Principal::Device(_), _) => Ok(()),
        _ => Err(refused(format!("only the session that spawned {session}, or a paired device, answers for it"))),
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

// A phone opens a plain chat in a folder it names: an attachment would read any
// file on the Mac, and a new worktree or a background run is the desktop's call.
fn device_may_spawn(params: &SpawnParams, is_chat: impl Fn(&str) -> bool) -> Result<(), RpcError> {
    let attaches = params.attach.as_ref().is_some_and(|files| !files.is_empty());
    if attaches || params.new_worktree.is_some() || params.background.unwrap_or(false) {
        return Err(refused("a device spawns a plain chat: attach, new_worktree and background are the desktop's".into()));
    }
    if params.folder.is_none() {
        return Err(RpcError::new(INVALID_PARAMS, "a device passes the folder to start in"));
    }
    match params.agent.as_deref() {
        Some(agent) if is_chat(agent) => Ok(()),
        _ => Err(refused("a device passes an agent that runs as a chat".into())),
    }
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

// A review that would not post as drawn is refused before its card shows, so
// an approval is never spent on a draft the host turns away.
fn postable(
    approval: &Approval,
    view_of: impl FnOnce(&str, u64) -> Result<crate::forge::pr_view::PrView, crate::forge::ForgeError>,
) -> Result<(), RpcError> {
    let Draft::ReviewSubmit { number, event, comments, head_sha, .. } = &approval.draft else { return Ok(()) };
    let view = view_of(&approval.project, *number).map_err(forge_refused)?;
    crate::forge::pr_view::check_review(&view, head_sha, *event, comments).map_err(|why| RpcError::new(INVALID_PARAMS, why))
}

// GitHub takes an older commit_id without complaint and anchors to it, so the
// refusal of a moved head is Tori's own; commit_id then covers the window after.
fn submit_pinned(
    number: u64,
    head_sha: &str,
    read_head: impl FnOnce() -> Result<String, crate::forge::ForgeError>,
    submit: impl FnOnce() -> Result<(), crate::forge::ForgeError>,
) -> Result<Value, RpcError> {
    let now = read_head().map_err(forge_refused)?;
    if now != head_sha {
        return Err(refused(format!("#{number} moved past {head_sha} to {now}, ask again")));
    }
    submit().map_err(forge_refused)?;
    Ok(json!({}))
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
    pub devices: Arc<super::devices::Devices>,
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
            Principal::Local | Principal::Device(_) => Identity::default(),
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

    // A question still open at the timeout is withdrawn: a late yes would
    // otherwise promote with nobody waiting on it.
    fn ask_for_worktree(&self, session: &str, question: &str, timeout: Option<u64>) -> Result<bool, String> {
        const YES: &str = "Create worktree";
        let params = AskParams {
            question: question.to_string(),
            options: Some(vec![YES.to_string(), "Not now".to_string()]),
            timeout,
            approval: None,
            project: None,
            item: None,
        };
        let answered = self.ask_create(session, params).map_err(|e| e.message)?;
        match answered["answer"].as_str() {
            Some(answer) => Ok(answer == YES),
            None => {
                let id = answered["id"].as_str().unwrap_or_default();
                self.asks.forget(id);
                let _ = self.bridge.request("ask.close", json!({ "id": id }));
                Err("The user has not answered yet. Carry on without changing that member, and ask again later.".into())
            }
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

    fn live_chat(&self, principal: &Principal, id: &str) -> Result<&crate::chat::host::ChatHost, RpcError> {
        let host = &self.app.state::<ChatState>().inner().0;
        if !host.is_live(id) {
            return Err(RpcError::new(INVALID_PARAMS, format!("no live chat session {id}")));
        }
        let locked = super::is_locked(&self.states, &self.autopilot, &self.runner, id);
        may_steer(principal, locked, self.runner.status().session.as_deref())?;
        Ok(host)
    }

    fn agent_of(&self, id: &str) -> Option<String> {
        if let Some(live) = self.live().remove(id).filter(|l| !l.agent.is_empty()) {
            return Some(live.agent);
        }
        listed_sessions(&self.app.state::<SessionIndex>(), None).into_iter().find(|m| m.id == id).map(|m| m.agent)
    }
}

/// The tree the sidebar draws, in the order it draws it: spaces in `space_order`
/// with their icon, colour, projects and branch units as resolved, then topics by
/// name with their members in `order`.
fn projects_tree(spaces: &[crate::config::Space], mut topics: Vec<crate::topics::Topic>) -> Value {
    let spaces: Vec<Value> = spaces
        .iter()
        .map(|space| {
            let projects: Vec<Value> = space
                .projects
                .iter()
                .map(|p| {
                    let units: Vec<Value> = p
                        .branch_units
                        .iter()
                        .map(|u| {
                            json!({
                                "label": u.label,
                                "folder": u.folder_path,
                                "branch": u.branch,
                                "kind": u.kind,
                                "isCurrent": u.is_current,
                                "issue": u.issue.as_ref().map(|i| &i.key),
                            })
                        })
                        .collect();
                    let image = crate::icons::shown_image(p.icon.as_deref(), p.icon_file.as_deref(), p.favicon.as_deref());
                    json!({
                        "name": p.name,
                        "path": p.path,
                        "icon": p.icon,
                        "image": image.and_then(crate::icons::image_version),
                        "units": units,
                    })
                })
                .collect();
            json!({ "name": space.name, "path": space.path, "icon": space.icon, "color": space.color, "projects": projects })
        })
        .collect();
    topics.sort_by_cached_key(|t| (t.name.to_lowercase(), t.name.clone()));
    for topic in &mut topics {
        topic.members.sort_by_key(|m| m.order);
    }
    json!({ "spaces": spaces, "topics": topics })
}

impl Backend for TauriBackend {
    fn watching_sessions(&self) {
        super::nudge_probe();
    }

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
        let (spaces, topics) = match rows.is_empty() {
            true => Default::default(),
            false => (crate::unit_home::spaces(&self.app.state::<crate::config::ProjectIndex>()), crate::unit_home::topics()),
        };
        super::refresh_dots_if_stale();
        let host = &self.app.state::<ChatState>().0;
        for row in &mut rows {
            if let Some(levers) = row["id"].as_str().and_then(|id| host.levers(id)) {
                row["model"] = json!(levers.model);
                row["permission_mode"] = json!(levers.mode);
            }
            let id = row["id"].as_str().unwrap_or_default();
            let (dot, certainty) = super::session_dot(id);
            row["attended"] = json!(super::session_attended(id, dot));
            row["dot"] = json!(dot);
            row["certainty"] = json!(certainty);
            let cwd = row["cwd"].as_str().unwrap_or_default();
            let branch = row["branch"].as_str().filter(|b| !b.is_empty());
            if let Some(home) = crate::unit_home::home_of(&spaces, &topics, cwd, branch) {
                row["home"] = json!(home);
            }
        }
        Ok(Value::Array(rows))
    }

    fn projects_list(&self) -> Result<Value, RpcError> {
        let config = crate::config::get_config_body(&self.app.state::<crate::config::ProjectIndex>())
            .map_err(|e| RpcError::new(INTERNAL_ERROR, e))?;
        let topics = crate::topics::list_topics(&crate::topics::Store::default_location());
        Ok(projects_tree(&config.spaces, topics))
    }

    fn project_icon(&self, params: ProjectIconParams) -> Result<Value, RpcError> {
        let spaces = crate::unit_home::spaces(&self.app.state::<crate::config::ProjectIndex>());
        let image = spaces
            .iter()
            .flat_map(|s| &s.projects)
            .find(|p| p.path == params.path)
            .and_then(|p| crate::icons::shown_image(p.icon.as_deref(), p.icon_file.as_deref(), p.favicon.as_deref()))
            .and_then(crate::icons::device_image);
        to_json(image)
    }

    fn session_history(&self, params: HistoryParams) -> Result<Value, RpcError> {
        let agent = match params.agent {
            Some(agent) => agent,
            None => self.agent_of(&params.id).ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("no session {}", params.id)))?,
        };
        let read = read_cached(&params.id, &history_source(&params.id, &agent), &agent);
        let (events, prompts) = &*read;
        let limit = params.limit.unwrap_or(DEFAULT_HISTORY_TURNS);
        let (range, next) = history_page(prompts, events.len(), params.before.as_ref(), limit);
        let mut page = events[range].to_vec();
        cap_outputs(&mut page);
        Ok(json!({ "events": page, "next": next }))
    }

    fn session_interrupt(&self, principal: &Principal, params: InterruptParams) -> Result<Value, RpcError> {
        let host = &self.app.state::<ChatState>().0;
        if !host.is_live(&params.id) {
            return Err(RpcError::new(INVALID_PARAMS, format!("no live chat session {}", params.id)));
        }
        let locked = super::is_locked(&self.states, &self.autopilot, &self.runner, &params.id);
        may_steer(principal, locked, self.runner.status().session.as_deref())?;
        host.interrupt(&params.id).map_err(refused)?;
        Ok(json!({ "interrupted": params.id }))
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
            Principal::Local => Value::Null,
            Principal::Session(caller) => json!(caller),
            Principal::Device(id) => json!({ "kind": "device", "id": id }),
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
        let locked = super::is_locked(&self.states, &self.autopilot, &self.runner, &params.id);
        may_steer(principal, locked, self.runner.status().session.as_deref())?;
        // A session waiting on a prompt is still inside its turn.
        let mid_turn = matches!(self.states.snapshot().get(&params.id), Some(SessionState::Working | SessionState::NeedsYou));
        let (by, text) = steered(principal, params.text);
        host.deliver(&params.id, vec![ContentBlock::Text { text }], mid_turn, by).map_err(refused)?;
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

    fn session_info(&self, params: InfoParams) -> Result<Value, RpcError> {
        let host = &self.app.state::<ChatState>().0;
        let levers = host.levers(&params.id).ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("no live chat session {}", params.id)))?;
        let modes = match levers.modes.is_empty() {
            false => json!(levers.modes),
            true => {
                let chat = self.agent_of(&params.id).and_then(|agent| crate::agents::find(&agent)).and_then(|a| a.chat.as_ref());
                let rows: Vec<Value> = chat
                    .map(|c| &c.modes)
                    .into_iter()
                    .flatten()
                    .map(|m| json!({ "id": m.id, "label": m.label, "hint": m.hint, "requires": m.requires, "permissive": m.permissive }))
                    .collect();
                json!(rows)
            }
        };
        Ok(json!({ "model": levers.model, "permission_mode": levers.mode, "models": levers.models, "modes": modes }))
    }

    fn session_model(&self, principal: &Principal, params: ModelParams) -> Result<Value, RpcError> {
        self.live_chat(principal, &params.id)?.set_model(&params.id, &params.model, params.effort).map_err(refused)?;
        Ok(json!({ "model": params.model }))
    }

    fn session_mode(&self, principal: &Principal, params: ModeParams) -> Result<Value, RpcError> {
        self.live_chat(principal, &params.id)?.set_mode(&params.id, PermissionMode::new(params.mode.clone())).map_err(refused)?;
        Ok(json!({ "mode": params.mode }))
    }

    fn units_git(&self, params: UnitsGitParams) -> Result<Value, RpcError> {
        to_json(crate::git::units_git(params.folders))
    }

    fn units_sync(&self, params: UnitsSyncParams) -> Result<Value, RpcError> {
        let units = params.units.into_iter().map(|u| crate::git::SyncUnit { path: u.path, branch: u.branch }).collect();
        crate::git::git_branch_sync_many(units).map_err(|e| RpcError::new(INTERNAL_ERROR, e)).and_then(to_json)
    }

    // A PR body can run to kilobytes and no row draws it, so it stays off the wire.
    fn units_pr(&self, params: UnitsPrParams) -> Result<Value, RpcError> {
        let mut report = crate::forge::commands::forge_unit_statuses(params.project, params.branches, false).map_err(|e| refused(e.message))?;
        for status in &mut report.statuses {
            if let Some(pr) = status.pull_request.as_mut() {
                pr.body = None;
            }
        }
        to_json(report)
    }

    fn worktree_new(&self, principal: &Principal, params: WorktreeParams) -> Result<Value, RpcError> {
        let project = self.project(principal, params.project)?;
        if let Some(number) = params.pr {
            let branch = format!("pr-{number}");
            let named = params.branch.trim();
            if params.issue.is_some() || params.from.is_some() || !(named.is_empty() || named == branch) {
                return Err(RpcError::new(INVALID_PARAMS, format!("pr goes alone: its branch is {branch}, and it takes no from or issue")));
            }
            let pr = crate::forge::commands::pull_request(&project, number).map_err(forge_refused)?;
            let sha = pr.head_sha;
            let head_ref = crate::forge::commands::pr_head_ref(&project, number);
            let askpass = self.app.state::<crate::askpass::AskpassState>().0.clone();
            {
                let lock = crate::exec::repo_lock(&project);
                let _held = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                crate::git::fetch_pr_head(&project, &head_ref, &sha, askpass.sock_path(), askpass.token()).map_err(refused)?;
                // Best effort: a stale base only widens what the worker reads, and ask.create refuses any comment off the real diff.
                let _ = crate::git::fetch_branch_quiet(&project, &pr.base_ref);
            }
            let create = crate::worktree::create_pr_worktree(self.app.clone(), project, number, sha.clone());
            let path = tauri::async_runtime::block_on(create).map_err(refused)?;
            return Ok(json!({ "path": path, "branch": branch, "head_sha": sha }));
        }
        // Asked before the worktree exists, so a bad key leaves nothing behind.
        let issue = params.issue.map(|key| crate::issues::commands::get(&project, &key)).transpose().map_err(forge_refused)?;
        let branch = params.branch.trim().to_string();
        let created = WorktreeParams { branch: branch.clone(), project: Some(project.clone()), from: params.from, issue: None, pr: None };
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
        if let Principal::Device(_) = principal {
            device_may_spawn(&params, |agent| crate::agents::find(agent).is_some_and(|a| a.chat.is_some()))?;
        }
        let me = self.identity(principal);
        let attach = params.attach.unwrap_or_default();
        if let Some(missing) = attach.iter().find(|path| !Path::new(path).is_file()) {
            return Err(RpcError::new(INVALID_PARAMS, format!("no file {missing}")));
        }
        let folder = match params.new_worktree {
            Some(branch) => {
                self.create_worktree(principal, WorktreeParams { branch, project: params.project.clone(), from: params.from, issue: None, pr: None })?
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
        if let Some(approval) = &approval {
            postable(approval, crate::forge::commands::pr_view)?;
        }
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

    fn ask_answer(&self, principal: &Principal, params: AskAnswerParams) -> Result<Value, RpcError> {
        match self.asks.answer(&params.id, params.answer, answered_by(principal)) {
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

    fn topic_member_promote(&self, session: &str, params: TopicPromoteParams) -> Result<Value, RpcError> {
        let cwd = self.session_cwd(session)?;
        let topics = crate::unit_home::topics();
        let topic = crate::unit_home::topic_of(&topics, &cwd)
            .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("{session} is not a Topic chat")))?;
        let member = crate::topics::member_named(topic, &params.member).map_err(|e| RpcError::new(INVALID_PARAMS, e))?;
        let index = self.app.state::<crate::config::ProjectIndex>().inner().clone();
        let promoted = crate::topics::promote_for_chat(
            topic,
            member,
            |question| self.ask_for_worktree(session, question, params.timeout),
            || crate::topics::commands::promote_settled(&self.app, &index, &topic.id, &member.repo_path),
        )
        .map_err(refused)?;
        let root = promoted
            .members
            .iter()
            .find(|m| m.repo_path == member.repo_path)
            .and_then(crate::topics::member_root);
        // The sidebar's own promote moves the Topic's tabs itself; this one
        // happened behind its back.
        let from = crate::topics::member_root(member);
        let _ = self.app.emit("topics://promoted", json!({ "topic": promoted, "from": from, "to": root }));
        Ok(json!({ "member": member.display_name, "branch": promoted.branch, "worktree": root }))
    }

    fn issues_assigned(&self, principal: &Principal, params: IssuesAssignedParams) -> Result<Value, RpcError> {
        let project = self.project(principal, params.project)?;
        to_json(crate::issues::commands::assigned(&project, params.refresh.unwrap_or(false)).map_err(forge_refused)?)
    }

    fn issue_get(&self, principal: &Principal, params: IssueGetParams) -> Result<Value, RpcError> {
        let (project, key) = match (params.project, issue_ref(&params.key)) {
            (Some(project), named) => (project, named.map_or(params.key, |(_, key)| key)),
            (None, Some((repo, key))) => {
                let origin = |dir: &str| crate::git::remote_url(dir, "origin").ok().flatten();
                (project_for_repo(&repo, &crate::config::discovered_project_dirs(), origin)?, key)
            }
            (None, None) => (self.project(principal, None)?, params.key),
        };
        let mut issue = to_json(crate::issues::commands::get(&project, &key).map_err(forge_refused)?)?;
        issue["project"] = json!(project);
        Ok(issue)
    }

    fn pr_get(&self, principal: &Principal, params: PrGetParams) -> Result<Value, RpcError> {
        let (project, number) = match (params.project, pr_ref(&params.key)) {
            (Some(project), named) => (project, named.map_or(params.key, |(_, n)| n)),
            (None, Some((repo, n))) => {
                let origin = |dir: &str| crate::git::remote_url(dir, "origin").ok().flatten();
                (project_for_repo(&repo, &crate::config::discovered_project_dirs(), origin)?, n)
            }
            (None, None) => (self.project(principal, None)?, params.key),
        };
        let number = number.trim().trim_start_matches('#').parse::<u64>().map_err(|_| RpcError::new(INVALID_PARAMS, format!("{number} is not a pull request number or URL")))?;
        let mut pr = to_json(crate::forge::commands::pr_view(&project, number).map_err(forge_refused)?)?;
        pr["project"] = json!(project);
        Ok(pr)
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
        let sha = params.head_sha;
        let req = crate::forge::CreatePr {
            title: params.title,
            body: params.body,
            head: params.head,
            base: params.base,
            draft: params.draft.unwrap_or(false),
        };
        let askpass = self.app.state::<crate::askpass::AskpassState>().0.clone();
        self.gated_outward(principal, params.project, draft, params.approval_id.as_deref(), |project| {
            let push = || {
                let lock = crate::exec::repo_lock(project);
                let _held = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                crate::git::push_sha(project, "origin", &req.head, &sha, askpass.sock_path(), askpass.token())
            };
            let create = || crate::forge::commands::create_pr(project, &req);
            to_json(crate::forge::prs::push_then_create(push, create).map_err(forge_refused)?)
        })
    }

    fn review_submit(&self, principal: &Principal, params: ReviewSubmitParams) -> Result<Value, RpcError> {
        let draft = params.draft();
        let comments = params.comments.unwrap_or_default();
        self.gated_outward(principal, params.project, draft, params.approval_id.as_deref(), |project| {
            submit_pinned(
                params.number,
                &params.head_sha,
                || crate::forge::commands::pull_request(project, params.number).map(|pr| pr.head_sha),
                || crate::forge::commands::submit_review(project, params.number, params.event, &params.body, &comments, Some(&params.head_sha)),
            )
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
        state["limits"] = json!({ "max_workers": crate::settings::autopilot_worker_cap() });
        Ok(state)
    }

    fn autopilot_log(&self, params: LogParams) -> Result<Value, RpcError> {
        Ok(json!(self.autopilot.recent_log(params.limit.unwrap_or(DEFAULT_LOG_LIMIT))))
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

    fn device_mint(&self, params: MintParams) -> Result<Value, RpcError> {
        let (device, credential) = self.devices.mint(&params.name).map_err(|e| RpcError::new(INTERNAL_ERROR, e))?;
        Ok(json!({ "id": device.id, "name": device.name, "credential": credential }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::commands::HistorySource;
    use serde_json::json;

    fn page_back(prompts: &[(u64, usize)], total: usize, limit: usize) -> Vec<std::ops::Range<usize>> {
        let (mut pages, mut before) = (Vec::new(), None);
        loop {
            let (range, next) = history_page(prompts, total, before.as_ref(), limit);
            pages.push(range);
            if next.is_none() {
                return pages;
            }
            assert!(pages.len() < 100, "no progress: {pages:?}");
            before = next;
        }
    }

    fn covered_once(pages: &[std::ops::Range<usize>], total: usize) {
        let mut seen: Vec<usize> = pages.iter().rev().flat_map(|r| r.clone()).collect();
        assert_eq!(seen.len(), total, "{pages:?}");
        seen.dedup();
        assert_eq!(seen, (0..total).collect::<Vec<_>>(), "{pages:?}");
    }

    #[test]
    fn paging_back_returns_every_event_once_and_never_splits_a_turn() {
        let prompts = [(100, 3), (200, 43), (300, 48), (400, 108)];
        let pages = page_back(&prompts, 120, 2);
        covered_once(&pages, 120);
        assert_eq!(pages, [48..120, 3..48, 0..3]);
        let untimed = prompts.map(|(_, at)| (0, at));
        covered_once(&page_back(&untimed, 120, 2), 120);
    }

    #[test]
    fn a_turn_bigger_than_a_page_is_walked_by_event() {
        let prompts = [(100, 0), (200, 10), (300, 1210)];
        let pages = page_back(&prompts, 1215, 5);
        covered_once(&pages, 1215);
        assert_eq!(history_page(&prompts, 1215, Some(&Before::Turn(300)), 5).1, Some(Before::Event { ts: Some(200), event: 700 }));
    }

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
    fn a_locked_session_is_steered_by_the_autopilot_alone() {
        let pilot = Some("pilot");
        let autopilot = Principal::Session(Caller::Chat("pilot".into()));
        assert!(may_steer(&autopilot, true, pilot).is_ok());
        for person in [
            Principal::Local,
            Principal::Session(Caller::Terminal("tab".into())),
            Principal::Session(Caller::Chat("another-chat".into())),
        ] {
            let refused = may_steer(&person, true, pilot).unwrap_err();
            assert!(refused.message.contains("stop the autopilot to type"), "{}", refused.message);
            assert!(may_steer(&person, false, pilot).is_ok(), "an unlocked session is anyone's");
        }
    }

    #[test]
    fn a_device_steers_as_the_user_types() {
        assert_eq!(steered(&Principal::Device("d1".into()), "go on".into()), (TurnBy::Local, "go on".into()));
        let (by, text) = steered(&Principal::Session(Caller::Chat("s1".into())), "go on".into());
        assert_eq!(by, TurnBy::Session("s1".into()));
        assert_ne!(text, "go on", "a chat's steer is wrapped as a note");
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
            draft: Draft::PrCreate {
                head: "1-x".into(),
                base: "main".into(),
                title: "T".into(),
                body: "B".into(),
                draft: false,
                head_sha: "abc".into(),
            },
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
        for named in ["pr.create", "a pull request from 1-x at abc into main", "/p", "no approval_id", "ask_create"] {
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
    fn a_failed_push_or_create_keeps_the_approval_and_a_retry_spends_it() {
        let approvals = Approvals::default();
        let id = approvals.grant("s1", pr_draft());
        let creates = std::cell::Cell::new(0);
        let attempt = |push: Result<(), String>, create: Result<(), &str>| {
            gated_by_approval(&approvals, Some("s1"), &pr_draft(), Some(&id), || {
                let opened = crate::forge::prs::push_then_create(
                    || push,
                    || {
                        creates.set(creates.get() + 1);
                        create.map(|()| sample_pr()).map_err(|message| crate::forge::ForgeError::Transport { message: message.into() })
                    },
                );
                to_json(opened.map_err(forge_refused)?)
            })
        };

        let err = attempt(Err("! [rejected] feature (non-fast-forward)".into()), Ok(())).unwrap_err();
        assert!(err.message.contains("non-fast-forward"), "{}", err.message);
        assert_eq!(creates.get(), 0, "a rejected push never reaches the forge");
        assert!(attempt(Ok(()), Err("422")).is_err());
        assert_eq!(creates.get(), 1);
        assert_eq!(attempt(Ok(()), Ok(())).unwrap()["number"], json!(12), "the same approval opens it on retry");
        let spent = attempt(Ok(()), Ok(())).unwrap_err();
        assert!(spent.message.contains("already spent"), "{}", spent.message);
    }

    fn sample_pr() -> crate::forge::model::PullRequest {
        crate::forge::model::PullRequest {
            number: 12,
            title: "T".into(),
            body: None,
            state: crate::forge::model::PrState::Open,
            is_draft: false,
            author: "a".into(),
            created_at: "2026-09-25T00:00:00Z".into(),
            merged_at: None,
            closed_at: None,
            comments: 0,
            head_ref: "1-x".into(),
            base_ref: "main".into(),
            head_sha: "abc".into(),
            head_repo_is_origin: true,
            url: "https://github.com/o/r/pull/12".into(),
            mergeable_state: crate::forge::model::MergeableState::Unknown,
        }
    }

    #[test]
    fn a_review_on_a_moved_head_is_refused_and_keeps_its_approval() {
        let approvals = Approvals::default();
        let review = Approval {
            project: "/p".into(),
            draft: Draft::ReviewSubmit { number: 45, event: crate::forge::model::ReviewEvent::Comment, body: "B".into(), comments: vec![], head_sha: "abc".into() },
        };
        let id = approvals.grant("s1", review.clone());
        let posts = std::cell::Cell::new(0);
        let attempt = |head: &str| {
            gated_by_approval(&approvals, Some("s1"), &review, Some(&id), || {
                submit_pinned(45, "abc", || Ok(head.to_string()), || {
                    posts.set(posts.get() + 1);
                    Ok(())
                })
            })
        };
        let moved = attempt("def").unwrap_err();
        assert!(moved.message.contains("moved past abc to def"), "{}", moved.message);
        assert_eq!(posts.get(), 0, "nothing posts on a moved head");
        assert!(attempt("abc").is_ok(), "the same approval posts once the head matches");
        assert_eq!(posts.get(), 1);
    }

    #[test]
    fn only_a_review_draft_that_would_post_reaches_its_card() {
        use crate::forge::model::{Capabilities, DiffSide, DraftComment, FileStatus, Paged, PrFile, ReviewEvent};
        let view = |_: &str, _: u64| {
            let file = PrFile {
                path: "src/a.rs".into(),
                previous_path: None,
                status: FileStatus::Modified,
                additions: 1,
                deletions: 0,
                patch: Some("@@ -1,2 +1,3 @@\n a\n+b\n c\n".into()),
            };
            let caps = Capabilities {
                pull_requests: true,
                checks: true,
                review_threads: true,
                resolve_threads: true,
                merge: true,
                approve: true,
                request_changes: true,
                comment_review: true,
                single_comment: true,
            };
            Ok(crate::forge::pr_view::view(sample_pr(), Paged::complete(vec![file]), "me", caps))
        };
        let review = |line| Approval {
            project: "/p".into(),
            draft: Draft::ReviewSubmit {
                number: 12,
                event: ReviewEvent::Approve,
                body: "B".into(),
                comments: vec![DraftComment { path: "src/a.rs".into(), line, side: DiffSide::Right, start_line: None, start_side: None, body: "c".into() }],
                head_sha: "abc".into(),
            },
        };
        assert!(postable(&review(2), view).is_ok());
        let err = postable(&review(9), view).unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
        assert!(err.message.contains("comment 1: line 9"), "{}", err.message);
        assert!(postable(&pr_draft(), |_: &str, _: u64| unreachable!("a pull request draft reads no review")).is_ok());
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

    #[test]
    fn a_space_carries_its_icon_and_colour_and_a_plain_one_nulls() {
        let space = |name: &str, icon: Option<&str>, color: Option<&str>| crate::config::Space {
            name: name.into(),
            path: format!("/{name}"),
            projects: vec![],
            icon: icon.map(Into::into),
            color: color.map(Into::into),
        };
        let tree = projects_tree(&[space("work", Some("Briefcase"), Some("teal")), space("plain", None, None)], vec![]);
        assert_eq!((&tree["spaces"][0]["icon"], &tree["spaces"][0]["color"]), (&json!("Briefcase"), &json!("teal")));
        assert_eq!((&tree["spaces"][1]["icon"], &tree["spaces"][1]["color"]), (&Value::Null, &Value::Null));
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
        let mut mirrored = ask("ask-3", "worker");
        mirrored.shown_in = vec!["worker".into(), "w1".into()];
        mirrored.approval = Some(crate::rpc::approvals::Approval {
            project: "/p".into(),
            draft: crate::rpc::approvals::Draft::PrMerge {
                number: 7,
                method: crate::forge::MergeMethod::Squash,
                head_sha: "abc".into(),
            },
        });
        let rows = pending_rows("w1", vec![ask("ask-1", "w1"), ask("ask-2", "other"), mirrored], native);
        let kinds: Vec<(&str, &str)> = rows.iter().map(|r| (r["kind"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
        assert_eq!(kinds, [("ask", "ask-1"), ("ask", "ask-3"), ("question", "toolu_q"), ("permission", "toolu_p")]);
        assert_eq!(rows[0]["text"], "ship it?");
        assert!(rows[0].get("approval").is_none());
        assert_eq!(rows[1]["session"], "worker", "a worker's approval lists under the root it shows in");
        assert_eq!(rows[1]["approval"]["head_sha"], "abc", "with the whole draft: {}", rows[1]);
        assert_eq!(rows[3]["tool"], "Bash");
        assert!(rows[2].get("request_id").is_none(), "the host's request id stays inside: {}", rows[2]);
    }

    #[test]
    fn only_a_device_answers_an_ask_as_a_person() {
        assert_eq!(answered_by(&Principal::Device("d1".into())), By::Device);
        for other in [Principal::Local, Principal::Session(Caller::Chat("s1".into())), Principal::Session(Caller::Terminal("t1".into()))] {
            assert_eq!(answered_by(&other), By::Socket, "{other:?}");
        }
    }

    #[test]
    fn only_the_spawner_answers_for_a_worker() {
        let chat = |id: &str| Principal::Session(Caller::Chat(id.into()));
        assert!(answers_for(&chat("pilot"), Some("pilot".into()), "w1").is_ok());
        let device = Principal::Device("d1".into());
        assert!(answers_for(&device, Some("pilot".into()), "w1").is_ok());
        assert!(answers_for(&device, None, "s1").is_ok(), "a device answers a session nobody spawned");
        for (caller, spawner) in [(chat("other"), Some("pilot".into())), (chat("pilot"), None), (Principal::Local, Some("pilot".into()))] {
            let err = answers_for(&caller, spawner, "w1").unwrap_err();
            assert_eq!(err.code, REFUSED, "{}", err.message);
        }
    }

    #[test]
    fn a_device_spawns_only_a_plain_chat_in_a_folder_it_names() {
        let is_chat = |agent: &str| agent == "claude";
        let plain = || SpawnParams { folder: Some("/p".into()), agent: Some("claude".into()), prompt: Some("hi".into()), ..Default::default() };
        assert!(device_may_spawn(&plain(), is_chat).is_ok());
        let refusals = [
            SpawnParams { attach: Some(vec!["/etc/hosts".into()]), ..plain() },
            SpawnParams { new_worktree: Some("b".into()), ..plain() },
            SpawnParams { background: Some(true), ..plain() },
            SpawnParams { agent: Some("pty-only".into()), ..plain() },
            SpawnParams { agent: None, ..plain() },
        ];
        for params in refusals {
            assert_eq!(device_may_spawn(&params, is_chat).unwrap_err().code, REFUSED, "{params:?}");
        }
        assert_eq!(device_may_spawn(&SpawnParams { folder: None, ..plain() }, is_chat).unwrap_err().code, INVALID_PARAMS);
        assert!(device_may_spawn(&SpawnParams { attach: Some(vec![]), ..plain() }, is_chat).is_ok());
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
