//! The GitHub provider.
//!
//! Everything GitHub-shaped lives here: URLs, the REST/GraphQL split, and the
//! mapping from wire JSON onto the neutral types in [`super::model`]. Nothing
//! above this file knows any of it.
//!
//! ## Why both transports
//!
//! REST is the default. GraphQL is used exactly where REST cannot do the job:
//!
//!   * **Review threads.** REST has no thread object at all, only comments with
//!     an `in_reply_to_id`. `resolveReviewThread` needs a
//!     `PullRequestReviewThread` node id, and a comment's `node_id` is not one,
//!     so threads must be *read* over GraphQL to be resolvable at all.
//!   * **Per-unit status.** The sidebar wants PR state, checks and review
//!     decision for every branch-unit of a project. Over REST that is three
//!     calls per unit; one aliased GraphQL query does the whole project in one
//!     request, which is the difference between affordable idle polling and
//!     spending the hourly budget on nothing.
//!
//! Replies also go over GraphQL, which was not the original intent. The REST
//! reply endpoint keys off a numeric *comment* id, and a caller holding a
//! thread has only the thread's node id, so reaching REST would mean fetching a
//! comment id purely to satisfy the transport. `addPullRequestReviewThreadReply`
//! takes the id the caller already has.

use super::http::{
    classify, graphql_data, paginate_graphql, paginate_rest, ConnectionSpec, GraphqlEndpoint,
    HttpRequest, NestedSpec, Transport, PAGE_CAP,
};
use super::model::{
    AuthState, Capabilities, CheckRollup, CheckState, FileStatus, MergeableState, Paged, PrFile,
    PrState, PullRequest, RateSnapshot, RepoRef, ReviewComment, ReviewDecision, ReviewThread,
    UnitStatus, Viewer,
};
use super::{CreatePr, Forge, ForgeError, MergeMethod};
use serde_json::Value;

/// How many changed files the API will describe for one pull request.
///
/// GitHub's own ceiling, not a budget of ours, which is why exceeding it is a
/// sentence on screen rather than a shorter list: past this the server simply
/// stops describing the PR, and the only honest thing left to offer is the link
/// out. At `PR_FILES_PER_PAGE` per page it is reached in exactly
/// `PR_FILE_PAGES` pages, so a `Link: rel="next"` on the last one is the signal.
const PR_FILE_CAP: usize = 300;
const PR_FILES_PER_PAGE: usize = 100;
const PR_FILE_PAGES: usize = PR_FILE_CAP / PR_FILES_PER_PAGE;

const API_BASE: &str = "https://api.github.com";
const GRAPHQL_URL: &str = "https://api.github.com/graphql";
/// Sent on every request. GitHub rejects an API call with no User-Agent, and
/// `update.rs` already sets one for the same reason.
const USER_AGENT: &str = "sway";

/// Derives the owner and repo from a git remote URL.
///
/// Accepts the three shapes a remote actually takes (`https://`, `git@` scp
/// syntax, and `ssh://`), and refuses anything not on github.com with
/// [`ForgeError::UnsupportedRemote`] rather than a generic failure. That
/// distinction is what lets the sidebar render a GitLab remote as inert instead
/// of as "no PR yet", which would offer a create button that cannot work.
pub fn parse_remote(url: &str) -> Result<RepoRef, ForgeError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(ForgeError::NoRemote);
    }
    // `git@host:owner/repo.git`, which is not a URL and will not parse as one.
    let (host, path) = if let Some(rest) = url.strip_prefix("git@") {
        match rest.split_once(':') {
            Some((host, path)) => (host.to_string(), path.to_string()),
            None => return Err(ForgeError::UnsupportedRemote { host: rest.to_string() }),
        }
    } else {
        let rest = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))
            .or_else(|| url.strip_prefix("ssh://git@"))
            .or_else(|| url.strip_prefix("ssh://"))
            .ok_or_else(|| ForgeError::UnsupportedRemote { host: url.to_string() })?;
        match rest.split_once('/') {
            Some((host, path)) => (host.to_string(), path.to_string()),
            None => return Err(ForgeError::UnsupportedRemote { host: rest.to_string() }),
        }
    };

    // Strip a `user@` prefix and any port, so `git@github.com` and
    // `github.com:22` both resolve to the same host.
    let host = host.rsplit('@').next().unwrap_or(&host).to_string();
    let host = host.split(':').next().unwrap_or(&host).to_string();
    if !host.eq_ignore_ascii_case("github.com") && !host.eq_ignore_ascii_case("www.github.com") {
        return Err(ForgeError::UnsupportedRemote { host });
    }

    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut bits = path.splitn(2, '/');
    let owner = bits.next().unwrap_or_default();
    let repo = bits.next().unwrap_or_default();
    if owner.is_empty() || repo.is_empty() {
        return Err(ForgeError::UnsupportedRemote { host });
    }
    Ok(RepoRef { owner: owner.to_string(), repo: repo.to_string() })
}

/// Wraps the real transport and records what every response said about the rate
/// budget and the credential.
///
/// This is a transport rather than a method on [`GitHubForge`] for one reason:
/// the pagination walkers take a `&dyn Transport` and loop on it directly, so
/// anything that lived only in a `GitHubForge` method would be skipped by every
/// paginated call. Putting it here means a 401 on page three of a thread walk
/// marks the credential suspect exactly like a 401 on a single GET, with no
/// call site able to opt out.
struct Recording {
    inner: Box<dyn Transport>,
    /// Set once a 401 has been seen. The token is kept, not cleared: see
    /// [`AuthState::Suspect`].
    suspect: std::sync::atomic::AtomicBool,
    rate: std::sync::Mutex<RateSnapshot>,
}

