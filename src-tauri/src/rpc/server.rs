//! Connection handling and dispatch, written against [`Transport`] and
//! [`Stream`] only. One thread reads a connection and one writes it; the writer
//! drains the connection's queue, which is the only thing that ever touches the
//! socket's write half after auth.

use std::io::BufReader;
use std::sync::mpsc::{sync_channel, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::approvals::Draft;
use super::auth::{authenticate, pair, Credential, Principal, PAIR_METHOD};
use super::frame::{
    read_request, to_line, write_line, ReadError, Request, Response, RpcError, INTERNAL_ERROR, INVALID_PARAMS,
    INVALID_REQUEST, METHOD_NOT_FOUND, REFUSED, UNAUTHORIZED,
};
use super::hub::{Channel, ChatOutbox, ConnId, Hub, Update, QUEUE_CAP, WAKE};
use super::table::{self, CallerKind};
use super::transport::{Stream, Transport};
use crate::autopilot::{
    Autonomy, AutopilotStore, ContractPatch, Kind, Observed, Patch, Pickup, Ships, Source, State, Target, UpdateError,
    What,
};
use crate::forge::model::{DraftComment, ReviewEvent};
use crate::forge::MergeMethod;
use crate::issues::IssueQuery;

pub const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_LOG_LIMIT: usize = 50;
pub const UNITS_GIT_MAX: usize = 64;

#[derive(Debug, Default, Serialize, Deserialize, JsonSchema)]
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
    /// Files sent with it, as the agent's first message would carry them. The browser's must be paths
    /// `attachment.write` answered.
    pub attach: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AttachmentWriteParams {
    /// The file's name, as the agent will see it.
    pub name: String,
    /// One chunk of the file, base64, at most 192 KB of it.
    pub data: String,
    /// The id the first chunk answered; left out on the first.
    pub upload: Option<String>,
    /// This chunk ends the file: the answer is its path.
    #[serde(default)]
    pub last: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DraftParams {
    /// The draft's text, left in the composer for the person to read and send.
    pub text: String,
    /// Files offered with it as chips: paths `attachment.write` answered.
    #[serde(default)]
    pub attach: Vec<String>,
    /// The worktree the draft opens in. Set from the browser tab, whatever the caller sends.
    #[serde(default)]
    pub folder: String,
    /// Only ask whether a draft could open now, so files are not uploaded for a window that is not there.
    #[serde(default)]
    pub check: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RevealParams {
    /// The chat session to bring forward in Tori's window.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InfoParams {
    /// The live chat session.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelParams {
    /// The live chat session to switch.
    pub id: String,
    /// A `value` from `session.info`'s models.
    pub model: String,
    /// An effort level the model lists.
    pub effort: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModeParams {
    /// The live chat session to switch.
    pub id: String,
    /// An `id` from `session.info`'s modes.
    pub mode: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PortParams {
    /// A port listening on localhost.
    pub port: u16,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SetupParams {
    /// The tab's port, which says which app of the worktree the page is.
    pub port: u16,
    /// The worktree. Set from the browser tab, whatever the caller sends.
    #[serde(default)]
    pub folder: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectIconParams {
    /// A project's `path` from `projects.list`.
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SyncRow {
    /// A unit's folder.
    pub path: String,
    /// The branch it shows.
    pub branch: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UnitsSyncParams {
    /// The units to read, at most 64.
    pub units: Vec<SyncRow>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UnitsPrParams {
    /// A project's `path` from `projects.list`.
    pub project: String,
    /// The branches to report on, most wanted first.
    pub branches: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UnitsGitParams {
    /// The worktree folders to count, at most 64.
    pub folders: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewMarkParams {
    /// The session to mark reviewed, an `id` from `review.list`.
    pub id: String,
    /// The row's `toTs`: the latest prompt the reviewer saw.
    pub to_ts: u64,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NeedsYouSeenParams {
    /// A session whose finished turns you have now seen.
    pub session: Option<String>,
    /// A folder whose pull request rows you have now seen.
    pub folder: Option<String>,
    /// Narrows `folder` to one branch, for a plain repo whose branches share it.
    pub branch: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DigestParams {
    /// Epoch ms to read from, so an open digest keeps the start it opened
    /// with. Defaults to when the person last saw it.
    pub since: Option<u64>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DigestLookedParams {
    /// The `asOf` of the digest the person saw, epoch ms.
    pub at: u64,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LogParams {
    /// At most this many entries, the last ones (default 50).
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WaitParams {
    /// The session to wait on.
    pub id: String,
    /// Seconds to wait for it to stop working before answering anyway (default 60).
    pub timeout: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HandoffParams {
    /// The live chat session to hand over.
    pub id: String,
    /// The agent id the new session runs.
    pub to: String,
    /// The account the new session runs on, the project contract's when left out.
    pub account: Option<String>,
    /// The model the new session opens on.
    pub model: Option<String>,
    /// A line for the new session, added to the brief.
    pub note: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckParams {
    /// The session whose work to check.
    pub id: String,
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
    /// The session that is waiting: one you spawned, or any for a paired device.
    pub session: String,
    /// The id `session.pending` gave the question or permission prompt.
    pub id: String,
    /// `allow` or `deny` for a permission. For a question, an option's label or your own words, as a list with
    /// one answer per question when it asks several.
    pub answer: Answer,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PromptRef {
    /// The session the permission prompt waits in.
    pub session: String,
    /// The prompt's id, as `permissions.pending` gave it.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AllowGroupParams {
    /// The prompts the person saw in the group. Only these are answered, and one already answered or gone is skipped.
    pub ids: Vec<PromptRef>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorktreeParams {
    /// The new branch, created in a new worktree. Left out with `pr`, which names it after the pull request.
    #[serde(default)]
    pub branch: String,
    /// The project folder, the caller's own project when left out.
    pub project: Option<String>,
    /// The ref the new branch starts from.
    pub from: Option<String>,
    /// The issue the branch is for, remembered on the unit it makes.
    pub issue: Option<String>,
    /// A pull request to review: its head is fetched from the forge's PR ref, forks included, onto a local
    /// branch named like the pull request's own, or `pr-<number>` for a fork or a name already in use here.
    /// A worktree already at another commit is refused, never reset.
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
pub struct PrWatchParams {
    /// The pull request's number, or its URL.
    pub key: String,
    /// The project folder. Left out, a URL key names the local project whose origin is that repo, else the
    /// caller's own project.
    pub project: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PrGetParams {
    /// The pull request's number, or its URL.
    pub key: String,
    /// The project folder. Left out, a URL key names the local project whose origin is that repo, else the
    /// caller's own project.
    pub project: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PrCheckLogParams {
    /// The pull request's number, or its URL.
    pub key: String,
    /// The failed check run's id, as a check_failed wake names it.
    pub run_id: u64,
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
    /// Also say, per hunk, which turn and tool call wrote it.
    pub why: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProvenanceParams {
    /// The worktree the file is in.
    pub folder: String,
    /// The file, relative to the folder.
    pub file: String,
    /// Each hunk as its blocks of changed lines on the working tree side: a start line and a line count, a count of 0 being a deletion after that line.
    pub hunks: Vec<Vec<crate::provenance::Span>>,
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
    /// The model it opens on, the project contract's when left out, else the
    /// calling chat's own when the agent is the caller's.
    pub model: Option<String>,
    /// The permission mode it opens on, the calling chat's own when left out and
    /// the agent is the caller's.
    pub mode: Option<String>,
    /// The effort level it opens on.
    pub effort: Option<String>,
    /// The autopilot item this worker is for. Refused when that item is already past its spend ceiling.
    pub item: Option<String>,
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
    /// An autopilot item whose sessions' spend to report as well.
    pub item: Option<String>,
    /// A pull request, by number or URL, whose head branch's spend to report as well.
    pub pr: Option<String>,
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
pub struct TopicPromoteParams {
    /// The member to give a worktree: its name, its repository, or the folder it reads from.
    pub member: String,
    /// Seconds to wait for the user when the Topic asks first; unanswered by then, the question is withdrawn.
    pub timeout: Option<u64>,
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
        Draft::PrMerge {
            number: self.number,
            method: self.method,
            head_sha: self.head_sha.clone(),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PrPushParams {
    /// The pull request's number.
    pub number: u64,
    /// Its head branch on origin.
    pub head: String,
    /// The commit to push, from any worktree of the project; never forced.
    pub head_sha: String,
    /// The project folder, the caller's own project when left out.
    pub project: Option<String>,
    /// The approval `ask.create` returned for exactly this call; a background session is refused without one.
    pub approval_id: Option<String>,
}

impl PrPushParams {
    pub fn draft(&self) -> Draft {
        Draft::PrPush {
            number: self.number,
            head: self.head.clone(),
            head_sha: self.head_sha.clone(),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LoopParams {
    /// The project the items are queued in, the caller's own when left out.
    pub project: Option<String>,
    /// The task for each entry; `{item}` is replaced by the entry, else the entry is appended.
    pub prompt: String,
    /// One ship item per entry.
    pub entries: Vec<String>,
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
    /// A dollar ceiling for this item alone, over its project's. Its workers get no new turn once their sessions
    /// have spent it. An ACP worker reports no cost, so it never reaches one.
    pub item_usd: Option<f64>,
}

impl ItemUpdateParams {
    /// `project` is the one resolved for a new item; with an id it must be left out. `origin` is that
    /// project's `owner/name`, which an issue key is read against.
    pub fn apply(self, store: &AutopilotStore, project: Option<String>, origin: String) -> Result<Value, RpcError> {
        let target = match (self.id, self.kind, self.source, project) {
            (Some(id), None, None, None) => Target::Id(id),
            (Some(_), ..) => {
                return Err(RpcError::new(
                    INVALID_PARAMS,
                    "kind, source and project name a new item: with an id pass only what changes",
                ))
            }
            (None, Some(kind), Some(source), Some(project)) => Target::Key {
                kind,
                source,
                project,
                origin,
            },
            (None, ..) => {
                return Err(RpcError::new(
                    INVALID_PARAMS,
                    "without an id, pass kind, source and project",
                ))
            }
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
            item_usd: self.item_usd,
        };
        let item = store.update(target, patch).map_err(update_error)?;
        serde_json::to_value(item).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
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
    /// Where the project's issues come from, replacing the list before. Empty, it is the issues assigned to you
    /// in the project's own repo.
    pub issues: Option<Vec<IssueQuery>>,
    /// A dollar ceiling each item inherits, over the global `budgets.itemUsd`. Its workers get no new turn once
    /// their sessions have spent it. An ACP worker reports no cost, so it never reaches one.
    pub item_usd: Option<f64>,
}

impl ProjectSetParams {
    pub fn apply(self, store: &AutopilotStore, project: String) -> Result<Value, RpcError> {
        for query in self.issues.iter().flatten() {
            query.check().map_err(|e| RpcError::new(INVALID_PARAMS, e))?;
        }
        let patch = ContractPatch {
            ships: self.ships,
            autonomy: self.autonomy,
            pickup: self.pickup,
            agent: self.agent,
            account: self.account,
            model: self.model,
            issues: self.issues,
            item_usd: self.item_usd,
        };
        let contract = store
            .set_project(project, patch)
            .map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))?;
        serde_json::to_value(contract).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
    }
}

pub fn autopilot_state(
    store: &AutopilotStore,
    holds: Vec<super::asks::Hold>,
    observe: impl FnOnce(&[crate::autopilot::Item]) -> Observed,
) -> Result<Value, RpcError> {
    let mut state =
        serde_json::to_value(store.state(observe)).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))?;
    state["holds"] = json!(holds);
    Ok(state)
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HoldResolveParams {
    /// The ask id of the hold.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScheduleAddParams {
    /// The project folder, the caller's own project when left out.
    pub project: Option<String>,
    /// What the schedule is called wherever its runs are named.
    pub name: String,
    /// When it fires: five cron fields in the Mac's local time, `0 7 * * 1-5` for weekdays at 7.
    pub cron: String,
    /// What each run does, in words. Pass this or `issue`.
    pub prompt: Option<String>,
    /// The issue each run works on. Pass this or `prompt`.
    pub issue: Option<String>,
}

impl ScheduleAddParams {
    pub fn apply(self, store: &AutopilotStore, project: String, origin: &str) -> Result<Value, RpcError> {
        let name = self.name.trim();
        if name.is_empty() {
            return Err(RpcError::new(INVALID_PARAMS, "name the schedule"));
        }
        crate::autopilot::schedules::parse(&self.cron).map_err(|e| RpcError::new(INVALID_PARAMS, e))?;
        let given = |v: Option<String>| v.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let what = match (given(self.prompt), given(self.issue)) {
            (Some(text), None) => What::Prompt { text },
            (None, Some(key)) => What::Issue {
                key: crate::issues::canonical_key(&key, origin),
            },
            _ => {
                return Err(RpcError::new(
                    INVALID_PARAMS,
                    "pass a prompt or an issue, one of the two",
                ))
            }
        };
        let row = store
            .add_schedule(project, name.to_string(), self.cron.trim().to_string(), what)
            .map_err(update_error)?;
        Ok(json!(row))
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScheduleIdParams {
    /// The schedule's id.
    pub id: String,
}

pub fn update_error(e: UpdateError) -> RpcError {
    match e {
        UpdateError::NoItem(_) | UpdateError::NoSchedule(_) => RpcError::new(INVALID_PARAMS, e.to_string()),
        UpdateError::Write(_) => RpcError::new(INTERNAL_ERROR, e.to_string()),
    }
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
    fn project_icon(&self, params: ProjectIconParams) -> Result<Value, RpcError>;
    fn ports_list(&self) -> Result<Value, RpcError>;
    fn worktree_at(&self, params: PortParams) -> Result<Value, RpcError>;
    fn session_tail(&self, params: TailParams) -> Result<Value, RpcError>;
    fn session_history(&self, params: HistoryParams) -> Result<Value, RpcError>;
    fn session_interrupt(&self, principal: &Principal, params: InterruptParams) -> Result<Value, RpcError>;
    fn caller(&self, principal: &Principal) -> Result<Value, RpcError>;
    fn session_steer(&self, principal: &Principal, params: SteerParams) -> Result<Value, RpcError>;
    fn session_wait(&self, params: WaitParams) -> Result<Value, RpcError>;
    fn session_check(&self, params: CheckParams) -> Result<Value, RpcError>;
    fn session_handoff(&self, principal: &Principal, params: HandoffParams) -> Result<Value, RpcError>;
    fn session_pending(&self, params: PendingParams) -> Result<Value, RpcError>;
    fn session_answer(&self, principal: &Principal, params: SessionAnswerParams) -> Result<Value, RpcError>;
    fn session_info(&self, params: InfoParams) -> Result<Value, RpcError>;
    fn session_model(&self, principal: &Principal, params: ModelParams) -> Result<Value, RpcError>;
    fn session_mode(&self, principal: &Principal, params: ModeParams) -> Result<Value, RpcError>;
    fn units_git(&self, params: UnitsGitParams) -> Result<Value, RpcError>;
    fn review_list(&self) -> Result<Value, RpcError>;
    fn review_mark(&self, params: ReviewMarkParams) -> Result<Value, RpcError>;
    fn permissions_pending(&self) -> Result<Value, RpcError>;
    fn permissions_allow_group(&self, params: AllowGroupParams) -> Result<Value, RpcError>;
    fn permissions_deny(&self, params: PromptRef) -> Result<Value, RpcError>;
    fn needs_you_list(&self) -> Result<Value, RpcError>;
    fn needs_you_seen(&self, params: NeedsYouSeenParams) -> Result<Value, RpcError>;
    fn digest_list(&self, params: DigestParams) -> Result<Value, RpcError>;
    fn digest_looked(&self, params: DigestLookedParams) -> Result<Value, RpcError>;
    fn radar_list(&self) -> Result<Value, RpcError>;
    fn units_sync(&self, params: UnitsSyncParams) -> Result<Value, RpcError>;
    fn units_pr(&self, params: UnitsPrParams) -> Result<Value, RpcError>;
    fn worktree_new(&self, principal: &Principal, params: WorktreeParams) -> Result<Value, RpcError>;
    fn checkpoints_list(&self, params: CheckpointsParams) -> Result<Value, RpcError>;
    fn checkpoint_diff(&self, params: CheckpointDiffParams) -> Result<Value, RpcError>;
    fn provenance_hunks(&self, params: ProvenanceParams) -> Result<Value, RpcError>;
    fn checkpoint_revert(&self, principal: &Principal, params: CheckpointParams) -> Result<Value, RpcError>;
    fn session_spawn(&self, principal: &Principal, params: SpawnParams) -> Result<Value, RpcError>;
    fn window_open(&self, params: OpenParams) -> Result<Value, RpcError>;
    fn budget(&self, principal: &Principal, params: BudgetParams) -> Result<Value, RpcError>;
    fn ask_create(&self, session: &str, params: AskParams) -> Result<Value, RpcError>;
    fn topic_member_promote(&self, session: &str, params: TopicPromoteParams) -> Result<Value, RpcError>;
    fn ask_wait(&self, params: AskWaitParams) -> Result<Value, RpcError>;
    fn ask_answer(&self, principal: &Principal, params: AskAnswerParams) -> Result<Value, RpcError>;
    fn issues_assigned(&self, principal: &Principal, params: IssuesAssignedParams) -> Result<Value, RpcError>;
    fn issue_get(&self, principal: &Principal, params: IssueGetParams) -> Result<Value, RpcError>;
    fn issue_link_branch(&self, principal: &Principal, params: LinkBranchParams) -> Result<Value, RpcError>;
    fn pr_get(&self, principal: &Principal, params: PrGetParams) -> Result<Value, RpcError>;
    fn pr_check_log(&self, principal: &Principal, params: PrCheckLogParams) -> Result<Value, RpcError>;
    fn pr_create(&self, principal: &Principal, params: PrCreateParams) -> Result<Value, RpcError>;
    fn review_submit(&self, principal: &Principal, params: ReviewSubmitParams) -> Result<Value, RpcError>;
    fn pr_merge(&self, principal: &Principal, params: PrMergeParams) -> Result<Value, RpcError>;
    fn pr_push(&self, principal: &Principal, params: PrPushParams) -> Result<Value, RpcError>;
    fn pr_watch(&self, principal: &Principal, params: PrWatchParams) -> Result<Value, RpcError>;
    fn pr_unwatch(&self, principal: &Principal, params: PrWatchParams) -> Result<Value, RpcError>;
    fn autopilot_state(&self) -> Result<Value, RpcError>;
    fn autopilot_log(&self, params: LogParams) -> Result<Value, RpcError>;
    fn autopilot_item_update(&self, principal: &Principal, params: ItemUpdateParams) -> Result<Value, RpcError>;
    fn autopilot_loop(&self, principal: &Principal, params: LoopParams) -> Result<Value, RpcError>;
    fn autopilot_project_set(&self, principal: &Principal, params: ProjectSetParams) -> Result<Value, RpcError>;
    fn autopilot_hold_resolve(&self, params: HoldResolveParams) -> Result<Value, RpcError>;
    fn autopilot_schedule_list(&self) -> Result<Value, RpcError>;
    fn autopilot_schedule_add(&self, principal: &Principal, params: ScheduleAddParams) -> Result<Value, RpcError>;
    fn autopilot_schedule_remove(&self, params: ScheduleIdParams) -> Result<Value, RpcError>;
    fn autopilot_schedule_resume(&self, params: ScheduleIdParams) -> Result<Value, RpcError>;
    fn autopilot_start(&self) -> Result<Value, RpcError>;
    fn autopilot_stop(&self) -> Result<Value, RpcError>;
    fn device_mint(&self, params: MintParams) -> Result<Value, RpcError>;
    fn browser_mint(&self) -> Result<Value, RpcError>;
    fn attachment_write(&self, params: AttachmentWriteParams) -> Result<Value, RpcError>;
    fn window_reveal(&self, params: RevealParams) -> Result<Value, RpcError>;
    fn chat_draft(&self, params: DraftParams) -> Result<Value, RpcError>;
    fn web_setup(&self, params: SetupParams) -> Result<Value, RpcError>;
    fn session_unit(&self, id: &str) -> Option<String>;
    fn folder_unit(&self, folder: &str) -> Option<String>;
    fn ask_session(&self, id: &str) -> Option<String>;
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

/// The refusals are by caller kind, so the daemon, which holds the
/// subscriptions but not the worker set, applies the same ones.
pub(super) fn subscribe(
    hub: &Hub,
    kind: CallerKind,
    conn: ConnId,
    params: &Value,
    watching_sessions: impl FnOnce(),
) -> Result<Value, RpcError> {
    let channel = channel(params)?;
    if kind == CallerKind::Browser {
        return Err(RpcError::new(
            REFUSED,
            "the browser extension subscribes to nothing yet",
        ));
    }
    if channel == Channel::Accounts && kind == CallerKind::Device {
        return Err(RpcError::new(
            REFUSED,
            "a device subscribes to sessions, session:<id>, chat:<id> and autopilot only",
        ));
    }
    // The stream is for a person watching a chat; an agent reads a session with session.tail.
    if matches!(channel, Channel::Chat(_)) && !matches!(kind, CallerKind::Device | CallerKind::Local) {
        return Err(RpcError::new(
            REFUSED,
            "chat:<id> is open to a device or a local client only",
        ));
    }
    if matches!(channel, Channel::Sessions | Channel::Session(_)) {
        watching_sessions();
    }
    hub.subscribe(conn, channel);
    Ok(json!({}))
}

pub(super) fn unsubscribe(hub: &Hub, conn: ConnId, params: &Value) -> Result<Value, RpcError> {
    hub.unsubscribe(conn, &channel(params)?);
    Ok(json!({}))
}

// Per connection rather than a method row: whether this phone is in front of
// someone belongs to the socket it arrived on.
fn visible(hub: &Hub, principal: &Principal, conn: ConnId, params: &Value) -> Result<Value, RpcError> {
    if !matches!(principal, Principal::Device(_)) {
        return Err(RpcError::new(REFUSED, "visible is for a paired device"));
    }
    let visible = params["visible"]
        .as_bool()
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "visible: a boolean"))?;
    hub.set_visible(conn, visible);
    Ok(json!({}))
}

// Off the method table: the native host reports it, and no agent has a use for it.
pub(super) fn browser_refused(hub: &Hub, principal: &Principal, params: &Value) -> Result<Value, RpcError> {
    if !matches!(principal, Principal::Browser(_)) {
        return Err(RpcError::new(
            REFUSED,
            "browser.refused is for the browser's native host",
        ));
    }
    let update = params["update"]
        .as_str()
        .and_then(Update::parse)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "update: \"extension\" or \"tori\""))?;
    hub.refuse_browser(update);
    Ok(json!({}))
}

// Off the method table so no agent sees it as a tool.
pub(super) fn browser_opened(hub: &Hub, principal: &Principal, params: &Value) -> Result<Value, RpcError> {
    if !matches!(principal, Principal::Browser(_)) {
        return Err(RpcError::new(
            REFUSED,
            "browser.opened is for the browser's native host",
        ));
    }
    let url = params["url"]
        .as_str()
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "url: the new tab's address"))?;
    Ok(json!(hub.take_opened(url, std::time::Instant::now())))
}

// Off the method table so no agent sees it as a tool.
fn shell_check(principal: &Principal, params: &Value) -> Result<Value, RpcError> {
    if !matches!(principal, Principal::Session(super::auth::Caller::Terminal(_))) {
        return Err(RpcError::new(REFUSED, "shell.check is for a terminal tab's hook"));
    }
    let session = params["session"].as_str().unwrap_or_default();
    let input = json!({ "command": params["command"] });
    Ok(json!({ "deny": crate::unattended::refuse_and_mark(session, "Bash", &input) }))
}

impl Server {
    pub fn dispatch(&self, conn: ConnId, principal: &Principal, req: &Request) -> Result<Value, RpcError> {
        match req.method.as_str() {
            "subscribe" => subscribe(&self.hub, self.backend.kind(principal), conn, &req.params, || {
                self.backend.watching_sessions()
            }),
            "unsubscribe" => unsubscribe(&self.hub, conn, &req.params),
            "visible" => visible(&self.hub, principal, conn, &req.params),
            "browser.refused" => browser_refused(&self.hub, principal, &req.params),
            "browser.opened" => browser_opened(&self.hub, principal, &req.params),
            "shell.check" => shell_check(principal, &req.params),
            "auth" => Err(RpcError::new(INVALID_REQUEST, "already authenticated")),
            _ => self.call(principal, req),
        }
    }

    /// One row of the method table, for a caller the transport already proved.
    pub fn call(&self, principal: &Principal, req: &Request) -> Result<Value, RpcError> {
        let kind = self.backend.kind(principal);
        let method = permit(&req.method, kind)?;
        if kind == CallerKind::Browser {
            return self.call_past_the_protocol_check(method, principal, req);
        }
        (method.call)(self.backend.as_ref(), principal, &req.params)
    }

    fn call_past_the_protocol_check(
        &self,
        method: &'static table::Method,
        principal: &Principal,
        req: &Request,
    ) -> Result<Value, RpcError> {
        self.hub.forget_last_refusal();
        super::scope::call(self.backend.as_ref(), method, principal, req)
    }
}

pub(super) fn permit(name: &str, kind: CallerKind) -> Result<&'static table::Method, RpcError> {
    let method = table::find(name).ok_or_else(|| RpcError::new(METHOD_NOT_FOUND, format!("no method {name}")))?;
    if !method.callers.contains(&kind) {
        let why = match kind {
            CallerKind::Worker => method.refusal.or(Some(table::WORKER_REFUSAL)),
            _ => method.refusal,
        };
        let why = why.map(|r| format!(": {r}")).unwrap_or_default();
        return Err(RpcError::new(
            REFUSED,
            format!("{name} is not open to a {} caller{why}", kind.name()),
        ));
    }
    Ok(method)
}

pub trait Dispatch: Send + Sync {
    fn hub(&self) -> &Hub;
    fn auth_timeout(&self) -> Duration;
    fn dispatch(&self, conn: ConnId, principal: &Principal, req: &Request) -> Result<Value, RpcError>;
}

impl Dispatch for Server {
    fn hub(&self) -> &Hub {
        &self.hub
    }
    fn auth_timeout(&self) -> Duration {
        self.auth_timeout
    }
    fn dispatch(&self, conn: ConnId, principal: &Principal, req: &Request) -> Result<Value, RpcError> {
        Server::dispatch(self, conn, principal, req)
    }
}

/// Accept on its own thread until the transport shuts down. A front is a
/// transport and the credential it accepts; every front shares one server.
pub fn serve(transport: Arc<dyn Transport>, credential: Arc<Credential>, server: Arc<dyn Dispatch>) {
    thread::spawn(move || loop {
        match transport.accept() {
            Ok(Some(stream)) => {
                let (server, credential) = (server.clone(), credential.clone());
                thread::spawn(move || handle(server.as_ref(), &credential, stream));
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

fn handle(server: &dyn Dispatch, credential: &Credential, stream: Box<dyn Stream>) {
    let Ok(read_half) = stream.try_clone_box() else { return };
    let mut reader = BufReader::new(read_half);

    // Bounded, so a client that connects and says nothing does not hold a
    // thread forever.
    let _ = stream.set_read_timeout(Some(server.auth_timeout()));
    let first = read_request(&mut reader);
    handle_first(server, credential, stream, reader, first);
}

pub fn handle_first(
    server: &dyn Dispatch,
    credential: &Credential,
    mut stream: Box<dyn Stream>,
    mut reader: BufReader<Box<dyn Stream>>,
    first: Result<Option<Request>, ReadError>,
) {
    let authed = match first {
        // Pairing ends the connection either way: the device comes back with
        // `auth`, so every connection that is served starts with a credential.
        Ok(Some(first)) if first.method == PAIR_METHOD => {
            let id = first.id.clone().unwrap_or(Value::Null);
            let reply = match pair(&first, credential) {
                Ok(paired) => {
                    for old in &paired.replaced {
                        server.hub().close_device(old);
                    }
                    Response::ok(id, json!(paired))
                }
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
        Err(ReadError::Io(_)) => Err(Response::err(
            Value::Null,
            RpcError::new(UNAUTHORIZED, "no auth frame in time"),
        )),
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
    let conn = server.hub().register(tx.clone(), Box::new(move || closer.close()));
    // Tagged before the check, so a revoke either sees this connection or
    // removed the device before the check reads it.
    match &principal {
        Principal::Device(id) => server.hub().tag_device(conn, id),
        Principal::Browser(id) => server.hub().tag_browser(conn, id),
        _ => {}
    }
    if !credential.holds(&principal) {
        server.hub().remove(conn);
        drop(tx);
        stream.close();
        return;
    }
    let Some(chat) = server.hub().chat_outbox(conn) else {
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
    server.hub().remove(conn);
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
        pub sessions: Option<Value>,
    }

    // A chat session with this id is treated as a worker.
    pub const WORKER: &str = "worker";
    pub const SLOW: &str = "slow";

    impl Backend for StubBackend {
        fn kind(&self, principal: &Principal) -> CallerKind {
            match principal {
                Principal::Session(Caller::Chat(id)) if id == WORKER => CallerKind::Worker,
                other => CallerKind::of(other),
            }
        }
        fn sessions_list(&self, p: ListParams) -> Result<Value, RpcError> {
            if let Some(rows) = &self.sessions {
                return Ok(rows.clone());
            }
            Ok(json!([{ "id": "s1", "limit": p.limit }]))
        }
        fn projects_list(&self) -> Result<Value, RpcError> {
            Ok(json!({ "spaces": [], "topics": [] }))
        }
        fn project_icon(&self, p: ProjectIconParams) -> Result<Value, RpcError> {
            Ok(json!({ "path": p.path }))
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
                Principal::Browser(id) => json!({ "caller": { "kind": "browser", "id": id } }),
            })
        }
        fn session_steer(&self, _: &Principal, p: SteerParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn session_wait(&self, p: WaitParams) -> Result<Value, RpcError> {
            if p.id == SLOW {
                thread::sleep(Duration::from_millis(800));
            }
            Ok(json!({ "id": p.id, "state": "idle", "question": null, "last": null }))
        }
        fn session_check(&self, p: CheckParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn session_handoff(&self, _: &Principal, p: HandoffParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.to }))
        }
        fn session_pending(&self, p: PendingParams) -> Result<Value, RpcError> {
            if p.id == SLOW {
                thread::sleep(Duration::from_millis(800));
            }
            Ok(json!([{ "kind": "ask", "id": p.id }]))
        }
        fn session_answer(&self, _: &Principal, p: SessionAnswerParams) -> Result<Value, RpcError> {
            Ok(json!({ "answered": p.id }))
        }
        fn session_info(&self, p: InfoParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn session_model(&self, _: &Principal, p: ModelParams) -> Result<Value, RpcError> {
            Ok(json!({ "model": p.model }))
        }
        fn session_mode(&self, _: &Principal, p: ModeParams) -> Result<Value, RpcError> {
            Ok(json!({ "mode": p.mode }))
        }
        fn units_git(&self, p: UnitsGitParams) -> Result<Value, RpcError> {
            Ok(json!({ "folders": p.folders }))
        }
        fn review_list(&self) -> Result<Value, RpcError> {
            Ok(json!([]))
        }
        fn review_mark(&self, p: ReviewMarkParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn permissions_pending(&self) -> Result<Value, RpcError> {
            Ok(json!([]))
        }
        fn permissions_allow_group(&self, p: AllowGroupParams) -> Result<Value, RpcError> {
            Ok(json!({ "allowed": p.ids.len(), "skipped": 0, "failed": [] }))
        }
        fn permissions_deny(&self, p: PromptRef) -> Result<Value, RpcError> {
            Ok(json!({ "denied": p.id }))
        }
        fn needs_you_list(&self) -> Result<Value, RpcError> {
            Ok(json!([]))
        }
        fn needs_you_seen(&self, p: NeedsYouSeenParams) -> Result<Value, RpcError> {
            Ok(json!({ "session": p.session }))
        }
        fn digest_list(&self, p: DigestParams) -> Result<Value, RpcError> {
            Ok(json!({ "since": p.since }))
        }
        fn digest_looked(&self, p: DigestLookedParams) -> Result<Value, RpcError> {
            Ok(json!({ "at": p.at }))
        }
        fn radar_list(&self) -> Result<Value, RpcError> {
            Ok(json!({ "enabled": true, "units": [] }))
        }
        fn ports_list(&self) -> Result<Value, RpcError> {
            Ok(json!([]))
        }
        fn worktree_at(&self, p: PortParams) -> Result<Value, RpcError> {
            Ok(json!({ "port": p.port }))
        }
        fn units_sync(&self, p: UnitsSyncParams) -> Result<Value, RpcError> {
            Ok(json!({ "units": p.units.len() }))
        }
        fn units_pr(&self, p: UnitsPrParams) -> Result<Value, RpcError> {
            Ok(json!({ "project": p.project }))
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
        fn provenance_hunks(&self, p: ProvenanceParams) -> Result<Value, RpcError> {
            Ok(json!({ "file": p.file }))
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
        fn topic_member_promote(&self, _: &str, p: TopicPromoteParams) -> Result<Value, RpcError> {
            Ok(json!({ "member": p.member }))
        }
        fn ask_create(&self, _: &str, p: AskParams) -> Result<Value, RpcError> {
            Ok(json!({ "question": p.question }))
        }
        fn ask_wait(&self, p: AskWaitParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn ask_answer(&self, _: &Principal, p: AskAnswerParams) -> Result<Value, RpcError> {
            match p.id.as_str() {
                "gone" => Err(RpcError::new(
                    INVALID_PARAMS,
                    format!("no ask {}, or it was already answered", p.id),
                )),
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
        fn pr_check_log(&self, _: &Principal, p: PrCheckLogParams) -> Result<Value, RpcError> {
            Ok(json!({ "runId": p.run_id }))
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
        fn pr_push(&self, _: &Principal, p: PrPushParams) -> Result<Value, RpcError> {
            Ok(json!({ "number": p.number }))
        }
        fn pr_watch(&self, _: &Principal, p: PrWatchParams) -> Result<Value, RpcError> {
            Ok(json!({ "key": p.key }))
        }
        fn pr_unwatch(&self, _: &Principal, p: PrWatchParams) -> Result<Value, RpcError> {
            Ok(json!({ "key": p.key }))
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
        fn autopilot_log(&self, p: LogParams) -> Result<Value, RpcError> {
            let log = self
                .autopilot
                .as_ref()
                .map(|store| store.recent_log(p.limit.unwrap_or(DEFAULT_LOG_LIMIT)));
            Ok(json!(log.unwrap_or_default()))
        }
        fn autopilot_loop(&self, _: &Principal, p: LoopParams) -> Result<Value, RpcError> {
            Ok(json!({ "queued": p.entries }))
        }
        fn autopilot_item_update(&self, _: &Principal, p: ItemUpdateParams) -> Result<Value, RpcError> {
            match &self.autopilot {
                Some(store) => {
                    let project = p.project.clone();
                    p.apply(store, project, String::new())
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
        fn autopilot_schedule_list(&self) -> Result<Value, RpcError> {
            Ok(json!(self.autopilot.as_ref().map(|store| store.schedules())))
        }
        fn autopilot_schedule_add(&self, _: &Principal, p: ScheduleAddParams) -> Result<Value, RpcError> {
            match &self.autopilot {
                Some(store) => {
                    let project = p.project.clone().unwrap_or_default();
                    p.apply(store, project, "")
                }
                None => Ok(json!({ "name": p.name })),
            }
        }
        fn autopilot_schedule_remove(&self, p: ScheduleIdParams) -> Result<Value, RpcError> {
            match &self.autopilot {
                Some(store) => Ok(json!(store.remove_schedule(&p.id).map_err(update_error)?)),
                None => Ok(json!({ "id": p.id })),
            }
        }
        fn autopilot_schedule_resume(&self, p: ScheduleIdParams) -> Result<Value, RpcError> {
            match &self.autopilot {
                Some(store) => Ok(json!(store.resume_schedule(&p.id).map_err(update_error)?)),
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
        fn browser_mint(&self) -> Result<Value, RpcError> {
            Ok(json!({}))
        }
        fn attachment_write(&self, p: AttachmentWriteParams) -> Result<Value, RpcError> {
            Ok(json!({ "name": p.name }))
        }
        fn window_reveal(&self, p: RevealParams) -> Result<Value, RpcError> {
            Ok(json!({ "revealed": p.id }))
        }
        fn chat_draft(&self, p: DraftParams) -> Result<Value, RpcError> {
            Ok(json!({ "folder": p.folder }))
        }
        fn web_setup(&self, p: SetupParams) -> Result<Value, RpcError> {
            Ok(json!({ "port": p.port, "folder": p.folder }))
        }
        fn session_unit(&self, id: &str) -> Option<String> {
            self.folder_unit(id.split_once('@')?.1)
        }
        fn folder_unit(&self, folder: &str) -> Option<String> {
            STUB_UNITS
                .iter()
                .filter(|unit| crate::sessions::owned_by_listing(folder, unit))
                .max_by_key(|unit| unit.len())
                .map(|unit| unit.to_string())
        }
        fn ask_session(&self, id: &str) -> Option<String> {
            id.contains('@').then(|| id.to_string())
        }
    }

    pub const STUB_UNITS: &[&str] = &["/w/app", "/w/app/.tori/worktrees/x", "/w/web"];

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
        let server = Arc::new(Server {
            hub: hub.clone(),
            backend: Box::<StubBackend>::default(),
            auth_timeout: timeout,
        });
        let credential = Arc::new(Credential::Local {
            process: "tok".into(),
            children: children.clone(),
            browsers: Arc::new(crate::rpc::devices::Devices::open(
                std::env::temp_dir().join("tori-test-no-browsers.json"),
            )),
        });
        serve(transport.clone(), credential, server);
        Running {
            transport,
            hub,
            children,
        }
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
        assert_eq!(
            c.call(1, "sessions.list", json!({"limit": 3}))["result"],
            json!([{"id": "s1", "limit": 3}])
        );
        assert_eq!(
            c.call(2, "session.tail", json!({"id": "s9", "agent": "claude"}))["result"],
            json!([{"id": "s9"}])
        );
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
        assert_eq!(
            as_caller(&tab),
            json!({"caller": {"kind": "terminal", "id": "t1"}, "kind": "terminal"})
        );
        assert_eq!(
            as_caller(&chat),
            json!({"caller": {"kind": "chat", "id": "s1"}, "kind": "chat"})
        );
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
        assert_eq!(
            c.call(2, "session.tail", json!({"id": 1}))["error"]["code"],
            json!(INVALID_PARAMS)
        );
        assert_eq!(
            c.call(3, "subscribe", json!({"topic": "topics"}))["error"]["code"],
            json!(INVALID_PARAMS)
        );
        c.send_raw("not json\n");
        assert_eq!(
            c.recv().unwrap()["error"]["code"],
            json!(crate::rpc::frame::PARSE_ERROR)
        );
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
    fn a_hidden_phone_stays_connected_but_stops_attending() {
        let server = stub_server();
        let (tx, _rx) = sync_channel(QUEUE_CAP);
        let conn = server.hub.register(tx, Box::new(|| {}));
        let phone = Principal::Device("d1".into());
        server.hub.tag_device(conn, "d1");
        assert!(server.hub.device_visible(), "a phone connects from the foreground");
        let hide = server.dispatch(conn, &phone, &request("visible", json!({ "visible": false })));
        assert!(hide.is_ok(), "{hide:?}");
        assert!(!server.hub.device_visible());
        assert!(server.hub.connected_devices().contains("d1"), "hidden, not dropped");
        server
            .dispatch(conn, &phone, &request("visible", json!({ "visible": true })))
            .unwrap();
        assert!(server.hub.device_visible());
        server.hub.remove(conn);
        assert!(!server.hub.device_visible(), "dropped");
        assert!(
            server
                .dispatch(conn, &Principal::Local, &request("visible", json!({ "visible": true })))
                .is_err(),
            "only a paired device reports this"
        );
    }

    #[test]
    fn every_spawn_param_is_optional_and_described() {
        let schema = schemars::schema_for!(SpawnParams).to_value();
        let properties = schema["properties"].as_object().unwrap();
        assert_eq!(properties.len(), 13);
        for (name, field) in properties {
            assert!(
                field["description"].as_str().is_some_and(|d| !d.is_empty()),
                "{name} has no description"
            );
        }
        assert!(schema["required"].as_array().is_none_or(|r| r.is_empty()), "{schema}");
    }

    #[test]
    fn issue_sources_set_through_project_set_come_back_in_state() {
        let schema = schemars::schema_for!(ProjectSetParams).to_value();
        assert!(
            schema["properties"]["issues"]["description"].as_str().is_some(),
            "{schema}"
        );
        let dir = crate::autopilot::tests::temp_dir("project-set-issues");
        let store = AutopilotStore::open(dir.clone(), Box::new(|_| {}));
        let params: ProjectSetParams = serde_json::from_value(json!({
            "issues": [{ "repo": "gettori/tickets", "milestone": "Phase 1: Mac and Android" }]
        }))
        .unwrap();
        params.apply(&store, "/p".into()).unwrap();
        for repo in ["", "gettori", "a/b/c", "a /b"] {
            let bad: ProjectSetParams = serde_json::from_value(json!({ "issues": [{ "repo": repo }] })).unwrap();
            assert!(bad.apply(&store, "/p".into()).is_err(), "{repo:?}");
        }
        let issues = &store.state(|_| Observed::default()).projects["/p"].issues;
        assert_eq!(
            (
                issues[0].repo.as_str(),
                issues[0].milestone.as_deref(),
                issues[0].assignee.as_deref()
            ),
            ("gettori/tickets", Some("Phase 1: Mac and Android"), None)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Params built from each row's own schema, so a row added later is covered
    // without touching this test.
    #[test]
    fn every_row_dispatches_to_the_backend() {
        let server = stub_server();
        for method in table::METHODS {
            let schema = (method.params)().to_value();
            let mut sample = serde_json::Map::new();
            for field in schema["required"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let property = &schema["properties"][field];
                let referenced = property["$ref"]
                    .as_str()
                    .and_then(|r| r.strip_prefix("#/$defs/"))
                    .map(|name| &schema["$defs"][name]);
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
                CallerKind::Browser => Principal::Browser("b1".into()),
            };
            let mut req = request(method.name, Value::Object(sample));
            if let Principal::Browser(_) = principal {
                req.worktree = Some(STUB_UNITS[0].into());
                if req.params.get("id").is_some() {
                    req.params["id"] = json!(format!("x@{}", STUB_UNITS[0]));
                }
            }
            let outcome = server.dispatch(0, &principal, &req);
            assert!(outcome.is_ok(), "{}: {outcome:?}", method.name);
        }
    }

    #[test]
    fn the_dispatcher_refuses_a_caller_kind_the_row_leaves_out() {
        let server = stub_server();
        let tab = Principal::Session(Caller::Terminal("t1".into()));
        let err = server
            .dispatch(0, &tab, &request("ask.create", json!({"question": "q"})))
            .unwrap_err();
        assert_eq!(err.code, REFUSED);
        assert!(
            err.message.contains("terminal") && err.message.contains("ask.create"),
            "{}",
            err.message
        );
        let chat = Principal::Session(Caller::Chat("s1".into()));
        assert!(server
            .dispatch(0, &chat, &request("ask.create", json!({"question": "q"})))
            .is_ok());
    }

    #[test]
    fn only_a_chat_session_may_watch_a_pull_request() {
        let server = stub_server();
        let worker = Principal::Session(Caller::Chat(WORKER.into()));
        for method in ["pr.watch", "pr.unwatch"] {
            for caller in [
                Principal::Local,
                Principal::Session(Caller::Terminal("t1".into())),
                worker.clone(),
            ] {
                let err = server
                    .dispatch(0, &caller, &request(method, json!({"key": "1"})))
                    .unwrap_err();
                assert_eq!(err.code, REFUSED, "{method} {caller:?}");
            }
            let tab = Principal::Session(Caller::Terminal("t1".into()));
            let err = server
                .dispatch(0, &tab, &request(method, json!({"key": "1"})))
                .unwrap_err();
            assert!(
                err.message.contains("only a chat you drive can hold one"),
                "{}",
                err.message
            );
            let chat = Principal::Session(Caller::Chat("s1".into()));
            assert!(
                server.dispatch(0, &chat, &request(method, json!({"key": "1"}))).is_ok(),
                "{method}"
            );
        }
    }

    #[test]
    fn only_a_person_or_a_paired_phone_reviews_work() {
        let server = stub_server();
        let mark = || request("review.mark", json!({"id": "s1", "to_ts": 1_760_000_900}));
        let device = Principal::Device("d1".into());
        assert!(server.dispatch(0, &device, &request("review.list", json!({}))).is_ok());
        assert!(server.dispatch(0, &device, &mark()).is_ok());
        assert!(server.dispatch(0, &Principal::Local, &mark()).is_ok());
        for caller in [
            Principal::Session(Caller::Chat("s1".into())),
            Principal::Session(Caller::Terminal("t1".into())),
        ] {
            let err = server.dispatch(0, &caller, &mark()).unwrap_err();
            assert_eq!(err.code, REFUSED, "{caller:?}");
            assert!(err.message.contains("cannot review its own work"), "{}", err.message);
        }
    }

    #[test]
    fn only_a_person_or_a_paired_phone_reads_what_needs_them() {
        let server = stub_server();
        let list = || request("needs_you.list", json!({}));
        let seen = || request("needs_you.seen", json!({"session": "s1", "folder": "/p/repo"}));
        let digest = || request("digest.list", json!({"since": 5}));
        let looked = || request("digest.looked", json!({"at": 5}));
        for caller in [Principal::Local, Principal::Device("d1".into())] {
            for call in [list(), seen(), digest(), looked()] {
                assert!(server.dispatch(0, &caller, &call).is_ok(), "{caller:?}");
            }
        }
        for caller in [
            Principal::Session(Caller::Chat("s1".into())),
            Principal::Session(Caller::Terminal("t1".into())),
        ] {
            for call in [list(), seen(), digest(), looked()] {
                let err = server.dispatch(0, &caller, &call).unwrap_err();
                assert_eq!(err.code, REFUSED, "{caller:?}");
            }
        }
    }

    #[test]
    fn only_a_person_or_a_paired_phone_answers_the_permission_inbox() {
        let server = stub_server();
        let pending = || request("permissions.pending", json!({}));
        let allow = || {
            request(
                "permissions.allow_group",
                json!({"ids": [{"session": "s1", "id": "p1"}]}),
            )
        };
        let deny = || request("permissions.deny", json!({"session": "s1", "id": "p1"}));
        for caller in [Principal::Local, Principal::Device("d1".into())] {
            for call in [pending(), allow(), deny()] {
                assert!(server.dispatch(0, &caller, &call).is_ok(), "{caller:?}");
            }
        }
        for caller in [
            Principal::Session(Caller::Chat("s1".into())),
            Principal::Session(Caller::Terminal("t1".into())),
        ] {
            for call in [pending(), allow(), deny()] {
                let err = server.dispatch(0, &caller, &call).unwrap_err();
                assert_eq!(err.code, REFUSED, "{caller:?}");
            }
        }
    }

    #[test]
    fn session_answer_is_refused_to_a_worker_a_shell_and_a_terminal() {
        let server = stub_server();
        let answer = || {
            request(
                "session.answer",
                json!({"session": "w1", "id": "toolu_1", "answer": "allow"}),
            )
        };
        for caller in [
            Principal::Session(Caller::Chat(WORKER.into())),
            Principal::Local,
            Principal::Session(Caller::Terminal("t1".into())),
        ] {
            let err = server.dispatch(0, &caller, &answer()).unwrap_err();
            assert_eq!(err.code, REFUSED, "{caller:?}");
            assert!(err.message.contains("only the session that spawned"), "{}", err.message);
        }
        assert!(server
            .dispatch(0, &Principal::Session(Caller::Chat("s1".into())), &answer())
            .is_ok());
        assert!(server.dispatch(0, &Principal::Device("d1".into()), &answer()).is_ok());
        let each = request(
            "session.answer",
            json!({"session": "w1", "id": "toolu_1", "answer": ["a", "b"]}),
        );
        assert!(server
            .dispatch(0, &Principal::Session(Caller::Chat("s1".into())), &each)
            .is_ok());
    }

    #[test]
    fn an_ask_is_answered_once_and_never_by_a_worker() {
        let server = stub_server();
        let answer = |who: &Principal, id: &str| {
            server.dispatch(0, who, &request("ask.answer", json!({"id": id, "answer": "yes"})))
        };
        assert!(answer(&Principal::Local, "open").is_ok());
        assert_eq!(answer(&Principal::Local, "gone").unwrap_err().code, INVALID_PARAMS);
        let worker = Principal::Session(Caller::Chat(WORKER.into()));
        assert_eq!(answer(&worker, "open").unwrap_err().code, REFUSED);
    }

    #[test]
    fn a_worker_is_refused_spawn_and_steer_but_may_ask() {
        let server = stub_server();
        let worker = Principal::Session(Caller::Chat(WORKER.into()));
        for (method, params) in [
            ("session.spawn", json!({})),
            ("session.steer", json!({"id": "s1", "text": "hi"})),
            ("session.handoff", json!({"id": "s1", "to": "codex"})),
        ] {
            let err = server.dispatch(0, &worker, &request(method, params)).unwrap_err();
            assert_eq!(err.code, REFUSED, "{method}");
            assert!(err.message.contains(table::WORKER_REFUSAL), "{method}: {}", err.message);
        }
        let link = request("issues.link_branch", json!({"key": "1", "branch": "1-x"}));
        assert_eq!(server.dispatch(0, &worker, &link).unwrap_err().code, REFUSED);
        let me = server.dispatch(0, &worker, &request("caller", Value::Null)).unwrap();
        assert_eq!(me["kind"], json!("worker"));
        assert!(server
            .dispatch(0, &worker, &request("ask.create", json!({"question": "q"})))
            .is_ok());
        assert!(server
            .dispatch(0, &worker, &request("ask.wait", json!({"id": "a1"})))
            .is_ok());
    }

    #[test]
    fn the_browser_reads_and_steers_and_subscribes_to_nothing() {
        let open: Vec<&str> = table::METHODS
            .iter()
            .filter(|m| m.callers.contains(&CallerKind::Browser))
            .map(|m| m.name)
            .collect();
        assert_eq!(
            open,
            [
                "sessions.list",
                "session.tail",
                "caller",
                "session.steer",
                "session.pending",
                "window.reveal",
                "chat.draft",
                "web.setup",
                "attachment.write",
                "ask.answer",
                "projects.list",
                "ports.list",
                "worktree.at",
            ]
        );
        let hub = Hub::default();
        for topic in ["sessions", "accounts", "autopilot"] {
            let refused = subscribe(&hub, CallerKind::Browser, 0, &json!({ "topic": topic }), || {});
            assert_eq!(refused.unwrap_err().code, REFUSED, "{topic}");
        }
    }

    #[test]
    fn a_device_reads_and_drives_chats_and_the_autopilot_switch() {
        let open: Vec<&str> = table::METHODS
            .iter()
            .filter(|m| m.callers.contains(&CallerKind::Device))
            .map(|m| m.name)
            .collect();
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
                "session.answer",
                "session.info",
                "session.model",
                "session.mode",
                "review.list",
                "review.mark",
                "permissions.pending",
                "permissions.allow_group",
                "permissions.deny",
                "needs_you.list",
                "needs_you.seen",
                "digest.list",
                "digest.looked",
                "radar.list",
                "units.git",
                "units.sync",
                "units.pr",
                "session.spawn",
                "ask.answer",
                "projects.list",
                "project.icon",
                "autopilot.state",
                "autopilot.log",
                "autopilot.start",
                "autopilot.stop",
            ]
        );
        let server = stub_server();
        let device = Principal::Device("d1".into());
        assert!(server
            .dispatch(
                0,
                &device,
                &request("session.spawn", json!({"folder": "/p", "agent": "claude"}))
            )
            .is_ok());
        let worker = Principal::Session(Caller::Chat(WORKER.into()));
        for method in [
            "session.info",
            "session.model",
            "session.mode",
            "units.git",
            "autopilot.log",
        ] {
            assert_eq!(
                server
                    .dispatch(0, &worker, &request(method, json!({})))
                    .unwrap_err()
                    .code,
                REFUSED,
                "{method}"
            );
        }
        assert_eq!(
            server.dispatch(0, &device, &request("caller", Value::Null)).unwrap()["kind"],
            json!("device")
        );
        for method in ["autopilot.start", "autopilot.stop"] {
            assert!(
                server.dispatch(0, &device, &request(method, Value::Null)).is_ok(),
                "{method}"
            );
            for session in [
                Principal::Session(Caller::Chat("s1".into())),
                Principal::Session(Caller::Chat(WORKER.into())),
            ] {
                assert_eq!(
                    server
                        .dispatch(0, &session, &request(method, Value::Null))
                        .unwrap_err()
                        .code,
                    REFUSED,
                    "{method}"
                );
            }
        }
    }

    #[test]
    fn a_device_reads_the_autopilot_log_the_desktop_reads() {
        let dir = crate::autopilot::tests::temp_dir("dispatch-log");
        let store = AutopilotStore::open(dir.clone(), Box::new(|_| {}));
        let server = Server {
            backend: Box::new(StubBackend {
                autopilot: Some(store),
                ..StubBackend::default()
            }),
            ..stub_server()
        };
        let item = json!({"kind": "ship", "source": {"type": "pr", "number": 7, "repo": "o/r"}, "project": "/p"});
        assert!(server
            .dispatch(0, &Principal::Local, &request("autopilot.item.update", item))
            .is_ok());
        let logged = server
            .dispatch(0, &Principal::Device("d1".into()), &request("autopilot.log", json!({})))
            .unwrap();
        let desktop = AutopilotStore::open(dir.clone(), Box::new(|_| {})).recent_log(DEFAULT_LOG_LIMIT);
        assert!(!desktop.is_empty());
        assert_eq!(logged, json!(desktop));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_device_subscribes_to_everything_but_accounts() {
        let server = stub_server();
        let device = Principal::Device("d1".into());
        let subscribe = |topic: &str| server.dispatch(0, &device, &request("subscribe", json!({ "topic": topic })));
        assert!(subscribe("sessions").is_ok());
        assert!(subscribe("session:s1").is_ok());
        assert!(subscribe("chat:s1").is_ok());
        assert!(subscribe("autopilot").is_ok());
        assert_eq!(subscribe("accounts").unwrap_err().code, REFUSED);
        assert!(server
            .dispatch(
                0,
                &Principal::Local,
                &request("subscribe", json!({"topic": "autopilot"}))
            )
            .is_ok());
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
            assert_eq!(
                server.dispatch(0, &caller, &chat()).unwrap_err().code,
                REFUSED,
                "{caller:?}"
            );
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
        assert_eq!(
            chat_lines
                .iter()
                .map(|l| l["params"]["data"]["n"].clone())
                .collect::<Vec<_>>(),
            [json!(1), json!(2)]
        );
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
            assert_eq!(
                server.dispatch(0, &caller, &mint()).unwrap_err().code,
                REFUSED,
                "{caller:?}"
            );
        }
    }

    #[test]
    fn an_item_update_without_an_id_makes_one_open_item_per_source() {
        let dir = crate::autopilot::tests::temp_dir("dispatch-upsert");
        let store = AutopilotStore::open(dir.clone(), Box::new(|_| {}));
        let server = Server {
            backend: Box::new(StubBackend {
                autopilot: Some(store),
                ..StubBackend::default()
            }),
            ..stub_server()
        };
        let update =
            |who: &Principal, params: Value| server.dispatch(0, who, &request("autopilot.item.update", params));
        let key = json!({"kind": "ship", "source": {"type": "issue", "key": "12", "project": "/p"}, "project": "/p"});
        let first = update(&Principal::Local, key.clone()).unwrap();
        assert_eq!(
            update(&Principal::Local, key.clone()).unwrap()["id"],
            first["id"],
            "a retry finds the item it made"
        );
        assert_eq!(
            update(&Principal::Local, json!({"id": first["id"], "state": "failed"})).unwrap()["state"],
            "failed"
        );
        let fresh = update(&Principal::Local, key).unwrap();
        assert_ne!(
            fresh["id"], first["id"],
            "a failed item is closed, so the same source opens a new one"
        );
        assert_eq!(
            update(&Principal::Local, json!({"id": first["id"], "project": "/p"}))
                .unwrap_err()
                .code,
            INVALID_PARAMS
        );
        let worker = Principal::Session(Caller::Chat(WORKER.into()));
        assert_eq!(
            update(&worker, json!({"id": fresh["id"], "state": "done"}))
                .unwrap_err()
                .code,
            REFUSED
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_resolved_hold_is_withdrawn_never_approved_and_state_shows_the_open_ones() {
        use crate::rpc::approvals::{Approval, Draft, APPROVE};
        use crate::rpc::asks::{Asks, By, Waited, WITHDRAWN};
        let dir = crate::autopilot::tests::temp_dir("dispatch-holds");
        let asks = Arc::new(Asks::with_holds(dir.join("holds.json"), Box::new(|_| {})));
        let store = AutopilotStore::open(dir.clone(), Box::new(|_| {}));
        let server = Server {
            backend: Box::new(StubBackend {
                autopilot: Some(store),
                asks: Some(asks.clone()),
                ..StubBackend::default()
            }),
            ..stub_server()
        };
        let draft = Draft::PrMerge {
            number: 7,
            method: crate::forge::MergeMethod::Squash,
            head_sha: "abc".into(),
        };
        let ask = |item: &str| {
            let approval = Some(Approval {
                project: "/p".into(),
                draft: draft.clone(),
            });
            asks.create("s1".into(), "merge?".into(), vec![], approval, None, Some(item.into()))
                .id
        };
        let open = ask("item-1");
        let approved = ask("item-2");
        asks.answer(&approved, APPROVE.into(), By::User).unwrap();

        let state = server
            .dispatch(0, &Principal::Local, &request("autopilot.state", json!({})))
            .unwrap();
        assert_eq!(state["holds"].as_array().map(Vec::len), Some(2));

        let resolve = |id: &str| {
            server.dispatch(
                0,
                &Principal::Local,
                &request("autopilot.hold.resolve", json!({ "id": id })),
            )
        };
        for id in [&open, &approved] {
            let resolved = resolve(id).unwrap();
            assert_eq!(resolved["answer"], WITHDRAWN);
            assert!(resolved.get("approval_id").is_none(), "{resolved}");
            assert_eq!(
                asks.wait(id, Duration::ZERO),
                Waited::Answered {
                    answer: WITHDRAWN.into(),
                    approval_id: None
                },
                "an unread grant goes too"
            );
        }
        assert!(asks.holds().is_empty());
        assert_eq!(
            resolve(&open).unwrap_err().code,
            INVALID_PARAMS,
            "a hold is withdrawn once"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_diff_range_ending_before_it_starts_is_refused() {
        let server = stub_server();
        let diff = |params| server.dispatch(0, &Principal::Local, &request("checkpoint.diff", params));
        assert_eq!(
            diff(json!({"id": "s1", "turn": 3, "to": 2})).unwrap_err().code,
            INVALID_PARAMS
        );
        assert!(diff(json!({"id": "s1", "turn": 2, "to": 3})).is_ok());
        assert!(diff(json!({"id": "s1", "turn": 2})).is_ok());
    }

    #[test]
    fn a_subscriber_gets_events_and_a_disconnect_clears_it() {
        let r = start(AUTH_TIMEOUT);
        let mut c = authed(&r);
        assert_eq!(
            c.call(1, "subscribe", json!({"topic": "sessions"}))["result"],
            json!({})
        );
        r.hub
            .publish(&Channel::Sessions, json!({"kind": "session.started", "id": "s1"}));
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
        r.hub
            .publish(&Channel::Chat("s1".into()), json!({"type": "textDelta", "text": "hi"}));
        let event = c.recv().unwrap();
        assert_eq!(event["params"]["topic"], json!("chat:s1"));
        assert_eq!(event["params"]["data"]["text"], json!("hi"));
        assert_eq!(
            c.call(2, "sessions.list", json!({"limit": 1}))["result"],
            json!([{"id": "s1", "limit": 1}])
        );
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
            Ok(Box::new(RevokeOnReply {
                inner: self.inner.try_clone()?,
                revoke: self.revoke.clone(),
            }))
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

        let dir = std::env::temp_dir().join(format!(
            "tori-server-revoke-{}-{}",
            std::process::id(),
            crate::chat::approval::random_token()
        ));
        let devices = Arc::new(Devices::open(dir.join("devices.json")));
        let (device, secret) = devices.mint("phone").unwrap();
        let credential = Credential::Remote {
            devices: devices.clone(),
            pairing: Arc::new(Pairing::new(Box::new(|_| {}))),
        };
        let server = Server {
            hub: Default::default(),
            backend: Box::<StubBackend>::default(),
            auth_timeout: Duration::from_secs(5),
        };

        let (mut client, served) = UnixStream::pair().unwrap();
        let revoke = {
            let devices = devices.clone();
            Arc::new(move || {
                let _ = devices.revoke(&device.id);
            })
        };
        client
            .write_all(
                format!(
                    "{}\n",
                    json!({"jsonrpc": "2.0", "id": 0, "method": "auth", "params": {"token": secret}})
                )
                .as_bytes(),
            )
            .unwrap();
        let handled =
            thread::spawn(move || handle(&server, &credential, Box::new(RevokeOnReply { inner: served, revoke })));

        client.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut got = String::new();
        client
            .read_to_string(&mut got)
            .expect("the connection is closed, not left open");
        assert!(got.contains("\"result\":{}"), "auth itself passed: {got}");
        handled.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
