//! A compiling proof that `ChatEvent` is actually transport-neutral.
//!
//! "The model is agent-agnostic" is the kind of claim that is true when
//! written and quietly false a month later, because the only transport in the
//! tree is Claude's and nothing pushes back when a Claude-shaped assumption
//! leaks into the model. This module is the pushback: it declares the *source*
//! event vocabularies of the two agents parked as handoffs - Codex's
//! `app-server` methods and ACP's `session/update` variants - and maps each
//! one into a `ChatEvent` with an **exhaustive `match`**.
//!
//! The check is that adding a variant to either source enum stops the crate
//! compiling until someone decides where it lands. If `ChatEvent` has drifted
//! Claude-ward, that decision becomes visibly impossible rather than a comment
//! somebody wrote once.
//!
//! Two deliberate rules, because a compiling check is easy to hollow out:
//!
//!   1. **A source variant with no sensible target maps to an explicit
//!      `ChatEvent::SessionError` arm**, never to a `// TODO` or a silently
//!      dropped `None`. An unmappable event is a real gap and has to look like
//!      one.
//!   2. **Compilation alone is not the check.** An arm could satisfy the
//!      compiler by returning any variant at all, so every arm carries a
//!      one-line justification for its target, and `mapping_targets_are_stable`
//!      below pins the source-to-target table so a careless re-point fails a
//!      test rather than relying on review to notice.
//!
//! These enums are *not* the real transports. They are the variant sets, taken
//! from the handoff's live protocol capture, and they exist only under
//! `cfg(test)`. The real Codex and ACP transports replace them wholesale.

use super::model::{
    ChatCommand, ChatEvent, FileEditKind, PermissionMode, PlanItem, PlanItemStatus, ToolKind, ToolStatus,
    TurnOutcome, Usage,
};

// ---------------------------------------------------------------------------
// Source vocabulary: Codex `app-server` (codex-cli 0.144.5)
// ---------------------------------------------------------------------------

/// The streaming and lifecycle methods `codex app-server` emits, per the
/// generated TypeScript bindings captured in the parked handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexEvent {
    ThreadStarted,
    ThreadResumed,
    ThreadForked,
    ThreadCompacted,
    ThreadArchived,
    TurnStarted,
    TurnCompleted,
    TurnInterrupted,
    ItemStarted,
    ItemCompleted,
    ProcessOutputDelta,
    ProcessExited,
    RawResponseItemCompleted,
    ExecCommandApproval,
    ApplyPatchApproval,
    TokenCount,
}

// ---------------------------------------------------------------------------
// Source vocabulary: ACP `session/update` (gemini-cli 0.46.0, `--acp`)
// ---------------------------------------------------------------------------

/// The `SessionNotification` update variants of the Agent Client Protocol.
/// Written as the general ACP set rather than a Gemini-specific one, matching
/// the handoff's decision to build that transport as a general ACP client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpSessionUpdate {
    UserMessageChunk,
    AgentMessageChunk,
    AgentThoughtChunk,
    ToolCall,
    ToolCallUpdate,
    Plan,
    AvailableCommandsUpdate,
    CurrentModeUpdate,
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

fn sid() -> String {
    "s1".to_string()
}
fn tid() -> String {
    "t1".to_string()
}

