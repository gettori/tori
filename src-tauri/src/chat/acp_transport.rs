//! Driving one ACP agent as a long-lived child process.
//!
//! The counterpart to [`super::claude_transport`], and deliberately the same
//! shape where the shapes can be the same: a child spawned through the shared
//! [`build_command`], a permission question parked in a map until somebody
//! answers it, and a teardown that denies whatever is still waiting rather than
//! leaving the agent blocked. What differs is everything below that, because ACP
//! is a JSON-RPC peer conversation rather than a line protocol Tori parses
//! itself.
//!
//! Three shapes here are load-bearing:
//!
//!   * **One dedicated OS thread per session, running `block_on`.** The SDK is
//!     built on the smol stack, not on tokio, and Tauri's runtime is neither.
//!     Rather than introduce a second global runtime, each session owns one
//!     thread that blocks on its own connection future for the life of the
//!     session. Nothing else in Tori has to know a runtime exists.
//!   * **The child is spawned by Tori, not by the SDK.** `AcpAgent::from_str`
//!     would spawn it for us, but it bypasses [`build_command`] and therefore
//!     `env::augmented_path()` - the same PATH trap `pty.rs` exists for, since a
//!     directly-spawned child gets no login shell. Spawning it here also keeps
//!     the pid, which the ownership registry's orphan record needs and which the
//!     SDK's own connection path does not hand back.
//!   * **A permission responder is parked, not awaited.** The SDK hands the
//!     request handler a [`Responder`] that is `Send` and answers synchronously,
//!     so it can sit in a map exactly as `claude_transport.rs` parks a
//!     `can_use_tool` request id, and be answered later from the command thread.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    AuthMethod, CancelNotification, EnvVariable, InitializeRequest, InitializeResponse, ListSessionsRequest,
    LoadSessionRequest, McpServer, McpServerStdio, NewSessionRequest, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome, SessionConfigId,
    SessionConfigOption, SessionConfigOptionValue, SessionConfigValueId, SessionId, SessionModeId, SessionNotification,
    SessionUpdate, SetSessionConfigOptionRequest, SetSessionModeRequest,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo, ErrorCode, Responder};
use futures::channel::mpsc;
use futures::StreamExt;

use super::acp::{self, AcpOverrides};
use super::acp_sessions::{self, AcpSession, ListedSession};
use super::model::{
    ChatConfigKind, ChatConfigValue, ChatEvent, ContentBlock, PermissionDecision, PermissionMode, PermissionScope,
    QuestionAnswer,
};
use super::transport::{build_command, emit, AgentTransport, Sink, StartSpec};
use crate::platform::process::Group;

/// How long Tori waits for `initialize` before giving up on an agent.
///
/// The client owns this deadline because the protocol gives the agent no
/// obligation to answer promptly and some do not answer at all. Without it a
/// misbehaving agent leaves a chat tab reading "connecting" forever, with no
/// error and nothing to retry.
const HANDSHAKE_TIMEOUT_SECS: u64 = 30;

/// How long an unanswered permission question waits before Tori denies it.
///
/// Kept equal to the Claude transport's own deadline so both routes to a prompt
/// expire alike; a user cannot tell which protocol asked, so they must not
/// behave differently.
const DECIDE_TIMEOUT_SECS: u64 = super::approval::DECIDE_TIMEOUT_SECS;

/// What the sync trait methods ask of the connection thread.
///
/// A channel rather than direct calls because the connection lives inside an
/// async closure on another thread, and every [`AgentTransport`] method is sync.
enum Command {
    Prompt(Vec<ContentBlock>),
    Cancel,
    /// The spec's own `session/set_mode`, used only for an agent that published
    /// no `mode`-category config option. Neither measured agent has answered it.
    SetMode(PermissionMode),
    /// Switch one session config option, which is how a model switch, a mode
    /// switch and every mirrored control travel alike. Carries the agent's own
    /// config id rather than a Tori-side name for it, and `what` only so a
    /// failure can say which control the user touched.
    SetConfigOption {
        config_id: String,
        value: ChatConfigValue,
        what: ConfigOption,
    },
    /// Ask the agent to hand the conversation over again.
    ///
    /// An ACP conversation only ever reaches the UI as `session/load`'s replay,
    /// so a webview reload - which leaves this child running and rewires the
    /// sink - loses it with no way to read it back. Measured on `codex-acp`
    /// 1.2.0: a second `session/load` for the same id on the same connection
    /// replays the whole conversation, `user_message_chunk` included, so asking
    /// again is cheaper and more honest than Tori keeping a copy.
    Reload,
    Close,
}

/// Which selector a `SetConfigOption` came from.
///
/// Two things need it and neither is cosmetic: the failure message names the
/// control the user actually touched, and the "did it take" check has to read
/// the *same* selector back out of the agent's answer. Reading the model
/// selector after a mode switch would compare two unrelated values and report a
/// mismatch on every mode change.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ConfigOption {
    Model,
    Mode,
    Effort,
    /// A control Tori has no bespoke one for, driven by the mirror. It carries
    /// the agent's own id because neither the noun nor the readback can be
    /// derived from a selector Tori knows nothing about: the three above are
    /// found by category, and this one is exactly the option no category claims.
    Mirrored {
        id: String,
    },
}

impl ConfigOption {
    fn noun(&self) -> String {
        match self {
            Self::Model => "model".into(),
            Self::Mode => "mode".into(),
            Self::Effort => "reasoning effort".into(),
            Self::Mirrored { id } => id.clone(),
        }
    }

    /// What the agent now reports for this selector, from its own answer.
    fn current(&self, options: &[SessionConfigOption]) -> Option<String> {
        match self {
            Self::Model => acp::current_model(options),
            Self::Mode => acp::current_mode(options),
            Self::Effort => acp::current_effort(options),
            // Read back through the same mapping the mirror renders, so the
            // check compares what the user will see rather than a second
            // reading of the wire that could disagree with it.
            Self::Mirrored { id } => {
                acp::config_options(options)
                    .into_iter()
                    .find(|o| &o.id == id)
                    .map(|o| match o.kind {
                        ChatConfigKind::Select { current, .. } => current,
                        ChatConfigKind::Boolean { value } => value.to_string(),
                    })
            }
        }
    }
}

/// A switch's value on the wire.
///
/// The two shapes are not interchangeable: a toggle sent as the *string*
/// `"true"` is a value id an agent will reject or, worse, quietly not
/// understand, and nothing downstream would say so. Split out of the send so
/// that mapping is a test rather than a line inside an async loop.
fn option_value(value: &ChatConfigValue) -> SessionConfigOptionValue {
    match value {
        ChatConfigValue::Value(id) => SessionConfigOptionValue::ValueId {
            value: SessionConfigValueId::new(id.as_str()),
        },
        ChatConfigValue::Flag(on) => SessionConfigOptionValue::Boolean { value: *on },
    }
}

/// Per-session state the connection thread and the command methods share.
struct Shared {
    session_id: String,
    /// Set once the session has ended, so a late failure on the connection
    /// thread cannot resurrect a session the user already closed.
    finished: AtomicBool,
    /// Whether this agent advertised `loadSession`, which is what decides
    /// whether it can be asked for the conversation a second time. Read off the
    /// handshake rather than assumed: an agent that cannot reload must say so
    /// before the host commits to letting it, or a rewired tab waits for a
    /// replay that is never coming.
    can_reload: AtomicBool,
    /// Permission questions the agent is blocked on, keyed by the id Tori
    /// minted for them.
    ///
    /// Holds the responder itself rather than a marker: answering *is* consuming
    /// the responder, so a question leaves this map exactly once, whoever gets
    /// there first. That is what makes "answered twice" impossible and, more
    /// importantly, "never answered" impossible too - the same invariant
    /// `claude_transport.rs` states, enforced here by ownership rather than by a
    /// set membership check.
    pending: Mutex<HashMap<String, Parked>>,
    /// Signalled whenever a question leaves `pending`, so an armed deadline
    /// stops waiting the moment its question is settled instead of sleeping out
    /// its full term. Without it a chat where the user answers promptly still
    /// accumulates one parked thread per prompt for the whole timeout apiece -
    /// the same cost `claude_transport.rs` uses a condvar to avoid.
    settled: std::sync::Condvar,
    /// The turn every incoming `session/update` belongs to.
    ///
    /// Held explicitly rather than derived from [`Self::seq`]. ACP does not
    /// stamp a turn on its updates, so the transport has to supply one, and the
    /// counter cannot: it is shared with minted request ids, so a single
    /// permission question would bump it mid-turn and every later update would
    /// be stamped with a turn id no turn ever had. Tori's transcript keys on
    /// `turn_id`, so that split one turn into two.
    current_turn: Mutex<String>,
    /// Monotonic counter behind minted request ids and turn numbering.
    seq: AtomicU64,
    /// What this session can do about models, once it has said.
    model_switch: Mutex<Switch>,
    /// And about modes. Separate state because an agent may publish one selector
    /// and not the other: `opencode acp` and `codex-acp` both publish both, but
    /// nothing in the protocol ties them together.
    mode_switch: Mutex<Switch>,
    /// And about reasoning effort, which `codex-acp` publishes and `opencode
    /// acp` does not - the clearest case for keeping these apart.
    effort_switch: Mutex<Switch>,
    /// The turn whose `UserMessage` this transport has already put in the
    /// stream, so an agent that *does* echo the prompt back does not have it
    /// rendered twice. Cleared before a reload, because the replay's own user
    /// messages are the conversation and must all come through.
    echoed_turn: Mutex<Option<String>>,
}

/// Whether a config switch has somewhere to go.
///
/// Three states rather than an `Option`, because `None` would mean two different
/// things and the difference is what the user reads. A chat that has not finished
/// opening has not asked the agent yet; a chat that has, and got no such
/// selector, has an answer. Reporting the first as the second blames the agent
/// for Tori's timing.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Switch {
    /// `session/new` has not answered yet, so nothing is known.
    Unknown,
    /// The session opened and offered no selector of this category.
    Unsupported,
    /// The agent's own config id for that selector.
    Available(String),
}

/// One parked permission question: the responder to answer, and the option ids
/// the agent offered, so an answer can be turned back into the agent's own
/// vocabulary.
struct Parked {
    responder: Responder<RequestPermissionResponse>,
    /// `optionId`s the agent supplied, split by what they mean. Tori's UI
    /// answers Allow or Deny; the agent expects one of *its* ids, so the
    /// translation needs both lists.
    allow_options: Vec<String>,
    deny_options: Vec<String>,
}

impl Shared {
    fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.seq.fetch_add(1, Ordering::SeqCst))
    }

    /// Answer one parked question, if it is still outstanding.
    ///
    /// `Ok(false)` means the question was never ours or was already settled.
    /// Neither is an error: the first is how the host learns to try the
    /// `PreToolUse` bridge instead, and the second is a user clicking as the
    /// deadline fires - a race they should never be shown.
    fn answer(&self, request_id: &str, decision: PermissionDecision, reason: Option<&str>) -> Result<bool, String> {
        let Some(parked) = self.claim(request_id) else {
            return Ok(false);
        };
        // The reason is deliberately unused: ACP's outcome carries a chosen
        // option id and nothing else, so there is no field to put Tori's own
        // explanation in. It still reaches the user through the event that
        // announced the denial.
        let _ = reason;
        let outcome = outcome_for(&parked.allow_options, &parked.deny_options, decision);
        parked
            .responder
            .respond(RequestPermissionResponse::new(outcome))
            .map_err(|e| e.to_string())?;
        Ok(true)
    }

    fn claim(&self, request_id: &str) -> Option<Parked> {
        let parked = self.pending.lock().ok()?.remove(request_id);
        if parked.is_some() {
            // Wake every armed deadline so the one that owned this question can
            // retire. `notify_all` rather than `notify_one` because the waiters
            // are not interchangeable: only the one whose question this was may
            // exit, and the rest must re-check and go back to waiting.
            self.settled.notify_all();
        }
        parked
    }

    /// The turn id to stamp on updates arriving right now.
    fn turn(&self) -> String {
        self.current_turn.lock().map(|t| t.clone()).unwrap_or_default()
    }

    /// Remember that this turn's user message is already in the stream.
    fn note_echoed(&self, turn: &str) {
        let mut guard = self.echoed_turn.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(turn.to_string());
    }

    /// Forget it, so the next reload's replayed user turns are not mistaken for
    /// the echo of a prompt Tori sent.
    fn forget_echoed(&self) {
        let mut guard = self.echoed_turn.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }

    /// Whether this turn's user message has already been emitted.
    fn already_echoed(&self, turn: &str) -> bool {
        let guard = self.echoed_turn.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_deref() == Some(turn)
    }

    /// Cancel everything still waiting.
    ///
    /// The fail-closed half of every exit path. ACP spells "no" for an
    /// abandoned question as the `cancelled` outcome rather than as a rejection:
    /// the spec requires a client to answer pending permission requests that way
    /// when the turn goes away, and a rejection would tell the agent the user
    /// made a decision they never made.
    fn cancel_all_pending(&self) {
        let outstanding: Vec<Parked> = match self.pending.lock() {
            Ok(mut p) => p.drain().map(|(_, v)| v).collect(),
            Err(_) => return,
        };
        for parked in outstanding {
            let _ = parked
                .responder
                .respond(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled));
        }
    }
}

/// Turn Tori's Allow/Deny into one of the agent's own option ids.
///
/// The agent owns the permission vocabulary, so this picks from what it offered
/// rather than sending a fixed token. An agent that offered nothing usable in
/// the requested direction gets `cancelled`, which is honest: Tori cannot
/// express the user's answer in that agent's grammar, and inventing an id would
/// be answered with a protocol error at best.
///
/// A free function taking the two lists rather than a method on [`Parked`], so
/// the translation can be tested without a [`Responder`] - which only the SDK
/// can construct, and only for a request that is really on the wire.
fn outcome_for(
    allow_options: &[String],
    deny_options: &[String],
    decision: PermissionDecision,
) -> RequestPermissionOutcome {
    let options = match decision {
        PermissionDecision::Allow => allow_options,
        PermissionDecision::Deny => deny_options,
    };
    match options.first() {
        Some(id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            agent_client_protocol::schema::v1::PermissionOptionId::new(id.as_str()),
        )),
        None => RequestPermissionOutcome::Cancelled,
    }
}

/// Sort an agent's offered options into the two directions Tori's UI can
/// answer in, keyed on the `kind` the agent itself gave each one.
fn split_options(options: &[agent_client_protocol::schema::v1::PermissionOption]) -> (Vec<String>, Vec<String>) {
    use agent_client_protocol::schema::v1::PermissionOptionKind;
    let (mut allow, mut deny) = (Vec::new(), Vec::new());
    for option in options {
        let id = option.option_id.0.to_string();
        match option.kind {
            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways => allow.push(id),
            _ => deny.push(id),
        }
    }
    (allow, deny)
}

