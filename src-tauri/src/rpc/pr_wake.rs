//! Delivers a pull request watch's pending news to the watching session: one
//! Tori note per wake, only once that session has been idle a while. It never
//! calls a model. The rules mirror the autopilot watcher's, per session.

use std::collections::{BTreeMap, HashMap};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::pr_watch::{self, Watch};

// A turn that ends and another that starts at once is the agent carrying on.
const IDLE_DEBOUNCE: Duration = Duration::from_secs(10);
// Every wake is a paid turn.
const REPEAT_WINDOW: Duration = Duration::from_secs(5 * 60);
const MAX_WAIT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Track {
    in_turn: bool,
    idle_since: Option<Instant>,
}

#[derive(Default)]
pub struct Core {
    tracks: HashMap<String, Track>,
    last_sent: HashMap<String, Instant>,
    deadlines: HashMap<String, Instant>,
}

impl Core {
    pub fn observe(&mut self, session: &str, kind: &str, now: Instant) {
        match kind {
            "session.turn_started" => {
                let track = self.tracks.entry(session.to_string()).or_default();
                (track.in_turn, track.idle_since) = (true, None);
            }
            "session.turn_ended" => {
                let track = self.tracks.entry(session.to_string()).or_default();
                (track.in_turn, track.idle_since) = (false, Some(now));
            }
            "session.ended" => {
                self.tracks.remove(session);
                self.deadlines.remove(session);
            }
            _ => {}
        }
    }

    // A session not seen ending a turn since Tori started counts its idle from
    // the first time it is asked about.
    pub fn due(&mut self, session: &str, ready: bool, now: Instant) -> bool {
        self.deadlines.remove(session);
        if !ready {
            return false;
        }
        let track = self.tracks.entry(session.to_string()).or_default();
        if track.in_turn {
            return false;
        }
        let quiet = *track.idle_since.get_or_insert(now) + IDLE_DEBOUNCE;
        let window = self.last_sent.get(session).map(|at| *at + REPEAT_WINDOW);
        let at = window.map_or(quiet, |w| w.max(quiet));
        if now < at {
            self.deadlines.insert(session.to_string(), at);
            return false;
        }
        true
    }

    // A send opens a turn; if it never starts, the window still holds the next one.
    pub fn sent(&mut self, session: &str, now: Instant) {
        self.last_sent.insert(session.to_string(), now);
        self.tracks.entry(session.to_string()).or_default().idle_since = None;
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        self.deadlines.values().min().copied()
    }
}

// One wake for every watched pull request of the session with news, and how
// much of each one's pending news it rendered.
pub fn wake_for(watches: &[Watch], session: &str) -> Option<(String, Vec<(String, usize)>)> {
    let mine: Vec<&Watch> = watches.iter().filter(|w| w.session == session && !w.pending.is_empty()).collect();
    if mine.is_empty() {
        return None;
    }
    let text = mine.iter().map(|w| pr_watch::render(&w.url, &w.pending)).collect::<Vec<_>>().join("\n\n");
    Some((text, mine.iter().map(|w| (w.url.clone(), w.pending.len())).collect()))
}

pub fn sessions_with_news(watches: &[Watch]) -> Vec<String> {
    let sessions: BTreeMap<&str, ()> = watches.iter().filter(|w| !w.pending.is_empty()).map(|w| (w.session.as_str(), ())).collect();
    sessions.into_keys().map(str::to_string).collect()
}

pub struct Waker {
    core: Mutex<Core>,
    nudge: Sender<()>,
}

static WAKER: OnceLock<Waker> = OnceLock::new();