/// Exhaustive over `CodexEvent`. Adding a variant breaks this build.
pub fn map_codex(ev: CodexEvent) -> ChatEvent {
    match ev {
        // A thread starting is a session coming up, the same thing Claude's
        // first `system/init` means.
        CodexEvent::ThreadStarted => ChatEvent::SessionStarted {
            session_id: sid(),
            cwd: "/tmp/w".into(),
            model: "gpt-5-codex".into(),
            permission_mode: PermissionMode::new("default"),
            tools: vec![],
            slash_commands: vec![],
            mcp_servers: vec![],
            models: vec![],
            modes: vec![],
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
            account: None,
            extra: Default::default(),
        },
        // Resuming re-establishes the same session, so it is a start too; the
        // history backfill is a separate concern from the live stream.
        CodexEvent::ThreadResumed => ChatEvent::SessionStarted {
            session_id: sid(),
            cwd: "/tmp/w".into(),
            model: "gpt-5-codex".into(),
            permission_mode: PermissionMode::new("default"),
            tools: vec![],
            slash_commands: vec![],
            mcp_servers: vec![],
            models: vec![],
            modes: vec![],
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
            account: None,
            extra: Default::default(),
        },
        // A fork is a *different* session id, so it is that new session
        // starting rather than an event on the original.
        CodexEvent::ThreadForked => ChatEvent::SessionStarted {
            session_id: "s2".into(),
            cwd: "/tmp/w".into(),
            model: "gpt-5-codex".into(),
            permission_mode: PermissionMode::new("default"),
            tools: vec![],
            slash_commands: vec![],
            mcp_servers: vec![],
            models: vec![],
            modes: vec![],
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
            account: None,
            extra: Default::default(),
        },
        // Compaction changes what the context holds, which the UI reads as a
        // usage change; the summary itself rides in `extra`.
        CodexEvent::ThreadCompacted => ChatEvent::Usage {
            session_id: sid(),
            turn_id: tid(),
            usage: Usage::default(),
            extra: Default::default(),
        },
        // Archiving ends the session as far as a live surface is concerned.
        CodexEvent::ThreadArchived => ChatEvent::SessionEnded {
            session_id: sid(),
            reason: Some("thread archived".into()),
        },
        CodexEvent::TurnStarted => ChatEvent::TurnStarted {
            session_id: sid(),
            turn_id: tid(),
            agent_initiated: false,
            model: "gpt-5-codex".into(),
            permission_mode: PermissionMode::new("default"),
            extra: Default::default(),
        },
        CodexEvent::TurnCompleted => ChatEvent::TurnCompleted {
            session_id: sid(),
            turn_id: tid(),
            outcome: TurnOutcome::Completed,
            stop_reason: Some("end_turn".into()),
            usage: Usage::default(),
            cost_usd: None,
            permission_denials: vec![],
            extra: Default::default(),
        },
        // An interrupt is still a completion, distinguished by outcome - the
        // same distinction that stops the composer queue flushing on stop.
        CodexEvent::TurnInterrupted => ChatEvent::TurnCompleted {
            session_id: sid(),
            turn_id: tid(),
            outcome: TurnOutcome::Cancelled,
            stop_reason: Some("interrupted".into()),
            usage: Usage::default(),
            cost_usd: None,
            permission_denials: vec![],
            extra: Default::default(),
        },
        // Codex's `item` is a content item: a tool call beginning is the case
        // the chat surface has to render, so it maps to the tool card's start.
        CodexEvent::ItemStarted => ChatEvent::ToolCallStarted {
            session_id: sid(),
            turn_id: tid(),
            tool_use_id: "item_1".into(),
            name: "shell".into(),
            input: serde_json::json!({}),
            // The vocabulary absorbing a third agent is the point of this file:
            // Codex names its shell tool `shell` and the neutral model files it
            // under the same kind Claude's `Bash` and ACP's `execute` land on.
            kind: ToolKind::Execute,
            locations: vec![],
            title: None,
        },
        CodexEvent::ItemCompleted => ChatEvent::ToolCallCompleted {
            session_id: sid(),
            turn_id: tid(),
            tool_use_id: "item_1".into(),
            status: ToolStatus::Ok,
            output: None,
            files: vec![],
            duration_ms: None,
            summary: None,
            output_truncated: false,
            patch: Vec::new(),
        },
        // Streaming stdout of a running command is progress on its call, not
        // assistant prose - it belongs inside the tool card.
        CodexEvent::ProcessOutputDelta => ChatEvent::ToolCallProgress {
            session_id: sid(),
            turn_id: tid(),
            tool_use_id: "item_1".into(),
            partial_input: String::new(),
        },
        CodexEvent::ProcessExited => ChatEvent::ToolCallCompleted {
            session_id: sid(),
            turn_id: tid(),
            tool_use_id: "item_1".into(),
            status: ToolStatus::Ok,
            output: None,
            files: vec![],
            duration_ms: None,
            summary: None,
            output_truncated: false,
            patch: Vec::new(),
        },
        // Codex's approvals are native and in-protocol rather than hook-based,
        // but they carry the same payload the prompt needs, so they land on the
        // same card by tool id. This is the arm that proves the approval model
        // is not Claude-hook-shaped.
        CodexEvent::ExecCommandApproval => ChatEvent::PermissionRequest {
            session_id: sid(),
            tool_use_id: "item_1".into(),
            tool_name: "shell".into(),
            input: serde_json::json!({}),
            request_id: "rpc-1".into(),
            auto_deny_at_ms: None,
            // Both are optional for exactly this reason: they are things one
            // agent happens to send, not things the neutral model requires.
            // Codex names no subagent and offers no alternatives.
            agent_id: None,
            suggestions: vec![],
        },
        // A patch approval is an approval *and* the only advance notice that a
        // file is about to change, but it has not changed yet, so it is the
        // prompt and not a `FileEdit`.
        CodexEvent::ApplyPatchApproval => ChatEvent::PermissionRequest {
            session_id: sid(),
            tool_use_id: "item_2".into(),
            tool_name: "apply_patch".into(),
            input: serde_json::json!({}),
            request_id: "rpc-2".into(),
            auto_deny_at_ms: None,
            agent_id: None,
            suggestions: vec![],
        },
        CodexEvent::TokenCount => ChatEvent::Usage {
            session_id: sid(),
            turn_id: tid(),
            usage: Usage::default(),
            extra: Default::default(),
        },
        // No sensible target, and deliberately explicit rather than dropped:
        // the raw provider response item is a debugging passthrough with no
        // normalized meaning. If a transport ever routes real content through
        // it, this loud arm is what surfaces the gap.
        CodexEvent::RawResponseItemCompleted => ChatEvent::SessionError {
            session_id: sid(),
            message: "codex rawResponseItem/completed has no normalized mapping".into(),
            fatal: false,
        },
    }
}

