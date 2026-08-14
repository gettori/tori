//! The process-wide chat session host.
//!
//! Structurally this is [`crate::pty`]'s session map with a different payload:
//! a map keyed by session id, each entry owning a child, a swappable sink and a
//! generation counter, so a remount re-subscribes instead of restarting. Copying
//! that shape rather than inventing one keeps the two hosts' lifecycles legible
//! side by side, and the idempotent-spawn behaviour is already proven there.
//!
//! What is *not* copied is death handling. A PTY tab can leave a dead shell on
//! screen and that is fine, even useful. A chat session that dies has to say so
//! and let go of its session id, or the id stays unclaimable until Sway
//! restarts. So the host wraps every caller's emit closure in one of its own,
//! and a fatal event flowing through that wrapper is what drops the map entry
//! and releases the ownership claim - one path, whether the child died on its
//! own, was killed, or failed to start.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::approval::{self, ApprovalServer};
use super::model::{ChatCommand, ChatEvent, ContentBlock, Effort, PermissionDecision, PermissionMode, PermissionScope};
use super::ownership::Registry;
use super::pacing::{monotonic_clock, Pacer, HIDDEN_RELEASE_MS};
use super::snapshot::SnapshotCache;
use super::transport::{emit, new_sink, AgentTransport, Emit, Sink, StartSpec};

/// What a spawn call actually did, so a caller can tell a fresh session from a
/// re-subscribe without inspecting the map itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Spawned {
    Started,
    Rewired,
}

struct Entry {
    /// What the *transport* emits into. Fixed for the session's life: its
    /// closure hands every event to the pacer and nothing else, so there is
    /// nothing here for a remount to swap.
    sink: Sink,
    /// What the *UI* is listening on, which is the slot a remount replaces. The
    /// pacer holds the same handle and releases into it.
    listener: Sink,
    pacer: Arc<Pacer>,
    transport: Arc<Mutex<Box<dyn AgentTransport>>>,
    tab_id: String,
    /// Bumped on every re-subscribe. Not used for routing (the listener swap
    /// does that); it exists so a late callback from a previous subscription
    /// can be recognised as stale rather than acted on.
    generation: u64,
}

type Sessions = Arc<Mutex<HashMap<String, Entry>>>;

/// The approval and snapshot machinery for one session.
///
/// Held beside the session rather than inside the transport: the transport
/// drives the harness's stdin, while this rides the harness's *hook*, and the
/// two only meet at the session id. Keeping them separate is also what lets a
/// second harness reuse the bridge unchanged if its own hook mechanism matches.
pub struct SessionBridge {
    pub server: Arc<ApprovalServer>,
    pub snapshots: Arc<Mutex<SnapshotCache>>,
    /// Keeps the liveness-stamp refresher running. Cleared on teardown, which is
    /// what makes an orphaned child's next allow-listed tool call fail closed:
    /// nobody is refreshing the stamp any more.
    stamping: Arc<std::sync::atomic::AtomicBool>,
    session_id: String,
}

impl SessionBridge {
    pub fn new(server: Arc<ApprovalServer>, snapshots: Arc<Mutex<SnapshotCache>>, session_id: &str) -> Self {
        let stamping = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let flag = stamping.clone();
        let id = session_id.to_string();
        std::thread::spawn(move || {
            loop {
                // Checked immediately before the write, not only at the top of
                // the loop. `teardown` clears the flag and *then* removes the
                // rules file, so a refresher waking from its sleep in between
                // would write the file back - leaving a rules file naming a live
                // Sway pid, which would pre-approve a later session that reused
                // the id. Exactly what teardown exists to prevent.
                if !flag.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                approval::refresh_stamp(&id);
                std::thread::sleep(std::time::Duration::from_millis(super::rules::STAMP_REFRESH_MS));
            }
        });
        Self { server, snapshots, stamping, session_id: session_id.to_string() }
    }

    /// Stop supervising. The stamp stops being refreshed, so any rule this
    /// session's rules file holds goes stale within the TTL and stops being
    /// honoured - the same fate a crashed Sway's rules meet.
    pub fn teardown(&self) {
        self.stamping.store(false, std::sync::atomic::Ordering::SeqCst);
        self.server.shutdown();
        // The rules file goes with the session: a rule is scoped to the chat
        // that created it, and leaving it behind would silently pre-approve a
        // later session that happened to reuse the id.
        let _ = std::fs::remove_file(super::rules::rules_path(&self.session_id));
        // The settings file holds this session's socket path and token, for a
        // socket that no longer exists. Nothing should be able to read it back.
        let _ = std::fs::remove_file(approval::settings_path(&self.session_id));
    }
}

/// The host. One per app, managed as Tauri state by `lib.rs`.
#[derive(Default)]
pub struct ChatHost {
    sessions: Sessions,
    pub registry: Arc<Registry>,
    /// One per live session, installed by `chat_spawn` once its socket exists.
    bridges: Arc<Mutex<HashMap<String, SessionBridge>>>,
}