pub struct AcpTransport {
    shared: Arc<Shared>,
    /// The adapter this session belongs to. Recorded in every locator this
    /// transport writes, so a listed row can say which agent it came from
    /// rather than leaving the sidebar to guess from the id's shape.
    agent: String,
    /// The command channel into the connection thread. `None` before `start`,
    /// which is what makes a command sent too early an error rather than a panic.
    commands: Option<mpsc::UnboundedSender<Command>>,
    /// The child's pid, kept for the ownership registry's orphan record. The
    /// SDK's own connection path never hands this back, which is one of the two
    /// reasons Tori spawns the child itself.
    pid: Option<u32>,
    /// Per-agent departures from a spec-correct client, from the adapter TOML.
    overrides: AcpOverrides,
    /// Mode switches take effect from the next turn, matching every other
    /// transport: a switch applied mid-turn would show a mode the running turn
    /// is not in.
    pending_mode: Option<PermissionMode>,
}

impl AcpTransport {
    pub fn new(session_id: impl Into<String>, agent: impl Into<String>, overrides: AcpOverrides) -> Self {
        Self {
            agent: agent.into(),
            shared: Arc::new(Shared {
                session_id: session_id.into(),
                finished: AtomicBool::new(false),
                can_reload: AtomicBool::new(false),
                pending: Mutex::new(HashMap::new()),
                settled: std::sync::Condvar::new(),
                current_turn: Mutex::new(String::new()),
                seq: AtomicU64::new(0),
                model_switch: Mutex::new(Switch::Unknown),
                mode_switch: Mutex::new(Switch::Unknown),
                effort_switch: Mutex::new(Switch::Unknown),
                echoed_turn: Mutex::new(None),
            }),
            commands: None,
            pid: None,
            overrides,
            pending_mode: None,
        }
    }

    fn send_command(&self, command: Command) -> Result<(), String> {
        let tx = self.commands.as_ref().ok_or("chat session is not running")?;
        tx.unbounded_send(command)
            .map_err(|_| "chat session is no longer running".to_string())
    }
}

impl AgentTransport for AcpTransport {
    fn start(&mut self, spec: StartSpec, sink: Sink) -> Result<(), String> {
        if self.commands.is_some() {
            return Err("chat session is already running".to_string());
        }

        // The shared builder, so PATH handling, the cwd and env layering cannot
        // drift between transports. Going through `AcpAgent::from_str` instead
        // would spawn a child with no `augmented_path()`, which fails to find
        // the agent binary on a normal desktop launch.
        let mut std_cmd = build_command(&spec);
        // Agents are commonly launched behind a wrapper (`npx …`, `uvx …`).
        // Killing only the immediate child orphans the real agent, which
        // re-parents to pid 1 and does not reliably exit on stdin EOF, so
        // the whole group has to be killable at once.
        Group::prepare(&mut std_cmd);

        // The pipes are configured **after** the conversion, not before:
        // `async_process::Command::from` does not carry a std command's stdio
        // settings across, so setting them on `std_cmd` leaves the child with
        // inherited stdio and no pipes to speak the protocol over.
        let mut cmd = async_process::Command::from(std_cmd);
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("could not start the agent: {e}"))?;
        let group = Group::adopt(child.id()).map_err(|e| {
            let _ = child.kill();
            format!("could not start the agent: {e}")
        })?;
        self.pid = Some(child.id());

        let stdin = child.stdin.take().ok_or("the agent gave no stdin")?;
        let stdout = child.stdout.take().ok_or("the agent gave no stdout")?;

        let (tx, rx) = mpsc::unbounded();
        self.commands = Some(tx);

        let shared = self.shared.clone();
        let overrides = self.overrides.clone();
        let cwd = spec.cwd.clone();
        let agent = self.agent.clone();
        thread::Builder::new()
            .name(format!("acp-{}", self.shared.session_id))
            .spawn(move || {
                let outcome = futures::executor::block_on(run_session(
                    ByteStreams::new(stdin, stdout),
                    rx,
                    shared.clone(),
                    sink.clone(),
                    cwd,
                    agent,
                    overrides,
                ));
                // Whatever happened, nothing is left blocked on a question
                // nobody will answer.
                shared.cancel_all_pending();
                if !shared.finished.swap(true, Ordering::SeqCst) {
                    match outcome {
                        Ok(()) => emit(
                            &sink,
                            ChatEvent::SessionEnded {
                                session_id: shared.session_id.clone(),
                                reason: None,
                            },
                        ),
                        Err(message) => emit(
                            &sink,
                            ChatEvent::SessionError {
                                session_id: shared.session_id.clone(),
                                message,
                                fatal: true,
                            },
                        ),
                    }
                }
                // Rust's `Child` does not kill on drop, so a connection that
                // ended for any reason would otherwise leave a live agent with
                // nobody holding it - the exact orphan the ownership registry
                // exists to detect, manufactured by the code meant to prevent it.
                group.kill_tree();
                let _ = child.kill();
            })
            .map_err(|e| format!("could not start the agent's connection thread: {e}"))?;

        Ok(())
    }

    fn send(&mut self, blocks: &[ContentBlock]) -> Result<(), String> {
        if let Some(mode) = self.pending_mode.take() {
            // The config option when the agent published one, the spec verb
            // otherwise. Both measured agents are the first case; the fallback
            // exists so an agent that only implements `session/set_mode` is not
            // left without a mode switch at all.
            let switch = self
                .shared
                .mode_switch
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let command = match switch {
                Switch::Available(config_id) => Command::SetConfigOption {
                    config_id,
                    value: ChatConfigValue::Value(mode.as_str().to_string()),
                    what: ConfigOption::Mode,
                },
                Switch::Unsupported | Switch::Unknown => Command::SetMode(mode),
            };
            self.send_command(command)?;
        }
        self.send_command(Command::Prompt(blocks.to_vec()))
    }

    /// ACP has no mid-turn delivery: `session/prompt` opens a turn and the next
    /// one cannot start until the current turn's `StopReason` arrives.
    ///
    /// Refused rather than degraded into a queued turn, exactly as the trait
    /// asks. A queued turn is indistinguishable to the caller from a steer that
    /// landed, which would make the UI claim a message reached a running turn
    /// when it will not be seen until the next one.
    fn steer(&mut self, _blocks: &[ContentBlock]) -> Result<(), String> {
        Err("this agent cannot take a message mid-turn".to_string())
    }

    fn interrupt(&mut self) -> Result<(), String> {
        self.send_command(Command::Cancel)
    }

    fn respond_permission(
        &mut self,
        _tool_use_id: &str,
        request_id: &str,
        decision: PermissionDecision,
        _scope: PermissionScope,
        reason: Option<&str>,
    ) -> Result<bool, String> {
        // Scope is dropped on purpose: ACP has no "remember this" grammar of its
        // own. An agent's `allow_always` option is the closest thing, and it is
        // the agent's to offer, not Tori's to synthesize from a scope the
        // protocol cannot carry.
        self.shared.answer(request_id, decision, reason)
    }

    /// Refused, not swallowed. ACP's `elicitation/create` is the wire form a
    /// question would arrive on, and it sits behind the `unstable_elicitation`
    /// cargo feature: probed on codex-acp 1.2.0 and pi-acp 0.0.33, both accept
    /// the client capability on the handshake and neither ever sends one. So
    /// nothing here can be blocked on a question, and an `Ok` would claim an
    /// answer reached an agent that never asked.
    fn respond_question(
        &mut self,
        _tool_use_id: &str,
        _request_id: &str,
        _answers: &[QuestionAnswer],
    ) -> Result<bool, String> {
        Err("this agent cannot be asked a question".to_string())
    }

    /// A mode switch takes the same route a model switch does when the agent
    /// published a `mode`-category config option, and falls back to the spec's
    /// `session/set_mode` when it did not.
    ///
    /// Held as `pending_mode` and sent with the next prompt rather than
    /// immediately, which is the trait's stated next-turn semantics and matters
    /// more here than it looks: a mode decides whether the agent asks before it
    /// writes, so applying one mid-turn would change the rules under a tool call
    /// already in flight.
    fn set_mode(&mut self, mode: PermissionMode) -> Result<(), String> {
        self.pending_mode = Some(mode);
        Ok(())
    }

    /// Model selection rides `session/set_config_option` rather than a dedicated
    /// verb: `session/set_model` does not exist in ACP 2.0.0, and which options
    /// a session has is the agent's own answer rather than a fixed set.
    ///
    /// Refused when this session offered no model selector, rather than sent to
    /// an id Tori made up. A picker that appears to switch while the session
    /// keeps running the old model is worse than one that says it cannot. The
    /// pick is pending in the store like any other, and the agent's answer,
    /// re-emitted whole as `ConfigOptions`, is what settles it.
    ///
    /// **`effort` used to be dropped here, on the belief that ACP has no notion
    /// of one.** It has: `SessionConfigOptionCategory::ThoughtLevel` is its own
    /// category, and `codex-acp` 1.2.0 publishes six levels under it. So a level
    /// travels as a second `set_config_option`, sent only when this agent
    /// published that selector - dropping it silently is what would make a level
    /// look chosen while the session reasons at the old one.
    ///
    /// Two requests rather than one because they are two options: an agent may
    /// accept the model and refuse the level, and folding them would report one
    /// outcome for two answers.
    fn set_model(&mut self, model: &str, effort: Option<String>) -> Result<(), String> {
        let config_id = match &*self.shared.model_switch.lock().unwrap_or_else(|e| e.into_inner()) {
            Switch::Available(config_id) => config_id.clone(),
            Switch::Unsupported => return Err("this agent offers no model to switch to".to_string()),
            // Not the agent's answer, Tori's timing: the options arrive with the
            // session, so a switch attempted before it opens has nothing to name
            // yet. Saying the agent offers no models would be a claim about the
            // agent made from Tori not having asked.
            Switch::Unknown => {
                return Err("this chat is still opening, so its model list has not arrived yet".to_string())
            }
        };
        self.send_command(Command::SetConfigOption {
            config_id,
            value: ChatConfigValue::Value(model.to_string()),
            what: ConfigOption::Model,
        })?;

        // Only when the agent published a thought-level selector. An agent that
        // did not is not sent a level it has nowhere to put, and the control
        // never offered one either - `model_catalogue` claims no levels for it.
        let Some(level) = effort else { return Ok(()) };
        let switch = self
            .shared
            .effort_switch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let Switch::Available(config_id) = switch else {
            return Ok(());
        };
        self.send_command(Command::SetConfigOption {
            config_id,
            value: ChatConfigValue::Value(level.as_str().to_string()),
            what: ConfigOption::Effort,
        })
    }

    /// A mirrored control's switch, named by the agent's own config id.
    ///
    /// **Sent straight away, unlike the mode.** A mode decides whether the agent
    /// asks before it writes, so it waits for a turn boundary; a mirrored option
    /// is whatever the agent published, Tori knows nothing about what it governs,
    /// and holding it back would be Tori inventing next-turn semantics for a
    /// lever it has never seen.
    ///
    /// Nothing is checked against a local list first, on purpose: the ids in the
    /// mirror came from this session's own answer, and re-validating them here
    /// would be a second copy of that list to keep in step.
    fn set_config_option(&mut self, config_id: &str, value: &ChatConfigValue) -> Result<(), String> {
        self.send_command(Command::SetConfigOption {
            config_id: config_id.to_string(),
            value: value.clone(),
            // The agent's own id is the noun a failure names. Tori has no
            // friendlier word for a lever it has never seen, and the label is
            // the agent's too, so quoting the id at least names the thing the
            // agent itself refused.
            what: ConfigOption::Mirrored {
                id: config_id.to_string(),
            },
        })
    }

    fn replay(&mut self) -> Result<bool, String> {
        // Answered from the handshake, not attempted and reported: the host has
        // to know *before* it decides what to hand the rewired tab, and a queued
        // command has not run yet.
        if !self.shared.can_reload.load(Ordering::SeqCst) {
            return Ok(false);
        }
        self.send_command(Command::Reload)?;
        Ok(true)
    }

    fn echoes_sent_turns(&self) -> bool {
        true
    }

    fn close(&mut self) -> Result<(), String> {
        // Marked finished *before* the command goes out, so the connection
        // thread's own exit does not also report a session error for a teardown
        // the user asked for.
        self.shared.finished.store(true, Ordering::SeqCst);
        let _ = self.send_command(Command::Close);
        self.commands = None;
        Ok(())
    }

    fn child_pid(&self) -> Option<u32> {
        self.pid
    }
}

