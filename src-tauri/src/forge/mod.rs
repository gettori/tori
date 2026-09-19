//! The forge layer: pull requests, checks, review threads and merges.
//!
//! This is **layer 2**, the forge's HTTP API. Layer 1 (the git protocol: clone,
//! fetch, push) stays on system `git` plus the askpass bridge and is untouched
//! by anything here; see `adr_git_integration_auth`. The two layers authenticate
//! separately on purpose, because a PR only exists in the API and a push only
//! exists in the protocol.
//!
//! Everything is behind the [`Forge`] trait so a second provider is a second
//! `impl`, not a second UI. The trait speaks **intent**, never transport: a
//! caller asks to resolve a thread, and whether that is a REST call or a
//! GraphQL mutation is the provider's business. On GitHub it happens to be both
//! at once (threads are read over GraphQL because REST has no thread object,
//! while replies post over REST), which is exactly the detail a caller must not
//! have to know.
//!
//! Module layout:
//!   * `model` - the domain types, mirrored into `src/utils/forgeTypes.ts`
//!   * `http`  - the transport seam, redaction, and both pagination walkers
//!   * `github`, `gitlab` - the providers
//!   * `accounts` - accounts per host, and which one a repo acts as
//!   * `cli` - the user's own `gh` login, read for hosts its org approved
//!   * `remote` - a git remote as a host plus a repo

pub mod accounts;
pub mod auth;
pub mod cli;
pub mod commands;
pub mod device_flow;
pub mod github;
pub mod gitlab;
pub mod http;
pub mod model;
pub mod prs;
pub mod refresh;
pub mod remote;
pub mod status;
pub mod token;

use model::{
    AuthState, Capabilities, DraftComment, Grant, OrgAccess, Paged, PrFile, PrSummary,
    PullRequest, RateSnapshot, RepoRef, ReviewComment, ReviewEvent, ReviewThread, UnitStatus,
    Viewer,
};
use serde::{Deserialize, Serialize};

/// Everything that can go wrong, as distinct variants rather than a `String`.
///
/// The variants are the ones a caller *branches on*, which is why "rate limited"
/// and "credential suspect" are separate from a generic API failure: one pauses
/// the poller with a retry deadline, the other pauses it and prompts the user.
/// A stringly-typed error would make both of those a substring match.
///
/// Deliberately carries no request, no headers, and no token. See the `Debug`
/// impl on [`http::HttpRequest`] for the other half of that promise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeError {
    /// The repo has no `origin`, so there is nothing to talk to.
    NoRemote,
    /// The remote is a host this provider does not serve (a GitLab URL reaching
    /// the GitHub provider). Distinct from `NoRemote` because the UI says
    /// something different for each, and neither should offer a create button.
    UnsupportedRemote { host: String },
    /// No token stored. The caller falls back to the compare-URL path.
    NotAuthenticated,
    /// A 401 came back. The token is *suspect*, not deleted; see
    /// [`model::AuthState::Suspect`] for why that distinction matters.
    CredentialSuspect,
    /// Authenticated, but not allowed to do this (scope or repo permission).
    Forbidden { message: String },
    /// Rate limited, with both deadlines the server offered.
    ///
    /// `retry_after_secs` is an explicit instruction and comes with a secondary
    /// limit; `reset_at_secs` is when the primary budget refills, and is the
    /// only number a 403 usually carries. Between them the caller always waits
    /// the server's own interval rather than a constant of our own, which is the
    /// difference between resuming on time and sulking for a quarter of an hour.
    RateLimited {
        kind: RateLimitKind,
        retry_after_secs: Option<u64>,
        /// Unix seconds, as `X-RateLimit-Reset` sends it.
        reset_at_secs: Option<u64>,
    },
    NotFound,
    /// A `404` an organisation is behind: the owner is an organisation, so the
    /// repo may well exist and simply be hidden from a token it has not
    /// approved. Its own variant because a missing repo and a blocked one look
    /// identical on the wire and need opposite answers from the user.
    OrgUnapproved { org: String },
    /// The mutation conflicts with existing state (a PR for this head already
    /// exists, a thread is already resolved).
    AlreadyExists { message: String },
    /// The server refused a merge. Carries the server's own wording, because
    /// GitHub knows about branch protection that Tori cannot see.
    NotMergeable { message: String },
    /// The host has several accounts and this repo has not picked one.
    AccountPickNeeded { host: String },
    /// Something the user typed cannot be used, with the sentence saying why.
    Invalid { message: String },
    /// Any other API-level failure, with the status kept for triage.
    Api { status: u16, message: String },
    /// The request never completed (DNS, TLS, timeout, offline).
    Transport { message: String },
    /// A 2xx whose body was not the shape we expect. Its own variant because it
    /// means *our* mapping is wrong, not the user's setup.
    Malformed { message: String },
}