/// Tauri state wrapper, matching `PtyState`'s shape.
#[derive(Default)]
pub struct ChatState(pub ChatHost);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        // A panicked holder must not wedge every future chat command; the map
        // and the transports behind it stay structurally valid either way.
        Err(e) => e.into_inner(),
    }
}

/// Is this event the end of a session's life?
///
/// A non-fatal `SessionError` is deliberately not: a single unparseable stdout
/// line is worth surfacing but not worth tearing a working session down over.
fn ends_session(event: &ChatEvent) -> bool {
    matches!(
        event,
        ChatEvent::SessionEnded { .. } | ChatEvent::SessionError { fatal: true, .. }
    )
}

/// Which of the two gates took an answer.
///
/// The caller needs this because the two persist a durable "and stop asking"
/// differently: the harness was handed the grant in the answer itself, as
/// `updatedPermissions`, while the bridge has no such channel and relies on
/// Sway's own rule store. Writing both for one click would leave two records of
/// one decision, in two formats, only one of which the harness ever reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnsweredBy {
    Harness,
    Bridge,
}

/// The `PreToolUse` bridge's vocabulary for a decision.
///
/// Lives here rather than beside the Tauri command because the host is what
/// routes an answer now, and nothing below `commands.rs` may depend on it.
/// Both defaults name who decided: the reason reaches the model as the tool
/// result, and a bare "Denied." tells it nothing about where to go next.
pub(super) fn hook_response_for(decision: PermissionDecision, reason: Option<&str>) -> approval::HookResponse {
    let said = reason.map(str::to_string);
    match decision {
        PermissionDecision::Allow => approval::HookResponse::allow(said.unwrap_or_else(|| "Allowed in Sway.".into())),
        PermissionDecision::Deny => approval::HookResponse::deny(said.unwrap_or_else(|| "Denied in Sway.".into())),
    }
}

impl ChatHost {
    /// Test-only: a host whose registry persists to `path` rather than the real
    /// `chat-claims.json`, so a test run cannot drop a live session's claim out
    /// from under a running Sway.
    #[cfg(test)]
    fn at(path: std::path::PathBuf) -> Self {
        Self { sessions: Sessions::default(), registry: Arc::new(Registry::at(path)), bridges: Arc::default() }
    }

    /// Attach a session's approval bridge, once `chat_spawn` has bound its
    /// socket. Separate from `spawn` because the socket has to exist *before*
    /// the child is launched - its path goes into the `--settings` payload the
    /// child is started with.
    pub fn install_bridge(&self, session_id: &str, bridge: SessionBridge) {
        if let Some(previous) = lock(&self.bridges).insert(session_id.to_string(), bridge) {
            previous.teardown();
        }
    }

