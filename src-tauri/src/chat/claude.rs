//! Mapping `claude` stream-json frames onto the normalized [`ChatEvent`] model.
//!
//! This is the only module in the tree that knows what Claude's wire format
//! looks like. Everything it does is derived from the captured corpus in
//! `dev/fixtures/claude/`, which `dev/protocol-probe.mjs` re-verifies against
//! the installed CLI; if the format moves, that script fails before this file
//! starts producing nonsense.
//!
//! The mapper is a small **state machine**, not a pure per-frame function,
//! because three measured properties of the stream make a stateless mapping
//! impossible:
//!
//!   1. **`system/init` re-emits on every turn.** It is not a session-open
//!      frame. The first one opens the session; every later one starts a turn
//!      and reports the model and permission mode currently in force, which is
//!      exactly how a mid-session model or mode switch is *confirmed* rather
//!      than assumed. Treating each as a session start would reset the
//!      transcript on every turn.
//!   2. **Deltas do not name their content block's type.** A
//!      `content_block_delta` carries `index` and a delta kind; whether index 0
//!      is thinking or text was established by the `content_block_start` that
//!      opened it, so the mapper tracks open blocks per index.
//!   3. **A turn has no id on the wire.** Turn ids are synthesized here and
//!      carried on every event so the UI can group a turn's text, tool calls
//!      and usage without re-deriving boundaries.

use std::collections::HashMap;

use serde_json::Value;

use crate::agents::{ChatEffortExtra, EffortExtraState};

use super::model::{
    ChatAccount, ChatConfigKind, ChatConfigOption, ChatEffortLevel, ChatEvent, ChatModelInfo,
    ChatQuestion, ChatQuestionOption, Extra, HookPhase, McpServer, PermissionDenial, PermissionMode,
    PatchHunk, PermissionSuggestion, QuestionAnswer, SlashCommand, SuggestedRule, ToolKind, ToolStatus,
    SubagentUsage, ToolSummary, PATCH_LINE_CAP,
    TurnOutcome, Usage, UsageWindow,
};

/// The call an event is about. Only the four a subagent can produce: measured,
/// it never streams, so no delta variant can ever be nested.
fn call_named_by(ev: &ChatEvent) -> Option<&str> {
    match ev {
        ChatEvent::ToolCallStarted { tool_use_id, .. }
        | ChatEvent::ToolCallProgress { tool_use_id, .. }
        | ChatEvent::ToolCallCompleted { tool_use_id, .. }
        | ChatEvent::FileEdit { tool_use_id, .. } => Some(tool_use_id),
        _ => None,
    }
}

/// The one tool whose `can_use_tool` is a question rather than a request to act.
///
/// Measured 2026-08-22 on claude 2.1.239: it raises `can_use_tool` in all four
/// permission modes, `bypassPermissions` included, which no other tool does.
/// The CLI has no interactive client on this transport, so rather than deciding
/// the question itself it hands it out.
pub(super) const ASK_USER_QUESTION: &str = "AskUserQuestion";

/// Why fast mode cannot be flipped from here, whatever the account says about
/// whether it could serve.
///
/// **Measured against 2.1.238, and it is a fact about the wire, not the plan.**
/// The CLI's control protocol takes seventeen request subtypes and exactly one
/// of them touches `flagSettings`, where `fastMode` lives: `apply_flag_settings`,
/// which validates its keys and answers `unsupported_key` for anything that is
/// not `effortLevel` or `ultracode`. So there is no mid-session switch to send.
///
/// This replaced "Fast mode is not available in the Agent SDK", which was the
/// CLI's own sentence for `sdk_opt_in_required` and stopped being true the
/// moment Sway took the opt-in (see `claude.toml`'s `--settings`). Quoting a
/// reason the session is no longer giving is worse than having none: it reads as
/// measured and is not.
const FAST_MODE_REFUSAL: &str = "Set when the chat starts; there is no mid-session switch";

/// The CLI's own sentence for each `fast_mode_disabled_reason`, quoted.
///
/// **Why a table of another program's vocabulary is right here.** The session
/// answers `system/init` with a reason *code* (`extra_usage_disabled`), and a
/// code is not something to put in front of a user. The CLI carries the
/// sentences and does not send them, so the choice is between quoting them and
/// inventing worse ones.
///
/// Every line below is read out of the 2.1.238 binary rather than paraphrased -
/// `q0d` for the first five, `Jvb` for the rest - so the wording a user sees
/// here is the wording they would see running `claude` themselves.
///
/// A code with no entry falls through to [`FAST_MODE_REFUSAL`], which stays
/// true whatever the account says, so a reason this build has never heard of
/// degrades to a weaker sentence rather than to a raw enum token.
///
/// Two are deliberately absent. `free` is the one reason whose sentence depends
/// on how the user authenticated (`oauth` vs an API key) and `system/init` does
/// not say which, so quoting either half would be a guess; `pending` is not a
/// refusal at all but the check still running.
const FAST_MODE_REASONS: [(&str, &str); 8] = [
    ("preference", "Fast mode has been disabled by your organization"),
    ("extra_usage_disabled", "Fast mode requires usage credits · /usage-credits to turn them on"),
    ("network_error", "Fast mode unavailable due to network connectivity issues"),
    ("unknown", "Fast mode is currently unavailable"),
    ("not_first_party", "Fast mode is only available when using the Anthropic API directly"),
    ("disabled_by_env", "Fast mode is not available"),
    ("model_not_allowed", "This model is not in your organization's allowed models"),
    // Kept even though `claude.toml` now passes the opt-in, because the flag is
    // a *setting* and a policy or project settings file outranks it. A user
    // whose org pins `fastMode: false` lands back here.
    ("sdk_opt_in_required", "Fast mode is not available in this mode"),
];

/// Why the session says fast mode will not serve, in words, or the transport's
/// own reason when it says nothing this build recognises.
fn fast_mode_note(reason: Option<&str>) -> String {
    let account = reason
        .and_then(|r| FAST_MODE_REASONS.iter().find(|(code, _)| *code == r))
        .map(|(_, sentence)| *sentence);
    match account {
        // Both are true and only one is actionable: "top up your credits" is
        // something the user can do, "there is no mid-session switch" is not.
        Some(sentence) => format!("{sentence}. {FAST_MODE_REFUSAL}"),
        None => FAST_MODE_REFUSAL.to_string(),
    }
}

/// The values `--thinking` takes, in the CLI's own order.
///
/// **Measured on 2.1.238, and the flag is undocumented**: `--help` lists no
/// thinking option at all, but `--thinking bogus --version` answers
/// `option '--thinking <mode>' argument 'bogus' is invalid. Allowed choices are
/// enabled, adaptive, disabled.` and exits 1, while each of the three passes
/// silently.
///
/// That rejection is the whole evidence, and it is the same observable
/// `dev/effort-probe.mjs` rests on: this CLI **ignores an unknown flag
/// entirely** (`--definitely-not-a-flag xyz --version` exits 0 and prints the
/// version), so acceptance proves nothing and only a validated choice set does.
/// **A measurement without a control, deliberately.** It was published as a
/// refused option for one release and has been withdrawn. `--thinking` is argv,
/// so it is fixed when the child is spawned, and there is no mid-session verb
/// for it: `apply_flag_settings` is the only control request that reaches launch
/// settings and it answers `unsupported_key` for everything but `effortLevel`
/// and `ultracode`. Nothing on the wire reports which mode is running, either.
///
/// A pill that can never move is permanent plumbing in a bar whose rule is that
/// plumbing shows when something has failed, not while it is merely fixed. This
/// one also landed beside the effort picker wearing the same word, so a Claude
/// composer carried two controls labelled "Thinking", one of them showing the
/// literal string `--thinking` as its value.
///
/// Kept here with its test so the measurement outlives the control it did not
/// justify. Whatever surface eventually offers launch flags is where it belongs.
const THINKING_MODES: [&str; 3] = ["enabled", "adaptive", "disabled"];

/// The levers claude has for one model, in the shape the mirror renders.
///
/// **The CLI publishes no config options at all**, so unlike an ACP agent's
/// these are assembled from the catalogue row's own capability flags.
///
/// **This used to read `[[chat.annotations]]` and no longer does.** The
/// handshake publishes `supportsFastMode` per model, so a Sway-side table
/// restating it was the `[[chat.models]]` trap again: hand-maintained, keyed on
/// a spelling the catalogue does not use (`claude-opus-5` against a resolved
/// `claude-opus-5[1m]`), and therefore already matching nothing.
///
/// One function for two callers. The probe caches this against each model row
/// and the live session emits it as the reported model moves, so for a given
/// resolved id a draft and the chat it becomes answer the same.
///
/// `fast_mode_reason` is the session's own `fast_mode_disabled_reason`, and the
/// one thing the two callers legitimately differ on: a live chat has been told
/// why this *account* cannot run fast mode, and the probe has no session to have
/// been told by. `None` therefore means "not asked", never "nothing wrong", so
/// the draft falls back to the transport's own reason rather than promising a
/// lever that would be refused for a second reason it has not heard yet.
pub fn config_options(model: &ChatModelInfo, fast_mode_reason: Option<&str>) -> Vec<ChatConfigOption> {
    let mut out = Vec::new();
    if model.supports_fast_mode {
        out.push(ChatConfigOption {
            id: "fast_mode".into(),
            name: "Fast mode".into(),
            description: String::new(),
            category: String::new(),
            // Shown refused rather than hidden. A model that has a fast mode
            // and a transport that will not reach it are two different facts,
            // and an absent control states neither.
            disabled: true,
            note: fast_mode_note(fast_mode_reason),
            kind: ChatConfigKind::Boolean { value: false },
        });
    }
    out
}

/// The effort levels for one model, as picker rows: everything the catalogue
/// published, plus whatever `[[chat.effort_extras]]` measured.
///
/// One function for two callers, the same arrangement `config_options` has and
/// for the same reason: a draft reads the probe's cached rows and the live chat
/// reads the handshake's, and for one resolved model they have to answer the
/// same.
///
/// **A model that publishes no levels gets none.** An extra adds a level to a
/// control that already exists; it never brings the control into being, so an
/// agent (or a model, like haiku) with no effort control still has none.
///
/// `cli_version` is the gate, and it is why an unadvertised level is safe to
/// offer at all. An extra was measured against one binary, so it renders as a
/// level only while that is the binary answering, and against any other it
/// renders **disabled naming both versions** rather than silently carrying a
/// claim nobody has re-checked. Degraded rather than dropped: a level that
/// vanishes on a CLI upgrade tells the user nothing, and a row that says why
/// tells them to re-run the probe.
pub fn effort_levels(
    model: &ChatModelInfo,
    extras: &[ChatEffortExtra],
    cli_version: &str,
) -> Vec<ChatEffortLevel> {
    if model.supported_effort_levels.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<ChatEffortLevel> = model
        .supported_effort_levels
        .iter()
        .map(|level| ChatEffortLevel {
            level: level.clone(),
            label: level.clone(),
            disabled: false,
            note: String::new(),
        })
        .collect();
    // Both sides normalized, so a `measured_on` written as the CLI prints it
    // ("2.1.237 (Claude Code)") compares equal to the bare number `system/init`
    // reports. Comparing the raw strings would make every row stale forever.
    let running = crate::health::parse_version(cli_version);
    // No version, no extras. A binary Sway cannot name is one no measurement
    // can be scoped to, so the picker shows exactly what the agent published
    // rather than a disabled row explaining a claim Sway never got to make.
    let Some(running) = running else { return out };
    for extra in extras {
        // A level the agent already named is the agent's, not Sway's. An extra
        // that collides with one adds nothing and must not re-state it as a
        // second row the picker cannot tell apart.
        if out.iter().any(|l| l.level == extra.id) {
            continue;
        }
        let stale = crate::health::parse_version(&extra.measured_on).as_ref() != Some(&running);
        let refused = extra.state == EffortExtraState::Refused;
        out.push(ChatEffortLevel {
            level: extra.id.clone(),
            label: extra.label.clone(),
            disabled: stale || refused,
            // Stale wins over refused, and the order is the point: a refusal is
            // a sentence about the binary it was heard from, so on any other one
            // it is exactly as unre-checked as a working measurement would be.
            // Quoting it there would be this gate's own failure, one row over.
            note: if stale {
                format!(
                    "Measured on {}, and this is {running}. Re-run dev/effort-probe.mjs to offer it again.",
                    extra.measured_on,
                )
            } else if refused {
                extra.note.clone()
            } else {
                String::new()
            },
        });
    }
    out
}

/// What kind of content an open block at a given index holds. Recorded at
/// `content_block_start` so the deltas that follow can be routed.
#[derive(Debug, Clone, PartialEq)]
enum OpenBlock {
    Text,
    Thinking,
    ToolUse { tool_use_id: String, name: String },
    /// A block type we do not render specially. Its deltas are dropped rather
    /// than guessed at.
    Other,
}

/// Per-session mapping state. One of these lives alongside each child process.
#[derive(Debug, Default)]
pub struct ClaudeMapper {
    session_id: String,
    /// False until the first `system/init`, which is what makes the second and
    /// later ones turn starts instead of session starts.
    session_open: bool,
    /// Incrementing turn counter; `turn_id` is derived from it.
    turn_seq: u64,
    /// Whether a turn is currently open, so a `result` can be attributed and a
    /// stray frame outside a turn does not invent one.
    turn_open: bool,
    open_blocks: HashMap<u64, OpenBlock>,
    /// The rich slash-command catalogue from the `initialize` control response,
    /// held until the first `system/init` can carry it into `SessionStarted`.
    /// `system/init` itself reports only bare names.
    command_catalogue: Vec<SlashCommand>,
    /// The model catalogue from the same control response, held the same way
    /// and for the same reason: `system/init` reports one resolved model id and
    /// never the list of what could be picked. Empty for a session that never
    /// handshook, which the picker reads as "fall back to the adapter table".
    model_catalogue: Vec<ChatModelInfo>,
    /// The account from the same control response, held the same way. `None`
    /// for a session that never handshook, which every consumer reads as
    /// "unknown" rather than as an account with empty fields.
    account: Option<ChatAccount>,
    /// Whether the answered handshake was already reported as `SessionReady`.
    /// Once, like `session_open`: a later control response (a set_model ack, an
    /// interrupt ack) proves nothing the first one did not.
    handshake_reported: bool,
    /// Tool inputs accumulated from `input_json_delta`, keyed by block index.
    partial_tool_input: HashMap<u64, String>,
    /// Hook ids proven to be Sway's own, learned from the marker on their
    /// `hook_response`. Retained for the session because a hook's `Started` can
    /// be re-examined only through this id, and the set is bounded by the
    /// number of tool calls rather than by anything unbounded.
    sway_hook_ids: std::collections::HashSet<String>,
    /// Tool calls whose result names a file they only *read*. Learned from the
    /// call's own name, and retained for the same reason and with the same
    /// bound as `sway_hook_ids`: the result frame arrives with nothing but a
    /// `tool_use_id` on it.
    read_only_calls: std::collections::HashSet<String>,
    /// `Agent` call id -> the `task_id` it launched, from `task_started`. What
    /// turns a nested frame's `parent_tool_use_id` into its lane.
    lane_of_call: HashMap<String, String>,
    /// Calls already announced against a lane, so the several frames one call
    /// produces do not each repeat its membership. Bounded like the tool-call
    /// sets above, and for the same reason.
    announced_calls: std::collections::HashSet<String>,
    /// The adapter's measured effort levels. Empty is a mapper nobody gave any,
    /// which offers the catalogue's own list rather than guessing at more.
    effort_extras: Vec<ChatEffortExtra>,
    /// The kill switch, stored in the negative so the derived `Default` is the
    /// live behaviour rather than the disabled one. True restores what shipped
    /// before the question card: `AskUserQuestion` becomes a permission prompt
    /// like any other tool, answerable only allow or deny.
    questions_as_permissions: bool,
    /// The binary that answered, from `system/init`. Empty until the first one,
    /// which is what keeps a measured extra out of the handshake's catalogue:
    /// the claim is scoped to a version, and nothing has named one yet.
    cli_version: String,
    /// The model the session last reported running. Empty before the first
    /// `system/init`, and what makes a model change detectable at all: the
    /// switch is reported here whether Sway asked for it or `/model` did.
    reported_model: String,
    /// Why the session says fast mode will not serve, from `system/init`'s
    /// `fast_mode_disabled_reason`. An account fact rather than a model one, so
    /// it is held on the mapper and re-read on every model switch: the reason
    /// does not change when the model does, but the option set is rebuilt.
    fast_mode_reason: Option<String>,
}