/// Which of GitHub's two rate limits was hit.
///
/// They behave differently and must be backed off differently: the primary
/// limit is a fixed hourly budget that resets at a known time, while a
/// secondary limit is an anti-abuse throttle that arrives as a 429 with a
/// `Retry-After`. Treating only the 403 as "rate limited", which is the obvious
/// reading, leaves a client that hammers straight through every 429.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitKind {
    Primary,
    Secondary,
}

impl std::fmt::Display for ForgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoRemote => write!(f, "this project has no origin remote"),
            Self::UnsupportedRemote { host } => write!(f, "{host} is not a supported forge"),
            Self::NotAuthenticated => write!(f, "not signed in"),
            Self::CredentialSuspect => write!(f, "the stored token was rejected"),
            Self::Forbidden { message } => write!(f, "{message}"),
            Self::RateLimited { kind, retry_after_secs, .. } => match retry_after_secs {
                Some(s) => write!(f, "{kind:?} rate limit, retry in {s}s"),
                None => write!(f, "{kind:?} rate limit"),
            },
            Self::NotFound => write!(f, "not found"),
            Self::OrgUnapproved { org } => write!(f, "{org} has not approved Tori"),
            Self::AlreadyExists { message } => write!(f, "{message}"),
            Self::NotMergeable { message } => write!(f, "{message}"),
            Self::AccountPickNeeded { host } => write!(f, "pick which {host} account this repo uses"),
            Self::Invalid { message } => write!(f, "{message}"),
            Self::Api { status, message } => write!(f, "{status}: {message}"),
            Self::Transport { message } => write!(f, "{message}"),
            Self::Malformed { message } => write!(f, "unexpected response: {message}"),
        }
    }
}

/// What a new pull request is made of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatePr {
    pub title: String,
    pub body: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
}

/// How to land a PR.
///
/// Serde-carried because it crosses the Tauri bridge: the picker is the user's
/// choice and a repo can forbid any of the three, so the refusal has to come
/// from the server rather than from a default chosen here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

/// A forge provider.
///
/// Every method is intent-shaped. Nothing here names a URL, an HTTP verb, or a
/// query language, so the GitLab impl that eventually lands does not have to
/// pretend to be GitHub-shaped to satisfy it.
pub trait Forge: Send + Sync {
    /// What this provider supports. Callers gate their controls on this rather
    /// than assuming, so an unsupported operation renders inert instead of
    /// shipping a button that fails on click.
    fn capabilities(&self) -> Capabilities;

    fn auth_state(&self) -> AuthState;

    /// What the last answered call said about the rate budget.
    fn rate_snapshot(&self) -> RateSnapshot;

    /// What the host says about the token itself: the scopes it holds and the
    /// deadline it carries, where the provider reports either.
    ///
    /// GitHub answers from headers its calls already carried, so it costs
    /// nothing; GitLab has to ask, which is why this is separate from
    /// [`Forge::viewer`] and the caller decides when to spend it.
    fn token_grant(&self) -> Grant;

    /// The organisation a refusal named since this client was built, where the
    /// provider names one. Read after a call rather than carried in the error,
    /// because a paginated walk can be refused on a page no caller sees.
    fn sso_challenge(&self) -> Option<OrgAccess>;

