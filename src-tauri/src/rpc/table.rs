//! Every socket method as one row: name, description, params schema, who may
//! call it and how it reaches the backend. The dispatcher and `tori mcp`'s
//! `tools/list` both read it, so a row added here is served and published.

use schemars::{json_schema, schema_for, JsonSchema, Schema};
use serde_json::{json, Value};

use super::auth::{Caller, Principal};
use super::frame::{RpcError, INTERNAL_ERROR, INVALID_PARAMS};
use super::server::{
    params, AskAnswerParams, AskParams, AskWaitParams, Backend, BudgetParams, CheckpointDiffParams, CheckpointParams, CheckpointsParams,
    HoldResolveParams, IssueGetParams, PrGetParams, PendingParams, SessionAnswerParams, IssuesAssignedParams, ItemUpdateParams, LinkBranchParams, ProjectSetParams, ListParams, OpenParams, PrCreateParams, PrMergeParams, ReviewSubmitParams,
    SpawnParams, SteerParams, TailParams, WaitParams, WorktreeParams,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallerKind {
    Local,
    Terminal,
    Chat,
    Worker,
}

impl CallerKind {
    pub fn of(principal: &Principal) -> Self {
        match principal {
            Principal::Local => Self::Local,
            Principal::Session(Caller::Terminal(_)) => Self::Terminal,
            Principal::Session(Caller::Chat(_)) => Self::Chat,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Terminal => "terminal",
            Self::Chat => "chat",
            Self::Worker => "worker",
        }
    }
}

const ANYONE: &[CallerKind] = &[CallerKind::Local, CallerKind::Terminal, CallerKind::Chat, CallerKind::Worker];
const NOT_WORKERS: &[CallerKind] = &[CallerKind::Local, CallerKind::Terminal, CallerKind::Chat];
// A person at a shell or an outside client; no agent session can start a spend.
const NOT_SESSIONS: &[CallerKind] = &[CallerKind::Local, CallerKind::Terminal];

/// What a worker is told on every row that leaves it out, in place of the row's own `refusal`.
pub const WORKER_REFUSAL: &str = "a worker never spawns or steers; finish your turn and your spawner reads it";

type Call = fn(&dyn Backend, &Principal, &Value) -> Result<Value, RpcError>;

pub struct Method {
    pub name: &'static str,
    pub description: &'static str,
    pub params: fn() -> Schema,
    pub callers: &'static [CallerKind],
    /// Appended to the dispatcher's refusal of a caller kind not in `callers`.
    pub refusal: Option<&'static str>,
    /// Its effect is visible outside this machine, so the harness asks before it runs in a foreground session.
    pub outward: bool,
    pub call: Call,
}

fn schema<T: JsonSchema>() -> Schema {
    schema_for!(T)
}

fn no_params() -> Schema {
    json_schema!({ "type": "object", "properties": {} })
}

pub static METHODS: &[Method] = &[
    Method {
        name: "sessions.list",
        description: "List agent sessions, newest first, with whether each is live and its state.",
        params: schema::<ListParams>,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, _, v| b.sessions_list(params(v)?),
    },
    Method {
        name: "session.tail",
        description: "The last events of a session's conversation, tool outputs capped.",
        params: schema::<TailParams>,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, _, v| b.session_tail(params(v)?),
    },
    Method {
        name: "caller",
        description: "Who is calling: the session or terminal tab this connection belongs to, and its agent, account and folder.",
        params: no_params,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, p, _| {
            let mut me = b.caller(p)?;
            if let Some(me) = me.as_object_mut() {
                me.insert("kind".into(), json!(b.kind(p).name()));
            }
            Ok(me)
        },
    },
    Method {
        name: "session.steer",
        description: "Send a message to a live chat session, as a steer mid turn or as its next turn.",
        params: schema::<SteerParams>,
        callers: NOT_WORKERS,
        refusal: None,
        outward: false,
        call: |b, p, v| b.session_steer(p, params(v)?),
    },
    Method {
        name: "session.wait",
        description: "Wait for a session to stop working: its state, the question it is waiting on if any, and its last message.",
        params: schema::<WaitParams>,
        callers: NOT_WORKERS,
        refusal: None,
        outward: false,
        call: |b, _, v| b.session_wait(params(v)?),
    },
    Method {
        name: "session.pending",
        description: "What a session is waiting on: questions it asked with ask.create, and its agent's own questions and permission prompts, each with its id.",
        params: schema::<PendingParams>,
        callers: NOT_WORKERS,
        refusal: None,
        outward: false,
        call: |b, _, v| b.session_pending(params(v)?),
    },
    Method {
        name: "session.answer",
        description: "Answer a question or permission prompt a session you spawned is waiting on, by the id session.pending gave it. An id nothing waits on any more is an error.",
        params: schema::<SessionAnswerParams>,
        callers: &[CallerKind::Chat],
        refusal: Some("only the session that spawned a worker answers for it"),
        outward: true,
        call: |b, p, v| b.session_answer(p, params(v)?),
    },
    Method {
        name: "worktree.new",
        description: "Create a git worktree on a new branch and return its path. With an issue key, the unit remembers the issue. With pr, the worktree is on that pull request's head commit, forks included, on branch pr-<number>, and head_sha is returned.",
        params: schema::<WorktreeParams>,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, p, v| b.worktree_new(p, params(v)?),
    },
    Method {
        name: "issues.assigned",
        description: "Open issues assigned to you in a project's repo, then open pull requests waiting on your review, each with its kind.",
        params: schema::<IssuesAssignedParams>,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, p, v| b.issues_assigned(p, params(v)?),
    },
    Method {
        name: "issues.get",
        description: "One issue: its title, body, url, the branch name suggested for it, and the project folder it was read in. Takes the issue's URL, and then finds the project by its origin.",
        params: schema::<IssueGetParams>,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, p, v| b.issue_get(p, params(v)?),
    },
    Method {
        name: "issues.link_branch",
        description: "Make a branch on the host under an issue and fetch it. Safe to retry: a branch already there is reported, not made twice.",
        params: schema::<LinkBranchParams>,
        callers: NOT_WORKERS,
        refusal: Some("making a branch on the host is the spawner's call"),
        outward: false,
        call: |b, p, v| b.issue_link_branch(p, params(v)?),
    },
    Method {
        name: "checkpoints.list",
        description: "A session's checkpoints, oldest first, each numbered with the turn the other checkpoint methods take.",
        params: schema::<CheckpointsParams>,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, _, v| b.checkpoints_list(params(v)?),
    },
    Method {
        name: "checkpoint.diff",
        description: "The files a session's turn, or run of turns, changed and their unified diff.",
        params: schema::<CheckpointDiffParams>,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, _, v| {
            let p: CheckpointDiffParams = params(v)?;
            if let Some(to) = p.to.filter(|to| *to < p.turn) {
                return Err(RpcError::new(INVALID_PARAMS, format!("to {to} is before turn {}", p.turn)));
            }
            b.checkpoint_diff(p)
        },
    },
    Method {
        name: "checkpoint.revert",
        description: "Revert a session's folder to one of its turn checkpoints.",
        params: schema::<CheckpointParams>,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, p, v| b.checkpoint_revert(p, params(v)?),
    },
    Method {
        name: "session.spawn",
        description: "Start a new agent session in Tori, optionally in a new worktree, with a first message and attached files.",
        params: schema::<SpawnParams>,
        callers: NOT_WORKERS,
        refusal: None,
        outward: false,
        call: |b, p, v| b.session_spawn(p, params(v)?),
    },
    Method {
        name: "window.open",
        description: "Open a file in Tori's editor.",
        params: schema::<OpenParams>,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, _, v| b.window_open(params(v)?),
    },
    Method {
        name: "budget",
        description: "Spend for a session and its project against the configured budgets, and the agent's quota windows.",
        params: schema::<BudgetParams>,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, p, v| b.budget(p, params(v)?),
    },
    Method {
        name: "ask.create",
        description: "Ask the user a question in the calling chat and wait for the answer, or return its id to poll with ask.wait.",
        params: schema::<AskParams>,
        callers: &[CallerKind::Chat, CallerKind::Worker],
        refusal: Some("its card shows in a chat panel, so only a chat session can ask"),
        outward: false,
        call: |b, p, v| match p {
            Principal::Session(Caller::Chat(session)) => b.ask_create(session, params(v)?),
            _ => Err(RpcError::new(INTERNAL_ERROR, "ask.create reached with a caller its row does not admit")),
        },
    },
    Method {
        name: "ask.answer",
        description: "Answer a question another session asked, on the user's behalf; the card in that session goes away.",
        params: schema::<AskAnswerParams>,
        callers: NOT_WORKERS,
        refusal: None,
        outward: false,
        call: |b, _, v| b.ask_answer(params(v)?),
    },
    Method {
        name: "ask.wait",
        description: "Wait for the answer to a question ask.create returned unanswered.",
        params: schema::<AskWaitParams>,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, _, v| b.ask_wait(params(v)?),
    },
    Method {
        name: "pr.get",
        description: "One pull request to review: its title, body, author, base, head and head_sha, its files with the line ranges a comment may anchor to on each side, whether it is yours, what verdicts the host has, and the project folder it was read in. Takes the pull request's URL, and then finds the project by its origin.",
        params: schema::<PrGetParams>,
        callers: NOT_WORKERS,
        refusal: None,
        outward: false,
        call: |b, p, v| b.pr_get(p, params(v)?),
    },
    Method {
        name: "pr.create",
        description: "Push head_sha to the head branch on origin, never forced, then open a pull request from it. Refused once the local branch has moved past head_sha. A background session needs the approval_id of an approved ask for exactly this draft.",
        params: schema::<PrCreateParams>,
        callers: ANYONE,
        refusal: None,
        outward: true,
        call: |b, p, v| b.pr_create(p, params(v)?),
    },
    Method {
        name: "review.submit",
        description: "Submit a review on a pull request: a verdict, a body and line comments. A background session needs the approval_id of an approved ask for exactly this draft.",
        params: schema::<ReviewSubmitParams>,
        callers: ANYONE,
        refusal: None,
        outward: true,
        call: |b, p, v| b.review_submit(p, params(v)?),
    },
    Method {
        name: "pr.merge",
        description: "Merge a pull request at the head commit given. A background session needs the approval_id of an approved ask for exactly this merge.",
        params: schema::<PrMergeParams>,
        callers: ANYONE,
        refusal: None,
        outward: true,
        call: |b, p, v| b.pr_merge(p, params(v)?),
    },
    Method {
        name: "projects.list",
        description: "The tree the sidebar draws, in its order: spaces with their projects and branch units (each with its issue key), then topics by name with their members.",
        params: no_params,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, _, _| b.projects_list(),
    },
    Method {
        name: "autopilot.state",
        description: "The autopilot's queue: each item with its stored state, whether its session is live and whether its worktree is gone.",
        params: no_params,
        callers: ANYONE,
        refusal: None,
        outward: false,
        call: |b, _, _| b.autopilot_state(),
    },
    Method {
        name: "autopilot.start",
        description: "Turn the autopilot on: start its session with the brief, and start it again when Tori launches. Answers the runner's status.",
        params: no_params,
        callers: NOT_SESSIONS,
        refusal: Some("turning the autopilot on is the user's call"),
        outward: false,
        call: |b, _, _| b.autopilot_start(),
    },
    Method {
        name: "autopilot.stop",
        description: "Turn the autopilot off: close its session. The queue on disk and every worker session stay as they are.",
        params: no_params,
        callers: NOT_SESSIONS,
        refusal: Some("turning the autopilot off is the user's call"),
        outward: false,
        call: |b, _, _| b.autopilot_stop(),
    },
    Method {
        name: "autopilot.item.update",
        description: "Update an autopilot item by id. Without an id, update the open item for a kind, source and project, or make it: safe to retry.",
        params: schema::<ItemUpdateParams>,
        callers: NOT_WORKERS,
        refusal: Some("the queue is the autopilot's to change"),
        outward: false,
        call: |b, p, v| b.autopilot_item_update(p, params(v)?),
    },
    Method {
        name: "autopilot.project.set",
        description: "Set how the autopilot works in a project: how work ships, how far it goes before asking, whether it picks up work unasked, and the agent, account and model its workers use. Fields left out keep their value.",
        params: schema::<ProjectSetParams>,
        callers: NOT_WORKERS,
        refusal: Some("a project's contract is the user's and the autopilot's to set"),
        outward: false,
        call: |b, p, v| b.autopilot_project_set(p, params(v)?),
    },
    Method {
        name: "autopilot.hold.resolve",
        description: "Withdraw a hold: its card closes and a waiting ask.wait reads Withdrawn. It never approves; only the user does, on the card.",
        params: schema::<HoldResolveParams>,
        callers: NOT_WORKERS,
        refusal: Some("withdrawing a hold is the autopilot's call"),
        outward: false,
        call: |b, _, v| b.autopilot_hold_resolve(params(v)?),
    },
];

pub fn find(name: &str) -> Option<&'static Method> {
    METHODS.iter().find(|m| m.name == name)
}
