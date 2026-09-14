//! Driving `claude` as a long-lived stream-json child.
//!
//! The mapping from wire frames to [`ChatEvent`]s lives in `chat/claude.rs`;
//! this file owns only the process: spawn it, hold its stdin open, read its
//! stdout a line at a time, and turn every way it can go wrong into an event
//! rather than a panic or a hang.
//!
//! **Holding stdin open is the whole design.** Early probes concluded the CLI
//! exits after one turn; it does not. Closing stdin is what ended those runs.
//! One child serves every turn of a session, which is why `Drop`-style
//! convenience (spawn per turn, let it exit) is not an option here: it would
//! also mean a fresh `--resume` per turn, and two concurrent resumes of one
//! session id silently corrupt its transcript.
//!
//! Three failure modes are treated as first-class rather than exceptional,
//! because a chat that has silently stopped working is worse than one that says
//! it broke:
//!
//!   * **The child dies.** The reader thread sees EOF, waits for the status and
//!     emits a fatal [`ChatEvent::SessionError`], which is what the host reaps on.
//!   * **stdout is unparseable.** One bad line is reported non-fatally and the
//!     stream continues; the alternative, tearing down a working session over a
//!     single malformed frame, loses more than it protects.
//!   * **stderr says something.** Kept as a bounded tail and attached to the
//!     death message, so "exited with status 1" comes with the reason.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::agents::ChatEffortExtra;

use super::claude::ClaudeMapper;
use super::model::{
    file_ref_locator, ChatConfigValue, ChatEvent, ChatQuestion, ContentBlock, PermissionDecision,
    PermissionMode, PermissionScope, PermissionSuggestion, QuestionAnswer,
};
use super::transport::{build_command, emit, AgentTransport, Sink, StartSpec};

/// How much stderr to keep. Enough to carry a usage error or a stack trace's
/// first frames; bounded so a chatty child cannot grow this without limit.
const STDERR_TAIL: usize = 4096;

/// How long a permission question waits for the user before Sway denies it.
///
/// **Sway owns this deadline because nobody else does.** Measured on claude
/// 2.1.231: a `can_use_tool` control request left unanswered was still
/// outstanding after seven minutes, with the turn simply parked and no timeout
/// of the CLI's own (`dev/protocol-probe.mjs`, scenario `permission-deadline`).
/// So an unanswered prompt is not a race between two timeouts here, the way the
/// `PreToolUse` bridge's is: it is a hang unless Sway ends it.
///
/// Kept equal to the approval bridge's [`super::approval::DECIDE_TIMEOUT_SECS`]
/// so both routes to a prompt expire alike; a user cannot tell which one asked.
const DECIDE_TIMEOUT_SECS: u64 = super::approval::DECIDE_TIMEOUT_SECS;

/// Per-session state the reader thread and the command methods share.
struct Shared {
    session_id: String,
    /// Set when Sway writes a user turn, cleared by the `TurnStarted` it causes.
    /// Nothing on the wire tells an agent-opened turn from a user-opened one:
    /// the two `system/init` frames are identical bar their `uuid`.
    turn_expected: AtomicBool,
    /// Set once the session has ended, so a late reader-thread error cannot
    /// resurrect a session the user already closed.
    finished: AtomicBool,
    stderr_tail: Mutex<String>,
    /// The child's stdin. Shared rather than owned by the transport because
    /// three writers need it and two of them are not on the command path: the
    /// auto-deny timer and the teardown that denies whatever is still pending.
    stdin: Mutex<Option<ChildStdin>>,
    /// Everything the child is blocked on, and which kind each one is.
    ///
    /// A request leaves this map exactly once, whoever gets there first: the
    /// user, the deadline, or a teardown. That is what makes "answered twice"
    /// impossible and, more importantly, makes "never answered" impossible too.
    ///
    /// The kind is carried because the two expire differently. A permission has
    /// a deadline that will resolve it whatever happens; a question has none, so
    /// an interrupt has to withdraw one or it outlives the turn that asked it.
    pending: Mutex<HashMap<String, Parked>>,
    /// Signalled whenever a question leaves `pending`, so an armed timer stops
    /// waiting the moment its question is settled instead of sleeping out its
    /// full deadline. Without it, a chat where the user answers promptly still
    /// accumulates one sleeping thread per prompt for 110s apiece.
    settled: Condvar,
    /// The rule the CLI itself proposed for each outstanding question, kept so a
    /// "for this session" answer can echo the agent's own grammar back rather
    /// than compose one. Keyed by `request_id` and dropped when answered, so it
    /// is bounded by the number of *outstanding* prompts, not by the session.
    granted_rules: Mutex<HashMap<String, Value>>,
    /// The form each outstanding question asked, kept so the answer can quote
    /// the question's own prose and echo the picked option's preview back.
    /// Keyed and dropped exactly like `granted_rules`, so it is bounded by the
    /// number of *outstanding* questions rather than by the session.
    /// The mode each outstanding `set_permission_mode` asked for, keyed by
    /// request id, so a refusal can name the mode it refused. Dropped on the
    /// response either way, so it holds at most one entry per unanswered switch.
    mode_requests: Mutex<HashMap<String, PermissionMode>>,
    parked_questions: Mutex<HashMap<String, Vec<ChatQuestion>>>,
}

/// What the child is blocked on. See [`Shared::pending`] for why it is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Parked {
    Permission,
    Question,
}

impl Shared {
    /// Write one JSON frame plus its newline.
    fn write_frame(&self, frame: &Value) -> Result<(), String> {
        let mut guard = self.stdin.lock().map_err(|_| "chat session stdin is poisoned".to_string())?;
        let stdin = guard.as_mut().ok_or("chat session is not running")?;
        writeln!(stdin, "{frame}").map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())
    }

    /// Claim a pending permission question, so exactly one answer can be sent.
    ///
    /// Settling it also drops its remembered grant. Doing that here rather than
    /// at the caller is what keeps the two maps in step: the deadline timer
    /// settles requests too, and it has no rule to write, so a removal left to
    /// the user-answer path would leak an entry for every prompt that timed out.
    fn claim(&self, request_id: &str) -> bool {
        let claimed = guarded(&self.pending).remove(request_id).is_some();
        if claimed {
            guarded(&self.granted_rules).remove(request_id);
            guarded(&self.parked_questions).remove(request_id);
            // Wake every armed timer so the one that owned this question can
            // retire. Notifying under no lock at all would be a lost wakeup.
            self.settled.notify_all();
        }
        claimed
    }

    /// Keep the CLI's own `allow` rule for this question, if it offered one.
    ///
    /// Only an `allow` rule is kept: a `deny` suggestion echoed back under a
    /// user's *allow* would invert the answer.
    fn remember_grant(&self, request_id: &str, suggestions: &[PermissionSuggestion]) {
        let rules = suggestions.iter().find_map(|s| match s {
            PermissionSuggestion::AddRules { rules, behavior, .. } if behavior == "allow" && !rules.is_empty() => {
                serde_json::to_value(rules).ok()
            }
            _ => None,
        });
        if let Some(rules) = rules {
            guarded(&self.granted_rules).insert(request_id.to_string(), rules);
        }
    }

    /// Build and send the answer to one question.
    ///
    /// Lives here rather than on the transport because the deadline timer and a
    /// teardown answer the same questions from threads that hold no `&mut self`.
    fn answer_decision(
        &self,
        request_id: &str,
        decision: PermissionDecision,
        scope: PermissionScope,
        reason: Option<&str>,
    ) -> Result<bool, String> {
        // Read without removing: a request that turns out not to be ours must
        // not consume another route's state. `claim` does the removal, once the
        // answer is actually going out.
        let rules = self.granted_rules.lock().ok().and_then(|r| r.get(request_id).cloned());
        self.answer(request_id, permission_response(decision, scope, reason, rules))
    }

    /// Answer a `can_use_tool` request, if it is still outstanding.
    ///
    /// The envelope is pinned by `a_permission_answer_is_the_envelope_the_cli_expects`
    /// below; it is the CLI's own `control_response` shape, not a Sway one.
    ///
    /// `Ok(false)` means this request was never ours, or was already answered.
    /// Both must not be errors: the first is how the caller learns to try the
    /// `PreToolUse` bridge instead, and the second is a user clicking as the
    /// deadline fires, a race they should never be shown.
    fn answer(&self, request_id: &str, response: Value) -> Result<bool, String> {
        if !self.claim(request_id) {
            return Ok(false);
        }
        self.write_frame(&json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": request_id, "response": response },
        }))?;
        Ok(true)
    }

    /// Deny everything still waiting. The fail-closed half of every exit path:
    /// a closed tab or an ended session must not leave the child blocked on a
    /// question nobody is left to answer.
    fn deny_all_pending(&self, reason: &str) {
        let outstanding: Vec<String> = guarded(&self.pending).drain().map(|(id, _)| id).collect();
        guarded(&self.granted_rules).clear();
        guarded(&self.parked_questions).clear();
        self.settled.notify_all();
        for request_id in outstanding {
            let _ = self.write_frame(&json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": request_id,
                    "response": { "behavior": "deny", "message": reason },
                },
            }));
        }
    }

    /// Withdraw every outstanding *question*, leaving permissions alone.
    ///
    /// The asymmetry is the point. A permission carries a deadline that settles
    /// it whatever the user does, so an interrupt can leave one to expire. A
    /// question has none by design, so an interrupt that ignored it would leave
    /// the child blocked on a form belonging to a turn that no longer exists.
    fn withdraw_questions(&self, reason: &str) {
        let outstanding: Vec<String> = {
            let mut pending = guarded(&self.pending);
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, kind)| **kind == Parked::Question)
                .map(|(id, _)| id.clone())
                .collect();
            for id in &ids {
                pending.remove(id);
            }
            ids
        };
        if outstanding.is_empty() {
            return;
        }
        let mut questions = guarded(&self.parked_questions);
        for id in &outstanding {
            questions.remove(id);
        }
        drop(questions);
        self.settled.notify_all();
        for request_id in outstanding {
            let _ = self.write_frame(&json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": request_id,
                    "response": { "behavior": "deny", "message": reason },
                },
            }));
        }
    }

    /// Keep the form a question asked, so its answer can quote it back.
    fn remember_questions(&self, request_id: &str, questions: &[ChatQuestion]) {
        guarded(&self.parked_questions).insert(request_id.to_string(), questions.to_vec());
    }

    /// Send the user's answers as the tool result the model reads.
    ///
    /// **A denial is the only channel that carries text.** `permission_response`
    /// puts `message` in front of the model verbatim on a deny, and an allow is
    /// a bare `{"behavior":"allow"}` with nowhere to put a string; allowing was
    /// measured to make the CLI self-answer within ~5ms with "The user did not
    /// answer the questions", because it runs the call against an interactive
    /// client that is not there. So the answer arrives `is_error: true`, which
    /// 20 of 20 runs across Opus and Sonnet acted on without re-asking.
    ///
    /// The form is read before `answer` claims the request, because claiming is
    /// what drops it.
    fn answer_question(&self, request_id: &str, answers: &[QuestionAnswer]) -> Result<bool, String> {
        let questions = guarded(&self.parked_questions).get(request_id).cloned().unwrap_or_default();
        let message = super::claude::answer_message(&questions, answers);
        self.answer(request_id, json!({ "behavior": "deny", "message": message }))
    }
}

