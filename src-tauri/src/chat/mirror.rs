//! The event log Tori keeps beside an ACP session.
//!
//! Every other agent Tori drives writes a transcript of its own that
//! `chat_history` can read back. An ACP agent keeps its conversation privately
//! and hands it over only as `session/load`'s replay, on the live channel, to a
//! session that is already running. So a tab restored after a restart has
//! nothing to draw until it spawns a child - which [[adr_lazy_tab_attachment]]
//! deliberately will not do until the user asks.
//!
//! This module closes that gap by writing the events down as they go past. Two
//! properties keep it honest:
//!
//!   * **The log is a cache of the agent's replay, never the truth.** The agent
//!     owns its conversation; a session continued in the codex CLI and reopened
//!     in Tori must show the CLI's turns, not Tori's stale copy. So a replay
//!     that brings a conversation *rebuilds* the file, and one that brings
//!     nothing leaves it alone rather than emptying it.
//!   * **It costs the reader thread nothing measurable.** Every live event of
//!     both transports passes `ChatHost::wrap` once, on the child's stdout
//!     reader thread, and anything slow there is backpressure on the agent.
//!     Measured 2026-09-08 on a release build: 38 us to serialise a 63 KB turn
//!     and 31 us to append it, against 4.9 ms for one `sync_data`. That ratio
//!     is the whole reason [`SYNC_ON_TURN`] is off.
//!
//! The file is `<id>.jsonl` beside the locator, one [`ChatEvent`] per line. Not
//! `.json`, deliberately: `acp_sessions::all()` scans that directory for
//! locators by extension, and a log wearing the locator's extension would be
//! parsed as a session and listed as one.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::model::ChatEvent;
use super::pacing::{split, Stream};

/// Whether a completed turn is forced to disk before the append returns.
///
/// **Off**, and the measurement is why: `sync_data` costs 4.9 ms against 31 us
/// to append, and it would spend that on the child's stdout reader thread once
/// per turn. What it buys is a turn surviving a power cut - the page cache
/// already survives a crash of Tori itself - and what is at risk is the tail of
/// a log that the agent can replay in full anyway. The constant exists so the
/// trade is named rather than assumed, and so a test can drive both sides.
const SYNC_ON_TURN: bool = false;

/// Where the mirror's lines actually go.
///
/// A seam rather than a `File` for the same reason the transport's sink is a
/// closure: the properties worth testing here are "how many times was this
/// opened" and "how many times was it synced", and neither is observable
/// through the filesystem.
pub trait LogWriter: Send {
    /// Add lines to the end of the log, opening it if this is the first write.
    fn append(&mut self, lines: &[String]) -> Result<(), String>;

    /// Replace the whole log with these lines, as one atomic swap.
    fn replace(&mut self, lines: &[String]) -> Result<(), String>;

    /// Replace the sidecar beside the log with this body.
    fn meta(&mut self, body: &str) -> Result<(), String>;

    /// Force what has been appended out to disk.
    fn sync(&mut self) -> Result<(), String>;
}

/// The figures a reader wants without parsing the conversation.
///
/// A prompt count is the one number the sidebar and the chat's status strip
/// both ask for, and deriving it from the log would mean reading every turn of
/// every listed session to draw a list. So the mirror, which already knows the
/// answer as it writes, writes it down beside the log.
///
/// **`.meta`, not `.json`**, for the same reason the log is `.jsonl`:
/// `acp_sessions::all` lists this directory by extension.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogMeta {
    /// Human prompts in the log, which is to say `userMessage` lines.
    #[serde(default)]
    pub prompt_count: u32,
    /// Epoch seconds when Tori last saw a prompt go past on this session, or 0
    /// when it never has. **Stamped from the clock**, because no `ChatEvent`
    /// carries a time of its own; a replay therefore leaves it where it was
    /// rather than dating an old conversation to the moment it was reopened.
    #[serde(default)]
    pub last_prompt_ts: u64,
    /// The model the session last reported. Observed on `SessionStarted`, which
    /// [`keep`] skips, so it cannot be recovered from the log.
    #[serde(default)]
    pub model: String,
}

/// The sidecar that belongs to a session file.
///
/// **The one derivation, called by everything that needs the path.** The log
/// and the locator share a stem and a directory, so either resolves onto the
/// same sidecar; that is a coincidence worth relying on but not worth spelling
/// out three times, since three spellings of it would eventually disagree about
/// an id with a dot in it.
pub fn meta_of(file: &Path) -> PathBuf {
    file.with_extension("meta")
}

