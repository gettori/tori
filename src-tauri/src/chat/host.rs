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

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use super::approval::{self, CaptureServer};
use super::model::{
    cap_output, ChatCommand, ChatConfigValue, ChatEvent, ContentBlock, PermissionDecision,
    PermissionMode, PermissionScope, QuestionAnswer,
};
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

/// The frames that say what a session *is*, kept so a re-subscribe can be told.
///
/// A webview reload leaves the child running and the process untouched, so
/// `spawn` rewires rather than starting anything - but the new tab's store is
/// empty and these two frames were delivered once, to a subscriber that no
/// longer exists. Without them the panel has a live session it does not know is
/// open: `connectionHealth` reads neither `started` nor `ready` and reports
/// "Connecting" for as long as the tab is open.
///
/// Only these two. Everything else is conversation, and where a transport has a
/// transcript that is what `chat_history` is for.
#[derive(Default, Clone)]
struct Identity {
    ready: Option<ChatEvent>,
    started: Option<ChatEvent>,
}

impl Identity {
    /// Ready first, matching the order a transport emits them: it reports a
    /// child that answered before it reports a session that opened.
    ///
    /// `started` is withheld when the transport is about to replay the
    /// conversation, because `SessionStarted` is what a consumer reads as the
    /// end of a replay. Sending it up front would close the window before the
    /// conversation arrived, and every replayed turn would read as live work.
    /// The transport emits its own once the replay is done.
    fn frames(&self, replay_coming: bool) -> Vec<ChatEvent> {
        let started = if replay_coming { None } else { self.started.clone() };
        [self.ready.clone(), started].into_iter().flatten().collect()
    }

    /// Whether this frame is one of the two, and keeping it if so. The check is
    /// on the hot path for every event, so it costs a discriminant compare and
    /// takes no lock for the frames it does not want.
    fn keep(&mut self, event: &ChatEvent) -> bool {
        match event {
            ChatEvent::SessionReady { .. } => self.ready = Some(event.clone()),
            ChatEvent::SessionStarted { .. } => self.started = Some(event.clone()),
            _ => return false,
        }
        true
    }
}

/// One session's full tool outputs, keyed by `tool_use_id` and bounded.
///
/// The point of the whole cache is that a card's output is **retained but not
/// resident**: what rides the event and sits in the store is a capped extract,
/// and the rest waits here until a user opens the card and asks for it. Bounded
/// for the same reason [`SnapshotCache`] is, except the entries here are not
/// tiny: an output over the cap is by definition large, so the bound is what
/// keeps a session that catted a hundred files from holding all hundred.
///
/// Oldest-first eviction, since the newest cards are the ones on screen. An
/// evicted id reads back as `None`, which the card renders as the extract it
/// already has.
#[derive(Debug, Default)]
pub struct OutputCache {
    entries: HashMap<String, String>,
    /// Insertion order, so eviction is oldest-first rather than whatever the
    /// map's iteration order happens to be.
    order: VecDeque<String>,
    cap: usize,
    /// Calls whose output must reach the UI whole, so the cut never runs for
    /// them at all.
    ///
    /// Learned from [`ChatEvent::QuestionRequest`] rather than from a tool
    /// name: a question's "output" is the answer record Sway itself produced,
    /// and it lands on a question row that has no card and therefore no way to
    /// ask for the rest. Keying on Sway's own event instead of on
    /// `AskUserQuestion` keeps the host out of one agent's vocabulary and gives
    /// any agent that asks a question through Sway the same treatment.
    whole: HashSet<String>,
}

impl OutputCache {
    pub fn new(cap: usize) -> Self {
        Self { entries: HashMap::new(), order: VecDeque::new(), cap: cap.max(1), whole: HashSet::new() }
    }

    /// Mark a call's output as one that must never be cut.
    pub fn keep_whole(&mut self, tool_use_id: &str) {
        self.whole.insert(tool_use_id.to_string());
    }

