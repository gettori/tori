//! The normalized chat event model: the one vocabulary every chat surface in
//! Sway speaks, and the only thing the frontend ever sees.
//!
//! A transport (today only `claude` stream-json, tomorrow possibly Codex or an
//! ACP agent) maps its own wire format *into* these types, and nothing above
//! the transport layer knows which agent produced an event. That is what lets
//! the chat panel, the tool cards, the diff rendering and the status tier be
//! written once. `neutrality_check.rs` is the compiling proof that the model is
//! actually general enough to absorb a second agent rather than merely being
//! asserted to be.
//!
//! **Agent-specific data goes in `extra`, never in a new field.** Claude
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

/// Agent-specific payload that has no place in the neutral model. See the
/// module docs for why this is a map rather than a growing field list.
pub type Extra = HashMap<String, serde_json::Value>;

fn extra_is_empty(e: &Extra) -> bool {
    e.is_empty()
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/// A permission mode, as the id its own agent names it.
///
/// **A string rather than an enum, and deliberately so.** Sway used to
/// enumerate Claude's four modes as variants, which made the neutral model
/// carry one agent's vocabulary: Gemini's `--approval-mode` speaks
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
/// **A permissive mode now means what it says.** This used to note that Sway's
/// own `PreToolUse` gate ran ahead of every agent mode, so a permissive one
/// was still supervised. Phase 7 deleted that gate: the agent decides, and a
/// mode named after bypassing permissions really does bypass them.
///
/// For an ACP session the mode is not a flag at all. Measured on `opencode acp`
/// and `@agentclientprotocol/codex-acp`, it is a `mode`-category config option
/// switched with `session/set_config_option`, so the ids here are whatever that
/// agent published on its handshake rather than anything an adapter declared.
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

// An effort level is a plain `String`, the way a mode id already is.
//
// It was a five-variant enum until the day its own note named: "the day a third
// agent disagrees again is the day this becomes a string." Two agents disagree
// now. `@agentclientprotocol/codex-acp` 1.2.0 publishes six levels and the sixth
// (`ultra`) was dropped on the floor because the enum could not carry it, and
// `claude` 2.1.237 takes a seventh word (`ultracode`) that its own `--help` does
// not list. A closed type would have had to grow both, which is two agents'
// vocabularies in one shared name for the benefit of neither.
//
// What replaces it is not "no validation". A level is only ever offered because
// a model's catalogue named it or a measured `[[chat.effort_extras]]` row did,
// which is a stronger check than a hardcoded list of five could ever be.

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

/// What a tool call is *doing*, in a vocabulary both transports can fill.
///
/// These are ACP's own `ToolKind` variants rather than a set invented here.
/// Adopting a published, versioned vocabulary means the ACP adapter passes its
/// agent's answer straight through, and the Claude adapter maps onto the same
/// words instead of every renderer keying off Claude's tool names. It is also
/// what lets a card be chosen by what a call *is* rather than by what it is
/// called, which matters most for the agents whose tool names are prose.
///
/// Unlike [`PermissionMode`], an unrecognised kind is **not** carried through
/// verbatim: it folds into `Other`. The difference is what the unknown value
/// would be used for. An unknown permission mode had to be reported as itself,
/// because collapsing it announced the strictest mode for a session running the
/// most permissive one. A kind only picks a card, `Other` is the generic card
/// that every call renders as today, and the agent's own words for the call
/// survive on `name` and `title` either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    /// The escape hatch, and the default. A kind this build has not heard of
    /// lands here rather than failing to parse the whole event.
    #[default]
    #[serde(other)]
    Other,
}

/// A file a tool call reached for, and the line it cared about.
///
/// ACP publishes these so a client can follow along; Claude has no equivalent
/// field and fills it from the call's own arguments. Kept separate from
/// `ToolCallCompleted::files`, which is narrower on purpose: that one is only
/// the paths a call **wrote**, and per-turn attribution depends on it staying
/// that way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLocation {
    pub path: String,
    #[serde(default)]
    pub line: Option<u32>,
}

/// One hunk of a measured diff, in the shape Claude's `structuredPatch` already
/// uses: each entry of `lines` carries its own `+`, `-` or space marker.
///
/// Carried rather than recomputed, because this is the only place the *file's*
/// line numbers exist. An `Edit`'s arguments name a fragment and never say where
/// in the file it sits, and a `Write` over an existing file carries no
/// before-state at all, so a client diffing the arguments can draw the change
/// but cannot number it or show a line of context around it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<String>,
}

/// The most patch lines carried on the wire, summed over one call's hunks.
///
/// Bounded by the *file* rather than by the edit, because a `Write` over an
/// existing file answers with a whole-file patch. Over the cap the patch is
/// dropped rather than cut, and the card falls back to diffing the call's own
/// arguments: unnumbered, but whole and honest about being neither.
pub const PATCH_LINE_CAP: usize = 2000;

/// What a finished tool call actually did, in numbers a collapsed row can say.
///
/// The variant is chosen by the **payload**, never by the tool's name. Claude's
/// `Grep` is the reason: measured, its result shape follows its `output_mode`,
/// so one tool name answers with hits, with paths, or with a count, and a
/// renderer keyed on the name would render the wrong body for two of the three.
/// `Paths` exists for the same reason, since ACP has no kind that distinguishes
/// a path list from a hit list.
///
/// Optional fields are the ones a transport measurably fails to report, never
/// the ones that were merely inconvenient to fill. Each carries the measurement
/// that made it optional.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ToolSummary {
    /// A search that reports what it matched.
    ///
    /// `files` is `Option` on a measurement, not on caution: Grep's `content`
    /// mode reports `numFiles: 0` for a result whose own `content` spans two
    /// files. The count is simply not filled in that mode, and a row reading
    /// "2 hits in 0 files" is worse than one that declines to say.
    Search { hits: u64, files: Option<u64> },
    /// A search or glob that reports only which files matched.
    Paths { count: u64 },
    /// `total` is the file's length, not the end of the returned range: the end
    /// is `from + lines - 1` and needs no field, while the length cannot be
    /// recovered from the other two and is what makes "13 of 400" sayable.
    Read { lines: u64, from: u64, total: Option<u64> },
    /// `exit_code` is `Option` because Claude does not report one at all.
    /// Measured across every `Bash` result in the local transcript corpus
    /// (~20k), the shape carries `interrupted` and no exit status; the optional
    /// `returnCodeInterpretation` that appears on some of them is prose
    /// ("No matches found"), not a code. So `interrupted` plus the call's error
    /// status is the whole verdict available over that transport.
    Execute { exit_code: Option<i32>, lines: u64 },
    Edit { added: u64, removed: u64 },
    /// `host` alone repeats the call's own argument. What a fetch actually
    /// *reports* is the status it came back with and how much it brought, so
    /// both are here, and both are `Option` because ACP publishes neither.
    Fetch { host: String, status: Option<u16>, bytes: Option<u64> },
}

