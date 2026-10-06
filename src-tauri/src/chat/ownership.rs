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
//! A crash adds a fourth: a claim on disk whose Tori is gone but whose child is
//! still running. That is an orphan, and it is *not* the same as an external
//! session, because we know its pid and can offer to end it.
//!
//! **Scope, stated because the name promises more than the file delivers:
//! nothing here addresses two live Toris.** The claims file is read, edited and
//! replaced without a lock across processes, so two running instances race it
//! and the loser's claim is dropped by last-writer-wins. Every rule below
//! assumes one Tori plus any number of agent processes it did not start. A
//! second instance is out of scope for this module and for the plan that built
//! it, not handled and known to be unhandled.
//!
//! Following [[lesson_pure_core_for_global_stores]], every rule here is a pure
//! function over explicit inputs; the disk and the process table are touched
//! only by the thin wrappers at the bottom.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::platform::process;

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
    /// The Tori process that took the claim. A claim naming a dead pid is a
    /// crash record, never a live holder.
    pub tori_pid: u32,
    /// Which adapter this session belongs to, so the startup reap can match a
    /// surviving child against *that* adapter's running pattern.
    ///
    /// Recorded rather than assumed: a reap that hardcoded one agent would
    /// classify a second agent's orphan as gone, leaving a live child nobody
    /// is told about. Defaulted for a claim file written before this field
    /// existed, since only claude could have written one.
    #[serde(default = "default_agent")]
    pub agent: String,
    /// Which account of `agent` this session runs as.
    ///
    /// Defaulted for a claim file written before accounts existed, and that
    /// default is correct rather than a placeholder: every session claimed
    /// before this field ran on the login the user already had, which *is* the
    /// default profile.
    #[serde(default = "default_profile")]
    pub profile: String,
}

fn default_agent() -> String {
    "claude".to_string()
}

fn default_profile() -> String {
    crate::accounts::DEFAULT_PROFILE_ID.to_string()
}

/// What a claim attempt resolved to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClaimOutcome {
    /// The claim is yours. `contested` marks a session we found running outside
    /// Tori: allowed, because we cannot stop it, but the caller must warn.
    Granted { contested: bool },
    /// You already have this open on the same kind of surface. Focus that tab.
    AlreadyMineFocus { tab_id: String },
    /// Another surface holds it. Opening a second driver would corrupt the
    /// transcript, so this is a refusal.
    HeldByOther { surface: Surface, tab_id: String },
    /// A previous Tori died leaving this session's child alive. Unclaimable
    /// until the user decides what to do with the surviving process.
    Orphaned { child_pid: u32 },
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
pub fn decide(claims: &HashMap<String, Claim>, session_id: &str, want: &Claim, probe: Probe) -> ClaimOutcome {
    match claims.get(session_id) {
        Some(held) if probe.holder_alive => {
            if held.surface == want.surface {
                ClaimOutcome::AlreadyMineFocus {
                    tab_id: held.tab_id.clone(),
                }
            } else {
                ClaimOutcome::HeldByOther {
                    surface: held.surface,
                    tab_id: held.tab_id.clone(),
                }
            }
        }
        // A claim whose Tori is gone. If its child outlived it and is still
        // running *this* session, that is an orphan we can name and offer to
        // end - materially different from a session the user started by hand,
        // which we can only warn about.
        //
        // The pid is matched out rather than unwrapped: a defaulted 0 here would
        // travel to the frontend as a killable pid, and `kill 0` signals this
        // whole process group.
        Some(Claim {
            child_pid: Some(pid), ..
        }) if probe.child_still_ours => ClaimOutcome::Orphaned { child_pid: *pid },
        // Stale record, nothing of ours survived it: the record is just litter.
        Some(_) | None => ClaimOutcome::Granted {
            contested: probe.externally_running,
        },
    }
}

/// Apply a granted outcome. Separate from [`decide`] so a refused claim can
/// never leave a partial write behind.
pub fn record(claims: &mut HashMap<String, Claim>, session_id: &str, want: Claim) {
    claims.insert(session_id.to_string(), want);
}

