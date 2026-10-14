//! The last quota windows per account, from the chats' own rate limit frames
//! and the window's probes, so `account.quota` goes out when a window moves and
//! not on every sample of the same numbers.

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
    // The harness's own word, about this window only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

const WARM_AT: f64 = 0.6;
const HOT_AT: f64 = 0.8;

/// The windows one rate limit frame names. The frame's status is about its
/// `limit_type` alone, so it is carried only onto that window.
pub fn of_rate_limit(event: &crate::chat::model::ChatEvent) -> Vec<Reading> {
    let crate::chat::model::ChatEvent::RateLimit {
        status,
        resets_at,
        limit_type,
        utilization,
        windows,
        ..
    } = event
    else {
        return Vec::new();
    };
    if !windows.is_empty() {
        return windows
            .iter()
            .map(|w| Reading {
                kind: w.kind.clone(),
                utilization: Some(w.utilization),
                resets_at: w.resets_at,
                status: (Some(&w.kind) == limit_type.as_ref()).then(|| status.clone()),
            })
            .collect();
    }
    let Some(kind) = limit_type else { return Vec::new() };
    vec![Reading {
        kind: kind.clone(),
        utilization: *utilization,
        resets_at: *resets_at,
        status: Some(status.clone()),
    }]
}

fn state(r: &Reading, warn_at: f64, now: u64) -> &'static str {
    if r.resets_at.is_some_and(|at| at <= now) {
        return "expired";
    }
    let status = r.status.as_deref().unwrap_or_default();
    if status == "rejected" || r.utilization.is_some_and(|u| u >= 1.0) {
        return "reached";
    }
    if warn_at <= 0.0 || warn_at >= 1.0 {
        return "ok";
    }
    if r.utilization.is_some_and(|u| u >= warn_at) || status == "allowed_warning" {
        return "approaching";
    }
    // A limit nobody has a name for is still a limit.
    if !status.is_empty() && status != "allowed" {
        return "approaching";
    }
    "ok"
}

fn band(r: &Reading, state: &str) -> &'static str {
    match (state, r.utilization) {
        ("expired", _) => "none",
        ("reached", _) => "hot",
        (_, None) => "none",
        (_, Some(u)) if u >= HOT_AT => "hot",
        (_, Some(u)) if u >= WARM_AT => "warm",
        _ => "clear",
    }
}

fn warn_at(agent: &str, profile: Option<&str>) -> f64 {
    let settings = crate::settings::get_settings();
    let own = settings
        .agent
        .usage
        .get(agent)
        .and_then(|u| u.accounts.get(profile.unwrap_or(crate::accounts::DEFAULT_PROFILE_ID)))
        .and_then(|a| a.warn_at);
    own.unwrap_or(settings.budgets.warn_at_fraction)
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

    pub fn shown(&self, agent: &str, profile: Option<&str>) -> Vec<serde_json::Value> {
        let held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(account) = held.get(&(agent.to_string(), profile.unwrap_or_default().to_string())) else {
            return Vec::new();
        };
        let (warn_at, now) = (warn_at(agent, profile), crate::owned_state::now_ms() / 1000);
        account
            .values()
            .map(|r| {
                let state = state(r, warn_at, now);
                serde_json::json!({
                    "kind": r.kind,
                    "utilization": r.utilization,
                    "resetsAt": r.resets_at,
                    "state": state,
                    "band": band(r, state),
                })
            })
            .collect()
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
            status: None,
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
