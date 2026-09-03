//! What a session off screen is allowed to cost.
//!
//! A streaming agent emits one event per token, three streams deep: assistant
//! text, thinking, and a tool call's arguments as they assemble. Each one
//! crosses the Tauri channel, is parsed in the webview and re-renders a
//! transcript. That is the right price for the chat somebody is reading. It is
//! the wrong price several times over for the three behind it, which are paying
//! it to repaint a DOM nobody can see.
//!
//! So a hidden session's deltas are **coalesced rather than dropped**: they
//! accumulate into one held fragment per stream and are released at most once
//! per [`HIDDEN_RELEASE_MS`]. Two properties make that safe to do to a
//! transcript:
//!
//!   * **Nothing is lost.** Anything that is not a delta releases whatever is
//!     held before it goes past, so a tool call, a turn end or a permission
//!     prompt can never overtake the text that preceded it. Coming back on
//!     screen releases too, which is the case a user can actually observe.
//!   * **Streams never merge.** The held fragment is keyed by stream identity
//!     (kind, turn, and for tool arguments the call), and a fragment from a
//!     different stream releases the previous one first rather than being
//!     appended to it. Concatenating two turns' text would corrupt the
//!     transcript, not merely delay it.
//!
//! The clock is injected. Pacing is the one behaviour here whose whole meaning
//! is "per unit of time", and a test that had to sleep to observe it would be
//! both slow and flaky, so [`Clock`] is a parameter and the tests below drive it
//! by hand.

use std::sync::{Arc, Mutex};

use super::model::ChatEvent;
use super::transport::{emit, Sink};

/// How long a hidden session's deltas accumulate before one release.
///
/// Four repaints a second for a transcript nobody is looking at. Low enough
/// that switching to the tab shows something already close to current, high
/// enough that a fast stream collapses by two orders of magnitude.
pub const HIDDEN_RELEASE_MS: u64 = 250;

/// Reads a monotonic millisecond count.
///
/// Injected rather than called directly so a test can drive a burst through the
/// pacer without sleeping through the interval it is asserting about.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The real clock: milliseconds since this call, monotonic. Not wall time -
/// pacing must not skip an interval or stall for one because the system clock
/// stepped.
pub fn monotonic_clock() -> Clock {
    let start = std::time::Instant::now();
    Arc::new(move || start.elapsed().as_millis() as u64)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        // Same reasoning as the host's: a panicked holder must not wedge a
        // session's whole event stream, and the held fragment is a `String`
        // either way.
        Err(e) => e.into_inner(),
    }
}

/// Which run of deltas a fragment belongs to.
///
/// Identity, not just kind: two turns' text are different streams even though
/// both are `TextDelta`, two tool calls' arguments are different streams even
/// within one turn, and two lanes' text are different streams within one turn.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Stream {
    Text { session_id: String, turn_id: String, agent_id: Option<String> },
    Thinking { session_id: String, turn_id: String, agent_id: Option<String> },
    ToolInput { session_id: String, turn_id: String, tool_use_id: String },
}

impl Stream {
    /// Rebuild the event this stream's accumulated fragment stands for. The
    /// result is indistinguishable from one the transport could have emitted,
    /// which is what lets every consumer stay unaware that pacing exists.
    fn rejoin(self, text: String) -> ChatEvent {
        match self {
            Stream::Text { session_id, turn_id, agent_id } => {
                ChatEvent::TextDelta { session_id, turn_id, text, agent_id }
            }
            Stream::Thinking { session_id, turn_id, agent_id } => {
                ChatEvent::ThinkingDelta { session_id, turn_id, text, agent_id }
            }
            Stream::ToolInput { session_id, turn_id, tool_use_id } => {
                ChatEvent::ToolCallProgress { session_id, turn_id, tool_use_id, partial_input: text }
            }
        }
    }
}

/// Split an event into the stream it belongs to and its fragment.
///
/// `None` for everything that is not a per-token delta, which is the signal to
/// release and pass through. Deliberately exhaustive over the three streaming
/// variants rather than a catch-all: a fourth added later should be a decision
/// here, not silently unthrottled.
fn split(event: &ChatEvent) -> Option<(Stream, String)> {
    match event {
        ChatEvent::TextDelta { session_id, turn_id, text, agent_id } => Some((
            Stream::Text {
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
                agent_id: agent_id.clone(),
            },
            text.clone(),
        )),
        ChatEvent::ThinkingDelta { session_id, turn_id, text, agent_id } => Some((
            Stream::Thinking {
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
                agent_id: agent_id.clone(),
            },
            text.clone(),
        )),
        ChatEvent::ToolCallProgress { session_id, turn_id, tool_use_id, partial_input } => Some((
            Stream::ToolInput {
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
                tool_use_id: tool_use_id.clone(),
            },
            partial_input.clone(),
        )),
        _ => None,
    }
}

