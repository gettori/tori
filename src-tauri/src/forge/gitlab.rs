//! The GitLab provider.
//!
//! REST v4 only, under `{base}/api/v4`. GitLab has a GraphQL API too, but every
//! read this trait needs exists in REST, and the one GitHub uses GraphQL for
//! (thread node ids) does not apply here: a discussion id is already addressable
//! over REST.
//!
//! ## Three places GitLab is not GitHub
//!
//!   * **No atomic review.** GitHub takes a verdict, a body and every line
//!     comment in one call. GitLab has approve, notes and discussions as
//!     separate endpoints, so [`Forge::submit_review`] posts the comments and
//!     then the verdict, and says so when only half of it lands.
//!   * **No request-changes.** There is approve and there is commenting, and
//!     nothing that carries "changes requested", which is why
//!     [`Capabilities::request_changes`] is false and the control renders inert
//!     rather than failing on click.
//!   * **A thread is addressed by three things**, not one. Resolving a
//!     discussion needs the project, the merge request and the discussion id,
//!     while the trait hands back a single opaque thread id, so this module
//!     packs all three into that id and unpacks them on the way back. The id is
//!     documented as opaque and never parsed above this file.

use super::http::{classify, paginate_rest, HttpRequest, Recording, Transport, PAGE_CAP};
use super::model::{
    AuthState, Capabilities, CheckRollup, CheckState, DiffSide, DraftComment, FileStatus, Grant,
    MergeableState, OrgAccess, Paged, PrFile, PrState, PrSummary, PullRequest, RateSnapshot,
    RepoRef, ReviewComment, ReviewDecision, ReviewEvent, ReviewThread, UnitStatus, Viewer,
};
use super::{epoch_secs, CreatePr, Forge, ForgeError, MergeMethod};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const USER_AGENT: &str = "tori";

/// How many merge requests one status tick will ask the approval endpoint
/// about.
///
/// The list call answers for the whole project in one request, but approvals
/// are a separate endpoint per merge request, so a project with fifty open ones
/// would spend fifty requests a tick. Past the cap the verdict reads `None`,
/// which is also what an unapproved merge request reads as.
const APPROVAL_LOOKUPS: usize = 10;

pub struct GitLabForge {
    transport: std::sync::Arc<Recording>,
    token: Option<String>,
    api_base: String,
    login: Option<String>,
}

impl GitLabForge {
    /// `base_url` is the instance's web URL, as the account records it.
    pub fn new(
        transport: Box<dyn Transport>,
        base_url: &str,
        token: Option<String>,
        login: Option<String>,
    ) -> Self {
        Self {
            transport: std::sync::Arc::new(Recording::new(transport)),
            token,
            api_base: format!("{}/api/v4", base_url.trim_end_matches('/')),
            login,
        }
    }

    /// Points the client at a different origin. Tests use it; nothing else does.
    #[cfg(test)]
    pub fn with_base(mut self, base: &str) -> Self {
        self.api_base = base.to_string();
        self
    }

    fn headers(&self) -> Vec<(String, String)> {
        let mut h = vec![
            ("Accept".to_string(), "application/json".to_string()),
            ("User-Agent".to_string(), USER_AGENT.to_string()),
        ];
        if let Some(t) = &self.token {
            h.push(("Authorization".to_string(), format!("Bearer {t}")));
        }
        h
    }

    fn require_token(&self) -> Result<(), ForgeError> {
        if self.token.is_none() {
            return Err(ForgeError::NotAuthenticated);
        }
        Ok(())
    }

    fn rest(&self, method: &'static str, path: &str, body: Option<Value>) -> HttpRequest {
        HttpRequest {
            method,
            url: format!("{}{path}", self.api_base),
            headers: self.headers(),
            body: body.map(|b| b.to_string()),
        }
    }

    fn send(&self, req: HttpRequest) -> Result<Value, ForgeError> {
        let resp = self.transport.send(req)?;
        if let Some(err) = classify(&resp) {
            return Err(err);
        }
        if resp.body.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&resp.body)
            .map_err(|e| ForgeError::Malformed { message: e.to_string() })
    }

    fn merge_request(&self, repo: &RepoRef, iid: u64) -> Result<Value, ForgeError> {
        self.send(self.rest("GET", &format!("/projects/{}/merge_requests/{iid}", project(repo)), None))
    }

    /// Each changed file's patch, as the line pairs a position is built from.
    fn diff_lines(
        &self,
        repo: &RepoRef,
        iid: u64,
    ) -> Result<BTreeMap<String, Vec<(u32, u32)>>, ForgeError> {
        let path =
            format!("/projects/{}/merge_requests/{iid}/diffs?per_page=100", project(repo));
        let (items, _) =
            paginate_rest(self.transport.as_ref(), self.rest("GET", &path, None), PAGE_CAP)?;
        Ok(items
            .iter()
            .filter_map(|f| {
                let path = opt_str(f, "new_path").filter(|p| !p.is_empty())?;
                let diff = f.get("diff").and_then(|d| d.as_str()).unwrap_or_default();
                Some((path, line_pairs(diff)))
            })
            .collect())
    }
}

/// `owner/repo` as one URL-encoded path segment, which is how every GitLab
/// endpoint names a project. Re-joining the two halves is what makes a subgroup
/// (`group/sub/project`) address correctly, since the slashes are part of the
/// name rather than of the URL.
fn project(repo: &RepoRef) -> String {
    encode(&format!("{}/{}", repo.owner, repo.repo))
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// The three coordinates a discussion needs, packed into the one opaque id the
/// trait carries. `#` cannot appear in a project path, an iid or a discussion
/// id, so it separates them unambiguously.
fn thread_id(repo: &RepoRef, iid: u64, discussion: &str) -> String {
    format!("{}/{}#{iid}#{discussion}", repo.owner, repo.repo)
}

fn unpack_thread(id: &str) -> Result<(String, u64, String), ForgeError> {
    let bad = || ForgeError::Malformed { message: "unreadable thread id".into() };
    let mut parts = id.splitn(3, '#');
    let path = parts.next().ok_or_else(bad)?;
    let iid: u64 = parts.next().ok_or_else(bad)?.parse().map_err(|_| bad())?;
    let discussion = parts.next().ok_or_else(bad)?;
    Ok((encode(path), iid, discussion.to_string()))
}

/// GitLab names a diff line `sha1(path)_oldline_newline`, and each end of a
/// multi-line comment needs one. Both numbers, because a position is a point in
/// two numberings rather than a line in one.
fn line_code(path: &str, old: u32, new: u32) -> String {
    let digest = Sha1::digest(path.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex}_{old}_{new}")
}

/// Every line of one file's patch as the pair of numbers GitLab counts it by.
///
/// A diff line carries only its own side's number; the other side is whatever
/// it stood at there. Walking the hunks is the only way to recover the pair,
/// and a draft comment knows one number and a side.
fn line_pairs(diff: &str) -> Vec<(u32, u32)> {
    let mut pairs = Vec::new();
    let (mut old, mut new) = (0u32, 0u32);
    for line in diff.lines() {
        if let Some(header) = line.strip_prefix("@@") {
            let mut halves = header.split(['-', '+']).skip(1);
            // One before the hunk's first line, since every branch below counts
            // its line before recording it.
            old = halves.next().and_then(hunk_start).map_or(old, |n| n.saturating_sub(1));
            new = halves.next().and_then(hunk_start).map_or(new, |n| n.saturating_sub(1));
            continue;
        }
        match line.chars().next() {
            Some('+') => {
                new += 1;
                pairs.push((old, new));
            }
            Some('-') => {
                old += 1;
                pairs.push((old, new));
            }
            Some(' ') => {
                old += 1;
                new += 1;
                pairs.push((old, new));
            }
            _ => {}
        }
    }
    pairs
}

fn hunk_start(part: &str) -> Option<u32> {
    part.trim().split(',').next()?.trim().parse().ok()
}

fn pair_for(pairs: &[(u32, u32)], line: u32, head: bool) -> Option<(u32, u32)> {
    pairs.iter().copied().find(|(old, new)| if head { *new == line } else { *old == line })
}

fn side_word(head: bool) -> &'static str {
    if head {
        "new"
    } else {
        "old"
    }
}