/// Point an existing claim at the tab now driving the session.
///
/// A remount within one run re-subscribes under the same tab id and needs
/// nothing; a **webview reload** does not. The child survives it, the tab does
/// not, and the tab that picks the session back up is a new id. Left alone, the
/// claim would go on naming a tab nobody can focus - which is the one thing the
/// tab id is recorded for.
///
/// Only ever moves a claim that exists. A rewire is not a claim.
pub fn retag(claims: &mut HashMap<String, Claim>, session_id: &str, tab_id: &str) -> bool {
    match claims.get_mut(session_id) {
        Some(held) => {
            held.tab_id = tab_id.to_string();
            true
        }
        None => false,
    }
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
    /// A crashed Tori's child is still running this session. Carries the agent
    /// so the terminate call matches the same pattern the classification did.
    Orphan {
        session_id: String,
        child_pid: u32,
        agent: String,
    },
    /// Nothing survived; the record is litter and gets dropped.
    Stale { session_id: String },
}

/// Classify every persisted claim at startup.
///
/// `alive` answers "is this pid a Tori that is still running", and
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
        .filter(|(_, c)| !alive(c.tori_pid))
        .map(|(id, c)| match c.child_pid {
            Some(pid) if still_running(&c.agent, id, pid) => Reaped::Orphan {
                session_id: id.clone(),
                child_pid: pid,
                agent: c.agent.clone(),
            },
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
    crate::owned_state::config_dir().join("chat-claims.json")
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
    std::fs::read_to_string(path)
        .map(|t| parse_claims(&t))
        .unwrap_or_default()
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
    crate::owned_state::write_atomically(path, &serialize_claims(claims))
}

/// Pids `kill` interprets as something other than one process: 0 is "every
/// process in my group" and 1 is launchd. Neither can ever be a claim's holder
/// or an agent child, and both are catastrophic to signal, so they are rejected
/// before any `kill` runs. Found by a test asserting `pid_alive(0)` was false
/// and discovering it was true.
fn is_signalable_pid(pid: u32) -> bool {
    pid > 1
}

fn pid_alive(pid: u32) -> bool {
    is_signalable_pid(pid) && process::pid_alive(pid)
}

/// Which of `ids` `claims` says are still driven by a live agent child.
///
/// **The id-independent half of liveness.** [`pid_runs_session`] answers "is
/// this process running that session" by finding the session id on a command
/// line, which only works for a agent that puts it there. An ACP agent's
/// command line is identical for every session it ever runs - the id is minted
/// inside the protocol and never appears in argv - so matching on it would
/// report every ACP session of an agent running whenever any one of them was.
/// What is left is the claim: Tori recorded the child it started, and whether
/// that pid is alive is a question the process table can still answer.
///
/// Deliberately does not also require the claiming Tori to be alive. A child
/// that outlived its Tori is an orphan, and an orphan is still a running agent;
/// the reap path is what offers to end it, and reporting it dead here would hide
/// it from the very sweep that notices it.
///
/// Pure, so the rule is tested against a table rather than against whatever
/// happens to be claimed on the machine.
fn with_live_child(claims: &HashMap<String, Claim>, ids: &[String], alive: impl Fn(u32) -> bool) -> Vec<String> {
    ids.iter()
        .filter(|id| claims.get(*id).and_then(|c| c.child_pid).is_some_and(&alive))
        .cloned()
        .collect()
}

/// **Tab** ids of `agent`'s `profile` held by a Tori that is still running.
///
/// Tab ids, not session ids, because the caller unions this with the PTY host's
/// own live table and that one can only answer in tab ids. A resumed PTY agent
/// tab is in both, so two id spaces would count it twice and tell the user to
/// close two things that are one tab. A tab is also what they can act on.
///
/// Narrowed to one account, because that is the question removal asks: another
/// account's live session is not harmed by deleting this one's home, and
/// blocking on it would make an unrelated chat in the other profile an
/// unexplainable reason the button will not work.
///
/// Deliberately the opposite test to [`with_live_child`], which asks about the
/// *agent* child and ignores whether Tori is alive. Here the question is "would
/// removing this strand something in flight", and only a live Tori has something
/// in flight: a claim naming a dead `tori_pid` is a crash record, and refusing a
/// removal because of one would leave a user unable to delete an account until
/// they had cleaned up after a crash they never saw.
///
/// A PTY agent tab records no `child_pid` (its child is a login shell), so a
/// child-based test would miss exactly the sessions a login flow produces. This
/// is why the two helpers exist side by side rather than one covering both.
///
/// Pure, so the rule is tested against a table rather than against whatever
/// happens to be claimed on the machine.
fn held_by(
    claims: &HashMap<String, Claim>,
    agent: &str,
    profile: &str,
    tori_alive: impl Fn(u32) -> bool,
) -> Vec<String> {
    let mut out: Vec<String> = claims
        .values()
        .filter(|c| c.agent == agent && c.profile == profile && tori_alive(c.tori_pid))
        .map(|c| c.tab_id.clone())
        .collect();
    // A `HashMap` has no order, and a message naming tabs must not shuffle
    // between two readings of the same state.
    out.sort();
    out
}

/// Is `pid` a process whose command line still matches `agent`'s running pattern
/// for `session_id`?
///
/// One process snapshot answers both halves at once: the pattern restricts
/// matches to a real resume of this session, and pid membership in the result
/// restricts it to *this* process. A bare liveness check would let a recycled pid be reported
/// as an orphan and offered up to be killed.
///
/// **An adapter with no running pattern degrades to the bare liveness check**,
/// deliberately, and it is the one place that trade is worth naming. A
/// protocol-backed agent puts its session id on no command line, so the pattern
/// half of the question is unanswerable for it; answering `false` would report
/// Tori's own live child as gone and hand a running session to the reaper. The
/// pid-recycling guard is what is given up, which is the same bargain Phase 5
/// struck for ACP liveness: the recorded child pid being alive is all there is
/// to go on.
fn pid_runs_session(agent: &str, session_id: &str, pid: u32) -> bool {
    let Some(pattern) = crate::agents::session_pattern(agent, session_id) else {
        return pid_alive(pid);
    };
    let Ok(pattern) = regex::Regex::new(&pattern) else {
        return false;
    };
    process::Snapshot::take()
        .matching(&pattern)
        .iter()
        .any(|(p, _)| *p == pid)
}

/// The process-wide registry. One per app; `lib.rs` manages it as Tauri state.
///
/// The in-memory table is authoritative for *this* Tori; the file exists only so
/// a crash leaves a record of what was running.
///
/// The store path is a field rather than a call to [`claims_path`] so tests can
/// point at a temp file. Without it a test run would rewrite the real
/// `chat-claims.json` and could drop a live session's claim out from under a
/// running Tori.
pub struct Registry {
    claims: Mutex<HashMap<String, Claim>>,
    path: PathBuf,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            claims: Mutex::new(HashMap::new()),
            path: claims_path(),
        }
    }
}

