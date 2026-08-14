//! The vendor-neutral half of the ACP transport: everything that turns a
//! protocol message into a [`ChatEvent`], with no process, no socket and no
//! runtime anywhere in it.
//!
//! Split out of `acp_transport.rs` for the same reason `claude.rs` is split out
//! of `claude_transport.rs`: the mapping is where the protocol is actually
//! *interpreted*, and it is the part worth pinning with tests. Driving a child
//! needs a live agent; mapping an update needs a struct literal.
//!
//! The load-bearing claim of this module is that **ACP needs no new
//! [`ChatEvent`] variant**. Sway's event model was built from Claude's wire
//! format, so a second protocol fitting it without widening it is what makes
//! [[concept_transport_neutral_event_model]] true rather than aspirational. Every
//! mapping below lands on a variant that already existed.

use agent_client_protocol::schema::v1::{
    ContentBlock as AcpContentBlock, ContentChunk, PermissionOption, RequestPermissionRequest,
    SessionUpdate, StopReason, ToolCall, ToolCallStatus, ToolCallUpdate,
};

use super::model::{
    ChatEvent, ContentBlock, PermissionSuggestion, PlanItem, PlanItemStatus, ToolStatus,
    TurnOutcome, Usage,
};

/// How an agent departs from a spec-correct client's defaults.
///
/// Two fields rather than a general escape hatch, because
/// [[concept_acp_agent_quirks]] found exactly two places where a *correct*
/// client is still wrong for a *particular* agent. Keeping the list closed is
/// what keeps [[adr_harness_breadth]]'s "a new harness is a TOML file" claim
/// honest: a third quirk has to be argued for and named here, not smuggled in as
/// free-form JSON.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AcpOverrides {
    /// Send Sway's MCP servers on `session/new`.
    ///
    /// **Defaults to off**, which is the safe direction: an adapter that does
    /// not itself speak MCP can fail `session/new` outright when the array is
    /// populated rather than ignoring it, so an agent has to opt in to being
    /// told about them. The key is still always *present* on the wire - an empty
    /// array is a value and an absent key is a protocol error.
    pub send_mcp_servers: bool,
    /// Advertise the client's filesystem and terminal capabilities.
    ///
    /// **Defaults to off**, matching the plan's decision that agents do their
    /// own I/O. Declining all three is a complete and legitimate configuration;
    /// some agents merely behave *better* when a client serves them, which is
    /// what this opts into.
    pub serve_client_fs: bool,
}

/// Sway's turn identity for an ACP turn.
///
/// ACP has no turn id: a turn is the span from one `session/prompt` to its
/// `StopReason`, and every update in between belongs to it implicitly. Sway's
/// event model keys almost everything on `turn_id`, so the transport mints one
/// per prompt and stamps it on the way through. Deriving it from a counter
/// rather than from a protocol field is deliberate - there is no field to
/// derive it from, and inventing one that looked protocol-supplied would be a
/// lie the next reader has to un-learn.
pub fn turn_id(seq: u64) -> String {
    format!("acp-turn-{seq}")
}

/// Name a content block Sway has no variant for, so it renders as *something*.
///
/// Dropping it instead would read as the agent having said nothing, which is a
/// worse lie than naming the thing that arrived.
fn describe_foreign_block(block: &AcpContentBlock) -> String {
    match block {
        AcpContentBlock::Audio(_) => "[audio]".to_string(),
        AcpContentBlock::ResourceLink(r) => format!("[resource: {}]", r.uri),
        AcpContentBlock::Resource(_) => "[embedded resource]".to_string(),
        // `ContentBlock` is `#[non_exhaustive]`: a block added to the protocol
        // after this was written must not stop the build, and must not vanish
        // from the transcript either.
        _ => "[unsupported content]".to_string(),
    }
}

/// The text of a streaming chunk, which is all Sway's delta events carry.
fn chunk_text(chunk: &ContentChunk) -> String {
    match &chunk.content {
        AcpContentBlock::Text(t) => t.text.clone(),
        other => describe_foreign_block(other),
    }
}

