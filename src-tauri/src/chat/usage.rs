//! What a session has cost, kept across restarts.
//!
//! **Why this has to be persisted at all.** `total_cost_usd` on a `result` frame
//! is per *turn*, not per session (measured, see `chatUsage.ts`), so a session
//! total is the sum of the turns Sway watched finish. Held only in the panel's
//! store, that sum resets every time the tab is reopened - which is fine for a
//! readout and useless for a ceiling, because a budget that forgets itself on
//! restart is not a budget.
//!
//! **One map per project, not one file per session.** The owned-state layout
//! calls for a small map atomically replaced, never a file per fact. Keying by
//! project rather than putting every session in one global map keeps each file
//! bounded by the sessions of one project, so the rewrite stays small on a
//! machine with years of history, and uses the shared path shape
//! [`crate::owned_state::project_state_path`] gives every per-project store.
//!
//! **Turns observed is recorded next to turns cost**, because the difference is
//! the honesty rule: a chat opened on a session with prior turns has history it
//! never saw a `result` frame for, so its total is a floor. Storing only the sum
//! would lose the one fact that says whether the sum can be trusted.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::owned_state::write_atomically;

/// The version stamped into a usage file.
///
/// Held here rather than shared, and deliberately still `2`: this used to be the
/// *rule* file's version constant, borrowed because both files were written by
/// the same module. Every usage file already on disk carries that value, so
/// giving this store its own constant must not change it - renumbering to 1
/// would make every existing file look like it came from the future.
const FORMAT_VERSION: u32 = 2;

/// One session's running total.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub tokens: u64,
    /// `None` until some turn actually reported a cost, so a session whose
    /// agent reports no money reads as "unknown" rather than as free.
    #[serde(default)]
    pub cost_usd: Option<f64>,
    /// Turns Sway watched finish, which is what the two figures above are the
    /// sum of.
    pub turns: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageFile {
    #[serde(default)]
    pub format_version: u32,
    #[serde(default)]
    pub sessions: BTreeMap<String, SessionUsage>,
}

pub fn usage_path(cwd: &str) -> PathBuf {
    crate::owned_state::project_state_path("usage", cwd)
}

pub fn load(path: &Path) -> UsageFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Add one completed turn and return the session's new total.
///
/// Read-modify-write from the supervisor's own call path, which is the only
/// writer, so there is no second party to race. The turn is counted whether or
/// not it reported a cost: `turns` is what the floor rule compares against, and
/// dropping an uncosted turn would make an *incomplete* observation look
/// complete.
pub fn record_turn(path: &Path, session_id: &str, tokens: u64, cost_usd: Option<f64>) -> Result<SessionUsage, String> {
    let mut file = load(path);
    file.format_version = FORMAT_VERSION;
    let entry = file.sessions.entry(session_id.to_string()).or_default();
    entry.tokens = entry.tokens.saturating_add(tokens);
    entry.turns = entry.turns.saturating_add(1);
    if let Some(cost) = cost_usd {
        entry.cost_usd = Some(entry.cost_usd.unwrap_or(0.0) + cost);
    }
    let total = entry.clone();
    write_atomically(path, &serde_json::to_string(&file).map_err(|e| e.to_string())?)?;
    Ok(total)
}

/// What a project has spent across every session in it, for the project ceiling.
pub fn project_total(file: &UsageFile) -> SessionUsage {
    let mut out = SessionUsage::default();
    for s in file.sessions.values() {
        out.tokens = out.tokens.saturating_add(s.tokens);
        out.turns = out.turns.saturating_add(s.turns);
        if let Some(cost) = s.cost_usd {
            out.cost_usd = Some(out.cost_usd.unwrap_or(0.0) + cost);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sway-usage-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("usage.json")
    }

    /// The whole reason this is on disk: a ceiling that forgets what has been
    /// spent every time a tab is reopened is not a ceiling.
    #[test]
    fn a_sessions_total_survives_being_reopened() {
        let path = scratch("survives");
        record_turn(&path, "s1", 100, Some(0.01)).unwrap();
        record_turn(&path, "s1", 250, Some(0.02)).unwrap();

        let reloaded = load(&path);
        let s1 = &reloaded.sessions["s1"];
        assert_eq!(s1.tokens, 350);
        assert_eq!(s1.turns, 2);
        assert!((s1.cost_usd.unwrap() - 0.03).abs() < 1e-9);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A turn that reported no cost still counts as a turn. `turns` is what the
    /// floor rule compares against the transcript, so dropping an uncosted turn
    /// would make an incomplete observation look complete.
    #[test]
    fn a_turn_with_no_cost_still_counts_as_observed() {
        let path = scratch("uncosted");
        let after = record_turn(&path, "s1", 10, None).unwrap();
        assert_eq!(after.turns, 1);
        assert_eq!(after.cost_usd, None, "no cost reported is not the same as free");

        let with_cost = record_turn(&path, "s1", 10, Some(0.5)).unwrap();
        assert_eq!(with_cost.turns, 2);
        assert_eq!(with_cost.cost_usd, Some(0.5), "the costed turns still add up");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Sessions in one project share a file, and the project ceiling is measured
    /// across all of them - two chats open on one repo spend one budget.
    #[test]
    fn a_projects_total_spans_every_session_in_it() {
        let path = scratch("project");
        record_turn(&path, "s1", 100, Some(0.10)).unwrap();
        record_turn(&path, "s2", 200, Some(0.20)).unwrap();

        let total = project_total(&load(&path));
        assert_eq!(total.tokens, 300);
        assert_eq!(total.turns, 2);
        assert!((total.cost_usd.unwrap() - 0.30).abs() < 1e-9);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Two checkouts of one repo are two projects, and must not share a budget.
    #[test]
    fn two_checkouts_sharing_a_basename_get_separate_usage_files() {
        let a = usage_path("/Users/x/Projects/sway/main");
        let b = usage_path("/Users/x/Projects/sway-wt/main");
        assert_ne!(a, b);
        assert_eq!(a.parent(), b.parent());
    }
}
