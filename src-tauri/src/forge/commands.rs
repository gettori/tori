//! The Tauri surface of the forge layer.
//!
//! Thin by design: every command here is a wrapper over a tested core in
//! `auth`, `device_flow` or `token`. Nothing below `commands.rs` touches Tauri,
//! which is the same one-directional layering the chat host uses.
//!
//! The in-flight device flow lives in [`DeviceFlowState`] rather than crossing
//! to the frontend, because a `device_code` is a secret: whoever holds one can
//! complete the exchange. The frontend gets a user code and a URL.

use super::device_flow::{self, DevicePrompt, PendingFlow, PollOutcome};
use super::http::UreqTransport;
use super::model::{
    AuthState, DraftComment, Paged, PrFile, PullRequest, RepoRef, ReviewComment, ReviewEvent,
    ReviewThread, StatusReport,
};
use super::{auth, github, prs, status, token, CreatePr, Forge, ForgeError};
use serde::Serialize;
use std::sync::Mutex;

#[derive(Default)]
pub struct DeviceFlowState(pub Mutex<Option<PendingFlow>>);

/// A `ForgeError` as the frontend sees it: a stable `kind` to branch on plus a
/// sentence to show.
///
/// The kind is what the UI switches on, so it must not be the display string:
/// a reworded message would silently change behaviour.
///
/// The two rate-limit fields ride along for the poll scheduler, which has to
/// back off by *the server's own* number. Parsing "retry in 60s" back out of the
/// sentence would work right up until the sentence is reworded, which is the
/// same trap the `kind` exists to avoid.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeErrorDto {
    pub kind: String,
    pub message: String,
    /// Which limit was hit, for the failures that are one. Primary and secondary
    /// limits need different backoff, and only the server can say which.
    pub rate_limit_kind: Option<String>,
    /// The server's own `Retry-After`, when it gave one. A secondary limit
    /// usually does; a primary one usually does not, and carries the field
    /// below instead.
    pub retry_after_secs: Option<u64>,
    /// Unix seconds at which the primary budget refills. The number that lets a
    /// 403 resume on time rather than after a fixed guess.
    pub reset_at_secs: Option<u64>,
}

impl From<ForgeError> for ForgeErrorDto {
    fn from(e: ForgeError) -> Self {
        let (rate_limit_kind, retry_after_secs, reset_at_secs) = match &e {
            ForgeError::RateLimited { kind, retry_after_secs, reset_at_secs } => (
                Some(
                    match kind {
                        super::RateLimitKind::Primary => "primary",
                        super::RateLimitKind::Secondary => "secondary",
                    }
                    .to_string(),
                ),
                *retry_after_secs,
                *reset_at_secs,
            ),
            _ => (None, None, None),
        };
        let kind = match &e {
            ForgeError::NoRemote => "noRemote",
            ForgeError::UnsupportedRemote { .. } => "unsupportedRemote",
            ForgeError::NotAuthenticated => "notAuthenticated",
            ForgeError::CredentialSuspect => "credentialSuspect",
            ForgeError::Forbidden { .. } => "forbidden",
            ForgeError::RateLimited { .. } => "rateLimited",
            ForgeError::NotFound => "notFound",
            ForgeError::AlreadyExists { .. } => "alreadyExists",
            ForgeError::NotMergeable { .. } => "notMergeable",
            ForgeError::Api { .. } => "api",
            ForgeError::Transport { .. } => "transport",
            ForgeError::Malformed { .. } => "malformed",
        };
        Self {
            kind: kind.into(),
            message: e.to_string(),
            rate_limit_kind,
            retry_after_secs,
            reset_at_secs,
        }
    }
}

/// What a poll turn tells the frontend.
///
/// The token is deliberately absent: it goes straight to the keychain on the
/// Rust side and never crosses the bridge.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PollReport {
    Authorized { login: String },
    Pending { next_interval_secs: u64 },
    Denied,
    Expired,
}

#[tauri::command]
pub fn github_auth_state() -> AuthState {
    auth::state()
}

#[tauri::command]
pub fn github_is_configured() -> bool {
    device_flow::is_configured()
}

/// Starts a device flow, holding the secret half in Rust.
#[tauri::command]
pub fn github_device_start(
    state: tauri::State<'_, DeviceFlowState>,
) -> Result<DevicePrompt, ForgeErrorDto> {
    let (prompt, pending) = device_flow::start(&UreqTransport::default())?;
    *state.0.lock().unwrap() = Some(pending);
    Ok(prompt)
}

