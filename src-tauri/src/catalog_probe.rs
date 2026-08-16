//! Asking a harness what it can run, and remembering the answer.
//!
//! Sway ships no model list. Every model, mode and option a picker offers is
//! something the harness itself named, either on a live session's handshake or
//! on the cached answer this module produces. The two are the same shape on
//! purpose: a picker opened before any session exists reads the cache, and the
//! live handshake replaces it the moment a session starts.
//!
//! **A probe is token-free or it does not ship.** For `claude_stream_json` that
//! is free: the `initialize` control response carries the whole catalogue and
//! arrives before any session exists, so the probe is spawn, handshake, kill,
//! with nothing written to disk on the harness's side and nothing to clean up.
//! ACP is not free that way (its catalogue only appears on `session/new`) and is
//! deliberately not implemented here; the exhaustive `match` in [`probe_with`]
//! is what will name that obligation when Phase 3 arrives.
//!
//! Three facts are kept apart because the UI renders them differently:
//!
//!   * **Never probed** is not an error. It is the honest state of a harness
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

use agent_client_protocol::schema::v1::SessionConfigOption;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::{AgentAdapter, ChatTransport};
use crate::chat::claude::ClaudeMapper;
use crate::chat::model::{ChatAccount, ChatEvent, ChatModeInfo, ChatModelInfo};
use crate::chat::transport::{build_command, StartSpec};

/// How long one harness gets to answer before the probe gives up on it.
///
/// **A ceiling, not an expectation.** Measured on claude 2.1.231, a full probe
/// (spawn, handshake, answer, kill) takes ~1.6s, so this is not a number
/// anything healthy comes near. It is sized for the harnesses that are not
/// measured yet: Paseo's notes report cold starts on the slow side, and Phase
/// 3's ACP probe has to spawn an agent and open a session before it can read
/// anything. Overrunning it is not fatal to anything: the harness lands in
/// [`FailureReason::TimedOut`] and keeps whatever catalogue it had.
const PROBE_DEADLINE: Duration = Duration::from_secs(45);

/// How much of a failed probe's stderr to keep, matching the chat transport's
/// own tail. Enough for a usage error or an auth message, bounded so a chatty
/// child cannot grow a cache file without limit.
const STDERR_TAIL: usize = 4096;

// --- the stored shape ---

/// Which of the three things a harness's catalogue currently is.
///
/// Derived from the two fields below rather than stored as a third independent
/// one, so it cannot disagree with them. It is serialized because the surfaces
/// branch on it directly, and skipped on the way back in because
/// [`ModelCatalog::settled`] recomputes it on load.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CatalogState {
    /// Nobody has asked this harness yet. Renders as no answer, never as zero.
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
    /// harness's sign-in state, which is why it is not folded into the next one.
    TimedOut,
    /// The harness's own sign-in probe says nobody is signed in. Measured
    /// through the adapter's `[accounts]` table rather than guessed from the
    /// words in a stderr tail.
    SignedOut,
    /// The child exited or closed its stdout without answering the handshake,
    /// and the harness does not report being signed out.
    NoAnswer,
    /// This build cannot probe this transport yet. Distinct from every other
    /// reason because it is a fact about Sway, not about the harness, and the
    /// surface should not blame the binary for it.
    Unsupported,
}

/// One failed attempt, kept so the surface can say what went wrong and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeFailure {
    pub reason: FailureReason,
    /// The harness's own words where there are any (a stderr tail, a spawn
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
    /// This row came from the user's own harness configuration, not from the
    /// harness's catalogue.
    ///
    /// Still not something Sway invented - the user wrote the id - but Sway
    /// cannot confirm it: a configured string is passed to `--model` unresolved,
    /// so such a row carries an empty `resolved_model` and anything deduping by
    /// that field must fall back to `value` rather than collapsing every
    /// user-configured row into one.
    #[serde(default)]
    pub user_configured: bool,
}

