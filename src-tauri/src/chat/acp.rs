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

use std::path::Path;

use agent_client_protocol::schema::v1::{
    ContentBlock as AcpContentBlock, ContentChunk, InitializeResponse, PermissionOption,
    RequestPermissionRequest, SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigSelect, SessionConfigSelectOption, SessionConfigSelectOptions, SessionUpdate,
    StopReason, ToolCall, ToolCallContent, ToolCallLocation, ToolCallStatus, ToolCallUpdate, ToolKind,
};

use super::model;
use super::model::{
    ChatCapabilities, ChatConfigChoice, ChatConfigKind, ChatConfigOption, ChatEffortLevel,
    ChatEvent, ChatModeInfo, ChatModelInfo, ContentBlock, FileEditKind, PermissionSuggestion,
    PlanItem, PlanItemStatus, ToolLocation, ToolStatus, ToolSummary, TurnOutcome, Usage,
};
use super::snapshot;

/// How an agent departs from a spec-correct client's defaults.
///
/// Two fields rather than a general escape hatch, because
/// [[concept_acp_agent_quirks]] found exactly two places where a *correct*
/// client is still wrong for a *particular* agent. Keeping the list closed is
/// what keeps [[adr_agent_breadth]]'s "a new agent is a TOML file" claim
/// honest: a third quirk has to be argued for and named here, not smuggled in as
/// free-form JSON.
///
/// This is also the resolved `[chat.acp]` table: an adapter deserializes
/// straight into it rather than into a parallel struct that would have to be
/// kept in step. `deny_unknown_fields` makes a misspelled or invented quirk a
/// loud load error, which is the same rule stated to the TOML instead of to the
/// reader.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AcpOverrides {
    /// Send Sway's MCP servers on `session/new`.
    ///
    /// **Defaults to off**, which is the safe direction: an adapter that does
    /// not itself speak MCP can fail `session/new` outright when the array is
    /// populated rather than ignoring it, so an agent has to opt in to being
    /// told about them. The key is still always *present* on the wire - an empty
    /// array is a value and an absent key is a protocol error.
    ///
    /// **Not settable from an adapter TOML**, alone among these, and the reason
    /// is worth stating: Sway does not yet forward its MCP configuration over
    /// ACP at all, so the array is empty whichever way this is set. A `[chat.acp]`
    /// key for it would be a published setting that changes nothing on the wire.
    /// It stays here as the shape the quirk needs, and becomes a TOML key in the
    /// same change that populates the array.
    #[serde(skip)]
    pub send_mcp_servers: bool,
    /// Advertise the client's filesystem and terminal capabilities.
    ///
    /// **Defaults to off**, matching the plan's decision that agents do their
    /// own I/O. Declining all three is a complete and legitimate configuration;
    /// some agents merely behave *better* when a client serves them, which is
    /// what this opts into.
    pub serve_client_fs: bool,
}

// ---------------------------------------------------------------------------
// Session configuration: the model catalogue and the modes, read off the wire
// ---------------------------------------------------------------------------

/// The one select option of `category` an agent offered, if it offered one.
///
/// Selected by the **category the agent gave it**, never by its id or its label.
/// Measured on `opencode acp` 1.18.3: the model selector's id is `model` and the
/// mode selector's is `mode`, which is tempting to match on and wrong to - the
/// ids are the agent's own vocabulary and another agent may spell them anything,
/// while `category` is the spec's word for what the option *is*.
fn select_of(
    options: &[SessionConfigOption],
    category: SessionConfigOptionCategory,
) -> Option<(&SessionConfigOption, &SessionConfigSelect)> {
    options.iter().find_map(|o| match (&o.category, &o.kind) {
        (Some(c), SessionConfigKind::Select(select)) if *c == category => Some((o, select)),
        _ => None,
    })
}

/// A select's entries, flattened out of the two shapes the spec allows.
///
/// Grouping is a display concern the picker does not have a row for, so the
/// groups are flattened rather than dropped: a grouped catalogue would otherwise
/// arrive as an empty model list, which reads as "this agent has no models".
fn select_entries(select: &SessionConfigSelect) -> Vec<&SessionConfigSelectOption> {
    match &select.options {
        SessionConfigSelectOptions::Ungrouped(entries) => entries.iter().collect(),
        SessionConfigSelectOptions::Grouped(groups) => {
            groups.iter().flat_map(|g| g.options.iter()).collect()
        }
        _ => Vec::new(),
    }
}

/// The models an agent offered, as the catalogue the picker already reads.
///
/// Empty when the agent offered no model selector, which the picker reads as
/// "fall back to the adapter table" - and an ACP adapter declares no table, so
/// the honest outcome is a picker with nothing to switch to rather than one
/// offering models this agent never mentioned.
///
/// Every field Sway cannot learn from ACP is left at its empty value rather than
/// guessed: `resolved_model` repeats the value because the agent reports no
/// separate resolution. Measured on `opencode acp` 1.18.3: 15 provider-qualified
/// ids (`github-copilot/claude-sonnet-4.6`, `opencode/big-pickle`, ...), the
/// same 15 `opencode models` prints, so nothing is lost by reading them from the
/// wire.
///
/// **Effort levels are a session property here, not a per-model one.** Claude's
/// catalogue names them per model, so `ChatModelInfo` carries them per model;
/// ACP publishes one `thought_level` selector for the whole session, so every
/// model gets the same list. Attaching them to each row rather than reshaping
/// the type keeps the control's one source of truth: it renders what the model
/// it is showing declares, whichever agent filled that in.
pub fn model_catalogue(options: &[SessionConfigOption]) -> Vec<ChatModelInfo> {
    let Some((_, select)) = select_of(options, SessionConfigOptionCategory::Model) else {
        return Vec::new();
    };
    let levels = effort_levels(options);
    select_entries(select)
        .into_iter()
        .map(|entry| ChatModelInfo {
            value: entry.value.0.to_string(),
            resolved_model: entry.value.0.to_string(),
            display_name: entry.name.clone(),
            description: entry.description.clone().unwrap_or_default(),
            supports_effort: !levels.is_empty(),
            supported_effort_levels: levels.clone(),
            // Every one of them enabled: an ACP agent's levels are its own
            // answer about itself, so there is nothing here for Sway to
            // annotate and nothing to refuse.
            effort_levels: levels
                .iter()
                .map(|level| ChatEffortLevel {
                    level: level.clone(),
                    label: level.clone(),
                    disabled: false,
                    note: String::new(),
                })
                .collect(),
            supports_auto_mode: false,
            // Both are claude's own words on its own handshake. ACP publishes
            // whatever levers it has as config options, so an ACP agent with
            // something of the sort reaches the mirror rather than these flags.
            supports_fast_mode: false,
            supports_adaptive_thinking: false,
        })
        .collect()
}

/// The model this session is running right now, as the agent reports it.
pub fn current_model(options: &[SessionConfigOption]) -> Option<String> {
    let (_, select) = select_of(options, SessionConfigOptionCategory::Model)?;
    Some(select.current_value.0.to_string())
}

/// The config id a model switch has to name on `session/set_config_option`.
///
/// Kept rather than re-derived at switch time because the options arrive once,
/// with the session, and the request needs the agent's own id for them. `None`
/// is an agent with no model selector, and a switch on one of those is refused
/// rather than sent to an id Sway made up.
pub fn model_config_id(options: &[SessionConfigOption]) -> Option<String> {
    let (option, _) = select_of(options, SessionConfigOptionCategory::Model)?;
    Some(option.id.0.to_string())
}

