//! Driving one ACP agent as a long-lived child process.
//!
//! The counterpart to [`super::claude_transport`], and deliberately the same
//! shape where the shapes can be the same: a child spawned through the shared
//! [`build_command`], a permission question parked in a map until somebody
//! answers it, and a teardown that denies whatever is still waiting rather than
//! leaving the agent blocked. What differs is everything below that, because ACP
//! is a JSON-RPC peer conversation rather than a line protocol Sway parses
//! itself.
//!
//! Three shapes here are load-bearing:
//!
//!   * **One dedicated OS thread per session, running `block_on`.** The SDK is
//!     built on the smol stack, not on tokio, and Tauri's runtime is neither.
//!     Rather than introduce a second global runtime, each session owns one
//!     thread that blocks on its own connection future for the life of the
//!     session. Nothing else in Sway has to know a runtime exists.
//!   * **The child is spawned by Sway, not by the SDK.** `AcpAgent::from_str`
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, InitializeRequest, NewSessionRequest, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionId, SessionModeId, SessionNotification,
    SetSessionModeRequest,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo, Responder};
use futures::channel::mpsc;
use futures::StreamExt;

use super::acp::{self, AcpOverrides};
use super::model::{
    ChatEvent, ContentBlock, Effort, PermissionDecision, PermissionMode, PermissionScope,
};
use super::transport::{build_command, emit, AgentTransport, Sink, StartSpec};

/// How long Sway waits for `initialize` before giving up on an agent.
///
/// The client owns this deadline because the protocol gives the agent no
/// obligation to answer promptly and some do not answer at all. Without it a
/// misbehaving agent leaves a chat tab reading "connecting" forever, with no
/// error and nothing to retry.
const HANDSHAKE_TIMEOUT_SECS: u64 = 30;

/// How long an unanswered permission question waits before Sway denies it.
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
    SetMode(PermissionMode),
    Close,
}

/// Per-session state the connection thread and the command methods share.
struct Shared {
    session_id: String,
    /// Set once the session has ended, so a late failure on the connection
    /// thread cannot resurrect a session the user already closed.
    finished: AtomicBool,
    /// Permission questions the agent is blocked on, keyed by the id Sway
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
    /// be stamped with a turn id no turn ever had. Sway's transcript keys on
    /// `turn_id`, so that split one turn into two.
    current_turn: Mutex<String>,
    /// Monotonic counter behind minted request ids and turn numbering.
    seq: AtomicU64,
}

/// One parked permission question: the responder to answer, and the option ids
/// the agent offered, so an answer can be turned back into the agent's own
/// vocabulary.
struct Parked {
    responder: Responder<RequestPermissionResponse>,
    /// `optionId`s the agent supplied, split by what they mean. Sway's UI
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
    fn answer(
        &self,
        request_id: &str,
        decision: PermissionDecision,
        reason: Option<&str>,
    ) -> Result<bool, String> {
        let Some(parked) = self.claim(request_id) else {
            return Ok(false);
        };
        // The reason is deliberately unused: ACP's outcome carries a chosen
        // option id and nothing else, so there is no field to put Sway's own
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
        self.current_turn
            .lock()
            .map(|t| t.clone())
            .unwrap_or_default()
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
                .respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ));
        }
    }
}

/// Turn Sway's Allow/Deny into one of the agent's own option ids.
///
/// The agent owns the permission vocabulary, so this picks from what it offered
/// rather than sending a fixed token. An agent that offered nothing usable in
/// the requested direction gets `cancelled`, which is honest: Sway cannot
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

/// Sort an agent's offered options into the two directions Sway's UI can
/// answer in, keyed on the `kind` the agent itself gave each one.
fn split_options(
    options: &[agent_client_protocol::schema::v1::PermissionOption],
) -> (Vec<String>, Vec<String>) {
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
    /// The command channel into the connection thread. `None` before `start`,
    /// which is what makes a command sent too early an error rather than a panic.
    commands: Option<mpsc::UnboundedSender<Command>>,
    /// The child's pid, kept for the ownership registry's orphan record. The
    /// SDK's own connection path never hands this back, which is one of the two
    /// reasons Sway spawns the child itself.
    pid: Option<u32>,
    /// Per-agent departures from a spec-correct client, from the adapter TOML.
    overrides: AcpOverrides,
    /// Mode switches take effect from the next turn, matching every other
    /// transport: a switch applied mid-turn would show a mode the running turn
    /// is not in.
    pending_mode: Option<PermissionMode>,
}

