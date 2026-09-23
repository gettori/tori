//! The seam between the chat host and whatever agent is actually driving a
//! session.
//!
//! [`AgentTransport`] is deliberately the *only* thing the host knows about a
//! agent. `chat/claude.rs` maps Claude's wire format and `ClaudeTransport`
//! drives its process; a second agent is a second implementor plus a TOML
//! `[chat]` table, with no branch anywhere in the host.
//!
//! Two shapes here are load-bearing rather than incidental:
//!
//!   * **The sink is a closure behind a swappable slot**, not a Tauri `Channel`.
//!     A transport that referenced `Channel` directly could only be tested
//!     inside a Tauri app; injecting the emit closure is the same move
//!     `askpass.rs` makes, and it is what lets the whole of Phase 3 be tested
//!     headlessly. `chat_spawn` wraps a real `Channel` in that closure at the
//!     command boundary and nowhere else.
//!   * **`start` takes an explicit env map** from day one. Multi-account is out
//!     of scope for now, but adding it later must not touch every call site, so
//!     the parameter exists before there is anything to put in it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::model::{
    ChatConfigValue, ChatEvent, ContentBlock, PermissionDecision, PermissionMode, PermissionScope,
    QuestionAnswer,
};

/// Delivers one event to whoever is currently listening to a session.
pub type Emit = Box<dyn Fn(ChatEvent) + Send + Sync>;

/// The swappable slot holding that closure, mirroring [`crate::pty`]'s sink: a
/// remount re-subscribes by replacing the closure, and a session with no
/// listener drops its events rather than blocking the reader thread.
pub type Sink = Arc<Mutex<Option<Emit>>>;

pub fn new_sink(emit: Emit) -> Sink {
    Arc::new(Mutex::new(Some(emit)))
}

/// Send one event to the sink's current listener, if any.
///
/// Silent when nobody is listening. That is correct rather than lossy: the
/// transcript's durable record is the agent's own on-disk one, and blocking a
/// reader thread on an absent UI would wedge the child process.
pub fn emit(sink: &Sink, event: ChatEvent) {
    if let Ok(guard) = sink.lock() {
        if let Some(f) = guard.as_ref() {
            f(event);
        }
    }
}

/// Everything needed to launch one session's child process.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StartSpec {
    pub session_id: String,
    pub cwd: String,
    pub program: String,
    pub args: Vec<String>,
    /// Extra environment for the child, layered on top of the inherited one.
    /// Empty today; the parameter exists so multi-account support later is a
    /// change at one call site rather than a signature change everywhere.
    pub env: HashMap<String, String>,
}

/// Build the child command for a spec. Shared by every transport so PATH
/// handling and env layering cannot drift between them.
pub fn build_command(spec: &StartSpec) -> std::process::Command {
    let mut cmd = std::process::Command::new(&spec.program);
    cmd.args(&spec.args);
    if !spec.cwd.is_empty() {
        cmd.current_dir(&spec.cwd);
    }
    // No login shell runs to set PATH for a directly-spawned child, so the
    // agent binary would be unfindable without this - the same reason
    // `pty.rs`'s `command` tabs use it.
    cmd.env("PATH", crate::env::augmented_path());
    cmd.envs(crate::credential::spawn_env());
    cmd.envs(crate::rpc::child_env());
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    cmd
}

/// One live agent session, driven as a long-lived process.
///
/// Every method returns `Result` rather than emitting on failure, so the host
/// decides whether a failure is fatal to the session. Transports still emit
/// [`ChatEvent::SessionError`] for failures that arrive *asynchronously* (the
/// child dying between commands), which no return value could carry.
pub trait AgentTransport: Send {
    /// Launch the child and begin streaming events into `sink`. Must return
    /// once the process is up; reading is the transport's own concern.
    fn start(&mut self, spec: StartSpec, sink: Sink) -> Result<(), String>;

    /// Submit a user turn.
    fn send(&mut self, blocks: &[ContentBlock]) -> Result<(), String>;

    /// Deliver a message into the turn that is already running.
    ///
    /// Separate from [`Self::send`] rather than a flag on it, because the two
    /// differ in what they are allowed to carry: `send` also flushes whatever
    /// mode or model switch is queued for the next turn, and a steer must not
    /// spend that switch on a turn already under way. A agent that buffers
    /// stdin to turn end has no honest implementation of this and should return
    /// an error rather than degrade into a queued turn, which the caller cannot
    /// tell apart from a steer that landed.
    fn steer(&mut self, blocks: &[ContentBlock]) -> Result<(), String>;

