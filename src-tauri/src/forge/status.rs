//! One poll tick: what to ask about, what to serve from memory, and how not to
//! ask the same thing twice at once.
//!
//! A pure core (a cache, a plan, a coalescer, all with their inputs explicit)
//! plus a thin global wrapper, per `[[lesson_pure_core_for_global_stores]]`.
//!
//! ## Why the tick is capped
//!
//! The batched query is one HTTP request whatever the branch count, which is
//! the reason `Forge::unit_statuses` takes a slice. It is *not* one unit of rate
//! budget: GitHub prices a GraphQL call by the connections it opens, and each
//! branch in the query opens a PR, a commit and up to 100 check contexts, so a
//! tick over N branches costs roughly N points of the 5,000/hour. Twenty
//! branches is about 21 points, which a two-minute interval turns into ~630 an
//! hour per project. Uncapped, a project with a hundred stale worktrees would
//! spend the whole budget on branches nobody is looking at.
//!
//! So the tick takes the first [`UNITS_PER_TICK`] branches **in the order the
//! caller passed them** (the caller puts the visible ones first, since it is the
//! only side that knows what is on screen) and reports the rest as `uncovered`
//! rather than dropping them silently. A partial answer that renders as a
//! complete one is the failure nobody notices: those units simply never get a
//! chip, with nothing on screen saying why.

use super::model::{CheckState, PrState, RateSnapshot, RepoRef, ReviewDecision, StatusReport, UnitStatus};
use super::ForgeError;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How many branch-units one tick may ask about. See the module note for the
/// arithmetic behind the number.
pub const UNITS_PER_TICK: usize = 20;

/// How long a fetched status is good enough to answer with.
///
/// Shorter than the poll interval on purpose: this window is not the polling
/// cadence, it is what stops the *other* triggers (a window focus, a project
/// re-select, a second panel asking) from each costing a request. A tick that
/// actually wants fresh data passes `refresh`.
pub const FRESH_FOR: Duration = Duration::from_secs(30);

/// Owner, repo and branch. Branch alone would collide across two projects that
/// both have a `main`, which is what a single-window app switching between
/// worktrees does all day.
type Key = (String, String, String);

/// What one tick will ask about, and what it will not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TickPlan {
    pub ask: Vec<String>,
    /// Distinct branches this tick left out. Counted, never dropped.
    pub uncovered: usize,
}

/// Trims the caller's branch list down to one tick's worth.
///
/// Order is the caller's priority order and is preserved. Duplicates collapse
/// before the cap so two worktrees on the same branch do not each eat a slot,
/// and empty names are skipped entirely rather than counted as uncovered: a
/// `plain-dir` unit has no branch, so there is nothing the forge could be asked
/// about and nothing the UI should report as missed.
pub fn plan_tick(branches: &[String], cap: usize) -> TickPlan {
    let mut seen = HashSet::new();
    let mut ask: Vec<String> = Vec::new();
    for b in branches {
        if b.is_empty() || !seen.insert(b.as_str()) {
            continue;
        }
        ask.push(b.clone());
    }
    let distinct = ask.len();
    ask.truncate(cap);
    TickPlan { uncovered: distinct - ask.len(), ask }
}

#[derive(Debug, Default)]
pub struct StatusCache {
    entries: HashMap<Key, (Instant, UnitStatus)>,
}

impl StatusCache {
    fn key(repo: &RepoRef, branch: &str) -> Key {
        (repo.owner.clone(), repo.repo.clone(), branch.to_string())
    }

    pub fn get_fresh(
        &self,
        repo: &RepoRef,
        branch: &str,
        now: Instant,
        ttl: Duration,
    ) -> Option<UnitStatus> {
        let (at, status) = self.entries.get(&Self::key(repo, branch))?;
        // `checked_duration_since` rather than subtraction: `Instant` arithmetic
        // panics on a negative interval, and a `now` older than the entry is
        // exactly what a test that fixes its clock hands in.
        if now.checked_duration_since(*at).map(|age| age <= ttl).unwrap_or(true) {
            return Some(status.clone());
        }
        None
    }

    /// Files a status under the head ref the server echoed back, not under
    /// whatever the caller asked about. The two disagree the moment a branch is
    /// renamed mid-flight, and the server's answer is the authority.
    pub fn put(&mut self, repo: &RepoRef, status: &UnitStatus, now: Instant) {
        self.entries.insert(Self::key(repo, &status.head_ref), (now, status.clone()));
    }