fn str_at(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// GitLab's merge verdict, carried through rather than recomputed.
///
/// `detailed_merge_status` is the newer field and says *why* a merge request
/// cannot merge; `merge_status` is the older one and only says whether it can.
/// Anything unrecognised reads `Unknown`, never as a green light.
fn mergeable_from(v: &Value) -> MergeableState {
    let detailed = v.get("detailed_merge_status").and_then(|m| m.as_str());
    match detailed {
        Some("mergeable") => return MergeableState::Clean,
        Some("draft_status") => return MergeableState::Draft,
        Some("broken_status") | Some("conflict") => return MergeableState::Dirty,
        Some("need_rebase") => return MergeableState::Behind,
        Some("ci_still_running") | Some("ci_must_pass") => return MergeableState::Unstable,
        Some("not_approved") | Some("blocked_status") | Some("policies_denied")
        | Some("discussions_not_resolved") => return MergeableState::Blocked,
        Some("checking") | Some("unchecked") | Some("preparing") => return MergeableState::Unknown,
        _ => {}
    }
    match v.get("merge_status").and_then(|m| m.as_str()) {
        Some("can_be_merged") => MergeableState::Clean,
        Some("cannot_be_merged") => MergeableState::Dirty,
        _ => MergeableState::Unknown,
    }
}

fn pr_from(v: &Value) -> Result<PullRequest, ForgeError> {
    let number = v
        .get("iid")
        .and_then(|n| n.as_u64())
        .ok_or_else(|| ForgeError::Malformed { message: "merge request has no iid".into() })?;
    let state = match v.get("state").and_then(|s| s.as_str()) {
        Some("merged") => PrState::Merged,
        Some("opened") | Some("reopened") => PrState::Open,
        _ => PrState::Closed,
    };
    Ok(PullRequest {
        number,
        title: str_at(v, "title"),
        // GitLab calls it a description, and an empty one comes back as an
        // empty string rather than as null.
        body: opt_str(v, "description").filter(|d| !d.is_empty()),
        state,
        is_draft: v.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
        author: v.get("author").map(|a| str_at(a, "username")).unwrap_or_default(),
        created_at: str_at(v, "created_at"),
        merged_at: opt_str(v, "merged_at"),
        closed_at: opt_str(v, "closed_at"),
        comments: v.get("user_notes_count").and_then(|c| c.as_u64()).unwrap_or(0) as u32,
        head_ref: str_at(v, "source_branch"),
        base_ref: str_at(v, "target_branch"),
        head_sha: str_at(v, "sha"),
        head_repo_is_origin: v.get("source_project_id") == v.get("target_project_id"),
        url: str_at(v, "web_url"),
        mergeable_state: mergeable_from(v),
    })
}

/// One pipeline, read as the whole check rollup.
///
/// GitLab reports a pipeline's status, not per-job counts, and asking for the
/// jobs would be a request per merge request per tick. So a failing pipeline
/// counts as one failing check, which is the granularity the answer actually
/// has.
fn checks_from_pipeline(pipeline: Option<&Value>) -> CheckRollup {
    let state = match pipeline.map(|p| str_at(p, "status")).as_deref() {
        Some("success") => CheckState::Success,
        Some("failed") | Some("canceled") => CheckState::Failure,
        Some("running") | Some("pending") | Some("created") | Some("preparing")
        | Some("waiting_for_resource") | Some("scheduled") => CheckState::Pending,
        _ => CheckState::None,
    };
    // No per-job list for the same reason there are no per-job counts: naming
    // the one pipeline as a context would be a list of one saying what the
    // rollup already says.
    match state {
        CheckState::None => CheckRollup::none(),
        CheckState::Failure => CheckRollup { state, total: 1, failing: 1, contexts: Vec::new() },
        _ => CheckRollup { state, total: 1, failing: 0, contexts: Vec::new() },
    }
}

/// The verdict the merge request list already answers, when it does.
///
/// `detailed_merge_status` reads `not_approved` whenever approvals are required
/// and missing, so the waiting case costs nothing. Anything else needs the
/// approval endpoint, which is a request per merge request.
fn verdict_from_list(mr: &Value) -> Option<ReviewDecision> {
    match mr.get("detailed_merge_status").and_then(|s| s.as_str()) {
        Some("not_approved") => Some(ReviewDecision::ReviewRequired),
        _ => None,
    }
}

/// The approval endpoint's answer as a review verdict.
///
/// GitLab has no "changes requested", so the only two outcomes are approved and
/// waiting. `approvals_left` is what tells a merge request that needs approval
/// from one that asks for none.
fn decision_from_approvals(v: &Value) -> ReviewDecision {
    if v.get("approved").and_then(|a| a.as_bool()).unwrap_or(false) {
        return ReviewDecision::Approved;
    }
    let left = v.get("approvals_left").and_then(|a| a.as_u64()).unwrap_or(0);
    let approved_by = v.get("approved_by").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0);
    if approved_by > 0 {
        return ReviewDecision::Approved;
    }
    if left > 0 {
        ReviewDecision::ReviewRequired
    } else {
        ReviewDecision::None
    }
}

