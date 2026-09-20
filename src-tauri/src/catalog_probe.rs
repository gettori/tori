//! Asking a agent what it can run, and remembering the answer.
//!
//! Tori ships no model list. Every model, mode and option a picker offers is
//! something the agent itself named, either on a live session's handshake or
//! on the cached answer this module produces. The two are the same shape on
//! purpose: a picker opened before any session exists reads the cache, and the
//! live handshake replaces it the moment a session starts.
//!
//! **A probe submits no turn.** For `claude_stream_json` that costs nothing at
//! all: the `initialize` control response carries the whole catalogue and
//! arrives before any session exists, so the probe is spawn, handshake, kill,
//! with nothing written on the agent's side and nothing to clean up.
//!
//! **ACP cannot be that clean, and the difference is stated rather than hidden.**
//! An ACP catalogue exists only as part of `session/new`, so asking means opening
//! a session. The probe opens exactly one, in [`probe_cwd`] (a directory that is
//! nobody's project), sends no `session/prompt`, and asks for a close when the
//! agent advertises one. `session/close` frees resources rather than deleting a
//! record, so the leftover is filtered out of Tori's own history by where it was
//! opened; see [`probe_cwd_spellings`].
//!
//! Three facts are kept apart because the UI renders them differently:
//!
//!   * **Never probed** is not an error. It is the honest state of a agent
//!     nobody has asked yet, and it renders as no count rather than as zero.
//!   * **A failure carries its reason.** "Signed out" and "the binary is not
//!     there" are different sentences, and a probe that timed out has said
//!     nothing about either.
//!   * **A failure never clobbers a good catalogue.** Stale-but-real beats
//!     fresh-but-empty, so [`ModelCatalog::catalogue`] survives a later failure
//!     and the surface shows its age instead of hiding it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::v1::{
    SessionNotification,
    CloseSessionRequest, SessionConfigId, SessionConfigOption, SessionConfigOptionValue,
    SessionConfigValueId, SetSessionConfigOptionRequest,
};
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo, ErrorCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::{AgentAdapter, ChatEffortExtra, ChatTransport};
use crate::chat::acp;
use crate::chat::acp_transport::{initialize_request, new_session_request};
use crate::chat::claude::{self, ClaudeMapper};
use crate::chat::model::{
    ChatAccount, ChatCapabilities, ChatConfigOption, ChatEvent, ChatModeInfo, ChatModelInfo,
    SlashCommand,
};
use crate::chat::transport::{build_command, StartSpec};

/// How long one agent gets to answer before the probe gives up on it.
///
/// **A ceiling, not an expectation.** Measured on claude 2.1.231, a full probe
/// (spawn, handshake, answer, kill) takes ~1.6s, so this is not a number
/// anything healthy comes near. It is sized for the agents that are not
/// measured yet: Paseo's notes report cold starts on the slow side, and Phase
/// 3's ACP probe has to spawn an agent and open a session before it can read
/// anything. Overrunning it is not fatal to anything: the agent lands in
/// [`FailureReason::TimedOut`] and keeps whatever catalogue it had.
const PROBE_DEADLINE: Duration = Duration::from_secs(45);

/// How much of a failed probe's stderr to keep, matching the chat transport's
/// own tail. Enough for a usage error or an auth message, bounded so a chatty
/// child cannot grow a cache file without limit.
const STDERR_TAIL: usize = 4096;

/// The last [`STDERR_TAIL`] bytes of what a child said, cut on a character
/// boundary.
///
/// The boundary search is not pedantry: a agent that writes a box-drawing
/// banner puts multi-byte characters in the buffer, and slicing a `String` mid
/// character is a panic, on the thread that was collecting the explanation for a
/// failure.
fn tail_of(text: &str) -> &str {
    let want = text.len().saturating_sub(STDERR_TAIL);
    let cut = (want..=text.len()).find(|i| text.is_char_boundary(*i)).unwrap_or(text.len());
    &text[cut..]
}

// --- the stored shape ---

/// Which of the three things a agent's catalogue currently is.
///
/// Derived from the two fields below rather than stored as a third independent
/// one, so it cannot disagree with them. It is serialized because the surfaces
/// branch on it directly, and skipped on the way back in because
/// [`ModelCatalog::settled`] recomputes it on load.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CatalogState {
    /// Nobody has asked this agent yet. Renders as no answer, never as zero.
    #[default]
    NeverProbed,
    /// The most recent attempt failed. A previous good catalogue may still be
    /// here, which is why this is a state of the record and not a replacement
    /// for it.
    Failed,
    /// The most recent attempt answered.
    Probed,
}

/// Why a probe did not produce a catalogue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureReason {
    /// The binary did not resolve, or the process would not start.
    SpawnFailed,
    /// The child was alive and said nothing in time. Says nothing about the
    /// agent's sign-in state, which is why it is not folded into the next one.
    TimedOut,
    /// The agent's own sign-in probe says nobody is signed in. Measured
    /// through the adapter's `[accounts]` table rather than guessed from the
    /// words in a stderr tail.
    SignedOut,
    /// The child exited or closed its stdout without answering the handshake,
    /// and the agent does not report being signed out.
    NoAnswer,
    /// This build cannot probe this transport yet. Distinct from every other
    /// reason because it is a fact about Tori, not about the agent, and the
    /// surface should not blame the binary for it.
    Unsupported,
}

/// One failed attempt, kept so the surface can say what went wrong and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeFailure {
    pub reason: FailureReason,
    /// The agent's own words where there are any (a stderr tail, a spawn
    /// error). Empty rather than invented when there are none.
    #[serde(default)]
    pub detail: String,
    pub at_ms: u64,
}

impl ProbeFailure {
    fn now(reason: FailureReason, detail: impl Into<String>) -> Self {
        Self { reason, detail: detail.into(), at_ms: now_ms() }
    }
}

/// One model row as the cache holds it.
///
/// [`ChatModelInfo`] flattened rather than wrapped, so a cached row and a live
/// handshake row are the same JSON and a surface can read one where it reads the
/// other. The extra bit is the one thing that is true of a cached row only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    #[serde(flatten)]
    pub info: ChatModelInfo,
    /// This row came from the user's own agent configuration, not from the
    /// agent's catalogue.
    ///
    /// Still not something Tori invented - the user wrote the id - but Tori
    /// cannot confirm it: a configured string is passed to `--model` unresolved,
    /// so such a row carries an empty `resolved_model` and anything deduping by
    /// that field must fall back to `value` rather than collapsing every
    /// user-configured row into one.
    #[serde(default)]
    pub user_configured: bool,
    /// The levers this agent has **for this model**, when they depend on it.
    ///
    /// Claude's do: the CLI publishes no options at all, so Tori assembles them
    /// per model row. An ACP agent's are per session rather than per model and
    /// live on the catalogue itself, so its rows leave this empty.
    #[serde(default)]
    pub options: Vec<ChatConfigOption>,
}

/// The cache shape a probe writes now.
///
/// Bumped when a field a surface reads is **added** to the cache, so a
/// catalogue written before that field existed is re-probed rather than
/// rendering as an agent that publishes nothing. Nothing on the wire carries
/// it: it describes what Tori asked for and kept, not what the agent said.
///
/// **Written here and compared only in `modelCatalog.ts::isStale`**, the split
/// [`Catalogue::version`] already lives under. Two staleness rules in two
/// languages that can disagree is the failure that moved the first one out of
/// Rust, and a shape stamp is the same kind of rule.
///
/// - **1**: the shape at the moment the stamp was introduced.
/// - **2**: `supports_fast_mode` and `supports_adaptive_thinking` on every model
///   row. A cache written at 1 carries neither, and both default to false, so a
///   model with a fast mode would read as one without until something re-asked.
/// - **3**: an ACP model row carries its **own** option set and its own effort
///   levels. A cache written at 2 has `options: []` on every ACP row and the
///   probe session's levels copied onto all of them, so a draft would offer a
///   level the picked model refuses.
/// - **6**: an *ACP* agent's commands are in it too. Shape 5 collected them
///   from claude's handshake only, and every other agent Tori ships an adapter
///   for is ACP - where they arrive on a notification after `session/new`,
///   which the probe was not listening for. So a cache at 5 has an empty list
///   for those agents, and it is empty for the wrong reason: nobody asked.
/// - **5**: the catalogue carries the agent's slash commands. A cache written
///   at 4 has none, and a draft reads its completions from here rather than
///   from a session, so `/` in a new chat would open on an empty menu until
///   something re-probed.
/// - **4**: claude's `thinking` option was withdrawn. A cache written at 3 still
///   carries the row, and a **draft** reads its levers from here rather than
///   from a session, so it would keep drawing a pill this build no longer
///   publishes - a control that cannot be reached by any code path, on a lever
///   that was never switchable. The first bump for a field *removed* rather than
///   added, which is the same rule read the other way: the cache describes a
///   shape this Tori no longer reads.
pub const CACHE_SHAPE: u32 = 8;

/// How many models one probe switches through to read their own option sets.
///
/// Sized against the two measured catalogues (OpenCode 15, Codex 4) so both are
/// swept whole, with room to spare inside [`PROBE_DEADLINE`]: the OpenCode sweep
/// measured ~4.5s including spawn. It is a backstop against a catalogue nobody
/// has seen, not a limit anything real is expected to hit.
const PER_MODEL_SWEEP_CAP: usize = 24;

/// How long an ACP probe waits after opening a session for the agent to publish
/// its commands.
///
/// They arrive on a notification rather than on any response, so there is
/// nothing to await on: measured on pi-acp 0.0.33, the
/// `available_commands_update` landed well inside a second of `session/new`.
/// Half a second is the beat that catches it without adding meaningfully to a
/// sweep that already spends seconds switching models.
const COMMANDS_GRACE: Duration = Duration::from_millis(500);

/// What a catalogue carrying no stamp is: the shape from before the field
/// existed.
///
/// A constant of its own rather than [`CACHE_SHAPE`], which moves. Reading an
/// unstamped cache as "whatever is current" would make every future bump miss
/// exactly the caches it exists to catch.
fn shape_before_the_stamp() -> u32 {
    1
}

/// What one agent said when it was asked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalogue {
    /// The binary version at the moment of the probe, when it was parseable.
    /// `None` is the `versionUnknown` case and is what makes this answer
    /// un-invalidatable except by an explicit re-check; see
    /// [`ModelCatalog::is_stale`].
    pub version: Option<String>,
    /// Which shape of cache this is; see [`CACHE_SHAPE`].
    #[serde(default = "shape_before_the_stamp")]
    pub shape: u32,
    pub probed_at_ms: u64,
    pub models: Vec<CatalogModel>,
    /// Empty for a agent whose modes are declared in its adapter TOML rather
    /// than published on the wire, which is claude today.
    #[serde(default)]
    pub modes: Vec<ChatModeInfo>,
    /// The agent's own config options, including the ones Tori has no bespoke
    /// control for. Empty for claude, which publishes none.
    ///
    /// **The same shape the live chat mirrors**, not the raw protocol structs:
    /// the settings page previews an agent's options before any chat exists, and
    /// a cache in a different shape would mean two renderers for one list.
    #[serde(default)]
    pub options: Vec<ChatConfigOption>,
    /// The account the agent named, when it named one. Load-bearing for the
    /// surface's honesty: a catalogue can differ per account, so a page showing
    /// one has to be able to say whose answer it is.
    pub account: Option<ChatAccount>,
    /// The agent's slash commands, from the same handshake the models come
    /// from. Kept for the composer of a chat that has not handshaken yet: a
    /// draft has no session to ask, so without this `/` opened on nothing.
    ///
    /// Measured (claude 2.1.251): the `initialize` response's `commands` and
    /// `system/init`'s `slash_commands` are the same list, and the skills are
    /// already in it - 17 of the 49 entries on this machine. So there is one
    /// completion source rather than a second one for skills.
    #[serde(default)]
    pub commands: Vec<SlashCommand>,
    /// What the agent advertised during the same initialize handshake. Cached
    /// so a draft can offer prompt inputs before it has opened a session.
    #[serde(default)]
    pub capabilities: Option<ChatCapabilities>,
}