/// How much of a tool's output rides on the event, in bytes.
///
/// Above this the adapter cuts and sets `output_truncated`, and the full text
/// is fetched on demand instead. The number is a chat row's worth of text with
/// room to spare, not a limit anything measured: what it is actually protecting
/// is the event bus and the store, where a single `Bash` that catted a binary
/// would otherwise sit in memory for the life of the session.
pub const TOOL_OUTPUT_CAP: usize = 64 * 1024;

/// The extract of a tool's output that fits [`TOOL_OUTPUT_CAP`], or `None` when
/// the whole thing already does.
///
/// Borrows and returns an `Option` rather than consuming and returning a pair,
/// so the common case allocates nothing and the caller keeps the original to
/// put somewhere: the one place that cuts also has to hold on to what it cut.
///
/// Cuts on a character boundary, since the cap is in bytes and the output is
/// not: slicing mid-codepoint would panic on exactly the outputs most worth
/// capping.
pub fn cap_output(text: &str) -> Option<String> {
    if text.len() <= TOOL_OUTPUT_CAP {
        return None;
    }
    let mut end = TOOL_OUTPUT_CAP;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(text[..end].to_string())
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

/// One rule the agent proposed, in the agent's own grammar.
///
/// `rule_content` is optional because a rule can name a whole tool with no
/// argument pattern (`toolName: "WebFetch"` and nothing else), which is a
/// meaningfully different offer from one scoped to a single command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedRule {
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_content: Option<String>,
}

/// An action the agent itself offered alongside a permission question.
///
/// **These are the CLI's words, not Sway's invention.** Measured on claude
/// 2.1.231, a `can_use_tool` request carries up to three of them: the rule that
/// would allow this call, the directory that would unblock it, and the mode that
/// would stop it asking. Sway renders them and echoes the chosen one back
/// verbatim rather than composing rule text itself, because the rule grammar
/// belongs to the agent - a `Bash` rule is a command *pattern*, and Sway
/// guessing at that is how an "always allow `touch a.txt`" silently becomes
/// "always allow every `touch`".
///
/// An unrecognised suggestion type is dropped at the mapper rather than
/// modelled, so a new one the CLI invents cannot fail the whole request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PermissionSuggestion {
    AddRules {
        rules: Vec<SuggestedRule>,
        /// "allow" or "deny", as the agent spells it.
        behavior: String,
        /// Where the agent would persist it, e.g. `session`, `localSettings`.
        destination: String,
    },
    AddDirectories {
        directories: Vec<String>,
        destination: String,
    },
    SetMode {
        mode: PermissionMode,
        destination: String,
    },
}

/// One question the agent wants answered before it goes on.
///
/// **`question` is the prose, `header` is the two-word chip above it**, and the
/// two are not interchangeable: the answer string the agent reads back quotes
/// the prose, so a surface that echoed the header would send the model text it
/// never wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQuestion {
    pub question: String,
    pub header: String,
    /// Whether several options may be picked at once. Measured 20 of 550
    /// questions, so one answer is the overwhelming case and the multi form is
    /// the exception a surface still has to render.
    #[serde(default)]
    pub multi_select: bool,
    pub options: Vec<ChatQuestionOption>,
}

/// One offered answer.
///
/// A free-text answer is always available too and is never an option here: it
/// is the absence of a pick, which is why [`QuestionAnswer`] carries both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
    /// A worked example of what this option means, shown with the option and
    /// echoed back inside the answer when this is the one chosen. Absent on
    /// most options; measured on 43 of 411 answered calls.
    #[serde(default)]
    pub preview: Option<String>,
}

/// What the user chose for one question.
///
/// `picks` holds option labels, never descriptions and never previews, because
/// the label is the only part of an option the agent can match against what it
/// offered. `free_text` is the user's own words, and the two are not exclusive:
/// a multi-select question can be answered with picks *and* an addition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswer {
    /// The question's own prose, matching [`ChatQuestion::question`]. Carried
    /// rather than an index so a late answer cannot land on a renumbered
    /// question.
    pub question: String,
    #[serde(default)]
    pub picks: Vec<String>,
    #[serde(default)]
    pub free_text: Option<String>,
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

/// One mode the live agent says it can run, as the mode selector needs it.
///
/// The counterpart to [`ChatModelInfo`], and deliberately thinner than the
/// adapter's own `ChatMode`. That one carries `args` (an ACP mode is a request,
/// not a flag), `requires` (a per-model gate Claude's catalogue publishes and no
/// agent advertises), `permissive` and `default`. The last two are the load
/// bearing omission: an agent publishes an id, a label and a description, so a
/// mode's danger and a mode's defaultness are things Sway would have to infer
/// from the words in an id. It does not, and the surface renders such a row
/// without the permissive caution rather than with a guessed one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModeInfo {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub hint: String,
}

/// One configuration lever the agent published, in the shape a generic control
/// can render.
///
/// **The mirror's point is that Sway does not have to recognise an option to
/// show it.** The three categories with bespoke controls (model, mode, thought
/// level) are three entries in the agent's list, not the whole of it, and an
/// agent is free to publish a fourth tomorrow. Everything representable is
/// carried across; which rows already have a control of their own is the
/// surface's decision, made from `category`, not this type's.
///
/// `category` stays the agent's own word rather than an enum, and the
/// uncategorized case is the interesting one: an option with no category is
/// exactly the one no bespoke control claims, so normalising it away would drop
/// the rows this type exists for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConfigOption {
    pub id: String,
    /// The agent's own label, rendered verbatim: for a lever Sway knows nothing
    /// else about, it is the only name the user will ever see.
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// `model`, `mode`, `thought_level`, `model_config`, whatever the agent
    /// wrote, or empty for one it left uncategorized.
    #[serde(default)]
    pub category: String,
    /// A lever this agent has but cannot currently take. Rendered rather than
    /// hidden, because a control that is absent says nothing about why.
    #[serde(default)]
    pub disabled: bool,
    /// Why it is disabled, in the agent's own words. Empty when nothing is
    /// disabled; a disabled row without one is a dead control with no reason.
    #[serde(default)]
    pub note: String,
    #[serde(flatten)]
    pub kind: ChatConfigKind,
}