/// The real thing: one append handle, opened on first use and kept.
///
/// Opened lazily so a session that never says anything leaves no file, which is
/// what lets "did this transport write a log at all" be a test.
pub struct FileLog {
    path: PathBuf,
    handle: Option<std::fs::File>,
}

impl FileLog {
    pub fn at(path: PathBuf) -> Self {
        Self { path, handle: None }
    }

    fn open(&mut self) -> Result<&mut std::fs::File, String> {
        if self.handle.is_none() {
            if let Some(parent) = self.path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .map_err(|e| e.to_string())?;
            self.handle = Some(file);
        }
        Ok(self.handle.as_mut().expect("just opened"))
    }
}

impl LogWriter for FileLog {
    fn append(&mut self, lines: &[String]) -> Result<(), String> {
        if lines.is_empty() {
            return Ok(());
        }
        let mut batch = String::new();
        for line in lines {
            batch.push_str(line);
            batch.push('\n');
        }
        let file = self.open()?;
        file.write_all(batch.as_bytes()).map_err(|e| e.to_string())
    }

    /// Written beside the log and renamed over it, so a reader either sees the
    /// whole rebuilt conversation or the whole previous one. A truncate-then-
    /// write would leave a window where the log is the empty file, and that
    /// window is exactly when a restored tab is reading it.
    fn replace(&mut self, lines: &[String]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("jsonl.tmp");
        let mut batch = String::new();
        for line in lines {
            batch.push_str(line);
            batch.push('\n');
        }
        std::fs::write(&tmp, batch.as_bytes()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        // The old handle points at the file that was just renamed away, so
        // appending through it would write into an unlinked inode nobody can
        // read. Dropped here; the next append reopens against the new file.
        self.handle = None;
        Ok(())
    }

    /// Tmp-then-rename like [`Self::replace`], and for the sharper version of
    /// the same reason: the sidecar is one small object, so a reader catching a
    /// partial write gets a parse failure rather than a short count.
    fn meta(&mut self, body: &str) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let meta = meta_of(&self.path);
        let tmp = meta.with_extension("meta.tmp");
        std::fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &meta).map_err(|e| e.to_string())
    }

    fn sync(&mut self) -> Result<(), String> {
        match self.handle.as_mut() {
            Some(file) => file.sync_data().map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }
}

/// What the mirror does with one event.
///
/// Exhaustive over [`ChatEvent`] on purpose, matching `pacing::split`'s reason:
/// a variant added later is a decision about whether a restored conversation
/// should contain it, and a catch-all would make that decision silently.
enum Keep {
    /// A per-token delta, joined onto the run it belongs to.
    Coalesce,
    /// Stored as it stands.
    Whole,
    /// Not part of the conversation, so not in the log.
    Skip,
}

fn keep(event: &ChatEvent) -> Keep {
    match event {
        // What the *session* is, not what was said in it. Replaying these from
        // disk into a restored tab would announce a session that is not open
        // and publish a model catalogue nobody asked the agent for.
        ChatEvent::SessionStarted { .. }
        | ChatEvent::SessionReady { .. }
        | ChatEvent::SessionEnded { .. }
        | ChatEvent::SessionError { .. }
        | ChatEvent::ConfigOptions { .. }
        | ChatEvent::SlashCommands { .. } => Keep::Skip,

        // Settled in the moment they happened. A permission prompt read back
        // from disk is a button that answers a question no agent is waiting on,
        // and a rate-limit notice is about a window that has since moved.
        ChatEvent::PermissionRequest { .. }
        | ChatEvent::QuestionRequest { .. }
        | ChatEvent::HookFired { .. }
        | ChatEvent::ModeRefused { .. }
        | ChatEvent::RateLimit { .. } => Keep::Skip,

        ChatEvent::TextDelta { .. } | ChatEvent::ThinkingDelta { .. } | ChatEvent::ToolCallProgress { .. } => {
            Keep::Coalesce
        }

        ChatEvent::TurnStarted { .. }
        | ChatEvent::UserMessage { .. }
        | ChatEvent::Compacted { .. }
        | ChatEvent::LocalCommand { .. }
        | ChatEvent::CompactionStarted { .. }
        | ChatEvent::CompactionFailed { .. }
        | ChatEvent::ToolCallStarted { .. }
        | ChatEvent::ToolCallCompleted { .. }
        | ChatEvent::FileEdit { .. }
        | ChatEvent::SubagentStarted { .. }
        | ChatEvent::SubagentCall { .. }
        | ChatEvent::SubagentUpdate { .. }
        | ChatEvent::PlanUpdate { .. }
        | ChatEvent::Usage { .. }
        | ChatEvent::TurnCompleted { .. } => Keep::Whole,
    }
}

