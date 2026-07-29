//! The normalized chat event model: the one vocabulary every chat surface in
//! Sway speaks, and the only thing the frontend ever sees.
//!
//! A transport (today only `claude` stream-json, tomorrow possibly Codex or an
//! ACP agent) maps its own wire format *into* these types, and nothing above
//! the transport layer knows which harness produced an event. That is what lets
//! the chat panel, the tool cards, the diff rendering and the status tier be
//! written once. `neutrality_check.rs` is the compiling proof that the model is
//! actually general enough to absorb a second harness rather than merely being
//! asserted to be.
//!
//! **Harness-specific data goes in `extra`, never in a new field.** Claude
//! reports things nobody else does (`ttft_ms`, `modelUsage`, cache-tier token
//! splits). Promoting those to first-class fields would quietly make the model
//! Claude-shaped and every other transport would have to fake them; keeping
//! them in a free-form map means a renderer that wants them opts in and one
//! that does not is unaffected.
//!
//! Serialization is internally tagged on `type` with camelCase names and
//! fields, so a `ChatEvent` crossing the Tauri boundary is directly usable by
//! `src/utils/chatTypes.ts`, which mirrors these shapes 1:1.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Harness-specific payload that has no place in the neutral model. See the
/// module docs for why this is a map rather than a growing field list.
pub type Extra = HashMap<String, serde_json::Value>;

fn extra_is_empty(e: &Extra) -> bool {
    e.is_empty()
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/// A permission mode, as the id its own harness names it.
///
/// **A string rather than an enum, and deliberately so.** Sway used to
/// enumerate Claude's four modes as variants, which made the neutral model
/// carry one harness's vocabulary: Gemini's `--approval-mode` speaks
/// `default|auto_edit|yolo|plan`, and Codex does not have a fixed set at all -
/// it lists its permission profiles *at runtime* over `permissionProfile/list`.
/// No fixed enum can represent that, so the mode is whatever the adapter
/// declares and Sway passes it through without opinion.
///
/// The guard the enum used to provide is not free, and is not replaced by
/// anything in this type. A string accepts every typo, so what a declared mode
/// is checked against is the **real CLI**: see `modes_the_cli_accepts` in
/// `crate::agents`, which spawns the binary once per declared mode. See also
/// the `gotchas.md` entry on enum-to-string neutrality.
///
/// Note that Sway's own `PreToolUse` approval gate runs *ahead* of every mode
/// any harness has, so a permissive one does not mean unsupervised: hooks run
/// first in claude's permission chain, which is what makes the gate
/// authoritative.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PermissionMode(String);

impl PermissionMode {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The five measured effort levels accepted by `--effort`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// How a turn ended.
///
/// `Cancelled` is split out from `Errored` on purpose. An interrupt is
/// delivered as a `result` frame that looks like a failure (`is_error: true`,
/// subtype `error_during_execution`), but the two mean opposite things to the
/// UI: a cancelled turn is the user getting what they asked for and **must not**
/// flush the composer queue, while an errored one is a fault to surface. A
/// single "not success" state would make stop flush exactly the messages the
/// user pressed stop to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnOutcome {
    Completed,
    Cancelled,
    Errored,
}

/// How a tool call finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    Ok,
    Error,
    Denied,
}

/// What a tool did to a file, for the edit cards and the diff gutter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileEditKind {
    Created,
    Modified,
    Deleted,
}

/// The only two answers the approval bridge ever gives.
///
/// `ask` is deliberately absent: measured headless, `permissionDecision: "ask"`
/// degrades to a denial with the reason surfaced, so offering it would be a
/// third state that does not exist on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionDecision {
    Allow,
    Deny,
}

/// How far an approval answer reaches. Project scope is Sway-owned and never
/// written to the user's own `~/.claude/settings.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionScope {
    Once,
    Session,
    Project,
}

/// A slash command as the composer's completion menu needs it.
///
/// Measured: `system/init` reports only bare command *names*, so the
/// descriptions and argument hints exist solely in the `initialize`
/// control-response catalogue. A transport that skips the control handshake
/// gets a usable menu with empty descriptions rather than no menu at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub argument_hint: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
}