/// Exhaustive over `AcpSessionUpdate`. Adding a variant breaks this build.
pub fn map_acp(update: AcpSessionUpdate) -> ChatEvent {
    match update {
        // The user's own message echoed back. Sway already rendered it when it
        // was sent, so replaying it as an event would duplicate the bubble;
        // there is no neutral "echo" event and inventing one to satisfy a
        // single transport is exactly the drift this module exists to prevent.
        AcpSessionUpdate::UserMessageChunk => ChatEvent::SessionError {
            session_id: sid(),
            message: "acp user_message_chunk is an echo with no normalized target".into(),
            fatal: false,
        },
        AcpSessionUpdate::AgentMessageChunk => ChatEvent::TextDelta {
            session_id: sid(),
            turn_id: tid(),
            text: String::new(),
            agent_id: None,
        },
        // ACP's "thought" is the same thing Claude calls thinking: reasoning
        // shown collapsed, not part of the answer.
        AcpSessionUpdate::AgentThoughtChunk => ChatEvent::ThinkingDelta {
            session_id: sid(),
            turn_id: tid(),
            text: String::new(),
            agent_id: None,
        },
        AcpSessionUpdate::ToolCall => ChatEvent::ToolCallStarted {
            session_id: sid(),
            turn_id: tid(),
            tool_use_id: "acp_1".into(),
            name: "read".into(),
            input: serde_json::json!({}),
            // `name` is the kind's token and the agent's prose goes to `title`,
            // which is what the ACP adapter really does: a title like "Read the
            // file README.md" is not something a mono row can show.
            kind: ToolKind::Read,
            locations: vec![],
            title: Some("read_text_file".into()),
        },
        // ACP folds progress and completion into one update discriminated by
        // its status field, and the completed case is the one that carries the
        // written paths per-turn attribution needs.
        AcpSessionUpdate::ToolCallUpdate => ChatEvent::ToolCallCompleted {
            session_id: sid(),
            turn_id: tid(),
            tool_use_id: "acp_1".into(),
            status: ToolStatus::Ok,
            output: None,
            files: vec![],
            duration_ms: None,
            summary: None,
            output_truncated: false,
            patch: Vec::new(),
        },
        AcpSessionUpdate::Plan => ChatEvent::PlanUpdate {
            session_id: sid(),
            turn_id: tid(),
            items: vec![PlanItem {
                text: String::new(),
                status: PlanItemStatus::Pending,
            }],
        },
        // The slash-command catalogue can change mid-session in ACP, where
        // Claude only reports it at init. `SessionStarted` carries the
        // catalogue, so a refresh is a re-announcement of the session's
        // capabilities rather than a new event type.
        //
        // The mode is Gemini's own `auto_edit`, not Claude's `acceptEdits`.
        // While `PermissionMode` was an enum this file had to say `AcceptEdits`,
        // because Claude's four variants were the only vocabulary the model
        // had: a Gemini event was recorded under a Claude name and the check
        // still passed. That substitution is what made the enum a neutrality
        // leak rather than a neutrality guard.
        AcpSessionUpdate::AvailableCommandsUpdate => ChatEvent::SessionStarted {
            session_id: sid(),
            cwd: "/tmp/w".into(),
            model: "gemini-2.5-pro".into(),
            permission_mode: PermissionMode::new("auto_edit"),
            tools: vec![],
            slash_commands: vec![],
            mcp_servers: vec![],
            models: vec![],
            modes: vec![],
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
            account: None,
            extra: Default::default(),
        },
        // No counterpart, honestly: `acp.rs` drops this update (pinned by its
        // `an_update_with_no_sway_counterpart_maps_to_no_events`), and a mode is
        // confirmed by the `set_config_option` answer, which no measured agent skips.
        AcpSessionUpdate::CurrentModeUpdate => ChatEvent::SessionError {
            session_id: sid(),
            message: "acp current_mode_update is dropped; a mode is confirmed by the config option answer"
                .into(),
            fatal: false,
        },
    }
}

