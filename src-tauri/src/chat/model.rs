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

/// The four permission modes, mapped to `--permission-mode`.
///
/// Note that Sway's own `PreToolUse` approval gate runs *ahead* of all of them,
/// so `BypassPermissions` here does not mean unsupervised: hooks run first in
/// the permission chain, which is exactly what makes the gate authoritative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    Plan,
    BypassPermissions,
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
        #[serde(default, skip_serializing_if = "extra_is_empty")]
        extra: Extra,
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
                permission_mode: PermissionMode::BypassPermissions,
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
                }],
                fast_mode_state: Some("off".into()),
                fast_mode_disabled_reason: Some("sdk_opt_in_required".into()),
                extra: extra(),
            },
            ChatEvent::TurnStarted {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                model: "claude-sonnet-5".into(),
                permission_mode: PermissionMode::Default,
                extra: Extra::new(),
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
                mode: PermissionMode::Plan,
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
                ChatEvent::TurnStarted { .. } => "turnStarted",
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
        // 15 variants; a mismatch means a sample is missing or duplicated.
        assert_eq!(events.len(), 15, "every_event() must hold exactly one sample per variant");
    }

    #[test]
    fn variant_list_covers_every_command() {
        let cmds = every_command();
        for cmd in &cmds {
            let _name = match cmd {
                ChatCommand::SendTurn { .. } => "sendTurn",
                ChatCommand::Interrupt { .. } => "interrupt",
                ChatCommand::RespondPermission { .. } => "respondPermission",
                ChatCommand::SetMode { .. } => "setMode",
                ChatCommand::SetModel { .. } => "setModel",
                ChatCommand::Close { .. } => "close",
            };
        }
        assert_eq!(cmds.len(), 6, "every_command() must hold exactly one sample per variant");
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
            permission_mode: PermissionMode::Default,
            extra: HashMap::from([
                ("ttftMs".into(), serde_json::json!(1575)),
                ("modelUsage".into(), serde_json::json!({ "claude-sonnet-5": { "outputTokens": 205 } })),
            ]),
        };
        let back: ChatEvent = serde_json::from_str(&serde_json::to_string(&ev).unwrap()).unwrap();
        assert_eq!(ev, back);
    }
}