/// What a catalogue carrying no account is: the shape from before accounts
/// existed, which was always the user's own login.
fn account_before_the_field() -> String {
    crate::accounts::DEFAULT_PROFILE_ID.to_string()
}

/// Everything Tori remembers about one agent's catalogue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    /// Aliased for the cache files written before the rename: a miss here reads
    /// as a never-probed agent, quietly throwing away a real answer.
    #[serde(alias = "harnessId")]
    pub agent_id: String,
    /// Which account answered. Half of this record's identity, because a
    /// catalogue is an account's answer and not an agent's: two profiles of one
    /// binary can be on different plans and offer different models.
    #[serde(default = "account_before_the_field")]
    pub profile_id: String,
    #[serde(skip_deserializing)]
    pub state: CatalogState,
    /// The last probe that answered, which outlives every failure after it.
    pub catalogue: Option<Catalogue>,
    /// Set when the *most recent* attempt failed, cleared by one that answers.
    pub last_failure: Option<ProbeFailure>,
}

impl ModelCatalog {
    /// The single funnel that computes [`Self::state`], so the three fields
    /// cannot drift. Everything that builds a record goes through here.
    fn settled(
        agent_id: String,
        profile_id: String,
        catalogue: Option<Catalogue>,
        last_failure: Option<ProbeFailure>,
    ) -> Self {
        let state = match (&last_failure, &catalogue) {
            (Some(_), _) => CatalogState::Failed,
            (None, Some(_)) => CatalogState::Probed,
            (None, None) => CatalogState::NeverProbed,
        };
        Self { agent_id, profile_id, state, catalogue, last_failure }
    }

    pub fn never_probed(agent_id: impl Into<String>, profile_id: impl Into<String>) -> Self {
        Self::settled(agent_id.into(), profile_id.into(), None, None)
    }

    /// Fold a probe's outcome into this record.
    ///
    /// **A failure keeps the catalogue.** That is the whole reason this is a
    /// method rather than a fresh record per probe: replacing the record on
    /// failure would turn a signed-out moment, or one slow cold start, into a
    /// agent that suddenly offers no models at all.
    fn absorb(&mut self, outcome: Result<Catalogue, ProbeFailure>) {
        let (agent, profile) = (self.agent_id.clone(), self.profile_id.clone());
        match outcome {
            Ok(catalogue) => *self = Self::settled(agent, profile, Some(catalogue), None),
            Err(failure) => {
                *self = Self::settled(agent, profile, self.catalogue.take(), Some(failure))
            }
        }
    }

    // **Staleness is not decided here.** [`Catalogue::version`] records the
    // binary that answered, and comparing it against the binary installed now is
    // the whole rule; it lived on this type until the batch refresh command
    // above it was removed, and left with no caller on this side. It is
    // `isStale` in `modelCatalog.ts` now, beside the code that acts on it, and
    // written once rather than in two languages that can drift.
    //
    // The rule itself is unchanged and worth restating where the field is: a
    // version comparison and nothing else. A TTL was the obvious alternative and
    // is rejected - a catalogue does not decay with time, it decays when the
    // binary changes, and an hourly re-probe would spawn a process per agent
    // forever to learn nothing. Both unknown-version cases answer "not stale",
    // because neither is evidence of a change, and treating absence of evidence
    // as staleness would re-probe a `versionUnknown` binary on every read. Such
    // a agent comes back through the detail page's Ask again.
}

// --- the store: one file per agent, under the data dir ---

/// `~/Library/Application Support/tori/model-catalogs` on macOS.
///
/// The data dir rather than `~/.config/tori`, for the reason `accounts.rs`
/// chose it: this is state Tori derived, not configuration a user edits, and
/// `~/.config` commonly lives in a dotfile repo. One file per agent rather
/// than one map, so deleting a single agent's answer is a `rm` and a corrupt
/// file costs one agent rather than all of them.
pub fn catalog_root() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join("tori/model-catalogs")
}

/// Reduce an id to a bare path segment. The cache files are named from adapter
/// ids that come out of user TOML, and the id is about to be concatenated into
/// a path. Same rule as `accounts.rs` and `owned_state.rs` keep privately: one
/// line each, so no module's escape depends on another's.
fn sanitize_segment(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// One file per (agent, account), with the default account keeping the bare
/// `{agent}.json` it has always had, so no existing cache is orphaned by this
/// gaining a second key.
fn catalog_path(root: &Path, agent_id: &str, profile_id: &str) -> PathBuf {
    let agent = sanitize_segment(agent_id);
    if profile_id == crate::accounts::DEFAULT_PROFILE_ID {
        return root.join(format!("{agent}.json"));
    }
    root.join(format!("{agent}__{}.json", sanitize_segment(profile_id)))
}

/// Read one account's remembered catalogue.
///
/// **Every failure is "never probed".** A missing file is the ordinary state of
/// a agent nobody has asked, and a corrupt one is derived state Tori can
/// simply ask for again; neither is worth an error the caller would have to
/// render. That is what makes the file safe to delete by hand.
///
/// A file whose contents name a different pair than the one asked for is one of
/// those failures rather than an answer. `__` separates the two ids in the name
/// and `sanitize_segment` can produce it from either, so two pairs can in
/// principle land on one path; handing back the wrong account's models is the
/// exact confusion this key exists to prevent.
pub fn load_from(root: &Path, agent_id: &str, profile_id: &str) -> ModelCatalog {
    let Ok(text) = std::fs::read_to_string(catalog_path(root, agent_id, profile_id)) else {
        return ModelCatalog::never_probed(agent_id, profile_id);
    };
    match serde_json::from_str::<ModelCatalog>(&text) {
        Ok(stored) if stored.agent_id == agent_id && stored.profile_id == profile_id => {
            ModelCatalog::settled(stored.agent_id, stored.profile_id, stored.catalogue, stored.last_failure)
        }
        _ => ModelCatalog::never_probed(agent_id, profile_id),
    }
}

pub fn save_to(root: &Path, catalog: &ModelCatalog) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    let path = catalog_path(root, &catalog.agent_id, &catalog.profile_id);
    let text = serde_json::to_string_pretty(catalog).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Drop one account's cached catalogue, for a profile being removed.
///
/// Silent on failure for the same reason [`load_from`] is: this is derived
/// state, and a leftover file is re-read as the never-probed state of whatever
/// profile id is minted next. The removal itself must not fail over it.
pub fn forget(agent_id: &str, profile_id: &str) {
    forget_in(&catalog_root(), agent_id, profile_id);
}

fn forget_in(root: &Path, agent_id: &str, profile_id: &str) {
    let _ = std::fs::remove_file(catalog_path(root, agent_id, profile_id));
}

// --- the probe ---

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Kill a child we are about to stop holding a handle to.
///
/// The `wait` is not optional: Rust's `Child` does not kill on drop, and a kill
/// without a reap leaves a zombie. Same shape as `claude_transport::abandon`,
/// and duplicated rather than shared because that one is private to a module
/// that owns a session's whole lifetime while this one ends a process that was
/// never a session.
fn abandon(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// A child's stderr, collected on its own thread into a bounded tail so a
/// failure can quote the agent rather than guess at it.
struct StderrTail {
    text: Arc<Mutex<String>>,
    reader: thread::JoinHandle<()>,
}

fn tail_stderr(stderr: impl Read + Send + 'static) -> StderrTail {
    let text = Arc::new(Mutex::new(String::new()));
    let into = text.clone();
    let reader = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut stderr = stderr;
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            if let Ok(mut t) = into.lock() {
                t.push_str(&String::from_utf8_lossy(&buf[..n]));
                if t.len() > STDERR_TAIL {
                    let kept = tail_of(&t).to_string();
                    *t = kept;
                }
            }
        }
    });
    StderrTail { text, reader }
}

impl StderrTail {
    /// Everything the child said, once it has finished saying it.
    ///
    /// **The join is the point.** Reading the buffer directly races the thread
    /// filling it: the child dying is what ends the probe, and the last write
    /// lands after that. Skipping the join made a failure quote nothing
    /// precisely when the agent had explained itself, which is the one case
    /// the tail exists for. Bounded rather than open-ended, because every caller
    /// has already killed and reaped the child, so stderr is at EOF.
    fn take(self) -> String {
        let _ = self.reader.join();
        self.text.lock().map(|t| t.trim().to_string()).unwrap_or_default()
    }
}

/// Drive `claude` far enough to read its catalogue, then kill it.
///
/// The args are the adapter's `base_args` and **nothing else**: no
/// `--session-id`, no `--resume`, no model or mode flag. That is what makes this
/// free. Those flags are what name a session, and the catalogue arrives on the
/// `initialize` control response, which the CLI answers before any session
/// exists. Nothing is ever written to stdin except that one control frame, so no
/// turn is submitted and no transcript is created.
///
/// Stdin is held open until the answer lands, for the reason
/// `claude_transport.rs` documents at length: closing it is what makes the CLI
/// exit, and an exit before the response would look like a failed probe.
fn probe_claude(
    spec: &StartSpec,
    version: Option<String>,
    deadline: Duration,
    effort_extras: &[ChatEffortExtra],
) -> Result<Catalogue, ProbeFailure> {
    let mut child = build_command(spec)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ProbeFailure::now(FailureReason::SpawnFailed, format!("could not start {}: {e}", spec.program)))?;

    let (Some(stdout), Some(stderr), Some(mut stdin)) =
        (child.stdout.take(), child.stderr.take(), child.stdin.take())
    else {
        abandon(&mut child);
        return Err(ProbeFailure::now(FailureReason::SpawnFailed, "the child produced no pipes"));
    };
    let tail = tail_stderr(stderr);

    // The reader owns the mapper: the catalogue rides `SessionReady`, which is
    // the same event a live session's handshake produces, so the probe and a
    // real chat read the response through one piece of code rather than two.
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut mapper = ClaudeMapper::new("catalog-probe");
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(frame) = serde_json::from_str::<Value>(line.trim()) else {
                // One unparseable line is not worth abandoning a probe over,
                // for the same reason a live session does not die on one.
                continue;
            };
            for event in mapper.map(&frame) {
                if let ChatEvent::SessionReady { models, modes, account, slash_commands, .. } = event {
                    let _ = tx.send(Some((models, modes, account, slash_commands)));
                    return;
                }
            }
        }
        // Stdout closed with no answer.
        let _ = tx.send(None);
    });

    let handshake = json!({
        "type": "control_request",
        "request_id": "catalog-probe-1",
        "request": { "subtype": "initialize", "hooks": {} },
    });
    if writeln!(stdin, "{handshake}").and_then(|()| stdin.flush()).is_err() {
        abandon(&mut child);
        return Err(ProbeFailure::now(FailureReason::NoAnswer, tail.take()));
    }

    let answer = rx.recv_timeout(deadline);
    // Unconditional, and before anything is returned: the probe owns this
    // child's whole life, and the timeout path is exactly the one where leaving
    // it running would leak a process per failed sweep.
    abandon(&mut child);

    match answer {
        Ok(Some((models, modes, account, commands))) => Ok(Catalogue {
            commands,
            models: models
                .into_iter()
                .map(|mut info| {
                    // Both from the same functions the live session emits from,
                    // so a draft and the chat it becomes cannot disagree about
                    // this model. The mapper had no version to scope an extra
                    // level to; here the probe does, and this is the version the
                    // catalogue is stored against.
                    info.effort_levels =
                        claude::effort_levels(&info, effort_extras, version.as_deref().unwrap_or_default());
                    CatalogModel {
                        // `None`: a probe reads the `initialize` control response,
                        // which arrives before any session exists and carries no
                        // `fast_mode_disabled_reason`. So a draft's lever states
                        // the transport's own reason and the live chat replaces it
                        // with the account's, which is the one thing the two
                        // callers are entitled to differ on.
                        options: claude::config_options(&info, None),
                        info,
                        user_configured: false,
                    }
                })
                .collect(),
            version,
            shape: CACHE_SHAPE,
            probed_at_ms: now_ms(),
            modes,
            // Claude's are per model, on the rows above. This is the per-session
            // set an ACP handshake publishes, which claude has none of.
            options: Vec::new(),
            account,
            capabilities: None,
        }),
        Ok(None) => Err(ProbeFailure::now(FailureReason::NoAnswer, tail.take())),
        Err(_) => Err(ProbeFailure::now(FailureReason::TimedOut, tail.take())),
    }
}