/// One poll turn. The frontend owns the waiting, using the interval reported
/// back, so a `slow_down` actually slows the caller down.
#[tauri::command]
pub fn github_device_poll(
    state: tauri::State<'_, DeviceFlowState>,
) -> Result<PollReport, ForgeErrorDto> {
    let pending = state.0.lock().unwrap().clone();
    let Some(flow) = pending else {
        return Err(ForgeError::NotAuthenticated.into());
    };
    let outcome = device_flow::poll_once(&UreqTransport::default(), &flow)?;
    Ok(match outcome {
        PollOutcome::Authorized { token: t } => {
            // Straight to the keychain; the token never reaches the frontend.
            auth::sign_in(t, None)?;
            state.0.lock().unwrap().take();
            // Ask who it belongs to. Without this the account is never named
            // anywhere: the signed-in row reads "Signed in as GitHub", and the
            // suspect notice cannot say which account stopped working, which is
            // the one thing that makes it actionable.
            PollReport::Authorized { login: learn_login().unwrap_or_default() }
        }
        // Both waiting outcomes report the interval to use next, so the caller
        // never has to know which one changed it.
        PollOutcome::Pending { next_interval_secs } | PollOutcome::SlowDown { next_interval_secs } => {
            if let Some(f) = state.0.lock().unwrap().as_mut() {
                f.interval_secs = next_interval_secs;
            }
            PollReport::Pending { next_interval_secs }
        }
        PollOutcome::Denied => {
            state.0.lock().unwrap().take();
            PollReport::Denied
        }
        PollOutcome::Expired => {
            state.0.lock().unwrap().take();
            PollReport::Expired
        }
    })
}

#[tauri::command]
pub fn github_device_cancel(state: tauri::State<'_, DeviceFlowState>) {
    state.0.lock().unwrap().take();
}

/// Signs out. The only thing in the app that deletes the credential.
#[tauri::command]
pub fn github_sign_out() -> Result<(), ForgeErrorDto> {
    auth::sign_out().map_err(Into::into)
}

// --- pull requests ---

/// Resolves a checkout to the repo its `origin` points at.
///
/// The two ways this fails are deliberately different errors, not one "cannot
/// find a repo": a project with no remote can still get a remote added, while a
/// GitLab remote never will. The sidebar renders the second as inert rather than
/// offering a create button that cannot work.
fn repo_ref(project_path: &str) -> Result<RepoRef, ForgeError> {
    match crate::git::git_origin(project_path.to_string()) {
        Ok(Some(url)) => github::parse_remote(&url),
        Ok(None) => Err(ForgeError::NoRemote),
        Err(message) => Err(ForgeError::Transport { message }),
    }
}

/// The PR for a branch, from the cache when it can be.
///
/// `refresh` is the manual-refresh path. Nothing here is persisted: see
/// [`super::prs`] for why the association is always a query.
#[tauri::command]
pub fn github_pr_for_branch(
    project_path: String,
    branch: String,
    refresh: bool,
) -> Result<Option<PullRequest>, ForgeErrorDto> {
    let repo = repo_ref(&project_path)?;
    let out = prs::cached_lookup(&repo, &branch, refresh, || {
        let result = client().pull_request_for_branch(&repo, &branch);
        auth::note_result(&result);
        result
    })?;
    Ok(out)
}

/// What the frontend sends to open a pull request.
///
/// One payload rather than five loose arguments, so the create and the
/// push-then-create commands cannot drift apart on their field list.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPr {
    pub title: String,
    pub body: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
}

impl From<NewPr> for CreatePr {
    fn from(n: NewPr) -> Self {
        CreatePr { title: n.title, body: n.body, head: n.head, base: n.base, draft: n.draft }
    }
}

/// Opens a pull request, then makes it immediately visible to the next lookup.
#[tauri::command]
pub fn github_create_pr(
    project_path: String,
    new_pr: NewPr,
) -> Result<PullRequest, ForgeErrorDto> {
    let repo = repo_ref(&project_path)?;
    let result = client().create_pull_request(&repo, &new_pr.into());
    auth::note_result(&result);
    let pr = result?;
    prs::record_created(&repo, pr.clone());
    Ok(pr)
}

