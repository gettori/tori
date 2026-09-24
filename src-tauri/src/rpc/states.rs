//! What each live session is doing, as the webview last reported it. The
//! webview computes the dot and owns it; this is a copy so `sessions.list` and
//! the `sessions` topic can answer without a round trip into it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::events::{same_folder, session_event, Place};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Working,
    NeedsYou,
    Idle,
    Ended,
}

// A chat's start and end are announced by `ChatHost`, which knows the reason;
// a PTY agent's only by this cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Chat,
    Pty,
}

#[derive(Debug, Deserialize)]
pub struct Reported {
    pub id: String,
    pub state: SessionState,
    pub source: Source,
    #[serde(default)]
    pub folder: Option<String>,
    // The PTY tab running it, which is how a PTY is known to be alive.
    #[serde(default)]
    pub tab: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Held {
    pub state: SessionState,
    pub source: Source,
    pub tab: Option<String>,
    folder: Option<String>,
    place: Place,
}

#[derive(Default)]
pub struct SessionStates {
    states: Mutex<HashMap<String, Held>>,
    settled: Condvar,
    // Spawned unattended, read by the approval gate on every outward call.
    background: Mutex<HashSet<String>>,
    workers: Mutex<HashSet<String>>,
    // Worker -> the chat session that spawned it.
    spawned_by: Mutex<HashMap<String, String>>,
}

impl SessionStates {
    // The webview's whole list, so one a reload lost still gets cleared. Absence
    // alone is not an end, since a reload restores tabs per workspace on first
    // visit, so an absent session ends only once `alive` says its child is gone.
    pub fn replace(
        &self,
        reported: Vec<Reported>,
        place_of: impl Fn(&str) -> Place,
        alive: impl Fn(&str, &Held) -> bool,
    ) -> Vec<Value> {
        let mut held = self.states.lock().unwrap_or_else(|e| e.into_inner());
        let mut events = Vec::new();
        let mut next: BTreeMap<String, Held> = BTreeMap::new();
        for r in reported {
            let before = held.remove(&r.id);
            let place = match &before {
                Some(b) if b.folder == r.folder => b.place.clone(),
                _ => r.folder.as_deref().map(&place_of).unwrap_or_default(),
            };
            if before.is_none() && r.source == Source::Pty {
                events.push(session_event("session.started", &r.id, &place, json!({})));
            }
            let was = before.as_ref().map(|b| b.state);
            if was != Some(r.state) {
                events.push(session_event("session.state", &r.id, &place, json!({ "state": r.state })));
                if r.state == SessionState::NeedsYou {
                    events.push(session_event("session.needs_you", &r.id, &place, json!({})));
                }
            }
            next.insert(r.id, Held { state: r.state, source: r.source, tab: r.tab, folder: r.folder, place });
        }
        let mut ended = Vec::new();
        for (id, gone) in held.drain() {
            if alive(&id, &gone) {
                next.insert(id, gone);
                continue;
            }
            events.push(session_event("session.state", &id, &gone.place, json!({ "state": SessionState::Ended })));
            if gone.source == Source::Pty {
                events.push(session_event("session.ended", &id, &gone.place, json!({})));
            }
            ended.push(id);
        }
        *held = next.into_iter().collect();
        let mut background = self.background.lock().unwrap_or_else(|e| e.into_inner());
        let mut workers = self.workers.lock().unwrap_or_else(|e| e.into_inner());
        let mut spawned_by = self.spawned_by.lock().unwrap_or_else(|e| e.into_inner());
        for id in ended {
            background.remove(&id);
            workers.remove(&id);
            spawned_by.remove(&id);
        }
        self.settled.notify_all();
        events
    }

    pub fn wait_settled(&self, id: &str, timeout: Duration) -> Option<SessionState> {
        let deadline = Instant::now() + timeout;
        let mut held = self.states.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let state = held.get(id)?.state;
            let left = deadline.saturating_duration_since(Instant::now());
            if state != SessionState::Working || left.is_zero() {
                return Some(state);
            }
            held = self.settled.wait_timeout(held, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    pub fn snapshot(&self) -> HashMap<String, SessionState> {
        let held = self.states.lock().unwrap_or_else(|e| e.into_inner());
        held.iter().map(|(id, h)| (id.clone(), h.state)).collect()
    }

    pub fn ids_in(&self, folder: &str) -> Vec<String> {
        let held = self.states.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<String> =
            held.iter().filter(|(_, h)| h.folder.as_deref().is_some_and(|f| same_folder(f, folder))).map(|(id, _)| id.clone()).collect();
        ids.sort();
        ids
    }

    pub fn mark_background(&self, id: &str) {
        self.background.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string());
    }

    pub fn background(&self) -> HashSet<String> {
        self.background.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn is_background(&self, id: &str) -> bool {
        self.background.lock().unwrap_or_else(|e| e.into_inner()).contains(id)
    }

    pub fn mark_worker(&self, id: &str, spawner: &str) {
        self.workers.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string());
        self.spawned_by.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), spawner.to_string());
    }

    pub fn rebind_spawner(&self, from: &str, to: &str) {
        let mut spawned_by = self.spawned_by.lock().unwrap_or_else(|e| e.into_inner());
        spawned_by.values_mut().filter(|s| *s == from).for_each(|s| *s = to.to_string());
    }

    // The topmost background session in `id`'s spawn chain, `id` itself
    // included; `None` when `id` is not background.
    pub fn root_background(&self, id: &str) -> Option<String> {
        let background = self.background.lock().unwrap_or_else(|e| e.into_inner());
        let spawned_by = self.spawned_by.lock().unwrap_or_else(|e| e.into_inner());
        let mut root = background.contains(id).then(|| id.to_string())?;
        while let Some(parent) = spawned_by.get(&root).filter(|p| background.contains(p.as_str())) {
            root = parent.clone();
        }
        Some(root)
    }

