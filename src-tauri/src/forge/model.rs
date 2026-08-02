//! The forge domain model: what a pull request, a check rollup, a review
//! thread and a merge verdict *are*, with no GitHub in any name.
//!
//! Everything here is the shape the UI consumes. The GitHub-specific wire
//! shapes stay inside `github.rs` and are mapped into these on the way out, so
//! adding GitLab means writing a second mapper, not a second UI.
//!
//! Field names serialize `camelCase` and are mirrored in
//! `src/utils/forgeTypes.ts`. That mirror is checked rather than trusted: the
//! round-trip test at the bottom of this file writes one sample per type into
//! `dev/fixtures/forge/`, and `forgeTypes.test.ts` parses that exact file. A
//! rename on either side fails there instead of surviving as two internally
//! consistent halves that disagree on the wire (same mechanism as
//! `chat/model.rs`, and for the same reason).

use serde::{Deserialize, Serialize};

/// A repository, as the two coordinates every forge API needs. Parsed from the
/// git remote by `github::parse_remote`, never stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub owner: String,
    pub repo: String,
}

/// Whether a PR is open, closed unmerged, or merged.
///
/// `Merged` is deliberately its own state rather than `Closed` plus a flag: the
/// sidebar chip and the merge guard both branch on it, and a boolean beside a
/// state is the shape that lets the two disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

/// GitHub's own mergeability verdict, carried through rather than recomputed.
///
/// Sway cannot see branch protection rules, required status checks it does not
/// model, or org policy, so a client-side "looks mergeable to me" is a guess
/// that renders an enabled button the server will refuse. This enum is the
/// server's answer; `Unknown` covers the window where GitHub is still computing
/// it (`mergeable: null`) and means "ask again", not "no".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeableState {
    Clean,
    Blocked,
    Behind,
    Dirty,
    Unstable,
    Draft,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub state: PrState,
    pub is_draft: bool,
    /// The login of whoever opened it. Compared against `Viewer::login` to
    /// decide whether approve and request-changes are even offerable, because
    /// GitHub rejects both from the PR author with a 422.
    pub author: String,
    pub head_ref: String,
    pub base_ref: String,
    /// The head commit, used to fetch the PR ref for local gap expansion.
    pub head_sha: String,
    pub url: String,
    pub mergeable_state: MergeableState,
}

/// The rollup of every check run on a PR's head.
///
/// `None` is "this head has no checks configured", which is not the same as
/// `Pending` ("checks exist and have not finished"). Collapsing them would make
/// a repo with no CI look permanently in-flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Success,
    Failure,
    Pending,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRollup {
    pub state: CheckState,
    pub total: u32,
    pub failing: u32,
}

/// The aggregate review verdict on a PR.
///
/// `None` means nobody has reviewed. On a single-owner repo that is the
/// permanent state, since the author cannot review their own PR, which is why
/// the merge guard reads `MergeableState` instead of this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
    None,
}

/// One branch-unit's whole forge story, as the sidebar chip needs it.
///
/// Fetched for every unit of a project in one batched query, because the rate
/// budget scales with unit count: per-unit requests times three concerns is
/// what exhausts 5,000/hour on idle polling alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitStatus {
    pub head_ref: String,
    /// `None` means no PR exists for this branch, which the UI must render
    /// differently from "this remote is not a forge Sway can talk to".
    pub pull_request: Option<PullRequest>,
    pub checks: CheckRollup,
    pub review_decision: ReviewDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    /// The GraphQL node id. Kept as an opaque string because it is only ever
    /// handed back to the API, never parsed.
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
}

/// A review conversation anchored to a diff line.
///
/// `id` is a `PullRequestReviewThread` node id, which is the reason threads are
/// read over GraphQL: REST has no thread object at all, only comments with an
/// `in_reply_to_id`, and `resolveReviewThread` will not take a comment's id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    /// The line in the head file, absent once the thread goes outdated. An
    /// absent line is what routes a thread into the outdated group rather than
    /// onto a line number that no longer means what it did.
    pub line: Option<u32>,
    pub diff_hunk: String,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub comments: Vec<ReviewComment>,
}

/// Who the stored token belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewer {
    pub login: String,
    pub avatar_url: Option<String>,
}

/// A collection that may not be complete.
///
/// Every list endpoint here paginates, and a first-page read that renders as a
/// full list is worse than an error: a 40-file PR showing 30 files looks like a
/// working feature. `truncated` forces the caller to decide what to say rather
/// than letting a silent cap pass for completeness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paged<T> {
    pub items: Vec<T>,
    pub truncated: bool,
}

impl<T> Paged<T> {
    pub fn complete(items: Vec<T>) -> Self {
        Self { items, truncated: false }
    }
}