/// Pushes the branch, then opens a pull request for it.
///
/// The push is blocking here rather than the usual fire-and-forget, because the
/// create must not run until the head exists on the remote. See
/// [`prs::push_then_create`].
#[tauri::command]
pub fn github_push_and_create_pr(
    state: tauri::State<'_, crate::askpass::AskpassState>,
    project_path: String,
    remote: String,
    new_pr: NewPr,
) -> Result<PullRequest, ForgeErrorDto> {
    let repo = repo_ref(&project_path)?;
    let inner = state.0.clone();
    // The branch pushed is the PR's own head, read from the same payload the
    // create uses. Taking it as a separate argument is how the two end up
    // disagreeing, and a PR opened against a branch that was never pushed is
    // exactly the failure this command exists to prevent.
    let head = new_pr.head.clone();
    let req: CreatePr = new_pr.into();
    let pr = prs::push_then_create(
        || crate::git::push_branch(&project_path, &remote, &head, inner.sock_path(), inner.token()),
        || {
            let result = client().create_pull_request(&repo, &req);
            auth::note_result(&result);
            result
        },
    )?;
    prs::record_created(&repo, pr.clone());
    Ok(pr)
}

/// One poll tick for a project: PR state, checks and review decision for as many
/// of `branches` as this tick covers.
///
/// `branches` is in the caller's priority order (visible units first), because
/// the frontend is the only side that knows what is on screen. Everything past
/// the per-tick cap comes back as `uncovered` rather than being dropped; see
/// [`super::status`].
///
/// The credential gate is a backstop, not the mechanism: the scheduler pauses
/// itself when signed out, suspect, or switched off. This is what makes "no
/// request" true even if a caller forgets, which matters most for the kill
/// switch, whose whole job is to stop the traffic.
#[tauri::command]
pub fn github_unit_statuses(
    project_path: String,
    branches: Vec<String>,
    refresh: bool,
) -> Result<StatusReport, ForgeErrorDto> {
    if !auth::may_call() {
        return Err(ForgeError::NotAuthenticated.into());
    }
    let repo = repo_ref(&project_path)?;
    let out = status::cached_tick(&repo, &branches, refresh, |ask| {
        let forge = client();
        let result = forge.unit_statuses(&repo, ask);
        auth::note_result(&result);
        // The snapshot is read whether the call succeeded or not, but only a
        // success carries it out of here: an error path returns the error, and
        // the scheduler backs off on that instead.
        result.map(|statuses| (statuses, forge.rate_snapshot()))
    })?;
    Ok(out)
}

/// Every open pull request on a project, for the Pull Requests panel.
///
/// Deliberately **not** cached and not coalesced, unlike the poll layer. This is
/// a panel the user opened, so a stale answer is worse than a request; the
/// things Phase 5 built its cache for (a tick every two minutes, per project,
/// forever) do not apply to something that happens when somebody clicks.
///
/// The kill switch is checked first for the same reason it is on the poll
/// command: `github.enabled` off has to mean no traffic, not merely no polling.
///
/// Checks and the review decision are **not** joined in here. The panel reads
/// them from the same status store the sidebar chips do, which is what stops a
/// row and its chip from being two answers to one question.
#[tauri::command]
pub fn github_list_prs(project_path: String) -> Result<Paged<PullRequest>, ForgeErrorDto> {
    if !auth::may_call() {
        return Err(ForgeError::NotAuthenticated.into());
    }
    let repo = repo_ref(&project_path)?;
    let result = client().list_pull_requests(&repo);
    auth::note_result(&result);
    Ok(result?)
}

/// Every file one pull request touches, with GitHub's own patch for each.
///
/// Uncached for the same reason as the listing above: this is a view somebody
/// opened, and the poll layer's pacing exists for a tick that runs forever.
///
/// The patches come from the API rather than from a local `git diff` because
/// Phase 10's review threads anchor to the hunks GitHub computed. A locally
/// recomputed diff would read identically and anchor differently, which puts
/// comments on the wrong lines rather than failing outright.
#[tauri::command]
pub fn github_pr_files(
    project_path: String,
    number: u64,
) -> Result<Paged<PrFile>, ForgeErrorDto> {
    if !auth::may_call() {
        return Err(ForgeError::NotAuthenticated.into());
    }
    let repo = repo_ref(&project_path)?;
    let result = client().pull_request_files(&repo, number);
    auth::note_result(&result);
    Ok(result?)
}

