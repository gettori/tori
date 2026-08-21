// Agent adapter registry: what used to be per-agent string branches scattered
// through sessions.rs is now data. One adapter ships bundled
// (agents/claude.toml, embedded at compile time); a user can add or
// whole-replace an adapter by dropping a
// `schema_version = 1`, `= 2` or `= 3` TOML file into `~/.config/sway/agents/`.
// See ADAPTERS.md for the schema. Every version so far is purely additive: v2
// adds the optional `[chat]` table describing how to drive the agent as a
// structured chat session rather than a PTY, and v3 adds the optional
// `[accounts]` table describing how it signs in and whether it can hold more
// than one account at once. An older file loads unchanged, reporting `None` for
// the tables it predates.
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
pub const SCHEMA_VERSION: u32 = 3;

/// Every schema version this build still loads.
///
/// Old versions stay supported deliberately: a user adapter in
/// `~/.config/sway/agents/` is somebody's working config, and each version so
/// far adds only an optional table, so there is nothing an older file needs to
/// say differently. It loads exactly as before, reporting `None` for the tables
/// it predates.
/// The **length** is tied to [`SCHEMA_VERSION`] rather than the contents, which
/// makes the next bump a compiler error instead of a judgement call: raise
/// `SCHEMA_VERSION` to 4 and this array is declared `[u32; 4]` while still
/// holding three entries, so the build stops until the new version is listed.
/// Writing `[1, 2, SCHEMA_VERSION]` would look like it derives itself and would
/// quietly become `[1, 2, 4]`, dropping v3 support with no error anywhere.
pub const SUPPORTED_SCHEMA_VERSIONS: [u32; SCHEMA_VERSION as usize] = [1, 2, 3];

/// The version each optional table was introduced in.
///
/// Per-table rather than compared against [`SCHEMA_VERSION`], which is the bug
/// this pair exists to prevent: gating `[chat]` on "the newest version" was
/// correct only while v2 *was* the newest, and would have started rejecting
/// every working v2 adapter the moment v3 landed. A table's minimum is a fact
/// about that table and never moves again.
const CHAT_MIN_VERSION: u32 = 2;
const ACCOUNTS_MIN_VERSION: u32 = 3;

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
    /// The Agent Client Protocol over a child's stdio, driven by the
    /// `agent-client-protocol` crate. Unlike `ClaudeStreamJson` this is not one
    /// vendor's wire format: every agent speaking ACP first-party reaches Sway
    /// through this one transport plus its own TOML.
    Acp,
}

impl ChatTransport {
    /// Every transport, so `from_str` can be derived from `as_str` instead of
    /// repeating the wire strings in a second, independently-drifting list.
    pub const ALL: [ChatTransport; 2] = [Self::ClaudeStreamJson, Self::Acp];

    /// Parse a `chat.transport` value. Derived from `as_str`, so a wire string
    /// cannot mean one thing when read and another when written.
    fn from_str(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == s)
    }

    /// The wire spelling of this transport.
    ///
    /// One of the **two exhaustive matches** over the enum in the tree; the
    /// other is `make_transport` in `chat/commands.rs`. This one is the
    /// serialization side and that one is the dispatch side, so between them a
    /// new transport has exactly two compiler-named obligations: a wire string
    /// nobody can spell two ways, and an implementation that must exist before
    /// a TOML can select it. Measured when `Acp` was added: exactly those two
    /// E0004s and no others.
    ///
    /// The compiler covers this arm, but it cannot see `ALL`: a new member left
    /// out of that list would parse as unknown and the transport would be
    /// silently unreachable from TOML. `every_transport_round_trips_through_its_wire_string`
    /// is what catches that, so adding a transport means the variant, an `ALL`
    /// entry, this arm, and the factory's.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeStreamJson => "claude_stream_json",
            Self::Acp => "acp",
        }
    }

    /// Does this transport reach its sessions through the protocol rather than
    /// through files on disk?
    ///
    /// The question decides whether an adapter may omit `[discovery]`,
    /// `[parser]` and `[running]`. A agent whose transcripts are files needs
    /// all three; one that mints session ids inside the protocol and keeps them
    /// somewhere only the protocol reaches has nothing true to put in any of
    /// them (see [`AgentAdapter::discovery`]).
    ///
    /// Exhaustive on purpose, and the third such match over the enum: a new
    /// transport has to say which kind it is rather than inheriting an answer.
    pub fn sessions_over_protocol(&self) -> bool {
        match self {
            Self::ClaudeStreamJson => false,
            Self::Acp => true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParserKind {
    ClaudeJsonl,
}

impl ParserKind {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "claude_jsonl" => Some(Self::ClaudeJsonl),
            _ => None,
        }
    }
}

/// How to read the answer a agent gives when asked who is signed in.
///
/// Closed, like [`ParserKind`] and [`ChatTransport`], because there is no
/// generic shape to fall back to. All three were measured on 2026-08-14 against
/// the CLIs named in each adapter's `verified_against`, signed in and signed
/// out, and no two of them answer the same way:
///
///   * `claude auth status` writes JSON to stdout and exits 0 or 1.
///   * `codex login status` writes prose to *stderr* and says everything in its
///     exit code.
///   * `opencode auth list` exits **0 either way** and puts the answer in a
///     box-drawn table's last line.
///
/// That third one is why an adapter cannot simply be assumed to use its exit
/// code: doing so would report OpenCode signed in while it holds no credentials
/// at all. Guessing wrong here produces a confident false positive, so the kind
/// is declared per adapter and the loader refuses probe args without one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WhoamiKind {
    /// A JSON object carrying `loggedIn`, and optionally `email` and
    /// `apiKeySource`.
    ClaudeJson,
    /// The exit status is the whole answer: zero is signed in.
    ExitCode,
    /// A `N credentials` count in OpenCode's own table output.
    OpencodeCredentials,
}

impl WhoamiKind {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "claude_json" => Some(Self::ClaudeJson),
            "exit_code" => Some(Self::ExitCode),
            "opencode_credentials" => Some(Self::OpencodeCredentials),
            _ => None,
        }
    }
}

/// Where an adapter's sessions live and how to find them.
///
/// One variant, and an enum rather than a struct on purpose: a backend that is
/// not a directory of per-session files (a shared database, say) has to declare
/// itself here, and every reader has to answer for it, rather than being smuggled
/// in as a specially-shaped path.
#[derive(Debug, Clone)]
pub enum Discovery {
    File { dir: PathBuf, filename_regex: Regex },
}

/// Something Sway knows about a model, keyed by the id the agent names it by.
///
/// **Not a model list, and the distinction is the whole point.** An adapter used
/// to declare `[[chat.models]]`: a hand-maintained table that was the picker's
/// fallback and the context meter's pre-first-turn denominator. It was wrong in
/// both jobs. Sonnet 5 and Opus 5 both said 200k while the agent reported 1M
/// for each, and a session that never handshook offered four models the CLI had
/// no say in. A model Sway names is a claim Sway cannot back.
///
/// So an annotation only ever **decorates a model the agent itself named**. It
/// contributes nothing to any list: an entry whose id no catalogue mentions
/// renders nothing at all, and there is deliberately no code path that turns one
/// of these into a picker row.
///
/// One field, because there is exactly one thing in this category. Everything
/// else the old table carried (label, window, effort levels, thinking, images)
/// is something the agent says better, and now does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatAnnotation {
    pub id: String,
    /// Whether this model has a fast mode to toggle.
    ///
    /// Sway's own claim, and the one thing here that has to be: the live
    /// catalogue carries no flag for it, and the only signal the CLI gives is
    /// the `/fast` command describing itself as "Toggle fast mode (Opus 5)".
    #[serde(default)]
    pub fast_mode: bool,
}

/// What a requested mode resolved to, and what it displaced if anything.
///
/// `downgraded_from` is `Some` exactly when the session is not running the mode
/// that was asked for, which is the one case the user has to be told about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMode {
    pub id: String,
    pub downgraded_from: Option<String>,
}

/// A permission mode and the args that select it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMode {
    pub id: String,
    pub label: String,
    /// One line on what this mode does, rendered on the menu row.
    ///
    /// Claude's are the CLI's own wording, read out of the `--permission-mode`
    /// description it embeds, rather than paraphrased: a mode is a statement
    /// about what the agent may do unattended, and that is the wrong place to
    /// improvise.
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// A per-model capability this mode needs, named as the live catalogue
    /// names it (`supportsAutoMode`). A model that does not declare it does not
    /// get the row.
    ///
    /// Declared rather than keyed on the mode's id, because the gate is not a
    /// property of the *word* "auto": another agent could gate a differently
    /// named mode on a differently named flag, and hardcoding the pair here
    /// would be one more Claude-shaped assumption in a neutral resolver.
    ///
    /// Measured on claude 2.1.220: `--permission-mode auto` on a model without
    /// `supportsAutoMode` exits 0 and silently reports `permissionMode` as
    /// `default`. Nothing on the wire objects, so the gate has to be here.
    #[serde(default)]
    pub requires: Option<String>,
    /// This mode runs tools without asking anybody.
    ///
    /// A fact about the **agent's** mode, not about Sway, which is what makes
    /// it survivable where its predecessor was not: `permissive_caveat` declared
    /// that Sway asked anyway, and was retired when that stopped being true.
    /// Adapter-declared rather than keyed on `"bypassPermissions"`, because a
    /// agent calling the same thing `yolo` is describing the same thing.
    #[serde(default)]
    pub permissive: bool,
    /// The mode a session runs when nothing else is chosen, and what an
    /// unresolvable mode downgrades to.
    ///
    /// Declared rather than assumed: Sway used to fall back to the literal
    /// `"default"`, which is Claude's spelling and nobody else's. Gemini's
    /// permissive-by-omission mode is also called `default`, but Codex's
    /// profiles are named at runtime and need not include that word at all.
    #[serde(default, rename = "default")]
    pub is_default: bool,
}