impl Transport for Recording {
    fn send(&self, req: super::http::HttpRequest) -> Result<super::http::HttpResponse, ForgeError> {
        let resp = self.inner.send(req)?;
        *self.rate.lock().unwrap() = RateSnapshot {
            remaining: resp.header("X-RateLimit-Remaining").and_then(|v| v.trim().parse().ok()),
            limit: resp.header("X-RateLimit-Limit").and_then(|v| v.trim().parse().ok()),
            // Seconds since the epoch, so this one is wider than the counts.
            reset_at: resp.header("X-RateLimit-Reset").and_then(|v| v.trim().parse().ok()),
        };
        match resp.status {
            401 => self.suspect.store(true, std::sync::atomic::Ordering::Relaxed),
            // Any answered call clears the suspicion. A 401 from a proxy, a
            // captive portal or a forge incident is transient, and without this
            // the flag would latch on forever: the user would be told to sign
            // in again to fix something that had already fixed itself.
            200..=299 => self.suspect.store(false, std::sync::atomic::Ordering::Relaxed),
            _ => {}
        }
        Ok(resp)
    }
}

pub struct GitHubForge {
    transport: std::sync::Arc<Recording>,
    token: Option<String>,
    api_base: String,
    graphql_url: String,
    login: Option<String>,
}

impl GitHubForge {
    pub fn new(transport: Box<dyn Transport>, token: Option<String>, login: Option<String>) -> Self {
        Self {
            transport: std::sync::Arc::new(Recording {
                inner: transport,
                suspect: std::sync::atomic::AtomicBool::new(false),
                rate: std::sync::Mutex::new(RateSnapshot::default()),
            }),
            token,
            api_base: API_BASE.to_string(),
            graphql_url: GRAPHQL_URL.to_string(),
            login,
        }
    }

    /// Points the client at a different origin. Tests use it; nothing else does.
    #[cfg(test)]
    pub fn with_base(mut self, base: &str) -> Self {
        self.api_base = base.to_string();
        self.graphql_url = format!("{base}/graphql");
        self
    }

    pub fn rate_snapshot(&self) -> RateSnapshot {
        *self.transport.rate.lock().unwrap()
    }