fn file_from(v: &Value) -> PrFile {
    let new_path = str_at(v, "new_path");
    let old_path = str_at(v, "old_path");
    let status = if v.get("new_file").and_then(|b| b.as_bool()).unwrap_or(false) {
        FileStatus::Added
    } else if v.get("deleted_file").and_then(|b| b.as_bool()).unwrap_or(false) {
        FileStatus::Removed
    } else if v.get("renamed_file").and_then(|b| b.as_bool()).unwrap_or(false) {
        FileStatus::Renamed
    } else {
        FileStatus::Modified
    };
    // GitLab sends no line counts with a diff, and the three absent-patch cases
    // (binary, mode-only, too large) are told apart by them, so they are counted
    // from the patch rather than left at zero.
    let diff = opt_str(v, "diff").filter(|d| !d.is_empty());
    let count = |prefix: char| {
        diff.as_deref()
            .map(|d| {
                d.lines()
                    .filter(|l| l.starts_with(prefix) && !l.starts_with("+++") && !l.starts_with("---"))
                    .count() as u32
            })
            .unwrap_or(0)
    };
    PrFile {
        path: if new_path.is_empty() { old_path.clone() } else { new_path },
        previous_path: (status == FileStatus::Renamed).then_some(old_path),
        status,
        additions: count('+'),
        deletions: count('-'),
        patch: diff,
    }
}

fn comment_from(note: &Value) -> ReviewComment {
    ReviewComment {
        id: note.get("id").map(|i| i.to_string()).unwrap_or_default(),
        author: note.get("author").map(|a| str_at(a, "username")).unwrap_or_default(),
        body: str_at(note, "body"),
        created_at: str_at(note, "created_at"),
    }
}

/// One discussion, as a review thread.
///
/// Only discussions anchored to a diff position are review threads; the rest
/// are the merge request's own conversation, which this surface does not show.
fn thread_from(repo: &RepoRef, iid: u64, discussion: &Value) -> Option<ReviewThread> {
    let notes = discussion.get("notes").and_then(|n| n.as_array())?;
    let first = notes.first()?;
    let position = first.get("position")?;
    let path = match opt_str(position, "new_path") {
        Some(p) if !p.is_empty() => p,
        _ => str_at(position, "old_path"),
    };
    let line = position.get("new_line").and_then(|l| l.as_u64()).map(|l| l as u32);
    Some(ReviewThread {
        id: thread_id(repo, iid, &str_at(discussion, "id")),
        path,
        line,
        // GitLab anchors a multi-line comment with a `line_range`, whose start
        // carries the first line of the range.
        start_line: position
            .get("line_range")
            .and_then(|r| r.get("start"))
            .and_then(|s| s.get("new_line"))
            .and_then(|l| l.as_u64())
            .map(|l| l as u32),
        diff_hunk: String::new(),
        is_resolved: first.get("resolved").and_then(|r| r.as_bool()).unwrap_or(false),
        // A position whose head-side line is gone is a comment on a line the
        // head no longer has, which is what "outdated" means on both forges.
        is_outdated: line.is_none(),
        comments: notes.iter().map(comment_from).collect(),
    })
}

/// The last history page per project, and which branches it was read for.
struct History {
    read_at: Instant,
    unmatched: BTreeSet<String>,
    list: Vec<Value>,
}

static HISTORY: Mutex<BTreeMap<String, History>> = Mutex::new(BTreeMap::new());
const HISTORY_FOR: Duration = Duration::from_secs(300);

impl GitLabForge {
    /// One page of recent merge requests for the branches with no open one. Reread
    /// only when a branch newly lost its open one or the page went stale, since the
    /// base branch never has one. Best effort: a failure must not blank the open half.
    fn history(&self, repo: &RepoRef, unmatched: BTreeSet<String>) -> Vec<Value> {
        let key = format!("{}/projects/{}", self.api_base, project(repo));
        {
            let cache = HISTORY.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(h) = cache.get(&key) {
                if h.read_at.elapsed() < HISTORY_FOR && unmatched.is_subset(&h.unmatched) {
                    return h.list.clone();
                }
            }
        }
        let path = format!("/projects/{}/merge_requests?state=all&order_by=updated_at&per_page=100", project(repo));
        let Ok(Value::Array(list)) = self.send(self.rest("GET", &path, None)) else {
            return vec![];
        };
        let mut cache = HISTORY.lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(key, History { read_at: Instant::now(), unmatched, list: list.clone() });
        list
    }
}