impl Waker {
    fn core(&self) -> MutexGuard<'_, Core> {
        self.core.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn session_event(session: &str, event: &Value) {
    if let Some(waker) = WAKER.get() {
        waker.core().observe(session, event["kind"].as_str().unwrap_or_default(), Instant::now());
        let _ = waker.nudge.send(());
    }
}

pub fn nudge() {
    if let Some(waker) = WAKER.get() {
        let _ = waker.nudge.send(());
    }
}

pub fn start(ready: impl Fn(&str) -> bool + Send + 'static, deliver: impl Fn(&str, String) -> Result<(), String> + Send + 'static) {
    let (nudge, rx) = mpsc::channel();
    if WAKER.set(Waker { core: Mutex::default(), nudge }).is_err() {
        return;
    }
    std::thread::spawn(move || run(rx, ready, deliver));
}

fn run(rx: Receiver<()>, ready: impl Fn(&str) -> bool, deliver: impl Fn(&str, String) -> Result<(), String>) {
    let Some(waker) = WAKER.get() else { return };
    loop {
        let watches = pr_watch::store().list();
        for session in sessions_with_news(&watches) {
            let now = Instant::now();
            if !waker.core().due(&session, ready(&session), now) {
                continue;
            }
            let Some((text, told)) = wake_for(&watches, &session) else { continue };
            if let Err(e) = deliver(&session, text) {
                eprintln!("tori: pull request wake not delivered: {e}");
                continue;
            }
            waker.core().sent(&session, now);
            let before = pr_watch::polled();
            let saved = pr_watch::store().update(|all| {
                all.iter()
                    .filter_map(|w| {
                        let (_, n) = told.iter().find(|(url, _)| w.session == session && &w.url == url)?;
                        let mut next = w.clone();
                        next.delivered(*n);
                        Some(next)
                    })
                    .collect()
            });
            if let Err(e) = saved {
                eprintln!("tori: pull request watch not saved after a wake: {e}");
            }
            if pr_watch::polled() != before {
                pr_watch::polled_moved();
            }
        }
        let next = waker.core().next_deadline();
        let wait = next.map_or(MAX_WAIT, |at| at.saturating_duration_since(Instant::now())).min(MAX_WAIT);
        match rx.recv_timeout(wait) {
            Err(RecvTimeoutError::Disconnected) => return,
            _ => while rx.try_recv().is_ok() {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(t0: Instant, secs: u64) -> Instant {
        t0 + Duration::from_secs(secs)
    }

    #[test]
    fn a_busy_session_is_held_until_its_turn_ends_and_ten_seconds_pass() {
        let (mut core, t0) = (Core::default(), Instant::now());
        core.observe("s", "session.turn_started", t0);
        assert!(!core.due("s", true, at(t0, 30)), "in a turn");
        core.observe("s", "session.turn_ended", at(t0, 40));
        assert!(!core.due("s", true, at(t0, 45)), "inside the debounce");
        assert_eq!(core.next_deadline(), Some(at(t0, 50)));
        core.observe("s", "session.turn_started", at(t0, 46));
        assert!(!core.due("s", true, at(t0, 51)), "the agent carried on");
        core.observe("s", "session.turn_ended", at(t0, 60));
        assert!(core.due("s", true, at(t0, 70)));
    }

    #[test]
    fn a_session_not_ready_is_held_and_delivered_once_it_is() {
        // No live process, or a chat stopped by its spend ceiling, which reports needs_you.
        let (mut core, t0) = (Core::default(), Instant::now());
        assert!(!core.due("s", false, t0));
        assert_eq!(core.next_deadline(), None, "waits for a nudge, not a clock");
        assert!(!core.due("s", true, at(t0, 100)), "a session first seen idle still waits the debounce");
        assert!(core.due("s", true, at(t0, 110)));
    }

    #[test]
    fn a_second_wake_waits_out_the_repeat_window() {
        let (mut core, t0) = (Core::default(), Instant::now());
        core.observe("s", "session.turn_ended", t0);
        assert!(core.due("s", true, at(t0, 10)));
        core.sent("s", at(t0, 10));
        core.observe("s", "session.turn_started", at(t0, 11));
        core.observe("s", "session.turn_ended", at(t0, 30));
        assert!(!core.due("s", true, at(t0, 60)));
        assert_eq!(core.next_deadline(), Some(at(t0, 310)));
        assert!(core.due("s", true, at(t0, 310)));
    }
}
