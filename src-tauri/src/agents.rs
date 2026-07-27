// Agent adapter registry: what used to be "claude"/"pi" string branches
// scattered through sessions.rs is now data. Three adapters ship bundled
// (agents/claude.toml, agents/pi.toml, agents/opencode.toml, embedded at
// compile time); a user can add or whole-replace an adapter by dropping a
// `schema_version = 1` or `= 2` TOML file into `~/.config/sway/agents/`. See
// ADAPTERS.md for the schema. v2 is purely additive: it adds the optional
// `[chat]` table describing how to drive the agent as a structured chat
// session rather than a PTY, and a v1 file loads unchanged reporting no chat.
//
// Parser kinds and chat transports stay code (an enum, not a config string): a config-driven
// launch/discovery/running-pattern description is enough to make an agent
// show up and resume correctly, but turning its transcript into `SessionMeta`/
// `SessionDetail`/touched-files/transcript-turns needs a real parser
// implementation. A user adapter may only reference an existing kind.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The newest schema this build writes and documents.
pub const SCHEMA_VERSION: u32 = 2;

/// Every schema version this build still loads.
///
/// v1 stays supported deliberately: a user adapter in `~/.config/sway/agents/`
/// is somebody's working config, and v2 adds only the optional `[chat]` table,
/// so there is nothing a v1 file needs to say differently. A v1 adapter loads
/// exactly as before and reports `chat: None`.
pub const SUPPORTED_SCHEMA_VERSIONS: [u32; 2] = [1, 2];

/// How Sway drives an agent as a structured chat session rather than a PTY.
///
/// A closed enum, not a config string, for the same reason `ParserKind` is: a
/// transport is a Rust module implementing a wire protocol, so a TOML can only
/// *select* one that exists. An unknown value is rejected loudly rather than
/// silently producing an adapter whose chat surface cannot start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatTransport {
    /// `claude -p --input-format stream-json --output-format stream-json`,
    /// driven as one long-lived child with stdin held open.
    ClaudeStreamJson,
}

impl ChatTransport {
    /// Every transport, so `from_str` can be derived from `as_str` instead of
    /// repeating the wire strings in a second, independently-drifting list.
    pub const ALL: [ChatTransport; 1] = [Self::ClaudeStreamJson];

    /// Parse a `chat.transport` value. Derived from `as_str`, so a wire string
    /// cannot mean one thing when read and another when written.
    fn from_str(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == s)
    }

    /// The wire spelling of this transport.
    ///
    /// This is deliberately the **single exhaustive match** over the enum in
    /// the tree, so adding a transport fails to compile in exactly one place.
    /// Confirmed by adding a throwaway member: exactly one E0004, at this
    /// `match`. It stays the only one until Phase 3's transport factory takes
    /// the role over; anything dispatching per-transport should go through the
    /// factory rather than adding a second match to keep in sync.
    ///
    /// The compiler covers this arm, but it cannot see `ALL`: a new member left
    /// out of that list would parse as unknown and the transport would be
    /// silently unreachable from TOML. `every_transport_round_trips_through_its_wire_string`
    /// is what catches that, so adding a transport means the variant, an `ALL`
    /// entry, and this arm.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeStreamJson => "claude_stream_json",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParserKind {
    ClaudeJsonl,
    PiJsonl,
    /// opencode's transcript isn't a file at all: every session's messages
    /// live as rows in one shared SQLite DB (`discovery.backend = "sqlite"`).
    /// See `crate::opencode` for the query layer.
    OpencodeSqlite,
}

impl ParserKind {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "claude_jsonl" => Some(Self::ClaudeJsonl),
            "pi_jsonl" => Some(Self::PiJsonl),
            "opencode_sqlite" => Some(Self::OpencodeSqlite),
            _ => None,
        }
    }
}

/// Where an adapter's sessions live and how to find them. Every bundled/user
/// adapter today is `File` (claude, pi); `Sqlite` exists because opencode has
/// no per-session file - every session's messages/parts are rows in one
/// shared DB covering every project on the machine (see ADAPTERS.md).
#[derive(Debug, Clone)]
pub enum Discovery {
    File { dir: PathBuf, filename_regex: Regex },
    Sqlite { db_path: PathBuf },
}

/// One model a chat-capable adapter can run.
///
/// `effort_levels` is empty for a model that has no effort control, which is
/// what hides the picker rather than rendering an inert one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatModel {
    pub id: String,
    pub label: String,
    /// Total context in tokens, when the adapter declares one. The meter only
    /// renders when it does, rather than inventing a denominator.
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub effort_levels: Vec<String>,
    #[serde(default)]
    pub supports_thinking: bool,
    #[serde(default)]
    pub supports_images: bool,
}

/// A permission mode and the args that select it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMode {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// An effort level and the args that select it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatEffort {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// The resolved `[chat]` table: everything needed to start and steer a
/// structured chat session for this adapter.
///
/// Arg templates rather than hardcoded flags, so a second harness is a TOML
/// table instead of a Rust branch. Placeholders are substituted by
/// `apply_chat_template`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatConfig {
    pub transport: ChatTransport,
    /// Defaults to the adapter's `launch.program`; overridable because the
    /// chat binary need not be the one the PTY tab launches.
    pub program: String,
    pub base_args: Vec<String>,
    /// `{id}` template selecting a brand-new session id.
    pub session_id_args: Vec<String>,
    /// `{id}` template resuming an existing session.
    pub resume_args: Vec<String>,
    /// `{model}` template.
    pub model_args: Vec<String>,
    /// `{effort}` template, the **default** for every `[[chat.effort]]` entry.
    /// See `ChatConfig::effort_args_for`.
    pub effort_args: Vec<String>,
    /// `{mode}` template, the **default** for every `[[chat.modes]]` entry.
    /// See `ChatConfig::mode_args_for`.
    pub mode_args: Vec<String>,
    /// `{dir}` template, applied once per extra directory.
    pub add_dir_args: Vec<String>,
    pub models: Vec<ChatModel>,
    pub modes: Vec<ChatMode>,
    pub effort: Vec<ChatEffort>,
}