/// Is this event part of the conversation itself?
///
/// The question the replay window asks, and only that: a replay carrying one of
/// these brought a conversation back and the log should be rebuilt from it,
/// where a replay carrying only notices and config brought nothing and must
/// leave the log alone. The same set the panel keys its own transcript reset on,
/// so the two cannot disagree about what "the replay brought something" means.
///
/// The panel does not carry its own copy of this list. `model.rs`'s fixture
/// emitter writes the tags out of *this* function and `chatTypes.ts` reads that
/// file, the same contract the event model itself uses: a variant added here
/// fails the TypeScript test until the panel agrees.
pub(super) fn is_conversation(event: &ChatEvent) -> bool {
    matches!(
        event,
        ChatEvent::UserMessage { .. }
            | ChatEvent::TextDelta { .. }
            | ChatEvent::ThinkingDelta { .. }
            | ChatEvent::ToolCallStarted { .. }
            | ChatEvent::ToolCallCompleted { .. }
            | ChatEvent::SubagentStarted { .. }
            | ChatEvent::Compacted { .. }
            | ChatEvent::LocalCommand { .. }
    )
}

#[derive(Default)]
struct State {
    /// The run of deltas being joined, and what has joined it so far. At most
    /// one: a fragment from any other stream releases this one first, which is
    /// [`super::pacing`]'s rule and is what keeps the order on disk the order
    /// it happened in.
    held: Option<(Stream, String)>,
    /// The turn being assembled, written in one batch when it completes.
    turn: Vec<ChatEvent>,
    /// Whether the agent is still handing the conversation back.
    replaying: bool,
    /// What the replay has brought so far. Held rather than appended because
    /// the replay is the *whole* conversation: it replaces the log rather than
    /// extending it, or a reopened session would hold every turn twice.
    replayed: Vec<ChatEvent>,
    /// Whether any of that was conversation, which is what decides between a
    /// rebuild and leaving the file untouched.
    brought_conversation: bool,
    /// What the sidecar will say at the next write. Seeded from the sidecar
    /// already on disk, or a session whose replay brings nothing back would
    /// count its new turns up from zero and understate a conversation the log
    /// still holds in full.
    meta: LogMeta,
}

/// One session's log, written from the sink wrapper every live event passes.
///
/// Held as an `Arc` by the host's entry and by every `wrap` closure that entry
/// ever gets, so a webview reload rewires the subscriber without opening a
/// second handle or losing the turn in flight.
pub struct Mirror {
    /// Write failures are swallowed rather than raised. A full disk must not
    /// take a working chat down over a file the agent can replay in full, and
    /// there is no session-level event that would mean "your history is not
    /// being saved" without reading as a failure of the conversation itself.
    writer: Mutex<Box<dyn LogWriter>>,
    state: Mutex<State>,
}

impl Mirror {
    /// A mirror writing to a real file.
    ///
    /// Starts **inside the replay window**: a session that is spawning may be
    /// about to `session/load`, and the frames from that load must rebuild the
    /// log rather than double it. A spawn that turns out to be a `session/new`
    /// brings no conversation and so leaves the file alone.
    pub fn at(path: PathBuf) -> Self {
        let seed = read_meta(&meta_of(&path)).unwrap_or_default();
        let mirror = Self::with_writer(Box::new(FileLog::at(path)));
        lock(&mirror.state).meta = seed;
        mirror
    }

    pub fn with_writer(writer: Box<dyn LogWriter>) -> Self {
        Self {
            writer: Mutex::new(writer),
            state: Mutex::new(State {
                replaying: true,
                ..State::default()
            }),
        }
    }

    /// A rewire whose transport promised to replay the conversation.
    ///
    /// Reopens the window, because the frames about to arrive are the same
    /// conversation again rather than new work. Called by the host at exactly
    /// the point it decides to withhold `SessionStarted` for the same reason.
    ///
    /// **The turn in flight is dropped, not kept.** A webview reload can land
    /// mid-turn, and a buffered half-turn would be appended at its
    /// `TurnCompleted` - which arrives *after* the replay has atomically
    /// replaced the file, so the log would end with a duplicate of content the
    /// replace already wrote, out of order. The replay is the authority here;
    /// losing at most half of one turn beats corrupting the file it lands in.
    pub fn expect_replay(&self) {
        let mut state = lock(&self.state);
        state.replaying = true;
        state.replayed.clear();
        state.brought_conversation = false;
        state.held = None;
        state.turn.clear();
    }

