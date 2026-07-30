//! Who owns a session id.
//!
//! This exists because of a measurement, not a worry: two `claude --resume`
//! processes on the same session id both succeed, both report that id, and both
//! append to one transcript. There is no lock, no error and no fork. Their
//! in-memory contexts diverge, so the file ends up recording a conversation that
//! never happened. Nothing downstream can repair that, so the only fix is to
//! stop the second opener.
//!
//! Three cases have to stay distinguishable, and collapsing any two of them
//! produces a bad experience:
//!
//!   * **Ours, same surface.** Re-opening a session already open in a chat tab
//!     should focus that tab. Erroring here would be user-hostile for the most
//!     common case.
//!   * **Ours, other surface.** A session live in a chat tab must not also open
//!     as a PTY agent tab, and vice versa. That is the corruption case.
//!   * **Not ours.** A `claude --resume` the user started in Ghostty. We cannot
//!     prevent it, so we allow the claim and say plainly what the risk is,
//!     rather than pretending to a lock we do not hold.
//!
//! A crash adds a fourth: a claim on disk whose Sway is gone but whose child is
//! still running. That is an orphan, and it is *not* the same as an external
//! session, because we know its pid and can offer to end it.
//!
//! **Scope, stated because the name promises more than the file delivers:
//! nothing here addresses two live Sways.** The claims file is read, edited and
//! replaced without a lock across processes, so two running instances race it
//! and the loser's claim is dropped by last-writer-wins. Every rule below
//! assumes one Sway plus any number of agent processes it did not start. A
//! second instance is out of scope for this module and for the plan that built
//! it, not handled and known to be unhandled.
//!
//! Following [[lesson_pure_core_for_global_stores]], every rule here is a pure
//! function over explicit inputs; the disk and the process table are touched
//! only by the thin wrappers at the bottom.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Which kind of surface holds a session.
///
/// A closed enum rather than a string: "chat" and "pty" are the only two
/// surfaces that can drive a session, and a third would need code either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Surface {
    Chat,
    PtyAgent,
}

/// One held session id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub surface: Surface,
    /// The tab holding it, so a repeat claim can focus rather than fail.
    pub tab_id: String,
    /// The agent child, recorded so a crash leaves enough to identify an orphan.
    /// `None` for a PTY agent tab, whose child is a login shell rather than the
    /// agent itself, so its pid would not match the adapter's running pattern.
    #[serde(default)]
    pub child_pid: Option<u32>,
    /// The Sway process that took the claim. A claim naming a dead pid is a
    /// crash record, never a live holder.
    pub sway_pid: u32,
    /// Which adapter this session belongs to, so the startup reap can match a
    /// surviving child against *that* adapter's running pattern.
    ///
    /// Recorded rather than assumed: a reap that hardcoded one agent would
    /// classify a second harness's orphan as gone, leaving a live child nobody
    /// is told about. Defaulted for a claim file written before this field
    /// existed, since only claude could have written one.
    #[serde(default = "default_agent")]
    pub agent: String,
}

fn default_agent() -> String {
    "claude".to_string()
}

/// What a claim attempt resolved to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClaimOutcome {
    /// The claim is yours. `contested` marks a session we found running outside
    /// Sway: allowed, because we cannot stop it, but the caller must warn.
    Granted {
        contested: bool,
    },
    /// You already have this open on the same kind of surface. Focus that tab.
    AlreadyMineFocus {
        tab_id: String,
    },
    /// Another surface holds it. Opening a second driver would corrupt the
    /// transcript, so this is a refusal.
    HeldByOther {
        surface: Surface,
        tab_id: String,
    },
    /// A previous Sway died leaving this session's child alive. Unclaimable
    /// until the user decides what to do with the surviving process.
    Orphaned {
        child_pid: u32,
    },
}

/// What the world looks like to a claim attempt, gathered once by the caller so
/// the decision itself stays pure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Probe {
    /// Is the process that recorded the existing claim still alive?
    pub holder_alive: bool,
    /// Does a process matching the adapter's running pattern for this id exist?
    pub externally_running: bool,
    /// Is the existing claim's recorded child still alive *and* still running
    /// this session? Pids are recycled, so liveness alone is not enough.
    pub child_still_ours: bool,
}