/// What a given forge provider can actually do.
///
/// Declared rather than assumed so a provider that cannot resolve threads (or
/// cannot merge) makes its control render inert instead of shipping a button
/// that fails on click.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub pull_requests: bool,
    pub checks: bool,
    pub review_threads: bool,
    pub resolve_threads: bool,
    pub merge: bool,
}

/// The three states the credential can be in.
///
/// `Suspect` exists because a 401 must not destroy the token. Clearing the
/// keychain on one bad response (a proxy, a captive portal, a forge incident)
/// costs the user a full device-flow re-auth to recover from something that may
/// have been transient. Suspect pauses polling and prompts; only the user's
/// sign-out or re-sign-in actually clears the entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AuthState {
    SignedOut,
    SignedIn { login: String },
    Suspect { login: Option<String> },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes one sample per type into `dev/fixtures/forge/`, which
    /// `src/utils/forgeTypes.test.ts` then parses.
    ///
    /// Hand-writing those samples on the TypeScript side would prove the mirror
    /// is self-consistent, not that it matches Rust. Serializing through the
    /// same serde impls the real client uses is what makes a rename fail there
    /// instead of surviving as two halves that each look fine.
    #[test]
    fn emit_wire_samples_for_the_typescript_mirror() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev/fixtures/forge");
        std::fs::create_dir_all(&dir).expect("create fixture dir");

        let pr = PullRequest {
            number: 42,
            title: "Let a conflict be handed to the agent".into(),
            body: Some("Replaces the compare-URL flow.".into()),
            state: PrState::Open,
            is_draft: false,
            author: "skarif2".into(),
            head_ref: "wave-3".into(),
            base_ref: "main".into(),
            head_sha: "4d95fc3aa0f1b2c3d4e5f60718293a4b5c6d7e8f".into(),
            url: "https://github.com/skarif2/sway/pull/42".into(),
            mergeable_state: MergeableState::Clean,
        };

        let samples = serde_json::json!({
            "repoRef": RepoRef { owner: "skarif2".into(), repo: "sway".into() },
            "pullRequest": pr.clone(),
            "checkRollup": CheckRollup { state: CheckState::Failure, total: 12, failing: 2 },
            "reviewDecision": ReviewDecision::ChangesRequested,
            "unitStatus": UnitStatus {
                head_ref: "wave-3".into(),
                pull_request: Some(pr),
                checks: CheckRollup { state: CheckState::Failure, total: 12, failing: 2 },
                review_decision: ReviewDecision::ChangesRequested,
            },
            "reviewThread": ReviewThread {
                id: "PRRT_kwDOABCD123".into(),
                path: "src-tauri/src/forge/github.rs".into(),
                line: Some(88),
                diff_hunk: "@@ -1,3 +1,4 @@\n fn main() {\n+    let x = 1;".into(),
                is_resolved: false,
                is_outdated: false,
                comments: vec![ReviewComment {
                    id: "PRRC_kwDOABCD456".into(),
                    author: "skarif2".into(),
                    body: "This drops the error.".into(),
                    created_at: "2026-08-02T12:00:00Z".into(),
                }],
            },
            "viewer": Viewer {
                login: "skarif2".into(),
                avatar_url: Some("https://avatars.githubusercontent.com/u/1".into()),
            },
            "capabilities": Capabilities {
                pull_requests: true,
                checks: true,
                review_threads: true,
                resolve_threads: true,
                merge: true,
            },
            // All three auth states, because the Settings section renders a
            // distinct surface for each and a mirror that only saw one would
            // let the other two drift.
            "authStates": [
                AuthState::SignedOut,
                AuthState::SignedIn { login: "skarif2".into() },
                AuthState::Suspect { login: Some("skarif2".into()) },
            ],
            // A truncated page, because `truncated: true` is the case the UI
            // must not render as a complete list.
            "pagedTruncated": Paged { items: vec![1u32, 2, 3], truncated: true },
        });

        let text = serde_json::to_string_pretty(&samples).expect("serialize samples");
        std::fs::write(dir.join("model.json"), format!("{text}\n")).expect("write fixture");
    }

    #[test]
    fn merged_is_a_state_of_its_own_not_closed_plus_a_flag() {
        // Guards the shape decision documented on `PrState`: if `Merged` were
        // ever folded into `Closed`, the sidebar chip and the merge guard would
        // have to agree on a separate boolean, which is exactly the pair that
        // can disagree.
        assert_ne!(PrState::Merged, PrState::Closed);
        let json = serde_json::to_string(&PrState::Merged).unwrap();
        assert_eq!(json, "\"merged\"");
    }

    #[test]
    fn no_checks_is_distinct_from_checks_pending() {
        // A repo with no CI must not render as permanently in flight.
        assert_ne!(CheckState::None, CheckState::Pending);
    }
}