/// Every review conversation on one pull request.
///
/// Read over GraphQL, and that is not an optimisation: REST has no thread object
/// at all, only comments carrying an `in_reply_to_id`, and the resolve mutation
/// takes a `PullRequestReviewThread` node id that no REST response ever
/// produces. A thread read the REST way could be displayed and never resolved.
#[tauri::command]
pub fn github_review_threads(
    project_path: String,
    number: u64,
) -> Result<Paged<ReviewThread>, ForgeErrorDto> {
    if !auth::may_call() {
        return Err(ForgeError::NotAuthenticated.into());
    }
    let repo = repo_ref(&project_path)?;
    let result = client().review_threads(&repo, number);
    auth::note_result(&result);
    Ok(result?)
}

/// Reply to a thread, returning the comment the server stored.
///
/// The caller has already drawn the reply optimistically. What comes back is
/// what corrects the three things it had to guess: the id, the author's login,
/// and the timestamp.
#[tauri::command]
pub fn github_reply_to_thread(
    project_path: String,
    thread_id: String,
    body: String,
) -> Result<ReviewComment, ForgeErrorDto> {
    if !auth::may_call() {
        return Err(ForgeError::NotAuthenticated.into());
    }
    let repo = repo_ref(&project_path)?;
    let result = client().reply_to_thread(&repo, &thread_id, &body);
    auth::note_result(&result);
    Ok(result?)
}

/// Resolve or unresolve a thread.
///
/// One command with a boolean rather than two, mirroring the trait: they are the
/// same intent, and a provider that has one has the other.
///
/// `project_path` is not used to address the thread (a node id is global) but is
/// still taken, so the command refuses on a repo the forge cannot serve for the
/// same reason every other one does, rather than being the single door that
/// answers for a GitLab checkout.
#[tauri::command]
pub fn github_set_thread_resolved(
    project_path: String,
    thread_id: String,
    resolved: bool,
) -> Result<(), ForgeErrorDto> {
    if !auth::may_call() {
        return Err(ForgeError::NotAuthenticated.into());
    }
    repo_ref(&project_path)?;
    let result = client().set_thread_resolved(&thread_id, resolved);
    auth::note_result(&result);
    Ok(result?)
}

/// Who the stored token belongs to.
///
/// Served from the credential state when the login is already known, which it is
/// from the moment of sign-in, so the usual answer costs no request. It is
/// fetched only when the credential was restored without one.
///
/// The frontend needs this to decide whether approve and request-changes are
/// even offerable: GitHub rejects both from the pull request's author with a
/// 422, and on a single-owner repo that is every pull request.
///
/// **The login, and only the login.** Not a [`Viewer`]: the cached path knows
/// who the token belongs to and nothing else, and answering `avatar_url: None`
/// there would state the account has no avatar rather than that nobody asked.
/// Returning the one field this command can always answer for keeps the cheap
/// path and the fetched path telling the same kind of truth.
#[tauri::command]
pub fn github_viewer() -> Result<String, ForgeErrorDto> {
    if !auth::may_call() {
        return Err(ForgeError::NotAuthenticated.into());
    }
    if let AuthState::SignedIn { login } = auth::state() {
        if !login.is_empty() {
            return Ok(login);
        }
    }
    let result = client().viewer();
    auth::note_result(&result);
    let viewer = result?;
    auth::note_login(viewer.login.clone());
    Ok(viewer.login)
}

/// Submit a review: a verdict, a body, and the line comments held with it.
///
/// One call, because a review is atomic on the server. Posting the comments
/// first and the verdict second would leave a half-submitted review behind
/// whenever the second call failed, with nothing telling the caller which
/// comments had already landed.
#[tauri::command]
pub fn github_submit_review(
    project_path: String,
    number: u64,
    event: ReviewEvent,
    body: String,
    comments: Vec<DraftComment>,
) -> Result<(), ForgeErrorDto> {
    if !auth::may_call() {
        return Err(ForgeError::NotAuthenticated.into());
    }
    let repo = repo_ref(&project_path)?;
    let result = client().submit_review(&repo, number, event, &body, &comments);
    auth::note_result(&result);
    Ok(result?)
}

