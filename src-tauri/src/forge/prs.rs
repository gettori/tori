//! The branch to pull-request association, derived rather than stored.
//!
//! Tori never persists "branch X has PR #12". The forge already knows, and a
//! stored copy is a second source of truth that goes wrong in the one direction
//! nobody notices: a PR closed, merged, or recreated elsewhere leaves Tori
//! confidently pointing at a number that no longer means what it says. So the
//! association is a **query** (`?head=owner:branch`), and this module is only a
//! cache in front of that query, thrown away when the app exits.
//!
//! ## Why the cached value is a nested `Option`
//!
//! `None` means *never asked*. `Some(None)` means *asked, and there is no PR*.
//! Collapsing them costs one API call per branch per repaint, because "no PR
//! yet" is the common case on a working branch and would never be cacheable.
//! Worse, the sidebar cannot tell "still loading" from "nothing here" and would
//! flash a create button on every render.
//!
//! ## Why a failed fetch never writes
//!
//! A rate limit, an offline laptop, and a suspect credential all fail the
//! lookup, and none of them is evidence about whether a PR exists. Writing
//! `Some(None)` on an error would cache "there is no PR" for the rest of the
//! session and hide a real PR behind a network blip, per
//! `[[lesson_pure_core_for_global_stores]]`: the core takes the fetch as an
//! argument so this rule is testable without a network.

use super::model::{PullRequest, RepoRef};
use super::ForgeError;
use std::collections::HashMap;

/// Owner, repo, and branch. Branch alone would collide across two projects that
/// both have a `main`, which is exactly what a single-window app switching
/// between worktrees does all day.
type Key = (String, String, String);

#[derive(Debug, Default)]
pub struct PrCache {
    entries: HashMap<Key, Option<PullRequest>>,
}

impl PrCache {
    fn key(repo: &RepoRef, branch: &str) -> Key {
        (repo.owner.clone(), repo.repo.clone(), branch.to_string())
    }

    /// The outer `Option` is "do I know?", the inner is "is there one?".
    pub fn get(&self, repo: &RepoRef, branch: &str) -> Option<Option<PullRequest>> {
        self.entries.get(&Self::key(repo, branch)).cloned()
    }

    pub fn put(&mut self, repo: &RepoRef, branch: &str, pr: Option<PullRequest>) {
        self.entries.insert(Self::key(repo, branch), pr);
    }

    /// Drops one branch's answer, so the next lookup asks again.
    pub fn invalidate(&mut self, repo: &RepoRef, branch: &str) {
        self.entries.remove(&Self::key(repo, branch));
    }

    /// Drops every branch of one repo. What a merge needs: merging a PR can
    /// change the answer for branches other than its own (a stacked PR's base
    /// moves), and re-asking is cheaper than reasoning about which.
    pub fn invalidate_repo(&mut self, repo: &RepoRef) {
        self.entries.retain(|(owner, name, _), _| owner != &repo.owner || name != &repo.repo);
    }

    /// Records a PR that was just created, keyed by the branch it was opened
    /// from. Without this the create returns a PR the very next lookup would
    /// not know about, and the UI would fall back to "no PR yet" until the next
    /// poll tick.
    pub fn record_created(&mut self, repo: &RepoRef, pr: PullRequest) {
        let branch = pr.head_ref.clone();
        self.put(repo, &branch, Some(pr));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Whether the cache can answer without asking the forge.
///
/// `refresh` is the manual-refresh path: it forces a fetch but still writes the
/// result back, so a user who hits refresh does not permanently opt that branch
/// out of caching.
///
/// Split out from the fetch so the two callers below can read, release the lock,
/// and only then go to the network.
pub fn cached_answer(
    cache: &PrCache,
    repo: &RepoRef,
    branch: &str,
    refresh: bool,
) -> Option<Option<PullRequest>> {
    if refresh {
        return None;
    }
    cache.get(repo, branch)
}

/// Answers "which PR is this branch's?", asking the forge only when it must.
///
/// The single-threaded composition, used by tests and by any caller holding its
/// own cache. [`cached_lookup`] is the same three steps against the global one.
pub fn lookup<F>(
    cache: &mut PrCache,
    repo: &RepoRef,
    branch: &str,
    refresh: bool,
    fetch: F,
) -> Result<Option<PullRequest>, ForgeError>
where
    F: FnOnce() -> Result<Option<PullRequest>, ForgeError>,
{
    if let Some(hit) = cached_answer(cache, repo, branch, refresh) {
        return Ok(hit);
    }
    // `?` before the `put` is the rule that a failure caches nothing.
    let fresh = fetch()?;
    cache.put(repo, branch, fresh.clone());
    Ok(fresh)
}

/// Pushes, then creates, and never the other way round.
///
/// GitHub refuses to open a pull request for a head it cannot see, so a create
/// that runs before its push fails with a 422 the user has to decode. Sequencing
/// it here, rather than in each caller, also means a failed push stops the flow
/// with the push's own error instead of a misleading API one.
///
/// Both halves are passed in so the order is testable without a git remote or a
/// network: the failure that matters is "create ran anyway", and that cannot be
/// observed from the outside once it has happened.
pub fn push_then_create<P, C>(push: P, create: C) -> Result<PullRequest, ForgeError>
where
    P: FnOnce() -> Result<(), String>,
    C: FnOnce() -> Result<PullRequest, ForgeError>,
{
    // A push failure is a git failure, not an API one: a rejected non-fast-
    // forward or a refused credential says nothing about the forge API, so it
    // carries git's own stderr rather than being dressed up as a server error.
    push().map_err(|message| ForgeError::Transport { message })?;
    create()
}

// --- thin global wrapper ---

static CACHE: std::sync::Mutex<Option<PrCache>> = std::sync::Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut PrCache) -> R) -> R {
    let mut guard = CACHE.lock().unwrap();
    f(guard.get_or_insert_with(PrCache::default))
}