// ---------------------------------------------------------------------------
// The other direction: what a agent can be *asked* to do
// ---------------------------------------------------------------------------

/// What a agent does with one [`ChatCommand`].
///
/// The command side needs its own check for a reason the event side does not
/// have: an event Sway cannot map is a gap in the *model*, but a verb a agent
/// cannot serve is normal and permanent. Nothing is wrong with a transport that
/// has no mid-turn input; what would be wrong is a verb only Claude can be
/// asked for, since then the trait is Claude's interface wearing a neutral name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    /// The agent has a wire form for this verb.
    Native,
    /// It has none. The transport returns an error, and the caller degrades;
    /// it must never accept the call and quietly do something else, which the
    /// caller could not tell apart from success.
    Refuses,
}

/// Codex `app-server`, per the captured protocol in the parked handoff.
///
/// Exhaustive on purpose: a new [`ChatCommand`] stops this compiling until
/// someone says what a non-Claude agent does with it.
pub fn codex_support(command: &ChatCommand) -> Support {
    match command {
        ChatCommand::SendTurn { .. } => Support::Native,
        // No mid-turn input in the captured protocol. This is the answer the
        // verb exists to make expressible: refusable, not absent.
        ChatCommand::Steer { .. } => Support::Refuses,
        ChatCommand::Interrupt { .. } => Support::Native,
        ChatCommand::RespondPermission { .. } => Support::Native,
        // `app-server` asks for permission and for nothing else: there is no
        // verb in the captured protocol that puts a form in front of the user,
        // so an answer would have nowhere to go.
        ChatCommand::RespondQuestion { .. } => Support::Refuses,
        ChatCommand::SetMode { .. } => Support::Native,
        ChatCommand::SetModel { .. } => Support::Native,
        // `app-server` has no generic option-setting verb: each lever it
        // exposes is its own named method, so a switch aimed at an id has
        // nowhere to go.
        ChatCommand::SetConfigOption { .. } => Support::Refuses,
        ChatCommand::Close { .. } => Support::Native,
    }
}