// --- the ACP probe ---

/// The one directory every ACP probe opens its session in.
///
/// **A constant path is the whole hygiene mechanism.** An ACP catalogue only
/// exists on `session/new`, so probing an ACP agent creates a session on that
/// agent's side, and `session/close` is not a delete: the spec says it frees
/// resources, and both measured agents keep the record and list it afterwards.
/// So Tori cannot prevent the phantom, only recognise it, and it recognises it
/// by *where* it was opened rather than by a growing list of ids to remember.
/// One path means a probe that crashed before it could record anything, and a
/// probe from a Tori build that predates the id list that does not exist, are
/// both still recognisable. See [`probe_cwd_spellings`].
pub fn probe_cwd() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join("tori/probe")
}

/// The probe directory, created if it is not there, in the spelling an agent
/// will be handed.
///
/// Canonicalized through the same helper `accounts.rs` uses, and for a related
/// reason: a agent told about `/var/...` records `/private/var/...`, so
/// handing over the resolved form is what makes the recorded path and the one
/// Tori filters on the same string.
fn probe_cwd_ready() -> Result<String, String> {
    let dir = probe_cwd();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    crate::accounts::canonicalize_home(&dir)
}

/// Every spelling of the probe directory a listed row might carry.
///
/// Both forms rather than the canonical one alone: a row recorded by an older
/// build, or by an agent that stored what it was given rather than what it
/// resolved, carries the unresolved spelling. Comparing against both is cheap
/// and is what lets [`crate::chat::acp_sessions::adopt`] stay pure, since it
/// receives the answers rather than touching the filesystem for them.
pub fn probe_cwd_spellings() -> Vec<String> {
    let raw = probe_cwd().to_string_lossy().into_owned();
    let mut spellings = vec![raw.clone()];
    if let Ok(canonical) = crate::accounts::canonicalize_home(&probe_cwd()) {
        if canonical != raw {
            spellings.push(canonical);
        }
    }
    spellings
}

/// Each model's own option set, by switching to it inside the probe's session.
///
/// **Built because it was measured, not because it was plausible.**
/// `dev/acp-probe.mjs --per-model` switched model inside one session on both
/// agents and diffed the answer. Both vary, and both vary in the same place:
/// the `thought_level` selector's choices. Measured 2026-08-21 on
/// `opencode acp` 1.18.3, `claude-opus-4.5` offers `max, high` where
/// `claude-opus-4.7` offers `low, medium, high, xhigh, max`; on
/// `@agentclientprotocol/codex-acp`, `gpt-5.6-terra` offers six levels
/// including `ultra` where `gpt-5.4-mini` offers four.
///
/// So the session's opening set describes **one** model, and a catalogue that
/// copied it onto every row would claim `ultra` for a model that refuses it -
/// the picker-that-appears-to-switch failure `[[chat.models]]` was retired for.
///
/// **Here rather than when the user picks a model**, and the measurement is what
/// decides it: the sweep is free. Timed on OpenCode, handshake plus
/// `session/new` alone is 4.4s and the same probe plus eight model switches is
/// 4.3s, because the whole cost is spawning the agent and opening the session
/// and a switch is one round trip down a pipe that is already open.
///
/// Asking on selection would mean asking an agent with no session, and an ACP
/// agent publishes its options only as part of `session/new`. So that path is
/// spawn, open, switch, tear down, per pick, paid while the user waits, and it
/// is the shape `probeOnHighlight`'s debounce already exists to prevent. A
/// *live* chat does ask on selection and needs none of this: the agent answers
/// every switch with its whole set and the mirror replaces wholesale. This cache
/// is only ever the stand-in for the one surface that cannot ask.
///
/// One session for the whole sweep, because `session/set_config_option` answers
/// with the agent's **whole** option set. No turn is submitted, so
/// [`concept_no_turn_probe`]'s promise is unchanged.
///
/// A model whose switch is refused is simply absent from the map, and the
/// caller falls back to the opening set for it: a refusal degrades one row
/// rather than failing the probe.
///
/// Capped at [`PER_MODEL_SWEEP_CAP`] for the same reason. The sweep is one round
/// trip per model, and a catalogue large enough to overrun [`PROBE_DEADLINE`]
/// would turn a working agent into an error card. Past the cap a row falls back
/// to the opening set, which is exactly what every row did before this existed:
/// the worst case degrades to the old behaviour instead of to a failure.
async fn per_model_options(
    conn: &ConnectionTo<Agent>,
    session_id: &agent_client_protocol::schema::v1::SessionId,
    options: &[SessionConfigOption],
) -> HashMap<String, Vec<SessionConfigOption>> {
    let mut out = HashMap::new();
    // By category, never by id: `category` is the spec's word for what an option
    // is, and Codex calls its effort selector `reasoning_effort`.
    let Some(config_id) = acp::model_config_id(options) else { return out };
    let models: Vec<String> = acp::model_catalogue(options)
        .into_iter()
        .map(|m| m.value)
        .take(PER_MODEL_SWEEP_CAP)
        .collect();

    for model in models {
        let request = SetSessionConfigOptionRequest::new(
            session_id.clone(),
            SessionConfigId::new(config_id.as_str()),
            SessionConfigOptionValue::ValueId { value: SessionConfigValueId::new(model.as_str()) },
        );
        if let Ok(answer) = conn.send_request(request).block_task().await {
            out.insert(model, answer.config_options);
        }
    }
    out
}

/// What one ACP agent's `session/new` answer means as a catalogue.
///
/// Pure, and separated from the process work so the shape of the answer is
/// testable from a fixture rather than only against a live agent.
///
/// **The options are stored whole**, in the shape the chat's mirror renders.
/// `models` and `modes` are the two the chat has bespoke controls for, but the
/// agent's full set is kept beside them, including categories this build has no
/// control for. Filtering to the three known categories at the cache boundary
/// would make the cache the place a new option gets lost.
///
/// **Per model as well as per session**, because [`per_model_options`] measured
/// that the two agents re-cut their options when the model changes. Each row
/// carries the set the agent answered *for that model*, so its effort levels
/// are its own rather than whichever model the probe's session opened on. The
/// catalogue-level set stays, and is what a row with no measurement of its own
/// falls back to; it is also still what the mirror reads for an agent with no
/// model selector at all.
fn acp_catalogue(
    version: Option<String>,
    options: Vec<SessionConfigOption>,
    per_model: HashMap<String, Vec<SessionConfigOption>>,
    commands: Vec<SlashCommand>,
    capabilities: ChatCapabilities,
) -> Catalogue {
    let models = acp::model_catalogue(&options)
        .into_iter()
        .map(|info| {
            // The row's own answer where there is one, the session's opening set
            // where the switch was refused. Never nothing: a row with no options
            // reads as an agent that publishes none.
            let mine = per_model.get(&info.value).unwrap_or(&options);
            // The whole row re-read from this model's own answer, rather than
            // the opening row with its levels patched: `model_catalogue` already
            // knows how to turn one option set into rows, and reaching in to fix
            // up two fields would be a second copy of that mapping. Falls back
            // to the opening row if the agent's answer stopped listing this
            // model, which is a contradiction Tori has no better reply to.
            let row = acp::model_catalogue(mine)
                .into_iter()
                .find(|m| m.value == info.value)
                .unwrap_or(info);
            CatalogModel { info: row, user_configured: false, options: acp::config_options(mine) }
        })
        .collect();

    Catalogue {
        version,
        shape: CACHE_SHAPE,
        probed_at_ms: now_ms(),
        models,
        modes: acp::mode_catalogue(&options),
        options: acp::config_options(&options),
        // Not on the handshake, which is why this is collected rather than
        // read off a response: measured on pi-acp 0.0.33, `session/new` answers
        // with the models, the modes and the options, and the commands follow
        // as a notification a moment later. Empty for an agent that sent none
        // inside the window, which is an agent with none as far as anything
        // here can tell.
        commands,
        // ACP publishes no account on the handshake. Empty rather than guessed,
        // which also means the surface's "whose answer is this" line correctly
        // says nothing for an ACP agent.
        account: None,
        capabilities: Some(capabilities),
    }
}

/// Does this agent advertise `session/close`?
///
/// Read off the handshake, on the same rule as `acp_transport::lists_sessions`:
/// an agent that does not advertise it is never sent the method, because a
/// `method not found` is noise Tori would then have to explain. **Absence is not
/// an error and not worth reporting** - the catalogue is already in hand by the
/// time this is asked, and the probe's real hygiene is the directory it opened
/// in, not the close.
fn closes_sessions(init: &agent_client_protocol::schema::v1::InitializeResponse) -> bool {
    init.agent_capabilities.session_capabilities.close.is_some()
}

/// Which failure a JSON-RPC error from `session/new` is.
///
/// `auth_required` is the one code worth branching on, for the reason
/// `acp_transport::describe_session_failure` states: it means the agent works
/// and nobody is signed in, which has a different fix from a broken install.
/// Measured value, not a guess at one: `-32000` **is** `AuthRequired` in ACP's
/// own numbering, which `an_agent_reporting_minus_32000_is_a_sign_in_failure`
/// pins on the transport side.
fn acp_failure(error: &agent_client_protocol::Error) -> ProbeFailure {
    let reason = if error.code == ErrorCode::AuthRequired {
        FailureReason::SignedOut
    } else {
        FailureReason::NoAnswer
    };
    ProbeFailure::now(reason, error.to_string())
}

