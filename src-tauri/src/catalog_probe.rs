//! Asking a agent what it can run, and remembering the answer.
//!
//! Sway ships no model list. Every model, mode and option a picker offers is
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
//! record, so the leftover is filtered out of Sway's own history by where it was
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

use agent_client_protocol::schema::v1::{CloseSessionRequest, SessionConfigOption};
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo, ErrorCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::{AgentAdapter, ChatAnnotation, ChatTransport};
use crate::chat::acp;
use crate::chat::acp_transport::{initialize_request, new_session_request};
use crate::chat::claude::{self, ClaudeMapper};
use crate::chat::model::{ChatAccount, ChatConfigOption, ChatEvent, ChatModeInfo, ChatModelInfo};
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
    /// reason because it is a fact about Sway, not about the agent, and the
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
    /// Still not something Sway invented - the user wrote the id - but Sway
    /// cannot confirm it: a configured string is passed to `--model` unresolved,
    /// so such a row carries an empty `resolved_model` and anything deduping by
    /// that field must fall back to `value` rather than collapsing every
    /// user-configured row into one.
    #[serde(default)]
    pub user_configured: bool,
    /// The levers this agent has **for this model**, when they depend on it.
    ///
    /// Claude's do: the CLI publishes no options at all, so Sway assembles them
    /// per model row. An ACP agent's are per session rather than per model and
    /// live on the catalogue itself, so its rows leave this empty.
    #[serde(default)]
    pub options: Vec<ChatConfigOption>,
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
    pub probed_at_ms: u64,
    pub models: Vec<CatalogModel>,
    /// Empty for a agent whose modes are declared in its adapter TOML rather
    /// than published on the wire, which is claude today.
    #[serde(default)]
    pub modes: Vec<ChatModeInfo>,
    /// The agent's own config options, including the ones Sway has no bespoke
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
}