    /// Ask the agent to abandon the running turn.
    fn interrupt(&mut self) -> Result<(), String>;

    /// Answer a blocked permission request, if this transport is what is
    /// blocked on it.
    ///
    /// **Returns whether the request was ours.** A prompt can reach the user
    /// from two places - the agent asking in-protocol, and Tori's own
    /// `PreToolUse` bridge blocking on a socket - and the answer must go back to
    /// whichever one is waiting. `Ok(false)` means "not mine, try the other
    /// route"; answering the wrong one would leave the real waiter hanging until
    /// its deadline, turning a click on Allow into a denial.
    fn respond_permission(
        &mut self,
        tool_use_id: &str,
        request_id: &str,
        decision: PermissionDecision,
        scope: PermissionScope,
        reason: Option<&str>,
    ) -> Result<bool, String>;

    /// Answer a blocked question, if this transport is what is blocked on it.
    ///
    /// **Returns whether the request was ours**, exactly as
    /// [`Self::respond_permission`] does and for the same reason: `Ok(false)`
    /// means "not mine", and it is how a stale answer stays a no-op instead of
    /// resolving something it does not own.
    ///
    /// An agent with no wire form for a question must return an error rather
    /// than `Ok(true)`. A silent success is the one answer the caller cannot
    /// tell apart from the form having landed, which would leave the agent
    /// blocked with the user believing they replied.
    fn respond_question(
        &mut self,
        tool_use_id: &str,
        request_id: &str,
        answers: &[QuestionAnswer],
    ) -> Result<bool, String>;

    /// Applies from the **next** turn, never the running one.
    fn set_mode(&mut self, mode: PermissionMode) -> Result<(), String>;

    /// Same next-turn semantics as [`Self::set_mode`].
    fn set_model(&mut self, model: &str, effort: Option<String>) -> Result<(), String>;

    /// Set one of the agent's **own** configuration options, by the id it
    /// published for it.
    ///
    /// Separate from [`Self::set_model`] and [`Self::set_mode`] because those
    /// two have Tori-side state behind them (a pending pick, a permission
    /// story) and this one has none: Tori does not know what the option
    /// governs, so it forwards the switch and renders whatever the agent says
    /// afterwards.
    ///
    /// A agent that publishes no such options **errors** rather than
    /// succeeding silently. Nothing can reach this without a mirror to click
    /// in, so a quiet `Ok(())` here would only ever hide a routing bug.
    fn set_config_option(&mut self, config_id: &str, value: &ChatConfigValue)
        -> Result<(), String>;

    /// Ask the agent to hand its conversation over again, and say whether it
    /// will.
    ///
    /// **The answer decides what the host tells the newly attached UI**, so it
    /// has to be given before the replay happens rather than reported after.
    /// `true` promises that a `SessionStarted` is coming and that whatever
    /// arrives before it is the conversation; `false` means the host announces
    /// the session itself and nothing further is on its way.
    ///
    /// Only a transport whose history reached the UI as a *replay* has anything
    /// to do here. Where the agent writes a transcript the UI re-reads on every
    /// mount, that read has already happened and the honest answer is `false`.
    fn replay(&mut self) -> Result<bool, String>;

    /// Terminate the child. Must be idempotent: the host calls it on tab close,
    /// and again on app exit for anything still in the map.
    fn close(&mut self) -> Result<(), String>;

    /// The child's pid, for the persisted claim's orphan record. `None` before
    /// `start` or after the child has been reaped.
    fn child_pid(&self) -> Option<u32>;
}

/// The trait's test double. It lives beside the trait rather than in the host's
/// test module because the host, the ownership tests and the command tests all
/// drive it, and three copies would drift.
#[cfg(test)]
pub(crate) mod mock {
    use super::*;

    #[derive(Default)]
    pub struct MockTransport {
        pub started: Vec<StartSpec>,
        pub sent: Vec<Vec<ContentBlock>>,
        /// Kept apart from `sent` so a test can assert which verb a caller used,
        /// which is the whole point of the two being distinct.
        pub steered: Vec<Vec<ContentBlock>>,
        pub interrupts: u32,
        /// Every mirrored switch, so a test can assert the id and value that
        /// actually left rather than that something was called.
        pub config_switches: Vec<(String, ChatConfigValue)>,
        /// The answers `respond_question` was handed, so a test can assert the
        /// form arrived intact rather than that a call happened.
        pub answered: Vec<Vec<QuestionAnswer>>,
        /// What `replay` should answer, and how often it was asked. Both,
        /// because the host branches on the answer and a test needs to pin the
        /// branch as well as the call.
        pub can_replay: bool,
        pub replays: u32,
        pub closed: bool,
        sink: Option<Sink>,
    }