pub struct ClaudeTransport {
    shared: Arc<Shared>,
    child: Option<Child>,
    /// Monotonic counter behind the `control_request` ids, so a response can be
    /// correlated to the request that caused it.
    request_seq: AtomicU64,
    /// Model and mode take effect from the next turn, so they are held here and
    /// applied when that turn is submitted. The CLI has no mid-turn switch, and
    /// pretending otherwise would show a mode the session is not in.
    pending_mode: Option<PermissionMode>,
    pending_model: Option<(String, Option<String>)>,
    /// The adapter's measured effort levels, handed to the mapper: they
    /// decorate the catalogue the session reports.
    effort_extras: Vec<ChatEffortExtra>,
    /// The kill switch, carried to the mapper at `start`. See
    /// [`ClaudeMapper::with_questions_as_permissions`].
    questions_as_permissions: bool,
}

impl ClaudeTransport {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            shared: Arc::new(Shared {
                session_id: session_id.into(),
                finished: AtomicBool::new(false),
                stderr_tail: Mutex::new(String::new()),
                turn_expected: AtomicBool::new(false),
                stdin: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                parked_questions: Mutex::new(HashMap::new()),
                mode_requests: Mutex::new(HashMap::new()),
                settled: Condvar::new(),
                granted_rules: Mutex::new(HashMap::new()),
            }),
            child: None,
            request_seq: AtomicU64::new(0),
            pending_mode: None,
            pending_model: None,
            effort_extras: Vec::new(),
            questions_as_permissions: false,
        }
    }

    /// Hand it the levels Sway measured that this CLI never advertises.
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

    fn next_request_id(&self) -> String {
        format!("sway-{}", self.request_seq.fetch_add(1, Ordering::SeqCst))
    }

    /// Write one JSON frame plus its newline. Every stdin write goes through
    /// here so the framing cannot drift between turn submission and the control
    /// protocol.
    fn write_frame(&mut self, frame: &Value) -> Result<(), String> {
        self.shared.write_frame(frame)
    }

    /// The `initialize` handshake. Its response is the only place the slash
    /// command catalogue exists with descriptions and argument hints; the
    /// `system/init` frame carries bare names only. Sent immediately after spawn
    /// so the catalogue is in the mapper before the first `SessionStarted`.
    fn handshake(&mut self) -> Result<(), String> {
        let request_id = self.next_request_id();
        self.write_frame(&json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "initialize", "hooks": {} },
        }))
    }
}

/// Translate a user turn's blocks into the `user` frame the CLI expects.
///
/// Images ride as base64 content blocks, measured to work over stream-json
/// stdin. A `FileRef` has no wire counterpart, so it is rendered as text that
/// names the path and range: dropping it would silently lose an `@`-mention,
/// and inventing a block type the CLI does not accept would fail the turn.
pub fn turn_frame(blocks: &[ContentBlock]) -> Value {
    let content: Vec<Value> = blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(json!({ "type": "text", "text": text })),
            ContentBlock::Image { media_type, data } => Some(json!({
                "type": "image",
                "source": { "type": "base64", "media_type": media_type, "data": data },
            })),
            ContentBlock::FileRef { path, start_line, end_line, text, label } => {
                let mut rendered = file_ref_locator(path, *start_line, *end_line);
                // `[Image 3]: @/abs/path`, the exact form `history.rs` reads
                // back, so the label survives a reopen.
                if let Some(l) = label {
                    rendered = format!("{l}: {rendered}");
                }
                if let Some(t) = text {
                    rendered.push_str("\n\n");
                    rendered.push_str(t);
                }
                Some(json!({ "type": "text", "text": rendered }))
            }
            // The one block a composer cannot make: it comes off a replayed
            // transcript and names bytes nothing kept. Sending it would mean
            // inventing an image, so it is left out rather than guessed at.
            ContentBlock::ImageRef => None,
        })
        .collect();
    json!({ "type": "user", "message": { "role": "user", "content": content } })
}

/// End a child we are about to stop holding a handle to.
///
/// Every `start` failure after the spawn goes through here, because Rust's
/// `Child` does **not** kill on drop: a bare `?` would leave a live agent
/// process with nobody holding it, which is exactly the orphan the ownership
/// registry exists to detect - manufactured by the code meant to prevent it.
/// The `wait` is not optional either; without it the dead child stays a zombie.
/// Register something the child is blocked on, and optionally start a clock.
///
/// Returns the wall-clock instant Sway will deny at, which rides out on the
/// event so the prompt can show a countdown that matches what actually happens
/// rather than one the UI invented. **`None` for `after` means no clock at all**
/// and returns `None`: nothing is spawned, so nothing can expire, and the only
/// things that can end that wait are the user and an explicit withdrawal.
///
/// A question takes that route. Measured 2026-08-22 on claude 2.1.239, the CLI
/// imposes no deadline of its own either: an unanswered question stayed
/// outstanding for 417s with zero frames after the ask. So there is no ceiling
/// to fit inside and nothing a countdown could honestly count down to, and a
/// question Sway denied on a timer would answer for the user.
///
/// The timer waits on the `settled` condvar rather than sleeping, so answering a
/// prompt retires its thread at once instead of leaving it parked for the rest
/// of the deadline. It still only *tries* to answer on expiry: `Shared::claim`
/// remains the single place that decides whether a request is outstanding, so a
/// user clicking at 109.9s wins and the timer's write is dropped. The wait is a
/// loop because a condvar may wake spuriously and because `notify_all` wakes
/// every armed timer, not only the one whose request was settled.
fn park(shared: &Arc<Shared>, request_id: String, kind: Parked, after: Option<Duration>) -> Option<u64> {
    guarded(&shared.pending).insert(request_id.clone(), kind);
    let after = after?;
    let deadline = now_ms() + after.as_millis() as u64;
    let shared = shared.clone();
    thread::spawn(move || {
        let expires_at = Instant::now() + after;
        let mut pending = guarded(&shared.pending);
        while pending.contains_key(&request_id) {
            let Some(left) = expires_at.checked_duration_since(Instant::now()) else { break };
            if left.is_zero() {
                break;
            }
            pending = match shared.settled.wait_timeout(pending, left) {
                Ok((guard, _)) => guard,
                Err(e) => e.into_inner().0,
            };
        }
        let expired = pending.contains_key(&request_id);
        // Never hold the pending lock across the write: `answer` takes it again
        // through `claim`, and takes stdin after it.
        drop(pending);
        if expired {
            let _ = shared.answer(
                &request_id,
                json!({
                    "behavior": "deny",
                    "message": format!(
                        "Sway denied this automatically: nobody answered within {} seconds. \
                         Ask again if you still need it.",
                        after.as_secs()
                    ),
                }),
            );
        }
    });
    Some(deadline)
}