    /// Drops every branch of one repo. What a merge or a close needs: both can
    /// change the answer for branches other than their own.
    pub fn invalidate_repo(&mut self, repo: &RepoRef) {
        self.entries.retain(|(owner, name, _), _| owner != &repo.owner || name != &repo.repo);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Every asked branch from the cache, or nothing.
///
/// All-or-nothing because the fetch is batched: covering a partial hit still
/// costs exactly one request, so serving three of five branches from memory and
/// asking for the other two saves nothing and returns a mixed-age answer.
pub fn cached_report(
    cache: &StatusCache,
    repo: &RepoRef,
    ask: &[String],
    now: Instant,
) -> Option<Vec<UnitStatus>> {
    let mut out = Vec::with_capacity(ask.len());
    for branch in ask {
        out.push(cache.get_fresh(repo, branch, now, FRESH_FOR)?);
    }
    Some(out)
}

/// What a fetch hands back: the statuses, and what the response said about the
/// budget on the way past.
pub type Fetched = (Vec<UnitStatus>, RateSnapshot);

/// One tick against a caller-owned cache.
///
/// The single-threaded composition, used by tests. [`cached_tick`] is the same
/// three steps against the process-wide cache, with the coalescer in between.
pub fn tick<F>(
    cache: &mut StatusCache,
    repo: &RepoRef,
    branches: &[String],
    refresh: bool,
    now: Instant,
    fetch: F,
) -> Result<StatusReport, ForgeError>
where
    F: FnOnce(&[String]) -> Result<Fetched, ForgeError>,
{
    let plan = plan_tick(branches, UNITS_PER_TICK);
    if plan.ask.is_empty() {
        return Ok(StatusReport {
            statuses: vec![],
            uncovered: plan.uncovered,
            rate: RateSnapshot::default(),
        });
    }
    if !refresh {
        if let Some(hit) = cached_report(cache, repo, &plan.ask, now) {
            return Ok(StatusReport {
                statuses: hit,
                uncovered: plan.uncovered,
                rate: RateSnapshot::default(),
            });
        }
    }
    // `?` before the writes is the rule that a failed tick caches nothing: a
    // rate limit and an offline laptop are not evidence about any branch's
    // state, and a cached wrong answer would outlive the failure that caused it.
    let (statuses, rate) = fetch(&plan.ask)?;
    for s in &statuses {
        cache.put(repo, s, now);
    }
    Ok(StatusReport { statuses, uncovered: plan.uncovered, rate })
}

/// Collapses concurrent identical requests into one.
///
/// Two triggers landing together (a window focus while the interval fires, or a
/// second panel mounting) would otherwise each spend a request for the same
/// answer. The follower waits on the leader's result rather than starting its
/// own, so the cost is one call and both callers get the same data.
///
/// Keyed by the **exact ask**, not by the project: a follower given a leader's
/// answer for a different branch set would silently receive statuses it never
/// asked about and, worse, miss the ones it did.
pub struct SingleFlight<T = Fetched> {
    in_flight: Mutex<HashMap<String, Shared<T>>>,
}

impl<T> Default for SingleFlight<T> {
    fn default() -> Self {
        Self { in_flight: Mutex::new(HashMap::new()) }
    }
}

type Answer<T = Fetched> = Result<T, ForgeError>;
type Shared<T> = Arc<(Mutex<Option<Answer<T>>>, Condvar)>;

impl<T: Clone> SingleFlight<T> {
    pub fn run<F>(&self, key: String, fetch: F) -> Answer<T>
    where
        F: FnOnce() -> Answer<T>,
    {
        let (shared, leading) = {
            let mut map = self.in_flight.lock().unwrap();
            match map.get(&key) {
                Some(s) => (s.clone(), false),
                None => {
                    let s: Shared<T> = Arc::new((Mutex::new(None), Condvar::new()));
                    map.insert(key.clone(), s.clone());
                    (s, true)
                }
            }
        };

        if !leading {
            let mut slot = shared.0.lock().unwrap();
            while slot.is_none() {
                slot = shared.1.wait(slot).unwrap();
            }
            return slot.clone().expect("the leader published before notifying");
        }

        // The publish lives in a `Drop` so a panicking fetch cannot leave
        // followers waiting on a result that will never arrive. A hung sidebar
        // is a far worse failure than the error they get instead.
        let mut lead = Leader { flight: self, key, shared, answer: None };
        let out = fetch();
        lead.answer = Some(out.clone());
        out
    }
}

struct Leader<'a, T> {
    flight: &'a SingleFlight<T>,
    key: String,
    shared: Shared<T>,
    answer: Option<Answer<T>>,
}

impl<T> Drop for Leader<'_, T> {
    fn drop(&mut self) {
        // Removed from the map first, so the *next* caller starts a fresh flight
        // rather than joining one that has already answered.
        self.flight.in_flight.lock().unwrap().remove(&self.key);
        let answer = self.answer.take().unwrap_or(Err(ForgeError::Transport {
            message: "the request did not complete".into(),
        }));
        *self.shared.0.lock().unwrap() = Some(answer);
        self.shared.1.notify_all();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrFacts {
    pub pull_request: Option<(u64, PrState)>,
    pub checks: CheckState,
    pub review: ReviewDecision,
}

impl PrFacts {
    pub fn of(status: &UnitStatus) -> Self {
        Self {
            pull_request: status.pull_request.as_ref().map(|pr| (pr.number, pr.state)),
            checks: status.checks.state,
            review: status.review_decision,
        }
    }
}

// What was last said per (project, branch). Kept apart from the TTL cache, so
// an expiry or `invalidate_repo` there never reads as a change here.
#[derive(Default)]
pub struct Published(HashMap<(String, String), PrFacts>);

impl Published {
    // A branch seen for the first time only seeds, so a launch is not a burst
    // of every branch.
    pub fn moved<'a>(&mut self, project: &str, statuses: &'a [UnitStatus]) -> Vec<&'a UnitStatus> {
        statuses
            .iter()
            .filter(|s| {
                let now = PrFacts::of(s);
                let before = self.0.insert((project.to_string(), s.head_ref.clone()), now);
                before.is_some_and(|b| b != now)
            })
            .collect()
    }
}