/// Map one `session/update` onto Sway's event model.
///
/// Returns a `Vec` rather than an `Option` because the relationship is not
/// one-to-one: an update Sway has no use for yields nothing, and one carrying
/// two independent facts yields two events. An empty result is a normal outcome,
/// never an error - `SessionUpdate` is `#[non_exhaustive]`, so a protocol
/// revision must be able to add an update this build silently ignores instead of
/// failing to compile against a newer agent.
pub fn map_update(session_id: &str, turn_id: &str, update: &SessionUpdate) -> Vec<ChatEvent> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => vec![ChatEvent::TextDelta {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            text: chunk_text(chunk),
        }],

        SessionUpdate::AgentThoughtChunk(chunk) => vec![ChatEvent::ThinkingDelta {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            text: chunk_text(chunk),
        }],

        // A replayed user turn. The live composer pushes its own, so this
        // matters for the turns Sway did not send: everything `session/load`
        // replays into a reopened tab.
        SessionUpdate::UserMessageChunk(chunk) => vec![ChatEvent::UserMessage {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            blocks: vec![ContentBlock::Text { text: chunk_text(chunk) }],
        }],

        SessionUpdate::ToolCall(call) => vec![tool_call_started(session_id, turn_id, call)],

        SessionUpdate::ToolCallUpdate(update) => tool_call_update(session_id, turn_id, update),

        SessionUpdate::Plan(plan) => vec![ChatEvent::PlanUpdate {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            items: plan.entries.iter().filter_map(plan_item).collect(),
        }],

        // ACP reports *context occupancy* (`used` of `size`), not the
        // per-turn input/output split Claude's `result` frame carries. Only
        // `used` is carried across, into the one field that means "tokens the
        // conversation is holding". Spreading it across the other counters
        // would invent a breakdown the agent never reported.
        SessionUpdate::UsageUpdate(usage) => vec![ChatEvent::Usage {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            usage: Usage {
                input_tokens: usage.used,
                ..Usage::default()
            },
            extra: Default::default(),
        }],

        // Modes, config options, session metadata and command catalogues all
        // change session-level state rather than describing turn content. They
        // reach the UI through the handshake and the session events, so they
        // produce nothing here rather than being forced into a turn-shaped
        // event they do not belong to.
        _ => Vec::new(),
    }
}

/// Carry one plan entry across, dropping any whose status this build does not
/// know. `PlanEntryStatus` is `#[non_exhaustive]`, and a status invented after
/// this was written has no honest Sway counterpart - showing it as `Pending`
/// would claim the agent had not started work it may well have finished.
fn plan_item(entry: &agent_client_protocol::schema::v1::PlanEntry) -> Option<PlanItem> {
    use agent_client_protocol::schema::v1::PlanEntryStatus;
    let status = match entry.status {
        PlanEntryStatus::Pending => PlanItemStatus::Pending,
        PlanEntryStatus::InProgress => PlanItemStatus::InProgress,
        PlanEntryStatus::Completed => PlanItemStatus::Completed,
        _ => return None,
    };
    Some(PlanItem { text: entry.content.clone(), status })
}

fn tool_call_started(session_id: &str, turn_id: &str, call: &ToolCall) -> ChatEvent {
    ChatEvent::ToolCallStarted {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        tool_use_id: call.tool_call_id.0.to_string(),
        name: call.title.clone(),
        input: call.raw_input.clone().unwrap_or(serde_json::Value::Null),
    }
}

/// A `tool_call_update` is a status patch, so whether it is "progress" or
/// "completed" is decided by the status it carries rather than by its name.
///
/// An update with no status at all is a content-only patch and yields nothing:
/// reporting it as progress would restart a card the agent only meant to amend.
fn tool_call_update(session_id: &str, turn_id: &str, update: &ToolCallUpdate) -> Vec<ChatEvent> {
    let tool_use_id = update.tool_call_id.0.to_string();
    let Some(status) = update.fields.status else {
        return Vec::new();
    };
    match status {
        ToolCallStatus::Completed | ToolCallStatus::Failed => {
            vec![ChatEvent::ToolCallCompleted {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
                tool_use_id,
                status: if status == ToolCallStatus::Completed {
                    ToolStatus::Ok
                } else {
                    ToolStatus::Error
                },
                output: update
                    .fields
                    .raw_output
                    .as_ref()
                    .map(|v| v.to_string()),
                // ACP does not report which paths a call wrote, so this stays
                // empty rather than being guessed at. It is the field
                // per-turn attribution reads, and a wrong path there would
                // attribute another session's edit to this one.
                files: Vec::new(),
                duration_ms: None,
            }]
        }
        ToolCallStatus::InProgress | ToolCallStatus::Pending => {
            vec![ChatEvent::ToolCallProgress {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
                tool_use_id,
                partial_input: update
                    .fields
                    .raw_input
                    .as_ref()
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
            }]
        }
        _ => Vec::new(),
    }
}