/// [`lookup`] against the process-wide cache.
///
/// **The lock is released before the fetch and retaken after it.** Holding it
/// across the request would make one global mutex the gate on every forge call
/// in the app: a single stalled lookup would block every other branch, every
/// other repo, and the create path's write-through, turning one slow request
/// into a frozen sidebar. The cost of letting go is that two simultaneous misses
/// on the same branch can both fetch, which spends one extra request and settles
/// on the same answer.
pub fn cached_lookup<F>(
    repo: &RepoRef,
    branch: &str,
    refresh: bool,
    fetch: F,
) -> Result<Option<PullRequest>, ForgeError>
where
    F: FnOnce() -> Result<Option<PullRequest>, ForgeError>,
{
    if let Some(hit) = with(|c| cached_answer(c, repo, branch, refresh)) {
        return Ok(hit);
    }
    let fresh = fetch()?;
    with(|c| c.put(repo, branch, fresh.clone()));
    Ok(fresh)
}

pub fn record_created(repo: &RepoRef, pr: PullRequest) {
    with(|c| c.record_created(repo, pr));
}

/// Whether the global cache is currently unlocked. Only used to prove that a
/// fetch does not run under the lock.
#[cfg(test)]
fn lock_is_free() -> bool {
    CACHE.try_lock().is_ok()
}