    /// One event on its way past, from the sink wrapper.
    pub fn note(&self, event: &ChatEvent) {
        let mut state = lock(&self.state);

        // Both figures are caught here, before `keep` gets a say. `keep` skips
        // `SessionStarted`, the only frame carrying the model, and no event
        // carries a wall clock at all, so neither is recoverable from the log.
        match event {
            ChatEvent::SessionStarted { model, .. } => state.meta.model = model.clone(),
            // Live prompts only. A replay is the agent handing back turns that
            // already happened, and stamping those would date the whole
            // conversation to the moment the tab was reopened.
            ChatEvent::UserMessage { .. } if !state.replaying => state.meta.last_prompt_ts = now_secs(),
            _ => {}
        }

        // The end of a replay. `SessionStarted` is what the transport emits once
        // the load has answered, so everything before it was the conversation.
        if state.replaying && matches!(event, ChatEvent::SessionStarted { .. }) {
            self.settle_replay(&mut state);
            return;
        }

        match keep(event) {
            Keep::Skip => {}
            Keep::Coalesce => {
                let Some((stream, fragment)) = split(event) else { return };
                match state.held.take() {
                    // Same run, so the fragment joins it rather than becoming a
                    // second event that says the model paused for a token.
                    Some((held, mut text)) if held == stream => {
                        text.push_str(&fragment);
                        state.held = Some((held, text));
                    }
                    Some((held, text)) => {
                        let joined = held.rejoin(text);
                        push(&mut state, joined);
                        state.held = Some((stream, fragment));
                    }
                    None => state.held = Some((stream, fragment)),
                }
            }
            Keep::Whole => {
                self.release(&mut state);
                push(&mut state, event.clone());
            }
        }

        // A turn is the unit written, so the buffer never grows past one and a
        // reader after a crash is one turn behind rather than a whole session.
        if matches!(event, ChatEvent::TurnCompleted { .. }) {
            self.flush(&mut state, SYNC_ON_TURN);
        }
        // The session is over and there will be no `TurnCompleted` to close an
        // interrupted turn, so whatever it said goes down now.
        if matches!(event, ChatEvent::SessionEnded { .. }) {
            self.release(&mut state);
            self.flush(&mut state, false);
        }
    }

    /// Close the replay window, rebuilding the log from what it brought.
    fn settle_replay(&self, state: &mut State) {
        self.release(state);
        state.replaying = false;
        let replayed = std::mem::take(&mut state.replayed);
        let brought = std::mem::take(&mut state.brought_conversation);
        // **Only a replay that brought a conversation replaces one.** An agent
        // that cannot load, one that has forgotten the session, and the host
        // re-emitting its cached identity frame all arrive here with nothing,
        // and writing that would delete the history this file exists to hold.
        if !brought {
            return;
        }
        let lines = encode(&replayed);
        if lock(&self.writer).replace(&lines).is_err() {
            return;
        }
        // Set, not added: the replay is the whole conversation, so its prompts
        // are the log's prompts however many the file held a moment ago.
        state.meta.prompt_count = prompts_in(&replayed);
        self.write_meta(state);
    }

    /// Write the held fragment out as the event it stands for.
    fn release(&self, state: &mut State) {
        if let Some((stream, text)) = state.held.take() {
            let joined = stream.rejoin(text);
            push(state, joined);
        }
    }

    /// Put the assembled turn on disk.
    fn flush(&self, state: &mut State, sync: bool) {
        let turn = std::mem::take(&mut state.turn);
        if turn.is_empty() {
            return;
        }
        let lines = encode(&turn);
        {
            let mut writer = lock(&self.writer);
            if writer.append(&lines).is_err() {
                return;
            }
            if sync {
                let _ = writer.sync();
            }
        }
        state.meta.prompt_count += prompts_in(&turn);
        self.write_meta(state);
    }

    /// Put the figures beside the log, after the log itself is on disk.
    ///
    /// Written at each of the two write points rather than per event: it is the
    /// same one small object every time, and a sidecar ahead of the log it
    /// describes would promise a turn a reader cannot find.
    fn write_meta(&self, state: &State) {
        let Ok(body) = serde_json::to_string(&state.meta) else {
            return;
        };
        let _ = lock(&self.writer).meta(&body);
    }
}

impl Drop for Mirror {
    /// A session torn down mid-turn still said what it said. Without this, the
    /// last turn of every chat closed while the agent was talking would be the
    /// one turn missing from the log.
    fn drop(&mut self) {
        let mut state = lock(&self.state);
        self.release(&mut state);
        // A replay interrupted before its `SessionStarted` is not a
        // conversation to keep: it is half of one, and half would replace the
        // whole one already on disk.
        if state.replaying {
            return;
        }
        self.flush(&mut state, false);
    }
}