impl AcpTransport {
    pub fn new(session_id: impl Into<String>, overrides: AcpOverrides) -> Self {
        Self {
            shared: Arc::new(Shared {
                session_id: session_id.into(),
                finished: AtomicBool::new(false),
                pending: Mutex::new(HashMap::new()),
                settled: std::sync::Condvar::new(),
                current_turn: Mutex::new(String::new()),
                seq: AtomicU64::new(0),
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
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            // Agents are commonly launched behind a wrapper (`npx …`, `uvx …`).
            // Killing only the immediate child orphans the real agent, which
            // re-parents to pid 1 and does not reliably exit on stdin EOF, so
            // the whole group has to be killable at once.
            std_cmd.process_group(0);
        }

        // The pipes are configured **after** the conversion, not before:
        // `async_process::Command::from` does not carry a std command's stdio
        // settings across, so setting them on `std_cmd` leaves the child with
        // inherited stdio and no pipes to speak the protocol over.
        let mut cmd = async_process::Command::from(std_cmd);
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not start the agent: {e}"))?;
        self.pid = Some(child.id());

        let stdin = child.stdin.take().ok_or("the agent gave no stdin")?;
        let stdout = child.stdout.take().ok_or("the agent gave no stdout")?;

        let (tx, rx) = mpsc::unbounded();
        self.commands = Some(tx);

        let shared = self.shared.clone();
        let overrides = self.overrides.clone();
        let cwd = spec.cwd.clone();
        thread::Builder::new()
            .name(format!("acp-{}", self.shared.session_id))
            .spawn(move || {
                let outcome = futures::executor::block_on(run_session(
                    ByteStreams::new(stdin, stdout),
                    rx,
                    shared.clone(),
                    sink.clone(),
                    cwd,
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
                let _ = child.kill();
            })
            .map_err(|e| format!("could not start the agent's connection thread: {e}"))?;

        Ok(())
    }

    fn send(&mut self, blocks: &[ContentBlock]) -> Result<(), String> {
        if let Some(mode) = self.pending_mode.take() {
            self.send_command(Command::SetMode(mode))?;
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
        // the agent's to offer, not Sway's to synthesize from a scope the
        // protocol cannot carry.
        self.shared.answer(request_id, decision, reason)
    }

    fn set_mode(&mut self, mode: PermissionMode) -> Result<(), String> {
        self.pending_mode = Some(mode);
        Ok(())
    }

    /// Model selection in ACP 2.0.0 rides `session/set_config_option` rather
    /// than a dedicated verb, and which options exist is per-agent and only
    /// known from the handshake.
    ///
    /// Reported as unsupported rather than silently accepted: a picker that
    /// appeared to switch models while the session kept running the old one is
    /// worse than one that says it cannot.
    fn set_model(&mut self, _model: &str, _effort: Option<Effort>) -> Result<(), String> {
        Err("this agent does not support switching models mid-session".to_string())
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
    overrides: AcpOverrides,
) -> Result<(), String> {
    let notification_shared = shared.clone();
    let notification_sink = sink.clone();
    let request_shared = shared.clone();
    let request_sink = sink.clone();

    Client
        .builder()
        .name("sway")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                let turn = notification_shared.turn();
                for event in acp::map_update(
                    &notification_shared.session_id,
                    &turn,
                    &notification.update,
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
            let result =
                drive_session(&conn, &mut commands, &shared, &sink, &cwd, &overrides).await;
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
/// Sway never decides a permission itself: the harness owns permissions and Sway
/// only carries the question to the user and the answer back. Auto-answering
/// anything here - even a deny - would be Sway deciding.
fn park_permission_request(
    shared: &Arc<Shared>,
    sink: &Sink,
    request: RequestPermissionRequest,
    responder: Responder<RequestPermissionResponse>,
) {
    let request_id = shared.next_id("acp-perm");
    let (allow_options, deny_options) = split_options(&request.options);
    let deadline = now_ms() + DECIDE_TIMEOUT_SECS * 1000;
    let event = acp::map_permission_request(
        &shared.session_id,
        &request_id,
        &request,
        Some(deadline),
    );

    if let Ok(mut pending) = shared.pending.lock() {
        pending.insert(
            request_id.clone(),
            Parked { responder, allow_options, deny_options },
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
                let Some(left) = expires_at.checked_duration_since(std::time::Instant::now())
                else {
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
            Some("Sway denied this because nobody answered in time."),
        );
    });
}

/// Handshake, open a session, then serve commands until close.
async fn drive_session(
    conn: &ConnectionTo<Agent>,
    commands: &mut mpsc::UnboundedReceiver<Command>,
    shared: &Arc<Shared>,
    sink: &Sink,
    cwd: &str,
    overrides: &AcpOverrides,
) -> Result<(), String> {
    let init = with_deadline(
        conn.send_request(initialize_request(overrides)).block_task(),
        HANDSHAKE_TIMEOUT_SECS,
        "the agent did not answer the handshake",
    )
    .await?;

    // The child answered, so the session is live even though no turn has run.
    // Emitted before `SessionStarted` for the same reason the Claude transport
    // does it: otherwise a freshly opened chat reads "connecting" until the
    // first message, about an agent that replied within a second.
    emit(
        sink,
        ChatEvent::SessionReady {
            session_id: shared.session_id.clone(),
            slash_commands: Vec::new(),
            models: Vec::new(),
            account: None,
        },
    );

    let session = conn
        .send_request(new_session_request(cwd, overrides))
        .block_task()
        .await
        .map_err(describe_session_failure)?;

    emit(
        sink,
        ChatEvent::SessionStarted {
            session_id: shared.session_id.clone(),
            cwd: cwd.to_string(),
            model: String::new(),
            permission_mode: PermissionMode::new(String::new()),
            tools: Vec::new(),
            slash_commands: Vec::new(),
            mcp_servers: Vec::new(),
            models: Vec::new(),
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
            account: None,
            extra: Default::default(),
        },
    );
    let _ = init;

    let session_id = session.session_id;
    while let Some(command) = commands.next().await {
        match command {
            Command::Prompt(blocks) => {
                run_turn(conn, shared, sink, &session_id, blocks);
            }
            Command::Cancel => {
                let _ = conn.send_notification(CancelNotification::new(session_id.clone()));
            }
            Command::SetMode(mode) => {
                let request = SetSessionModeRequest::new(
                    session_id.clone(),
                    SessionModeId::new(mode.as_str()),
                );
                if let Err(e) = conn.send_request(request).block_task().await {
                    emit(
                        sink,
                        ChatEvent::SessionError {
                            session_id: shared.session_id.clone(),
                            message: format!("this agent would not switch mode: {e}"),
                            fatal: false,
                        },
                    );
                }
            }
            Command::Close => break,
        }
    }
    Ok(())
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
fn initialize_request(overrides: &AcpOverrides) -> InitializeRequest {
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
/// absent key is a protocol error to agents that validate strictly. What the
/// override controls is whether the array is *populated*, because an adapter
/// that does not speak MCP can fail `session/new` outright when it is.
fn new_session_request(cwd: &str, overrides: &AcpOverrides) -> NewSessionRequest {
    let mut request = NewSessionRequest::new(std::path::PathBuf::from(cwd));
    request.mcp_servers = if overrides.send_mcp_servers {
        // Populating this needs the session's own MCP config, which arrives
        // with the adapter rather than with the transport. Until an adapter
        // opts in there is nothing to send, and the empty array is still sent.
        Vec::new()
    } else {
        Vec::new()
    };
    request
}

/// Name a `session/new` failure in terms the user can act on.
///
/// `auth_required` is the one error code on this path worth branching on: it
/// means the agent works but nobody is signed in, which is a different thing
/// from a spawn failure and has a different fix. Reporting it as a generic
/// failure sends the user looking for a broken install.
fn describe_session_failure(error: agent_client_protocol::Error) -> String {
    let text = error.to_string();
    if text.contains("auth_required") || text.contains("Authentication required") {
        format!("This agent needs you to sign in first. {text}")
    } else {
        format!("The agent would not open a session: {text}")
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

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        PermissionOption, PermissionOptionId, PermissionOptionKind,
    };

    fn shared() -> Arc<Shared> {
        Arc::new(Shared {
            session_id: "s1".to_string(),
            finished: AtomicBool::new(false),
            pending: Mutex::new(HashMap::new()),
            settled: std::sync::Condvar::new(),
            current_turn: Mutex::new(String::new()),
            seq: AtomicU64::new(0),
        })
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
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

    /// An agent that offered no option in the answered direction leaves Sway
    /// unable to express the answer at all. `cancelled` is the honest reply;
    /// inventing an option id would be rejected by the agent anyway.
    #[test]
    fn an_answer_the_agent_offered_no_option_for_is_cancelled() {
        let outcome = outcome_for(&[], &ids(&["stop"]), PermissionDecision::Allow);
        assert!(matches!(outcome, RequestPermissionOutcome::Cancelled));
    }

    /// A question Sway never parked is not ours to answer. The host reads
    /// `Ok(false)` as "try the other route", so this must not be an error.
    #[test]
    fn a_question_the_transport_never_parked_is_disclaimed() {
        let shared = shared();
        assert_eq!(
            shared.answer("never-seen", PermissionDecision::Allow, None),
            Ok(false)
        );
    }

    /// The defect this pins: turn ids and permission request ids once came from
    /// the same counter, so a single question asked mid-turn re-stamped every
    /// later `session/update` with a turn id no turn ever had. Sway's transcript
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
        let mut transport = AcpTransport::new("s1", AcpOverrides::default());
        assert!(transport.send(&[]).is_err());
        assert!(transport.interrupt().is_err());
        assert!(transport.child_pid().is_none());
    }

    /// ACP has no mid-turn delivery, and the trait says a harness without one
    /// must refuse rather than quietly queue. A queued turn looks exactly like
    /// a steer that landed to everything upstream.
    #[test]
    fn a_steer_is_refused_rather_than_degraded_into_a_queued_turn() {
        let mut transport = AcpTransport::new("s1", AcpOverrides::default());
        assert!(transport.steer(&[ContentBlock::Text { text: "hi".into() }]).is_err());
    }

    /// The first of the two per-agent overrides. An agent that refuses a
    /// populated `mcpServers` must get an empty one, and the key must still be
    /// present either way.
    #[test]
    fn mcp_servers_are_empty_unless_the_adapter_opts_in() {
        let request = new_session_request("/tmp", &AcpOverrides::default());
        assert!(request.mcp_servers.is_empty());
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
    // ones no mock can establish - that a real agent answers Sway's handshake,
    // opens a session, and streams a turn back through the event model.
    // -----------------------------------------------------------------------

    #[cfg(test)]
    fn live_session(program: &str, args: &[&str]) -> (AcpTransport, Arc<Mutex<Vec<ChatEvent>>>) {
        use super::super::transport::new_sink;

        let cwd = std::env::temp_dir().join(format!("sway-acp-live-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();
        let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = seen.clone();
        let sink = new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev)));

        let mut transport = AcpTransport::new("live-1", AcpOverrides::default());
        transport
            .start(
                StartSpec {
                    session_id: "live-1".to_string(),
                    cwd: cwd.to_string_lossy().into_owned(),
                    program: program.to_string(),
                    args: args.iter().map(|s| s.to_string()).collect(),
                    env: HashMap::new(),
                },
                sink,
            )
            .expect("the agent should start");
        (transport, seen)
    }

    #[cfg(test)]
    fn wait_for(
        seen: &Arc<Mutex<Vec<ChatEvent>>>,
        secs: u64,
        done: impl Fn(&[ChatEvent]) -> bool,
    ) -> Vec<ChatEvent> {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let events = seen.lock().unwrap().clone();
            if done(&events) || std::time::Instant::now() >= deadline {
                return events;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    /// **The measurement the transport rests on**: a real agent completes
    /// Sway's handshake and opens a session, so the client is spec-correct
    /// enough for an implementation that is not Sway's own.
    #[test]
    #[ignore = "drives the real `opencode acp` binary"]
    fn a_live_agent_answers_the_handshake_and_opens_a_session() {
        let (mut transport, seen) = live_session("opencode", &["acp"]);
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
        let (mut transport, seen) = live_session("opencode", &["acp"]);
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
    /// That is the harness owning permissions working as intended, and it means
    /// the in-protocol prompt path stays covered by the unit tests above rather
    /// than by this one.
    #[test]
    #[ignore = "drives the real `opencode acp` binary: costs tokens"]
    fn a_live_tool_call_renders_as_a_tool_card() {
        let (mut transport, seen) = live_session("opencode", &["acp"]);
        wait_for(&seen, 60, |e| {
            e.iter().any(|e| matches!(e, ChatEvent::SessionStarted { .. }))
        });
        transport
            .send(&[ContentBlock::Text {
                text: "Create a file called probe.txt containing the word hello. Use your tools."
                    .to_string(),
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

    /// **The permission round trip, end to end over the real protocol.**
    ///
    /// The one property no mock establishes: that a real agent blocks on
    /// `session/request_permission`, that Sway's answer reaches it in the
    /// agent's *own* vocabulary, and that the agent then carries on. If the
    /// answer were sent as a fixed token, or against the wrong request, the
    /// agent would sit blocked until its own deadline and the turn would never
    /// end.
    ///
    /// Measured against `@agentclientprotocol/claude-agent-acp` 0.67.0, which
    /// asks before writing a file and offers three options of its own
    /// (`reject`, `allow`, `allow_always`). OpenCode does not ask under its
    /// default configuration, which is why this test names a different agent
    /// from the others: whether to ask is the harness's decision, not Sway's.
    #[test]
    #[ignore = "drives the real claude-agent-acp over npx: costs tokens and needs network"]
    fn a_live_permission_prompt_is_answered_in_the_agents_own_vocabulary() {
        use super::super::model::PermissionSuggestion;

        let (mut transport, seen) =
            live_session("npx", &["-y", "@agentclientprotocol/claude-agent-acp"]);
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
        let Some(ChatEvent::PermissionRequest { request_id, tool_use_id, suggestions, .. }) = asked
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
        // Sway went looking for the `PreToolUse` bridge instead, leaving the
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