struct State {
    visible: bool,
    held: Option<(Stream, String)>,
    /// When a delta last reached the listener, on [`Clock`]'s scale.
    last_release_ms: u64,
}

/// One session's pacer, sitting between its transport and its subscriber.
///
/// It holds the *listener* slot rather than a closure, because a remount swaps
/// the subscriber while the session and its pacer live on: the sink the
/// transport was handed at start-up is fixed for the session's life, and it is
/// this that gets rewired underneath.
pub struct Pacer {
    listener: Sink,
    interval_ms: u64,
    clock: Clock,
    state: Mutex<State>,
}

impl Pacer {
    pub fn new(listener: Sink, visible: bool, interval_ms: u64, clock: Clock) -> Self {
        let now = clock();
        Self {
            listener,
            interval_ms,
            clock,
            state: Mutex::new(State { visible, held: None, last_release_ms: now }),
        }
    }

    /// Take one event from the transport and pass on whatever is due.
    ///
    /// Emits **while holding the state lock**, so a delta arriving on the reader
    /// thread cannot overtake a fragment another thread is releasing. The
    /// listener never calls back in here, so there is no re-entrancy to deadlock
    /// on.
    pub fn deliver(&self, event: ChatEvent) {
        let mut st = lock(&self.state);
        if st.visible {
            emit(&self.listener, event);
            return;
        }
        let Some((stream, text)) = split(&event) else {
            let now = (self.clock)();
            self.release(&mut st, now);
            emit(&self.listener, event);
            return;
        };
        if !st.held.as_ref().is_some_and(|(held, _)| *held == stream) {
            let now = (self.clock)();
            self.release(&mut st, now);
        }
        if let Some((_, held)) = st.held.as_mut() {
            held.push_str(&text);
        } else {
            st.held = Some((stream, text));
        }
        let now = (self.clock)();
        if now.saturating_sub(st.last_release_ms) >= self.interval_ms {
            self.release(&mut st, now);
        }
    }

    /// This session's tab came on screen, or left it.
    pub fn set_visible(&self, visible: bool) {
        let mut st = lock(&self.state);
        if st.visible == visible {
            return;
        }
        st.visible = visible;
        let now = (self.clock)();
        if visible {
            self.release(&mut st, now);
        } else {
            // Stamped, because `last_release_ms` does not move while a session
            // is on screen. Without this a tab that had been visible for a
            // minute would arrive in the background with a whole minute of
            // credit and release its first hidden delta immediately.
            st.last_release_ms = now;
        }
    }