/// File the event where the window says it belongs.
fn push(state: &mut State, event: ChatEvent) {
    if state.replaying {
        state.brought_conversation |= is_conversation(&event);
        state.replayed.push(event);
    } else {
        state.turn.push(event);
    }
}

/// Human prompts among these events, which is the log's whole definition of one.
fn prompts_in(events: &[ChatEvent]) -> u32 {
    events
        .iter()
        .filter(|e| matches!(e, ChatEvent::UserMessage { .. }))
        .count() as u32
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The figures beside a log, or `None` when there is no sidecar to read.
///
/// A sidecar that will not parse reads the same as one that is absent. It is
/// derived from the log and rewritten at the next turn, so the honest answer
/// for a torn one is "not known yet" rather than an error a caller would have
/// to render.
pub fn read_meta(path: &Path) -> Option<LogMeta> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Read a log back as the events it recorded, plus the number of lines that
/// would not parse.
///
/// A bad line is skipped rather than failing the read, for the same reason
/// `acp_sessions::all` skips a corrupt locator: one torn line - the tail of a
/// turn interrupted by a crash is the likely one - must not hide every turn
/// before it. The count is returned rather than swallowed so the caller can say
/// so; a conversation silently missing a turn is the failure that looks like no
/// failure at all.
///
/// A missing file reads as an empty conversation, which is what a session that
/// has not spoken yet is.
pub fn read_log(path: &Path) -> (Vec<ChatEvent>, usize) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (Vec::new(), 0);
    };
    let mut events = Vec::new();
    let mut skipped = 0;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<ChatEvent>(line) {
            Ok(event) => events.push(event),
            Err(_) => skipped += 1,
        }
    }
    (events, skipped)
}

/// One JSON object per line. An event that will not serialise is dropped rather
/// than written half-formed: a truncated line would take the rest of the file
/// with it on the next read.
fn encode(events: &[ChatEvent]) -> Vec<String> {
    events.iter().filter_map(|e| serde_json::to_string(e).ok()).collect()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        // Same reasoning as the host's and the pacer's: a panicked holder must
        // not wedge a session's whole event stream over a log.
        Err(e) => e.into_inner(),
    }
}

/// A log writer that records what it was asked to do.
///
/// Shared with the host's tests rather than duplicated there, the way
/// [`super::transport::mock`] is shared: "how many handles did this session
/// open" and "how many times was it synced" are the properties both modules
/// assert, and neither is observable through the filesystem.
#[cfg(test)]
pub(crate) mod recorder {
    use super::*;
    use std::sync::Arc;

    #[derive(Default)]
    pub struct Recorder {
        pub lines: Vec<String>,
        /// Counted the way [`FileLog`] opens: once on the first write, and
        /// again after a `replace` renames the old file away.
        pub opens: usize,
        pub appends: usize,
        pub replaces: usize,
        pub syncs: usize,
        /// The sidecar body of each write, so a test can assert what a reader
        /// would find without going near a filesystem.
        pub metas: Vec<String>,
        open: bool,
    }

    #[derive(Clone, Default)]
    pub struct Handle(pub Arc<Mutex<Recorder>>);

    impl Handle {
        /// Every logged event's wire tag, in order.
        pub fn kinds(&self) -> Vec<String> {
            lock(&self.0)
                .lines
                .iter()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .filter_map(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
                .collect()
        }

        pub fn count(&self, kind: &str) -> usize {
            self.kinds().iter().filter(|k| *k == kind).count()
        }

        /// What the last sidecar write said, as a reader would parse it.
        pub fn meta(&self) -> Option<LogMeta> {
            lock(&self.0)
                .metas
                .last()
                .and_then(|body| serde_json::from_str(body).ok())
        }
    }