/// Restores the credential at startup and installs the keychain store.
///
/// Failure is non-fatal and deliberately so: a keychain that will not open
/// should leave Sway running signed-out, not stop it from starting, the same way
/// the askpass bridge and the tray icon handle their own failures.
pub fn restore_at_startup(enabled: bool) {
    if let Err(e) = token::install_store() {
        log_startup(&format!("forge: {e}"));
        return;
    }
    match token::load() {
        Ok(stored) => {
            let had_token = stored.is_some();
            auth::restore(stored, None, enabled);
            // The login is not stored beside the token, so it has to be asked
            // for again on every launch. Best-effort: a failure here leaves the
            // account unnamed, which is cosmetic, and must not stop startup.
            if had_token && enabled {
                let _ = learn_login();
            }
        }
        Err(e) => {
            log_startup(&format!("forge: {e}"));
            auth::restore(None, None, enabled);
        }
    }
}

/// Asks the forge who the stored token belongs to and records it.
///
/// Routed through [`auth::note_result`] like every other forge call, so a token
/// that has been revoked since last launch is discovered here and marks the
/// credential suspect rather than silently failing.
fn learn_login() -> Option<String> {
    let forge = client();
    let result = forge.viewer();
    auth::note_result(&result);
    let login = result.ok().map(|v| v.login)?;
    auth::note_login(login.clone());
    Some(login)
}

/// A forge client built from the current credential.
///
/// Built per call rather than held: the token can change under it (sign-in,
/// sign-out, re-sign-in), and a cached client would keep using the old one.
pub fn client() -> super::github::GitHubForge {
    super::github::GitHubForge::new(
        Box::new(super::http::UreqTransport::default()),
        auth::token(),
        match auth::state() {
            AuthState::SignedIn { login } => Some(login),
            AuthState::Suspect { login } => login,
            AuthState::SignedOut => None,
        },
    )
}