/// What a measurement of an unadvertised effort level found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffortExtraState {
    /// An observable moved for it. Renders as a pickable level.
    Working,
    /// The CLI said no, in its own words. Renders disabled, carrying the note.
    Refused,
}

/// A level `--effort` accepts that the agent's own catalogue never lists.
///
/// The effort counterpart of [`ChatAnnotation`] and deliberately **not** a field
/// on it: a fast mode is a property of one model, an accepted flag value is a
/// property of the binary. Measured on 2.1.237, `--effort ultracode` is taken on
/// every model that has effort at all, so keying it by model id would mean
/// re-listing every model on every release to keep one CLI-wide fact true. That
/// is the hand-maintained manifest `[[chat.models]]` was retired for.
///
/// It adds a **level, never a model**: a row renders only on a model whose own
/// catalogue entry already publishes effort levels, so this contributes nothing
/// to any list an agent did not already have.
///
/// `measured_on` is what makes shipping a claim the CLI does not advertise
/// survivable. The claim is scoped to the binary it was measured against and
/// degrades to disabled-with-note against any other, rather than quietly staying
/// true. `dev/effort-probe.mjs` re-takes the measurement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatEffortExtra {
    pub id: String,
    pub label: String,
    pub state: EffortExtraState,
    /// The `--version` string the measurement was taken against, verbatim.
    pub measured_on: String,
    /// Why it is refused, in the agent's own words. Empty for a working level.
    #[serde(default)]
    pub note: String,
}

/// The resolved `[chat]` table: everything needed to start and steer a
/// structured chat session for this adapter.
///
/// Arg templates rather than hardcoded flags, so a second agent is a TOML
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
    /// `{from}`/`{id}` template replaying an existing session into a **new**
    /// one. Two placeholders because a fork is the one case where the session
    /// being read and the session being written are different ids. Empty for an
    /// adapter that cannot fork, which is what hides the action rather than
    /// offering one that would silently resume in place.
    pub fork_args: Vec<String>,
    /// `{model}` template.
    pub model_args: Vec<String>,
    /// `{effort}` template, filled with whatever level the catalogue named.
    /// See `ChatConfig::effort_args_for`.
    pub effort_args: Vec<String>,
    /// `{mode}` template, the **default** for every `[[chat.modes]]` entry.
    /// See `ChatConfig::mode_args_for`.
    pub mode_args: Vec<String>,
    /// `{dir}` template, applied once per extra directory.
    pub add_dir_args: Vec<String>,
    /// What Sway knows about individual models, never what models exist. See
    /// [`ChatAnnotation`].
    pub annotations: Vec<ChatAnnotation>,
    /// Effort levels Sway measured that this agent never advertises. See
    /// [`ChatEffortExtra`]. Empty for every agent nobody has measured, which is
    /// all of them but claude.
    pub effort_extras: Vec<ChatEffortExtra>,
    /// This agent's model names carry a `Provider/Name` path (measured on
    /// opencode and pi), and the picker may unpick it for display. Opt-in per
    /// adapter because it is a naming convention, not a protocol fact: applied
    /// blindly, a `/` or `:` in an honest model name would be mangled. Display
    /// only; the id on the wire is never rewritten.
    pub split_model_names: bool,
    pub modes: Vec<ChatMode>,
    /// How this agent departs from a spec-correct ACP client. Always present
    /// and at its defaults for a transport that is not ACP, where it is inert:
    /// a per-transport option table would make the common case pay for the
    /// uncommon one.
    pub acp: crate::chat::acp::AcpOverrides,
}

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
    /// hatch for a agent whose modes are not one flag with a varying value.
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

    /// The mode this adapter runs when nothing else is chosen.
    ///
    /// The `default = true` marker when one is set, else the first declared
    /// mode. Falling back to *position* rather than to the literal `"default"`
    /// keeps the Claude spelling out of a neutral resolver: an adapter that
    /// forgot the marker still gets a real mode of its own, not one named after
    /// another agent's vocabulary.
    pub fn default_mode(&self) -> Option<&ChatMode> {
        self.modes.iter().find(|m| m.is_default).or_else(|| self.modes.first())
    }

    /// Which mode a session will actually run, given what was asked for.
    ///
    /// **A mode Sway cannot resolve downgrades; it never fails the spawn.** The
    /// requested id reaches here from a settings file that outlived the adapter
    /// that declared it - a mode removed from the TOML, or a project pinned to
    /// one a different agent offered. Refusing to start would strand that
    /// session permanently behind a file the user cannot see, and the failure
    /// would arrive as a dead child rather than as an explanation.
    ///
    /// Returns the id to run and, when it is not the one asked for, the one
    /// that was. The caller says so; this only decides.
    pub fn resolve_mode(&self, requested: Option<&str>) -> Option<ResolvedMode> {
        // A declared mode is itself. Anything else - an id the adapter dropped,
        // or no request at all - lands on the default, and only a request that
        // was displaced counts as a downgrade worth reporting.
        if let Some(id) = requested.filter(|id| self.modes.iter().any(|m| &m.id == id)) {
            return Some(ResolvedMode { id: id.to_string(), downgraded_from: None });
        }
        self.default_mode().map(|m| ResolvedMode {
            id: m.id.clone(),
            downgraded_from: requested.map(str::to_string),
        })
    }

    /// The args that select `effort_id`, or `None` for an adapter that does not
    /// spell effort as args at all.
    ///
    /// **Any level fills the template**, which is the whole point and the same
    /// correction `model_args_for` already took. This used to require the id to
    /// appear in a `[[chat.effort]]` table of five, so a level the agent named
    /// and the table had not caught up with produced no `--effort` flag: the
    /// session ran at the CLI's default while the pill displayed the level that
    /// had been picked, with nothing anywhere to contradict it. The catalogue the
    /// level came from is the check, exactly as it is for a model.
    ///
    /// `None` is an adapter with no template, which is not a dropped flag: an
    /// ACP agent's levels are a session option it publishes and Sway sets after
    /// open, so there is no argv for them to ride in the first place.
    pub fn effort_args_for(&self, effort_id: &str) -> Option<Vec<String>> {
        if self.effort_args.is_empty() {
            return None;
        }
        Some(apply_chat_template(&self.effort_args, &[("effort", effort_id)]))
    }

    /// The args that select `model_id`. Models have no per-entry override, so
    /// this is just the template, but it is exposed alongside the other two so
    /// a caller never reaches past the resolver for one of the three.
    ///
    /// **Any id fills the template.** This used to require the id to appear in
    /// `[[chat.models]]`, which turned a hand-maintained table into a gate on
    /// what the user could run: a model the CLI offered but the TOML had not
    /// caught up with produced no `--model` flag and silently started the
    /// session on something else. The catalogue the id came from is the check,
    /// and it is a better one.
    pub fn model_args_for(&self, model_id: &str) -> Option<Vec<String>> {
        Some(apply_chat_template(&self.model_args, &[("model", model_id)]))
    }
}

/// How Sway signs this adapter in, and whether it can hold more than one
/// account at a time.
///
/// Every field is optional because the ladder degrades rather than failing: an
/// adapter with no `login_args` still renders a documentation link, and one
/// with no `whoami_args` reports its sign-in state as unknown rather than as
/// signed out. What is *not* optional is the coherence rule the loader
/// enforces: claiming `supports_isolation` without naming a `home_env` is
/// rejected, because there would be no mechanism behind the claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccountsConfig {
    /// The environment variable that points this agent at an isolated profile
    /// home, e.g. `CLAUDE_CONFIG_DIR`. The **default profile is this variable
    /// left unset**, which is what makes it resolve the user's existing login
    /// rather than a Sway-managed copy of it.
    pub home_env: Option<String>,
    /// Where `home_env` points when it is left unset: the agent's own default
    /// home, `~/.claude` for claude.
    ///
    /// Discovery uses it as a hinge. Phase 0 measured that an isolated home
    /// reproduces the default layout exactly (`projects/<slugified-cwd>/…`), so
    /// a profile's transcript root is `[discovery] dir` with this prefix swapped
    /// for the profile home. Two declared paths rather than a declared suffix,
    /// because the suffix is then derived and a `dir` that does not sit under
    /// this home yields no root at all rather than a guessed one.
    ///
    /// Backend-only, like `discovery` itself: it names a directory to scan, and
    /// the frontend scans nothing.
    #[serde(skip)]
    pub home_default: Option<PathBuf>,
    /// Args that start an interactive login. Run in a real PTY tab, never
    /// captured: measured in Phase 0, `claude auth login` is browser OAuth with
    /// no non-interactive variant, so anything that tried to complete a login
    /// headlessly would hang instead of failing.
    pub login_args: Vec<String>,
    /// Args that sign the profile out. Empty for a agent that offers no
    /// logout, which is a state the removal flow has to say out loud rather
    /// than paper over: tokens stay valid until they expire.
    pub logout_args: Vec<String>,
    /// Args for a bounded, non-interactive "who is signed in here" probe.
    pub whoami_args: Vec<String>,
    /// How to read what those args print. `None` exactly when `whoami_args` is
    /// empty, which the loader enforces: probe args with no declared shape would
    /// have to be read by guessing, and the measured shapes disagree about
    /// everything including whether the exit code means anything.
    pub whoami_kind: Option<WhoamiKind>,
    /// Whether this adapter can hold two accounts at once without them
    /// clobbering each other.
    ///
    /// Defaults to `false`, and the default is the point: an adapter is not
    /// isolable until somebody has measured that it is. Claude on darwin earned
    /// its `true` in Phase 0 by holding two simultaneous logins in separate
    /// Keychain items, keyed by config dir. An adapter that merely *has* a home
    /// env may still share one credential store behind it, in which case adding
    /// a second account would silently sign the first one out.
    pub supports_isolation: bool,
}