/// One model the live harness says it can run, as the picker needs it.
///
/// Measured: this catalogue exists **only** in the `initialize` control
/// response, never on `system/init`, which reports a single already-resolved
/// model id. The two fields are not interchangeable and conflating them is the
/// trap this struct exists to make impossible: `value` (`default`, `sonnet`,
/// `opus`) is what `--model` takes and what the picker keeps as the authority
/// for its own selection, while `resolved_model` (`claude-sonnet-5`) is what
/// `system/init.model` reports back. Several distinct `value`s resolve to one
/// `resolved_model`, so init alone can never say which was picked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelInfo {
    pub value: String,
    pub resolved_model: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub supports_effort: bool,
    /// Empty for a model with no effort control, which is what hides the
    /// control rather than rendering an inert one.
    #[serde(default)]
    pub supported_effort_levels: Vec<String>,
    /// Whether this model honours `--permission-mode auto`.
    ///
    /// Carried because the CLI will not say so at runtime: measured on 2.1.220,
    /// a model without it accepts the flag, exits 0, and silently reports
    /// `permissionMode: "default"`. Without this flag the picker would offer a
    /// mode the session is not in and nothing would contradict it.
    ///
    /// Absent means false. The catalogue omits these keys entirely for a model
    /// that lacks the capability rather than declaring them false, which is the
    /// same shape `supported_effort_levels` already relies on.
    #[serde(default)]
    pub supports_auto_mode: bool,
}

/// Who the session is signed in as, from the `initialize` handshake.
///
/// Measured: like the model catalogue, this exists **only** in that control
/// response, never on `system/init`. So a session that never handshook has no
/// account at all, which is why every consumer takes an `Option` rather than a
/// struct of empty strings - "we did not ask" and "no organization" are
/// different answers and only one of them is worth rendering.
///
/// **`email` is deliberately not carried.** The response has one; nothing here
/// needs it, and a personal identifier that no consumer reads is a field that
/// only ever leaks - into a fixture, a log line, or a bug report. Multi-account
/// profiles may need it later, and can add it then with a reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAccount {
    /// As the harness words it, e.g. `Claude Pro`, `Claude Max`. Passed through
    /// rather than parsed into a tier: the strings are the CLI's to change, and
    /// a plan Sway has never seen should render as itself, not as "unknown".
    #[serde(default)]
    pub subscription_type: String,
    #[serde(default)]
    pub organization: String,
    /// `firstParty` for the Anthropic API, else a gateway (Bedrock, Vertex).
    /// Load-bearing beyond display: the extended context window depends on it,
    /// because several models run 1M on first-party and less elsewhere without
    /// saying so in their id.
    #[serde(default)]
    pub api_provider: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub tool_count: Option<u32>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Token and cost accounting, flattened out of the harness's own richer shape.
/// Cache-tier splits and per-model breakdowns live in the owning event's
/// `extra` rather than here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    #[serde(default)]
    pub thinking_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub text: String,
    pub status: PlanItemStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanItemStatus {
    Pending,
    InProgress,
    Completed,
}

/// A record of a tool call that was blocked, mirroring `result`'s
/// `permission_denials`.
///
/// Measured: those entries carry `tool_name`, `tool_use_id` and `tool_input`
/// and **no reason**. The denial reason travels separately, as the `tool_result`
/// the model actually saw, so a UI wanting to show "why" reads it off the tool
/// card rather than from here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDenial {
    pub tool_use_id: String,
    pub tool_name: String,
    #[serde(default)]
    pub tool_input: serde_json::Value,
}