/// What sort of control an option needs, and the state it is in.
///
/// Flattened onto [`ChatConfigOption`] so the wire shape is one object with a
/// `kind` discriminator, which is what a renderer switches on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatConfigKind {
    Select {
        current: String,
        choices: Vec<ChatConfigChoice>,
    },
    Boolean {
        value: bool,
    },
}

/// One entry of a select-shaped option.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConfigChoice {
    pub value: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
}

/// What a switch carries back to the agent: a select's value id, or a toggle's
/// state.
///
/// Untagged because the two are disjoint JSON types, so a caller sends `"high"`
/// or `true` and nothing has to spell out which it meant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatConfigValue {
    Value(String),
    Flag(bool),
}

impl ChatConfigValue {
    /// How the value reads in a message to the user, and how a readback of the
    /// agent's answer is compared against it.
    pub fn as_text(&self) -> String {
        match self {
            Self::Value(v) => v.clone(),
            Self::Flag(b) => b.to_string(),
        }
    }
}

/// One row of the effort picker: a level, and whether it can be taken.
///
/// `disabled`/`note` rather than a state word, the same pair
/// [`ChatConfigOption`] carries and for the same reason: "a lever the agent has
/// but cannot currently take" is one idea, and giving effort its own vocabulary
/// for it would mean two rules to keep in step.
///
/// A level the agent published is always enabled. The only disabled rows are
/// Sway's own measured extras whose measurement no longer applies, which is a
/// row that says why rather than a level that quietly vanished.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEffortLevel {
    pub level: String,
    /// What the picker row reads, which is the level itself for anything the
    /// agent named: it published a word, not a label, and inventing one would
    /// describe a level by Sway's guess at it.
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub disabled: bool,
    /// Why it cannot be taken, in words the user can act on. Empty when nothing
    /// is refusing it.
    #[serde(default)]
    pub note: String,
}

/// One model the live agent says it can run, as the picker needs it.
///
/// Measured: this catalogue exists **only** in the `initialize` control
/// response, never on `system/init`, which reports a single already-resolved
/// model id. The two fields are not interchangeable and conflating them is the
/// trap this struct exists to make impossible: `value` (`default`, `sonnet`,
/// `opus`) is what `--model` takes and what the picker keeps as the authority
/// for its own selection, while `resolved_model` (`claude-sonnet-5`) is what
/// `system/init.model` reports back. Several distinct `value`s resolve to one
/// `resolved_model`, so init alone can never say which was picked.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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
    /// The same levels as rows a picker can render, plus any level Sway measured
    /// that this agent never advertises. See [`ChatEffortLevel`].
    ///
    /// Additive rather than a replacement, because a catalogue cached before
    /// this field existed still deserializes and still has to work: an empty
    /// list there means "nobody filled this in", and the reader falls back to
    /// `supported_effort_levels` with every row enabled, which is what that
    /// cache actually recorded.
    #[serde(default)]
    pub effort_levels: Vec<ChatEffortLevel>,
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
    /// Whether this model has a fast mode to toggle.
    ///
    /// **The CLI publishes this and Sway used to restate it.** `[[chat.annotations]]`
    /// carried a hand-keyed table saying the same thing, and it was already
    /// wrong: it named `claude-opus-5` while the catalogue resolves both Opus
    /// rows to `claude-opus-5[1m]`, so the lookup never matched. Reading the
    /// handshake is the same correction `[[chat.models]]` already got.
    ///
    /// Measured on 2.1.238: present on `default` and `opus[1m]`, absent on
    /// Fable, Sonnet and Haiku.
    #[serde(default)]
    pub supports_fast_mode: bool,
    /// Whether this model has an adaptive-thinking lever.
    ///
    /// Absent on Haiku alone, which declares none of the model-scoped
    /// capabilities. Carried for the same reason as the flag above: whether a
    /// control has any business existing is the catalogue's answer, and whether
    /// this transport can reach it is a separate question `claude.rs` decides.
    #[serde(default)]
    pub supports_adaptive_thinking: bool,
}

/// What a agent said it can do, read off its own handshake.
///
/// **Advertised, not measured, and the distinction is the point.** Sway's
/// per-transport tier records what *shipped* against a agent somebody sat down
/// and measured; this records what *this* agent, on this machine, at this
/// version, claims about itself. They answer different questions and the tier
/// needs both: one generic transport carries agents that genuinely differ, so a
/// tier that only knew the transport would publish the same capabilities for an
/// agent that resumes conversations and one that cannot.
///
/// `None` on the event for a agent that advertises nothing. That is not a
/// agent with no capabilities: Claude's are measured and pinned rather than
/// asked for, so there is nothing to carry, and a surface reads the absence as
/// "the tier is all there is" rather than as an empty list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCapabilities {
    /// The agent can replay a conversation it still holds (`session/load`).
    pub load_session: bool,
    /// The agent can enumerate its own sessions (`session/list`). An
    /// advertisement, never a promise of rows: `opencode acp` 1.18.3 advertises
    /// it and can answer with nothing.
    pub list_sessions: bool,
}

// Session **fork** is deliberately absent, and the reason is worth keeping.
// Both measured agents advertise `sessionCapabilities.fork` on the wire, but the
// protocol schema this build speaks (v1) models no such field, so reading it
// would mean parsing raw JSON around the crate. That would be worth doing for a
// capability Sway could use - and it cannot: Sway's fork is `fork_args` plus a
// tree snapshot, and the ACP transport implements no fork verb at all. A
// capability published here would be one the UI could only offer and then fail.

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
    /// As the agent words it, e.g. `Claude Pro`, `Claude Max`. Passed through
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

/// Token and cost accounting, flattened out of the agent's own richer shape.
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

/// Not [`Usage`]: a subagent reports a flat total, a tool count and an elapsed
/// time, so folding the two would invent a breakdown the wire never sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentUsage {
    #[serde(default)]
    pub total_tokens: u64,
    #[serde(default)]
    pub tool_uses: u64,
    #[serde(default)]
    pub duration_ms: u64,
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
    /// An image a past turn carried, without the bytes: reading a transcript's
    /// base64 back would hold every screenshot a session sent in memory to
    /// redraw turns already read. Replay only, and nothing composes one.
    ImageRef,
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
        /// `[image 3]`: the token the prose names an attachment by. Rendered
        /// in front of the path on every wire, and read back off the
        /// transcript, so a reopened chat draws the chip the live one did.
        #[serde(default)]
        label: Option<String>,
    },
}