/// What one harness said when it was asked.
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
    /// Empty for a harness whose modes are declared in its adapter TOML rather
    /// than published on the wire, which is claude today.
    #[serde(default)]
    pub modes: Vec<ChatModeInfo>,
    /// The agent's own config options, verbatim, including the ones Sway has no
    /// bespoke control for. Empty for claude, which publishes none. Phase 5
    /// mirrors these into the chat; keeping them whole here is what lets the
    /// settings page preview them before any chat exists.
    #[serde(default)]
    pub options: Vec<SessionConfigOption>,
    /// The account the harness named, when it named one. Load-bearing for the
    /// surface's honesty: a catalogue can differ per account, so a page showing
    /// one has to be able to say whose answer it is.
    pub account: Option<ChatAccount>,
}

/// Everything Sway remembers about one harness's catalogue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub harness_id: String,
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
    fn settled(harness_id: String, catalogue: Option<Catalogue>, last_failure: Option<ProbeFailure>) -> Self {
        let state = match (&last_failure, &catalogue) {
            (Some(_), _) => CatalogState::Failed,
            (None, Some(_)) => CatalogState::Probed,
            (None, None) => CatalogState::NeverProbed,
        };
        Self { harness_id, state, catalogue, last_failure }
    }

    pub fn never_probed(harness_id: impl Into<String>) -> Self {
        Self::settled(harness_id.into(), None, None)
    }

    /// Fold a probe's outcome into this record.
    ///
    /// **A failure keeps the catalogue.** That is the whole reason this is a
    /// method rather than a fresh record per probe: replacing the record on
    /// failure would turn a signed-out moment, or one slow cold start, into a
    /// harness that suddenly offers no models at all.
    fn absorb(&mut self, outcome: Result<Catalogue, ProbeFailure>) {
        match outcome {
            Ok(catalogue) => *self = Self::settled(self.harness_id.clone(), Some(catalogue), None),
            Err(failure) => {
                *self = Self::settled(self.harness_id.clone(), self.catalogue.take(), Some(failure))
            }
        }
    }

    /// Whether what is remembered no longer describes the binary on disk.
    ///
    /// Version comparison and nothing else. A TTL was the obvious alternative
    /// and is rejected: a catalogue does not decay with time, it decays when the
    /// binary changes, and an hourly re-probe would spawn a process per harness
    /// forever to learn nothing. The two unknown-version cases both answer "not
    /// stale" rather than "stale", because neither one is evidence of a change,
    /// and treating absence of evidence as staleness would re-probe a
    /// `versionUnknown` binary on every read. Such a harness is re-checked when
    /// the user asks, which is what the detail page's Check again is for.
    pub fn is_stale(&self, current_version: Option<&str>) -> bool {
        match self.catalogue.as_ref() {
            // Never answered, so there is nothing to be stale; the caller's
            // "probe the stale and the never-probed" reads better with this
            // saying false, and `state` already reports the difference.
            None => false,
            Some(c) => match (c.version.as_deref(), current_version) {
                (Some(recorded), Some(current)) => recorded != current,
                _ => false,
            },
        }
    }
}

// --- the store: one file per harness, under the data dir ---

/// `~/Library/Application Support/sway/model-catalogs` on macOS.
///
/// The data dir rather than `~/.config/sway`, for the reason `install.rs` and
/// `accounts.rs` both chose it: this is state Sway derived, not configuration a
/// user edits, and `~/.config` commonly lives in a dotfile repo. One file per
/// harness rather than one map, so deleting a single harness's answer is a `rm`
/// and a corrupt file costs one harness rather than all of them.
pub fn catalog_root() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join("sway/model-catalogs")
}

fn catalog_path(root: &Path, harness_id: &str) -> PathBuf {
    root.join(format!("{}.json", crate::install::sanitize_segment(harness_id)))
}

