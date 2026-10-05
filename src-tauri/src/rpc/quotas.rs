//! The last quota windows the webview reported per account, so `account.quota`
//! goes out when a window moves and not on every sample of the same numbers.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub kind: String,
    pub utilization: Option<f64>,
    // Epoch seconds.
    pub resets_at: Option<u64>,
}

#[derive(Default)]
pub struct Quotas(Mutex<HashMap<(String, String), BTreeMap<String, Reading>>>);

impl Quotas {
    /// Every window the account has, when any of `readings` moved one.
    pub fn record(&self, agent: &str, profile: Option<&str>, readings: Vec<Reading>) -> Option<Vec<Reading>> {
        let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let account = held
            .entry((agent.to_string(), profile.unwrap_or_default().to_string()))
            .or_default();
        let mut moved = false;
        for reading in readings {
            if account.get(&reading.kind) != Some(&reading) {
                account.insert(reading.kind.clone(), reading);
                moved = true;
            }
        }
        moved.then(|| account.values().cloned().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn five_hour(utilization: f64) -> Reading {
        Reading {
            kind: "five_hour".into(),
            utilization: Some(utilization),
            resets_at: Some(1_900_000_000),
        }
    }

    #[test]
    fn the_same_reading_twice_publishes_once() {
        let quotas = Quotas::default();
        assert!(quotas.record("claude", Some("work"), vec![five_hour(0.4)]).is_some());
        assert!(quotas.record("claude", Some("work"), vec![five_hour(0.4)]).is_none());
        let moved = quotas.record("claude", Some("work"), vec![five_hour(0.5)]).unwrap();
        assert_eq!(moved, [five_hour(0.5)]);
        assert!(
            quotas.record("claude", Some("home"), vec![five_hour(0.5)]).is_some(),
            "another account is its own"
        );
    }
}