/// The modes an agent offered, in the shape the mode selector already reads.
///
/// **ACP has two mechanisms for this and agents use the second.** The spec's own
/// `session/set_mode` takes a `SessionModeId` from the modes `session/new`
/// advertises; separately, an agent may publish a `mode`-category config option.
/// Measured on both agents that have one, `opencode acp` 1.18.3 and
/// `@agentclientprotocol/codex-acp` 1.2.0, it is the config option they use, and
/// `session/set_mode` was never answered by either. So the config option is
/// tried first and the spec verb is the fallback, rather than the other way
/// round: preferring the verb would send every measured agent a request it does
/// not serve.
///
/// `args` is empty because an ACP mode is a request rather than a flag, and
/// `permissive` and `default` are left **undeclared** rather than guessed.
/// Codex's `agent-full-access` really is permissive and its `read-only` really
/// is the safe one, but nothing on the wire says so: the agent publishes an id,
/// a label and a description, and inferring danger from the words in an id is
/// exactly the per-vendor knowledge a generic transport must not carry. What is
/// lost is the permissive caution on such a row, which is a real gap and is
/// recorded as one rather than papered over with a guess.
pub fn mode_catalogue(options: &[SessionConfigOption]) -> Vec<ChatModeInfo> {
    let Some((_, select)) = select_of(options, SessionConfigOptionCategory::Mode) else {
        return Vec::new();
    };
    select_entries(select)
        .into_iter()
        .map(|entry| ChatModeInfo {
            id: entry.value.0.to_string(),
            label: entry.name.clone(),
            hint: entry.description.clone().unwrap_or_default(),
        })
        .collect()
}

/// The mode this session is running right now, as the agent reports it.
pub fn current_mode(options: &[SessionConfigOption]) -> Option<String> {
    let (_, select) = select_of(options, SessionConfigOptionCategory::Mode)?;
    Some(select.current_value.0.to_string())
}

/// The config id a mode switch has to name, on the same rule as
/// [`model_config_id`]: kept because the options arrive once, `None` for an
/// agent that published no mode selector.
pub fn mode_config_id(options: &[SessionConfigOption]) -> Option<String> {
    let (option, _) = select_of(options, SessionConfigOptionCategory::Mode)?;
    Some(option.id.0.to_string())
}

/// The reasoning-effort levels an agent offered, every one of them.
///
/// ACP does have a notion of one, contrary to what this module said until
/// Phase 8: `SessionConfigOptionCategory::ThoughtLevel` is a category of its
/// own, and `@agentclientprotocol/codex-acp` 1.2.0 publishes six levels under
/// it - `low, medium, high, xhigh, max, ultra`.
///
/// **`ultra` used to be dropped here and no longer is.** The narrowing existed
/// because a level travelled as an `Effort` variant and there was no variant for
/// it, so offering the sixth would have been a picker row `set_model` could not
/// carry. A level is a plain string now, so the level goes out exactly as the
/// agent spelled it and the drop has nothing left to protect against: filtering
/// a published level against a list Sway keeps would be Sway deciding which of
/// the agent's own words it approves of.
pub fn effort_levels(options: &[SessionConfigOption]) -> Vec<String> {
    let Some((_, select)) = select_of(options, SessionConfigOptionCategory::ThoughtLevel) else {
        return Vec::new();
    };
    select_entries(select).into_iter().map(|entry| entry.value.0.to_string()).collect()
}

/// The level this session is running right now, as the agent reports it.
pub fn current_effort(options: &[SessionConfigOption]) -> Option<String> {
    let (_, select) = select_of(options, SessionConfigOptionCategory::ThoughtLevel)?;
    Some(select.current_value.0.to_string())
}

/// The config id an effort switch has to name. `None` for an agent that
/// published no thought-level selector, and a switch on one of those is refused
/// rather than sent to an id Sway made up.
pub fn effort_config_id(options: &[SessionConfigOption]) -> Option<String> {
    let (option, _) = select_of(options, SessionConfigOptionCategory::ThoughtLevel)?;
    Some(option.id.0.to_string())
}

/// The agent's category word for an option, or empty for one it left
/// uncategorized.
///
/// A future variant of the spec's `#[non_exhaustive]` enum also reads as empty,
/// which is the honest answer rather than a wrong one: an option Sway cannot
/// categorize is an option no bespoke control claims, and the mirror renders it
/// generically. Naming it something specific would hand it to a control written
/// for a different lever.
fn category_word(category: Option<&SessionConfigOptionCategory>) -> String {
    match category {
        Some(SessionConfigOptionCategory::Model) => "model",
        Some(SessionConfigOptionCategory::Mode) => "mode",
        Some(SessionConfigOptionCategory::ThoughtLevel) => "thought_level",
        Some(SessionConfigOptionCategory::ModelConfig) => "model_config",
        Some(SessionConfigOptionCategory::Other(word)) => word,
        _ => "",
    }
    .to_string()
}

/// Every option the agent published, in the neutral shape the mirror renders.
///
/// **The whole set, not the three categories Sway has controls for.** This
/// module's other readers each pick out one category and drop the rest, which
/// was fine while the rest was nothing; it is not fine now that
/// `session/set_config_option` is the only way to reach whatever else an agent
/// exposes. What Sway does not recognise is carried across with the agent's own
/// label, id and description, and the surface decides what to do with it.
///
/// An option whose kind this build cannot represent is **skipped and logged**,
/// never rendered as an inert control: `SessionConfigKind` is
/// `#[non_exhaustive]`, so a protocol revision may add a shape with no Sway
/// control at all, and a mirror that crashed or drew a dead widget for it would
/// be a worse answer than one row fewer.
pub fn config_options(options: &[SessionConfigOption]) -> Vec<ChatConfigOption> {
    options
        .iter()
        .filter_map(|option| {
            let kind = match &option.kind {
                SessionConfigKind::Select(select) => ChatConfigKind::Select {
                    current: select.current_value.0.to_string(),
                    choices: select_entries(select)
                        .into_iter()
                        .map(|entry| ChatConfigChoice {
                            value: entry.value.0.to_string(),
                            label: entry.name.clone(),
                            description: entry.description.clone().unwrap_or_default(),
                        })
                        .collect(),
                },
                SessionConfigKind::Boolean(toggle) => {
                    ChatConfigKind::Boolean { value: toggle.current_value }
                }
                other => {
                    eprintln!(
                        "sway: ignoring config option `{}`, this build has no control for {other:?}",
                        option.id.0
                    );
                    return None;
                }
            };
            Some(ChatConfigOption {
                id: option.id.0.to_string(),
                name: option.name.clone(),
                description: option.description.clone().unwrap_or_default(),
                category: category_word(option.category.as_ref()),
                // The protocol has no way to publish a lever it will refuse, so
                // everything an ACP agent lists is one it says it can take.
                disabled: false,
                note: String::new(),
                kind,
            })
        })
        .collect()
}