/// One piece of a user turn. Images ride as base64, which is measured to work
/// over stream-json stdin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Image {
        media_type: String,
        data: String,
    },
    /// A structured file reference from an `@`-mention, an editor selection or
    /// a Changes-panel hunk comment. Carried as structure rather than pasted
    /// text so the receiving end keeps the path and line range.
    FileRef {
        path: String,
        #[serde(default)]
        start_line: Option<u32>,
        #[serde(default)]
        end_line: Option<u32>,
        #[serde(default)]
        text: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Which half of a hook execution a [`ChatEvent::HookFired`] carries.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HookPhase {
    Started,
    Finished,
}

/// Everything a chat session can tell the UI.
///
/// Every variant carries `session_id` because events from several concurrent
/// sessions share one channel and routing must never depend on which sink a
/// frame happened to arrive on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatEvent {
    /// The session is live. Emitted **once** per session, from the first
    /// `system/init` only: the CLI re-emits that frame on every turn, and
    /// treating each one as a new session would reset the transcript mid-chat.
    /// Later ones become `TurnStarted` plus whatever changed.
    SessionStarted {
        session_id: String,
        cwd: String,
        model: String,
        permission_mode: PermissionMode,
        tools: Vec<String>,
        slash_commands: Vec<SlashCommand>,
        mcp_servers: Vec<McpServer>,
        /// The live model catalogue from the `initialize` control response.
        /// **Empty when the handshake did not happen**, which the picker reads
        /// as "fall back to the adapter table" rather than as "no models".
        #[serde(default)]
        models: Vec<ChatModelInfo>,
        /// `system/init`'s fast-mode state and, when it is unavailable, the
        /// harness's own reason. Typed rather than left in `extra` because the
        /// toggle renders the reason instead of an inert control.
        #[serde(default)]
        fast_mode_state: Option<String>,
        #[serde(default)]
        fast_mode_disabled_reason: Option<String>,
        /// Who this session is signed in as, from the handshake. `None` when it
        /// did not happen, which reads as "unknown" rather than "no account".
        #[serde(default)]
        account: Option<ChatAccount>,
        #[serde(default, skip_serializing_if = "extra_is_empty")]
        extra: Extra,
    },

    /// The child answered a control request: alive and talking, but no turn
    /// has run, so `system/init` has not opened the session yet. Emitted once,
    /// before `SessionStarted`, from the `initialize` handshake the transport
    /// sends at spawn. Without it a freshly opened chat reads "connecting"
    /// until the first message, about a child that answered within a second.
    ///
    /// Carries the catalogues the handshake response held, because they
    /// otherwise wait for the first `system/init` to ride `SessionStarted`
    /// into the UI - which is exactly the wait this event exists to end.
    SessionReady {
        session_id: String,
        /// The rich command catalogue from the `initialize` response; empty
        /// when the response did not carry one.
        #[serde(default)]
        slash_commands: Vec<SlashCommand>,
        /// The model catalogue from the same response, empty the same way,
        /// which the picker reads as "fall back to the adapter table".
        #[serde(default)]
        models: Vec<ChatModelInfo>,
        /// The account the same response named. Carried here as well as on
        /// `SessionStarted` because this event can arrive a whole turn earlier
        /// and is the point of it: the handshake is the only source, so waiting
        /// for the first `system/init` would hold back data already in hand.
        #[serde(default)]
        account: Option<ChatAccount>,
    },

    /// One hook execution, from the in-band `hook_started`/`hook_response`
    /// frames that `--include-hook-events` turns on.
    ///
    /// One event per **frame**, not per hook: a hook produces a `Started` and
    /// then a `Finished` sharing one `hook_id`, and the transcript renders the
    /// pair as a row that fills in its outcome rather than waiting for it.
    HookFired {
        session_id: String,
        /// Pairs `Started` with its `Finished`. Also what lets a `Started` be
        /// attributed to Sway retroactively: only the response carries the
        /// marker, so the started frame inherits ownership through this id.
        hook_id: String,
        /// As the harness names it, e.g. `PreToolUse:Bash`. **Reports the tool,
        /// not the configured matcher** (measured, claude 2.1.220), which is
        /// why it cannot identify whose hook this is.
        name: String,
        /// The lifecycle event, e.g. `PreToolUse`, `SessionStart`.
        event: String,
        phase: HookPhase,
        /// True when this is Sway's own injected approval hook, identified by
        /// the marker it stamps on its own output. Collapsed by default: it
        /// runs on every tool call and is Sway's own plumbing, not something
        /// the user configured.
        sway_owned: bool,
        #[serde(default)]
        outcome: Option<String>,
        #[serde(default)]
        exit_code: Option<i64>,
        /// The hook's stdout. Kept so a user hook can show what it contributed.
        #[serde(default)]
        output: Option<String>,
        #[serde(default)]
        stderr: Option<String>,
    },

    /// A turn began. `model` and `permission_mode` are repeated here because
    /// the per-turn `system/init` re-emission is how a mid-session model or
    /// mode switch is *confirmed* to have taken effect, rather than assumed.
    TurnStarted {
        session_id: String,
        turn_id: String,
        model: String,
        permission_mode: PermissionMode,
        #[serde(default, skip_serializing_if = "extra_is_empty")]
        extra: Extra,
    },

    /// A user turn, as an event rather than as something the composer already
    /// knows it sent.
    ///
    /// A live chat pushes its own user turn locally, so this exists for the
    /// turns it did *not* send: a transcript replayed into a reopened tab, and a
    /// session whose earlier turns happened in a PTY tab or an outside terminal.
    /// Without it, backfilled history would render the assistant talking to
    /// nobody.
    UserMessage {
        session_id: String,
        turn_id: String,
        blocks: Vec<ContentBlock>,
    },

    /// The conversation was compacted: earlier turns were replaced by a summary
    /// so the context window could be reclaimed.
    ///
    /// Measured on a real transcript (claude 2.1.220): the boundary is a
    /// `system`/`compact_boundary` record carrying `compactMetadata` with
    /// `trigger`, `preTokens` and `postTokens`, and the **summary is the next
    /// user message**, not a field on the boundary. So `summary` is stitched on
    /// by whoever reads the two together; a reader that only saw the boundary
    /// leaves it `None` rather than inventing one.
    ///
    /// Surfaced rather than swallowed because a transcript that silently loses
    /// its middle is indistinguishable from one that lost it to a bug.
    Compacted {
        session_id: String,
        turn_id: String,
        /// `"manual"` (the user ran `/compact`) or `"auto"` (the window filled).
        #[serde(default)]
        trigger: Option<String>,
        #[serde(default)]
        pre_tokens: Option<u64>,
        #[serde(default)]
        post_tokens: Option<u64>,
        #[serde(default)]
        summary: Option<String>,
    },

    TextDelta {
        session_id: String,
        turn_id: String,
        text: String,
    },

    ThinkingDelta {
        session_id: String,
        turn_id: String,
        text: String,
    },

    /// A tool call was announced.
    ///
    /// **This fires more than once for the same `tool_use_id`, and consumers
    /// must upsert on that id rather than append.** A transport learns a call's
    /// name the moment its block opens but its arguments only as they finish
    /// streaming, so the first emission carries an empty `input` (letting a card
    /// render immediately) and a later one carries the assembled arguments.
    /// Measured on the Claude transport: exactly two emissions per call, `{}`
    /// then the parsed input. Appending instead of upserting renders two cards
    /// per tool call.
    ToolCallStarted {
        session_id: String,
        turn_id: String,
        tool_use_id: String,
        name: String,
        input: serde_json::Value,
    },

    /// Streaming arguments for a call whose input is still arriving, so a card
    /// can render before the full JSON has been assembled.
    ToolCallProgress {
        session_id: String,
        turn_id: String,
        tool_use_id: String,
        partial_input: String,
    },

    /// A tool call finished. `files` is the load-bearing field for concurrent
    /// worktrees: it is exactly which paths *this* session wrote, which is what
    /// lets per-turn attribution stop guessing from a whole-tree `git add -A`
    /// snapshot when several chats share one working tree.
    ToolCallCompleted {
        session_id: String,
        turn_id: String,
        tool_use_id: String,
        status: ToolStatus,
        #[serde(default)]
        output: Option<String>,
        #[serde(default)]
        files: Vec<String>,
        #[serde(default)]
        duration_ms: Option<u64>,
    },

    /// A file was written, with the before-state addressed by content hash so
    /// an exact diff can be reconstructed later without holding the bytes.
    FileEdit {
        session_id: String,
        turn_id: String,
        tool_use_id: String,
        path: String,
        kind: FileEditKind,
        /// `git hash-object` sha of the file's content *before* the write.
        /// `None` when the folder has no object store to write into.
        #[serde(default)]
        before_blob: Option<String>,
    },

    /// A tool call is blocked awaiting the user's answer.
    ///
    /// This arrives over the approval socket from a forked hook helper, while
    /// the `assistant` frame declaring the same call arrives on the child's
    /// stdout - two channels with nothing ordering them. Consumers must
    /// materialize a card from whichever reaches them first and key it on
    /// `tool_use_id`.
    PermissionRequest {
        session_id: String,
        tool_use_id: String,
        tool_name: String,
        input: serde_json::Value,
        /// Correlates the answer back to the blocked helper process.
        request_id: String,
        /// When Sway will auto-deny. Sway owns this deadline and keeps it
        /// strictly below the hook's own timeout, so an unanswered prompt fails
        /// closed with a reason rather than being resolved by the CLI.
        #[serde(default)]
        auto_deny_at_ms: Option<u64>,
    },

    PlanUpdate {
        session_id: String,
        turn_id: String,
        items: Vec<PlanItem>,
    },

    Usage {
        session_id: String,
        turn_id: String,
        usage: Usage,
        #[serde(default, skip_serializing_if = "extra_is_empty")]
        extra: Extra,
    },

    RateLimit {
        session_id: String,
        status: String,
        #[serde(default)]
        resets_at: Option<u64>,
        #[serde(default)]
        limit_type: Option<String>,
    },

    TurnCompleted {
        session_id: String,
        turn_id: String,
        outcome: TurnOutcome,
        #[serde(default)]
        stop_reason: Option<String>,
        usage: Usage,
        #[serde(default)]
        cost_usd: Option<f64>,
        #[serde(default)]
        permission_denials: Vec<PermissionDenial>,
        #[serde(default, skip_serializing_if = "extra_is_empty")]
        extra: Extra,
    },

    /// Something went wrong that is not a turn outcome: the child died, stdout
    /// was unparseable, the transport could not start. Never a panic and never
    /// a silent hang - a session that has stopped working must say so.
    SessionError {
        session_id: String,
        message: String,
        /// Whether the session is unusable from here on.
        fatal: bool,
    },

    SessionEnded {
        session_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Everything the UI can ask of a live chat session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatCommand {
    SendTurn {
        session_id: String,
        blocks: Vec<ContentBlock>,
    },
    /// The same content delivered *into* a turn that is already running, rather
    /// than opening one. Its own variant because it is not a turn: a queued
    /// mode or model switch must not be spent on it, and a harness that cannot
    /// take input mid-turn has to be able to refuse this while still accepting
    /// [`Self::SendTurn`].
    Steer {
        session_id: String,
        blocks: Vec<ContentBlock>,
    },
    Interrupt {
        session_id: String,
    },
    RespondPermission {
        session_id: String,
        tool_use_id: String,
        request_id: String,
        decision: PermissionDecision,
        scope: PermissionScope,
        #[serde(default)]
        reason: Option<String>,
    },
    /// Applies from the **next** turn, not the running one. The UI says so
    /// rather than claiming immediate effect, and the next turn's re-emitted
    /// init is what confirms it landed.
    SetMode {
        session_id: String,
        mode: PermissionMode,
    },
    SetModel {
        session_id: String,
        model: String,
        #[serde(default)]
        effort: Option<Effort>,
    },
    Close {
        session_id: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extra() -> Extra {
        HashMap::from([("ttftMs".to_string(), serde_json::json!(1575))])
    }

    /// One of every `ChatEvent` variant. The round-trip test below is only as
    /// good as this list, so a new variant belongs here too - which the
    /// exhaustive `match` in `variant_list_covers_every_event` enforces.
    fn every_event() -> Vec<ChatEvent> {
        vec![
            ChatEvent::SessionStarted {
                session_id: "s1".into(),
                cwd: "/tmp/w".into(),
                model: "claude-sonnet-5".into(),
                permission_mode: PermissionMode::new("bypassPermissions"),
                tools: vec!["Bash".into(), "Edit".into()],
                slash_commands: vec![SlashCommand {
                    name: "review".into(),
                    description: "Multi-lens code review".into(),
                    argument_hint: Some("<pr>".into()),
                    aliases: vec!["rv".into()],
                }],
                mcp_servers: vec![McpServer {
                    name: "ctx".into(),
                    status: "connected".into(),
                    tool_count: Some(11),
                    error: None,
                }],
                models: vec![ChatModelInfo {
                    value: "sonnet".into(),
                    resolved_model: "claude-sonnet-5".into(),
                    display_name: "Sonnet 5".into(),
                    description: "Balanced".into(),
                    supports_effort: true,
                    supported_effort_levels: vec!["low".into(), "high".into()],
                    supports_auto_mode: true,
                }],
                fast_mode_state: Some("off".into()),
                fast_mode_disabled_reason: Some("sdk_opt_in_required".into()),
                account: Some(ChatAccount {
                    subscription_type: "Claude Pro".into(),
                    organization: "Acme".into(),
                    api_provider: "firstParty".into(),
                }),
                extra: extra(),
            },
            ChatEvent::SessionReady {
                session_id: "s1".into(),
                slash_commands: vec![SlashCommand {
                    name: "review".into(),
                    description: "Multi-lens code review".into(),
                    argument_hint: Some("<pr>".into()),
                    aliases: vec!["rv".into()],
                }],
                models: vec![ChatModelInfo {
                    value: "sonnet".into(),
                    resolved_model: "claude-sonnet-5".into(),
                    display_name: "Sonnet 5".into(),
                    description: "Balanced".into(),
                    supports_effort: true,
                    supported_effort_levels: vec!["low".into(), "high".into()],
                    supports_auto_mode: true,
                }],
                account: Some(ChatAccount {
                    subscription_type: "Claude Pro".into(),
                    organization: "Acme".into(),
                    api_provider: "firstParty".into(),
                }),
            },
            ChatEvent::TurnStarted {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                model: "claude-sonnet-5".into(),
                permission_mode: PermissionMode::new("default"),
                extra: Extra::new(),
            },
            ChatEvent::UserMessage {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                blocks: vec![ContentBlock::Text { text: "fix the bug".into() }],
            },
            ChatEvent::Compacted {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                trigger: Some("manual".into()),
                pre_tokens: Some(247408),
                post_tokens: Some(9444),
                summary: Some("This session is being continued from a previous conversation".into()),
            },
            ChatEvent::TextDelta {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                text: "hello".into(),
            },
            ChatEvent::ThinkingDelta {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                text: "considering".into(),
            },
            ChatEvent::ToolCallStarted {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                tool_use_id: "toolu_1".into(),
                name: "Bash".into(),
                input: serde_json::json!({ "command": "echo hi" }),
            },
            ChatEvent::ToolCallProgress {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                tool_use_id: "toolu_1".into(),
                partial_input: "{\"comm".into(),
            },
            ChatEvent::ToolCallCompleted {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                tool_use_id: "toolu_1".into(),
                status: ToolStatus::Ok,
                output: Some("hi".into()),
                files: vec!["/tmp/w/probe.txt".into()],
                duration_ms: Some(42),
            },
            ChatEvent::FileEdit {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                tool_use_id: "toolu_2".into(),
                path: "/tmp/w/probe.txt".into(),
                kind: FileEditKind::Modified,
                before_blob: Some("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391".into()),
            },
            ChatEvent::PermissionRequest {
                session_id: "s1".into(),
                tool_use_id: "toolu_3".into(),
                tool_name: "Bash".into(),
                input: serde_json::json!({ "command": "rm -rf /" }),
                request_id: "op-9".into(),
                auto_deny_at_ms: Some(1_785_179_400_000),
            },
            ChatEvent::PlanUpdate {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                items: vec![PlanItem {
                    text: "Write the mappers".into(),
                    status: PlanItemStatus::InProgress,
                }],
            },
            ChatEvent::Usage {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                usage: Usage {
                    input_tokens: 6,
                    output_tokens: 205,
                    cache_read_tokens: 64_647,
                    cache_write_tokens: 8_866,
                    thinking_tokens: 22,
                },
                extra: extra(),
            },
            ChatEvent::RateLimit {
                session_id: "s1".into(),
                status: "allowed".into(),
                resets_at: Some(1_785_179_400),
                limit_type: Some("five_hour".into()),
            },
            ChatEvent::TurnCompleted {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                outcome: TurnOutcome::Cancelled,
                stop_reason: Some("error_during_execution".into()),
                usage: Usage::default(),
                cost_usd: Some(0.076_299_1),
                permission_denials: vec![PermissionDenial {
                    tool_use_id: "toolu_3".into(),
                    tool_name: "Bash".into(),
                    tool_input: serde_json::json!({ "command": "echo blocked" }),
                }],
                extra: Extra::new(),
            },
            ChatEvent::SessionError {
                session_id: "s1".into(),
                message: "child exited with status 1".into(),
                fatal: true,
            },
            ChatEvent::SessionEnded {
                session_id: "s1".into(),
                reason: Some("closed by user".into()),
            },
            // Last on purpose: the TS replay tests read this list as an arrival
            // order, and a hook frame is not part of the session-lifecycle
            // sequence they assert on.
            ChatEvent::HookFired {
                session_id: "s1".into(),
                hook_id: "0169c799-647f-402b-8585-49a207f46940".into(),
                // The measured shape: the tool, not the configured matcher.
                name: "PreToolUse:Bash".into(),
                event: "PreToolUse".into(),
                phase: HookPhase::Finished,
                sway_owned: false,
                outcome: Some("success".into()),
                exit_code: Some(0),
                output: Some("{\"hookSpecificOutput\":{}}".into()),
                stderr: None,
            },
        ]
    }

    fn every_command() -> Vec<ChatCommand> {
        vec![
            ChatCommand::SendTurn {
                session_id: "s1".into(),
                blocks: vec![
                    ContentBlock::Text { text: "look at this".into() },
                    ContentBlock::Image {
                        media_type: "image/png".into(),
                        data: "iVBORw0KGgo=".into(),
                    },
                    ContentBlock::FileRef {
                        path: "/tmp/w/probe.txt".into(),
                        start_line: Some(2),
                        end_line: Some(4),
                        text: Some("beta".into()),
                    },
                ],
            },
            ChatCommand::Steer {
                session_id: "s1".into(),
                blocks: vec![ContentBlock::Text { text: "stop reading, just summarise".into() }],
            },
            ChatCommand::Interrupt { session_id: "s1".into() },
            ChatCommand::RespondPermission {
                session_id: "s1".into(),
                tool_use_id: "toolu_3".into(),
                request_id: "op-9".into(),
                decision: PermissionDecision::Deny,
                scope: PermissionScope::Once,
                reason: Some("not on this tree".into()),
            },
            ChatCommand::SetMode {
                session_id: "s1".into(),
                mode: PermissionMode::new("plan"),
            },
            ChatCommand::SetModel {
                session_id: "s1".into(),
                model: "claude-opus-5".into(),
                effort: Some(Effort::Xhigh),
            },
            ChatCommand::Close { session_id: "s1".into() },
        ]
    }

    #[test]
    fn every_event_variant_round_trips() {
        for ev in every_event() {
            let json = serde_json::to_string(&ev).expect("serialize");
            let back: ChatEvent =
                serde_json::from_str(&json).unwrap_or_else(|e| panic!("deserialize {json}: {e}"));
            assert_eq!(ev, back, "round trip changed the value: {json}");
        }
    }

    #[test]
    fn every_command_variant_round_trips() {
        for cmd in every_command() {
            let json = serde_json::to_string(&cmd).expect("serialize");
            let back: ChatCommand =
                serde_json::from_str(&json).unwrap_or_else(|e| panic!("deserialize {json}: {e}"));
            assert_eq!(cmd, back, "round trip changed the value: {json}");
        }
    }

    /// The round-trip tests above only cover the variants `every_event` lists,
    /// so a variant added without a sample would be silently untested. This
    /// `match` is exhaustive, so adding one to `ChatEvent` fails to compile
    /// until it is added here - and the compile error points at the sample list.
    #[test]
    fn variant_list_covers_every_event() {
        let events = every_event();
        for ev in &events {
            let _name = match ev {
                ChatEvent::SessionStarted { .. } => "sessionStarted",
                ChatEvent::SessionReady { .. } => "sessionReady",
                ChatEvent::HookFired { .. } => "hookFired",
                ChatEvent::TurnStarted { .. } => "turnStarted",
                ChatEvent::UserMessage { .. } => "userMessage",
                ChatEvent::Compacted { .. } => "compacted",
                ChatEvent::TextDelta { .. } => "textDelta",
                ChatEvent::ThinkingDelta { .. } => "thinkingDelta",
                ChatEvent::ToolCallStarted { .. } => "toolCallStarted",
                ChatEvent::ToolCallProgress { .. } => "toolCallProgress",
                ChatEvent::ToolCallCompleted { .. } => "toolCallCompleted",
                ChatEvent::FileEdit { .. } => "fileEdit",
                ChatEvent::PermissionRequest { .. } => "permissionRequest",
                ChatEvent::PlanUpdate { .. } => "planUpdate",
                ChatEvent::Usage { .. } => "usage",
                ChatEvent::RateLimit { .. } => "rateLimit",
                ChatEvent::TurnCompleted { .. } => "turnCompleted",
                ChatEvent::SessionError { .. } => "sessionError",
                ChatEvent::SessionEnded { .. } => "sessionEnded",
            };
        }
        // 19 variants; a mismatch means a sample is missing or duplicated.
        assert_eq!(events.len(), 19, "every_event() must hold exactly one sample per variant");
    }

    #[test]
    fn variant_list_covers_every_command() {
        let cmds = every_command();
        for cmd in &cmds {
            let _name = match cmd {
                ChatCommand::SendTurn { .. } => "sendTurn",
                ChatCommand::Steer { .. } => "steer",
                ChatCommand::Interrupt { .. } => "interrupt",
                ChatCommand::RespondPermission { .. } => "respondPermission",
                ChatCommand::SetMode { .. } => "setMode",
                ChatCommand::SetModel { .. } => "setModel",
                ChatCommand::Close { .. } => "close",
            };
        }
        assert_eq!(cmds.len(), 7, "every_command() must hold exactly one sample per variant");
    }

    /// The wire shape the TypeScript mirror is written against: tagged on
    /// `type`, camelCase tag, camelCase fields.
    #[test]
    fn wire_shape_is_tagged_camel_case() {
        let json = serde_json::to_value(&ChatEvent::TextDelta {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            text: "hi".into(),
        })
        .unwrap();
        assert_eq!(json["type"], "textDelta");
        assert_eq!(json["sessionId"], "s1");
        assert_eq!(json["turnId"], "t1");
    }

    /// Emit the sample corpus for `src/utils/chatTypes.test.ts` to consume.
    ///
    /// The TypeScript mirror is meant to match this model's JSON 1:1, and
    /// hand-writing both sides is exactly how a mirror silently drifts: a
    /// renamed field would leave the Rust tests green and the TS tests green
    /// while the two disagree on the wire. Serializing the *same* samples the
    /// round-trip test uses and having the TS test parse that file makes drift
    /// a failure instead of a discovery.
    ///
    /// Output is deterministic (fixed samples, sorted keys), so a run that
    /// changes the file is a real model change and shows up in the diff.
    #[test]
    fn emit_wire_samples_for_the_typescript_mirror() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev/fixtures/chat");
        std::fs::create_dir_all(&dir).expect("create fixture dir");
        let events = serde_json::to_string_pretty(&every_event()).expect("serialize events");
        let commands = serde_json::to_string_pretty(&every_command()).expect("serialize commands");
        std::fs::write(dir.join("events.json"), format!("{events}\n")).expect("write events");
        std::fs::write(dir.join("commands.json"), format!("{commands}\n")).expect("write commands");
    }

    /// Harness-specific data must survive the round trip untouched, since the
    /// whole point of `extra` is that the neutral model does not know what is
    /// in it.
    #[test]
    fn extra_survives_untouched() {
        let ev = ChatEvent::TurnStarted {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            model: "m".into(),
            permission_mode: PermissionMode::new("default"),
            extra: HashMap::from([
                ("ttftMs".into(), serde_json::json!(1575)),
                ("modelUsage".into(), serde_json::json!({ "claude-sonnet-5": { "outputTokens": 205 } })),
            ]),
        };
        let back: ChatEvent = serde_json::from_str(&serde_json::to_string(&ev).unwrap()).unwrap();
        assert_eq!(ev, back);
    }
}