/// One command that installs the agent, exactly as the vendor documents it.
///
/// A program plus args rather than a shell line, because it is spawned directly
/// (`kind: "command"` in the PTY tab): no shell means no quoting surprises, and
/// the tab stays put on failure so "npm: command not found" is readable rather
/// than a vanished window.
///
/// The update and uninstall verbs share the table and its program: every
/// package manager worth declaring spells all three as arguments to one
/// binary. Either arg list empty means that verb is undeclared, which renders
/// as no button rather than a guessed command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallSpec {
    pub program: String,
    pub args: Vec<String>,
    pub update_args: Vec<String>,
    pub uninstall_args: Vec<String>,
}

/// A resolved, validated adapter. The frontend gets a mirrored subset of this
/// via `list_agents` (the regex/path fields stay backend-only).
#[derive(Debug, Clone, Serialize)]
pub struct AgentAdapter {
    pub id: String,
    pub label: String,
    /// A `PICKER_ICONS` name (the set the space picker draws from), or `None`
    /// for an adapter that names no glyph - the cards fall back to the label's
    /// first letter, which is what every adapter looked like before this.
    ///
    /// Optional scalar rather than a version-gated table: the gates exist for
    /// `[chat]` and `[accounts]`, whose absence changes what Sway can *do*, and
    /// a missing icon changes only what it looks like. The cost of not bumping
    /// is that a v3 file carrying `icon` is rejected by a build that predates
    /// the key, which is the same trade every additive key here has taken.
    pub icon: Option<String>,
    pub program: String,
    pub base_args: Vec<String>,
    pub yolo_args: Vec<String>,
    /// `{id}`/`{file}` placeholder template; `apply_template` substitutes.
    pub resume_args: Vec<String>,
    /// Where this adapter's sessions are on disk, or `None` for a agent whose
    /// sessions only its protocol reaches.
    ///
    /// The three file-era fields (`discovery`, `parser_kind`, `running_pattern`)
    /// are absent together or present together, which the loader enforces: they
    /// are one fact about an adapter, not three independent ones. An ACP agent
    /// mints its session id inside `session/new`, puts it on no command line and
    /// keeps the conversation somewhere only `session/load` reaches, so no
    /// directory-and-regex describes its sessions, no parser kind has anything
    /// to parse, and a `pgrep` pattern would match every session of that agent
    /// at once (measured in Phase 5: two sessions of one ACP agent are two
    /// identical command lines). Declaring plausible values would be worse than
    /// declaring none: a wrong liveness pattern reports a live session dead or a
    /// dead one live.
    #[serde(skip)]
    pub discovery: Option<Discovery>,
    pub parser_kind: Option<ParserKind>,
    /// ERE template (for `pgrep -f`) with an `{id}` placeholder.
    pub running_pattern: Option<String>,
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
    /// captured against (e.g. `"claude 2.1.220"`), echoed in ADAPTERS.md.
    /// Optional: not every adapter carries one.
    pub verified_against: Option<String>,
    /// The `[chat]` table, or `None` for an adapter with no chat transport.
    ///
    /// `None` is the normal case, not a degraded one: a PTY-only adapter is
    /// fully functional that way, and every v1 adapter reports `None` without
    /// changing behaviour.
    pub chat: Option<ChatConfig>,
    /// The `[accounts]` table, or `None` for an adapter that declares no
    /// sign-in of its own.
    ///
    /// `None` is not "signed out": it is "Sway has nothing true to say about
    /// this adapter's accounts", which is why it renders no account controls at
    /// all rather than an inert set.
    pub accounts: Option<AccountsConfig>,
    /// The `[install]` table: the vendor's own documented install command, run
    /// in a visible PTY tab by `crate::install`. `None` renders instructions
    /// instead of a button. Backend-only, like `discovery`: the frontend asks
    /// `agent_install_route` rather than mirroring the raw command.
    #[serde(skip)]
    pub install: Option<InstallSpec>,
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
    #[serde(default)]
    icon: Option<String>,
    launch: LaunchToml,
    /// Absent together for a protocol-backed adapter; see
    /// [`AgentAdapter::discovery`]. Optional here rather than required so the
    /// combination can be validated as one rule with an error that names what a
    /// partial declaration is missing.
    #[serde(default)]
    discovery: Option<DiscoveryToml>,
    #[serde(default)]
    parser: Option<ParserToml>,
    #[serde(default)]
    running: Option<RunningToml>,
    #[serde(default)]
    capabilities: CapabilitiesToml,
    #[serde(default)]
    verified_against: Option<String>,
    #[serde(default)]
    chat: Option<ChatToml>,
    #[serde(default)]
    accounts: Option<AccountsToml>,
    #[serde(default)]
    install: Option<InstallToml>,
}

/// `[install]`. Strict like `[accounts]` and for the same reason: a silently
/// dropped key here would run a different command than the file's author wrote.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallToml {
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    update_args: Vec<String>,
    #[serde(default)]
    uninstall_args: Vec<String>,
}

/// `[accounts]`, v3's addition.
///
/// `deny_unknown_fields` rather than serde's default silence, per
/// `gotchas#serde ignores unknown fields, so a version field alone cannot gate
/// a format`. A version number only gates a format when the parser also refuses
/// keys it does not know: without this, a future `[accounts]` key would be
/// dropped without a word by every build that predates it, and an adapter
/// declaring a safety-relevant field (`supports_isolation` under some later
/// spelling) would read as its permissive default. Here the cost of strictness
/// is one loud error naming the key; the cost of silence is an account sharing
/// a home nobody meant it to share.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AccountsToml {
    #[serde(default)]
    home_env: Option<String>,
    #[serde(default)]
    home_default: Option<String>,
    #[serde(default)]
    login_args: Vec<String>,
    #[serde(default)]
    logout_args: Vec<String>,
    #[serde(default)]
    whoami_args: Vec<String>,
    #[serde(default)]
    whoami_kind: Option<String>,
    #[serde(default)]
    supports_isolation: bool,
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
    fork_args: Vec<String>,
    #[serde(default)]
    model_args: Vec<String>,
    #[serde(default)]
    effort_args: Vec<String>,
    #[serde(default)]
    mode_args: Vec<String>,
    #[serde(default)]
    add_dir_args: Vec<String>,
    #[serde(default)]
    annotations: Vec<ChatAnnotation>,
    #[serde(default)]
    effort_extras: Vec<ChatEffortExtra>,
    #[serde(default)]
    split_model_names: bool,
    #[serde(default)]
    modes: Vec<ChatMode>,
    /// `[chat.acp]`, the per-agent departures from a spec-correct ACP client.
    #[serde(default)]
    acp: crate::chat::acp::AcpOverrides,
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
    /// Required when `backend = "file"` (the default, and the only one today).
    dir: Option<String>,
    /// Required when `backend = "file"`.
    filename_pattern: Option<String>,
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

/// What every adapter must declare, whatever it is.
///
/// `discovery`, `parser` and `running` are *not* here: they are required for a
/// file-backed adapter and meaningless for a protocol-backed one, so the rule
/// they obey is a combination rather than a per-key requirement and lives in
/// [`check_session_plumbing`].
const REQUIRED_TOP_LEVEL: [&str; 4] = ["schema_version", "id", "label", "launch"];
const KNOWN_TOP_LEVEL: [&str; 13] = [
    "schema_version",
    "id",
    "label",
    "icon",
    "launch",
    "discovery",
    "parser",
    "running",
    "capabilities",
    "verified_against",
    "chat",
    "accounts",
    "install",
];