impl ClaudeMapper {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            ..Default::default()
        }
    }

    /// Hand the mapper the levels Sway measured that this CLI never advertises,
    /// so the live catalogue offers the same set the probe cached.
    pub fn with_effort_extras(mut self, extras: Vec<ChatEffortExtra>) -> Self {
        self.effort_extras = extras;
        self
    }

    /// Send `AskUserQuestion` back down the permission path, as it was before
    /// the question card existed.
    pub fn with_questions_as_permissions(mut self, on: bool) -> Self {
        self.questions_as_permissions = on;
        self
    }

    fn turn_id(&self) -> String {
        format!("turn-{}", self.turn_seq)
    }

    /// The handshake's model catalogue with each row's effort picker filled in.
    ///
    /// One method for the two events the catalogue leaves on, so the handshake
    /// report and the session start cannot offer different levels for the same
    /// model. Decorated on the way out rather than when the response is
    /// absorbed, because the `initialize` response never names a version and
    /// `system/init` does.
    fn decorated_catalogue(&self) -> Vec<ChatModelInfo> {
        self.model_catalogue
            .iter()
            .map(|m| ChatModelInfo {
                effort_levels: effort_levels(m, &self.effort_extras, &self.cli_version),
                ..m.clone()
            })
            .collect()
    }

    /// The lever set for the model this init reports, when it is not the set
    /// already published.
    ///
    /// Driven by what the session says it is running, not by Sway's own set
    /// path, so a `/model` slash command refreshes the mirror exactly as
    /// `chat_set_model` does: both are confirmed by the next `system/init`.
    fn model_options(&mut self, model: &str) -> Option<ChatEvent> {
        if self.reported_model == model {
            return None;
        }
        self.reported_model = model.to_string();
        // The session's own report beats the catalogue, so a model the
        // handshake did not list (or spelled differently) still gets its
        // levers: what is running is the id init just named.
        let row = self
            .model_catalogue
            .iter()
            .find(|m| m.resolved_model == model)
            .cloned()
            .unwrap_or_else(|| ChatModelInfo { resolved_model: model.to_string(), ..Default::default() });
        Some(ChatEvent::ConfigOptions {
            session_id: self.session_id.clone(),
            options: config_options(&row, self.fast_mode_reason.as_deref()),
        })
    }

    /// Absorb the `initialize` control response, the only place command
    /// descriptions, argument hints, the model catalogue and the account exist.
    ///
    /// All three are absorbed independently: a response carrying one and not
    /// the others must not discard what it does carry.
    pub fn absorb_control_response(&mut self, frame: &Value) {
        let inner = &frame["response"]["response"];
        if let Some(commands) = inner["commands"].as_array() {
            self.command_catalogue = commands
                .iter()
                .filter_map(|c| {
                    Some(SlashCommand {
                        name: c["name"].as_str()?.to_string(),
                        description: c["description"].as_str().unwrap_or_default().to_string(),
                        argument_hint: c["argumentHint"].as_str().map(str::to_string),
                        aliases: c["aliases"]
                            .as_array()
                            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                            .unwrap_or_default(),
                    })
                })
                .collect();
        }
        if let Some(models) = inner["models"].as_array() {
            self.model_catalogue = models
                .iter()
                .filter_map(|m| {
                    // Both ids are required: an entry missing either one cannot
                    // be picked (`--model` needs `value`) or confirmed (the next
                    // init reports `resolvedModel`), so it is dropped rather
                    // than half-rendered.
                    Some(ChatModelInfo {
                        value: m["value"].as_str()?.to_string(),
                        resolved_model: m["resolvedModel"].as_str()?.to_string(),
                        display_name: m["displayName"].as_str().unwrap_or_default().to_string(),
                        description: m["description"].as_str().unwrap_or_default().to_string(),
                        supports_effort: m["supportsEffort"].as_bool().unwrap_or(false),
                        supported_effort_levels: m["supportedEffortLevels"]
                            .as_array()
                            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                            .unwrap_or_default(),
                        // Filled on the way out, where the version is known.
                        effort_levels: Vec::new(),
                        supports_auto_mode: m["supportsAutoMode"].as_bool().unwrap_or(false),
                        supports_fast_mode: m["supportsFastMode"].as_bool().unwrap_or(false),
                        supports_adaptive_thinking: m["supportsAdaptiveThinking"]
                            .as_bool()
                            .unwrap_or(false),
                    })
                })
                .collect();
        }
        // Presence of the object is the signal, not the presence of any one
        // field: a plan with no organization is still a known account, and
        // rendering hangs off "did the handshake answer" rather than off
        // whether every string came back non-empty. `email` is read past
        // deliberately; see `ChatAccount`.
        if inner["account"].is_object() {
            // Read through `Value` rather than the inner `Map`, which **panics**
            // on a missing key where `Value` yields null. A plan with no
            // organization is the documented case right above this, so indexing
            // the map made the one shape this branch exists to tolerate crash
            // the reader thread.
            let account = &inner["account"];
            self.account = Some(ChatAccount {
                subscription_type: account["subscriptionType"].as_str().unwrap_or_default().to_string(),
                organization: account["organization"].as_str().unwrap_or_default().to_string(),
                api_provider: account["apiProvider"].as_str().unwrap_or_default().to_string(),
            });
        }
    }

    /// Map one stream-json frame to zero or more `ChatEvent`s.
    ///
    /// Zero is a normal and common answer: most frames are either redundant
    /// with a frame we already mapped (the non-streaming `assistant` message
    /// repeats content already sent as deltas) or carry nothing the UI needs.
    /// Guessing an event for such a frame would duplicate content in the
    /// transcript, which is worse than dropping it.
    pub fn map(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let events = self.map_frame(frame);
        self.attribute_to_lane(frame, events)
    }

    /// Announce every call a nested frame introduced against the lane it ran in.
    /// Here because `map` is the only place seeing both the parent and the
    /// events. An unknown parent is left alone rather than guessed at.
    fn attribute_to_lane(&mut self, frame: &Value, events: Vec<ChatEvent>) -> Vec<ChatEvent> {
        let Some(agent_id) = frame["parent_tool_use_id"]
            .as_str()
            .and_then(|parent| self.lane_of_call.get(parent))
            .cloned()
        else {
            return events;
        };
        let mut out = Vec::with_capacity(events.len());
        for mut ev in events {
            // Text is stamped in place; a call is announced beside itself
            // instead, keyed on its id, because a card is built from several
            // frames and only one of them is nested.
            match &mut ev {
                ChatEvent::TextDelta { agent_id: lane, .. } | ChatEvent::ThinkingDelta { agent_id: lane, .. } => {
                    *lane = Some(agent_id.clone());
                }
                _ => {}
            }
            if let Some(tool_use_id) = call_named_by(&ev) {
                if self.announced_calls.insert(tool_use_id.to_string()) {
                    out.push(ChatEvent::SubagentCall {
                        session_id: self.session_id.clone(),
                        agent_id: agent_id.clone(),
                        tool_use_id: tool_use_id.to_string(),
                    });
                }
            }
            out.push(ev);
        }
        out
    }

    fn map_frame(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let events = match frame["type"].as_str() {
            Some("system") => self.map_system(frame),
            Some("stream_event") => self.map_stream_event(frame),
            Some("user") => self.map_user(frame),
            Some("assistant") => self.map_assistant(frame),
            Some("rate_limit_event") => self.map_rate_limit(frame),
            Some("result") => self.map_result(frame),
            Some("control_response") => {
                self.absorb_control_response(frame);
                self.report_ready()
            }
            Some("control_request") => self.map_control_request(frame),
            _ => Vec::new(),
        };
        // Noted here rather than at each emission site, because a tool call is
        // announced from two of them (block open, then block close with the
        // full input) and this is the one place both pass through.
        for ev in &events {
            if let ChatEvent::ToolCallStarted { tool_use_id, name, .. } = ev {
                if READ_ONLY_TOOLS.contains(&name.as_str()) {
                    self.read_only_calls.insert(tool_use_id.clone());
                }
            }
        }
        events
    }

    /// Map an inbound `control_request`, which today means one thing: the CLI
    /// asking whether a tool call may proceed.
    ///
    /// This is the request `--permission-prompt-tool stdio` turns on, and it is
    /// the agent's *own* permission chain asking - so it fires only for calls
    /// the agent itself has not already settled. Measured on claude 2.1.231
    /// (`dev/protocol-probe.mjs`, scenario `permission-coverage`): `Write`,
    /// `WebFetch`, a non-safe-listed `Bash`, an MCP tool and a `Task` subagent's
    /// own call all ask; `Read` does not, and neither does anything under
    /// `acceptEdits` or `bypassPermissions`. Those silences are the agent
    /// deciding, not a gap Sway has to cover.
    ///
    /// **Nothing is answered here.** The mapper's only job is to turn the frame
    /// into an event; the answer travels back out through the transport, which
    /// is the half that owns the deadline. An unrecognised subtype maps to no
    /// event rather than to a guess, because a control request Sway does not
    /// understand is one it must not pretend to have handled.
    fn map_control_request(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let request = &frame["request"];
        if request["subtype"].as_str() != Some("can_use_tool") {
            return Vec::new();
        }
        // Both ids are required. Without `request_id` the answer cannot be
        // correlated and the child would block forever; without `tool_use_id`
        // the prompt cannot find its tool card. A frame missing either is
        // dropped rather than half-rendered.
        let (Some(request_id), Some(tool_use_id)) =
            (frame["request_id"].as_str(), request["tool_use_id"].as_str())
        else {
            return Vec::new();
        };
        // The one tool that asks rather than acts. It falls through to a
        // permission prompt when the form cannot be parsed, which is the honest
        // degrade: a half-read form would send the agent an answer to a
        // question the user was never shown.
        if !self.questions_as_permissions && request["tool_name"].as_str() == Some(ASK_USER_QUESTION) {
            if let Some(questions) = parse_questions(&request["input"]) {
                return vec![ChatEvent::QuestionRequest {
                    session_id: self.session_id.clone(),
                    tool_use_id: tool_use_id.to_string(),
                    request_id: request_id.to_string(),
                    agent_id: request["agent_id"].as_str().map(str::to_string),
                    questions,
                }];
            }
        }
        vec![ChatEvent::PermissionRequest {
            session_id: self.session_id.clone(),
            tool_use_id: tool_use_id.to_string(),
            tool_name: request["tool_name"].as_str().unwrap_or_default().to_string(),
            input: request["input"].clone(),
            request_id: request_id.to_string(),
            // Filled by the transport, which is where the deadline is armed.
            auto_deny_at_ms: None,
            agent_id: request["agent_id"].as_str().map(str::to_string),
            suggestions: suggestions(&request["permission_suggestions"]),
        }]
    }

    /// An answered control request is the first proof the child is alive:
    /// `system/init` does not arrive until the first turn starts, so without
    /// this a freshly opened chat has no liveness signal at all until the user
    /// sends something. Reported once, and not after `system/init` has already
    /// opened the session, where it would be stale news.
    fn report_ready(&mut self) -> Vec<ChatEvent> {
        if self.handshake_reported || self.session_open {
            return Vec::new();
        }
        self.handshake_reported = true;
        vec![ChatEvent::SessionReady {
            session_id: self.session_id.clone(),
            slash_commands: self.command_catalogue.clone(),
            models: self.decorated_catalogue(),
            // Claude's modes are declared in `claude.toml` and checked against
            // the real CLI by `modes_the_cli_accepts`, so there is nothing live
            // to carry. Empty means "use the adapter's table", which is where
            // they already are.
            modes: Vec::new(),
            account: self.account.clone(),
            // Claude advertises no capability set of its own. What Sway knows
            // about this agent was measured and pinned in the chat tier, so
            // there is nothing on the wire to carry - and `None` says exactly
            // that rather than claiming an agent that supports nothing.
            capabilities: None,
        }]
    }

    fn map_system(&mut self, frame: &Value) -> Vec<ChatEvent> {
        match frame["subtype"].as_str() {
            Some("init") => self.map_init(frame),
            Some("compact_boundary") => self.map_compact_boundary(frame),
            Some("status") => self.map_status(frame),
            Some("hook_started") => self.map_hook(frame, HookPhase::Started),
            Some("hook_response") => self.map_hook(frame, HookPhase::Finished),
            Some("task_started") => self.map_task_started(frame),
            // Three frames, one variant: each patches the same record.
            // `background_tasks_changed` is not mapped: it names no task.
            Some("task_progress") | Some("task_updated") | Some("task_notification") => {
                self.map_task_update(frame)
            }
            _ => Vec::new(),
        }
    }

    /// The one place a subagent's two ids are joined. The `tool_use_id ->
    /// task_id` entry is what later lets a nested frame name its lane.
    ///
    /// **Not every task here is a subagent.** A backgrounded `Bash` rides the
    /// same channel as `local_bash`, so only `local_agent` claims the call: a
    /// shell task's own tool card belongs to the main conversation, and stamping
    /// it with a lane would file it under a transcript that does not exist.
    fn map_task_started(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let (Some(agent_id), Some(tool_use_id)) =
            (frame["task_id"].as_str(), frame["tool_use_id"].as_str())
        else {
            return Vec::new();
        };
        let task_type = frame["task_type"].as_str().unwrap_or_default().to_string();
        if task_type == SUBAGENT_TASK {
            self.lane_of_call
                .insert(tool_use_id.to_string(), agent_id.to_string());
        }
        vec![ChatEvent::SubagentStarted {
            session_id: self.session_id.clone(),
            agent_id: agent_id.to_string(),
            tool_use_id: tool_use_id.to_string(),
            task_type,
            agent_type: frame["subagent_type"].as_str().unwrap_or_default().to_string(),
            description: frame["description"].as_str().unwrap_or_default().to_string(),
            prompt: frame["prompt"].as_str().unwrap_or_default().to_string(),
        }]
    }

    /// Status is read from two places because the frames disagree:
    /// `task_updated` nests it under `patch`, `task_notification` does not.
    fn map_task_update(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let Some(agent_id) = frame["task_id"].as_str() else {
            return Vec::new();
        };
        let status = frame["patch"]["status"]
            .as_str()
            .or_else(|| frame["status"].as_str())
            .map(str::to_string);
        let usage = frame.get("usage").filter(|u| !u.is_null()).map(|u| SubagentUsage {
            total_tokens: u["total_tokens"].as_u64().unwrap_or(0),
            tool_uses: u["tool_uses"].as_u64().unwrap_or(0),
            duration_ms: u["duration_ms"].as_u64().unwrap_or(0),
        });
        vec![ChatEvent::SubagentUpdate {
            session_id: self.session_id.clone(),
            agent_id: agent_id.to_string(),
            status,
            activity: frame["description"].as_str().map(str::to_string),
            last_tool_name: frame["last_tool_name"].as_str().map(str::to_string),
            usage,
            summary: frame["summary"].as_str().map(str::to_string),
        }]
    }

    /// A compaction boundary. The summary is not on this frame - measured, it is
    /// the *next* user message - so this reports the reclaim and leaves the
    /// summary to be stitched on by a reader that sees both.
    ///
    /// Subagent boundaries are skipped: reporting one would claim a reclaim
    /// this transcript never had. This read `isSidechain` until 2026-09-04,
    /// the transcript's spelling, absent from all twenty live captures.
    ///
    /// **Both spellings, because the two surfaces disagree.** The stream frame
    /// says `compact_metadata`/`pre_tokens`/`post_tokens` (claude 2.1.251,
    /// `dev/fixtures/claude/compaction.jsonl`) while the transcript record on
    /// disk says `compactMetadata`/`preTokens`/`postTokens` for the same
    /// compaction - checked against both on one captured run. Reading only the
    /// camelCase one, as this did, cost a live compaction its trigger word and
    /// both its figures: the notice degraded to a bare "Compacted." while the
    /// same session, reopened and replayed off disk, read "Compacted manually
    /// (16.6k to 2k)". Neither spelling is more correct, so neither is dropped.
    fn map_compact_boundary(&mut self, frame: &Value) -> Vec<ChatEvent> {
        if frame["parent_tool_use_id"].is_string() {
            return Vec::new();
        }
        let meta = match frame.get("compact_metadata") {
            Some(m) if !m.is_null() => m,
            _ => &frame["compactMetadata"],
        };
        let tokens = |snake: &str, camel: &str| meta[snake].as_u64().or_else(|| meta[camel].as_u64());
        vec![ChatEvent::Compacted {
            session_id: self.session_id.clone(),
            turn_id: self.turn_id(),
            trigger: meta["trigger"].as_str().map(str::to_string),
            pre_tokens: tokens("pre_tokens", "preTokens"),
            post_tokens: tokens("post_tokens", "postTokens"),
            summary: None,
        }]
    }

    /// The CLI's own "what am I doing" channel.
    ///
    /// Measured values: `"requesting"`, which every turn emits and which the
    /// turn state already says better; `"compacting"`; and `null` on the frame
    /// that closes one, alongside `compact_result` and, when it did not work, a
    /// `compact_error`. Only the compaction pair is carried across - a status
    /// this build has never seen is not news, and inventing a caption for it is
    /// how a wire word ends up in the UI.
    fn map_status(&mut self, frame: &Value) -> Vec<ChatEvent> {
        if frame["status"].as_str() == Some("compacting") {
            return vec![ChatEvent::CompactionStarted {
                session_id: self.session_id.clone(),
                turn_id: self.turn_id(),
            }];
        }
        // Keyed on the error rather than on `compact_result`, because the
        // failure is the half worth reporting and the message is the whole of
        // what it has to say. A success needs nothing here: the boundary that
        // follows it carries the figures.
        if let Some(error) = frame["compact_error"].as_str() {
            return vec![ChatEvent::CompactionFailed {
                session_id: self.session_id.clone(),
                turn_id: self.turn_id(),
                error: error.to_string(),
            }];
        }
        Vec::new()
    }

    /// One `hook_started`/`hook_response` frame.
    ///
    /// Ownership is decided from the marker Sway stamps on its own hook output
    /// ([`approval::SWAY_HOOK_MARKER`]), never from `hook_name`: that field
    /// reports the *tool*, so Sway's all-tools hook and a user's hook on the
    /// same tool are both `PreToolUse:Bash` and cannot be told apart by name.
    ///
    /// Only the response carries the marker, so a `Started` is remembered by
    /// `hook_id` and its ownership settled when the response arrives. A
    /// `Started` whose response has not landed yet is reported as not-ours,
    /// which is the safe direction: it shows a row that may then be folded
    /// away, rather than hiding a user hook that never gets attributed.
    fn map_hook(&mut self, frame: &Value, phase: HookPhase) -> Vec<ChatEvent> {
        let hook_id = frame["hook_id"].as_str().unwrap_or_default().to_string();
        let output = frame["output"].as_str().map(str::to_string);
        let sway_owned = match phase {
            HookPhase::Finished => {
                let owned = output.as_deref().is_some_and(is_sway_hook_output);
                if owned {
                    self.sway_hook_ids.insert(hook_id.clone());
                }
                owned
            }
            HookPhase::Started => self.sway_hook_ids.contains(&hook_id),
        };
        vec![ChatEvent::HookFired {
            session_id: self.session_id.clone(),
            hook_id,
            name: frame["hook_name"].as_str().unwrap_or_default().to_string(),
            event: frame["hook_event"].as_str().unwrap_or_default().to_string(),
            phase,
            sway_owned,
            outcome: frame["outcome"].as_str().map(str::to_string),
            exit_code: frame["exit_code"].as_i64(),
            output,
            stderr: frame["stderr"].as_str().map(str::to_string).filter(|s| !s.is_empty()),
        }]
    }

    fn map_init(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let model = frame["model"].as_str().unwrap_or_default().to_string();
        let mode = permission_mode(frame["permissionMode"].as_str());
        // Before anything reads the catalogue below: this is the first frame
        // that names the binary answering, and a measured extra level is only
        // offered while its measurement names that same one.
        if let Some(v) = frame["claude_code_version"].as_str() {
            self.cli_version = v.to_string();
        }
        // Before `model_options`, which reads it: this is where the account's
        // own reason arrives, and it has to be in hand by the time the lever
        // that quotes it is built. Re-read on every init rather than latched on
        // the first, since an account can run out of credits mid session.
        self.fast_mode_reason = frame["fast_mode_disabled_reason"].as_str().map(str::to_string);
        // Taken before either branch returns, because an init is both the first
        // report of the model and every later one.
        let options = self.model_options(&model);

        // The measured quirk this whole state machine exists for: the *first*
        // init opens the session, every later one starts a turn.
        if !self.session_open {
            self.session_open = true;
            let bare: Vec<String> = frame["slash_commands"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            // Prefer the control-response catalogue; fall back to bare names so
            // a session that skipped the handshake still gets a usable menu.
            let slash_commands = if self.command_catalogue.is_empty() {
                bare.into_iter()
                    .map(|name| SlashCommand {
                        name,
                        description: String::new(),
                        argument_hint: None,
                        aliases: Vec::new(),
                    })
                    .collect()
            } else {
                self.command_catalogue.clone()
            };

            let mut extra = Extra::new();
            for key in ["claude_code_version", "capabilities", "memory_paths", "skills", "agents", "plugins"] {
                if let Some(v) = frame.get(key) {
                    extra.insert(camel(key), v.clone());
                }
            }
            let fast_mode_state = frame["fast_mode_state"].as_str().map(str::to_string);
            let fast_mode_disabled_reason = self.fast_mode_reason.clone();

            self.turn_seq = 1;
            self.turn_open = true;
            let mut out = vec![
                ChatEvent::SessionStarted {
                    session_id: self.session_id.clone(),
                    cwd: frame["cwd"].as_str().unwrap_or_default().to_string(),
                    model: model.clone(),
                    permission_mode: mode.clone(),
                    tools: frame["tools"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                    slash_commands,
                    mcp_servers: mcp_servers(&frame["mcp_servers"]),
                    models: self.decorated_catalogue(),
                    // Declared in the adapter, not reported by the CLI.
                    modes: Vec::new(),
                    fast_mode_state,
                    fast_mode_disabled_reason,
                    account: self.account.clone(),
                    extra,
                },
                ChatEvent::TurnStarted {
                    session_id: self.session_id.clone(),
                    turn_id: self.turn_id(),
                    agent_initiated: false,
                    model,
                    permission_mode: mode,
                    extra: Extra::new(),
                },
            ];
            // Last, and outside the lifecycle: the options move whenever the
            // agent says so, which is not a step in the open sequence.
            out.extend(options);
            return out;
        }

        self.turn_seq += 1;
        self.turn_open = true;
        self.open_blocks.clear();
        self.partial_tool_input.clear();
        let mut out = vec![ChatEvent::TurnStarted {
            session_id: self.session_id.clone(),
            turn_id: self.turn_id(),
            agent_initiated: false,
            model,
            permission_mode: mode,
            extra: Extra::new(),
        }];
        out.extend(options);
        out
    }

    /// A **nested** `assistant` frame, a subagent's only declaration of its own
    /// work: it does not stream, so no `stream_event` twin repeats this. The
    /// main agent's frames stay dropped, or every call would render twice.
    fn map_assistant(&self, frame: &Value) -> Vec<ChatEvent> {
        if !frame["parent_tool_use_id"].is_string() {
            return Vec::new();
        }
        let mut out = Vec::new();
        for block in frame["message"]["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") => {
                    let text = block["text"].as_str().unwrap_or_default();
                    if text.is_empty() {
                        continue;
                    }
                    out.push(ChatEvent::TextDelta {
                        session_id: self.session_id.clone(),
                        turn_id: self.turn_id(),
                        text: text.to_string(),
                        agent_id: None,
                    });
                }
                Some("tool_use") => {
                    let name = block["name"].as_str().unwrap_or_default().to_string();
                    // Whole, in one emission, unlike the streamed path: the
                    // arguments are already here, so there is no empty card to
                    // fill in later.
                    out.push(ChatEvent::ToolCallStarted {
                        session_id: self.session_id.clone(),
                        turn_id: self.turn_id(),
                        tool_use_id: block["id"].as_str().unwrap_or_default().to_string(),
                        kind: tool_kind(&name),
                        name,
                        input: block["input"].clone(),
                        locations: Vec::new(),
                        title: None,
                    });
                }
                _ => {}
            }
        }
        out
    }

    fn map_stream_event(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let ev = &frame["event"];
        let index = ev["index"].as_u64().unwrap_or(0);
        match ev["type"].as_str() {
            Some("content_block_start") => {
                let block = &ev["content_block"];
                let open = match block["type"].as_str() {
                    Some("text") => OpenBlock::Text,
                    Some("thinking") => OpenBlock::Thinking,
                    Some("tool_use") => OpenBlock::ToolUse {
                        tool_use_id: block["id"].as_str().unwrap_or_default().to_string(),
                        name: block["name"].as_str().unwrap_or_default().to_string(),
                    },
                    _ => OpenBlock::Other,
                };
                let started = match &open {
                    // A tool call is announced the moment its block opens, so a
                    // card can render before the arguments have finished
                    // streaming. The input starts empty and fills via
                    // ToolCallProgress.
                    OpenBlock::ToolUse { tool_use_id, name } => vec![ChatEvent::ToolCallStarted {
                        session_id: self.session_id.clone(),
                        turn_id: self.turn_id(),
                        tool_use_id: tool_use_id.clone(),
                        name: name.clone(),
                        input: Value::Object(Default::default()),
                        kind: tool_kind(name),
                        // Claude publishes neither. `name` is already the short
                        // human-readable token a row wants, so there is no prose
                        // to put in `title`, and the paths a call names live in
                        // its arguments, which have not arrived yet at this
                        // emission.
                        locations: Vec::new(),
                        title: None,
                    }],
                    _ => Vec::new(),
                };
                self.open_blocks.insert(index, open);
                started
            }

            Some("content_block_delta") => {
                let delta = &ev["delta"];
                // Route by the block this index opened with: the delta itself
                // never says whether it is text or thinking.
                match (self.open_blocks.get(&index), delta["type"].as_str()) {
                    // Never a lane: only the main agent streams, so a delta
                    // is the main agent's by construction. A subagent's prose
                    // arrives whole, through `map_assistant`.
                    (Some(OpenBlock::Text), Some("text_delta")) => vec![ChatEvent::TextDelta {
                        session_id: self.session_id.clone(),
                        turn_id: self.turn_id(),
                        text: delta["text"].as_str().unwrap_or_default().to_string(),
                        agent_id: None,
                    }],
                    (Some(OpenBlock::Thinking), Some("thinking_delta")) => vec![ChatEvent::ThinkingDelta {
                        session_id: self.session_id.clone(),
                        turn_id: self.turn_id(),
                        text: delta["thinking"].as_str().unwrap_or_default().to_string(),
                        agent_id: None,
                    }],
                    // The cryptographic signature of a thinking block is not
                    // content and must never reach the transcript.
                    (Some(OpenBlock::Thinking), Some("signature_delta")) => Vec::new(),
                    (Some(OpenBlock::ToolUse { tool_use_id, .. }), Some("input_json_delta")) => {
                        let chunk = delta["partial_json"].as_str().unwrap_or_default();
                        self.partial_tool_input.entry(index).or_default().push_str(chunk);
                        vec![ChatEvent::ToolCallProgress {
                            session_id: self.session_id.clone(),
                            turn_id: self.turn_id(),
                            tool_use_id: tool_use_id.clone(),
                            partial_input: chunk.to_string(),
                        }]
                    }
                    _ => Vec::new(),
                }
            }

            Some("content_block_stop") => {
                // A finished tool-use block is where the accumulated argument
                // JSON becomes parseable, so this is the first point a card can
                // show real input rather than a fragment.
                let finished = match self.open_blocks.get(&index) {
                    Some(OpenBlock::ToolUse { tool_use_id, name }) => {
                        let raw = self.partial_tool_input.get(&index).cloned().unwrap_or_default();
                        let input = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Object(Default::default()));
                        vec![ChatEvent::ToolCallStarted {
                            session_id: self.session_id.clone(),
                            turn_id: self.turn_id(),
                            tool_use_id: tool_use_id.clone(),
                            name: name.clone(),
                            input,
                            kind: tool_kind(name),
                            locations: Vec::new(),
                            title: None,
                        }]
                    }
                    _ => Vec::new(),
                };
                self.open_blocks.remove(&index);
                self.partial_tool_input.remove(&index);
                finished
            }

            Some("message_delta") => {
                // One API response's usage, which is what "context" means: the
                // tokens this request was given. A subagent's response is not
                // the conversation's, so it is skipped rather than allowed to
                // report a Task's occupancy as the session's.
                if frame["parent_tool_use_id"].is_string() {
                    return Vec::new();
                }
                let usage = usage_from(&ev["usage"]);
                if usage == Usage::default() {
                    return Vec::new();
                }
                vec![ChatEvent::Usage {
                    session_id: self.session_id.clone(),
                    turn_id: self.turn_id(),
                    usage,
                    extra: Extra::new(),
                }]
            }

            _ => Vec::new(),
        }
    }

    /// A `user` frame in this stream is not the human speaking; it is the tool
    /// results being fed back to the model.
    fn map_user(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let Some(content) = frame["message"]["content"].as_array() else {
            return Vec::new();
        };
        content
            .iter()
            .filter(|c| c["type"] == "tool_result")
            .map(|c| {
                let id = c["tool_use_id"].as_str().unwrap_or_default();
                ChatEvent::ToolCallCompleted {
                    session_id: self.session_id.clone(),
                    turn_id: self.turn_id(),
                    tool_use_id: id.to_string(),
                    // A blocked call and a call that ran and failed both arrive
                    // as `is_error: true`; they are told apart at the session
                    // level by whether the id shows up in
                    // `result.permission_denials`, so a finer verdict is not
                    // available here.
                    status: if c["is_error"].as_bool().unwrap_or(false) {
                        ToolStatus::Error
                    } else {
                        ToolStatus::Ok
                    },
                    // Whole. The host cuts it on its way past and keeps the
                    // rest, which is the only place that can: the cache lives
                    // there, and an adapter that cut here would have thrown
                    // away what a card later asks for.
                    output: tool_result_text(&c["content"]),
                    // A read reports its target in the same shape a write does,
                    // so the *call* has to say which it was. Without this,
                    // opening a file another session is editing files that file
                    // under this session's writes, and the turn offers to
                    // revert it.
                    files: if self.read_only_calls.contains(id) {
                        Vec::new()
                    } else {
                        files_touched(&frame["tool_use_result"])
                    },
                    duration_ms: None,
                    // The structured result sits on the *frame*, not on the
                    // content block, and a frame carries at most one tool
                    // result: measured across 47539 such records in the local
                    // transcript corpus, none held a second `tool_result`
                    // block. So this payload belongs to this block without
                    // having to be matched to it.
                    summary: summarise_result(&frame["tool_use_result"]),
                    output_truncated: false,
                    patch: structured_patch(&frame["tool_use_result"]),
                }
            })
            .collect()
    }

    fn map_rate_limit(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let info = &frame["rate_limit_info"];
        vec![ChatEvent::RateLimit {
            session_id: self.session_id.clone(),
            status: info["status"].as_str().unwrap_or_default().to_string(),
            resets_at: info["resetsAt"].as_u64(),
            limit_type: info["rateLimitType"].as_str().map(str::to_string),
            utilization: info["utilization"].as_f64(),
            windows: unified_windows(&info["unifiedWindows"]),
            overage_status: info["overageStatus"].as_str().map(str::to_string),
        }]
    }

    fn map_result(&mut self, frame: &Value) -> Vec<ChatEvent> {
        if !self.turn_open {
            return Vec::new();
        }
        self.turn_open = false;
        // Unclosed blocks are expected here rather than exceptional: an
        // interrupted turn truncates the stream, so the CLI never sends the
        // closing frames. Clearing them is the mapper honouring the obligation
        // the protocol leaves to the consumer.
        self.open_blocks.clear();
        self.partial_tool_input.clear();

        let is_error = frame["is_error"].as_bool().unwrap_or(false);
        let subtype = frame["subtype"].as_str().unwrap_or_default();
        // An interrupt is delivered as a failure-shaped result. It is not a
        // failure: the user asked for it, and calling it one would make the
        // composer flush the very queue that stop was pressed to hold.
        let outcome = if !is_error {
            TurnOutcome::Completed
        } else if subtype == "error_during_execution" {
            TurnOutcome::Cancelled
        } else {
            TurnOutcome::Errored
        };

        let mut extra = Extra::new();
        for (key, name) in [
            ("ttft_ms", "ttftMs"),
            ("modelUsage", "modelUsage"),
            ("num_turns", "numTurns"),
            ("duration_ms", "durationMs"),
            ("terminal_reason", "terminalReason"),
        ] {
            if let Some(v) = frame.get(key) {
                extra.insert(name.to_string(), v.clone());
            }
        }

        vec![ChatEvent::TurnCompleted {
            session_id: self.session_id.clone(),
            turn_id: self.turn_id(),
            outcome,
            stop_reason: frame["stop_reason"]
                .as_str()
                .map(str::to_string)
                .or_else(|| Some(subtype.to_string()).filter(|s| !s.is_empty())),
            usage: usage_from(&frame["usage"]),
            cost_usd: frame["total_cost_usd"].as_f64(),
            permission_denials: denials(&frame["permission_denials"]),
            extra,
        }]
    }
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

