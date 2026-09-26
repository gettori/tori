//! Connection handling and dispatch, written against [`Transport`] and
//! [`Stream`] only. One thread reads a connection and one writes it; the writer
//! drains the connection's queue, which is the only thing that ever touches the
//! socket's write half after auth.

use std::io::BufReader;
use std::sync::mpsc::{sync_channel, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use super::approvals::Draft;
use super::auth::{authenticate, pair, Credential, Principal, PAIR_METHOD};
use crate::autopilot::{AutopilotStore, Autonomy, ContractPatch, Kind, Observed, Patch, Pickup, Ships, Source, State, Target, UpdateError};
use crate::forge::model::{DraftComment, ReviewEvent};
use crate::forge::MergeMethod;
use super::frame::{
    read_request, to_line, write_line, ReadError, Request, Response, RpcError, INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST,
    METHOD_NOT_FOUND, REFUSED, UNAUTHORIZED,
};
use super::hub::{Channel, ChatOutbox, ConnId, Hub, QUEUE_CAP, WAKE};
use super::table::{self, CallerKind};
use super::transport::{Stream, Transport};

pub const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListParams {
    /// Only sessions whose folder is this one or inside it.
    pub cwd: Option<String>,
    /// Only sessions running in this Tori right now.
    pub live: Option<bool>,
    /// At most this many rows, newest first (default 50).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TailParams {
    /// The session id.
    pub id: String,
    /// The session's agent, looked up from the live claims, then the index, when left out.
    pub agent: Option<String>,
    /// At most this many events, the last ones (default 50).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryParams {
    /// The session id.
    pub id: String,
    /// The session's agent, looked up from the live claims, then the index, when left out.
    pub agent: Option<String>,
    /// The `next` of the page after this one; left out for the latest page.
    pub before: Option<Before>,
    /// At most this many turns (default 10). A page never holds more than 500 events.
    pub limit: Option<usize>,
}

/// Where a page ends. A prompt timestamp ends it before that prompt's turn. An
/// event inside a turn is for a turn too big for one page: `ts` names the turn
/// by its prompt (absent for what came before the first prompt), `event` counts
/// from the turn's start.
#[derive(Debug, Clone, PartialEq, serde::Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Before {
    Turn(u64),
    Event { ts: Option<u64>, event: usize },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MintParams {
    /// What to call the device, shown beside it later.
    pub name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InterruptParams {
    /// The live chat session whose turn to stop.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SteerParams {
    /// The live chat session to send to.
    pub id: String,
    /// The message, delivered as a steer mid turn or as the next turn otherwise.
    pub text: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WaitParams {
    /// The session to wait on.
    pub id: String,
    /// Seconds to wait for it to stop working before answering anyway (default 60).
    pub timeout: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PendingParams {
    /// The session whose open questions and permission prompts to list.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Answer {
    One(String),
    Each(Vec<String>),
}

impl Answer {
    pub fn into_list(self) -> Vec<String> {
        match self {
            Answer::One(one) => vec![one],
            Answer::Each(each) => each,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionAnswerParams {
    /// The session you spawned that is waiting.
    pub session: String,
    /// The id `session.pending` gave the question or permission prompt.
    pub id: String,
    /// `allow` or `deny` for a permission. For a question, an option's label or your own words, as a list with
    /// one answer per question when it asks several.
    pub answer: Answer,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorktreeParams {
    /// The new branch, created in a new worktree. Left out with `pr`, which names it `pr-<number>`.
    #[serde(default)]
    pub branch: String,
    /// The project folder, the caller's own project when left out.
    pub project: Option<String>,
    /// The ref the new branch starts from.
    pub from: Option<String>,
    /// The issue the branch is for, remembered on the unit it makes.
    pub issue: Option<String>,
    /// A pull request to review: its head is fetched from the forge's PR ref, forks included, onto a local
    /// `pr-<number>` branch. A worktree already at another commit is refused, never reset.
    pub pr: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct IssuesAssignedParams {
    /// The project folder, the caller's own project when left out.
    pub project: Option<String>,
    /// Ask the host even when a list fetched in the last half minute is at hand.
    pub refresh: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct IssueGetParams {
    /// The issue's key, the number on GitHub, or its URL.
    pub key: String,
    /// The project folder. Left out, a URL key names the local project whose origin is that repo, else the
    /// caller's own project.
    pub project: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PrGetParams {
    /// The pull request's number, or its URL.
    pub key: String,
    /// The project folder. Left out, a URL key names the local project whose origin is that repo, else the
    /// caller's own project.
    pub project: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LinkBranchParams {
    /// The issue's key, the number on GitHub.
    pub key: String,
    /// The branch to make on the host, linked under the issue.
    pub branch: String,
    /// The branch it starts from, the host's default branch when left out.
    pub base: Option<String>,
    /// The project folder, the caller's own project when left out.
    pub project: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckpointsParams {
    /// The session id.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckpointParams {
    /// The session id.
    pub id: String,
    /// The turn, 1 based, in the order `checkpoints.list` returns.
    pub turn: usize,
    /// Revert even with other live sessions in the same folder.
    pub force: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckpointDiffParams {
    /// The session id.
    pub id: String,
    /// The first turn, 1 based, in the order `checkpoints.list` returns.
    pub turn: usize,
    /// The last turn of a range, the same turn when left out; never before `turn`.
    pub to: Option<usize>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnParams {
    /// The agent id, the caller's own agent when left out.
    pub agent: Option<String>,
    /// The agent account, the caller's own when the agent is the caller's.
    pub account: Option<String>,
    /// The folder to start in, the caller's own folder when left out.
    pub folder: Option<String>,
    /// The first message of the new session.
    pub prompt: Option<String>,
    /// Paths of files attached to the first message.
    pub attach: Option<Vec<String>>,
    /// Start in a new worktree on this new branch instead of `folder`.
    pub new_worktree: Option<String>,
    /// The project a `new_worktree` is made in, the caller's own when left out.
    pub project: Option<String>,
    /// The ref a `new_worktree` branches from.
    pub from: Option<String>,
    /// Mark the session as running unattended; `sessions.list` flags it `background`.
    pub background: Option<bool>,
    /// The model it opens on, the project contract's when left out.
    pub model: Option<String>,
    /// The effort level it opens on.
    pub effort: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OpenParams {
    /// Path of the file to open in the editor.
    pub path: String,
    /// The 1 based line to put the cursor on.
    pub line: Option<u32>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BudgetParams {
    /// The session to report, the calling chat session when left out.
    pub id: Option<String>,
    /// The folder whose usage to report, the session's folder when left out.
    pub folder: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AskParams {
    /// The question shown to the user in the calling chat.
    pub question: String,
    /// Answers offered as buttons; the user can still type their own.
    pub options: Option<Vec<String>>,
    /// Seconds to wait for an answer before returning the id to poll with `ask.wait`.
    pub timeout: Option<u64>,
    /// Ask to approve this outward action and its exact draft. The options become Approve and Reject, and
    /// an Approve answer comes back with the `approval_id` a background session passes to that action.
    pub approval: Option<Draft>,
    /// The project an `approval` is for, the caller's own project when left out.
    pub project: Option<String>,
    /// The autopilot item an `approval` holds up. The ask then survives the asking chat and a restart,
    /// and is withdrawn when the item is done or failed.
    pub item: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AskAnswerParams {
    /// The id of a question `ask.create` raised in another session.
    pub id: String,
    /// The answer, handed to whoever is waiting on that id.
    pub answer: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AskWaitParams {
    /// The id `ask.create` returned.
    pub id: String,
    /// Seconds to wait for the answer before returning null again.
    pub timeout: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PrCreateParams {
    /// The branch the pull request is from.
    pub head: String,
    /// The commit pushed to `head` on origin first; refused when the local branch has moved past it.
    pub head_sha: String,
    /// The branch it merges into.
    pub base: String,
    /// The pull request's title.
    pub title: String,
    /// The pull request's body.
    pub body: String,
    /// Open it as a draft.
    pub draft: Option<bool>,
    /// The project folder, the caller's own project when left out.
    pub project: Option<String>,
    /// The approval `ask.create` returned for exactly this call; a background session is refused without one.
    pub approval_id: Option<String>,
}

impl PrCreateParams {
    pub fn draft(&self) -> Draft {
        Draft::PrCreate {
            head: self.head.clone(),
            base: self.base.clone(),
            title: self.title.clone(),
            body: self.body.clone(),
            draft: self.draft.unwrap_or(false),
            head_sha: self.head_sha.clone(),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewSubmitParams {
    /// The pull request's number.
    pub number: u64,
    /// The verdict.
    pub event: ReviewEvent,
    /// The review's body.
    pub body: String,
    /// Line comments held with the review.
    pub comments: Option<Vec<DraftComment>>,
    /// The head commit the comments were drawn against, pr.get's head_sha; refused once the pull request has moved on.
    pub head_sha: String,
    /// The project folder, the caller's own project when left out.
    pub project: Option<String>,
    /// The approval `ask.create` returned for exactly this call; a background session is refused without one.
    pub approval_id: Option<String>,
}

impl ReviewSubmitParams {
    pub fn draft(&self) -> Draft {
        Draft::ReviewSubmit {
            number: self.number,
            event: self.event,
            body: self.body.clone(),
            comments: self.comments.clone().unwrap_or_default(),
            head_sha: self.head_sha.clone(),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PrMergeParams {
    /// The pull request's number.
    pub number: u64,
    /// How to land it.
    pub method: MergeMethod,
    /// The head commit to land; the host refuses once the branch has moved on.
    pub head_sha: String,
    /// The project folder, the caller's own project when left out.
    pub project: Option<String>,
    /// The approval `ask.create` returned for exactly this call; a background session is refused without one.
    pub approval_id: Option<String>,
}

impl PrMergeParams {
    pub fn draft(&self) -> Draft {
        Draft::PrMerge { number: self.number, method: self.method, head_sha: self.head_sha.clone() }
    }
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ItemUpdateParams {
    /// The item to update. Left out, the item for this kind, source and project that is not done or failed is
    /// updated, or made when there is none, so a retry never makes a second one.
    pub id: Option<String>,
    /// What the item is for; needed without an id.
    pub kind: Option<Kind>,
    /// Where the item came from; needed without an id.
    pub source: Option<Source>,
    /// The project folder, the caller's own project when left out without an id.
    pub project: Option<String>,
    /// Its new state.
    pub state: Option<State>,
    /// The worktree it runs in.
    pub worktree: Option<String>,
    /// The session working on it.
    pub session: Option<String>,
    /// Its pull request's url.
    pub pr_url: Option<String>,
    /// The issue's or pull request's own page, as `issues_get` or the forge gave it.
    pub url: Option<String>,
    /// A line on where it stands.
    pub note: Option<String>,
    /// What the work is, in a few words, shown on its card.
    pub title: Option<String>,
    /// What to build, how it ships and what is out of scope.
    pub contract: Option<String>,
}

impl ItemUpdateParams {
    /// `project` is the one resolved for a new item; with an id it must be left out.
    pub fn apply(self, store: &AutopilotStore, project: Option<String>) -> Result<Value, RpcError> {
        let target = match (self.id, self.kind, self.source, project) {
            (Some(id), None, None, None) => Target::Id(id),
            (Some(_), ..) => return Err(RpcError::new(INVALID_PARAMS, "kind, source and project name a new item: with an id pass only what changes")),
            (None, Some(kind), Some(source), Some(project)) => Target::Key { kind, source, project },
            (None, ..) => return Err(RpcError::new(INVALID_PARAMS, "without an id, pass kind, source and project")),
        };
        let patch = Patch {
            state: self.state,
            worktree: self.worktree,
            session: self.session,
            pr_url: self.pr_url,
            url: self.url,
            note: self.note,
            title: self.title,
            contract: self.contract,
        };
        match store.update(target, patch) {
            Ok(item) => serde_json::to_value(item).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string())),
            Err(e @ UpdateError::NoItem(_)) => Err(RpcError::new(INVALID_PARAMS, e.to_string())),
            Err(e @ UpdateError::Write(_)) => Err(RpcError::new(INTERNAL_ERROR, e.to_string())),
        }
    }
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectSetParams {
    /// The project folder, the caller's own project when left out.
    pub project: Option<String>,
    /// How finished work leaves the machine.
    pub ships: Option<Ships>,
    /// How far the autopilot goes before asking.
    pub autonomy: Option<Autonomy>,
    /// Whether new work is queued without asking.
    pub pickup: Option<Pickup>,
    /// The agent the project's workers run.
    pub agent: Option<String>,
    /// The agent account they run under.
    pub account: Option<String>,
    /// The model they use.
    pub model: Option<String>,
}

impl ProjectSetParams {
    pub fn apply(self, store: &AutopilotStore, project: String) -> Result<Value, RpcError> {
        let patch = ContractPatch {
            ships: self.ships,
            autonomy: self.autonomy,
            pickup: self.pickup,
            agent: self.agent,
            account: self.account,
            model: self.model,
        };
        let contract = store.set_project(project, patch).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))?;
        serde_json::to_value(contract).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
    }
}

pub fn autopilot_state(
    store: &AutopilotStore,
    holds: Vec<super::asks::Hold>,
    observe: impl FnOnce(&[crate::autopilot::Item]) -> Observed,
) -> Result<Value, RpcError> {
    let mut state = serde_json::to_value(store.state(observe)).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))?;
    state["holds"] = json!(holds);
    Ok(state)
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HoldResolveParams {
    /// The ask id of the hold.
    pub id: String,
}

// Withdraws, never approves: approving is the user's answer on the card.
pub fn hold_resolve(asks: &super::asks::Asks, id: &str) -> Result<Value, RpcError> {
    if !asks.withdraw(id) {
        return Err(RpcError::new(INVALID_PARAMS, format!("no open hold {id}")));
    }
    Ok(json!({ "id": id, "answer": super::asks::WITHDRAWN }))
}

/// What the methods read. Tauri state in the app, a stub in tests.
pub trait Backend: Send + Sync {
    fn watching_sessions(&self) {}
    fn kind(&self, principal: &Principal) -> CallerKind;
    fn sessions_list(&self, params: ListParams) -> Result<Value, RpcError>;
    fn projects_list(&self) -> Result<Value, RpcError>;
    fn session_tail(&self, params: TailParams) -> Result<Value, RpcError>;
    fn session_history(&self, params: HistoryParams) -> Result<Value, RpcError>;
    fn session_interrupt(&self, principal: &Principal, params: InterruptParams) -> Result<Value, RpcError>;
    fn caller(&self, principal: &Principal) -> Result<Value, RpcError>;
    fn session_steer(&self, principal: &Principal, params: SteerParams) -> Result<Value, RpcError>;
    fn session_wait(&self, params: WaitParams) -> Result<Value, RpcError>;
    fn session_pending(&self, params: PendingParams) -> Result<Value, RpcError>;
    fn session_answer(&self, principal: &Principal, params: SessionAnswerParams) -> Result<Value, RpcError>;
    fn worktree_new(&self, principal: &Principal, params: WorktreeParams) -> Result<Value, RpcError>;
    fn checkpoints_list(&self, params: CheckpointsParams) -> Result<Value, RpcError>;
    fn checkpoint_diff(&self, params: CheckpointDiffParams) -> Result<Value, RpcError>;
    fn checkpoint_revert(&self, principal: &Principal, params: CheckpointParams) -> Result<Value, RpcError>;
    fn session_spawn(&self, principal: &Principal, params: SpawnParams) -> Result<Value, RpcError>;
    fn window_open(&self, params: OpenParams) -> Result<Value, RpcError>;
    fn budget(&self, principal: &Principal, params: BudgetParams) -> Result<Value, RpcError>;
    fn ask_create(&self, session: &str, params: AskParams) -> Result<Value, RpcError>;
    fn ask_wait(&self, params: AskWaitParams) -> Result<Value, RpcError>;
    fn ask_answer(&self, params: AskAnswerParams) -> Result<Value, RpcError>;
    fn issues_assigned(&self, principal: &Principal, params: IssuesAssignedParams) -> Result<Value, RpcError>;
    fn issue_get(&self, principal: &Principal, params: IssueGetParams) -> Result<Value, RpcError>;
    fn issue_link_branch(&self, principal: &Principal, params: LinkBranchParams) -> Result<Value, RpcError>;
    fn pr_get(&self, principal: &Principal, params: PrGetParams) -> Result<Value, RpcError>;
    fn pr_create(&self, principal: &Principal, params: PrCreateParams) -> Result<Value, RpcError>;
    fn review_submit(&self, principal: &Principal, params: ReviewSubmitParams) -> Result<Value, RpcError>;
    fn pr_merge(&self, principal: &Principal, params: PrMergeParams) -> Result<Value, RpcError>;
    fn autopilot_state(&self) -> Result<Value, RpcError>;
    fn autopilot_item_update(&self, principal: &Principal, params: ItemUpdateParams) -> Result<Value, RpcError>;
    fn autopilot_project_set(&self, principal: &Principal, params: ProjectSetParams) -> Result<Value, RpcError>;
    fn autopilot_hold_resolve(&self, params: HoldResolveParams) -> Result<Value, RpcError>;
    fn autopilot_start(&self) -> Result<Value, RpcError>;
    fn autopilot_stop(&self) -> Result<Value, RpcError>;
    fn device_mint(&self, params: MintParams) -> Result<Value, RpcError>;
}

pub struct Server {
    pub hub: Arc<Hub>,
    pub backend: Box<dyn Backend>,
    pub auth_timeout: Duration,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TopicParams {
    topic: String,
}

pub(super) fn params<T: DeserializeOwned>(value: &Value) -> Result<T, RpcError> {
    let value = if value.is_null() { json!({}) } else { value.clone() };
    serde_json::from_value(value).map_err(|e| RpcError::new(INVALID_PARAMS, e.to_string()))
}

fn channel(value: &Value) -> Result<Channel, RpcError> {
    let TopicParams { topic } = params(value)?;
    Channel::parse(&topic).ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("unknown topic {topic}")))
}

impl Server {
    pub fn dispatch(&self, conn: ConnId, principal: &Principal, req: &Request) -> Result<Value, RpcError> {
        match req.method.as_str() {
            "subscribe" => {
                let channel = channel(&req.params)?;
                let sessions = matches!(channel, Channel::Sessions | Channel::Session(_));
                let kind = self.backend.kind(principal);
                if matches!(channel, Channel::Accounts | Channel::Autopilot) && kind == CallerKind::Device {
                    return Err(RpcError::new(REFUSED, "a device subscribes to sessions, session:<id> and chat:<id> only"));
                }
                // The stream is for a person watching a chat; an agent reads a session with session.tail.
                if matches!(channel, Channel::Chat(_)) && !matches!(kind, CallerKind::Device | CallerKind::Local) {
                    return Err(RpcError::new(REFUSED, "chat:<id> is open to a device or a local client only"));
                }
                if sessions {
                    self.backend.watching_sessions();
                }
                self.hub.subscribe(conn, channel);
                Ok(json!({}))
            }
            "unsubscribe" => {
                self.hub.unsubscribe(conn, &channel(&req.params)?);
                Ok(json!({}))
            }
            "auth" => Err(RpcError::new(INVALID_REQUEST, "already authenticated")),
            name => {
                let method = table::find(name).ok_or_else(|| RpcError::new(METHOD_NOT_FOUND, format!("no method {name}")))?;
                let kind = self.backend.kind(principal);
                if !method.callers.contains(&kind) {
                    let why = match kind {
                        CallerKind::Worker => method.refusal.or(Some(table::WORKER_REFUSAL)),
                        _ => method.refusal,
                    };
                    let why = why.map(|r| format!(": {r}")).unwrap_or_default();
                    return Err(RpcError::new(REFUSED, format!("{name} is not open to a {} caller{why}", kind.name())));
                }
                (method.call)(self.backend.as_ref(), principal, &req.params)
            }
        }
    }
}

/// Accept on its own thread until the transport shuts down. A front is a
/// transport and the credential it accepts; every front shares one server.
pub fn serve(transport: Arc<dyn Transport>, credential: Arc<Credential>, server: Arc<Server>) {
    thread::spawn(move || loop {
        match transport.accept() {
            Ok(Some(stream)) => {
                let (server, credential) = (server.clone(), credential.clone());
                thread::spawn(move || handle(&server, &credential, stream));
            }
            Ok(None) => break,
            // A failed accept (a client that hung up mid handshake) is that
            // client's problem, not a reason to stop listening.
            Err(_) => continue,
        }
    });
}

// Replies and other topics first; the chat queue only when the main one is empty.
fn drain(rx: &Receiver<String>, chat: &ChatOutbox, mut write: impl FnMut(&str) -> bool) {
    loop {
        let line = match rx.try_recv() {
            Ok(line) => line,
            Err(TryRecvError::Disconnected) => return,
            Err(TryRecvError::Empty) => match chat.pop() {
                Some(line) => line,
                None => match rx.recv() {
                    Ok(line) => line,
                    Err(_) => return,
                },
            },
        };
        if line == WAKE {
            chat.clear_wake();
            continue;
        }
        if !write(&line) {
            return;
        }
    }
}

fn handle(server: &Server, credential: &Credential, mut stream: Box<dyn Stream>) {
    let Ok(read_half) = stream.try_clone_box() else { return };
    let mut reader = BufReader::new(read_half);

    // Bounded, so a client that connects and says nothing does not hold a
    // thread forever.
    let _ = stream.set_read_timeout(Some(server.auth_timeout));
    let authed = match read_request(&mut reader) {
        // Pairing ends the connection either way: the device comes back with
        // `auth`, so every connection that is served starts with a credential.
        Ok(Some(first)) if first.method == PAIR_METHOD => {
            let id = first.id.clone().unwrap_or(Value::Null);
            let reply = match pair(&first, credential) {
                Ok(paired) => Response::ok(id, json!(paired)),
                Err(e) => Response::err(id, e.rpc()),
            };
            let _ = write_line(&mut stream, &to_line(&reply));
            stream.close();
            return;
        }
        Ok(Some(first)) => match authenticate(&first, credential) {
            Ok(principal) => {
                let reply = Response::ok(first.id.clone().unwrap_or(Value::Null), json!({}));
                if write_line(&mut stream, &to_line(&reply)).is_err() {
                    return;
                }
                Ok(principal)
            }
            Err(e) => Err(Response::err(first.id.clone().unwrap_or(Value::Null), e.rpc())),
        },
        Ok(None) => return,
        Err(ReadError::Io(_)) => Err(Response::err(Value::Null, RpcError::new(UNAUTHORIZED, "no auth frame in time"))),
        Err(e) => Err(Response::err(Value::Null, e.rpc())),
    };
    let principal = match authed {
        Ok(principal) => principal,
        Err(reply) => {
            let _ = write_line(&mut stream, &to_line(&reply));
            stream.close();
            return;
        }
    };
    let _ = stream.set_read_timeout(None);

    let (tx, rx) = sync_channel::<String>(QUEUE_CAP);
    let Ok(closer) = stream.try_clone_box() else { return };
    let conn = server.hub.register(tx.clone(), Box::new(move || closer.close()));
    // Tagged before the check, so a revoke either sees this connection or
    // removed the device before the check reads it.
    if let Principal::Device(id) = &principal {
        server.hub.tag_device(conn, id);
    }
    if !credential.holds(&principal) {
        server.hub.remove(conn);
        drop(tx);
        stream.close();
        return;
    }
    let Some(chat) = server.hub.chat_outbox(conn) else {
        stream.close();
        return;
    };
    let writer = thread::spawn(move || {
        drain(&rx, &chat, |line| write_line(&mut stream, line).is_ok());
        stream.close();
    });

    loop {
        let reply = match read_request(&mut reader) {
            Ok(None) | Err(ReadError::Io(_)) => break,
            Ok(Some(req)) => {
                let outcome = server.dispatch(conn, &principal, &req);
                match req.id {
                    Some(id) => Response::reply(id, outcome),
                    None => continue,
                }
            }
            Err(ReadError::TooLarge) => {
                let _ = tx.send(to_line(&Response::err(Value::Null, ReadError::TooLarge.rpc())));
                break;
            }
            Err(ReadError::Bad(e)) => Response::err(Value::Null, e),
        };
        // Blocking is fine here: it only ever stalls this client's own reader.
        if tx.send(to_line(&reply)).is_err() {
            break;
        }
    }
    server.hub.remove(conn);
    drop(tx);
    let _ = writer.join();
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::rpc::auth::{Caller, Children};
    use crate::rpc::transport::UnixTransport;
    use std::io::{BufRead, Write};
    use std::os::unix::net::UnixStream;

    // Echoes like every other stub method, unless given a real queue to write.
    #[derive(Default)]
    pub struct StubBackend {
        pub autopilot: Option<AutopilotStore>,
        pub asks: Option<Arc<crate::rpc::asks::Asks>>,
    }

    // A chat session with this id is treated as a worker.
    pub const WORKER: &str = "worker";

    impl Backend for StubBackend {
        fn kind(&self, principal: &Principal) -> CallerKind {
            match principal {
                Principal::Session(Caller::Chat(id)) if id == WORKER => CallerKind::Worker,
                other => CallerKind::of(other),
            }
        }
        fn sessions_list(&self, p: ListParams) -> Result<Value, RpcError> {
            Ok(json!([{ "id": "s1", "limit": p.limit }]))
        }
        fn projects_list(&self) -> Result<Value, RpcError> {
            Ok(json!({ "spaces": [], "topics": [] }))
        }
        fn session_tail(&self, p: TailParams) -> Result<Value, RpcError> {
            Ok(json!([{ "id": p.id }]))
        }
        fn session_history(&self, p: HistoryParams) -> Result<Value, RpcError> {
            Ok(json!({ "events": [], "next": p.before }))
        }
        fn session_interrupt(&self, _: &Principal, p: InterruptParams) -> Result<Value, RpcError> {
            Ok(json!({ "interrupted": p.id }))
        }
        fn caller(&self, principal: &Principal) -> Result<Value, RpcError> {
            Ok(match principal {
                Principal::Local => json!({ "caller": null }),
                Principal::Session(caller) => json!({ "caller": caller }),
                Principal::Device(id) => json!({ "caller": { "kind": "device", "id": id } }),
            })
        }
        fn session_steer(&self, _: &Principal, p: SteerParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn session_wait(&self, p: WaitParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id, "state": "idle", "question": null, "last": null }))
        }
        fn session_pending(&self, p: PendingParams) -> Result<Value, RpcError> {
            Ok(json!([{ "kind": "ask", "id": p.id }]))
        }
        fn session_answer(&self, _: &Principal, p: SessionAnswerParams) -> Result<Value, RpcError> {
            Ok(json!({ "answered": p.id }))
        }
        fn worktree_new(&self, _: &Principal, p: WorktreeParams) -> Result<Value, RpcError> {
            Ok(json!({ "branch": p.branch }))
        }
        fn checkpoints_list(&self, p: CheckpointsParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn checkpoint_diff(&self, p: CheckpointDiffParams) -> Result<Value, RpcError> {
            Ok(json!({ "turn": p.turn }))
        }
        fn checkpoint_revert(&self, _: &Principal, p: CheckpointParams) -> Result<Value, RpcError> {
            Ok(json!({ "turn": p.turn }))
        }
        fn session_spawn(&self, _: &Principal, p: SpawnParams) -> Result<Value, RpcError> {
            Ok(json!({ "folder": p.folder }))
        }
        fn window_open(&self, p: OpenParams) -> Result<Value, RpcError> {
            Ok(json!({ "path": p.path }))
        }
        fn budget(&self, _: &Principal, p: BudgetParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn ask_create(&self, _: &str, p: AskParams) -> Result<Value, RpcError> {
            Ok(json!({ "question": p.question }))
        }
        fn ask_wait(&self, p: AskWaitParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn ask_answer(&self, p: AskAnswerParams) -> Result<Value, RpcError> {
            match p.id.as_str() {
                "gone" => Err(RpcError::new(INVALID_PARAMS, format!("no ask {}, or it was already answered", p.id))),
                _ => Ok(json!({})),
            }
        }
        fn issues_assigned(&self, _: &Principal, p: IssuesAssignedParams) -> Result<Value, RpcError> {
            Ok(json!({ "project": p.project }))
        }
        fn issue_get(&self, _: &Principal, p: IssueGetParams) -> Result<Value, RpcError> {
            Ok(json!({ "key": p.key }))
        }
        fn issue_link_branch(&self, _: &Principal, p: LinkBranchParams) -> Result<Value, RpcError> {
            Ok(json!({ "branch": p.branch }))
        }
        fn pr_get(&self, _: &Principal, p: PrGetParams) -> Result<Value, RpcError> {
            Ok(json!({ "key": p.key }))
        }
        fn pr_create(&self, _: &Principal, p: PrCreateParams) -> Result<Value, RpcError> {
            Ok(json!({ "head": p.head }))
        }
        fn review_submit(&self, _: &Principal, p: ReviewSubmitParams) -> Result<Value, RpcError> {
            Ok(json!({ "number": p.number }))
        }
        fn pr_merge(&self, _: &Principal, p: PrMergeParams) -> Result<Value, RpcError> {
            Ok(json!({ "number": p.number }))
        }
        fn autopilot_state(&self) -> Result<Value, RpcError> {
            match &self.autopilot {
                Some(store) => {
                    let holds = self.asks.as_ref().map(|asks| asks.holds()).unwrap_or_default();
                    autopilot_state(store, holds, |_| Observed::default())
                }
                None => Ok(json!({ "items": [], "projects": {} })),
            }
        }
        fn autopilot_item_update(&self, _: &Principal, p: ItemUpdateParams) -> Result<Value, RpcError> {
            match &self.autopilot {
                Some(store) => {
                    let project = p.project.clone();
                    p.apply(store, project)
                }
                None => Ok(json!({ "id": p.id })),
            }
        }
        fn autopilot_project_set(&self, _: &Principal, p: ProjectSetParams) -> Result<Value, RpcError> {
            match &self.autopilot {
                Some(store) => {
                    let project = p.project.clone().unwrap_or_default();
                    p.apply(store, project)
                }
                None => Ok(json!({ "project": p.project })),
            }
        }
        fn autopilot_hold_resolve(&self, p: HoldResolveParams) -> Result<Value, RpcError> {
            match &self.asks {
                Some(asks) => hold_resolve(asks, &p.id),
                None => Ok(json!({ "id": p.id })),
            }
        }
        fn autopilot_start(&self) -> Result<Value, RpcError> {
            Ok(json!({ "state": "starting" }))
        }
        fn autopilot_stop(&self) -> Result<Value, RpcError> {
            Ok(json!({ "state": "off" }))
        }
        fn device_mint(&self, p: MintParams) -> Result<Value, RpcError> {
            Ok(json!({ "name": p.name }))
        }
    }

    pub struct Running {
        pub transport: Arc<UnixTransport>,
        pub hub: Arc<Hub>,
        pub children: Arc<Children>,
    }

    impl Drop for Running {
        fn drop(&mut self) {
            self.transport.shutdown();
        }
    }

    pub fn start(timeout: Duration) -> Running {
        let transport = Arc::new(UnixTransport::bind().unwrap());
        let hub = Arc::new(Hub::default());
        let children = Arc::new(Children::default());
        let server = Arc::new(Server { hub: hub.clone(), backend: Box::<StubBackend>::default(), auth_timeout: timeout });
        let credential = Arc::new(Credential::Local { process: "tok".into(), children: children.clone() });
        serve(transport.clone(), credential, server);
        Running { transport, hub, children }
    }

    pub struct Client {
        out: UnixStream,
        input: BufReader<UnixStream>,
    }

    impl Client {
        pub fn connect(r: &Running) -> Self {
            let out = UnixStream::connect(r.transport.sock_path()).unwrap();
            out.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let input = BufReader::new(out.try_clone().unwrap());
            Self { out, input }
        }
        pub fn send(&mut self, v: Value) {
            self.out.write_all(format!("{v}\n").as_bytes()).unwrap();
        }
        pub fn send_raw(&mut self, raw: &str) {
            self.out.write_all(raw.as_bytes()).unwrap();
        }
        /// The next line, or `None` once the server has closed.
        pub fn recv(&mut self) -> Option<Value> {
            let mut line = String::new();
            match self.input.read_line(&mut line) {
                Ok(0) | Err(_) => None,
                Ok(_) => Some(serde_json::from_str(&line).unwrap()),
            }
        }
        pub fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
            self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
            self.recv().expect("a reply")
        }
    }

    fn authed(r: &Running) -> Client {
        let mut c = Client::connect(r);
        let ok = c.call(0, "auth", json!({"token": "tok"}));
        assert_eq!(ok["result"], json!({}), "{ok}");
        c
    }

    fn refused(c: &mut Client) {
        let reply = c.recv().expect("an error before the close");
        assert_eq!(reply["error"]["code"], json!(UNAUTHORIZED), "{reply}");
        assert!(c.recv().is_none(), "then the connection closes");
    }

    #[test]
    fn a_correct_token_allows_the_next_call() {
        let r = start(AUTH_TIMEOUT);
        let mut c = authed(&r);
        assert_eq!(c.call(1, "sessions.list", json!({"limit": 3}))["result"], json!([{"id": "s1", "limit": 3}]));
        assert_eq!(c.call(2, "session.tail", json!({"id": "s9", "agent": "claude"}))["result"], json!([{"id": "s9"}]));
    }

    #[test]
    fn each_connection_keeps_the_caller_its_token_was_minted_for() {
        let r = start(AUTH_TIMEOUT);
        let tab = r.children.mint(Caller::Terminal("t1".into()));
        let chat = r.children.mint(Caller::Chat("s1".into()));
        let as_caller = |token: &str| {
            let mut c = Client::connect(&r);
            assert_eq!(c.call(0, "auth", json!({ "token": token }))["result"], json!({}));
            c.call(1, "caller", Value::Null)["result"].clone()
        };
        assert_eq!(as_caller(&tab), json!({"caller": {"kind": "terminal", "id": "t1"}, "kind": "terminal"}));
        assert_eq!(as_caller(&chat), json!({"caller": {"kind": "chat", "id": "s1"}, "kind": "chat"}));
        assert_eq!(as_caller("tok"), json!({"caller": null, "kind": "local"}));

        r.children.revoke_token(&tab);
        let mut c = Client::connect(&r);
        c.send(json!({"jsonrpc": "2.0", "id": 0, "method": "auth", "params": {"token": tab}}));
        refused(&mut c);
    }

    #[test]
    fn wrong_or_missing_tokens_and_a_non_auth_first_frame_are_closed() {
        let r = start(AUTH_TIMEOUT);
        for first in [
            json!({"jsonrpc": "2.0", "id": 0, "method": "auth", "params": {"token": "nope"}}),
            json!({"jsonrpc": "2.0", "id": 0, "method": "auth", "params": {}}),
            json!({"jsonrpc": "2.0", "id": 0, "method": "sessions.list", "params": {"token": "tok"}}),
        ] {
            let mut c = Client::connect(&r);
            c.send(first);
            refused(&mut c);
        }
    }

    #[test]
    fn a_silent_client_is_closed_after_the_timeout() {
        let r = start(Duration::from_millis(100));
        let mut c = Client::connect(&r);
        refused(&mut c);
    }

    #[test]
    fn unknown_methods_bad_params_and_malformed_lines_answer_without_closing() {
        let r = start(AUTH_TIMEOUT);
        let mut c = authed(&r);
        assert_eq!(c.call(1, "nope", json!({}))["error"]["code"], json!(METHOD_NOT_FOUND));
        assert_eq!(c.call(2, "session.tail", json!({"id": 1}))["error"]["code"], json!(INVALID_PARAMS));
        assert_eq!(c.call(3, "subscribe", json!({"topic": "topics"}))["error"]["code"], json!(INVALID_PARAMS));
        c.send_raw("not json\n");
        assert_eq!(c.recv().unwrap()["error"]["code"], json!(crate::rpc::frame::PARSE_ERROR));
        assert_eq!(c.call(4, "sessions.list", Value::Null)["result"][0]["id"], json!("s1"));
    }

    fn stub_server() -> Server {
        Server {
            hub: Arc::default(),
            backend: Box::<StubBackend>::default(),
            auth_timeout: AUTH_TIMEOUT,
        }
    }

    fn request(method: &str, params: Value) -> Request {
        serde_json::from_value(json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})).unwrap()
    }

    #[test]
    fn every_spawn_param_is_optional_and_described() {
        let schema = schemars::schema_for!(SpawnParams).to_value();
        let properties = schema["properties"].as_object().unwrap();
        assert_eq!(properties.len(), 11);
        for (name, field) in properties {
            assert!(field["description"].as_str().is_some_and(|d| !d.is_empty()), "{name} has no description");
        }
        assert!(schema["required"].as_array().is_none_or(|r| r.is_empty()), "{schema}");
    }

    // Params built from each row's own schema, so a row added later is covered
    // without touching this test.
    #[test]
    fn every_row_dispatches_to_the_backend() {
        let server = stub_server();
        for method in table::METHODS {
            let schema = (method.params)().to_value();
            let mut sample = serde_json::Map::new();
            for field in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                let property = &schema["properties"][field];
                let referenced = property["$ref"].as_str().and_then(|r| r.strip_prefix("#/$defs/")).map(|name| &schema["$defs"][name]);
                if let Some(first) = referenced.and_then(|def| def["enum"].get(0)) {
                    sample.insert(field.to_string(), first.clone());
                    continue;
                }
                let value = match property["type"].as_str() {
                    Some("integer") => json!(1),
                    Some("array") => json!([]),
                    Some("boolean") => json!(false),
                    _ => json!("x"),
                };
                sample.insert(field.to_string(), value);
            }
            let principal = match method.callers[0] {
                CallerKind::Local => Principal::Local,
                CallerKind::Terminal => Principal::Session(Caller::Terminal("t1".into())),
                CallerKind::Chat | CallerKind::Worker => Principal::Session(Caller::Chat("s1".into())),
                CallerKind::Device => Principal::Device("d1".into()),
            };
            let outcome = server.dispatch(0, &principal, &request(method.name, Value::Object(sample)));
            assert!(outcome.is_ok(), "{}: {outcome:?}", method.name);
        }
    }

    #[test]
    fn the_dispatcher_refuses_a_caller_kind_the_row_leaves_out() {
        let server = stub_server();
        let tab = Principal::Session(Caller::Terminal("t1".into()));
        let err = server.dispatch(0, &tab, &request("ask.create", json!({"question": "q"}))).unwrap_err();
        assert_eq!(err.code, REFUSED);
        assert!(err.message.contains("terminal") && err.message.contains("ask.create"), "{}", err.message);
        let chat = Principal::Session(Caller::Chat("s1".into()));
        assert!(server.dispatch(0, &chat, &request("ask.create", json!({"question": "q"}))).is_ok());
    }

    #[test]
    fn session_answer_is_refused_to_a_worker_a_shell_and_a_terminal() {
        let server = stub_server();
        let answer = || request("session.answer", json!({"session": "w1", "id": "toolu_1", "answer": "allow"}));
        for caller in [
            Principal::Session(Caller::Chat(WORKER.into())),
            Principal::Local,
            Principal::Session(Caller::Terminal("t1".into())),
        ] {
            let err = server.dispatch(0, &caller, &answer()).unwrap_err();
            assert_eq!(err.code, REFUSED, "{caller:?}");
            assert!(err.message.contains("only the session that spawned"), "{}", err.message);
        }
        assert!(server.dispatch(0, &Principal::Session(Caller::Chat("s1".into())), &answer()).is_ok());
        let each = request("session.answer", json!({"session": "w1", "id": "toolu_1", "answer": ["a", "b"]}));
        assert!(server.dispatch(0, &Principal::Session(Caller::Chat("s1".into())), &each).is_ok());
    }

    #[test]
    fn an_ask_is_answered_once_and_never_by_a_worker() {
        let server = stub_server();
        let answer = |who: &Principal, id: &str| server.dispatch(0, who, &request("ask.answer", json!({"id": id, "answer": "yes"})));
        assert!(answer(&Principal::Local, "open").is_ok());
        assert_eq!(answer(&Principal::Local, "gone").unwrap_err().code, INVALID_PARAMS);
        let worker = Principal::Session(Caller::Chat(WORKER.into()));
        assert_eq!(answer(&worker, "open").unwrap_err().code, REFUSED);
    }

    #[test]
    fn a_worker_is_refused_spawn_and_steer_but_may_ask() {
        let server = stub_server();
        let worker = Principal::Session(Caller::Chat(WORKER.into()));
        for (method, params) in [("session.spawn", json!({})), ("session.steer", json!({"id": "s1", "text": "hi"}))] {
            let err = server.dispatch(0, &worker, &request(method, params)).unwrap_err();
            assert_eq!(err.code, REFUSED, "{method}");
            assert!(err.message.contains(table::WORKER_REFUSAL), "{method}: {}", err.message);
        }
        let link = request("issues.link_branch", json!({"key": "1", "branch": "1-x"}));
        assert_eq!(server.dispatch(0, &worker, &link).unwrap_err().code, REFUSED);
        let me = server.dispatch(0, &worker, &request("caller", Value::Null)).unwrap();
        assert_eq!(me["kind"], json!("worker"));
        assert!(server.dispatch(0, &worker, &request("ask.create", json!({"question": "q"}))).is_ok());
        assert!(server.dispatch(0, &worker, &request("ask.wait", json!({"id": "a1"}))).is_ok());
    }

    #[test]
    fn a_device_reads_and_drives_chats_and_nothing_else() {
        let open: Vec<&str> = table::METHODS.iter().filter(|m| m.callers.contains(&CallerKind::Device)).map(|m| m.name).collect();
        assert_eq!(
            open,
            [
                "sessions.list",
                "session.tail",
                "caller",
                "session.history",
                "session.interrupt",
                "session.steer",
                "session.pending",
                "ask.answer",
                "projects.list",
            ]
        );
        let server = stub_server();
        let device = Principal::Device("d1".into());
        let err = server.dispatch(0, &device, &request("session.spawn", json!({}))).unwrap_err();
        assert_eq!(err.code, REFUSED);
        assert!(err.message.contains("device"), "{}", err.message);
        assert_eq!(server.dispatch(0, &device, &request("caller", Value::Null)).unwrap()["kind"], json!("device"));
    }

    #[test]
    fn a_device_subscribes_to_sessions_and_chats_only() {
        let server = stub_server();
        let device = Principal::Device("d1".into());
        let subscribe = |topic: &str| server.dispatch(0, &device, &request("subscribe", json!({ "topic": topic })));
        assert!(subscribe("sessions").is_ok());
        assert!(subscribe("session:s1").is_ok());
        assert!(subscribe("chat:s1").is_ok());
        for topic in ["autopilot", "accounts"] {
            assert_eq!(subscribe(topic).unwrap_err().code, REFUSED, "{topic}");
        }
        assert!(server.dispatch(0, &Principal::Local, &request("subscribe", json!({"topic": "autopilot"}))).is_ok());
    }

    #[test]
    fn only_a_device_or_a_local_client_reads_a_chat_stream() {
        let server = stub_server();
        let chat = || request("subscribe", json!({ "topic": "chat:s1" }));
        assert!(server.dispatch(0, &Principal::Local, &chat()).is_ok());
        for caller in [
            Principal::Session(Caller::Chat("s2".into())),
            Principal::Session(Caller::Chat(WORKER.into())),
            Principal::Session(Caller::Terminal("t1".into())),
        ] {
            assert_eq!(server.dispatch(0, &caller, &chat()).unwrap_err().code, REFUSED, "{caller:?}");
        }
    }

    #[test]
    fn the_writer_sends_replies_before_a_queued_chat_stream() {
        let hub = Hub::default();
        let (tx, rx) = sync_channel(QUEUE_CAP);
        let conn = hub.register(tx.clone(), Box::new(|| {}));
        hub.subscribe(conn, Channel::Chat("s1".into()));
        let chat = hub.chat_outbox(conn).unwrap();
        hub.publish(&Channel::Chat("s1".into()), json!({ "n": 1 }));
        hub.publish(&Channel::Chat("s1".into()), json!({ "n": 2 }));
        tx.send("reply".into()).unwrap();

        let mut written = Vec::new();
        drain(&rx, &chat, |line| {
            written.push(line.to_string());
            written.len() < 3
        });
        assert_eq!(written[0], "reply", "the reply overtakes the stream queued before it");
        let chat_lines: Vec<Value> = written[1..].iter().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(chat_lines.iter().map(|l| l["params"]["data"]["n"].clone()).collect::<Vec<_>>(), [json!(1), json!(2)]);
    }

    #[test]
    fn only_a_local_caller_mints_a_device() {
        let server = stub_server();
        let mint = || request("device.mint", json!({"name": "phone"}));
        assert!(server.dispatch(0, &Principal::Local, &mint()).is_ok());
        for caller in [
            Principal::Session(Caller::Terminal("t1".into())),
            Principal::Session(Caller::Chat("s1".into())),
            Principal::Device("d1".into()),
        ] {
            assert_eq!(server.dispatch(0, &caller, &mint()).unwrap_err().code, REFUSED, "{caller:?}");
        }
    }

    #[test]
    fn an_item_update_without_an_id_makes_one_open_item_per_source() {
        let dir = crate::autopilot::tests::temp_dir("dispatch-upsert");
        let store = AutopilotStore::open(dir.clone(), Box::new(|_| {}));
        let server = Server { backend: Box::new(StubBackend { autopilot: Some(store), ..StubBackend::default() }), ..stub_server() };
        let update = |who: &Principal, params: Value| server.dispatch(0, who, &request("autopilot.item.update", params));
        let key = json!({"kind": "ship", "source": {"type": "issue", "key": "12", "project": "/p"}, "project": "/p"});
        let first = update(&Principal::Local, key.clone()).unwrap();
        assert_eq!(update(&Principal::Local, key.clone()).unwrap()["id"], first["id"], "a retry finds the item it made");
        assert_eq!(update(&Principal::Local, json!({"id": first["id"], "state": "failed"})).unwrap()["state"], "failed");
        let fresh = update(&Principal::Local, key).unwrap();
        assert_ne!(fresh["id"], first["id"], "a failed item is closed, so the same source opens a new one");
        assert_eq!(update(&Principal::Local, json!({"id": first["id"], "project": "/p"})).unwrap_err().code, INVALID_PARAMS);
        let worker = Principal::Session(Caller::Chat(WORKER.into()));
        assert_eq!(update(&worker, json!({"id": fresh["id"], "state": "done"})).unwrap_err().code, REFUSED);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_resolved_hold_is_withdrawn_never_approved_and_state_shows_the_open_ones() {
        use crate::rpc::approvals::{Approval, Draft, APPROVE};
        use crate::rpc::asks::{Asks, By, Waited, WITHDRAWN};
        let dir = crate::autopilot::tests::temp_dir("dispatch-holds");
        let asks = Arc::new(Asks::with_holds(dir.join("holds.json"), Box::new(|_| {})));
        let store = AutopilotStore::open(dir.clone(), Box::new(|_| {}));
        let server = Server { backend: Box::new(StubBackend { autopilot: Some(store), asks: Some(asks.clone()) }), ..stub_server() };
        let draft = Draft::PrMerge { number: 7, method: crate::forge::MergeMethod::Squash, head_sha: "abc".into() };
        let ask = |item: &str| {
            let approval = Some(Approval { project: "/p".into(), draft: draft.clone() });
            asks.create("s1".into(), "merge?".into(), vec![], approval, None, Some(item.into())).id
        };
        let open = ask("item-1");
        let approved = ask("item-2");
        asks.answer(&approved, APPROVE.into(), By::User).unwrap();

        let state = server.dispatch(0, &Principal::Local, &request("autopilot.state", json!({}))).unwrap();
        assert_eq!(state["holds"].as_array().map(Vec::len), Some(2));

        let resolve = |id: &str| server.dispatch(0, &Principal::Local, &request("autopilot.hold.resolve", json!({ "id": id })));
        for id in [&open, &approved] {
            let resolved = resolve(id).unwrap();
            assert_eq!(resolved["answer"], WITHDRAWN);
            assert!(resolved.get("approval_id").is_none(), "{resolved}");
            assert_eq!(asks.wait(id, Duration::ZERO), Waited::Answered { answer: WITHDRAWN.into(), approval_id: None }, "an unread grant goes too");
        }
        assert!(asks.holds().is_empty());
        assert_eq!(resolve(&open).unwrap_err().code, INVALID_PARAMS, "a hold is withdrawn once");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_diff_range_ending_before_it_starts_is_refused() {
        let server = stub_server();
        let diff = |params| server.dispatch(0, &Principal::Local, &request("checkpoint.diff", params));
        assert_eq!(diff(json!({"id": "s1", "turn": 3, "to": 2})).unwrap_err().code, INVALID_PARAMS);
        assert!(diff(json!({"id": "s1", "turn": 2, "to": 3})).is_ok());
        assert!(diff(json!({"id": "s1", "turn": 2})).is_ok());
    }

    #[test]
    fn a_subscriber_gets_events_and_a_disconnect_clears_it() {
        let r = start(AUTH_TIMEOUT);
        let mut c = authed(&r);
        assert_eq!(c.call(1, "subscribe", json!({"topic": "sessions"}))["result"], json!({}));
        r.hub.publish(&Channel::Sessions, json!({"kind": "session.started", "id": "s1"}));
        let event = c.recv().unwrap();
        assert_eq!(event["method"], json!("event"));
        assert_eq!(event["params"]["data"]["id"], json!("s1"));

        drop(c);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while r.hub.subscriptions() > 0 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(r.hub.subscriptions(), 0);
    }

    #[test]
    fn a_chat_stream_reaches_its_subscriber_and_a_reply_still_follows() {
        let r = start(AUTH_TIMEOUT);
        let mut c = authed(&r);
        assert_eq!(c.call(1, "subscribe", json!({"topic": "chat:s1"}))["result"], json!({}));
        r.hub.publish(&Channel::Chat("s1".into()), json!({"type": "textDelta", "text": "hi"}));
        let event = c.recv().unwrap();
        assert_eq!(event["params"]["topic"], json!("chat:s1"));
        assert_eq!(event["params"]["data"]["text"], json!("hi"));
        assert_eq!(c.call(2, "sessions.list", json!({"limit": 1}))["result"], json!([{"id": "s1", "limit": 1}]));
    }

    // Revokes the device while the auth reply is on its way, the one moment
    // before the connection is registered where a revoke has nothing to close.
    struct RevokeOnReply {
        inner: UnixStream,
        revoke: Arc<dyn Fn() + Send + Sync>,
    }

    impl std::io::Read for RevokeOnReply {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.inner.read(buf)
        }
    }

    impl Write for RevokeOnReply {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            (self.revoke)();
            self.inner.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.inner.flush()
        }
    }

    impl Stream for RevokeOnReply {
        fn try_clone_box(&self) -> std::io::Result<Box<dyn Stream>> {
            Ok(Box::new(RevokeOnReply { inner: self.inner.try_clone()?, revoke: self.revoke.clone() }))
        }
        fn set_read_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()> {
            self.inner.set_read_timeout(timeout)
        }
        fn close(&self) {
            Stream::close(&self.inner);
        }
    }

    #[test]
    fn a_device_revoked_while_its_auth_is_answered_is_not_served() {
        use crate::rpc::devices::Devices;
        use crate::rpc::pairing::Pairing;
        use std::io::Read;

        let dir = std::env::temp_dir().join(format!("tori-server-revoke-{}-{}", std::process::id(), crate::chat::approval::random_token()));
        let devices = Arc::new(Devices::open(dir.join("devices.json")));
        let (device, secret) = devices.mint("phone").unwrap();
        let credential = Credential::Remote { devices: devices.clone(), pairing: Arc::new(Pairing::new(Box::new(|_| {}))) };
        let server = Server { hub: Default::default(), backend: Box::<StubBackend>::default(), auth_timeout: Duration::from_secs(5) };

        let (mut client, served) = UnixStream::pair().unwrap();
        let revoke = {
            let devices = devices.clone();
            Arc::new(move || {
                let _ = devices.revoke(&device.id);
            })
        };
        client.write_all(format!("{}\n", json!({"jsonrpc": "2.0", "id": 0, "method": "auth", "params": {"token": secret}})).as_bytes()).unwrap();
        let handled = thread::spawn(move || handle(&server, &credential, Box::new(RevokeOnReply { inner: served, revoke })));

        client.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut got = String::new();
        client.read_to_string(&mut got).expect("the connection is closed, not left open");
        assert!(got.contains("\"result\":{}"), "auth itself passed: {got}");
        handled.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