/// Turn a `session/request_permission` into Sway's prompt event.
///
/// The agent's own options are carried through as suggestions rather than being
/// collapsed into Allow/Deny. Per [[concept_acp_agent_quirks]] the permission
/// vocabulary belongs to the agent: it supplies `optionId` and `kind`, the
/// client renders what was offered and echoes the chosen id back. Imposing a
/// fixed pair here would silently drop options like "allow for this session"
/// that the agent was willing to honour.
pub fn map_permission_request(
    session_id: &str,
    request_id: &str,
    request: &RequestPermissionRequest,
    auto_deny_at_ms: Option<u64>,
) -> ChatEvent {
    ChatEvent::PermissionRequest {
        session_id: session_id.to_string(),
        tool_use_id: request.tool_call.tool_call_id.0.to_string(),
        tool_name: request
            .tool_call
            .fields
            .title
            .clone()
            .unwrap_or_else(|| "tool".to_string()),
        input: request
            .tool_call
            .fields
            .raw_input
            .clone()
            .unwrap_or(serde_json::Value::Null),
        request_id: request_id.to_string(),
        auto_deny_at_ms,
        // ACP has no subagent attribution on a permission request, so this is
        // left unknown rather than attributed to the main agent.
        agent_id: None,
        suggestions: request.options.iter().map(option_as_suggestion).collect(),
    }
}

/// Carry one agent-offered permission option across as a suggestion.
/// The agent's `optionId` rides in `destination`, because that is the field the
/// answer path echoes back. ACP has no rule grammar to fill `rules` with: an
/// option is an opaque id the agent already knows the meaning of, so Sway
/// carries the id and stays out of the semantics.
fn option_as_suggestion(option: &PermissionOption) -> PermissionSuggestion {
    use agent_client_protocol::schema::v1::PermissionOptionKind;
    PermissionSuggestion::AddRules {
        rules: Vec::new(),
        behavior: match option.kind {
            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways => {
                "allow".to_string()
            }
            _ => "deny".to_string(),
        },
        destination: option.option_id.0.to_string(),
    }
}

/// Map a turn's `StopReason` onto Sway's turn outcome.
///
/// `Refusal` is the one that costs something to get wrong: the spec says the
/// user prompt *and everything after it* are dropped from the next prompt, so a
/// refused turn that rendered as a normal completion would leave the transcript
/// showing a message the agent will never see again.
pub fn map_stop_reason(session_id: &str, turn_id: &str, reason: StopReason) -> ChatEvent {
    let outcome = match reason {
        StopReason::EndTurn => TurnOutcome::Completed,
        StopReason::Cancelled => TurnOutcome::Cancelled,
        // Not errors in the transport sense - the turn ran and ended for a
        // stated reason - but each leaves the conversation in a state the user
        // has to be told about, so none of them may render as a clean finish.
        StopReason::MaxTokens | StopReason::MaxTurnRequests | StopReason::Refusal => {
            TurnOutcome::Errored
        }
        // `StopReason` is `#[non_exhaustive]`. A reason added later is reported
        // as completed with its own wire spelling attached, rather than being
        // guessed at as a failure.
        _ => TurnOutcome::Completed,
    };
    ChatEvent::TurnCompleted {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        outcome,
        stop_reason: Some(stop_reason_wire(reason).to_string()),
        usage: Usage::default(),
        cost_usd: None,
        permission_denials: Vec::new(),
        extra: Default::default(),
    }
}