/// Reachable only from tests until Phase 3 spawns a chat session and Phases 6
/// and 9 build the mode and effort controls on these. **Phase 6 removes this
/// allow**; if it survives once those controls exist, a resolver genuinely is
/// unused and a call site is reading the fields directly instead.
#[allow(dead_code)]
impl ChatConfig {
    /// The args that select `mode_id`, resolving the two ways an adapter can
    /// say it.
    ///
    /// A mode or effort level can be expressed either by the table-level
    /// template (`mode_args = ["--permission-mode", "{mode}"]`) or by the
    /// entry's own `args`, and without a stated rule every consumer would pick
    /// one and they would disagree. The rule is: **an entry's own `args` win
    /// when non-empty, otherwise the template is filled with the entry's id.**
    /// The template is the concise default; per-entry args are the escape
    /// hatch for a harness whose modes are not one flag with a varying value.
    ///
    /// Both callers (Phase 6's mode selector, Phase 9's effort control) go
    /// through here rather than reading the fields directly.
    pub fn mode_args_for(&self, mode_id: &str) -> Option<Vec<String>> {
        let mode = self.modes.iter().find(|m| m.id == mode_id)?;
        if !mode.args.is_empty() {
            return Some(mode.args.clone());
        }
        Some(apply_chat_template(&self.mode_args, &[("mode", mode_id)]))
    }

    /// The args that select `effort_id`. Same precedence as `mode_args_for`.
    pub fn effort_args_for(&self, effort_id: &str) -> Option<Vec<String>> {
        let level = self.effort.iter().find(|e| e.id == effort_id)?;
        if !level.args.is_empty() {
            return Some(level.args.clone());
        }
        Some(apply_chat_template(&self.effort_args, &[("effort", effort_id)]))
    }

    /// The args that select `model_id`. Models have no per-entry override, so
    /// this is just the template, but it is exposed alongside the other two so
    /// a caller never reaches past the resolver for one of the three.
    pub fn model_args_for(&self, model_id: &str) -> Option<Vec<String>> {
        self.models.iter().find(|m| m.id == model_id)?;
        Some(apply_chat_template(&self.model_args, &[("model", model_id)]))
    }
}

/// A resolved, validated adapter. The frontend gets a mirrored subset of this
/// via `list_agents` (the regex/path fields stay backend-only).
#[derive(Debug, Clone, Serialize)]
pub struct AgentAdapter {
    pub id: String,
    pub label: String,
    pub program: String,
    pub base_args: Vec<String>,
    pub yolo_args: Vec<String>,
    /// `{id}`/`{file}` placeholder template; `apply_template` substitutes.
    pub resume_args: Vec<String>,
    #[serde(skip)]
    pub discovery: Discovery,
    pub parser_kind: ParserKind,
    /// ERE template (for `pgrep -f`) with an `{id}` placeholder.
    pub running_pattern: String,
    pub pty_quiet_ms: u64,
    /// Whether the quiet-PTY x pending-tool_use join is trusted as a "needs
    /// you" signal for this agent (see `CapabilitiesToml::needs_you`).
    pub needs_you: bool,
    /// Whether this agent has a verified hook-driven status mechanism
    /// (`crate::hooks`) that overrides the transcript-tail join as the
    /// authoritative working/needs-you source. Only claude ships one today
    /// (phase 1's `--settings` injection spike); every other adapter stays
    /// on the tail-join floor.
    pub hooks: bool,
    /// The agent CLI version this adapter's conventions were empirically
    /// captured against (e.g. `"opencode 1.18.3"`), echoed in ADAPTERS.md.
    /// Optional: not every adapter carries one.
    pub verified_against: Option<String>,
    /// The `[chat]` table, or `None` for an adapter with no chat transport.
    ///
    /// `None` is the normal case, not a degraded one: pi and opencode are
    /// PTY-only and stay fully functional that way, and every v1 adapter
    /// reports `None` without changing behaviour.
    pub chat: Option<ChatConfig>,
    /// Where this adapter was loaded from: `"bundled:<id>"` for a built-in, or
    /// the absolute path of the user TOML that defined (or whole-replaced) it.
    /// The Agents cards show the path so a user who forgot about an override
    /// can see which file is actually in effect.
    pub source: String,
}

// --- raw TOML shape (kept separate from `AgentAdapter`: a `Regex` isn't
// `Deserialize`, and validation needs to happen before the typed struct is
// trusted) ---

#[derive(Debug, Deserialize)]
struct AdapterToml {
    schema_version: u32,
    id: String,
    label: String,
    launch: LaunchToml,
    discovery: DiscoveryToml,
    parser: ParserToml,
    running: RunningToml,
    #[serde(default)]
    capabilities: CapabilitiesToml,
    #[serde(default)]
    verified_against: Option<String>,
    #[serde(default)]
    chat: Option<ChatToml>,
}

#[derive(Debug, Deserialize)]
struct ChatToml {
    transport: String,
    #[serde(default)]
    program: Option<String>,
    #[serde(default)]
    base_args: Vec<String>,
    #[serde(default)]
    session_id_args: Vec<String>,
    #[serde(default)]
    resume_args: Vec<String>,
    #[serde(default)]
    model_args: Vec<String>,
    #[serde(default)]
    effort_args: Vec<String>,
    #[serde(default)]
    mode_args: Vec<String>,
    #[serde(default)]
    add_dir_args: Vec<String>,
    #[serde(default)]
    models: Vec<ChatModel>,
    #[serde(default)]
    modes: Vec<ChatMode>,
    #[serde(default)]
    effort: Vec<ChatEffort>,
}