/// Drive an ACP agent far enough to read its config options, then close.
///
/// **This one is not free the way the claude probe is**, and the difference is
/// structural rather than incidental: ACP publishes a catalogue only as part of
/// `session/new`, so there is no way to ask without opening a session. What the
/// probe can promise instead is that it opens exactly one, in a directory that
/// is nobody's project, submits no `session/prompt`, and asks for the session to
/// be closed when the agent says it can be. The phantom that survives that is
/// filtered out of Tori's own history by [`probe_cwd_spellings`], not left for
/// the user to notice.
fn probe_acp(
    spec: &StartSpec,
    overrides: &acp::AcpOverrides,
    version: Option<String>,
    deadline: Duration,
) -> Result<Catalogue, ProbeFailure> {
    use futures::future::{select, Either};
    use futures::AsyncReadExt as _;

    let mut std_cmd = build_command(spec);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        // Same reason as the transport's: agents are commonly launched behind a
        // wrapper, and killing only the immediate child orphans the real agent.
        std_cmd.process_group(0);
    }
    // The pipes go on **after** the conversion: `async_process::Command::from`
    // does not carry a std command's stdio settings across, which would leave
    // the child with inherited stdio and no protocol to speak over.
    let mut cmd = async_process::Command::from(std_cmd);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        ProbeFailure::now(FailureReason::SpawnFailed, format!("could not start {}: {e}", spec.program))
    })?;
    let (Some(stdin), Some(stdout), Some(mut stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        abandon_group(&mut child);
        return Err(ProbeFailure::now(FailureReason::SpawnFailed, "the child produced no pipes"));
    };

    let init_request = initialize_request(overrides);
    let session_request = new_session_request(&spec.cwd, overrides);
    // The commands the agent publishes, which arrive as a notification rather
    // than on any response (measured on pi-acp 0.0.33). Shared with the handler
    // because that is the only thing that can see them, and read back after the
    // session has settled.
    let commands: Arc<Mutex<Vec<SlashCommand>>> = Arc::new(Mutex::new(Vec::new()));
    let collected = commands.clone();
    let answer = futures::executor::block_on(async {
        let work = Client
            .builder()
            .name("tori")
            .on_receive_notification(
                async move |notification: SessionNotification, _cx| {
                    // Through the same mapper a live session reads, so the
                    // probe and the chat cannot disagree about one list.
                    for event in acp::map_update("catalog-probe", "probe-turn", &notification.update, None) {
                        if let ChatEvent::SlashCommands { commands: published, .. } = event {
                            if let Ok(mut held) = collected.lock() {
                                *held = published;
                            }
                        }
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .connect_with(
            ByteStreams::new(stdin, stdout),
            async move |conn: ConnectionTo<Agent>| {
                let init = conn.send_request(init_request).block_task().await?;
                let opened = conn.send_request(session_request).block_task().await?;
                let options = opened.config_options.unwrap_or_default();

                // **Measured, not assumed**: both agents re-cut their options per
                // model, so one session's set describes one model. See
                // `per_model_options` for what this costs and why it is worth it.
                let per_model = per_model_options(&conn, &opened.session_id, &options).await;

                // Best effort, and gated on the advertisement so an agent that
                // does not serve it is never sent a method it would answer with
                // `method not found`. Its failure is not the probe's failure:
                // the catalogue is already in hand, and a session that would not
                // close is exactly what the cwd filter covers.
                if closes_sessions(&init) {
                    let _ = conn
                        .send_request(CloseSessionRequest::new(opened.session_id.clone()))
                        .block_task()
                        .await;
                }
                // The commands ride a notification, so there is nothing to
                // await: this is the beat that lets one arrive before the
                // connection is torn down. Short, because it is spent on every
                // ACP probe whether or not the agent sends any.
                async_io::Timer::after(COMMANDS_GRACE).await;

                Ok((options, per_model, acp::capabilities(&init)))
            },
        );
        futures::pin_mut!(work);
        let timer = async_io::Timer::after(deadline);
        futures::pin_mut!(timer);
        match select(work, timer).await {
            Either::Left((result, _)) => Some(result),
            Either::Right(_) => None,
        }
    });

    // Unconditional and before anything is returned, the timeout path included:
    // that is the one where leaving it running leaks an agent per failed sweep.
    abandon_group(&mut child);

    let failed = match answer {
        Some(Ok((options, per_model, capabilities))) => {
            let published = commands.lock().map(|c| c.clone()).unwrap_or_default();
            return Ok(acp_catalogue(version, options, per_model, published, capabilities));
        }
        // `None` is the deadline, `Some(Err(_))` is the agent's own refusal.
        other => other,
    };

    // Read only now, and only on the way to a failure. The child is dead, so its
    // stderr is at EOF and this returns at once; reading it before the kill
    // would sample a stream the agent is still writing to, which is the race the
    // claude probe's tail joins its reader thread to avoid.
    let mut said = String::new();
    futures::executor::block_on(async {
        let read = stderr.read_to_string(&mut said);
        let timer = async_io::Timer::after(Duration::from_secs(1));
        futures::pin_mut!(read, timer);
        let _ = select(read, timer).await;
    });
    let said = tail_of(said.trim());

    match failed {
        // The protocol error is the informative one here, so it leads. The tail
        // still rides along, because a child that died before it spoke any
        // JSON-RPC at all leaves a generic connection error, and the one sentence
        // worth reading (`npx: command not found`) is only on stderr.
        Some(Err(e)) => {
            let mut failure = acp_failure(&e);
            if !said.is_empty() {
                failure.detail = format!("{}\n{said}", failure.detail);
            }
            Err(failure)
        }
        _ => Err(ProbeFailure::now(FailureReason::TimedOut, said)),
    }
}

/// Kill an ACP probe's child **and the group it leads**, then reap it.
///
/// The group is not optional here. The child is spawned with `process_group(0)`
/// because agents are commonly launched behind a wrapper (`npx …`, `bun …`), and
/// signalling only the leader leaves the real agent re-parented to pid 1, where
/// it does not reliably exit on stdin EOF. A chat session at least has the
/// ownership registry watching for that; a probe is fire-and-forget, so it would
/// leak one agent per sweep with nobody to notice. Same shape as `dap.rs::stop`,
/// shelling out for the same reason: `libc` is not a direct dependency.
fn abandon_group(child: &mut async_process::Child) {
    let pid = child.id();
    let _ = std::process::Command::new("kill")
        .arg("-KILL")
        .arg(format!("-{pid}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

/// What the probe spawns: the adapter's own launch line, in the account's home.
///
/// The env is the whole of the account binding, and it is the same pair a
/// session spawns with. Without it every probe answered as whichever login the
/// process inherited, so one account's models were cached under another's name.
fn probe_spec(
    adapter: &AgentAdapter,
    chat: &crate::agents::ChatConfig,
    home: Option<&(String, String)>,
) -> StartSpec {
    StartSpec {
        session_id: String::new(),
        // Inherited for a claude probe, which never opens a session and so has
        // no project for a directory to be attached to. The ACP arm replaces
        // it, because a `session/new` in whatever directory Tori was launched
        // from would file a phantom session inside a real project.
        cwd: String::new(),
        program: crate::settings::agent_override(&adapter.id).unwrap_or_else(|| chat.program.clone()),
        args: chat.base_args.clone(),
        env: home.cloned().into_iter().collect(),
    }
}

/// Ask one account of one agent, with the version the caller already knows.
///
/// The version is a parameter rather than probed here so that it is the *same*
/// number the staleness check compares against. Deriving it independently would
/// let a catalogue record one version while the invalidation rule read another,
/// which is a cache that goes stale without ever saying so.
///
/// `home` is the adapter's home variable and the profile's canonical path, from
/// [`crate::accounts::spawn_env`], and `None` is the default account. Same pair
/// a session spawns with, so the catalogue is the answer of the account the
/// picker is about to start rather than of whoever probed last.
pub fn probe_with(
    adapter: &AgentAdapter,
    home: Option<&(String, String)>,
    version: Option<String>,
    deadline: Duration,
) -> Result<Catalogue, ProbeFailure> {
    let Some(chat) = adapter.chat.as_ref() else {
        return Err(ProbeFailure::now(
            FailureReason::Unsupported,
            format!("{} has no chat transport", adapter.label),
        ));
    };

    let mut spec = probe_spec(adapter, chat, home);

    // Exhaustive, so a new transport is a compile error here rather than a
    // agent that silently never gets a catalogue.
    let outcome = match chat.transport {
        ChatTransport::ClaudeStreamJson => {
            probe_claude(&spec, version, deadline, &chat.effort_extras).map(|mut c| {
                let extras = user_configured_models(&claude_settings_path(home), &c.models);
                c.models.extend(extras);
                c
            })
        }
        ChatTransport::Acp => match probe_cwd_ready() {
            Ok(cwd) => {
                spec.cwd = cwd;
                probe_acp(&spec, &chat.acp, version, deadline)
            }
            // Nothing to blame the agent for: Tori could not make the one
            // directory it is willing to open a phantom session in, so it does
            // not open one anywhere else.
            Err(e) => Err(ProbeFailure::now(FailureReason::Unsupported, e)),
        },
    };

    // Only a child that started and then said nothing is worth a second
    // question. A spawn failure has already explained itself, and a timeout has
    // said nothing about anybody's credentials.
    match outcome {
        Err(f) if f.reason == FailureReason::NoAnswer => Err(refine_signed_out(adapter, home, f)),
        other => other,
    }
}

/// Upgrade a silent failure to [`FailureReason::SignedOut`] when the agent's
/// own probe says so.
///
/// Measured rather than inferred: the adapter's `[accounts]` table names a real
/// command whose exit code answers the question, so nothing here reads the
/// stderr tail for auth-shaped words. A agent that declares no such probe
/// keeps the original reason, because "we cannot tell" must not render as an
/// accusation.
///
/// Asked in the same home the probe ran in. With no home it answered for the
/// default account, so a Fonn probe that failed while the personal account was
/// signed in kept a reason it had no evidence for, and the reverse read as an
/// accusation against an account that was signed in.
fn refine_signed_out(
    adapter: &AgentAdapter,
    home: Option<&(String, String)>,
    failure: ProbeFailure,
) -> ProbeFailure {
    let (Some(path), Some(accounts)) = (crate::env::resolve_binary(&adapter.program), adapter.accounts.as_ref())
    else {
        return failure;
    };
    if crate::auth::whoami(&path, accounts, home).state == crate::auth::SignIn::SignedOut {
        return ProbeFailure { reason: FailureReason::SignedOut, ..failure };
    }
    failure
}

// --- models the user configured rather than the agent published ---

/// The settings file of the account being probed: `<home>/settings.json` for an
/// added profile, and for the default one `$CLAUDE_CONFIG_DIR/settings.json`
/// else `~/.claude/settings.json`.
///
/// The process's own variable is read **only** for the default account, which is
/// the account it describes. Reading it for a profile would have credited the
/// launching environment's pinned models to every account on the machine.
fn claude_settings_path(home: Option<&(String, String)>) -> PathBuf {
    if let Some((_, dir)) = home {
        return PathBuf::from(dir).join("settings.json");
    }
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"))
        .join("settings.json")
}

fn is_model_env_key(key: &str) -> bool {
    key.starts_with("ANTHROPIC_") && key.ends_with("_MODEL")
}

/// Model ids the user pinned in claude's own settings, as extra catalogue rows.
///
/// These belong in the picker: `model` and the `ANTHROPIC_*_MODEL` variables are
/// what that CLI will actually run, and a catalogue that omitted them would make
/// the picker disagree with the binary. They are marked rather than mixed in,
/// because the provenance differs and the surface should be able to say so.
///
/// **Every failure is silence.** A missing file is the common case, and a
/// malformed one is a file Tori does not own and must not fail on; either way
/// the answer is no extras, never an error and never a guess at what was meant.
fn user_configured_models(path: &Path, known: &[CatalogModel]) -> Vec<CatalogModel> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(settings) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };

    let mut found: Vec<(String, String)> = Vec::new();
    if let Some(model) = settings["model"].as_str() {
        found.push((model.to_string(), "settings.json `model`".to_string()));
    }
    if let Some(env) = settings["env"].as_object() {
        for (key, value) in env {
            if let (true, Some(id)) = (is_model_env_key(key), value.as_str()) {
                found.push((id.to_string(), format!("settings.json `env.{key}`")));
            }
        }
    }

    let mut extras: Vec<CatalogModel> = Vec::new();
    for (id, source) in found {
        let already_published = known.iter().any(|m| m.info.value == id || m.info.resolved_model == id);
        let already_added = extras.iter().any(|m| m.info.value == id);
        if already_published || already_added {
            continue;
        }
        extras.push(CatalogModel {
            info: ChatModelInfo {
                value: id.clone(),
                // Deliberately empty: the user's string is passed to the CLI
                // unresolved, and writing `id` here would claim a resolution
                // nothing measured.
                resolved_model: String::new(),
                display_name: id,
                description: format!("Configured in {source}"),
                supports_effort: false,
                supported_effort_levels: Vec::new(),
                effort_levels: Vec::new(),
                supports_auto_mode: false,
                // A configured string is passed to the CLI unresolved, so no
                // catalogue row backs it and no capability can be claimed for it.
                supports_fast_mode: false,
                supports_adaptive_thinking: false,
            },
            user_configured: true,
            // An annotation decorates a model the agent named, and this row is
            // one the agent was never asked about.
            options: Vec::new(),
        });
    }
    extras
}

// --- the Tauri surface ---

/// One lock per (agent, account), so probes are concurrent across pairs and
/// sequential within one.
///
/// Two sweeps overlapping on the same pair would spawn two of its binaries
/// and race to write one file; two different pairs write different files and
/// should not queue behind each other. Keyed on the pair rather than the agent
/// because that is what the file is keyed on: an agent-wide lock would make a
/// Fonn re-check wait out a 45-second default-account timeout for nothing. The
/// map only ever grows by the number of accounts, so nothing prunes it.
fn agent_lock(agent_id: &str, profile_id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<(String, String), Arc<Mutex<()>>>>> = OnceLock::new();
    let mut map = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry((agent_id.to_string(), profile_id.to_string())).or_default().clone()
}

/// Every agent that could have a catalogue, in adapter order.
fn probeable() -> Vec<&'static AgentAdapter> {
    crate::agents::registry().iter().filter(|a| a.chat.is_some()).collect()
}

/// Probe one account of one agent and write the result, keeping any previous
/// good catalogue.
fn refresh_one(
    adapter: &AgentAdapter,
    profile_id: &str,
    home: Option<&(String, String)>,
    version: Option<String>,
) -> ModelCatalog {
    let lock = agent_lock(&adapter.id, profile_id);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    let root = catalog_root();
    let mut catalog = load_from(&root, &adapter.id, profile_id);
    catalog.absorb(probe_with(adapter, home, version, PROBE_DEADLINE));
    // A write that fails leaves the answer correct for this call and forgotten
    // by the next one. Worth neither an error the caller must render nor a
    // silent claim that it persisted, so it is dropped and the value returned.
    let _ = save_to(&root, &catalog);
    catalog
}

/// The binary version each adapter is currently running, from the cached health
/// sweep. Reused rather than re-probed so the recorded version and the staleness
/// comparison are the same measurement.
async fn versions() -> HashMap<String, Option<String>> {
    crate::health::agent_health().await.into_iter().map(|h| (h.id, h.version)).collect::<HashMap<_, _>>()
}

/// What Tori remembers, one row per (agent with a chat transport, account).
///
/// Every account in `accounts.json`, including ones nobody has probed: a row in
/// the never-probed state is what tells the frontend a Fonn catalogue is due,
/// where an absent row would read as an agent that has no such account.
///
/// **Reads only.** No spawn, no subprocess, nothing that could take a second:
/// this is what a settings page or a picker calls on open, and a read that
/// probed would make opening Settings launch every agent binary on the machine.
/// Probing is [`refresh_model_catalog`], a separate command for exactly that
/// reason.
#[tauri::command]
pub async fn model_catalogs() -> Vec<ModelCatalog> {
    let root = catalog_root();
    let file = crate::accounts::load();
    let mut out = Vec::new();
    for adapter in probeable() {
        for profile in crate::accounts::profiles_for(&file, &adapter.id) {
            out.push(load_from(&root, &adapter.id, &profile.id));
        }
    }
    out
}

/// Re-ask one account of one agent, whatever its current state.
///
/// Unconditional on purpose: this is the detail page's Check again, and a
/// `versionUnknown` binary has no other route back to a fresh answer.
///
/// A profile that cannot be resolved is an `Err` rather than a stored failure.
/// The row it would have been written under is gone (the reachable way here is
/// a removal racing an open picker), so a cache file recording it would outlive
/// the account it names.
#[tauri::command]
pub async fn refresh_model_catalog(
    agent_id: String,
    profile_id: Option<String>,
) -> Result<ModelCatalog, String> {
    let adapter = crate::agents::find(&agent_id).ok_or_else(|| format!("unknown agent {agent_id}"))?;
    let profile = profile_id.as_deref().unwrap_or(crate::accounts::DEFAULT_PROFILE_ID);
    let home = crate::accounts::profile_pair(adapter, &crate::accounts::load(), Some(profile))?;
    let version = versions().await.get(&agent_id).cloned().flatten();
    Ok(refresh_one(adapter, profile, home.as_ref(), version))
}

/// Fold a live session's handshake into the cache, so the next draft opens on
/// what this account said most recently rather than on what the last probe
/// heard. A plugin installed after the probe is the measured case: nothing
/// re-probes for it, since [`ModelCatalog::is_stale`] is keyed on the binary's
/// version, so the cache stayed without it until an explicit Ask again.
///
/// Commands only. Models are re-resolved by the probe on every version change
/// and carry `user_configured` and per-row options the live list does not.
/// A never-probed account is left alone: a catalogue built from a handshake
/// would have no version to go stale against, and the draft's own due check
/// probes it anyway.
#[tauri::command]
pub async fn record_live_catalog(
    agent_id: String,
    profile_id: Option<String>,
    commands: Vec<SlashCommand>,
) -> Result<ModelCatalog, String> {
    let profile = profile_id.unwrap_or_else(|| crate::accounts::DEFAULT_PROFILE_ID.to_string());
    crate::exec::blocking("record_live_catalog", move || {
        let lock = agent_lock(&agent_id, &profile);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let root = catalog_root();
        let mut catalog = load_from(&root, &agent_id, &profile);
        if let Some(cat) = catalog.catalogue.as_mut() {
            if !commands.is_empty() && cat.commands != commands {
                cat.commands = commands;
                save_to(&root, &catalog)?;
            }
        }
        Ok(catalog)
    })
    .await
}

// There is deliberately **no batch refresh command.** One existed, sweeping
// every never-probed or stale agent on its own threads and returning the lot,
// and it was the wrong shape for the only caller there is: a batch answers when
// its *slowest* member does, so one agent hitting [`PROBE_DEADLINE`] would hold
// every row on the page empty for 45 seconds. The frontend asks per agent
// instead (`refreshDueCatalogs` in `modelCatalog.ts`), so each row fills as its
// own probe lands and a refusal is one row's error rather than everyone's wait.
// Deciding what is due needs the cache and the versions, which that side already
// has. Concurrency is unaffected: [`agent_lock`] is per agent, so parallel
// calls run in parallel.

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("tori-catalog-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    fn a_catalogue(version: Option<&str>) -> Catalogue {
        Catalogue {
            version: version.map(str::to_string),
            shape: CACHE_SHAPE,
            probed_at_ms: 1_700_000_000_000,
            models: vec![CatalogModel {
                info: ChatModelInfo {
                    value: "sonnet".into(),
                    resolved_model: "claude-sonnet-5".into(),
                    display_name: "Sonnet 5".into(),
                    description: String::new(),
                    supports_effort: true,
                    supported_effort_levels: vec!["low".into(), "high".into()],
                    effort_levels: Vec::new(),
                    supports_auto_mode: true,
                    supports_fast_mode: false,
                    supports_adaptive_thinking: false,
                },
                user_configured: false,
                options: Vec::new(),
            }],
            modes: Vec::new(),
            options: Vec::new(),
            account: None,
            commands: vec![SlashCommand {
                name: "review".into(),
                description: "Review the diff".into(),
                argument_hint: None,
                aliases: Vec::new(),
            }],
            capabilities: None,
        }
    }

    // --- the three states ---

    /// A agent nobody asked is not an error and not an empty catalogue. The
    /// distinction is the whole reason `state` exists: the surface renders no
    /// count here, where it would render "0 models" for a probed-but-empty one.
    #[test]
    fn a_agent_nobody_asked_is_never_probed() {
        let catalog = ModelCatalog::never_probed("claude", "default");
        assert_eq!(catalog.state, CatalogState::NeverProbed);
        assert!(catalog.catalogue.is_none());
        assert!(catalog.last_failure.is_none());
    }

    #[test]
    fn an_answered_probe_is_probed() {
        let mut catalog = ModelCatalog::never_probed("claude", "default");
        catalog.absorb(Ok(a_catalogue(Some("2.1.231"))));
        assert_eq!(catalog.state, CatalogState::Probed);
        assert_eq!(catalog.catalogue.as_ref().unwrap().models.len(), 1);
        assert!(catalog.last_failure.is_none());
    }

    #[test]
    fn a_failure_carries_its_reason() {
        let mut catalog = ModelCatalog::never_probed("claude", "default");
        catalog.absorb(Err(ProbeFailure::now(FailureReason::SignedOut, "not logged in")));
        assert_eq!(catalog.state, CatalogState::Failed);
        assert_eq!(catalog.last_failure.as_ref().unwrap().reason, FailureReason::SignedOut);
        assert!(catalog.catalogue.is_none(), "there was never a catalogue to keep");
    }

    /// The rule the whole record shape exists for: a signed-out moment, or one
    /// slow cold start, must not turn a working picker into an empty one.
    #[test]
    fn a_failed_probe_never_clobbers_a_good_catalogue() {
        let mut catalog = ModelCatalog::never_probed("claude", "default");
        catalog.absorb(Ok(a_catalogue(Some("2.1.231"))));
        catalog.absorb(Err(ProbeFailure::now(FailureReason::TimedOut, String::new())));

        assert_eq!(catalog.state, CatalogState::Failed, "the surface must be able to show the error");
        let kept = catalog.catalogue.as_ref().expect("the good catalogue survived the failure");
        assert_eq!(kept.models[0].info.value, "sonnet");
        assert_eq!(kept.version.as_deref(), Some("2.1.231"), "and it still reports its own age");
    }

    /// And an answer clears the failure, so an error does not stick around
    /// contradicting a catalogue that has just been refreshed.
    #[test]
    fn an_answer_clears_a_previous_failure() {
        let mut catalog = ModelCatalog::never_probed("claude", "default");
        catalog.absorb(Err(ProbeFailure::now(FailureReason::SpawnFailed, "no binary")));
        catalog.absorb(Ok(a_catalogue(Some("2.1.231"))));
        assert_eq!(catalog.state, CatalogState::Probed);
        assert!(catalog.last_failure.is_none());
    }

    // --- the store ---

    #[test]
    fn the_stored_file_round_trips() {
        let root = temp_root("roundtrip");
        let mut written = ModelCatalog::never_probed("claude", "default");
        written.absorb(Ok(a_catalogue(Some("2.1.231"))));
        save_to(&root, &written).expect("the file should write");

        let read = load_from(&root, "claude", "default");
        assert_eq!(read, written);
        assert_eq!(read.state, CatalogState::Probed, "state survives as a derived value");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failure_round_trips_alongside_the_catalogue_it_kept() {
        let root = temp_root("roundtrip-failure");
        let mut written = ModelCatalog::never_probed("claude", "default");
        written.absorb(Ok(a_catalogue(Some("2.1.231"))));
        written.absorb(Err(ProbeFailure::now(FailureReason::SignedOut, "run `claude auth login`")));
        save_to(&root, &written).expect("the file should write");

        let read = load_from(&root, "claude", "default");
        assert_eq!(read, written);
        assert_eq!(read.state, CatalogState::Failed);
        assert!(read.catalogue.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The file is derived state, so deleting it by hand must be a supported
    /// move rather than a way to break the app.
    #[test]
    fn a_deleted_file_degrades_to_never_probed() {
        let root = temp_root("deleted");
        let mut written = ModelCatalog::never_probed("claude", "default");
        written.absorb(Ok(a_catalogue(Some("2.1.231"))));
        save_to(&root, &written).unwrap();
        std::fs::remove_file(catalog_path(&root, "claude", "default")).unwrap();

        let read = load_from(&root, "claude", "default");
        assert_eq!(read.state, CatalogState::NeverProbed);
        assert_eq!(read.agent_id, "claude");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_corrupt_file_degrades_to_never_probed_rather_than_erroring() {
        let root = temp_root("corrupt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(catalog_path(&root, "claude", "default"), "{ not json").unwrap();
        assert_eq!(load_from(&root, "claude", "default").state, CatalogState::NeverProbed);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A agent id reaches the filesystem, and adapter ids come from user TOML.
    #[test]
    fn a_agent_id_cannot_escape_the_catalog_directory() {
        let root = Path::new("/tmp/tori-catalogs");
        assert_eq!(catalog_path(root, "../../etc/passwd", "default"), root.join("______etc_passwd.json"));
    }

    // --- one catalogue per account ---

    /// The default account keeps the bare name it has always had, so nothing
    /// written before accounts existed is orphaned; an added one is suffixed.
    #[test]
    fn the_default_account_keeps_the_bare_file_name_and_an_added_one_is_suffixed() {
        let root = Path::new("/tmp/tori-catalogs");
        assert_eq!(catalog_path(root, "claude", "default"), root.join("claude.json"));
        assert_eq!(catalog_path(root, "claude", "fonn"), root.join("claude__fonn.json"));
    }

    /// And the file already on disk reads as that account's answer rather than
    /// as a agent nobody has asked.
    #[test]
    fn a_cache_written_before_the_account_field_reads_as_the_default_account() {
        let root = temp_root("pre-accounts");
        std::fs::create_dir_all(&root).unwrap();
        let mut written = ModelCatalog::never_probed("claude", "default");
        written.absorb(Ok(a_catalogue(Some("2.1.231"))));
        let mut json = serde_json::to_value(&written).unwrap();
        json.as_object_mut().unwrap().remove("profileId");
        std::fs::write(catalog_path(&root, "claude", "default"), json.to_string()).unwrap();

        let read = load_from(&root, "claude", "default");
        assert_eq!(read.profile_id, "default");
        assert_eq!(read.state, CatalogState::Probed, "the answer survives the new key");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Two accounts of one agent are two files and two answers, which is the
    /// whole point: they can be on different plans.
    #[test]
    fn each_account_keeps_its_own_answer() {
        let root = temp_root("per-account");
        let mut default = ModelCatalog::never_probed("claude", "default");
        default.absorb(Ok(a_catalogue(Some("2.1.231"))));
        let mut fonn = ModelCatalog::never_probed("claude", "fonn");
        fonn.absorb(Err(ProbeFailure::now(FailureReason::SignedOut, "not logged in")));
        save_to(&root, &default).unwrap();
        save_to(&root, &fonn).unwrap();

        assert!(root.join("claude__fonn.json").exists(), "the added account writes its own file");
        assert_eq!(load_from(&root, "claude", "default"), default);
        assert_eq!(load_from(&root, "claude", "fonn"), fonn);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Removing an account takes its catalogue with it, and leaves every other
    /// account's alone.
    #[test]
    fn forgetting_an_account_deletes_only_its_own_catalogue() {
        let root = temp_root("forget");
        let mut default = ModelCatalog::never_probed("claude", "default");
        default.absorb(Ok(a_catalogue(Some("2.1.231"))));
        let mut fonn = ModelCatalog::never_probed("claude", "fonn");
        fonn.absorb(Ok(a_catalogue(Some("2.1.231"))));
        save_to(&root, &default).unwrap();
        save_to(&root, &fonn).unwrap();

        forget_in(&root, "claude", "fonn");
        assert_eq!(load_from(&root, "claude", "fonn").state, CatalogState::NeverProbed);
        assert_eq!(load_from(&root, "claude", "default").state, CatalogState::Probed);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `__` joins the two ids and `sanitize_segment` can produce it from either,
    /// so one path can be reached by two pairs. Handing back the other account's
    /// models is the confusion this key exists to prevent, so the mismatch reads
    /// as never probed.
    #[test]
    fn a_file_naming_another_account_is_not_read_as_this_ones_answer() {
        let root = temp_root("collision");
        let mut fonn = ModelCatalog::never_probed("claude", "fonn");
        fonn.absorb(Ok(a_catalogue(Some("2.1.231"))));
        save_to(&root, &fonn).unwrap();

        // `claude..fonn` sanitizes onto the same file the pair above wrote.
        assert_eq!(
            catalog_path(&root, "claude..fonn", "default"),
            catalog_path(&root, "claude", "fonn"),
        );
        assert_eq!(load_from(&root, "claude..fonn", "default").state, CatalogState::NeverProbed);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Probes queue per account rather than per agent, so a Fonn re-check does
    /// not wait out the default account's 45-second deadline.
    #[test]
    fn one_account_probing_does_not_hold_up_another() {
        let held = agent_lock("claude", "default");
        let _guard = held.lock().unwrap();

        let started = std::time::Instant::now();
        let other = agent_lock("claude", "fonn");
        let taken = other.try_lock().is_ok();

        assert!(taken, "the other account's lock is a different lock");
        assert!(started.elapsed() < Duration::from_secs(1), "and it was not waited on");
        assert!(agent_lock("claude", "default").try_lock().is_err(), "while this one is held");
    }

    // --- user-configured extras ---

    fn write_settings(name: &str, body: &str) -> PathBuf {
        let dir = temp_root(name);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn a_configured_model_and_every_anthropic_model_variable_become_extra_rows() {
        let path = write_settings(
            "settings",
            r#"{
              "model": "opusplan",
              "env": {
                "ANTHROPIC_MODEL": "claude-opus-5-20260101",
                "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001",
                "ANTHROPIC_API_KEY": "sk-not-a-model",
                "ANTHROPIC_BASE_URL": "https://example.invalid"
              }
            }"#,
        );
        let extras = user_configured_models(&path, &[]);

        let mut ids: Vec<&str> = extras.iter().map(|m| m.info.value.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["claude-haiku-4-5-20251001", "claude-opus-5-20260101", "opusplan"]);
        assert!(extras.iter().all(|m| m.user_configured), "provenance rides every extra row");
        assert!(
            extras.iter().all(|m| m.info.resolved_model.is_empty()),
            "Tori cannot resolve a configured string, so it claims no resolution"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The catalogue is the authority. A configured id the agent already
    /// published must not appear twice in a picker, under two provenances.
    #[test]
    fn a_configured_id_the_agent_already_published_is_not_added_again() {
        let path = write_settings("settings-dupe", r#"{"model": "sonnet", "env": {"ANTHROPIC_MODEL": "claude-sonnet-5"}}"#);
        let extras = user_configured_models(&path, &a_catalogue(None).models);
        assert!(extras.is_empty(), "`sonnet` is a published value and `claude-sonnet-5` its resolution");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_malformed_or_missing_settings_file_degrades_to_no_extras() {
        let path = write_settings("settings-malformed", "{ oops");
        assert!(user_configured_models(&path, &[]).is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());

        assert!(user_configured_models(Path::new("/nonexistent/settings.json"), &[]).is_empty());
    }

    /// Which account's pinned models these are. An added profile's live inside
    /// its own home; the process's `CLAUDE_CONFIG_DIR` describes the account
    /// Tori inherited, so it answers for the default one and nobody else.
    #[test]
    fn the_configured_models_come_from_the_account_being_probed() {
        let home = ("CLAUDE_CONFIG_DIR".to_string(), "/tmp/tori-homes/claude-fonn".to_string());
        assert_eq!(
            claude_settings_path(Some(&home)),
            Path::new("/tmp/tori-homes/claude-fonn/settings.json"),
        );
        assert!(claude_settings_path(None).ends_with("settings.json"));
        assert!(!claude_settings_path(None).starts_with("/tmp/tori-homes"));
    }

    /// The probe spawns in the account's home, so the answer is that account's.
    /// Without this every probe answered as whatever login the process
    /// inherited, and the catalogue was filed under the account that asked.
    #[test]
    fn a_probe_runs_in_the_accounts_own_home() {
        let claude = crate::agents::find("claude").expect("claude is a registered adapter");
        let chat = claude.chat.as_ref().expect("claude has a chat transport");
        let home = ("CLAUDE_CONFIG_DIR".to_string(), "/tmp/tori-homes/claude-fonn".to_string());

        let scoped = probe_spec(claude, chat, Some(&home));
        assert_eq!(scoped.env.get("CLAUDE_CONFIG_DIR").map(String::as_str), Some("/tmp/tori-homes/claude-fonn"));
        assert!(probe_spec(claude, chat, None).env.is_empty(), "the default account sets nothing");
    }

    #[test]
    fn only_anthropic_model_variables_count() {
        assert!(is_model_env_key("ANTHROPIC_MODEL"));
        assert!(is_model_env_key("ANTHROPIC_DEFAULT_OPUS_MODEL"));
        assert!(!is_model_env_key("ANTHROPIC_API_KEY"));
        assert!(!is_model_env_key("OTHER_MODEL"));
    }

    // --- the probe's bounds ---

    fn sh(script: &str) -> StartSpec {
        StartSpec {
            session_id: String::new(),
            cwd: String::new(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: HashMap::new(),
        }
    }

    /// The deadline is what stops a hung agent from wedging the sweep, so it
    /// is driven here rather than trusted. The child holds its stdout open and
    /// answers nothing, which is exactly the hang shape; the probe ends on its
    /// own, with a reason, and kills the child on the way out.
    ///
    /// A short deadline rather than [`PROBE_DEADLINE`], which is why that value
    /// is a parameter: a test that waited the real 45s would be one nobody runs.
    #[test]
    fn a_silent_child_times_out_rather_than_wedging() {
        let started = std::time::Instant::now();
        let failure = probe_claude(&sh("sleep 30"), None, Duration::from_millis(300), &[])
            .expect_err("a child that never answers cannot produce a catalogue");

        assert_eq!(failure.reason, FailureReason::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5), "the probe returned on its own deadline");
    }

    /// A child that exits without answering is a different sentence from one
    /// that hung, and the surface says so.
    #[test]
    fn a_child_that_exits_without_answering_is_no_answer() {
        let failure = probe_claude(&sh("exit 0"), None, PROBE_DEADLINE, &[]).expect_err("nothing was answered");
        assert_eq!(failure.reason, FailureReason::NoAnswer);
    }

    /// And it quotes the agent rather than paraphrasing it.
    #[test]
    fn a_failure_carries_the_agents_own_stderr() {
        let failure = probe_claude(&sh("echo 'credit balance too low' >&2; exit 1"), None, PROBE_DEADLINE, &[])
            .expect_err("nothing was answered");
        assert_eq!(failure.detail, "credit balance too low");
    }

    /// A stderr big enough to need several reads is where the tail's two rules
    /// are actually visible: it is bounded to the **last** [`STDERR_TAIL`]
    /// bytes, and it is complete, because the probe joins the reader thread
    /// rather than sampling a buffer another thread is still filling. Without
    /// that join this truncates somewhere arbitrary, which is the failure mode
    /// that loses a agent's explanation exactly when it gave one.
    #[test]
    fn a_long_stderr_is_kept_whole_at_its_end_and_bounded() {
        let noise = STDERR_TAIL * 2 / 40;
        let script = format!("for i in $(seq {noise}); do echo 'noisy line of agent output' >&2; done; echo LAST >&2");

        let failure = probe_claude(&sh(&script), None, PROBE_DEADLINE, &[]).expect_err("nothing was answered");

        assert!(failure.detail.ends_with("LAST"), "the tail keeps the end, which is where the reason is");
        assert!(failure.detail.len() <= STDERR_TAIL, "and stays bounded: {} bytes", failure.detail.len());
    }

    #[test]
    fn a_binary_that_is_not_there_is_a_spawn_failure() {
        let spec = StartSpec {
            session_id: String::new(),
            cwd: String::new(),
            program: "/nonexistent/agent-binary".into(),
            args: Vec::new(),
            env: HashMap::new(),
        };
        let failure = probe_claude(&spec, None, PROBE_DEADLINE, &[]).expect_err("nothing to spawn");
        assert_eq!(failure.reason, FailureReason::SpawnFailed);
    }

    /// The catalogue really is read off the handshake, proved without the real
    /// binary: a stand-in that answers one `control_response` is enough, which
    /// is also the claim that the probe needs no session to get an answer.
    #[test]
    fn the_control_response_alone_produces_a_catalogue() {
        let response = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "catalog-probe-1", "response": {
                "models": [{
                    "value": "opus",
                    "resolvedModel": "claude-opus-5",
                    "displayName": "Opus 5",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["low", "high"],
                    // The lever the cached row is expected to carry, published
                    // by the handshake rather than restated in an adapter table.
                    "supportsFastMode": true,
                }],
                "account": { "subscriptionType": "Claude Max", "apiProvider": "firstParty" },
            }},
        })
        .to_string();
        // Reads its stdin (so the probe's write does not fail on a closed pipe),
        // answers once, then holds the pipe open the way the real CLI does.
        let script = format!("read -r _line; printf '%s\\n' '{response}'; sleep 5");

        let catalogue = probe_claude(&sh(&script), Some("2.1.231".into()), Duration::from_secs(10), &[])
            .expect("the stand-in answered the handshake");

        assert_eq!(catalogue.version.as_deref(), Some("2.1.231"));
        assert_eq!(catalogue.models.len(), 1);
        assert_eq!(catalogue.models[0].info.resolved_model, "claude-opus-5");
        assert_eq!(catalogue.models[0].info.supported_effort_levels, ["low", "high"]);
        assert!(!catalogue.models[0].user_configured);
        assert_eq!(catalogue.account.unwrap().subscription_type, "Claude Max");

        // The cached row carries what a live session on this model would
        // publish, from the same function, so a draft and the chat it becomes
        // cannot disagree about claude's own levers.
        assert_eq!(
            catalogue.models[0].options,
            claude::config_options(&catalogue.models[0].info, None)
        );
        assert_eq!(catalogue.models[0].options.len(), 1);
        assert!(catalogue.models[0].options[0].disabled);
        // Claude has no per-session set at all: its levers are per model.
        assert!(catalogue.options.is_empty());
    }

    // --- the ACP probe ---

    use agent_client_protocol::schema::v1::SessionConfigOptionCategory as Category;

    fn select_option(id: &str, category: Option<Category>, entries: &[(&str, &str)]) -> SessionConfigOption {
        use agent_client_protocol::schema::v1::{
            SessionConfigId, SessionConfigKind, SessionConfigSelect, SessionConfigSelectOption,
            SessionConfigSelectOptions, SessionConfigValueId,
        };

        let options: Vec<SessionConfigSelectOption> = entries
            .iter()
            .map(|(value, name)| SessionConfigSelectOption::new(SessionConfigValueId::new(*value), *name))
            .collect();
        let current = SessionConfigValueId::new(entries[0].0);
        let select = SessionConfigSelect::new(current, SessionConfigSelectOptions::Ungrouped(options));
        let mut option =
            SessionConfigOption::new(SessionConfigId::new(id), id, SessionConfigKind::Select(select));
        option.category = category;
        option
    }

    fn init_response(closes: bool) -> agent_client_protocol::schema::v1::InitializeResponse {
        use agent_client_protocol::schema::v1::{InitializeResponse, SessionCloseCapabilities};
        use agent_client_protocol::schema::ProtocolVersion;

        let mut init = InitializeResponse::new(ProtocolVersion::V1);
        if closes {
            init.agent_capabilities.session_capabilities.close = Some(SessionCloseCapabilities::new());
        }
        init
    }

    /// Both ways round, because the cost of getting it wrong differs by
    /// direction: skipping the close on an agent that serves it leaves a session
    /// alive for nothing, and sending it to one that does not is a request Tori
    /// would then have to explain away.
    #[test]
    fn a_session_is_closed_only_when_the_agent_says_it_can_be() {
        assert!(closes_sessions(&init_response(true)));
        assert!(!closes_sessions(&init_response(false)));
    }

    /// A missing account is a different sentence from a broken agent, and the
    /// surface's "Sign in" is only honest when the reason really says so.
    #[test]
    fn an_auth_required_answer_is_a_signed_out_probe() {
        use agent_client_protocol::Error;

        let auth = acp_failure(&Error::auth_required());
        assert_eq!(auth.reason, FailureReason::SignedOut);
        assert!(!auth.detail.is_empty(), "and it quotes the agent rather than paraphrasing it");

        let other = acp_failure(&Error::internal_error());
        assert_eq!(other.reason, FailureReason::NoAnswer, "not everything that fails is a login");
    }

    /// The catalogue keeps the agent's **whole** option set, not the three
    /// categories this build has controls for. Phase 5 mirrors the rest into the
    /// chat, and a cache that filtered here would be the place a new option gets
    /// lost - before anything downstream could ever see it.
    #[test]
    fn an_option_tori_has_no_control_for_is_kept_rather_than_dropped() {
        let options = vec![
            select_option("model", Some(Category::Model), &[("sonnet", "Sonnet")]),
            select_option("reasoning-depth", None, &[("shallow", "Shallow")]),
        ];

        // No per-model measurement, which is the refused-switch path: every row
        // falls back to the session's opening set.
        let catalogue = acp_catalogue(
            Some("1.18.3".into()),
            options,
            HashMap::new(),
            Vec::new(),
            ChatCapabilities::default(),
        );

        assert_eq!(catalogue.models.len(), 1, "the model selector still becomes the model list");
        assert_eq!(catalogue.models[0].info.value, "sonnet");
        let ids: Vec<&str> = catalogue.options.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, ["model", "reasoning-depth"], "and the uncategorized one survives beside it");
    }

    /// **An ACP row carries its own levers, because the agents re-cut them.**
    ///
    /// Measured 2026-08-21 by `dev/acp-probe.mjs --per-model`: switching model
    /// inside one session changes the `thought_level` selector's choices on both
    /// agents. On `@agentclientprotocol/codex-acp`, `gpt-5.6-terra` publishes
    /// six levels including `ultra` where `gpt-5.4-mini` publishes four; on
    /// `opencode acp` 1.18.3, `claude-opus-4.5` publishes two where
    /// `claude-opus-4.7` publishes five.
    ///
    /// So the session's opening set describes one model. Copying it onto every
    /// row put `ultra` on a picker for a model that refuses it, which is the
    /// offer-what-cannot-be-sent failure the whole catalogue work exists to end.
    #[test]
    fn each_acp_model_row_keeps_the_levels_its_own_answer_named() {
        let opening = vec![
            select_option("model", Some(Category::Model), &[("terra", "Terra"), ("mini", "Mini")]),
            select_option(
                "reasoning_effort",
                Some(Category::ThoughtLevel),
                &[("low", "low"), ("high", "high"), ("ultra", "ultra")],
            ),
        ];
        // What the agent answered when each model was switched to. Mini drops
        // `ultra`, which is the whole variation this exists for.
        let per_model = HashMap::from([
            ("terra".to_string(), opening.clone()),
            (
                "mini".to_string(),
                vec![
                    select_option("model", Some(Category::Model), &[("mini", "Mini"), ("terra", "Terra")]),
                    select_option(
                        "reasoning_effort",
                        Some(Category::ThoughtLevel),
                        &[("low", "low"), ("high", "high")],
                    ),
                ],
            ),
        ]);

        let catalogue = acp_catalogue(
            Some("1.2.0".into()),
            opening,
            per_model,
            Vec::new(),
            ChatCapabilities::default(),
        );
        let levels = |value: &str| {
            catalogue
                .models
                .iter()
                .find(|m| m.info.value == value)
                .unwrap_or_else(|| panic!("{value} is listed"))
                .info
                .supported_effort_levels
                .clone()
        };
        assert_eq!(levels("terra"), ["low", "high", "ultra"]);
        assert_eq!(levels("mini"), ["low", "high"], "a level this model refuses is not offered for it");

        // And the row's whole option set is cached beside the levels, so a
        // mirrored option that varies is right per model too.
        let mini = catalogue.models.iter().find(|m| m.info.value == "mini").expect("mini is listed");
        assert_eq!(
            mini.options.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(),
            ["model", "reasoning_effort"]
        );
    }

    /// A model whose switch the agent refused keeps the session's opening set
    /// rather than losing its levers: a refusal degrades one row, and an empty
    /// one would read as a model with no effort control at all.
    #[test]
    fn a_model_the_agent_would_not_switch_to_falls_back_to_the_opening_set() {
        let opening = vec![
            select_option("model", Some(Category::Model), &[("terra", "Terra"), ("mini", "Mini")]),
            select_option("reasoning_effort", Some(Category::ThoughtLevel), &[("low", "low")]),
        ];
        // Only terra answered.
        let per_model = HashMap::from([("terra".to_string(), opening.clone())]);

        let catalogue = acp_catalogue(
            Some("1.2.0".into()),
            opening,
            per_model,
            Vec::new(),
            ChatCapabilities::default(),
        );
        let mini = catalogue.models.iter().find(|m| m.info.value == "mini").expect("mini is listed");
        assert_eq!(mini.info.supported_effort_levels, ["low"]);
        assert!(!mini.options.is_empty(), "a refused switch is not an agent that publishes nothing");
    }

    /// And it survives the round trip to disk, which is what Phase 4's settings
    /// preview and Phase 5's mirror both read.
    #[test]
    fn the_full_option_set_round_trips_through_the_cache_file() {
        let root = temp_root("acp-options");
        let mut written = ModelCatalog::never_probed("opencode", "default");
        written.absorb(Ok(acp_catalogue(
            Some("1.18.3".into()),
            vec![select_option("web-search", None, &[("on", "On"), ("off", "Off")])],
            HashMap::new(),
            Vec::new(),
            ChatCapabilities::default(),
        )));
        save_to(&root, &written).expect("the file should write");

        let read = load_from(&root, "opencode", "default");
        assert_eq!(read, written);
        assert_eq!(read.catalogue.unwrap().options.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A child that dies before it speaks any JSON-RPC leaves the connection
    /// with a generic error, and the one sentence worth reading is on stderr.
    /// Losing it there would repeat the Phase 1 defect the claude tail's thread
    /// join was written for, on the other transport.
    #[test]
    fn an_agent_that_never_speaks_the_protocol_is_still_quoted() {
        let spec = StartSpec {
            session_id: String::new(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "echo 'npx: command not found' >&2; exit 127".into()],
            env: HashMap::new(),
        };
        let failure = probe_acp(&spec, &acp::AcpOverrides::default(), None, Duration::from_secs(5))
            .expect_err("a child that says nothing cannot produce a catalogue");
        assert!(
            failure.detail.contains("npx: command not found"),
            "the wrapper's own words survive: {}",
            failure.detail
        );
    }

    // --- the live probe ---

    /// The claim this whole module rests on, against the real binary: the
    /// `initialize` control response carries a catalogue, and getting it costs
    /// no session and no tokens.
    ///
    /// The token-free half is proved by construction rather than by inspection:
    /// [`probe_claude`] writes exactly one frame to stdin, and it is the
    /// handshake. There is no code path that could write a `user` frame, so a
    /// turn cannot be submitted, and the args carry no `--session-id` or
    /// `--resume`, so no session id is ever named.
    #[test]
    #[ignore = "drives the real `claude` binary"]
    fn the_real_claude_answers_a_catalogue_without_starting_a_session() {
        let claude = crate::agents::find("claude").expect("the bundled claude adapter");
        let before = session_files();

        let catalogue =
            probe_with(claude, None, Some("live".into()), PROBE_DEADLINE).expect("claude should answer the handshake");

        assert!(!catalogue.models.is_empty(), "an empty answer from a real binary is a bug");
        assert!(
            catalogue.models.iter().any(|m| !m.user_configured),
            "at least one row came from the agent itself"
        );
        assert!(
            catalogue.models.iter().filter(|m| !m.user_configured).all(|m| !m.info.resolved_model.is_empty()),
            "every published row names what it resolves to"
        );
        assert_eq!(session_files(), before, "the probe wrote no transcript");
    }

    /// The ACP half of the same claim, against `opencode acp`: one `session/new`
    /// is enough to learn the whole catalogue, and no turn is ever submitted.
    ///
    /// The no-turn half is proved by construction rather than by inspection:
    /// [`probe_acp`] sends `initialize`, `session/new` and at most
    /// `session/close`, and there is no `session/prompt` in it at all, so a turn
    /// cannot be submitted. What only a real agent can establish is that the
    /// catalogue is actually there on that answer, which is the claim the whole
    /// ACP arm rests on.
    ///
    /// Measured on `opencode acp` 1.18.3: 15 provider-qualified models and 2
    /// modes, out of exactly two config options, both of them categorized
    /// (`model`, `mode`). Asserted as "more than a couple" rather than as 15,
    /// because the number is the user's authenticated providers rather than a
    /// property of the agent. **No uncategorized option is sent by this agent**,
    /// so the rule that keeps the whole option set is pinned by a fixture rather
    /// than here; see
    /// `an_option_tori_has_no_control_for_is_kept_rather_than_dropped`.
    #[test]
    #[ignore = "drives the real `opencode` binary"]
    fn the_real_opencode_answers_a_catalogue_from_one_session() {
        let opencode = crate::agents::find("opencode").expect("the bundled opencode adapter");

        let catalogue =
            probe_with(opencode, None, Some("live".into()), PROBE_DEADLINE).expect("opencode should answer");

        assert!(catalogue.models.len() > 2, "a real answer names the user's providers: {:?}", catalogue.models);
        assert!(
            catalogue.models.iter().all(|m| !m.info.value.is_empty()),
            "every row carries the id a switch would have to name"
        );
        assert!(!catalogue.options.is_empty(), "and the agent's own option set is kept whole");
    }

    /// The same probe against Codex, and **the first live agent to publish an
    /// option Tori has no control for**.
    ///
    /// Measured on `codex-cli 0.147.0` with `@agentclientprotocol/codex-acp`
    /// 1.2.0, 2026-08-17. Four config options where opencode sends two:
    ///
    ///   * `model`, four models, each with a description,
    ///   * `mode`, three (read-only, agent, agent-full-access),
    ///   * `reasoning_effort`, **categorized `thought_level`**, six levels on
    ///     the model the session opens on and fewer on the others,
    ///   * `collaboration_mode` (default, plan), categorized as itself.
    ///
    /// That last one is the whole of Phase 5's case, live: Tori has no control
    /// for it, its category is the agent's own word, and before the mirror it
    /// was read off the wire and dropped. It is a real lever (Codex's plan mode),
    /// not a curiosity.
    ///
    /// **The effort selector's id is `reasoning_effort`, not `thought_level`.**
    /// The category is what says what it is, and reading it by id - which is the
    /// tempting shortcut, since opencode's ids do match their categories - would
    /// have found nothing here.
    ///
    /// Asserted structurally rather than by exact ids: the model list is per
    /// account (signed out, the native app-server offers seven), so pinning the
    /// four would make somebody else's entitlement a test failure.
    ///
    /// **The levels are per model and the counts differ**, which is what the
    /// probe now switches model to measure. Live on 2026-08-21: `gpt-5.6-terra`
    /// 6 (including `ultra`), `gpt-5.6-luna` 5, `gpt-5.5` and `gpt-5.4-mini` 4.
    /// This used to assert every model carried exactly five, which was two
    /// claims that had both stopped being true: `ultra` is no longer dropped
    /// (8d67733), and the opening session's list was being copied onto rows that
    /// refuse half of it.
    #[test]
    #[ignore = "drives the real `codex` binary"]
    fn the_real_codex_answers_a_catalogue_from_one_session() {
        let codex = crate::agents::find("codex").expect("the bundled codex adapter");

        let catalogue =
            probe_with(codex, None, Some("live".into()), PROBE_DEADLINE).expect("codex should answer");

        assert!(!catalogue.models.is_empty(), "the handshake names this account's models");
        assert!(
            catalogue.models.iter().all(|m| !m.info.supported_effort_levels.is_empty()),
            "every model publishes its own levels: {:?}",
            catalogue.models
        );
        // Structural rather than by count: whether this account's models happen
        // to disagree today is its entitlement, and the claim worth pinning is
        // that each row carries *its own* answer rather than one copied set.
        let per_row: Vec<&Vec<String>> =
            catalogue.models.iter().map(|m| &m.info.supported_effort_levels).collect();
        assert!(
            per_row.iter().any(|l| *l != per_row[0]) || catalogue.models.len() == 1,
            "the levels are read per model, so a catalogue whose models differ shows it: {per_row:?}"
        );
        assert!(
            catalogue.models.iter().all(|m| !m.options.is_empty()),
            "and each row caches the option set the agent answered for it: {:?}",
            catalogue.models
        );
        assert_eq!(catalogue.modes.len(), 3, "read-only, agent, agent-full-access");
        assert!(
            catalogue.capabilities.is_some_and(|c| c.image_input),
            "Codex advertises ACP image input"
        );

        let uncategorized: Vec<&str> = catalogue
            .options
            .iter()
            .filter(|o| !["model", "mode", "thought_level"].contains(&o.category.as_str()))
            .map(|o| o.id.as_str())
            .collect();
        assert!(
            uncategorized.contains(&"collaboration_mode"),
            "the option no bespoke control claims is kept, and the mirror is what renders it: {:?}",
            catalogue.options
        );
    }

    /// The phantom-session question for Codex: it **does** advertise
    /// `session/list`, so the same filter proof OpenCode gets applies here
    /// rather than the weaker "no listing, so nothing to leak" answer.
    ///
    /// Measured 2026-08-17, and the second finding is the reassuring one:
    /// **Codex's listing is scoped to the asking session's cwd.** A chat in a
    /// project directory is answered with that directory's sessions and nothing
    /// else, so a probe session opened in the probe directory is out of reach
    /// twice over - once by the agent's own scoping, and once by `adopt`'s
    /// filter, which is the half Tori controls and the half that survives an
    /// agent changing its mind about scoping.
    ///
    /// Which means this test proves the **outcome** against a real Codex, not
    /// the filter: with that scoping in place the row could not appear here
    /// whatever `adopt` did. The filter itself is pinned by
    /// `acp_sessions::a_session_toris_own_probe_opened_is_not_adopted_as_history`,
    /// and what this adds is that Codex answers listings at all, so that filter
    /// is load-bearing rather than theoretical.
    ///
    /// No turn is submitted by either agent, so this costs a launch and no
    /// tokens. Run with `--test-threads=1`: it redirects the locator store, a
    /// process-global for the reason `acp_sessions` documents.
    #[test]
    #[ignore = "drives the real `codex` binary twice"]
    fn a_codex_probe_is_not_adopted_into_the_history_a_chat_lists() {
        use crate::chat::acp_sessions;
        use crate::chat::acp_transport::AcpTransport;
        use crate::chat::transport::{new_sink, AgentTransport};

        let codex = crate::agents::find("codex").expect("the bundled codex adapter");
        let chat = codex.chat.as_ref().expect("with an ACP chat transport");

        let root = std::env::temp_dir().join(format!("tori-codex-phantom-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        acp_sessions::use_dir_for_tests(root.join("locators"));

        probe_with(codex, None, None, PROBE_DEADLINE).expect("codex should answer the probe");

        let id = "live-codex-phantom";
        let args = crate::chat::commands::build_args(chat, id, false, None, None, None, None, &[]);
        let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = seen.clone();
        let mut transport = AcpTransport::new(id, &codex.id, chat.acp.clone());
        transport
            .start(
                StartSpec {
                    session_id: id.to_string(),
                    cwd: root.to_string_lossy().into_owned(),
                    program: chat.program.clone(),
                    args,
                    env: std::collections::HashMap::new(),
                },
                new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev))),
            )
            .expect("the adapter's launch should start the agent");

        let mut lists = None;
        for _ in 0..120 {
            lists = seen.lock().unwrap().iter().find_map(|e| match e {
                ChatEvent::SessionReady { capabilities, .. } => *capabilities,
                _ => None,
            });
            if lists.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let capabilities = lists.expect("codex answers the handshake");
        assert!(
            capabilities.list_sessions,
            "codex advertises session/list, so the filter is what keeps the probe out"
        );

        // The listing runs behind the session opening, so this waits on its
        // effect (locators on disk) rather than on an event of its own.
        let mut adopted = Vec::new();
        for _ in 0..40 {
            adopted = acp_sessions::all();
            if !adopted.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let _ = transport.close();

        // Loudly, and before the real assertion: an empty store means the chat
        // never opened, and "no probe row" is then true of a test that measured
        // nothing at all.
        assert!(
            !adopted.is_empty(),
            "the chat session must reach the locator store for its listing to mean anything"
        );
        let spellings = probe_cwd_spellings();
        assert!(
            !adopted.iter().any(|s| spellings.contains(&s.cwd)),
            "a session opened in the probe directory is never adopted as the user\'s history: {adopted:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The hygiene claim, end to end: the probe's session exists on the agent's
    /// side (there is no verb that would delete it), and it is nonetheless not
    /// in the history Tori would show.
    ///
    /// Run with `--test-threads=1`: it redirects the locator store, which is a
    /// process-global for the reason `acp_sessions` documents.
    #[test]
    #[ignore = "drives the real `opencode` binary"]
    fn a_probe_leaves_nothing_in_the_history_tori_would_adopt() {
        let opencode = crate::agents::find("opencode").expect("the bundled opencode adapter");
        probe_with(opencode, None, None, PROBE_DEADLINE).expect("opencode should answer");

        let probe_dir = probe_cwd_ready().expect("the probe directory exists after a probe");
        let listed = crate::chat::acp_sessions::ListedSession {
            acp_session_id: "ses_probe".to_string(),
            cwd: probe_dir,
            title: None,
            updated_at: None,
        };
        let adopted =
            crate::chat::acp_sessions::adopt("opencode", &[listed], &[], 0, &probe_cwd_spellings());
        assert!(adopted.is_empty(), "a row in the probe directory is never adopted as the user's history");
    }

    /// Every jsonl under claude's discovery dir, so the live test can prove it
    /// created none.
    fn session_files() -> usize {
        let dir = dirs::home_dir().unwrap_or_default().join(".claude/projects");
        walk(&dir)
    }

    fn walk(dir: &Path) -> usize {
        let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
        entries
            .filter_map(Result::ok)
            .map(|e| {
                let path = e.path();
                if path.is_dir() {
                    walk(&path)
                } else {
                    usize::from(path.extension().is_some_and(|x| x == "jsonl"))
                }
            })
            .sum()
    }
}