/// The mode `system/init` reported, carried through as the CLI spelled it.
///
/// A mode this build has never heard of is **kept**, not folded into
/// `default`. The enum this replaced had to guess, and guessed at the strictest
/// mode, which was the safe answer to the wrong question: reporting `default`
/// for a session actually running `dontAsk` tells the user the opposite of the
/// truth about what the agent may do without asking. Passing the id through
/// means the status shows what the CLI said, and an id Sway cannot resolve to a
/// declared mode is handled where that is decidable - see `ChatConfig::mode_args_for`.
///
/// Absent stays `default`, which is the Claude literal on purpose: this is the
/// Claude mapper, and it is what the CLI itself falls back to.
fn permission_mode(raw: Option<&str>) -> PermissionMode {
    PermissionMode::new(raw.unwrap_or("default"))
}

/// `unifiedWindows` as a sorted list, so two frames carrying the same windows
/// map to the same value whatever order the map serialised in.
///
/// A window with no `utilization` is dropped rather than defaulted to zero: an
/// unreported level is not a level of nothing, and a 0% bar would read as an
/// untouched quota.
fn unified_windows(raw: &Value) -> Vec<UsageWindow> {
    let Some(map) = raw.as_object() else {
        return Vec::new();
    };
    let mut out: Vec<UsageWindow> = map
        .iter()
        .filter_map(|(kind, w)| {
            Some(UsageWindow {
                kind: kind.clone(),
                utilization: w["utilization"].as_f64()?,
                resets_at: w["resetsAt"].as_u64(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.kind.cmp(&b.kind));
    out
}

fn camel(snake: &str) -> String {
    let mut out = String::with_capacity(snake.len());
    let mut upper = false;
    for ch in snake.chars() {
        if ch == '_' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

/// Does this hook stdout carry Sway's own marker?
///
/// Parsed rather than substring-matched: a user hook that merely *prints* the
/// marker word (echoing a payload, logging a diff) must not be mistaken for
/// Sway's, and only a real top-level `true` counts.
fn is_sway_hook_output(output: &str) -> bool {
    serde_json::from_str::<Value>(output)
        .ok()
        .and_then(|v| v.get(super::approval::SWAY_HOOK_MARKER).and_then(Value::as_bool))
        .unwrap_or(false)
}

fn mcp_servers(raw: &Value) -> Vec<McpServer> {
    raw.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    Some(McpServer {
                        name: s["name"].as_str()?.to_string(),
                        status: s["status"].as_str().unwrap_or("unknown").to_string(),
                        tool_count: s["toolCount"].as_u64().map(|n| n as u32),
                        error: s["error"].as_str().map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn usage_from(raw: &Value) -> Usage {
    Usage {
        input_tokens: raw["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: raw["output_tokens"].as_u64().unwrap_or(0),
        cache_read_tokens: raw["cache_read_input_tokens"].as_u64().unwrap_or(0),
        cache_write_tokens: raw["cache_creation_input_tokens"].as_u64().unwrap_or(0),
        thinking_tokens: raw["output_tokens_details"]["thinking_tokens"].as_u64().unwrap_or(0),
    }
}

/// One `AskUserQuestion` input, as a form Sway can render.
///
/// **All or nothing.** A question the parser cannot read drops the whole form
/// back to a permission prompt rather than rendering the rest, because the
/// answer string names every question it was given: a form silently short one
/// row would send the agent an answer to a question the user never saw.
///
/// `header` and `description` degrade to empty where the wire omits them, since
/// neither reaches the agent. `question` and `label` do not: the answer quotes
/// the question's prose and echoes the chosen option's label back, so a missing
/// one has no honest substitute.
fn parse_questions(input: &Value) -> Option<Vec<ChatQuestion>> {
    let raw = input["questions"].as_array()?;
    if raw.is_empty() {
        return None;
    }
    let questions: Vec<ChatQuestion> = raw
        .iter()
        .filter_map(|q| {
            let offered = q["options"].as_array()?;
            let options: Vec<ChatQuestionOption> = offered
                .iter()
                .filter_map(|o| {
                    Some(ChatQuestionOption {
                        label: o["label"].as_str()?.to_string(),
                        description: o["description"].as_str().unwrap_or_default().to_string(),
                        preview: o["preview"].as_str().map(str::to_string),
                    })
                })
                .collect();
            if options.len() != offered.len() || options.is_empty() {
                return None;
            }
            Some(ChatQuestion {
                question: q["question"].as_str()?.to_string(),
                header: q["header"].as_str().unwrap_or_default().to_string(),
                multi_select: q["multiSelect"].as_bool().unwrap_or(false),
                options,
            })
        })
        .collect();
    (questions.len() == raw.len()).then_some(questions)
}

/// The answer string the model reads, in the CLI's own wording.
///
/// **These literals are measured, not composed**, from 411 real tool results
/// plus live probes against claude 2.1.239, and they are the one place in this
/// repo where a non-ASCII character is load bearing: the two `\u{2014}` below
/// are em dashes, and the corpus has them where a transcription of it had
/// hyphens. Written as escapes so the source file stays ASCII and the byte on
/// the wire does not.
///
/// **Which head is used turns on free text and on nothing else.** Measured
/// decisively: 0 of 17 "The user answered" results had all-label values and 17
/// of 17 carried a value matching no declared label, while 7 multi-pick results
/// used the other head. So several picks in one question stay the first form,
/// joined with `, ` inside a single quoted value; one free-text answer moves the
/// whole call to the second, including its label-only entries.
pub(super) fn answer_message(questions: &[ChatQuestion], answers: &[QuestionAnswer]) -> String {
    let entries: Vec<String> = answers.iter().map(|a| entry(questions, a)).collect();
    let entries = entries.join(", ");
    if answers.iter().any(|a| free_text(a).is_some()) {
        format!(
            "The user answered: {entries}. Read the answers carefully \u{2014} they may request \
             clarification, changes, or that you not proceed \u{2014} and follow what they \
             actually say."
        )
    } else {
        format!("Your questions have been answered: {entries}. You can now continue with these answers in mind.")
    }
}

/// The user's own words, or `None` when they only picked.
///
/// Blank is not free text. A surface that leaves an empty Other field behind
/// would otherwise move the whole call onto the wrong head and tell the agent
/// to read a clarification nobody wrote.
fn free_text(answer: &QuestionAnswer) -> Option<&str> {
    answer.free_text.as_deref().map(str::trim).filter(|t| !t.is_empty())
}

/// One `"<question>"="<value>"` pair, with the chosen option's preview after it.
///
/// Picks and free text are joined into one value rather than kept apart. The
/// measured grammar has no entry carrying both, because the CLI's own client
/// cannot produce one; Sway's can, since a multi-select question offers Other
/// alongside its boxes. Joining is the only shape that fits a grammar of one
/// value per question, and it is the same `, ` a multi-pick already uses.
fn entry(questions: &[ChatQuestion], answer: &QuestionAnswer) -> String {
    let mut parts: Vec<&str> = answer.picks.iter().map(String::as_str).collect();
    parts.extend(free_text(answer));
    let mut out = format!("\"{}\"=\"{}\"", answer.question, parts.join(", "));
    if let Some(preview) = preview_for(questions, answer) {
        out.push_str(&format!(" selected preview:\n{preview}"));
    }
    out
}

/// The preview declared by the option this answer picked, if it declared one.
///
/// First match rather than all of them, and the two cannot differ: the tool
/// offers a preview only on a single-select question, so an answer carrying a
/// preview carries exactly one pick.
fn preview_for<'a>(questions: &'a [ChatQuestion], answer: &QuestionAnswer) -> Option<&'a str> {
    let question = questions.iter().find(|q| q.question == answer.question)?;
    answer.picks.iter().find_map(|pick| {
        question
            .options
            .iter()
            .find(|o| &o.label == pick)
            .and_then(|o| o.preview.as_deref())
    })
}

/// The actions a `can_use_tool` request offered, as the CLI wrote them.
///
/// An entry whose `type` Sway does not know is **skipped**, not guessed at and
/// not fatal: the list is the agent's, it grows on the agent's schedule, and
/// one unknown offer must not cost the user the offers that came with it.
fn suggestions(raw: &Value) -> Vec<PermissionSuggestion> {
    raw.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| match s["type"].as_str()? {
                    "addRules" => Some(PermissionSuggestion::AddRules {
                        rules: s["rules"]
                            .as_array()
                            .map(|r| {
                                r.iter()
                                    .filter_map(|rule| {
                                        Some(SuggestedRule {
                                            tool_name: rule["toolName"].as_str()?.to_string(),
                                            rule_content: rule["ruleContent"].as_str().map(str::to_string),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                        behavior: s["behavior"].as_str().unwrap_or_default().to_string(),
                        destination: s["destination"].as_str().unwrap_or_default().to_string(),
                    }),
                    "addDirectories" => Some(PermissionSuggestion::AddDirectories {
                        directories: s["directories"]
                            .as_array()
                            .map(|d| d.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                            .unwrap_or_default(),
                        destination: s["destination"].as_str().unwrap_or_default().to_string(),
                    }),
                    // The mode is required: a `setMode` with nothing to switch
                    // to would render a button that does nothing.
                    "setMode" => Some(PermissionSuggestion::SetMode {
                        mode: PermissionMode::new(s["mode"].as_str()?),
                        destination: s["destination"].as_str().unwrap_or_default().to_string(),
                    }),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn denials(raw: &Value) -> Vec<PermissionDenial> {
    raw.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|d| {
                    Some(PermissionDenial {
                        tool_use_id: d["tool_use_id"].as_str()?.to_string(),
                        tool_name: d["tool_name"].as_str().unwrap_or_default().to_string(),
                        tool_input: d["tool_input"].clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A tool result's content is a bare string for most tools and a content-block
/// array for some, so both shapes are flattened to text.
fn tool_result_text(raw: &Value) -> Option<String> {
    if let Some(s) = raw.as_str() {
        return Some(s.to_string());
    }
    let parts: Vec<String> = raw
        .as_array()?
        .iter()
        .filter_map(|b| b["text"].as_str().map(str::to_string))
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// Tools whose result names a file they did not write. `Read` reports its
/// target under `file.filePath`, which is indistinguishable from a write's
/// `filePath` once the frame is all that is left, so the exclusion is keyed off
/// the call's name instead of guessing at the result's shape.
/// The `task_type` a subagent announces, and the only one that opens a lane.
/// Measured on claude 2.1.259: a backgrounded `Bash` says `local_bash` on the
/// same channel and carries neither `subagent_type` nor `prompt`.
pub(crate) const SUBAGENT_TASK: &str = "local_agent";

const READ_ONLY_TOOLS: &[&str] = &["Read", "NotebookRead"];

/// Claude's tool names, mapped onto the neutral vocabulary.
///
/// Claude has no `kind` on the wire, so this is where its names become the same
/// words ACP supplies directly, and it is the reason a renderer can stop being
/// keyed on `"Grep"` and `"Glob"` by name.
///
/// Names marked *measured* appear in the committed corpus under
/// `dev/fixtures/claude/`. The rest are the CLI's own siblings of a measured
/// name, mapped because they are the same kind of thing; anything else, MCP
/// tools included, lands on `Other`, which is the generic card every tool
/// renders as today. Being wrong about a kind costs a mismatched card, so the
/// rule here is to map only what is obvious and let the rest fall through.
pub(crate) fn tool_kind(name: &str) -> ToolKind {
    match name {
        // measured
        "Read" => ToolKind::Read,
        "NotebookRead" => ToolKind::Read,
        // measured: Edit, Write
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => ToolKind::Edit,
        // measured: Bash
        "Bash" | "BashOutput" | "KillShell" => ToolKind::Execute,
        // measured: Glob, Grep
        "Glob" | "Grep" => ToolKind::Search,
        // measured: WebFetch
        "WebFetch" | "WebSearch" => ToolKind::Fetch,
        "TodoWrite" => ToolKind::Think,
        "ExitPlanMode" => ToolKind::SwitchMode,
        // `Agent` and `AskUserQuestion` are both measured and both deliberately
        // `Other`: ACP has no kind for delegating to a subagent or for putting a
        // form in front of the user, and inventing the nearest fit would render
        // a subagent as reasoning and a question as a generic tool. Their cards
        // are chosen by other means already.
        _ => ToolKind::Other,
    }
}

/// The paths a tool touched, read off `tool_use_result`.
///
/// This is the field per-turn attribution turns on: with several chats sharing
/// one working tree, a whole-tree snapshot cannot say which session wrote what,
/// and this can.
fn files_touched(raw: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for key in ["filePath", "file_path"] {
        for candidate in [raw[key].as_str(), raw["file"][key].as_str()] {
            let Some(p) = candidate else { continue };
            // Deliberately not `Vec::dedup`, which only collapses *adjacent*
            // duplicates: the same path legitimately arrives from more than one
            // of these keys and they are not guaranteed to land next to each
            // other. A duplicate here would double-count a file in per-turn
            // attribution.
            if !out.iter().any(|existing| existing == p) {
                out.push(p.to_string());
            }
        }
    }
    out
}

/// What a finished Claude tool call did, read off its structured result.
///
/// **Dispatch is on the payload, never on the tool's name.** `Grep` is the
/// reason it has to be: measured, its result shape follows `output_mode`, so
/// one name answers with hits, with paths, or with a count, and a table keyed
/// on the name would render two of the three wrong. Every other shape turns out
/// to be distinguishable by its own keys as well, so the name is never
/// consulted and an MCP tool or a CLI sibling this build has never heard of
/// gets summarised on its shape or not at all.
///
/// `None` is the answer for everything unrecognised, and the corpus holds four
/// ways to be unrecognised. Three are non-objects: a **bare string**, which is
/// what a failed, denied or unanswered call replies with; an **absent payload**,
/// which is what a call made inside a subagent has; and an **array of content
/// blocks**, which is what every MCP tool replies with (measured: 5247 of them
/// locally, all `[{type: "text", ...}]`, and none of them summarisable). The
/// fourth is an object whose keys none of the arms below claim.
///
/// There is deliberately no text fallback. Phase 1 measured no tool whose
/// success is text-only, so a parser for one would be code that never runs.
/// The diff an edit or a write measured, in the shape the card renders.
///
/// Read off `structuredPatch` rather than diffed from the call's arguments,
/// because only this carries the file's own line numbers and the context around
/// the change. Empty for everything that is not an edit, for a creating `Write`
/// (whose patch is empty and whose content is the whole diff anyway), and for a
/// patch over [`PATCH_LINE_CAP`], where the card falls back to the arguments.
pub(crate) fn structured_patch(raw: &Value) -> Vec<PatchHunk> {
    let Some(hunks) = raw.get("structuredPatch").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut total = 0usize;
    for hunk in hunks {
        let lines: Vec<String> = hunk
            .get("lines")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        total += lines.len();
        if total > PATCH_LINE_CAP {
            return Vec::new();
        }
        let at = |key: &str, fallback: u32| {
            hunk.get(key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(fallback)
        };
        out.push(PatchHunk {
            old_start: at("oldStart", 1),
            old_lines: at("oldLines", 0),
            new_start: at("newStart", 1),
            new_lines: at("newLines", 0),
            lines,
        });
    }
    out
}

pub(crate) fn summarise_result(raw: &Value) -> Option<ToolSummary> {
    let obj = raw.as_object()?;

    // An edit and a write both answer with a patch, and the patch is the only
    // place the counts are. Checked first because `Write` also carries the
    // `content`/`type` pair a read answers with.
    if let Some(patch) = obj.get("structuredPatch").and_then(Value::as_array) {
        // An empty patch is not a no-op. Measured across the local corpus,
        // 1588 of the 1590 empty ones are a `Write` that *created* the file,
        // where the patch has nothing to diff against and the content is the
        // only place the size is reported. The other 2 are a write over a file
        // that was already there and unchanged, where 0/0 really is the answer,
        // so `originalFile` tells the two apart without a guess.
        if patch.is_empty() {
            let original = obj.get("originalFile").and_then(Value::as_str).unwrap_or_default();
            let content = obj.get("content").and_then(Value::as_str).unwrap_or_default();
            return Some(ToolSummary::Edit {
                added: if original.is_empty() { line_count(content) } else { 0 },
                removed: 0,
            });
        }
        let (mut added, mut removed) = (0u64, 0u64);
        for hunk in patch {
            for line in hunk.get("lines").and_then(Value::as_array).into_iter().flatten() {
                match line.as_str().and_then(|l| l.chars().next()) {
                    Some('+') => added += 1,
                    Some('-') => removed += 1,
                    _ => {}
                }
            }
        }
        return Some(ToolSummary::Edit { added, removed });
    }

    // `numFiles` is read as "0 means not reported" in both modes. Measured, a
    // `content` grep whose own output spans two files still reports `numFiles:
    // 0`, and a search that found hits in no files is a contradiction, so the
    // zero is the field being unfilled rather than a count worth showing.
    if let Some(mode) = obj.get("mode").and_then(Value::as_str) {
        let files = num(obj, "numFiles").filter(|n| *n > 0);
        return match mode {
            "content" => Some(ToolSummary::Search { hits: num(obj, "numLines")?, files }),
            "count" => Some(ToolSummary::Search { hits: num(obj, "numMatches")?, files }),
            // The total rather than the returned list, so a truncated answer
            // still says how much it matched.
            "files_with_matches" => Some(ToolSummary::Paths {
                count: num(obj, "totalFiles").or(files)?,
            }),
            _ => None,
        };
    }

    if let Some(stdout) = obj.get("stdout").and_then(Value::as_str) {
        let stderr = obj.get("stderr").and_then(Value::as_str).unwrap_or_default();
        return Some(ToolSummary::Execute {
            // Permanently `None` over this transport; see the variant's docs.
            exit_code: None,
            lines: line_count(stdout) + line_count(stderr),
        });
    }

    if let Some(file) = obj.get("file").and_then(Value::as_object) {
        return Some(ToolSummary::Read {
            lines: num(file, "numLines")?,
            from: num(file, "startLine").unwrap_or(1),
            total: num(file, "totalLines"),
        });
    }

    // A glob. Same total-not-list reading as `files_with_matches` above.
    if obj.contains_key("filenames") {
        return Some(ToolSummary::Paths {
            count: num(obj, "totalMatches").or_else(|| num(obj, "numFiles"))?,
        });
    }

    if let Some(url) = obj.get("url").and_then(Value::as_str) {
        return Some(ToolSummary::Fetch {
            host: host_of(url)?,
            status: num(obj, "code").and_then(|c| u16::try_from(c).ok()),
            bytes: num(obj, "bytes"),
        });
    }

    None
}

fn num(obj: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    obj.get(key).and_then(Value::as_u64)
}

/// Lines of output, where nothing is zero rather than one.
///
/// `"".lines()` already yields nothing, but `str::lines` also drops a single
/// trailing newline, which is what makes a one-line command report one line
/// instead of two.
fn line_count(s: &str) -> u64 {
    s.lines().count() as u64
}

/// The host out of a URL, without a URL parser.
///
/// Sway has no `url` crate and this needs one field of one, so it takes the
/// authority between `://` and the first `/`, `?` or `#` and drops any
/// `user@`. `None` for anything without a scheme, which keeps a summary from
/// claiming a host it guessed at.
fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    (!host.is_empty()).then(|| host.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> Vec<Value> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev/fixtures/claude")
            .join(format!("{name}.jsonl"));
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("fixture line is json"))
            .collect()
    }

    fn run(name: &str) -> Vec<ChatEvent> {
        let mut m = ClaudeMapper::new("s1");
        fixture(name).iter().flat_map(|f| m.map(f)).collect()
    }

    fn count(events: &[ChatEvent], pred: impl Fn(&ChatEvent) -> bool) -> usize {
        events.iter().filter(|e| pred(e)).count()
    }

    /// `task_started` alone joins the `task_id` a permission prompt names to
    /// the `Agent` call its nested frames point at. Losing it costs both.
    #[test]
    fn a_subagent_reports_its_start_and_its_ending() {
        let events = run("permission-subagent");

        let started: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::SubagentStarted { agent_id, tool_use_id, agent_type, .. } => {
                    Some((agent_id.as_str(), tool_use_id.as_str(), agent_type.as_str()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            started,
            [("acb01121756a92ca0", "toolu_01Ec9PYYDVBe9S6DjXp4RM1s", "general-purpose")],
            "exactly one subagent started, with both its ids and its type"
        );

        let terminal = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::SubagentUpdate { status: Some(s), .. } => Some(s.as_str()),
                _ => None,
            })
            .last();
        assert_eq!(terminal, Some("completed"), "the subagent's last reported status");
    }

    /// Not everything on the `task_*` channel is a subagent, and the first build
    /// that read it assumed so: a backgrounded `Bash` appeared on the lane strip
    /// offering a transcript that does not exist.
    #[test]
    fn a_backgrounded_shell_is_a_task_and_not_a_lane() {
        let events = run("background-shell");
        let started: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::SubagentStarted { task_type, agent_type, prompt, .. } => {
                    Some((task_type.as_str(), agent_type.as_str(), prompt.as_str()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(started, [("local_bash", "", "")], "the shell task, with neither of a subagent's fields");

        // The load-bearing half: its call is the main conversation's, so nothing
        // nested may be attributed to it.
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::SubagentCall { .. })),
            0,
            "a shell task claimed a call"
        );

        // And the subagent fixture still reports itself as one.
        let agent: Vec<_> = run("permission-subagent")
            .iter()
            .filter_map(|e| match e {
                ChatEvent::SubagentStarted { task_type, .. } => Some(task_type.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(agent, ["local_agent"]);
    }

    /// Both halves matter: attributing nothing leaves a subagent's work reading
    /// as the parent's, and over-attributing puts the main agent's own calls
    /// into a lane the user never opened.
    #[test]
    fn only_a_subagents_calls_are_announced_against_a_lane() {
        let events = run("permission-subagent");
        let announced: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::SubagentCall { agent_id, tool_use_id, .. } => {
                    Some((agent_id.as_str(), tool_use_id.as_str()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            announced,
            [("acb01121756a92ca0", "toolu_01V4im1SuXMxH4xRjNuCDorw")],
            "the nested Write, once, against the subagent that ran it"
        );

        // The `Agent` call itself is the *parent's* work: it is what the main
        // agent did, and a lane holding its own launcher would nest forever.
        assert!(
            !announced.iter().any(|(_, id)| *id == "toolu_01Ec9PYYDVBe9S6DjXp4RM1s"),
            "the Agent call belongs to the main agent, not to the lane it opened"
        );
    }

    /// A subagent's `assistant` frame is its only declaration of its own work.
    /// Without it the lane's card is built from the `tool_result` alone, so it
    /// carries no name and no arguments: a row that says nothing about itself.
    #[test]
    fn a_subagents_call_is_named_by_its_own_frame() {
        let events = run("subagent-background");
        let named: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::ToolCallStarted { tool_use_id, name, input, .. } => {
                    Some((name.as_str(), tool_use_id.as_str(), input))
                }
                _ => None,
            })
            .collect();

        let write: Vec<_> = named.iter().filter(|(n, ..)| *n == "Write").collect();
        assert_eq!(write.len(), 1, "the nested call, announced once, got {named:?}");
        assert!(
            write[0].2["file_path"].as_str().is_some_and(|p| p.ends_with("bg-made.txt")),
            "and carrying the arguments the subagent sent, got {}",
            write[0].2
        );

        // The main agent's frames stay dropped. Its `Agent` call is announced
        // twice by the streamed path (block open, then block close with the
        // full input), and a third would be this arm double-counting it.
        assert_eq!(
            named.iter().filter(|(n, ..)| *n == "Agent").count(),
            2,
            "the streamed pair and nothing more, got {named:?}"
        );
    }

    /// The one piece of prose a live lane has. It arrives whole, in a nested
    /// `assistant` frame, because a subagent never streams.
    #[test]
    fn a_subagents_closing_report_lands_in_its_own_lane() {
        let events = run("subagent-background");
        let laned: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TextDelta { text, agent_id: Some(lane), .. } => Some((lane.as_str(), text.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(laned.len(), 1, "one whole frame, not deltas, got {laned:?}");
        assert_eq!(laned[0].0, "ad7048d25dc5e778a");
        assert!(laned[0].1.starts_with("Done. Created"), "got {:?}", laned[0].1);

        let main: String = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TextDelta { text, agent_id: None, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(main.contains("launched"), "the main agent's own text is untouched, got {main:?}");
        assert!(main.contains("The background subagent finished"));
        assert!(!main.contains("Done. Created"), "and the lane's report is not in it");
    }

    /// A lane's tokens are the CLI's figure, not one Sway adds up: the
    /// lifecycle frames already report a running total, and a second
    /// accumulator would give one subagent two numbers that drift apart.
    #[test]
    fn a_lanes_tokens_are_reported_by_the_cli_and_kept_out_of_the_session() {
        let events = run("permission-subagent");

        let lane_total = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::SubagentUpdate { usage: Some(u), .. } => Some(u.total_tokens),
                _ => None,
            })
            .max();
        // 10371 is `task_notification`'s figure; the `Agent` result says 10429
        // for the same work, counted later. The lane quotes the lifecycle
        // channel because that is the one reporting mid-flight too.
        assert_eq!(lane_total, Some(10371), "the lane carries the CLI's own figure");

        // A nested `message_delta` still produces nothing, so the session meter
        // is byte-identical to what it reported before lanes existed.
        let nested = serde_json::json!({
            "type": "stream_event",
            "parent_tool_use_id": "toolu_1",
            "event": { "type": "message_delta", "usage": { "output_tokens": 5, "input_tokens": 2 } },
        });
        let mut m = ClaudeMapper::new("s1");
        assert_eq!(
            count(&m.map(&nested), |e| matches!(e, ChatEvent::Usage { .. })),
            0,
            "a subagent's occupancy is not the session's"
        );
    }

    /// The second half is what the guard is for, and it was unreachable while
    /// the guard read a field this stream never sends.
    #[test]
    fn a_nested_compaction_is_not_reported_as_the_sessions() {
        let base = serde_json::json!({
            "type": "system", "subtype": "compact_boundary",
            "compact_metadata": { "trigger": "auto", "pre_tokens": 500, "post_tokens": 100 },
        });
        let mut m = ClaudeMapper::new("s1");
        assert_eq!(
            count(&m.map(&base), |e| matches!(e, ChatEvent::Compacted { .. })),
            1,
            "the session's own compaction reaches the transcript"
        );

        let mut nested = base.clone();
        nested["parent_tool_use_id"] = serde_json::json!("toolu_1");
        let mut m = ClaudeMapper::new("s1");
        assert_eq!(
            count(&m.map(&nested), |e| matches!(e, ChatEvent::Compacted { .. })),
            0,
            "a subagent's compaction is its own context, not this conversation's"
        );
    }

    /// Two subagents must not collect into one lane.
    #[test]
    fn parallel_subagents_keep_their_calls_apart() {
        let events = run("subagent-parallel");
        let mut lanes: std::collections::BTreeMap<&str, Vec<&str>> = Default::default();
        for ev in &events {
            if let ChatEvent::SubagentCall { agent_id, tool_use_id, .. } = ev {
                lanes.entry(agent_id).or_default().push(tool_use_id);
            }
        }
        assert_eq!(lanes.len(), 2, "one lane per subagent, got {lanes:?}");
        let mut seen: Vec<&str> = lanes.values().flatten().copied().collect();
        let before = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(before, seen.len(), "no call is announced against two lanes");
    }

    /// The failure this prevents is the one `PermissionMode` already had: an
    /// unrecognised value folded into the nearest known one, so a cancelled
    /// subagent reports as finished. Serde is checked too; either could fold.
    #[test]
    fn an_unrecognised_terminal_status_survives_unfolded() {
        for status in ["failed", "cancelled", "a_word_this_build_has_never_seen"] {
            let frame = serde_json::json!({
                "type": "system",
                "subtype": "task_updated",
                "task_id": "acb01121756a92ca0",
                "patch": { "status": status, "end_time": 1_786_659_154_233u64 },
            });
            let mut m = ClaudeMapper::new("s1");
            let events = m.map(&frame);
            let Some(ChatEvent::SubagentUpdate { status: Some(mapped), .. }) = events.first() else {
                panic!("{status}: expected one SubagentUpdate carrying a status, got {events:?}");
            };
            assert_eq!(mapped, status, "the mapper reported the agent's own word");

            let wire = serde_json::to_value(&events[0]).expect("serializes");
            assert_eq!(wire["status"], status, "and serde carried it to the mirror unchanged");
        }
    }

    /// `task_updated` puts the status under `patch`, `task_notification` puts it
    /// at the top level. Reading only one leaves the other silently statusless.
    #[test]
    fn both_spellings_of_a_terminal_status_are_read() {
        let patched = serde_json::json!({
            "type": "system", "subtype": "task_updated",
            "task_id": "a1", "patch": { "status": "completed" },
        });
        let top_level = serde_json::json!({
            "type": "system", "subtype": "task_notification",
            "task_id": "a1", "status": "completed", "summary": "Done.",
        });
        for frame in [patched, top_level] {
            let mut m = ClaudeMapper::new("s1");
            assert!(
                matches!(
                    m.map(&frame).first(),
                    Some(ChatEvent::SubagentUpdate { status: Some(s), .. }) if s == "completed"
                ),
                "status not read from {frame}"
            );
        }
    }

    /// The fixture's second `system/init` is the CLI reporting the subagent
    /// unprompted. It is a real turn and must be mapped as one; it must not be
    /// attributed to a user who sent nothing, which only the transport knows.
    #[test]
    fn a_background_subagents_ending_opens_no_user_turn() {
        let events = run("subagent-background");

        // Twice, not once: both terminal frames report the status and both are
        // carried. They patch one record, so applying both lands in one place.
        let settled = events.iter().filter(|e| {
            matches!(e, ChatEvent::SubagentUpdate { status: Some(s), .. } if s == "completed")
        });
        assert_eq!(settled.count(), 2, "both terminal frames reach the lane");

        // The report *is* a turn and has to be mapped as one, or the paragraph
        // the CLI wrote about the subagent never reaches the transcript.
        let turns = count(&events, |e| matches!(e, ChatEvent::TurnStarted { .. }));
        assert_eq!(turns, 2, "the launching turn, and the one the CLI opened to report");

        // Attribution is not the mapper's to make: both `system/init` frames are
        // byte-identical bar their `uuid`, so it leaves every turn at the
        // default and the transport corrects the ones the user actually sent.
        assert!(
            events
                .iter()
                .all(|e| !matches!(e, ChatEvent::TurnStarted { agent_initiated: true, .. })),
            "the mapper does not guess at an attribution the wire cannot support"
        );
    }

    /// A backgrounded subagent's updates arrive after its parent's `result`, so
    /// anything keyed on an open turn would drop every one of them.
    #[test]
    fn a_background_subagents_updates_survive_the_turn_that_launched_it() {
        let frames = fixture("subagent-background");
        let mut m = ClaudeMapper::new("s1");
        let mut after_result = Vec::new();
        let mut ended = false;
        for frame in &frames {
            let events = m.map(frame);
            if ended {
                after_result.extend(events);
            } else {
                ended = frame["type"].as_str() == Some("result");
            }
        }
        let updates = count(&after_result, |e| matches!(e, ChatEvent::SubagentUpdate { .. }));
        assert!(updates > 0, "the subagent reported after the parent's turn ended");
        assert!(
            after_result.iter().any(|e| matches!(
                e,
                ChatEvent::SubagentUpdate { status: Some(s), .. } if s == "completed"
            )),
            "including the one that settles its lane"
        );
    }

    /// The compaction channel, off the captured run.
    ///
    /// The point of the scenario: a compaction is announced, takes 33 seconds
    /// of complete silence, and then reports itself. Both ends have to reach
    /// the panel or the transcript has nothing to say for half a minute.
    #[test]
    fn a_compaction_reports_both_its_start_and_its_result() {
        let events = run("compaction");
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::CompactionStarted { .. })),
            1,
            "system/status carries `compacting`, and it is the only warning the panel gets"
        );
        let boundary = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::Compacted {
                    trigger,
                    pre_tokens,
                    post_tokens,
                    ..
                } => Some((trigger.clone(), *pre_tokens, *post_tokens)),
                _ => None,
            })
            .expect("the boundary reaches the panel");
        // The figures the notice reads out. They are only here because both
        // spellings are accepted: this frame says `compact_metadata` with
        // `pre_tokens`, and reading only the transcript's camelCase left every
        // live compaction reporting a bare "Compacted." with no trigger and no
        // sizes.
        assert_eq!(boundary, (Some("manual".to_string()), Some(16_572), Some(1_990)));
    }

    /// The transcript on disk spells the same metadata the other way
    /// (`compactMetadata`/`preTokens`), which is what a resumed session
    /// replays. One reader, both spellings, or the same compaction reads two
    /// different ways depending on which surface it came from.
    #[test]
    fn the_boundarys_other_spelling_reads_the_same() {
        let mut m = ClaudeMapper::new("s1");
        let frame: Value = serde_json::from_str(
            r#"{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":16566,"postTokens":2157}}"#,
        )
        .unwrap();
        match m.map(&frame).first() {
            Some(ChatEvent::Compacted {
                trigger,
                pre_tokens,
                post_tokens,
                ..
            }) => assert_eq!(
                (trigger.as_deref(), *pre_tokens, *post_tokens),
                (Some("auto"), Some(16_566), Some(2_157))
            ),
            other => panic!("expected a boundary, got {other:?}"),
        }
    }

    /// A compaction that did not happen writes no boundary, so the closing
    /// status frame's error is the whole of what it has to report. Measured by
    /// asking a conversation too short to compact.
    #[test]
    fn a_refused_compaction_reports_the_agents_reason() {
        let mut m = ClaudeMapper::new("s1");
        let frame: Value = serde_json::from_str(
            r#"{"type":"system","subtype":"status","status":null,"compact_result":"failed","compact_error":"Not enough messages to compact."}"#,
        )
        .unwrap();
        match m.map(&frame).first() {
            Some(ChatEvent::CompactionFailed { error, .. }) => {
                assert_eq!(error, "Not enough messages to compact.")
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    /// `requesting` is on the same channel and is every turn's ordinary state.
    /// Carrying it would put a wire word on screen for something the turn state
    /// already says.
    #[test]
    fn an_ordinary_status_frame_is_not_news() {
        let mut m = ClaudeMapper::new("s1");
        let frame: Value =
            serde_json::from_str(r#"{"type":"system","subtype":"status","status":"requesting"}"#).unwrap();
        assert!(m.map(&frame).is_empty());
    }

    /// What the context meter is fed, measured against the capture rather than
    /// asserted from the docs.
    ///
    /// `permission-grant` is one turn over three API calls, reading 17,440,
    /// 23,532 and 23,766 cached tokens. Every usage event carries one of those,
    /// never their sum: the conversation held about 24k, and the result frame's
    /// 64,738 is what that turn *cost*, not what the window holds. Reading the
    /// latter as the former is how a 1M window comes to report 7.8M.
    #[test]
    fn usage_events_carry_one_response_each_and_never_the_turn_total() {
        let events = run("permission-grant");
        let reads: Vec<u64> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::Usage { usage, .. } => Some(usage.cache_read_tokens),
                _ => None,
            })
            .collect();
        assert_eq!(reads, vec![17_440, 23_532, 23_766]);

        let totals: Vec<u64> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TurnCompleted { usage, .. } => Some(usage.cache_read_tokens),
                _ => None,
            })
            .collect();
        assert_eq!(totals, vec![64_738], "the result frame is the turn added up");
        assert_eq!(
            reads.iter().sum::<u64>(),
            64_738,
            "and it is exactly the sum of the responses, which is why it must not be read as one"
        );
    }

    /// A subagent's response is not the conversation's context. It reports its
    /// own occupancy, in its own window, and a Task finishing last would leave
    /// the meter describing the subagent.
    #[test]
    fn a_subagents_response_reports_no_usage_for_the_session() {
        let mut m = ClaudeMapper::new("s1");
        let frame: Value = serde_json::from_str(
            r#"{"type":"stream_event","parent_tool_use_id":"toolu_1","event":{"type":"message_delta","usage":{"input_tokens":2,"cache_read_input_tokens":999999,"cache_creation_input_tokens":0,"output_tokens":5}}}"#,
        )
        .unwrap();
        assert_eq!(count(&m.map(&frame), |e| matches!(e, ChatEvent::Usage { .. })), 0);
    }

    /// The measurement this whole state machine exists for.
    #[test]
    fn two_turns_produce_one_session_start_and_two_turn_starts() {
        let events = run("two-turns");
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::SessionStarted { .. })),
            1,
            "system/init re-emits per turn; only the first may open the session"
        );
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::TurnStarted { .. })),
            2
        );
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::TurnCompleted { .. })),
            2
        );
    }

    /// Turn ids must actually separate the turns, or grouping in the UI is
    /// meaningless even with the right counts.
    #[test]
    fn each_turn_gets_a_distinct_id() {
        let events = run("two-turns");
        let ids: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TurnStarted { turn_id, .. } => Some(turn_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec!["turn-1", "turn-2"]);

        // Text from the second turn must not be filed under the first.
        let second_turn_text = events.iter().any(|e| {
            matches!(e, ChatEvent::TextDelta { turn_id, .. } if turn_id == "turn-2")
        });
        assert!(second_turn_text, "no text was attributed to the second turn");
    }

    #[test]
    fn a_plain_turn_streams_text_and_completes() {
        let events = run("plain-turn");
        assert_eq!(count(&events, |e| matches!(e, ChatEvent::SessionStarted { .. })), 1);
        assert!(count(&events, |e| matches!(e, ChatEvent::TextDelta { .. })) > 0);
        let completed = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::TurnCompleted { outcome, .. } => Some(*outcome),
                _ => None,
            })
            .expect("a completed turn");
        assert_eq!(completed, TurnOutcome::Completed);
    }

    #[test]
    fn a_bash_call_becomes_a_tool_card_with_parsed_input() {
        let events = run("bash-call");
        let started: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::ToolCallStarted { name, input, tool_use_id, .. } => {
                    Some((name.clone(), input.clone(), tool_use_id.clone()))
                }
                _ => None,
            })
            .collect();
        assert!(!started.is_empty(), "no tool call was mapped");
        assert!(started.iter().any(|(n, ..)| n == "Bash"), "the Bash call is missing");
        // The block-stop re-emission is what carries the assembled arguments.
        let with_input = started.iter().find(|(n, i, _)| n == "Bash" && i["command"].is_string());
        assert!(with_input.is_some(), "the Bash call never got its parsed input");

        let completed = events.iter().any(|e| matches!(e, ChatEvent::ToolCallCompleted { .. }));
        assert!(completed, "the tool result never became a completion");
    }

    /// The tool-card lifecycle has to line up by id or the UI shows a call that
    /// never finishes next to a result belonging to nothing.
    #[test]
    fn tool_completions_match_a_started_call_by_id() {
        for name in ["bash-call", "edit-call"] {
            let events = run(name);
            let started: Vec<String> = events
                .iter()
                .filter_map(|e| match e {
                    ChatEvent::ToolCallStarted { tool_use_id, .. } => Some(tool_use_id.clone()),
                    _ => None,
                })
                .collect();
            for e in &events {
                if let ChatEvent::ToolCallCompleted { tool_use_id, .. } = e {
                    assert!(
                        started.contains(tool_use_id),
                        "{name}: completion for {tool_use_id} with no matching start"
                    );
                }
            }
        }
    }

    /// An edit is what per-turn attribution needs a path from.
    #[test]
    fn an_edit_reports_the_file_it_touched() {
        let events = run("edit-call");
        let files: Vec<&String> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::ToolCallCompleted { files, .. } => files.first(),
                _ => None,
            })
            .collect();
        assert!(!files.is_empty(), "no tool completion reported a touched file");
        assert!(
            files.iter().any(|f| f.contains("probe.txt")),
            "the edited file never appeared in a completion: {files:?}"
        );
    }

    /// The same capture opens `probe.txt` with `Read` before editing it, and a
    /// `Read` result carries `file.filePath` exactly as a write carries
    /// `filePath`. Only the edit may report the path: a file this session merely
    /// opened is not one it wrote, and recording it as such makes the turn claim
    /// a file another session may own.
    #[test]
    fn a_read_reports_no_touched_file_even_though_its_result_names_one() {
        let mut mapper = ClaudeMapper::new("s1");
        let mut names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut per_tool: Vec<(String, Vec<String>)> = Vec::new();
        for frame in fixture("edit-call") {
            for ev in mapper.map(&frame) {
                match ev {
                    ChatEvent::ToolCallStarted { tool_use_id, name, .. } => {
                        names.insert(tool_use_id, name);
                    }
                    ChatEvent::ToolCallCompleted { tool_use_id, files, .. } => {
                        per_tool.push((names.get(&tool_use_id).cloned().unwrap_or_default(), files));
                    }
                    _ => {}
                }
            }
        }
        let read = per_tool.iter().find(|(name, _)| name == "Read").expect("the capture reads first");
        assert!(read.1.is_empty(), "a read is not a write: {:?}", read.1);
        let edit = per_tool.iter().find(|(name, _)| name == "Edit").expect("the capture then edits");
        assert!(edit.1.iter().any(|f| f.contains("probe.txt")), "the edit still reports its file");
    }

    /// The distinction the composer queue depends on: a cancelled turn is not
    /// an error, and flushing on it would send exactly what stop prevented.
    #[test]
    fn an_interrupted_turn_is_cancelled_not_errored() {
        let events = run("interrupt");
        let outcomes: Vec<TurnOutcome> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TurnCompleted { outcome, .. } => Some(*outcome),
                _ => None,
            })
            .collect();
        assert_eq!(
            outcomes,
            vec![TurnOutcome::Cancelled, TurnOutcome::Completed],
            "the interrupted turn must read as cancelled and the next one as a clean completion"
        );
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::SessionStarted { .. })),
            1,
            "an interrupt must not restart the session"
        );
    }

    #[test]
    fn a_hook_denial_is_carried_on_the_completed_turn() {
        let events = run("hook-denied");
        let denials = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::TurnCompleted { permission_denials, .. } if !permission_denials.is_empty() => {
                    Some(permission_denials.clone())
                }
                _ => None,
            })
            .expect("the denial never reached a completed turn");
        assert_eq!(denials[0].tool_name, "Bash");

        // The reason is not on the denial record; it reaches the model as the
        // tool result, so that is where the UI must read it from.
        let errored = events.iter().any(|e| {
            matches!(e, ChatEvent::ToolCallCompleted { status, output, .. }
                if *status == ToolStatus::Error
                    && output.as_deref().is_some_and(|o| o.contains("denied by fixture hook")))
        });
        assert!(errored, "the denial reason never surfaced on the tool card");
    }

    /// Pinned against the real frames captured from claude 2.1.220 with
    /// `--include-hook-events`, including the measured detail that makes the
    /// whole attribution necessary: Sway's all-tools hook and the user's hook
    /// on the same tool both arrive as `PreToolUse:Bash`.
    #[test]
    fn sway_and_user_hooks_on_one_tool_call_are_told_apart_by_the_marker() {
        let mut m = ClaudeMapper::new("s1");
        let started = |id: &str| {
            serde_json::json!({
                "type": "system", "subtype": "hook_started", "hook_id": id,
                "hook_name": "PreToolUse:Bash", "hook_event": "PreToolUse", "session_id": "s1"
            })
        };
        let response = |id: &str, output: &str| {
            serde_json::json!({
                "type": "system", "subtype": "hook_response", "hook_id": id,
                "hook_name": "PreToolUse:Bash", "hook_event": "PreToolUse",
                "output": output, "stdout": "", "stderr": "", "exit_code": 0,
                "outcome": "success", "session_id": "s1"
            })
        };
        let owned = |evs: &[ChatEvent]| match evs {
            [ChatEvent::HookFired { sway_owned, .. }] => *sway_owned,
            _ => panic!("expected exactly one HookFired, got {evs:?}"),
        };

        // Both started frames are indistinguishable, and neither has been
        // attributed yet: an unattributed hook reports as not-ours, so a user
        // hook is never hidden by a guess.
        assert!(!owned(&m.map(&started("sway"))));
        assert!(!owned(&m.map(&started("user"))));

        // The responses settle it. Only Sway's carries the marker.
        let sway_out = super::super::approval::hook_output();
        assert!(owned(&m.map(&response("sway", &sway_out))));
        assert!(!owned(&m.map(&response("user", ""))));

        // And the id is now known, so a later frame for the same hook is ours.
        assert!(owned(&m.map(&started("sway"))));
    }

    /// **The marker really survives the CLI**, checked against the frames the
    /// CLI actually sent rather than against frames this test wrote.
    ///
    /// The test above proves the mapper attributes a marker it is handed. That
    /// is only worth anything if the CLI hands one back, and the two halves can
    /// drift apart in silence: change `hook_output` and the hand-written frames
    /// change with it, while the real `hook_response.output` would not. So this
    /// replays `dev/protocol-probe.mjs`'s committed `hook-matcher` capture,
    /// where the probe's hook printed exactly what the shipped helper prints.
    #[test]
    fn the_committed_capture_shows_the_cli_echoing_the_marker_back_verbatim() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev/fixtures/claude/hook-matcher.jsonl");
        let text = std::fs::read_to_string(&path).expect("the hook-matcher capture is committed");

        let mut m = ClaudeMapper::new("f592ef96-0eb0-4d56-b488-d6d86ab4c8e9");
        let mut attributed = 0;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let frame: Value = serde_json::from_str(line).expect("every captured line is JSON");
            if frame["subtype"] != "hook_response" {
                continue;
            }
            assert_eq!(
                frame["output"].as_str().unwrap_or_default(),
                super::super::approval::hook_output(),
                "the CLI echoed something other than what the helper prints; re-run the probe"
            );
            for ev in m.map(&frame) {
                if let ChatEvent::HookFired { sway_owned, .. } = ev {
                    assert!(sway_owned, "a captured Sway hook row was not attributed to Sway");
                    attributed += 1;
                }
            }
        }
        assert_eq!(attributed, 2, "the capture holds one hook response per write tool");
    }

    #[test]
    fn a_user_hook_that_merely_prints_the_marker_word_is_not_mistaken_for_sways() {
        // A hook echoing a payload or logging a diff can easily contain the
        // marker's text. Only a parsed top-level `true` counts.
        let mut m = ClaudeMapper::new("s1");
        for output in [
            "swayApproval",
            "{\"swayApproval\": false}",
            "{\"nested\": {\"swayApproval\": true}}",
            "not json at all { swayApproval: true",
        ] {
            let evs = m.map(&serde_json::json!({
                "type": "system", "subtype": "hook_response", "hook_id": "u",
                "hook_name": "PreToolUse:Bash", "hook_event": "PreToolUse",
                "output": output, "exit_code": 0, "outcome": "success", "session_id": "s1"
            }));
            assert!(
                matches!(evs.as_slice(), [ChatEvent::HookFired { sway_owned: false, .. }]),
                "output {output:?} must not read as Sway's own hook"
            );
        }
    }

    #[test]
    fn a_user_hook_carries_its_outcome_and_exit_code() {
        let mut m = ClaudeMapper::new("s1");
        let evs = m.map(&serde_json::json!({
            "type": "system", "subtype": "hook_response", "hook_id": "u",
            "hook_name": "SessionStart:startup", "hook_event": "SessionStart",
            "output": "context", "stderr": "a warning", "exit_code": 2,
            "outcome": "blocking_error", "session_id": "s1"
        }));
        match evs.as_slice() {
            [ChatEvent::HookFired { name, event, outcome, exit_code, output, stderr, sway_owned, .. }] => {
                assert_eq!(name, "SessionStart:startup");
                assert_eq!(event, "SessionStart");
                assert_eq!(outcome.as_deref(), Some("blocking_error"));
                assert_eq!(*exit_code, Some(2));
                assert_eq!(output.as_deref(), Some("context"));
                assert_eq!(stderr.as_deref(), Some("a warning"));
                assert!(!sway_owned);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// The captured `unifiedWindows` map is the only place the per-window
    /// levels exist; `rateLimitType` names one window and `utilization` is about
    /// that one alone, so reading either as the whole picture loses a window.
    #[test]
    fn a_captured_unified_windows_frame_maps_to_both_windows() {
        let events = run("read-add-dir");
        let with_windows = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::RateLimit { windows, overage_status, .. } if !windows.is_empty() => {
                    Some((windows.clone(), overage_status.clone()))
                }
                _ => None,
            })
            .expect("the capture carries a frame with unifiedWindows");
        assert_eq!(
            with_windows.0,
            vec![
                UsageWindow { kind: "five_hour".into(), utilization: 0.06, resets_at: Some(1_788_537_600) },
                UsageWindow { kind: "seven_day".into(), utilization: 0.42, resets_at: Some(1_788_742_800) },
            ]
        );
        // `allowed` with overage `rejected` is the common capture: overage is
        // about spending past the ceiling, not about having reached it.
        assert_eq!(with_windows.1.as_deref(), Some("rejected"));
    }

    /// The other captured shape: no `unifiedWindows` at all, a top-level
    /// `utilization` about `rateLimitType`. Defaulting the missing map to a
    /// window would report a level for a window the frame never named.
    #[test]
    fn a_frame_without_unified_windows_carries_its_headline_utilization_only() {
        let events = run("read-call");
        let warning = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::RateLimit { status, utilization, windows, limit_type, .. } if status == "allowed_warning" => {
                    Some((*utilization, windows.len(), limit_type.clone()))
                }
                _ => None,
            })
            .expect("the capture carries an allowed_warning frame");
        assert_eq!(warning, (Some(0.88), 0, Some("seven_day".into())));
    }

    /// Thinking is rendered separately from the answer, and its signature must
    /// never leak into either.
    #[test]
    fn thinking_is_separated_and_its_signature_dropped() {
        let mut m = ClaudeMapper::new("s1");
        m.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": [], "mcp_servers": []
        }));
        m.map(&serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_start", "index": 0, "content_block": { "type": "thinking" } }
        }));
        let thought = m.map(&serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "hmm" } }
        }));
        assert!(matches!(thought.as_slice(), [ChatEvent::ThinkingDelta { text, .. }] if text == "hmm"));

        let sig = m.map(&serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "SECRET" } }
        }));
        assert!(sig.is_empty(), "a thinking signature must never become an event");
    }

    /// Deltas name only their index, so a mapper that ignored which block that
    /// index opened would file thinking as answer text and vice versa.
    #[test]
    fn deltas_route_by_the_block_their_index_opened() {
        let mut m = ClaudeMapper::new("s1");
        m.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": [], "mcp_servers": []
        }));
        // index 0 = thinking, index 1 = text, interleaved on purpose.
        for (index, ty) in [(0u64, "thinking"), (1, "text")] {
            m.map(&serde_json::json!({
                "type": "stream_event",
                "event": { "type": "content_block_start", "index": index, "content_block": { "type": ty } }
            }));
        }
        let a = m.map(&serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "answer" } }
        }));
        let b = m.map(&serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "reasoning" } }
        }));
        assert!(matches!(a.as_slice(), [ChatEvent::TextDelta { text, .. }] if text == "answer"));
        assert!(matches!(b.as_slice(), [ChatEvent::ThinkingDelta { text, .. }] if text == "reasoning"));
    }

    /// Every fixture must map without panicking and without inventing a second
    /// session, which is the cheapest guard against a future CLI change turning
    /// into a crash in the transport thread.
    #[test]
    fn every_fixture_maps_cleanly() {
        for name in [
            "plain-turn",
            "two-turns",
            "bash-call",
            "edit-call",
            "read-call",
            "glob-call",
            "grep-modes",
            "webfetch-call",
            "interrupt",
            "hook-denied",
            "image-turn",
        ] {
            let events = run(name);
            assert!(!events.is_empty(), "{name} produced no events");
            assert_eq!(
                count(&events, |e| matches!(e, ChatEvent::SessionStarted { .. })),
                1,
                "{name} opened more than one session"
            );
            for e in &events {
                assert!(
                    !matches!(e, ChatEvent::SessionError { .. }),
                    "{name} produced a SessionError from a healthy fixture: {e:?}"
                );
            }
        }
    }

    /// The answered handshake is the only liveness signal before the first
    /// turn: `system/init` waits for a message, and a chat nobody has typed in
    /// yet must not read "connecting" about a child that already answered.
    #[test]
    fn the_answered_handshake_reports_ready_once_with_the_catalogues() {
        let control = &fixture("initialize")[0];
        let mut m = ClaudeMapper::new("s1");

        let events = m.map(control);
        let (commands, models) = match events.as_slice() {
            [ChatEvent::SessionReady { slash_commands, models, .. }] => (slash_commands.clone(), models.clone()),
            other => panic!("expected exactly one SessionReady, got {other:?}"),
        };
        // The catalogues ride the ready event so the UI is off its fallbacks
        // before the first message, not just off "connecting".
        assert!(commands.len() > 1, "the command catalogue did not ride SessionReady");
        assert_eq!(models.len(), 5, "the model catalogue did not ride SessionReady");

        // A second ack proves nothing new; after init it would be stale news.
        assert!(m.map(control).is_empty(), "a second control response re-reported ready");
        m.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": [], "mcp_servers": []
        }));
        assert!(m.map(control).is_empty(), "a control response after init re-reported ready");
    }

    /// The account rides the handshake, and rides it onto the first
    /// `system/init` too: a resumed panel that missed the ready event still has
    /// to know which plan and provider it is on, since the context window
    /// depends on the provider and nothing else on the wire reports it.
    #[test]
    fn the_account_rides_both_the_handshake_and_the_session_start() {
        let control = &fixture("initialize")[0];
        let mut m = ClaudeMapper::new("s1");

        let ready = match m.map(control).as_slice() {
            [ChatEvent::SessionReady { account, .. }] => account.clone(),
            other => panic!("expected exactly one SessionReady, got {other:?}"),
        };
        let ready = ready.expect("the handshake carried an account and it did not ride SessionReady");
        // Asserted on the provider rather than on the plan or the organization:
        // those are whoever captured the fixture, while `firstParty` is the
        // value Phase 5's window resolution actually branches on.
        assert_eq!(ready.api_provider, "firstParty");
        assert!(!ready.subscription_type.is_empty(), "the subscription type was dropped");

        let started = m.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": [], "mcp_servers": []
        }));
        match started.first() {
            Some(ChatEvent::SessionStarted { account, .. }) => {
                assert_eq!(account.as_ref(), Some(&ready), "the account did not survive onto SessionStarted");
            }
            other => panic!("expected SessionStarted, got {other:?}"),
        }
    }

    /// The doc comment above `absorb_control_response` claims a plan with no
    /// organization is still a known account. It was not: the branch indexed the
    /// inner `Map`, which panics on a missing key rather than yielding null, so
    /// the one shape it exists to tolerate killed the reader thread. Found by
    /// the catalogue probe, which drives this same response with a fixture
    /// rather than a captured one.
    #[test]
    fn an_account_missing_a_field_is_read_rather_than_panicking() {
        let mut m = ClaudeMapper::new("s1");
        let control = serde_json::json!({
            "type": "control_response",
            "response": { "response": { "account": { "apiProvider": "firstParty" } } },
        });
        match m.map(&control).as_slice() {
            [ChatEvent::SessionReady { account: Some(account), .. }] => {
                assert_eq!(account.api_provider, "firstParty");
                assert!(account.organization.is_empty(), "an absent field reads as absent");
            }
            other => panic!("expected a SessionReady carrying the account, got {other:?}"),
        }
    }

    /// A session that never handshook has no account, and must say so rather
    /// than inventing one made of empty strings: "we never asked" and "a plan
    /// with no name" are different answers, and only one of them renders.
    #[test]
    fn a_session_that_never_handshook_reports_no_account() {
        let mut m = ClaudeMapper::new("s1");
        let started = m.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": [], "mcp_servers": []
        }));
        match started.first() {
            Some(ChatEvent::SessionStarted { account, .. }) => assert_eq!(*account, None),
            other => panic!("expected SessionStarted, got {other:?}"),
        }
    }

    /// The `can_use_tool` frame as claude 2.1.231 actually sends it, captured by
    /// `dev/protocol-probe.mjs`. `agent_id` is present only on a subagent's own
    /// call, which is the whole basis of the routing below.
    fn can_use_tool(agent_id: Option<&str>) -> serde_json::Value {
        let mut request = serde_json::json!({
            "subtype": "can_use_tool",
            "tool_name": "Bash",
            "display_name": "Bash",
            "input": { "command": "touch a.txt", "description": "Create a.txt" },
            "description": "Create a.txt",
            "tool_use_id": "toolu_1",
            "permission_suggestions": [
                {
                    "type": "addRules",
                    "rules": [{ "toolName": "Bash", "ruleContent": "touch a.txt" }],
                    "behavior": "allow",
                    "destination": "localSettings"
                },
                { "type": "addDirectories", "directories": ["/w"], "destination": "session" },
                { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
            ]
        });
        if let Some(id) = agent_id {
            request["agent_id"] = serde_json::json!(id);
        }
        serde_json::json!({ "type": "control_request", "request_id": "req-1", "request": request })
    }

    /// An `AskUserQuestion` frame, shaped like the captured one in
    /// `dev/fixtures/claude/ask-user-question.jsonl` and widened to the corpus
    /// maximum: four questions, four options, one `multiSelect`, one `preview`.
    ///
    /// `requires_user_interaction` is on the real frame and is deliberately
    /// *not* what the mapper branches on. The tool name is, because the flag
    /// appears on nothing else measured and a mapper keyed to it would be
    /// guessing that it means the same thing on a tool that has not been seen.
    fn ask_user_question() -> serde_json::Value {
        serde_json::json!({
            "type": "control_request",
            "request_id": "req-q",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "AskUserQuestion",
                "display_name": "AskUserQuestion",
                "tool_use_id": "toolu_q",
                "requires_user_interaction": true,
                "input": { "questions": [
                    {
                        "question": "Which colour do you want?",
                        "header": "Colour",
                        "multiSelect": false,
                        "options": [
                            { "label": "Red", "description": "Choose red.", "preview": "#ff0000" },
                            { "label": "Blue", "description": "Choose blue." }
                        ]
                    },
                    {
                        "question": "Which should I address?",
                        "header": "Scope",
                        "multiSelect": true,
                        "options": [
                            { "label": "Add check 9 for the title copy", "description": "One." },
                            { "label": "Comment the keyframe coupling", "description": "Two." },
                            { "label": "Neither", "description": "Three." },
                            { "label": "Both plus the tests", "description": "Four." }
                        ]
                    },
                    {
                        "question": "Where should it render?",
                        "header": "Placement",
                        "options": [
                            { "label": "Inline", "description": "In the transcript." },
                            { "label": "Modal", "description": "Over it." }
                        ]
                    },
                    {
                        "question": "Anything else?",
                        "header": "Extra",
                        "multiSelect": false,
                        "options": [
                            { "label": "No", "description": "Carry on." },
                            { "label": "Yes", "description": "Wait." }
                        ]
                    }
                ] }
            }
        })
    }

    /// Claude has no `kind` on the wire, so this map is the whole of it. The
    /// unknown case is the one that matters most: MCP tools arrive as
    /// `mcp__<server>__<tool>` and a build cannot know them, so they have to
    /// land somewhere honest rather than on a guess.
    #[test]
    fn a_tool_name_this_build_does_not_know_lands_on_other() {
        assert_eq!(tool_kind("Bash"), ToolKind::Execute);
        assert_eq!(tool_kind("Grep"), ToolKind::Search);
        assert_eq!(tool_kind("Glob"), ToolKind::Search);
        assert_eq!(tool_kind("WebFetch"), ToolKind::Fetch);
        assert_eq!(tool_kind("Read"), ToolKind::Read);
        assert_eq!(tool_kind("Write"), ToolKind::Edit);

        assert_eq!(tool_kind("mcp__linear__create_issue"), ToolKind::Other);
        assert_eq!(tool_kind("SomeToolFromTheNextRelease"), ToolKind::Other);
        assert_eq!(tool_kind(""), ToolKind::Other);
        // Both measured in the corpus, and both deliberately unmapped: ACP has
        // no kind for delegating to a subagent or for asking the user a
        // question, and the nearest fit would be a wrong card rather than a
        // generic one.
        assert_eq!(tool_kind("Agent"), ToolKind::Other);
        assert_eq!(tool_kind("AskUserQuestion"), ToolKind::Other);
    }

    /// The kind has to ride the *first* emission, not just the one carrying the
    /// assembled arguments, or a card renders generic and then re-renders as
    /// itself the moment the input finishes streaming.
    #[test]
    fn a_calls_kind_is_set_from_the_moment_its_block_opens() {
        let kinds: Vec<ToolKind> = run("grep-modes")
            .iter()
            .filter_map(|e| match e {
                ChatEvent::ToolCallStarted { name, kind, .. } if name == "Grep" => Some(*kind),
                _ => None,
            })
            .collect();
        assert!(!kinds.is_empty(), "the fixture holds no Grep call");
        assert!(
            kinds.iter().all(|k| *k == ToolKind::Search),
            "every emission of a call must agree on its kind: {kinds:?}"
        );
    }

    /// The exception to every other tool: this `can_use_tool` is a question, so
    /// it becomes a form and never a prompt with two buttons.
    #[test]
    fn an_ask_user_question_becomes_a_question_request_and_never_a_permission() {
        let mut m = ClaudeMapper::new("s1");
        let events = m.map(&ask_user_question());
        assert!(
            !events.iter().any(|e| matches!(e, ChatEvent::PermissionRequest { .. })),
            "an allow or deny cannot answer a form: {events:?}"
        );
        match events.as_slice() {
            [ChatEvent::QuestionRequest { session_id, tool_use_id, request_id, agent_id, questions }] => {
                assert_eq!(session_id, "s1");
                assert_eq!(tool_use_id, "toolu_q");
                assert_eq!(request_id, "req-q");
                assert_eq!(*agent_id, None, "the main agent asked, so nothing to attribute");
                assert_eq!(questions.len(), 4);
                assert_eq!(questions[0].question, "Which colour do you want?");
                assert_eq!(questions[0].header, "Colour");
                assert_eq!(questions[0].options[0].preview.as_deref(), Some("#ff0000"));
                assert_eq!(questions[0].options[1].preview, None);
                assert_eq!(questions[0].options[1].description, "Choose blue.");
                assert!(questions[1].multi_select, "the one multi-select survives the crossing");
                assert_eq!(questions[1].options.len(), 4, "four is the measured maximum");
                // Absent rather than false on the wire, and the tool treats that
                // as single-select, so the mapper must too.
                assert!(!questions[2].multi_select);
            }
            other => panic!("expected one QuestionRequest, got {other:?}"),
        }
    }

    /// A subagent's question attaches to the subagent, the same routing a
    /// subagent's permission prompt already gets.
    #[test]
    fn a_subagents_question_carries_the_agent_that_asked_it() {
        let mut m = ClaudeMapper::new("s1");
        let mut frame = ask_user_question();
        frame["request"]["agent_id"] = serde_json::json!("affdd797eddcfa753");
        match m.map(&frame).as_slice() {
            [ChatEvent::QuestionRequest { agent_id, .. }] => {
                assert_eq!(agent_id.as_deref(), Some("affdd797eddcfa753"));
            }
            other => panic!("expected a QuestionRequest, got {other:?}"),
        }
    }

    /// **A form that cannot be fully read degrades to the old card, not to
    /// nothing and not to a partial form.**
    ///
    /// The answer string names every question it was given, so a form silently
    /// one row short would put an answer in front of the agent for a question
    /// the user never saw. A permission prompt at least says honestly that Sway
    /// could not read this and lets the user deny it.
    #[test]
    fn a_question_that_cannot_be_read_falls_back_to_the_permission_prompt() {
        let broken = [
            // No `question` prose, which is what the answer quotes back.
            serde_json::json!({ "questions": [{ "header": "H", "options": [{ "label": "A" }] }] }),
            // An option with no label, which is what a pick reports.
            serde_json::json!({ "questions": [{ "question": "Q", "options": [{ "description": "d" }] }] }),
            // A question with no options at all.
            serde_json::json!({ "questions": [{ "question": "Q", "options": [] }] }),
            // Nothing to ask.
            serde_json::json!({ "questions": [] }),
            // Not the shape at all.
            serde_json::json!({ "prompt": "pick one" }),
        ];
        for input in broken {
            let mut m = ClaudeMapper::new("s1");
            let mut frame = ask_user_question();
            frame["request"]["input"] = input.clone();
            match m.map(&frame).as_slice() {
                [ChatEvent::PermissionRequest { tool_name, .. }] => {
                    assert_eq!(tool_name, "AskUserQuestion");
                }
                other => panic!("expected a fallback PermissionRequest for {input}, got {other:?}"),
            }
        }
    }

    /// A partly-readable form is still a broken form. One unreadable question
    /// out of two drops both, for the same reason as above.
    #[test]
    fn one_unreadable_question_drops_the_whole_form() {
        let mut m = ClaudeMapper::new("s1");
        let mut frame = ask_user_question();
        frame["request"]["input"] = serde_json::json!({ "questions": [
            { "question": "Readable?", "options": [{ "label": "Yes" }] },
            { "header": "no prose here", "options": [{ "label": "Yes" }] },
        ] });
        assert!(
            matches!(m.map(&frame).as_slice(), [ChatEvent::PermissionRequest { .. }]),
            "half a form is not a form"
        );
    }

    /// The kill switch: with it on, the mapper does exactly what it did before
    /// the question card existed.
    #[test]
    fn the_kill_switch_puts_the_question_back_on_the_permission_path() {
        let mut m = ClaudeMapper::new("s1").with_questions_as_permissions(true);
        match m.map(&ask_user_question()).as_slice() {
            [ChatEvent::PermissionRequest { tool_name, tool_use_id, request_id, input, .. }] => {
                assert_eq!(tool_name, "AskUserQuestion");
                assert_eq!(tool_use_id, "toolu_q");
                assert_eq!(request_id, "req-q");
                // The input rides through untouched, which is what lets the old
                // card render the raw JSON it always did.
                assert!(input["questions"].is_array());
            }
            other => panic!("expected the old permission prompt, got {other:?}"),
        }
    }

    // ---- the answer string ----------------------------------------------
    //
    // Byte for byte against the measured corpus. These are the CLI's own words,
    // and a paraphrase reaching the model is a silent behaviour change with
    // nothing to catch it, so the expectations below are written out in full
    // rather than assembled from the same helpers the code uses.

    fn form() -> Vec<ChatQuestion> {
        let mut m = ClaudeMapper::new("s1");
        match m.map(&ask_user_question()).as_slice() {
            [ChatEvent::QuestionRequest { questions, .. }] => questions.clone(),
            other => panic!("expected a QuestionRequest, got {other:?}"),
        }
    }

    fn answered(question: &str, picks: &[&str], free_text: Option<&str>) -> QuestionAnswer {
        QuestionAnswer {
            question: question.to_string(),
            picks: picks.iter().map(|p| p.to_string()).collect(),
            free_text: free_text.map(str::to_string),
        }
    }

    #[test]
    fn every_answer_made_of_labels_uses_the_first_head() {
        let answers = [
            answered("Which should I address?", &["Neither"], None),
            answered("Where should it render?", &["Inline"], None),
        ];
        assert_eq!(
            answer_message(&form(), &answers),
            "Your questions have been answered: \"Which should I address?\"=\"Neither\", \
             \"Where should it render?\"=\"Inline\". You can now continue with these answers in mind."
        );
    }

    /// **A multi-pick stays on the first head**, joined with `, ` inside one
    /// quoted value. Measured: 7 multi-pick results used it, and 0 of 17
    /// second-head results had all-label values.
    #[test]
    fn several_picks_join_inside_one_value_and_do_not_change_the_head() {
        let answers = [answered(
            "Which should I address?",
            &["Add check 9 for the title copy", "Comment the keyframe coupling"],
            None,
        )];
        assert_eq!(
            answer_message(&form(), &answers),
            "Your questions have been answered: \"Which should I address?\"=\"Add check 9 for the \
             title copy, Comment the keyframe coupling\". You can now continue with these answers in mind."
        );
    }

    /// One free-text answer moves the whole call to the second head, including
    /// the label-only entries beside it. The two dashes are U+2014 EM DASH, not
    /// hyphens; a transcription of the corpus had hyphens and would have shipped.
    #[test]
    fn one_free_text_answer_moves_the_whole_call_to_the_second_head() {
        let answers = [
            answered("Where should it render?", &["Inline"], None),
            answered("Anything else?", &[], Some("ask me again after the diff")),
        ];
        let message = answer_message(&form(), &answers);
        assert_eq!(
            message,
            "The user answered: \"Where should it render?\"=\"Inline\", \"Anything else?\"=\"ask me \
             again after the diff\". Read the answers carefully \u{2014} they may request \
             clarification, changes, or that you not proceed \u{2014} and follow what they actually say."
        );
        assert_eq!(message.matches('\u{2014}').count(), 2, "em dashes, not hyphens");
        assert!(!message.contains(" - "), "a hyphen here is the transcription bug this pins");
    }

    /// The picked option's preview rides back with it, after the entry.
    #[test]
    fn a_picked_option_carrying_a_preview_echoes_it_back() {
        let answers = [answered("Which colour do you want?", &["Red"], None)];
        assert_eq!(
            answer_message(&form(), &answers),
            "Your questions have been answered: \"Which colour do you want?\"=\"Red\" selected \
             preview:\n#ff0000. You can now continue with these answers in mind."
        );
        // The option without one adds no suffix, so the marker is not boilerplate.
        let plain = answer_message(&form(), &[answered("Which colour do you want?", &["Blue"], None)]);
        assert!(!plain.contains("selected preview"), "{plain}");
    }

    /// Picks and free text in one answer join into a single value.
    ///
    /// The measured grammar has no entry carrying both, because the CLI's own
    /// client cannot produce one. Sway's can: a multi-select question offers
    /// Other beside its boxes. Pinned so the shape is a decision on the record
    /// rather than whatever the code happened to do.
    #[test]
    fn picks_and_free_text_share_one_value() {
        let answers = [answered(
            "Which should I address?",
            &["Neither"],
            Some("hold until the review lands"),
        )];
        assert_eq!(
            answer_message(&form(), &answers),
            "The user answered: \"Which should I address?\"=\"Neither, hold until the review lands\". \
             Read the answers carefully \u{2014} they may request clarification, changes, or that you \
             not proceed \u{2014} and follow what they actually say."
        );
    }

    /// A blank Other box is not an answer.
    ///
    /// Without this a surface that leaves an empty field behind would move the
    /// call onto the second head and tell the agent to read a clarification
    /// nobody wrote.
    #[test]
    fn a_blank_free_text_box_is_not_free_text() {
        for blank in ["", "   ", "\n"] {
            let answers = [answered("Where should it render?", &["Inline"], Some(blank))];
            let message = answer_message(&form(), &answers);
            assert!(
                message.starts_with("Your questions have been answered: "),
                "blank {blank:?} must not change the head: {message}"
            );
            assert!(message.contains("\"Where should it render?\"=\"Inline\""), "{message}");
        }
    }

    #[test]
    fn a_can_use_tool_request_becomes_a_permission_request() {
        let mut m = ClaudeMapper::new("s1");
        match m.map(&can_use_tool(None)).first() {
            Some(ChatEvent::PermissionRequest {
                session_id, tool_use_id, tool_name, request_id, agent_id, input, ..
            }) => {
                assert_eq!(session_id, "s1");
                assert_eq!(tool_use_id, "toolu_1");
                assert_eq!(tool_name, "Bash");
                assert_eq!(request_id, "req-1");
                assert_eq!(input["command"], "touch a.txt");
                assert_eq!(*agent_id, None, "the main agent names no subagent");
            }
            other => panic!("expected PermissionRequest, got {other:?}"),
        }
    }

    /// The routing half: a subagent's question must be attributable to the
    /// subagent that asked it, not silently shown as the parent's own call.
    #[test]
    fn a_subagent_request_carries_the_agent_that_made_it() {
        let mut m = ClaudeMapper::new("s1");
        match m.map(&can_use_tool(Some("affdd797eddcfa753"))).first() {
            Some(ChatEvent::PermissionRequest { agent_id, session_id, .. }) => {
                assert_eq!(agent_id.as_deref(), Some("affdd797eddcfa753"));
                // Still the one session: a subagent is work inside this chat,
                // not a second transcript.
                assert_eq!(session_id, "s1");
            }
            other => panic!("expected PermissionRequest, got {other:?}"),
        }
    }

    #[test]
    fn the_agents_own_suggestions_are_carried_through() {
        let mut m = ClaudeMapper::new("s1");
        let events = m.map(&can_use_tool(None));
        let Some(ChatEvent::PermissionRequest { suggestions, .. }) = events.first() else {
            panic!("expected PermissionRequest");
        };
        assert_eq!(suggestions.len(), 3);
        assert!(matches!(
            &suggestions[0],
            PermissionSuggestion::AddRules { rules, behavior, destination }
                if behavior == "allow"
                    && destination == "localSettings"
                    && rules[0].tool_name == "Bash"
                    && rules[0].rule_content.as_deref() == Some("touch a.txt")
        ));
        assert!(matches!(&suggestions[2], PermissionSuggestion::SetMode { mode, .. } if mode.as_str() == "acceptEdits"));
    }

    /// A suggestion type Sway does not know must cost only itself. Failing the
    /// whole request would take the offers that *are* understood down with it.
    #[test]
    fn an_unknown_suggestion_is_dropped_without_losing_the_others() {
        let mut frame = can_use_tool(None);
        frame["request"]["permission_suggestions"] = serde_json::json!([
            { "type": "somethingNewIn2027", "whatever": true },
            { "type": "setMode", "mode": "plan", "destination": "session" }
        ]);
        let mut m = ClaudeMapper::new("s1");
        let events = m.map(&frame);
        let Some(ChatEvent::PermissionRequest { suggestions, .. }) = events.first() else {
            panic!("expected PermissionRequest");
        };
        assert_eq!(suggestions.len(), 1, "the unknown offer is skipped, the known one survives");
        assert!(matches!(&suggestions[0], PermissionSuggestion::SetMode { mode, .. } if mode.as_str() == "plan"));
    }

    /// A control request Sway does not understand must not become a prompt: it
    /// would be a question nobody can answer, blocking the child forever.
    #[test]
    fn an_unrecognised_control_request_maps_to_nothing() {
        let mut m = ClaudeMapper::new("s1");
        let frame = serde_json::json!({
            "type": "control_request",
            "request_id": "req-9",
            "request": { "subtype": "some_future_request" }
        });
        assert!(m.map(&frame).is_empty());
    }

    /// Without either id the answer cannot be correlated or attached, so the
    /// frame is dropped rather than half-rendered as an unanswerable prompt.
    #[test]
    fn a_request_missing_its_ids_is_dropped() {
        let mut m = ClaudeMapper::new("s1");

        let mut no_request_id = can_use_tool(None);
        no_request_id["request_id"] = serde_json::Value::Null;
        assert!(m.map(&no_request_id).is_empty());

        let mut no_tool_use_id = can_use_tool(None);
        no_tool_use_id["request"]["tool_use_id"] = serde_json::Value::Null;
        assert!(m.map(&no_tool_use_id).is_empty());
    }

    /// A session that opened without ever handshaking (a resumed child whose
    /// first frame is `system/init`) must not get a late `SessionReady` when
    /// some other control request is acknowledged mid-conversation.
    #[test]
    fn a_control_response_after_init_alone_does_not_report_ready() {
        let control = &fixture("initialize")[0];
        let mut m = ClaudeMapper::new("s1");
        m.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": [], "mcp_servers": []
        }));
        assert!(m.map(control).is_empty());
    }

    /// The rich catalogue exists only in the control response; `system/init`
    /// has bare names. A session that never handshakes must still get a menu.
    #[test]
    fn the_command_catalogue_comes_from_the_control_response() {
        let control = &fixture("initialize")[0];

        let mut with = ClaudeMapper::new("s1");
        with.map(control);
        let events = with.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": ["review"], "mcp_servers": []
        }));
        let described = match &events[0] {
            ChatEvent::SessionStarted { slash_commands, .. } => slash_commands.clone(),
            other => panic!("expected SessionStarted, got {other:?}"),
        };
        assert!(described.len() > 1, "the catalogue was not absorbed");
        assert!(
            described.iter().any(|c| !c.description.is_empty()),
            "the catalogue carried no descriptions"
        );
        // The menu shows the hint beside the name, so it has to survive the
        // absorb. Measured: `argumentHint` is present but empty on most
        // commands, so this asserts at least one real one rather than all.
        assert!(
            described.iter().any(|c| c.argument_hint.as_deref().is_some_and(|h| !h.is_empty())),
            "the catalogue carried no argument hints"
        );

        let mut without = ClaudeMapper::new("s1");
        let events = without.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": ["review"], "mcp_servers": []
        }));
        let fallback = match &events[0] {
            ChatEvent::SessionStarted { slash_commands, .. } => slash_commands.clone(),
            other => panic!("expected SessionStarted, got {other:?}"),
        };
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].name, "review");
    }

    fn an_init(model: &str) -> Value {
        serde_json::json!({
            "type": "system", "subtype": "init", "model": model,
            "permissionMode": "default", "cwd": "/w", "tools": [],
            "slash_commands": [], "mcp_servers": []
        })
    }

    fn options_of(events: &[ChatEvent]) -> Option<Vec<ChatConfigOption>> {
        events.iter().find_map(|e| match e {
            ChatEvent::ConfigOptions { options, .. } => Some(options.clone()),
            _ => None,
        })
    }

    /// Claude publishes no options of its own, so the levers it does have are
    /// assembled per model, **from that model's own catalogue row**. The set
    /// follows what the **session** says it is running, which is how a `/model`
    /// slash command refreshes it: Sway is not on that path, and `system/init`
    /// reports the switch either way.
    ///
    /// The ids here are the fixture's, not invented: `initialize.jsonl`
    /// publishes `supportsFastMode` on both Opus 5 rows (resolving to
    /// `claude-opus-5[1m]`) and on none of Fable, Sonnet or Haiku.
    #[test]
    fn the_option_set_follows_the_model_the_session_reports() {
        let mut m = ClaudeMapper::new("s1");
        m.map(&fixture("initialize")[0]);

        let ids = |events: &[ChatEvent]| {
            options_of(events).map(|o| o.iter().map(|x| x.id.clone()).collect::<Vec<_>>())
        };

        // Sonnet has no fast mode, and adaptive thinking is not a lever, so it
        // opens with an empty set. Empty rather than absent: the event still
        // fires, which is what clears a previous model's levers.
        let opened = m.map(&an_init("claude-sonnet-5"));
        assert_eq!(ids(&opened), Some(Vec::new()));

        // The same turn's model reported again moves nothing.
        assert_eq!(options_of(&m.map(&an_init("claude-sonnet-5"))), None);

        let switched = m.map(&an_init("claude-opus-5[1m]"));
        assert_eq!(ids(&switched), Some(vec!["fast_mode".to_string()]), "the Opus row declares it");
        let fast = options_of(&switched).unwrap().remove(0);
        assert!(fast.disabled, "a lever this transport cannot reach is published refused");
        assert_eq!(fast.note, FAST_MODE_REFUSAL);

        // And back, so a row is not a one-way addition to the set.
        assert_eq!(ids(&m.map(&an_init("claude-sonnet-5"))), Some(Vec::new()));
    }

    /// **The account's own reason beats the transport's, and is quoted.**
    ///
    /// `system/init` carries `fast_mode_disabled_reason`, and it is the only
    /// place anyone is told why *this* account cannot run fast mode. Sway used
    /// to read it into the store and show none of it, so the lever said "no
    /// mid-session switch" to a user whose real problem was usage credits - true
    /// and useless, since one of those is fixable.
    ///
    /// The code is not shown; the CLI's own sentence for it is. A code is not
    /// something to put in front of a user, and the binary carries the wording
    /// without ever sending it.
    #[test]
    fn a_refused_fast_mode_quotes_the_reason_the_session_gave() {
        let with_reason = |reason: &str| {
            let mut m = ClaudeMapper::new("s1");
            m.map(&fixture("initialize")[0]);
            let mut frame = an_init("claude-opus-5[1m]");
            frame["fast_mode_disabled_reason"] = serde_json::json!(reason);
            options_of(&m.map(&frame)).unwrap().remove(0).note
        };

        // The reason this account actually gives, and the one thing about it a
        // user can act on.
        let credits = with_reason("extra_usage_disabled");
        assert!(credits.contains("/usage-credits"), "{credits}");
        // Both facts, because both are true and only the first is actionable.
        assert!(credits.contains(FAST_MODE_REFUSAL), "{credits}");

        assert!(with_reason("preference").contains("disabled by your organization"));

        // A code this build has never heard of degrades to the transport's own
        // reason rather than to a raw enum token on screen.
        assert_eq!(with_reason("some_future_reason"), FAST_MODE_REFUSAL);
        assert!(!with_reason("some_future_reason").contains("some_future_reason"));
    }

    /// A session that says nothing about fast mode is not a session saying it
    /// works. The probe is the same case: it reads `initialize`, which arrives
    /// before any session and carries no reason at all.
    #[test]
    fn no_reason_reported_falls_back_rather_than_promising() {
        let mut m = ClaudeMapper::new("s1");
        m.map(&fixture("initialize")[0]);
        let fast = options_of(&m.map(&an_init("claude-opus-5[1m]"))).unwrap().remove(0);
        assert!(fast.disabled);
        assert_eq!(fast.note, FAST_MODE_REFUSAL);
    }

    /// **The claim the retired annotation table used to make, checked against
    /// the CLI's own answer.**
    ///
    /// Every row `initialize.jsonl` publishes, through `config_options` with no
    /// table of any kind behind it. Two Opus rows carry a fast mode and the
    /// other three do not, which is the CLI's own per-model answer: the table
    /// said the same thing keyed on `claude-opus-5`, which is a spelling neither
    /// Opus row resolves to, so it decorated nothing.
    #[test]
    fn fast_mode_comes_off_each_models_own_row() {
        let mut m = ClaudeMapper::new("s1");
        m.map(&fixture("initialize")[0]);
        let with_lever: Vec<&str> = m
            .model_catalogue
            .iter()
            .filter(|row| config_options(row, None).iter().any(|o| o.id == "fast_mode"))
            .map(|row| row.value.as_str())
            .collect();
        assert_eq!(with_lever, ["default", "opus[1m]"], "{:?}", m.model_catalogue);

        // And the whole catalogue really is five rows, so the two above are a
        // selection rather than everything the fixture had.
        assert_eq!(m.model_catalogue.len(), 5);
        // Nothing is invented for a row that declares none.
        let haiku = m.model_catalogue.iter().find(|r| r.value == "haiku").expect("haiku is listed");
        assert!(config_options(haiku, None).is_empty());
    }

    /// **Adaptive thinking is measured and deliberately has no control.**
    ///
    /// It had one for a release: a select published refused, carrying
    /// `--thinking` as its own value because nothing reports which mode is
    /// running. On screen that was a second pill labelled "Thinking" next to the
    /// effort picker, reading `Thinking: --thinking`, which could never move.
    ///
    /// So `config_options` offers nothing for it, and the capability flag is
    /// still read off the handshake (it is what the model row carries) so the
    /// day a mid-session verb appears there is something to hang it on. This
    /// pins the absence, because "no control" and "we forgot" look identical.
    #[test]
    fn adaptive_thinking_is_measured_and_offers_no_lever() {
        let mut m = ClaudeMapper::new("s1");
        m.map(&fixture("initialize")[0]);
        let row = |value: &str| {
            m.model_catalogue.iter().find(|r| r.value == value).unwrap_or_else(|| panic!("{value} is listed"))
        };

        // Sonnet declares the capability and still gets no lever, which is the
        // whole claim: the flag is read, the control is not drawn.
        assert!(row("sonnet").supports_adaptive_thinking);
        assert!(config_options(row("sonnet"), None).is_empty());

        // The values the CLI validated, kept as a measurement so a future
        // launch-flags surface has them without re-probing.
        assert_eq!(THINKING_MODES, ["enabled", "adaptive", "disabled"]);

        // Haiku publishes neither capability, so it gets no levers either, and
        // for a different reason - which is why the assertion above is not
        // enough on its own.
        assert!(!row("haiku").supports_adaptive_thinking);
        assert!(config_options(row("haiku"), None).is_empty());

        // Fable has thinking and no fast mode, so it is the row that would
        // regress silently if thinking ever came back as an option.
        assert!(row("claude-fable-5[1m]").supports_adaptive_thinking);
        assert!(config_options(row("claude-fable-5[1m]"), None).is_empty());
    }

    /// A mapper that never saw a catalogue publishes an empty set rather than
    /// inventing one. Nothing has said this model has either lever, and "not
    /// known to have one" is the same answer as "does not".
    #[test]
    fn a_model_nothing_has_described_gets_no_lever() {
        let mut m = ClaudeMapper::new("s1");
        assert_eq!(options_of(&m.map(&an_init("claude-opus-5[1m]"))), Some(Vec::new()));
    }

    /// **The one spelling that does not line up, pinned rather than papered
    /// over.** The lookup is `resolved_model == the id init reported`, and
    /// measured across every captured fixture init reports `claude-opus-5[1m]`,
    /// which matches. `fast-mode.jsonl` is the exception: it reports the bare
    /// `claude-opus-5`, so no row is found and the session shows no fast-mode
    /// control for a model that has one.
    ///
    /// Not fixed by stripping the suffix. `[1m]` is the vendor's naming
    /// convention, and parsing an id for meaning is the dependency
    /// `contextWindowFor` already refuses to take on for the same suffix. The
    /// honest fix is the session's own `fast_mode_state`, which rides this very
    /// frame; whether a model *without* a fast mode omits that key is unmeasured
    /// (every captured init is an Opus one), so nothing is built on it yet.
    #[test]
    fn a_model_the_catalogue_spells_differently_gets_no_lever() {
        let mut m = ClaudeMapper::new("s1");
        m.map(&fixture("initialize")[0]);
        assert_eq!(
            options_of(&m.map(&an_init("claude-opus-5"))),
            Some(Vec::new()),
            "the catalogue calls this row claude-opus-5[1m], so nothing is found"
        );
    }

    fn a_model(levels: &[&str]) -> ChatModelInfo {
        ChatModelInfo {
            resolved_model: "claude-sonnet-5".into(),
            supports_effort: !levels.is_empty(),
            supported_effort_levels: levels.iter().map(|l| (*l).to_string()).collect(),
            ..Default::default()
        }
    }

    fn ultracode(state: EffortExtraState, measured_on: &str) -> Vec<ChatEffortExtra> {
        vec![ChatEffortExtra {
            id: "ultracode".into(),
            label: "Ultracode".into(),
            state,
            measured_on: measured_on.into(),
            note: "the CLI said no".into(),
        }]
    }

    fn rows(levels: &[ChatEffortLevel]) -> Vec<(&str, bool)> {
        levels.iter().map(|l| (l.level.as_str(), l.disabled)).collect()
    }

    /// A measured extra joins the levels the agent published, and everything the
    /// agent published is takeable.
    #[test]
    fn a_measured_level_joins_the_ones_the_agent_published() {
        let extras = ultracode(EffortExtraState::Working, "2.1.237");
        let levels = effort_levels(&a_model(&["low", "high"]), &extras, "2.1.237");
        assert_eq!(rows(&levels), vec![("low", false), ("high", false), ("ultracode", false)]);
        assert!(levels.iter().all(|l| l.note.is_empty()));
    }

    /// **An extra adds a level, never a control.** A model with no effort of its
    /// own stays without one: the annotation decorates what the agent named and
    /// brings nothing into being.
    #[test]
    fn a_model_with_no_effort_gains_none_from_a_measurement() {
        let levels = effort_levels(&a_model(&[]), &ultracode(EffortExtraState::Working, "2.1.237"), "2.1.237");
        assert!(levels.is_empty(), "{levels:?}");
    }

    /// The version gate, and the whole reason an unadvertised level is safe to
    /// ship: the measurement names a binary, so on any other one the row says so
    /// rather than quietly carrying a claim nobody re-checked.
    #[test]
    fn a_measurement_does_not_outlive_the_version_it_names() {
        let levels = effort_levels(&a_model(&["low"]), &ultracode(EffortExtraState::Working, "2.1.237"), "2.1.240");
        assert_eq!(rows(&levels), vec![("low", false), ("ultracode", true)]);
        let note = &levels[1].note;
        assert!(note.contains("2.1.237") && note.contains("2.1.240"), "{note}");
    }

    /// Both sides normalized, so a `measured_on` written the way the CLI prints
    /// it compares equal to the bare number `system/init` reports. Without this
    /// every row would read as stale forever.
    #[test]
    fn the_version_comparison_ignores_how_the_cli_dresses_it_up() {
        let extras = ultracode(EffortExtraState::Working, "2.1.237 (Claude Code)");
        let levels = effort_levels(&a_model(&["low"]), &extras, "2.1.237");
        assert_eq!(rows(&levels), vec![("low", false), ("ultracode", false)]);
    }

    /// A binary Sway cannot name is one no measurement can be scoped to, so the
    /// picker offers exactly what the agent published and nothing of Sway's.
    #[test]
    fn an_unnamed_binary_gets_no_measured_levels() {
        let levels = effort_levels(&a_model(&["low"]), &ultracode(EffortExtraState::Working, "2.1.237"), "");
        assert_eq!(rows(&levels), vec![("low", false)]);
    }

    /// A level the CLI refuses renders as a row that says so, in the CLI's own
    /// words, rather than as a level that silently is not there.
    #[test]
    fn a_refused_level_renders_disabled_carrying_its_reason() {
        let levels = effort_levels(&a_model(&["low"]), &ultracode(EffortExtraState::Refused, "2.1.237"), "2.1.237");
        assert_eq!(rows(&levels), vec![("low", false), ("ultracode", true)]);
        assert_eq!(levels[1].note, "the CLI said no");
    }

    /// A refusal heard from one binary says nothing about another, so on a
    /// version mismatch the row stops quoting it and says the measurement is the
    /// thing that no longer applies.
    #[test]
    fn a_refusal_measured_elsewhere_is_not_quoted_as_this_binarys_answer() {
        let levels = effort_levels(&a_model(&["low"]), &ultracode(EffortExtraState::Refused, "2.1.237"), "2.1.240");
        assert_eq!(rows(&levels), vec![("low", false), ("ultracode", true)]);
        assert!(levels[1].note.contains("2.1.240"), "{}", levels[1].note);
        assert!(!levels[1].note.contains("the CLI said no"), "{}", levels[1].note);
    }

    /// An extra that collides with a level the agent already named is the
    /// agent's, not Sway's: one row, and no second copy the picker's own
    /// selection could not tell apart.
    #[test]
    fn a_measurement_never_duplicates_a_published_level() {
        let extras = vec![ChatEffortExtra {
            id: "high".into(),
            label: "High".into(),
            state: EffortExtraState::Working,
            measured_on: "2.1.237".into(),
            note: String::new(),
        }];
        let levels = effort_levels(&a_model(&["low", "high"]), &extras, "2.1.237");
        assert_eq!(rows(&levels), vec![("low", false), ("high", false)]);
    }

    /// The handshake report carries no measured extra, because no frame has
    /// named the binary yet; the first `system/init` names it and the catalogue
    /// it carries has the level.
    #[test]
    fn a_measured_level_waits_for_the_init_that_names_the_binary() {
        let mut m = ClaudeMapper::new("s1").with_effort_extras(ultracode(EffortExtraState::Working, "2.1.237"));
        let ready = m.map(&fixture("initialize")[0]);
        let sonnet = |events: &[ChatEvent]| -> Vec<ChatEffortLevel> {
            events
                .iter()
                .find_map(|e| match e {
                    ChatEvent::SessionReady { models, .. } | ChatEvent::SessionStarted { models, .. } => Some(
                        models
                            .iter()
                            .find(|m| m.resolved_model == "claude-sonnet-5")
                            .expect("sonnet")
                            .effort_levels
                            .clone(),
                    ),
                    _ => None,
                })
                .expect("a catalogue")
        };
        assert_eq!(rows(&sonnet(&ready)), vec![
            ("low", false),
            ("medium", false),
            ("high", false),
            ("xhigh", false),
            ("max", false)
        ]);

        let mut init = an_init("claude-sonnet-5");
        init["claude_code_version"] = serde_json::json!("2.1.237");
        let started = m.map(&init);
        assert_eq!(sonnet(&started).last().map(|l| l.level.clone()), Some("ultracode".to_string()));
    }

    /// The model catalogue rides the same control response as the commands and
    /// is absent from `system/init`, so the picker's source is the handshake.
    #[test]
    fn the_model_catalogue_comes_from_the_control_response() {
        let control = &fixture("initialize")[0];
        let init = serde_json::json!({
            "type": "system", "subtype": "init", "model": "claude-sonnet-5",
            "permissionMode": "default", "cwd": "/w", "tools": [],
            "slash_commands": [], "mcp_servers": [],
            "fast_mode_state": "off", "fast_mode_disabled_reason": "sdk_opt_in_required"
        });

        let mut with = ClaudeMapper::new("s1");
        with.map(control);
        let (models, state, reason) = match &with.map(&init)[0] {
            ChatEvent::SessionStarted {
                models,
                fast_mode_state,
                fast_mode_disabled_reason,
                ..
            } => (models.clone(), fast_mode_state.clone(), fast_mode_disabled_reason.clone()),
            other => panic!("expected SessionStarted, got {other:?}"),
        };
        assert_eq!(models.len(), 5, "the catalogue was not absorbed");
        // `value` is what `--model` takes, `resolvedModel` is what the next
        // init reports back, and they are measurably not the same string.
        //
        // *Which* model `default` resolves to is account-side and moves without
        // the wire format moving: it was `claude-sonnet-5` when captured against
        // 2.1.220 and is `claude-opus-5[1m]` as of the 2.1.231 re-capture. So the
        // shape is asserted and the identity is only read from the fixture,
        // rather than pinning a name that drifts on Anthropic's schedule.
        let default = models.iter().find(|m| m.value == "default").expect("default present");
        assert_ne!(default.resolved_model, default.value, "a resolved id is not the value you pass");
        assert_eq!(default.display_name, "Default (recommended)");
        // Two distinct values resolving to one id is exactly why agreement
        // cannot be checked by comparing the picked value against init's model.
        assert_eq!(
            models.iter().filter(|m| m.resolved_model == default.resolved_model).count(),
            2
        );
        let sonnet = models.iter().find(|m| m.value == "sonnet").expect("sonnet present");
        assert!(sonnet.supports_effort);
        assert_eq!(sonnet.supported_effort_levels, ["low", "medium", "high", "xhigh", "max"]);
        // Measured: haiku omits both effort keys entirely rather than declaring
        // them empty, which is the hidden-control case the effort task needs.
        let haiku = models.iter().find(|m| m.value == "haiku").expect("haiku present");
        assert!(!haiku.supports_effort);
        assert!(haiku.supported_effort_levels.is_empty());
        // `fast_mode_state` rides `system/init`, not the control response.
        assert_eq!(state.as_deref(), Some("off"));
        assert_eq!(reason.as_deref(), Some("sdk_opt_in_required"));

        // No handshake reports an empty list rather than a fabricated one.
        let mut without = ClaudeMapper::new("s1");
        match &without.map(&init)[0] {
            ChatEvent::SessionStarted { models, .. } => assert!(models.is_empty()),
            other => panic!("expected SessionStarted, got {other:?}"),
        }
    }

    #[test]
    fn permission_mode_round_trips_from_the_wire_spelling() {
        for wire in ["bypassPermissions", "acceptEdits", "plan", "default"] {
            assert_eq!(permission_mode(Some(wire)).as_str(), wire);
        }
        assert_eq!(permission_mode(None).as_str(), "default");
    }

    /// The enum version folded anything it did not recognise into `Default`,
    /// which reported the *strictest* mode for a session that might be running
    /// the most permissive one. A mode this build has not heard of is now
    /// carried through, so the status says what the CLI said.
    #[test]
    fn a_mode_this_build_does_not_know_is_carried_not_downgraded() {
        assert_eq!(permission_mode(Some("dontAsk")).as_str(), "dontAsk");
        assert_eq!(permission_mode(Some("newModeInV3")).as_str(), "newModeInV3");
    }

    // -----------------------------------------------------------------------
    // What `tool_use_result` actually holds, per tool
    // -----------------------------------------------------------------------
    //
    // Phase 3 summarises a finished call from this payload rather than by
    // parsing the prose beside it, so what each tool puts there is a
    // *measurement* the corpus has to keep taking. Captured against claude
    // 2.1.241 by `dev/protocol-probe.mjs`; the surprise was that there is no
    // text-only successful tool in the corpus at all, so the fallback parser
    // the plan reserved for them has nothing to fall back for.
    //
    // Two shapes are not objects, and both matter more than the happy path:
    // a call that failed or was refused answers with a bare **string**, and a
    // tool call made *inside a subagent* carries no `tool_use_result` at all.

    /// What a tool answers with, as measured.
    #[derive(Debug, Clone, Copy)]
    enum ResultShape {
        /// A JSON object. The listed paths are the ones a summary will read,
        /// dotted for nesting, so a CLI that drops one fails here rather than
        /// rendering a blank row months later.
        Structured(&'static [&'static str]),
        /// A bare string where an object sits on the success path. Measured
        /// only on calls that failed, were denied, or were never answered.
        ErrorText,
        /// No `tool_use_result` key on the frame whatsoever.
        Absent,
    }

    /// One row per (fixture, tool, `output_mode`). `mode` is empty for tools
    /// that have none; `Grep` is the one tool whose result shape follows its
    /// mode rather than its name, which is why the key is a triple.
    const RESULT_SHAPES: &[(&str, &str, &str, ResultShape)] = &[
        // Execute. Note what is NOT here: no exit code, on either the result or
        // the frame. `ToolSummary::Execute` can only ever carry `None` for it
        // over this transport, and `interrupted` plus `is_error` are the whole
        // verdict available.
        (
            "bash-call",
            "Bash",
            "",
            ResultShape::Structured(&["stdout", "stderr", "interrupted"]),
        ),
        (
            "permission-coverage",
            "Bash",
            "",
            ResultShape::Structured(&["stdout", "stderr", "interrupted"]),
        ),
        // Read. Its target sits under `file.filePath`, the same spelling a
        // write uses at the top level, which is why `READ_ONLY_TOOLS` keys the
        // exclusion off the call's name and not the result's shape.
        (
            "read-call",
            "Read",
            "",
            ResultShape::Structured(&[
                "file.filePath",
                "file.content",
                "file.numLines",
                "file.startLine",
                "file.totalLines",
            ]),
        ),
        (
            "edit-call",
            "Read",
            "",
            ResultShape::Structured(&[
                "file.filePath",
                "file.content",
                "file.numLines",
                "file.startLine",
                "file.totalLines",
            ]),
        ),
        (
            "hook-matcher",
            "Read",
            "",
            ResultShape::Structured(&[
                "file.filePath",
                "file.content",
                "file.numLines",
                "file.startLine",
                "file.totalLines",
            ]),
        ),
        (
            "permission-coverage",
            "Read",
            "",
            ResultShape::Structured(&[
                "file.filePath",
                "file.content",
                "file.numLines",
                "file.startLine",
                "file.totalLines",
            ]),
        ),
        // Edits and writes both answer with a `structuredPatch`, so an
        // added/removed count is counted off the hunks rather than diffed here.
        (
            "edit-call",
            "Edit",
            "",
            ResultShape::Structured(&["filePath", "structuredPatch"]),
        ),
        (
            "hook-matcher",
            "Edit",
            "",
            ResultShape::Structured(&["filePath", "structuredPatch"]),
        ),
        (
            "hook-matcher",
            "Write",
            "",
            ResultShape::Structured(&["filePath", "structuredPatch"]),
        ),
        (
            "permission-coverage",
            "Write",
            "",
            ResultShape::Structured(&["filePath", "structuredPatch"]),
        ),
        (
            "permission-grant",
            "Write",
            "",
            ResultShape::Structured(&["filePath", "structuredPatch"]),
        ),
        // Paths. `numFiles` is the count the row reports; `truncated` says
        // whether it is the whole answer.
        (
            "glob-call",
            "Glob",
            "",
            ResultShape::Structured(&["filenames", "numFiles", "truncated"]),
        ),
        // Search, three ways. `content` mode leaves `filenames` EMPTY and puts
        // the hits in `content`, `files_with_matches` fills `filenames` and
        // has no hit count at all, and `count` reports `numMatches` and no
        // `numLines`. One tool name, three payloads: the summary variant has
        // to be chosen by the payload, never by the name.
        (
            "grep-modes",
            "Grep",
            "content",
            ResultShape::Structured(&["mode", "numFiles", "numLines", "content"]),
        ),
        (
            "grep-modes",
            "Grep",
            "files_with_matches",
            ResultShape::Structured(&["mode", "filenames", "numFiles"]),
        ),
        (
            "grep-modes",
            "Grep",
            "count",
            ResultShape::Structured(&["mode", "numFiles", "numMatches", "content"]),
        ),
        // Fetch. `result` is the model's answer about the page, not the page,
        // so only `url`, `code` and `bytes` describe the fetch itself.
        (
            "webfetch-call",
            "WebFetch",
            "",
            ResultShape::Structured(&["url", "code", "bytes", "result"]),
        ),
        // A subagent, from outside. The enclosing call answers richly even
        // though the calls it made inside it do not - see the `Absent` row.
        (
            "permission-subagent",
            "Agent",
            "",
            ResultShape::Structured(&["status", "agentType", "totalToolUseCount"]),
        ),
        // The three non-object shapes.
        //
        // A refused, denied or unanswered call answers with a bare string, so
        // a summariser that assumes an object has to return `None` here rather
        // than unwrap. `AskUserQuestion` is the sharp one: Sway answers it *by
        // denying it*, which makes this the shape of the app's own success.
        ("ask-user-question", "AskUserQuestion", "", ResultShape::ErrorText),
        ("hook-denied", "Bash", "", ResultShape::ErrorText),
        ("permission-deadline", "Write", "", ResultShape::ErrorText),
        // A tool called INSIDE a subagent. The frame carries
        // `parent_tool_use_id` and no result payload at all, so a nested call
        // can never be summarised and its row stays bare. Asserted so that a
        // CLI which starts sending one is noticed rather than silently
        // improving nothing.
        ("permission-subagent", "Write", "", ResultShape::Absent),
    ];

    // --- What a summariser reads off those shapes ---
    //
    // The other half of the table above: `RESULT_SHAPES` pins what the CLI
    // sends, this pins what Sway makes of it. Same (fixture, tool, mode) key,
    // so a shape row without a summary row is a payload nobody summarises and
    // the coverage test below says so by name.

    /// The summary each measured payload produces. `None` is a real answer,
    /// not a gap: it is what an unrecognised shape must yield rather than a
    /// wrong number.
    /// A function rather than a `const`, only because `ToolSummary::Fetch`
    /// holds an owned host and a `const` cannot allocate one.
    fn summaries() -> Vec<(&'static str, &'static str, &'static str, Option<ToolSummary>)> {
        vec![
        (
            "bash-call",
            "Bash",
            "",
            Some(ToolSummary::Execute { exit_code: None, lines: 1 }),
        ),
        // Empty output is zero lines, not one. `str::lines` on an empty string
        // yields nothing, which is the behaviour a row wants here.
        (
            "permission-coverage",
            "Bash",
            "",
            Some(ToolSummary::Execute { exit_code: None, lines: 0 }),
        ),
        (
            "read-call",
            "Read",
            "",
            Some(ToolSummary::Read { lines: 13, from: 1, total: Some(13) }),
        ),
        (
            "edit-call",
            "Read",
            "",
            Some(ToolSummary::Read { lines: 4, from: 1, total: Some(4) }),
        ),
        (
            "hook-matcher",
            "Read",
            "",
            Some(ToolSummary::Read { lines: 2, from: 1, total: Some(2) }),
        ),
        (
            "permission-coverage",
            "Read",
            "",
            Some(ToolSummary::Read { lines: 2, from: 1, total: Some(2) }),
        ),
        ("edit-call", "Edit", "", Some(ToolSummary::Edit { added: 1, removed: 1 })),
        ("hook-matcher", "Edit", "", Some(ToolSummary::Edit { added: 1, removed: 1 })),
        // A write to a new path, whose patch is empty and whose size is only in
        // its content. `removed: 0` because there was nothing there.
        ("hook-matcher", "Write", "", Some(ToolSummary::Edit { added: 1, removed: 0 })),
        ("permission-coverage", "Write", "", Some(ToolSummary::Edit { added: 1, removed: 0 })),
        ("permission-grant", "Write", "", Some(ToolSummary::Edit { added: 1, removed: 0 })),
        ("glob-call", "Glob", "", Some(ToolSummary::Paths { count: 3 })),
        // The three greps, and the whole reason dispatch is on the payload.
        // `content` reports no usable file count: its own hits span two files
        // and it still says `numFiles: 0`, so the summary declines to name one.
        (
            "grep-modes",
            "Grep",
            "content",
            Some(ToolSummary::Search { hits: 2, files: None }),
        ),
        (
            "grep-modes",
            "Grep",
            "files_with_matches",
            Some(ToolSummary::Paths { count: 2 }),
        ),
        (
            "grep-modes",
            "Grep",
            "count",
            Some(ToolSummary::Search { hits: 2, files: Some(2) }),
        ),
        (
            "webfetch-call",
            "WebFetch",
            "",
            Some(ToolSummary::Fetch {
                host: "example.com".to_string(),
                status: Some(200),
                bytes: Some(559),
            }),
        ),
        // A subagent's own result is rich and still unsummarisable: none of its
        // keys is a count of anything a row can say.
        ("permission-subagent", "Agent", "", None),
        // The non-object shapes, which are the ones that would panic an
        // unwrapping summariser rather than merely mis-report.
        ("ask-user-question", "AskUserQuestion", "", None),
        ("hook-denied", "Bash", "", None),
        ("permission-deadline", "Write", "", None),
        ("permission-subagent", "Write", "", None),
        ]
    }

    /// Every measured payload summarises to what it was measured to summarise.
    #[test]
    fn every_measured_result_shape_summarises_the_same_way() {
        for (fixture_name, tool, mode, expected) in summaries() {
            let matching: Vec<_> = tool_results(fixture_name)
                .into_iter()
                .filter(|(t, m, _, _)| t == tool && m == mode)
                .collect();
            assert!(
                !matching.is_empty(),
                "{fixture_name}: no {tool} result with mode {mode:?} left to summarise"
            );
            for (_, _, result, _) in matching {
                let got = summarise_result(&result.unwrap_or(Value::Null));
                assert_eq!(
                    got.as_ref(),
                    expected.as_ref(),
                    "{fixture_name}/{tool}/{mode}: summary changed"
                );
            }
        }
    }

    /// Neither table may grow a row the other does not have. Without this, a
    /// new shape could be measured and never summarised, or a summary could
    /// keep asserting against a payload the CLI stopped sending.
    #[test]
    fn the_shape_table_and_the_summary_table_cover_the_same_calls() {
        let shapes: Vec<_> = RESULT_SHAPES.iter().map(|(f, t, m, _)| (*f, *t, *m)).collect();
        let summaries: Vec<_> = summaries().into_iter().map(|(f, t, m, _)| (f, t, m)).collect();
        for key in &shapes {
            assert!(summaries.contains(key), "{key:?} is measured but never summarised");
        }
        for key in &summaries {
            assert!(shapes.contains(key), "{key:?} is summarised but no longer measured");
        }
    }

    /// The four ways a payload can be unsummarisable, as values rather than as
    /// fixtures. Three are measured shapes; the fourth is an object whose keys
    /// no arm claims, which is every MCP tool and every CLI tool this build has
    /// not been taught.
    #[test]
    fn an_unrecognised_payload_summarises_to_nothing_rather_than_a_wrong_number() {
        let unsummarisable = [
            // A failed, denied or unanswered call.
            serde_json::json!("Error: permission denied"),
            // A call made inside a subagent: no payload at all.
            Value::Null,
            // Every MCP tool, measured: 5247 locally, all content blocks.
            serde_json::json!([{ "type": "text", "text": "some output" }]),
            // An object with none of the keys an arm reads.
            serde_json::json!({ "matches": 3, "query": "x", "total_deferred_tools": 40 }),
            // A shape that opens like one it knows and carries none of the
            // numbers, which must not summarise to zeroes.
            serde_json::json!({ "file": { "filePath": "/a" } }),
        ];
        for payload in unsummarisable {
            assert_eq!(
                summarise_result(&payload),
                None,
                "summarised something it does not understand: {payload}"
            );
        }
    }

    /// The diff an edit measured, carried whole rather than recomputed.
    ///
    /// The card can always diff `old_string` against `new_string`, so what this
    /// is for is the half the arguments cannot supply: which lines of the file
    /// the change landed on, and what sits around it.
    #[test]
    fn an_edit_carries_the_lines_its_change_landed_on() {
        let payload = serde_json::json!({
            "filePath": "/a.rs",
            "structuredPatch": [{
                "oldStart": 12, "oldLines": 3, "newStart": 12, "newLines": 4,
                "lines": [" ctx", "-was", "+is", "+and", " ctx"],
            }],
        });
        let patch = structured_patch(&payload);
        assert_eq!(patch.len(), 1);
        assert_eq!(patch[0].old_start, 12);
        assert_eq!(patch[0].new_lines, 4);
        // The markers ride on the lines, which is the shape the renderer reads.
        assert_eq!(patch[0].lines[1], "-was");
    }

    #[test]
    fn a_call_that_wrote_nothing_carries_no_patch() {
        for payload in [
            serde_json::json!({ "stdout": "hi", "stderr": "" }),
            serde_json::json!("Error: permission denied"),
            Value::Null,
            // A creating `Write`: the patch really is empty, and the content is
            // the whole diff, which the card reads from the arguments instead.
            serde_json::json!({ "filePath": "/a.rs", "structuredPatch": [], "originalFile": "" }),
        ] {
            assert!(structured_patch(&payload).is_empty(), "carried a patch for {payload}");
        }
    }

    /// A `Write` over an existing file answers with a whole-file patch, so the
    /// bound is the file rather than the edit. Dropped whole rather than cut,
    /// because half a diff is worse than none: the card falls back to the
    /// arguments and says it has no line numbers.
    #[test]
    fn a_patch_too_big_for_the_wire_is_dropped_rather_than_cut() {
        let lines: Vec<String> = (0..PATCH_LINE_CAP + 1).map(|i| format!("+line {i}")).collect();
        let payload = serde_json::json!({
            "filePath": "/a.rs",
            "structuredPatch": [{ "oldStart": 1, "oldLines": 0, "newStart": 1, "newLines": lines.len(), "lines": lines }],
        });
        assert!(structured_patch(&payload).is_empty());

        let ok: Vec<String> = (0..PATCH_LINE_CAP).map(|i| format!("+line {i}")).collect();
        let payload = serde_json::json!({
            "filePath": "/a.rs",
            "structuredPatch": [{ "oldStart": 1, "oldLines": 0, "newStart": 1, "newLines": ok.len(), "lines": ok }],
        });
        assert_eq!(structured_patch(&payload).len(), 1);
    }

    /// Walk a dotted path into a value, so `file.numLines` reads one level in.
    fn dotted<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
        path.split('.').try_fold(v, |acc, seg| acc.get(seg))
    }

    /// Every `tool_result` in a fixture, paired with the call it answers.
    fn tool_results(name: &str) -> Vec<(String, String, Option<Value>, bool)> {
        let mut calls: HashMap<String, (String, String)> = HashMap::new();
        let mut out = Vec::new();
        for frame in fixture(name) {
            let content = frame["message"]["content"].as_array().cloned().unwrap_or_default();
            match frame["type"].as_str() {
                Some("assistant") => {
                    for c in content.iter().filter(|c| c["type"] == "tool_use") {
                        calls.insert(
                            c["id"].as_str().unwrap_or_default().to_string(),
                            (
                                c["name"].as_str().unwrap_or_default().to_string(),
                                c["input"]["output_mode"].as_str().unwrap_or_default().to_string(),
                            ),
                        );
                    }
                }
                Some("user") => {
                    for c in content.iter().filter(|c| c["type"] == "tool_result") {
                        let id = c["tool_use_id"].as_str().unwrap_or_default();
                        let (tool, mode) = calls.get(id).cloned().unwrap_or_default();
                        // `get` rather than indexing: indexing a missing key
                        // yields `Null`, which is indistinguishable from a
                        // payload that really is null, and the absence is one
                        // of the three shapes this table records.
                        out.push((
                            tool,
                            mode,
                            frame.get("tool_use_result").cloned(),
                            c["is_error"].as_bool().unwrap_or(false),
                        ));
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// The corpus is the contract for the payload as much as for the frame
    /// kinds, and a vocabulary check cannot see inside a frame. Every observed
    /// result must have a row, and every row must be observed - so a new tool
    /// shape cannot arrive unrecorded, and a fixture cannot quietly stop
    /// containing the thing it was captured for.
    #[test]
    fn every_captured_tool_result_matches_its_measured_shape() {
        let mut seen: HashMap<(&str, &str, &str), usize> = HashMap::new();
        for &(fixture_name, tool, mode, _) in RESULT_SHAPES {
            seen.insert((fixture_name, tool, mode), 0);
        }

        // Sorted before dedup, deliberately: `dedup` only collapses *adjacent*
        // duplicates, and one fixture legitimately holds several tools whose
        // rows are not next to each other in the table.
        let mut fixtures: Vec<&str> = RESULT_SHAPES.iter().map(|r| r.0).collect();
        fixtures.sort_unstable();
        fixtures.dedup();
        for fixture_name in fixtures {
            for (tool, mode, result, is_error) in tool_results(fixture_name) {
                let row = RESULT_SHAPES
                    .iter()
                    .find(|(f, t, m, _)| *f == fixture_name && *t == tool && *m == mode);
                let Some((_, row_tool, row_mode, shape)) = row else {
                    panic!(
                        "{fixture_name}: {tool}{} answered with an unrecorded result shape; \
                         add a row to RESULT_SHAPES saying what it carries",
                        if mode.is_empty() { String::new() } else { format!(" ({mode})") }
                    );
                };
                *seen.get_mut(&(fixture_name, row_tool, row_mode)).unwrap() += 1;

                match shape {
                    ResultShape::Structured(paths) => {
                        let obj = result.as_ref().unwrap_or_else(|| {
                            panic!("{fixture_name}: {tool} lost its tool_use_result entirely")
                        });
                        assert!(
                            obj.is_object(),
                            "{fixture_name}: {tool} answered with {obj:?}, not an object"
                        );
                        assert!(!is_error, "{fixture_name}: {tool} was captured as an error");
                        for path in *paths {
                            assert!(
                                dotted(obj, path).is_some_and(|v| !v.is_null()),
                                "{fixture_name}: {tool}'s result no longer carries `{path}`, \
                                 which a tool summary reads"
                            );
                        }
                    }
                    ResultShape::ErrorText => {
                        let v = result.as_ref().unwrap_or_else(|| {
                            panic!("{fixture_name}: {tool} lost its tool_use_result entirely")
                        });
                        assert!(
                            v.is_string(),
                            "{fixture_name}: {tool} now answers with {v:?} rather than a bare \
                             string; a summariser may stop returning None for it"
                        );
                        assert!(
                            is_error,
                            "{fixture_name}: {tool} carries a string result on a call that did \
                             not fail, so the string is no longer the error shape"
                        );
                    }
                    ResultShape::Absent => assert!(
                        result.is_none(),
                        "{fixture_name}: {tool} now carries a tool_use_result ({result:?}); a \
                         nested subagent call can be summarised after all"
                    ),
                }
            }
        }

        let unobserved: Vec<_> = seen.iter().filter(|(_, n)| **n == 0).map(|(k, _)| *k).collect();
        assert!(
            unobserved.is_empty(),
            "these rows describe a call the fixture no longer contains, so they assert nothing: \
             {unobserved:?}"
        );
    }

    /// The four fixtures captured for their payload rather than their frame
    /// kinds. Parsing is asserted by `fixture()` itself, which panics on a bad
    /// line; what this adds is that each one really holds a finished call, so
    /// an empty or turn-less capture cannot pass as a measurement.
    ///
    /// A floor rather than an exact count, deliberately: a recapture in which
    /// the model read one extra file is not the CLI drifting, and pinning the
    /// number here would fail on model discretion - the thing the corpus is
    /// built set-and-grammar-wise to avoid. An *unrecorded* shape is still
    /// caught, by `RESULT_SHAPES` having no row for it.
    #[test]
    fn the_result_shape_fixtures_each_hold_a_completed_tool_call() {
        for (name, least) in [
            ("read-call", 1),
            ("glob-call", 1),
            ("grep-modes", 3),
            ("webfetch-call", 1),
        ] {
            let results = tool_results(name);
            assert!(
                results.len() >= least,
                "{name} holds {} tool results, fewer than the {least} it was captured for",
                results.len()
            );
            let events = run(name);
            assert!(
                events
                    .iter()
                    .any(|e| matches!(e, ChatEvent::ToolCallCompleted { .. })),
                "{name} produced no ToolCallCompleted"
            );
        }
    }
}