    /// Whether `owner` is an organisation rather than a person, from the host's
    /// own public record.
    ///
    /// The one question that tells a missing repo from a repo an organisation is
    /// hiding, since both answer `404`. A provider with no organisation-level
    /// block on applications answers `false` without asking anyone.
    fn owner_is_org(&self, owner: &str) -> Result<bool, ForgeError>;

    /// Who the stored token belongs to. Needed before a review can be offered,
    /// because the author of a PR cannot approve or request changes on it.
    fn viewer(&self) -> Result<Viewer, ForgeError>;

    /// The open PR whose head is `branch`, if there is one.
    ///
    /// Derived per query rather than stored: an association persisted anywhere
    /// can go stale, and there is nothing here worth the staleness.
    fn pull_request_for_branch(
        &self,
        repo: &RepoRef,
        branch: &str,
    ) -> Result<Option<PullRequest>, ForgeError>;

    fn list_pull_requests(&self, repo: &RepoRef) -> Result<Paged<PullRequest>, ForgeError>;

    fn create_pull_request(
        &self,
        repo: &RepoRef,
        req: &CreatePr,
    ) -> Result<PullRequest, ForgeError>;

    /// PR state, checks and review decision for **many branches at once**.
    ///
    /// Batched by design. The sidebar wants this for every branch-unit of a
    /// project, and one request per unit per concern is what turns idle polling
    /// into a rate-limit exhaustion: the budget scales with unit count, so the
    /// per-unit cache that looks like the fix solves the wrong axis.
    fn unit_statuses(
        &self,
        repo: &RepoRef,
        branches: &[String],
    ) -> Result<Vec<UnitStatus>, ForgeError>;

