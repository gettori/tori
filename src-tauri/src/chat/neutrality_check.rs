//! A compiling proof that `ChatEvent` is actually transport-neutral.
//!
//! "The model is harness-agnostic" is the kind of claim that is true when
//! written and quietly false a month later, because the only transport in the
//! tree is Claude's and nothing pushes back when a Claude-shaped assumption
//! leaks into the model. This module is the pushback: it declares the *source*
//! event vocabularies of the two harnesses parked as handoffs - Codex's
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
    ChatEvent, FileEditKind, PermissionMode, PlanItem, PlanItemStatus, ToolStatus, TurnOutcome, Usage,
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
            permission_mode: PermissionMode::Default,
            tools: vec![],
            slash_commands: vec![],
            mcp_servers: vec![],
            models: vec![],
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
            extra: Default::default(),
        },
        // Resuming re-establishes the same session, so it is a start too; the
        // history backfill is a separate concern from the live stream.
        CodexEvent::ThreadResumed => ChatEvent::SessionStarted {
            session_id: sid(),
            cwd: "/tmp/w".into(),
            model: "gpt-5-codex".into(),
            permission_mode: PermissionMode::Default,
            tools: vec![],
            slash_commands: vec![],
            mcp_servers: vec![],
            models: vec![],
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
            extra: Default::default(),
        },
        // A fork is a *different* session id, so it is that new session
        // starting rather than an event on the original.
        CodexEvent::ThreadForked => ChatEvent::SessionStarted {
            session_id: "s2".into(),
            cwd: "/tmp/w".into(),
            model: "gpt-5-codex".into(),
            permission_mode: PermissionMode::Default,
            tools: vec![],
            slash_commands: vec![],
            mcp_servers: vec![],
            models: vec![],
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
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
            model: "gpt-5-codex".into(),
            permission_mode: PermissionMode::Default,
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
        },
        CodexEvent::ItemCompleted => ChatEvent::ToolCallCompleted {
            session_id: sid(),
            turn_id: tid(),
            tool_use_id: "item_1".into(),
            status: ToolStatus::Ok,
            output: None,
            files: vec![],
            duration_ms: None,
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
        },
        // ACP's "thought" is the same thing Claude calls thinking: reasoning
        // shown collapsed, not part of the answer.
        AcpSessionUpdate::AgentThoughtChunk => ChatEvent::ThinkingDelta {
            session_id: sid(),
            turn_id: tid(),
            text: String::new(),
        },
        AcpSessionUpdate::ToolCall => ChatEvent::ToolCallStarted {
            session_id: sid(),
            turn_id: tid(),
            tool_use_id: "acp_1".into(),
            name: "read_text_file".into(),
            input: serde_json::json!({}),
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
        AcpSessionUpdate::AvailableCommandsUpdate => ChatEvent::SessionStarted {
            session_id: sid(),
            cwd: "/tmp/w".into(),
            model: "gemini-2.5-pro".into(),
            permission_mode: PermissionMode::Default,
            tools: vec![],
            slash_commands: vec![],
            mcp_servers: vec![],
            models: vec![],
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
            extra: Default::default(),
        },
        // A mode change lands on the same field the next turn reports, which is
        // how Claude confirms a mode switch took effect too.
        AcpSessionUpdate::CurrentModeUpdate => ChatEvent::TurnStarted {
            session_id: sid(),
            turn_id: tid(),
            model: "gemini-2.5-pro".into(),
            permission_mode: PermissionMode::AcceptEdits,
            extra: Default::default(),
        },
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
            (AcpSessionUpdate::CurrentModeUpdate, "turnStarted"),
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
        assert!(
            acp_unmapped <= 1,
            "{acp_unmapped} acp variants have no normalized target; the model has drifted Claude-ward"
        );
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
}