    fn release(&self, st: &mut State, now: u64) {
        let Some((stream, text)) = st.held.take() else { return };
        st.last_release_ms = now;
        emit(&self.listener, stream.rejoin(text));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::model::{ToolKind, ToolStatus, TurnOutcome, Usage};
    use crate::chat::transport::new_sink;

    /// A clock a test steps by hand.
    #[derive(Clone, Default)]
    struct Hand(Arc<Mutex<u64>>);

    impl Hand {
        fn clock(&self) -> Clock {
            let inner = self.0.clone();
            Arc::new(move || *lock(&inner))
        }
        fn advance(&self, ms: u64) {
            *lock(&self.0) += ms;
        }
    }

    #[derive(Clone, Default)]
    struct Seen(Arc<Mutex<Vec<ChatEvent>>>);

    impl Seen {
        fn sink(&self) -> Sink {
            let inner = self.0.clone();
            new_sink(Box::new(move |ev| lock(&inner).push(ev)))
        }
        fn events(&self) -> Vec<ChatEvent> {
            lock(&self.0).clone()
        }
        fn text(&self) -> String {
            self.events()
                .iter()
                .filter_map(|ev| match ev {
                    ChatEvent::TextDelta { text, .. } => Some(text.clone()),
                    _ => None,
                })
                .collect()
        }
    }

    fn text_delta(turn: &str, text: &str) -> ChatEvent {
        laned_text(turn, None, text)
    }

    fn laned_text(turn: &str, agent_id: Option<&str>, text: &str) -> ChatEvent {
        ChatEvent::TextDelta {
            session_id: "s1".into(),
            turn_id: turn.into(),
            text: text.into(),
            agent_id: agent_id.map(str::to_string),
        }
    }

    fn thinking_delta(turn: &str, text: &str) -> ChatEvent {
        ChatEvent::ThinkingDelta {
            session_id: "s1".into(),
            turn_id: turn.into(),
            text: text.into(),
            agent_id: None,
        }
    }

    fn tool_progress(call: &str, part: &str) -> ChatEvent {
        ChatEvent::ToolCallProgress {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            tool_use_id: call.into(),
            partial_input: part.into(),
        }
    }

    fn turn_completed() -> ChatEvent {
        ChatEvent::TurnCompleted {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            outcome: TurnOutcome::Completed,
            stop_reason: None,
            usage: Usage::default(),
            cost_usd: None,
            permission_denials: Vec::new(),
            extra: Default::default(),
        }
    }

    fn paced(seen: &Seen, hand: &Hand, visible: bool) -> Pacer {
        Pacer::new(seen.sink(), visible, HIDDEN_RELEASE_MS, hand.clock())
    }

    /// The motivating claim, driven through the pacer with the clock held still
    /// so the assertion is about the rule rather than about how fast the test
    /// machine happens to be.
    #[test]
    fn a_hidden_session_releases_at_most_one_update_per_interval() {
        let (seen, hand) = (Seen::default(), Hand::default());
        let pacer = paced(&seen, &hand, false);

        for i in 0..200 {
            pacer.deliver(text_delta("t1", &format!("{i} ")));
        }
        assert!(seen.events().is_empty(), "a burst inside one interval should release nothing");

        // Four intervals' worth of wall clock, but each release needs a delta to
        // carry it, so the count is bounded by the intervals rather than by the
        // deltas.
        for _ in 0..4 {
            hand.advance(HIDDEN_RELEASE_MS);
            for i in 0..50 {
                pacer.deliver(text_delta("t1", &format!("{i} ")));
            }
        }
        assert_eq!(seen.events().len(), 4, "one release per elapsed interval, not one per delta");
    }

    /// The other half of the same claim: the chat somebody is reading pays the
    /// full price, unchanged.
    #[test]
    fn a_visible_session_is_not_paced_at_all() {
        let (seen, hand) = (Seen::default(), Hand::default());
        let pacer = paced(&seen, &hand, true);

        for i in 0..200 {
            pacer.deliver(text_delta("t1", &format!("{i} ")));
        }
        assert_eq!(seen.events().len(), 200);
        assert_eq!(seen.events()[7], text_delta("t1", "7 "), "and each one verbatim");
    }

    /// Coalescing is a delay, never a loss. Reassembling the released fragments
    /// has to give back exactly what went in.
    #[test]
    fn nothing_a_hidden_session_wrote_is_lost() {
        let (seen, hand) = (Seen::default(), Hand::default());
        let pacer = paced(&seen, &hand, false);

        let mut wrote = String::new();
        for i in 0..500 {
            let frag = format!("{i} ");
            wrote.push_str(&frag);
            pacer.deliver(text_delta("t1", &frag));
            // Enough elapsed time to release on some deltas and not others, so
            // the reassembly spans both paths.
            if i % 37 == 0 {
                hand.advance(HIDDEN_RELEASE_MS);
            }
        }
        pacer.deliver(turn_completed());
        assert_eq!(seen.text(), wrote);
    }

    /// Ordering is the property a transcript cannot recover from losing: a tool
    /// card rendered above the sentence that introduced it is wrong in a way a
    /// later delta cannot repair.
    #[test]
    fn a_held_fragment_is_released_before_the_event_that_follows_it() {
        let (seen, hand) = (Seen::default(), Hand::default());
        let pacer = paced(&seen, &hand, false);

        pacer.deliver(text_delta("t1", "let me "));
        pacer.deliver(text_delta("t1", "look"));
        let started = ChatEvent::ToolCallStarted {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            tool_use_id: "tu1".into(),
            name: "Read".into(),
            input: serde_json::json!({}),
            kind: ToolKind::Read,
            locations: vec![],
            title: None,
        };
        pacer.deliver(started.clone());

        assert_eq!(seen.events(), vec![text_delta("t1", "let me look"), started]);
    }

    /// Two streams must not be concatenated into one another, however close
    /// together they arrive.
    #[test]
    fn a_fragment_from_another_stream_releases_the_one_being_held() {
        let (seen, hand) = (Seen::default(), Hand::default());
        let pacer = paced(&seen, &hand, false);

        pacer.deliver(text_delta("t1", "first turn"));
        pacer.deliver(thinking_delta("t1", "hmm"));
        pacer.deliver(text_delta("t2", "second turn"));
        pacer.deliver(tool_progress("tu1", "{\"pa"));
        pacer.deliver(tool_progress("tu2", "{\"ot"));
        pacer.deliver(turn_completed());

        assert_eq!(
            seen.events(),
            vec![
                text_delta("t1", "first turn"),
                thinking_delta("t1", "hmm"),
                text_delta("t2", "second turn"),
                tool_progress("tu1", "{\"pa"),
                tool_progress("tu2", "{\"ot"),
                turn_completed(),
            ]
        );
    }

    /// Two lanes inside one turn are two streams. Nothing captured has a
    /// subagent streaming, so this is synthesised: the failure it prevents is a
    /// subagent's report being appended to the main agent's paragraph.
    #[test]
    fn two_lanes_in_one_turn_are_not_concatenated() {
        let (seen, hand) = (Seen::default(), Hand::default());
        let pacer = paced(&seen, &hand, false);

        pacer.deliver(laned_text("t1", None, "the main agent"));
        pacer.deliver(laned_text("t1", Some("acb01121756a92ca0"), "the subagent"));
        pacer.deliver(laned_text("t1", None, ", still"));
        pacer.deliver(turn_completed());

        assert_eq!(
            seen.events(),
            vec![
                laned_text("t1", None, "the main agent"),
                laned_text("t1", Some("acb01121756a92ca0"), "the subagent"),
                laned_text("t1", None, ", still"),
                turn_completed(),
            ]
        );
    }

    /// The one delay a user can actually observe, and the one that must not
    /// survive the moment they look.
    #[test]
    fn coming_back_on_screen_releases_what_was_held() {
        let (seen, hand) = (Seen::default(), Hand::default());
        let pacer = paced(&seen, &hand, false);

        pacer.deliver(text_delta("t1", "held"));
        assert!(seen.events().is_empty());

        pacer.set_visible(true);
        assert_eq!(seen.events(), vec![text_delta("t1", "held")]);

        pacer.deliver(text_delta("t1", " and live"));
        assert_eq!(seen.events().len(), 2, "and it is unpaced from there");
    }

    /// A tab that has been on screen for a while has not been accruing credit
    /// for the pacing it was not doing.
    #[test]
    fn a_tab_just_sent_to_the_background_gets_no_free_release() {
        let (seen, hand) = (Seen::default(), Hand::default());
        let pacer = paced(&seen, &hand, true);

        hand.advance(60_000);
        pacer.set_visible(false);
        pacer.deliver(text_delta("t1", "first hidden fragment"));

        assert!(seen.events().is_empty(), "the minute it spent visible must not buy an immediate release");
        hand.advance(HIDDEN_RELEASE_MS);
        pacer.deliver(text_delta("t1", "!"));
        assert_eq!(seen.events(), vec![text_delta("t1", "first hidden fragment!")]);
    }

    /// The end of a session is not a delta, so it takes the release-first path
    /// like any other event - which is what stops a session's last words dying
    /// with it.
    #[test]
    fn a_session_ending_releases_before_it_reports() {
        let (seen, hand) = (Seen::default(), Hand::default());
        let pacer = paced(&seen, &hand, false);

        pacer.deliver(text_delta("t1", "last words"));
        let ended = ChatEvent::SessionEnded { session_id: "s1".into(), reason: None };
        pacer.deliver(ended.clone());

        assert_eq!(seen.events(), vec![text_delta("t1", "last words"), ended]);
    }

    /// A completed tool call is not a delta either, and its `files` list is what
    /// checkpoint attribution reads, so it must never be folded into anything.
    #[test]
    fn a_completed_tool_call_passes_through_whole() {
        let (seen, hand) = (Seen::default(), Hand::default());
        let pacer = paced(&seen, &hand, false);

        let done = ChatEvent::ToolCallCompleted {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            tool_use_id: "tu1".into(),
            status: ToolStatus::Ok,
            output: None,
            files: vec!["src/main.rs".into()],
            duration_ms: None,
            summary: None,
            output_truncated: false,
            patch: Vec::new(),
        };
        pacer.deliver(done.clone());
        assert_eq!(seen.events(), vec![done]);
    }
}