/// Read one harness's remembered catalogue.
///
/// **Every failure is "never probed".** A missing file is the ordinary state of
/// a harness nobody has asked, and a corrupt one is derived state Sway can
/// simply ask for again; neither is worth an error the caller would have to
/// render. That is what makes the file safe to delete by hand.
pub fn load_from(root: &Path, harness_id: &str) -> ModelCatalog {
    let Ok(text) = std::fs::read_to_string(catalog_path(root, harness_id)) else {
        return ModelCatalog::never_probed(harness_id);
    };
    match serde_json::from_str::<ModelCatalog>(&text) {
        Ok(stored) => ModelCatalog::settled(stored.harness_id, stored.catalogue, stored.last_failure),
        Err(_) => ModelCatalog::never_probed(harness_id),
    }
}

pub fn save_to(root: &Path, catalog: &ModelCatalog) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    let path = catalog_path(root, &catalog.harness_id);
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
/// failure can quote the harness rather than guess at it.
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
                    let cut = t.len() - STDERR_TAIL;
                    *t = t[cut..].to_string();
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
    /// precisely when the harness had explained itself, which is the one case
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
fn probe_claude(spec: &StartSpec, version: Option<String>, deadline: Duration) -> Result<Catalogue, ProbeFailure> {
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
            models: models.into_iter().map(|info| CatalogModel { info, user_configured: false }).collect(),
            modes,
            options: Vec::new(),
            account,
        }),
        Ok(None) => Err(ProbeFailure::now(FailureReason::NoAnswer, tail.take())),
        Err(_) => Err(ProbeFailure::now(FailureReason::TimedOut, tail.take())),
    }
}

/// Ask one harness, with the version the caller already knows.
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

    let spec = StartSpec {
        session_id: String::new(),
        // Inherited on purpose. A cwd is what a harness turns into a project,
        // and the probe has no project: it never starts a session, so there is
        // nothing for a directory to be attached to. Phase 3's ACP probe does
        // create a session and therefore does need a canonical scratch dir.
        cwd: String::new(),
        program: crate::settings::harness_override().unwrap_or_else(|| chat.program.clone()),
        args: chat.base_args.clone(),
        env: HashMap::new(),
    };

    // Exhaustive, so a new transport is a compile error here rather than a
    // harness that silently never gets a catalogue.
    let outcome = match chat.transport {
        ChatTransport::ClaudeStreamJson => probe_claude(&spec, version, deadline).map(|mut c| {
            let extras = user_configured_models(&claude_settings_path(), &c.models);
            c.models.extend(extras);
            c
        }),
        ChatTransport::Acp => Err(ProbeFailure::now(
            FailureReason::Unsupported,
            "an ACP catalogue only exists on `session/new`, which this build does not probe",
        )),
    };

    // Only a child that started and then said nothing is worth a second
    // question. A spawn failure has already explained itself, and a timeout has
    // said nothing about anybody's credentials.
    match outcome {
        Err(f) if f.reason == FailureReason::NoAnswer => Err(refine_signed_out(adapter, f)),
        other => other,
    }
}

/// Upgrade a silent failure to [`FailureReason::SignedOut`] when the harness's
/// own probe says so.
///
/// Measured rather than inferred: the adapter's `[accounts]` table names a real
/// command whose exit code answers the question, so nothing here reads the
/// stderr tail for auth-shaped words. A harness that declares no such probe
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

// --- models the user configured rather than the harness published ---

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
        });
    }
    extras
}

// --- the Tauri surface ---

/// One lock per harness id, so probes are concurrent across harnesses and
/// sequential within one.
///
/// Two sweeps overlapping on the same harness would spawn two of its binaries
/// and race to write one file; two different harnesses have nothing to share and
/// should not queue behind each other. The map only ever grows by the number of
/// adapters, so nothing prunes it.
fn harness_lock(harness_id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut map = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(harness_id.to_string()).or_default().clone()
}

/// Every harness that could have a catalogue, in adapter order.
fn probeable() -> Vec<&'static AgentAdapter> {
    crate::agents::registry().iter().filter(|a| a.chat.is_some()).collect()
}

