//! Every socket method as one row: name, description, params schema, who may
//! call it and how it reaches the backend. The dispatcher and `tori mcp`'s
//! `tools/list` both read it, so a row added here is served and published.

use schemars::{json_schema, schema_for, JsonSchema, Schema};
use serde_json::Value;

use super::auth::{Caller, Principal};
use super::frame::{RpcError, INTERNAL_ERROR};
use super::server::{
    params, AskParams, AskWaitParams, Backend, BudgetParams, CheckpointParams, CheckpointsParams, ListParams, OpenParams,
    SpawnParams, SteerParams, TailParams, WorktreeParams,
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

type Call = fn(&dyn Backend, &Principal, &Value) -> Result<Value, RpcError>;

pub struct Method {
    pub name: &'static str,
    pub description: &'static str,
    pub params: fn() -> Schema,
    pub callers: &'static [CallerKind],
    /// Appended to the dispatcher's refusal of a caller kind not in `callers`.
    pub refusal: Option<&'static str>,
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
        call: |b, _, v| b.sessions_list(params(v)?),
    },
    Method {
        name: "session.tail",
        description: "The last events of a session's conversation, tool outputs capped.",
        params: schema::<TailParams>,
        callers: ANYONE,
        refusal: None,
        call: |b, _, v| b.session_tail(params(v)?),
    },
    Method {
        name: "caller",
        description: "Who is calling: the session or terminal tab this connection belongs to, and its agent, account and folder.",
        params: no_params,
        callers: ANYONE,
        refusal: None,
        call: |b, p, _| b.caller(p),
    },
    Method {
        name: "session.steer",
        description: "Send a message to a live chat session, as a steer mid turn or as its next turn.",
        params: schema::<SteerParams>,
        callers: ANYONE,
        refusal: None,
        call: |b, p, v| b.session_steer(p, params(v)?),
    },
    Method {
        name: "worktree.new",
        description: "Create a git worktree on a new branch and return its path.",
        params: schema::<WorktreeParams>,
        callers: ANYONE,
        refusal: None,
        call: |b, p, v| b.worktree_new(p, params(v)?),
    },
    Method {
        name: "checkpoints.list",
        description: "A session's checkpoints, oldest first, each numbered with the turn the other checkpoint methods take.",
        params: schema::<CheckpointsParams>,
        callers: ANYONE,
        refusal: None,
        call: |b, _, v| b.checkpoints_list(params(v)?),
    },
    Method {
        name: "checkpoint.diff",
        description: "The files a session's turn changed and their unified diff.",
        params: schema::<CheckpointParams>,
        callers: ANYONE,
        refusal: None,
        call: |b, _, v| b.checkpoint_diff(params(v)?),
    },
    Method {
        name: "checkpoint.revert",
        description: "Revert a session's folder to one of its turn checkpoints.",
        params: schema::<CheckpointParams>,
        callers: ANYONE,
        refusal: None,
        call: |b, p, v| b.checkpoint_revert(p, params(v)?),
    },
    Method {
        name: "session.spawn",
        description: "Start a new agent session in Tori, optionally in a new worktree, with a first message and attached files.",
        params: schema::<SpawnParams>,
        callers: ANYONE,
        refusal: None,
        call: |b, p, v| b.session_spawn(p, params(v)?),
    },
    Method {
        name: "window.open",
        description: "Open a file in Tori's editor.",
        params: schema::<OpenParams>,
        callers: ANYONE,
        refusal: None,
        call: |b, _, v| b.window_open(params(v)?),
    },
    Method {
        name: "budget",
        description: "Spend for a session and its project against the configured budgets, and the agent's quota windows.",
        params: schema::<BudgetParams>,
        callers: ANYONE,
        refusal: None,
        call: |b, p, v| b.budget(p, params(v)?),
    },
    Method {
        name: "ask.create",
        description: "Ask the user a question in the calling chat and wait for the answer, or return its id to poll with ask.wait.",
        params: schema::<AskParams>,
        callers: &[CallerKind::Chat],
        refusal: Some("its card shows in a chat panel, so only a chat session can ask"),
        call: |b, p, v| match p {
            Principal::Session(Caller::Chat(session)) => b.ask_create(session, params(v)?),
            _ => Err(RpcError::new(INTERNAL_ERROR, "ask.create reached with a caller its row does not admit")),
        },
    },
    Method {
        name: "ask.wait",
        description: "Wait for the answer to a question ask.create returned unanswered.",
        params: schema::<AskWaitParams>,
        callers: ANYONE,
        refusal: None,
        call: |b, _, v| b.ask_wait(params(v)?),
    },
];

pub fn find(name: &str) -> Option<&'static Method> {
    METHODS.iter().find(|m| m.name == name)
}