#[derive(Debug, Deserialize)]
struct LaunchToml {
    program: String,
    #[serde(default)]
    base_args: Vec<String>,
    #[serde(default)]
    yolo_args: Vec<String>,
    resume_args: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct DiscoveryToml {
    #[serde(default = "default_backend")]
    backend: String,
    /// Required when `backend = "file"` (the default).
    dir: Option<String>,
    /// Required when `backend = "file"`.
    filename_pattern: Option<String>,
    /// Required when `backend = "sqlite"`.
    db_path: Option<String>,
}

fn default_backend() -> String {
    "file".to_string()
}

#[derive(Debug, Deserialize)]
struct ParserToml {
    kind: String,
}

#[derive(Debug, Deserialize)]
struct RunningToml {
    pattern: String,
}

#[derive(Debug, Deserialize)]
struct CapabilitiesToml {
    #[serde(default = "default_quiet_ms")]
    pty_quiet_ms: u64,
    /// Whether the quiet-PTY x pending-tool_use join is trusted as a
    /// "needs you" signal for this agent. False when the agent has no
    /// observable permission-block state to be quiet during - see
    /// ADAPTERS.md's Capabilities section.
    #[serde(default = "default_needs_you")]
    needs_you: bool,
    /// Whether a verified hook-driven status mechanism exists for this
    /// agent (see `AgentAdapter::hooks`). False for every adapter unless a
    /// TOML explicitly opts in - there is no generic injection mechanism,
    /// each one is agent-specific code in `crate::hooks`.
    #[serde(default)]
    hooks: bool,
}

impl Default for CapabilitiesToml {
    fn default() -> Self {
        Self {
            pty_quiet_ms: default_quiet_ms(),
            needs_you: default_needs_you(),
            hooks: false,
        }
    }
}

fn default_quiet_ms() -> u64 {
    2000
}

fn default_needs_you() -> bool {
    true
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

const REQUIRED_TOP_LEVEL: [&str; 7] =
    ["schema_version", "id", "label", "launch", "discovery", "parser", "running"];
const KNOWN_TOP_LEVEL: [&str; 10] = [
    "schema_version",
    "id",
    "label",
    "launch",
    "discovery",
    "parser",
    "running",
    "capabilities",
    "verified_against",
    "chat",
];

/// Parse + validate one adapter TOML source. `source` labels the origin for
/// error messages/warnings (a file path, or a fixed name for a built-in).
/// Rejects an unsupported `schema_version`, names every missing required
/// field in one message (not just the first, the way a bare serde error
/// would), warns (doesn't reject) on an unrecognized top-level field, and
/// rejects a `parser.kind` outside the closed set of implemented parsers.
fn load_adapter_str(text: &str, source: &str) -> Result<AgentAdapter, String> {
    let value: toml::Value = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if let Some(table) = value.as_table() {
        for key in table.keys() {
            if !KNOWN_TOP_LEVEL.contains(&key.as_str()) {
                eprintln!("sway: agent adapter {source}: unknown field `{key}`, ignoring");
            }
        }
        let missing: Vec<&str> =
            REQUIRED_TOP_LEVEL.iter().filter(|k| !table.contains_key(**k)).copied().collect();
        if !missing.is_empty() {
            return Err(format!("{source}: missing required field(s): {}", missing.join(", ")));
        }
    }

    let raw: AdapterToml = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if !SUPPORTED_SCHEMA_VERSIONS.contains(&raw.schema_version) {
        let supported =
            SUPPORTED_SCHEMA_VERSIONS.map(|v| v.to_string()).join(", ");
        return Err(format!(
            "{source}: unsupported schema_version {} (sway supports {supported})",
            raw.schema_version
        ));
    }

    // `[chat]` is what v2 adds, so honouring it in a file that declares v1
    // would make the version number decorative. Named rather than ignored: a
    // silently-dropped chat table looks exactly like an adapter that simply
    // has no chat surface.
    if raw.chat.is_some() && raw.schema_version < SCHEMA_VERSION {
        return Err(format!(
            "{source}: [chat] requires schema_version = {SCHEMA_VERSION} (this file declares {})",
            raw.schema_version
        ));
    }

    let parser_kind = ParserKind::from_str(&raw.parser.kind).ok_or_else(|| {
        format!(
            "{source}: unknown parser kind `{}` (expected claude_jsonl, pi_jsonl, or opencode_sqlite)",
            raw.parser.kind
        )
    })?;

    let discovery = match raw.discovery.backend.as_str() {
        "file" => {
            let dir = raw.discovery.dir.ok_or_else(|| {
                format!("{source}: discovery.dir is required for backend = \"file\"")
            })?;
            let pattern = raw.discovery.filename_pattern.ok_or_else(|| {
                format!("{source}: discovery.filename_pattern is required for backend = \"file\"")
            })?;
            let filename_regex = Regex::new(&pattern)
                .map_err(|e| format!("{source}: invalid discovery.filename_pattern: {e}"))?;
            if filename_regex.capture_names().flatten().all(|n| n != "id") {
                return Err(format!(
                    "{source}: discovery.filename_pattern must have a named `id` capture group"
                ));
            }
            Discovery::File { dir: expand_tilde(&dir), filename_regex }
        }
        "sqlite" => {
            let db_path = raw.discovery.db_path.ok_or_else(|| {
                format!("{source}: discovery.db_path is required for backend = \"sqlite\"")
            })?;
            Discovery::Sqlite { db_path: expand_tilde(&db_path) }
        }
        other => {
            return Err(format!(
                "{source}: unknown discovery.backend `{other}` (expected file or sqlite)"
            ))
        }
    };

    let chat = raw
        .chat
        .map(|c| {
            let transport = ChatTransport::from_str(&c.transport).ok_or_else(|| {
                format!(
                    "{source}: unknown chat.transport `{}` (expected claude_stream_json)",
                    c.transport
                )
            })?;
            // Every declared model's effort levels must exist in
            // `[[chat.effort]]`, or the picker offers a level with no args to
            // send and the switch silently does nothing.
            for m in &c.models {
                for level in &m.effort_levels {
                    if !c.effort.iter().any(|e| &e.id == level) {
                        return Err(format!(
                            "{source}: chat model `{}` lists effort level `{level}`, which no [[chat.effort]] entry defines",
                            m.id
                        ));
                    }
                }
            }
            Ok(ChatConfig {
                transport,
                program: c.program.unwrap_or_else(|| raw.launch.program.clone()),
                base_args: c.base_args,
                session_id_args: c.session_id_args,
                resume_args: c.resume_args,
                model_args: c.model_args,
                effort_args: c.effort_args,
                mode_args: c.mode_args,
                add_dir_args: c.add_dir_args,
                models: c.models,
                modes: c.modes,
                effort: c.effort,
            })
        })
        .transpose()?;

    Ok(AgentAdapter {
        id: raw.id,
        label: raw.label,
        program: raw.launch.program,
        base_args: raw.launch.base_args,
        yolo_args: raw.launch.yolo_args,
        resume_args: raw.launch.resume_args,
        discovery,
        parser_kind,
        running_pattern: raw.running.pattern,
        pty_quiet_ms: raw.capabilities.pty_quiet_ms,
        needs_you: raw.capabilities.needs_you,
        hooks: raw.capabilities.hooks,
        verified_against: raw.verified_against,
        chat,
        source: source.to_string(),
    })
}

/// Substitute a chat arg template's placeholders.
///
/// Separate from `apply_template` (which knows only `{id}`/`{file}`) because
/// the chat templates carry a different, larger placeholder set; folding both
/// into one function would mean every caller passes four empty strings.
///
/// Reachable only from tests and `ChatConfig`'s resolvers until Phase 3 spawns
/// a session; the allow goes with theirs.
#[allow(dead_code)]
pub fn apply_chat_template(template: &[String], vars: &[(&str, &str)]) -> Vec<String> {
    template
        .iter()
        .map(|a| {
            let mut out = a.clone();
            for (key, value) in vars {
                out = out.replace(&format!("{{{key}}}"), value);
            }
            out
        })
        .collect()
}

const BUILTIN_CLAUDE: &str = include_str!("../agents/claude.toml");
const BUILTIN_PI: &str = include_str!("../agents/pi.toml");
const BUILTIN_OPENCODE: &str = include_str!("../agents/opencode.toml");

fn user_agents_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/agents")
}

/// Bundled built-ins, then every `*.toml` in `user_dir`. A user file whose id
/// matches a built-in whole-replaces it (last insert wins - the entire
/// struct, never a field-by-field merge). A user file that fails validation
/// is never silently swallowed: it's logged loudly (naming the problem) and
/// the id it would have overridden keeps its previous (built-in or
/// earlier-loaded) entry, so one broken file can't make an agent disappear.
fn build_registry_from(user_dir: &Path) -> Vec<AgentAdapter> {
    let mut by_id: HashMap<String, AgentAdapter> = HashMap::new();

    for (source, text) in [
        ("bundled:claude", BUILTIN_CLAUDE),
        ("bundled:pi", BUILTIN_PI),
        ("bundled:opencode", BUILTIN_OPENCODE),
    ] {
        match load_adapter_str(text, source) {
            Ok(a) => {
                by_id.insert(a.id.clone(), a);
            }
            Err(e) => eprintln!("sway: ERROR loading built-in agent adapter {source}: {e}"),
        }
    }

    if let Ok(entries) = std::fs::read_dir(user_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("toml") {
                continue;
            }
            let source = path.to_string_lossy().into_owned();
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("sway: ERROR reading agent adapter {source}: {e}");
                    continue;
                }
            };
            match load_adapter_str(&text, &source) {
                Ok(a) => {
                    by_id.insert(a.id.clone(), a);
                }
                Err(e) => eprintln!(
                    "sway: ERROR loading agent adapter {source}: {e} (keeping the previous adapter for this id)"
                ),
            }
        }
    }

    let mut list: Vec<AgentAdapter> = by_id.into_values().collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    list
}