    impl AgentTransport for MockTransport {
        fn start(&mut self, spec: StartSpec, sink: Sink) -> Result<(), String> {
            self.started.push(spec);
            self.sink = Some(sink);
            Ok(())
        }
        fn send(&mut self, blocks: &[ContentBlock]) -> Result<(), String> {
            self.sent.push(blocks.to_vec());
            Ok(())
        }
        fn steer(&mut self, blocks: &[ContentBlock]) -> Result<(), String> {
            self.steered.push(blocks.to_vec());
            Ok(())
        }
        fn interrupt(&mut self) -> Result<(), String> {
            self.interrupts += 1;
            Ok(())
        }
        fn respond_permission(
            &mut self,
            _tool_use_id: &str,
            _request_id: &str,
            _decision: PermissionDecision,
            _scope: PermissionScope,
            _reason: Option<&str>,
        ) -> Result<bool, String> {
            Ok(false)
        }
        fn respond_question(
            &mut self,
            _tool_use_id: &str,
            _request_id: &str,
            answers: &[QuestionAnswer],
        ) -> Result<bool, String> {
            self.answered.push(answers.to_vec());
            Ok(true)
        }
        fn set_mode(&mut self, _mode: PermissionMode) -> Result<(), String> {
            Ok(())
        }
        fn set_model(&mut self, _model: &str, _effort: Option<String>) -> Result<(), String> {
            Ok(())
        }
        fn set_config_option(
            &mut self,
            config_id: &str,
            value: &ChatConfigValue,
        ) -> Result<(), String> {
            self.config_switches.push((config_id.to_string(), value.clone()));
            Ok(())
        }
        fn replay(&mut self) -> Result<bool, String> {
            self.replays += 1;
            Ok(self.can_replay)
        }
        fn close(&mut self) -> Result<(), String> {
            self.closed = true;
            Ok(())
        }
        fn child_pid(&self) -> Option<u32> {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::mock::MockTransport;
    use super::*;
    use std::io::Read;

    /// A mock alone would only prove the trait compiles, so this spawns the
    /// command `build_command` actually produces and reads the variable back out
    /// of the child. If the env map ever stopped reaching the process, the value
    /// printed here would be empty.
    #[test]
    fn the_env_map_reaches_the_spawned_command() {
        let spec = StartSpec {
            session_id: "s1".to_string(),
            cwd: String::new(),
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "printf '%s' \"$TORI_CHAT_TEST\"".to_string()],
            env: HashMap::from([("TORI_CHAT_TEST".to_string(), "reached".to_string())]),
        };
        let mut child = build_command(&spec)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("the mock command should spawn");
        let mut out = String::new();
        child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
        let _ = child.wait();
        assert_eq!(out, "reached");
    }

    /// A transport must be usable as a boxed object: the host holds
    /// `Box<dyn AgentTransport>`, so an accidentally non-object-safe method
    /// (a generic parameter, a `Self` return) would break it here first.
    #[test]
    fn the_trait_is_object_safe_and_the_mock_records_calls() {
        let mut t: Box<dyn AgentTransport> = Box::<MockTransport>::default();
        let sink = new_sink(Box::new(|_| {}));
        t.start(StartSpec::default(), sink).unwrap();
        t.send(&[ContentBlock::Text { text: "hi".to_string() }]).unwrap();
        t.interrupt().unwrap();
        t.close().unwrap();

        // Read off a concrete mock rather than the boxed one: through
        // `Box<dyn AgentTransport>` there is no way back to the type, which is
        // the whole reason the boxed half above can only prove object safety.
        let answers = vec![QuestionAnswer {
            question: "Which answer channel?".to_string(),
            picks: vec!["In protocol".to_string()],
            free_text: None,
        }];
        let mut mock = MockTransport::default();
        assert!(mock.respond_question("toolu_4", "op-10", &answers).unwrap());
        assert_eq!(mock.answered, vec![answers], "the form must arrive intact, not merely arrive");
    }

    /// A sink with no listener must drop events rather than panic or block: the
    /// reader thread runs even while a tab is unmounted.
    #[test]
    fn an_unlistened_sink_drops_events() {
        let sink: Sink = Arc::new(Mutex::new(None));
        emit(
            &sink,
            ChatEvent::SessionEnded { session_id: "s".to_string(), reason: None },
        );
    }
}