    /// A sender that can reach any live session's sink later.
    ///
    /// The approval server is built before the session exists, so its emit
    /// closure cannot capture a sink; it captures this instead and resolves the
    /// sink at emit time. A call for a session that has since gone is dropped,
    /// which is correct: its tool call is being denied anyway.
    pub fn emitter(&self) -> impl Fn(&str, ChatEvent) + Send + Sync + 'static {
        let sessions = self.sessions.clone();
        move |session_id, event| {
            let sink = lock(&sessions).get(session_id).map(|e| e.sink.clone());
            if let Some(sink) = sink {
                emit(&sink, event);
            }
        }
    }

    /// This session's snapshot cache, for a card the user expanded.
    pub fn snapshots(&self, session_id: &str) -> Option<Arc<Mutex<SnapshotCache>>> {
        lock(&self.bridges).get(session_id).map(|b| b.snapshots.clone())
    }

    /// Answer a blocked tool call, sending the answer to whichever of the two
    /// gates is actually waiting on it.
    ///
    /// **The transport is asked first, and its answer decides.** A prompt reaches
    /// the user either from the harness asking in-protocol or from Sway's
    /// `PreToolUse` bridge blocking on a socket, and the two have separate
    /// request-id spaces. Only the transport can say whether an id is one of its
    /// outstanding `can_use_tool` questions, so it is asked, and the bridge is
    /// the fallback for everything it disclaims. Guessing the other way round -
    /// answering the socket first - would resolve nothing when the harness was
    /// the one waiting, and the click would land as a deadline denial instead.
    pub fn answer_permission(
        &self,
        session_id: &str,
        tool_use_id: &str,
        request_id: &str,
        decision: PermissionDecision,
        scope: PermissionScope,
        reason: Option<&str>,
    ) -> Result<AnsweredBy, String> {
        let transport = lock(&self.sessions).get(session_id).map(|e| e.transport.clone());
        if let Some(transport) = transport {
            if lock(&transport).respond_permission(tool_use_id, request_id, decision, scope, reason)? {
                return Ok(AnsweredBy::Harness);
            }
        }
        self.resolve_permission(session_id, request_id, hook_response_for(decision, reason))?;
        Ok(AnsweredBy::Bridge)
    }

    /// Answer a blocked tool call over the `PreToolUse` bridge specifically.
    pub fn resolve_permission(&self, session_id: &str, request_id: &str, resp: approval::HookResponse) -> Result<(), String> {
        let server = lock(&self.bridges).get(session_id).map(|b| b.server.clone());
        let Some(server) = server else { return Err(format!("no approval bridge for session {session_id}")) };
        approval::resolve(&server, request_id, resp);
        Ok(())
    }

    /// Tear a session's bridge down. Everything currently blocked is denied
    /// rather than left to time out, since nobody is left who could answer it.
    fn drop_bridge(&self, session_id: &str) {
        if let Some(bridge) = lock(&self.bridges).remove(session_id) {
            bridge.teardown();
        }
    }

    /// Start a session, or re-subscribe an existing one.
    ///
    /// A second call for a live id **rewires the sink and returns without
    /// touching the child**, which is what makes a tab remount free. `make` is
    /// consumed only on the spawning path, so a caller can observe that no
    /// second process was created.
    pub fn spawn(
        &self,
        session_id: &str,
        tab_id: &str,
        emit: Emit,
        spec: StartSpec,
        make: impl FnOnce() -> Box<dyn AgentTransport>,
    ) -> Result<Spawned, String> {
        {
            let mut guard = lock(&self.sessions);
            if let Some(entry) = guard.get_mut(session_id) {
                *lock(&entry.listener) = Some(self.wrap(session_id, emit));
                entry.generation += 1;
                return Ok(Spawned::Rewired);
            }
        }

        // A fresh session starts **visible**. The tab that spawned it is
        // normally the one on screen, and a session wrongly paced is a
        // transcript that looks stalled, where a session wrongly unpaced only
        // costs what it cost before this existed. `chat_spawn` corrects it
        // immediately for a tab that is not on screen.
        let listener = new_sink(self.wrap(session_id, emit));
        let pacer = Arc::new(Pacer::new(listener.clone(), true, HIDDEN_RELEASE_MS, monotonic_clock()));
        let into_pacer = pacer.clone();
        let sink = new_sink(Box::new(move |event| into_pacer.deliver(event)));
        let mut transport = make();
        if let Err(e) = transport.start(spec, sink.clone()) {
            // The claim was taken before the spawn so a refusal never starts a
            // process; a spawn that then fails has to give it back, or the id
            // stays held by a session that does not exist.
            self.registry.release(session_id, tab_id);
            return Err(e);
        }
        if let Some(pid) = transport.child_pid() {
            self.registry.note_child_pid(session_id, pid);
        }

        lock(&self.sessions).insert(
            session_id.to_string(),
            Entry {
                sink,
                listener,
                pacer,
                transport: Arc::new(Mutex::new(transport)),
                tab_id: tab_id.to_string(),
                generation: 0,
            },
        );
        Ok(Spawned::Started)
    }

    /// Wrap a caller's emit closure so a fatal event tears the session down on
    /// its way past. Every event still reaches the caller: the UI needs to see
    /// the error that killed the session, not just its absence.
    fn wrap(&self, session_id: &str, emit: Emit) -> Emit {
        let sessions = self.sessions.clone();
        let registry = self.registry.clone();
        let bridges = self.bridges.clone();
        let id = session_id.to_string();
        Box::new(move |event| {
            let fatal = ends_session(&event);
            emit(event);
            if fatal {
                let tab = lock(&sessions).remove(&id).map(|e| e.tab_id);
                if let Some(bridge) = lock(&bridges).remove(&id) {
                    bridge.teardown();
                }
                if let Some(tab) = tab {
                    registry.release(&id, &tab);
                }
            }
        })
    }

    /// Apply a command to a live session.
    ///
    /// One entry point rather than a method per command: the commands are
    /// already an enum, and a `match` here means a new [`ChatCommand`] variant
    /// fails to compile until it is routed, where seven parallel methods would
    /// silently leave it unhandled.
    pub fn dispatch(&self, command: &ChatCommand) -> Result<(), String> {
        let session_id = match command {
            ChatCommand::SendTurn { session_id, .. }
            | ChatCommand::Steer { session_id, .. }
            | ChatCommand::Interrupt { session_id }
            | ChatCommand::RespondPermission { session_id, .. }
            | ChatCommand::SetMode { session_id, .. }
            | ChatCommand::SetModel { session_id, .. }
            | ChatCommand::Close { session_id } => session_id.clone(),
        };
        let Some(transport) = lock(&self.sessions).get(&session_id).map(|e| e.transport.clone()) else {
            return Err(format!("no live chat session {session_id}"));
        };
        let mut t = lock(&transport);
        match command {
            ChatCommand::SendTurn { blocks, .. } => t.send(blocks),
            ChatCommand::Steer { blocks, .. } => t.steer(blocks),
            ChatCommand::Interrupt { .. } => t.interrupt(),
            ChatCommand::RespondPermission { tool_use_id, request_id, decision, scope, reason, .. } => {
                // Whether the transport owned the request is routing information
                // for `answer_permission`, which is the caller that acts on it;
                // a bare dispatch has no second route to fall back to.
                t.respond_permission(tool_use_id, request_id, *decision, *scope, reason.as_deref()).map(|_| ())
            }
            ChatCommand::SetMode { mode, .. } => t.set_mode(mode.clone()),
            ChatCommand::SetModel { model, effort, .. } => t.set_model(model, *effort),
            ChatCommand::Close { .. } => {
                drop(t);
                self.close(&session_id)
            }
        }
    }

    /// Convenience wrappers over [`Self::dispatch`], so command handlers read as
    /// what they do rather than as enum construction.
    pub fn send(&self, session_id: &str, blocks: Vec<ContentBlock>) -> Result<(), String> {
        self.dispatch(&ChatCommand::SendTurn { session_id: session_id.to_string(), blocks })
    }

    pub fn steer(&self, session_id: &str, blocks: Vec<ContentBlock>) -> Result<(), String> {
        self.dispatch(&ChatCommand::Steer { session_id: session_id.to_string(), blocks })
    }

    pub fn interrupt(&self, session_id: &str) -> Result<(), String> {
        self.dispatch(&ChatCommand::Interrupt { session_id: session_id.to_string() })
    }

    pub fn set_mode(&self, session_id: &str, mode: PermissionMode) -> Result<(), String> {
        self.dispatch(&ChatCommand::SetMode { session_id: session_id.to_string(), mode })
    }

    pub fn set_model(&self, session_id: &str, model: &str, effort: Option<Effort>) -> Result<(), String> {
        self.dispatch(&ChatCommand::SetModel { session_id: session_id.to_string(), model: model.to_string(), effort })
    }

    /// End a session: kill the child, drop the entry, release the claim.
    ///
    /// Idempotent, because both the tab-close path and app exit call it.
    pub fn close(&self, session_id: &str) -> Result<(), String> {
        // The bridge goes first: its blocked tool calls must be denied while the
        // child is still there to receive the denial, not after it is killed.
        self.drop_bridge(session_id);
        let entry = lock(&self.sessions).remove(session_id);
        let Some(entry) = entry else { return Ok(()) };
        let result = lock(&entry.transport).close();
        self.registry.release(session_id, &entry.tab_id);
        result
    }

    /// Kill every live child and release every claim.
    ///
    /// Called on app exit. A `claude` child holds its own stdin and would
    /// otherwise outlive the window that started it, keeping its session id
    /// unclaimable on the next launch and continuing to write to the transcript.
    pub fn shutdown(&self) {
        let ids: Vec<String> = lock(&self.sessions).keys().cloned().collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }

    pub fn is_live(&self, session_id: &str) -> bool {
        lock(&self.sessions).contains_key(session_id)
    }

    /// This session's tab came on screen, or left it.
    ///
    /// Returns whether it reached a live session. `false` is not an error: a tab
    /// unmounting races its own session's teardown, and a visibility change for
    /// a session that has gone is exactly as meaningful as it sounds.
    ///
    /// The pacer is cloned out and the map guard dropped **before** the call,
    /// because releasing a held fragment emits, and emitting can end a session,
    /// which takes this same lock.
    pub fn set_visible(&self, session_id: &str, visible: bool) -> bool {
        let pacer = lock(&self.sessions).get(session_id).map(|e| e.pacer.clone());
        let Some(pacer) = pacer else { return false };
        pacer.set_visible(visible);
        true
    }

    /// Test-only: the live set, sorted. The product reads `is_live` for one id;
    /// nothing needs the whole list yet, and exposing it unused would be exactly
    /// the dead code Phase 1's removed `allow(dead_code)` was hiding.
    #[cfg(test)]
    fn live_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = lock(&self.sessions).keys().cloned().collect();
        ids.sort();
        ids
    }

    #[cfg(test)]
    fn generation(&self, session_id: &str) -> Option<u64> {
        lock(&self.sessions).get(session_id).map(|e| e.generation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::model::{PermissionDecision, PermissionScope};
    use crate::chat::ownership::{Claim, ClaimOutcome, Surface};
    use crate::chat::transport::mock::MockTransport;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Collects everything a session emitted, so a test can assert on the
    /// stream the UI would have seen.
    #[derive(Clone, Default)]
    struct Collector(Arc<Mutex<Vec<ChatEvent>>>);

    impl Collector {
        fn emit(&self) -> Emit {
            let inner = self.0.clone();
            Box::new(move |ev| lock(&inner).push(ev))
        }
        fn events(&self) -> Vec<ChatEvent> {
            lock(&self.0).clone()
        }
    }

    /// A transport that hands its sink back so a test can drive events through
    /// it the way a reader thread would.
    #[derive(Default)]
    struct Puppet {
        /// Where `start` publishes the sink the host gave it.
        sink_out: Option<Arc<Mutex<Option<Sink>>>>,
        closed: Arc<AtomicU32>,
    }

    impl AgentTransport for Puppet {
        fn start(&mut self, _spec: StartSpec, sink: Sink) -> Result<(), String> {
            if let Some(out) = &self.sink_out {
                *lock(out) = Some(sink);
            }
            Ok(())
        }
        fn send(&mut self, _blocks: &[ContentBlock]) -> Result<(), String> {
            Ok(())
        }
        fn steer(&mut self, _blocks: &[ContentBlock]) -> Result<(), String> {
            Ok(())
        }
        fn interrupt(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn respond_permission(
            &mut self,
            _t: &str,
            _r: &str,
            _d: PermissionDecision,
            _s: PermissionScope,
            _reason: Option<&str>,
        ) -> Result<bool, String> {
            Ok(false)
        }
        fn set_mode(&mut self, _mode: PermissionMode) -> Result<(), String> {
            Ok(())
        }
        fn set_model(&mut self, _model: &str, _effort: Option<Effort>) -> Result<(), String> {
            Ok(())
        }
        fn close(&mut self) -> Result<(), String> {
            self.closed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn child_pid(&self) -> Option<u32> {
            None
        }
    }

    /// A per-test claims store, never the real one.
    fn temp_store() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("sway-host-claims-{}", std::process::id()))
            .join(format!("{:?}.json", std::thread::current().id()))
    }

    fn spec(id: &str) -> StartSpec {
        StartSpec { session_id: id.to_string(), ..Default::default() }
    }

    /// The idempotent-spawn contract this host inherits from `pty.rs`: a tab
    /// remount must re-subscribe, never start a second `claude`. Two of them on
    /// one session id is precisely the transcript-corrupting case the whole
    /// ownership layer exists to prevent, so this is the load-bearing test of
    /// the map.
    #[test]
    fn a_second_spawn_for_a_live_id_rewires_the_sink_without_a_second_process() {
        let host = ChatHost::at(temp_store());
        let spawns = Arc::new(AtomicU32::new(0));

        let first = Collector::default();
        let counter = spawns.clone();
        let outcome = host
            .spawn("s1", "tab-a", first.emit(), spec("s1"), move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Box::<Puppet>::default()
            })
            .unwrap();
        assert_eq!(outcome, Spawned::Started);
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert_eq!(host.generation("s1"), Some(0));

        let second = Collector::default();
        let counter = spawns.clone();
        let outcome = host
            .spawn("s1", "tab-a", second.emit(), spec("s1"), move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Box::<Puppet>::default()
            })
            .unwrap();
        assert_eq!(outcome, Spawned::Rewired);
        assert_eq!(spawns.load(Ordering::SeqCst), 1, "a re-subscribe must not spawn a second process");
        assert_eq!(host.generation("s1"), Some(1), "a re-subscribe bumps the generation");

        // The rewire is real: events now reach the new subscriber only.
        host.close("s1").unwrap();
        assert!(first.events().is_empty());
    }

    /// A mock child that dies mid-turn. All three consequences are asserted
    /// together because any one of them alone leaves the session id stuck: an
    /// error nobody sees, a map entry nothing will ever drive, or a claim held
    /// by a process that no longer exists.
    #[test]
    fn a_child_dying_mid_turn_reaches_the_sink_drops_the_entry_and_releases_the_claim() {
        let host = ChatHost::at(temp_store());
        let seen = Collector::default();

        host.registry.claim(
            "s-dies",
            Claim { surface: Surface::Chat, tab_id: "tab-a".into(), child_pid: None, sway_pid: std::process::id(), agent: "claude".into() },
        );
        assert!(host.registry.snapshot().contains_key("s-dies"));

        let sink_holder: Arc<Mutex<Option<Sink>>> = Arc::new(Mutex::new(None));
        let holder = sink_holder.clone();
        host.spawn("s-dies", "tab-a", seen.emit(), spec("s-dies"), move || {
            Box::new(Puppet { sink_out: Some(holder), closed: Arc::default() })
        })
        .unwrap();

        let sink = lock(&sink_holder).clone().expect("the transport should have received a sink");
        crate::chat::transport::emit(
            &sink,
            ChatEvent::SessionError {
                session_id: "s-dies".to_string(),
                message: "child exited with status 1".to_string(),
                fatal: true,
            },
        );

        assert!(matches!(seen.events().first(), Some(ChatEvent::SessionError { fatal: true, .. })));
        assert!(!host.is_live("s-dies"), "a dead session must not stay in the map");
        assert!(!host.registry.snapshot().contains_key("s-dies"), "a dead session must release its claim");
    }

    /// The pacer is wired into the sink the transport writes to, not bolted on
    /// somewhere a second harness could miss.
    ///
    /// Deterministic without a clock injection because the bound is enormous: a
    /// synthetic burst of in-memory pushes finishes several orders of magnitude
    /// inside one 250ms interval, so a hidden session cannot release more than a
    /// handful however loaded the machine is - while the visible one is required
    /// to be exact.
    #[test]
    fn a_hidden_session_is_paced_at_the_sink_and_a_visible_one_is_not() {
        let host = ChatHost::at(temp_store());
        let (seen, holder) = (Collector::default(), Arc::new(Mutex::new(None)));
        let out = holder.clone();
        host.spawn("s1", "tab-a", seen.emit(), spec("s1"), move || {
            Box::new(Puppet { sink_out: Some(out), closed: Arc::default() })
        })
        .unwrap();
        let sink = lock(&holder).clone().expect("the transport should have received a sink");

        let fragments: Vec<String> = (0..300).map(|i| format!("{i} ")).collect();
        let burst = |sink: &Sink, id: &str| {
            for text in &fragments {
                crate::chat::transport::emit(
                    &sink.clone(),
                    ChatEvent::TextDelta { session_id: id.into(), turn_id: "t1".into(), text: text.clone() },
                );
            }
        };

        burst(&sink, "s1");
        assert_eq!(seen.events().len(), 300, "a session on screen streams unchanged");

        host.close("s1").unwrap();
        let (seen, holder) = (Collector::default(), Arc::new(Mutex::new(None)));
        let out = holder.clone();
        host.spawn("s2", "tab-b", seen.emit(), spec("s2"), move || {
            Box::new(Puppet { sink_out: Some(out), closed: Arc::default() })
        })
        .unwrap();
        assert!(host.set_visible("s2", false));
        let sink = lock(&holder).clone().expect("the transport should have received a sink");
        burst(&sink, "s2");
        assert!(seen.events().len() < 10, "a hidden session must not pay per token");

        // And the collapse is a delay rather than a loss, which is the half a
        // count alone would not catch.
        assert!(host.set_visible("s2", true));
        let joined: String = seen
            .events()
            .iter()
            .filter_map(|ev| match ev {
                ChatEvent::TextDelta { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(joined, fragments.concat());
    }

    /// A visibility change for a session that has gone is ordinary, not an
    /// error: closing a tab races the effect that reports it left the screen.
    #[test]
    fn a_visibility_change_for_a_dead_session_is_a_no_op() {
        let host = ChatHost::at(temp_store());
        assert!(!host.set_visible("never-existed", false));
    }

    /// A non-fatal error is information, not a death sentence: one unparseable
    /// line must not take a working session down.
    #[test]
    fn a_non_fatal_error_leaves_the_session_live() {
        let host = ChatHost::at(temp_store());
        let seen = Collector::default();
        host.spawn("s1", "tab-a", seen.emit(), spec("s1"), || Box::<Puppet>::default()).unwrap();

        // Emitting through the host's own wrapper is what the transport does.
        assert!(!ends_session(&ChatEvent::SessionError {
            session_id: "s1".into(),
            message: "one bad line".into(),
            fatal: false
        }));
        assert!(host.is_live("s1"));
    }

    #[test]
    fn dispatch_on_a_dead_session_errors_rather_than_silently_doing_nothing() {
        let host = ChatHost::at(temp_store());
        let err = host.interrupt("nope").unwrap_err();
        assert!(err.contains("nope"), "the error should name the session: {err}");
    }

    /// App exit: every child killed, every claim released. A surviving `claude`
    /// would keep its id unclaimable on the next launch and keep appending to
    /// the transcript with nobody reading it.
    #[test]
    fn shutdown_closes_every_child_and_releases_every_claim() {
        let host = ChatHost::at(temp_store());
        let closes = Arc::new(AtomicU32::new(0));

        for (id, tab) in [("s1", "tab-a"), ("s2", "tab-b")] {
            host.registry.claim(
                id,
                Claim { surface: Surface::Chat, tab_id: tab.into(), child_pid: None, sway_pid: std::process::id(), agent: "claude".into() },
            );
            let closed = closes.clone();
            host.spawn(id, tab, Box::new(|_| {}), spec(id), move || {
                Box::new(Puppet { sink_out: None, closed })
            })
            .unwrap();
        }
        assert_eq!(host.live_ids(), vec!["s1", "s2"]);

        host.shutdown();

        assert_eq!(closes.load(Ordering::SeqCst), 2, "every child must be closed");
        assert!(host.live_ids().is_empty());
        for id in ["s1", "s2"] {
            assert!(!host.registry.snapshot().contains_key(id), "{id} must have released its claim");
        }
    }

    /// A transport that fails to start must give the session id back, or it
    /// stays held by a session that never existed.
    #[test]
    fn a_failed_start_releases_the_claim_it_was_given() {
        let host = ChatHost::at(temp_store());
        host.registry.claim(
            "s-bad",
            Claim { surface: Surface::Chat, tab_id: "tab-a".into(), child_pid: None, sway_pid: std::process::id(), agent: "claude".into() },
        );

        struct Broken;
        impl AgentTransport for Broken {
            fn start(&mut self, _spec: StartSpec, _sink: Sink) -> Result<(), String> {
                Err("no such file or directory".to_string())
            }
            fn send(&mut self, _b: &[ContentBlock]) -> Result<(), String> {
                Ok(())
            }
            fn steer(&mut self, _b: &[ContentBlock]) -> Result<(), String> {
                Ok(())
            }
            fn interrupt(&mut self) -> Result<(), String> {
                Ok(())
            }
            fn respond_permission(
                &mut self,
                _t: &str,
                _r: &str,
                _d: PermissionDecision,
                _s: PermissionScope,
                _reason: Option<&str>,
            ) -> Result<bool, String> {
                Ok(false)
            }
            fn set_mode(&mut self, _m: PermissionMode) -> Result<(), String> {
                Ok(())
            }
            fn set_model(&mut self, _m: &str, _e: Option<Effort>) -> Result<(), String> {
                Ok(())
            }
            fn close(&mut self) -> Result<(), String> {
                Ok(())
            }
            fn child_pid(&self) -> Option<u32> {
                None
            }
        }

        let err = host
            .spawn("s-bad", "tab-a", Box::new(|_| {}), spec("s-bad"), || Box::new(Broken))
            .unwrap_err();
        assert!(err.contains("no such file"));
        assert!(!host.is_live("s-bad"));
        assert!(!host.registry.snapshot().contains_key("s-bad"));
    }

    /// The cross-surface refusal, end to end: one session id opened as a PTY
    /// agent tab and then as chat.
    ///
    /// The transcript assertion is the point. Two live drivers of one id both
    /// append to a single transcript file, producing a record of a conversation
    /// that never happened - measured, not feared. So the test does not just
    /// check the refusal, it checks that nothing was started: the factory is
    /// never called and a stand-in transcript is byte-for-byte unchanged.
    #[test]
    fn one_session_id_cannot_be_opened_as_chat_and_as_a_pty_agent_tab() {
        let host = ChatHost::at(temp_store());
        let id = format!("s-two-surfaces-{}", std::process::id());

        let transcript = std::env::temp_dir().join(format!("{id}.jsonl"));
        std::fs::write(&transcript, "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n").unwrap();
        let before = std::fs::read(&transcript).unwrap();

        let first = host.registry.claim(
            &id,
            Claim { surface: Surface::PtyAgent, tab_id: "pty-tab".into(), child_pid: None, sway_pid: std::process::id(), agent: "claude".into() },
        );
        assert_eq!(first, ClaimOutcome::Granted { contested: false });

        let second = host.registry.claim(
            &id,
            Claim { surface: Surface::Chat, tab_id: "chat-tab".into(), child_pid: None, sway_pid: std::process::id(), agent: "claude".into() },
        );
        assert_eq!(second, ClaimOutcome::HeldByOther { surface: Surface::PtyAgent, tab_id: "pty-tab".to_string() });

        // The refused claim is what stops the spawn, so nothing was started.
        let spawns = Arc::new(AtomicU32::new(0));
        let counter = spawns.clone();
        if matches!(second, ClaimOutcome::Granted { .. }) {
            host.spawn(&id, "chat-tab", Box::new(|_| {}), spec(&id), move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Box::<Puppet>::default()
            })
            .unwrap();
        }
        assert_eq!(spawns.load(Ordering::SeqCst), 0, "a refused claim must not start a second driver");
        assert_eq!(std::fs::read(&transcript).unwrap(), before, "the refused attempt must not touch the transcript");

        host.registry.forget(&id);
        let _ = std::fs::remove_file(&transcript);
    }

    /// The reverse direction, and the one that decides *where* the guard lives:
    /// a session held by chat must be refused a PTY agent tab.
    ///
    /// `pty_spawn` takes the claim itself rather than trusting the frontend to
    /// call a separate command first, so this asserts the shape that spawn site
    /// depends on. A fresh agent tab passes no session id at all - its id does
    /// not exist until the agent writes a transcript - so nothing is claimed and
    /// nothing can conflict.
    #[test]
    fn a_session_held_by_chat_is_refused_a_pty_agent_tab() {
        let host = ChatHost::at(temp_store());
        let id = format!("s-chat-first-{}", std::process::id());

        host.spawn(&id, "chat-tab", Box::new(|_| {}), spec(&id), || Box::<Puppet>::default()).unwrap();
        host.registry.claim(
            &id,
            Claim { surface: Surface::Chat, tab_id: "chat-tab".into(), child_pid: None, sway_pid: std::process::id(), agent: "claude".into() },
        );

        let outcome = host.registry.claim(
            &id,
            Claim { surface: Surface::PtyAgent, tab_id: "pty-tab".into(), child_pid: None, sway_pid: std::process::id(), agent: "claude".into() },
        );
        assert_eq!(outcome, ClaimOutcome::HeldByOther { surface: Surface::Chat, tab_id: "chat-tab".to_string() });

        // Closing the chat tab hands the session back to the terminal.
        host.close(&id).unwrap();
        assert_eq!(
            host.registry.claim(
                &id,
                Claim { surface: Surface::PtyAgent, tab_id: "pty-tab".into(), child_pid: None, sway_pid: std::process::id(), agent: "claude".into() },
            ),
            ClaimOutcome::Granted { contested: false }
        );
        host.registry.forget(&id);
    }

    /// App exit against real processes, not mocks: the children must actually be
    /// dead afterwards. A surviving `claude` keeps its session id unclaimable on
    /// the next launch and keeps appending to a transcript nobody is reading.
    #[test]
    fn shutdown_actually_kills_the_child_processes() {
        use crate::chat::claude_transport::ClaudeTransport;

        let host = ChatHost::at(temp_store());
        let mut ids = Vec::new();
        for n in 0..2 {
            let id = format!("s-exit-{}-{n}", std::process::id());
            host.registry.claim(
                &id,
                Claim { surface: Surface::Chat, tab_id: id.clone(), child_pid: None, sway_pid: std::process::id(), agent: "claude".into() },
            );
            let start = StartSpec {
                session_id: id.clone(),
                program: "/bin/sh".into(),
                // Holds stdin open forever, the way a real chat child does.
                args: vec!["-c".into(), "cat > /dev/null".into()],
                ..Default::default()
            };
            let factory_id = id.clone();
            host.spawn(&id, &id, Box::new(|_| {}), start, move || Box::new(ClaudeTransport::new(factory_id)))
                .unwrap();
            ids.push(id);
        }

        let pids: Vec<u32> = ids
            .iter()
            .map(|id| host.registry.snapshot().get(id).and_then(|c| c.child_pid).expect("a claim should record its child pid"))
            .collect();
        assert_eq!(pids.len(), 2);

        host.shutdown();

        for pid in pids {
            let mut alive = true;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                alive = std::process::Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if !alive {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            assert!(!alive, "pid {pid} survived shutdown");
        }
        for id in &ids {
            assert!(!host.registry.snapshot().contains_key(id), "{id} left a stale claim behind");
        }
    }

    /// Installing a second bridge for one session **tears the first one down**.
    ///
    /// Pinned because it is why `chat_spawn` returns early on a remount rather
    /// than falling through. A running child's approval socket path went into
    /// its `--settings` at launch and cannot be changed, so replacing the bridge
    /// would deny whatever was blocked, delete the session's rules, and leave
    /// the child calling a socket that had just been shut down. This test states
    /// the hazard; the early return in `chat_spawn` is what avoids it.
    #[test]
    fn installing_a_second_bridge_tears_the_first_one_down() {
        let host = ChatHost::at(temp_store());
        let session = format!("rebridge-{}", std::process::id());

        let first = crate::chat::approval::start(Box::new(|_| {}), Box::new(|_| {})).unwrap();
        let first_dir = first.sock_path().parent().unwrap().to_path_buf();
        host.install_bridge(&session, SessionBridge::new(first, Arc::new(Mutex::new(SnapshotCache::new(8))), &session));
        assert!(first_dir.exists());

        let second = crate::chat::approval::start(Box::new(|_| {}), Box::new(|_| {})).unwrap();
        host.install_bridge(&session, SessionBridge::new(second, Arc::new(Mutex::new(SnapshotCache::new(8))), &session));

        // The first server really stopped serving: its directory is gone once the
        // accept loop released its handle.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while first_dir.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!first_dir.exists(), "the replaced bridge must be torn down, which is why a remount must not replace one");

        host.drop_bridge(&session);
    }

    /// **Tearing a bridge down must not leave its rules behind.**
    ///
    /// `teardown` clears the refresher flag and then removes the rules file, so
    /// a refresher waking from its sleep in between could write the file back -
    /// leaving a rules file naming a *live* Sway pid, which would pre-approve a
    /// later session that reused the id. The flag is therefore checked
    /// immediately before the write, and this waits out a full refresh interval
    /// to give the race a chance to happen.
    #[test]
    fn a_torn_down_bridge_leaves_no_rules_file_behind_for_a_later_session() {
        let session = format!("teardown-{}", std::process::id());
        let rules_path = crate::chat::rules::rules_path(&session);
        let server = crate::chat::approval::start(Box::new(|_| {}), Box::new(|_| {})).unwrap();
        let bridge = SessionBridge::new(server, Arc::new(Mutex::new(SnapshotCache::new(8))), &session);

        // The refresher has written it.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !rules_path.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(rules_path.exists(), "the supervisor should be stamping a rules file");

        bridge.teardown();

        // Long enough for a mid-sleep refresher to wake and write it back.
        std::thread::sleep(std::time::Duration::from_millis(crate::chat::rules::STAMP_REFRESH_MS + 500));
        assert!(!rules_path.exists(), "a torn-down session's rules must not be resurrected");
        assert!(
            !crate::chat::approval::settings_path(&session).exists(),
            "the settings file holds a token for a socket that no longer exists"
        );
    }

    /// The mock from `transport.rs` records what reached it, which is how the
    /// dispatch routing is checked rather than assumed.
    #[test]
    fn dispatch_routes_each_command_to_the_transport() {
        let host = ChatHost::at(temp_store());
        host.spawn("s1", "tab-a", Box::new(|_| {}), spec("s1"), || Box::<MockTransport>::default()).unwrap();

        host.send("s1", vec![ContentBlock::Text { text: "hello".into() }]).unwrap();
        host.interrupt("s1").unwrap();
        host.set_mode("s1", PermissionMode::new("plan")).unwrap();
        host.set_model("s1", "claude-opus-5", Some(Effort::High)).unwrap();

        // Close goes through the host's own teardown, not straight to the
        // transport, so the map entry and the claim go with it.
        host.dispatch(&ChatCommand::Close { session_id: "s1".into() }).unwrap();
        assert!(!host.is_live("s1"));
    }
}