impl Forge for GitLabForge {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            pull_requests: true,
            checks: true,
            review_threads: true,
            resolve_threads: true,
            merge: true,
            approve: true,
            request_changes: false,
            comment_review: true,
            single_comment: false,
        }
    }

    fn rate_snapshot(&self) -> RateSnapshot {
        self.transport.rate()
    }

    /// From the token's own record, which is the only place GitLab says either.
    ///
    /// Only a personal access token can read it, and only a personal access
    /// token needs to: a token the browser flow minted came with its lifetime
    /// in the exchange. A refusal answers "nothing known" rather than failing a
    /// sign-in the viewer call has already carried.
    fn token_grant(&self) -> Grant {
        let Ok(v) = self.send(self.rest("GET", "/personal_access_tokens/self", None)) else {
            return Grant::default();
        };
        Grant {
            scopes: v.get("scopes").and_then(|s| s.as_array()).map(|list| {
                list.iter().filter_map(|s| s.as_str()).map(str::to_string).collect()
            }),
            expires_at: opt_str(&v, "expires_at").as_deref().and_then(epoch_secs),
        }
    }

    /// Nothing to answer. GitLab enforces SAML at the group level and says so by
    /// refusing the whole instance, never by naming a group in a header.
    fn sso_challenge(&self) -> Option<OrgAccess> {
        None
    }

    /// Always `false`, and asked for nothing. A GitLab group cannot block an
    /// application the way a GitHub organisation can, so a `404` here is a repo
    /// that is genuinely not there and a request to check would be spent on a
    /// distinction that does not exist.
    fn owner_is_org(&self, _owner: &str) -> Result<bool, ForgeError> {
        Ok(false)
    }

    fn auth_state(&self) -> AuthState {
        match (&self.token, self.transport.suspect()) {
            (None, _) => AuthState::SignedOut,
            (Some(_), true) => AuthState::Suspect { login: self.login.clone() },
            (Some(_), false) => {
                AuthState::SignedIn { login: self.login.clone().unwrap_or_default() }
            }
        }
    }

    fn viewer(&self) -> Result<Viewer, ForgeError> {
        self.require_token()?;
        let v = self.send(self.rest("GET", "/user", None))?;
        Ok(Viewer { login: str_at(&v, "username"), avatar_url: opt_str(&v, "avatar_url") })
    }

    fn pull_request_for_branch(
        &self,
        repo: &RepoRef,
        branch: &str,
    ) -> Result<Option<PullRequest>, ForgeError> {
        self.require_token()?;
        let path = format!(
            "/projects/{}/merge_requests?state=opened&source_branch={}&per_page=1",
            project(repo),
            encode(branch)
        );
        let v = self.send(self.rest("GET", &path, None))?;
        match v.as_array().and_then(|a| a.first()) {
            Some(mr) => pr_from(mr).map(Some),
            None => Ok(None),
        }
    }

    fn pull_request(&self, repo: &RepoRef, number: u64) -> Result<PullRequest, ForgeError> {
        self.require_token()?;
        pr_from(&self.merge_request(repo, number)?)
    }

    fn pull_request_states(&self, repo: &RepoRef, numbers: &[u64]) -> Result<Vec<(u64, PrState)>, ForgeError> {
        self.require_token()?;
        if numbers.is_empty() {
            return Ok(vec![]);
        }
        let iids: String = numbers.iter().map(|n| format!("&iids[]={n}")).collect();
        let path = format!("/projects/{}/merge_requests?state=all&per_page=100{iids}", project(repo));
        let (items, _) = paginate_rest(self.transport.as_ref(), self.rest("GET", &path, None), PAGE_CAP)?;
        items.iter().map(|v| pr_from(v).map(|pr| (pr.number, pr.state))).collect()
    }

    fn list_pull_requests(&self, repo: &RepoRef) -> Result<Paged<PullRequest>, ForgeError> {
        self.require_token()?;
        let path =
            format!("/projects/{}/merge_requests?state=opened&per_page=100", project(repo));
        let (items, truncated) =
            paginate_rest(self.transport.as_ref(), self.rest("GET", &path, None), PAGE_CAP)?;
        let items = items.iter().map(pr_from).collect::<Result<Vec<_>, _>>()?;
        Ok(Paged { items, truncated })
    }

    fn create_pull_request(
        &self,
        repo: &RepoRef,
        req: &CreatePr,
    ) -> Result<PullRequest, ForgeError> {
        self.require_token()?;
        // A draft is a title prefix on GitLab, not a flag: the API has no
        // `draft` parameter on create, and the prefix is what the server itself
        // reads back as `draft: true`.
        let title = if req.draft { format!("Draft: {}", req.title) } else { req.title.clone() };
        let body = serde_json::json!({
            "source_branch": req.head,
            "target_branch": req.base,
            "title": title,
            "description": req.body,
        });
        let path = format!("/projects/{}/merge_requests", project(repo));
        let v = self.send(self.rest("POST", &path, Some(body)))?;
        pr_from(&v)
    }

    /// One list request for the whole project, then the approval verdict for as
    /// many of the matched merge requests as [`APPROVAL_LOOKUPS`] allows.
    ///
    /// GitLab has no batched equivalent of GitHub's aliased query, so the list
    /// is what keeps this off one-request-per-branch: the branches are matched
    /// against it locally.
    fn unit_statuses(
        &self,
        repo: &RepoRef,
        branches: &[String],
    ) -> Result<Vec<UnitStatus>, ForgeError> {
        self.require_token()?;
        if branches.is_empty() {
            return Ok(vec![]);
        }
        let path =
            format!("/projects/{}/merge_requests?state=opened&per_page=100", project(repo));
        let (open, _) =
            paginate_rest(self.transport.as_ref(), self.rest("GET", &path, None), PAGE_CAP)?;
        let has_open = |branch: &str| open.iter().any(|mr| str_at(mr, "source_branch") == branch);

        let unmatched: BTreeSet<String> = branches.iter().filter(|b| !has_open(b)).cloned().collect();
        let ended = if unmatched.is_empty() { vec![] } else { self.history(repo, unmatched) };

        let mut asked = 0;
        Ok(branches
            .iter()
            .map(|branch| {
                let Some(mr) = open.iter().find(|mr| str_at(mr, "source_branch") == *branch) else {
                    // Newest created wins, the same pick GitHub's query makes.
                    let finished = ended
                        .iter()
                        .filter(|mr| str_at(mr, "source_branch") == *branch)
                        .filter_map(|mr| pr_from(mr).ok())
                        .filter(|pr| pr.state != PrState::Open && pr.head_repo_is_origin)
                        .max_by(|a, b| a.created_at.cmp(&b.created_at));
                    return UnitStatus {
                        head_ref: branch.clone(),
                        pull_request: finished,
                        checks: CheckRollup::none(),
                        review_decision: ReviewDecision::None,
                    };
                };
                let pull_request = pr_from(mr).ok();
                let review_decision = match pull_request.as_ref() {
                    // Free, and the common half of the answer.
                    Some(_) if verdict_from_list(mr).is_some() => {
                        verdict_from_list(mr).unwrap_or(ReviewDecision::None)
                    }
                    Some(pr) if asked < APPROVAL_LOOKUPS => {
                        asked += 1;
                        let path = format!(
                            "/projects/{}/merge_requests/{}/approvals",
                            project(repo),
                            pr.number
                        );
                        self.send(self.rest("GET", &path, None))
                            .map(|v| decision_from_approvals(&v))
                            .unwrap_or(ReviewDecision::None)
                    }
                    _ => ReviewDecision::None,
                };
                UnitStatus {
                    head_ref: branch.clone(),
                    pull_request,
                    checks: checks_from_pipeline(mr.get("head_pipeline")),
                    review_decision,
                }
            })
            .collect())
    }

    fn pull_request_files(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<Paged<PrFile>, ForgeError> {
        self.require_token()?;
        let path = format!(
            "/projects/{}/merge_requests/{number}/diffs?per_page=100",
            project(repo)
        );
        let (items, truncated) =
            paginate_rest(self.transport.as_ref(), self.rest("GET", &path, None), PAGE_CAP)?;
        Ok(Paged { items: items.iter().map(file_from).collect(), truncated })
    }

    fn review_threads(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<Paged<ReviewThread>, ForgeError> {
        self.require_token()?;
        let path = format!(
            "/projects/{}/merge_requests/{number}/discussions?per_page=100",
            project(repo)
        );
        let (items, truncated) =
            paginate_rest(self.transport.as_ref(), self.rest("GET", &path, None), PAGE_CAP)?;
        let items = items.iter().filter_map(|d| thread_from(repo, number, d)).collect();
        Ok(Paged { items, truncated })
    }

    fn reply_to_thread(
        &self,
        _repo: &RepoRef,
        thread_id: &str,
        body: &str,
    ) -> Result<ReviewComment, ForgeError> {
        self.require_token()?;
        let (project, iid, discussion) = unpack_thread(thread_id)?;
        let path =
            format!("/projects/{project}/merge_requests/{iid}/discussions/{discussion}/notes");
        let v = self.send(self.rest("POST", &path, Some(serde_json::json!({ "body": body }))))?;
        Ok(comment_from(&v))
    }

    fn set_thread_resolved(&self, thread_id: &str, resolved: bool) -> Result<(), ForgeError> {
        self.require_token()?;
        let (project, iid, discussion) = unpack_thread(thread_id)?;
        let path = format!(
            "/projects/{project}/merge_requests/{iid}/discussions/{discussion}?resolved={resolved}"
        );
        self.send(self.rest("PUT", &path, None))?;
        Ok(())
    }

    /// Comments first, then the verdict.
    ///
    /// GitLab has no atomic review, so this is several calls and the order is
    /// the one that fails safely: a comment that does not post stops the
    /// verdict, while an approval that fails leaves comments the reader can
    /// still act on. `RequestChanges` is refused outright rather than
    /// approximated, which is why `capabilities().request_changes` is false.
    fn submit_review(
        &self,
        repo: &RepoRef,
        number: u64,
        event: ReviewEvent,
        body: &str,
        comments: &[DraftComment],
        head_sha: Option<&str>,
    ) -> Result<Option<String>, ForgeError> {
        self.require_token()?;
        if event == ReviewEvent::RequestChanges {
            return Err(ForgeError::Invalid {
                message: "GitLab has no request-changes verdict.".into(),
            });
        }
        let project = project(repo);
        let mr = match (head_sha, comments.is_empty()) {
            (None, true) => Value::Null,
            _ => self.merge_request(repo, number)?,
        };
        // A discussion names no commit of its own, so a pinned review can only
        // be refused once the head has moved, before anything is posted.
        if let Some(sha) = head_sha {
            let now = mr.get("diff_refs").and_then(|r| r.get("head_sha")).and_then(Value::as_str).unwrap_or_default();
            if now != sha {
                return Err(ForgeError::Invalid { message: format!("the merge request moved past {sha} to {now}, ask again") });
            }
        }
        if !comments.is_empty() {
            // Every line comment is anchored against the diff the server
            // currently has, which is what `diff_refs` names; without those
            // three shas GitLab rejects a positioned discussion.
            let refs = mr.get("diff_refs").cloned().unwrap_or(Value::Null);
            // Only a range needs the patch. A single line is addressed by its
            // own number, while the ends of a range are named by a code built
            // from both sides' numbers.
            let ranged = comments.iter().any(|c| c.start_line.is_some());
            let diffs =
                if ranged { self.diff_lines(repo, number)? } else { BTreeMap::new() };
            for c in comments {
                let mut position = serde_json::json!({
                    "position_type": "text",
                    "base_sha": refs.get("base_sha"),
                    "start_sha": refs.get("start_sha"),
                    "head_sha": refs.get("head_sha"),
                    "new_path": c.path,
                    "old_path": c.path,
                });
                // A removed line exists only in the base file. Sent as a
                // head-side line it would anchor on whatever now holds that
                // number, which is the failure `DiffSide` exists to prevent.
                let head = c.side == DiffSide::Right;
                let numbering = if head { "new_line" } else { "old_line" };
                position[numbering] = serde_json::json!(c.line);
                // A range only exists when both ends are on one side, which is
                // the same rule the draft was anchored under.
                let ends = c
                    .start_line
                    .filter(|_| c.start_side == Some(c.side))
                    .zip(diffs.get(&c.path))
                    .and_then(|(start, pairs)| {
                        Some((pair_for(pairs, start, head)?, pair_for(pairs, c.line, head)?))
                    });
                if let Some((from, to)) = ends {
                    position["line_range"] = serde_json::json!({
                        "start": {
                            "line_code": line_code(&c.path, from.0, from.1),
                            "type": side_word(head),
                            "old_line": from.0,
                            "new_line": from.1,
                        },
                        "end": {
                            "line_code": line_code(&c.path, to.0, to.1),
                            "type": side_word(head),
                            "old_line": to.0,
                            "new_line": to.1,
                        },
                    });
                }
                let path = format!("/projects/{project}/merge_requests/{number}/discussions");
                self.send(self.rest(
                    "POST",
                    &path,
                    Some(serde_json::json!({ "body": c.body, "position": position })),
                ))?;
            }
        }
        if !body.trim().is_empty() {
            let path = format!("/projects/{project}/merge_requests/{number}/notes");
            self.send(self.rest("POST", &path, Some(serde_json::json!({ "body": body }))))?;
        }
        if event == ReviewEvent::Approve {
            let path = format!("/projects/{project}/merge_requests/{number}/approve");
            // The comments and the summary are already posted, so a refused
            // approval has to say so: re-submitting the whole review would post
            // every one of them a second time.
            self.send(self.rest("POST", &path, Some(serde_json::json!({})))).map_err(|e| {
                ForgeError::Api {
                    status: 0,
                    message: format!("your comments were posted, but the approval was not: {e}"),
                }
            })?;
        }
        Ok(None)
    }

    fn add_review_comment(
        &self,
        _repo: &RepoRef,
        _number: u64,
        _commit_id: &str,
        _comment: &DraftComment,
    ) -> Result<(), ForgeError> {
        // Refused rather than approximated with a discussion note. A note has no
        // commit to anchor against, so it would land wherever the line happens
        // to be when it arrives, which is the one failure this call exists to
        // prevent. `capabilities().single_comment` says so before anyone calls.
        Err(ForgeError::Invalid {
            message: "GitLab has no single line comment anchored to a commit.".into(),
        })
    }

    fn pr_summary(&self, repo: &RepoRef, number: u64) -> Result<PrSummary, ForgeError> {
        self.require_token()?;
        let v = self.merge_request(repo, number)?;
        Ok(PrSummary {
            mergeable_state: mergeable_from(&v),
            updated_at: str_at(&v, "updated_at"),
            // No counts, rather than zeros. A merge request object carries none
            // of them: the commit count, the per-side totals and the reviewer
            // verdicts each need their own endpoint, and "0 commits, +0 -0" on
            // screen is a sentence nobody wrote. The merge verdict above is the
            // part GitLab can answer, and it is the one a control depends on.
            counts: None,
        })
    }

    /// Squash is a parameter; a merge commit is the project's own setting.
    ///
    /// GitLab's merge endpoint takes no method, because an instance decides per
    /// project whether a merge commit or a rebase is used. `Rebase` is refused
    /// rather than quietly merged the project's way: a picker that says rebase
    /// and produces a merge commit is worse than one that says it cannot.
    fn merge(&self, repo: &RepoRef, number: u64, method: MergeMethod, expected_head: Option<&str>) -> Result<(), ForgeError> {
        self.require_token()?;
        if method == MergeMethod::Rebase {
            return Err(ForgeError::Invalid {
                message: "GitLab merges the way its project is configured. Use merge or squash."
                    .into(),
            });
        }
        let path = format!("/projects/{}/merge_requests/{number}/merge", project(repo));
        let mut body = serde_json::json!({ "squash": method == MergeMethod::Squash });
        if let Some(sha) = expected_head {
            body["sha"] = serde_json::json!(sha);
        }
        self.send(self.rest("PUT", &path, Some(body)))?;
        Ok(())
    }

    fn update_branch(&self, repo: &RepoRef, number: u64) -> Result<(), ForgeError> {
        self.require_token()?;
        // A rebase, because GitLab has no "merge the target into the source":
        // the server rebases the source branch onto the target and reports the
        // result on the next read, exactly like GitHub's queued update.
        let path = format!("/projects/{}/merge_requests/{number}/rebase", project(repo));
        self.send(self.rest("PUT", &path, Some(serde_json::json!({}))))?;
        Ok(())
    }

    fn reopen(&self, repo: &RepoRef, number: u64) -> Result<(), ForgeError> {
        self.require_token()?;
        let path = format!("/projects/{}/merge_requests/{number}", project(repo));
        self.send(self.rest("PUT", &path, Some(serde_json::json!({ "state_event": "reopen" }))))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::http::test_support::StubTransport;
    use super::*;

    /// A subgroup project, because the slash inside the owner is the part every
    /// GitLab URL gets wrong: it belongs to the project's name, not to the path.
    fn repo() -> RepoRef {
        RepoRef { owner: "group/sub".into(), repo: "project".into() }
    }

    const PROJECT: &str = "group%2Fsub%2Fproject";

    fn forge(
        responses: Vec<super::super::http::HttpResponse>,
    ) -> (GitLabForge, std::sync::Arc<StubTransport>) {
        let stub = std::sync::Arc::new(StubTransport::new(responses));
        let f = GitLabForge::new(
            Box::new(stub.clone()),
            "https://gitlab.test/",
            Some("glpat_test".into()),
            None,
        );
        (f, stub)
    }

    /// One open merge request, in the shape the list endpoint answers with.
    fn mr(over: &str) -> String {
        format!(
            r#"{{"iid":7,"title":"Wave 3","description":"hi","state":"opened","draft":false,
                "author":{{"username":"arif"}},"source_branch":"wave-3","target_branch":"main",
                "sha":"abc123","web_url":"https://gitlab.test/group/sub/project/-/merge_requests/7",
                "detailed_merge_status":"mergeable"{over}}}"#
        )
    }

    #[test]
    fn every_call_addresses_the_project_as_one_encoded_segment() {
        // A subgroup path sent unencoded reads as extra URL segments, and every
        // endpoint below then answers 404 for a project that exists.
        let (f, stub) = forge(vec![StubTransport::json(200, &format!("[{}]", mr("")))]);
        f.list_pull_requests(&repo()).unwrap();
        let url = &stub.requests()[0].url;
        assert!(
            url.starts_with(&format!("https://gitlab.test/api/v4/projects/{PROJECT}/merge_requests")),
            "got {url}"
        );
    }

    #[test]
    fn a_merge_request_maps_onto_the_neutral_pull_request() {
        let (f, _stub) = forge(vec![StubTransport::json(200, &format!("[{}]", mr("")))]);
        let pr = f.pull_request_for_branch(&repo(), "wave-3").unwrap().unwrap();
        assert_eq!(pr.number, 7, "the iid is the number a user sees, not the global id");
        assert_eq!(pr.author, "arif");
        assert_eq!(pr.head_ref, "wave-3");
        assert_eq!(pr.head_sha, "abc123");
        assert_eq!(pr.state, PrState::Open);
        assert_eq!(pr.mergeable_state, MergeableState::Clean);

        // A merged one, and a verdict GitLab has not computed yet: `Unknown`
        // means ask again, never a green light.
        let merged = format!(r#"[{}]"#, mr(r#","state":"merged","detailed_merge_status":"checking""#));
        let (f, _stub) = forge(vec![StubTransport::json(200, &merged)]);
        let pr = f.pull_request_for_branch(&repo(), "wave-3").unwrap().unwrap();
        assert_eq!(pr.state, PrState::Merged);
        assert_eq!(pr.mergeable_state, MergeableState::Unknown);
    }

    #[test]
    fn a_draft_is_created_as_a_title_prefix() {
        // GitLab's create endpoint has no draft flag: the prefix is the flag,
        // and it is what the server reads back as `draft: true`.
        let (f, stub) = forge(vec![StubTransport::json(200, &mr(""))]);
        let req = CreatePr {
            title: "Wave 3".into(),
            body: "b".into(),
            head: "wave-3".into(),
            base: "main".into(),
            draft: true,
        };
        f.create_pull_request(&repo(), &req).unwrap();
        let sent: Value = serde_json::from_str(&stub.bodies()[0]).unwrap();
        assert_eq!(sent["title"], "Draft: Wave 3");
        assert_eq!(sent["source_branch"], "wave-3");
        assert_eq!(sent["target_branch"], "main");
    }

    #[test]
    fn a_status_tick_reads_the_project_once_and_matches_branches_locally() {
        // GitLab has no batched query, so the whole point is that N branches
        // cost one list request rather than N: a per-branch call is what turns
        // idle polling into a rate-limit problem.
        let list = format!("[{}]", mr(r#","head_pipeline":{"status":"failed"}"#));
        let (f, stub) = forge(vec![
            StubTransport::json(200, &list),
            StubTransport::json(200, "[]"),
            StubTransport::json(200, r#"{"approved":true,"approvals_left":0}"#),
        ]);
        let statuses = f
            .unit_statuses(&repo(), &["wave-3".to_string(), "no-mr-here".to_string()])
            .unwrap();

        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].pull_request.as_ref().unwrap().number, 7);
        assert_eq!(statuses[0].checks.state, CheckState::Failure);
        assert_eq!(statuses[0].review_decision, ReviewDecision::Approved);
        // A branch with no merge request is answered for, not skipped.
        assert!(statuses[1].pull_request.is_none());
        assert_eq!(statuses[1].checks.state, CheckState::None);
        // The open list, one page of history for the unmatched branch, and one
        // approval call: nothing per branch.
        assert_eq!(stub.request_count(), 3);
    }

    #[test]
    fn a_branch_with_no_open_mr_takes_its_newest_finished_one_from_one_page() {
        let history = format!(
            "[{},{},{}]",
            mr(r#","iid":9,"source_branch":"done","state":"merged","created_at":"2026-09-20T00:00:00Z",
                "source_project_id":2,"target_project_id":1"#),
            mr(r#","iid":3,"source_branch":"done","state":"closed","created_at":"2026-08-01T00:00:00Z""#),
            mr(r#","iid":4,"source_branch":"done","state":"merged","created_at":"2026-09-01T00:00:00Z",
                "merged_at":"2026-09-02T00:00:00Z","source_project_id":1,"target_project_id":1"#),
        );
        let (f, stub) = forge(vec![StubTransport::json(200, "[]"), StubTransport::json(200, &history)]);
        let statuses = f.unit_statuses(&repo(), &["done".to_string()]).unwrap();

        // !9 is newer, but from a fork's branch of the same name.
        let pr = statuses[0].pull_request.as_ref().unwrap();
        assert_eq!((pr.number, pr.state), (4, PrState::Merged));
        assert_eq!(pr.merged_at.as_deref(), Some("2026-09-02T00:00:00Z"));
        assert!(pr.head_repo_is_origin);
        assert!(stub.requests()[1].url.contains("state=all"));

        // Every branch matched an open one, so the history is never asked for.
        let (f, stub) = forge(vec![StubTransport::json(200, &format!("[{}]", mr("")))]);
        f.unit_statuses(&repo(), &["wave-3".to_string()]).unwrap();
        assert_eq!(stub.request_count(), 2, "the open list and its one approval lookup");
    }

    #[test]
    fn the_history_page_is_reread_only_for_a_branch_that_newly_lost_its_open_mr() {
        let open = |branch: &str| format!("[{}]", mr(&format!(r#","source_branch":"{branch}""#)));
        let (f, stub) = forge(vec![
            StubTransport::json(200, &open("cache-b")),
            StubTransport::json(200, "[]"),
            StubTransport::json(200, r#"{"approved":true,"approvals_left":0}"#),
            StubTransport::json(200, &open("cache-b")),
            StubTransport::json(200, r#"{"approved":true,"approvals_left":0}"#),
            StubTransport::json(200, "[]"),
            StubTransport::json(200, "[]"),
        ]);
        let base_only = ["cache-main".to_string(), "cache-b".to_string()];
        f.unit_statuses(&repo(), &base_only).unwrap();
        f.unit_statuses(&repo(), &base_only).unwrap();
        assert_eq!(stub.request_count(), 5, "the second tick reused the page read for cache-main");

        // cache-b's merge request is no longer open: its history is news.
        f.unit_statuses(&repo(), &base_only).unwrap();
        assert!(stub.requests()[6].url.contains("state=all"));
    }

    #[test]
    fn a_discussion_becomes_a_thread_that_can_be_replied_to_and_resolved() {
        // The id the trait hands back carries the project and the merge request
        // as well as the discussion, because resolving needs all three and the
        // trait's resolve method is given only the id.
        let discussions = r#"[
            {"id":"abc123","notes":[
                {"id":1,"body":"this leaks","created_at":"2026-09-01T10:00:00Z",
                 "author":{"username":"arif"},"resolved":false,
                 "position":{"new_path":"src/a.rs","old_path":"src/a.rs","new_line":12}}
            ]},
            {"id":"nopos","notes":[{"id":2,"body":"just a note","author":{"username":"arif"}}]}
        ]"#;
        let (f, stub) = forge(vec![
            StubTransport::json(200, discussions),
            StubTransport::json(200, r#"{"id":9,"body":"fixed","created_at":"t","author":{"username":"arif"}}"#),
            StubTransport::json(200, "{}"),
        ]);

        let threads = f.review_threads(&repo(), 7).unwrap();
        // The second discussion has no diff position, so it is the merge
        // request's own conversation rather than a review thread.
        assert_eq!(threads.items.len(), 1);
        let thread = &threads.items[0];
        assert_eq!(thread.path, "src/a.rs");
        assert_eq!(thread.line, Some(12));
        assert_eq!(thread.comments.len(), 1);

        f.reply_to_thread(&repo(), &thread.id, "fixed").unwrap();
        f.set_thread_resolved(&thread.id, true).unwrap();
        let sent = stub.requests();
        assert_eq!(
            sent[1].url,
            format!("https://gitlab.test/api/v4/projects/{PROJECT}/merge_requests/7/discussions/abc123/notes")
        );
        assert_eq!(
            sent[2].url,
            format!("https://gitlab.test/api/v4/projects/{PROJECT}/merge_requests/7/discussions/abc123?resolved=true")
        );
    }

    #[test]
    fn a_thread_on_a_line_the_head_no_longer_has_reads_as_outdated() {
        let discussions = r#"[
            {"id":"old","notes":[{"id":1,"body":"was here","author":{"username":"arif"},
             "position":{"new_path":"src/a.rs","old_path":"src/a.rs","old_line":4}}]}
        ]"#;
        let (f, _stub) = forge(vec![StubTransport::json(200, discussions)]);
        let threads = f.review_threads(&repo(), 7).unwrap();
        assert!(threads.items[0].is_outdated, "no head line means the thread no longer anchors");
        assert_eq!(threads.items[0].line, None);
    }

    #[test]
    fn a_changed_file_counts_the_lines_gitlab_does_not_send() {
        // GitLab sends the diff and no counts, and the three absent-patch cases
        // (binary, mode-only, too large) are told apart by them.
        let diffs = r#"[
            {"old_path":"src/a.rs","new_path":"src/a.rs","new_file":false,"renamed_file":false,
             "deleted_file":false,"diff":"@@ -1,2 +1,2 @@\n-one\n+two\n+three\n"},
            {"old_path":"src/from.rs","new_path":"src/to.rs","new_file":false,"renamed_file":true,
             "deleted_file":false,"diff":""}
        ]"#;
        let (f, _stub) = forge(vec![StubTransport::json(200, diffs)]);
        let files = f.pull_request_files(&repo(), 7).unwrap();

        assert_eq!(files.items[0].path, "src/a.rs");
        assert_eq!(files.items[0].additions, 2);
        assert_eq!(files.items[0].deletions, 1);
        assert_eq!(files.items[1].status, FileStatus::Renamed);
        assert_eq!(files.items[1].previous_path.as_deref(), Some("src/from.rs"));
        // An empty diff is an absent patch, not a file with no changes to show.
        assert_eq!(files.items[1].patch, None);
    }

    #[test]
    fn a_review_posts_its_comments_before_the_verdict() {
        // GitLab has no atomic review. The order is the one that fails safely:
        // a comment that will not post stops the approval, and an approval that
        // fails leaves comments the reader can still act on.
        let (f, stub) = forge(vec![
            StubTransport::json(200, r#"{"diff_refs":{"base_sha":"b","start_sha":"s","head_sha":"h"}}"#),
            StubTransport::json(200, r#"{"id":1}"#),
            StubTransport::json(200, r#"{"id":2}"#),
            StubTransport::json(200, r#"{"id":3}"#),
        ]);
        let comments = [DraftComment {
            path: "src/a.rs".into(),
            line: 12,
            side: super::super::model::DiffSide::Right,
            start_line: None,
            start_side: None,
            body: "here".into(),
        }];
        f.submit_review(&repo(), 7, ReviewEvent::Approve, "looks good", &comments, None).unwrap();

        let sent = stub.requests();
        assert!(sent[1].url.ends_with("/merge_requests/7/discussions"), "got {}", sent[1].url);
        // The three shas the position needs: without them GitLab refuses a
        // positioned discussion outright.
        let position: Value = serde_json::from_str(&stub.bodies()[1]).unwrap();
        assert_eq!(position["position"]["head_sha"], "h");
        assert_eq!(position["position"]["new_line"], 12);
        assert!(sent[2].url.ends_with("/merge_requests/7/notes"));
        assert!(sent[3].url.ends_with("/merge_requests/7/approve"));
    }

    #[test]
    fn a_multi_line_comment_posts_the_range_it_was_drawn_on() {
        // Without the range the comment narrows to its last line, which is a
        // remark about three lines landing on one. The ends are named by a code
        // built from both sides' numbers, so the patch is what recovers them.
        let (f, stub) = forge(vec![
            StubTransport::json(
                200,
                r#"{"diff_refs":{"base_sha":"b","start_sha":"s","head_sha":"h"}}"#,
            ),
            StubTransport::json(
                200,
                r#"[{"old_path":"src/a.rs","new_path":"src/a.rs","new_file":false,
                     "renamed_file":false,"deleted_file":false,
                     "diff":"@@ -1,2 +1,4 @@\n one\n+two\n+three\n four\n"}]"#,
            ),
            StubTransport::json(200, r#"{"id":1}"#),
        ]);
        let comments = [DraftComment {
            path: "src/a.rs".into(),
            line: 3,
            side: DiffSide::Right,
            start_line: Some(2),
            start_side: Some(DiffSide::Right),
            body: "both of these".into(),
        }];
        f.submit_review(&repo(), 7, ReviewEvent::Comment, "", &comments, None).unwrap();

        let sent: Value = serde_json::from_str(&stub.bodies()[2]).unwrap();
        let range = &sent["position"]["line_range"];
        assert_eq!(range["start"]["new_line"], 2);
        assert_eq!(range["end"]["new_line"], 3);
        assert_eq!(range["start"]["type"], "new");
        // The old side of an added line is the line it follows, which is what
        // the code has to carry for the server to place it.
        assert!(
            range["start"]["line_code"].as_str().unwrap().ends_with("_1_2"),
            "got {range}"
        );
    }

    #[test]
    fn a_comment_on_a_removed_line_is_anchored_on_the_base_side() {
        // That line exists only in the base file. Sent as `new_line` it would
        // land on whatever now holds that number, which is a review comment
        // about code the author never wrote.
        let (f, stub) = forge(vec![
            StubTransport::json(
                200,
                r#"{"diff_refs":{"base_sha":"b","start_sha":"s","head_sha":"h"}}"#,
            ),
            StubTransport::json(200, r#"{"id":1}"#),
        ]);
        let comments = [DraftComment {
            path: "src/a.rs".into(),
            line: 41,
            side: DiffSide::Left,
            start_line: None,
            start_side: None,
            body: "this dropped the error".into(),
        }];
        f.submit_review(&repo(), 7, ReviewEvent::Comment, "", &comments, None).unwrap();

        let sent: Value = serde_json::from_str(&stub.bodies()[1]).unwrap();
        assert_eq!(sent["position"]["old_line"], 41);
        assert!(
            sent["position"].get("new_line").is_none(),
            "a base-side comment must not carry a head line: {}",
            sent["position"]
        );
    }

    #[test]
    fn a_single_comment_is_refused_rather_than_posted_as_a_note() {
        // A discussion note has no commit to anchor against, so it would land
        // wherever the line happens to be when it arrives. That is the one
        // failure this call exists to prevent, so it must not be faked.
        let (f, stub) = forge(vec![]);
        let err = f
            .add_review_comment(
                &repo(),
                7,
                "abc1234",
                &DraftComment {
                    path: "src/a.rs".into(),
                    line: 3,
                    side: DiffSide::Right,
                    start_line: None,
                    start_side: None,
                    body: "no".into(),
                },
            )
            .unwrap_err();
        assert!(matches!(err, ForgeError::Invalid { .. }), "got {err:?}");
        assert_eq!(stub.request_count(), 0, "a refused call must not reach the wire");
        assert!(!f.capabilities().single_comment);
    }

    #[test]
    fn request_changes_is_refused_rather_than_approximated() {
        // The capability says GitLab has no such verdict, and the call agrees:
        // faking it as a comment would report a verdict nobody can act on.
        let (f, stub) = forge(vec![]);
        let err = f
            .submit_review(&repo(), 7, ReviewEvent::RequestChanges, "fix it", &[], None)
            .unwrap_err();
        assert!(matches!(err, ForgeError::Invalid { .. }), "got {err:?}");
        assert_eq!(stub.request_count(), 0, "a refused verdict must not reach the wire");
        assert!(!f.capabilities().request_changes);
    }

    #[test]
    fn a_pinned_review_is_refused_before_posting_once_the_head_moved() {
        let (f, stub) = forge(vec![
            StubTransport::json(200, r#"{"diff_refs":{"base_sha":"b","start_sha":"s","head_sha":"new"}}"#),
            StubTransport::json(200, r#"{"diff_refs":{"base_sha":"b","start_sha":"s","head_sha":"new"}}"#),
            StubTransport::json(200, r#"{"id":1}"#),
        ]);
        let err = f.submit_review(&repo(), 7, ReviewEvent::Comment, "body", &[], Some("old")).unwrap_err();
        assert!(matches!(&err, ForgeError::Invalid { message } if message.contains("moved past old")), "got {err:?}");
        assert_eq!(stub.request_count(), 1, "only the read went out");
        f.submit_review(&repo(), 7, ReviewEvent::Comment, "body", &[], Some("new")).unwrap();
        assert_eq!(stub.request_count(), 3);
    }

    #[test]
    fn merging_squashes_only_when_asked_and_updating_rebases() {
        let (f, stub) = forge(vec![
            StubTransport::json(200, "{}"),
            StubTransport::json(200, "{}"),
            StubTransport::json(200, "{}"),
        ]);
        f.merge(&repo(), 7, MergeMethod::Squash, None).unwrap();
        f.merge(&repo(), 7, MergeMethod::Merge, None).unwrap();
        f.update_branch(&repo(), 7).unwrap();

        let bodies = stub.bodies();
        assert_eq!(serde_json::from_str::<Value>(&bodies[0]).unwrap()["squash"], true);
        assert_eq!(serde_json::from_str::<Value>(&bodies[1]).unwrap()["squash"], false);
        let sent = stub.requests();
        assert!(sent[0].url.ends_with("/merge_requests/7/merge"));
        assert!(sent[2].url.ends_with("/merge_requests/7/rebase"), "got {}", sent[2].url);
    }

    #[test]
    fn reopening_sends_the_reopen_state_event() {
        let (f, stub) = forge(vec![StubTransport::json(200, "{}")]);
        f.reopen(&repo(), 7).unwrap();
        let sent = stub.requests();
        assert_eq!(sent[0].method, "PUT");
        assert!(sent[0].url.ends_with(&format!("/projects/{PROJECT}/merge_requests/7")), "got {}", sent[0].url);
        assert_eq!(serde_json::from_str::<Value>(sent[0].body.as_deref().unwrap()).unwrap()["state_event"], "reopen");
    }

    #[test]
    fn the_viewer_is_read_from_the_username() {
        // GitLab's `/user` answers `username`, and mapping `name` instead would
        // compare a display name against a merge request's author login.
        let (f, _stub) = forge(vec![StubTransport::json(
            200,
            r#"{"username":"arif","name":"Fazlul Haque Arif","avatar_url":"https://gitlab.test/a.png"}"#,
        )]);
        let viewer = f.viewer().unwrap();
        assert_eq!(viewer.login, "arif");
        assert_eq!(viewer.avatar_url.as_deref(), Some("https://gitlab.test/a.png"));
    }

    #[test]
    fn signed_out_never_reaches_the_network() {
        let stub = std::sync::Arc::new(StubTransport::new(vec![]));
        let f = GitLabForge::new(Box::new(stub.clone()), "https://gitlab.test", None, None);
        assert_eq!(f.auth_state(), AuthState::SignedOut);
        assert_eq!(
            f.pull_request_for_branch(&repo(), "wave-3").unwrap_err(),
            ForgeError::NotAuthenticated
        );
        assert_eq!(stub.request_count(), 0);
    }
}