impl Registry {
    #[cfg(test)]
    pub fn at(path: PathBuf) -> Self {
        Self {
            claims: Mutex::new(HashMap::new()),
            path,
        }
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
            holder_alive: held.as_ref().map(|c| pid_alive(c.tori_pid)).unwrap_or(false),
            externally_running: crate::sessions::running_by_pattern(agent, session_id),
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

    /// Which of `ids` this registry still holds a live agent child for.
    ///
    /// Answers one bounded question about the ids the caller names rather than
    /// handing out the whole table, which is why it is a method here instead of
    /// a reader over [`Self::snapshot`]. See [`with_live_child`] for why an ACP
    /// session has no other honest liveness check.
    pub fn sessions_with_live_child(&self, ids: &[String]) -> Vec<String> {
        let guard = match self.claims.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        with_live_child(&guard, ids, pid_alive)
    }

    /// Tab ids of one `(agent, profile)` pair that a **live** Tori is holding
    /// right now.
    ///
    /// One bounded question again, rather than handing out the table: the caller
    /// is the accounts screen asking whether removing this account would strand
    /// a session in flight. A claim naming a dead `tori_pid` is a crash record,
    /// not a holder, so it must not block anything.
    pub fn held_by(&self, agent: &str, profile: &str) -> Vec<String> {
        let guard = match self.claims.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        held_by(&guard, agent, profile, pid_alive)
    }

    /// The account a held session is running as, or `None` when nothing holds
    /// it. The claim is where the account of record lives, so a rewire (which
    /// never re-resolves the profile) can still report it back to the tab.
    pub fn profile_of(&self, session_id: &str) -> Option<String> {
        let guard = match self.claims.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        guard.get(session_id).map(|c| c.profile.clone())
    }

    pub fn agent_of(&self, session_id: &str) -> Option<String> {
        let guard = match self.claims.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        guard.get(session_id).map(|c| c.agent.clone())
    }

    /// Every session this Tori process holds, as `(id, agent)`: chat sessions and
    /// agents in terminal tabs alike.
    pub fn held_here(&self) -> Vec<(String, String)> {
        let guard = match self.claims.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let me = std::process::id();
        guard
            .iter()
            .filter(|(_, c)| c.tori_pid == me)
            .map(|(id, c)| (id.clone(), c.agent.clone()))
            .collect()
    }

    /// Move an existing claim onto the tab that has just taken the session over.
    /// See [`retag`] for why a rewire has to do this at all.
    pub fn retag(&self, session_id: &str, tab_id: &str) {
        let mut guard = match self.claims.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        if retag(&mut guard, session_id, tab_id) {
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
            pid_alive(c.tori_pid)
                || found
                    .iter()
                    .any(|r| matches!(r, Reaped::Orphan { session_id, .. } if session_id == id))
        })
        .collect();
    let _ = save_claims_to(path, &survivors);
    found
        .into_iter()
        .filter(|r| matches!(r, Reaped::Orphan { .. }))
        .collect()
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
    process::terminate(child_pid);
    registry.forget(session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(surface: Surface, tab: &str) -> Claim {
        Claim {
            surface,
            tab_id: tab.to_string(),
            child_pid: Some(4242),
            tori_pid: 1,
            agent: "claude".into(),
            profile: "default".into(),
        }
    }

    /// A per-test claims store. Never the real one: a test run while Tori is
    /// open would otherwise rewrite `chat-claims.json` and drop a live session's
    /// claim out from under it.
    /// A claims file in a directory of this test's own.
    ///
    /// One directory per test, not one per process. These run in parallel inside
    /// a single process, so a shared `tori-claims-<pid>` directory means one
    /// test's `remove_dir_all` cleanup deletes another test's store while it is
    /// mid-write, and an atomic write's `rename` then fails into a discarded
    /// error in `reap_at`. See the "Rust tests sharing a temp path keyed only on
    /// process id race each other" gotcha.
    fn temp_store(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-claims-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("claims.json")
    }

    fn clear() -> Probe {
        Probe {
            holder_alive: false,
            externally_running: false,
            child_still_ours: false,
        }
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
        assert!(
            parked.take().is_empty(),
            "a second read must not re-offer a child already dealt with"
        );
    }

    fn live() -> Probe {
        Probe {
            holder_alive: true,
            externally_running: false,
            child_still_ours: false,
        }
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
            ClaimOutcome::AlreadyMineFocus {
                tab_id: "tab-a".to_string()
            }
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
            ClaimOutcome::HeldByOther {
                surface: Surface::Chat,
                tab_id: "tab-a".to_string()
            }
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

    /// A webview reload keeps the child and destroys the tab, so the tab that
    /// picks the session back up has a new id. The claim has to follow it: a
    /// claim naming a tab nobody can focus is a refusal with no way out.
    #[test]
    fn a_rewire_moves_the_claim_onto_the_tab_now_driving_the_session() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-before-reload"));
        assert!(retag(&mut claims, "s1", "tab-after-reload"));
        assert_eq!(claims["s1"].tab_id, "tab-after-reload");
        // And the claim is still the same claim: retag moves a holder, it does
        // not hand the session to a different surface.
        assert_eq!(claims["s1"].surface, Surface::Chat);
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::Chat, "tab-third"), live()),
            ClaimOutcome::AlreadyMineFocus {
                tab_id: "tab-after-reload".to_string()
            }
        );
    }

    /// A rewire is not a claim. Retagging an id nobody holds would mint one
    /// behind the claim path's back, with no probe run and no refusal possible.
    #[test]
    fn retagging_an_unheld_session_records_nothing() {
        let mut claims = HashMap::new();
        assert!(!retag(&mut claims, "s1", "tab-a"));
        assert!(claims.is_empty());
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
        let probe = Probe {
            holder_alive: false,
            externally_running: true,
            child_still_ours: false,
        };
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::Chat, "tab-a"), probe),
            ClaimOutcome::Granted { contested: true }
        );
    }

    /// A crash record whose child outlived it. Distinct from the contested case
    /// above because we know the pid and can offer to end it.
    #[test]
    fn a_dead_tori_with_a_surviving_child_is_an_orphan_not_a_grant() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        let probe = Probe {
            holder_alive: false,
            externally_running: true,
            child_still_ours: true,
        };
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::Chat, "tab-b"), probe),
            ClaimOutcome::Orphaned { child_pid: 4242 }
        );
    }

    /// A crash record with nothing left alive is litter, not an obstacle.
    #[test]
    fn a_dead_tori_with_no_surviving_child_is_just_a_stale_record() {
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
        assert_eq!(
            found,
            vec![Reaped::Stale {
                session_id: "s1".to_string()
            }]
        );
    }

    #[test]
    fn a_crashed_tori_whose_child_still_runs_the_session_is_reported_as_an_orphan() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        let found = classify_persisted(&claims, |_| false, |_, _, _| true);
        assert_eq!(
            found,
            vec![Reaped::Orphan {
                session_id: "s1".to_string(),
                child_pid: 4242,
                agent: "claude".into()
            }]
        );
    }

    #[test]
    fn a_claim_whose_tori_is_alive_is_not_reaped_at_all() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        assert!(classify_persisted(&claims, |_| true, |_, _, _| true).is_empty());
    }

    // ---- persistence (pure round trip, no global store touched) ----

    #[test]
    fn claims_round_trip_through_the_on_disk_shape() {
        let mut claims = HashMap::new();
        record(&mut claims, "s1", claim(Surface::Chat, "tab-a"));
        record(
            &mut claims,
            "s2",
            Claim {
                surface: Surface::PtyAgent,
                tab_id: "tab-b".into(),
                child_pid: None,
                tori_pid: 9,
                agent: "claude".into(),
                profile: "default".into(),
            },
        );
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

    // --- what a removal would strand ---

    fn held(agent: &str, tori_pid: u32, child_pid: Option<u32>) -> Claim {
        held_on(agent, DEFAULT_PROFILE, tori_pid, child_pid)
    }

    const DEFAULT_PROFILE: &str = crate::accounts::DEFAULT_PROFILE_ID;

    /// The tab id is derived from the session id so the assertions below can
    /// name what they seeded: `held_by` answers in tab ids, not session ids.
    fn held_on(agent: &str, profile: &str, tori_pid: u32, child_pid: Option<u32>) -> Claim {
        Claim {
            surface: Surface::Chat,
            tab_id: "tab".into(),
            child_pid,
            tori_pid,
            agent: agent.into(),
            profile: profile.into(),
        }
    }

    /// One claim, with a tab id of its own.
    fn on_tab(claim: Claim, tab_id: &str) -> Claim {
        Claim {
            tab_id: tab_id.into(),
            ..claim
        }
    }

    #[test]
    fn held_by_names_only_this_agents_live_tabs() {
        let mut claims = HashMap::new();
        claims.insert("s-b".to_string(), on_tab(held("claude", 1, Some(9)), "claude-b"));
        claims.insert("s-a".to_string(), on_tab(held("claude", 1, Some(9)), "claude-a"));
        claims.insert("s-1".to_string(), on_tab(held("codex", 1, Some(9)), "codex-1"));
        // Sorted, so a refusal message reads the same twice running.
        assert_eq!(
            held_by(&claims, "claude", DEFAULT_PROFILE, |_| true),
            ["claude-a", "claude-b"]
        );
        assert_eq!(held_by(&claims, "codex", DEFAULT_PROFILE, |_| true), ["codex-1"]);
        assert!(held_by(&claims, "gemini", DEFAULT_PROFILE, |_| true).is_empty());
    }

    /// The whole reason this answers in tab ids: the removal guard unions it
    /// with the PTY host's live table, which can only answer in tab ids. A
    /// resumed PTY agent tab is in both, and two id spaces would count one tab
    /// twice and tell the user to close two things.
    #[test]
    fn a_claims_tab_id_is_the_one_the_pty_table_would_name() {
        let mut claims = HashMap::new();
        claims.insert(
            "s-1".to_string(),
            on_tab(
                Claim {
                    surface: Surface::PtyAgent,
                    ..held("claude", 1, None)
                },
                "sh:7",
            ),
        );
        assert_eq!(held_by(&claims, "claude", DEFAULT_PROFILE, |_| true), ["sh:7"]);
    }

    /// Removal is per account, so another account's live chat must not be the
    /// unexplainable reason this one cannot be removed.
    #[test]
    fn held_by_names_only_the_account_being_removed() {
        let mut claims = HashMap::new();
        claims.insert(
            "s-default".to_string(),
            on_tab(held_on("claude", DEFAULT_PROFILE, 1, Some(9)), "on-default"),
        );
        claims.insert(
            "s-globex".to_string(),
            on_tab(held_on("claude", "globex", 1, Some(9)), "on-globex"),
        );
        assert_eq!(held_by(&claims, "claude", "globex", |_| true), ["on-globex"]);
        assert_eq!(held_by(&claims, "claude", DEFAULT_PROFILE, |_| true), ["on-default"]);
    }

    /// A claims file written before accounts existed names no profile, and
    /// every session in it ran on the login the user already had.
    #[test]
    fn a_claim_stored_before_accounts_reads_as_the_default_profile() {
        let text = r#"{"s1":{"surface":"chat","tabId":"t","toriPid":1,"agent":"claude"}}"#;
        let claims = parse_claims(text);
        assert_eq!(claims["s1"].profile, DEFAULT_PROFILE);
    }

    /// A crash record must not block a removal forever. The user would have no
    /// way to tell why, and nothing they could do about it.
    #[test]
    fn a_session_held_by_a_dead_tori_blocks_nothing() {
        let mut claims = HashMap::new();
        claims.insert("s1".to_string(), held("claude", 4_000_000, Some(9)));
        assert!(held_by(&claims, "claude", DEFAULT_PROFILE, pid_alive).is_empty());
    }

    /// A PTY agent tab records no `child_pid`, and a login flow produces exactly
    /// those. Testing liveness by the child would miss them all.
    #[test]
    fn a_pty_agent_tab_counts_even_with_no_child_pid_recorded() {
        let mut claims = HashMap::new();
        claims.insert(
            "s1".to_string(),
            on_tab(held("claude", std::process::id(), None), "sh:1"),
        );
        assert_eq!(held_by(&claims, "claude", DEFAULT_PROFILE, pid_alive), ["sh:1"]);
    }

    /// A claim naming a dead Tori pid must be recognised as a crash record, not
    /// trusted as a live holder - otherwise every session a crashed Tori had
    /// open would stay permanently unclaimable.
    #[test]
    fn a_claim_naming_a_dead_tori_pid_is_not_trusted() {
        let mut claims = HashMap::new();
        // A pid above the system maximum can never be live, so `pid_alive`
        // really answers here rather than the test asserting against a stub.
        let dead = 4_000_000_u32;
        record(
            &mut claims,
            "s1",
            Claim {
                surface: Surface::Chat,
                tab_id: "tab-a".into(),
                child_pid: None,
                tori_pid: dead,
                agent: "claude".into(),
                profile: "default".into(),
            },
        );
        assert!(!pid_alive(dead));
        assert_eq!(
            decide(
                &claims,
                "s1",
                &claim(Surface::Chat, "tab-b"),
                Probe {
                    holder_alive: pid_alive(dead),
                    externally_running: false,
                    child_still_ours: false
                }
            ),
            ClaimOutcome::Granted { contested: false }
        );
    }

    /// Our own pid is alive, which is the positive control for the check above.
    #[test]
    fn pid_alive_finds_this_very_process() {
        assert!(pid_alive(std::process::id()));
    }

    /// The id-independent liveness rule, tested against a table rather than
    /// against whatever happens to be running: a session is live exactly when
    /// the claim records a child and that child is still there.
    #[test]
    fn a_session_is_live_when_its_claimed_child_is() {
        let mut claims = HashMap::new();
        claims.insert("live".to_string(), {
            let mut c = claim(Surface::Chat, "tab-a");
            c.child_pid = Some(4242);
            c
        });
        claims.insert("gone".to_string(), {
            let mut c = claim(Surface::Chat, "tab-b");
            c.child_pid = Some(9999);
            c
        });
        // A PTY tab's child is a login shell, so its claim records no agent
        // child at all - and no child is not a running session.
        claims.insert("pty".to_string(), {
            let mut c = claim(Surface::PtyAgent, "tab-c");
            c.child_pid = None;
            c
        });

        let ids = ["live", "gone", "pty", "never-claimed"].map(str::to_string).to_vec();
        let live = with_live_child(&claims, &ids, |pid| pid == 4242);
        assert_eq!(live, vec!["live".to_string()]);
    }

    /// `kill -0 0` succeeds, because 0 means "my whole process group" rather
    /// than a process. A liveness check that trusted it would report a
    /// zero-valued pid as alive, and a terminate that trusted it would signal
    /// every process Tori shares a group with.
    #[test]
    fn pid_zero_and_one_are_never_treated_as_signalable() {
        assert!(!is_signalable_pid(0));
        assert!(!is_signalable_pid(1));
        assert!(!pid_alive(0), "pid 0 is the process group, not a process");
        assert!(!pid_alive(1), "launchd is never a Tori or an agent child");

        let registry = Registry::at(temp_store("signal-guard"));
        assert!(terminate_orphan(&registry, "s1", 0, "claude").is_err());
    }

    /// The external-vs-orphan distinction against the **real** process table, so
    /// the running pattern and the pid membership check are exercised rather
    /// than stubbed.
    ///
    /// A process whose command line matches the adapter's running pattern stands
    /// in for a `claude --resume` the user started in Ghostty. With no claim of
    /// ours, that is contested: allowed, because we cannot stop it, but the
    /// caller has to warn. It must never be reported as an orphan, since we did
    /// not start it and have no business offering to kill it.
    #[test]
    fn a_session_running_outside_tori_is_contested_and_never_reported_as_an_orphan() {
        let id = format!("ext-{}", std::process::id());
        // The shell's own command line contains `claude --resume <id>`, which is
        // what the adapter's running pattern matches on.
        let mut child = crate::platform::testing::sh_command(&format!("claude --resume {id} ; sleep 5"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("the stand-in external session should start");

        // The process table needs a moment to show a freshly forked process.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut seen = false;
        while std::time::Instant::now() < deadline && !seen {
            seen = crate::sessions::running_by_pattern("claude", &id);
            if !seen {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        assert!(
            seen,
            "the stand-in should be visible to the same snapshot the claim path uses"
        );

        let registry = Registry::at(temp_store("contested"));
        let outcome = registry.claim(
            &id,
            Claim {
                surface: Surface::Chat,
                tab_id: "tab-a".into(),
                child_pid: None,
                tori_pid: std::process::id(),
                agent: "claude".into(),
                profile: "default".into(),
            },
        );
        assert_eq!(
            outcome,
            ClaimOutcome::Granted { contested: true },
            "a session running outside Tori is a warning, not a refusal"
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
        let mut child = crate::platform::testing::sh_command(&format!("claude --resume {id} ; sleep 5"))
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
    /// a real store file: what a `SIGKILL`ed Tori leaves behind, and what the
    /// next launch does about it.
    ///
    /// A killed Tori cannot clean up after itself, which is the whole reason the
    /// claim is written to disk. So the leftover is reconstructed exactly as a
    /// crash would leave it - a record naming a dead Tori pid and a child that is
    /// still running - and then the startup reap is run against it. Three things
    /// have to hold together, and any one alone is not enough: the child is
    /// *named* as an orphan (so the user can be offered its termination), the
    /// record *survives* (so the session stays unclaimable meanwhile), and a
    /// claim attempt is refused with the same pid rather than silently
    /// proceeding.
    #[test]
    fn a_crashed_tori_leaves_a_named_orphan_and_the_session_stays_unclaimable() {
        let id = format!("crash-{}", std::process::id());
        let mut child = crate::platform::testing::sh_command(&format!("claude --resume {id} ; sleep 10"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("the surviving child should start");
        let child_pid = child.id();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline && !pid_runs_session("claude", &id, child_pid) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // The record a killed Tori leaves: its own pid is gone, its child is not.
        let store = temp_store("crash-recovery");
        let mut leftover = HashMap::new();
        record(
            &mut leftover,
            &id,
            Claim {
                surface: Surface::Chat,
                tab_id: "tab-a".into(),
                child_pid: Some(child_pid),
                tori_pid: 4_000_000,
                agent: "claude".into(),
                profile: "default".into(),
            },
        );
        // Plus a record whose child did not survive, which must be swept.
        record(
            &mut leftover,
            "litter",
            Claim {
                surface: Surface::Chat,
                tab_id: "tab-z".into(),
                child_pid: None,
                tori_pid: 4_000_000,
                agent: "claude".into(),
                profile: "default".into(),
            },
        );
        save_claims_to(&store, &leftover).unwrap();

        let orphans = reap_at(&store);
        assert_eq!(
            orphans,
            vec![Reaped::Orphan {
                session_id: id.clone(),
                child_pid,
                agent: "claude".into()
            }],
            "the surviving child should be named as an orphan, and the litter swept"
        );

        let survivors = load_claims_from(&store);
        assert!(
            survivors.contains_key(&id),
            "an orphan's record must survive, or its session looks free"
        );
        assert!(
            !survivors.contains_key("litter"),
            "a record with nothing alive behind it is litter"
        );

        // And the session is genuinely unclaimable until the user decides.
        let registry = Registry::at(store.clone());
        *registry.claims.lock().unwrap() = survivors;
        assert_eq!(
            registry.claim(
                &id,
                Claim {
                    surface: Surface::Chat,
                    tab_id: "tab-new".into(),
                    child_pid: None,
                    tori_pid: std::process::id(),
                    agent: "claude".into(),
                    profile: "default".into()
                },
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
    /// second agent's surviving child "gone" and never mention it.
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
                tori_pid: 4_000_000,
                agent: "claude".into(),
                profile: DEFAULT_PROFILE.into(),
            },
        );
        record(
            &mut claims,
            "s-other",
            Claim {
                surface: Surface::Chat,
                tab_id: "t2".into(),
                child_pid: Some(4343),
                tori_pid: 4_000_000,
                agent: "gemini".into(),
                profile: DEFAULT_PROFILE.into(),
            },
        );

        let seen = std::sync::Mutex::new(Vec::new());
        let found = classify_persisted(
            &claims,
            |_| false,
            |agent, id, pid| {
                seen.lock().unwrap().push((agent.to_string(), id.to_string(), pid));
                true
            },
        );
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
        assert!(found
            .iter()
            .any(|r| matches!(r, Reaped::Orphan { agent, .. } if agent == "gemini")));
    }

    /// A claims file written before the agent field existed must still load.
    /// Only claude could have written one, which is what makes the default safe.
    #[test]
    fn a_claim_file_predating_the_agent_field_still_loads() {
        let parsed = parse_claims(r#"{"s1":{"surface":"chat","tabId":"t","childPid":42,"toriPid":7}}"#);
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
            Claim {
                surface: Surface::PtyAgent,
                tab_id: "tab-a".into(),
                child_pid: None,
                tori_pid: 12345,
                agent: "claude".into(),
                profile: "default".into(),
            },
        );
        let probe = Probe {
            holder_alive: false,
            externally_running: true,
            child_still_ours: true,
        };
        assert_eq!(
            decide(&claims, "s1", &claim(Surface::Chat, "tab-b"), probe),
            ClaimOutcome::Granted { contested: true }
        );
    }
}
