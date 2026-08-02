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
//!   * `github` - the one provider that exists today

pub mod auth;
pub mod commands;
pub mod device_flow;
pub mod github;
pub mod http;
pub mod model;
pub mod prs;
pub mod status;
pub mod token;

use model::{
    AuthState, Capabilities, DraftComment, MergeableState, Paged, PrFile, PullRequest, RepoRef,
    ReviewComment, ReviewEvent, ReviewThread, UnitStatus, Viewer,
};

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
    /// The mutation conflicts with existing state (a PR for this head already
    /// exists, a thread is already resolved).
    AlreadyExists { message: String },
    /// The server refused a merge. Carries the server's own wording, because
    /// GitHub knows about branch protection that Sway cannot see.
    NotMergeable { message: String },
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
            Self::AlreadyExists { message } => write!(f, "{message}"),
            Self::NotMergeable { message } => write!(f, "{message}"),
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

    /// The server's mergeability verdict, not ours.
    fn mergeability(&self, repo: &RepoRef, number: u64) -> Result<MergeableState, ForgeError>;

    fn merge(
        &self,
        repo: &RepoRef,
        number: u64,
        method: MergeMethod,
    ) -> Result<(), ForgeError>;
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
            }
        }
        fn auth_state(&self) -> AuthState {
            AuthState::SignedOut
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
        fn mergeability(
            &self,
            _repo: &RepoRef,
            _number: u64,
        ) -> Result<MergeableState, ForgeError> {
            Ok(MergeableState::Unknown)
        }
        fn merge(
            &self,
            _repo: &RepoRef,
            _number: u64,
            _method: MergeMethod,
        ) -> Result<(), ForgeError> {
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
        let repo = RepoRef { owner: "skarif2".into(), repo: "sway".into() };
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