static PUBLISHED: Mutex<Option<Published>> = Mutex::new(None);

pub fn moved_since_published(project: &str, statuses: &[UnitStatus]) -> Vec<UnitStatus> {
    let mut guard = PUBLISHED.lock().unwrap_or_else(|e| e.into_inner());
    guard.get_or_insert_with(Published::default).moved(project, statuses).into_iter().cloned().collect()
}

// --- thin global wrapper ---

static CACHE: Mutex<Option<StatusCache>> = Mutex::new(None);
static FLIGHT: OnceLock<SingleFlight> = OnceLock::new();

fn with<R>(f: impl FnOnce(&mut StatusCache) -> R) -> R {
    let mut guard = CACHE.lock().unwrap();
    f(guard.get_or_insert_with(StatusCache::default))
}

fn flight() -> &'static SingleFlight {
    FLIGHT.get_or_init(SingleFlight::default)
}

/// The exact ask, so a coalesced follower can only ever receive the answer to
/// its own question.
fn flight_key(repo: &RepoRef, ask: &[String]) -> String {
    format!("{}/{}\n{}", repo.owner, repo.repo, ask.join("\n"))
}

/// [`tick`] against the process-wide cache, with concurrent identical ticks
/// collapsed into one request.
///
/// **The cache lock is released before the fetch and retaken after it**, for the
/// same reason as `prs::cached_lookup`: one global mutex held across the network
/// would make a single stalled request freeze every other project's status. The
/// coalescer, not the lock, is what stops the duplicate call.
pub fn cached_tick<F>(
    repo: &RepoRef,
    branches: &[String],
    refresh: bool,
    fetch: F,
) -> Result<StatusReport, ForgeError>
where
    F: FnOnce(&[String]) -> Result<Fetched, ForgeError>,
{
    let plan = plan_tick(branches, UNITS_PER_TICK);
    if plan.ask.is_empty() {
        return Ok(StatusReport {
            statuses: vec![],
            uncovered: plan.uncovered,
            rate: RateSnapshot::default(),
        });
    }
    if !refresh {
        if let Some(hit) = with(|c| cached_report(c, repo, &plan.ask, Instant::now())) {
            return Ok(StatusReport {
                statuses: hit,
                uncovered: plan.uncovered,
                rate: RateSnapshot::default(),
            });
        }
    }
    let (statuses, rate) = flight().run(flight_key(repo, &plan.ask), || fetch(&plan.ask))?;
    with(|c| {
        let now = Instant::now();
        for s in &statuses {
            c.put(repo, s, now);
        }
    });
    Ok(StatusReport { statuses, uncovered: plan.uncovered, rate })
}

/// Whether the global cache is currently unlocked. Only used to prove that a
/// fetch does not run under the lock.
#[cfg(test)]
fn lock_is_free() -> bool {
    CACHE.try_lock().is_ok()
}