/// Everything Sway remembers about one agent's catalogue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    /// Aliased for the cache files written before the rename: a miss here reads
    /// as a never-probed agent, quietly throwing away a real answer.
    #[serde(alias = "harnessId")]
    pub agent_id: String,
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
    fn settled(agent_id: String, catalogue: Option<Catalogue>, last_failure: Option<ProbeFailure>) -> Self {
        let state = match (&last_failure, &catalogue) {
            (Some(_), _) => CatalogState::Failed,
            (None, Some(_)) => CatalogState::Probed,
            (None, None) => CatalogState::NeverProbed,
        };
        Self { agent_id, state, catalogue, last_failure }
    }

    pub fn never_probed(agent_id: impl Into<String>) -> Self {
        Self::settled(agent_id.into(), None, None)
    }

    /// Fold a probe's outcome into this record.
    ///
    /// **A failure keeps the catalogue.** That is the whole reason this is a
    /// method rather than a fresh record per probe: replacing the record on
    /// failure would turn a signed-out moment, or one slow cold start, into a
    /// agent that suddenly offers no models at all.
    fn absorb(&mut self, outcome: Result<Catalogue, ProbeFailure>) {
        match outcome {
            Ok(catalogue) => *self = Self::settled(self.agent_id.clone(), Some(catalogue), None),
            Err(failure) => {
                *self = Self::settled(self.agent_id.clone(), self.catalogue.take(), Some(failure))
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

/// `~/Library/Application Support/sway/model-catalogs` on macOS.
///
/// The data dir rather than `~/.config/sway`, for the reason `accounts.rs`
/// chose it: this is state Sway derived, not configuration a user edits, and
/// `~/.config` commonly lives in a dotfile repo. One file per agent rather
/// than one map, so deleting a single agent's answer is a `rm` and a corrupt
/// file costs one agent rather than all of them.
pub fn catalog_root() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join("sway/model-catalogs")
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

fn catalog_path(root: &Path, agent_id: &str) -> PathBuf {
    root.join(format!("{}.json", sanitize_segment(agent_id)))
}

/// Read one agent's remembered catalogue.
///
/// **Every failure is "never probed".** A missing file is the ordinary state of
/// a agent nobody has asked, and a corrupt one is derived state Sway can
/// simply ask for again; neither is worth an error the caller would have to
/// render. That is what makes the file safe to delete by hand.
pub fn load_from(root: &Path, agent_id: &str) -> ModelCatalog {
    let Ok(text) = std::fs::read_to_string(catalog_path(root, agent_id)) else {
        return ModelCatalog::never_probed(agent_id);
    };
    match serde_json::from_str::<ModelCatalog>(&text) {
        Ok(stored) => ModelCatalog::settled(stored.agent_id, stored.catalogue, stored.last_failure),
        Err(_) => ModelCatalog::never_probed(agent_id),
    }
}

pub fn save_to(root: &Path, catalog: &ModelCatalog) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    let path = catalog_path(root, &catalog.agent_id);
    let text = serde_json::to_string_pretty(catalog).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))
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
    annotations: &[ChatAnnotation],
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
                if let ChatEvent::SessionReady { models, modes, account, .. } = event {
                    let _ = tx.send(Some((models, modes, account)));
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
        Ok(Some((models, modes, account))) => Ok(Catalogue {
            version,
            probed_at_ms: now_ms(),
            models: models
                .into_iter()
                .map(|info| CatalogModel {
                    // The same function the live session emits from, so a draft
                    // and the chat it becomes cannot disagree about this model.
                    options: claude::config_options(&info, annotations),
                    info,
                    user_configured: false,
                })
                .collect(),
            modes,
            // Claude's are per model, on the rows above. This is the per-session
            // set an ACP handshake publishes, which claude has none of.
            options: Vec::new(),
            account,
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
/// So Sway cannot prevent the phantom, only recognise it, and it recognises it
/// by *where* it was opened rather than by a growing list of ids to remember.
/// One path means a probe that crashed before it could record anything, and a
/// probe from a Sway build that predates the id list that does not exist, are
/// both still recognisable. See [`probe_cwd_spellings`].
pub fn probe_cwd() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join("sway/probe")
}

/// The probe directory, created if it is not there, in the spelling an agent
/// will be handed.
///
/// Canonicalized through the same helper `accounts.rs` uses, and for a related
/// reason: a agent told about `/var/...` records `/private/var/...`, so
/// handing over the resolved form is what makes the recorded path and the one
/// Sway filters on the same string.
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
fn acp_catalogue(version: Option<String>, options: Vec<SessionConfigOption>) -> Catalogue {
    Catalogue {
        version,
        probed_at_ms: now_ms(),
        models: acp::model_catalogue(&options)
            .into_iter()
            // An ACP agent's options are per session, on the catalogue below.
            .map(|info| CatalogModel { info, user_configured: false, options: Vec::new() })
            .collect(),
        modes: acp::mode_catalogue(&options),
        options: acp::config_options(&options),
        // ACP publishes no account on the handshake. Empty rather than guessed,
        // which also means the surface's "whose answer is this" line correctly
        // says nothing for an ACP agent.
        account: None,
    }
}

/// Does this agent advertise `session/close`?
///
/// Read off the handshake, on the same rule as `acp_transport::lists_sessions`:
/// an agent that does not advertise it is never sent the method, because a
/// `method not found` is noise Sway would then have to explain. **Absence is not
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
/// filtered out of Sway's own history by [`probe_cwd_spellings`], not left for
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
    let answer = futures::executor::block_on(async {
        let work = Client.builder().name("sway").connect_with(
            ByteStreams::new(stdin, stdout),
            async move |conn: ConnectionTo<Agent>| {
                let init = conn.send_request(init_request).block_task().await?;
                let opened = conn.send_request(session_request).block_task().await?;
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
                Ok(opened.config_options.unwrap_or_default())
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
        Some(Ok(options)) => return Ok(acp_catalogue(version, options)),
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

/// Ask one agent, with the version the caller already knows.
///
/// The version is a parameter rather than probed here so that it is the *same*
/// number the staleness check compares against. Deriving it independently would
/// let a catalogue record one version while the invalidation rule read another,
/// which is a cache that goes stale without ever saying so.
pub fn probe_with(adapter: &AgentAdapter, version: Option<String>, deadline: Duration) -> Result<Catalogue, ProbeFailure> {
    let Some(chat) = adapter.chat.as_ref() else {
        return Err(ProbeFailure::now(
            FailureReason::Unsupported,
            format!("{} has no chat transport", adapter.label),
        ));
    };

    let mut spec = StartSpec {
        session_id: String::new(),
        // Inherited for a claude probe, which never opens a session and so has
        // no project for a directory to be attached to. The ACP arm below
        // replaces it, because a `session/new` in whatever directory Sway was
        // launched from would file a phantom session inside a real project.
        cwd: String::new(),
        program: crate::settings::agent_override(&adapter.id).unwrap_or_else(|| chat.program.clone()),
        args: chat.base_args.clone(),
        env: HashMap::new(),
    };

    // Exhaustive, so a new transport is a compile error here rather than a
    // agent that silently never gets a catalogue.
    let outcome = match chat.transport {
        ChatTransport::ClaudeStreamJson => probe_claude(&spec, version, deadline, &chat.annotations).map(|mut c| {
            let extras = user_configured_models(&claude_settings_path(), &c.models);
            c.models.extend(extras);
            c
        }),
        ChatTransport::Acp => match probe_cwd_ready() {
            Ok(cwd) => {
                spec.cwd = cwd;
                probe_acp(&spec, &chat.acp, version, deadline)
            }
            // Nothing to blame the agent for: Sway could not make the one
            // directory it is willing to open a phantom session in, so it does
            // not open one anywhere else.
            Err(e) => Err(ProbeFailure::now(FailureReason::Unsupported, e)),
        },
    };

    // Only a child that started and then said nothing is worth a second
    // question. A spawn failure has already explained itself, and a timeout has
    // said nothing about anybody's credentials.
    match outcome {
        Err(f) if f.reason == FailureReason::NoAnswer => Err(refine_signed_out(adapter, f)),
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
fn refine_signed_out(adapter: &AgentAdapter, failure: ProbeFailure) -> ProbeFailure {
    let (Some(path), Some(accounts)) = (crate::env::resolve_binary(&adapter.program), adapter.accounts.as_ref())
    else {
        return failure;
    };
    if crate::auth::whoami(&path, accounts, None).state == crate::auth::SignIn::SignedOut {
        return ProbeFailure { reason: FailureReason::SignedOut, ..failure };
    }
    failure
}

// --- models the user configured rather than the agent published ---

/// `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`.
fn claude_settings_path() -> PathBuf {
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
/// malformed one is a file Sway does not own and must not fail on; either way
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
                supports_auto_mode: false,
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

/// One lock per agent id, so probes are concurrent across agents and
/// sequential within one.
///
/// Two sweeps overlapping on the same agent would spawn two of its binaries
/// and race to write one file; two different agents have nothing to share and
/// should not queue behind each other. The map only ever grows by the number of
/// adapters, so nothing prunes it.
fn agent_lock(agent_id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut map = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(agent_id.to_string()).or_default().clone()
}

/// Every agent that could have a catalogue, in adapter order.
fn probeable() -> Vec<&'static AgentAdapter> {
    crate::agents::registry().iter().filter(|a| a.chat.is_some()).collect()
}

/// Probe one agent and write the result, keeping any previous good catalogue.
fn refresh_one(adapter: &AgentAdapter, version: Option<String>) -> ModelCatalog {
    let lock = agent_lock(&adapter.id);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    let root = catalog_root();
    let mut catalog = load_from(&root, &adapter.id);
    catalog.absorb(probe_with(adapter, version, PROBE_DEADLINE));
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

/// What Sway remembers, for every agent with a chat transport.
///
/// **Reads only.** No spawn, no subprocess, nothing that could take a second:
/// this is what a settings page or a picker calls on open, and a read that
/// probed would make opening Settings launch every agent binary on the machine.
/// Probing is [`refresh_model_catalog`] and [`refresh_model_catalogs`], which
/// are separate commands for exactly that reason.
#[tauri::command]
pub async fn model_catalogs() -> Vec<ModelCatalog> {
    let root = catalog_root();
    probeable().into_iter().map(|a| load_from(&root, &a.id)).collect()
}

/// Re-ask one agent, whatever its current state.
///
/// Unconditional on purpose: this is the detail page's Check again, and a
/// `versionUnknown` binary has no other route back to a fresh answer.
#[tauri::command]
pub async fn refresh_model_catalog(agent_id: String) -> Result<ModelCatalog, String> {
    let adapter = crate::agents::find(&agent_id).ok_or_else(|| format!("unknown agent {agent_id}"))?;
    let version = versions().await.get(&agent_id).cloned().flatten();
    Ok(refresh_one(adapter, version))
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
        let root = std::env::temp_dir().join(format!("sway-catalog-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    fn a_catalogue(version: Option<&str>) -> Catalogue {
        Catalogue {
            version: version.map(str::to_string),
            probed_at_ms: 1_700_000_000_000,
            models: vec![CatalogModel {
                info: ChatModelInfo {
                    value: "sonnet".into(),
                    resolved_model: "claude-sonnet-5".into(),
                    display_name: "Sonnet 5".into(),
                    description: String::new(),
                    supports_effort: true,
                    supported_effort_levels: vec!["low".into(), "high".into()],
                    supports_auto_mode: true,
                },
                user_configured: false,
                options: Vec::new(),
            }],
            modes: Vec::new(),
            options: Vec::new(),
            account: None,
        }
    }

    // --- the three states ---

    /// A agent nobody asked is not an error and not an empty catalogue. The
    /// distinction is the whole reason `state` exists: the surface renders no
    /// count here, where it would render "0 models" for a probed-but-empty one.
    #[test]
    fn a_agent_nobody_asked_is_never_probed() {
        let catalog = ModelCatalog::never_probed("claude");
        assert_eq!(catalog.state, CatalogState::NeverProbed);
        assert!(catalog.catalogue.is_none());
        assert!(catalog.last_failure.is_none());
    }

    #[test]
    fn an_answered_probe_is_probed() {
        let mut catalog = ModelCatalog::never_probed("claude");
        catalog.absorb(Ok(a_catalogue(Some("2.1.231"))));
        assert_eq!(catalog.state, CatalogState::Probed);
        assert_eq!(catalog.catalogue.as_ref().unwrap().models.len(), 1);
        assert!(catalog.last_failure.is_none());
    }

    #[test]
    fn a_failure_carries_its_reason() {
        let mut catalog = ModelCatalog::never_probed("claude");
        catalog.absorb(Err(ProbeFailure::now(FailureReason::SignedOut, "not logged in")));
        assert_eq!(catalog.state, CatalogState::Failed);
        assert_eq!(catalog.last_failure.as_ref().unwrap().reason, FailureReason::SignedOut);
        assert!(catalog.catalogue.is_none(), "there was never a catalogue to keep");
    }

    /// The rule the whole record shape exists for: a signed-out moment, or one
    /// slow cold start, must not turn a working picker into an empty one.
    #[test]
    fn a_failed_probe_never_clobbers_a_good_catalogue() {
        let mut catalog = ModelCatalog::never_probed("claude");
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
        let mut catalog = ModelCatalog::never_probed("claude");
        catalog.absorb(Err(ProbeFailure::now(FailureReason::SpawnFailed, "no binary")));
        catalog.absorb(Ok(a_catalogue(Some("2.1.231"))));
        assert_eq!(catalog.state, CatalogState::Probed);
        assert!(catalog.last_failure.is_none());
    }

    // --- the store ---

    #[test]
    fn the_stored_file_round_trips() {
        let root = temp_root("roundtrip");
        let mut written = ModelCatalog::never_probed("claude");
        written.absorb(Ok(a_catalogue(Some("2.1.231"))));
        save_to(&root, &written).expect("the file should write");

        let read = load_from(&root, "claude");
        assert_eq!(read, written);
        assert_eq!(read.state, CatalogState::Probed, "state survives as a derived value");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failure_round_trips_alongside_the_catalogue_it_kept() {
        let root = temp_root("roundtrip-failure");
        let mut written = ModelCatalog::never_probed("claude");
        written.absorb(Ok(a_catalogue(Some("2.1.231"))));
        written.absorb(Err(ProbeFailure::now(FailureReason::SignedOut, "run `claude auth login`")));
        save_to(&root, &written).expect("the file should write");

        let read = load_from(&root, "claude");
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
        let mut written = ModelCatalog::never_probed("claude");
        written.absorb(Ok(a_catalogue(Some("2.1.231"))));
        save_to(&root, &written).unwrap();
        std::fs::remove_file(catalog_path(&root, "claude")).unwrap();

        let read = load_from(&root, "claude");
        assert_eq!(read.state, CatalogState::NeverProbed);
        assert_eq!(read.agent_id, "claude");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_corrupt_file_degrades_to_never_probed_rather_than_erroring() {
        let root = temp_root("corrupt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(catalog_path(&root, "claude"), "{ not json").unwrap();
        assert_eq!(load_from(&root, "claude").state, CatalogState::NeverProbed);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A agent id reaches the filesystem, and adapter ids come from user TOML.
    #[test]
    fn a_agent_id_cannot_escape_the_catalog_directory() {
        let root = Path::new("/tmp/sway-catalogs");
        assert_eq!(catalog_path(root, "../../etc/passwd"), root.join("______etc_passwd.json"));
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
            "Sway cannot resolve a configured string, so it claims no resolution"
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
                }],
                "account": { "subscriptionType": "Claude Max", "apiProvider": "firstParty" },
            }},
        })
        .to_string();
        // Reads its stdin (so the probe's write does not fail on a closed pipe),
        // answers once, then holds the pipe open the way the real CLI does.
        let script = format!("read -r _line; printf '%s\\n' '{response}'; sleep 5");

        let annotations = vec![ChatAnnotation { id: "claude-opus-5".into(), fast_mode: true }];
        let catalogue = probe_claude(&sh(&script), Some("2.1.231".into()), Duration::from_secs(10), &annotations)
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
            claude::config_options(&catalogue.models[0].info, &annotations)
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
    /// alive for nothing, and sending it to one that does not is a request Sway
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
    fn an_option_sway_has_no_control_for_is_kept_rather_than_dropped() {
        let options = vec![
            select_option("model", Some(Category::Model), &[("sonnet", "Sonnet")]),
            select_option("reasoning-depth", None, &[("shallow", "Shallow")]),
        ];

        let catalogue = acp_catalogue(Some("1.18.3".into()), options);

        assert_eq!(catalogue.models.len(), 1, "the model selector still becomes the model list");
        assert_eq!(catalogue.models[0].info.value, "sonnet");
        let ids: Vec<&str> = catalogue.options.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, ["model", "reasoning-depth"], "and the uncategorized one survives beside it");
    }

    /// And it survives the round trip to disk, which is what Phase 4's settings
    /// preview and Phase 5's mirror both read.
    #[test]
    fn the_full_option_set_round_trips_through_the_cache_file() {
        let root = temp_root("acp-options");
        let mut written = ModelCatalog::never_probed("opencode");
        written.absorb(Ok(acp_catalogue(
            Some("1.18.3".into()),
            vec![select_option("web-search", None, &[("on", "On"), ("off", "Off")])],
        )));
        save_to(&root, &written).expect("the file should write");

        let read = load_from(&root, "opencode");
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
            probe_with(claude, Some("live".into()), PROBE_DEADLINE).expect("claude should answer the handshake");

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
    /// `an_option_sway_has_no_control_for_is_kept_rather_than_dropped`.
    #[test]
    #[ignore = "drives the real `opencode` binary"]
    fn the_real_opencode_answers_a_catalogue_from_one_session() {
        let opencode = crate::agents::find("opencode").expect("the bundled opencode adapter");

        let catalogue =
            probe_with(opencode, Some("live".into()), PROBE_DEADLINE).expect("opencode should answer");

        assert!(catalogue.models.len() > 2, "a real answer names the user's providers: {:?}", catalogue.models);
        assert!(
            catalogue.models.iter().all(|m| !m.info.value.is_empty()),
            "every row carries the id a switch would have to name"
        );
        assert!(!catalogue.options.is_empty(), "and the agent's own option set is kept whole");
    }

    /// The same probe against Codex, and **the first live agent to publish an
    /// option Sway has no control for**.
    ///
    /// Measured on `codex-cli 0.147.0` with `@agentclientprotocol/codex-acp`
    /// 1.2.0, 2026-08-17. Four config options where opencode sends two:
    ///
    ///   * `model`, four models, each with a description,
    ///   * `mode`, three (read-only, agent, agent-full-access),
    ///   * `reasoning_effort`, **categorized `thought_level`**, six levels,
    ///   * `collaboration_mode` (default, plan), categorized as itself.
    ///
    /// That last one is the whole of Phase 5's case, live: Sway has no control
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
    #[test]
    #[ignore = "drives the real `codex` binary"]
    fn the_real_codex_answers_a_catalogue_from_one_session() {
        let codex = crate::agents::find("codex").expect("the bundled codex adapter");

        let catalogue =
            probe_with(codex, Some("live".into()), PROBE_DEADLINE).expect("codex should answer");

        assert!(!catalogue.models.is_empty(), "the handshake names this account's models");
        assert!(
            catalogue.models.iter().all(|m| m.info.supported_effort_levels.len() == 5),
            "every model carries the five levels Sway can send, and not the sixth: {:?}",
            catalogue.models
        );
        assert_eq!(catalogue.modes.len(), 3, "read-only, agent, agent-full-access");

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
    /// filter, which is the half Sway controls and the half that survives an
    /// agent changing its mind about scoping.
    ///
    /// Which means this test proves the **outcome** against a real Codex, not
    /// the filter: with that scoping in place the row could not appear here
    /// whatever `adopt` did. The filter itself is pinned by
    /// `acp_sessions::a_session_sways_own_probe_opened_is_not_adopted_as_history`,
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

        let root = std::env::temp_dir().join(format!("sway-codex-phantom-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        acp_sessions::use_dir_for_tests(root.join("locators"));

        probe_with(codex, None, PROBE_DEADLINE).expect("codex should answer the probe");

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
    /// in the history Sway would show.
    ///
    /// Run with `--test-threads=1`: it redirects the locator store, which is a
    /// process-global for the reason `acp_sessions` documents.
    #[test]
    #[ignore = "drives the real `opencode` binary"]
    fn a_probe_leaves_nothing_in_the_history_sway_would_adopt() {
        let opencode = crate::agents::find("opencode").expect("the bundled opencode adapter");
        probe_with(opencode, None, PROBE_DEADLINE).expect("opencode should answer");

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
