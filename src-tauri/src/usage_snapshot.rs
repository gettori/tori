//! Where the titlebar's quota readings survive a restart.
//!
//! Two things live in one file per install:
//!
//! - **The last snapshot**, so the strip opens with the windows it knew rather
//!   than blank until the first turn of the day runs.
//! - **The fired dedupe keys**, so a restart *inside* a window that has already
//!   been announced does not announce it again. Without these the notice would
//!   be tied to a process rather than to a window, and quitting Sway would be a
//!   way to hear about the same 90% five times.
//!
//! **There was a third thing and it is gone: a bounded 7-day ring of past
//! readings, for a chart of how a window got to where it is.** The chart is not
//! being built, and the reason is the same one that would have made it wrong. A
//! quota window belongs to the *account*, not to Sway: turns run in the CLI, in
//! the desktop app, or on another machine all count against it. The ring records
//! only what Sway itself read, so a stretch with Sway shut has no samples in it
//! while the level goes on moving, and on a real machine that is most of the
//! week. A file that grows to draw a chart which is mostly hole is worth
//! neither. What answers the question is the current level and its reset, and
//! those are in the snapshot.
//!
//! The frontend owns the merge (`src/utils/usageStore.ts`); this owns durability
//! and the prune. The prune happens on save rather than on load, so a file left
//! by a Sway that ran a fortnight ago cannot come back holding stale keys.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One window as some source reported it. Mirrors `WindowReading` in
/// `src/utils/usageStore.ts`; the fields travel through Rust untouched, so a
/// window kind this build has never heard of round-trips rather than being
/// dropped at the door.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowReading {
    pub kind: String,
    #[serde(default)]
    pub utilization: Option<f64>,
    /// Epoch **seconds**, as every source sends it.
    #[serde(default)]
    pub resets_at: Option<u64>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub reached_type: Option<String>,
    /// Epoch **milliseconds**: a local clock reading, not a source's.
    pub sampled_at: u64,
    pub source: String,
}

/// What the frontend hands over and gets back, and what sits on disk.
///
/// `BTreeMap` rather than `HashMap` throughout, so the file is byte-stable
/// across saves that changed nothing: a state file that rewrites itself with a
/// different key order on every run is noise in every diff, which is the shape
/// of the `forge/model.json` churn this repo already lives with.
///
/// Unknown keys are ignored rather than rejected, which is what carries a file
/// written by a build that still had the ring: the extra key is read past and
/// the next save writes it out of existence.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    /// Account key -> window kind -> newest reading. The key is the frontend's
    /// own `"{agentId} {profileId}"`, passed through rather than parsed: this
    /// module stores what it is given and never has an opinion about which
    /// account a reading is for.
    #[serde(default)]
    pub readings: BTreeMap<String, BTreeMap<String, WindowReading>>,
    /// Transition key -> the window's `resetsAt` in epoch seconds, or null for a
    /// window that reported none.
    #[serde(default)]
    pub fired: BTreeMap<String, Option<u64>>,
}

/// The data dir rather than `~/.config/sway`, for the reason `catalog_probe.rs`
/// and `accounts.rs` chose it: this is state Sway derived from what a harness
/// said, not configuration a user edits, and `~/.config` commonly lives in a
/// dotfile repo.
pub fn usage_root() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join("sway/usage")
}

fn usage_path(root: &Path) -> PathBuf {
    root.join("snapshot.json")
}