    impl LogWriter for Handle {
        fn append(&mut self, lines: &[String]) -> Result<(), String> {
            let mut guard = lock(&self.0);
            if !guard.open {
                guard.open = true;
                guard.opens += 1;
            }
            guard.appends += 1;
            guard.lines.extend_from_slice(lines);
            Ok(())
        }
        fn replace(&mut self, lines: &[String]) -> Result<(), String> {
            let mut guard = lock(&self.0);
            guard.replaces += 1;
            guard.lines = lines.to_vec();
            guard.open = false;
            Ok(())
        }
        fn meta(&mut self, body: &str) -> Result<(), String> {
            lock(&self.0).metas.push(body.to_string());
            Ok(())
        }
        fn sync(&mut self) -> Result<(), String> {
            lock(&self.0).syncs += 1;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::model;
    use super::recorder::Handle;
    use super::*;

    fn mirror() -> (Mirror, Handle) {
        let handle = Handle::default();
        let mirror = Mirror::with_writer(Box::new(handle.clone()));
        // Live from the start: the replay window is what the window tests drive
        // on purpose, and every other test is about a session already open.
        mirror.note(&started());
        (mirror, handle)
    }

    fn started() -> ChatEvent {
        ChatEvent::SessionStarted {
            session_id: "s1".into(),
            cwd: "/tmp".into(),
            model: "m".into(),
            permission_mode: model::PermissionMode::new("default"),
            tools: Vec::new(),
            slash_commands: Vec::new(),
            mcp_servers: Vec::new(),
            models: Vec::new(),
            modes: Vec::new(),
            fast_mode_state: None,
            fast_mode_disabled_reason: None,
            account: None,
            extra: model::Extra::new(),
        }
    }

    fn text(turn: &str, text: &str) -> ChatEvent {
        ChatEvent::TextDelta {
            session_id: "s1".into(),
            turn_id: turn.into(),
            text: text.into(),
            agent_id: None,
        }
    }

    fn tool_started(turn: &str, id: &str) -> ChatEvent {
        ChatEvent::ToolCallStarted {
            session_id: "s1".into(),
            turn_id: turn.into(),
            tool_use_id: id.into(),
            name: "Read".into(),
            input: serde_json::json!({}),
            kind: model::ToolKind::Read,
            locations: Vec::new(),
            title: None,
            secret: None,
        }
    }

    fn tool_completed(turn: &str, id: &str) -> ChatEvent {
        ChatEvent::ToolCallCompleted {
            session_id: "s1".into(),
            turn_id: turn.into(),
            tool_use_id: id.into(),
            status: model::ToolStatus::Ok,
            output: Some("ok".into()),
            files: Vec::new(),
            duration_ms: None,
            summary: None,
            output_truncated: false,
            patch: Vec::new(),
        }
    }

    fn turn_done(turn: &str) -> ChatEvent {
        ChatEvent::TurnCompleted {
            session_id: "s1".into(),
            turn_id: turn.into(),
            outcome: model::TurnOutcome::Completed,
            stop_reason: Some("end_turn".into()),
            usage: model::Usage::default(),
            cost_usd: None,
            permission_denials: Vec::new(),
            extra: model::Extra::new(),
        }
    }

    fn user(turn: &str, said: &str) -> ChatEvent {
        ChatEvent::UserMessage {
            session_id: "s1".into(),
            turn_id: turn.into(),
            blocks: vec![model::ContentBlock::Text { text: said.into() }],
        }
    }

    /// **The coalescing rule, at the volume it exists for.** 500 deltas become
    /// two text events because two tool calls split the run, and neither tool
    /// call overtakes the text that preceded it.
    #[test]
    fn a_turn_of_deltas_is_coalesced_but_never_reordered() {
        let (mirror, log) = mirror();
        for i in 0..250 {
            mirror.note(&text("t1", &format!("{i} ")));
        }
        mirror.note(&tool_started("t1", "c1"));
        mirror.note(&tool_completed("t1", "c1"));
        for i in 0..250 {
            mirror.note(&text("t1", &format!("{i} ")));
        }
        mirror.note(&tool_started("t1", "c2"));
        mirror.note(&tool_completed("t1", "c2"));
        mirror.note(&turn_done("t1"));

        assert_eq!(
            log.kinds(),
            vec![
                "textDelta",
                "toolCallStarted",
                "toolCallCompleted",
                "textDelta",
                "toolCallStarted",
                "toolCallCompleted",
                "turnCompleted",
            ],
            "500 deltas are two runs, and a tool call never overtakes the text before it"
        );
    }

    /// A run is joined, not merely counted: the text on disk is the text that
    /// streamed, in order.
    #[test]
    fn a_coalesced_run_holds_every_fragment_in_order() {
        let (mirror, log) = mirror();
        for word in ["one ", "two ", "three"] {
            mirror.note(&text("t1", word));
        }
        mirror.note(&turn_done("t1"));

        let joined = lock(&log.0)
            .lines
            .iter()
            .filter_map(|l| serde_json::from_str::<ChatEvent>(l).ok())
            .find_map(|e| match e {
                ChatEvent::TextDelta { text, .. } => Some(text),
                _ => None,
            })
            .expect("the run is on disk");
        assert_eq!(joined, "one two three");
    }

    /// Two turns' text are different streams even though both are `TextDelta`,
    /// so the second never joins the first.
    #[test]
    fn two_turns_are_never_joined_into_one_run() {
        let (mirror, log) = mirror();
        mirror.note(&text("t1", "first"));
        mirror.note(&turn_done("t1"));
        mirror.note(&text("t2", "second"));
        mirror.note(&turn_done("t2"));

        assert_eq!(
            log.kinds(),
            vec!["textDelta", "turnCompleted", "textDelta", "turnCompleted"]
        );
    }

    /// **Nothing is synced per event, and nothing per turn either while
    /// [`SYNC_ON_TURN`] is off.** The cost this avoids is 4.9 ms on the child's
    /// reader thread, measured; the exposure it accepts is one turn of a file
    /// the agent can replay in full.
    #[test]
    fn a_streaming_turn_never_touches_the_disk_sync() {
        let (mirror, log) = mirror();
        for i in 0..500 {
            mirror.note(&text("t1", &format!("{i}")));
        }
        mirror.note(&turn_done("t1"));

        let guard = lock(&log.0);
        assert_eq!(guard.syncs, 0, "a turn must not pay for an fsync");
        assert_eq!(guard.appends, 1, "and a turn is one append, not five hundred");
    }

    /// **The replay rebuilds, the live stream extends.** Three replayed turns
    /// and two streamed after it are five turns, not eight and not two.
    #[test]
    fn a_replay_rebuilds_the_log_and_live_turns_extend_it() {
        let handle = Handle::default();
        let mirror = Mirror::with_writer(Box::new(handle.clone()));
        for turn in ["t1", "t2", "t3"] {
            mirror.note(&user(turn, "ask"));
            mirror.note(&text(turn, "answer"));
        }
        mirror.note(&started());
        for turn in ["t4", "t5"] {
            mirror.note(&user(turn, "ask"));
            mirror.note(&text(turn, "answer"));
            mirror.note(&turn_done(turn));
        }

        let users = handle.count("userMessage");
        assert_eq!(
            users,
            5,
            "three replayed turns plus two live ones: {:?}",
            handle.kinds()
        );
        let guard = lock(&handle.0);
        assert_eq!(guard.replaces, 1, "the replay replaces the log exactly once");
    }

    /// **A bare `SessionStarted` leaves the log alone.** The host re-emits its
    /// cached identity frame on every rewire, and an agent that cannot load
    /// answers one too. Either would empty a five-turn log if arrival were the
    /// trigger rather than content.
    #[test]
    fn a_session_started_that_brought_nothing_leaves_the_log_alone() {
        let (mirror, log) = mirror();
        for turn in ["t1", "t2", "t3", "t4", "t5"] {
            mirror.note(&user(turn, "ask"));
            mirror.note(&turn_done(turn));
        }
        assert_eq!(log.count("userMessage"), 5);

        mirror.expect_replay();
        mirror.note(&started());

        assert_eq!(
            log.count("userMessage"),
            5,
            "a replay that brought nothing must not replace five turns with none"
        );
        assert_eq!(lock(&log.0).replaces, 0);
    }

    /// The same, through the path that actually produces it: a `session/load`
    /// that failed emits a non-fatal `SessionError` and then the session opens
    /// anyway. Neither frame is a conversation.
    #[test]
    fn a_failed_load_leaves_the_log_alone() {
        let (mirror, log) = mirror();
        for turn in ["t1", "t2", "t3", "t4", "t5"] {
            mirror.note(&user(turn, "ask"));
            mirror.note(&turn_done(turn));
        }

        mirror.expect_replay();
        mirror.note(&ChatEvent::SessionError {
            session_id: "s1".into(),
            message: "this agent would not hand the conversation back".into(),
            fatal: false,
        });
        mirror.note(&started());

        assert_eq!(
            log.count("userMessage"),
            5,
            "a refused load is not an empty conversation"
        );
    }

    /// **A reload mid-turn must not leave a half-turn to land after the
    /// rebuild.** The `TurnCompleted` that would flush it arrives *after* the
    /// replay has atomically replaced the file, so a buffer kept across the
    /// window would append content the replace had already written, out of
    /// order. The replay is the authority; the half-turn goes.
    #[test]
    fn a_reload_mid_turn_does_not_replay_its_own_half_turn_back() {
        let (mirror, log) = mirror();
        mirror.note(&user("t1", "ask"));
        mirror.note(&text("t1", "half an ans"));

        // The webview reloads while the agent is still talking.
        mirror.expect_replay();
        mirror.note(&user("t1", "ask"));
        mirror.note(&text("t1", "the whole answer"));
        mirror.note(&started());
        // The turn finishes on the live channel afterwards.
        mirror.note(&turn_done("t1"));

        assert_eq!(
            log.kinds(),
            vec!["userMessage", "textDelta", "turnCompleted"],
            "the replay is the conversation, and the buffer it superseded is gone"
        );
        assert_eq!(lock(&log.0).replaces, 1);
    }

    /// A session torn down mid-turn still said what it said.
    #[test]
    fn a_turn_still_running_at_drop_is_written_out() {
        let (mirror, log) = mirror();
        mirror.note(&user("t1", "ask"));
        mirror.note(&text("t1", "half an ans"));
        drop(mirror);

        assert_eq!(log.kinds(), vec!["userMessage", "textDelta"]);
    }

    /// **The figures land beside the log, on a real filesystem.** The sidecar
    /// exists so a listing can say how many prompts a session holds without
    /// reading a turn of it, so what a reader would actually find is the thing
    /// worth asserting.
    #[test]
    fn three_flushed_turns_leave_their_count_beside_the_log() {
        let dir = std::env::temp_dir().join(format!("tori-mirror-meta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let log = dir.join("s1.jsonl");

        let before = now_secs();
        let mirror = Mirror::at(log.clone());
        mirror.note(&started());
        for turn in ["t1", "t2", "t3"] {
            mirror.note(&user(turn, "ask"));
            mirror.note(&text(turn, "answer"));
            mirror.note(&turn_done(turn));
        }

        let meta = read_meta(&dir.join("s1.meta")).expect("the sidecar is beside the log");
        assert_eq!(meta.prompt_count, 3);
        assert_eq!(
            meta.model, "m",
            "observed on SessionStarted, which the log itself skips"
        );
        assert!(
            meta.last_prompt_ts >= before,
            "the last prompt is stamped from the clock"
        );
        assert!(!dir.join("s1.meta.tmp").exists(), "the swap leaves nothing behind");
    }

    /// **A replay sets the count, it does not add to it.** The replay replaces
    /// the whole log, so a count carried over from the turns it just overwrote
    /// would double every reopened conversation. Its timestamps do not move
    /// either: those turns already happened, and dating them to the reopen
    /// would make every restored session look like it was just used.
    #[test]
    fn a_replay_sets_the_count_rather_than_adding_to_it() {
        let (mirror, log) = mirror();
        for turn in ["t1", "t2", "t3"] {
            mirror.note(&user(turn, "ask"));
            mirror.note(&turn_done(turn));
        }
        let live = log.meta().expect("three live turns wrote a sidecar");
        assert_eq!(live.prompt_count, 3);

        mirror.expect_replay();
        for turn in ["r1", "r2"] {
            mirror.note(&user(turn, "ask"));
            mirror.note(&text(turn, "answer"));
        }
        mirror.note(&started());

        let after = log.meta().expect("the rebuild wrote one too");
        assert_eq!(
            after.prompt_count, 2,
            "the replay is the whole conversation, not an addition"
        );
        assert_eq!(
            after.last_prompt_ts, live.last_prompt_ts,
            "a replayed prompt is not a new one"
        );
    }

    /// **A reopened session counts on from the sidecar, not from zero.** An
    /// agent whose replay brings nothing back leaves the log in place, so a
    /// mirror that started its count at zero would report the new turns alone
    /// and understate a conversation the file still holds in full.
    #[test]
    fn a_reopened_session_counts_on_from_what_the_sidecar_held() {
        let dir = std::env::temp_dir().join(format!("tori-mirror-seed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let log = dir.join("s1.jsonl");

        let first = Mirror::at(log.clone());
        first.note(&started());
        for turn in ["t1", "t2"] {
            first.note(&user(turn, "ask"));
            first.note(&turn_done(turn));
        }
        drop(first);

        let second = Mirror::at(log.clone());
        second.note(&started());
        second.note(&user("t3", "ask"));
        second.note(&turn_done("t3"));

        let meta = read_meta(&dir.join("s1.meta")).expect("the sidecar survived the reopen");
        assert_eq!(meta.prompt_count, 3, "two turns on disk plus the one just sent");
    }

    /// What the session *is* never reaches the log. Read back into a restored
    /// tab these would announce a session that is not open.
    #[test]
    fn the_log_holds_the_conversation_and_not_the_session() {
        let (mirror, log) = mirror();
        mirror.note(&ChatEvent::ConfigOptions {
            session_id: "s1".into(),
            options: Vec::new(),
        });
        mirror.note(&user("t1", "ask"));
        mirror.note(&turn_done("t1"));

        assert_eq!(log.kinds(), vec!["userMessage", "turnCompleted"]);
    }
}