/// The whole claim decision, as a pure function of the current claims table and
/// one gathered [`Probe`].
///
/// Returns the outcome plus the claims table it implies, so the caller writes
/// state in one place instead of each branch mutating as it goes.
pub fn decide(
    claims: &HashMap<String, Claim>,
    session_id: &str,
    want: &Claim,
    probe: Probe,
) -> ClaimOutcome {
    match claims.get(session_id) {
        Some(held) if probe.holder_alive => {
            if held.surface == want.surface {
                ClaimOutcome::AlreadyMineFocus { tab_id: held.tab_id.clone() }
            } else {
                ClaimOutcome::HeldByOther { surface: held.surface, tab_id: held.tab_id.clone() }
            }
        }
        // A claim whose Sway is gone. If its child outlived it and is still
        // running *this* session, that is an orphan we can name and offer to
        // end - materially different from a session the user started by hand,
        // which we can only warn about.
        //
        // The pid is matched out rather than unwrapped: a defaulted 0 here would
        // travel to the frontend as a killable pid, and `kill 0` signals this
        // whole process group.
        Some(Claim { child_pid: Some(pid), .. }) if probe.child_still_ours => {
            ClaimOutcome::Orphaned { child_pid: *pid }
        }
        // Stale record, nothing of ours survived it: the record is just litter.
        Some(_) | None => ClaimOutcome::Granted { contested: probe.externally_running },
    }
}

/// Apply a granted outcome. Separate from [`decide`] so a refused claim can
/// never leave a partial write behind.
pub fn record(claims: &mut HashMap<String, Claim>, session_id: &str, want: Claim) {
    claims.insert(session_id.to_string(), want);
}

/// Release a claim, but only if `tab_id` is the tab that holds it.
///
/// The guard matters: a stale close from a tab that already lost the claim would
/// otherwise release the *current* holder's claim and let a second driver in.
pub fn release(claims: &mut HashMap<String, Claim>, session_id: &str, tab_id: &str) -> bool {
    match claims.get(session_id) {
        Some(held) if held.tab_id == tab_id => {
            claims.remove(session_id);
            true
        }
        _ => false,
    }
}

/// What a persisted claim turned out to be at startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Reaped {
    /// A crashed Sway's child is still running this session. Carries the agent
    /// so the terminate call matches the same pattern the classification did.
    Orphan { session_id: String, child_pid: u32, agent: String },
    /// Nothing survived; the record is litter and gets dropped.
    Stale { session_id: String },
}

/// Classify every persisted claim at startup.
///
/// `alive` answers "is this pid a Sway that is still running", and
/// `still_running` answers "is this pid still running *this session id*". The
/// second is deliberately not a bare liveness check: pids are recycled, so a
/// claim whose recorded child pid now belongs to somebody's editor would
/// otherwise be offered up as an orphan to kill.
pub fn classify_persisted(
    claims: &HashMap<String, Claim>,
    alive: impl Fn(u32) -> bool,
    still_running: impl Fn(&str, &str, u32) -> bool,
) -> Vec<Reaped> {
    let mut out: Vec<Reaped> = claims
        .iter()
        .filter(|(_, c)| !alive(c.sway_pid))
        .map(|(id, c)| match c.child_pid {
            Some(pid) if still_running(&c.agent, id, pid) => {
                Reaped::Orphan { session_id: id.clone(), child_pid: pid, agent: c.agent.clone() }
            }
            _ => Reaped::Stale { session_id: id.clone() },
        })
        .collect();
    // Deterministic order so a caller can present and test a stable list; the
    // map's iteration order is not.
    out.sort_by_key(|r| match r {
        Reaped::Orphan { session_id, .. } | Reaped::Stale { session_id } => session_id.clone(),
    });
    out
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

fn claims_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/chat-claims.json")
}

/// Parse the on-disk claims file. A malformed or absent file yields an empty
/// table rather than an error: the file is a crash-recovery aid, and refusing to
/// start a chat because it could not be parsed would be a worse failure than
/// losing the ability to name an orphan.
pub fn parse_claims(text: &str) -> HashMap<String, Claim> {
    serde_json::from_str(text).unwrap_or_default()
}

pub fn serialize_claims(claims: &HashMap<String, Claim>) -> String {
    serde_json::to_string_pretty(claims).unwrap_or_else(|_| "{}".to_string())
}

fn load_claims_from(path: &std::path::Path) -> HashMap<String, Claim> {
    std::fs::read_to_string(path).map(|t| parse_claims(&t)).unwrap_or_default()
}