    pub fn is_worker(&self, id: &str) -> bool {
        self.workers.lock().unwrap_or_else(|e| e.into_inner()).contains(id)
    }

    pub fn forget_worker(&self, id: &str) {
        self.workers.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        self.spawned_by.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(id: &str, state: SessionState, source: Source) -> Reported {
        Reported { id: id.into(), state, source, folder: Some("/p/wt".into()), tab: Some(format!("tab-{id}")) }
    }

    fn place(_: &str) -> Place {
        Place { project: Some("/p".into()), folder: Some("/p/wt".into()) }
    }

    fn kinds(events: &[Value]) -> Vec<String> {
        events.iter().map(|e| format!("{} {}", e["kind"].as_str().unwrap(), e["id"].as_str().unwrap())).collect()
    }

    const GONE: fn(&str, &Held) -> bool = |_, _| false;

    #[test]
    fn a_chat_added_then_dropped_announces_no_lifecycle() {
        let states = SessionStates::default();
        let first = states.replace(vec![report("c", SessionState::Working, Source::Chat)], place, GONE);
        assert_eq!(kinds(&first), ["session.state c"]);
        assert_eq!(first[0]["project"], "/p");
        let second = states.replace(vec![], place, GONE);
        assert_eq!(kinds(&second), ["session.state c"]);
        assert_eq!(second[0]["state"], "ended");
    }

    #[test]
    fn a_pty_added_then_dropped_starts_and_ends() {
        let states = SessionStates::default();
        let first = states.replace(vec![report("p", SessionState::Working, Source::Pty)], place, GONE);
        assert_eq!(kinds(&first), ["session.started p", "session.state p"]);
        let second = states.replace(vec![], place, GONE);
        assert_eq!(kinds(&second), ["session.state p", "session.ended p"]);
    }

    #[test]
    fn needs_you_fires_on_the_rising_edge_only() {
        let states = SessionStates::default();
        states.replace(vec![report("c", SessionState::Working, Source::Chat)], place, GONE);
        let up = states.replace(vec![report("c", SessionState::NeedsYou, Source::Chat)], place, GONE);
        assert_eq!(kinds(&up), ["session.state c", "session.needs_you c"]);
        let same = states.replace(vec![report("c", SessionState::NeedsYou, Source::Chat)], place, GONE);
        assert!(same.is_empty());
    }

    #[test]
    fn a_session_missing_from_the_list_but_still_running_is_kept_quietly() {
        let states = SessionStates::default();
        states.replace(vec![report("p", SessionState::Idle, Source::Pty)], place, GONE);
        let reload = states.replace(vec![], place, |_, held| held.tab.as_deref() == Some("tab-p"));
        assert!(reload.is_empty());
        assert_eq!(states.snapshot().get("p"), Some(&SessionState::Idle));
        let back = states.replace(vec![report("p", SessionState::Idle, Source::Pty)], place, GONE);
        assert!(back.is_empty(), "coming back is not a second start");
    }

    #[test]
    fn a_waiter_wakes_when_the_session_settles() {
        let states = std::sync::Arc::new(SessionStates::default());
        states.replace(vec![report("w", SessionState::Working, Source::Chat)], place, GONE);
        assert_eq!(states.wait_settled("w", Duration::from_millis(20)), Some(SessionState::Working));
        assert_eq!(states.wait_settled("nobody", Duration::from_secs(5)), None);
        let flipping = states.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            flipping.replace(vec![report("w", SessionState::Idle, Source::Chat)], place, GONE);
        });
        assert_eq!(states.wait_settled("w", Duration::from_secs(5)), Some(SessionState::Idle));
    }

    #[test]
    fn a_workers_root_is_the_topmost_background_session_above_it() {
        let states = SessionStates::default();
        states.mark_background("autopilot");
        states.mark_worker("worker", "autopilot");
        states.mark_background("worker");
        states.mark_worker("helper", "worker");
        states.mark_background("helper");
        assert_eq!(states.root_background("helper").as_deref(), Some("autopilot"));
        assert_eq!(states.root_background("autopilot").as_deref(), Some("autopilot"));
        states.mark_worker("fg", "autopilot");
        assert_eq!(states.root_background("fg"), None, "a foreground session has no root");
        states.forget_worker("worker");
        assert_eq!(states.root_background("helper").as_deref(), Some("worker"), "an ended link stops the walk");
    }

    #[test]
    fn an_ended_session_is_no_longer_a_worker() {
        let states = SessionStates::default();
        states.replace(vec![report("w", SessionState::Working, Source::Chat)], place, GONE);
        states.mark_worker("w", "boss");
        states.mark_background("w");
        assert!(states.is_worker("w"));
        states.replace(vec![], place, GONE);
        assert!(!states.is_worker("w"));
        assert!(!states.is_background("w"));
        assert!(states.spawned_by.lock().unwrap().is_empty(), "its spawner link went with it");
    }

    #[test]
    fn the_project_is_resolved_once_per_session() {
        let states = SessionStates::default();
        let calls = std::cell::Cell::new(0);
        let counting = |folder: &str| {
            calls.set(calls.get() + 1);
            place(folder)
        };
        states.replace(vec![report("c", SessionState::Working, Source::Chat)], counting, GONE);
        states.replace(vec![report("c", SessionState::Idle, Source::Chat)], counting, GONE);
        assert_eq!(calls.get(), 1);
    }
}