fn build_registry() -> Vec<AgentAdapter> {
    build_registry_from(&user_agents_dir())
}

static REGISTRY: OnceLock<Vec<AgentAdapter>> = OnceLock::new();

/// The process-wide adapter registry, loaded once on first use (bundled +
/// `~/.config/sway/agents/*.toml`; not live-watched - restart to pick up
/// edits, same as any other loaded-at-startup config in Sway today).
pub fn registry() -> &'static [AgentAdapter] {
    REGISTRY.get_or_init(build_registry)
}

impl AgentAdapter {
    /// The on-disk location this adapter discovers sessions from: a directory
    /// for the `File` backend, the DB file for `Sqlite`. The health cards
    /// report whether it exists, which is the difference between "the agent is
    /// installed but you have never run it" and "something is misconfigured".
    pub fn discovery_path(&self) -> &Path {
        match &self.discovery {
            Discovery::File { dir, .. } => dir,
            Discovery::Sqlite { db_path } => db_path,
        }
    }

    /// True when this adapter came from a user TOML rather than a built-in.
    pub fn is_override(&self) -> bool {
        !self.source.starts_with("bundled:")
    }
}

pub fn find(id: &str) -> Option<&'static AgentAdapter> {
    registry().iter().find(|a| a.id == id)
}