/// Probe one harness and write the result, keeping any previous good catalogue.
fn refresh_one(adapter: &AgentAdapter, version: Option<String>) -> ModelCatalog {
    let lock = harness_lock(&adapter.id);
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

/// What Sway remembers, for every harness with a chat transport.
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

/// Re-ask one harness, whatever its current state.
///
/// Unconditional on purpose: this is the detail page's Check again, and a
/// `versionUnknown` binary has no other route back to a fresh answer.
#[tauri::command]
pub async fn refresh_model_catalog(harness_id: String) -> Result<ModelCatalog, String> {
    let adapter = crate::agents::find(&harness_id).ok_or_else(|| format!("unknown agent {harness_id}"))?;
    let version = versions().await.get(&harness_id).cloned().flatten();
    Ok(refresh_one(adapter, version))
}

/// Ask every harness that has never answered or whose binary has changed.
///
/// Skipping the rest is what makes this safe to call on a picker's first open:
/// a machine whose catalogues are all current spawns nothing at all. The probes
/// run on their own threads so one slow cold start does not hold up the rest,
/// and each is bounded by [`PROBE_DEADLINE`], so a hung child costs one row
/// rather than the sweep.
#[tauri::command]
pub async fn refresh_model_catalogs() -> Vec<ModelCatalog> {
    let versions = versions().await;
    let root = catalog_root();
    let stale: Vec<(&'static AgentAdapter, Option<String>)> = probeable()
        .into_iter()
        .filter_map(|a| {
            let stored = load_from(&root, &a.id);
            let version = versions.get(&a.id).cloned().flatten();
            let due = stored.state == CatalogState::NeverProbed || stored.is_stale(version.as_deref());
            due.then_some((a, version))
        })
        .collect();

    thread::scope(|scope| {
        let handles: Vec<_> = stale.into_iter().map(|(a, v)| scope.spawn(move || refresh_one(a, v))).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

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
            }],
            modes: Vec::new(),
            options: Vec::new(),
            account: None,
        }
    }

    // --- the three states ---

    /// A harness nobody asked is not an error and not an empty catalogue. The
    /// distinction is the whole reason `state` exists: the surface renders no
    /// count here, where it would render "0 models" for a probed-but-empty one.
    #[test]
    fn a_harness_nobody_asked_is_never_probed() {
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

    // --- staleness ---

    #[test]
    fn a_version_change_flips_staleness() {
        let mut catalog = ModelCatalog::never_probed("claude");
        catalog.absorb(Ok(a_catalogue(Some("2.1.231"))));
        assert!(!catalog.is_stale(Some("2.1.231")), "the same version is not stale");
        assert!(catalog.is_stale(Some("2.2.0")), "a different version is");
    }

    /// Neither unknown-version case is evidence that anything changed, so
    /// neither one re-probes on its own. Such a harness comes back through the
    /// detail page's explicit Check again.
    #[test]
    fn an_unknown_version_is_stale_only_by_explicit_recheck() {
        let mut recorded_unknown = ModelCatalog::never_probed("codex");
        recorded_unknown.absorb(Ok(a_catalogue(None)));
        assert!(!recorded_unknown.is_stale(Some("1.0.0")));
        assert!(!recorded_unknown.is_stale(None));

        let mut current_unknown = ModelCatalog::never_probed("codex");
        current_unknown.absorb(Ok(a_catalogue(Some("1.0.0"))));
        assert!(!current_unknown.is_stale(None));
    }

    #[test]
    fn a_never_probed_harness_is_not_reported_stale() {
        assert!(!ModelCatalog::never_probed("gemini").is_stale(Some("1.0.0")));
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
        assert_eq!(read.harness_id, "claude");
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

    /// A harness id reaches the filesystem, and adapter ids come from user TOML.
    #[test]
    fn a_harness_id_cannot_escape_the_catalog_directory() {
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

    /// The catalogue is the authority. A configured id the harness already
    /// published must not appear twice in a picker, under two provenances.
    #[test]
    fn a_configured_id_the_harness_already_published_is_not_added_again() {
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

    /// The deadline is what stops a hung harness from wedging the sweep, so it
    /// is driven here rather than trusted. The child holds its stdout open and
    /// answers nothing, which is exactly the hang shape; the probe ends on its
    /// own, with a reason, and kills the child on the way out.
    ///
    /// A short deadline rather than [`PROBE_DEADLINE`], which is why that value
    /// is a parameter: a test that waited the real 45s would be one nobody runs.
    #[test]
    fn a_silent_child_times_out_rather_than_wedging() {
        let started = std::time::Instant::now();
        let failure = probe_claude(&sh("sleep 30"), None, Duration::from_millis(300))
            .expect_err("a child that never answers cannot produce a catalogue");

        assert_eq!(failure.reason, FailureReason::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5), "the probe returned on its own deadline");
    }

    /// A child that exits without answering is a different sentence from one
    /// that hung, and the surface says so.
    #[test]
    fn a_child_that_exits_without_answering_is_no_answer() {
        let failure = probe_claude(&sh("exit 0"), None, PROBE_DEADLINE).expect_err("nothing was answered");
        assert_eq!(failure.reason, FailureReason::NoAnswer);
    }

    /// And it quotes the harness rather than paraphrasing it.
    #[test]
    fn a_failure_carries_the_harnesss_own_stderr() {
        let failure = probe_claude(&sh("echo 'credit balance too low' >&2; exit 1"), None, PROBE_DEADLINE)
            .expect_err("nothing was answered");
        assert_eq!(failure.detail, "credit balance too low");
    }

    /// A stderr big enough to need several reads is where the tail's two rules
    /// are actually visible: it is bounded to the **last** [`STDERR_TAIL`]
    /// bytes, and it is complete, because the probe joins the reader thread
    /// rather than sampling a buffer another thread is still filling. Without
    /// that join this truncates somewhere arbitrary, which is the failure mode
    /// that loses a harness's explanation exactly when it gave one.
    #[test]
    fn a_long_stderr_is_kept_whole_at_its_end_and_bounded() {
        let noise = STDERR_TAIL * 2 / 40;
        let script = format!("for i in $(seq {noise}); do echo 'noisy line of harness output' >&2; done; echo LAST >&2");

        let failure = probe_claude(&sh(&script), None, PROBE_DEADLINE).expect_err("nothing was answered");

        assert!(failure.detail.ends_with("LAST"), "the tail keeps the end, which is where the reason is");
        assert!(failure.detail.len() <= STDERR_TAIL, "and stays bounded: {} bytes", failure.detail.len());
    }

    #[test]
    fn a_binary_that_is_not_there_is_a_spawn_failure() {
        let spec = StartSpec {
            session_id: String::new(),
            cwd: String::new(),
            program: "/nonexistent/harness-binary".into(),
            args: Vec::new(),
            env: HashMap::new(),
        };
        let failure = probe_claude(&spec, None, PROBE_DEADLINE).expect_err("nothing to spawn");
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

        let catalogue = probe_claude(&sh(&script), Some("2.1.231".into()), Duration::from_secs(10))
            .expect("the stand-in answered the handshake");

        assert_eq!(catalogue.version.as_deref(), Some("2.1.231"));
        assert_eq!(catalogue.models.len(), 1);
        assert_eq!(catalogue.models[0].info.resolved_model, "claude-opus-5");
        assert_eq!(catalogue.models[0].info.supported_effort_levels, ["low", "high"]);
        assert!(!catalogue.models[0].user_configured);
        assert_eq!(catalogue.account.unwrap().subscription_type, "Claude Max");
    }

    /// ACP is not probeable in this build, and says so as a fact about Sway
    /// rather than blaming the binary.
    #[test]
    fn an_acp_harness_reports_unsupported_rather_than_a_failure_of_its_own() {
        let opencode = crate::agents::find("opencode").expect("the bundled opencode adapter");
        let failure = probe_with(opencode, None, PROBE_DEADLINE).expect_err("this build cannot probe ACP");
        assert_eq!(failure.reason, FailureReason::Unsupported);
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
            "at least one row came from the harness itself"
        );
        assert!(
            catalogue.models.iter().filter(|m| !m.user_configured).all(|m| !m.info.resolved_model.is_empty()),
            "every published row names what it resolves to"
        );
        assert_eq!(session_files(), before, "the probe wrote no transcript");
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
