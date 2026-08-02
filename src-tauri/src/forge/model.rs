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

/// What the last answered call said about the rate budget.
///
/// Captured on every response so the poll scheduler can slow down *before* it
/// gets refused, rather than discovering the limit by hitting it. Every field is
/// optional because a response that carried no rate headers must read as "no
/// news", not as a budget of zero.
///
/// Provider-neutral in shape (a budget, a ceiling, and when it resets) and lives
/// here rather than in `github.rs` because it crosses the bridge with
/// [`StatusReport`] and is mirrored in TypeScript like the rest of this file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateSnapshot {
    pub remaining: Option<u32>,
    pub limit: Option<u32>,
    /// Unix **seconds** at which the primary budget resets, as the header sends
    /// it. Converted at the one point of use rather than at the boundary, so the
    /// field keeps the wire's units.
    pub reset_at: Option<u64>,
}

/// One poll tick's answer: the statuses it covered, what it did not, and what
/// the budget looked like afterwards.
///
/// `uncovered` is the part that must not be silent. A project past the per-tick
/// cap gets a partial answer, and a partial answer that renders as a complete
/// one is the failure nobody notices: units simply never get a chip, with
/// nothing on screen saying so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub statuses: Vec<UnitStatus>,
    pub uncovered: usize,
    /// All-`None` when the tick was served from the cache, which spends nothing
    /// and therefore learns nothing about the budget.
    pub rate: RateSnapshot,
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

/// What happened to one file in a pull request.
///
/// `Changed` is GitHub's own word for a file whose content the API could not
/// classify further; it is kept rather than folded into `Modified` so a status
/// the server invents later does not arrive wearing a word it did not choose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Modified,
    Removed,
    Renamed,
    Copied,
    Changed,
    Unchanged,
}

/// One file of a pull request's diff, with the forge's **own** patch.
///
/// The patch is carried through rather than recomputed locally, and that is the
/// whole point of this type. A review thread anchors to a `diff_hunk` and a
/// position that GitHub calculated; a diff Sway computed itself would differ in
/// context size, in rename detection and in whitespace handling, and every one
/// of those differences lands a comment on the wrong line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    pub path: String,
    /// Where a renamed or copied file came from. `None` for everything else.
    pub previous_path: Option<String>,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
    /// The unified patch, hunks only, with no `diff --git` preamble.
    ///
    /// Absent in three different situations that the UI must not render alike:
    /// a binary file, a mode-only change, and a patch past the size the API
    /// will send. The line counts beside it are what tell them apart, which is
    /// why they are carried even though the patch already contains them.
    pub patch: Option<String>,
}

/// Which side of the diff a comment's line is counted on.
///
/// `Left` is the base file and `Right` the head file, and they are two different
/// numberings of the same region: line 12 on the left is not line 12 on the
/// right once anything above it changed. A comment that names a line without
/// naming its side is a comment on whichever line the server guesses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DiffSide {
    Left,
    Right,
}

/// A line comment held in a review that has not been submitted.
///
/// Anchored with `line`/`side` (plus `start_line`/`start_side` for a range) and
/// **never** with `position`. `position` counts lines from the top of a patch,
/// so it silently means something different the moment the pull request gets a
/// new commit; GitHub deprecated it for exactly that. The line-and-side form is
/// re-resolved by the server against the diff it currently has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftComment {
    pub path: String,
    /// The last line of the range, in `side`'s numbering.
    pub line: u32,
    pub side: DiffSide,
    /// The first line of a multi-line range. `None` for a single line.
    pub start_line: Option<u32>,
    pub start_side: Option<DiffSide>,
    pub body: String,
}

/// The verdict a submitted review carries.
///
/// `Approve` and `RequestChanges` are rejected with a 422 on a pull request the
/// viewer authored, which on a single-owner repo is every pull request Sway
/// opens. They are built and gated rather than omitted, because the gate is
/// about *this* pull request, not about the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewEvent {
    Approve,
    Comment,
    RequestChanges,
}

impl ReviewEvent {
    /// The wire word. GitHub spells these in screaming snake case, and it is the
    /// only place that spelling belongs.
    pub fn wire(self) -> &'static str {
        match self {
            Self::Approve => "APPROVE",
            Self::Comment => "COMMENT",
            Self::RequestChanges => "REQUEST_CHANGES",
        }
    }
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

        let unit = UnitStatus {
            head_ref: "wave-3".into(),
            pull_request: Some(pr.clone()),
            checks: CheckRollup { state: CheckState::Failure, total: 12, failing: 2 },
            review_decision: ReviewDecision::ChangesRequested,
        };

        let samples = serde_json::json!({
            "repoRef": RepoRef { owner: "skarif2".into(), repo: "sway".into() },
            "pullRequest": pr.clone(),
            "checkRollup": CheckRollup { state: CheckState::Failure, total: 12, failing: 2 },
            "reviewDecision": ReviewDecision::ChangesRequested,
            "unitStatus": unit.clone(),
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
            // A renamed file whose patch the API did send, because the two
            // fields the UI branches on (`previousPath` and `patch`) are both
            // populated only in that case.
            "prFile": PrFile {
                path: "src/utils/forgeChip.ts".into(),
                previous_path: Some("src/panels/LeftSidebar/chip.ts".into()),
                status: FileStatus::Renamed,
                additions: 12,
                deletions: 3,
                patch: Some("@@ -1,3 +1,4 @@\n fn main() {\n+    let x = 1;".into()),
            },
            // A multi-line right-side range, because that is the shape carrying
            // every field: a single-line comment sends the start pair as null.
            "draftComment": DraftComment {
                path: "src/utils/reviewThreads.ts".into(),
                line: 48,
                side: DiffSide::Right,
                start_line: Some(45),
                start_side: Some(DiffSide::Right),
                body: "This anchors on the wrong side.".into(),
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
            "rateSnapshot": RateSnapshot {
                remaining: Some(4_812),
                limit: Some(5_000),
                reset_at: Some(1_785_179_400),
            },
            // A capped tick: fewer statuses than the caller asked about, with
            // the remainder counted rather than dropped.
            "statusReport": StatusReport {
                statuses: vec![unit],
                uncovered: 4,
                rate: RateSnapshot {
                    remaining: Some(4_812),
                    limit: Some(5_000),
                    reset_at: Some(1_785_179_400),
                },
            },
            // Not a domain type, but it crosses the same bridge and the poll
            // scheduler branches on it, so it is mirrored the same way. A rate
            // limit is the sample because it is the variant carrying the extra
            // fields; the others send them as null.
            "forgeError": super::super::commands::ForgeErrorDto::from(
                super::super::ForgeError::RateLimited {
                    kind: super::super::RateLimitKind::Secondary,
                    retry_after_secs: Some(60),
                    reset_at_secs: Some(1_785_179_400),
                },
            ),
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