/// Read the stored snapshot back.
///
/// **Every failure is "nothing stored yet".** A missing file is the ordinary
/// state of a fresh install, and a corrupt one is derived state the next turn
/// will replace; neither is worth an error the titlebar would have to render.
/// That is also what makes the file safe to delete by hand.
pub fn load_from(root: &Path) -> UsageSnapshot {
    let Ok(text) = std::fs::read_to_string(usage_path(root)) else {
        return UsageSnapshot::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// Drop fired keys that can no longer be proved current.
///
/// A past reset is the ordinary case: that window is gone, and keeping its key
/// would silence the next one. A key with **no** reset goes too, for the
/// opposite reason - nothing about it can ever go stale, so it would silence its
/// window permanently. Repeating a notice after a restart is the lesser failure.
fn prune_fired(fired: BTreeMap<String, Option<u64>>, now_ms: u64) -> BTreeMap<String, Option<u64>> {
    fired
        .into_iter()
        .filter(|(_, resets_at)| resets_at.is_some_and(|s| s * 1000 > now_ms))
        .collect()
}

/// Write the snapshot, pruning the fired keys on the way past.
pub fn save_to(root: &Path, snapshot: UsageSnapshot, now_ms: u64) -> Result<UsageSnapshot, String> {
    let stored = UsageSnapshot {
        readings: snapshot.readings,
        fired: prune_fired(snapshot.fired, now_ms),
    };
    let text = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(&usage_path(root), &text)?;
    Ok(stored)
}

#[tauri::command]
pub async fn usage_snapshot_load() -> Result<UsageSnapshot, String> {
    Ok(load_from(&usage_root()))
}

/// Returns the snapshot as stored, so the caller's fired set can be replaced by
/// the pruned one rather than drifting from what is on disk.
#[tauri::command]
pub async fn usage_snapshot_save(snapshot: UsageSnapshot) -> Result<UsageSnapshot, String> {
    save_to(&usage_root(), snapshot, crate::owned_state::now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Nanos and a counter, not the pid alone: every test in one run shares a
    /// pid, so a pid-keyed path makes tests in this module race each other.
    fn temp_root(name: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("sway-usage-{name}-{}-{nanos}-{seq}", std::process::id()))
    }

    const NOW: u64 = 1_788_500_000_000;

    fn reading(kind: &str, resets_at: Option<u64>) -> WindowReading {
        WindowReading {
            kind: kind.into(),
            utilization: Some(0.42),
            resets_at,
            status: None,
            reached_type: None,
            sampled_at: NOW,
            source: "sessions".into(),
        }
    }

    fn snapshot() -> UsageSnapshot {
        let mut windows = BTreeMap::new();
        windows.insert("five_hour".to_string(), reading("five_hour", Some(NOW / 1000 + 3600)));
        let mut readings = BTreeMap::new();
        readings.insert("claude default".to_string(), windows);
        UsageSnapshot { readings, fired: BTreeMap::new() }
    }

    #[test]
    fn a_snapshot_reads_back_the_way_it_was_written() {
        let root = temp_root("round-trip");
        let mut snap = snapshot();
        snap.fired.insert("claude default five_hour 1788503600 approaching".into(), Some(NOW / 1000 + 3600));

        save_to(&root, snap.clone(), NOW).unwrap();
        let back = load_from(&root);

        assert_eq!(back.readings, snap.readings);
        assert_eq!(back.fired, snap.fired, "the dedupe keys survive, or a restart repeats every notice");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_save_keeps_the_fired_key_whose_window_is_still_open_and_drops_the_rest() {
        let root = temp_root("prune-fired");
        let mut snap = snapshot();
        snap.fired.insert("open".into(), Some(NOW / 1000 + 3600));
        snap.fired.insert("passed".into(), Some(NOW / 1000 - 60));
        // No reset at all: unprunable, so persisting it would silence that
        // window for good.
        snap.fired.insert("undatable".into(), None);

        let stored = save_to(&root, snap, NOW).unwrap();

        assert_eq!(stored.fired.keys().collect::<Vec<_>>(), vec!["open"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Every release up to now wrote a 7-day `ring` beside the snapshot. Those
    /// files are on real machines, so the key has to read past rather than take
    /// the whole file down with it, and the next save has to be what clears it.
    #[test]
    fn a_file_written_when_there_was_still_a_ring_loads_and_then_loses_it() {
        let root = temp_root("legacy-ring");
        let legacy = r#"{
            "readings": {},
            "fired": {},
            "ring": [{ "at": 1788499999000, "accounts": { "claude default": [] } }]
        }"#;
        crate::owned_state::write_atomically(&usage_path(&root), legacy).unwrap();

        assert_eq!(load_from(&root), UsageSnapshot::default(), "the unknown key is read past");

        save_to(&root, snapshot(), NOW).unwrap();
        let text = std::fs::read_to_string(usage_path(&root)).unwrap();
        assert!(!text.contains("ring"), "and the next save writes it out of existence: {text}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_corrupt_file_reads_as_nothing_stored_rather_than_failing() {
        let root = temp_root("corrupt");
        crate::owned_state::write_atomically(&usage_path(&root), "{ not json").unwrap();

        assert_eq!(load_from(&root), UsageSnapshot::default());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_absent_file_reads_as_nothing_stored() {
        assert_eq!(load_from(&temp_root("absent")), UsageSnapshot::default());
    }
}
