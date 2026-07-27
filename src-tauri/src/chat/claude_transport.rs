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

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

use super::claude::ClaudeMapper;
use super::model::{ChatEvent, ContentBlock, Effort, PermissionDecision, PermissionMode, PermissionScope};
use super::transport::{build_command, emit, AgentTransport, Sink, StartSpec};

/// How much stderr to keep. Enough to carry a usage error or a stack trace's
/// first frames; bounded so a chatty child cannot grow this without limit.
const STDERR_TAIL: usize = 4096;

/// Per-session state the reader thread and the command methods share.
struct Shared {
    session_id: String,
    /// Set once the session has ended, so a late reader-thread error cannot
    /// resurrect a session the user already closed.
    finished: AtomicBool,
    stderr_tail: Mutex<String>,
}

pub struct ClaudeTransport {
    shared: Arc<Shared>,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
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
            }),
            child: None,
            stdin: None,
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
        let stdin = self.stdin.as_mut().ok_or("chat session is not running")?;
        writeln!(stdin, "{frame}").map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())
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
        self.stdin = Some(stdin);

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
                            for event in mapper.map(&frame) {
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
                "request": { "subtype": "set_permission_mode", "mode": mode_wire(mode) },
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

    fn interrupt(&mut self) -> Result<(), String> {
        let request_id = self.next_request_id();
        self.write_frame(&json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "interrupt" },
        }))
    }

    fn respond_permission(
        &mut self,
        _tool_use_id: &str,
        _request_id: &str,
        _decision: PermissionDecision,
        _scope: PermissionScope,
        _reason: Option<&str>,
    ) -> Result<(), String> {
        // Permission answers do not travel over the child's stdin at all: the
        // `PreToolUse` hook is the gate, and it blocks on Sway's own socket.
        // Phase 4 owns that socket; until it exists there is nothing blocked to
        // answer, so this reports rather than pretending to have delivered one.
        Err("permission answers arrive over the approval bridge, which Phase 4 builds".to_string())
    }

    fn set_mode(&mut self, mode: PermissionMode) -> Result<(), String> {
        self.pending_mode = Some(mode);
        Ok(())
    }

    fn set_model(&mut self, model: &str, effort: Option<Effort>) -> Result<(), String> {
        self.pending_model = Some((model.to_string(), effort));
        Ok(())
    }

    fn close(&mut self) -> Result<(), String> {
        // Marked finished *before* the kill so the reader thread's EOF does not
        // also report a death the user asked for.
        self.shared.finished.store(true, Ordering::SeqCst);
        // Dropping stdin is the graceful half; the kill covers a child that is
        // mid-turn and not reading it.
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            abandon(&mut child);
        }
        Ok(())
    }

    fn child_pid(&self) -> Option<u32> {
        self.child.as_ref().map(|c| c.id())
    }
}

fn mode_wire(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default => "default",
        PermissionMode::AcceptEdits => "acceptEdits",
        PermissionMode::Plan => "plan",
        PermissionMode::BypassPermissions => "bypassPermissions",
    }
}

fn effort_wire(effort: Effort) -> &'static str {
    match effort {
        Effort::Low => "low",
        Effort::Medium => "medium",
        Effort::High => "high",
        Effort::Xhigh => "xhigh",
        Effort::Max => "max",
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::chat::transport::new_sink;
    use std::collections::HashMap;

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
        t.set_mode(PermissionMode::Plan).unwrap();
        t.set_model("claude-opus-5", Some(Effort::High)).unwrap();
        assert_eq!(t.pending_mode, Some(PermissionMode::Plan));
        assert_eq!(t.pending_model, Some(("claude-opus-5".to_string(), Some(Effort::High))));
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
                args: crate::chat::commands::build_args(chat, session_id, false, None, None, None, &[]),
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