fn log_startup(message: &str) {
    // Matches the prefix every other non-fatal startup failure uses in lib.rs,
    // so one grep finds them all.
    eprintln!("sway: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_kind_is_stable_and_separate_from_its_wording() {
        // The UI switches on `kind`, so it must not be the message: rewording a
        // sentence would otherwise silently change behaviour.
        let dto: ForgeErrorDto = ForgeError::RateLimited {
            kind: super::super::RateLimitKind::Secondary,
            retry_after_secs: Some(60),
            reset_at_secs: None,
        }
        .into();
        assert_eq!(dto.kind, "rateLimited");
        assert!(dto.message.contains("60"));

        let dto: ForgeErrorDto = ForgeError::CredentialSuspect.into();
        assert_eq!(dto.kind, "credentialSuspect");
    }

    #[test]
    fn every_error_variant_has_its_own_kind() {
        // A duplicated kind would collapse two states the UI must tell apart.
        let all = [
            ForgeError::NoRemote,
            ForgeError::UnsupportedRemote { host: "gitlab.com".into() },
            ForgeError::NotAuthenticated,
            ForgeError::CredentialSuspect,
            ForgeError::Forbidden { message: String::new() },
            ForgeError::RateLimited {
                kind: super::super::RateLimitKind::Primary,
                retry_after_secs: None,
                reset_at_secs: None,
            },
            ForgeError::NotFound,
            ForgeError::AlreadyExists { message: String::new() },
            ForgeError::NotMergeable { message: String::new() },
            ForgeError::Api { status: 500, message: String::new() },
            ForgeError::Transport { message: String::new() },
            ForgeError::Malformed { message: String::new() },
        ];
        let mut kinds: Vec<String> =
            all.iter().cloned().map(|e| ForgeErrorDto::from(e).kind).collect();
        let total = kinds.len();
        kinds.sort();
        kinds.dedup();
        assert_eq!(kinds.len(), total, "two variants share a kind");
    }

    /// A scratch git repo, optionally with an `origin`.
    fn repo_at(origin: Option<&str>) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sway_forge_repo_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap()
        };
        git(&["init"]);
        if let Some(url) = origin {
            git(&["remote", "add", "origin", url]);
        }
        dir
    }

    const TOKEN: &str = "gho_liveTokenThatMustNotLeak";

    fn forge(status: u16, body: &str, headers: Vec<(&str, &str)>) -> super::super::github::GitHubForge {
        let resp = super::super::http::HttpResponse {
            status,
            headers: headers.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: body.to_string(),
        };
        super::super::github::GitHubForge::new(
            Box::new(super::super::http::test_support::StubTransport::new(vec![resp])),
            Some(TOKEN.into()),
            None,
        )
        .with_base("https://api.test")
    }

    fn create(f: &super::super::github::GitHubForge) -> ForgeError {
        let repo = RepoRef { owner: "skarif2".into(), repo: "sway".into() };
        let req = CreatePr {
            title: "t".into(),
            body: "b".into(),
            head: "wave-3".into(),
            base: "main".into(),
            draft: false,
        };
        f.create_pull_request(&repo, &req).unwrap_err()
    }

    #[test]
    fn every_way_opening_a_pr_fails_is_its_own_error() {
        // The point is that the UI can branch. A single "could not open a PR"
        // string forces the user to read a sentence to learn whether to add a
        // remote, sign in again, wait, or just click through to a PR that is
        // already open.
        let no_remote = repo_at(None);
        assert!(matches!(repo_ref(no_remote.to_str().unwrap()), Err(ForgeError::NoRemote)));

        let gitlab = repo_at(Some("git@gitlab.com:skarif2/sway.git"));
        match repo_ref(gitlab.to_str().unwrap()) {
            Err(ForgeError::UnsupportedRemote { host }) => assert_eq!(host, "gitlab.com"),
            other => panic!("a GitLab remote is not a missing one: {other:?}"),
        }

        let forbidden = create(&forge(403, r#"{"message":"Resource not accessible"}"#, vec![]));
        assert!(matches!(forbidden, ForgeError::Forbidden { .. }));

        let exists = create(&forge(
            422,
            r#"{"message":"Validation Failed","errors":[{"message":"A pull request already exists for skarif2:wave-3."}]}"#,
            vec![],
        ));
        match &exists {
            // The detail from `errors[]`, not the bare "Validation Failed" that
            // names no branch and suggests no fix.
            ForgeError::AlreadyExists { message } => assert!(message.contains("skarif2:wave-3")),
            other => panic!("expected AlreadyExists, got {other:?}"),
        }

        let limited = create(&forge(
            403,
            r#"{"message":"rate limit exceeded"}"#,
            vec![("X-RateLimit-Remaining", "0")],
        ));
        assert!(matches!(limited, ForgeError::RateLimited { .. }));

        let suspect = create(&forge(401, r#"{"message":"Bad credentials"}"#, vec![]));
        assert!(matches!(suspect, ForgeError::CredentialSuspect));

        let kinds: Vec<String> = [forbidden, exists, limited, suspect]
            .into_iter()
            .map(|e| ForgeErrorDto::from(e).kind)
            .collect();
        let mut sorted = kinds.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), kinds.len(), "two failures collapsed into one kind");

        let _ = std::fs::remove_dir_all(&no_remote);
        let _ = std::fs::remove_dir_all(&gitlab);
    }

    #[test]
    fn a_nothing_to_merge_422_is_not_reported_as_an_existing_pr() {
        // 422 is GitHub's catch-all validation status. Creating a PR with no
        // commits between the branches lands on it too, and calling that "a PR
        // already exists" sends the user hunting for a PR that is not there.
        let err = create(&forge(
            422,
            r#"{"message":"Validation Failed","errors":[{"message":"No commits between main and wave-3"}]}"#,
            vec![],
        ));
        match err {
            ForgeError::Api { status, message } => {
                assert_eq!(status, 422);
                assert!(message.contains("No commits between"), "kept the actionable half");
            }
            other => panic!("expected a plain validation failure, got {other:?}"),
        }
    }

    #[test]
    fn no_pr_failure_ever_carries_the_token() {
        // Every one of these errors is rendered in the UI and may be copied into
        // a bug report. A token reaching the message would be a leak that no
        // redaction downstream could take back.
        let cases = [
            create(&forge(403, r#"{"message":"nope"}"#, vec![])),
            create(&forge(401, r#"{"message":"Bad credentials"}"#, vec![])),
            create(&forge(500, r#"{"message":"boom"}"#, vec![])),
            create(&forge(422, r#"{"message":"Validation Failed"}"#, vec![])),
        ];
        for err in cases {
            let dto = ForgeErrorDto::from(err.clone());
            let json = serde_json::to_string(&dto).unwrap();
            assert!(!json.contains(TOKEN), "token leaked into {json}");
            assert!(!format!("{err:?}").contains(TOKEN), "token leaked into Debug of {err:?}");
        }
    }

    #[test]
    fn a_rate_limit_hands_the_scheduler_a_deadline_rather_than_a_sentence_to_parse() {
        // The scheduler has to back off by the server's own number. Reading it
        // out of the message would work until the message is reworded, which is
        // the same trap `kind` exists to avoid.
        let dto: ForgeErrorDto = ForgeError::RateLimited {
            kind: super::super::RateLimitKind::Secondary,
            retry_after_secs: Some(60),
            reset_at_secs: None,
        }
        .into();
        assert_eq!(dto.rate_limit_kind.as_deref(), Some("secondary"));
        assert_eq!(dto.retry_after_secs, Some(60));

        // A primary limit usually names no deadline; the kind is what tells the
        // scheduler to wait out an hourly budget rather than a few seconds.
        let dto: ForgeErrorDto = ForgeError::RateLimited {
            kind: super::super::RateLimitKind::Primary,
            retry_after_secs: None,
            reset_at_secs: Some(1_785_179_400),
        }
        .into();
        assert_eq!(dto.rate_limit_kind.as_deref(), Some("primary"));
        assert_eq!(dto.retry_after_secs, None);
        // The number that lets the scheduler resume when the budget actually
        // refills instead of after a fixed guess of its own.
        assert_eq!(dto.reset_at_secs, Some(1_785_179_400));

        // And every other failure sends both as null rather than as a zero the
        // scheduler would read as "retry immediately".
        let dto: ForgeErrorDto = ForgeError::NotFound.into();
        assert_eq!(dto.rate_limit_kind, None);
        assert_eq!(dto.retry_after_secs, None);
    }

    #[test]
    fn the_kill_switch_stops_a_poll_before_it_can_reach_anything() {
        // The deferred half of the `github.enabled` promise: the scheduler pauses
        // itself, and this is the backstop that makes "no request" true even if a
        // caller forgets. The path handed in is not a repo at all, so a build
        // where the gate is missing fails with a *remote* error instead, which is
        // what makes this assertion discriminating rather than decorative.
        let not_a_repo = std::env::temp_dir().join("sway_forge_no_repo_here");
        auth::restore(Some(TOKEN.into()), Some("skarif2".into()), false);

        let err = github_unit_statuses(
            not_a_repo.to_string_lossy().into_owned(),
            vec!["wave-3".into()],
            false,
        )
        .unwrap_err();
        assert_eq!(err.kind, "notAuthenticated", "a disabled integration reached the repo");

        auth::restore(None, None, true);
    }

    #[test]
    fn the_kill_switch_stops_a_pr_listing_too() {
        // Same backstop, second door. `github.enabled` off has to mean no
        // traffic at all, not merely no polling, and a panel the user opens is
        // exactly the caller that would otherwise reach the wire while the
        // scheduler sat paused. The path is not a repo, so a build missing the
        // gate fails with a *remote* error instead.
        let not_a_repo = std::env::temp_dir().join("sway_forge_no_repo_here");
        auth::restore(Some(TOKEN.into()), Some("skarif2".into()), false);

        let err = github_list_prs(not_a_repo.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(err.kind, "notAuthenticated", "a disabled integration listed pull requests");

        auth::restore(None, None, true);
    }

    #[test]
    fn the_kill_switch_stops_a_file_listing_too() {
        // Third door onto the wire, same backstop. A PR detail view is opened by
        // a click, so it reaches Rust while the scheduler sits paused, and a
        // "no polling" reading of the toggle would let it straight through.
        let not_a_repo = std::env::temp_dir().join("sway_forge_no_repo_here");
        auth::restore(Some(TOKEN.into()), Some("skarif2".into()), false);

        let err = github_pr_files(not_a_repo.to_string_lossy().into_owned(), 12).unwrap_err();
        assert_eq!(err.kind, "notAuthenticated", "a disabled integration listed changed files");

        auth::restore(None, None, true);
    }

    #[test]
    fn a_poll_report_never_carries_the_token() {
        // The whole reason the report is its own type rather than `PollOutcome`.
        let json = serde_json::to_string(&PollReport::Authorized { login: "skarif2".into() }).unwrap();
        assert!(json.contains("skarif2"));
        assert!(!json.contains("gho_"), "a token reached the frontend: {json}");
    }
}