/// Replace the claims file atomically.
///
/// A bare `fs::write` truncates in place, so a crash between the truncate and
/// the write leaves a short file - and both readers here end in
/// `unwrap_or_default()`, so a torn file does not fail loudly, it reads back as
/// **no claims at all**. That is exactly the failure this module exists to
/// prevent: every live session would look unowned, and a second opener of any of
/// them would be waved through onto one transcript.
///
/// `write_atomically` (write temp, fsync temp, `rename`, fsync the directory) is
/// the convention the owned-state layout names for every small map, and the
/// primitive the sibling stores already use. Claims were the one store still
/// outside it.
fn save_claims_to(path: &std::path::Path, claims: &HashMap<String, Claim>) -> Result<(), String> {
    crate::chat::rules::write_atomically(path, &serialize_claims(claims))
}

/// Pids `kill` interprets as something other than one process: 0 is "every
/// process in my group" and 1 is launchd. Neither can ever be a claim's holder
/// or an agent child, and both are catastrophic to signal, so they are rejected
/// before any `kill` runs. Found by a test asserting `pid_alive(0)` was false
/// and discovering it was true.
fn is_signalable_pid(pid: u32) -> bool {
    pid > 1
}

/// Is `pid` a live process?
///
/// `kill(pid, 0)` via the `kill` binary rather than a libc dependency, matching
/// this codebase's habit of shelling out for process questions (`pgrep` in
/// `sessions::session_running`).
fn pid_alive(pid: u32) -> bool {
    if !is_signalable_pid(pid) {
        return false;
    }
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Is `pid` a process whose command line still matches `agent`'s running pattern
/// for `session_id`?
///
/// One `pgrep -f` answers both halves at once: the pattern restricts matches to
/// a real resume of this session, and pid membership in the result restricts it
/// to *this* process. A bare liveness check would let a recycled pid be reported
/// as an orphan and offered up to be killed.
fn pid_runs_session(agent: &str, session_id: &str, pid: u32) -> bool {
    let pattern = crate::agents::session_pattern(agent, session_id);
    let Ok(out) = Command::new("pgrep").args(["-f", &pattern]).output() else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .any(|p| p == pid)
}

/// The process-wide registry. One per app; `lib.rs` manages it as Tauri state.
///
/// The in-memory table is authoritative for *this* Sway; the file exists only so
/// a crash leaves a record of what was running.
///
/// The store path is a field rather than a call to [`claims_path`] so tests can
/// point at a temp file. Without it a test run would rewrite the real
/// `chat-claims.json` and could drop a live session's claim out from under a
/// running Sway.
pub struct Registry {
    claims: Mutex<HashMap<String, Claim>>,
    path: PathBuf,
}

impl Default for Registry {
    fn default() -> Self {
        Self { claims: Mutex::new(HashMap::new()), path: claims_path() }
    }
}

impl Registry {
    #[cfg(test)]
    pub fn at(path: PathBuf) -> Self {
        Self { claims: Mutex::new(HashMap::new()), path }
    }

    /// Attempt to take `session_id` for `want`, gathering the process-table
    /// facts [`decide`] needs.
    pub fn claim(&self, session_id: &str, want: Claim) -> ClaimOutcome {
        let agent = want.agent.clone();
        let agent = agent.as_str();
        let mut guard = match self.claims.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let held = guard.get(session_id).cloned();
        let probe = Probe {
            holder_alive: held.as_ref().map(|c| pid_alive(c.sway_pid)).unwrap_or(false),
            externally_running: crate::sessions::session_running(session_id.to_string(), agent.to_string())
                .unwrap_or(false),
            child_still_ours: held
                .as_ref()
                .and_then(|c| c.child_pid)
                .map(|pid| pid_runs_session(agent, session_id, pid))
                .unwrap_or(false),
        };
        let outcome = decide(&guard, session_id, &want, probe);
        if matches!(outcome, ClaimOutcome::Granted { .. }) {
            record(&mut guard, session_id, want);
            let _ = save_claims_to(&self.path, &guard);
        }
        outcome
    }

    /// Record the child pid once the process exists. Claiming happens before the
    /// spawn (so a refused claim never starts a process), which means the pid is
    /// only knowable a moment later.
    pub fn note_child_pid(&self, session_id: &str, child_pid: u32) {
        let mut guard = match self.claims.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        if let Some(claim) = guard.get_mut(session_id) {
            claim.child_pid = Some(child_pid);
            let _ = save_claims_to(&self.path, &guard);
        }
    }

    pub fn release(&self, session_id: &str, tab_id: &str) -> bool {
        let mut guard = match self.claims.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let released = release(&mut guard, session_id, tab_id);
        if released {
            let _ = save_claims_to(&self.path, &guard);
        }
        released
    }

    /// Drop a persisted record for a session whose orphan the user has dealt
    /// with, so the session stops being unclaimable.
    pub fn forget(&self, session_id: &str) {
        let mut guard = match self.claims.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        guard.remove(session_id);
        let _ = save_claims_to(&self.path, &guard);
    }

    /// Test-only: the in-memory table. The product never needs to read the
    /// whole registry - `claim` already returns everything a caller acts on.
    #[cfg(test)]
    pub fn snapshot(&self) -> HashMap<String, Claim> {
        match self.claims.lock() {
            Ok(g) => g.clone(),
            Err(e) => e.into_inner().clone(),
        }
    }
}

/// Classify the previous run's leftovers at startup, dropping the litter and
/// returning the orphans for the user to decide about.
///
/// Orphan records are deliberately *kept* on disk: an orphan makes its session
/// unclaimable, and dropping the record here would make the session look free
/// while its old child kept writing to the transcript.
pub fn reap_on_startup() -> Vec<Reaped> {
    reap_at(&claims_path())
}

/// The startup reap's orphans, parked until the frontend asks for them.
///
/// Held rather than emitted: the reap runs inside Tauri's `setup`, which
/// completes before the webview has loaded, and an event emitted there reaches
/// no listener at all - the orphan would block its session id with nothing on
/// screen saying why. A pull the frontend makes when it is ready cannot race.
#[derive(Default)]
pub struct Orphans(pub Mutex<Vec<Reaped>>);

impl Orphans {
    pub fn set(&self, found: Vec<Reaped>) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = found;
        }
    }

    /// Read and clear. Once delivered they are the frontend's to act on, and a
    /// second read must not re-offer children the user has already ended.
    pub fn take(&self) -> Vec<Reaped> {
        match self.0.lock() {
            Ok(mut guard) => std::mem::take(&mut *guard),
            Err(_) => Vec::new(),
        }
    }
}