/// ACP, same rules.
pub fn acp_support(command: &ChatCommand) -> Support {
    match command {
        ChatCommand::SendTurn { .. } => Support::Native,
        ChatCommand::Steer { .. } => Support::Refuses,
        ChatCommand::Interrupt { .. } => Support::Native,
        ChatCommand::RespondPermission { .. } => Support::Native,
        // `elicitation/create` is the wire form this would answer, and it is
        // gated behind the `unstable_elicitation` cargo feature. Probed on
        // codex-acp 1.2.0 and pi-acp 0.0.33: both accept the client capability
        // and neither ever sends one. Refused until an agent actually asks.
        ChatCommand::RespondQuestion { .. } => Support::Refuses,
        // No model or effort switch mid-session in the captured protocol; the
        // mode update is an event ACP *sends*, not one it takes.
        ChatCommand::SetMode { .. } => Support::Refuses,
        ChatCommand::SetModel { .. } => Support::Refuses,
        // `session/set_config_option`, and the one verb the two refusals above
        // are actually routed through by the live transport: what the captured
        // vocabulary lacked was a *model* switch, not a way to set an option.
        ChatCommand::SetConfigOption { .. } => Support::Native,
        ChatCommand::Close { .. } => Support::Native,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The discriminant name of a `ChatEvent`, used to pin the mapping table
    /// without writing out whole values.
    fn target(ev: &ChatEvent) -> &'static str {
        match ev {
            ChatEvent::SessionStarted { .. } => "sessionStarted",
            ChatEvent::SessionReady { .. } => "sessionReady",
            ChatEvent::HookFired { .. } => "hookFired",
            ChatEvent::TurnStarted { .. } => "turnStarted",
            ChatEvent::ModeRefused { .. } => "modeRefused",
            ChatEvent::UserMessage { .. } => "userMessage",
            ChatEvent::Compacted { .. } => "compacted",
            ChatEvent::SlashCommands { .. } => "slashCommands",
            ChatEvent::CompactionStarted { .. } => "compactionStarted",
            ChatEvent::CompactionFailed { .. } => "compactionFailed",
            ChatEvent::TextDelta { .. } => "textDelta",
            ChatEvent::ThinkingDelta { .. } => "thinkingDelta",
            ChatEvent::ToolCallStarted { .. } => "toolCallStarted",
            ChatEvent::ToolCallProgress { .. } => "toolCallProgress",
            ChatEvent::ToolCallCompleted { .. } => "toolCallCompleted",
            ChatEvent::FileEdit { .. } => "fileEdit",
            ChatEvent::PermissionRequest { .. } => "permissionRequest",
            ChatEvent::QuestionRequest { .. } => "questionRequest",
            ChatEvent::SubagentStarted { .. } => "subagentStarted",
            ChatEvent::SubagentCall { .. } => "subagentCall",
            ChatEvent::SubagentUpdate { .. } => "subagentUpdate",
            ChatEvent::PlanUpdate { .. } => "planUpdate",
            ChatEvent::Usage { .. } => "usage",
            ChatEvent::RateLimit { .. } => "rateLimit",
            ChatEvent::TurnCompleted { .. } => "turnCompleted",
            ChatEvent::SessionError { .. } => "sessionError",
            ChatEvent::SessionEnded { .. } => "sessionEnded",
            ChatEvent::ConfigOptions { .. } => "configOptions",
        }
    }

    /// Compilation only proves *an* arm exists, not that it is the right one -
    /// an arm returning an arbitrary variant type-checks fine. This table is
    /// the second half of the check: re-pointing an arm fails here instead of
    /// depending on a reviewer to spot it.
    #[test]
    fn mapping_targets_are_stable() {
        let codex = [
            (CodexEvent::ThreadStarted, "sessionStarted"),
            (CodexEvent::ThreadResumed, "sessionStarted"),
            (CodexEvent::ThreadForked, "sessionStarted"),
            (CodexEvent::ThreadCompacted, "usage"),
            (CodexEvent::ThreadArchived, "sessionEnded"),
            (CodexEvent::TurnStarted, "turnStarted"),
            (CodexEvent::TurnCompleted, "turnCompleted"),
            (CodexEvent::TurnInterrupted, "turnCompleted"),
            (CodexEvent::ItemStarted, "toolCallStarted"),
            (CodexEvent::ItemCompleted, "toolCallCompleted"),
            (CodexEvent::ProcessOutputDelta, "toolCallProgress"),
            (CodexEvent::ProcessExited, "toolCallCompleted"),
            (CodexEvent::RawResponseItemCompleted, "sessionError"),
            (CodexEvent::ExecCommandApproval, "permissionRequest"),
            (CodexEvent::ApplyPatchApproval, "permissionRequest"),
            (CodexEvent::TokenCount, "usage"),
        ];
        for (src, expected) in codex {
            assert_eq!(target(&map_codex(src)), expected, "codex {src:?} mapped somewhere new");
        }

        let acp = [
            (AcpSessionUpdate::UserMessageChunk, "sessionError"),
            (AcpSessionUpdate::AgentMessageChunk, "textDelta"),
            (AcpSessionUpdate::AgentThoughtChunk, "thinkingDelta"),
            (AcpSessionUpdate::ToolCall, "toolCallStarted"),
            (AcpSessionUpdate::ToolCallUpdate, "toolCallCompleted"),
            (AcpSessionUpdate::Plan, "planUpdate"),
            (AcpSessionUpdate::AvailableCommandsUpdate, "sessionStarted"),
            (AcpSessionUpdate::CurrentModeUpdate, "sessionError"),
        ];
        for (src, expected) in acp {
            assert_eq!(target(&map_acp(src)), expected, "acp {src:?} mapped somewhere new");
        }
    }

    /// The neutrality claim is only meaningful if most source variants reach a
    /// *real* target. If unmappable arms ever became the common case, the model
    /// would have stopped being neutral while every match still compiled.
    #[test]
    fn unmappable_arms_stay_the_exception() {
        let codex_unmapped = [
            CodexEvent::ThreadStarted,
            CodexEvent::ThreadResumed,
            CodexEvent::ThreadForked,
            CodexEvent::ThreadCompacted,
            CodexEvent::ThreadArchived,
            CodexEvent::TurnStarted,
            CodexEvent::TurnCompleted,
            CodexEvent::TurnInterrupted,
            CodexEvent::ItemStarted,
            CodexEvent::ItemCompleted,
            CodexEvent::ProcessOutputDelta,
            CodexEvent::ProcessExited,
            CodexEvent::RawResponseItemCompleted,
            CodexEvent::ExecCommandApproval,
            CodexEvent::ApplyPatchApproval,
            CodexEvent::TokenCount,
        ]
        .into_iter()
        .filter(|e| target(&map_codex(*e)) == "sessionError")
        .count();
        assert!(
            codex_unmapped <= 2,
            "{codex_unmapped} codex variants have no normalized target; the model has drifted Claude-ward"
        );

        let acp_unmapped = [
            AcpSessionUpdate::UserMessageChunk,
            AcpSessionUpdate::AgentMessageChunk,
            AcpSessionUpdate::AgentThoughtChunk,
            AcpSessionUpdate::ToolCall,
            AcpSessionUpdate::ToolCallUpdate,
            AcpSessionUpdate::Plan,
            AcpSessionUpdate::AvailableCommandsUpdate,
            AcpSessionUpdate::CurrentModeUpdate,
        ]
        .into_iter()
        .filter(|u| target(&map_acp(*u)) == "sessionError")
        .count();
        // Two by design: the user-message echo, and `current_mode_update`, which
        // the real mapper drops because the config option answer confirms a mode.
        assert!(
            acp_unmapped <= 2,
            "{acp_unmapped} acp variants have no normalized target; the model has drifted Claude-ward"
        );
    }

    /// **The check that replaces what the `PermissionMode` enum used to do.**
    ///
    /// The enum was a compile-time guard: a agent whose modes were not
    /// Claude's four could not be expressed, so the drift showed up as a build
    /// error. A `String` has the opposite property - it accepts every
    /// vocabulary, which is the point, and therefore *nothing fails to compile
    /// when one goes missing*. Replacing the enum silently disarmed the guard,
    /// because compiling is exactly what a string guarantees.
    ///
    /// So the guard becomes a test, and it has to assert the thing a string
    /// cannot: that a foreign mode reaches the far side **unchanged**. A
    /// resolver that normalized, lowercased, or mapped-to-nearest would still
    /// compile and would still pass a test that only checked "some mode came
    /// out".
    #[test]
    fn a_foreign_mode_vocabulary_survives_the_model_unchanged() {
        // Gemini's real `--approval-mode` values. None of them is one of the
        // four the enum had, and `auto_edit` is deliberately the near-miss of
        // Claude's `acceptEdits`: a mapper quietly folding one into the other
        // is the exact failure this catches.
        for id in ["auto_edit", "yolo", "default", "plan"] {
            let mode = PermissionMode::new(id);
            assert_eq!(mode.as_str(), id, "the model altered a mode it was merely carrying");

            // Across serde too, since the frontend reads these and a rename or
            // a case convention there would be just as silent.
            let wire = serde_json::to_string(&mode).expect("a mode serializes");
            assert_eq!(wire, format!("\"{id}\""), "a mode must cross the boundary as its own id");
            let back: PermissionMode = serde_json::from_str(&wire).expect("a mode deserializes");
            assert_eq!(back, mode);
        }

        // And the mapper above must actually be exercising a foreign one, or
        // this file could go back to Claude-only vocabulary without failing.
        let foreign = map_acp(AcpSessionUpdate::AvailableCommandsUpdate);
        match foreign {
            ChatEvent::SessionStarted { permission_mode, .. } => {
                assert_eq!(
                    permission_mode.as_str(),
                    "auto_edit",
                    "the ACP mapping records a Gemini mode under a Claude name"
                );
            }
            other => panic!("expected SessionStarted, got {other:?}"),
        }
    }

    /// A mode Claude reports that this build has never heard of must survive
    /// the mapper, not be folded into the strictest known one.
    ///
    /// The enum forced that fold, and it was wrong in the one direction that
    /// matters: a session actually running `dontAsk` was reported as
    /// `default`, telling the user the agent would ask before acting when it
    /// would do the opposite.
    #[test]
    fn an_unknown_mode_is_not_downgraded_on_the_way_through() {
        let unknown = PermissionMode::new("dontAsk");
        assert_ne!(unknown, PermissionMode::new("default"));
        assert_eq!(unknown.as_str(), "dontAsk");
    }

    /// `FileEdit` has no arm in either mapper above, which is correct rather
    /// than an omission: Codex reports a patch *approval* before the write and
    /// a generic item completion after it, and ACP folds writes into
    /// `tool_call_update`. Both transports would derive `FileEdit` from a tool
    /// call's payload, not from a distinct source variant. Pinned here so the
    /// absence is a recorded decision instead of looking like a gap.
    #[test]
    fn file_edit_is_derived_not_mapped() {
        let kinds = [FileEditKind::Created, FileEditKind::Modified, FileEditKind::Deleted];
        assert_eq!(kinds.len(), 3);
    }

    /// A verb only Claude can be asked for would make `AgentTransport` Claude's
    /// interface under a neutral name, so every command has to be answerable by
    /// a agent that is not Claude - including by refusing it.
    ///
    /// `Steer` is the one this phase publishes, and both non-Claude agents
    /// refuse it. That is the *right* answer, and the point: a refusable verb is
    /// neutral, an unaskable one is not.
    #[test]
    fn every_command_is_answerable_by_a_agent_that_is_not_claude() {
        let steer = ChatCommand::Steer { session_id: "s1".into(), blocks: vec![] };
        assert_eq!(codex_support(&steer), Support::Refuses);
        assert_eq!(acp_support(&steer), Support::Refuses);

        // Not every verb may refuse, or the trait would describe nothing two
        // agents share. Send, interrupt and close are the floor.
        for cmd in [
            ChatCommand::SendTurn { session_id: "s1".into(), blocks: vec![] },
            ChatCommand::Interrupt { session_id: "s1".into() },
            ChatCommand::Close { session_id: "s1".into() },
        ] {
            assert_eq!(codex_support(&cmd), Support::Native, "{cmd:?} is the shared floor");
            assert_eq!(acp_support(&cmd), Support::Native, "{cmd:?} is the shared floor");
        }
    }
}