/// What the agent said it can do, from its `initialize` answer.
///
/// Read off the wire on every connection rather than declared in the adapter
/// TOML, which is the whole difference between a generic client and a
/// per-vendor one: two agents behind the same transport can differ here, and the
/// crate's own stability labels disagree with what agents advertise (session
/// fork is marked unstable in 2.0.0 while both measured agents advertise it).
/// So the tier for an ACP session is the transport's floor plus this.
///
/// Whether the session has a model selector is deliberately *not* here: the
/// catalogue itself already rides `SessionStarted`, and a boolean saying an
/// empty list exists would be the same fact told twice, in two places that can
/// disagree.
pub fn capabilities(init: &InitializeResponse) -> ChatCapabilities {
    let sessions = &init.agent_capabilities.session_capabilities;
    ChatCapabilities {
        load_session: init.agent_capabilities.load_session,
        list_sessions: sessions.list.is_some(),
    }
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

/// What a tool call opened as, held until its completion needs it.
///
/// **Measured, not defensive.** On codex-acp 1.2.0 and opencode alike, `kind`
/// and `locations` ride the opening `tool_call` and are gone from the update
/// that completes it. An adapter that reads only the completion cannot tell a
/// shell run from a file read, so this is the one place that knowledge survives
/// the gap. Owned by the transport, one per session, and a call is dropped as
/// it completes. A call the agent opens and never finishes is held for the life
/// of the connection, which is the same bound the mapper's other per-call maps
/// accept: one entry per tool call, and nothing unbounded behind it.
#[derive(Default)]
pub struct AcpToolCalls {
    kinds: std::collections::HashMap<String, model::ToolKind>,
}

impl AcpToolCalls {
    /// [`map_update`], plus the summary only this side can fill in.
    ///
    /// A wrapper rather than an argument on `map_update` itself, so the mapping
    /// stays what its own docs claim: one update in, the events it implies out,
    /// with no state to thread through the fifteen places that do not need it.
    pub fn map(
        &mut self,
        session_id: &str,
        turn_id: &str,
        update: &SessionUpdate,
        cwd: Option<&Path>,
    ) -> Vec<ChatEvent> {
        let mut events = map_update(session_id, turn_id, update, cwd);
        for event in &mut events {
            match event {
                // An opening frame, or a status-less patch that named a kind.
                // `Other` is not recorded: it is the default a patch sends for
                // "I said nothing about the kind", and storing it would erase
                // what the opening frame established.
                ChatEvent::ToolCallStarted { tool_use_id, kind, .. } if *kind != model::ToolKind::Other => {
                    self.kinds.insert(tool_use_id.clone(), *kind);
                }
                ChatEvent::ToolCallCompleted { tool_use_id, summary, .. } => {
                    let kind = self.kinds.remove(tool_use_id).unwrap_or_default();
                    *summary = raw_output_summary(kind, raw_output_of(update));
                }
                _ => {}
            }
        }
        events
    }
}

/// The `rawOutput` on a completing update, if this update is one.
fn raw_output_of(update: &SessionUpdate) -> Option<&serde_json::Value> {
    match update {
        SessionUpdate::ToolCallUpdate(u) => u.fields.raw_output.as_ref().filter(|v| !v.is_null()),
        _ => None,
    }
}

/// What an agent's own `rawOutput` says a call did.
///
/// `rawOutput` is agent-defined by the spec, so this reads the shapes that were
/// actually measured and returns `None` for everything else rather than
/// guessing. Measured on opencode 1.18.x (`dev/acp-probe.mjs --tool-call`): an
/// `execute` call answers with `{ output: string, metadata: { exit: number,
/// output: string, truncated: bool } }`, and a `read` answers with the same
/// two keys and no range in `metadata`, which is why only the execute case
/// summarises. codex-acp 1.2.0's shape is not measured and falls through here.
///
/// **`metadata.exit` is the answer to the question `ToolSummary::Execute` has
/// been holding an empty `exit_code` for.** Claude reports no exit status at
/// all; an ACP agent does, under a key of its own choosing.
fn raw_output_summary(kind: model::ToolKind, raw: Option<&serde_json::Value>) -> Option<ToolSummary> {
    if kind != model::ToolKind::Execute {
        return None;
    }
    let raw = raw?;
    let out = raw.get("output").and_then(serde_json::Value::as_str)?;
    Some(ToolSummary::Execute {
        exit_code: raw
            .get("metadata")
            .and_then(|m| m.get("exit"))
            .and_then(serde_json::Value::as_i64)
            .and_then(|c| i32::try_from(c).ok()),
        lines: out.lines().count() as u64,
    })
}

/// Map one `session/update` onto Sway's event model.
///
/// Returns a `Vec` rather than an `Option` because the relationship is not
/// one-to-one: an update Sway has no use for yields nothing, and one carrying
/// two independent facts yields two events. An empty result is a normal outcome,
/// never an error - `SessionUpdate` is `#[non_exhaustive]`, so a protocol
/// revision must be able to add an update this build silently ignores instead of
/// failing to compile against a newer agent.
///
/// `cwd` is the session's working directory, and it is here for one job: an
/// agent that sends a file's prior text needs somewhere to put it, and the
/// object store is reached through the repo. `None` for a caller with no
/// directory to offer, which degrades a diff block to a `FileEdit` with no
/// before-state rather than dropping the edit.
pub fn map_update(
    session_id: &str,
    turn_id: &str,
    update: &SessionUpdate,
    cwd: Option<&Path>,
) -> Vec<ChatEvent> {
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

        SessionUpdate::ToolCall(call) => {
            let mut events = vec![tool_call_started(session_id, turn_id, call)];
            events.extend(file_edits(
                session_id,
                turn_id,
                &call.tool_call_id.0,
                &call.content,
                cwd,
            ));
            events
        }

        SessionUpdate::ToolCallUpdate(update) => {
            let mut events = tool_call_update(session_id, turn_id, update);
            // A content-only patch yields no status event and still carries the
            // diff, so the edits are collected from the update either way.
            events.extend(file_edits(
                session_id,
                turn_id,
                &update.tool_call_id.0,
                update.fields.content.as_deref().unwrap_or(&[]),
                cwd,
            ));
            events
        }

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

        // The agent moved its own configuration, unprompted. Carried across
        // whole, because the update is the whole option set and one option can
        // re-cut another's choices: picking a model changes which thinking
        // levels exist, so a mirror patched per option would show levels the
        // agent had just withdrawn.
        SessionUpdate::ConfigOptionUpdate(update) => vec![ChatEvent::ConfigOptions {
            session_id: session_id.to_string(),
            options: config_options(&update.config_options),
        }],

        // Modes, session metadata and command catalogues all change
        // session-level state rather than describing turn content. They reach
        // the UI through the handshake and the session events, so they produce
        // nothing here rather than being forced into a turn-shaped event they do
        // not belong to.
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

/// The file edits a tool call's content blocks describe.
///
/// **This is the claim the ACP tier used to deny.** Sway's decision that "ACP
/// agents cannot produce exact before-state diffs" was written from Claude's
/// shape, where a before-state exists only because a hook reads the file just
/// ahead of the write. Measured 2026-08-14 on `@agentclientprotocol/codex-acp`
/// 1.2.0, the protocol carries it directly: a `tool_call` content block of type
/// `diff` holds `oldText`, `newText` and an absolute `path`, which is a *better*
/// source than the hook - it is what the agent is about to write rather than
/// what happened to be on disk when a helper got there.
///
/// The text is stored in the same object store the hook capture writes to, so a
/// card built from either is the same card and nothing downstream learns which
/// agent it came from. That is also why no `ChatEvent` variant was added:
/// `FileEdit` already means "a file was written, here is its before-state by
/// content hash", which is exactly this.
///
/// An agent that sends no diff block yields nothing here, which is the honest
/// outcome rather than an empty edit - `opencode acp` 1.18.3 sends none.
fn file_edits(
    session_id: &str,
    turn_id: &str,
    tool_use_id: &str,
    content: &[ToolCallContent],
    cwd: Option<&Path>,
) -> Vec<ChatEvent> {
    content
        .iter()
        .filter_map(|block| match block {
            ToolCallContent::Diff(diff) => Some(diff),
            _ => None,
        })
        .map(|diff| {
            // `oldText: null` is the agent saying the file did not exist, which
            // is a creation rather than a capture that failed. Measured: that is
            // what codex-acp sends for a new file, with `_meta.kind: "add"`.
            let before = match (&diff.old_text, cwd) {
                (None, _) => snapshot::BeforeState::Absent,
                (Some(text), Some(repo)) => snapshot::store_text(repo, text),
                // Nowhere to put it. The card degrades to "diff unavailable"
                // exactly as it does for a non-repo folder on the hook path.
                (Some(_), None) => snapshot::BeforeState::Unavailable,
            };
            ChatEvent::FileEdit {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
                tool_use_id: tool_use_id.to_string(),
                path: diff.path.to_string_lossy().into_owned(),
                kind: match before {
                    snapshot::BeforeState::Absent => FileEditKind::Created,
                    _ => FileEditKind::Modified,
                },
                before_blob: match before {
                    snapshot::BeforeState::Blob { sha } => Some(sha),
                    _ => None,
                },
            }
        })
        .collect()
}

/// ACP's `ToolKind` in Sway's spelling.
///
/// A total match rather than a serde re-parse, so a variant added to the crate
/// fails to compile here instead of silently arriving as `Other`. `ToolKind` is
/// `#[non_exhaustive]` upstream, which is what the wildcard arm is for, and it
/// is the right answer for a kind from a newer spec than this build.
fn tool_kind(kind: &ToolKind) -> model::ToolKind {
    match kind {
        ToolKind::Read => model::ToolKind::Read,
        ToolKind::Edit => model::ToolKind::Edit,
        ToolKind::Delete => model::ToolKind::Delete,
        ToolKind::Move => model::ToolKind::Move,
        ToolKind::Search => model::ToolKind::Search,
        ToolKind::Execute => model::ToolKind::Execute,
        ToolKind::Think => model::ToolKind::Think,
        ToolKind::Fetch => model::ToolKind::Fetch,
        ToolKind::SwitchMode => model::ToolKind::SwitchMode,
        _ => model::ToolKind::Other,
    }
}

fn tool_locations(locations: &[ToolCallLocation]) -> Vec<ToolLocation> {
    locations
        .iter()
        .map(|l| ToolLocation {
            path: l.path.to_string_lossy().into_owned(),
            line: l.line,
        })
        .collect()
}

/// A `tool_call`, with the two fields that make its card renderable.
///
/// **`name` is not the agent's title.** The collapsed row renders `name` as a
/// mono token, and an ACP title is prose: `codex-acp` opened a file read as
/// "Read the file README.md in this directory". So `name` carries the kind's
/// canonical spelling, which is a token, and the prose moves to `title` where a
/// renderer can use it as a subtitle or ignore it.
///
/// Measured on codex-acp 1.2.0 and opencode alike, `kind` and `locations`
/// arrive here on the opening frame and are **absent from the completing
/// update**, which is why they are captured at the start rather than read off
/// the end.
fn tool_call_started(session_id: &str, turn_id: &str, call: &ToolCall) -> ChatEvent {
    ChatEvent::ToolCallStarted {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        tool_use_id: call.tool_call_id.0.to_string(),
        name: tool_kind_token(&call.kind).to_string(),
        input: call.raw_input.clone().unwrap_or(serde_json::Value::Null),
        kind: tool_kind(&call.kind),
        locations: tool_locations(&call.locations),
        // An agent that sent an empty title said nothing, and `Some("")` would
        // make a renderer falling back on `name` show a blank row instead.
        title: (!call.title.is_empty()).then(|| call.title.clone()),
    }
}

/// The short token a collapsed row shows for a kind.
///
/// Spelled out rather than derived from the serde name, because this is UI text
/// and a rename of the wire spelling should not silently change what a row
/// says.
fn tool_kind_token(kind: &ToolKind) -> &'static str {
    match kind {
        ToolKind::Read => "read",
        ToolKind::Edit => "edit",
        ToolKind::Delete => "delete",
        ToolKind::Move => "move",
        ToolKind::Search => "search",
        ToolKind::Execute => "execute",
        ToolKind::Think => "think",
        ToolKind::Fetch => "fetch",
        ToolKind::SwitchMode => "switchMode",
        // The same word an unnamed card already renders as. A kind this build
        // does not know still has the agent's `title` beside it, which is what
        // the row actually shows.
        _ => "tool",
    }
}

/// A `tool_call_update` is a status patch, so whether it is "progress" or
/// "completed" is decided by the status it carries rather than by its name.
///
/// An update with no status is not necessarily empty. The spec lets `kind`,
/// `title` and `locations` arrive on any patch, so one that carries them and no
/// status is a card being *described*, not a card being restarted, and
/// discarding it loses the only copy of those fields. It becomes an upsert
/// (see `ToolCallStarted`'s contract) naming only what the patch actually
/// carried. A patch with none of them still yields nothing: reporting a
/// content-only amendment as progress would restart a card the agent only meant
/// to add to, and its content is collected as `FileEdit`s by the caller either
/// way.
///
/// **Defensive, not measured.** Phase 1 probed codex-acp 1.2.0 and opencode and
/// neither sends a status-less patch: both put `kind` and `locations` on the
/// opening `tool_call`. This is a spec-legal frame with no agent behind it yet,
/// so its test is synthetic and says so.
fn tool_call_update(session_id: &str, turn_id: &str, update: &ToolCallUpdate) -> Vec<ChatEvent> {
    let tool_use_id = update.tool_call_id.0.to_string();
    let Some(status) = update.fields.status else {
        return describe_tool_call(session_id, turn_id, tool_use_id, update);
    };
    match status {
        ToolCallStatus::Completed | ToolCallStatus::Failed => {
            // Whole, and cut by the host on its way past: the cache that keeps
            // the rest lives there, so an adapter that cut here would have
            // thrown away what a card later asks for.
            //
            // A JSON `null` is the agent saying there was no output, not an
            // output whose text is "null" - which is what `Value::to_string`
            // would have made of it, and what a card would then have rendered
            // as the call's answer.
            let output = update
                .fields
                .raw_output
                .as_ref()
                .filter(|v| !v.is_null())
                .map(|v| v.to_string());
            vec![ChatEvent::ToolCallCompleted {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
                tool_use_id,
                status: if status == ToolCallStatus::Completed {
                    ToolStatus::Ok
                } else {
                    ToolStatus::Error
                },
                output,
                // Empty because no ACP agent publishes a diff: measured on
                // codex-acp 1.2.0 and opencode 1.18.x, a completing update
                // carries `rawOutput` and nothing patch-shaped. The card falls
                // back to diffing the call's own arguments.
                patch: Vec::new(),
                // Still empty, and Phase 8 measured *why* rather than assuming
                // it. A diff block does name an absolute path, so this looked
                // like it could be filled from one - but the sequence
                // `codex-acp` 1.2.0 actually sends is `tool_call` carrying the
                // diff and then a `tool_call_update` completing it with **no
                // content at all**. Reading the completing update's content
                // would therefore be code that runs and finds nothing.
                //
                // The paths still reach the consumers that want them: the same
                // diff block becomes a `FileEdit`, and `filesWritten` in the
                // store reads `fileEdit.path` beside `toolCallCompleted.files`.
                files: Vec::new(),
                duration_ms: None,
                // Filled by `AcpToolCalls`, which is the only thing that still
                // knows what kind this call opened as.
                summary: None,
                output_truncated: false,
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

/// A status-less patch, as an upsert carrying only what it described.
///
/// Every field the patch did not carry is sent **empty**, which upsert reads as
/// "unchanged": an absent `raw_input` here is the agent saying nothing about the
/// arguments, not the agent clearing them, and a consumer that overwrote the
/// card with these blanks would erase what the opening frame established.
fn describe_tool_call(
    session_id: &str,
    turn_id: &str,
    tool_use_id: String,
    update: &ToolCallUpdate,
) -> Vec<ChatEvent> {
    let f = &update.fields;
    if f.kind.is_none() && f.title.is_none() && f.locations.is_none() {
        return Vec::new();
    }
    vec![ChatEvent::ToolCallStarted {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        tool_use_id,
        // Empty unless this patch named a kind, since the token is derived from
        // the kind and a defaulted one would overwrite a good name with "tool".
        name: f.kind.as_ref().map(|k| tool_kind_token(k).to_string()).unwrap_or_default(),
        input: f.raw_input.clone().unwrap_or(serde_json::Value::Null),
        kind: f.kind.as_ref().map(tool_kind).unwrap_or_default(),
        locations: f.locations.as_deref().map(tool_locations).unwrap_or_default(),
        title: f.title.clone(),
    }]
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

    // --- session config options ------------------------------------------

    /// One select option, in the shape `opencode acp` 1.18.3 actually sends it.
    fn select(
        id: &str,
        name: &str,
        category: Option<SessionConfigOptionCategory>,
        current: &str,
        values: &[(&str, &str)],
    ) -> SessionConfigOption {
        use agent_client_protocol::schema::v1::{SessionConfigId, SessionConfigValueId};
        let entries: Vec<SessionConfigSelectOption> = values
            .iter()
            .map(|(value, label)| {
                SessionConfigSelectOption::new(
                    SessionConfigValueId::new(*value),
                    (*label).to_string(),
                )
            })
            .collect();
        let mut option = SessionConfigOption::new(
            SessionConfigId::new(id),
            name.to_string(),
            SessionConfigKind::Select(SessionConfigSelect::new(
                SessionConfigValueId::new(current),
                SessionConfigSelectOptions::Ungrouped(entries),
            )),
        );
        option.category = category;
        option
    }

    fn opencode_options() -> Vec<SessionConfigOption> {
        vec![
            select(
                "model",
                "Model",
                Some(SessionConfigOptionCategory::Model),
                "opencode/big-pickle",
                &[
                    ("github-copilot/claude-sonnet-4.6", "GitHub Copilot/Claude Sonnet 4.6"),
                    ("opencode/big-pickle", "opencode/Big Pickle"),
                ],
            ),
            select(
                "mode",
                "Session Mode",
                Some(SessionConfigOptionCategory::Mode),
                "build",
                &[("build", "build"), ("plan", "plan")],
            ),
        ]
    }

    /// The four selectors `@agentclientprotocol/codex-acp` 1.2.0 actually sends
    /// on `session/new`, measured 2026-08-14.
    fn codex_options() -> Vec<SessionConfigOption> {
        vec![
            select(
                "model",
                "Model",
                Some(SessionConfigOptionCategory::Model),
                "gpt-5.6-terra",
                &[("gpt-5.6-terra", "GPT-5.6 Terra"), ("gpt-5.5", "GPT-5.5")],
            ),
            select(
                "mode",
                "Mode",
                Some(SessionConfigOptionCategory::Mode),
                "agent",
                &[
                    ("read-only", "Read Only"),
                    ("agent", "Agent"),
                    ("agent-full-access", "Agent (full access)"),
                ],
            ),
            select(
                "thought_level",
                "Reasoning effort",
                Some(SessionConfigOptionCategory::ThoughtLevel),
                "medium",
                &[
                    ("low", "Low"),
                    ("medium", "Medium"),
                    ("high", "High"),
                    ("xhigh", "Extra high"),
                    ("max", "Max"),
                    ("ultra", "Ultra"),
                ],
            ),
        ]
    }

    /// One boolean toggle, the shape an agent publishes for a lever Sway has no
    /// category for.
    fn toggle(id: &str, name: &str, description: &str, on: bool) -> SessionConfigOption {
        use agent_client_protocol::schema::v1::SessionConfigId;
        let mut option = SessionConfigOption::new(
            SessionConfigId::new(id),
            name.to_string(),
            SessionConfigKind::Boolean(
                agent_client_protocol::schema::v1::SessionConfigBoolean::new(on),
            ),
        );
        option.description = Some(description.to_string());
        option
    }

    /// **The mirror carries the option Sway has no control for**, which is the
    /// whole reason it exists: the three category readers above would each drop
    /// this row, and dropping it is how a lever the agent published becomes one
    /// nobody can reach.
    #[test]
    fn an_option_with_no_category_survives_the_mirror() {
        let mut options = opencode_options();
        options.push(toggle("web_search", "Web search", "Let the agent search", true));
        let mirrored = config_options(&options);

        assert_eq!(mirrored.len(), 3, "{mirrored:?}");
        let novel = mirrored.iter().find(|o| o.id == "web_search").expect("the toggle");
        assert_eq!(novel.name, "Web search");
        assert_eq!(novel.description, "Let the agent search");
        // Uncategorized on the wire is uncategorized here, not guessed into a
        // category with a control already written for it.
        assert_eq!(novel.category, "");
        assert_eq!(novel.kind, ChatConfigKind::Boolean { value: true });
    }

    /// The categorized ones are carried too, with the agent's own word, so a
    /// surface can tell which rows already have a control of their own.
    #[test]
    fn a_categorized_option_keeps_the_agents_word_for_it() {
        let mirrored = config_options(&codex_options());
        let words: Vec<&str> = mirrored.iter().map(|o| o.category.as_str()).collect();
        assert_eq!(words, vec!["model", "mode", "thought_level"]);

        let effort = mirrored.iter().find(|o| o.id == "thought_level").expect("the selector");
        let ChatConfigKind::Select { current, choices } = &effort.kind else {
            panic!("a select is a select: {effort:?}");
        };
        assert_eq!(current, "medium");
        // **All six, including `ultra`.** The mirror reports what the agent
        // published, and now so does the effort control beside it.
        assert_eq!(choices.len(), 6);
        assert_eq!(choices[0].value, "low");
        assert_eq!(choices[0].label, "Low");
    }

    /// An agent moving its own configuration re-publishes the whole set, and
    /// that is what reaches the UI.
    #[test]
    fn a_config_update_carries_the_whole_option_set() {
        use agent_client_protocol::schema::v1::ConfigOptionUpdate;
        let update = SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(opencode_options()));
        let events = map_update("s1", "t1", &update, None);

        let [ChatEvent::ConfigOptions { session_id, options }] = &events[..] else {
            panic!("expected one config event: {events:?}");
        };
        assert_eq!(session_id, "s1");
        assert_eq!(options.len(), 2);
    }

    /// **ACP does have a notion of a reasoning level**, contrary to what this
    /// module claimed until an agent published one.
    #[test]
    fn a_thought_level_select_becomes_the_effort_levels() {
        let models = model_catalogue(&codex_options());
        assert!(models.iter().all(|m| m.supports_effort));
        // Every model gets the same list: ACP publishes one selector for the
        // session where Claude's catalogue names them per model.
        for model in &models {
            assert_eq!(model.supported_effort_levels, vec!["low", "medium", "high", "xhigh", "max", "ultra"]);
            // Rows too, and every one of them takeable: these are the agent's
            // own answer about itself, so there is nothing to refuse.
            let rows: Vec<&str> = model.effort_levels.iter().map(|l| l.level.as_str()).collect();
            assert_eq!(rows, model.supported_effort_levels);
            assert!(model.effort_levels.iter().all(|l| !l.disabled && l.note.is_empty()));
        }
        assert_eq!(current_effort(&codex_options()).as_deref(), Some("medium"));
        assert_eq!(effort_config_id(&codex_options()).as_deref(), Some("thought_level"));
    }

    /// **`ultra` came back, and that is the finding.** It was dropped while a
    /// level travelled as an `Effort` variant and there was no variant for it.
    /// A level is a string now, so the sixth goes out exactly as codex spelled
    /// it and nothing here decides which of the agent's words Sway approves of.
    #[test]
    fn every_level_the_agent_published_is_offered() {
        let levels = effort_levels(&codex_options());
        assert_eq!(levels, vec!["low", "medium", "high", "xhigh", "max", "ultra"]);
    }

    /// An agent with no thought-level selector claims none, which is what keeps
    /// the control hidden rather than rendering inert.
    #[test]
    fn an_agent_with_no_thought_level_claims_no_effort() {
        assert!(effort_levels(&opencode_options()).is_empty());
        assert_eq!(current_effort(&opencode_options()), None);
        assert_eq!(effort_config_id(&opencode_options()), None);
    }

    /// The mode selector reaches the UI as the agent spelled it, with the
    /// permissive flag left undeclared: nothing on the wire says which of
    /// Codex's three runs tools unattended.
    #[test]
    fn a_mode_select_becomes_the_live_mode_catalogue() {
        let modes = mode_catalogue(&codex_options());
        assert_eq!(
            modes.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["read-only", "agent", "agent-full-access"],
        );
        assert_eq!(modes[0].label, "Read Only");
        assert_eq!(current_mode(&codex_options()).as_deref(), Some("agent"));
        assert_eq!(mode_config_id(&codex_options()).as_deref(), Some("mode"));
    }

    /// The catalogue is the agent's, provider-qualified ids and all.
    #[test]
    fn a_model_select_becomes_the_live_catalogue() {
        let models = model_catalogue(&opencode_options());
        assert_eq!(
            models.iter().map(|m| m.value.as_str()).collect::<Vec<_>>(),
            vec!["github-copilot/claude-sonnet-4.6", "opencode/big-pickle"],
        );
        assert_eq!(models[0].display_name, "GitHub Copilot/Claude Sonnet 4.6");
        // *This agent* publishes no thought-level selector, so no level is
        // claimed and the control stays hidden rather than rendering inert.
        // Not a fact about ACP: `codex-acp` does publish one, see below.
        assert!(models.iter().all(|m| !m.supports_effort && m.supported_effort_levels.is_empty()));
        // No separate resolution exists on the wire, so the value is its own.
        assert!(models.iter().all(|m| m.value == m.resolved_model));

        assert_eq!(current_model(&opencode_options()).as_deref(), Some("opencode/big-pickle"));
        assert_eq!(model_config_id(&opencode_options()).as_deref(), Some("model"));
    }

    /// The **category** decides, never the id or the label.
    ///
    /// An agent that calls its model selector anything else is still understood,
    /// and one whose *mode* selector happens to be called `model` is not
    /// mistaken for a catalogue.
    #[test]
    fn a_selector_is_found_by_its_category_not_its_name() {
        let renamed = vec![select(
            "llm",
            "Which brain",
            Some(SessionConfigOptionCategory::Model),
            "a",
            &[("a", "A")],
        )];
        assert_eq!(model_config_id(&renamed).as_deref(), Some("llm"));

        let misleading = vec![select(
            "model",
            "Model",
            Some(SessionConfigOptionCategory::Mode),
            "build",
            &[("build", "build")],
        )];
        assert!(model_catalogue(&misleading).is_empty(), "a mode selector is not a catalogue");
        assert_eq!(model_config_id(&misleading), None, "and offers nothing to switch");
    }

    /// An agent that offers no model selector yields an empty catalogue and no
    /// id to switch with, which is what makes `set_model` refuse rather than
    /// send a request naming an option that does not exist.
    #[test]
    fn an_agent_with_no_model_selector_offers_no_switch() {
        let none: Vec<SessionConfigOption> = Vec::new();
        assert!(model_catalogue(&none).is_empty());
        assert_eq!(model_config_id(&none), None);
        assert_eq!(current_model(&none), None);

        // An option with no category at all is not guessed at either.
        let uncategorised = vec![select("model", "Model", None, "a", &[("a", "A")])];
        assert!(model_catalogue(&uncategorised).is_empty());
    }

    /// A grouped catalogue is flattened, not dropped: the spec allows both
    /// shapes, and reading only one would report an agent's models as none.
    #[test]
    fn a_grouped_catalogue_is_flattened_rather_than_lost() {
        use agent_client_protocol::schema::v1::{
            SessionConfigGroupId, SessionConfigId, SessionConfigSelectGroup, SessionConfigValueId,
        };
        let group = SessionConfigSelectGroup::new(
            SessionConfigGroupId::new("anthropic"),
            "Anthropic".to_string(),
            vec![SessionConfigSelectOption::new(
                SessionConfigValueId::new("anthropic/claude-sonnet-4-5"),
                "Claude Sonnet 4.5".to_string(),
            )],
        );
        let mut option = SessionConfigOption::new(
            SessionConfigId::new("model"),
            "Model".to_string(),
            SessionConfigKind::Select(SessionConfigSelect::new(
                SessionConfigValueId::new("anthropic/claude-sonnet-4-5"),
                SessionConfigSelectOptions::Grouped(vec![group]),
            )),
        );
        option.category = Some(SessionConfigOptionCategory::Model);

        let models = model_catalogue(&[option]);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].value, "anthropic/claude-sonnet-4-5");
    }

    /// Capabilities are read off the handshake, so two agents behind one
    /// transport can differ - which is the whole reason they are not declared in
    /// the adapter TOML.
    #[test]
    fn capabilities_come_from_the_handshake_rather_than_the_adapter() {
        use agent_client_protocol::schema::v1::{AgentCapabilities, SessionCapabilities};
        use agent_client_protocol::schema::ProtocolVersion;

        let mut silent = InitializeResponse::new(ProtocolVersion::V1);
        silent.agent_capabilities = AgentCapabilities::default();
        let caps = capabilities(&silent);
        assert!(!caps.load_session, "an agent that says nothing claims nothing");
        assert!(!caps.list_sessions);

        let mut advertised = InitializeResponse::new(ProtocolVersion::V1);
        let mut agent_caps = AgentCapabilities::default();
        agent_caps.load_session = true;
        let mut sessions = SessionCapabilities::default();
        sessions.list = Some(Default::default());
        agent_caps.session_capabilities = sessions;
        advertised.agent_capabilities = agent_caps;
        let caps = capabilities(&advertised);
        assert!(caps.load_session);
        assert!(caps.list_sessions);
    }

    #[test]
    fn an_agent_message_chunk_becomes_a_text_delta() {
        let events = map_update("s1", "t1", &SessionUpdate::AgentMessageChunk(text_chunk("hi")), None);
        assert!(matches!(
            events.as_slice(),
            [ChatEvent::TextDelta { text, .. }] if text == "hi"
        ));
    }

    #[test]
    fn a_thought_chunk_is_thinking_rather_than_speech() {
        let events = map_update("s1", "t1", &SessionUpdate::AgentThoughtChunk(text_chunk("hm")), None);
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
    ///
    /// Still true now that a status-less patch can describe a call: this one
    /// names no kind, title or locations, so there is nothing to upsert and the
    /// answer is the same as it always was.
    #[test]
    fn a_tool_call_update_without_a_status_yields_nothing() {
        let update = tool_update("call-1", None);
        assert!(map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(update), None).is_empty());
    }

    /// A tool call's `name` is a mono token in the collapsed row, and an ACP
    /// title is prose: codex-acp opened a file read as "Read the file README.md
    /// in this directory". So the kind's canonical spelling is the name and the
    /// agent's sentence moves to `title`, where a renderer can use it as a
    /// subtitle or ignore it.
    #[test]
    fn an_acp_call_names_its_kind_and_keeps_the_agents_prose_as_a_title() {
        let mut call = ToolCall::new(
            ToolCallId::new("call-1"),
            "Read the file README.md in this directory".to_string(),
        );
        call.kind = ToolKind::Read;
        call.locations = vec![ToolCallLocation::new("/tmp/w/README.md").line(3u32)];

        match map_update("s1", "t1", &SessionUpdate::ToolCall(call), None).as_slice() {
            [ChatEvent::ToolCallStarted { name, title, kind, locations, .. }] => {
                assert_eq!(name, "read", "the row's token has to be a token");
                assert_eq!(title.as_deref(), Some("Read the file README.md in this directory"));
                assert_eq!(*kind, model::ToolKind::Read);
                assert_eq!(locations.len(), 1);
                assert_eq!(locations[0].path, "/tmp/w/README.md");
                assert_eq!(locations[0].line, Some(3));
            }
            other => panic!("expected one ToolCallStarted, got {other:?}"),
        }
    }

    /// SYNTHETIC, and deliberately so.
    ///
    /// Phase 1 probed codex-acp 1.2.0 and opencode for when `kind`, `locations`
    /// and `content` arrive, and both put them on the opening `tool_call`;
    /// neither ever sent a patch without a status. So there is no fixture
    /// behind this and none is claimed: it is a spec-legal frame this client
    /// has to survive, built by hand from the crate's own types.
    #[test]
    fn a_status_less_patch_describes_the_call_rather_than_being_discarded() {
        let placeholder = ToolCall::new(ToolCallId::new("call-1"), "working".to_string());
        let opened = map_update("s1", "t1", &SessionUpdate::ToolCall(placeholder), None);
        assert!(matches!(opened.as_slice(), [ChatEvent::ToolCallStarted { .. }]));

        let mut fields = ToolCallUpdateFields::default();
        fields.locations = Some(vec![ToolCallLocation::new("/tmp/w/late.rs")]);
        let patch = ToolCallUpdate::new(ToolCallId::new("call-1"), fields);

        match map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(patch), None).as_slice() {
            [ChatEvent::ToolCallStarted { tool_use_id, locations, name, input, .. }] => {
                assert_eq!(tool_use_id, "call-1", "an upsert onto the same card");
                assert_eq!(locations.len(), 1);
                assert_eq!(locations[0].path, "/tmp/w/late.rs");
                // The patch said nothing about either, and an upsert reads an
                // empty field as unchanged. Sending the kind's default token
                // here would rename the card to "tool".
                assert!(name.is_empty(), "a patch that named no kind names no token");
                assert!(input.is_null(), "a patch that named no arguments clears none");
            }
            other => panic!("expected one ToolCallStarted, got {other:?}"),
        }
    }

    /// The measured opencode sequence, end to end.
    ///
    /// Captured 2026-08-24 by `dev/acp-probe.mjs --agent opencode --tool-call`:
    /// an opening `tool_call` carrying `kind`, `locations`, `rawInput`, `status`
    /// and `title` and **no content**, then a completing `tool_call_update`
    /// carrying `content`, `rawOutput`, `status` and `title` and **neither kind
    /// nor locations**. So the summary can only come from what was remembered at
    /// the start, which is exactly what this asserts.
    #[test]
    fn an_execute_call_is_summarised_from_the_kind_its_opening_frame_named() {
        let mut calls = AcpToolCalls::default();

        let mut call = ToolCall::new(ToolCallId::new("call-1"), "Run `false`".to_string());
        call.kind = ToolKind::Execute;
        call.locations = vec![ToolCallLocation::new("/tmp/w")];
        let opened = calls.map("s1", "t1", &SessionUpdate::ToolCall(call), None);
        match opened.as_slice() {
            [ChatEvent::ToolCallStarted { kind, locations, .. }] => {
                assert_eq!(*kind, model::ToolKind::Execute);
                assert_eq!(locations[0].path, "/tmp/w");
            }
            other => panic!("expected one ToolCallStarted, got {other:?}"),
        }

        // The completing update, with the agent's own `rawOutput` shape and
        // nothing else. `metadata.exit` is where opencode puts the exit status
        // Claude never reports at all.
        let mut fields = ToolCallUpdateFields::default();
        fields.status = Some(ToolCallStatus::Completed);
        fields.raw_output = Some(serde_json::json!({
            "output": "one\ntwo\nthree",
            "metadata": { "exit": 1, "output": "one\ntwo\nthree", "truncated": false },
        }));
        let done = calls.map(
            "s1",
            "t1",
            &SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(ToolCallId::new("call-1"), fields)),
            None,
        );
        match done.as_slice() {
            [ChatEvent::ToolCallCompleted { summary, .. }] => {
                assert_eq!(
                    *summary,
                    Some(ToolSummary::Execute { exit_code: Some(1), lines: 3 }),
                    "the completing update names no kind; only the opening frame did"
                );
            }
            other => panic!("expected one ToolCallCompleted, got {other:?}"),
        }
    }

    /// A completion whose call was never opened here summarises to nothing
    /// rather than to a guess. This is the reconnect case: the transport rewires
    /// mid-call and the opening frame belonged to the connection before it.
    #[test]
    fn a_completion_with_no_remembered_opening_frame_summarises_to_nothing() {
        let mut calls = AcpToolCalls::default();
        let mut fields = ToolCallUpdateFields::default();
        fields.status = Some(ToolCallStatus::Completed);
        fields.raw_output = Some(serde_json::json!({ "output": "one\ntwo" }));
        let done = calls.map(
            "s1",
            "t1",
            &SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(ToolCallId::new("orphan"), fields)),
            None,
        );
        match done.as_slice() {
            [ChatEvent::ToolCallCompleted { summary, .. }] => assert_eq!(*summary, None),
            other => panic!("expected one ToolCallCompleted, got {other:?}"),
        }
    }

    /// A `rawOutput` of JSON `null` is the agent saying there was no output.
    /// Serialized, it would have become the four-letter string "null" and been
    /// rendered as the call's answer, which is a write appearing to have
    /// printed something.
    #[test]
    fn a_null_raw_output_is_no_output_rather_than_the_word_null() {
        let mut fields = ToolCallUpdateFields::default();
        fields.status = Some(ToolCallStatus::Completed);
        fields.raw_output = Some(serde_json::Value::Null);
        let events = map_update(
            "s1",
            "t1",
            &SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(ToolCallId::new("call-1"), fields)),
            None,
        );
        match events.as_slice() {
            [ChatEvent::ToolCallCompleted { output, output_truncated, .. }] => {
                assert_eq!(*output, None, "a null output is no output block at all");
                assert!(!output_truncated);
            }
            other => panic!("expected one ToolCallCompleted, got {other:?}"),
        }
    }

    #[test]
    fn a_failed_tool_call_completes_as_an_error_rather_than_ok() {
        let update = tool_update("call-1", Some(ToolCallStatus::Failed));
        let events = map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(update), None);
        assert!(matches!(
            events.as_slice(),
            [ChatEvent::ToolCallCompleted { status: ToolStatus::Error, .. }]
        ));
    }

    #[test]
    fn a_completed_tool_call_reports_no_files_rather_than_guessing_at_them() {
        let update = tool_update("call-1", Some(ToolCallStatus::Completed));
        let events = map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(update), None);
        assert!(matches!(
            events.as_slice(),
            [ChatEvent::ToolCallCompleted { status: ToolStatus::Ok, files, .. }] if files.is_empty()
        ));
    }

    /// A tool-call update carrying a diff block, as `codex-acp` 1.2.0 sends one.
    fn tool_update_with_diff(
        id: &str,
        status: Option<ToolCallStatus>,
        path: &str,
        old_text: Option<&str>,
        new_text: &str,
    ) -> ToolCallUpdate {
        use agent_client_protocol::schema::v1::{Diff, ToolCallUpdateFields};
        let mut diff = Diff::new(std::path::PathBuf::from(path), new_text.to_string());
        diff.old_text = old_text.map(str::to_string);
        let mut fields = ToolCallUpdateFields::default();
        fields.status = status;
        fields.content = Some(vec![ToolCallContent::Diff(diff)]);
        ToolCallUpdate::new(ToolCallId::new(id), fields)
    }

    /// A repo to hash into, so a before-state has somewhere to land.
    fn tmp_repo(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("sway-acp-diff-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::process::Command::new("git")
            .current_dir(&dir)
            .args(["init", "-q"])
            .output()
            .unwrap();
        dir
    }

    /// **The measurement that falsified "ACP cannot produce exact diffs".**
    ///
    /// The agent sends the file's prior text with the call, so the before-state
    /// is exact and addressable in the same object store the capture hook writes
    /// to. No new `ChatEvent` variant: `FileEdit` already meant this.
    #[test]
    fn a_diff_block_becomes_a_file_edit_with_a_real_before_state() {
        let repo = tmp_repo("modified");
        let update = tool_update_with_diff(
            "call-1",
            Some(ToolCallStatus::Completed),
            "/tmp/hello.txt",
            Some("one\ntwo\nthree\n"),
            "one\ntwo\nTHREE\n",
        );
        let events =
            map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(update), Some(repo.as_path()));

        let edit = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::FileEdit { path, kind, before_blob, .. } => {
                    Some((path.clone(), *kind, before_blob.clone()))
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("no file edit: {events:?}"));
        assert_eq!(edit.0, "/tmp/hello.txt");
        assert_eq!(edit.1, FileEditKind::Modified);
        let sha = edit.2.expect("the prior text was stored");
        assert_eq!(
            snapshot::read_back(&repo, &sha).as_deref(),
            Some("one\ntwo\nthree\n"),
            "and reads back byte for byte, which is what makes the diff exact"
        );

        // **The completing event still reports no write targets, on purpose.**
        // Measured: `codex-acp` puts the diff on `tool_call` and completes with
        // no content, so filling this from the completing update would be code
        // that never finds anything. Per-turn attribution reads the `FileEdit`
        // above instead, through `filesWritten` in the store.
        let files = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::ToolCallCompleted { files, .. } => Some(files.clone()),
                _ => None,
            })
            .expect("the call still completes");
        assert!(files.is_empty(), "{files:?}");

        std::fs::remove_dir_all(&repo).ok();
    }

    /// `oldText: null` is the agent saying the file did not exist. A creation,
    /// not a capture that failed, and the two render differently.
    #[test]
    fn a_diff_with_no_prior_text_is_a_creation_rather_than_a_failed_capture() {
        let repo = tmp_repo("created");
        let update = tool_update_with_diff(
            "call-1",
            Some(ToolCallStatus::Completed),
            "/tmp/new.txt",
            None,
            "hello\n",
        );
        let events =
            map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(update), Some(repo.as_path()));
        let edit = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::FileEdit { kind, before_blob, .. } => Some((*kind, before_blob.clone())),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no file edit: {events:?}"));
        assert_eq!(edit.0, FileEditKind::Created);
        assert_eq!(edit.1, None, "there is no prior content to address");
        std::fs::remove_dir_all(&repo).ok();
    }

    /// A content-only patch carries the diff and no status. The edit must still
    /// come through: the status is what decides whether the *card* moves, and
    /// dropping the edit with it would lose the before-state entirely.
    #[test]
    fn a_diff_arrives_even_when_the_patch_reports_no_status() {
        let repo = tmp_repo("statusless");
        let update = tool_update_with_diff(
            "call-1",
            None,
            "/tmp/hello.txt",
            Some("before\n"),
            "after\n",
        );
        let events =
            map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(update), Some(repo.as_path()));
        assert!(
            events.iter().any(|e| matches!(e, ChatEvent::FileEdit { .. })),
            "the edit survives a statusless patch: {events:?}"
        );
        assert!(
            !events.iter().any(|e| matches!(e, ChatEvent::ToolCallProgress { .. })),
            "and still does not restart the card: {events:?}"
        );
        std::fs::remove_dir_all(&repo).ok();
    }

    /// With nowhere to hash into, the edit is still reported and the diff is
    /// not. The card degrades to "diff unavailable" exactly as it does for a
    /// non-repo folder on the hook path, rather than the write going unrecorded.
    #[test]
    fn a_diff_with_no_object_store_still_reports_the_write() {
        let update = tool_update_with_diff(
            "call-1",
            Some(ToolCallStatus::Completed),
            "/tmp/hello.txt",
            Some("before\n"),
            "after\n",
        );
        let events = map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(update), None);
        let edit = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::FileEdit { path, before_blob, .. } => {
                    Some((path.clone(), before_blob.clone()))
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("no file edit: {events:?}"));
        assert_eq!(edit.0, "/tmp/hello.txt");
        assert_eq!(edit.1, None);
    }

    /// An agent that sends no diff block contributes nothing, which is the
    /// honest outcome rather than an empty edit. `opencode acp` 1.18.3 is this
    /// case, so the ACP tier cannot claim diffs for every agent behind it.
    #[test]
    fn an_agent_that_sends_no_diff_produces_no_file_edit() {
        let repo = tmp_repo("nodiff");
        let update = tool_update("call-1", Some(ToolCallStatus::Completed));
        let events =
            map_update("s1", "t1", &SessionUpdate::ToolCallUpdate(update), Some(repo.as_path()));
        assert!(!events.iter().any(|e| matches!(e, ChatEvent::FileEdit { .. })), "{events:?}");
        std::fs::remove_dir_all(&repo).ok();
    }

    /// The protocol is `#[non_exhaustive]` and gains updates over time. An
    /// update this build has no mapping for must produce nothing rather than
    /// panicking or being forced into a turn event it does not belong to.
    #[test]
    fn an_update_with_no_sway_counterpart_maps_to_no_events() {
        use agent_client_protocol::schema::v1::{CurrentModeUpdate, SessionModeId};
        let update =
            SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(SessionModeId::new("plan")));
        assert!(map_update("s1", "t1", &update, None).is_empty());
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