/// A mutex guard that survives a poisoned lock.
///
/// Same reasoning as the host's: a panicked holder must not wedge every later
/// permission answer, and both maps stay structurally valid either way. Failing
/// closed here would mean *no* answer at all, which is the one outcome this
/// module exists to rule out.
fn guarded<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A `set_permission_mode` the CLI answered with an error, as the event saying
/// so. The bookkeeping is dropped on any response, success included: a switch
/// that landed is confirmed by the next `system/init` instead.
fn mode_refusal(shared: &Shared, frame: &Value) -> Option<ChatEvent> {
    if frame["type"].as_str() != Some("control_response") {
        return None;
    }
    let response = &frame["response"];
    let mode = guarded(&shared.mode_requests).remove(response["request_id"].as_str()?)?;
    if response["subtype"].as_str() != Some("error") {
        return None;
    }
    Some(ChatEvent::ModeRefused {
        session_id: shared.session_id.clone(),
        mode,
        reason: response["error"]
            .as_str()
            .unwrap_or("the agent refused the switch without saying why")
            .to_string(),
    })
}

/// The `response` payload of a permission answer, as the CLI reads it.
///
/// Pure so the envelope can be asserted without a live child; the shape is a
/// measurement of claude 2.1.231, not a convention. Measured: a deny's `message`
/// reaches the model verbatim as the tool result, and a bare
/// `{"behavior":"allow"}` runs the call unchanged.
fn permission_response(
    decision: PermissionDecision,
    scope: PermissionScope,
    reason: Option<&str>,
    granted_rules: Option<Value>,
) -> Value {
    match decision {
        // A denial's message is the model's tool result, measured verbatim:
        // "write to fixtures/ instead" redirects the turn, where a bare refusal
        // only stops it. Hence a default that still says something.
        PermissionDecision::Deny => json!({
            "behavior": "deny",
            "message": reason.unwrap_or("The user denied this tool call."),
        }),
        PermissionDecision::Allow => {
            let mut response = json!({ "behavior": "allow" });
            // A durable allow only ships when the agent told us how to spell
            // it. With no suggestion to echo, this degrades to a one-call allow
            // rather than inventing rule text.
            if let (Some(destination), Some(rules)) = (grant_destination(scope), granted_rules) {
                response["updatedPermissions"] = json!([{
                    "type": "addRules",
                    "rules": rules,
                    "behavior": "allow",
                    "destination": destination,
                }]);
            }
            response
        }
    }
}

