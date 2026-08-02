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
use super::model::{AuthState, PullRequest, RepoRef};
use super::{auth, github, prs, token, CreatePr, Forge, ForgeError};
use serde::Serialize;
use std::sync::Mutex;

#[derive(Default)]
pub struct DeviceFlowState(pub Mutex<Option<PendingFlow>>);

/// A `ForgeError` as the frontend sees it: a stable `kind` to branch on plus a
/// sentence to show.
///
/// The kind is what the UI switches on, so it must not be the display string:
/// a reworded message would silently change behaviour.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeErrorDto {
    pub kind: String,
    pub message: String,
}

impl From<ForgeError> for ForgeErrorDto {
    fn from(e: ForgeError) -> Self {
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
        Self { kind: kind.into(), message: e.to_string() }
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
    fn a_poll_report_never_carries_the_token() {
        // The whole reason the report is its own type rather than `PollOutcome`.
        let json = serde_json::to_string(&PollReport::Authorized { login: "skarif2".into() }).unwrap();
        assert!(json.contains("skarif2"));
        assert!(!json.contains("gho_"), "a token reached the frontend: {json}");
    }
}