impl ContentBlock {
    /// A replayed user text block, read back as the attachment it was sent as.
    ///
    /// The exact form `turn_frame` and `prompt_blocks` write and nothing
    /// looser, so a sentence that merely says `[image 1]` stays prose. The path
    /// is a transcript's word, not Sway's: an agent writes that file, so it is
    /// required to be absolute and one line, and every surface drawing it still
    /// decides for itself what it will open.
    pub fn from_replayed_text(text: &str) -> ContentBlock {
        text.strip_prefix('[')
            .and_then(|rest| rest.split_once("]: @"))
            .filter(|(token, path)| is_label(token) && path.starts_with('/') && !path.contains('\n'))
            .map(|(token, rendered)| {
                let (path, start_line, end_line) = split_range(rendered);
                ContentBlock::FileRef { path, start_line, end_line, text: None, label: Some(format!("[{token}]")) }
            })
            .unwrap_or_else(|| ContentBlock::Text { text: text.to_string() })
    }
}

/// `image 3`: one of the kinds a composer mints, then a number.
fn is_label(token: &str) -> bool {
    let Some((kind, n)) = token.split_once(' ') else { return false };
    matches!(kind, "image" | "pdf" | "file") && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())
}

/// The `#L2-4` tail a ranged reference is rendered with, taken back off the
/// path. No label carries a range today, and reading one back rather than
/// leaving `#L2-4` buried in a path is what keeps that true by accident rather
/// than by luck. A file actually named that way is the wire form's cost, and
/// the rendering paid it first.
fn split_range(rendered: &str) -> (String, Option<u32>, Option<u32>) {
    let whole = || (rendered.to_string(), None, None);
    let Some((path, range)) = rendered.rsplit_once("#L") else { return whole() };
    if path.is_empty() {
        return whole();
    }
    match range.split_once('-') {
        Some((from, to)) => match (from.parse().ok(), to.parse().ok()) {
            (Some(from), Some(to)) => (path.to_string(), Some(from), Some(to)),
            _ => whole(),
        },
        None => match range.parse().ok() {
            Some(from) => (path.to_string(), Some(from), None),
            None => whole(),
        },
    }
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
        /// The live mode catalogue, on the same rule as `models`: empty means
        /// "fall back to the adapter's `[[chat.modes]]`", which is how a
        /// Claude-shaped adapter keeps its declared modes and an ACP one - whose
        /// table is empty on purpose - gets the agent's own.
        #[serde(default)]
        modes: Vec<ChatModeInfo>,
        /// `system/init`'s fast-mode state and, when it is unavailable, the
        /// agent's own reason. Typed rather than left in `extra` because the
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
        /// And the mode catalogue, carried here for the same reason: an ACP
        /// session's modes arrive with `session/new`, a whole turn before any
        /// `SessionStarted` would carry them.
        #[serde(default)]
        modes: Vec<ChatModeInfo>,
        /// The account the same response named. Carried here as well as on
        /// `SessionStarted` because this event can arrive a whole turn earlier
        /// and is the point of it: the handshake is the only source, so waiting
        /// for the first `system/init` would hold back data already in hand.
        #[serde(default)]
        account: Option<ChatAccount>,
        /// What this agent advertised about itself, for a agent that
        /// advertises. `None` for one whose capabilities are measured and
        /// pinned instead; see [`ChatCapabilities`].
        #[serde(default)]
        capabilities: Option<ChatCapabilities>,
    },

    /// The agent's configuration levers, as they now stand.
    ///
    /// Emitted when the session opens and again whenever the agent reports a
    /// change, its own `session/update` and the answer to a switch Sway sent
    /// alike. **The whole set every time, never a delta**: the agent replies
    /// with its full list, one option can re-cut another's choices (picking a
    /// model changes which thinking levels exist), and a mirror rebuilt from the
    /// whole answer cannot drift from it.
    ///
    /// Its own variant rather than a field on `SessionStarted`, because the
    /// interesting half is the *re-render*: `SessionStarted` fires once and the
    /// options move for the rest of the session.
    ConfigOptions {
        session_id: String,
        options: Vec<ChatConfigOption>,
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
        /// As the agent names it, e.g. `PreToolUse:Bash`. **Reports the tool,
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
        /// Opened by the agent, not by anything the user sent: a backgrounded
        /// subagent finishing makes the CLI open one to report itself. Only the
        /// transport can tell, and a ceiling declines turns it never saw open.
        #[serde(default)]
        agent_initiated: bool,
        model: String,
        permission_mode: PermissionMode,
        #[serde(default, skip_serializing_if = "extra_is_empty")]
        extra: Extra,
    },

    /// The agent refused a mode switch outright, in its own words. Distinct
    /// from a switch that merely did not take: this is answered on the control
    /// channel, so the control can stop offering a row that can never land.
    ModeRefused {
        session_id: String,
        mode: PermissionMode,
        reason: String,
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

    /// The commands this session takes, republished whenever the agent's list
    /// changes.
    ///
    /// Its own event rather than a field on `SessionReady`, because for an ACP
    /// agent it does not arrive with the handshake: measured on pi-acp 0.0.33,
    /// `session/new` answers with `sessionId`, `configOptions`, `models` and
    /// `modes`, and the commands follow moments later as an
    /// `available_commands_update` notification - 33 of them, the agent's own
    /// skills among them. Folding that into the handshake event would mean
    /// re-emitting a whole catalogue to carry one late list.
    SlashCommands {
        session_id: String,
        commands: Vec<SlashCommand>,
    },

    /// A compaction has *started*, which is the only warning the panel gets
    /// that the next half minute of silence is work rather than a hang.
    ///
    /// Measured (claude 2.1.251, `dev/fixtures/claude/compaction.jsonl`): the
    /// CLI reports what it is doing on `system`/`status`, and a compaction is
    /// `status: "compacting"` at the start against `status: null` plus
    /// `compact_result` at the end. The captured run took 33 seconds between
    /// the two, with no other frame in between - which is exactly the window in
    /// which the transcript showed nothing at all.
    CompactionStarted { session_id: String, turn_id: String },

    /// A compaction that ended without one: the closing status frame carried a
    /// `compact_error`. Measured on the same channel, by asking a conversation
    /// too short to compact: `compact_result: "failed"` with
    /// `compact_error: "Not enough messages to compact."`.
    ///
    /// Its own event rather than a flag on `Compacted`, because no boundary is
    /// written for a compaction that did not happen: there is nothing to report
    /// the size of, and a `Compacted` with empty figures would read as one that
    /// reclaimed an unknown amount.
    CompactionFailed {
        session_id: String,
        turn_id: String,
        error: String,
    },

    TextDelta {
        session_id: String,
        turn_id: String,
        text: String,
        /// The subagent whose text this is, `None` for the main agent's. A
        /// subagent never streams, so its arrives as one whole `assistant`
        /// frame: the only prose a live lane has.
        #[serde(default)]
        agent_id: Option<String>,
    },

    ThinkingDelta {
        session_id: String,
        turn_id: String,
        text: String,
        /// The subagent whose thinking this is. Same rule as `TextDelta`, and
        /// no capture has yet shown a nested thinking block.
        #[serde(default)]
        agent_id: Option<String>,
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
    ///
    /// **An empty field means "unchanged", never "cleared".** A later emission
    /// carries only what that frame actually said, so a consumer merges rather
    /// than replaces: a null `input`, an empty `name` or an empty `locations`
    /// is the transport declining to speak about that field. ACP is where this
    /// bites, since a `tool_call_update` may describe a call's kind or
    /// locations while saying nothing about its arguments.
    ToolCallStarted {
        session_id: String,
        turn_id: String,
        tool_use_id: String,
        /// A short token for the call, meant to be rendered in mono. Claude
        /// sends its tool name; ACP has no such field, so the adapter puts the
        /// kind's canonical spelling here and the agent's prose in `title`.
        name: String,
        input: serde_json::Value,
        /// Defaulted rather than required, so an event serialized before this
        /// field existed still reads back as the generic card it rendered as.
        #[serde(default)]
        kind: ToolKind,
        #[serde(default)]
        locations: Vec<ToolLocation>,
        /// The agent's own prose for the call, when it has any. `None` on
        /// Claude, whose `name` is already the human-readable thing.
        #[serde(default)]
        title: Option<String>,
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
        /// What the call did, for the collapsed row. `None` whenever the
        /// result's shape was not recognised, which is deliberately common: a
        /// row with no summary reads exactly as it does today, and a wrong
        /// number would be worse than no number.
        #[serde(default)]
        summary: Option<ToolSummary>,
        /// `output` was cut to fit the wire, and the full text is fetched on
        /// demand instead. Set by the adapter that did the cutting.
        #[serde(default)]
        output_truncated: bool,
        /// The diff the call produced, where the transport measured one. Empty
        /// for every call that wrote nothing, for a patch over
        /// [`PATCH_LINE_CAP`], and for every ACP agent, none of which publish
        /// one.
        #[serde(default)]
        patch: Vec<PatchHunk>,
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
    /// Two sources produce this, and a consumer cannot tell them apart nor needs
    /// to: the `PreToolUse` approval socket (a forked hook helper), and the
    /// agent's own in-protocol `can_use_tool` control request. Either way the
    /// `assistant` frame declaring the same call arrives on a different channel
    /// with nothing ordering the two, so consumers must materialize a card from
    /// whichever reaches them first and key it on `tool_use_id`.
    PermissionRequest {
        session_id: String,
        tool_use_id: String,
        tool_name: String,
        input: serde_json::Value,
        /// Correlates the answer back to the blocked helper process, or to the
        /// control request the agent is waiting on.
        request_id: String,
        /// When Sway will auto-deny. Sway owns this deadline and keeps it
        /// strictly below the hook's own timeout, so an unanswered prompt fails
        /// closed with a reason rather than being resolved by the CLI.
        #[serde(default)]
        auto_deny_at_ms: Option<u64>,
        /// The subagent that made this call, when a subagent made it.
        ///
        /// Measured on claude 2.1.231: a `Task` subagent's `can_use_tool` request
        /// carries `agent_id`, and the main agent's does not. Without it a
        /// subagent's prompt would attach to the parent, which is the one place
        /// a permission question can be shown against work the user did not ask
        /// about directly.
        #[serde(default)]
        agent_id: Option<String>,
        /// Actions the agent offered for this call. Empty when it offered
        /// none, which is normal rather than a failure.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        suggestions: Vec<PermissionSuggestion>,
    },

    /// The agent is blocked asking the *user* something, rather than asking
    /// permission to act.
    ///
    /// Its own variant and not a [`Self::PermissionRequest`] because the two
    /// answer differently: a permission is allow or deny, and this is a form.
    /// Keeping them apart is also what stops the answering agent's own wording
    /// leaking above its adapter, since a question is answered in the agent's
    /// vocabulary and the surface never sees that string.
    ///
    /// There is no deadline field. Measured 2026-08-22 on claude 2.1.239: the
    /// CLI imposes none (417s held, zero frames after the ask), and Sway arms
    /// none either, so an unanswered question ends only by being cancelled.
    QuestionRequest {
        session_id: String,
        tool_use_id: String,
        /// Correlates the answer back to whatever the agent is waiting on.
        request_id: String,
        /// The subagent that asked, when a subagent asked. Same reason as
        /// [`Self::PermissionRequest`]'s: without it a subagent's question
        /// attaches to the parent.
        #[serde(default)]
        agent_id: Option<String>,
        /// Measured maximum 4, and never empty.
        questions: Vec<ChatQuestion>,
    },

    /// The only frame joining a subagent's two ids: `agent_id` is what its
    /// `can_use_tool` carries, `tool_use_id` is what its nested frames point at.
    /// Miss it and neither the prompt nor the nested calls can be attributed.
    SubagentStarted {
        session_id: String,
        agent_id: String,
        tool_use_id: String,
        /// What kind of task this is, and the only thing telling a subagent from
        /// the other work on this channel. Measured: `local_agent` for a
        /// subagent, `local_bash` for a backgrounded shell command.
        task_type: String,
        /// Empty for anything that is not a subagent, which sends neither this
        /// nor `prompt`.
        agent_type: String,
        description: String,
        prompt: String,
    },

    /// A tool call made inside a subagent, keyed on `tool_use_id` so arrival
    /// order does not matter. Emitted beside the call rather than as a field on
    /// it: the field would need naming at ninety-odd sites, nearly all `None`.
    SubagentCall {
        session_id: String,
        agent_id: String,
        tool_use_id: String,
    },

    /// One variant for three frames that patch one record. Fields are optional
    /// because each sends a different subset, and absent means "not reported
    /// now". No `turn_id`: a background subagent outlives its parent's turn.
    SubagentUpdate {
        session_id: String,
        agent_id: String,
        /// The agent's own word, never an enum: an unrecognised status must
        /// reach the UI as itself rather than fold into one this build knows.
        #[serde(default)]
        status: Option<String>,
        /// What it is doing *now* ("Writing sub-made.txt"), not what it was
        /// asked to do. `SubagentStarted::description` is the task.
        #[serde(default)]
        activity: Option<String>,
        #[serde(default)]
        last_tool_name: Option<String>,
        #[serde(default)]
        usage: Option<SubagentUsage>,
        #[serde(default)]
        summary: Option<String>,
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
    /// mode or model switch must not be spent on it, and a agent that cannot
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
    /// Answer a blocked [`ChatEvent::QuestionRequest`], one entry per question.
    ///
    /// Every question the request carried must appear here: the agents measured
    /// so far have no grammar for a partial answer, so a surface that dropped
    /// one would leave the agent reading a form with a silent hole in it.
    RespondQuestion {
        session_id: String,
        tool_use_id: String,
        request_id: String,
        answers: Vec<QuestionAnswer>,
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
        effort: Option<String>,
    },
    /// Set one of the agent's own configuration options, named by the id the
    /// agent gave it. The generic counterpart of [`Self::SetModel`] and
    /// [`Self::SetMode`], which stay separate because a model or a mode has
    /// session state behind it (a pending pick, a permission story) that a
    /// mirrored toggle does not.
    SetConfigOption {
        session_id: String,
        config_id: String,
        value: ChatConfigValue,
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
                    // One enabled row and one refused, so both halves of the
                    // shape cross the wire as values rather than as defaults.
                    effort_levels: vec![
                        ChatEffortLevel {
                            level: "low".into(),
                            label: "low".into(),
                            disabled: false,
                            note: String::new(),
                        },
                        ChatEffortLevel {
                            level: "ultracode".into(),
                            label: "Ultracode".into(),
                            disabled: true,
                            note: "Measured on another version of this CLI".into(),
                        },
                    ],
                    supports_auto_mode: true,
                    // True rather than defaulted, so a mirror that dropped
                    // either flag fails on the sample instead of agreeing with
                    // it by accident.
                    supports_fast_mode: true,
                    supports_adaptive_thinking: true,
                }],
                modes: vec![ChatModeInfo {
                    id: "read-only".into(),
                    label: "Read Only".into(),
                    hint: "Ask before writing".into(),
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
                    // One enabled row and one refused, so both halves of the
                    // shape cross the wire as values rather than as defaults.
                    effort_levels: vec![
                        ChatEffortLevel {
                            level: "low".into(),
                            label: "low".into(),
                            disabled: false,
                            note: String::new(),
                        },
                        ChatEffortLevel {
                            level: "ultracode".into(),
                            label: "Ultracode".into(),
                            disabled: true,
                            note: "Measured on another version of this CLI".into(),
                        },
                    ],
                    supports_auto_mode: true,
                    // True rather than defaulted, so a mirror that dropped
                    // either flag fails on the sample instead of agreeing with
                    // it by accident.
                    supports_fast_mode: true,
                    supports_adaptive_thinking: true,
                }],
                modes: vec![ChatModeInfo {
                    id: "read-only".into(),
                    label: "Read Only".into(),
                    hint: "Ask before writing".into(),
                }],
                account: Some(ChatAccount {
                    subscription_type: "Claude Pro".into(),
                    organization: "Acme".into(),
                    api_provider: "firstParty".into(),
                }),
                capabilities: Some(ChatCapabilities { load_session: true, list_sessions: true }),
            },
            ChatEvent::TurnStarted {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                agent_initiated: false,
                model: "claude-sonnet-5".into(),
                permission_mode: PermissionMode::new("default"),
                extra: Extra::new(),
            },
            ChatEvent::ModeRefused {
                session_id: "s1".into(),
                mode: PermissionMode::new("bypassPermissions"),
                reason: "the session was not launched with --dangerously-skip-permissions".into(),
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
            ChatEvent::SlashCommands {
                session_id: "s1".into(),
                commands: vec![SlashCommand {
                    name: "plan".into(),
                    description: "Plan, explore, interview, then create a scoped plan file".into(),
                    argument_hint: Some("what to plan".into()),
                    aliases: Vec::new(),
                }],
            },
            ChatEvent::CompactionStarted {
                session_id: "s1".into(),
                turn_id: "t1".into(),
            },
            ChatEvent::CompactionFailed {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                error: "Not enough messages to compact.".into(),
            },
            ChatEvent::TextDelta {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                text: "hello".into(),
                // Filled rather than `None`, so a mirror that dropped the
                // field fails here instead of reading every lane as main.
                agent_id: Some("acb01121756a92ca0".into()),
            },
            ChatEvent::ThinkingDelta {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                text: "considering".into(),
                agent_id: None,
            },
            ChatEvent::ToolCallStarted {
                session_id: "s1".into(),
                turn_id: "t1".into(),
                tool_use_id: "toolu_1".into(),
                name: "Bash".into(),
                input: serde_json::json!({ "command": "echo hi" }),
                kind: ToolKind::Execute,
                locations: vec![ToolLocation { path: "/tmp/w/probe.txt".into(), line: Some(12) }],
                // Filled rather than `None`, so a mirror that dropped the field
                // fails on the sample instead of agreeing with it by accident.
                title: Some("Running echo hi".into()),
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
                // `None` on purpose: the adapters do not summarise yet, and the
                // absent case is the one every consumer has to keep rendering.
                // The filled variants get their own corpus, see
                // `every_tool_summary`.
                summary: None,
                output_truncated: false,
                // One hunk, in the shape `structuredPatch` sends: the markers
                // ride on the lines rather than in a parallel array.
                patch: vec![PatchHunk {
                    old_start: 12,
                    old_lines: 3,
                    new_start: 12,
                    new_lines: 4,
                    lines: vec![" ctx".into(), "-was".into(), "+is".into(), "+and".into(), " ctx".into()],
                }],
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
                agent_id: Some("affdd797eddcfa753".into()),
                // One of each shape the CLI was measured to send, so the
                // TypeScript mirror is checked against all three rather than
                // against whichever one happened to be sampled.
                suggestions: vec![
                    PermissionSuggestion::AddRules {
                        rules: vec![SuggestedRule {
                            tool_name: "Bash".into(),
                            rule_content: Some("rm -rf /".into()),
                        }],
                        behavior: "allow".into(),
                        destination: "localSettings".into(),
                    },
                    PermissionSuggestion::AddDirectories {
                        directories: vec!["/tmp/w".into()],
                        destination: "session".into(),
                    },
                    PermissionSuggestion::SetMode {
                        mode: PermissionMode::new("acceptEdits"),
                        destination: "session".into(),
                    },
                ],
            },
            // The widest shape measured: four questions is the cap, four options
            // is the cap, and one of each of `multi_select`, a `preview` and a
            // set `agent_id` so the mirror is checked against all three rather
            // than against whichever happened to be sampled.
            ChatEvent::QuestionRequest {
                session_id: "s1".into(),
                tool_use_id: "toolu_4".into(),
                request_id: "op-10".into(),
                agent_id: Some("affdd797eddcfa753".into()),
                questions: vec![
                    ChatQuestion {
                        question: "Which answer channel should the card use?".into(),
                        header: "Channel".into(),
                        multi_select: false,
                        options: vec![
                            ChatQuestionOption {
                                label: "In protocol".into(),
                                description: "Answer the question the agent already asked.".into(),
                                preview: Some("{\"behavior\":\"deny\",\"message\":\"...\"}".into()),
                            },
                            ChatQuestionOption {
                                label: "A dedicated hook".into(),
                                description: "Intercept the call before the agent decides.".into(),
                                preview: None,
                            },
                        ],
                    },
                    ChatQuestion {
                        question: "Which surfaces should the blocking tier cover?".into(),
                        header: "Surfaces".into(),
                        multi_select: true,
                        options: vec![
                            ChatQuestionOption {
                                label: "Permission prompt".into(),
                                description: "The allow or deny card.".into(),
                                preview: None,
                            },
                            ChatQuestionOption {
                                label: "Question card".into(),
                                description: "The form this event opens.".into(),
                                preview: None,
                            },
                            ChatQuestionOption {
                                label: "Hook rows".into(),
                                description: "The ambient rows, which are not blocking.".into(),
                                preview: None,
                            },
                            ChatQuestionOption {
                                label: "Notices".into(),
                                description: "Session errors and endings.".into(),
                                preview: None,
                            },
                        ],
                    },
                    ChatQuestion {
                        question: "Should the card stay inline?".into(),
                        header: "Placement".into(),
                        multi_select: false,
                        options: vec![
                            ChatQuestionOption {
                                label: "Inline".into(),
                                description: "In the transcript, under the call.".into(),
                                preview: None,
                            },
                            ChatQuestionOption {
                                label: "Modal".into(),
                                description: "Over the transcript that explains it.".into(),
                                preview: None,
                            },
                        ],
                    },
                    ChatQuestion {
                        question: "How should an unanswered question end?".into(),
                        header: "Cancel".into(),
                        multi_select: false,
                        options: vec![
                            ChatQuestionOption {
                                label: "Tab close, session end, interrupt".into(),
                                description: "The three explicit exits.".into(),
                                preview: None,
                            },
                            ChatQuestionOption {
                                label: "A timer".into(),
                                description: "Measured absent on this transport.".into(),
                                preview: None,
                            },
                        ],
                    },
                ],
            },
            ChatEvent::SubagentStarted {
                session_id: "s1".into(),
                agent_id: "acb01121756a92ca0".into(),
                tool_use_id: "toolu_5".into(),
                task_type: "local_agent".into(),
                agent_type: "general-purpose".into(),
                description: "Create sub-made.txt".into(),
                prompt: "Use the Write tool to create sub-made.txt containing the word sub.".into(),
            },
            ChatEvent::SubagentCall {
                session_id: "s1".into(),
                agent_id: "acb01121756a92ca0".into(),
                tool_use_id: "toolu_01V4im1SuXMxH4xRjNuCDorw".into(),
            },
            ChatEvent::SubagentUpdate {
                session_id: "s1".into(),
                agent_id: "acb01121756a92ca0".into(),
                status: Some("completed".into()),
                activity: Some("Writing sub-made.txt".into()),
                last_tool_name: Some("Write".into()),
                usage: Some(SubagentUsage { total_tokens: 10371, tool_uses: 1, duration_ms: 4844 }),
                summary: Some("Done. Created sub-made.txt containing the word sub.".into()),
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
            // After the hook frame for the same reason: the options move
            // whenever the agent says so, which is not a step in the lifecycle
            // sequence the replay tests read this list as.
            ChatEvent::ConfigOptions {
                session_id: "s1".into(),
                options: vec![
                    ChatConfigOption {
                        id: "web_search".into(),
                        name: "Web search".into(),
                        description: "Let the agent search the web".into(),
                        category: String::new(),
                        disabled: false,
                        note: String::new(),
                        kind: ChatConfigKind::Boolean { value: true },
                    },
                    // One disabled row, so the mirror's two extra fields cross
                    // the wire in the fixture rather than only as defaults.
                    ChatConfigOption {
                        id: "verbosity".into(),
                        name: "Verbosity".into(),
                        description: String::new(),
                        category: "model_config".into(),
                        disabled: true,
                        note: "Not available on this model".into(),
                        kind: ChatConfigKind::Select {
                            current: "concise".into(),
                            choices: vec![ChatConfigChoice {
                                value: "concise".into(),
                                label: "Concise".into(),
                                description: "Short answers".into(),
                            }],
                        },
                    },
                ],
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
                        label: None,
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
            // One picked answer, one multi-pick, and one that is free text with
            // no pick at all: the three shapes the answer string is built from.
            ChatCommand::RespondQuestion {
                session_id: "s1".into(),
                tool_use_id: "toolu_4".into(),
                request_id: "op-10".into(),
                answers: vec![
                    QuestionAnswer {
                        question: "Which answer channel should the card use?".into(),
                        picks: vec!["In protocol".into()],
                        free_text: None,
                    },
                    QuestionAnswer {
                        question: "Which surfaces should the blocking tier cover?".into(),
                        picks: vec!["Permission prompt".into(), "Question card".into()],
                        free_text: None,
                    },
                    QuestionAnswer {
                        question: "Should the card stay inline?".into(),
                        picks: vec![],
                        free_text: Some("inline, but collapse it once answered".into()),
                    },
                ],
            },
            ChatCommand::SetMode {
                session_id: "s1".into(),
                mode: PermissionMode::new("plan"),
            },
            ChatCommand::SetModel {
                session_id: "s1".into(),
                model: "claude-opus-5".into(),
                effort: Some("xhigh".into()),
            },
            ChatCommand::SetConfigOption {
                session_id: "s1".into(),
                config_id: "web_search".into(),
                value: ChatConfigValue::Flag(true),
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

    /// A catalogue cached before `effortLevels` existed still reads back, and
    /// reads back as **absent** rather than as a model with no levels. This
    /// shape is what is on the user's disk, so an additive field that was not
    /// actually additive would empty every cached picker on upgrade.
    #[test]
    fn a_model_row_stored_before_the_effort_rows_existed_still_reads() {
        let stored = r#"{
            "value": "sonnet",
            "resolvedModel": "claude-sonnet-5",
            "displayName": "Sonnet 5",
            "description": "Balanced",
            "supportsEffort": true,
            "supportedEffortLevels": ["low", "high"],
            "supportsAutoMode": true
        }"#;
        let model: ChatModelInfo = serde_json::from_str(stored).expect("an older cache still deserializes");
        assert_eq!(model.supported_effort_levels, ["low", "high"]);
        assert!(model.effort_levels.is_empty(), "absent, so the reader falls back to the published list");
    }

    /// The cap is in bytes and the text is not, so the cut lands on a character
    /// boundary rather than panicking on exactly the multi-byte outputs most
    /// worth capping.
    #[test]
    fn the_cap_never_splits_a_character() {
        // Three bytes each, so the cap falls mid-character.
        let text = "\u{4f60}".repeat(TOOL_OUTPUT_CAP);
        let cut = cap_output(&text).expect("well over the cap");
        assert!(cut.len() <= TOOL_OUTPUT_CAP);
        assert!(cut.chars().all(|c| c == '\u{4f60}'), "cut mid-character");
    }

    /// Text that fits yields no extract at all, so the caller keeps the string
    /// it already had. The equal-to-cap case is the boundary the `<=` is for.
    #[test]
    fn text_that_fits_is_not_cut() {
        assert_eq!(cap_output(&"x".repeat(TOOL_OUTPUT_CAP)), None);
        assert_eq!(cap_output(""), None);
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

    /// One sample per `ToolSummary` variant.
    ///
    /// A corpus of its own rather than more `ChatEvent` samples, because
    /// `every_event` holds exactly one sample per event variant and six more
    /// `ToolCallCompleted`s would break that. The TypeScript mirror walks this
    /// file to check the field names inside each variant, which is the only
    /// place they are checked: an event's own key list stops at `summary`.
    fn every_tool_summary() -> Vec<ToolSummary> {
        vec![
            // Every `Option` here is `Some`, and its `None` is asserted in the
            // mirror's own test. The absent halves are what the transports
            // permanently answer, so the samples carry the fuller shape that
            // has to survive a round trip and the mirror checks the other one.
            ToolSummary::Search { hits: 12, files: Some(3) },
            ToolSummary::Paths { count: 7 },
            ToolSummary::Read { lines: 40, from: 1, total: Some(400) },
            ToolSummary::Execute { exit_code: Some(0), lines: 118 },
            ToolSummary::Edit { added: 4, removed: 2 },
            ToolSummary::Fetch { host: "example.com".into(), status: Some(200), bytes: Some(559) },
        ]
    }

    #[test]
    fn every_tool_summary_variant_round_trips() {
        for summary in every_tool_summary() {
            let json = serde_json::to_string(&summary).expect("serialize");
            let back: ToolSummary =
                serde_json::from_str(&json).unwrap_or_else(|e| panic!("deserialize {json}: {e}"));
            assert_eq!(summary, back, "round trip changed the value: {json}");
        }
    }

    /// Exhaustive, so a variant added without a sample fails to compile here
    /// rather than reaching the TypeScript mirror untested.
    #[test]
    fn variant_list_covers_every_tool_summary() {
        let all = every_tool_summary();
        for summary in &all {
            let _name = match summary {
                ToolSummary::Search { .. } => "search",
                ToolSummary::Paths { .. } => "paths",
                ToolSummary::Read { .. } => "read",
                ToolSummary::Execute { .. } => "execute",
                ToolSummary::Edit { .. } => "edit",
                ToolSummary::Fetch { .. } => "fetch",
            };
        }
        assert_eq!(all.len(), 6, "every_tool_summary() must hold exactly one sample per variant");
    }

    /// An unknown kind folds into `Other` rather than failing the whole event.
    /// This is the property the ACP adapter leans on: an agent may send a kind
    /// from a newer spec than this build knows.
    #[test]
    fn a_tool_kind_this_build_does_not_know_becomes_other() {
        assert_eq!(
            serde_json::from_str::<ToolKind>("\"somethingNewInV3\"").expect("parses"),
            ToolKind::Other
        );
        assert_eq!(serde_json::from_str::<ToolKind>("\"switchMode\"").expect("parses"), ToolKind::SwitchMode);
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
            };
        }
        // 25 variants; a mismatch means a sample is missing or duplicated.
        assert_eq!(events.len(), 28, "every_event() must hold exactly one sample per variant");
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
                ChatCommand::RespondQuestion { .. } => "respondQuestion",
                ChatCommand::SetMode { .. } => "setMode",
                ChatCommand::SetModel { .. } => "setModel",
                ChatCommand::SetConfigOption { .. } => "setConfigOption",
                ChatCommand::Close { .. } => "close",
            };
        }
        assert_eq!(cmds.len(), 9, "every_command() must hold exactly one sample per variant");
    }

    /// The wire shape the TypeScript mirror is written against: tagged on
    /// `type`, camelCase tag, camelCase fields.
    #[test]
    fn wire_shape_is_tagged_camel_case() {
        let json = serde_json::to_value(&ChatEvent::TextDelta {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            text: "hi".into(),
            agent_id: None,
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
        let summaries = serde_json::to_string_pretty(&every_tool_summary()).expect("serialize summaries");
        std::fs::write(dir.join("events.json"), format!("{events}\n")).expect("write events");
        std::fs::write(dir.join("commands.json"), format!("{commands}\n")).expect("write commands");
        std::fs::write(dir.join("toolSummaries.json"), format!("{summaries}\n")).expect("write summaries");
    }

    /// Agent-specific data must survive the round trip untouched, since the
    /// whole point of `extra` is that the neutral model does not know what is
    /// in it.
    #[test]
    fn extra_survives_untouched() {
        let ev = ChatEvent::TurnStarted {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            agent_initiated: false,
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
