//! Where the titlebar's quota readings survive a restart, and where their
//! history accumulates.
//!
//! Three things live in one file per (agent, account):
//!
//! - **The last snapshot**, so the strip opens with the windows it knew rather
//!   than blank until the first turn of the day runs.
//! - **The fired dedupe keys**, so a restart *inside* a window that has already
//!   been announced does not announce it again. Without these the notice would
//!   be tied to a process rather than to a window, and quitting Sway would be a
//!   way to hear about the same 90% five times.
//! - **A bounded 7-day ring** of past readings, which is the only record of how
//!   a window *got* to where it is. Nothing else keeps it: the passive frames
//!   report a level and never a history.
//!
//! The frontend owns the merge (`src/utils/usageStore.ts`); this owns durability
//! and the two prunes. Both prunes happen on save rather than on load, so a file
//! left by a Sway that ran a fortnight ago cannot come back holding a fortnight
//! of samples.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How far back the ring keeps samples. Seven days because that is the longest
/// window any source reports, so the history always spans at least one whole
/// one; anything shorter would draw a weekly window's chart with its beginning
/// cut off.
const RING_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// A ceiling on entries as well as on age, so a build that samples far more
/// often than a turn boundary cannot grow the file without bound. Sized well
/// past a week at [`RING_MIN_GAP_MS`] (2016 samples).
const RING_CAP: usize = 4096;

/// How close together two history points may be.
///
/// Saves are debounced on the frontend and land seconds apart while a chat is
/// busy, but a quota level moves by a percent an hour; recording at save
/// cadence would fill the ring in a morning and leave every later save
/// re-reading and rewriting a file at its cap. Five minutes is finer than any
/// chart of a five-hour window needs.
const RING_MIN_GAP_MS: u64 = 5 * 60 * 1000;

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

/// One point in the history: every account's windows at one moment.
///
/// Keyed by account rather than flattened into one list. A machine with two
/// logins signed in writes both accounts on every point, and a flat list would
/// leave the chart drawing one account's history as the other's with nothing in
/// the file left to tell them apart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RingEntry {
    pub at: u64,
    pub accounts: BTreeMap<String, Vec<WindowReading>>,
}

/// What the frontend hands over and gets back.
///
/// `BTreeMap` rather than `HashMap` throughout, so the file is byte-stable
/// across saves that changed nothing: a state file that rewrites itself with a
/// different key order on every run is noise in every diff, which is the shape
/// of the `forge/model.json` churn this repo already lives with.
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

/// The snapshot plus its history, which is what actually sits on disk. The ring
/// is not in [`UsageSnapshot`] because the frontend neither sends nor needs it
/// on a save: it is appended here, from the readings, on the way past.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredUsage {
    #[serde(flatten)]
    pub snapshot: UsageSnapshot,
    #[serde(default)]
    pub ring: Vec<RingEntry>,
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