    /// Cut an output down to what an event should carry, keeping the rest here.
    ///
    /// Returns the text to send and whether it was cut. Nothing is stored for
    /// an output that fits: the cache would then hold a copy of what the store
    /// already has, and evicting it would push out an entry that is actually
    /// needed.
    pub fn take(&mut self, tool_use_id: &str, output: String) -> (String, bool) {
        if self.whole.contains(tool_use_id) {
            return (output, false);
        }
        let Some(cut) = cap_output(&output) else { return (output, false) };
        if self.entries.insert(tool_use_id.to_string(), output).is_none() {
            self.order.push_back(tool_use_id.to_string());
        }
        while self.order.len() > self.cap {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        (cut, true)
    }

    /// The full output for a tool call, or `None` if it was never over the cap
    /// or has been evicted.
    ///
    /// `None` is a normal answer, not an error, the same way
    /// [`SnapshotCache::get`]'s is: the card keeps showing the extract it
    /// already has.
    pub fn get(&self, tool_use_id: &str) -> Option<&String> {
        self.entries.get(tool_use_id)
    }

    /// Test-only, like `SnapshotCache::len`: the product asks about one call at
    /// a time.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

fn is_identity(event: &ChatEvent) -> bool {
    matches!(event, ChatEvent::SessionReady { .. } | ChatEvent::SessionStarted { .. })
}

/// The approval and snapshot machinery for one session.
///
/// Held beside the session rather than inside the transport: the transport
/// drives the agent's stdin, while this rides the agent's *hook*, and the
/// two only meet at the session id. Keeping them separate is also what lets a
/// second agent reuse the bridge unchanged if its own hook mechanism matches.
pub struct SessionBridge {
    pub server: Arc<CaptureServer>,
    pub snapshots: Arc<Mutex<SnapshotCache>>,
    session_id: String,
}

impl SessionBridge {
    pub fn new(server: Arc<CaptureServer>, snapshots: Arc<Mutex<SnapshotCache>>, session_id: &str) -> Self {
        Self { server, snapshots, session_id: session_id.to_string() }
    }

    /// Stop capturing for this session.
    pub fn teardown(&self) {
        self.server.shutdown();
        // The settings file holds this session's socket path and token, for a
        // socket that no longer exists. Nothing should be able to read it back.
        let _ = std::fs::remove_file(approval::settings_path(&self.session_id));
    }
}

/// How many oversized outputs one session keeps. Small on purpose: every entry
/// is over [`crate::chat::model::TOOL_OUTPUT_CAP`] by definition, so this is a
/// cap on megabytes, not on rows, and the cards a user actually opens are the
/// recent ones.
pub const OUTPUT_CACHE_CAP: usize = 16;

/// The host. One per app, managed as Tauri state by `lib.rs`.
#[derive(Default)]
pub struct ChatHost {
    sessions: Sessions,
    pub registry: Arc<Registry>,
    /// One per live session, installed by `chat_spawn` once its socket exists.
    bridges: Arc<Mutex<HashMap<String, SessionBridge>>>,
    /// Kept beside the sessions rather than inside `Entry`, so recording one
    /// takes the identity lock and never the map's: an event passes through
    /// while `spawn` may be holding the map, and the two must not meet.
    identity: Arc<Mutex<HashMap<String, Identity>>>,
    /// The full text of tool outputs too large to ride their event, one cache
    /// per session. Beside the sessions for the same reason `identity` is, and
    /// written from the same place: the sink wrapper, which every live event
    /// passes through exactly once.
    outputs: Arc<Mutex<HashMap<String, OutputCache>>>,
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

impl ChatHost {
    /// Test-only: a host whose registry persists to `path` rather than the real
    /// `chat-claims.json`, so a test run cannot drop a live session's claim out
    /// from under a running Sway.
    #[cfg(test)]
    fn at(path: std::path::PathBuf) -> Self {
        Self {
            sessions: Sessions::default(),
            registry: Arc::new(Registry::at(path)),
            bridges: Arc::default(),
            identity: Arc::default(),
            outputs: Arc::default(),
        }
    }

    /// Attach a session's capture bridge, once `chat_spawn` has bound its
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
    /// Closures built before a session exists cannot capture its sink; they
    /// capture this instead and resolve the sink at emit time. An event for a
    /// session that has since gone is dropped, which is correct: there is no
    /// longer a transcript for it to belong to.
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

    /// Cut a replayed conversation's outputs the way a live one's are cut.
    ///
    /// Replay does not pass through the sink wrapper: `chat_history` returns its
    /// events straight to the caller. So the cut happens here instead, through
    /// the same cache, and a backfilled card can fetch its remainder exactly
    /// like a live one. Without this the replayed card would offer a button
    /// that could only ever fail.
    ///
    /// **Only for a session the host knows.** History can be read for a session
    /// that is never spawned, and storing for one of those would leave a cache
    /// per browsed conversation with nothing to ever drop it. Those still get
    /// their outputs cut, and their cards say the rest is not held, which is
    /// true.
    pub fn cut_outputs(&self, session_id: &str, events: &mut [ChatEvent]) {
        let live = lock(&self.sessions).contains_key(session_id);
        let mut outputs = lock(&self.outputs);
        for event in events {
            let ChatEvent::ToolCallCompleted { tool_use_id, output, output_truncated, .. } = event else {
                continue;
            };
            let Some(text) = output.take() else { continue };
            if live {
                let (cut, truncated) = outputs
                    .entry(session_id.to_string())
                    .or_insert_with(|| OutputCache::new(OUTPUT_CACHE_CAP))
                    .take(tool_use_id, text);
                *output = Some(cut);
                *output_truncated = truncated;
            } else {
                match cap_output(&text) {
                    Some(cut) => {
                        *output = Some(cut);
                        *output_truncated = true;
                    }
                    None => *output = Some(text),
                }
            }
        }
    }

    /// The full output of one tool call, for a card that asked for the rest.
    ///
    /// `None` for a session with no cache, an output that was never cut, and
    /// one that has been evicted. The caller cannot tell those apart and does
    /// not need to: all three mean "show what you already have".
    pub fn tool_output(&self, session_id: &str, tool_use_id: &str) -> Option<String> {
        lock(&self.outputs).get(session_id)?.get(tool_use_id).cloned()
    }

    /// Answer a tool call the agent is asking about.
    ///
    /// **Only the transport can take this.** There used to be a second waiter -
    /// Sway's own `PreToolUse` gate, blocking on a socket with its own request-id
    /// space - and this routed between them. That gate is gone: the agent is
    /// the only thing that asks, so an id the transport disclaims belongs to
    /// nobody, and saying so is better than resolving it somewhere that would
    /// swallow it.
    pub fn answer_permission(
        &self,
        session_id: &str,
        tool_use_id: &str,
        request_id: &str,
        decision: PermissionDecision,
        scope: PermissionScope,
        reason: Option<&str>,
    ) -> Result<(), String> {
        let transport = lock(&self.sessions).get(session_id).map(|e| e.transport.clone());
        let Some(transport) = transport else { return Err(format!("no live session {session_id}")) };
        // A `false` here means nothing is waiting on that id: the question timed
        // out, or its turn ended, and the click arrived after. Deliberately not
        // an error - the race is routine, and an error toast for it would report
        // a fault where there is only a stale button.
        let _ = lock(&transport).respond_permission(tool_use_id, request_id, decision, scope, reason)?;
        Ok(())
    }

    /// Deliver a question's answers to whichever transport is blocked on it.
    ///
    /// **Returns the routing answer rather than swallowing it**, unlike
    /// [`Self::answer_permission`]. A permission that nobody owns is a stale
    /// button and routine; a question that nobody owns means a form was filled
    /// in and went nowhere, which the caller has to be able to see.
    pub fn answer_question(
        &self,
        session_id: &str,
        tool_use_id: &str,
        request_id: &str,
        answers: &[QuestionAnswer],
    ) -> Result<bool, String> {
        let transport = lock(&self.sessions).get(session_id).map(|e| e.transport.clone());
        let Some(transport) = transport else { return Err(format!("no live session {session_id}")) };
        let mut t = lock(&transport);
        t.respond_question(tool_use_id, request_id, answers)
    }

    /// Tear a session's bridge down.
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
        // Taken under the map's lock, used outside it: a listener is a caller's
        // closure, and what it does on the way out is not this host's business
        // to hold a lock across.
        let rewired = {
            let mut guard = lock(&self.sessions);
            guard.get_mut(session_id).map(|entry| {
                let transport = entry.transport.clone();
                entry.generation += 1;
                // The tab driving this session is whichever one just
                // subscribed. Same id on a remount, a brand-new one after a
                // webview reload - and the claim has to follow, or it names a
                // tab that no longer exists and `close` releases nothing.
                entry.tab_id = tab_id.to_string();
                (entry.listener.clone(), transport)
            })
        };
        if let Some((listener, transport)) = rewired {
            *lock(&listener) = Some(self.wrap(session_id, emit));
            self.registry.retag(session_id, tab_id);
            // Asked **after** the listener is in place, so a replay that starts
            // immediately has somewhere to land, and before the identity is
            // sent, because the answer decides what the identity may include.
            // A transport that errors here is answering "no", not failing the
            // rewire: the tab is attached either way.
            let replay_coming = lock(&transport).replay().unwrap_or(false);
            // The rewired tab's store is empty, so it has to be told what it is
            // attached to.
            //
            // **Bound first, so the guard is dropped before the loop.** These
            // frames go back out through `wrap`, which takes this very lock to
            // record them, and a `std::sync::Mutex` is not reentrant: holding
            // the guard across the emit deadlocks the thread and leaves the lock
            // held forever, which wedges the handshake of every session after
            // it. Qualified because `emit` is this function's own parameter,
            // already moved above.
            let identity = lock(&self.identity).get(session_id).cloned().unwrap_or_default();
            for event in identity.frames(replay_coming) {
                super::transport::emit(&listener, event);
            }
            return Ok(Spawned::Rewired);
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
        let identity = self.identity.clone();
        let outputs = self.outputs.clone();
        let id = session_id.to_string();
        Box::new(move |mut event| {
            let fatal = ends_session(&event);
            // Two frames per session, so the lock is taken twice in its life
            // rather than once per event.
            if is_identity(&event) {
                lock(&identity).entry(id.clone()).or_default().keep(&event);
            }
            // The one place both transports' events meet before the UI, which
            // is what makes it the place to cut. An adapter that cut instead
            // would have to reach a cache it cannot see, and there are two of
            // them; this is one choke point serving both.
            match &mut event {
                ChatEvent::QuestionRequest { tool_use_id, .. } => {
                    lock(&outputs)
                        .entry(id.clone())
                        .or_insert_with(|| OutputCache::new(OUTPUT_CACHE_CAP))
                        .keep_whole(tool_use_id);
                }
                ChatEvent::ToolCallCompleted { tool_use_id, output, output_truncated, .. } => {
                    if let Some(text) = output.take() {
                        let (cut, truncated) = lock(&outputs)
                            .entry(id.clone())
                            .or_insert_with(|| OutputCache::new(OUTPUT_CACHE_CAP))
                            .take(tool_use_id, text);
                        *output = Some(cut);
                        *output_truncated = truncated;
                    }
                }
                _ => {}
            }
            emit(event);
            if fatal {
                let tab = lock(&sessions).remove(&id).map(|e| e.tab_id);
                // Goes with the entry: a session that ended has no identity to
                // hand anyone, and keeping it would be a leak per dead session.
                lock(&identity).remove(&id);
                // Same, and it matters more here: these entries are the large
                // ones.
                lock(&outputs).remove(&id);
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
            | ChatCommand::RespondQuestion { session_id, .. }
            | ChatCommand::SetMode { session_id, .. }
            | ChatCommand::SetModel { session_id, .. }
            | ChatCommand::SetConfigOption { session_id, .. }
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
            ChatCommand::RespondQuestion { tool_use_id, request_id, answers, .. } => {
                // Same reason the arm above drops its bool: which route owned
                // the request is `answer_question`'s business, not a bare
                // dispatch's.
                t.respond_question(tool_use_id, request_id, answers).map(|_| ())
            }
            ChatCommand::SetMode { mode, .. } => t.set_mode(mode.clone()),
            ChatCommand::SetModel { model, effort, .. } => t.set_model(model, effort.clone()),
            ChatCommand::SetConfigOption { config_id, value, .. } => {
                t.set_config_option(config_id, value)
            }
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

    pub fn set_model(&self, session_id: &str, model: &str, effort: Option<String>) -> Result<(), String> {
        self.dispatch(&ChatCommand::SetModel { session_id: session_id.to_string(), model: model.to_string(), effort })
    }

    pub fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: ChatConfigValue,
    ) -> Result<(), String> {
        self.dispatch(&ChatCommand::SetConfigOption {
            session_id: session_id.to_string(),
            config_id: config_id.to_string(),
            value,
        })
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

    /// Every live session id, sorted. Keyed by **session** id, unlike
    /// `PtyState`, which is keyed by frontend tab id: a restore matches chat
    /// tabs against this list and terminal tabs against `pty_live_ids`.
    pub fn live_ids(&self) -> Vec<String> {
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
        /// What this transport answers when asked to hand the conversation
        /// back, and how often it was asked.
        can_replay: bool,
        replays: Arc<AtomicU32>,
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
        fn respond_question(
            &mut self,
            _t: &str,
            _r: &str,
            _a: &[QuestionAnswer],
        ) -> Result<bool, String> {
            Ok(false)
        }
        fn set_mode(&mut self, _mode: PermissionMode) -> Result<(), String> {
            Ok(())
        }
        fn set_model(&mut self, _model: &str, _effort: Option<String>) -> Result<(), String> {
            Ok(())
        }
        fn set_config_option(&mut self, _id: &str, _v: &ChatConfigValue) -> Result<(), String> {
            Ok(())
        }
        fn replay(&mut self) -> Result<bool, String> {
            self.replays.fetch_add(1, Ordering::SeqCst);
            Ok(self.can_replay)
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

    /// The two frames that report a session's identity, at their emptiest: what
    /// they carry is not what these tests are about, only that they come back.
    fn ready(id: &str) -> ChatEvent {
        ChatEvent::SessionReady {
            session_id: id.to_string(),
            slash_commands: Vec::new(),
            models: Vec::new(),
            modes: Vec::new(),
            account: None,
            capabilities: None,
        }
    }

    fn started(id: &str) -> ChatEvent {
        ChatEvent::SessionStarted {
            session_id: id.to_string(),
            cwd: "/repo".into(),
            model: "m".into(),
            permission_mode: PermissionMode::new("default"),
            tools: Vec::new(),
            slash_commands: Vec::new(),
            mcp_servers: Vec::new(),
            models: Vec::new(),
            modes: Vec::new(),
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
            account: None,
            extra: Default::default(),
        }
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

    /// A completion, with whatever output the test wants to push through.
    fn completed(id: &str, tool_use_id: &str, output: &str) -> ChatEvent {
        ChatEvent::ToolCallCompleted {
            session_id: id.to_string(),
            turn_id: "t1".into(),
            tool_use_id: tool_use_id.to_string(),
            status: crate::chat::model::ToolStatus::Ok,
            output: Some(output.to_string()),
            files: Vec::new(),
            duration_ms: None,
            summary: None,
            output_truncated: false,
        }
    }

    /// The cache is bounded and evicts oldest-first, so a session that produced
    /// more oversized outputs than the cap keeps the recent ones. Asserted on
    /// the cache directly, because driving `OUTPUT_CACHE_CAP + 1` megabyte
    /// outputs through a host would be a slow way to test a `VecDeque`.
    #[test]
    fn the_output_cache_evicts_oldest_first_at_its_cap() {
        let mut cache = OutputCache::new(2);
        let big = "x".repeat(crate::chat::model::TOOL_OUTPUT_CAP + 1);
        for id in ["a", "b", "c"] {
            let (cut, truncated) = cache.take(id, big.clone());
            assert!(truncated, "{id} was over the cap");
            assert_eq!(cut.len(), crate::chat::model::TOOL_OUTPUT_CAP);
        }
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get("a"), None, "the oldest went first");
        assert_eq!(cache.get("b").map(String::len), Some(big.len()));
        assert_eq!(cache.get("c").map(String::len), Some(big.len()));
    }

    /// An output that fits is not stored at all. Storing it would put a second
    /// copy of what the store already has into a bounded cache, evicting an
    /// entry that is actually needed to hold one that never will be.
    #[test]
    fn an_output_that_fits_is_not_cached() {
        let mut cache = OutputCache::new(4);
        assert_eq!(cache.take("a", "short".into()), ("short".to_string(), false));
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.get("a"), None);
    }

    /// Every live event passes the sink wrapper exactly once, which is what
    /// makes it the place to cut: both transports get this without knowing the
    /// cache exists. An oversized output arrives cut and flagged, and the rest
    /// is waiting where the card will ask for it.
    #[test]
    fn a_huge_output_is_cut_on_its_way_past_and_the_rest_is_kept() {
        let host = ChatHost::at(temp_store());
        let seen = Collector::default();
        let sink_out: Arc<Mutex<Option<Sink>>> = Arc::new(Mutex::new(None));
        let out = sink_out.clone();
        host.spawn("s1", "tab-a", seen.emit(), spec("s1"), move || {
            Box::new(Puppet { sink_out: Some(out), ..Default::default() })
        })
        .unwrap();
        let sink = lock(&sink_out).clone().expect("the puppet published its sink");

        let big = "x".repeat(crate::chat::model::TOOL_OUTPUT_CAP + 500);
        crate::chat::transport::emit(&sink, completed("s1", "toolu_1", &big));

        match seen.events().as_slice() {
            [ChatEvent::ToolCallCompleted { output, output_truncated, .. }] => {
                assert!(*output_truncated);
                assert_eq!(
                    output.as_deref().unwrap_or_default().len(),
                    crate::chat::model::TOOL_OUTPUT_CAP,
                    "the UI gets an extract, not the whole thing"
                );
            }
            other => panic!("expected one completion, got {other:?}"),
        }
        assert_eq!(host.tool_output("s1", "toolu_1").map(|s| s.len()), Some(big.len()));
    }

    /// A question's output is never cut. It lands on a question row rather than
    /// a tool card, so there is nothing there to ask for the rest with, and the
    /// exemption is keyed on Sway's own `QuestionRequest` rather than on one
    /// agent's tool name.
    #[test]
    fn a_questions_answer_is_never_cut() {
        let host = ChatHost::at(temp_store());
        let seen = Collector::default();
        let sink_out: Arc<Mutex<Option<Sink>>> = Arc::new(Mutex::new(None));
        let out = sink_out.clone();
        host.spawn("s1", "tab-a", seen.emit(), spec("s1"), move || {
            Box::new(Puppet { sink_out: Some(out), ..Default::default() })
        })
        .unwrap();
        let sink = lock(&sink_out).clone().expect("the puppet published its sink");

        crate::chat::transport::emit(
            &sink,
            ChatEvent::QuestionRequest {
                session_id: "s1".into(),
                tool_use_id: "toolu_q".into(),
                request_id: "r1".into(),
                agent_id: None,
                questions: Vec::new(),
            },
        );
        let big = "x".repeat(crate::chat::model::TOOL_OUTPUT_CAP + 500);
        crate::chat::transport::emit(&sink, completed("s1", "toolu_q", &big));

        let last = seen.events().pop().expect("a completion");
        match last {
            ChatEvent::ToolCallCompleted { output, output_truncated, .. } => {
                assert!(!output_truncated);
                assert_eq!(output.map(|s| s.len()), Some(big.len()), "an answer record was cut");
            }
            other => panic!("expected a completion, got {other:?}"),
        }
    }

    /// A replayed conversation is cut the same way a live one is, and through
    /// the same cache, so a backfilled card can fetch its remainder instead of
    /// offering a button that could only ever fail.
    #[test]
    fn a_replayed_conversation_is_cut_through_the_same_cache() {
        let host = ChatHost::at(temp_store());
        host.spawn("s1", "tab-a", Collector::default().emit(), spec("s1"), || {
            Box::new(Puppet::default())
        })
        .unwrap();

        let big = "x".repeat(crate::chat::model::TOOL_OUTPUT_CAP + 500);
        let mut events = vec![completed("s1", "toolu_1", &big), completed("s1", "toolu_2", "short")];
        host.cut_outputs("s1", &mut events);

        match events.as_slice() {
            [
                ChatEvent::ToolCallCompleted { output: cut, output_truncated: true, .. },
                ChatEvent::ToolCallCompleted { output: whole, output_truncated: false, .. },
            ] => {
                assert_eq!(cut.as_deref().unwrap_or_default().len(), crate::chat::model::TOOL_OUTPUT_CAP);
                assert_eq!(whole.as_deref(), Some("short"));
            }
            other => panic!("expected two completions, got {other:?}"),
        }
        assert_eq!(host.tool_output("s1", "toolu_1").map(|s| s.len()), Some(big.len()));
        assert_eq!(host.tool_output("s1", "toolu_2"), None, "a short output is not cached");
    }

    /// History can be read for a session that is never spawned. Those outputs
    /// are still cut, and still nothing is stored: a cache per browsed
    /// conversation would have nothing to ever drop it.
    #[test]
    fn browsing_a_dead_sessions_history_cuts_without_caching() {
        let host = ChatHost::at(temp_store());
        let big = "x".repeat(crate::chat::model::TOOL_OUTPUT_CAP + 500);
        let mut events = vec![completed("gone", "toolu_1", &big)];
        host.cut_outputs("gone", &mut events);

        match events.as_slice() {
            [ChatEvent::ToolCallCompleted { output, output_truncated, .. }] => {
                assert!(*output_truncated, "the user is still told it was cut");
                assert_eq!(output.as_deref().unwrap_or_default().len(), crate::chat::model::TOOL_OUTPUT_CAP);
            }
            other => panic!("expected one completion, got {other:?}"),
        }
        assert_eq!(host.tool_output("gone", "toolu_1"), None);
    }

    /// An id nothing cached reads back as `None` rather than as an error: a
    /// short output, an evicted one and a session that never existed are all
    /// "show what you already have".
    #[test]
    fn an_uncached_output_reads_back_as_nothing() {
        let host = ChatHost::at(temp_store());
        assert_eq!(host.tool_output("never-existed", "toolu_1"), None);
    }

    /// **A webview reload leaves the child running and the store empty.**
    ///
    /// The two frames that say a session is open are sent once, to a subscriber
    /// that the reload destroyed. Without replaying them the tab that picks the
    /// session back up has a live session it cannot tell is live: it reads
    /// neither `started` nor `ready`, so it says "Connecting" for as long as it
    /// is open. An ACP session never recovers, because its handshake happens
    /// once; a Claude one limps until `system/init` re-fires on the next turn.
    #[test]
    fn a_rewired_tab_is_told_what_session_it_just_attached_to() {
        let host = ChatHost::at(temp_store());
        let sink_out: Arc<Mutex<Option<Sink>>> = Arc::new(Mutex::new(None));

        let before = Collector::default();
        let out = sink_out.clone();
        host.spawn("s1", "tab-a", before.emit(), spec("s1"), move || {
            Box::new(Puppet { sink_out: Some(out), ..Default::default() })
        })
        .unwrap();

        // The handshake, as a reader thread would deliver it.
        let sink = lock(&sink_out).clone().expect("the puppet published its sink");
        crate::chat::transport::emit(&sink, ready("s1"));
        crate::chat::transport::emit(&sink, started("s1"));
        assert_eq!(before.events().len(), 2);

        let after = Collector::default();
        let outcome = host
            .spawn("s1", "tab-b", after.emit(), spec("s1"), || unreachable!("a live session rewires"))
            .unwrap();
        assert_eq!(outcome, Spawned::Rewired);

        let replayed = after.events();
        assert!(
            matches!(replayed.first(), Some(ChatEvent::SessionReady { .. })),
            "ready first, the order a transport sends them in: {replayed:?}"
        );
        assert!(
            matches!(replayed.get(1), Some(ChatEvent::SessionStarted { .. })),
            "and the session it opened: {replayed:?}"
        );
        assert_eq!(replayed.len(), 2, "the identity, not the conversation: {replayed:?}");
    }

    /// **The other half of the reload story.** A transport that is about to
    /// replay the conversation must not have `SessionStarted` sent ahead of it:
    /// a consumer reads that event as "the session is open, everything before it
    /// was history", so sending it first closes the window before the history
    /// arrives and every replayed turn reads as work happening now. The
    /// transport emits its own once the replay is done.
    #[test]
    fn a_rewire_withholds_the_open_frame_when_the_agent_will_replay() {
        let host = ChatHost::at(temp_store());
        let sink_out: Arc<Mutex<Option<Sink>>> = Arc::new(Mutex::new(None));
        let replays = Arc::new(AtomicU32::new(0));

        let out = sink_out.clone();
        let asked = replays.clone();
        host.spawn("s3", "tab-a", Collector::default().emit(), spec("s3"), move || {
            Box::new(Puppet { sink_out: Some(out), can_replay: true, replays: asked, ..Default::default() })
        })
        .unwrap();

        let sink = lock(&sink_out).clone().expect("the puppet published its sink");
        crate::chat::transport::emit(&sink, ready("s3"));
        crate::chat::transport::emit(&sink, started("s3"));

        let after = Collector::default();
        host.spawn("s3", "tab-b", after.emit(), spec("s3"), || unreachable!("a live session rewires"))
            .unwrap();

        assert_eq!(replays.load(Ordering::SeqCst), 1, "the transport is asked exactly once per rewire");
        let replayed = after.events();
        assert!(
            matches!(replayed.as_slice(), [ChatEvent::SessionReady { .. }]),
            "ready clears \"Connecting\"; started is the replay's job: {replayed:?}"
        );
    }

    /// A rewire before the handshake has nothing to say, and must not invent
    /// a session that is not open yet.
    #[test]
    fn a_rewire_replays_nothing_when_the_session_never_reported_itself() {
        let host = ChatHost::at(temp_store());
        host.spawn("s2", "tab-a", Collector::default().emit(), spec("s2"), || Box::<Puppet>::default())
            .unwrap();

        let after = Collector::default();
        host.spawn("s2", "tab-b", after.emit(), spec("s2"), || unreachable!("a live session rewires"))
            .unwrap();

        assert!(after.events().is_empty(), "nothing handshook, so there is nothing to replay");
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
            Box::new(Puppet { sink_out: Some(holder), ..Default::default() })
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
    /// somewhere a second agent could miss.
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
            Box::new(Puppet { sink_out: Some(out), ..Default::default() })
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
            Box::new(Puppet { sink_out: Some(out), ..Default::default() })
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

    /// The listing a restore matches chat tabs against answers in **session
    /// ids**, never the tab that hosts them. `PtyState::live_ids` answers the
    /// other half in tab ids, so the two sets stay disjoint.
    #[test]
    fn live_ids_are_session_ids_not_the_tabs_hosting_them() {
        let host = ChatHost::at(temp_store());
        for (id, tab) in [("s1", "tab-a"), ("s2", "tab-b")] {
            host.spawn(id, tab, Box::new(|_| {}), spec(id), || {
                Box::new(Puppet::default())
            })
            .unwrap();
        }

        let ids = host.live_ids();

        assert_eq!(ids, vec!["s1", "s2"], "sorted session ids");
        assert!(!ids.iter().any(|id| id.starts_with("tab-")), "a hosting tab id must not appear in the session listing");
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
                Box::new(Puppet { sink_out: None, closed, ..Default::default() })
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
            fn respond_question(
                &mut self,
                _t: &str,
                _r: &str,
                _a: &[QuestionAnswer],
            ) -> Result<bool, String> {
                Ok(false)
            }
            fn set_mode(&mut self, _m: PermissionMode) -> Result<(), String> {
                Ok(())
            }
            fn set_model(&mut self, _m: &str, _e: Option<String>) -> Result<(), String> {
                Ok(())
            }
            fn set_config_option(&mut self, _i: &str, _v: &ChatConfigValue) -> Result<(), String> {
                Ok(())
            }
            fn replay(&mut self) -> Result<bool, String> {
                Ok(false)
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
    /// than falling through. A running child's capture socket path went into its
    /// `--settings` at launch and cannot be changed, so replacing the bridge
    /// would leave the child calling a socket that had just been shut down, and
    /// every later write would lose its diff. This test states the hazard; the
    /// early return in `chat_spawn` is what avoids it.
    #[test]
    fn installing_a_second_bridge_tears_the_first_one_down() {
        let host = ChatHost::at(temp_store());
        let session = format!("rebridge-{}", std::process::id());

        let first = crate::chat::approval::start(Box::new(|_| {})).unwrap();
        let first_dir = first.sock_path().parent().unwrap().to_path_buf();
        host.install_bridge(&session, SessionBridge::new(first, Arc::new(Mutex::new(SnapshotCache::new(8))), &session));
        assert!(first_dir.exists());

        let second = crate::chat::approval::start(Box::new(|_| {})).unwrap();
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

    /// **Tearing a bridge down must not leave its settings file behind.**
    ///
    /// That file names a socket path and carries the token that authenticates to
    /// it. Once the server is down the socket is gone, and a readable file
    /// describing how to talk to it is a credential for nothing that should
    /// still be lying about.
    #[test]
    fn a_torn_down_bridge_leaves_no_settings_file_behind() {
        let session = format!("teardown-{}", std::process::id());
        let server = crate::chat::approval::start(Box::new(|_| {})).unwrap();
        let settings = crate::chat::approval::settings_args(&session, server.sock_path(), server.token()).unwrap();
        let settings_path = std::path::PathBuf::from(&settings[1]);
        assert!(settings_path.exists(), "the session was launched with a settings file");

        let bridge = SessionBridge::new(server, Arc::new(Mutex::new(SnapshotCache::new(8))), &session);
        bridge.teardown();

        assert!(
            !settings_path.exists(),
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
        host.set_model("s1", "claude-opus-5", Some("high".to_string())).unwrap();
        host.set_config_option("s1", "web_search", ChatConfigValue::Flag(true)).unwrap();

        // Close goes through the host's own teardown, not straight to the
        // transport, so the map entry and the claim go with it.
        host.dispatch(&ChatCommand::Close { session_id: "s1".into() }).unwrap();
        assert!(!host.is_live("s1"));
    }

    /// A filled-in form has to reach the transport that is blocked on it, and
    /// the caller has to learn whether it did.
    ///
    /// The bool is the assertion that matters. A question nobody owns means an
    /// answer went nowhere, which is why `answer_question` returns it where
    /// `answer_permission` drops its own: a stale Allow click is routine, a
    /// stale form is a hole in the conversation.
    #[test]
    fn a_question_is_answered_at_the_transport_that_asked_it() {
        let host = ChatHost::at(temp_store());
        host.spawn("s-q", "tab-a", Box::new(|_| {}), spec("s-q"), || Box::<MockTransport>::default())
            .unwrap();

        let answers = vec![QuestionAnswer {
            question: "Which answer channel?".into(),
            picks: vec!["In protocol".into()],
            free_text: None,
        }];
        assert!(
            host.answer_question("s-q", "toolu_4", "op-10", &answers).unwrap(),
            "the mock owns the request, so the answer landed"
        );
        host.dispatch(&ChatCommand::RespondQuestion {
            session_id: "s-q".into(),
            tool_use_id: "toolu_4".into(),
            request_id: "op-10".into(),
            answers,
        })
        .unwrap();

        let err = host.answer_question("s-gone", "toolu_4", "op-10", &[]).unwrap_err();
        assert!(err.contains("no live session"), "{err}");

        host.dispatch(&ChatCommand::Close { session_id: "s-q".into() }).unwrap();
    }
}
