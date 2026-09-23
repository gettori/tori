//! What each live session is doing, as the webview last reported it. The
//! webview computes the dot and owns it; this is a copy so `sessions.list` and
//! the `sessions` topic can answer without a round trip into it.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Working,
    NeedsYou,
    Idle,
    Ended,
}

#[derive(Debug, Deserialize)]
pub struct Reported {
    pub id: String,
    pub state: SessionState,
}

#[derive(Default)]
pub struct SessionStates(Mutex<HashMap<String, SessionState>>);

impl SessionStates {
    // The webview's whole list rather than a delta, so one a reload lost still
    // gets cleared. A session no longer listed comes back as `Ended`.
    pub fn replace(&self, reported: Vec<Reported>) -> Vec<(String, SessionState)> {
        let next: HashMap<String, SessionState> = reported.into_iter().map(|r| (r.id, r.state)).collect();
        let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut moved: BTreeMap<String, SessionState> = held
            .keys()
            .filter(|id| !next.contains_key(*id))
            .map(|id| (id.clone(), SessionState::Ended))
            .collect();
        for (id, state) in &next {
            if held.get(id) != Some(state) {
                moved.insert(id.clone(), *state);
            }
        }
        *held = next;
        moved.into_iter().collect()
    }

    pub fn snapshot(&self) -> HashMap<String, SessionState> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

