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

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::claude::ClaudeMapper;
use super::model::{
    ChatConfigValue, ChatEvent, ContentBlock, Effort, PermissionDecision, PermissionMode, PermissionScope,
    PermissionSuggestion,
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
    /// Set once the session has ended, so a late reader-thread error cannot
    /// resurrect a session the user already closed.
    finished: AtomicBool,
    stderr_tail: Mutex<String>,
    /// The child's stdin. Shared rather than owned by the transport because
    /// three writers need it and two of them are not on the command path: the
    /// auto-deny timer and the teardown that denies whatever is still pending.
    stdin: Mutex<Option<ChildStdin>>,
    /// `request_id`s of permission questions the child is blocked on.
    ///
    /// A request leaves this set exactly once, whoever gets there first: the
    /// user, the deadline, or a teardown. That is what makes "answered twice"
    /// impossible and, more importantly, makes "never answered" impossible too.
    pending: Mutex<HashSet<String>>,
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
        let claimed = guarded(&self.pending).remove(request_id);
        if claimed {
            guarded(&self.granted_rules).remove(request_id);
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
        let outstanding: Vec<String> = guarded(&self.pending).drain().collect();
        guarded(&self.granted_rules).clear();
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
    pending_model: Option<(String, Option<Effort>)>,
}

impl ClaudeTransport {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            shared: Arc::new(Shared {
                session_id: session_id.into(),
                finished: AtomicBool::new(false),
                stderr_tail: Mutex::new(String::new()),
                stdin: Mutex::new(None),
                pending: Mutex::new(HashSet::new()),
                settled: Condvar::new(),
                granted_rules: Mutex::new(HashMap::new()),
            }),
            child: None,
            request_seq: AtomicU64::new(0),
            pending_mode: None,
            pending_model: None,
        }
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
        .map(|b| match b {
            ContentBlock::Text { text } => json!({ "type": "text", "text": text }),
            ContentBlock::Image { media_type, data } => json!({
                "type": "image",
                "source": { "type": "base64", "media_type": media_type, "data": data },
            }),
            ContentBlock::FileRef { path, start_line, end_line, text } => {
                let mut rendered = match (start_line, end_line) {
                    (Some(s), Some(e)) => format!("@{path}#L{s}-{e}"),
                    (Some(s), None) => format!("@{path}#L{s}"),
                    _ => format!("@{path}"),
                };
                if let Some(t) = text {
                    rendered.push_str("\n\n");
                    rendered.push_str(t);
                }
                json!({ "type": "text", "text": rendered })
            }
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
/// Register a permission question as outstanding and start the clock on it.
///
/// Returns the wall-clock instant Sway will deny at, which rides out on the
/// event so the prompt can show a countdown that matches what actually happens
/// rather than one the UI invented.
///
/// The timer waits on the `settled` condvar rather than sleeping, so answering a
/// prompt retires its thread at once instead of leaving it parked for the rest
/// of the deadline. It still only *tries* to answer on expiry: `Shared::claim`
/// remains the single place that decides whether a question is outstanding, so a
/// user clicking at 109.9s wins and the timer's write is dropped. The wait is a
/// loop because a condvar may wake spuriously and because `notify_all` wakes
/// every armed timer, not only the one whose question was settled.
fn arm_auto_deny(shared: &Arc<Shared>, request_id: String) -> u64 {
    guarded(&shared.pending).insert(request_id.clone());
    let deadline = now_ms() + DECIDE_TIMEOUT_SECS * 1000;
    let shared = shared.clone();
    thread::spawn(move || {
        let expires_at = Instant::now() + Duration::from_secs(DECIDE_TIMEOUT_SECS);
        let mut pending = guarded(&shared.pending);
        while pending.contains(&request_id) {
            let Some(left) = expires_at.checked_duration_since(Instant::now()) else { break };
            if left.is_zero() {
                break;
            }
            pending = match shared.settled.wait_timeout(pending, left) {
                Ok((guard, _)) => guard,
                Err(e) => e.into_inner().0,
            };
        }
        let expired = pending.contains(&request_id);
        // Never hold the pending lock across the write: `answer` takes it again
        // through `claim`, and takes stdin after it.
        drop(pending);
        if expired {
            let _ = shared.answer(
                &request_id,
                json!({
                    "behavior": "deny",
                    "message": format!(
                        "Sway denied this automatically: nobody answered within {DECIDE_TIMEOUT_SECS} seconds. \
                         Ask again if you still need it."
                    ),
                }),
            );
        }
    });
    deadline
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
            });
        }

        // The reader: one JSON frame per line, mapped and emitted.
        {
            let shared = self.shared.clone();
            let sink = sink.clone();
            let mut mapper = ClaudeMapper::new(shared.session_id.clone());
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(line) {
                        Ok(frame) => {
                            for mut event in mapper.map(&frame) {
                                // The mapper turns the frame into an event; the
                                // deadline is armed here, because the transport
                                // is the half that can actually answer.
                                if let ChatEvent::PermissionRequest {
                                    request_id, auto_deny_at_ms, suggestions, ..
                                } = &mut event
                                {
                                    shared.remember_grant(request_id, suggestions);
                                    *auto_deny_at_ms = Some(arm_auto_deny(&shared, request_id.clone()));
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
                // EOF on stdout means the child is going away. Report it exactly
                // once: a `close()` that already ended the session has nothing
                // to add, and a second fatal event would confuse the host's reap.
                if !shared.finished.swap(true, Ordering::SeqCst) {
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
                request["effort"] = json!(effort_wire(effort));
            }
            let _ = self.write_frame(&json!({
                "type": "control_request",
                "request_id": request_id,
                "request": request,
            }));
        }
        self.write_frame(&turn_frame(blocks))
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

    fn interrupt(&mut self) -> Result<(), String> {
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

    fn set_mode(&mut self, mode: PermissionMode) -> Result<(), String> {
        self.pending_mode = Some(mode);
        Ok(())
    }

    fn set_model(&mut self, model: &str, effort: Option<Effort>) -> Result<(), String> {
        self.pending_model = Some((model.to_string(), effort));
        Ok(())
    }

    /// Claude publishes no configuration options of its own: its model, effort
    /// and permission mode are flags, and each already has a control. So there
    /// is nothing for a mirror to show here and nothing this could forward.
    fn set_config_option(
        &mut self,
        _config_id: &str,
        _value: &ChatConfigValue,
    ) -> Result<(), String> {
        Err("this agent publishes no session options to switch".to_string())
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

/// Both agents spell these the same, so the mapping lives on the enum and
/// this is the name the call site reads by.
fn effort_wire(effort: Effort) -> &'static str {
    effort.as_str()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::chat::transport::new_sink;
    use std::collections::HashMap;

    fn shared() -> Arc<Shared> {
        Arc::new(Shared {
            session_id: "s1".into(),
            finished: AtomicBool::new(false),
            stderr_tail: Mutex::new(String::new()),
            // No child: every write fails, which is exactly the condition these
            // tests want. They are about *which* questions get answered and how
            // many times, not about the bytes reaching a pipe.
            stdin: Mutex::new(None),
            pending: Mutex::new(HashSet::new()),
            settled: Condvar::new(),
            granted_rules: Mutex::new(HashMap::new()),
        })
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
        shared.pending.lock().unwrap().insert("req-1".into());

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
            pending.insert("req-1".into());
            pending.insert("req-2".into());
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
        shared.pending.lock().unwrap().insert("req-1".into());
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
        let deadline = arm_auto_deny(&shared, "req-1".into());

        assert!(shared.pending.lock().unwrap().contains("req-1"), "an armed question must be pending");
        assert!(deadline >= before + DECIDE_TIMEOUT_SECS * 1000);
        assert!(DECIDE_TIMEOUT_SECS < super::super::approval::HOOK_TIMEOUT_SECS);
    }

    /// The timer must retire when its question is answered, not sleep out the
    /// full 110s. Asserted by joining the waiter: a `thread::sleep` version
    /// would still be parked and this would hang instead of returning.
    #[test]
    fn answering_retires_the_armed_timer_immediately() {
        let shared = shared();
        guarded(&shared.pending).insert("req-1".into());

        let waiter = {
            let shared = shared.clone();
            thread::spawn(move || {
                let expires_at = Instant::now() + Duration::from_secs(DECIDE_TIMEOUT_SECS);
                let mut pending = guarded(&shared.pending);
                while pending.contains("req-1") {
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
        }]);
        assert_eq!(frame["message"]["content"][0]["text"], "@README.md");
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
        t.set_model("claude-opus-5", Some(Effort::High)).unwrap();
        assert_eq!(t.pending_mode, Some(PermissionMode::new("plan")));
        assert_eq!(t.pending_model, Some(("claude-opus-5".to_string(), Some(Effort::High))));
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
        t.set_model("claude-opus-5", Some(Effort::High)).unwrap();

        let blocks = [ContentBlock::Text { text: "stop reading, just summarise".to_string() }];
        assert!(t.steer(&blocks).is_err(), "no child, so the write itself cannot succeed");
        assert_eq!(t.pending_mode, Some(PermissionMode::new("plan")), "the steer must not spend the mode switch");
        assert_eq!(
            t.pending_model,
            Some(("claude-opus-5".to_string(), Some(Effort::High))),
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
}