    fn headers(&self) -> Vec<(String, String)> {
        let mut h = vec![
            ("Accept".to_string(), "application/vnd.github+json".to_string()),
            ("X-GitHub-Api-Version".to_string(), "2022-11-28".to_string()),
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

    /// Sends a single request and maps a non-2xx onto a typed error.
    ///
    /// The rate snapshot and the suspect flag are *not* updated here: they live
    /// in [`Recording`], so the paginated paths that never call this function
    /// still record them.
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

    fn rest(&self, method: &'static str, path: &str, body: Option<Value>) -> HttpRequest {
        HttpRequest {
            method,
            url: format!("{}{path}", self.api_base),
            headers: self.headers(),
            body: body.map(|b| b.to_string()),
        }
    }

    fn graphql(&self, query: &str, vars: Value) -> Result<Value, ForgeError> {
        let req = HttpRequest {
            method: "POST",
            url: self.graphql_url.clone(),
            headers: self.headers(),
            body: Some(serde_json::json!({ "query": query, "variables": vars }).to_string()),
        };
        // GraphQL answers 200 with an `errors` array, so a status check is not
        // enough on its own. The unwrapping lives in `http` and is shared with
        // the pagination walker, rather than being written twice and drifting.
        let resp = self.transport.send(req)?;
        graphql_data(&resp)
    }
}

// --- wire mapping ---

fn str_at(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

/// Maps a REST pull-request object.
///
/// `merged_at` rather than a `merged` boolean, because the list endpoint omits
/// `merged` entirely and only the detail endpoint carries it; reading the
/// timestamp works on both.
fn pr_from_rest(v: &Value) -> Result<PullRequest, ForgeError> {
    let number = v
        .get("number")
        .and_then(|n| n.as_u64())
        .ok_or_else(|| ForgeError::Malformed { message: "pull request has no number".into() })?;
    let state = if v.get("merged_at").map(|m| !m.is_null()).unwrap_or(false) {
        PrState::Merged
    } else if str_at(v, "state") == "closed" {
        PrState::Closed
    } else {
        PrState::Open
    };
    Ok(PullRequest {
        number,
        title: str_at(v, "title"),
        body: v.get("body").and_then(|b| b.as_str()).map(|s| s.to_string()),
        state,
        is_draft: v.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
        author: v.get("user").map(|u| str_at(u, "login")).unwrap_or_default(),
        head_ref: v.get("head").map(|h| str_at(h, "ref")).unwrap_or_default(),
        base_ref: v.get("base").map(|b| str_at(b, "ref")).unwrap_or_default(),
        head_sha: v.get("head").map(|h| str_at(h, "sha")).unwrap_or_default(),
        url: str_at(v, "html_url"),
        mergeable_state: mergeable_from_rest(v),
    })
}

/// Maps one entry of `GET /pulls/{n}/files`.
///
/// `patch` is passed through untouched, including its absence. GitHub omits it
/// for a binary file, for a mode-only change, and for a patch past the size it
/// will send, and those need three different sentences on screen; the line
/// counts are what tell them apart, so they are kept even though a present
/// patch already contains them.
fn file_from_rest(v: &Value) -> Result<PrFile, ForgeError> {
    let path = v
        .get("filename")
        .and_then(|f| f.as_str())
        .ok_or_else(|| ForgeError::Malformed { message: "changed file has no filename".into() })?;
    let status = match v.get("status").and_then(|s| s.as_str()) {
        Some("added") => FileStatus::Added,
        Some("removed") => FileStatus::Removed,
        Some("renamed") => FileStatus::Renamed,
        Some("copied") => FileStatus::Copied,
        Some("unchanged") => FileStatus::Unchanged,
        Some("changed") => FileStatus::Changed,
        // Includes GitHub's own "modified" and anything it adds later. A file
        // Sway cannot classify still renders its patch, which is the part the
        // reader came for.
        _ => FileStatus::Modified,
    };
    Ok(PrFile {
        path: path.to_string(),
        previous_path: v
            .get("previous_filename")
            .and_then(|p| p.as_str())
            .map(|s| s.to_string()),
        status,
        additions: v.get("additions").and_then(|a| a.as_u64()).unwrap_or(0) as u32,
        deletions: v.get("deletions").and_then(|d| d.as_u64()).unwrap_or(0) as u32,
        patch: v.get("patch").and_then(|p| p.as_str()).map(|s| s.to_string()),
    })
}

/// GitHub's `mergeable_state`, carried through rather than recomputed.
///
/// `mergeable: null` means it is still being computed, which is `Unknown` and
/// means "ask again", not "no". Anything unrecognised is also `Unknown`: a new
/// state string must not read as a green light.
fn mergeable_from_rest(v: &Value) -> MergeableState {
    match v.get("mergeable_state").and_then(|m| m.as_str()) {
        Some("clean") => MergeableState::Clean,
        Some("blocked") => MergeableState::Blocked,
        Some("behind") => MergeableState::Behind,
        Some("dirty") => MergeableState::Dirty,
        Some("unstable") | Some("has_hooks") => MergeableState::Unstable,
        Some("draft") => MergeableState::Draft,
        _ => MergeableState::Unknown,
    }
}

fn checks_from_rollup(rollup: Option<&Value>) -> CheckRollup {
    let Some(rollup) = rollup else {
        return CheckRollup { state: CheckState::None, total: 0, failing: 0 };
    };
    let contexts = rollup.get("contexts");
    let total = contexts
        .and_then(|c| c.get("totalCount"))
        .and_then(|t| t.as_u64())
        .unwrap_or(0) as u32;
    // `state` is GitHub's own rollup over *every* context, so it stays correct
    // even when the node list below is capped. The counts are the part that can
    // be partial, which is why the state is not derived from them.
    let state = match rollup.get("state").and_then(|s| s.as_str()) {
        Some("SUCCESS") => CheckState::Success,
        Some("FAILURE") | Some("ERROR") => CheckState::Failure,
        Some("PENDING") | Some("EXPECTED") => CheckState::Pending,
        _ if total == 0 => CheckState::None,
        _ => CheckState::Pending,
    };
    let failing = contexts
        .and_then(|c| c.get("nodes"))
        .and_then(|n| n.as_array())
        .map(|nodes| {
            nodes
                .iter()
                .filter(|n| {
                    matches!(
                        n.get("conclusion").and_then(|c| c.as_str()),
                        Some("FAILURE") | Some("TIMED_OUT") | Some("CANCELLED") | Some("ACTION_REQUIRED")
                    ) || matches!(
                        n.get("state").and_then(|s| s.as_str()),
                        Some("FAILURE") | Some("ERROR")
                    )
                })
                .count() as u32
        })
        .unwrap_or(0);
    CheckRollup { state, total, failing }
}

fn review_decision_from(v: Option<&str>) -> ReviewDecision {
    match v {
        Some("APPROVED") => ReviewDecision::Approved,
        Some("CHANGES_REQUESTED") => ReviewDecision::ChangesRequested,
        Some("REVIEW_REQUIRED") => ReviewDecision::ReviewRequired,
        _ => ReviewDecision::None,
    }
}

fn pr_from_graphql(v: &Value) -> PullRequest {
    let state = match v.get("state").and_then(|s| s.as_str()) {
        Some("MERGED") => PrState::Merged,
        Some("CLOSED") => PrState::Closed,
        _ => PrState::Open,
    };
    let head_sha = v
        .get("commits")
        .and_then(|c| c.get("nodes"))
        .and_then(|n| n.as_array())
        .and_then(|n| n.first())
        .and_then(|n| n.get("commit"))
        .map(|c| str_at(c, "oid"))
        .unwrap_or_default();
    PullRequest {
        number: v.get("number").and_then(|n| n.as_u64()).unwrap_or(0),
        title: str_at(v, "title"),
        body: v.get("body").and_then(|b| b.as_str()).map(|s| s.to_string()),
        state,
        is_draft: v.get("isDraft").and_then(|d| d.as_bool()).unwrap_or(false),
        author: v.get("author").map(|a| str_at(a, "login")).unwrap_or_default(),
        head_ref: str_at(v, "headRefName"),
        base_ref: str_at(v, "baseRefName"),
        head_sha,
        url: str_at(v, "url"),
        // GraphQL's `mergeable` is **not** REST's `mergeable_state`. It reports
        // merge *conflicts* only, and knows nothing about branch protection or
        // required checks, so mapping `MERGEABLE` onto `Clean` would hand the
        // merge guard a green light for a PR the server will refuse. Only
        // `CONFLICTING` is definite here; everything else is Unknown, and the
        // authority is `mergeability()`, which asks REST.
        mergeable_state: match v.get("mergeable").and_then(|m| m.as_str()) {
            Some("CONFLICTING") => MergeableState::Dirty,
            _ => MergeableState::Unknown,
        },
    }
}

fn thread_from_graphql(v: &Value) -> ReviewThread {
    let comments: Vec<ReviewComment> = v
        .get("comments")
        .and_then(|c| c.get("nodes"))
        .and_then(|n| n.as_array())
        .map(|nodes| {
            nodes
                .iter()
                .map(|c| ReviewComment {
                    id: str_at(c, "id"),
                    author: c.get("author").map(|a| str_at(a, "login")).unwrap_or_default(),
                    body: str_at(c, "body"),
                    created_at: str_at(c, "createdAt"),
                })
                .collect()
        })
        .unwrap_or_default();
    // The hunk lives on the comments, not the thread, so it comes off the first
    // one. An empty thread cannot happen in practice but must not panic.
    let diff_hunk = v
        .get("comments")
        .and_then(|c| c.get("nodes"))
        .and_then(|n| n.as_array())
        .and_then(|n| n.first())
        .map(|c| str_at(c, "diffHunk"))
        .unwrap_or_default();
    ReviewThread {
        id: str_at(v, "id"),
        path: str_at(v, "path"),
        line: v.get("line").and_then(|l| l.as_u64()).map(|l| l as u32),
        diff_hunk,
        is_resolved: v.get("isResolved").and_then(|r| r.as_bool()).unwrap_or(false),
        is_outdated: v.get("isOutdated").and_then(|o| o.as_bool()).unwrap_or(false),
        comments,
    }
}

// --- GraphQL documents ---

/// The PR fields every query needs, so the aliased batch and the single lookup
/// cannot drift into disagreeing about what a PR is.
const PR_FIELDS: &str = r#"
  number title body state isDraft url headRefName baseRefName
  mergeable
  author { login }
  reviewDecision
  commits(last: 1) { nodes { commit {
    oid
    statusCheckRollup {
      state
      contexts(first: 100) {
        totalCount
        nodes { __typename ... on CheckRun { conclusion } ... on StatusContext { state } }
      }
    }
  } } }
"#;

const THREADS_QUERY: &str = r#"
query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:50, after:$after){
        nodes{
          id path line isResolved isOutdated
          comments(first:50){
            nodes{ id body createdAt diffHunk author{ login } }
            pageInfo{ hasNextPage endCursor }
          }
        }
        pageInfo{ hasNextPage endCursor }
      }
    }
  }
}"#;