/// Are `[discovery]`, `[parser]` and `[running]` declared in a combination this
/// adapter is allowed to declare?
///
/// Three outcomes, and the middle one is the reason this is a function rather
/// than three `Option`s left to the reader:
///
///   * **All three present.** A file-backed adapter, which is every v1 adapter
///     and every Claude-shaped one. Always allowed.
///   * **All three absent.** Only allowed when `[chat]` names a transport whose
///     sessions come over the protocol. Otherwise the adapter could list no
///     sessions at all and would look, from the outside, exactly like an agent
///     the user has never run.
///   * **Some present.** Always an error, naming the missing ones. This is the
///     case worth the code: a typo in `[[discovery]]` or a table accidentally
///     nested under `[chat]` would otherwise turn a working Claude-shaped
///     adapter into a silent protocol adapter whose sessions stop appearing.
fn check_session_plumbing(raw: &AdapterToml, source: &str) -> Result<(), String> {
    let declared: [(&str, bool); 3] = [
        ("discovery", raw.discovery.is_some()),
        ("parser", raw.parser.is_some()),
        ("running", raw.running.is_some()),
    ];
    let missing: Vec<&str> =
        declared.iter().filter(|(_, present)| !present).map(|(k, _)| *k).collect();

    if missing.is_empty() {
        return Ok(());
    }

    if missing.len() < declared.len() {
        return Err(format!(
            "{source}: missing required field(s): {} (an adapter that declares any of \
             discovery/parser/running must declare all three)",
            missing.join(", ")
        ));
    }

    let over_protocol = raw
        .chat
        .as_ref()
        .and_then(|c| ChatTransport::from_str(&c.transport))
        .is_some_and(|t| t.sessions_over_protocol());
    if over_protocol {
        return Ok(());
    }

    let protocol_transports: Vec<&str> = ChatTransport::ALL
        .iter()
        .filter(|t| t.sessions_over_protocol())
        .map(|t| t.as_str())
        .collect();
    Err(format!(
        "{source}: missing required field(s): {} (omit all three only for a \
         chat.transport that reaches its sessions over the protocol: {})",
        missing.join(", "),
        protocol_transports.join(", ")
    ))
}

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

    // Honouring a table in a file that declares a version predating it would
    // make the version number decorative. Named rather than ignored: a
    // silently-dropped table looks exactly like an adapter that simply has no
    // chat surface, or no accounts.
    //
    // Each gate compares against that table's own minimum, never against
    // `SCHEMA_VERSION`. The difference is invisible while only one optional
    // table exists and breaks everything the moment a second one lands: `<
    // SCHEMA_VERSION` would have started rejecting `[chat]` in every v2 adapter
    // on the day v3 shipped, including the four bundled ones.
    for (name, declared, min) in [
        ("chat", raw.chat.is_some(), CHAT_MIN_VERSION),
        ("accounts", raw.accounts.is_some(), ACCOUNTS_MIN_VERSION),
    ] {
        if declared && raw.schema_version < min {
            return Err(format!(
                "{source}: [{name}] requires schema_version >= {min} (this file declares {})",
                raw.schema_version
            ));
        }
    }

    // The three file-era tables stand or fall together, and whether they may be
    // absent at all depends on the chat transport, so the combination is checked
    // before any of them is resolved.
    check_session_plumbing(&raw, source)?;

    let parser_kind = raw
        .parser
        .as_ref()
        .map(|p| {
            ParserKind::from_str(&p.kind).ok_or_else(|| {
                format!("{source}: unknown parser kind `{}` (expected claude_jsonl)", p.kind)
            })
        })
        .transpose()?;

    let discovery = match raw.discovery {
        None => None,
        Some(d) => match d.backend.as_str() {
            "file" => {
                let dir = d.dir.ok_or_else(|| {
                    format!("{source}: discovery.dir is required for backend = \"file\"")
                })?;
                let pattern = d.filename_pattern.ok_or_else(|| {
                    format!(
                        "{source}: discovery.filename_pattern is required for backend = \"file\""
                    )
                })?;
                let filename_regex = Regex::new(&pattern)
                    .map_err(|e| format!("{source}: invalid discovery.filename_pattern: {e}"))?;
                if filename_regex.capture_names().flatten().all(|n| n != "id") {
                    return Err(format!(
                        "{source}: discovery.filename_pattern must have a named `id` capture group"
                    ));
                }
                Some(Discovery::File { dir: expand_tilde(&dir), filename_regex })
            }
            other => {
                return Err(format!(
                    "{source}: unknown discovery.backend `{other}` (expected file)"
                ))
            }
        },
    };

    let chat = raw
        .chat
        .map(|c| -> Result<ChatConfig, String> {
            let transport = ChatTransport::from_str(&c.transport).ok_or_else(|| {
                let known: Vec<&str> = ChatTransport::ALL.iter().map(|t| t.as_str()).collect();
                format!(
                    "{source}: unknown chat.transport `{}` (expected one of {})",
                    c.transport,
                    known.join(", ")
                )
            })?;
            // Nothing here checks a level against a list any more. A model's
            // levels come from the agent's own catalogue and `effort_args` says
            // only how to spell one, for whichever levels that catalogue names.
            Ok(ChatConfig {
                transport,
                program: c.program.unwrap_or_else(|| raw.launch.program.clone()),
                base_args: c.base_args,
                session_id_args: c.session_id_args,
                resume_args: c.resume_args,
                fork_args: c.fork_args,
                model_args: c.model_args,
                effort_args: c.effort_args,
                mode_args: c.mode_args,
                add_dir_args: c.add_dir_args,
                annotations: c.annotations,
                effort_extras: c.effort_extras,
                split_model_names: c.split_model_names,
                modes: c.modes,
                acp: c.acp,
            })
        })
        .transpose()?;

    // Isolation is a claim about a mechanism, so it is rejected without one.
    // The alternative is the failure this whole table exists to prevent: an
    // "add account" action that offers a second profile, sets no environment
    // for it, and lands both accounts in the one home the first was already
    // using - which reads as success right up until the first login signs the
    // second one out.
    let accounts = raw
        .accounts
        .map(|a| {
            if a.supports_isolation && a.home_env.is_none() {
                return Err(format!(
                    "{source}: accounts.supports_isolation = true requires accounts.home_env \
                     (there is no way to isolate a profile without a variable to point at it)"
                ));
            }
            // A second account whose sessions nobody can find is half an
            // account. `home_default` is what turns the declared discovery dir
            // into that profile's own root; without it every profile but the
            // default would sign in fine and then show an empty history.
            // Required only alongside `[discovery]`, because an adapter whose
            // sessions live behind its protocol has no root to relocate.
            if a.supports_isolation && discovery.is_some() && a.home_default.is_none() {
                return Err(format!(
                    "{source}: accounts.supports_isolation = true with a [discovery] table \
                     requires accounts.home_default (the profile's sessions are found by \
                     swapping that prefix on discovery.dir, and there is nothing to swap)"
                ));
            }
            // Probe args and the shape of their answer are one fact, the same
            // way `[discovery]`/`[parser]`/`[running]` are. Args with no kind
            // would leave the reader guessing, and the measured shapes make
            // every guess wrong somewhere: assume the exit code and OpenCode
            // reports signed in while holding no credentials at all.
            let whoami_kind = match (a.whoami_args.is_empty(), a.whoami_kind.as_deref()) {
                (true, None) => None,
                (false, Some(kind)) => Some(WhoamiKind::from_str(kind).ok_or_else(|| {
                    format!("{source}: unknown accounts.whoami_kind `{kind}`")
                })?),
                (false, None) => {
                    return Err(format!(
                        "{source}: accounts.whoami_args needs accounts.whoami_kind \
                         (no two agents report sign-in the same way, so there is \
                         nothing to fall back to)"
                    ))
                }
                (true, Some(kind)) => {
                    return Err(format!(
                        "{source}: accounts.whoami_kind = `{kind}` with no accounts.whoami_args \
                         to produce anything to read"
                    ))
                }
            };
            Ok(AccountsConfig {
                home_env: a.home_env,
                home_default: a.home_default.as_deref().map(expand_tilde),
                login_args: a.login_args,
                logout_args: a.logout_args,
                whoami_args: a.whoami_args,
                whoami_kind,
                supports_isolation: a.supports_isolation,
            })
        })
        .transpose()?;

    // Not version-gated, on the icon precedent: dropping it changes what the
    // page offers, never what a session does. An older build warns and shows
    // instructions instead of a button, which is the pre-[install] behaviour.
    let install = raw
        .install
        .map(|i| {
            if i.program.trim().is_empty() {
                return Err(format!("{source}: install.program must not be empty"));
            }
            Ok(InstallSpec {
                program: i.program,
                args: i.args,
                update_args: i.update_args,
                uninstall_args: i.uninstall_args,
            })
        })
        .transpose()?;

    Ok(AgentAdapter {
        id: raw.id,
        label: raw.label,
        icon: raw.icon,
        program: raw.launch.program,
        base_args: raw.launch.base_args,
        yolo_args: raw.launch.yolo_args,
        resume_args: raw.launch.resume_args,
        discovery,
        parser_kind,
        running_pattern: raw.running.map(|r| r.pattern),
        pty_quiet_ms: raw.capabilities.pty_quiet_ms,
        needs_you: raw.capabilities.needs_you,
        hooks: raw.capabilities.hooks,
        verified_against: raw.verified_against,
        chat,
        accounts,
        install,
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
const BUILTIN_OPENCODE: &str = include_str!("../agents/opencode.toml");
const BUILTIN_GEMINI: &str = include_str!("../agents/gemini.toml");
const BUILTIN_CODEX: &str = include_str!("../agents/codex.toml");
const BUILTIN_COPILOT: &str = include_str!("../agents/copilot.toml");
const BUILTIN_KIMI: &str = include_str!("../agents/kimi.toml");
const BUILTIN_PI: &str = include_str!("../agents/pi.toml");

/// Every adapter compiled into the binary, source label and text.
///
/// One list, because there are two readers: the registry builder and the test
/// that emits the frontend's fallback fixture. Kept apart, a new bundled adapter
/// would reach the app while the fixture the TypeScript fallback is checked
/// against still described the old set - and that check would keep passing.
const BUNDLED: [(&str, &str); 7] = [
    ("bundled:claude", BUILTIN_CLAUDE),
    ("bundled:opencode", BUILTIN_OPENCODE),
    ("bundled:gemini", BUILTIN_GEMINI),
    ("bundled:codex", BUILTIN_CODEX),
    ("bundled:copilot", BUILTIN_COPILOT),
    ("bundled:kimi", BUILTIN_KIMI),
    ("bundled:pi", BUILTIN_PI),
];

fn user_agents_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/agents")
}

/// Bundled built-ins, then every `*.toml` in `user_dir`. A user file whose id
/// matches a built-in whole-replaces it (last insert wins - the entire
/// struct, never a field-by-field merge). A user file that fails validation
/// is never silently swallowed: it's logged loudly (naming the problem) and
/// the id it would have overridden keeps its previous (built-in or
/// earlier-loaded) entry, so one broken file can't make an agent disappear.
///
/// Seven built-ins ship today: one Claude-shaped file adapter and six ACP ones.
/// The loop stays a loop: what makes this a registry is that nothing downstream
/// knows how many adapters there are.
fn build_registry_from(user_dir: &Path) -> Vec<AgentAdapter> {
    let mut by_id: HashMap<String, AgentAdapter> = HashMap::new();

    for (source, text) in BUNDLED {
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
    /// The on-disk location this adapter discovers sessions from. The health
    /// cards report whether it exists, which is the difference between "the
    /// agent is installed but you have never run it" and "something is
    /// misconfigured".
    ///
    /// `None` for a protocol-backed adapter, which has no such location: its
    /// sessions live wherever the agent keeps them, which Sway never reads.
    /// A card showing a path that does not exist would report a
    /// misconfiguration that is really just a different design.
    pub fn discovery_path(&self) -> Option<&Path> {
        match &self.discovery {
            Some(Discovery::File { dir, .. }) => Some(dir),
            None => None,
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
///
/// Test-only for now: every live caller goes through `apply_chat_template`,
/// which takes arbitrary placeholder pairs and so covers this shape too. Kept
/// because the non-chat (terminal) resume path still describes its templates in
/// these two placeholders (see `AgentAdapter::resume_args`); if that path never
/// grows a caller, this and its test can go.
#[cfg(test)]
pub fn apply_template(template: &[String], id: &str, file: &str) -> Vec<String> {
    template.iter().map(|a| a.replace("{id}", id).replace("{file}", file)).collect()
}

/// ERE pattern (for `pgrep -f`) matching a live process resuming session
/// `id`. Falls back to the claude pattern for an unrecognized agent id,
/// matching this function's pre-registry implicit default.
///
/// `None` for an adapter that declares no pattern, which is a protocol-backed
/// one: its sessions are not on any command line, so there is no pattern to
/// return and every caller has to say what it does without one. Returning a
/// pattern that matches nothing, or borrowing Claude's, would answer a question
/// the process table cannot answer for this agent.
pub fn session_pattern(agent: &str, id: &str) -> Option<String> {
    match find(agent).or_else(|| find("claude")) {
        Some(a) => a.running_pattern.as_ref().map(|p| p.replace("{id}", id)),
        // Kept in step with `agents/claude.toml`'s `[running] pattern`: the
        // token run is what makes a chat's command line match, since the chat
        // transport puts its base_args before `--resume`/`--session-id`.
        None => Some(format!("claude ([^ ]+ )*(--resume|-r|--session-id) {id}")),
    }
}

/// The parser kind for `agent`, defaulting to Claude's shape for an
/// unrecognized id (matches the pre-registry implicit `else` branch every
/// transcript-parsing call site used to take).
///
/// `None` for an adapter that declares no parser, whose sessions are not files
/// this build can read. A caller with nothing to parse returns nothing rather
/// than parsing an unrelated format and reporting the empty result as content.
pub fn parser_kind_for(agent: &str) -> Option<ParserKind> {
    match find(agent) {
        Some(a) => a.parser_kind,
        None => Some(ParserKind::ClaudeJsonl),
    }
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

    /// The running pattern has to match every shape that actually drives a
    /// session, and none of the decoys that merely mention its id.
    ///
    /// Pinned because the original pattern silently failed the chat shapes: it
    /// wanted the flag adjacent to the program name, and the chat transport
    /// puts its base_args first. Every guard built on `session_running` (the
    /// worktree-removal count, the delete-group warning, the revert guard's
    /// detached tier, the sidebar status dot) was therefore blind to chats.
    #[test]
    fn the_running_pattern_matches_chat_command_lines_not_just_pty_ones() {
        let claude = load_adapter_str(BUILTIN_CLAUDE, "bundled:claude").expect("claude parses");
        let id = "2e0777d8-a84b-425c-9a71-7b875918dcf1";
        let pattern = claude.running_pattern.as_ref().expect("claude declares a running pattern");
        let re = regex::Regex::new(&pattern.replace("{id}", id)).expect("valid ERE");

        let base = "claude -p --input-format stream-json --output-format stream-json --verbose \
                    --include-partial-messages --include-hook-events";
        for (label, cmdline) in [
            ("PTY agent tab", format!("claude --resume {id}")),
            ("PTY agent tab, short flag", format!("claude -r {id}")),
            // The two the original pattern missed.
            ("a new chat", format!("{base} --session-id {id}")),
            ("a resumed chat", format!("{base} --resume {id}")),
            ("a forked chat", format!("{base} --resume other --fork-session --session-id {id}")),
        ] {
            assert!(re.is_match(&cmdline), "{label} must count as running: {cmdline}");
        }

        for (label, cmdline) in [
            ("a tail on the transcript", format!("tail -f /Users/x/.claude/projects/p/{id}.jsonl")),
            ("an editor with it open", format!("nvim /Users/x/.claude/projects/p/{id}.jsonl")),
            ("a grep for the id", format!("grep -r {id} /Users/x/notes")),
        ] {
            assert!(!re.is_match(&cmdline), "{label} must not count as running: {cmdline}");
        }
    }

    #[test]
    fn bundled_adapters_load_and_validate() {
        let claude = load_adapter_str(BUILTIN_CLAUDE, "bundled:claude").expect("claude parses");
        assert_eq!(claude.id, "claude");
        assert_eq!(claude.program, "claude");
        assert_eq!(claude.parser_kind, Some(ParserKind::ClaudeJsonl));
        assert_eq!(claude.yolo_args, vec!["--dangerously-skip-permissions"]);
        // Empirically confirmed (phase 2): claude genuinely blocks-and-goes-quiet
        // on a permission prompt, so needs-you ships enabled.
        assert!(claude.needs_you);
        // Phase 3: claude's hook-driven status mechanism is verified and wired.
        assert!(claude.hooks);
    }

    /// The registry mechanism is the point, not the count. Seven built-ins ship
    /// and nothing downstream may assume that number.
    ///
    /// What is worth pinning is the *shape spread*: one file-backed adapter and
    /// six protocol-backed ones, so both halves of the loader's session-plumbing
    /// rule are exercised by something that actually ships rather than only by a
    /// fixture.
    #[test]
    fn the_bundled_adapters_cover_both_session_shapes() {
        let reg = build_registry_from(&PathBuf::from("/nonexistent/agents"));
        let mut ids: Vec<&str> = reg.iter().map(|a| a.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["claude", "codex", "copilot", "gemini", "kimi", "opencode", "pi"]);

        let by_id = |id: &str| reg.iter().find(|a| a.id == id).expect("bundled adapter").clone();
        let claude = by_id("claude");
        assert!(claude.discovery.is_some(), "claude discovers sessions from files");
        assert!(claude.parser_kind.is_some());
        assert!(claude.running_pattern.is_some());

        for id in ["opencode", "gemini", "codex", "copilot", "kimi", "pi"] {
            let a = by_id(id);
            assert_eq!(
                a.chat.as_ref().map(|c| c.transport),
                Some(ChatTransport::Acp),
                "{id} is an ACP adapter"
            );
            assert!(a.discovery.is_none(), "{id} has no on-disk discovery");
            assert!(a.parser_kind.is_none(), "{id} has no transcript to parse");
            assert!(a.running_pattern.is_none(), "{id} names no session on its command line");
        }
    }

    /// Gemini ships **unmeasured**, and `verified_against` is how that is said.
    /// Naming a version there would claim a measurement nobody took; the Agents
    /// surface reads its absence to tell a measured agent from an untested one.
    #[test]
    fn an_unmeasured_bundled_adapter_declares_no_verified_version() {
        let reg = build_registry_from(&PathBuf::from("/nonexistent/agents"));
        let find = |id: &str| reg.iter().find(|a| a.id == id).expect("bundled adapter");
        assert_eq!(find("opencode").verified_against.as_deref(), Some("opencode 1.18.3"));
        assert_eq!(find("gemini").verified_against, None);
        // Codex names two versions because two binaries are involved, and the
        // one health.rs compares against `codex --version` has to come first.
        let codex = find("codex").verified_against.clone().expect("codex is measured");
        assert!(codex.starts_with("codex-cli 0.147.0"), "{codex}");
        assert!(codex.contains("codex-acp 1.2.0"), "{codex}");
    }

    /// **Codex is the one adapter whose chat binary is not its launch binary.**
    ///
    /// The PTY tab runs the `codex` a user installed; the chat surface runs the
    /// first-party ACP wrapper, because `codex` has no `acp` subcommand. Pinned
    /// on purpose: an unpinned `npx` would move the agent underneath a
    /// `verified_against` that names a version. Anything comparing adapters by
    /// program has to see past the runner, which is what
    /// `catalog::launch_identity` is for.
    #[test]
    fn codex_drives_chat_through_a_different_binary_than_its_pty_tab() {
        let reg = build_registry_from(&PathBuf::from("/nonexistent/agents"));
        let codex = reg.iter().find(|a| a.id == "codex").expect("codex is bundled");
        assert_eq!(codex.program, "codex");
        let chat = codex.chat.as_ref().expect("codex ships a chat table");
        assert_eq!(chat.program, "npx");
        assert_eq!(chat.base_args, vec!["-y", "@agentclientprotocol/codex-acp@1.2.0"]);
        // Everything else comes off the handshake, so there is nothing to declare.
        assert!(chat.annotations.is_empty(), "nothing to annotate on a agent Sway has not measured");
        assert!(chat.modes.is_empty());
        assert!(chat.effort_extras.is_empty(), "nothing measured on a agent nobody has probed");
    }

    #[test]
    fn sample_user_toml_for_a_new_agent_loads() {
        let a = load_adapter_str(VALID_MINIMAL, "test").expect("valid user adapter parses");
        assert_eq!(a.id, "x");
        assert_eq!(a.resume_args, vec!["--resume", "{id}"]);
        match a.discovery.as_ref().expect("a file-backed adapter declares discovery") {
            Discovery::File { filename_regex, .. } => assert!(filename_regex.is_match("abc.jsonl")),
        }
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
        // Replaced, not duplicated: an override is one entry for that id.
        assert_eq!(reg.iter().filter(|a| a.id == "claude").count(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Adding an adapter is a file drop, not a code change. A user TOML naming a
    /// fresh id registers beside the built-ins rather than replacing one.
    #[test]
    fn a_user_toml_for_a_new_id_registers_alongside_the_builtin() {
        let dir = tmp_dir();
        std::fs::write(dir.join("another.toml"), VALID_MINIMAL).unwrap();

        let reg = build_registry_from(&dir);
        let mut ids: Vec<&str> = reg.iter().map(|a| a.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["claude", "codex", "copilot", "gemini", "kimi", "opencode", "pi", "x"]);

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
        // One past the newest, derived rather than written: hardcoding the
        // number meant this test silently stopped testing rejection the moment
        // that version became supported (it said 3, and v3 shipped).
        let unsupported = SCHEMA_VERSION + 1;
        let text = VALID_MINIMAL
            .replacen("schema_version = 1", &format!("schema_version = {unsupported}"), 1);
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
        assert_eq!(a.parser_kind, Some(ParserKind::ClaudeJsonl));
    }

    /// A v2 adapter that simply has no chat surface is the normal case, not a
    /// degraded one - a PTY-only adapter is fully functional.
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

[[chat.annotations]]
id = "m1"
fast_mode = true

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
        assert!(err.contains("[chat]"), "error should name the table it refused: {err}");
        assert!(
            err.contains(&format!("schema_version >= {CHAT_MIN_VERSION}")),
            "error should say what version [chat] needs: {err}"
        );
    }

    // --- schema v3: the [accounts] table ---

    const ACCOUNTS_TABLE: &str = r#"
[accounts]
home_env = "X_CONFIG_DIR"
home_default = "~/.x"
login_args = ["auth", "login"]
logout_args = ["auth", "logout"]
whoami_args = ["auth", "status"]
whoami_kind = "claude_json"
supports_isolation = true
"#;

    fn v3_with(table: &str) -> String {
        format!("{}{table}", VALID_MINIMAL.replacen("schema_version = 1", "schema_version = 3", 1))
    }

    #[test]
    fn a_v3_adapter_resolves_its_accounts_table() {
        let a = load_adapter_str(&v3_with(ACCOUNTS_TABLE), "test").expect("v3 + accounts parses");
        let acc = a.accounts.expect("accounts resolved");
        assert_eq!(acc.home_env.as_deref(), Some("X_CONFIG_DIR"));
        assert_eq!(acc.login_args, ["auth", "login"]);
        assert_eq!(acc.logout_args, ["auth", "logout"]);
        assert_eq!(acc.whoami_args, ["auth", "status"]);
        assert_eq!(acc.whoami_kind, Some(WhoamiKind::ClaudeJson));
        assert!(acc.supports_isolation);
        assert_eq!(acc.home_default, Some(expand_tilde("~/.x")));
    }

    /// Isolation without a default home is an account whose sessions nobody can
    /// find: the profile signs in, and its history renders empty forever,
    /// because discovery has no prefix to swap on the declared `dir`.
    #[test]
    fn isolation_over_a_discovery_dir_needs_the_home_it_relocates_from() {
        let table = ACCOUNTS_TABLE
            .lines()
            .filter(|l| !l.starts_with("home_default"))
            .collect::<Vec<_>>()
            .join("\n");
        let err = load_adapter_str(&v3_with(&table), "test").unwrap_err();
        assert!(err.contains("home_default"), "error should name what is missing: {err}");
    }

    /// The rule is about relocating a directory, so an adapter that has no
    /// directory is not asked for one. An ACP agent keeps its sessions where
    /// only its protocol reaches, and there is nothing there to move.
    #[test]
    fn a_agent_with_no_discovery_dir_may_claim_isolation_without_one() {
        // The three file-era tables are absent together, which is the shape the
        // loader already requires of a protocol-backed adapter.
        let table = ACCOUNTS_TABLE
            .lines()
            .filter(|l| !l.starts_with("home_default"))
            .collect::<Vec<_>>()
            .join("\n");
        let text = format!(
            "schema_version = 3\nid = \"x\"\nlabel = \"X\"\n\n[launch]\nprogram = \"x\"\n\
             resume_args = []\n\n[chat]\ntransport = \"acp\"\nbase_args = [\"acp\"]\n{table}"
        );
        let a = load_adapter_str(&text, "test").expect("protocol-backed adapter parses");
        let acc = a.accounts.expect("accounts resolved");
        assert!(acc.supports_isolation);
        assert_eq!(acc.home_default, None);
    }

    /// Probe args and the shape of their answer are one fact. Args alone would
    /// leave the reader guessing, and the three measured shapes make every guess
    /// wrong somewhere: read OpenCode's exit code and it reports itself signed
    /// in while holding no credentials at all.
    #[test]
    fn probe_args_without_a_declared_shape_are_rejected() {
        let table = ACCOUNTS_TABLE
            .lines()
            .filter(|l| !l.starts_with("whoami_kind"))
            .collect::<Vec<_>>()
            .join("\n");
        let err = load_adapter_str(&v3_with(&table), "test").unwrap_err();
        assert!(err.contains("whoami_kind"), "error should name what is missing: {err}");
    }

    /// And the other way round, so a kind left behind after its args were
    /// deleted is a loud error rather than a silent no-op.
    #[test]
    fn a_declared_shape_with_no_probe_args_is_rejected() {
        let table = ACCOUNTS_TABLE.replace(r#"whoami_args = ["auth", "status"]"#, "whoami_args = []");
        let err = load_adapter_str(&v3_with(&table), "test").unwrap_err();
        assert!(err.contains("whoami_args"), "{err}");
    }

    #[test]
    fn an_unknown_whoami_kind_is_rejected() {
        let table = ACCOUNTS_TABLE.replace("claude_json", "vibes");
        let err = load_adapter_str(&v3_with(&table), "test").unwrap_err();
        assert!(err.contains("vibes"), "error should name the kind it did not recognize: {err}");
    }

    /// An adapter may declare accounts without declaring a probe: plenty of
    /// agents have no way to say who is signed in, and that has to load
    /// rather than being a schema error.
    #[test]
    fn an_accounts_table_with_no_probe_at_all_is_fine() {
        let a = load_adapter_str(&v3_with("\n[accounts]\nlogin_args = [\"login\"]\n"), "test")
            .expect("a login-only accounts table parses");
        let acc = a.accounts.expect("accounts resolved");
        assert_eq!(acc.whoami_kind, None);
        assert!(acc.whoami_args.is_empty());
    }

    /// Each of the three bundled agents answers differently, and the file is
    /// where that measurement is spent. Read as a set rather than one at a time:
    /// the moment two of them shared a kind, one of them would be a guess.
    #[test]
    fn each_measured_agent_declares_the_shape_of_its_own_answer() {
        let kinds: Vec<(String, Option<WhoamiKind>)> = BUNDLED
            .iter()
            .filter_map(|(source, text)| load_adapter_str(text, source).ok())
            .filter_map(|a| a.accounts.as_ref().map(|acc| (a.id.clone(), acc.whoami_kind)))
            .collect();
        assert_eq!(
            kinds,
            [
                ("claude".to_string(), Some(WhoamiKind::ClaudeJson)),
                ("opencode".to_string(), Some(WhoamiKind::OpencodeCredentials)),
                ("codex".to_string(), Some(WhoamiKind::ExitCode)),
                // A login command with no probe: copilot documents no
                // non-interactive status command, so its sign-in state is
                // honestly unknown rather than read from a guessed shape.
                ("copilot".to_string(), None),
            ],
            "a new adapter has to come here and say which answer shape it measured"
        );
    }

    #[test]
    fn an_install_table_parses_into_a_spec() {
        let text = format!(
            "{VALID_MINIMAL}\n[install]\nprogram = \"npm\"\nargs = [\"install\", \"-g\", \"x\"]\n"
        );
        let spec = load_adapter_str(&text, "test").expect("parses").install.expect("declared");
        assert_eq!(spec.program, "npm");
        assert_eq!(spec.args, ["install", "-g", "x"]);
    }

    /// Strict like `[accounts]`: a silently dropped key here would run a
    /// different command than the file's author wrote.
    #[test]
    fn an_unknown_install_key_is_loud() {
        let text = format!("{VALID_MINIMAL}\n[install]\nprogram = \"npm\"\ncommand = \"npm i\"\n");
        let err = load_adapter_str(&text, "test").unwrap_err();
        assert!(err.contains("command"), "{err}");
    }

    #[test]
    fn an_empty_install_program_is_rejected() {
        let text = format!("{VALID_MINIMAL}\n[install]\nprogram = \"\"\n");
        let err = load_adapter_str(&text, "test").unwrap_err();
        assert!(err.contains("install.program"), "{err}");
    }

    /// OpenCode's `auth logout` needs a provider argument and prompts without
    /// one, so there is no single command that signs the agent out. The empty
    /// list is what makes the removal flow ask instead of running something that
    /// would sit waiting for a keystroke.
    #[test]
    fn opencode_declares_no_logout_because_it_has_none_to_declare() {
        let a = load_adapter_str(BUILTIN_OPENCODE, "bundled:opencode").expect("opencode parses");
        let acc = a.accounts.expect("opencode declares accounts");
        assert!(acc.logout_args.is_empty());
        assert!(!acc.login_args.is_empty(), "but it does have a login");
    }

    /// The compatibility promise of the v3 bump, and the regression that makes
    /// it worth a test of its own: `[chat]` was gated on `< SCHEMA_VERSION`,
    /// which was indistinguishable from `< CHAT_MIN_VERSION` right up until a
    /// second optional table existed. Bumping to v3 under the old gate would
    /// have rejected the chat table in every v2 adapter in the world.
    #[test]
    fn a_v2_adapter_keeps_its_chat_table_after_the_v3_bump() {
        let a = load_adapter_str(&v2_with_chat(CHAT_TABLE), "test")
            .expect("a v2 adapter with [chat] still parses under v3");
        assert!(a.chat.is_some(), "v2's chat table must survive the v3 bump");
        assert!(a.accounts.is_none(), "a v2 adapter must report accounts: None");
    }

    #[test]
    fn a_v1_adapter_reports_no_accounts() {
        let a = load_adapter_str(VALID_MINIMAL, "test").expect("a v1 adapter still parses");
        assert!(a.accounts.is_none());
    }

    /// A version number that does not gate anything is decorative, the same
    /// rule `[chat]` obeys.
    #[test]
    fn an_accounts_table_in_a_v2_file_is_refused_rather_than_ignored() {
        let err = load_adapter_str(&v2_with_chat(ACCOUNTS_TABLE), "test").unwrap_err();
        assert!(err.contains("[accounts]"), "error should name the table it refused: {err}");
        assert!(
            err.contains(&format!("schema_version >= {ACCOUNTS_MIN_VERSION}")),
            "error should say what version [accounts] needs: {err}"
        );
    }

    /// Per `gotchas#serde ignores unknown fields, so a version field alone
    /// cannot gate a format`. Without `deny_unknown_fields` this file would
    /// load, drop the key, and report `supports_isolation: false` while the
    /// author believed they had declared it.
    #[test]
    fn an_unknown_accounts_key_is_rejected_rather_than_dropped() {
        let table = ACCOUNTS_TABLE.replace("supports_isolation", "supports_isolatoin");
        let err = load_adapter_str(&v3_with(&table), "test").unwrap_err();
        assert!(
            err.contains("supports_isolatoin"),
            "error should name the key it did not recognize: {err}"
        );
    }

    /// Isolation is a claim about a mechanism, so a claim with no mechanism is
    /// refused. Otherwise "add account" would offer a second profile, set no
    /// environment for it, and land both in the one home the first was using.
    #[test]
    fn claiming_isolation_without_a_home_env_is_rejected() {
        let table = ACCOUNTS_TABLE
            .lines()
            .filter(|l| !l.starts_with("home_env"))
            .collect::<Vec<_>>()
            .join("\n");
        let err = load_adapter_str(&v3_with(&table), "test").unwrap_err();
        assert!(err.contains("home_env"), "error should name what is missing: {err}");
    }

    /// The honest default. An adapter that says nothing about isolation is not
    /// isolable, because nobody has measured that it is.
    #[test]
    fn an_accounts_table_that_says_nothing_about_isolation_is_not_isolable() {
        let a = load_adapter_str(&v3_with("\n[accounts]\nlogin_args = [\"login\"]\n"), "test")
            .expect("a minimal accounts table parses");
        let acc = a.accounts.expect("accounts resolved");
        assert!(!acc.supports_isolation, "isolation must be earned, never defaulted to true");
        assert_eq!(acc.home_env, None);
    }

    /// Every bundled adapter must load under the current build. Cheap, and it
    /// is the check that would have caught the `< SCHEMA_VERSION` gate.
    #[test]
    fn every_bundled_adapter_loads() {
        for (source, text) in BUNDLED {
            if let Err(e) = load_adapter_str(text, source) {
                panic!("bundled adapter {source} failed to load: {e}");
            }
        }
    }

    /// Phase 0 measured all five of these against `claude auth`. The bundled
    /// adapter is where that measurement is spent, so it is pinned here rather
    /// than left to drift.
    #[test]
    fn the_bundled_claude_adapter_declares_its_measured_accounts_table() {
        let a = load_adapter_str(BUILTIN_CLAUDE, "bundled:claude").expect("claude.toml parses");
        let acc = a.accounts.clone().expect("claude declares [accounts]");
        assert_eq!(acc.home_env.as_deref(), Some("CLAUDE_CONFIG_DIR"));
        assert!(acc.supports_isolation, "measured in Phase 0: two simultaneous logins");
        assert!(!acc.whoami_args.is_empty(), "the sign-in probe must have args to run");
        assert!(!acc.login_args.is_empty(), "the login ladder needs args for the PTY rung");
        // The other half of the Phase 0 measurement: a session under an isolated
        // home wrote its transcript beneath that home, in the same layout. The
        // declared discovery dir has to sit under this one for the swap to mean
        // anything, which is the whole of how a second account is found.
        let home = acc.home_default.expect("claude declares the home it relocates from");
        let dir = a.discovery_path().expect("claude discovers sessions from a directory");
        assert!(dir.starts_with(&home), "{} is not under {}", dir.display(), home.display());
    }

    /// Isolation is claimed only where it was measured.
    ///
    /// Claude earned its `true` in Phase 0 on darwin, by holding two
    /// simultaneous logins in separate Keychain items.
    ///
    /// Codex and OpenCode declare `[accounts]` too, and neither claims
    /// isolation, which is the distinction worth keeping sharp: declaring a
    /// table says "here is how this agent signs in", and `supports_isolation`
    /// says "and two accounts can hold it at once". `CODEX_HOME` and
    /// `XDG_DATA_HOME` were both measured relocating a credential store, which
    /// is *not* the same claim: nobody has run two accounts side by side on
    /// either. So they get a sign-in state and a login button, and no "add
    /// account" action. This test is the tripwire for adding the flag by
    /// copy-paste.
    #[test]
    fn only_a_measured_adapter_claims_account_isolation() {
        let claiming: Vec<String> = BUNDLED
            .iter()
            .filter_map(|(source, text)| load_adapter_str(text, source).ok())
            .filter(|a| a.accounts.as_ref().is_some_and(|acc| acc.supports_isolation))
            .map(|a| a.id)
            .collect();
        assert_eq!(claiming, ["claude"], "only measured adapters may claim isolation");
    }

    /// The bundled claude adapter is what actually ships, so its tables are
    /// asserted against real content rather than mere presence.
    #[test]
    fn bundled_claude_declares_modes_effort_and_no_models() {
        let claude = load_adapter_str(BUILTIN_CLAUDE, "bundled:claude").expect("claude parses");
        let chat = claude.chat.expect("claude ships a chat table");
        assert_eq!(chat.transport, ChatTransport::ClaudeStreamJson);
        assert_eq!(claude.verified_against.as_deref(), Some("claude 2.1.231"));

        // The annotation table is not a model list and must never grow into one.
        // Its predecessor `[[chat.models]]` declared four models with labels,
        // windows and effort levels, and was measurably wrong: Opus 5 and Sonnet
        // 5 both said 200000 while the agent reports 1000000 for each on
        // `result.modelUsage` (dev/fixtures/claude/plain-turn.jsonl,
        // fast-mode.jsonl), and Fable's figure was inferred from a `[1m]` suffix
        // by a build that had never run a Fable turn.
        assert_eq!(
            chat.annotations.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            ["claude-opus-5"],
            "only the one model Sway has something to say about"
        );
        assert!(chat.annotations.iter().all(|a| a.fast_mode), "an annotation carrying nothing is just a model list");

        // The six modes --permission-mode both accepts *and honours*, spelled
        // exactly as it takes them. `manual` is deliberately absent: the CLI
        // accepts it but documents it as an alias for `default`, and reports
        // `default` at init, so a row for it would duplicate one.
        let modes: Vec<&str> = chat.modes.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(modes, vec!["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);
        assert!(!modes.contains(&"manual"), "`manual` is an alias for `default`, not a mode of its own");
        assert!(
            chat.modes.iter().all(|m| !m.hint.is_empty()),
            "a mode with no hint renders a menu row that does not say what it does"
        );

        // `auto` is gated on the capability the live catalogue reports, because
        // a model lacking it runs `default` instead without saying so.
        let auto = chat.modes.iter().find(|m| m.id == "auto").expect("auto declared");
        assert_eq!(auto.requires.as_deref(), Some("supportsAutoMode"));

        // No mode carries a caveat any more. There used to be one - Sway's hook
        // ran ahead of the permission chain, so `bypassPermissions` still
        // stopped at Sway's gate - and the whole point of retiring that gate is
        // that the promise in the mode's name is now kept.
        //
        // Checked against the parsed tables rather than the file's text, which
        // also mentions the retired key in the comment explaining its
        // replacement - and against the tables rather than the struct, since
        // `ChatMode` ignores keys it does not know, so a leftover declaration
        // would be silently dropped instead of failing anything.
        let raw: toml::Value = toml::from_str(BUILTIN_CLAUDE).expect("the bundled adapter parses as TOML");
        for table in raw["chat"]["modes"].as_array().expect("modes is an array of tables") {
            assert!(
                table.get("permissive_caveat").is_none(),
                "a mode declaring a caveat Sway no longer imposes would warn about nothing"
            );
        }

        // What *is* declared is which mode runs tools unasked, which is a fact
        // about the mode rather than about Sway - and one that matters more now
        // that Sway is not behind it.
        let permissive: Vec<&str> = chat.modes.iter().filter(|m| m.permissive).map(|m| m.id.as_str()).collect();
        assert_eq!(permissive, vec!["bypassPermissions"]);

        // No effort table any more: the levels are the agent's per model, and
        // `effort_args` says only how to spell whichever ones it names.
        assert_eq!(chat.effort_args, vec!["--effort", "{effort}"]);

        // What is declared is the opposite kind of claim: a level this CLI
        // accepts and never advertises. Every one of them carries the version it
        // was measured against, which is what stops it outliving the
        // measurement, and none of them may be a level `--help` already lists.
        let advertised = ["low", "medium", "high", "xhigh", "max"];
        for extra in &chat.effort_extras {
            assert!(
                !extra.measured_on.is_empty(),
                "effort extra `{}` claims a level with no version behind it",
                extra.id
            );
            assert!(
                !advertised.contains(&extra.id.as_str()),
                "effort extra `{}` restates a level the CLI already advertises",
                extra.id
            );
        }
        let extras: Vec<&str> = chat.effort_extras.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(extras, vec!["ultracode"], "see dev/effort-probe.mjs for what is measured");
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
        let mut adapters: Vec<AgentAdapter> = BUNDLED
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

    /// A mode can be expressed two ways, so the precedence has to be pinned.
    #[test]
    fn an_entrys_own_args_win_over_the_table_template() {
        let a = load_adapter_str(&v2_with_chat(CHAT_TABLE), "test").expect("parses");
        let chat = a.chat.unwrap();
        // `plan` declares its own args, so those are used verbatim.
        assert_eq!(
            chat.mode_args_for("plan"),
            Some(vec!["--permission-mode".to_string(), "plan".to_string()])
        );
        // An unknown id resolves to nothing rather than sending a filled
        // template for a mode the adapter never declared.
        assert_eq!(chat.mode_args_for("not_a_mode"), None);
        // Effort levels moved to the model side of that line and joined the
        // exception below: there is no declared list of them left to be unknown
        // to, so any level the catalogue named fills the template.
        assert_eq!(
            chat.effort_args_for("a-level-no-toml-mentions"),
            Some(vec!["--effort".to_string(), "a-level-no-toml-mentions".to_string()])
        );
        // Models are the exception, and deliberately so: there is no declared
        // list to be unknown to. The adapter says how to *spell* a model as
        // args; the catalogue the id came from says which models exist. Gating
        // here meant a model the CLI offered but the TOML lacked produced no
        // `--model` flag and silently ran something else.
        assert_eq!(
            chat.model_args_for("a-model-no-toml-mentions"),
            Some(vec!["--model".to_string(), "a-model-no-toml-mentions".to_string()])
        );
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

    /// A agent whose modes are named nothing like Claude's, used wherever a
    /// resolver has to be shown not to have Claude's vocabulary baked in.
    /// These are Gemini's real `--approval-mode` values, and none of them is
    /// the literal `"default"` that Sway used to fall back to.
    const FOREIGN_MODES: &str = r#"
[[chat.modes]]
id = "yolo"
label = "Yolo"

[[chat.modes]]
id = "auto_edit"
label = "Auto edit"
default = true
"#;

    fn foreign_chat() -> ChatConfig {
        // The declared modes replace the table's, rather than adding to it, so
        // nothing Claude-shaped survives into the fixture.
        let table = CHAT_TABLE.replace(
            "[[chat.modes]]\nid = \"plan\"\nlabel = \"Plan\"\nargs = [\"--permission-mode\", \"plan\"]\n",
            "",
        );
        let a = load_adapter_str(&v2_with_chat(&format!("{table}{FOREIGN_MODES}")), "foreign").expect("parses");
        a.chat.expect("a chat table")
    }

    /// The fallback must be the mode the *adapter* nominates, never the literal
    /// `"default"`: that string is Claude's spelling, and a resolver carrying it
    /// would quietly pick nothing at all on a agent that does not use it.
    #[test]
    fn the_default_mode_is_the_one_the_adapter_marks() {
        let chat = foreign_chat();
        assert_eq!(chat.default_mode().map(|m| m.id.as_str()), Some("auto_edit"));
        assert!(!chat.modes.iter().any(|m| m.id == "default"), "the fixture must not contain Claude's spelling");

        let claude = load_adapter_str(BUILTIN_CLAUDE, "bundled:claude").expect("parses");
        let claude_chat = claude.chat.expect("a chat table");
        assert_eq!(claude_chat.default_mode().map(|m| m.id.as_str()), Some("default"));
        assert_eq!(
            claude_chat.modes.iter().filter(|m| m.is_default).count(),
            1,
            "exactly one mode may be the default, or which one wins is positional luck"
        );
    }

    /// An adapter that never set the marker still resolves to a real mode of
    /// its own rather than to nothing.
    #[test]
    fn an_adapter_with_no_marked_default_falls_back_to_its_first_mode() {
        let chat = load_adapter_str(&v2_with_chat(CHAT_TABLE), "test").expect("parses").chat.expect("chat");
        assert!(!chat.modes.iter().any(|m| m.is_default));
        assert_eq!(chat.default_mode().map(|m| m.id.as_str()), Some("plan"));
    }

    /// The case a settings file produces: a stored mode the adapter no longer
    /// declares. It must downgrade to the adapter's default and *say* it did -
    /// failing the spawn would strand the session behind a file the user
    /// cannot see, and downgrading silently would leave the control showing a
    /// mode the session is not in.
    #[test]
    fn an_undeclared_mode_downgrades_to_the_adapters_default_and_reports_it() {
        let chat = foreign_chat();

        let stale = chat.resolve_mode(Some("bypassPermissions")).expect("a downgrade still resolves");
        assert_eq!(stale.id, "auto_edit");
        assert_eq!(stale.downgraded_from.as_deref(), Some("bypassPermissions"));

        // A declared mode passes through untouched and reports no downgrade,
        // so the notice cannot fire on the ordinary path.
        let fine = chat.resolve_mode(Some("yolo")).expect("a declared mode resolves");
        assert_eq!(fine.id, "yolo");
        assert_eq!(fine.downgraded_from, None);
    }

    /// The spawn still happens, and on the *right* flags: the downgrade is only
    /// worth anything if the args that reach the child are the default's.
    #[test]
    fn a_session_with_a_stale_stored_mode_still_starts_on_the_default() {
        let chat = foreign_chat();
        let args = crate::chat::commands::build_args(
            &chat,
            "s1",
            false,
            None,
            None,
            Some("bypassPermissions"),
            None,
            &[],
        );
        assert!(
            args.windows(2).any(|w| w == ["--permission-mode", "auto_edit"]),
            "expected the adapter's default mode in {args:?}"
        );
        assert!(!args.iter().any(|a| a == "bypassPermissions"), "the dropped mode must not reach the child");
    }

    /// **The guard that replaces the `PermissionMode` enum**, relocated to the
    /// one place it can actually fail.
    ///
    /// A mode used to be an enum variant, so an id nobody supported could not be
    /// written down. It is a string now, which accepts every typo, and the
    /// obvious replacement - checking each declared id against a known set at
    /// load time - cannot fail: every id in the TOML is "known" by construction,
    /// because the TOML is what declares them. Only the binary can say whether
    /// an id is accepted, so this asks it.
    ///
    /// Not `#[ignore]`d, unlike the tests that drive a real conversation: this
    /// spawns `--version`, which parses the args and exits. No tokens, no
    /// network, milliseconds. It skips only when the binary is absent, so a
    /// machine without `claude` still gets a green suite.
    ///
    /// The args come from `mode_args_for` rather than a hardcoded
    /// `--permission-mode`, so this probes what Sway would really send.
    #[test]
    fn every_declared_mode_is_one_the_cli_accepts() {
        let claude = load_adapter_str(BUILTIN_CLAUDE, "bundled:claude").expect("parses");
        let chat = claude.chat.expect("claude ships a chat table");

        // `--version` on a bare program name, as the cheapest possible check
        // that the binary is both present and runnable.
        if std::process::Command::new(&chat.program).arg("--version").output().is_err() {
            eprintln!("skipping: `{}` is not on PATH", chat.program);
            return;
        }

        assert!(!chat.modes.is_empty(), "an adapter with no declared mode has nothing to probe");
        for m in &chat.modes {
            let args = chat.mode_args_for(&m.id).expect("a declared mode resolves its own args");
            let out = std::process::Command::new(&chat.program)
                .args(&args)
                .arg("--version")
                .output()
                .expect("the binary was just shown to run");
            assert!(
                out.status.success(),
                "`{} {} --version` failed ({}), so mode `{}` is declared but not accepted: {}",
                chat.program,
                args.join(" "),
                out.status,
                m.id,
                String::from_utf8_lossy(&out.stderr).trim(),
            );
        }
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
        // **Every level spells out, including ones this build has never heard
        // of.** The picker's levels come from the agent's own catalogue and from
        // `[[chat.effort_extras]]`, neither of which this table gets a say in,
        // so a level that resolved to nothing here would spawn the session
        // flagless with the pill still displaying it - the silent-flag failure
        // `resolve_mode` was written to end, one control over.
        for level in ["low", "max", "ultracode", "a-level-no-build-has-seen"] {
            let args = chat.effort_args_for(level).unwrap_or_default();
            assert_eq!(args, vec!["--effort", level], "`{level}` did not reach argv");
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
        for field in ["label", "launch"] {
            assert!(err.contains(field), "error should name missing field `{field}`: {err}");
        }
    }

    /// The three file-era tables are one fact about an adapter, not three, so a
    /// file that declares some of them is an error naming the rest.
    ///
    /// This is the case the rule exists for. A typo that loses `[discovery]`
    /// from a Claude-shaped adapter would otherwise resolve as a protocol-backed
    /// one and its sessions would simply stop appearing, which looks nothing like
    /// a config error from the outside.
    #[test]
    fn declaring_some_session_plumbing_and_not_the_rest_is_an_error() {
        let text = VALID_MINIMAL.replacen("[discovery]", "[unused_discovery]", 1);
        let err = load_adapter_str(&text, "test").unwrap_err();
        assert!(err.contains("discovery"), "names the one that went missing: {err}");
        assert!(err.contains("all three"), "says the three travel together: {err}");
    }

    /// Omitting all three is allowed only for a transport that reaches its
    /// sessions over the protocol. A PTY-only adapter with none of them could
    /// list no sessions at all, which is indistinguishable from an agent the
    /// user has never run.
    #[test]
    fn omitting_all_session_plumbing_needs_a_protocol_transport() {
        let bare = "schema_version = 2\nid = \"x\"\nlabel = \"X\"\n\n[launch]\nprogram = \"x\"\nresume_args = []\n";
        let err = load_adapter_str(bare, "test").unwrap_err();
        assert!(err.contains("over the protocol"), "says what would make it legal: {err}");
        assert!(err.contains("acp"), "names the transport that qualifies: {err}");

        let with_acp = format!("{bare}\n[chat]\ntransport = \"acp\"\nbase_args = [\"acp\"]\n");
        let a = load_adapter_str(&with_acp, "test").expect("an ACP adapter may omit all three");
        assert!(a.discovery.is_none());

        // ...and the same file with a file-backed transport is still rejected,
        // so the exemption is the transport's rather than the chat table's.
        let with_claude = with_acp.replace("\"acp\"", "\"claude_stream_json\"");
        assert!(load_adapter_str(&with_claude, "test").is_err());
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
        assert_eq!(a.parser_kind, Some(ParserKind::ClaudeJsonl));
    }

    /// The doc's ACP example is the load-bearing one now: it is the file a user
    /// writes to add a agent, and it claims to be *complete*. If it stopped
    /// validating, the shortest path into Sway would be a broken copy-paste.
    #[test]
    fn adapters_md_acp_example_parses_and_needs_no_session_plumbing() {
        let doc = include_str!("../../ADAPTERS.md");
        let heading = "### An ACP agent";
        let after = doc.find(heading).expect("ADAPTERS.md must document an ACP example") + heading.len();
        let rest = &doc[after..];
        let fence_start = rest.find("```toml").expect("the ACP example needs a ```toml block")
            + "```toml".len();
        let fence_end = rest[fence_start..].find("```").expect("unterminated fence") + fence_start;

        let a = load_adapter_str(rest[fence_start..fence_end].trim(), "ADAPTERS.md ACP example")
            .expect("the ACP example TOML should parse");
        assert_eq!(a.chat.as_ref().map(|c| c.transport), Some(ChatTransport::Acp));
        assert!(a.discovery.is_none(), "and it declares none of the three file-era tables");
        assert!(a.parser_kind.is_none());
        assert!(a.running_pattern.is_none());
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