/// The protocol's own spelling, so the UI reports the agent's reason rather
/// than a Sway paraphrase of it.
fn stop_reason_wire(reason: StopReason) -> &'static str {
    match reason {
        StopReason::EndTurn => "end_turn",
        StopReason::MaxTokens => "max_tokens",
        StopReason::MaxTurnRequests => "max_turn_requests",
        StopReason::Refusal => "refusal",
        StopReason::Cancelled => "cancelled",
        _ => "unknown",
    }
}

/// Translate a user turn's blocks into ACP content.
///
/// A `FileRef` has no ACP counterpart, so it renders as text naming the path and
/// range - the same choice `claude.rs` makes, for the same reason: dropping it
/// would silently lose an `@`-mention.
pub fn prompt_blocks(blocks: &[ContentBlock]) -> Vec<AcpContentBlock> {
    use agent_client_protocol::schema::v1::{ImageContent, TextContent};
    blocks
        .iter()
        .map(|b| match b {
            ContentBlock::Text { text } => AcpContentBlock::Text(TextContent::new(text.clone())),
            ContentBlock::Image { media_type, data } => {
                AcpContentBlock::Image(ImageContent::new(data.clone(), media_type.clone()))
            }
            ContentBlock::FileRef { path, start_line, end_line, text } => {
                let mut rendered = match (start_line, end_line) {
                    (Some(s), Some(e)) => format!("@{path}#L{s}-{e}"),
                    (Some(s), None) => format!("@{path}#L{s}"),
                    _ => format!("@{path}"),
                };
                if let Some(t) = text {
                    rendered.push_str("\n\n");
                    rendered.push_str(t);
                }
                AcpContentBlock::Text(TextContent::new(rendered))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        PermissionOptionId, PermissionOptionKind, TextContent, ToolCallId, ToolCallUpdateFields,
    };

    fn text_chunk(text: &str) -> ContentChunk {
        ContentChunk::new(AcpContentBlock::Text(TextContent::new(text.to_string())))
    }

    #[test]
    fn an_agent_message_chunk_becomes_a_text_delta() {
        let events = map_update("s1", "t1", &SessionUpdate::AgentMessageChunk(text_chunk("hi")));
        assert!(matches!(
            events.as_slice(),
            [ChatEvent::TextDelta { text, .. }] if text == "hi"
        ));
    }

    #[test]
    fn a_thought_chunk_is_thinking_rather_than_speech() {
        let events = map_update("s1", "t1", &SessionUpdate::AgentThoughtChunk(text_chunk("hm")));
        assert!(matches!(events.as_slice(), [ChatEvent::ThinkingDelta { .. }]));
    }

    /// Build a status-only update, which is the shape every tool-call patch
    /// takes here. `ToolCallUpdateFields` is `#[non_exhaustive]`, so it can only
    /// be built by mutating a default rather than by a struct literal.
    fn tool_update(id: &str, status: Option<ToolCallStatus>) -> ToolCallUpdate {
        let mut fields = ToolCallUpdateFields::default();
        fields.status = status;
        ToolCallUpdate::new(ToolCallId::new(id), fields)
    }

    /// A content-only patch must not restart the card. `tool_call_update`
    /// carries an optional status precisely so an agent can amend a call's
    /// content without claiming its state changed.
    #[test]
    fn a_tool_call_update_without_a_status_yields_nothing() {
        let update = tool_update("call-1", None);
        assert!(map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(update)).is_empty());
    }

    #[test]
    fn a_failed_tool_call_completes_as_an_error_rather_than_ok() {
        let update = tool_update("call-1", Some(ToolCallStatus::Failed));
        let events = map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(update));
        assert!(matches!(
            events.as_slice(),
            [ChatEvent::ToolCallCompleted { status: ToolStatus::Error, .. }]
        ));
    }

    #[test]
    fn a_completed_tool_call_reports_no_files_rather_than_guessing_at_them() {
        let update = tool_update("call-1", Some(ToolCallStatus::Completed));
        let events = map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(update));
        assert!(matches!(
            events.as_slice(),
            [ChatEvent::ToolCallCompleted { status: ToolStatus::Ok, files, .. }] if files.is_empty()
        ));
    }

    /// The protocol is `#[non_exhaustive]` and gains updates over time. An
    /// update this build has no mapping for must produce nothing rather than
    /// panicking or being forced into a turn event it does not belong to.
    #[test]
    fn an_update_with_no_sway_counterpart_maps_to_no_events() {
        use agent_client_protocol::schema::v1::{CurrentModeUpdate, SessionModeId};
        let update =
            SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(SessionModeId::new("plan")));
        assert!(map_update("s1", "t1", &update).is_empty());
    }

    /// A refusal drops the user's prompt from the agent's history, so it cannot
    /// render as a clean completion.
    #[test]
    fn a_refusal_is_not_reported_as_a_completed_turn() {
        let event = map_stop_reason("s1", "t1", StopReason::Refusal);
        assert!(matches!(
            event,
            ChatEvent::TurnCompleted { outcome: TurnOutcome::Errored, ref stop_reason, .. }
                if stop_reason.as_deref() == Some("refusal")
        ));
    }

    /// Cancellation is a stop reason, not a failure: the spec requires the agent
    /// to answer a cancelled prompt with this reason, and a client that showed
    /// it as an error would report the user's own interrupt as a fault.
    #[test]
    fn a_cancelled_turn_is_an_interrupt_rather_than_an_error() {
        let event = map_stop_reason("s1", "t1", StopReason::Cancelled);
        assert!(matches!(
            event,
            ChatEvent::TurnCompleted { outcome: TurnOutcome::Cancelled, .. }
        ));
    }

    /// The agent owns the permission vocabulary. Every option it offered has to
    /// survive into the prompt, or Sway silently narrows what the user may
    /// choose.
    #[test]
    fn every_option_the_agent_offered_reaches_the_prompt() {
        let mut tool_call = tool_update("call-1", None);
        tool_call.fields.title = Some("Bash".to_string());
        let request = RequestPermissionRequest::new(
            agent_client_protocol::schema::v1::SessionId::new("s1"),
            tool_call,
            vec![
                PermissionOption::new(
                    PermissionOptionId::new("allow-once"),
                    "Allow once".to_string(),
                    PermissionOptionKind::AllowOnce,
                ),
                PermissionOption::new(
                    PermissionOptionId::new("reject"),
                    "Reject".to_string(),
                    PermissionOptionKind::RejectOnce,
                ),
            ],
        );

        let event = map_permission_request("s1", "req-1", &request, None);
        let ChatEvent::PermissionRequest { suggestions, tool_name, .. } = event else {
            panic!("expected a permission request");
        };
        assert_eq!(tool_name, "Bash");
        assert_eq!(suggestions.len(), 2);
        let ids: Vec<_> = suggestions
            .iter()
            .map(|s| match s {
                PermissionSuggestion::AddRules { destination, behavior, .. } => {
                    (destination.clone(), behavior.clone())
                }
                _ => panic!("an ACP option must carry across as a rule suggestion"),
            })
            .collect();
        assert_eq!(
            ids,
            vec![
                ("allow-once".to_string(), "allow".to_string()),
                ("reject".to_string(), "deny".to_string()),
            ]
        );
    }

    #[test]
    fn a_file_reference_renders_as_text_naming_the_path_and_range() {
        let blocks = prompt_blocks(&[ContentBlock::FileRef {
            path: "src/main.rs".to_string(),
            start_line: Some(10),
            end_line: Some(20),
            text: None,
        }]);
        assert!(matches!(
            blocks.as_slice(),
            [AcpContentBlock::Text(t)] if t.text == "@src/main.rs#L10-20"
        ));
    }

    /// The default is the spec-correct, agent-does-its-own-I/O configuration.
    /// Both overrides exist to be turned *on* by an adapter that needs them, so
    /// an adapter that says nothing gets the safe shape.
    #[test]
    fn the_default_overrides_decline_everything() {
        let overrides = AcpOverrides::default();
        assert!(!overrides.send_mcp_servers);
        assert!(!overrides.serve_client_fs);
    }
}