/// Substitute `{id}`/`{file}` placeholders in an arg template.
pub fn apply_template(template: &[String], id: &str, file: &str) -> Vec<String> {
    template.iter().map(|a| a.replace("{id}", id).replace("{file}", file)).collect()
}

/// ERE pattern (for `pgrep -f`) matching a live process resuming session
/// `id`. Falls back to the claude pattern for an unrecognized agent id,
/// matching this function's pre-registry implicit default.
pub fn session_pattern(agent: &str, id: &str) -> String {
    match find(agent).or_else(|| find("claude")) {
        Some(a) => a.running_pattern.replace("{id}", id),
        None => format!("claude (--resume|-r) {id}"),
    }
}

/// The parser kind for `agent`, defaulting to Claude's shape for an
/// unrecognized id (matches the pre-registry implicit `else` branch every
/// transcript-parsing call site used to take).
pub fn parser_kind_for(agent: &str) -> ParserKind {
    find(agent).map(|a| a.parser_kind).unwrap_or(ParserKind::ClaudeJsonl)
}

#[tauri::command]
pub fn list_agents() -> Vec<AgentAdapter> {
    registry().to_vec()
}

#[cfg(test)]
const VALID_MINIMAL: &str = r#"
schema_version = 1
id = "x"
label = "X"

[launch]
program = "x"
resume_args = ["--resume", "{id}"]

[discovery]
dir = "~/.x/sessions"
filename_pattern = '^(?P<id>.+)\.jsonl$'

[parser]
kind = "claude_jsonl"

[running]
pattern = 'x --resume {id}'
"#;