/// Where the agent should persist a granted rule, per how far the user said
/// the answer reaches.
///
/// `Once` is `None` rather than a destination: it is the absence of a grant, and
/// mapping it to a destination would persist the very thing the user scoped to
/// one call. `Project` uses `localSettings`, which is the agent's own
/// project-local file - the point of this phase is that the agent owns the
/// permission, so Sway records it where the agent looks rather than in a
/// Sway-side store the CLI never reads.
fn grant_destination(scope: PermissionScope) -> Option<&'static str> {
    match scope {
        PermissionScope::Once => None,
        PermissionScope::Session => Some("session"),
        PermissionScope::Project => Some("localSettings"),
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn abandon(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

impl AgentTransport for ClaudeTransport {
    fn start(&mut self, spec: StartSpec, sink: Sink) -> Result<(), String> {
        let mut child = build_command(&spec)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", spec.program))?;

        let mut take_stdio = || {
            Ok::<_, String>((
                child.stdout.take().ok_or("child produced no stdout")?,
                child.stderr.take().ok_or("child produced no stderr")?,
                child.stdin.take().ok_or("child accepted no stdin")?,
            ))
        };
        let (stdout, stderr, stdin) = match take_stdio() {
            Ok(parts) => parts,
            Err(e) => {
                abandon(&mut child);
                return Err(e);
            }
        };
        if let Ok(mut slot) = self.shared.stdin.lock() {
            *slot = Some(stdin);
        }

        // stderr into a bounded tail, so the death message can say why.
        let (stderr_done_tx, stderr_done) = std::sync::mpsc::channel::<()>();
        {
            let shared = self.shared.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let mut stderr = stderr;
                while let Ok(n) = stderr.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    if let Ok(mut tail) = shared.stderr_tail.lock() {
                        tail.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if tail.len() > STDERR_TAIL {
                            let cut = tail.len() - STDERR_TAIL;
                            *tail = tail[cut..].to_string();
                        }
                    }
                }
                let _ = stderr_done_tx.send(());
            });
        }

        // The reader: one JSON frame per line, mapped and emitted.
        {
            let shared = self.shared.clone();
            let sink = sink.clone();
            let mut mapper =
                ClaudeMapper::new(shared.session_id.clone())
                    .with_effort_extras(self.effort_extras.clone())
                    .with_questions_as_permissions(self.questions_as_permissions);
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(line) {
                        Ok(frame) => {
                            if let Some(refused) = mode_refusal(&shared, &frame) {
                                emit(&sink, refused);
                            }
                            for mut event in mapper.map(&frame) {
                                // The mapper turns the frame into an event; the
                                // deadline is armed here, because the transport
                                // is the half that can actually answer.
                                match &mut event {
                                    // Consumed rather than read, so the turn
                                    // after this one is user-opened only if the
                                    // user opens it too.
                                    ChatEvent::TurnStarted { agent_initiated, .. } => {
                                        *agent_initiated =
                                            !shared.turn_expected.swap(false, Ordering::SeqCst);
                                    }
                                    ChatEvent::PermissionRequest {
                                        request_id, auto_deny_at_ms, suggestions, ..
                                    } => {
                                        shared.remember_grant(request_id, suggestions);
                                        *auto_deny_at_ms = park(
                                            &shared,
                                            request_id.clone(),
                                            Parked::Permission,
                                            Some(Duration::from_secs(DECIDE_TIMEOUT_SECS)),
                                        );
                                    }
                                    // Parked with no clock. See `park`.
                                    ChatEvent::QuestionRequest { request_id, questions, .. } => {
                                        shared.remember_questions(request_id, questions);
                                        park(&shared, request_id.clone(), Parked::Question, None);
                                    }
                                    _ => {}
                                }
                                emit(&sink, event);
                            }
                        }
                        // Non-fatal on purpose: a single malformed frame is worth
                        // reporting, not worth killing a live session over.
                        Err(e) => emit(
                            &sink,
                            ChatEvent::SessionError {
                                session_id: shared.session_id.clone(),
                                message: format!("unparseable stdout: {e}"),
                                fatal: false,
                            },
                        ),
                    }
                }
                // The child is gone, so every question it was blocked on is moot.
                // Forgetting them is the honest move rather than writing answers
                // into a closed pipe: it also stops the armed timers from finding
                // anything to deny, so they expire silently.
                if let Ok(mut pending) = shared.pending.lock() {
                    pending.clear();
                }
                if let Ok(mut rules) = shared.granted_rules.lock() {
                    rules.clear();
                }
                if let Ok(mut questions) = shared.parked_questions.lock() {
                    questions.clear();
                }
                // EOF on stdout means the child is going away. Report it exactly
                // once: a `close()` that already ended the session has nothing
                // to add, and a second fatal event would confuse the host's reap.
                if !shared.finished.swap(true, Ordering::SeqCst) {
                    // stdout can close before the stderr reader drains a child that
                    // wrote and exited at once. Bounded, because a grandchild holding
                    // stderr open would otherwise hold the death message forever.
                    let _ = stderr_done.recv_timeout(Duration::from_millis(500));
                    let tail = shared.stderr_tail.lock().map(|t| t.trim().to_string()).unwrap_or_default();
                    let message = if tail.is_empty() {
                        "the claude process exited".to_string()
                    } else {
                        format!("the claude process exited: {tail}")
                    };
                    emit(
                        &sink,
                        ChatEvent::SessionError { session_id: shared.session_id.clone(), message, fatal: true },
                    );
                }
            });
        }

        self.child = Some(child);
        // Same rule as the stdio takes above, now that `close` can do the work:
        // a handshake that cannot be written means the child is unusable, and
        // returning without killing it would leak it.
        if let Err(e) = self.handshake() {
            let _ = self.close();
            return Err(e);
        }
        Ok(())
    }

    fn send(&mut self, blocks: &[ContentBlock]) -> Result<(), String> {
        // A queued mode or model switch takes effect with this turn, which is
        // the only boundary at which the CLI can honour one.
        if let Some(mode) = self.pending_mode.take() {
            let request_id = self.next_request_id();
            guarded(&self.shared.mode_requests).insert(request_id.clone(), mode.clone());
            let _ = self.write_frame(&json!({
                "type": "control_request",
                "request_id": request_id,
                // The id as its adapter declared it: the transport is the layer
                // that knows this agent's spelling, and for Claude the
                // declared id *is* the wire value.
                "request": { "subtype": "set_permission_mode", "mode": mode.as_str() },
            }));
        }
        if let Some((model, effort)) = self.pending_model.take() {
            let request_id = self.next_request_id();
            let mut request = json!({ "subtype": "set_model", "model": model });
            if let Some(effort) = effort {
                request["effort"] = json!(effort);
            }
            let _ = self.write_frame(&json!({
                "type": "control_request",
                "request_id": request_id,
                "request": request,
            }));
        }
        // Armed only once the frame is away: a failed write opens no turn, and
        // a flag left set would hand the next agent-opened turn to the user.
        let sent = self.write_frame(&turn_frame(blocks));
        if sent.is_ok() {
            self.shared.turn_expected.store(true, Ordering::SeqCst);
        }
        sent
    }

    /// The same `user` frame `send` ends with, and deliberately nothing else.
    ///
    /// No pending mode or model switch is flushed: those are promises about the
    /// *next* turn, and a steer runs inside the current one. Taking them here
    /// would apply a switch the user was told would wait, and worse, consume it
    /// so the turn it was meant for never got it.
    ///
    /// Measured, not assumed: Phase 2's spike 5 wrote this frame mid-turn over
    /// `--input-format stream-json` in three trials and the model acted on it
    /// before its next tool call every time, at 1.5s to 5.4s. That is an
    /// observation against claude 2.1.220 rather than a contract.
    fn steer(&mut self, blocks: &[ContentBlock]) -> Result<(), String> {
        self.write_frame(&turn_frame(blocks))
    }

    /// Abandon the running turn, withdrawing any question it left open.
    ///
    /// The withdrawal goes first, and only questions are withdrawn. A permission
    /// still has its deadline to settle it, but a question has none, so an
    /// interrupt that left one parked would block the child on a form belonging
    /// to a turn the user just abandoned.
    fn interrupt(&mut self) -> Result<(), String> {
        self.shared
            .withdraw_questions("Sway withdrew this: the user interrupted the turn before answering.");
        let request_id = self.next_request_id();
        self.write_frame(&json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "interrupt" },
        }))
    }

    /// Answer the agent's own `can_use_tool` question.
    ///
    /// **The scope is delivered as the agent's rule, not as Sway's.** An allow
    /// that should outlast this one call rides back as `updatedPermissions`,
    /// which was measured to work: two `Write`s in one turn, the first answered
    /// with a session-scoped `addRules`, and the second never asked
    /// (`dev/protocol-probe.mjs`, scenario `permission-grant`). The rule text
    /// itself is the CLI's own suggestion echoed back rather than composed here,
    /// because the grammar belongs to the agent: a `Bash` rule is a command
    /// pattern, and Sway guessing at one is how "always allow `touch a.txt`"
    /// quietly becomes "always allow every `touch`". With no suggestion to echo,
    /// the answer degrades to a one-call allow rather than inventing a rule.
    ///
    /// `updatedInput` is deliberately omitted: measured, a bare
    /// `{"behavior":"allow"}` runs the call as the model wrote it, and echoing
    /// an input Sway never edited only adds a way to corrupt it.
    fn respond_permission(
        &mut self,
        _tool_use_id: &str,
        request_id: &str,
        decision: PermissionDecision,
        scope: PermissionScope,
        reason: Option<&str>,
    ) -> Result<bool, String> {
        self.shared.answer_decision(request_id, decision, scope, reason)
    }

    /// Answer a question by denying the call with the answer as the message,
    /// which is the only field that carries text to the model. See
    /// [`Shared::answer_question`].
    fn respond_question(
        &mut self,
        _tool_use_id: &str,
        request_id: &str,
        answers: &[QuestionAnswer],
    ) -> Result<bool, String> {
        self.shared.answer_question(request_id, answers)
    }

    fn set_mode(&mut self, mode: PermissionMode) -> Result<(), String> {
        self.pending_mode = Some(mode);
        Ok(())
    }

    fn set_model(&mut self, model: &str, effort: Option<String>) -> Result<(), String> {
        self.pending_model = Some((model.to_string(), effort));
        Ok(())
    }

    /// Claude's own levers are all published refused, so a set can only ever be
    /// a mistake. Named rather than swallowed: nothing reaches here without a
    /// control to click, so a quiet `Ok(())` would hide a routing bug.
    fn set_config_option(
        &mut self,
        config_id: &str,
        _value: &ChatConfigValue,
    ) -> Result<(), String> {
        Err(format!("this agent cannot switch `{config_id}` from a session"))
    }

    /// Nothing to replay: claude writes a per-session transcript and
    /// `chat_history` re-reads it on every mount, rewire included, so the
    /// conversation is already back before this would be asked.
    fn replay(&mut self) -> Result<bool, String> {
        Ok(false)
    }

    fn close(&mut self) -> Result<(), String> {
        // Marked finished *before* the kill so the reader thread's EOF does not
        // also report a death the user asked for.
        self.shared.finished.store(true, Ordering::SeqCst);
        // Answer whatever is still blocked *before* stdin goes away. A closed
        // tab is the commonest way to abandon a prompt, and a child left waiting
        // on a question nobody will answer is the hang this whole path exists to
        // rule out. Fail-closed: it is a denial, and it says why.
        self.shared.deny_all_pending("Sway denied this: the chat was closed before anyone answered.");
        // Dropping stdin is the graceful half; the kill covers a child that is
        // mid-turn and not reading it.
        if let Ok(mut slot) = self.shared.stdin.lock() {
            *slot = None;
        }
        if let Some(mut child) = self.child.take() {
            abandon(&mut child);
        }
        Ok(())
    }

    fn child_pid(&self) -> Option<u32> {
        self.child.as_ref().map(|c| c.id())
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::chat::model::ChatQuestionOption;
    use crate::chat::transport::new_sink;
    use std::collections::HashMap;

    /// Nothing on the wire says who opened a turn: the `system/init` a
    /// background subagent produces is identical to a user turn's bar its
    /// `uuid`. Only the writing side holds this, and a ceiling needs it.
    #[test]
    fn a_turn_the_user_did_not_send_is_marked_as_the_agents() {
        let shared = shared();

        // Nobody sent anything: the next turn is the agent's own.
        assert!(!shared.turn_expected.swap(false, Ordering::SeqCst));

        // Sway writes a turn, so the one that follows is the user's, and
        // exactly one is: the flag is consumed, not merely read.
        shared.turn_expected.store(true, Ordering::SeqCst);
        assert!(shared.turn_expected.swap(false, Ordering::SeqCst), "the turn the user sent");
        assert!(
            !shared.turn_expected.swap(false, Ordering::SeqCst),
            "and the turn after it is not, or one send would excuse every later turn"
        );
    }

    fn shared() -> Arc<Shared> {
        Arc::new(Shared {
            session_id: "s1".into(),
            turn_expected: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            stderr_tail: Mutex::new(String::new()),
            // No child: every write fails, which is exactly the condition these
            // tests want. They are about *which* questions get answered and how
            // many times, not about the bytes reaching a pipe.
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            settled: Condvar::new(),
            granted_rules: Mutex::new(HashMap::new()),
            parked_questions: Mutex::new(HashMap::new()),
            mode_requests: Mutex::new(HashMap::new()),
        })
    }

    /// Claude's levers are all published refused, so a set can only be a bug in
    /// the routing above. It says which lever rather than answering `Ok(())`,
    /// which would leave a control that looks like it worked.
    #[test]
    fn a_set_on_a_lever_this_transport_cannot_switch_names_it() {
        let mut t = ClaudeTransport::new("s1");
        let err = t
            .set_config_option("fast_mode", &ChatConfigValue::Flag(true))
            .expect_err("claude switches none of its own options");
        assert!(err.contains("fast_mode"), "the refusal must name the option: {err}");
    }

    /// Task 4's envelope, pinned rather than described. These field names are a
    /// measurement of the CLI; a rename here is a silent protocol break.
    #[test]
    fn a_permission_answer_is_the_envelope_the_cli_expects() {
        let denied = permission_response(PermissionDecision::Deny, PermissionScope::Once, Some("not that file"), None);
        assert_eq!(denied["behavior"], "deny");
        assert_eq!(denied["message"], "not that file");

        // A denial with no typed reason still says something: the model reads
        // this as the tool result, and an empty one teaches it nothing.
        let bare = permission_response(PermissionDecision::Deny, PermissionScope::Once, None, None);
        assert_eq!(bare["behavior"], "deny");
        assert!(bare["message"].as_str().is_some_and(|m| !m.is_empty()));

        // A one-call allow carries no grant, and deliberately no `updatedInput`.
        let once = permission_response(PermissionDecision::Allow, PermissionScope::Once, None, None);
        assert_eq!(once["behavior"], "allow");
        assert!(once.get("updatedPermissions").is_none());
        assert!(once.get("updatedInput").is_none());
    }

    /// The measured grant path: a session-scoped allow echoes the agent's own
    /// rule back, which is what stops the next identical call from asking.
    #[test]
    fn a_scoped_allow_echoes_the_agents_own_rule() {
        let rules = json!([{ "toolName": "Bash", "ruleContent": "touch a.txt" }]);
        let granted =
            permission_response(PermissionDecision::Allow, PermissionScope::Session, None, Some(rules.clone()));
        let update = &granted["updatedPermissions"][0];
        assert_eq!(update["type"], "addRules");
        assert_eq!(update["behavior"], "allow");
        assert_eq!(update["destination"], "session");
        assert_eq!(update["rules"], rules);

        // Project scope goes to the agent's own project-local file, because
        // the agent is what has to read it back on the next call.
        let project = permission_response(PermissionDecision::Allow, PermissionScope::Project, None, Some(rules));
        assert_eq!(project["updatedPermissions"][0]["destination"], "localSettings");
    }

    /// Without a suggestion to echo there is no rule to write, so a scoped allow
    /// degrades to a one-call allow rather than Sway inventing rule text.
    #[test]
    fn a_scoped_allow_without_a_suggestion_does_not_invent_a_rule() {
        let granted = permission_response(PermissionDecision::Allow, PermissionScope::Session, None, None);
        assert_eq!(granted["behavior"], "allow");
        assert!(granted.get("updatedPermissions").is_none());
    }

    /// The routing signal `ChatHost::answer_permission` depends on. A prompt
    /// raised by the `PreToolUse` bridge carries a request id this transport
    /// never issued, and it must disclaim it rather than swallow the answer:
    /// swallowing it would leave the blocked hook waiting for its own 110s
    /// auto-deny, turning a click on Allow into a denial.
    #[test]
    fn a_request_the_transport_never_issued_is_disclaimed() {
        let shared = shared();
        let answered = shared
            .answer_decision("from-the-hook-bridge", PermissionDecision::Allow, PermissionScope::Once, None)
            .expect("disclaiming is not an error");
        assert!(!answered, "an unknown request must route on to the bridge");
    }

    /// Task 5's core invariant: one question, one answer, whoever gets there
    /// first. Without this the deadline and a late click both write, and the
    /// control protocol desynchronizes.
    #[test]
    fn a_question_can_only_be_answered_once() {
        let shared = shared();
        shared.pending.lock().unwrap().insert("req-1".into(), Parked::Permission);

        assert!(shared.claim("req-1"), "the first answer should win");
        assert!(!shared.claim("req-1"), "a second answer must not be sent");
        assert!(!shared.claim("never-asked"), "an unknown request is not answerable");
    }

    /// Closing a tab must not leave the child blocked on a question nobody is
    /// left to answer. Fail-closed: everything outstanding is denied and
    /// forgotten, so an armed timer finds nothing to answer either.
    #[test]
    fn a_teardown_denies_everything_still_waiting() {
        let shared = shared();
        {
            let mut pending = shared.pending.lock().unwrap();
            pending.insert("req-1".into(), Parked::Permission);
            pending.insert("req-2".into(), Parked::Permission);
        }
        shared.granted_rules.lock().unwrap().insert("req-1".into(), json!([]));

        shared.deny_all_pending("the chat was closed");

        assert!(shared.pending.lock().unwrap().is_empty(), "nothing may stay pending after a teardown");
        assert!(shared.granted_rules.lock().unwrap().is_empty(), "a settled question keeps no remembered grant");
        assert!(!shared.claim("req-1"), "a late click after teardown must be a no-op");
        assert!(!shared.claim("req-2"));
    }

    /// The deadline settles a question without writing a rule, so if the removal
    /// lived on the user-answer path instead of in `claim`, every timed-out
    /// prompt would leave its grant behind for the life of the session.
    #[test]
    fn a_settled_question_drops_its_remembered_grant() {
        let shared = shared();
        shared.pending.lock().unwrap().insert("req-1".into(), Parked::Permission);
        shared.granted_rules.lock().unwrap().insert("req-1".into(), json!([{ "toolName": "Bash" }]));

        assert!(shared.claim("req-1"));
        assert!(shared.granted_rules.lock().unwrap().is_empty(), "claiming must drop the grant with it");
    }

    /// The deadline rides out on the event so the prompt counts down to the
    /// moment Sway actually acts, and it stays under the two minutes the
    /// injected hook declares, so neither route outlives the other.
    #[test]
    fn arming_a_deadline_registers_the_question_and_returns_when_it_expires() {
        let shared = shared();
        let before = now_ms();
        let deadline = park(
            &shared,
            "req-1".into(),
            Parked::Permission,
            Some(Duration::from_secs(DECIDE_TIMEOUT_SECS)),
        )
        .expect("a permission is parked with a clock");

        assert!(shared.pending.lock().unwrap().contains_key("req-1"), "an armed question must be pending");
        assert!(deadline >= before + DECIDE_TIMEOUT_SECS * 1000);
        assert!(DECIDE_TIMEOUT_SECS < super::super::approval::HOOK_TIMEOUT_SECS);
    }

    /// **A question is parked with no clock at all.**
    ///
    /// The literal claim, "the child stays blocked past `DECIDE_TIMEOUT_SECS`",
    /// was measured in the Phase 0 spike rather than waited out here: an
    /// unanswered question held for 417s against claude 2.1.239 with zero frames
    /// after the ask. What a unit test can prove, and what this proves, is that
    /// Sway arms nothing, by running the same `park` with a deadline short
    /// enough to observe and then with none. A 110s sleep would prove the same
    /// thing 2000 times slower and would still not reach 417s.
    #[test]
    fn a_question_is_parked_with_no_deadline_and_a_permission_is_not() {
        let shared = shared();

        // The control: with a clock, the same call expires and denies itself.
        assert!(park(&shared, "with-clock".into(), Parked::Permission, Some(Duration::from_millis(40)))
            .is_some());
        thread::sleep(Duration::from_millis(300));
        assert!(
            !guarded(&shared.pending).contains_key("with-clock"),
            "a parked permission must expire on its own"
        );

        // The subject: no clock, nothing spawned, nothing to expire.
        assert_eq!(park(&shared, "no-clock".into(), Parked::Question, None), None, "no deadline to report");
        thread::sleep(Duration::from_millis(300));
        assert_eq!(
            guarded(&shared.pending).get("no-clock"),
            Some(&Parked::Question),
            "a question outlives any deadline a permission would have had"
        );
        assert!(shared.claim("no-clock"), "and it is still the user's to answer");
    }

    /// Interrupting a turn withdraws its question and leaves permissions alone.
    ///
    /// The asymmetry is deliberate and is what the deadline removal created: a
    /// permission still has a clock that will settle it, a question has none, so
    /// an interrupt is the only thing standing between an abandoned turn and a
    /// child blocked forever.
    #[test]
    fn an_interrupt_withdraws_the_question_and_leaves_the_permission_parked() {
        let shared = shared();
        park(&shared, "perm".into(), Parked::Permission, None);
        park(&shared, "quest".into(), Parked::Question, None);
        shared.remember_questions("quest", &[ChatQuestion {
            question: "Which?".into(),
            header: "H".into(),
            multi_select: false,
            options: vec![ChatQuestionOption {
                label: "A".into(),
                description: String::new(),
                preview: None,
            }],
        }]);

        shared.withdraw_questions("the user interrupted");

        assert!(!guarded(&shared.pending).contains_key("quest"), "the question is withdrawn");
        assert!(
            guarded(&shared.parked_questions).is_empty(),
            "and its remembered form goes with it, or the map grows for the session"
        );
        assert_eq!(
            guarded(&shared.pending).get("perm"),
            Some(&Parked::Permission),
            "a permission has its own deadline and is not the interrupt's business"
        );
        assert!(!shared.claim("quest"), "a late answer after a withdrawal is a no-op");
    }

    /// The three ways an unanswered question ends, asserted together because
    /// what matters is that *none* of them leaves an id parked. A question has
    /// no deadline, so anything these three miss is blocked for the life of the
    /// child.
    #[test]
    fn no_exit_path_leaves_a_question_parked() {
        // Tab close and session end are one path: both reach `deny_all_pending`.
        let shared = shared();
        park(&shared, "q1".into(), Parked::Question, None);
        shared.remember_questions("q1", &[]);
        shared.deny_all_pending("the chat was closed");
        assert!(guarded(&shared.pending).is_empty(), "teardown leaves nothing parked");
        assert!(guarded(&shared.parked_questions).is_empty(), "and nothing remembered");

        // Interrupt is the third, on a fresh session so the two cannot mask
        // each other by leaving the map already empty.
        drop(shared);
        let shared = super::tests::shared();
        park(&shared, "q2".into(), Parked::Question, None);
        shared.remember_questions("q2", &[]);
        shared.withdraw_questions("the user interrupted");
        assert!(guarded(&shared.pending).is_empty(), "an interrupt leaves nothing parked");
        assert!(guarded(&shared.parked_questions).is_empty());
    }

    /// The answer reaches the model as a **denial**, because that is the only
    /// field on the response that carries text: an allow is a bare
    /// `{"behavior":"allow"}`, and measured, allowing makes the CLI answer for
    /// the user within milliseconds.
    #[test]
    fn a_question_is_answered_by_denying_the_call_with_the_answer_as_the_message() {
        let shared = shared();
        let questions = vec![ChatQuestion {
            question: "Which colour do you want?".into(),
            header: "Colour".into(),
            multi_select: false,
            options: vec![ChatQuestionOption {
                label: "Red".into(),
                description: "Choose red.".into(),
                preview: Some("#ff0000".into()),
            }],
        }];
        park(&shared, "q".into(), Parked::Question, None);
        shared.remember_questions("q", &questions);

        // No child, so the write fails after the claim. What is under test is
        // the claim and the message, and `answer` claims before it writes.
        let _ = shared.answer_question("q", &[QuestionAnswer {
            question: "Which colour do you want?".into(),
            picks: vec!["Red".into()],
            free_text: None,
        }]);
        assert!(!guarded(&shared.pending).contains_key("q"), "answering settles it");
        assert!(
            !shared
                .answer_question(
                    "q",
                    &[QuestionAnswer { question: "Which colour do you want?".into(), picks: vec![], free_text: None }]
                )
                .expect("a second answer is a no-op, not an error"),
            "one question, one answer"
        );
    }

    /// A question whose form was forgotten still answers, without the preview.
    ///
    /// Reachable in one race: the reader thread forgets every parked form when
    /// the child dies, so a click landing in that window finds nothing.
    /// Answering with a form-less string beats refusing, since the request is
    /// about to be moot either way and an error toast for a dead child helps
    /// nobody. Writing this test is what caught the forgetting *not* happening:
    /// the comment claimed a cleanup that only covered `pending` and the grants.
    #[test]
    fn an_answer_with_no_remembered_form_still_names_the_questions() {
        let shared = shared();
        park(&shared, "q".into(), Parked::Question, None);
        let message = super::super::claude::answer_message(
            &[],
            &[QuestionAnswer {
                question: "Which colour do you want?".into(),
                picks: vec!["Red".into()],
                free_text: None,
            }],
        );
        assert!(message.contains("\"Which colour do you want?\"=\"Red\""), "{message}");
        assert!(!message.contains("selected preview"), "no form, so no preview to echo: {message}");
    }

    /// The timer must retire when its question is answered, not sleep out the
    /// full 110s. Asserted by joining the waiter: a `thread::sleep` version
    /// would still be parked and this would hang instead of returning.
    #[test]
    fn answering_retires_the_armed_timer_immediately() {
        let shared = shared();
        guarded(&shared.pending).insert("req-1".into(), Parked::Permission);

        let waiter = {
            let shared = shared.clone();
            thread::spawn(move || {
                let expires_at = Instant::now() + Duration::from_secs(DECIDE_TIMEOUT_SECS);
                let mut pending = guarded(&shared.pending);
                while pending.contains_key("req-1") {
                    let Some(left) = expires_at.checked_duration_since(Instant::now()) else { break };
                    pending = shared.settled.wait_timeout(pending, left).map(|(g, _)| g).unwrap();
                }
            })
        };

        // A moment for the waiter to park, then settle the question under it.
        thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        assert!(shared.claim("req-1"));
        waiter.join().expect("the timer thread should wake and exit");

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the timer slept past its question being answered"
        );
    }

    /// Only an `allow` rule is remembered. A `deny` suggestion echoed back under
    /// the user's *allow* would invert the answer.
    #[test]
    fn only_an_allow_suggestion_is_kept_as_a_grant() {
        let shared = shared();
        shared.remember_grant(
            "req-1",
            &[PermissionSuggestion::AddRules {
                rules: vec![super::super::model::SuggestedRule {
                    tool_name: "Bash".into(),
                    rule_content: Some("rm -rf /".into()),
                }],
                behavior: "deny".into(),
                destination: "session".into(),
            }],
        );
        assert!(shared.granted_rules.lock().unwrap().get("req-1").is_none(), "a deny rule must never become a grant");

        shared.remember_grant(
            "req-2",
            &[PermissionSuggestion::SetMode {
                mode: PermissionMode::new("acceptEdits"),
                destination: "session".into(),
            }],
        );
        assert!(shared.granted_rules.lock().unwrap().get("req-2").is_none(), "a mode switch is not a rule");
    }

    #[test]
    fn a_text_turn_becomes_the_frame_the_cli_expects() {
        let frame = turn_frame(&[ContentBlock::Text { text: "hello".into() }]);
        assert_eq!(frame["type"], "user");
        assert_eq!(frame["message"]["role"], "user");
        assert_eq!(frame["message"]["content"][0]["type"], "text");
        assert_eq!(frame["message"]["content"][0]["text"], "hello");
    }

    /// Images were measured to work over stream-json stdin only in this exact
    /// nested `source` shape, so the shape is pinned rather than described.
    #[test]
    fn an_image_rides_as_a_base64_source_block() {
        let frame = turn_frame(&[ContentBlock::Image { media_type: "image/png".into(), data: "AAAA".into() }]);
        let block = &frame["message"]["content"][0];
        assert_eq!(block["type"], "image");
        assert_eq!(block["source"]["type"], "base64");
        assert_eq!(block["source"]["media_type"], "image/png");
        assert_eq!(block["source"]["data"], "AAAA");
    }

    /// A file reference has no wire counterpart. Rendering it as text keeps the
    /// path and range; dropping it would silently lose an `@`-mention.
    #[test]
    fn a_file_reference_renders_as_text_naming_the_path_and_range() {
        let frame = turn_frame(&[ContentBlock::FileRef {
            path: "src/main.rs".into(),
            start_line: Some(10),
            end_line: Some(20),
            text: Some("fn main() {}".into()),
            label: None,
        }]);
        let text = frame["message"]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("@src/main.rs#L10-20"), "got {text}");
        assert!(text.contains("fn main() {}"));
    }

    #[test]
    fn a_file_reference_without_a_range_names_just_the_path() {
        let frame = turn_frame(&[ContentBlock::FileRef {
            path: "README.md".into(),
            start_line: None,
            end_line: None,
            text: None,
            label: None,
        }]);
        assert_eq!(frame["message"]["content"][0]["text"], "@README.md");
    }

    /// A PDF is addressed by page, not by line: the agent opens it with a PDF
    /// reader, and `#L3` would send it looking for a third line of text.
    #[test]
    fn a_pdf_reference_names_pages_rather_than_lines() {
        let one = turn_frame(&[ContentBlock::FileRef {
            path: "docs/manual.pdf".into(),
            start_line: Some(3),
            end_line: Some(3),
            text: None,
            label: None,
        }]);
        assert_eq!(one["message"]["content"][0]["text"], "@docs/manual.pdf (page 3)");

        let many = turn_frame(&[ContentBlock::FileRef {
            path: "docs/manual.PDF".into(),
            start_line: Some(3),
            end_line: Some(4),
            text: None,
            label: None,
        }]);
        assert_eq!(many["message"]["content"][0]["text"], "@docs/manual.PDF (pages 3-4)");
    }

    /// The other half of the same claim: nothing but a `.pdf` moved off `#L`.
    #[test]
    fn a_source_file_still_names_lines() {
        for path in ["src/main.rs", "src/app.ts", "notes.pdf.ts"] {
            let frame = turn_frame(&[ContentBlock::FileRef {
                path: path.into(),
                start_line: Some(3),
                end_line: Some(4),
                text: None,
                label: None,
            }]);
            assert_eq!(frame["message"]["content"][0]["text"], format!("@{path}#L3-4"));
        }
    }

    /// An attachment is a labelled path: the token the prose names it by, then
    /// the mention. This exact form is what `history.rs` reads back.
    #[test]
    fn a_labelled_reference_leads_with_its_label() {
        let frame = turn_frame(&[ContentBlock::FileRef {
            path: "/home/me/.config/sway/attachments/ab-shot.png".into(),
            start_line: None,
            end_line: None,
            text: None,
            label: Some("[Image 3]".into()),
        }]);
        assert_eq!(
            frame["message"]["content"][0]["text"],
            "[Image 3]: @/home/me/.config/sway/attachments/ab-shot.png"
        );
    }

    /// Every frame the CLI reads is newline-delimited JSON, so a turn that
    /// contained a raw newline would be split into two invalid frames. Rust's
    /// `Display` for `Value` never emits one, and this pins that.
    #[test]
    fn a_multiline_turn_still_serializes_to_exactly_one_line() {
        let frame = turn_frame(&[ContentBlock::Text { text: "line one\nline two".into() }]);
        assert_eq!(frame.to_string().lines().count(), 1);
    }

    /// A command sent to a transport that never started must error rather than
    /// panic on the absent stdin.
    #[test]
    fn commands_before_start_error_rather_than_panic() {
        let mut t = ClaudeTransport::new("s1");
        assert!(t.send(&[ContentBlock::Text { text: "hi".into() }]).is_err());
        assert!(t.interrupt().is_err());
        assert!(t.child_pid().is_none());
        // Close is idempotent and must succeed even having never started.
        assert!(t.close().is_ok());
    }

    /// Mode and model are queued, not sent immediately: the CLI applies them at
    /// a turn boundary, and claiming otherwise would show a mode the session is
    /// not actually in.
    #[test]
    fn mode_and_model_are_queued_for_the_next_turn() {
        let mut t = ClaudeTransport::new("s1");
        t.set_mode(PermissionMode::new("plan")).unwrap();
        t.set_model("claude-opus-5", Some("high".to_string())).unwrap();
        assert_eq!(t.pending_mode, Some(PermissionMode::new("plan")));
        assert_eq!(t.pending_model, Some(("claude-opus-5".to_string(), Some("high".to_string()))));
    }

    /// A steer runs inside the current turn, so it must leave a queued switch
    /// alone. `send` *takes* the pending values, so had steering reused it the
    /// switch would have been applied to a turn the user was told it would wait
    /// for, and then been gone before the turn it was actually meant for.
    ///
    /// Asserted on the pending state rather than on the wire because there is no
    /// child here to write to: both calls fail at the absent stdin, and what is
    /// under test is what they consumed before reaching it.
    #[test]
    fn a_steer_leaves_a_queued_mode_or_model_switch_for_the_next_turn() {
        let mut t = ClaudeTransport::new("s1");
        t.set_mode(PermissionMode::new("plan")).unwrap();
        t.set_model("claude-opus-5", Some("high".to_string())).unwrap();

        let blocks = [ContentBlock::Text { text: "stop reading, just summarise".to_string() }];
        assert!(t.steer(&blocks).is_err(), "no child, so the write itself cannot succeed");
        assert_eq!(t.pending_mode, Some(PermissionMode::new("plan")), "the steer must not spend the mode switch");
        assert_eq!(
            t.pending_model,
            Some(("claude-opus-5".to_string(), Some("high".to_string()))),
            "nor the model switch"
        );

        // The turn the switches were queued for still takes them, which is what
        // makes the steer's restraint a deferral rather than a loss.
        let _ = t.send(&blocks);
        assert_eq!(t.pending_mode, None);
        assert_eq!(t.pending_model, None);
    }

    /// Every failure path in `start` relies on `abandon` actually ending the
    /// child, because Rust's `Child` does not kill on drop. Tested directly
    /// against a real long-lived process: the leak windows inside `start` are
    /// racy to provoke, but the thing they all call is not.
    #[test]
    fn abandon_really_ends_the_child_since_drop_would_not() {
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("the stand-in child should start");
        let pid = child.id();
        assert!(pid_is_alive(pid), "the child should be running before we abandon it");

        abandon(&mut child);

        assert!(!pid_is_alive(pid), "abandon must leave no live process behind");
    }

    #[cfg(test)]
    fn pid_is_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// A child that exits immediately is the mock-child case: the reader hits
    /// EOF and a fatal error must reach the sink, since that is what the host
    /// reaps on.
    #[test]
    fn a_child_that_exits_produces_one_fatal_session_error() {
        let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = seen.clone();
        let sink = new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev)));

        let mut t = ClaudeTransport::new("s-exits");
        // `false` exits non-zero at once while accepting stdin, which is exactly
        // a child dying mid-turn.
        let spec = StartSpec {
            session_id: "s-exits".into(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "exit 1".into()],
            ..Default::default()
        };
        // The handshake write races the exit, so its result is not the subject.
        let _ = t.start(spec, sink);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if seen.lock().unwrap().iter().any(|e| matches!(e, ChatEvent::SessionError { fatal: true, .. })) {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        let events = seen.lock().unwrap().clone();
        let fatal: Vec<_> = events.iter().filter(|e| matches!(e, ChatEvent::SessionError { fatal: true, .. })).collect();
        assert_eq!(fatal.len(), 1, "exactly one fatal error, got {events:?}");
    }

    /// stderr is carried into the death message, so "it exited" comes with why.
    #[test]
    fn the_death_message_carries_the_stderr_tail() {
        let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = seen.clone();
        let sink = new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev)));

        let mut t = ClaudeTransport::new("s-noisy");
        let spec = StartSpec {
            session_id: "s-noisy".into(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "printf 'unknown option --nope' >&2; exit 2".into()],
            ..Default::default()
        };
        let _ = t.start(spec, sink);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut message = String::new();
        while std::time::Instant::now() < deadline {
            if let Some(ChatEvent::SessionError { message: m, .. }) = seen
                .lock()
                .unwrap()
                .iter()
                .find(|e| matches!(e, ChatEvent::SessionError { fatal: true, .. }))
            {
                message = m.clone();
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(message.contains("unknown option --nope"), "got {message:?}");
    }

    /// An explicit close must not also report a death: the user asked for it,
    /// and a fatal error afterwards would surface as a crash they did not cause.
    #[test]
    fn closing_does_not_also_report_the_child_dying() {
        let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = seen.clone();
        let sink = new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev)));

        let mut t = ClaudeTransport::new("s-closed");
        let spec = StartSpec {
            session_id: "s-closed".into(),
            program: "/bin/sh".into(),
            // Reads stdin forever, so nothing ends it but our own close.
            args: vec!["-c".into(), "cat > /dev/null".into()],
            ..Default::default()
        };
        t.start(spec, sink).unwrap();
        assert!(t.child_pid().is_some(), "a started transport must report a pid for the claim record");
        t.close().unwrap();

        thread::sleep(std::time::Duration::from_millis(300));
        let events = seen.lock().unwrap().clone();
        assert!(
            !events.iter().any(|e| matches!(e, ChatEvent::SessionError { fatal: true, .. })),
            "a deliberate close must not look like a crash: {events:?}"
        );
    }

    // -----------------------------------------------------------------------
    // Live tests
    //
    // Opt-in (`cargo test -- --ignored --test-threads=1`), because they drive
    // the real `claude`, cost tokens, and need network. Everything above runs on
    // mock children and stays in the default suite; these two exist because the
    // properties they assert are the ones a mock cannot establish - that the
    // real CLI serves many turns from one child, and that it honours an
    // interrupt and keeps going afterwards. Both were measured during planning;
    // these keep them measured.
    // -----------------------------------------------------------------------

    #[cfg(test)]
    fn live_session(cwd: &std::path::Path, session_id: &str) -> (ClaudeTransport, Arc<Mutex<Vec<ChatEvent>>>) {
        let adapter = crate::agents::find("claude").expect("the bundled claude adapter");
        let chat = adapter.chat.as_ref().expect("claude declares a chat transport");
        let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = seen.clone();
        let sink = new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev)));

        let mut t = ClaudeTransport::new(session_id);
        t.start(
            StartSpec {
                session_id: session_id.to_string(),
                cwd: cwd.to_string_lossy().into_owned(),
                program: chat.program.clone(),
                // Through the real arg builder, so a drift in the adapter's
                // flags fails here rather than at runtime.
                args: crate::chat::commands::build_args(chat, session_id, false, None, None, None, None, &[]),
                env: HashMap::new(),
            },
            sink,
        )
        .expect("claude should start");
        (t, seen)
    }

    #[cfg(test)]
    fn wait_for(seen: &Arc<Mutex<Vec<ChatEvent>>>, secs: u64, done: impl Fn(&[ChatEvent]) -> bool) -> Vec<ChatEvent> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        loop {
            let events = seen.lock().unwrap().clone();
            if done(&events) || std::time::Instant::now() >= deadline {
                return events;
            }
            thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    #[cfg(test)]
    fn turns_completed(events: &[ChatEvent]) -> usize {
        events.iter().filter(|e| matches!(e, ChatEvent::TurnCompleted { .. })).count()
    }

    /// **The measurement the whole design rests on**: one child serves many
    /// turns when stdin stays open. Early probes concluded the CLI exits after
    /// one turn; closing stdin was the cause. If that were ever true, a session
    /// would need a fresh `--resume` per turn, and two concurrent resumes of one
    /// id silently corrupt the transcript.
    #[test]
    #[ignore = "drives the real claude CLI: costs tokens and needs network"]
    fn two_turns_run_on_one_live_child() {
        let cwd = std::env::temp_dir().join(format!("sway-live-turns-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();
        let session_id = uuid_like();
        let (mut t, seen) = live_session(&cwd, &session_id);

        t.send(&[ContentBlock::Text { text: "Reply with exactly: one".into() }]).unwrap();
        wait_for(&seen, 120, |e| turns_completed(e) >= 1);
        t.send(&[ContentBlock::Text { text: "Reply with exactly: two".into() }]).unwrap();
        let events = wait_for(&seen, 120, |e| turns_completed(e) >= 2);

        let started = events.iter().filter(|e| matches!(e, ChatEvent::SessionStarted { .. })).count();
        assert_eq!(started, 1, "the per-turn system/init must not read as a second session");
        assert_eq!(turns_completed(&events), 2, "two turns should complete on one child");
        assert!(t.child_pid().is_some(), "the child should still be alive after both turns");
        assert!(
            !events.iter().any(|e| matches!(e, ChatEvent::SessionError { fatal: true, .. })),
            "the child must not have died: {events:?}"
        );

        t.close().unwrap();
        let _ = std::fs::remove_dir_all(&cwd);
    }

    /// Interrupt via the advertised `interrupt_receipt_v1` capability, and the
    /// half that matters more: the session is still usable afterwards. An
    /// interrupt that killed the child would be indistinguishable from a crash.
    #[test]
    #[ignore = "drives the real claude CLI: costs tokens and needs network"]
    fn an_interrupt_cancels_the_turn_and_the_session_survives_it() {
        let cwd = std::env::temp_dir().join(format!("sway-live-interrupt-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();
        let session_id = uuid_like();
        let (mut t, seen) = live_session(&cwd, &session_id);

        t.send(&[ContentBlock::Text { text: "Count slowly from 1 to 500, one number per line.".into() }])
            .unwrap();
        // Let the turn genuinely start, or the interrupt lands on nothing.
        wait_for(&seen, 60, |e| e.iter().any(|ev| matches!(ev, ChatEvent::TextDelta { .. })));

        let before = std::time::Instant::now();
        t.interrupt().unwrap();
        let events = wait_for(&seen, 5, |e| turns_completed(e) >= 1);
        assert!(before.elapsed() < std::time::Duration::from_secs(5), "the interrupt should land within 5s");

        let outcome = events.iter().find_map(|e| match e {
            ChatEvent::TurnCompleted { outcome, .. } => Some(*outcome),
            _ => None,
        });
        assert_eq!(
            outcome,
            Some(crate::chat::model::TurnOutcome::Cancelled),
            "an interrupted turn is cancelled, not errored: {events:?}"
        );

        t.send(&[ContentBlock::Text { text: "Reply with exactly: alive".into() }]).unwrap();
        let events = wait_for(&seen, 120, |e| turns_completed(e) >= 2);
        assert_eq!(turns_completed(&events), 2, "a further turn must run on the same child after an interrupt");

        t.close().unwrap();
        let _ = std::fs::remove_dir_all(&cwd);
    }

    /// `--session-id` requires a UUID, so a live test cannot pass a readable
    /// name. Derived from the clock and the pid rather than pulling in a uuid
    /// dependency for two ignored tests.
    #[cfg(test)]
    pub fn uuid_like() -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let hex = format!("{:032x}", nanos ^ ((std::process::id() as u128) << 96));
        format!("{}-{}-4{}-8{}-{}", &hex[0..8], &hex[8..12], &hex[13..16], &hex[17..20], &hex[20..32])
    }

    /// The steer reaches the child's stdin *while it is running*, which is the
    /// half of Phase 2's spike 5 that lives in Sway rather than in the CLI.
    ///
    /// The spike established that claude acts on a mid-turn `user` frame before
    /// its next tool call; what it could not establish is that Sway's own
    /// `steer` still writes that frame once it stopped going through `send`.
    /// So the child here is a stand-in that copies stdin to a file, and the
    /// assertion is on the bytes that actually left the pipe.
    #[test]
    fn a_steer_writes_the_user_frame_to_the_live_childs_stdin() {
        let dir = std::env::temp_dir().join(format!("sway-steer-{}-{}", std::process::id(), uuid_like()));
        std::fs::create_dir_all(&dir).expect("create the scratch dir");
        let log = dir.join("stdin.jsonl");

        let mut t = ClaudeTransport::new("s-steer");
        let spec = StartSpec {
            session_id: "s-steer".into(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), format!("cat > '{}'", log.display())],
            ..Default::default()
        };
        t.start(spec, new_sink(Box::new(|_| {}))).unwrap();
        t.steer(&[ContentBlock::Text { text: "stop reading, just summarise".to_string() }])
            .expect("the steer should reach a running child");

        // Polled rather than slept on: `cat` writes as it reads, but when it gets
        // there is the OS's business.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut written = String::new();
        while std::time::Instant::now() < deadline {
            written = std::fs::read_to_string(&log).unwrap_or_default();
            if written.contains("summarise") {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        t.close().unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        let steer = written
            .lines()
            .find(|l| l.contains("summarise"))
            .unwrap_or_else(|| panic!("the steer never reached stdin; got: {written}"));
        // A `user` frame, the same shape a turn takes: the CLI has no separate
        // wire form for a steer, and inventing one would fail the turn.
        assert!(steer.contains("\"type\":\"user\""), "the steer must ride the user frame: {steer}");
    }

    /// Unparseable stdout is reported without killing the session, because one
    /// malformed frame is worth less than a live session.
    #[test]
    fn an_unparseable_line_is_reported_without_ending_the_session() {
        let seen: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = seen.clone();
        let sink = new_sink(Box::new(move |ev| collected.lock().unwrap().push(ev)));

        let mut t = ClaudeTransport::new("s-garbage");
        let spec = StartSpec {
            session_id: "s-garbage".into(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "printf 'not json\\n'; cat > /dev/null".into()],
            ..Default::default()
        };
        t.start(spec, sink).unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        let events = seen.lock().unwrap().clone();
        t.close().unwrap();
        assert!(
            matches!(events.first(), Some(ChatEvent::SessionError { fatal: false, .. })),
            "expected a non-fatal parse error, got {events:?}"
        );
    }

    // Measured on claude 2.1.258: a session not launched bypass-capable answers
    // `set_permission_mode bypassPermissions` with an error and stays in the
    // mode it was in, so nothing later on the wire contradicts the pick.
    #[test]
    fn a_refused_switch_becomes_an_event_naming_the_mode_and_the_reason() {
        let shared = shared();
        guarded(&shared.mode_requests).insert("r1".into(), PermissionMode::new("bypassPermissions"));
        let frame = json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": "r1",
                "error": "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions",
            },
        });
        match mode_refusal(&shared, &frame) {
            Some(ChatEvent::ModeRefused { mode, reason, .. }) => {
                assert_eq!(mode.as_str(), "bypassPermissions");
                assert!(reason.contains("--dangerously-skip-permissions"), "got {reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(guarded(&shared.mode_requests).is_empty(), "the request is spent");
    }

    #[test]
    fn a_switch_the_agent_took_reports_nothing_and_stops_being_tracked() {
        let shared = shared();
        guarded(&shared.mode_requests).insert("r1".into(), PermissionMode::new("plan"));
        let frame = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "r1", "response": { "mode": "plan" } },
        });
        assert!(mode_refusal(&shared, &frame).is_none());
        // Confirmed by the next init instead, so holding the entry would only
        // leave it to be reported against some later request id.
        assert!(guarded(&shared.mode_requests).is_empty());
    }

    #[test]
    fn an_error_for_a_different_request_leaves_the_mode_switch_outstanding() {
        let shared = shared();
        guarded(&shared.mode_requests).insert("r1".into(), PermissionMode::new("plan"));
        let frame = json!({
            "type": "control_response",
            "response": { "subtype": "error", "request_id": "r2", "error": "unknown model" },
        });
        assert!(mode_refusal(&shared, &frame).is_none());
        assert_eq!(guarded(&shared.mode_requests).len(), 1);
    }
}