    /// Every file a pull request touches, each with the forge's own patch.
    ///
    /// Deliberately not "give me a diff": the provider returns per-file patches
    /// it computed, because that is what a review thread's anchor is measured
    /// against. A caller that recomputed the diff locally would get a document
    /// that reads the same and anchors differently.
    fn pull_request_files(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<Paged<PrFile>, ForgeError>;

    fn review_threads(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<Paged<ReviewThread>, ForgeError>;

    /// Post a reply and hand back **the comment the server stored**.
    ///
    /// Not `()`. A reply is shown the instant it is typed, because waiting on a
    /// round trip to see your own words is the slowest a text box can feel; but
    /// an optimistic comment is a guess about id, author and timestamp, and the
    /// only thing that can correct it is what the server actually wrote.
    fn reply_to_thread(
        &self,
        repo: &RepoRef,
        thread_id: &str,
        body: &str,
    ) -> Result<ReviewComment, ForgeError>;

    /// Resolve or unresolve a thread.
    ///
    /// One method with a boolean rather than two, because they are the same
    /// intent and every provider that has one has the other.
    fn set_thread_resolved(&self, thread_id: &str, resolved: bool) -> Result<(), ForgeError>;

    /// Submit a review: a verdict, a body, and any line comments held with it.
    ///
    /// One call rather than a comment-posting loop plus a verdict. A review is
    /// atomic on the server, and posting the comments separately would leave a
    /// half-submitted review behind whenever the verdict call failed, with no
    /// way for the caller to tell which comments had already landed.
    fn submit_review(
        &self,
        repo: &RepoRef,
        number: u64,
        event: ReviewEvent,
        body: &str,
        comments: &[DraftComment],
    ) -> Result<(), ForgeError>;

    /// Post one line comment on its own, outside any held review.
    ///
    /// Separate from [`Forge::submit_review`] rather than a one-comment call to
    /// it, because of `commit_id`. A submitted review sends none, so the server
    /// re-resolves every anchor against the diff it has at that moment; this one
    /// names the commit the patch on screen came from, so a comment written
    /// while the branch moves underneath lands where it was drawn or is refused,
    /// never silently elsewhere.
    ///
    /// Hosts without it answer [`ForgeError::Unsupported`], and say so through
    /// [`Capabilities::single_comment`] before anyone calls.
    fn add_review_comment(
        &self,
        repo: &RepoRef,
        number: u64,
        commit_id: &str,
        comment: &DraftComment,
    ) -> Result<(), ForgeError>;

    /// Everything about one pull request the list endpoint does not carry: the
    /// server's mergeability verdict, the totals, and who has signed off.
    ///
    /// One call rather than a verdict call and a detail call, because they are
    /// the same GET. The merge verdict has to be asked for (branch protection
    /// and required checks are invisible from here, so a local verdict renders
    /// an enabled button the server refuses), and that same response already
    /// carries every total; only the reviewer counts cost a second read.
    fn pr_summary(&self, repo: &RepoRef, number: u64) -> Result<PrSummary, ForgeError>;

    fn merge(
        &self,
        repo: &RepoRef,
        number: u64,
        method: MergeMethod,
    ) -> Result<(), ForgeError>;

    /// Bring the pull request's head up to date with its base.
    ///
    /// The server's own merge of base into head, not a local one: the branch may
    /// not be checked out anywhere on this machine, and a local merge would then
    /// have to be pushed, which is two failure modes where the forge offers one.
    fn update_branch(&self, repo: &RepoRef, number: u64) -> Result<(), ForgeError>;
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A plain-text UTC timestamp from a forge, as unix seconds.
///
/// `YYYY-MM-DD`, optionally followed by a clock and a `UTC` suffix: GitLab dates
/// a personal access token to the day, GitHub's expiry header adds the time.
/// Both are UTC, so there is no zone to read and no calendar crate to carry for
/// it. Anything else answers `None` rather than a date nobody meant.
pub fn epoch_secs(text: &str) -> Option<u64> {
    let text = text.trim();
    let text = text.strip_suffix("UTC").unwrap_or(text).trim_end();
    let (date, clock) = text.split_once(' ').unwrap_or((text, ""));
    let mut ymd = date.split('-');
    let year: i64 = ymd.next()?.parse().ok()?;
    let month: i64 = ymd.next()?.parse().ok()?;
    let day: i64 = ymd.next()?.parse().ok()?;
    if ymd.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // A date with no clock is midnight, which is how GitLab dates a token.
    let mut hms = clock.split(':');
    let mut unit = || match hms.next() {
        None | Some("") => Some(0),
        Some(field) => field.trim().parse::<i64>().ok(),
    };
    let (hour, minute, second) = (unit()?, unit()?, unit()?);
    let secs = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    u64::try_from(secs).ok()
}

/// Days from 1970-01-01 to a proleptic Gregorian date, by Howard Hinnant's
/// `days_from_civil`. Shifting the year to start in March is what makes the leap
/// day the last of it, so no case analysis is needed for February.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_from_march = (month + 9) % 12;
    let day_of_year = (153 * month_from_march + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use model::{CheckRollup, CheckState, ReviewDecision};

    /// A do-nothing provider, kept for one reason: it is the compile-time proof
    /// that [`Forge`] is implementable without dragging GitHub in. If a future
    /// method leaks a URL, a status code or a GraphQL cursor into the trait,
    /// this stub is what stops compiling.
    struct StubForge;

    impl Forge for StubForge {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                pull_requests: true,
                checks: false,
                review_threads: false,
                resolve_threads: false,
                merge: false,
                approve: false,
                request_changes: false,
                comment_review: false,
                single_comment: false,
            }
        }
        fn auth_state(&self) -> AuthState {
            AuthState::SignedOut
        }
        fn rate_snapshot(&self) -> RateSnapshot {
            RateSnapshot::default()
        }
        fn token_grant(&self) -> Grant {
            Grant::default()
        }
        fn sso_challenge(&self) -> Option<OrgAccess> {
            None
        }
        fn owner_is_org(&self, _owner: &str) -> Result<bool, ForgeError> {
            Ok(false)
        }
        fn viewer(&self) -> Result<Viewer, ForgeError> {
            Err(ForgeError::NotAuthenticated)
        }
        fn pull_request_for_branch(
            &self,
            _repo: &RepoRef,
            _branch: &str,
        ) -> Result<Option<PullRequest>, ForgeError> {
            Ok(None)
        }
        fn list_pull_requests(&self, _repo: &RepoRef) -> Result<Paged<PullRequest>, ForgeError> {
            Ok(Paged::complete(vec![]))
        }
        fn create_pull_request(
            &self,
            _repo: &RepoRef,
            _req: &CreatePr,
        ) -> Result<PullRequest, ForgeError> {
            Err(ForgeError::NotAuthenticated)
        }
        fn unit_statuses(
            &self,
            _repo: &RepoRef,
            branches: &[String],
        ) -> Result<Vec<UnitStatus>, ForgeError> {
            Ok(branches
                .iter()
                .map(|b| UnitStatus {
                    head_ref: b.clone(),
                    pull_request: None,
                    checks: CheckRollup { state: CheckState::None, total: 0, failing: 0 },
                    review_decision: ReviewDecision::None,
                })
                .collect())
        }
        fn pull_request_files(
            &self,
            _repo: &RepoRef,
            _number: u64,
        ) -> Result<Paged<PrFile>, ForgeError> {
            Ok(Paged::complete(vec![]))
        }
        fn review_threads(
            &self,
            _repo: &RepoRef,
            _number: u64,
        ) -> Result<Paged<ReviewThread>, ForgeError> {
            Ok(Paged::complete(vec![]))
        }
        fn reply_to_thread(
            &self,
            _repo: &RepoRef,
            _thread_id: &str,
            _body: &str,
        ) -> Result<ReviewComment, ForgeError> {
            Err(ForgeError::NotAuthenticated)
        }
        fn set_thread_resolved(&self, _thread_id: &str, _resolved: bool) -> Result<(), ForgeError> {
            Err(ForgeError::NotAuthenticated)
        }
        fn submit_review(
            &self,
            _repo: &RepoRef,
            _number: u64,
            _event: ReviewEvent,
            _body: &str,
            _comments: &[DraftComment],
        ) -> Result<(), ForgeError> {
            Err(ForgeError::NotAuthenticated)
        }
        fn add_review_comment(
            &self,
            _repo: &RepoRef,
            _number: u64,
            _commit_id: &str,
            _comment: &DraftComment,
        ) -> Result<(), ForgeError> {
            Err(ForgeError::NotAuthenticated)
        }
        fn pr_summary(&self, _repo: &RepoRef, _number: u64) -> Result<PrSummary, ForgeError> {
            Err(ForgeError::NotAuthenticated)
        }
        fn merge(
            &self,
            _repo: &RepoRef,
            _number: u64,
            _method: MergeMethod,
        ) -> Result<(), ForgeError> {
            Err(ForgeError::NotAuthenticated)
        }
        fn update_branch(&self, _repo: &RepoRef, _number: u64) -> Result<(), ForgeError> {
            Err(ForgeError::NotAuthenticated)
        }
    }

    #[test]
    fn the_trait_is_implementable_without_github() {
        let f: Box<dyn Forge> = Box::new(StubForge);
        assert_eq!(f.auth_state(), AuthState::SignedOut);
        assert!(!f.capabilities().merge);

        // The batched shape is part of the contract, not an optimisation the
        // GitHub impl happens to make: one call, many branches.
        let repo = RepoRef { owner: "skarif2".into(), repo: "tori".into() };
        let statuses = f
            .unit_statuses(&repo, &["wave-3".to_string(), "wave-4".to_string()])
            .expect("stub cannot fail");
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].head_ref, "wave-3");
    }

    #[test]
    fn a_rate_limit_carries_which_limit_it_was() {
        // Primary and secondary limits need different backoff, so a caller must
        // be able to tell them apart without parsing a message.
        let primary = ForgeError::RateLimited {
            kind: RateLimitKind::Primary,
            retry_after_secs: None,
            reset_at_secs: None,
        };
        let secondary =
            ForgeError::RateLimited {
                kind: RateLimitKind::Secondary,
                retry_after_secs: Some(60),
                reset_at_secs: None,
            };
        assert_ne!(primary, secondary);
    }
}