/// What a merge or a close calls, so the next tick re-reads the whole project.
pub fn invalidate_repo(repo: &RepoRef) {
    with(|c| c.invalidate_repo(repo));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::model::{CheckRollup, ReviewDecision};
    use std::cell::Cell;

    fn repo() -> RepoRef {
        RepoRef { owner: "skarif2".into(), repo: "tori".into() }
    }

    fn status(head: &str) -> UnitStatus {
        UnitStatus {
            head_ref: head.into(),
            pull_request: None,
            checks: CheckRollup::none(),
            review_decision: ReviewDecision::None,
        }
    }

    fn branches(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn answered(ask: &[String]) -> Result<Fetched, ForgeError> {
        Ok((ask.iter().map(|b| status(b)).collect(), RateSnapshot::default()))
    }

    #[test]
    fn a_tick_past_the_cap_reports_what_it_left_out() {
        // The whole point of `uncovered`: a silently truncated answer renders as
        // a complete one, and the units past the cap just never get a chip.
        let all: Vec<String> = (0..UNITS_PER_TICK + 5).map(|i| format!("wave-{i}")).collect();
        let plan = plan_tick(&all, UNITS_PER_TICK);
        assert_eq!(plan.ask.len(), UNITS_PER_TICK);
        assert_eq!(plan.uncovered, 5);
        // Caller order is priority order: the visible units the caller listed
        // first are the ones that get asked about.
        assert_eq!(plan.ask[0], "wave-0");
    }

    #[test]
    fn duplicate_branches_do_not_each_eat_a_slot() {
        // Two worktrees on one branch is normal (a detached checkout beside the
        // primary), and asking twice buys nothing.
        let plan = plan_tick(&branches(&["main", "wave-3", "main"]), 2);
        assert_eq!(plan.ask, branches(&["main", "wave-3"]));
        assert_eq!(plan.uncovered, 0, "the duplicate was never a distinct unit");
    }

    #[test]
    fn a_unit_with_no_branch_is_not_a_unit_the_forge_can_answer_for() {
        // A `plain-dir` unit has no branch. Counting it as uncovered would put a
        // permanent "1 not covered" on a project that is fully covered.
        let plan = plan_tick(&branches(&["", "main", ""]), 20);
        assert_eq!(plan.ask, branches(&["main"]));
        assert_eq!(plan.uncovered, 0);
    }

    #[test]
    fn a_second_ask_inside_the_freshness_window_costs_nothing() {
        let mut c = StatusCache::default();
        let calls = Cell::new(0);
        let now = Instant::now();
        for _ in 0..2 {
            tick(&mut c, &repo(), &branches(&["main"]), false, now, |ask| {
                calls.set(calls.get() + 1);
                answered(ask)
            })
            .unwrap();
        }
        assert_eq!(calls.get(), 1, "the second tick was served from memory");
    }

    #[test]
    fn a_stale_entry_is_re_asked_rather_than_served() {
        let mut c = StatusCache::default();
        let t0 = Instant::now();
        let calls = Cell::new(0);
        let mut run_at = |now: Instant| {
            tick(&mut c, &repo(), &branches(&["main"]), false, now, |ask| {
                calls.set(calls.get() + 1);
                answered(ask)
            })
            .unwrap()
        };
        run_at(t0);
        run_at(t0 + FRESH_FOR + Duration::from_secs(1));
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn one_stale_branch_re_asks_for_the_whole_batch() {
        // Not a compromise: the fetch is batched, so covering the miss costs one
        // request whether it carries one branch or twenty. Serving the rest from
        // memory would only buy an answer of mixed age.
        let mut c = StatusCache::default();
        let t0 = Instant::now();
        c.put(&repo(), &status("main"), t0);
        let asked = std::cell::RefCell::new(Vec::new());
        tick(&mut c, &repo(), &branches(&["main", "wave-3"]), false, t0, |ask| {
            *asked.borrow_mut() = ask.to_vec();
            answered(ask)
        })
        .unwrap();
        assert_eq!(*asked.borrow(), branches(&["main", "wave-3"]));
    }

    #[test]
    fn a_refresh_re_asks_but_does_not_opt_the_project_out_of_caching() {
        let mut c = StatusCache::default();
        let now = Instant::now();
        tick(&mut c, &repo(), &branches(&["main"]), false, now, answered).unwrap();

        let calls = Cell::new(0);
        tick(&mut c, &repo(), &branches(&["main"]), true, now, |ask| {
            calls.set(calls.get() + 1);
            answered(ask)
        })
        .unwrap();
        assert_eq!(calls.get(), 1, "the refresh went to the network");

        tick(&mut c, &repo(), &branches(&["main"]), false, now, |ask| {
            calls.set(calls.get() + 1);
            answered(ask)
        })
        .unwrap();
        assert_eq!(calls.get(), 1, "and the refreshed answer is now the cached one");
    }

    #[test]
    fn a_failed_tick_caches_nothing() {
        // A rate limit says nothing about any branch. Caching an answer derived
        // from a failure would outlive the failure itself.
        let mut c = StatusCache::default();
        let err = tick(&mut c, &repo(), &branches(&["main"]), false, Instant::now(), |_| {
            Err(ForgeError::RateLimited {
                kind: crate::forge::RateLimitKind::Primary,
                retry_after_secs: None,
                reset_at_secs: None,
            })
        })
        .unwrap_err();
        assert!(matches!(err, ForgeError::RateLimited { .. }));
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn a_status_is_filed_under_the_head_the_server_named() {
        // The server's echo is the authority. Filing by position in the ask
        // would put every entry under the wrong key the moment the two lists
        // disagree.
        let mut c = StatusCache::default();
        let now = Instant::now();
        tick(&mut c, &repo(), &branches(&["main"]), false, now, |_| {
            Ok((vec![status("renamed")], RateSnapshot::default()))
        })
        .unwrap();
        assert!(c.get_fresh(&repo(), "renamed", now, FRESH_FOR).is_some());
        assert!(c.get_fresh(&repo(), "main", now, FRESH_FOR).is_none());
    }

    #[test]
    fn two_repos_with_the_same_branch_name_never_collide() {
        let other = RepoRef { owner: "skarif2".into(), repo: "grimoire".into() };
        let mut c = StatusCache::default();
        let now = Instant::now();
        c.put(&repo(), &status("main"), now);
        c.put(&other, &status("main"), now);
        c.invalidate_repo(&repo());
        assert!(c.get_fresh(&repo(), "main", now, FRESH_FOR).is_none());
        assert!(c.get_fresh(&other, "main", now, FRESH_FOR).is_some());
    }

    #[test]
    fn an_empty_project_asks_nothing_at_all() {
        let mut c = StatusCache::default();
        let report = tick(&mut c, &repo(), &[], false, Instant::now(), |_| {
            panic!("a project with no branch-units must not reach the network")
        })
        .unwrap();
        assert!(report.statuses.is_empty());
        assert_eq!(report.uncovered, 0);
    }

    #[test]
    fn two_concurrent_ticks_for_one_project_make_one_request() {
        // The failure this prevents is invisible in a single-threaded test: a
        // focus event landing on the same millisecond as the interval doubles
        // every tick's cost, and both callers still get the right answer, so
        // nothing looks wrong until the budget runs out.
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;

        let flight = Arc::new(SingleFlight::default());
        let calls = Arc::new(AtomicUsize::new(0));
        // Trips *inside* the leader's fetch, so by the time this thread joins,
        // the flight being registered and open is an ordering fact rather than a
        // race. Two threads both racing to call `run` would sometimes have the
        // second arrive after the first had already published, which makes two
        // requests the correct behaviour and the test a coin flip.
        let in_fetch = Arc::new(Barrier::new(2));

        let leader = {
            let (flight, calls, in_fetch) = (flight.clone(), calls.clone(), in_fetch.clone());
            std::thread::spawn(move || {
                flight.run("skarif2/tori\nmain".into(), || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    in_fetch.wait();
                    // Held open while this thread joins. A sleep rather than a
                    // second barrier because a follower blocked on the condvar
                    // cannot signal anything, and a barrier nobody reaches is a
                    // hang; this one always ends.
                    std::thread::sleep(Duration::from_millis(50));
                    Ok((vec![status("main")], RateSnapshot::default()))
                })
            })
        };

        in_fetch.wait();
        let follower = flight.run("skarif2/tori\nmain".into(), || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok((vec![], RateSnapshot::default()))
        });

        assert_eq!(calls.load(Ordering::SeqCst), 1, "the second tick spent its own request");
        assert_eq!(follower.unwrap().0[0].head_ref, "main", "the follower got the real answer");
        assert_eq!(leader.join().unwrap().unwrap().0.len(), 1);
    }

    #[test]
    fn a_coalesced_follower_only_ever_gets_the_answer_to_its_own_question() {
        // Keying the flight by project alone would hand a follower asking about
        // twenty branches the leader's answer about one, which reads as
        // "nineteen units have no PR" rather than as a bug.
        let flight = SingleFlight::default();
        let one = flight.run(flight_key(&repo(), &branches(&["main"])), || {
            Ok((vec![status("main")], RateSnapshot::default()))
        });
        let two = flight.run(flight_key(&repo(), &branches(&["main", "wave-3"])), || {
            Ok((vec![status("main"), status("wave-3")], RateSnapshot::default()))
        });
        assert_eq!(one.unwrap().0.len(), 1);
        assert_eq!(two.unwrap().0.len(), 2);
    }

    #[test]
    fn a_flight_that_panics_does_not_strand_the_callers_waiting_on_it() {
        // Without the publish-on-drop, a panicking fetch would leave every
        // follower blocked on a condvar for the life of the process: the app
        // would not crash, it would simply stop answering.
        let flight = Arc::new(SingleFlight::default());
        let f = flight.clone();
        let panicked = std::thread::spawn(move || {
            f.run("k".into(), || -> Answer { panic!("the transport blew up") })
        });
        assert!(panicked.join().is_err(), "the panic still propagates to its own caller");

        // And the key is free again, so the next tick starts a fresh flight.
        let out = flight.run("k".into(), || Ok((vec![status("main")], RateSnapshot::default())));
        assert_eq!(out.unwrap().0.len(), 1);
    }

    #[test]
    fn the_global_cache_is_not_locked_while_a_request_is_in_flight() {
        // One global mutex held across the network would queue every project's
        // status behind the slowest single request. Nothing about that is
        // visible from a passing tick, which is why it is asserted.
        let unlocked = Cell::new(false);
        let probe = RepoRef { owner: "skarif2".into(), repo: "lock-probe".into() };
        cached_tick(&probe, &branches(&["main"]), true, |ask| {
            unlocked.set(lock_is_free());
            answered(ask)
        })
        .unwrap();
        assert!(unlocked.get(), "the fetch ran while holding the cache lock");
    }

    #[test]
    fn the_cache_sits_in_front_of_the_real_client_not_just_a_closure() {
        // The closure tests above prove the caching rules; this one proves they
        // are wired to the thing that actually costs a request, and that the
        // cost does not grow with the number of branches asked about.
        use crate::forge::http::test_support::StubTransport;
        use crate::forge::{github::GitHubForge, Forge};

        let body = r#"{"data":{"repository":{}}}"#;
        let stub = std::sync::Arc::new(StubTransport::new(vec![
            StubTransport::json(200, body),
            StubTransport::json(200, body),
        ]));
        let client = GitHubForge::new(Box::new(stub.clone()), "https://github.com", Some("gho_test".into()), None)
            .with_base("https://api.test");

        let three = branches(&["a", "b", "c"]);
        let twenty: Vec<String> = (0..20).map(|i| format!("u{i}")).collect();
        let mut c = StatusCache::default();
        let now = Instant::now();

        for set in [&three, &twenty] {
            tick(&mut c, &repo(), set, false, now, |ask| {
                let out = client.unit_statuses(&repo(), ask)?;
                Ok((out, client.rate_snapshot()))
            })
            .unwrap();
        }

        assert_eq!(
            stub.request_count(),
            2,
            "one request per tick, whether the tick covers three branches or twenty"
        );
        // And every branch of the larger tick really was in that single query.
        assert!(stub.bodies()[1].contains("u19"));
    }

    #[test]
    fn a_pr_change_is_news_once_and_a_first_sighting_is_not() {
        let mut published = Published::default();
        let failing = |head: &str| {
            let mut s = status(head);
            s.checks.state = CheckState::Failure;
            s
        };
        assert!(published.moved("/p", &[status("main"), status("feat")]).is_empty(), "first tick seeds");
        invalidate_repo(&RepoRef { owner: "o".into(), repo: "r".into() });
        assert!(published.moved("/p", &[status("main"), status("feat")]).is_empty(), "a refetch that says the same");
        let flipped = [status("main"), failing("feat")];
        let moved = published.moved("/p", &flipped);
        assert_eq!(moved.iter().map(|s| s.head_ref.as_str()).collect::<Vec<_>>(), ["feat"]);
        assert!(published.moved("/p", &flipped).is_empty(), "and once only");
        assert!(published.moved("/other", &flipped).is_empty(), "another project seeds on its own");
    }
}