/// Read the stored usage back.
///
/// **Every failure is "nothing stored yet".** A missing file is the ordinary
/// state of a fresh install, and a corrupt one is derived state the next turn
/// will replace; neither is worth an error the titlebar would have to render.
/// That is also what makes the file safe to delete by hand.
pub fn load_from(root: &Path) -> StoredUsage {
    let Ok(text) = std::fs::read_to_string(usage_path(root)) else {
        return StoredUsage::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// Drop ring entries older than a week, newest-first order preserved.
fn prune_ring(mut ring: Vec<RingEntry>, now_ms: u64) -> Vec<RingEntry> {
    let floor = now_ms.saturating_sub(RING_MAX_AGE_MS);
    ring.retain(|e| e.at >= floor);
    // Oldest first, so the tail is what a chart draws left to right and the cap
    // drops the beginning rather than the end.
    ring.sort_by_key(|e| e.at);
    if ring.len() > RING_CAP {
        ring.drain(0..ring.len() - RING_CAP);
    }
    ring
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

/// Write the snapshot, appending this moment to the ring and pruning both.
///
/// **Two reasons a save records no point.** With no readings, because a gap is
/// honest about a period nobody sampled where a run of empty points would draw
/// as a level that fell to zero. And inside [`RING_MIN_GAP_MS`] of the last one,
/// because a save happens on the frontend's debounce - seconds apart while a
/// chat is busy - and a level that moves by a percent an hour does not need
/// recording at that rate. Without the gap the file would reach the cap in a
/// morning and be re-read and rewritten in full on every save after that.
pub fn save_to(root: &Path, snapshot: UsageSnapshot, now_ms: u64) -> Result<StoredUsage, String> {
    let prior = load_from(root);
    let mut ring = prior.ring;
    let accounts: BTreeMap<String, Vec<WindowReading>> = snapshot
        .readings
        .iter()
        .map(|(account, windows)| (account.clone(), windows.values().cloned().collect()))
        .filter(|(_, windows): &(String, Vec<WindowReading>)| !windows.is_empty())
        .collect();
    let too_soon = ring.iter().map(|e| e.at).max().is_some_and(|last| now_ms.saturating_sub(last) < RING_MIN_GAP_MS);
    if !accounts.is_empty() && !too_soon {
        ring.push(RingEntry { at: now_ms, accounts });
    }

    let stored = StoredUsage {
        snapshot: UsageSnapshot {
            readings: snapshot.readings,
            fired: prune_fired(snapshot.fired, now_ms),
        },
        ring: prune_ring(ring, now_ms),
    };
    let text = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(&usage_path(root), &text)?;
    Ok(stored)
}

#[tauri::command]
pub async fn usage_snapshot_load() -> Result<UsageSnapshot, String> {
    Ok(load_from(&usage_root()).snapshot)
}

/// Returns the snapshot as stored, so the caller's fired set can be replaced by
/// the pruned one rather than drifting from what is on disk.
#[tauri::command]
pub async fn usage_snapshot_save(snapshot: UsageSnapshot) -> Result<UsageSnapshot, String> {
    Ok(save_to(&usage_root(), snapshot, crate::owned_state::now_ms())?.snapshot)
}

/// One account's history, oldest first. The 7-day view's only source.
#[tauri::command]
pub async fn usage_history() -> Result<Vec<RingEntry>, String> {
    Ok(load_from(&usage_root()).ring)
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

    /// One history point holding one account with one window.
    fn point(at: u64) -> RingEntry {
        let mut accounts = BTreeMap::new();
        accounts.insert("claude default".to_string(), vec![reading("five_hour", None)]);
        RingEntry { at, accounts }
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
        let back = load_from(&root).snapshot;

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

        assert_eq!(stored.snapshot.fired.keys().collect::<Vec<_>>(), vec!["open"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A point holds every account separately. Flattened into one list, a
    /// machine with two logins would write both accounts' windows into one bag
    /// and the chart would have nothing left to tell them apart.
    #[test]
    fn a_point_keeps_each_account_under_its_own_key() {
        let root = temp_root("ring-accounts");
        let mut snap = snapshot();
        let mut other = BTreeMap::new();
        other.insert("seven_day".to_string(), reading("seven_day", Some(NOW / 1000 + 7200)));
        snap.readings.insert("claude fonn".to_string(), other);

        let stored = save_to(&root, snap, NOW).unwrap();

        let point = &stored.ring[0];
        assert_eq!(point.accounts.keys().collect::<Vec<_>>(), vec!["claude default", "claude fonn"]);
        assert_eq!(point.accounts["claude default"][0].kind, "five_hour");
        assert_eq!(point.accounts["claude fonn"][0].kind, "seven_day");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_ring_forgets_anything_older_than_a_week() {
        let root = temp_root("prune-ring");
        let old = point(NOW - RING_MAX_AGE_MS - 1000);
        let recent = point(NOW - RING_MIN_GAP_MS - 1000);
        let text = serde_json::to_string(&StoredUsage {
            snapshot: UsageSnapshot::default(),
            ring: vec![old, recent.clone()],
        })
        .unwrap();
        crate::owned_state::write_atomically(&usage_path(&root), &text).unwrap();

        let stored = save_to(&root, snapshot(), NOW).unwrap();

        // The week-old point is gone; the recent one and this save's own point
        // remain, oldest first.
        assert_eq!(stored.ring.len(), 2);
        assert_eq!(stored.ring[0].at, recent.at);
        assert_eq!(stored.ring[1].at, NOW);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Saves land seconds apart while a chat is busy. Recording every one would
    /// fill the ring in a morning and leave each later save re-reading and
    /// rewriting a file sitting at its cap.
    #[test]
    fn two_saves_inside_the_minimum_gap_record_one_point() {
        let root = temp_root("ring-cadence");
        save_to(&root, snapshot(), NOW).unwrap();

        let stored = save_to(&root, snapshot(), NOW + 5_000).unwrap();
        assert_eq!(stored.ring.len(), 1, "a save 5 seconds later is the same moment as far as a chart is concerned");

        let later = save_to(&root, snapshot(), NOW + RING_MIN_GAP_MS).unwrap();
        assert_eq!(later.ring.len(), 2);
        // The snapshot itself is written every time regardless: only the history
        // is rate-limited, and a restart must open on the newest levels.
        assert_eq!(later.snapshot.readings, snapshot().readings);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A gap says "nobody sampled here". A run of empty points would draw as a
    /// level that fell to zero, which is the one thing an absent window must
    /// never look like.
    #[test]
    fn a_save_with_nothing_to_record_leaves_no_point_behind() {
        let root = temp_root("empty-ring");
        let stored = save_to(&root, UsageSnapshot::default(), NOW).unwrap();
        assert!(stored.ring.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_corrupt_file_reads_as_nothing_stored_rather_than_failing() {
        let root = temp_root("corrupt");
        crate::owned_state::write_atomically(&usage_path(&root), "{ not json").unwrap();

        let back = load_from(&root);

        assert_eq!(back, StoredUsage::default());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_absent_file_reads_as_nothing_stored() {
        assert_eq!(load_from(&temp_root("absent")), StoredUsage::default());
    }

    /// The ring is written beside the snapshot in one file, so a `StoredUsage`
    /// deserialised from a snapshot-shaped payload must not lose it.
    #[test]
    fn the_ring_survives_a_save_that_only_carried_a_snapshot() {
        let root = temp_root("ring-survives");
        save_to(&root, snapshot(), NOW - RING_MIN_GAP_MS).unwrap();
        let stored = save_to(&root, snapshot(), NOW).unwrap();
        assert_eq!(stored.ring.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }
}