/// [`reap_on_startup`] against an explicit store, so the crash-recovery path can
/// be tested without rewriting the real one.
fn reap_at(path: &std::path::Path) -> Vec<Reaped> {
    let persisted = load_claims_from(path);
    let found = classify_persisted(&persisted, pid_alive, pid_runs_session);
    let survivors: HashMap<String, Claim> = persisted
        .into_iter()
        .filter(|(id, c)| {
            pid_alive(c.sway_pid)
                || found.iter().any(|r| matches!(r, Reaped::Orphan { session_id, .. } if session_id == id))
        })
        .collect();
    let _ = save_claims_to(path, &survivors);
    found.into_iter().filter(|r| matches!(r, Reaped::Orphan { .. })).collect()
}

/// End an orphaned child and drop its record.
pub fn terminate_orphan(registry: &Registry, session_id: &str, child_pid: u32, agent: &str) -> Result<(), String> {
    if !is_signalable_pid(child_pid) {
        return Err(format!("refusing to signal pid {child_pid}"));
    }
    // Re-check before signalling: the classification could be seconds old, and
    // signalling a pid that has since been recycled would kill a stranger.
    if !pid_runs_session(agent, session_id, child_pid) {
        registry.forget(session_id);
        return Ok(());
    }
    Command::new("kill")
        .args(["-TERM", &child_pid.to_string()])
        .status()
        .map_err(|e| e.to_string())?;
    registry.forget(session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(surface: Surface, tab: &str) -> Claim {
        Claim { surface, tab_id: tab.to_string(), child_pid: Some(4242), sway_pid: 1, agent: "claude".into() }
    }

    /// A per-test claims store. Never the real one: a test run while Sway is
    /// open would otherwise rewrite `chat-claims.json` and drop a live session's
    /// claim out from under it.
    /// A claims file in a directory of this test's own.
    ///
    /// One directory per test, not one per process. These run in parallel inside
    /// a single process, so a shared `sway-claims-<pid>` directory means one
    /// test's `remove_dir_all` cleanup deletes another test's store while it is
    /// mid-write, and an atomic write's `rename` then fails into a discarded
    /// error in `reap_at`. See the "Rust tests sharing a temp path keyed only on
    /// process id race each other" gotcha.
    fn temp_store(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sway-claims-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("claims.json")
    }

    fn clear() -> Probe {
        Probe { holder_alive: false, externally_running: false, child_still_ours: false }
    }

    #[test]
    fn orphans_survive_until_the_frontend_asks_and_are_delivered_once() {
        // The whole point of parking them: the reap finishes long before there
        // is a webview to emit to, so the record has to wait rather than fire.
        let parked = Orphans::default();
        parked.set(vec![Reaped::Orphan {
            session_id: "s1".into(),
            child_pid: 4242,
            agent: "claude".into(),
        }]);
        let first = parked.take();
        assert_eq!(first.len(), 1, "the frontend's first read gets the orphan");
        assert!(parked.take().is_empty(), "a second read must not re-offer a child already dealt with");
    }

    fn live() -> Probe {
        Probe { holder_alive: true, externally_running: false, child_still_ours: false }
    }

    #[test]
    fn an_unheld_session_is_granted() {
        let claims = HashMap::new();
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::Chat, "tab-a"), clear()),
            ClaimOutcome::Granted { contested: false }
        );
    }

    /// The common case, and the one an error would ruin: re-opening a session
    /// you already have open should send you to the tab that has it.
    #[test]
    fn a_repeat_claim_from_the_same_surface_focuses_the_holding_tab() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::Chat, "tab-b"), live()),
            ClaimOutcome::AlreadyMineFocus { tab_id: "tab-a".to_string() }
        );
    }

    /// The corruption case: chat and a PTY agent tab driving one session id both
    /// append to one transcript.
    #[test]
    fn a_claim_from_a_different_surface_names_the_holder() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::PtyAgent, "tab-b"), live()),
            ClaimOutcome::HeldByOther { surface: Surface::Chat, tab_id: "tab-a".to_string() }
        );
    }

    #[test]
    fn releasing_on_tab_close_makes_it_claimable_again() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        assert!(release(&mut claims, "s1", "tab-a"));
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::PtyAgent, "tab-b"), clear()),
            ClaimOutcome::Granted { contested: false }
        );
    }

    /// A late close from a tab that no longer holds the claim must not release
    /// the current holder's, or a second driver walks straight in.
    #[test]
    fn a_stale_close_cannot_release_someone_elses_claim() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        assert!(!release(&mut claims, "s1", "tab-ghost"));
        assert!(claims.contains_key("s1"));
    }

    /// A session the user started by hand in a terminal: we cannot lock it, so
    /// the claim proceeds but carries the warning.
    #[test]
    fn an_externally_running_session_is_granted_but_contested() {
        let claims = HashMap::new();
        let probe = Probe { holder_alive: false, externally_running: true, child_still_ours: false };
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::Chat, "tab-a"), probe),
            ClaimOutcome::Granted { contested: true }
        );
    }

    /// A crash record whose child outlived it. Distinct from the contested case
    /// above because we know the pid and can offer to end it.
    #[test]
    fn a_dead_sway_with_a_surviving_child_is_an_orphan_not_a_grant() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        let probe = Probe { holder_alive: false, externally_running: true, child_still_ours: true };
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::Chat, "tab-b"), probe),
            ClaimOutcome::Orphaned { child_pid: 4242 }
        );
    }

    /// A crash record with nothing left alive is litter, not an obstacle.
    #[test]
    fn a_dead_sway_with_no_surviving_child_is_just_a_stale_record() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::Chat, "tab-b"), clear()),
            ClaimOutcome::Granted { contested: false }
        );
    }

    /// The pid-recycling guard, and the reason `still_running` takes the session
    /// id rather than being a bare `alive(pid)`: a live pid that is somebody
    /// else's process must never be offered up as an orphan to kill.
    #[test]
    fn a_live_pid_whose_command_line_does_not_match_is_treated_as_gone() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        let found = classify_persisted(&claims, |_| false, |_, _, _| false);
        assert_eq!(found, vec![Reaped::Stale { session_id: "s1".to_string() }]);
    }

    #[test]
    fn a_crashed_sway_whose_child_still_runs_the_session_is_reported_as_an_orphan() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        let found = classify_persisted(&claims, |_| false, |_, _, _| true);
        assert_eq!(found, vec![Reaped::Orphan { session_id: "s1".to_string(), child_pid: 4242, agent: "claude".into() }]);
    }

    #[test]
    fn a_claim_whose_sway_is_alive_is_not_reaped_at_all() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        assert!(classify_persisted(&claims, |_| true, |_, _, _| true).is_empty());
    }

    // ---- persistence (pure round trip, no global store touched) ----

    #[test]
    fn claims_round_trip_through_the_on_disk_shape() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        record(&mut claims, "s2", Claim { surface: Surface::PtyAgent, tab_id: "tab-b".into(), child_pid: None, sway_pid: 9, agent: "claude".into() });
        assert_eq!(parse_claims(&serialize_claims(&claims)), claims);
    }

    #[test]
    fn a_missing_or_invalid_claims_file_reads_as_empty_rather_than_failing() {
        assert!(parse_claims("").is_empty());
        assert!(parse_claims("{ not json").is_empty());
        assert!(parse_claims("[]").is_empty());
    }

    #[test]
    fn write_read_back_and_removal_all_work_off_disk() {
        // Its own directory, since this test removes the whole thing at the end
        // and its siblings run in parallel. See `temp_store`.
        let path = temp_store("write-read-back");
        let dir = path.parent().unwrap().to_path_buf();

        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        save_claims_to(&path, &claims).unwrap();
        assert_eq!(load_claims_from(&path), claims);

        release(&mut claims, "s1", "tab-a");
        save_claims_to(&path, &claims).unwrap();
        assert!(load_claims_from(&path).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The claims file is *replaced*, never truncated in place.
    ///
    /// A bare `fs::write` truncates before it writes, so a crash mid-write
    /// leaves a short file - and every reader here ends in `unwrap_or_default`,
    /// so that reads back as an empty map rather than as an error: every live
    /// session would look unowned and a second opener would be waved through.
    ///
    /// The property is checkable without a crash. `rename` swaps a directory
    /// entry, so a handle opened before the save keeps reading the bytes it was
    /// opened on, while an in-place truncate would rewrite the very file that
    /// handle points at. The old implementation fails this assertion.
    #[test]
    fn claims_are_replaced_by_rename_so_a_torn_write_cannot_empty_the_file() {
        use std::io::Read;
        let path = temp_store("atomic-rename");
        let dir = path.parent().unwrap().to_path_buf();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();

        let mut first = HashMap::new();
        record(&mut first, "s1", claim(Surface::Chat, "tab-a"));
        save_claims_to(&path, &first).unwrap();

        // Opened against the first version and held across the second save.
        let mut held = std::fs::File::open(&path).unwrap();

        let mut second = HashMap::new();
        record(&mut second, "s2", claim(Surface::PtyAgent, "tab-b"));
        save_claims_to(&path, &second).unwrap();

        let mut carried = String::new();
        held.read_to_string(&mut carried).unwrap();
        assert_eq!(
            parse_claims(&carried),
            first,
            "a handle opened before the save must still see the replaced file, which only a rename gives",
        );
        assert_eq!(load_claims_from(&path), second);

        // The temp file is renamed onto the target, never left beside it.
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| *n != name)
            .collect();
        assert!(leftovers.is_empty(), "unexpected leftovers: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A claim naming a dead Sway pid must be recognised as a crash record, not
    /// trusted as a live holder - otherwise every session a crashed Sway had
    /// open would stay permanently unclaimable.
    #[test]
    fn a_claim_naming_a_dead_sway_pid_is_not_trusted() {
        let mut claims = HashMap::new();
        // A pid above the system maximum can never be live, so `pid_alive`
        // really answers here rather than the test asserting against a stub.
        let dead = 4_000_000_u32;
        record(
            &mut claims,
            "s1",
            Claim { surface: Surface::Chat, tab_id: "tab-a".into(), child_pid: None, sway_pid: dead, agent: "claude".into() },
        );
        assert!(!pid_alive(dead));
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::Chat, "tab-b"), Probe {
                holder_alive: pid_alive(dead),
                externally_running: false,
                child_still_ours: false
            }),
            ClaimOutcome::Granted { contested: false }
        );
    }

    /// Our own pid is alive, which is the positive control for the check above.
    #[test]
    fn pid_alive_finds_this_very_process() {
        assert!(pid_alive(std::process::id()));
    }

    /// `kill -0 0` succeeds, because 0 means "my whole process group" rather
    /// than a process. A liveness check that trusted it would report a
    /// zero-valued pid as alive, and a terminate that trusted it would signal
    /// every process Sway shares a group with.
    #[test]
    fn pid_zero_and_one_are_never_treated_as_signalable() {
        assert!(!is_signalable_pid(0));
        assert!(!is_signalable_pid(1));
        assert!(!pid_alive(0), "pid 0 is the process group, not a process");
        assert!(!pid_alive(1), "launchd is never a Sway or an agent child");

        let registry = Registry::at(temp_store("signal-guard"));
        assert!(terminate_orphan(&registry, "s1", 0, "claude").is_err());
    }

    /// The external-vs-orphan distinction against the **real** process table, so
    /// the `pgrep` pattern and the pid membership check are exercised rather
    /// than stubbed.
    ///
    /// A process whose command line matches the adapter's running pattern stands
    /// in for a `claude --resume` the user started in Ghostty. With no claim of
    /// ours, that is contested: allowed, because we cannot stop it, but the
    /// caller has to warn. It must never be reported as an orphan, since we did
    /// not start it and have no business offering to kill it.
    #[test]
    fn a_session_running_outside_sway_is_contested_and_never_reported_as_an_orphan() {
        let id = format!("ext-{}", std::process::id());
        // The shell's own command line contains `claude --resume <id>`, which is
        // what the adapter's running pattern matches on.
        let mut child = Command::new("/bin/sh")
            .args(["-c", &format!("claude --resume {id} ; sleep 5")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("the stand-in external session should start");

        // pgrep needs a moment to see a freshly forked process.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut seen = false;
        while std::time::Instant::now() < deadline && !seen {
            seen = crate::sessions::session_running(id.clone(), "claude".to_string()).unwrap_or(false);
            if !seen {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        assert!(seen, "the stand-in should be visible to the same pgrep the claim path uses");

        let registry = Registry::at(temp_store("contested"));
        let outcome = registry.claim(
            &id,
            Claim { surface: Surface::Chat, tab_id: "tab-a".into(), child_pid: None, sway_pid: std::process::id(), agent: "claude".into() },
        );
        assert_eq!(
            outcome,
            ClaimOutcome::Granted { contested: true },
            "a session running outside Sway is a warning, not a refusal"
        );

        registry.forget(&id);
        let _ = child.kill();
        let _ = child.wait();
    }

    /// The positive control for `pid_runs_session`, and the pid-recycling guard,
    /// both against real processes: the pid actually running the session is
    /// recognised, and a live pid running something else is not.
    #[test]
    fn pid_runs_session_matches_only_the_process_actually_running_that_session() {
        let id = format!("orph-{}", std::process::id());
        let mut child = Command::new("/bin/sh")
            .args(["-c", &format!("claude --resume {id} ; sleep 5")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("the stand-in orphan should start");
        let pid = child.id();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut matched = false;
        while std::time::Instant::now() < deadline && !matched {
            matched = pid_runs_session("claude", &id, pid);
            if !matched {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        assert!(matched, "the process actually running this session must be recognised");
        assert!(
            !pid_runs_session("claude", &id, std::process::id()),
            "a live pid whose command line does not match must be treated as gone"
        );

        let _ = child.kill();
        let _ = child.wait();
    }

    /// The crash-recovery path end to end, against a real surviving process and
    /// a real store file: what a `SIGKILL`ed Sway leaves behind, and what the
    /// next launch does about it.
    ///
    /// A killed Sway cannot clean up after itself, which is the whole reason the
    /// claim is written to disk. So the leftover is reconstructed exactly as a
    /// crash would leave it - a record naming a dead Sway pid and a child that is
    /// still running - and then the startup reap is run against it. Three things
    /// have to hold together, and any one alone is not enough: the child is
    /// *named* as an orphan (so the user can be offered its termination), the
    /// record *survives* (so the session stays unclaimable meanwhile), and a
    /// claim attempt is refused with the same pid rather than silently
    /// proceeding.
    #[test]
    fn a_crashed_sway_leaves_a_named_orphan_and_the_session_stays_unclaimable() {
        let id = format!("crash-{}", std::process::id());
        let mut child = Command::new("/bin/sh")
            .args(["-c", &format!("claude --resume {id} ; sleep 10")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("the surviving child should start");
        let child_pid = child.id();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline && !pid_runs_session("claude", &id, child_pid) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // The record a killed Sway leaves: its own pid is gone, its child is not.
        let store = temp_store("crash-recovery");
        let mut leftover = HashMap::new();
        record(
            &mut leftover,
            &id,
            Claim { surface: Surface::Chat, tab_id: "tab-a".into(), child_pid: Some(child_pid), sway_pid: 4_000_000, agent: "claude".into() },
        );
        // Plus a record whose child did not survive, which must be swept.
        record(
            &mut leftover,
            "litter",
            Claim { surface: Surface::Chat, tab_id: "tab-z".into(), child_pid: None, sway_pid: 4_000_000, agent: "claude".into() },
        );
        save_claims_to(&store, &leftover).unwrap();

        let orphans = reap_at(&store);
        assert_eq!(
            orphans,
            vec![Reaped::Orphan { session_id: id.clone(), child_pid, agent: "claude".into() }],
            "the surviving child should be named as an orphan, and the litter swept"
        );

        let survivors = load_claims_from(&store);
        assert!(survivors.contains_key(&id), "an orphan's record must survive, or its session looks free");
        assert!(!survivors.contains_key("litter"), "a record with nothing alive behind it is litter");

        // And the session is genuinely unclaimable until the user decides.
        let registry = Registry::at(store.clone());
        *registry.claims.lock().unwrap() = survivors;
        assert_eq!(
            registry.claim(
                &id,
                Claim { surface: Surface::Chat, tab_id: "tab-new".into(), child_pid: None, sway_pid: std::process::id(), agent: "claude".into() },
            ),
            ClaimOutcome::Orphaned { child_pid }
        );

        // Terminating it releases the session, which is the offer the user gets.
        terminate_orphan(&registry, &id, child_pid, "claude").unwrap();
        assert!(!load_claims_from(&store).contains_key(&id));

        let _ = child.kill();
        let _ = child.wait();
    }

    /// The reap classifies each claim against **its own** adapter's running
    /// pattern, not one hardcoded agent. A reap that assumed claude would call a
    /// second harness's surviving child "gone" and never mention it.
    #[test]
    fn the_reap_matches_each_claim_against_its_own_agents_pattern() {
        let mut claims = HashMap::new();
        record(
            &mut claims,
            "s-claude",
            Claim {
                surface: Surface::Chat,
                tab_id: "t1".into(),
                child_pid: Some(4242),
                sway_pid: 4_000_000,
                agent: "claude".into(),
            },
        );
        record(
            &mut claims,
            "s-other",
            Claim {
                surface: Surface::Chat,
                tab_id: "t2".into(),
                child_pid: Some(4343),
                sway_pid: 4_000_000,
                agent: "gemini".into(),
            },
        );

        let seen = std::sync::Mutex::new(Vec::new());
        let found = classify_persisted(&claims, |_| false, |agent, id, pid| {
            seen.lock().unwrap().push((agent.to_string(), id.to_string(), pid));
            true
        });
        let mut asked = seen.into_inner().unwrap();
        asked.sort();
        assert_eq!(
            asked,
            vec![
                ("claude".to_string(), "s-claude".to_string(), 4242),
                ("gemini".to_string(), "s-other".to_string(), 4343),
            ],
            "each claim must be probed with the agent it recorded"
        );
        // And the agent travels onto the orphan, so terminating it re-checks the
        // same pattern the classification used.
        assert!(found.iter().any(|r| matches!(r, Reaped::Orphan { agent, .. } if agent == "gemini")));
    }

    /// A claims file written before the agent field existed must still load.
    /// Only claude could have written one, which is what makes the default safe.
    #[test]
    fn a_claim_file_predating_the_agent_field_still_loads() {
        let parsed = parse_claims(
            r#"{"s1":{"surface":"chat","tabId":"t","childPid":42,"swayPid":7}}"#,
        );
        assert_eq!(parsed["s1"].agent, "claude");
    }

    /// A claim recorded without a child pid can never become an orphan the user
    /// is offered a pid to kill, whatever the probe says.
    #[test]
    fn a_claim_with_no_recorded_child_never_yields_an_orphan_pid() {
        let mut claims = HashMap::new();
        record(
            &mut claims,
            "s1",
            Claim { surface: Surface::PtyAgent, tab_id: "tab-a".into(), child_pid: None, sway_pid: 12345, agent: "claude".into() },
        );
        let probe = Probe { holder_alive: false, externally_running: true, child_still_ours: true };
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::Chat, "tab-b"), probe),
            ClaimOutcome::Granted { contested: true }
        );
    }
}