/// The follow-up for one thread whose comments did not fit on a page.
const THREAD_COMMENTS_QUERY: &str = r#"
query($id:ID!,$commentsAfter:String){
  node(id:$id){
    ... on PullRequestReviewThread {
      comments(first:50, after:$commentsAfter){
        nodes{ id body createdAt diffHunk author{ login } }
        pageInfo{ hasNextPage endCursor }
      }
    }
  }
}"#;

impl Forge for GitHubForge {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            pull_requests: true,
            checks: true,
            review_threads: true,
            resolve_threads: true,
            merge: true,
        }
    }

    fn auth_state(&self) -> AuthState {
        match (&self.token, self.transport.suspect.load(std::sync::atomic::Ordering::Relaxed)) {
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
        Ok(Viewer {
            login: str_at(&v, "login"),
            avatar_url: v.get("avatar_url").and_then(|a| a.as_str()).map(|s| s.to_string()),
        })
    }

    fn pull_request_for_branch(
        &self,
        repo: &RepoRef,
        branch: &str,
    ) -> Result<Option<PullRequest>, ForgeError> {
        self.require_token()?;
        // Scoped by `head=owner:branch`, so two projects with a branch of the
        // same name cannot collide: the qualifier is remote-scoped.
        let path = format!(
            "/repos/{}/{}/pulls?state=open&head={}:{}&per_page=1",
            repo.owner, repo.repo, repo.owner, branch
        );
        let v = self.send(self.rest("GET", &path, None))?;
        match v.as_array().and_then(|a| a.first()) {
            Some(pr) => pr_from_rest(pr).map(Some),
            None => Ok(None),
        }
    }

    fn list_pull_requests(&self, repo: &RepoRef) -> Result<Paged<PullRequest>, ForgeError> {
        self.require_token()?;
        let path = format!("/repos/{}/{}/pulls?state=open&per_page=100", repo.owner, repo.repo);
        let (items, truncated) =
            paginate_rest(self.transport.as_ref(), self.rest("GET", &path, None), PAGE_CAP)?;
        let items = items.iter().map(pr_from_rest).collect::<Result<Vec<_>, _>>()?;
        Ok(Paged { items, truncated })
    }

    fn pull_request_files(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<Paged<PrFile>, ForgeError> {
        self.require_token()?;
        let path = format!(
            "/repos/{}/{}/pulls/{number}/files?per_page={PR_FILES_PER_PAGE}",
            repo.owner, repo.repo
        );
        let (items, truncated) = paginate_rest(
            self.transport.as_ref(),
            self.rest("GET", &path, None),
            PR_FILE_PAGES,
        )?;
        let items = items.iter().map(file_from_rest).collect::<Result<Vec<_>, _>>()?;
        Ok(Paged { items, truncated })
    }

    fn create_pull_request(
        &self,
        repo: &RepoRef,
        req: &CreatePr,
    ) -> Result<PullRequest, ForgeError> {
        self.require_token()?;
        let body = serde_json::json!({
            "title": req.title,
            "body": req.body,
            "head": req.head,
            "base": req.base,
            "draft": req.draft,
        });
        let path = format!("/repos/{}/{}/pulls", repo.owner, repo.repo);
        let v = self.send(self.rest("POST", &path, Some(body)))?;
        pr_from_rest(&v)
    }

    fn unit_statuses(
        &self,
        repo: &RepoRef,
        branches: &[String],
    ) -> Result<Vec<UnitStatus>, ForgeError> {
        self.require_token()?;
        if branches.is_empty() {
            return Ok(vec![]);
        }
        // One aliased selection per branch, all in a single request. The whole
        // point: the rate budget scales with unit count, so per-unit requests
        // are what exhausts it on idle polling.
        let selections = branches
            .iter()
            .enumerate()
            .map(|(i, b)| {
                format!(
                    "u{i}: pullRequests(headRefName:{}, states:[OPEN], first:1) {{ nodes {{ {PR_FIELDS} }} }}",
                    serde_json::Value::String(b.clone())
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let query = format!(
            "query($owner:String!,$repo:String!){{ repository(owner:$owner,name:$repo){{\n{selections}\n}} }}"
        );
        let data = self
            .graphql(&query, serde_json::json!({ "owner": repo.owner, "repo": repo.repo }))?;
        let repository = data.get("repository").ok_or_else(|| ForgeError::Malformed {
            message: "no repository in response".into(),
        })?;

        Ok(branches
            .iter()
            .enumerate()
            .map(|(i, branch)| {
                let node = repository
                    .get(format!("u{i}"))
                    .and_then(|c| c.get("nodes"))
                    .and_then(|n| n.as_array())
                    .and_then(|n| n.first());
                let Some(node) = node else {
                    return UnitStatus {
                        head_ref: branch.clone(),
                        pull_request: None,
                        checks: CheckRollup { state: CheckState::None, total: 0, failing: 0 },
                        review_decision: ReviewDecision::None,
                    };
                };
                let rollup = node
                    .get("commits")
                    .and_then(|c| c.get("nodes"))
                    .and_then(|n| n.as_array())
                    .and_then(|n| n.first())
                    .and_then(|n| n.get("commit"))
                    .and_then(|c| c.get("statusCheckRollup"));
                UnitStatus {
                    head_ref: branch.clone(),
                    pull_request: Some(pr_from_graphql(node)),
                    checks: checks_from_rollup(rollup),
                    review_decision: review_decision_from(
                        node.get("reviewDecision").and_then(|r| r.as_str()),
                    ),
                }
            })
            .collect())
    }

    fn review_threads(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<Paged<ReviewThread>, ForgeError> {
        self.require_token()?;
        let nested = NestedSpec {
            key: "comments".into(),
            query: THREAD_COMMENTS_QUERY.into(),
            id_var: "id".into(),
            cursor_var: "commentsAfter".into(),
            path: vec!["node".into(), "comments".into()],
        };
        let headers = self.headers();
        let (nodes, truncated) = paginate_graphql(
            &GraphqlEndpoint {
                transport: self.transport.as_ref(),
                url: &self.graphql_url,
                headers: &headers,
            },
            THREADS_QUERY,
            &serde_json::json!({ "owner": repo.owner, "repo": repo.repo, "number": number }),
            &ConnectionSpec {
                path: vec!["repository".into(), "pullRequest".into(), "reviewThreads".into()],
                cursor_var: "after".into(),
            },
            Some(&nested),
            PAGE_CAP,
        )?;
        Ok(Paged { items: nodes.iter().map(thread_from_graphql).collect(), truncated })
    }

    fn reply_to_thread(
        &self,
        _repo: &RepoRef,
        thread_id: &str,
        body: &str,
    ) -> Result<(), ForgeError> {
        self.require_token()?;
        // GraphQL, despite replies being a REST-friendly operation: the caller
        // holds a thread node id, and the REST reply endpoint keys off a numeric
        // *comment* id it has no way to know.
        let query = r#"
mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId, body:$body}){
    comment { id }
  }
}"#;
        self.graphql(query, serde_json::json!({ "threadId": thread_id, "body": body }))?;
        Ok(())
    }

    fn set_thread_resolved(&self, thread_id: &str, resolved: bool) -> Result<(), ForgeError> {
        self.require_token()?;
        // The reason threads are read over GraphQL at all: this mutation takes a
        // `PullRequestReviewThread` node id, and REST never produces one.
        let query = if resolved {
            "mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { id isResolved } } }"
        } else {
            "mutation($id:ID!){ unresolveReviewThread(input:{threadId:$id}){ thread { id isResolved } } }"
        };
        self.graphql(query, serde_json::json!({ "id": thread_id }))?;
        Ok(())
    }

    fn mergeability(&self, repo: &RepoRef, number: u64) -> Result<MergeableState, ForgeError> {
        self.require_token()?;
        // Asked, not computed. GitHub accounts for branch protection and
        // required checks that Sway cannot see, so a local verdict would render
        // an enabled button the server then refuses.
        let path = format!("/repos/{}/{}/pulls/{number}", repo.owner, repo.repo);
        let v = self.send(self.rest("GET", &path, None))?;
        Ok(mergeable_from_rest(&v))
    }

    fn merge(&self, repo: &RepoRef, number: u64, method: MergeMethod) -> Result<(), ForgeError> {
        self.require_token()?;
        let method = match method {
            MergeMethod::Merge => "merge",
            MergeMethod::Squash => "squash",
            MergeMethod::Rebase => "rebase",
        };
        let path = format!("/repos/{}/{}/pulls/{number}/merge", repo.owner, repo.repo);
        self.send(self.rest("PUT", &path, Some(serde_json::json!({ "merge_method": method }))))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::http::test_support::StubTransport;
    use super::*;

    fn repo() -> RepoRef {
        RepoRef { owner: "skarif2".into(), repo: "sway".into() }
    }

    /// A signed-in client over a scripted transport, plus a handle on that
    /// transport so a test can read back what was actually sent.
    fn forge(
        responses: Vec<super::super::http::HttpResponse>,
    ) -> (GitHubForge, std::sync::Arc<StubTransport>) {
        let stub = std::sync::Arc::new(StubTransport::new(responses));
        let f = GitHubForge::new(Box::new(stub.clone()), Some("gho_test".into()), None)
            .with_base("https://api.test");
        (f, stub)
    }

    #[test]
    fn every_remote_shape_resolves_to_the_same_repo() {
        let want = repo();
        for url in [
            "https://github.com/skarif2/sway.git",
            "https://github.com/skarif2/sway",
            "git@github.com:skarif2/sway.git",
            "ssh://git@github.com/skarif2/sway.git",
            "https://github.com/skarif2/sway/",
        ] {
            assert_eq!(parse_remote(url).unwrap(), want, "failed on {url}");
        }
    }

    #[test]
    fn a_non_github_remote_is_its_own_error_not_a_generic_failure() {
        // This is what lets the sidebar render a GitLab unit as inert instead of
        // as "no PR yet" behind a create button that cannot work.
        assert_eq!(
            parse_remote("git@gitlab.com:acme/widgets.git"),
            Err(ForgeError::UnsupportedRemote { host: "gitlab.com".into() })
        );
        assert_eq!(
            parse_remote("https://bitbucket.org/acme/widgets.git"),
            Err(ForgeError::UnsupportedRemote { host: "bitbucket.org".into() })
        );
        assert_eq!(parse_remote(""), Err(ForgeError::NoRemote));
        // A host with no repo path is unsupported, not a panic.
        assert!(parse_remote("https://github.com/skarif2").is_err());
    }

    #[test]
    fn a_canned_rate_limit_response_surfaces_as_a_rate_limit_through_the_client() {
        let (f, _stub) = forge(vec![StubTransport::with_headers(
            403,
            &[("X-RateLimit-Remaining", "0"), ("X-RateLimit-Limit", "5000"), ("X-RateLimit-Reset", "1780000000")],
            r#"{"message":"API rate limit exceeded"}"#,
        )]);
        let err = f.pull_request_for_branch(&repo(), "wave-3").unwrap_err();
        assert!(
            matches!(err, ForgeError::RateLimited { kind: super::super::RateLimitKind::Primary, .. }),
            "got {err:?}"
        );
        // The headers are captured even on the refusal, which is what lets the
        // scheduler back off with a real deadline instead of guessing.
        let rate = f.rate_snapshot();
        assert_eq!(rate.remaining, Some(0));
        assert_eq!(rate.limit, Some(5000));
        assert_eq!(rate.reset_at, Some(1780000000));
    }

    #[test]
    fn a_canned_error_body_keeps_its_shape_through_the_client() {
        let (f, _stub) = forge(vec![StubTransport::json(
            422,
            r#"{"message":"A pull request already exists for skarif2:wave-3."}"#,
        )]);
        let err = f
            .create_pull_request(
                &repo(),
                &CreatePr {
                    title: "t".into(),
                    body: "b".into(),
                    head: "wave-3".into(),
                    base: "main".into(),
                    draft: false,
                },
            )
            .unwrap_err();
        assert_eq!(
            err,
            ForgeError::AlreadyExists {
                message: "A pull request already exists for skarif2:wave-3.".into()
            }
        );
    }

    #[test]
    fn a_401_makes_the_credential_suspect_without_forgetting_the_token() {
        let (f, _stub) = forge(vec![StubTransport::json(401, r#"{"message":"Bad credentials"}"#)]);
        assert_eq!(f.auth_state(), AuthState::SignedIn { login: String::new() });
        assert_eq!(f.viewer().unwrap_err(), ForgeError::CredentialSuspect);
        // Suspect, not signed out: the keychain entry is untouched, so a
        // transient 401 does not cost a full device-flow re-auth.
        assert_eq!(f.auth_state(), AuthState::Suspect { login: None });
        assert!(f.token.is_some(), "the token is kept, not cleared");
    }

    #[test]
    fn a_401_on_a_later_page_is_recorded_like_a_401_on_the_first_call() {
        // The paginating paths hand the transport to a walker that loops on it
        // directly, so anything recorded only in `GitHubForge::send` would be
        // skipped by every paged call. Page one succeeds here specifically so
        // the failure happens somewhere `send` never sees.
        let link = "<https://api.test/repos/skarif2/sway/pulls?page=2>; rel=\"next\"";
        let (f, _stub) = forge(vec![
            StubTransport::with_headers(
                200,
                &[("Link", link), ("X-RateLimit-Remaining", "4000")],
                r#"[{"number":1,"state":"open","user":{"login":"me"},
                    "head":{"ref":"b","sha":"s"},"base":{"ref":"main"}}]"#,
            ),
            StubTransport::with_headers(
                401,
                &[("X-RateLimit-Remaining", "3999")],
                r#"{"message":"Bad credentials"}"#,
            ),
        ]);
        assert_eq!(f.list_pull_requests(&repo()).unwrap_err(), ForgeError::CredentialSuspect);
        assert_eq!(f.auth_state(), AuthState::Suspect { login: None });
        // And the rate headers from the paged responses landed too.
        assert_eq!(f.rate_snapshot().remaining, Some(3999));
    }

    #[test]
    fn a_transient_401_stops_being_suspect_once_a_call_answers() {
        // A proxy or a forge incident can answer 401 once. If the flag latched
        // forever the user would be told to sign in again to fix something that
        // had already fixed itself.
        let (f, _stub) = forge(vec![
            StubTransport::json(401, r#"{"message":"Bad credentials"}"#),
            StubTransport::json(200, r#"{"login":"skarif2"}"#),
        ]);
        assert_eq!(f.viewer().unwrap_err(), ForgeError::CredentialSuspect);
        assert_eq!(f.auth_state(), AuthState::Suspect { login: None });

        // The same token, retried, with nothing re-authenticated.
        assert_eq!(f.viewer().unwrap().login, "skarif2");
        assert_eq!(f.auth_state(), AuthState::SignedIn { login: String::new() });
    }

    #[test]
    fn the_batched_query_never_claims_a_pr_is_mergeable() {
        // GraphQL's `mergeable` reports merge *conflicts* only and knows nothing
        // about branch protection, so MERGEABLE must not become `Clean`: that
        // would hand the merge guard a green light for a PR the server refuses.
        let (f, _stub) = forge(vec![StubTransport::json(
            200,
            r#"{"data":{"repository":{"u0":{"nodes":[{"number":1,"state":"OPEN","headRefName":"a",
                "mergeable":"MERGEABLE","author":{"login":"me"},
                "commits":{"nodes":[{"commit":{"oid":"s"}}]}}]}}}}"#,
        )]);
        let statuses = f.unit_statuses(&repo(), &["a".to_string()]).unwrap();
        assert_eq!(
            statuses[0].pull_request.as_ref().unwrap().mergeable_state,
            MergeableState::Unknown,
            "MERGEABLE means no conflicts, not permission to merge"
        );

        // A conflict is the one thing GraphQL does answer definitively.
        let (f, _stub) = forge(vec![StubTransport::json(
            200,
            r#"{"data":{"repository":{"u0":{"nodes":[{"number":1,"state":"OPEN","headRefName":"a",
                "mergeable":"CONFLICTING","author":{"login":"me"},
                "commits":{"nodes":[{"commit":{"oid":"s"}}]}}]}}}}"#,
        )]);
        let statuses = f.unit_statuses(&repo(), &["a".to_string()]).unwrap();
        assert_eq!(
            statuses[0].pull_request.as_ref().unwrap().mergeable_state,
            MergeableState::Dirty
        );
    }

    #[test]
    fn signed_out_never_reaches_the_network() {
        let t = StubTransport::new(vec![]);
        let f = GitHubForge::new(Box::new(t), None, None).with_base("https://api.test");
        assert_eq!(f.auth_state(), AuthState::SignedOut);
        // Not "returns an error after asking": it must not reach the wire at all.
        assert_eq!(
            f.pull_request_for_branch(&repo(), "wave-3").unwrap_err(),
            ForgeError::NotAuthenticated
        );
    }

    #[test]
    fn a_pr_lookup_maps_the_wire_shape_onto_the_model() {
        let (f, _stub) = forge(vec![StubTransport::json(
            200,
            r#"[{"number":42,"title":"Wave 3","body":"hi","state":"open","draft":true,
                "merged_at":null,"html_url":"https://github.com/skarif2/sway/pull/42",
                "mergeable_state":"blocked",
                "user":{"login":"skarif2"},
                "head":{"ref":"wave-3","sha":"abc123"},
                "base":{"ref":"main"}}]"#,
        )]);
        let pr = f.pull_request_for_branch(&repo(), "wave-3").unwrap().unwrap();
        assert_eq!(pr.number, 42);
        assert_eq!(pr.state, PrState::Open);
        assert!(pr.is_draft);
        assert_eq!(pr.author, "skarif2");
        assert_eq!(pr.head_sha, "abc123");
        assert_eq!(pr.mergeable_state, MergeableState::Blocked);
    }

    #[test]
    fn no_open_pr_for_the_branch_is_none_not_an_error() {
        let (f, _stub) = forge(vec![StubTransport::json(200, "[]")]);
        assert_eq!(f.pull_request_for_branch(&repo(), "wave-3").unwrap(), None);
    }

    #[test]
    fn a_merged_pr_is_merged_not_closed() {
        // The list endpoint omits `merged`, so reading the timestamp is what
        // keeps this correct on both endpoints.
        let (f, _stub) = forge(vec![StubTransport::json(
            200,
            r#"[{"number":1,"state":"closed","merged_at":"2026-08-01T00:00:00Z",
                "user":{"login":"a"},"head":{"ref":"x","sha":"s"},"base":{"ref":"main"}}]"#,
        )]);
        let pr = f.pull_request_for_branch(&repo(), "x").unwrap().unwrap();
        assert_eq!(pr.state, PrState::Merged);
    }

    #[test]
    fn many_branches_cost_one_request_not_one_each() {
        // The batching contract, asserted as a request count. Three branches
        // times three concerns would be nine calls over REST.
        let (f, _stub) = forge(vec![StubTransport::json(
            200,
            r#"{"data":{"repository":{
                "u0":{"nodes":[{"number":1,"state":"OPEN","headRefName":"a","author":{"login":"me"},
                      "reviewDecision":"CHANGES_REQUESTED",
                      "commits":{"nodes":[{"commit":{"oid":"s1","statusCheckRollup":{
                        "state":"FAILURE",
                        "contexts":{"totalCount":3,"nodes":[{"conclusion":"FAILURE"},{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"}]}
                      }}}]}}]},
                "u1":{"nodes":[]},
                "u2":{"nodes":[{"number":7,"state":"OPEN","headRefName":"c","author":{"login":"me"},
                      "reviewDecision":null,
                      "commits":{"nodes":[{"commit":{"oid":"s3","statusCheckRollup":null}}]}}]}
            }}}"#,
        )]);
        let branches = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let statuses = f.unit_statuses(&repo(), &branches).unwrap();

        assert_eq!(statuses.len(), 3);
        assert_eq!(statuses[0].head_ref, "a");
        assert_eq!(statuses[0].checks.state, CheckState::Failure);
        assert_eq!(statuses[0].checks.total, 3);
        assert_eq!(statuses[0].checks.failing, 1);
        assert_eq!(statuses[0].review_decision, ReviewDecision::ChangesRequested);

        // A branch with no PR is a real answer, not a gap in the list.
        assert_eq!(statuses[1].head_ref, "b");
        assert_eq!(statuses[1].pull_request, None);

        // A PR with no CI reads as None, never as permanently pending.
        assert_eq!(statuses[2].checks.state, CheckState::None);
    }

    #[test]
    fn an_empty_branch_list_asks_nothing() {
        let (f, _stub) = forge(vec![]);
        assert_eq!(f.unit_statuses(&repo(), &[]).unwrap(), vec![]);
    }

    #[test]
    fn threads_come_back_with_their_node_ids_and_outdated_flags() {
        let (f, _stub) = forge(vec![StubTransport::json(
            200,
            r#"{"data":{"repository":{"pullRequest":{"reviewThreads":{
                "nodes":[
                  {"id":"PRRT_1","path":"src/a.rs","line":12,"isResolved":false,"isOutdated":false,
                   "comments":{"nodes":[{"id":"C1","body":"nit","createdAt":"2026-08-01T00:00:00Z",
                     "diffHunk":"@@ -1 +1 @@","author":{"login":"me"}}],
                     "pageInfo":{"hasNextPage":false,"endCursor":null}}},
                  {"id":"PRRT_2","path":"src/b.rs","line":null,"isResolved":true,"isOutdated":true,
                   "comments":{"nodes":[{"id":"C2","body":"old","createdAt":"2026-08-01T00:00:00Z",
                     "diffHunk":"@@ -9 +9 @@","author":{"login":"me"}}],
                     "pageInfo":{"hasNextPage":false,"endCursor":null}}}
                ],
                "pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}"#,
        )]);
        let threads = f.review_threads(&repo(), 42).unwrap();
        assert!(!threads.truncated);
        assert_eq!(threads.items.len(), 2);

        // The node id is the whole reason this read is GraphQL: resolve needs it.
        assert_eq!(threads.items[0].id, "PRRT_1");
        assert_eq!(threads.items[0].diff_hunk, "@@ -1 +1 @@");
        assert_eq!(threads.items[0].comments.len(), 1);

        // An outdated thread has no line, which is what routes it to the
        // outdated group rather than onto a line that moved.
        assert_eq!(threads.items[1].line, None);
        assert!(threads.items[1].is_outdated);
    }

    #[test]
    fn resolve_and_unresolve_are_the_same_intent_with_different_mutations() {
        let ok = || StubTransport::json(200, r#"{"data":{"resolveReviewThread":{"thread":{"id":"T"}}}}"#);
        let (f, stub) = forge(vec![ok(), ok()]);

        f.set_thread_resolved("PRRT_1", true).unwrap();
        f.set_thread_resolved("PRRT_1", false).unwrap();

        // Same call shape from the caller's side; only the document differs.
        let seen = stub.bodies();
        assert!(seen[0].contains("resolveReviewThread"));
        assert!(seen[1].contains("unresolveReviewThread"));
        assert!(seen[0].contains("PRRT_1"));
    }

    #[test]
    fn a_merge_refusal_carries_the_servers_own_reason() {
        // GitHub knows about branch protection Sway cannot see, so its wording
        // is the only useful thing to show.
        let (f, _stub) = forge(vec![StubTransport::json(
            405,
            r#"{"message":"At least 1 approving review is required by reviewers with write access."}"#,
        )]);
        let err = f.merge(&repo(), 42, MergeMethod::Squash).unwrap_err();
        assert_eq!(
            err,
            ForgeError::NotMergeable {
                message: "At least 1 approving review is required by reviewers with write access."
                    .into()
            }
        );
    }

    #[test]
    fn mergeability_is_read_from_the_server_including_still_computing() {
        let (f, _stub) = forge(vec![StubTransport::json(200, r#"{"mergeable":null,"mergeable_state":"unknown"}"#)]);
        // `null` means "still computing", which must read as Unknown (ask
        // again), never as a green light.
        assert_eq!(f.mergeability(&repo(), 1).unwrap(), MergeableState::Unknown);

        let (f, _stub) = forge(vec![StubTransport::json(200, r#"{"mergeable":true,"mergeable_state":"behind"}"#)]);
        assert_eq!(f.mergeability(&repo(), 1).unwrap(), MergeableState::Behind);
    }

    #[test]
    fn an_unrecognised_mergeable_state_is_unknown_not_clean() {
        // A state string GitHub adds later must not read as a green light.
        let (f, _stub) = forge(vec![StubTransport::json(200, r#"{"mergeable_state":"something_new"}"#)]);
        assert_eq!(f.mergeability(&repo(), 1).unwrap(), MergeableState::Unknown);
    }

    #[test]
    fn the_pr_list_pages_to_exhaustion() {
        let link = "<https://api.test/repos/skarif2/sway/pulls?page=2>; rel=\"next\"";
        let pr = |n: u32| {
            format!(
                r#"{{"number":{n},"state":"open","user":{{"login":"me"}},
                    "head":{{"ref":"b{n}","sha":"s"}},"base":{{"ref":"main"}}}}"#
            )
        };
        let (f, _stub) = forge(vec![
            StubTransport::with_headers(200, &[("Link", link)], &format!("[{},{}]", pr(1), pr(2))),
            StubTransport::json(200, &format!("[{}]", pr(3))),
        ]);
        let list = f.list_pull_requests(&repo()).unwrap();
        assert_eq!(list.items.len(), 3);
        assert!(!list.truncated);
    }

    #[test]
    fn a_changed_file_keeps_the_status_and_the_patch_the_api_computed() {
        // Four statuses that render four different ways, and the rename's
        // `previous_filename`, which is the only thing saying where the file
        // came from: without it a rename reads as an addition beside a deletion.
        let body = r#"[
            {"filename":"src/new.ts","status":"added","additions":9,"deletions":0,
             "patch":"@@ -0,0 +1,9 @@\n+const a = 1;"},
            {"filename":"src/old.ts","status":"removed","additions":0,"deletions":4,
             "patch":"@@ -1,4 +0,0 @@\n-const b = 2;"},
            {"filename":"src/edit.ts","status":"modified","additions":1,"deletions":1,
             "patch":"@@ -1,1 +1,1 @@\n-a\n+b"},
            {"filename":"src/to.ts","status":"renamed","previous_filename":"src/from.ts",
             "additions":0,"deletions":0}
        ]"#;
        let (f, _stub) = forge(vec![StubTransport::json(200, body)]);
        let files = f.pull_request_files(&repo(), 12).unwrap();

        assert_eq!(files.items.len(), 4);
        assert!(!files.truncated);
        assert_eq!(files.items[0].status, FileStatus::Added);
        assert_eq!(files.items[1].status, FileStatus::Removed);
        assert_eq!(files.items[2].status, FileStatus::Modified);
        assert_eq!(files.items[3].status, FileStatus::Renamed);
        assert_eq!(files.items[3].previous_path.as_deref(), Some("src/from.ts"));
        assert_eq!(files.items[0].previous_path, None);
        // The patch is the API's own text, carried through byte for byte: it is
        // what Phase 10's thread anchors are measured against.
        assert_eq!(files.items[2].patch.as_deref(), Some("@@ -1,1 +1,1 @@\n-a\n+b"));
        // A pure rename has no patch at all, which is not the same as an empty
        // one and must not render as a file with no changes to show.
        assert_eq!(files.items[3].patch, None);
    }

    #[test]
    fn a_file_list_past_the_api_ceiling_reports_truncation_rather_than_a_short_list() {
        // The failure this prevents: a 400-file PR showing 300 files and looking
        // entirely healthy doing it. Three pages is the whole budget, so a
        // fourth `Link` is the server saying it has stopped describing the PR.
        let file = |n: usize| format!(r#"{{"filename":"f{n}.ts","status":"modified","patch":"@@"}}"#);
        let page = |from: usize| {
            let items: Vec<String> = (from..from + 100).map(file).collect();
            format!("[{}]", items.join(","))
        };
        let next = |p: u32| {
            format!("<https://api.test/repos/skarif2/sway/pulls/1/files?page={p}>; rel=\"next\"")
        };
        let (f, stub) = forge(vec![
            StubTransport::with_headers(200, &[("Link", &next(2))], &page(0)),
            StubTransport::with_headers(200, &[("Link", &next(3))], &page(100)),
            StubTransport::with_headers(200, &[("Link", &next(4))], &page(200)),
        ]);

        let files = f.pull_request_files(&repo(), 1).unwrap();
        assert_eq!(files.items.len(), PR_FILE_CAP);
        assert!(files.truncated, "the cap was hit and nothing said so");
        // And it stopped at the ceiling rather than walking on: a fourth page
        // would be a request spent on files the API will not finish sending.
        assert_eq!(stub.request_count(), PR_FILE_PAGES);
    }

    #[test]
    fn every_request_carries_the_headers_github_requires() {
        let (f, stub) = forge(vec![StubTransport::json(200, "[]")]);
        f.pull_request_for_branch(&repo(), "wave-3").unwrap();
        let seen = stub.requests()[0].headers.clone();
        assert!(seen.iter().any(|(k, _)| k == "User-Agent"), "GitHub rejects a call with none");
        assert!(seen.iter().any(|(k, v)| k == "Authorization" && v.starts_with("Bearer ")));
        assert!(seen.iter().any(|(k, _)| k == "X-GitHub-Api-Version"));
    }

}