/// A minimal adapter launching `program`, for tests in other modules that need
/// an adapter but not a whole TOML (see `crate::health`).
#[cfg(test)]
pub fn test_adapter(program: &str) -> AgentAdapter {
    let text = VALID_MINIMAL.replace("program = \"x\"", &format!("program = \"{program}\""));
    load_adapter_str(&text, "bundled:test").expect("test adapter parses")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_dir() -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("sway_agents_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn bundled_adapters_load_and_validate() {
        let claude = load_adapter_str(BUILTIN_CLAUDE, "bundled:claude").expect("claude parses");
        assert_eq!(claude.id, "claude");
        assert_eq!(claude.program, "claude");
        assert_eq!(claude.parser_kind, ParserKind::ClaudeJsonl);
        assert_eq!(claude.yolo_args, vec!["--dangerously-skip-permissions"]);
        // Empirically confirmed (phase 2): claude genuinely blocks-and-goes-quiet
        // on a permission prompt, so needs-you ships enabled.
        assert!(claude.needs_you);
        // Phase 3: claude's hook-driven status mechanism is verified and wired.
        assert!(claude.hooks);

        let pi = load_adapter_str(BUILTIN_PI, "bundled:pi").expect("pi parses");
        assert_eq!(pi.id, "pi");
        assert_eq!(pi.program, "pi");
        assert_eq!(pi.parser_kind, ParserKind::PiJsonl);
        // Empirically confirmed (phase 2): pi's built-in tools never block on
        // permission, so there is no genuine blocked-quiet state to verify the
        // join against; needs-you stays off per the plan's contingency.
        assert!(!pi.needs_you);

        let opencode = load_adapter_str(BUILTIN_OPENCODE, "bundled:opencode").expect("opencode parses");
        assert_eq!(opencode.id, "opencode");
        assert_eq!(opencode.parser_kind, ParserKind::OpencodeSqlite);
        assert!(matches!(opencode.discovery, Discovery::Sqlite { .. }));
        // Empirically confirmed (phase 2, real pty capture): no permission
        // prompt gates opencode's default agent, and the TUI never goes
        // quiet while working - no blocked-quiet state to verify against.
        assert!(!opencode.needs_you);
        assert_eq!(opencode.verified_against.as_deref(), Some("opencode 1.18.3"));
    }

    #[test]
    fn sample_user_toml_for_a_new_agent_loads() {
        let a = load_adapter_str(VALID_MINIMAL, "test").expect("valid user adapter parses");
        assert_eq!(a.id, "x");
        assert_eq!(a.resume_args, vec!["--resume", "{id}"]);
        match &a.discovery {
            Discovery::File { filename_regex, .. } => assert!(filename_regex.is_match("abc.jsonl")),
            Discovery::Sqlite { .. } => panic!("expected a file-backed discovery"),
        }
    }

    #[test]
    fn sqlite_backend_requires_db_path() {
        const TOML: &str = r#"
schema_version = 1
id = "x"
label = "X"

[launch]
program = "x"
resume_args = ["--session", "{id}"]

[discovery]
backend = "sqlite"

[parser]
kind = "opencode_sqlite"

[running]
pattern = 'x --session {id}'
"#;
        let err = load_adapter_str(TOML, "test").unwrap_err();
        assert!(err.contains("db_path"), "error should mention db_path: {err}");
    }

    #[test]
    fn unknown_discovery_backend_is_rejected() {
        let text = VALID_MINIMAL.replacen(
            "[discovery]",
            "[discovery]\nbackend = \"made_up_backend\"",
            1,
        );
        let err = load_adapter_str(&text, "test").unwrap_err();
        assert!(err.contains("made_up_backend"), "error should name the bad backend: {err}");
    }

    #[test]
    fn full_override_of_claude_whole_replaces_the_builtin() {
        let dir = tmp_dir();
        std::fs::write(
            dir.join("claude.toml"),
            r#"
schema_version = 1
id = "claude"
label = "Claude (custom)"

[launch]
program = "claude-beta"
resume_args = ["--resume", "{id}"]

[discovery]
dir = "~/.claude-beta/projects"
filename_pattern = '^(?P<id>.+)\.jsonl$'

[parser]
kind = "claude_jsonl"

[running]
pattern = 'claude-beta (--resume|-r) {id}'
"#,
        )
        .unwrap();

        let reg = build_registry_from(&dir);
        let claude = reg.iter().find(|a| a.id == "claude").expect("claude present");
        assert_eq!(claude.program, "claude-beta");
        assert_eq!(claude.label, "Claude (custom)");
        // pi is untouched by an override that only names claude.
        let pi = reg.iter().find(|a| a.id == "pi").expect("pi present");
        assert_eq!(pi.program, "pi");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn broken_override_keeps_the_builtin_available_not_a_silent_swap() {
        let dir = tmp_dir();
        // Missing label/launch/discovery/parser/running.
        std::fs::write(dir.join("claude.toml"), "schema_version = 1\nid = \"claude\"\n").unwrap();

        let reg = build_registry_from(&dir);
        let claude = reg.iter().find(|a| a.id == "claude").expect("built-in claude still present");
        assert_eq!(claude.program, "claude"); // untouched bundled value, not silently dropped

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bad_schema_version_is_rejected() {
        let text = VALID_MINIMAL.replacen("schema_version = 1", "schema_version = 3", 1);
        let err = load_adapter_str(&text, "test").unwrap_err();
        assert!(err.contains("schema_version"), "error should mention schema_version: {err}");
    }

    // --- schema v2: the [chat] table ---

    /// The compatibility promise of the v2 bump: an existing user adapter is
    /// somebody's working config and must not need editing.
    #[test]
    fn a_v1_adapter_loads_unchanged_and_reports_no_chat() {
        let a = load_adapter_str(VALID_MINIMAL, "test").expect("a v1 adapter still parses");
        assert!(a.chat.is_none(), "a v1 adapter must report chat: None");
        // Everything else is byte-for-byte what v1 produced.
        assert_eq!(a.id, "x");
        assert_eq!(a.program, "x");
        assert_eq!(a.resume_args, vec!["--resume", "{id}"]);
        assert_eq!(a.parser_kind, ParserKind::ClaudeJsonl);
    }

    /// A v2 adapter that simply has no chat surface is the normal case, not a
    /// degraded one - pi and opencode stay PTY-only.
    #[test]
    fn a_v2_adapter_without_a_chat_table_also_reports_none() {
        let text = VALID_MINIMAL.replacen("schema_version = 1", "schema_version = 2", 1);
        let a = load_adapter_str(&text, "test").expect("a v2 adapter without [chat] parses");
        assert!(a.chat.is_none());
    }

    const CHAT_TABLE: &str = r#"
[chat]
transport = "claude_stream_json"
base_args = ["-p", "--output-format", "stream-json"]
session_id_args = ["--session-id", "{id}"]
resume_args = ["--resume", "{id}"]
model_args = ["--model", "{model}"]
effort_args = ["--effort", "{effort}"]
mode_args = ["--permission-mode", "{mode}"]
add_dir_args = ["--add-dir", "{dir}"]

[[chat.models]]
id = "m1"
label = "M1"
context_window = 200000
effort_levels = ["low"]

[[chat.modes]]
id = "plan"
label = "Plan"
args = ["--permission-mode", "plan"]

[[chat.effort]]
id = "low"
label = "Low"
args = ["--effort", "low"]
"#;

    fn v2_with_chat(chat: &str) -> String {
        format!("{}{chat}", VALID_MINIMAL.replacen("schema_version = 1", "schema_version = 2", 1))
    }

    #[test]
    fn a_chat_table_resolves_and_defaults_program_to_the_launch_binary() {
        let a = load_adapter_str(&v2_with_chat(CHAT_TABLE), "test").expect("parses");
        let chat = a.chat.expect("chat table resolved");
        assert_eq!(chat.transport, ChatTransport::ClaudeStreamJson);
        // Not overridden, so it falls back to launch.program rather than empty.
        assert_eq!(chat.program, "x");
        assert_eq!(chat.session_id_args, vec!["--session-id", "{id}"]);
        assert_eq!(chat.add_dir_args, vec!["--add-dir", "{dir}"]);
    }

    #[test]
    fn chat_program_can_be_overridden_independently_of_the_pty_binary() {
        let chat = CHAT_TABLE.replacen(
            "transport = \"claude_stream_json\"",
            "transport = \"claude_stream_json\"\nprogram = \"claude-beta\"",
            1,
        );
        let a = load_adapter_str(&v2_with_chat(&chat), "test").expect("parses");
        assert_eq!(a.chat.unwrap().program, "claude-beta");
        assert_eq!(a.program, "x", "the PTY launch binary is untouched");
    }

    /// The transport is a closed enum for the same reason `parser.kind` is: a
    /// TOML can only select a Rust module that exists.
    #[test]
    fn an_unknown_transport_is_rejected_naming_it() {
        let chat = CHAT_TABLE.replacen("claude_stream_json", "made_up_transport", 1);
        let err = load_adapter_str(&v2_with_chat(&chat), "test").unwrap_err();
        assert!(err.contains("made_up_transport"), "error should name the bad transport: {err}");
    }

    /// The loud-failure contract: a broken chat table must not make the agent
    /// vanish, it must leave the previous adapter for that id in place.
    #[test]
    fn an_unknown_transport_keeps_the_previous_adapter_for_that_id() {
        let dir = tmp_dir();
        let mut text = v2_with_chat(CHAT_TABLE).replacen("id = \"x\"", "id = \"claude\"", 1);
        text = text.replacen("claude_stream_json", "made_up_transport", 1);
        std::fs::write(dir.join("claude.toml"), text).unwrap();

        let reg = build_registry_from(&dir);
        let claude = reg.iter().find(|a| a.id == "claude").expect("built-in claude still present");
        assert_eq!(claude.program, "claude", "the bundled adapter survived the broken override");
        assert!(claude.chat.is_some(), "and kept its own working chat table");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A version number that does not gate anything is decorative.
    #[test]
    fn a_chat_table_in_a_v1_file_is_refused_rather_than_ignored() {
        let err = load_adapter_str(&format!("{VALID_MINIMAL}{CHAT_TABLE}"), "test").unwrap_err();
        assert!(err.contains("schema_version = 2"), "error should say what v2 is needed for: {err}");
    }

    /// An effort level with no matching `[[chat.effort]]` entry would render a
    /// picker option carrying no args, so switching to it would silently do
    /// nothing.
    #[test]
    fn a_model_referencing_an_undefined_effort_level_is_rejected() {
        let chat = CHAT_TABLE.replacen("effort_levels = [\"low\"]", "effort_levels = [\"low\", \"ludicrous\"]", 1);
        let err = load_adapter_str(&v2_with_chat(&chat), "test").unwrap_err();
        assert!(err.contains("ludicrous"), "error should name the undefined level: {err}");
    }

    /// The bundled claude adapter is what actually ships, so its three tables
    /// are asserted against real content rather than mere presence.
    #[test]
    fn bundled_claude_declares_models_modes_and_effort() {
        let claude = load_adapter_str(BUILTIN_CLAUDE, "bundled:claude").expect("claude parses");
        let chat = claude.chat.expect("claude ships a chat table");
        assert_eq!(chat.transport, ChatTransport::ClaudeStreamJson);
        assert_eq!(claude.verified_against.as_deref(), Some("claude 2.1.220"));

        assert!(!chat.models.is_empty(), "no models declared");
        assert!(chat.models.iter().any(|m| m.id == "claude-opus-5"));
        assert!(
            chat.models.iter().all(|m| m.context_window.is_some()),
            "a declared model without a context window would render a meter with no denominator"
        );
        // Haiku declares no effort levels, which is what hides the control
        // rather than rendering an inert one.
        let haiku = chat.models.iter().find(|m| m.label == "Haiku 4.5").expect("haiku present");
        assert!(haiku.effort_levels.is_empty());

        // The four permission modes, spelled exactly as --permission-mode takes.
        let modes: Vec<&str> = chat.modes.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(modes, vec!["default", "acceptEdits", "plan", "bypassPermissions"]);

        // The five measured effort levels.
        let levels: Vec<&str> = chat.effort.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(levels, vec!["low", "medium", "high", "xhigh", "max"]);
        assert!(chat.effort.iter().all(|e| !e.args.is_empty()), "an effort level must carry args");
    }

    /// pi and opencode stay PTY-only, and that has to be true of what ships,
    /// not just of the loader.
    #[test]
    fn the_other_bundled_adapters_declare_no_chat_transport() {
        for (source, text) in [("bundled:pi", BUILTIN_PI), ("bundled:opencode", BUILTIN_OPENCODE)] {
            let a = load_adapter_str(text, source).expect("parses");
            assert!(a.chat.is_none(), "{source} must stay PTY-only");
        }
    }

    /// Emit the resolved bundled adapters for `src/utils/agents.test.ts`.
    ///
    /// `agents.ts` keeps a hand-maintained `FALLBACK_AGENTS` list so the first
    /// paint (before `list_agents` resolves) and a failed `invoke` both look
    /// like the real registry. Hand-maintained is exactly how it goes stale, so
    /// the TS test compares it against this file rather than against nothing.
    /// Serialized by the same `Serialize` impl `list_agents` uses, so it is the
    /// real wire shape, not a restatement of it.
    #[test]
    fn emit_bundled_adapters_for_the_typescript_fallback() {
        let mut adapters: Vec<AgentAdapter> = [
            ("bundled:claude", BUILTIN_CLAUDE),
            ("bundled:pi", BUILTIN_PI),
            ("bundled:opencode", BUILTIN_OPENCODE),
        ]
        .into_iter()
        .map(|(source, text)| load_adapter_str(text, source).expect("bundled adapter parses"))
        .collect();
        adapters.sort_by(|a, b| a.id.cmp(&b.id));

        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("dev/fixtures/agents");
        std::fs::create_dir_all(&dir).expect("create fixture dir");
        let json = serde_json::to_string_pretty(&adapters).expect("serialize adapters");
        std::fs::write(dir.join("bundled.json"), format!("{json}\n")).expect("write adapters");
    }

    /// `as_str` is compiler-enforced exhaustive, but `ALL` is not: a member
    /// missing from it would make that transport unreachable from TOML with no
    /// error anywhere. This is the check that turns that silent hole loud.
    #[test]
    fn every_transport_round_trips_through_its_wire_string() {
        for t in ChatTransport::ALL {
            assert_eq!(
                ChatTransport::from_str(t.as_str()),
                Some(t),
                "{t:?} does not parse back from its own wire string"
            );
        }
        assert!(ChatTransport::from_str("made_up_transport").is_none());
    }

    /// An adapter can express a mode or effort level two ways, so the
    /// precedence has to be pinned or Phase 6 and Phase 9 will each pick one.
    #[test]
    fn an_entrys_own_args_win_over_the_table_template() {
        let a = load_adapter_str(&v2_with_chat(CHAT_TABLE), "test").expect("parses");
        let chat = a.chat.unwrap();
        // `plan` declares its own args, so those are used verbatim.
        assert_eq!(
            chat.mode_args_for("plan"),
            Some(vec!["--permission-mode".to_string(), "plan".to_string()])
        );
        assert_eq!(
            chat.effort_args_for("low"),
            Some(vec!["--effort".to_string(), "low".to_string()])
        );
        // An unknown id resolves to nothing rather than sending a filled
        // template for a mode the adapter never declared.
        assert_eq!(chat.mode_args_for("not_a_mode"), None);
        assert_eq!(chat.effort_args_for("not_a_level"), None);
        assert_eq!(chat.model_args_for("not_a_model"), None);
    }

    /// The other half of the rule: an entry with no args of its own falls back
    /// to the table template filled with its id.
    #[test]
    fn an_entry_without_args_falls_back_to_the_filled_template() {
        let chat_toml = CHAT_TABLE
            .replacen("args = [\"--permission-mode\", \"plan\"]", "", 1)
            .replacen("args = [\"--effort\", \"low\"]", "", 1);
        let a = load_adapter_str(&v2_with_chat(&chat_toml), "test").expect("parses");
        let chat = a.chat.unwrap();
        assert_eq!(
            chat.mode_args_for("plan"),
            Some(vec!["--permission-mode".to_string(), "plan".to_string()]),
            "the {{mode}} template should have been filled with the entry id"
        );
        assert_eq!(
            chat.effort_args_for("low"),
            Some(vec!["--effort".to_string(), "low".to_string()])
        );
    }

    /// Models carry no per-entry override, so the template is the only source,
    /// but the resolver still gates on the model being declared.
    #[test]
    fn model_args_come_from_the_template_for_a_declared_model() {
        let claude = load_adapter_str(BUILTIN_CLAUDE, "bundled:claude").expect("parses");
        let chat = claude.chat.unwrap();
        assert_eq!(
            chat.model_args_for("claude-opus-5"),
            Some(vec!["--model".to_string(), "claude-opus-5".to_string()])
        );
    }

    /// The bundled adapter states both forms, so the two must agree - a
    /// mismatch there would make the precedence rule observable as a bug.
    #[test]
    fn the_bundled_adapters_two_forms_agree() {
        let claude = load_adapter_str(BUILTIN_CLAUDE, "bundled:claude").expect("parses");
        let chat = claude.chat.unwrap();
        for m in &chat.modes {
            assert_eq!(
                chat.mode_args_for(&m.id),
                Some(apply_chat_template(&chat.mode_args, &[("mode", m.id.as_str())])),
                "mode `{}` states args that differ from the table template",
                m.id
            );
        }
        for e in &chat.effort {
            assert_eq!(
                chat.effort_args_for(&e.id),
                Some(apply_chat_template(&chat.effort_args, &[("effort", e.id.as_str())])),
                "effort level `{}` states args that differ from the table template",
                e.id
            );
        }
    }

    #[test]
    fn chat_templates_substitute_their_own_placeholder_set() {
        let args = vec!["--model".to_string(), "{model}".to_string(), "--effort".to_string(), "{effort}".to_string()];
        assert_eq!(
            apply_chat_template(&args, &[("model", "claude-opus-5"), ("effort", "xhigh")]),
            vec!["--model", "claude-opus-5", "--effort", "xhigh"]
        );
    }

    #[test]
    fn partial_override_names_every_missing_field() {
        let err = load_adapter_str("schema_version = 1\nid = \"x\"\n", "test").unwrap_err();
        for field in ["label", "launch", "discovery", "parser", "running"] {
            assert!(err.contains(field), "error should name missing field `{field}`: {err}");
        }
    }

    #[test]
    fn unknown_parser_kind_is_rejected() {
        let text = VALID_MINIMAL.replacen("kind = \"claude_jsonl\"", "kind = \"made_up_kind\"", 1);
        let err = load_adapter_str(&text, "test").unwrap_err();
        assert!(err.contains("made_up_kind"), "error should name the bad kind: {err}");
    }

    /// ADAPTERS.md's complete example (a from-scratch `gemini` adapter) is not
    /// just illustrative prose - it must actually validate, so the doc can't
    /// silently drift from what the loader accepts.
    #[test]
    fn adapters_md_example_parses() {
        let doc = include_str!("../../ADAPTERS.md");
        let heading = "## Example: a from-scratch third-party adapter";
        let after_heading =
            doc.find(heading).expect("ADAPTERS.md must document a complete example") + heading.len();
        let rest = &doc[after_heading..];
        let fence_start =
            rest.find("```toml").expect("the example section must have a ```toml block") + "```toml".len();
        let fence_end = rest[fence_start..].find("```").expect("unterminated ```toml fence") + fence_start;
        let example = rest[fence_start..fence_end].trim();

        let a = load_adapter_str(example, "ADAPTERS.md example").expect("the example TOML should parse");
        assert_eq!(a.id, "gemini");
        assert_eq!(a.parser_kind, ParserKind::ClaudeJsonl);
    }

    #[test]
    fn apply_template_substitutes_placeholders() {
        let resume = vec!["--resume".to_string(), "{id}".to_string()];
        assert_eq!(apply_template(&resume, "abc", ""), vec!["--resume", "abc"]);
        let session = vec!["--session".to_string(), "{file}".to_string()];
        assert_eq!(
            apply_template(&session, "", "/path/to/file.jsonl"),
            vec!["--session", "/path/to/file.jsonl"]
        );
    }
}