/// The connection's whole life: handshake, session, then commands until close.
async fn run_session(
    transport: ByteStreams<async_process::ChildStdin, async_process::ChildStdout>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    shared: Arc<Shared>,
    sink: Sink,
    cwd: String,
    agent: String,
    overrides: AcpOverrides,
) -> Result<(), String> {
    let notification_shared = shared.clone();
    let notification_sink = sink.clone();
    // One per connection, owned by the notification handler because that is the
    // only thing that reads it and notifications are delivered one at a time.
    let mut tool_calls = acp::AcpToolCalls::default();
    // The session's own directory, so an agent that sends a file's prior text
    // has an object store to put it in. Owned by the closure because the
    // notification handler outlives this frame.
    let notification_cwd = std::path::PathBuf::from(&cwd);
    let request_shared = shared.clone();
    let request_sink = sink.clone();

    Client
        .builder()
        .name("tori")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                for event in update_events(
                    &notification_shared,
                    &mut tool_calls,
                    &notification.update,
                    Some(notification_cwd.as_path()),
                ) {
                    emit(&notification_sink, event);
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                park_permission_request(&request_shared, &request_sink, request, responder);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(transport, |conn: ConnectionTo<Agent>| async move {
            let result = drive_session(&conn, &mut commands, &shared, &sink, &cwd, &agent, &overrides).await;
            if let Err(message) = result {
                if !shared.finished.load(Ordering::SeqCst) {
                    emit(
                        &sink,
                        ChatEvent::SessionError {
                            session_id: shared.session_id.clone(),
                            message,
                            fatal: true,
                        },
                    );
                    shared.finished.store(true, Ordering::SeqCst);
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())
}

/// Park a permission question and show it, rather than answering it here.
///
/// Tori never decides a permission itself: the agent owns permissions and Tori
/// only carries the question to the user and the answer back. Auto-answering
/// anything here - even a deny - would be Tori deciding.
fn park_permission_request(
    shared: &Arc<Shared>,
    sink: &Sink,
    request: RequestPermissionRequest,
    responder: Responder<RequestPermissionResponse>,
) {
    let request_id = shared.next_id("acp-perm");
    let (allow_options, deny_options) = split_options(&request.options);
    let deadline = now_ms() + DECIDE_TIMEOUT_SECS * 1000;
    let event = acp::map_permission_request(&shared.session_id, &request_id, &request, Some(deadline));

    if let Ok(mut pending) = shared.pending.lock() {
        pending.insert(
            request_id.clone(),
            Parked {
                responder,
                allow_options,
                deny_options,
            },
        );
    } else {
        // The map is poisoned, so the question can never be answered through
        // it. Say so rather than showing a prompt whose answer goes nowhere.
        return;
    }

    emit(sink, event);
    arm_auto_deny(shared, request_id);
}

/// Deny an unanswered question when its deadline passes.
///
/// The same fail-closed rule the approval bridge states: a question nobody
/// answers must resolve to a denial with a reason, never to a hang and never to
/// an allow.
/// The wait is a condvar loop rather than a sleep, so answering a prompt retires
/// its thread at once. It still only *tries* to answer on expiry: [`Shared::claim`]
/// stays the single place that decides whether a question is outstanding, so a
/// user clicking as the deadline fires wins and the timer's write is dropped.
/// The loop is required because a condvar may wake spuriously and because
/// `notify_all` wakes every armed deadline, not only the one that was settled.
fn arm_auto_deny(shared: &Arc<Shared>, request_id: String) {
    let shared = shared.clone();
    thread::spawn(move || {
        let expires_at = std::time::Instant::now() + Duration::from_secs(DECIDE_TIMEOUT_SECS);
        {
            let Ok(mut pending) = shared.pending.lock() else { return };
            while pending.contains_key(&request_id) {
                let Some(left) = expires_at.checked_duration_since(std::time::Instant::now()) else {
                    break;
                };
                if left.is_zero() {
                    break;
                }
                let Ok((guard, _)) = shared.settled.wait_timeout(pending, left) else {
                    return;
                };
                pending = guard;
            }
        }
        let _ = shared.answer(
            &request_id,
            PermissionDecision::Deny,
            Some("Tori denied this because nobody answered in time."),
        );
    });
}

/// Handshake, open a session, then serve commands until close.
#[allow(clippy::too_many_arguments)]
async fn drive_session(
    conn: &ConnectionTo<Agent>,
    commands: &mut mpsc::UnboundedReceiver<Command>,
    shared: &Arc<Shared>,
    sink: &Sink,
    cwd: &str,
    agent: &str,
    overrides: &AcpOverrides,
) -> Result<(), String> {
    let init = with_deadline(
        conn.send_request(initialize_request(overrides)).block_task(),
        HANDSHAKE_TIMEOUT_SECS,
        "the agent did not answer the handshake",
    )
    .await?;

    shared
        .can_reload
        .store(init.agent_capabilities.load_session, Ordering::SeqCst);

    // The child answered, so the session is live even though no turn has run.
    // Emitted before `SessionStarted` for the same reason the Claude transport
    // does it: otherwise a freshly opened chat reads "connecting" until the
    // first message, about an agent that replied within a second.
    emit(
        sink,
        ChatEvent::SessionReady {
            session_id: shared.session_id.clone(),
            slash_commands: Vec::new(),
            // Neither catalogue is known yet: both arrive with the session, one
            // request later, and ride `SessionStarted`. Empty here is the
            // honest answer rather than a placeholder.
            models: Vec::new(),
            modes: Vec::new(),
            account: None,
            capabilities: Some(acp::capabilities(&init)),
        },
    );

    // Sent again on every load: an agent starts the servers per session/new or
    // session/load, and a resumed chat would otherwise come back without them.
    let servers = mcp_servers(overrides, || tori_mcp_server(&shared.session_id));
    let OpenedSession {
        session_id: session,
        config_options,
    } = open_session(conn, shared, sink, cwd, agent, &servers, &init).await?;
    adopt_session(shared, sink, cwd, &config_options);
    // **After the chat is open, never before it.** Enumerating an agent's other
    // sessions is worth one request on a connection that already exists, but it
    // is not worth making the user wait: an agent with pages of history would
    // otherwise hold a freshly clicked chat closed for several round trips over
    // something nobody asked to see. Commands sent during the walk queue on the
    // channel below and are served the moment it returns.
    //
    // Gated on the advertisement, so an agent that does not do listings is never
    // sent a method it would answer with `method not found`.
    if lists_sessions(&init) {
        if let Err(message) = refresh_listing(conn, agent, cwd).await {
            // Non-fatal by design: the session is already open and works whether
            // or not Tori could enumerate its siblings.
            emit(
                sink,
                ChatEvent::SessionError {
                    session_id: shared.session_id.clone(),
                    message: format!("this agent would not list its sessions: {message}"),
                    fatal: false,
                },
            );
        }
    }

    let session_id = session;
    while let Some(command) = commands.next().await {
        match command {
            Command::Prompt(blocks) => {
                run_turn(conn, shared, sink, &session_id, blocks);
            }
            Command::Cancel => {
                let _ = conn.send_notification(CancelNotification::new(session_id.clone()));
            }
            Command::Reload => {
                // The whole conversation is about to come back, its user turns
                // included, and none of those is the echo of a live prompt.
                shared.forget_echoed();
                let mut request = LoadSessionRequest::new(session_id.clone(), PathBuf::from(cwd));
                request.mcp_servers = servers.clone();
                match conn.send_request(request).block_task().await {
                    // The replayed `session/update`s have already landed by the
                    // time this answers, so announcing the session here puts
                    // `SessionStarted` after them - the same order a fresh open
                    // produces, which is what lets a consumer read everything
                    // before it as the conversation.
                    Ok(loaded) => adopt_session(shared, sink, cwd, &loaded.config_options.unwrap_or_default()),
                    // Non-fatal: the session is still perfectly usable, it just
                    // could not be re-read. Saying so beats a panel that stays
                    // silently empty.
                    Err(e) => emit(
                        sink,
                        ChatEvent::SessionError {
                            session_id: shared.session_id.clone(),
                            message: format!(
                                "this agent would not hand the conversation back, so this tab starts empty: {e}"
                            ),
                            fatal: false,
                        },
                    ),
                }
            }
            Command::SetConfigOption { config_id, value, what } => {
                let request = SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    SessionConfigId::new(config_id.as_str()),
                    option_value(&value),
                );
                let answer = conn.send_request(request).block_task().await;
                let answer = answer
                    .as_ref()
                    .map(|response| response.config_options.as_slice())
                    .map_err(|e| e.to_string());
                for event in switch_events(&shared.session_id, &what, &value.as_text(), answer) {
                    emit(sink, event);
                }
            }
            Command::SetMode(mode) => {
                let request = SetSessionModeRequest::new(session_id.clone(), SessionModeId::new(mode.as_str()));
                if let Err(e) = conn.send_request(request).block_task().await {
                    // A refusal rather than a plain error, so the store settles
                    // the pick instead of promising the mode forever.
                    emit(
                        sink,
                        ChatEvent::ModeRefused {
                            session_id: shared.session_id.clone(),
                            mode,
                            reason: format!("this agent would not switch mode: {e}"),
                        },
                    );
                }
            }
            Command::Close => break,
        }
    }
    Ok(())
}

/// The answer is checked, not assumed: the agent's whole option set says what is
/// *now* selected, which need not be what was asked. The set goes out first (it
/// is how the store confirms an ACP pick), then a mode that did not take refuses.
fn switch_events(
    session_id: &str,
    what: &ConfigOption,
    asked: &str,
    answer: Result<&[SessionConfigOption], String>,
) -> Vec<ChatEvent> {
    let did_not_take = |message: String| match what {
        ConfigOption::Mode => ChatEvent::ModeRefused {
            session_id: session_id.to_string(),
            mode: PermissionMode::new(asked),
            reason: message,
        },
        _ => ChatEvent::SessionError {
            session_id: session_id.to_string(),
            message,
            fatal: false,
        },
    };
    let options = match answer {
        Err(e) => {
            return vec![did_not_take(format!(
                "this agent would not switch {}: {e}",
                what.noun()
            ))]
        }
        Ok(options) => options,
    };
    let mut events = vec![ChatEvent::ConfigOptions {
        session_id: session_id.to_string(),
        options: acp::config_options(options),
    }];
    match what.current(options) {
        Some(now) if now == asked => {}
        Some(now) => events.push(did_not_take(format!(
            "this agent accepted the switch but reports its {} is `{now}` rather than `{asked}`.",
            what.noun()
        ))),
        // Only a mode reads "unsaid" as refused: left pending it would promise
        // the mode forever, while an unmentioned mirrored option is "cannot tell".
        None if *what == ConfigOption::Mode => events.push(did_not_take(
            "this agent accepted the switch but its answer does not say which mode it is in.".to_string(),
        )),
        None => {}
    }
    events
}

/// What one `session/update` becomes, minus the prompt this transport has
/// already put in the stream for the turn it belongs to.
///
/// A named function rather than a block inside the notification closure so the
/// drop is testable: an agent that echoes the prompt and one that does not have
/// to produce the same single `UserMessage`, and that is a property, not a
/// detail of how the handler is written.
fn update_events(
    shared: &Shared,
    tool_calls: &mut acp::AcpToolCalls,
    update: &SessionUpdate,
    cwd: Option<&Path>,
) -> Vec<ChatEvent> {
    let turn = shared.turn();
    let echoed = shared.already_echoed(&turn);
    tool_calls
        .map(&shared.session_id, &turn, update, cwd)
        .into_iter()
        .filter(|event| !(echoed && matches!(event, ChatEvent::UserMessage { .. })))
        .collect()
}

/// Run one turn as a spawned task, so the command loop stays responsive.
///
/// A turn is awaited on the connection's own task pool rather than inline,
/// because an inline `await` would hold the command loop for the whole turn -
/// and the one command a user is most likely to send *during* a turn is the
/// interrupt that ends it.
fn run_turn(
    conn: &ConnectionTo<Agent>,
    shared: &Arc<Shared>,
    sink: &Sink,
    session_id: &SessionId,
    blocks: Vec<ContentBlock>,
) {
    // Published before the prompt goes out, so an update that arrives before
    // this call returns is already stamped with the turn it belongs to.
    let turn = acp::turn_id(shared.seq.fetch_add(1, Ordering::SeqCst));
    if let Ok(mut current) = shared.current_turn.lock() {
        *current = turn.clone();
    }
    // **The user's own turn enters the stream from what Tori sent**, not from
    // what the agent hands back: measured 2026-09-08, `codex-acp` 1.2.0 echoes
    // nothing for a live prompt, so a conversation read back later would be the
    // assistant talking to itself. Emitted before the request goes out, so it
    // cannot land after the answer it prompted. An agent that does echo has its
    // copy dropped for this turn by the notification handler.
    shared.note_echoed(&turn);
    emit(
        sink,
        ChatEvent::UserMessage {
            session_id: shared.session_id.clone(),
            turn_id: turn.clone(),
            blocks: blocks.clone(),
        },
    );
    let request = PromptRequest::new(session_id.clone(), acp::prompt_blocks(&blocks));
    let pending = conn.send_request(request).block_task();
    // Kept for the spawn-failure path below, which runs on this thread rather
    // than inside the task that consumes the other pair.
    let (outer_shared, outer_sink) = (shared.clone(), sink.clone());
    let (shared, sink) = (shared.clone(), sink.clone());

    let spawned = conn.spawn(async move {
        match pending.await {
            Ok(response) => emit(
                &sink,
                acp::map_stop_reason(&shared.session_id, &turn, response.stop_reason),
            ),
            // Swallowed into an event rather than returned: the SDK shuts the
            // whole connection down when a spawned task returns an error, so a
            // single failed turn would take the session with it.
            Err(e) => emit(
                &sink,
                ChatEvent::SessionError {
                    session_id: shared.session_id.clone(),
                    message: format!("the turn failed: {e}"),
                    fatal: false,
                },
            ),
        }
        Ok(())
    });
    if spawned.is_err() {
        emit(
            &outer_sink,
            ChatEvent::SessionError {
                session_id: outer_shared.session_id.clone(),
                message: "the agent's connection is no longer accepting turns".to_string(),
                fatal: true,
            },
        );
    }
}

/// The `initialize` payload, with the client capabilities this build actually
/// serves.
///
/// `fs` and `terminal` are declined by default: agents do their own I/O, and
/// declining all three is a complete configuration rather than a degraded one.
/// An adapter opts back in through [`AcpOverrides::serve_client_fs`].
/// Shared with the catalogue probe rather than copied: a probe that handshook
/// with different capabilities than a real session would be measuring an agent
/// Tori never actually runs.
pub fn initialize_request(overrides: &AcpOverrides) -> InitializeRequest {
    use agent_client_protocol::schema::v1::{ClientCapabilities, FileSystemCapabilities};

    let mut capabilities = ClientCapabilities::default();
    if overrides.serve_client_fs {
        let mut fs = FileSystemCapabilities::default();
        fs.read_text_file = true;
        fs.write_text_file = true;
        capabilities.fs = fs;
        capabilities.terminal = true;
    }
    let mut request = InitializeRequest::new(ProtocolVersion::V1);
    request.client_capabilities = capabilities;
    request
}

/// The `session/new` payload.
///
/// `cwd` and `mcpServers` are both sent unconditionally, never gated on a
/// capability: per [[concept_acp_agent_quirks]] an empty array is a value and an
/// absent key is a protocol error to agents that validate strictly. Whether the
/// array is *populated* is the caller's call.
/// Shared with the catalogue probe for the same reason as
/// [`initialize_request`]: the options a probe reads are the ones this exact
/// payload asks for.
pub fn new_session_request(cwd: &str, mcp_servers: &[McpServer]) -> NewSessionRequest {
    let mut request = NewSessionRequest::new(std::path::PathBuf::from(cwd));
    request.mcp_servers = mcp_servers.to_vec();
    request
}

// Empty unless the adapter opts in: an agent that does not speak MCP can fail
// `session/new` outright on a populated array. No token is minted when it is off.
fn mcp_servers(overrides: &AcpOverrides, tori: impl FnOnce() -> Option<McpServer>) -> Vec<McpServer> {
    match overrides.send_mcp_servers {
        true => tori().into_iter().collect(),
        false => Vec::new(),
    }
}

fn tori_mcp_server(session_id: &str) -> Option<McpServer> {
    let (exe, env) = crate::rpc::mcp_launch(crate::rpc::auth::Caller::Chat(session_id.to_string()))?;
    let env = env
        .into_iter()
        .map(|(name, value)| EnvVariable::new(name, value))
        .collect();
    Some(McpServer::Stdio(
        McpServerStdio::new(crate::rpc::MCP_SERVER, exe)
            .args(vec!["mcp".to_string()])
            .env(env),
    ))
}

/// Does this agent advertise `session/list`?
///
/// Read off the handshake rather than assumed, and read as an advertisement
/// rather than as a promise of rows: `opencode acp` 1.18.3 advertises the
/// capability and returns nothing at all. An empty list is an empty history,
/// never an error.
fn lists_sessions(init: &InitializeResponse) -> bool {
    init.agent_capabilities.session_capabilities.list.is_some()
}

/// How many pages of `session/list` Tori will walk before it stops asking.
///
/// A bound rather than a full drain: the cursor is the agent's, and an agent
/// whose `nextCursor` never clears would otherwise loop forever. Ten pages is
/// far past the 50 rows the measured agents return in one.
///
/// **What a full ten pages drops is the oldest history**, because a listing
/// comes back newest-first, so the sessions a user is likely to reopen are the
/// ones that survive the cap. Said here rather than reported to the user: a
/// message on every chat open, for a store nobody has yet grown that large, is
/// worse than the limit it describes.
const MAX_SESSION_PAGES: usize = 10;

/// Ask the agent what sessions it has here, and write a locator for each row
/// that is new or has changed. Returns how many it wrote, which on a second
/// connection with nothing new is zero.
///
/// The `cwd` filter is sent because the protocol offers one, but nothing relies
/// on the agent honouring it: each row records its own `cwd` and the sidebar
/// filters on that, so an agent that returns everything costs a few extra
/// locators rather than a folder full of another project's sessions.
///
/// **The filter is sent canonicalized, and the rows come back re-spelled.**
/// Measured on `codex-acp` 1.2.0: the filter is matched as a string, and a
/// directory macOS hands out as `/var/...` is recorded by the agent as
/// `/private/var/...`, so the same directory under its other name listed nothing
/// at all. The return leg is the same fact from the other side: a row Tori has
/// never seen would otherwise be filed under the agent's spelling, and the
/// sidebar's prefix match against the folder the user opened would then hide the
/// very rows this listing exists to find. `adopt` already keeps Tori's spelling
/// for a row it knows; this extends that to a row it is meeting for the first
/// time, which is the whole of the import case.
async fn refresh_listing(conn: &ConnectionTo<Agent>, agent: &str, cwd: &str) -> Result<usize, String> {
    let known = acp_sessions::all();
    let ours = canonical(cwd);
    let filter = ours.clone().unwrap_or_else(|| cwd.to_string());
    let mut cursor: Option<String> = None;
    let mut rows: Vec<ListedSession> = Vec::new();
    for _ in 0..MAX_SESSION_PAGES {
        let mut request = ListSessionsRequest::new();
        request.cwd = Some(std::path::PathBuf::from(&filter));
        request.cursor = cursor;
        let page = conn
            .send_request(request)
            .block_task()
            .await
            .map_err(|e| e.to_string())?;
        rows.extend(page.sessions.iter().map(listed_session));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }

    // Resolved once, not once per row: a listing is up to ten pages and every
    // row would otherwise pay for canonicalizing the same directory again.
    if let Some(ours) = &ours {
        for row in &mut rows {
            if row.cwd != cwd && canonical(&row.cwd).as_ref() == Some(ours) {
                row.cwd = cwd.to_string();
            }
        }
    }

    let adopted = acp_sessions::adopt(
        agent,
        &rows,
        &known,
        now_secs(),
        &crate::catalog_probe::probe_cwd_spellings(),
    );
    let mut written = 0;
    for session in &adopted {
        // A listing runs on every connection and most of it is the same rows as
        // last time, so writing the ones that did not change is pure churn: N
        // files rewritten every time the user opens any chat of this agent.
        if known.contains(session) {
            continue;
        }
        // One unwritable locator must not lose the rest of the page.
        if acp_sessions::record(session).is_ok() {
            written += 1;
        }
    }
    Ok(written)
}

/// A path with its symlinks resolved, or `None` when it does not resolve.
///
/// Kept out of [`acp_sessions::adopt`] on purpose: that function is pure so what
/// a listed row becomes is testable without a filesystem, and this is the one
/// part of the question only the filesystem can answer.
fn canonical(path: &str) -> Option<String> {
    crate::platform::fs::canonical(path)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

fn listed_session(info: &agent_client_protocol::schema::v1::SessionInfo) -> ListedSession {
    ListedSession {
        acp_session_id: info.session_id.0.to_string(),
        cwd: info.cwd.to_string_lossy().into_owned(),
        title: info.title.clone(),
        updated_at: info.updated_at.clone(),
    }
}

/// Attach to the session this tab is for: load the one Tori has a locator for,
/// or open a new one.
///
/// **The locator is what makes a reopened chat a reopened chat.** ACP mints its
/// own session id inside `session/new`, so Tori's id and the agent's are never
/// the same string, and nothing in the launch command carries either one. The
/// locator written after the first `session/new` is the only bridge back, and
/// `session/load` replays the whole conversation as ordinary `session/update`
/// notifications - which is why replay needs no new event, no transcript file
/// and no change to `chat_history`.
#[allow(clippy::too_many_arguments)]
/// A session that is open, and what it said about itself as it opened.
///
/// The config options travel with the id rather than being fetched afterwards
/// because there is no request that would fetch them: they are answered *by*
/// `session/new` and `session/load`, once, and an agent is not obliged to
/// mention them again.
struct OpenedSession {
    session_id: SessionId,
    config_options: Vec<SessionConfigOption>,
}

/// Take up an opened session's own answer about itself, and tell the UI.
///
/// Called on the way out of `session/new` and again on a reload, which is what
/// makes a rewired tab indistinguishable from a fresh one: the same three
/// switches are armed from the same answer, and the same two events land in the
/// same order. `SessionStarted` last of the two on purpose - a consumer reads it
/// as "the session is open", which is the end of any replay that preceded it.
fn adopt_session(shared: &Arc<Shared>, sink: &Sink, cwd: &str, config_options: &[SessionConfigOption]) {
    // The model catalogue and the running model both come from the session's own
    // config options, so they reach the UI on the event that says a session
    // exists. `model_args` is empty for every ACP adapter: a switch is a request,
    // not a flag, so the id the switch has to name is kept here rather than
    // re-derived from an option list nobody would have any more.
    *shared.model_switch.lock().unwrap_or_else(|e| e.into_inner()) = match acp::model_config_id(config_options) {
        Some(config_id) => Switch::Available(config_id),
        None => Switch::Unsupported,
    };
    // The mode selector arrives on the same answer and is kept for the same
    // reason. Measured on `codex-acp` 1.2.0: this is the *only* lever on whether
    // Codex asks before it writes. It ignores the user's own `approval_policy`
    // and `sandbox_mode` from `~/.codex/config.toml` (verified: `config/read`
    // reports them set, and the wrapper writes anyway) and applies its own mode
    // instead, defaulting to `agent`. So without this the agent's permission
    // prompt is something Tori publishes and no user can reach.
    *shared.mode_switch.lock().unwrap_or_else(|e| e.into_inner()) = match acp::mode_config_id(config_options) {
        Some(config_id) => Switch::Available(config_id),
        None => Switch::Unsupported,
    };
    *shared.effort_switch.lock().unwrap_or_else(|e| e.into_inner()) = match acp::effort_config_id(config_options) {
        Some(config_id) => Switch::Available(config_id),
        None => Switch::Unsupported,
    };

    emit(
        sink,
        ChatEvent::SessionStarted {
            session_id: shared.session_id.clone(),
            cwd: cwd.to_string(),
            model: acp::current_model(config_options).unwrap_or_default(),
            permission_mode: PermissionMode::new(acp::current_mode(config_options).unwrap_or_default()),
            tools: Vec::new(),
            slash_commands: Vec::new(),
            mcp_servers: Vec::new(),
            models: acp::model_catalogue(config_options),
            modes: acp::mode_catalogue(config_options),
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
            account: None,
            extra: Default::default(),
        },
    );
    // Right behind the session, and separately from it: the three categories
    // above have controls of their own, and everything else the agent published
    // reaches the user only through this.
    emit(
        sink,
        ChatEvent::ConfigOptions {
            session_id: shared.session_id.clone(),
            options: acp::config_options(config_options),
        },
    );
}

async fn open_session(
    conn: &ConnectionTo<Agent>,
    shared: &Arc<Shared>,
    sink: &Sink,
    cwd: &str,
    agent: &str,
    servers: &[McpServer],
    init: &InitializeResponse,
) -> Result<OpenedSession, String> {
    if let Some(record) = acp_sessions::read(&shared.session_id) {
        if init.agent_capabilities.load_session {
            let session_id = SessionId::new(record.acp_session_id.as_str());
            let mut request = LoadSessionRequest::new(session_id.clone(), PathBuf::from(cwd));
            request.mcp_servers = servers.to_vec();
            match conn.send_request(request).block_task().await {
                Ok(loaded) => {
                    return Ok(OpenedSession {
                        session_id,
                        config_options: loaded.config_options.unwrap_or_default(),
                    })
                }
                // A session the agent has forgotten is not a failure to open a
                // chat: say what was lost and start a fresh one, the same way a
                // deleted transcript leaves a usable empty chat behind.
                Err(e) => emit(
                    sink,
                    ChatEvent::SessionError {
                        session_id: shared.session_id.clone(),
                        message: format!(
                            "this agent could not reopen the earlier conversation, so this chat starts empty: {e}"
                        ),
                        fatal: false,
                    },
                ),
            }
        } else {
            emit(
                sink,
                ChatEvent::SessionError {
                    session_id: shared.session_id.clone(),
                    message: "this agent cannot reopen an earlier conversation, so this chat starts empty.".to_string(),
                    fatal: false,
                },
            );
        }
    }

    let opened = conn
        .send_request(new_session_request(cwd, servers))
        .block_task()
        .await
        .map_err(|e| describe_session_failure(&e, &init.auth_methods))?;

    // Recorded straight away rather than at first turn: a session opened and
    // abandoned still exists inside the agent, and a locator written only on
    // success-plus-a-message would lose it.
    let _ = acp_sessions::record(&AcpSession {
        id: shared.session_id.clone(),
        agent: agent.to_string(),
        acp_session_id: opened.session_id.0.to_string(),
        cwd: cwd.to_string(),
        title: "(untitled session)".to_string(),
        updated_at: now_secs(),
    });
    Ok(OpenedSession {
        session_id: opened.session_id,
        config_options: opened.config_options.unwrap_or_default(),
    })
}

/// Name a `session/new` failure in terms the user can act on.
///
/// `auth_required` is the one error code on this path worth branching on: it
/// means the agent works but nobody is signed in, which is a different thing
/// from a spawn failure and has a different fix. Reporting it as a generic
/// failure sends the user looking for a broken install.
///
/// The methods come from the agent's own `initialize` result and are quoted
/// rather than interpreted. Both agents measured in Phases 4 and 5 describe
/// theirs as a command to run in a terminal (`Run \`opencode auth login\` in the
/// terminal`, `Run \`claude /login\` in the terminal`), so `authenticate` alone
/// cannot sign anybody in and Tori does not pretend it can: what it can do is
/// put the agent's own instruction in front of the user.
///
/// **A third agent was thought to break this and does not.** Phase 8 opened
/// carrying a finding that `@agentclientprotocol/codex-acp` 1.2.0 reports a
/// missing account as "a generic `-32000`" that this branch would miss, and that
/// Tori would therefore show an opaque failure. Measured properly: `-32000` **is**
/// `ErrorCode::AuthRequired` in ACP's own numbering, so the code branch matches
/// and the user already gets the agent's own instruction. The finding came from
/// reading a raw JSON-RPC number off a probe and assuming a named constructor
/// meant a different wire value.
///
/// Left as it was, deliberately: the fix it asked for was a check on the error
/// *text*, which Phase 5 rejected for reasons that still hold and which would
/// have been dead code here. `an_agent_reporting_minus_32000_is_a_sign_in_failure`
/// pins the measured value so the same claim cannot be made a third time.
fn describe_session_failure(error: &agent_client_protocol::Error, methods: &[AuthMethod]) -> String {
    if error.code != ErrorCode::AuthRequired {
        return format!("The agent would not open a session: {error}");
    }
    match describe_auth_methods(methods) {
        Some(how) => format!("This agent needs you to sign in first. {how}"),
        None => format!("This agent needs you to sign in first, and did not say how. {error}"),
    }
}

/// The agent's sign-in instructions as one line of text, or `None` when it
/// offered none.
///
/// Each method's own description is preferred over its name, because the
/// description is where both measured agents put the command to run; the name
/// alone ("Log in with Claude Code") tells a user nothing they can act on.
fn describe_auth_methods(methods: &[AuthMethod]) -> Option<String> {
    let described: Vec<String> = methods
        .iter()
        .map(|method| match method.description() {
            Some(description) if !description.trim().is_empty() => description.trim().to_string(),
            _ => method.name().to_string(),
        })
        .filter(|text| !text.is_empty())
        .collect();
    if described.is_empty() {
        None
    } else {
        Some(described.join(" Or: "))
    }
}

/// Fail a future that takes too long, rather than waiting on it forever.
async fn with_deadline<T>(
    future: impl std::future::Future<Output = Result<T, agent_client_protocol::Error>>,
    secs: u64,
    message: &str,
) -> Result<T, String> {
    use futures::future::{select, Either};
    futures::pin_mut!(future);
    let timer = async_io::Timer::after(Duration::from_secs(secs));
    futures::pin_mut!(timer);
    match select(future, timer).await {
        Either::Left((result, _)) => result.map_err(|e| e.to_string()),
        Either::Right((_, _)) => Err(message.to_string()),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{PermissionOption, PermissionOptionId, PermissionOptionKind};

    fn shared() -> Arc<Shared> {
        Arc::new(Shared {
            session_id: "s1".to_string(),
            finished: AtomicBool::new(false),
            can_reload: AtomicBool::new(false),
            pending: Mutex::new(HashMap::new()),
            settled: std::sync::Condvar::new(),
            current_turn: Mutex::new(String::new()),
            seq: AtomicU64::new(0),
            model_switch: Mutex::new(Switch::Unknown),
            mode_switch: Mutex::new(Switch::Unknown),
            effort_switch: Mutex::new(Switch::Unknown),
            echoed_turn: Mutex::new(None),
        })
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    /// **One user message per turn, whichever agent is behind the session.**
    ///
    /// Tori emits the prompt itself because `codex-acp` 1.2.0 sends nothing back
    /// for a live turn - see `what_codex_replays_is_what_the_log_can_hold` - and
    /// without it the log a restored tab reads would be the assistant talking to
    /// itself. An agent that *does* echo must not therefore have the same
    /// message rendered and logged twice.
    #[test]
    fn a_live_send_puts_exactly_one_user_message_in_the_stream() {
        use agent_client_protocol::schema::v1::{ContentBlock as AcpContentBlock, ContentChunk, TextContent};

        let shared = shared();
        let mut calls = acp::AcpToolCalls::default();
        *shared.current_turn.lock().unwrap() = acp::turn_id(0);
        let turn = shared.turn();
        let chunk = |text: &str| {
            SessionUpdate::UserMessageChunk(ContentChunk::new(AcpContentBlock::Text(TextContent::new(
                text.to_string(),
            ))))
        };

        // What `run_turn` puts in the stream from what Tori sent.
        let mut stream = vec![ChatEvent::UserMessage {
            session_id: shared.session_id.clone(),
            turn_id: turn.clone(),
            blocks: vec![ContentBlock::Text {
                text: "fix the bug".to_string(),
            }],
        }];
        shared.note_echoed(&turn);
        // And what an echoing agent sends back for that same turn.
        stream.extend(update_events(&shared, &mut calls, &chunk("fix the bug"), None));

        assert_eq!(
            stream
                .iter()
                .filter(|e| matches!(e, ChatEvent::UserMessage { .. }))
                .count(),
            1,
            "an echoed prompt must not become a second message: {stream:?}"
        );

        // A reload replays the conversation, and every user turn in it is one
        // the user really sent rather than an echo of a live prompt.
        shared.forget_echoed();
        let replayed = update_events(&shared, &mut calls, &chunk("fix the bug"), None);
        assert!(
            matches!(replayed.as_slice(), [ChatEvent::UserMessage { .. }]),
            "a replayed user turn is the conversation, not an echo: {replayed:?}"
        );
    }

    /// A toggle travels as a boolean and a choice as a value id. Sending the
    /// string `"true"` for a toggle is the failure this pins: the spec has a
    /// shape for each, and an agent given the wrong one either refuses or
    /// silently does nothing.
    #[test]
    fn a_toggle_and_a_choice_leave_in_different_shapes() {
        assert_eq!(
            option_value(&ChatConfigValue::Flag(true)),
            SessionConfigOptionValue::Boolean { value: true }
        );
        assert_eq!(
            option_value(&ChatConfigValue::Value("detailed".into())),
            SessionConfigOptionValue::ValueId {
                value: SessionConfigValueId::new("detailed")
            }
        );
    }

    /// **The readback follows the id, not the category.** The three bespoke
    /// selectors are found by what the agent called them; a mirrored option is
    /// exactly the one no category claims, so reading one back through a
    /// category lookup would compare an unrelated selector's value and report a
    /// mismatch on every switch.
    #[test]
    fn a_mirrored_switch_is_read_back_by_the_agents_own_id() {
        use agent_client_protocol::schema::v1::{SessionConfigBoolean, SessionConfigId, SessionConfigKind};

        let options = vec![SessionConfigOption::new(
            SessionConfigId::new("web_search"),
            "Web search".to_string(),
            SessionConfigKind::Boolean(SessionConfigBoolean::new(true)),
        )];
        let what = ConfigOption::Mirrored {
            id: "web_search".to_string(),
        };

        assert_eq!(what.current(&options).as_deref(), Some("true"));
        assert_eq!(
            what.noun(),
            "web_search",
            "and a failure names what the agent called it"
        );
        // An id the answer does not mention reads as unknown rather than as a
        // mismatch: "we cannot tell" must not render as the agent refusing.
        let absent = ConfigOption::Mirrored {
            id: "verbosity".to_string(),
        };
        assert_eq!(absent.current(&options), None);
    }

    /// A mode-category select with `current` in force, the shape both measured
    /// agents answer `session/set_config_option` with.
    fn mode_select(current: &str) -> SessionConfigOption {
        use agent_client_protocol::schema::v1::{
            SessionConfigId, SessionConfigKind, SessionConfigOptionCategory, SessionConfigSelect,
            SessionConfigSelectOption, SessionConfigSelectOptions,
        };
        let entries = ["read-only", "agent"]
            .iter()
            .map(|id| SessionConfigSelectOption::new(SessionConfigValueId::new(*id), id.to_string()))
            .collect();
        let mut option = SessionConfigOption::new(
            SessionConfigId::new("approval_policy"),
            "Mode".to_string(),
            SessionConfigKind::Select(SessionConfigSelect::new(
                SessionConfigValueId::new(current),
                SessionConfigSelectOptions::Ungrouped(entries),
            )),
        );
        option.category = Some(SessionConfigOptionCategory::Mode);
        option
    }

    fn kinds(events: &[ChatEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|e| match e {
                ChatEvent::ConfigOptions { .. } => "configOptions",
                ChatEvent::ModeRefused { .. } => "modeRefused",
                ChatEvent::SessionError { .. } => "sessionError",
                _ => "other",
            })
            .collect()
    }

    /// A mode that took is the option set and nothing else: the store reads the
    /// mode's `current` off that set, which is the confirmation on this transport.
    #[test]
    fn a_mode_the_agent_took_is_confirmed_by_its_option_set_alone() {
        let options = vec![mode_select("read-only")];
        let events = switch_events("s1", &ConfigOption::Mode, "read-only", Ok(&options));
        assert_eq!(kinds(&events), ["configOptions"]);
    }

    /// Every way a mode can fail to take is a refusal, so the store settles the
    /// pick with the agent's reason rather than promising the mode forever.
    #[test]
    fn a_mode_that_did_not_take_is_a_refusal_however_it_failed() {
        let refused = switch_events("s1", &ConfigOption::Mode, "read-only", Err("nope".into()));
        assert_eq!(kinds(&refused), ["modeRefused"]);
        match &refused[0] {
            ChatEvent::ModeRefused { mode, reason, .. } => {
                assert_eq!(mode.as_str(), "read-only");
                assert!(reason.contains("nope"), "the agent's own words survive: {reason}");
            }
            other => panic!("expected ModeRefused, got {other:?}"),
        }

        // Accepted and then reported as something else: the set goes out first
        // so the store learns the mode in force, then the pick is settled.
        let elsewhere = vec![mode_select("agent")];
        let mismatch = switch_events("s1", &ConfigOption::Mode, "read-only", Ok(&elsewhere));
        assert_eq!(kinds(&mismatch), ["configOptions", "modeRefused"]);
        match &mismatch[1] {
            ChatEvent::ModeRefused { mode, reason, .. } => {
                assert_eq!(mode.as_str(), "read-only");
                assert!(reason.contains("`agent`"), "names what the agent reports: {reason}");
            }
            other => panic!("expected ModeRefused, got {other:?}"),
        }

        // Accepted with an answer that names no mode at all: unconfirmed, and
        // said so, rather than a pick left pending for the rest of the session.
        let silent: Vec<SessionConfigOption> = vec![];
        let unsaid = switch_events("s1", &ConfigOption::Mode, "read-only", Ok(&silent));
        assert_eq!(kinds(&unsaid), ["configOptions", "modeRefused"]);
    }

    /// A model keeps its plain error: nothing in the store settles on it, and
    /// its pending pick is settled by the option set instead.
    #[test]
    fn a_model_that_did_not_take_stays_a_session_error() {
        let refused = switch_events("s1", &ConfigOption::Model, "gpt-5.6", Err("nope".into()));
        assert_eq!(kinds(&refused), ["sessionError"]);
        let silent: Vec<SessionConfigOption> = vec![];
        let unsaid = switch_events("s1", &ConfigOption::Model, "gpt-5.6", Ok(&silent));
        assert_eq!(
            kinds(&unsaid),
            ["configOptions"],
            "no model select reads as unknown, not refused"
        );
    }

    /// An answer must come back in the agent's own vocabulary. Sending a fixed
    /// "allow" token would be answered with a protocol error by an agent whose
    /// option is called something else.
    #[test]
    fn an_allow_selects_the_agents_own_allow_option() {
        let outcome = outcome_for(&ids(&["proceed"]), &ids(&["stop"]), PermissionDecision::Allow);
        assert!(matches!(
            outcome,
            RequestPermissionOutcome::Selected(s) if s.option_id.0.as_ref() == "proceed"
        ));
    }

    #[test]
    fn a_deny_selects_the_agents_own_reject_option() {
        let outcome = outcome_for(&ids(&["proceed"]), &ids(&["stop"]), PermissionDecision::Deny);
        assert!(matches!(
            outcome,
            RequestPermissionOutcome::Selected(s) if s.option_id.0.as_ref() == "stop"
        ));
    }

    /// An agent that offered no option in the answered direction leaves Tori
    /// unable to express the answer at all. `cancelled` is the honest reply;
    /// inventing an option id would be rejected by the agent anyway.
    #[test]
    fn an_answer_the_agent_offered_no_option_for_is_cancelled() {
        let outcome = outcome_for(&[], &ids(&["stop"]), PermissionDecision::Allow);
        assert!(matches!(outcome, RequestPermissionOutcome::Cancelled));
    }

    /// A question Tori never parked is not ours to answer. The host reads
    /// `Ok(false)` as "try the other route", so this must not be an error.
    #[test]
    fn a_question_the_transport_never_parked_is_disclaimed() {
        let shared = shared();
        assert_eq!(shared.answer("never-seen", PermissionDecision::Allow, None), Ok(false));
    }

    /// The defect this pins: turn ids and permission request ids once came from
    /// the same counter, so a single question asked mid-turn re-stamped every
    /// later `session/update` with a turn id no turn ever had. Tori's transcript
    /// keys on `turn_id`, so one turn rendered as two.
    #[test]
    fn a_permission_request_does_not_renumber_the_running_turn() {
        let shared = shared();
        *shared.current_turn.lock().unwrap() = acp::turn_id(0);
        let during_turn = shared.turn();

        // Two questions asked while that turn runs, each minting an id.
        let first = shared.next_id("acp-perm");
        let second = shared.next_id("acp-perm");
        assert_ne!(first, second, "each question needs its own id");

        assert_eq!(
            shared.turn(),
            during_turn,
            "asking a question must not move the turn the updates belong to"
        );
    }

    #[test]
    fn commands_before_start_error_rather_than_panic() {
        let mut transport = AcpTransport::new("s1", "opencode", AcpOverrides::default());
        assert!(transport.send(&[]).is_err());
        assert!(transport.interrupt().is_err());
        assert!(transport.child_pid().is_none());
    }

    /// A refused model switch says **which** refusal it is.
    ///
    /// Both answers are "no", and they are not the same no: one is the agent
    /// having offered no model selector, the other is Tori not having asked yet
    /// because the session is still opening. Reporting the second as the first
    /// blames the agent for Tori's timing, and it is the message a user would act
    /// on by going to look for a setting that is not the problem.
    #[test]
    fn a_model_switch_says_which_refusal_it_is() {
        let mut transport = AcpTransport::new("s1", "opencode", AcpOverrides::default());
        let before = transport
            .set_model("anything", None)
            .expect_err("nothing to switch yet");
        assert!(before.contains("still opening"), "{before}");

        *transport.shared.model_switch.lock().unwrap() = Switch::Unsupported;
        let unsupported = transport.set_model("anything", None).expect_err("no selector");
        assert!(unsupported.contains("offers no model"), "{unsupported}");
        assert!(!unsupported.contains("still opening"), "{unsupported}");

        // And with a selector, the refusal is gone: what stops it now is only
        // that no session is running, which is a different error entirely.
        *transport.shared.model_switch.lock().unwrap() = Switch::Available("model".into());
        let with_selector = transport.set_model("anything", None).expect_err("not started");
        assert!(!with_selector.contains("offers no model"), "{with_selector}");
        assert!(!with_selector.contains("still opening"), "{with_selector}");
    }

    /// ACP has no mid-turn delivery, and the trait says a agent without one
    /// must refuse rather than quietly queue. A queued turn looks exactly like
    /// a steer that landed to everything upstream.
    #[test]
    fn a_steer_is_refused_rather_than_degraded_into_a_queued_turn() {
        let mut transport = AcpTransport::new("s1", "opencode", AcpOverrides::default());
        assert!(transport.steer(&[ContentBlock::Text { text: "hi".into() }]).is_err());
    }

    /// The route a mode picked in a **draft** takes once its session opens.
    ///
    /// A draft has no session, so there is nothing to name a mode against until
    /// one exists - which is why every ACP adapter declares `mode_args = []`
    /// (pinned in `agents.rs`) and why the pick has nowhere to go but the wire.
    ///
    /// Both halves of the ordering matter. Staging alone must send nothing, or a
    /// mode would land mid-turn and change the rules under a tool call already
    /// in flight. And it must go out *before* the first message rather than
    /// after it, because the mode is what decides whether the agent asks before
    /// it writes, and the turn it governs is exactly the first one.
    #[test]
    fn a_drafts_mode_reaches_the_agent_with_its_first_prompt_and_never_as_argv() {
        let mut transport = AcpTransport::new("s1", "codex", AcpOverrides::default());
        let (tx, mut rx) = mpsc::unbounded();
        transport.commands = Some(tx);
        *transport.shared.mode_switch.lock().unwrap() = Switch::Available("approval_policy".into());

        transport
            .set_mode(PermissionMode::new("read-only"))
            .expect("staging a mode the agent offered");
        assert!(rx.try_recv().is_err(), "staging alone puts nothing on the wire");

        transport
            .send(&[ContentBlock::Text { text: "go".into() }])
            .expect("a prompt goes out");

        assert!(
            matches!(
                rx.try_recv().ok(),
                Some(Command::SetConfigOption { ref config_id, what: ConfigOption::Mode, .. })
                    if config_id == "approval_policy"
            ),
            "the mode travels as the agent's own config option, before anything else"
        );
        assert!(
            matches!(rx.try_recv().ok(), Some(Command::Prompt(_))),
            "and the message follows it rather than the other way round"
        );
    }

    /// The gate the listing task asks for: an agent that never advertises
    /// `session/list` is never sent it, because a method it does not implement
    /// comes back as a protocol error the user would see as a broken chat.
    #[test]
    fn an_agent_that_does_not_advertise_listing_is_never_asked_for_one() {
        use agent_client_protocol::schema::v1::{AgentCapabilities, SessionCapabilities, SessionListCapabilities};

        let silent = InitializeResponse::new(ProtocolVersion::V1);
        assert!(!lists_sessions(&silent));

        let mut capabilities = AgentCapabilities::default();
        let mut sessions = SessionCapabilities::default();
        sessions.list = Some(SessionListCapabilities::default());
        capabilities.session_capabilities = sessions;
        let mut advertised = InitializeResponse::new(ProtocolVersion::V1);
        advertised.agent_capabilities = capabilities;
        assert!(lists_sessions(&advertised));
    }

    fn agent_auth(id: &str, name: &str, description: Option<&str>) -> AuthMethod {
        use agent_client_protocol::schema::v1::{AuthMethodAgent, AuthMethodId};
        let mut method = AuthMethodAgent::new(AuthMethodId::new(id), name.to_string());
        method.description = description.map(str::to_string);
        AuthMethod::Agent(method)
    }

    /// The failure this names: an agent that works but has nobody signed in
    /// looks exactly like a broken install unless the error says otherwise. The
    /// two descriptions asserted here are the ones the measured agents actually
    /// return, and they are instructions the user can carry out.
    #[test]
    fn a_sign_in_failure_quotes_the_agents_own_instruction() {
        let error = agent_client_protocol::Error::auth_required();
        let message = describe_session_failure(
            &error,
            &[agent_auth(
                "opencode",
                "Log in",
                Some("Run `opencode auth login` in the terminal"),
            )],
        );
        assert!(message.contains("sign in"), "{message}");
        assert!(message.contains("opencode auth login"), "{message}");

        let message = describe_session_failure(
            &error,
            &[agent_auth(
                "claude",
                "Log in with Claude Code",
                Some("Run `claude /login` in the terminal"),
            )],
        );
        assert!(message.contains("claude /login"), "{message}");
    }

    /// An agent that offers a method but no description leaves only its name to
    /// show, which is still better than an error code.
    #[test]
    fn a_method_with_no_description_falls_back_to_its_name() {
        let message = describe_session_failure(
            &agent_client_protocol::Error::auth_required(),
            &[agent_auth("oauth", "Sign in with Google", None)],
        );
        assert!(message.contains("Sign in with Google"), "{message}");
    }

    /// Sign-in is a claim about the agent's state, so it must not be made about
    /// a failure that says nothing of the kind.
    #[test]
    fn a_failure_that_is_not_about_signing_in_does_not_mention_signing_in() {
        let message = describe_session_failure(
            &agent_client_protocol::Error::invalid_params(),
            &[agent_auth("opencode", "Log in", Some("Run `opencode auth login`"))],
        );
        assert!(!message.contains("sign in"), "{message}");
        assert!(message.contains("would not open a session"), "{message}");
    }

    /// An agent that cannot be asked a question must say so, not report an
    /// answer it never delivered.
    ///
    /// `Ok(true)` is the dangerous return here, not `Err`: it is the one the
    /// caller cannot tell apart from the form having landed, so the user would
    /// watch their answer disappear into an agent that was never blocked.
    #[test]
    fn a_question_cannot_be_answered_at_an_agent_that_cannot_ask_one() {
        let mut transport = AcpTransport::new("s-no-questions", "opencode", AcpOverrides::default());
        let err = transport
            .respond_question(
                "toolu_4",
                "op-10",
                &[QuestionAnswer {
                    question: "Which answer channel?".to_string(),
                    picks: vec!["In protocol".to_string()],
                    free_text: None,
                }],
            )
            .expect_err("an answer must not report success at an agent that never asked");
        assert!(err.contains("cannot be asked a question"), "{err}");
    }

    /// **The wire value, pinned, because a phase was planned around getting it
    /// wrong.**
    ///
    /// Phase 8 opened believing `codex-acp`'s `-32000` was a generic error this
    /// branch would miss, and budgeted a fix for it. `-32000` is what
    /// `ErrorCode::AuthRequired` *is*, so the agent is spec-correct and the
    /// existing branch already handles it - the reproduction below is the exact
    /// frame that agent sends with no account, built from the number rather than
    /// from the named constructor, so it fails if the mapping ever changes.
    #[test]
    fn an_agent_reporting_minus_32000_is_a_sign_in_failure() {
        assert_eq!(ErrorCode::from(-32000), ErrorCode::AuthRequired);

        let mut error = agent_client_protocol::Error::internal_error();
        error.code = ErrorCode::from(-32000);
        error.message = "Authentication required".to_string();

        let message = describe_session_failure(
            &error,
            &[agent_auth("api-key", "API Key", Some("Use an API key to authenticate"))],
        );
        assert!(message.contains("sign in"), "{message}");
        assert!(message.contains("Use an API key to authenticate"), "{message}");
        assert!(!message.contains("would not open a session"), "{message}");
    }

    /// `auth_required` with no methods listed still has to say what is wrong.
    /// Saying nothing would leave the user with a bare protocol error.
    #[test]
    fn a_sign_in_failure_with_no_methods_still_says_so() {
        let message = describe_session_failure(&agent_client_protocol::Error::auth_required(), &[]);
        assert!(message.contains("sign in"), "{message}");
        assert!(message.contains("did not say how"), "{message}");
    }

    /// The first of the two per-agent overrides. An agent that refuses a
    /// populated `mcpServers` must get an empty one, and the key must still be
    /// present either way.
    #[test]
    fn mcp_servers_are_empty_unless_the_adapter_opts_in() {
        let off = mcp_servers(&AcpOverrides::default(), || {
            panic!("no token is minted for an agent that opted out")
        });
        let request = new_session_request("/tmp", &off);
        assert!(request.mcp_servers.is_empty());
        let wire = serde_json::to_value(&request).unwrap();
        assert_eq!(wire["mcpServers"], serde_json::json!([]));

        let tori = McpServer::Stdio(
            McpServerStdio::new("tori", "/sock/bin/tori")
                .args(vec!["mcp".to_string()])
                .env(vec![
                    EnvVariable::new("TORI_SOCK", "/sock/s"),
                    EnvVariable::new("TORI_CALLER", "tok"),
                ]),
        );
        let on = AcpOverrides {
            send_mcp_servers: true,
            ..Default::default()
        };
        let wire = serde_json::to_value(new_session_request("/tmp", &mcp_servers(&on, || Some(tori)))).unwrap();
        assert_eq!(
            wire["mcpServers"],
            serde_json::json!([{
                "name": "tori",
                "command": "/sock/bin/tori",
                "args": ["mcp"],
                "env": [{ "name": "TORI_SOCK", "value": "/sock/s" }, { "name": "TORI_CALLER", "value": "tok" }],
            }])
        );
    }

    /// The second override. Declining fs and terminal is the default and is a
    /// complete configuration: agents do their own I/O.
    #[test]
    fn client_capabilities_are_declined_unless_the_adapter_opts_in() {
        let declined = initialize_request(&AcpOverrides::default());
        assert!(!declined.client_capabilities.terminal);
        assert!(!declined.client_capabilities.fs.read_text_file);
        assert!(!declined.client_capabilities.fs.write_text_file);

        let served = initialize_request(&AcpOverrides {
            serve_client_fs: true,
            ..Default::default()
        });
        assert!(served.client_capabilities.terminal);
        assert!(served.client_capabilities.fs.read_text_file);
    }

    // -----------------------------------------------------------------------
    // Live tests
    //
    // Opt-in (`cargo test -- --ignored --test-threads=1`), because they drive a
    // real ACP agent and need whatever that agent needs. Everything above is
    // pure translation; these exist because the properties they assert are the
    // ones no mock can establish - that a real agent answers Tori's handshake,
    // opens a session, and streams a turn back through the event model.
    // -----------------------------------------------------------------------

    #[cfg(test)]
    fn live_session(session_id: &str, program: &str, args: &[&str]) -> (AcpTransport, Arc<Mutex<Vec<ChatEvent>>>) {
        live_session_as(session_id, program, args).0
    }

    /// A live session under a session id of the caller's choosing, plus the cwd
    /// it was opened in.
    ///
    /// The id matters now that a locator is written per session: two live tests
    /// sharing one id would have the second read the first's locator and try to
    /// `session/load` a conversation from a previous run. The locator store is
    /// redirected to a temp directory for the same reason - a test must not
    /// write into the running user's real history.
    #[cfg(test)]
    #[allow(clippy::type_complexity)]
    fn live_session_as(
        session_id: &str,
        program: &str,
        args: &[&str],
    ) -> ((AcpTransport, Arc<Mutex<Vec<ChatEvent>>>), String) {
        live_session_in(session_id, "opencode", program, args, "shared", &[])
    }

    /// A live session in a cwd of its own, seeded with files before the agent
    /// starts.
    ///
    /// The cwd matters more than it looks. An ACP agent reads *its own* config
    /// out of the working directory, so a test that needs the agent configured a
    /// particular way cannot share the directory every other live test runs in -
    /// one asking for permission on every edit would leave the others waiting on
    /// a prompt nobody answers.
    #[cfg(test)]
    #[allow(clippy::type_complexity)]
    fn live_session_in(
        session_id: &str,
        agent: &str,
        program: &str,
        args: &[&str],
        dir_tag: &str,
        files: &[(&str, &str)],
    ) -> ((AcpTransport, Arc<Mutex<Vec<ChatEvent>>>), String) {
        use super::super::transport::new_sink;

        let root = std::env::temp_dir()
            .join(format!("tori-acp-live-{}", std::process::id()))
            .join(dir_tag);
        std::fs::create_dir_all(&root).unwrap();
        for (name, contents) in files {
            std::fs::write(root.join(name), contents).unwrap();
        }
        acp_sessions::use_dir_for_tests(root.join("locators"));
        let cwd = root.to_string_lossy().into_owned();
        let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = seen.clone();
        let sink = new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev)));

        let mut transport = AcpTransport::new(session_id, agent, AcpOverrides::default());
        transport
            .start(
                StartSpec {
                    session_id: session_id.to_string(),
                    cwd: cwd.clone(),
                    program: program.to_string(),
                    args: args.iter().map(|s| s.to_string()).collect(),
                    env: HashMap::new(),
                },
                sink,
            )
            .expect("the agent should start");
        ((transport, seen), cwd)
    }

    #[cfg(test)]
    fn wait_for(seen: &Arc<Mutex<Vec<ChatEvent>>>, secs: u64, done: impl Fn(&[ChatEvent]) -> bool) -> Vec<ChatEvent> {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let events = seen.lock().unwrap().clone();
            if done(&events) || std::time::Instant::now() >= deadline {
                return events;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    /// The model picker's whole supply for an ACP session, proven live.
    ///
    /// An ACP adapter declares no `[[chat.models]]` on purpose: measured on
    /// `opencode acp` 1.18.3, the agent's own catalogue is 15 provider-qualified
    /// ids and `opencode models` prints the same 15, so there is no shortfall to
    /// make up and a bundled table could only go stale or contradict the user's
    /// authenticated providers. What this pins is that the catalogue really does
    /// arrive over the protocol, since the picker has nothing else to fall back
    /// to.
    #[test]
    #[ignore = "drives the real `opencode acp` binary"]
    fn a_live_session_reports_the_agents_own_model_catalogue() {
        let (mut transport, seen) = live_session("live-models", "opencode", &["acp"]);
        let events = wait_for(&seen, 60, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });

        let started = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::SessionStarted { models, model, .. } => Some((models, model)),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no session started: {events:?}"));
        let (models, running) = started;

        assert!(
            !models.is_empty(),
            "the agent offered a model selector, so the picker has rows"
        );
        assert!(
            models.iter().any(|m| m.value.contains('/')),
            "opencode's ids are provider-qualified: {:?}",
            models.iter().map(|m| &m.value).collect::<Vec<_>>()
        );
        assert!(!running.is_empty(), "the session says which model it is running");
        assert!(
            models.iter().any(|m| &m.value == running),
            "the running model is one of the offered ones: {running} not in {:?}",
            models.iter().map(|m| &m.value).collect::<Vec<_>>()
        );
        // No effort levels are invented for a protocol that has no notion of one.
        assert!(models.iter().all(|m| m.supported_effort_levels.is_empty()));

        // A switch to another offered model is accepted. `session/set_model` does
        // not exist in ACP 2.0.0, so this proves the `session/set_config_option`
        // route rather than a verb the spec dropped.
        let other = models.iter().map(|m| m.value.clone()).find(|v| v != running);
        if let Some(other) = other {
            transport
                .set_model(&other, None)
                .expect("a switch to an offered model is accepted");
            let after = wait_for(&seen, 20, |e| {
                e.iter().any(|e| matches!(e, ChatEvent::SessionError { .. }))
            });
            assert!(
                !after.iter().any(|e| matches!(e, ChatEvent::SessionError { .. })),
                "the agent accepted the config option rather than refusing it: {after:?}"
            );
        }

        let _ = transport.close();
    }

    /// **The genericity proof**: one agent, driven entirely from its own adapter
    /// TOML, through streaming text, a tool call and a permission prompt.
    ///
    /// Nothing here names a program, an argument or a quirk. Every one of those
    /// is read out of the bundled `opencode.toml`, so if this passes then adding
    /// OpenCode really did cost a TOML file and no Rust - which is the claim
    /// [[adr_agent_breadth]] rests on and the reason the ACP transport exists
    /// rather than a second typed adapter.
    ///
    /// **The permission half needed the agent's own config, not Tori's.**
    /// `opencode acp` approves edits silently by default, which is why Phases 4
    /// and 5 both recorded the prompt as unproven against it and reached for a
    /// different agent. Measured here: with `permission.edit = "ask"` in the
    /// agent's own `opencode.json`, it asks - offering `once`, `always` and
    /// `reject`. That whether-to-ask is the agent's setting and not Tori's is
    /// exactly [[tori-agent-owns-permissions]], so the fix was to configure the
    /// agent rather than to add anything here.
    #[test]
    #[ignore = "drives the real `opencode acp` binary: costs tokens"]
    fn an_acp_agent_is_driven_entirely_from_its_own_adapter_toml() {
        use super::super::transport::new_sink;

        let adapter = crate::agents::find("opencode").expect("opencode ships bundled");
        let chat = adapter.chat.as_ref().expect("with an ACP chat transport");
        let args = crate::chat::commands::build_args(chat, "live-generic", false, None, None, None, None, &[]);

        // The agent's own configuration, so it asks before it writes. Tori
        // contributes nothing to this decision and could not.
        let root = std::env::temp_dir()
            .join(format!("tori-acp-live-{}", std::process::id()))
            .join("generic");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("opencode.json"),
            r#"{"$schema":"https://opencode.ai/config.json","permission":{"edit":"ask"}}"#,
        )
        .unwrap();
        acp_sessions::use_dir_for_tests(root.join("locators"));
        let cwd = root.to_string_lossy().into_owned();

        let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = seen.clone();
        let sink = new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev)));

        // Program, args and quirks all from the adapter.
        let mut transport = AcpTransport::new("live-generic", &adapter.id, chat.acp.clone());
        transport
            .start(
                StartSpec {
                    session_id: "live-generic".to_string(),
                    cwd: cwd.clone(),
                    program: chat.program.clone(),
                    args,
                    env: HashMap::new(),
                },
                sink,
            )
            .expect("the adapter's launch should start the agent");

        wait_for(&seen, 60, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });
        transport
            .send(&[ContentBlock::Text {
                text: "Create a file named generic.txt containing exactly the word hello. \
                       Use your write tool, then say done."
                    .to_string(),
            }])
            .expect("a prompt goes out");

        // Answer the question the agent asks, in the agent's own vocabulary.
        let asked = wait_for(&seen, 180, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::PermissionRequest { .. }))
        });
        let (request_id, suggestions) = asked
            .iter()
            .find_map(|e| match e {
                ChatEvent::PermissionRequest {
                    request_id,
                    suggestions,
                    ..
                } => Some((request_id.clone(), suggestions.clone())),
                _ => None,
            })
            .unwrap_or_else(|| panic!("the agent's own config says ask, so it must ask: {asked:?}"));

        // Whatever the agent offered is what is on the prompt: Tori composes no
        // option of its own, so this is a record of the agent's vocabulary
        // rather than an assertion about Tori's.
        let _ = suggestions;

        assert!(
            transport
                .respond_permission("", &request_id, PermissionDecision::Allow, PermissionScope::Once, None,)
                .expect("answering is in-protocol"),
            "the answer went to the transport rather than to the PreToolUse bridge"
        );

        let done = wait_for(&seen, 180, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. }))
        });
        let _ = transport.close();

        assert!(
            done.iter()
                .any(|e| matches!(e, ChatEvent::TextDelta { .. } | ChatEvent::ThinkingDelta { .. })),
            "streaming text: {done:?}"
        );
        assert!(
            done.iter().any(|e| matches!(e, ChatEvent::ToolCallStarted { .. })),
            "a tool call: {done:?}"
        );
        assert!(
            done.iter().any(|e| matches!(
                e,
                ChatEvent::TurnCompleted {
                    outcome: crate::chat::model::TurnOutcome::Completed,
                    ..
                }
            )),
            "and a turn that completed: {done:?}"
        );
        assert!(
            root.join("generic.txt").exists(),
            "the approved write actually happened, so the allow reached the agent"
        );
    }

    /// **Codex, end to end, from its own adapter TOML.**
    ///
    /// The second agent driven with no Rust of its own, and the one that
    /// justified the phase's scope decision: `codex app-server` exists and a typed adapter
    /// for it runs to ~9,000 lines elsewhere, while this route is `codex.toml` plus the mode
    /// switch below. What it proves is everything the tier claims for Codex - a
    /// live model catalogue, a real permission prompt answered in the agent's own
    /// vocabulary, and an exact before-and-after diff, which ACP was assumed not
    /// to have.
    ///
    /// **The mode switch is not incidental to the prompt, it is the whole
    /// reason there is one.** Measured on `codex-acp` 1.2.0: the wrapper ignores
    /// `approval_policy` and `sandbox_mode` from the user's own
    /// `~/.codex/config.toml` (verified separately - `config/read` reports both
    /// set and the agent writes anyway) and runs its own `agent` mode, which
    /// approves edits inside *and outside* the workspace silently. So without
    /// `session/set_config_option` on the `mode` selector, Codex's permission
    /// prompt is a capability Tori publishes and no user can reach.
    #[test]
    #[ignore = "drives the real `npx @agentclientprotocol/codex-acp`: costs tokens"]
    fn codex_is_driven_entirely_from_its_own_adapter_toml() {
        use super::super::transport::new_sink;

        let adapter = crate::agents::find("codex").expect("codex ships bundled");
        let chat = adapter.chat.as_ref().expect("with an ACP chat transport");
        let args = crate::chat::commands::build_args(chat, "live-codex", false, None, None, None, None, &[]);

        let root = std::env::temp_dir()
            .join(format!("tori-acp-live-{}", std::process::id()))
            .join("codex");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("hello.txt"), "one\ntwo\nthree\n").unwrap();
        // A repo, because the before-state is stored as a git blob. Not
        // incidental to the test: in a folder with no object store the diff
        // degrades to unavailable, which is the same answer the capture hook
        // gives for the same reason, and asserting the exact diff would then be
        // asserting something Tori cannot do anywhere.
        crate::platform::process::command("git")
            .current_dir(&root)
            .args(["init", "-q"])
            .output()
            .unwrap();
        acp_sessions::use_dir_for_tests(root.join("locators"));
        let cwd = root.to_string_lossy().into_owned();

        let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = seen.clone();
        let sink = new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev)));

        let mut transport = AcpTransport::new("live-codex", &adapter.id, chat.acp.clone());
        transport
            .start(
                StartSpec {
                    session_id: "live-codex".to_string(),
                    cwd: cwd.clone(),
                    program: chat.program.clone(),
                    args,
                    env: HashMap::new(),
                },
                sink,
            )
            .expect("the adapter's launch should start the agent");

        let opened = wait_for(&seen, 120, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });
        let (models, modes, mode_now) = opened
            .iter()
            .find_map(|e| match e {
                ChatEvent::SessionStarted {
                    models,
                    modes,
                    permission_mode,
                    ..
                } => Some((models.clone(), modes.clone(), permission_mode.clone())),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no session started: {opened:?}"));

        // The catalogues are the agent's, not the TOML's: `codex.toml` declares
        // neither, so anything here came off the wire.
        assert!(!models.is_empty(), "the model catalogue arrived over the protocol");
        assert!(
            modes.iter().any(|m| m.id == "read-only"),
            "codex publishes its modes as a config option: {modes:?}"
        );
        assert!(!mode_now.as_str().is_empty(), "and says which one it is in");
        // Reasoning effort too, which this transport claimed ACP had no notion
        // of until this agent published a `thought_level` selector. Narrowed to
        // what `Effort` can send, so `ultra` is measured on the wire and
        // deliberately absent here.
        let levels = &models[0].supported_effort_levels;
        assert!(
            models[0].supports_effort,
            "codex publishes reasoning levels: {models:?}"
        );
        assert!(levels.contains(&"xhigh".to_string()), "{levels:?}");
        assert!(
            !levels.contains(&"ultra".to_string()),
            "a level Tori cannot send: {levels:?}"
        );

        // Into the one mode that makes it ask. Applied with the next prompt, so
        // this is staged rather than sent, which is the trait's contract.
        transport
            .set_mode(PermissionMode::new("read-only"))
            .expect("staging a mode the agent offered");
        transport
            .send(&[ContentBlock::Text {
                text: "Edit hello.txt so its third line reads THREE in capital letters. \
                       Use your file editing tool, not a shell command. Then say done."
                    .to_string(),
            }])
            .expect("a prompt goes out");

        let asked = wait_for(&seen, 240, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::PermissionRequest { .. }))
        });
        let request_id = asked
            .iter()
            .find_map(|e| match e {
                ChatEvent::PermissionRequest { request_id, .. } => Some(request_id.clone()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("read-only means it must ask before writing: {asked:?}"));

        assert!(
            transport
                .respond_permission("", &request_id, PermissionDecision::Allow, PermissionScope::Once, None,)
                .expect("answering is in-protocol"),
            "the answer went to the transport rather than to the PreToolUse bridge"
        );

        let done = wait_for(&seen, 240, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. }))
        });
        let _ = transport.close();

        assert!(
            done.iter().any(|e| matches!(e, ChatEvent::ToolCallStarted { .. })),
            "a tool call: {done:?}"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("hello.txt")).unwrap(),
            "one\ntwo\nTHREE\n",
            "the approved write landed, so the allow reached the agent"
        );

        // **The claim the ACP tier used to deny.** `codex-acp` sends the file's
        // prior text with the tool call, so the before-state is exact - the same
        // thing Claude's capture hook produces, arriving over the protocol
        // instead of from a hook.
        let edit = done
            .iter()
            .find_map(|e| match e {
                ChatEvent::FileEdit { path, before_blob, .. } => Some((path.clone(), before_blob.clone())),
                _ => None,
            })
            .unwrap_or_else(|| panic!("the diff block became a FileEdit: {done:?}"));
        assert!(edit.0.ends_with("hello.txt"), "naming the file it wrote: {}", edit.0);
        assert!(edit.1.is_some(), "with the prior content addressable as a blob");
    }

    /// Whether Codex can offer the `sessions` rung, which only running it says.
    ///
    /// Measured 2026-09-06 on `codex-acp` 1.2.0: it cannot. The wrapper receives
    /// `account/rateLimits/updated` and answers it with `return null`, so the
    /// snapshot reaches its own `/status` prose and never the client.
    #[test]
    #[ignore = "drives the real `npx @agentclientprotocol/codex-acp`: costs tokens"]
    fn codex_forwards_no_rate_limits_over_acp() {
        use super::super::transport::new_sink;

        let adapter = crate::agents::find("codex").expect("codex ships bundled");
        let chat = adapter.chat.as_ref().expect("with an ACP chat transport");
        let args = crate::chat::commands::build_args(chat, "live-quota", false, None, None, None, None, &[]);

        let root = std::env::temp_dir()
            .join(format!("tori-acp-quota-{}", std::process::id()))
            .join("codex");
        std::fs::create_dir_all(&root).unwrap();
        acp_sessions::use_dir_for_tests(root.join("locators"));

        let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = seen.clone();
        let sink = new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev)));

        let mut transport = AcpTransport::new("live-quota", &adapter.id, chat.acp.clone());
        transport
            .start(
                StartSpec {
                    session_id: "live-quota".to_string(),
                    cwd: root.to_string_lossy().into_owned(),
                    program: chat.program.clone(),
                    args,
                    env: HashMap::new(),
                },
                sink,
            )
            .expect("the adapter's launch should start the agent");

        wait_for(&seen, 120, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });
        transport
            .set_mode(PermissionMode::new("read-only"))
            .expect("staging a mode the agent offered");
        transport
            .send(&[ContentBlock::Text {
                text: "Reply with the single word ok. Use no tools.".to_string(),
            }])
            .expect("a prompt goes out");

        let done = wait_for(&seen, 240, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. }))
        });
        let _ = transport.close();

        // Without this the negative below would pass on an agent that never
        // answered at all, which measures nothing.
        assert!(
            done.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. })),
            "a real turn ran: {done:?}"
        );
        let quota: Vec<&ChatEvent> = done
            .iter()
            .filter(|e| matches!(e, ChatEvent::RateLimit { .. }))
            .collect();
        assert!(
            quota.is_empty(),
            "codex-acp 1.2.0 forwarded a rate limit after all, so the `sessions` rung is \
             available to codex.toml and this finding needs rewriting: {quota:?}"
        );
    }

    /// The symlink case, without a live agent.
    ///
    /// This is the same fact `[[gotchas#ensure_inside returns the caller's
    /// unresolved path]]` records from the install side and Phase 0 measured on
    /// `CLAUDE_CONFIG_DIR`: on macOS one directory has two spellings, and a
    /// agent that compares paths as strings sees two directories.
    #[test]
    fn two_spellings_of_one_directory_resolve_to_one_path() {
        let base = std::env::temp_dir().join(format!("tori-samedir-{}", std::process::id()));
        let real = base.join("real");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&real).unwrap();
        let real_s = real.to_string_lossy().into_owned();

        let link = base.join("link");
        crate::platform::fs::link_entry(&real, &link).unwrap();
        let link_s = link.to_string_lossy().into_owned();
        assert_eq!(
            canonical(&link_s),
            canonical(&real_s),
            "a symlink and its target are one directory"
        );
        assert_ne!(link_s, real_s, "under two spellings, which is the whole problem");

        // A directory that does not resolve answers `None` rather than echoing
        // the path back. That is what keeps a deleted cwd from comparing equal to
        // another deleted cwd and re-filing one session under another's folder.
        let gone = base.join("gone").to_string_lossy().into_owned();
        assert_eq!(canonical(&gone), None);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// **Codex history, over the one method Codex actually answers.**
    ///
    /// The plan this phase belongs to expected Codex history to arrive over
    /// `thread/list`, on a native `codex app-server` transport. That transport
    /// was dropped with the user after measurement, so Codex reaches Tori as an
    /// ACP client and `session/list` is the whole of the route. What was left
    /// unmeasured is whether the wrapper answers it with anything: the registry's
    /// probe records `sessionList: true`, and a published capability is the
    /// registry's word, not Tori's, and not a promise of rows either way
    /// (`opencode acp` 1.18.3 advertises the same and returns nothing).
    ///
    /// So this drives two connections. The first opens a session and says one
    /// word to make it real; the second is a *different* Tori session in the
    /// same directory, and it must come away holding a locator for the first,
    /// which it can only have learned from the listing.
    #[test]
    #[ignore = "drives the real `npx @agentclientprotocol/codex-acp` twice: costs tokens"]
    fn codex_lists_the_sessions_it_already_had_over_session_list() {
        use super::super::transport::new_sink;

        let adapter = crate::agents::find("codex").expect("codex ships bundled");
        let chat = adapter.chat.as_ref().expect("with an ACP chat transport");

        let root = std::env::temp_dir()
            .join(format!("tori-acp-live-{}", std::process::id()))
            .join("codex-listing");
        std::fs::create_dir_all(&root).unwrap();
        acp_sessions::use_dir_for_tests(root.join("locators"));
        // Deliberately the spelling macOS hands out (`/var/...`), not the
        // resolved one. Codex records the resolved form and matches the filter as
        // a string, so this listing came back empty until `refresh_listing`
        // started canonicalizing it. Keeping the raw spelling here is what makes
        // this a regression test rather than a demonstration.
        let cwd = root.to_string_lossy().into_owned();

        let open = |id: &str| {
            let args = crate::chat::commands::build_args(chat, id, false, None, None, None, None, &[]);
            let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
            let collected = seen.clone();
            let sink = new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev)));
            let mut transport = AcpTransport::new(id, &adapter.id, chat.acp.clone());
            transport
                .start(
                    StartSpec {
                        session_id: id.to_string(),
                        cwd: cwd.clone(),
                        program: chat.program.clone(),
                        args,
                        env: HashMap::new(),
                    },
                    sink,
                )
                .expect("the adapter's launch should start the agent");
            (transport, seen)
        };

        let (mut first, seen) = open("live-codex-list-a");
        wait_for(&seen, 120, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });
        first
            .send(&[ContentBlock::Text {
                text: "Reply with exactly the word: marker".to_string(),
            }])
            .expect("the first turn should submit");
        wait_for(&seen, 180, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. }))
        });
        let _ = first.close();

        let earlier = acp_sessions::read("live-codex-list-a").expect("the first session must leave a locator");
        assert_eq!(earlier.agent, "codex", "a locator names the agent that wrote it");

        // **The store is wiped before the second connection, and that is the
        // whole design of this test.** `session/new` records a locator of its
        // own, so leaving it in place would let the assertion below pass on the
        // first session's leftovers whether or not the agent listed anything.
        // With the store empty, the earlier session can only come back over the
        // wire.
        std::fs::remove_dir_all(root.join("locators")).expect("the store should clear");
        assert!(acp_sessions::all().is_empty(), "the store starts empty");

        let (mut second, later) = open("live-codex-list-b");
        let events = wait_for(&later, 180, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
                && acp_sessions::all()
                    .iter()
                    .any(|s| s.acp_session_id == earlier.acp_session_id)
        });
        let _ = second.close();

        assert!(
            !events.iter().any(|e| matches!(
                e,
                ChatEvent::SessionError { message, .. } if message.contains("would not list")
            )),
            "codex-acp must answer session/list rather than refusing it: {events:?}"
        );
        let recorded = acp_sessions::all();
        assert!(
            recorded.iter().any(|s| s.acp_session_id == earlier.acp_session_id),
            "the earlier session must arrive over the listing: {recorded:?}"
        );
        assert!(
            recorded.iter().all(|s| s.agent == "codex"),
            "every row a codex listing produced belongs to codex: {recorded:?}"
        );
        assert_eq!(
            recorded
                .iter()
                .filter(|s| s.acp_session_id == earlier.acp_session_id)
                .count(),
            1,
            "the listing must not add a second row for a session Tori already had"
        );
        // And it is filed under the folder the user opened, not the one the agent
        // resolved it to. Without this the row imports and the sidebar hides it,
        // which is the failure that looks exactly like the listing not working.
        assert_eq!(
            recorded
                .iter()
                .find(|s| s.acp_session_id == earlier.acp_session_id)
                .map(|s| s.cwd.as_str()),
            Some(cwd.as_str()),
            "an imported row keeps Tori's spelling of the directory"
        );

        // Tori's own name for it is gone with the store, so a row it learns from
        // a listing is filed under an id derived from the agent's. That is the
        // shape a session started outside Tori arrives in.
        assert_eq!(
            recorded
                .iter()
                .find(|s| s.acp_session_id == earlier.acp_session_id)
                .map(|s| s.id.clone()),
            Some(acp_sessions::tori_id_for(&earlier.acp_session_id)),
            "a row with no prior locator is filed under an id derived from the agent's"
        );
    }

    /// The capabilities Tori publishes for an ACP session come off the wire.
    ///
    /// This is what stops one generic transport publishing one answer for every
    /// agent behind it. `opencode acp` 1.18.3 advertises `loadSession` and
    /// `sessionCapabilities.list`; an agent that advertises neither must publish
    /// neither, and nothing in the adapter TOML says either way.
    #[test]
    #[ignore = "drives the real `opencode acp` binary"]
    fn a_live_handshake_is_where_the_published_capabilities_come_from() {
        let (mut transport, seen) = live_session("live-caps", "opencode", &["acp"]);
        let events = wait_for(&seen, 60, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionReady { .. }))
        });
        let _ = transport.close();

        let caps = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::SessionReady { capabilities, .. } => Some(*capabilities),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no session ready: {events:?}"))
            .expect("an ACP session carries what its agent advertised");

        assert!(caps.load_session, "opencode 1.18.3 advertises loadSession");
        assert!(caps.list_sessions, "and sessionCapabilities.list");
    }

    /// **The measurement the transport rests on**: a real agent completes
    /// Tori's handshake and opens a session, so the client is spec-correct
    /// enough for an implementation that is not Tori's own.
    #[test]
    #[ignore = "drives the real `opencode acp` binary"]
    fn a_live_agent_answers_the_handshake_and_opens_a_session() {
        let (mut transport, seen) = live_session("live-handshake", "opencode", &["acp"]);
        let events = wait_for(&seen, 60, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });
        let _ = transport.close();

        assert!(
            events.iter().any(|e| matches!(e, ChatEvent::SessionReady { .. })),
            "the agent answered initialize, so the session must read ready: {events:?}"
        );
        assert!(
            events.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. })),
            "session/new must open a session: {events:?}"
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, ChatEvent::SessionError { fatal: true, .. })),
            "a clean start must not report a fatal error: {events:?}"
        );
    }

    /// A turn streams back through the event model with no new variant needed,
    /// which is the whole claim of `super::super::acp`.
    #[test]
    #[ignore = "drives the real `opencode acp` binary: costs tokens"]
    fn a_live_turn_streams_text_and_completes() {
        let (mut transport, seen) = live_session("live-turn", "opencode", &["acp"]);
        wait_for(&seen, 60, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });

        transport
            .send(&[ContentBlock::Text {
                text: "Reply with exactly the word: pong".to_string(),
            }])
            .expect("the turn should submit");

        let events = wait_for(&seen, 120, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. }))
        });
        let _ = transport.close();

        assert!(
            events.iter().any(|e| matches!(e, ChatEvent::TextDelta { .. })),
            "the agent's reply must arrive as text deltas: {events:?}"
        );
        assert!(
            events.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. })),
            "the turn must complete on a stop reason: {events:?}"
        );
    }

    /// A live tool-using turn renders as a tool card, not as prose about one.
    ///
    /// Measured against `opencode acp` 1.18.3: a turn that writes a file emits
    /// `ToolCallStarted` / `ToolCallProgress` / `ToolCallCompleted` in that
    /// order, plus `Usage` and a `TurnCompleted` carrying `end_turn`. This is
    /// the live half of the claim that ACP needs no new `ChatEvent` variant.
    ///
    /// Note what this test does *not* prove: no `PermissionRequest` arrives,
    /// because OpenCode's own configuration approved the write without asking.
    /// That is the agent owning permissions working as intended, and it means
    /// the in-protocol prompt path stays covered by the unit tests above rather
    /// than by this one.
    #[test]
    #[ignore = "drives the real `opencode acp` binary: costs tokens"]
    fn a_live_tool_call_renders_as_a_tool_card() {
        let (mut transport, seen) = live_session("live-tool", "opencode", &["acp"]);
        wait_for(&seen, 60, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });
        transport
            .send(&[ContentBlock::Text {
                text: "Create a file called probe.txt containing the word hello. Use your tools.".to_string(),
            }])
            .expect("the turn should submit");
        let events = wait_for(&seen, 180, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. }))
        });
        let _ = transport.close();

        assert!(
            events.iter().any(|e| matches!(e, ChatEvent::ToolCallStarted { .. })),
            "a tool-using turn must open a tool card: {events:?}"
        );
        assert!(
            events.iter().any(|e| matches!(e, ChatEvent::ToolCallCompleted { .. })),
            "the tool card must be closed out rather than left running: {events:?}"
        );
        assert!(
            events.iter().any(|e| matches!(
                e,
                ChatEvent::TurnCompleted { stop_reason, .. }
                    if stop_reason.as_deref() == Some("end_turn")
            )),
            "the turn must end on the agent's own stop reason: {events:?}"
        );
    }

    /// **The whole of the listing and reopening task, measured live.**
    ///
    /// One conversation is had, the tab is closed, and a second transport is
    /// started under the *same Tori session id* - which is exactly what a chat
    /// reopened after an app restart does. The agent replays the conversation as
    /// ordinary `session/update` notifications, so the prior turn arrives back
    /// through the same event model a live turn uses, with no transcript file,
    /// no new `ChatEvent` variant, and no `ParserKind` or `Discovery` variant.
    ///
    /// The bridge between the two runs is the locator: ACP mints its session id
    /// inside `session/new` and puts it in no command line, so without a record
    /// on Tori's side the second run has no id to load and nothing to replay.
    ///
    /// Measured against `opencode acp` 1.18.3, which advertises both
    /// `loadSession` and `sessionCapabilities.list`.
    #[test]
    #[ignore = "drives the real `opencode acp` binary: costs tokens"]
    fn a_reopened_chat_replays_the_conversation_the_agent_still_holds() {
        let id = "live-reopen";
        let ((mut first, seen), cwd) = live_session_as(id, "opencode", &["acp"]);
        wait_for(&seen, 60, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });
        first
            .send(&[ContentBlock::Text {
                text: "Reply with exactly the word: marker".to_string(),
            }])
            .expect("the first turn should submit");
        wait_for(&seen, 120, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. }))
        });
        let _ = first.close();

        // What survives the close is one small file naming the agent's own id.
        let locator = acp_sessions::read(id).expect("the first session must leave a locator");
        assert_eq!(locator.agent, "opencode");
        assert_eq!(locator.cwd, cwd);
        assert!(!locator.acp_session_id.is_empty());

        let ((mut second, replayed), _) = live_session_as(id, "opencode", &["acp"]);
        let events = wait_for(&replayed, 90, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
                && e.iter().any(|e| matches!(e, ChatEvent::TextDelta { .. }))
        });
        let _ = second.close();

        assert!(
            !events
                .iter()
                .any(|e| matches!(e, ChatEvent::SessionError { fatal: true, .. })),
            "reopening must not be a fatal failure: {events:?}"
        );
        assert!(
            events.iter().any(|e| matches!(e, ChatEvent::TextDelta { .. })),
            "the earlier conversation must replay into the reopened chat: {events:?}"
        );
        // The listing ran on the same connection, so the agent's own row for
        // this session is now recorded beside it - which is what puts a session
        // started outside Tori into the history list.
        let recorded = acp_sessions::all();
        assert!(
            recorded.iter().any(|s| s.acp_session_id == locator.acp_session_id),
            "the reopened session must still be recorded exactly once: {recorded:?}"
        );
        assert_eq!(
            recorded
                .iter()
                .filter(|s| s.acp_session_id == locator.acp_session_id)
                .count(),
            1,
            "a listing must not add a second row for a session Tori already had"
        );
    }

    /// **The permission round trip, end to end over the real protocol.**
    ///
    /// The one property no mock establishes: that a real agent blocks on
    /// `session/request_permission`, that Tori's answer reaches it in the
    /// agent's *own* vocabulary, and that the agent then carries on. If the
    /// answer were sent as a fixed token, or against the wrong request, the
    /// agent would sit blocked until its own deadline and the turn would never
    /// end.
    ///
    /// Measured against `@agentclientprotocol/claude-agent-acp` 0.67.0, which
    /// asks before writing a file and offers three options of its own
    /// (`reject`, `allow`, `allow_always`). OpenCode does not ask under its
    /// default configuration, which is why this test names a different agent
    /// from the others: whether to ask is the agent's decision, not Tori's.
    #[test]
    #[ignore = "drives the real claude-agent-acp over npx: costs tokens and needs network"]
    fn a_live_permission_prompt_is_answered_in_the_agents_own_vocabulary() {
        use super::super::model::PermissionSuggestion;

        let (mut transport, seen) = live_session(
            "live-permission",
            "npx",
            &["-y", "@agentclientprotocol/claude-agent-acp"],
        );
        wait_for(&seen, 120, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });
        transport
            .send(&[ContentBlock::Text {
                text: "Create a file called probe.txt containing the word hello.".to_string(),
            }])
            .expect("the turn should submit");

        let asked = wait_for(&seen, 180, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::PermissionRequest { .. }))
        });
        let Some(ChatEvent::PermissionRequest {
            request_id,
            tool_use_id,
            suggestions,
            ..
        }) = asked
            .iter()
            .find(|e| matches!(e, ChatEvent::PermissionRequest { .. }))
            .cloned()
        else {
            panic!("the agent must ask before writing: {asked:?}");
        };

        // The agent's own option ids survive the crossing rather than being
        // collapsed into a fixed Allow/Deny pair.
        let offered: Vec<_> = suggestions
            .iter()
            .filter_map(|s| match s {
                PermissionSuggestion::AddRules { destination, .. } => Some(destination.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            offered.contains(&"allow") && offered.contains(&"reject"),
            "the agent's own option ids must reach the prompt, got {offered:?}"
        );

        // Answering must be claimed by *this* transport. `Ok(false)` would mean
        // Tori went looking for the `PreToolUse` bridge instead, leaving the
        // agent blocked on a question nobody answered.
        let claimed = transport
            .respond_permission(
                &tool_use_id,
                &request_id,
                PermissionDecision::Allow,
                PermissionScope::Once,
                None,
            )
            .expect("answering must not error");
        assert!(claimed, "an in-protocol question must be answered in protocol");

        let events = wait_for(&seen, 180, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. }))
        });
        let _ = transport.close();

        assert!(
            events.iter().any(|e| matches!(e, ChatEvent::ToolCallCompleted { .. })),
            "an allowed tool call must run to completion: {events:?}"
        );
        assert!(
            events.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. })),
            "the turn must end rather than hang on an unanswered question: {events:?}"
        );

        // A question is answered exactly once. The second attempt is the race a
        // user cannot see: it must be disclaimed, never re-sent.
        let again = transport
            .respond_permission(
                &tool_use_id,
                &request_id,
                PermissionDecision::Allow,
                PermissionScope::Once,
                None,
            )
            .expect("a second answer must not error");
        assert!(!again, "a settled question must not be answerable twice");
    }

    /// Every event's wire tag with a count, read off the same `type` field the
    /// UI narrows on rather than off a hand-written match that could disagree
    /// with it.
    #[cfg(test)]
    fn kind_counts(events: &[ChatEvent]) -> Vec<(String, usize)> {
        let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
        for event in events {
            let tag = serde_json::to_value(event)
                .ok()
                .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
                .unwrap_or_else(|| "?".to_string());
            *counts.entry(tag).or_default() += 1;
        }
        counts.into_iter().collect()
    }

    /// **What `codex-acp` actually hands back**, which is the whole basis for the
    /// log Tori keeps beside an ACP session: that log is a cache of this replay,
    /// so a frame kind the replay does not carry is a turn a restored tab can
    /// never show, no matter how the log is written.
    ///
    /// Measured 2026-09-08 against `npx -y @agentclientprotocol/codex-acp@1.2.0`
    /// driving `codex-cli 0.147.0`, on one prompt answered with one word:
    ///
    ///   * **`loadSession` is advertised** (`load_session = true`), so the reload
    ///     path is open at all.
    ///   * **a live `send` sends no `user_message_chunk` back.** The whole turn
    ///     was `textDelta` x1, `usage` x1, `turnCompleted` x1 - the agent echoes
    ///     nothing for the prompt Tori just handed it, which is why the transport
    ///     emits the `UserMessage` itself rather than waiting for one. See
    ///     [`AcpTransport::send`].
    ///   * **the replay does carry the user's turn**: `userMessage` x1,
    ///     `textDelta` x1, `usage` x1, plus the identity frames `sessionStarted`,
    ///     `configOptions` and `slashCommands`, one each. So a restored
    ///     conversation is a conversation and not a wall of assistant prose.
    ///
    /// The counts are not asserted - a model is free to answer in one delta or
    /// forty - but the *kinds* are, because those are what the log's shape rests
    /// on. Note that the live half stops being observable here once the
    /// transport emits its own `UserMessage`: the figure above is the dated
    /// measurement of the agent, not a live assertion about it.
    #[test]
    #[ignore = "drives the real codex-acp over npx: costs tokens and needs network"]
    fn what_codex_replays_is_what_the_log_can_hold() {
        let ((mut transport, seen), _) = live_session_in(
            "live-codex-log",
            "codex",
            "npx",
            &["-y", "@agentclientprotocol/codex-acp@1.2.0"],
            "codex",
            &[],
        );
        let opened = wait_for(&seen, 180, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });
        let caps = opened
            .iter()
            .find_map(|e| match e {
                ChatEvent::SessionReady { capabilities, .. } => Some(*capabilities),
                _ => None,
            })
            .flatten()
            .unwrap_or_else(|| panic!("no session ready: {opened:?}"));

        seen.lock().unwrap().clear();
        transport
            .send(&[ContentBlock::Text {
                text: "Reply with exactly the word: marker".to_string(),
            }])
            .expect("the turn should submit");
        let live = wait_for(&seen, 240, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. }))
        });

        seen.lock().unwrap().clear();
        assert!(
            transport.replay().expect("the reload should submit"),
            "codex advertises loadSession"
        );
        let replayed = wait_for(&seen, 180, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });
        let _ = transport.close();

        let (live_kinds, replay_kinds) = (kind_counts(&live), kind_counts(&replayed));
        eprintln!("codex-acp 1.2.0 loadSession={}", caps.load_session);
        eprintln!("codex-acp 1.2.0 live turn: {live_kinds:?}");
        eprintln!("codex-acp 1.2.0 replay:    {replay_kinds:?}");

        assert!(caps.load_session, "codex-acp 1.2.0 advertises loadSession");
        assert!(
            replay_kinds.iter().any(|(kind, _)| kind == "userMessage"),
            "the replay must bring the user's own turns back, or a restored tab is half a conversation: {replay_kinds:?}"
        );
        assert!(
            replay_kinds.iter().any(|(kind, _)| kind == "textDelta"),
            "and the agent's answers with them: {replay_kinds:?}"
        );
    }

    /// The agent's `kind` is what decides which direction an option answers in,
    /// not its label or its position. An agent is free to call its allow option
    /// anything, so reading the kind is the only stable way to sort them.
    #[test]
    fn a_permission_option_is_sorted_by_the_kind_the_agent_gave_it() {
        let options = vec![
            PermissionOption::new(
                PermissionOptionId::new("yes"),
                "Absolutely".to_string(),
                PermissionOptionKind::AllowAlways,
            ),
            PermissionOption::new(
                PermissionOptionId::new("no"),
                "Certainly not".to_string(),
                PermissionOptionKind::RejectAlways,
            ),
        ];
        let (allow, deny) = split_options(&options);
        assert_eq!(allow, vec!["yes".to_string()]);
        assert_eq!(deny, vec!["no".to_string()]);
    }
}