/// What a merge or a close calls. Both change the answer, and neither is
/// something the next poll tick should be trusted to notice first.
pub fn invalidate_repo(repo: &RepoRef) {
    with(|c| c.invalidate_repo(repo));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::model::{MergeableState, PrState};
    use std::cell::Cell;

    fn repo() -> RepoRef {
        RepoRef { owner: "skarif2".into(), repo: "tori".into() }
    }

    fn pr(number: u64, head: &str) -> PullRequest {
        PullRequest {
            number,
            title: "t".into(),
            body: None,
            state: PrState::Open,
            is_draft: false,
            author: "skarif2".into(),
            created_at: "2026-09-17T08:14:00Z".into(),
            merged_at: None,
            closed_at: None,
            comments: 0,
            head_ref: head.into(),
            base_ref: "main".into(),
            head_sha: "abc".into(),
            head_repo_is_origin: true,
            url: "https://github.com/skarif2/tori/pull/1".into(),
            mergeable_state: MergeableState::Unknown,
        }
    }

    #[test]
    fn a_known_absence_is_remembered_as_firmly_as_a_known_pr() {
        // The nested Option's whole reason to exist. "No PR yet" is the normal
        // state of a working branch, so if it were indistinguishable from
        // "never asked" it would cost a request on every single repaint.
        let mut c = PrCache::default();
        assert_eq!(c.get(&repo(), "wave-3"), None, "never asked");

        c.put(&repo(), "wave-3", None);
        assert_eq!(c.get(&repo(), "wave-3"), Some(None), "asked, and there is none");
    }

    #[test]
    fn a_cache_hit_asks_the_forge_nothing() {
        let mut c = PrCache::default();
        c.put(&repo(), "wave-3", Some(pr(12, "wave-3")));
        let asked = Cell::new(false);
        let got = lookup(&mut c, &repo(), "wave-3", false, || {
            asked.set(true);
            Ok(None)
        })
        .unwrap();
        assert_eq!(got.unwrap().number, 12);
        assert!(!asked.get(), "the cached answer was enough");
    }

    #[test]
    fn a_miss_asks_once_and_then_stops_asking() {
        let mut c = PrCache::default();
        let calls = Cell::new(0);
        for _ in 0..2 {
            lookup(&mut c, &repo(), "wave-3", false, || {
                calls.set(calls.get() + 1);
                Ok(Some(pr(12, "wave-3")))
            })
            .unwrap();
        }
        assert_eq!(calls.get(), 1, "the second lookup was served from the cache");
    }

    #[test]
    fn a_failed_lookup_never_caches_an_answer_it_does_not_have() {
        // The bug this prevents is silent and lasts the whole session: cache
        // `Some(None)` on a rate limit and the branch renders "no PR yet"
        // forever, with a create button that would 422 against the PR that is
        // actually there.
        let mut c = PrCache::default();
        let err = lookup(&mut c, &repo(), "wave-3", false, || {
            Err(ForgeError::RateLimited {
                kind: crate::forge::RateLimitKind::Primary,
                retry_after_secs: None,
                reset_at_secs: None,
            })
        })
        .unwrap_err();
        assert!(matches!(err, ForgeError::RateLimited { .. }));
        assert_eq!(c.get(&repo(), "wave-3"), None, "still unknown, not 'no PR'");
    }

    #[test]
    fn a_refresh_re_asks_but_does_not_opt_the_branch_out_of_caching() {
        let mut c = PrCache::default();
        c.put(&repo(), "wave-3", Some(pr(12, "wave-3")));
        let got = lookup(&mut c, &repo(), "wave-3", true, || Ok(Some(pr(13, "wave-3")))).unwrap();
        assert_eq!(got.unwrap().number, 13, "the refresh won over the stale entry");

        // And the fresh answer is now the cached one, so refresh is a one-shot
        // rather than a mode the branch stays stuck in.
        let asked = Cell::new(false);
        let again = lookup(&mut c, &repo(), "wave-3", false, || {
            asked.set(true);
            Ok(None)
        })
        .unwrap();
        assert_eq!(again.unwrap().number, 13);
        assert!(!asked.get());
    }

    #[test]
    fn creating_a_pr_makes_the_next_lookup_find_it_with_no_poll_tick() {
        // Without the write-through, the create succeeds and the UI immediately
        // says "no PR yet" until a poll happens to run.
        let mut c = PrCache::default();
        c.put(&repo(), "wave-3", None);

        c.record_created(&repo(), pr(12, "wave-3"));

        let asked = Cell::new(false);
        let got = lookup(&mut c, &repo(), "wave-3", false, || {
            asked.set(true);
            Ok(None)
        })
        .unwrap();
        assert_eq!(got.unwrap().number, 12);
        assert!(!asked.get(), "no request was needed to see the PR just created");
    }

    #[test]
    fn a_created_pr_is_filed_under_its_own_head_not_the_branch_asked_about() {
        // The head the server echoes back is the authority. Filing it under
        // whatever branch the caller thought it was creating from would put the
        // entry under the wrong key the moment those disagree.
        let mut c = PrCache::default();
        c.record_created(&repo(), pr(12, "feature/x"));
        assert_eq!(c.get(&repo(), "feature/x").unwrap().unwrap().number, 12);
        assert_eq!(c.get(&repo(), "wave-3"), None);
    }

    #[test]
    fn invalidating_one_branch_leaves_its_neighbours_alone() {
        let mut c = PrCache::default();
        c.put(&repo(), "wave-3", Some(pr(12, "wave-3")));
        c.put(&repo(), "wave-4", Some(pr(13, "wave-4")));
        c.invalidate(&repo(), "wave-3");
        assert_eq!(c.get(&repo(), "wave-3"), None);
        assert_eq!(c.get(&repo(), "wave-4").unwrap().unwrap().number, 13);
    }

    #[test]
    fn a_merge_drops_the_whole_repo_but_not_another_ones() {
        // A merge can change the answer for branches other than its own, so the
        // repo goes rather than the branch. Another project's entries must
        // survive: the cache is shared across every open worktree.
        let other = RepoRef { owner: "skarif2".into(), repo: "grimoire".into() };
        let mut c = PrCache::default();
        c.put(&repo(), "wave-3", Some(pr(12, "wave-3")));
        c.put(&repo(), "wave-4", None);
        c.put(&other, "wave-3", Some(pr(99, "wave-3")));

        c.invalidate_repo(&repo());

        assert_eq!(c.len(), 1, "only the other repo's entry is left");
        assert_eq!(c.get(&other, "wave-3").unwrap().unwrap().number, 99);
    }

    #[test]
    fn two_repos_with_the_same_branch_name_never_collide() {
        // A single-window app switching between worktrees does this constantly,
        // and `main` is in every one of them.
        let other = RepoRef { owner: "skarif2".into(), repo: "grimoire".into() };
        let mut c = PrCache::default();
        c.put(&repo(), "main", Some(pr(1, "main")));
        c.put(&other, "main", Some(pr(2, "main")));
        assert_eq!(c.get(&repo(), "main").unwrap().unwrap().number, 1);
        assert_eq!(c.get(&other, "main").unwrap().unwrap().number, 2);
    }

    #[test]
    fn the_cache_sits_in_front_of_the_real_client_not_just_a_closure() {
        // The closure-based tests above prove the caching rule; this one proves
        // it is wired to the thing that actually costs a request. A `head=` query
        // that matches returns the PR, one that does not returns null rather than
        // an error, and the second ask spends nothing.
        use crate::forge::http::test_support::StubTransport;
        use crate::forge::{github::GitHubForge, Forge};

        let found = r#"[{"number":12,"title":"t","state":"open","head":{"ref":"wave-3","sha":"abc"},"base":{"ref":"main"},"user":{"login":"skarif2"},"html_url":"https://github.com/skarif2/tori/pull/12"}]"#;
        let stub = std::sync::Arc::new(StubTransport::new(vec![
            StubTransport::json(200, found),
            StubTransport::json(200, "[]"),
        ]));
        let client = GitHubForge::new(Box::new(stub.clone()), "https://github.com", Some("gho_test".into()), None)
            .with_base("https://api.test");

        let mut c = PrCache::default();

        let hit = lookup(&mut c, &repo(), "wave-3", false, || {
            client.pull_request_for_branch(&repo(), "wave-3")
        })
        .unwrap();
        assert_eq!(hit.unwrap().number, 12);

        let miss = lookup(&mut c, &repo(), "no-pr", false, || {
            client.pull_request_for_branch(&repo(), "no-pr")
        })
        .unwrap();
        assert!(miss.is_none(), "no open PR for the head is null, not an error");

        assert_eq!(stub.request_count(), 2, "one request per distinct branch");
        assert!(
            stub.requests()[0].url.contains("head=skarif2:wave-3"),
            "the query is scoped by head, so two projects sharing a branch name cannot collide"
        );

        // And now both answers are cached, including the absence.
        lookup(&mut c, &repo(), "wave-3", false, || {
            client.pull_request_for_branch(&repo(), "wave-3")
        })
        .unwrap();
        lookup(&mut c, &repo(), "no-pr", false, || {
            client.pull_request_for_branch(&repo(), "no-pr")
        })
        .unwrap();
        assert_eq!(stub.request_count(), 2, "the cache spent nothing on the repeat");
    }

    #[test]
    fn the_global_cache_is_not_locked_while_a_request_is_in_flight() {
        // One global mutex held across the network would make every forge call
        // in the app queue behind the slowest one: a stalled lookup for one repo
        // would freeze the sidebar for all of them, and block the create path
        // from writing its result back. Nothing about that failure is visible
        // from a passing lookup, which is why it is asserted rather than argued.
        let unlocked = Cell::new(false);
        let branch = "lock-probe";
        cached_lookup(&repo(), branch, true, || {
            unlocked.set(lock_is_free());
            Ok(None)
        })
        .unwrap();
        assert!(unlocked.get(), "the fetch ran while holding the cache lock");
    }

    #[test]
    fn a_failed_push_stops_before_the_pr_is_created() {
        // The ordering failure is invisible after the fact: a PR opened against
        // an unpushed head is either refused with a confusing 422 or, worse,
        // opened against a stale head that silently misses the user's commits.
        let order = std::cell::RefCell::new(Vec::new());
        let err = push_then_create(
            || {
                order.borrow_mut().push("push");
                Err("rejected: non-fast-forward".to_string())
            },
            || {
                order.borrow_mut().push("create");
                Ok(pr(12, "wave-3"))
            },
        )
        .unwrap_err();

        assert_eq!(*order.borrow(), vec!["push"], "create never ran");
        match err {
            // git's own words, not an invented API error: "non-fast-forward" is
            // actionable, "server rejected the request" is not.
            ForgeError::Transport { message } => assert!(message.contains("non-fast-forward")),
            other => panic!("a push failure should not look like an API failure: {other:?}"),
        }
    }

    #[test]
    fn a_successful_push_runs_before_the_create() {
        let order = std::cell::RefCell::new(Vec::new());
        let out = push_then_create(
            || {
                order.borrow_mut().push("push");
                Ok(())
            },
            || {
                order.borrow_mut().push("create");
                Ok(pr(12, "wave-3"))
            },
        )
        .unwrap();
        assert_eq!(*order.borrow(), vec!["push", "create"]);
        assert_eq!(out.number, 12);
    }
}
