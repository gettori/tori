//! The Tauri surface of the forge layer.
//!
//! Thin by design: every command here is a wrapper over a tested core in
//! `auth`, `accounts`, `device_flow` or `token`. Nothing below `commands.rs`
//! touches Tauri, which is the same one-directional layering the chat host uses.
//!
//! The in-flight device flow lives in [`DeviceFlowState`] rather than crossing
//! to the frontend, because a `device_code` is a secret: whoever holds one can
//! complete the exchange. The frontend gets a user code and a URL.

use super::accounts::{
    self, AccountView, AccountsFile, HostView, Provider, Resolution, SignInRoutes, Source,
};
use super::device_flow::{self, DevicePrompt, PendingFlow, PollOutcome};
use super::http::UreqTransport;
use super::model::{
    AuthState, Capabilities, DraftComment, Grant, Paged, PrFile, PrState, PrSummary, PullRequest, RepoRef,
    ReviewComment, ReviewEvent, ReviewThread, StatusReport, UnitStatus,
};
use super::remote::{self, Remote};
use super::token::{self, Secret};
use super::{
    auth, cli, github, gitlab, now_secs, prs, refresh, status, CreatePr, Forge, ForgeError,
    MergeMethod,
};
use crate::credential::Reach;
use crate::rpc::pr_watch;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Mutex;

/// A device flow in flight, and where its token will be filed. No `Debug`: the
/// flow carries the device code.
#[derive(Clone)]
pub struct PendingSignIn {
    flow: PendingFlow,
    provider: Provider,
    base_url: String,
    host: String,
    reauth: Option<String>,
    client_id: String,
    endpoints: device_flow::Endpoints,
}

#[derive(Default)]
pub struct DeviceFlowState(pub Mutex<Option<PendingSignIn>>);

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
    /// The organisation standing in the way, for the one failure that has one.
    /// Named separately from the message because the surfaces branch on it: what
    /// to offer next depends on the organisation, not on the sentence.
    pub org: Option<String>,
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
            ForgeError::OrgUnapproved { .. } => "orgUnapproved",
            ForgeError::AlreadyExists { .. } => "alreadyExists",
            ForgeError::NotMergeable { .. } => "notMergeable",
            ForgeError::AccountPickNeeded { .. } => "pickAccount",
            ForgeError::Invalid { .. } => "invalid",
            ForgeError::Api { .. } => "api",
            ForgeError::Transport { .. } => "transport",
            ForgeError::Malformed { .. } => "malformed",
        };
        let org = match &e {
            ForgeError::OrgUnapproved { org } => Some(org.clone()),
            _ => None,
        };
        Self {
            kind: kind.into(),
            message: e.to_string(),
            rate_limit_kind,
            retry_after_secs,
            reset_at_secs,
            org,
        }
    }
}

/// What a poll turn tells the frontend.
///
/// The token is deliberately absent: it goes straight to the keychain on the
/// Rust side and never crosses the bridge.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum PollReport {
    Authorized { account_id: String, login: String },
    Pending { next_interval_secs: u64 },
    /// `code` is the server's own `error` value, so the UI can quote the host.
    Denied { code: String },
    Expired { code: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    pub account_id: String,
    pub login: String,
}

/// The account one checkout acts as, as the chip and the Review panel need it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum RepoAccount {
    Account { account_id: String, host: String, auth: AuthState, capabilities: Capabilities },
    Pick { host: String, candidates: Vec<AccountView> },
    /// No remote, or a host with no account. `host` is absent for the first.
    NoAccount { host: Option<String> },
}

#[tauri::command(async)]
pub fn forge_accounts() -> Vec<HostView> {
    accounts::view(&accounts::load(), auth::state)
}

/// What happened when the user pressed the host's one sign-in button.
///
/// The frontend offers no choice of route, so this is the answer to "sign me
/// in", not a menu: either it is already done, or here is the browser to go to,
/// or here is what a token for this host has to look like.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum SignInStart {
    /// `gh` already held a usable token, so nothing was asked of the user.
    SignedIn { account_id: String, login: String },
    /// A device flow is running; poll it with `forge_device_poll`. The routes
    /// ride along so a flow that fails can fall back to a token without asking
    /// again.
    Browser { prompt: DevicePrompt, routes: SignInRoutes },
    Token { routes: SignInRoutes },
}

/// Whether the user asked for the GitHub CLI by name, or just pressed sign in.
///
/// Carried rather than passed as a bare flag because it is the whole of the
/// difference between reading `gh` and hijacking a re-auth, and a `true` at a
/// call site says neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliAsk {
    /// Ordinary sign in. `gh` answers only where it cannot collide.
    Whoever,
    /// A control that says "GitHub CLI". `gh` may also re-source an account of
    /// the same login that came from somewhere else.
    Named,
}

impl From<bool> for CliAsk {
    fn from(named: bool) -> Self {
        if named {
            Self::Named
        } else {
            Self::Whoever
        }
    }
}

/// Whether `gh`'s token may answer for this sign-in.
///
/// Only where nothing of the user's is overwritten by it: a host that has no
/// account for `gh`'s login yet, or a re-authentication of the very account
/// `gh` supplied in the first place. Anywhere else the user is adding or
/// repairing a *second* identity, and `gh` speaks for only one, so it would
/// quietly hand back the first.
///
/// [`CliAsk::Named`] is the user having pressed a control that says "GitHub
/// CLI", which is the one case where adopting `gh` for an account that came from
/// a pasted token is not a hijack: the login is the same person either way, and
/// only the route to them changes. It is what the organisation notice presses,
/// since an organisation refuses an application rather than a person.
fn gh_may_answer(
    file: &AccountsFile,
    host: &str,
    login: &str,
    reauth: Option<&str>,
    ask: CliAsk,
) -> bool {
    let same_login = |a: &accounts::Account| {
        a.login.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(login))
    };
    match reauth {
        // The host is checked too: ids are unique across hosts, so one from
        // another host would otherwise be judged against this host's accounts.
        Some(id) => accounts::find(file, id).is_some_and(|(at, a)| {
            at == host && same_login(a) && (a.source == Source::Cli || ask == CliAsk::Named)
        }),
        None => !file
            .hosts
            .get(host)
            .is_some_and(|record| record.accounts.iter().any(same_login)),
    }
}

#[tauri::command(async)]
pub fn forge_sign_in_start(
    state: tauri::State<'_, DeviceFlowState>,
    provider: Provider,
    base_url: String,
    account_id: Option<String>,
    prefer_cli: bool,
) -> Result<SignInStart, ForgeErrorDto> {
    let (base_url, host) = accounts::normalize_base_url(&base_url)?;
    let file = accounts::load();
    let reauth = account_id.as_deref();
    if provider == Provider::Github {
        if let Some(signed) = cli_sign_in(&file, &base_url, &host, reauth, prefer_cli.into())? {
            return Ok(SignInStart::SignedIn { account_id: signed.account_id, login: signed.login });
        }
        // GitHub's browser route is Tori's own application, which an
        // organisation can refuse to approve. A token the user makes themselves
        // is the route that survives that, so it is the only fallback offered.
        return Ok(SignInStart::Token { routes: routes_in(&file, provider, &base_url, &host) });
    }
    let routes = routes_in(&file, provider, &base_url, &host);
    if routes.device_flow {
        let prompt = start_gitlab_device_flow(&state, &file, base_url, host, account_id)?;
        return Ok(SignInStart::Browser { prompt, routes });
    }
    Ok(SignInStart::Token { routes })
}

/// Why a `cli` account cannot be repaired from `gh` as it stands.
///
/// `gh auth switch` moves the CLI to another login while Tori's account keeps
/// pointing at the first. Storing the new token under the old id would move an
/// account to somebody else's identity behind an id that repositories already
/// pick, so the switch is named instead: only the user can decide which of the
/// two they meant.
fn switched_away(account: &accounts::Account, gh_login: &str) -> Option<ForgeError> {
    let held = account.login.as_deref()?;
    let moved = account.source == Source::Cli && !held.eq_ignore_ascii_case(gh_login);
    moved.then(|| ForgeError::Invalid {
        message: format!(
            "The GitHub CLI is signed in as {gh_login} now, not {held}. \
             Run `gh auth switch` to go back, or paste a token for {held}."
        ),
    })
}

/// `Ok(None)` is the ordinary answer on a machine with no `gh`, or one whose
/// `gh` speaks for somebody else: the caller falls through to a token.
fn cli_sign_in(
    file: &AccountsFile,
    base_url: &str,
    host: &str,
    reauth: Option<&str>,
    ask: CliAsk,
) -> Result<Option<SignedIn>, ForgeError> {
    let Some(token) = cli::token(host) else {
        return Ok(None);
    };
    let named = match ask_viewer(Provider::Github, base_url, host, &token, Source::Cli) {
        Ok(named) => named,
        // A `gh` that is installed but holds a stale token must not block the
        // token route behind an error about a credential the user never chose.
        Err(_) => return Ok(None),
    };
    // Said out loud only where `gh` was the account's own route, because that is
    // the one case where the user pressed a button expecting `gh` to answer.
    if let Some(account) = reauth.and_then(|id| accounts::find(file, id)).map(|(_, a)| a) {
        if let Some(e) = switched_away(account, &named.login) {
            return Err(e);
        }
    }
    if !gh_may_answer(file, host, &named.login, reauth, ask) {
        return Ok(None);
    }
    store_signed_in(
        Provider::Github,
        base_url,
        host,
        Secret::access(token),
        None,
        Source::Cli,
        reauth,
        named,
    )
    .map(Some)
}

/// A `cli` account the host stopped accepting, repaired from `gh` without
/// asking the user.
///
/// The token belongs to `gh`, which rotates it on its own schedule, so a
/// rejection here usually means `gh` already holds a newer one. Run from the
/// startup probe beside [`learn_login`], off the setup thread, because reading
/// `gh` spawns a process.
fn recover_cli(id: &str) -> Result<Option<SignedIn>, ForgeError> {
    let file = accounts::load();
    let Some((host, account)) = accounts::find(&file, id) else {
        return Ok(None);
    };
    if account.source != Source::Cli {
        return Ok(None);
    }
    let (base_url, host) = (account.base_url.clone(), host.to_string());
    // Nobody pressed anything: the startup probe is repairing an account that
    // was already `gh`'s, which `gh_may_answer` allows on its own.
    cli_sign_in(&file, &base_url, &host, Some(id), CliAsk::Whoever)
}

// Per host, because only that instance can issue one: gitlab.com's is Tori's
// own, and a company's server has whichever its admin created, or none.
#[tauri::command(async)]
pub fn forge_set_app_id(
    provider: Provider,
    base_url: String,
    app_id: String,
) -> Result<SignInRoutes, ForgeErrorDto> {
    let (base_url, host) = accounts::normalize_base_url(&base_url)?;
    if host == accounts::GITLAB_COM {
        return Err(ForgeError::Invalid {
            message: "gitlab.com signs in with Tori's own application.".into(),
        }
        .into());
    }
    accounts::update(|file| Ok(accounts::set_app_id(file, &host, &app_id)))?;
    let file = accounts::load();
    Ok(routes_in(&file, provider, &base_url, &host))
}

/// The per-host switch for git over https, answering with the refreshed list so
/// the pane renders what Rust stored rather than what it assumed.
#[tauri::command(async)]
pub fn forge_set_git_credentials(host: String, enabled: bool) -> Result<Vec<HostView>, ForgeErrorDto> {
    accounts::update(|file| {
        let everywhere = accounts::git_everywhere(file, &host);
        let changed = accounts::set_git_credentials(file, &host, enabled);
        // Only a host set everywhere has anything in the global config to take out.
        if everywhere {
            sync_global_config(file)?;
        }
        Ok(changed)
    })?;
    Ok(accounts::view(&accounts::load(), auth::state))
}

/// The second switch: git outside Tori asks Tori for this host too.
#[tauri::command(async)]
pub fn forge_set_git_everywhere(host: String, enabled: bool) -> Result<Vec<HostView>, ForgeErrorDto> {
    accounts::update(|file| {
        let changed = accounts::set_git_everywhere(file, &host, enabled);
        sync_global_config(file)?;
        Ok(changed)
    })?;
    Ok(accounts::view(&accounts::load(), auth::state))
}

// Inside the update, so a global config git could not write leaves the switch
// where it was rather than showing a state git does not have.
fn sync_global_config(file: &AccountsFile) -> Result<(), ForgeError> {
    crate::credential::sync_global_config(file).map_err(|message| ForgeError::Transport { message })
}

/// The global git config brought in line with the accounts as they are now,
/// under the lock the switches take, so it cannot undo one flipped meanwhile.
pub fn resync_global_config() {
    let _ = accounts::update(|file| sync_global_config(file));
}

#[tauri::command(async)]
pub fn forge_set_default_account(
    host: String,
    account_id: Option<String>,
) -> Result<Vec<HostView>, ForgeErrorDto> {
    accounts::update(|file| accounts::set_default_account(file, &host, account_id.as_deref()))?;
    Ok(accounts::view(&accounts::load(), auth::state))
}

fn routes_in(
    file: &AccountsFile,
    provider: Provider,
    base_url: &str,
    host: &str,
) -> SignInRoutes {
    accounts::sign_in_routes(
        provider,
        base_url,
        host,
        client_id_for(file, provider, host).as_deref(),
        accounts::git_credentials(file, host),
    )
}

/// The OAuth application a host's browser sign-in would use.
///
/// GitLab only, since Tori registers no GitHub application: Tori's own on
/// gitlab.com, and on any other instance whichever the user registered there.
///
/// A stored gitlab.com id is ignored rather than preferred: nothing can clear
/// it, and gitlab.com tokens renew with Tori's application.
fn client_id_for(file: &AccountsFile, provider: Provider, host: &str) -> Option<String> {
    match provider {
        Provider::Github => None,
        Provider::Gitlab if host == accounts::GITLAB_COM => (!device_flow::GITLAB_COM_CLIENT_ID.is_empty())
            .then(|| device_flow::GITLAB_COM_CLIENT_ID.to_string()),
        Provider::Gitlab => accounts::app_id(file, host),
    }
}

/// Starts a GitLab device flow, holding the secret half in Rust.
fn start_gitlab_device_flow(
    state: &tauri::State<'_, DeviceFlowState>,
    file: &AccountsFile,
    base_url: String,
    host: String,
    account_id: Option<String>,
) -> Result<DevicePrompt, ForgeError> {
    let provider = Provider::Gitlab;
    let client_id = client_id_for(file, provider, &host).ok_or(ForgeError::NotAuthenticated)?;
    let endpoints = device_flow::gitlab_endpoints(&base_url);
    let (prompt, flow) =
        device_flow::start_with(&UreqTransport::default(), &client_id, &endpoints)?;
    *state.0.lock().unwrap() = Some(PendingSignIn {
        flow,
        provider,
        base_url,
        host,
        reauth: account_id,
        client_id,
        endpoints,
    });
    Ok(prompt)
}

/// One poll turn. The frontend owns the waiting, using the interval reported
/// back, so a `slow_down` actually slows the caller down.
#[tauri::command(async)]
pub fn forge_device_poll(
    state: tauri::State<'_, DeviceFlowState>,
) -> Result<PollReport, ForgeErrorDto> {
    let pending = state.0.lock().unwrap().clone();
    let Some(sign_in) = pending else {
        return Err(ForgeError::NotAuthenticated.into());
    };
    let outcome = device_flow::poll_once_with(
        &UreqTransport::default(),
        &sign_in.client_id,
        &sign_in.endpoints,
        &sign_in.flow,
    )?;
    Ok(match outcome {
        PollOutcome::Authorized { token: t } => {
            state.0.lock().unwrap().take();
            // Straight to the keychain; the token never reaches the frontend.
            let signed = add_signed_in(
                sign_in.provider,
                &sign_in.base_url,
                &sign_in.host,
                Secret { access_token: t.access_token, refresh_token: t.refresh_token },
                expires_at(t.expires_in_secs),
                Source::Browser,
                sign_in.reauth.as_deref(),
            )?;
            PollReport::Authorized { account_id: signed.account_id, login: signed.login }
        }
        // Both waiting outcomes report the interval to use next, so the caller
        // never has to know which one changed it.
        PollOutcome::Pending { next_interval_secs } | PollOutcome::SlowDown { next_interval_secs } => {
            if let Some(p) = state.0.lock().unwrap().as_mut() {
                p.flow.interval_secs = next_interval_secs;
            }
            PollReport::Pending { next_interval_secs }
        }
        PollOutcome::Denied => {
            state.0.lock().unwrap().take();
            PollReport::Denied { code: device_flow::ACCESS_DENIED.into() }
        }
        PollOutcome::Expired => {
            state.0.lock().unwrap().take();
            PollReport::Expired { code: device_flow::EXPIRED_TOKEN.into() }
        }
    })
}

#[tauri::command]
pub fn forge_device_cancel(state: tauri::State<'_, DeviceFlowState>) {
    state.0.lock().unwrap().take();
}

/// Whether the GitHub CLI is installed, which decides whether an organisation
/// notice can offer it as the route not yet tried.
#[tauri::command(async)]
pub fn forge_cli_installed() -> bool {
    cli::installed()
}

#[tauri::command(async)]
pub fn forge_add_token(
    provider: Provider,
    base_url: String,
    token: String,
    account_id: Option<String>,
) -> Result<SignedIn, ForgeErrorDto> {
    let token = token.trim();
    if token.is_empty() {
        return Err(ForgeError::Invalid { message: "Paste a token first.".into() }.into());
    }
    let (base_url, host) = accounts::normalize_base_url(&base_url)?;
    // A pasted token carries no expiry: whatever the user set on the host is
    // the host's business, and inventing a deadline here would sign them out.
    Ok(add_signed_in(
        provider,
        &base_url,
        &host,
        Secret::access(token.to_string()),
        None,
        Source::Token,
        account_id.as_deref(),
    )?)
}

/// The wall-clock deadline for a token that expires, from the server's own "in
/// N seconds". Absolute, because the process will not be running for most of
/// the wait.
fn expires_at(in_secs: Option<u64>) -> Option<u64> {
    in_secs.map(|s| now_secs() + s)
}

/// Asks the host whose token this is, then files it under that login. A token
/// the host will not name is never stored.
fn add_signed_in(
    provider: Provider,
    base_url: &str,
    host: &str,
    secret: Secret,
    expires_at: Option<u64>,
    source: Source,
    reauth: Option<&str>,
) -> Result<SignedIn, ForgeError> {
    let named = ask_viewer(provider, base_url, host, &secret.access_token, source)?;
    store_signed_in(provider, base_url, host, secret, expires_at, source, reauth, named)
}

/// Who a token belongs to, and what the host says the token itself holds.
/// Split from the storing half so a route that has to decide *before* filing
/// the account does not pay for a second viewer call.
struct Named {
    login: String,
    grant: Grant,
}

fn ask_viewer(
    provider: Provider,
    base_url: &str,
    host: &str,
    token: &str,
    source: Source,
) -> Result<Named, ForgeError> {
    let forge = forge_for(provider, base_url, Some(token.to_string()), None);
    let login = match forge.viewer() {
        Ok(viewer) => viewer.login,
        Err(ForgeError::CredentialSuspect) => {
            return Err(ForgeError::Invalid { message: format!("{host} rejected that token.") })
        }
        Err(e) => return Err(e),
    };
    Ok(Named { login, grant: reported_grant(provider, source, forge.as_ref()) })
}

fn store_signed_in(
    provider: Provider,
    base_url: &str,
    host: &str,
    secret: Secret,
    expires_at: Option<u64>,
    source: Source,
    reauth: Option<&str>,
    named: Named,
) -> Result<SignedIn, ForgeError> {
    let Named { login, grant } = named;
    // The flow's own lifetime wins where there is one: a browser token's
    // `expires_in` is the authority on itself, and the grant read is the only
    // source for a pasted one.
    let expires_at = expires_at.or(grant.expires_at);
    let scopes = grant.scopes;
    let account_id = accounts::update(|file| {
        let id = accounts::add_account(file, provider, base_url, host, &login, source, reauth)?;
        accounts::note_expiry(file, &id, expires_at);
        accounts::clear_org_access(file, &id);
        if let Some(scopes) = scopes.clone() {
            accounts::note_scopes(file, &id, scopes);
        }
        auth::sign_in(&id, &secret, Some(login.clone()))?;
        Ok(id)
    })?;
    Ok(SignedIn { account_id, login })
}

/// Signs an account out and forgets it, along with the repo picks naming it.
#[tauri::command(async)]
pub fn forge_remove_account(account_id: String) -> Result<(), ForgeErrorDto> {
    auth::sign_out(&account_id)?;
    accounts::update(|file| Ok(accounts::remove_account(file, &account_id)))?;
    // The removal stands either way. Git asks the user on a host with no account.
    resync_global_config();
    // A pick left behind names no account, so resolution already ignores it.
    let _ = crate::settings::edit_forge_picks(|picks| accounts::drop_picks_for(picks, &account_id));
    Ok(())
}

#[tauri::command(async)]
pub fn forge_repo_account(project_path: String) -> Result<RepoAccount, ForgeErrorDto> {
    let remote = match remote_of(&project_path) {
        Ok(remote) => remote,
        Err(ForgeError::NoRemote | ForgeError::UnsupportedRemote { .. }) => {
            return Ok(RepoAccount::NoAccount { host: None })
        }
        Err(e) => return Err(e.into()),
    };
    let picks = crate::settings::get_settings().forge.picks;
    Ok(repo_account_in(&accounts::load(), &picks, &remote, auth::state))
}

fn repo_account_in(
    file: &AccountsFile,
    picks: &BTreeMap<String, String>,
    remote: &Remote,
    auth: impl Fn(&str) -> AuthState,
) -> RepoAccount {
    let host = remote.host.clone();
    match accounts::resolve(file, picks, remote) {
        Resolution::Account(id) => {
            // Built without a token, because a capability is a fact about the
            // provider rather than about the credential, and this answer is
            // rendered before any call is made.
            let capabilities = accounts::find(file, &id)
                .map(|(_, a)| forge_for(a.provider, &a.base_url, None, None).capabilities())
                .unwrap_or_default();
            RepoAccount::Account { auth: auth(&id), account_id: id, host, capabilities }
        }
        Resolution::Pick { candidates } => RepoAccount::Pick {
            candidates: candidates
                .iter()
                .filter_map(|id| accounts::find(file, id))
                .map(|(_, account)| accounts::account_view(account, &auth))
                .collect(),
            host,
        },
        Resolution::NoAccount => RepoAccount::NoAccount { host: Some(host) },
    }
}

#[tauri::command(async)]
pub fn forge_pick_account(project_path: String, account_id: String) -> Result<(), ForgeErrorDto> {
    let remote = remote_of(&project_path)?;
    let on_host = accounts::load()
        .hosts
        .get(&remote.host)
        .is_some_and(|r| r.accounts.iter().any(|a| a.id == account_id));
    if !on_host {
        return Err(ForgeError::Invalid { message: format!("That account is not on {}.", remote.host) }.into());
    }
    crate::settings::edit_forge_picks(|picks| {
        picks.insert(remote.key(), account_id.clone()).as_ref() != Some(&account_id)
    })
    .map_err(|message| ForgeError::Transport { message })?;
    Ok(())
}

/// A forge client for one checkout: the account it acts as, and the repo on
/// that account's host.
pub struct Client {
    pub account_id: String,
    pub repo: RepoRef,
    pub forge: Box<dyn Forge>,
}

fn remote_of(project_path: &str) -> Result<Remote, ForgeError> {
    match crate::git::git_origin(project_path.to_string()) {
        Ok(Some(url)) => remote::parse(&url),
        Ok(None) => Err(ForgeError::NoRemote),
        Err(message) => Err(ForgeError::Transport { message }),
    }
}

/// No remote and a host nothing serves stay distinct errors: the first can still
/// get a remote added, the second renders inert in the sidebar.
pub fn client_for(project_path: &str) -> Result<Client, ForgeError> {
    let remote = remote_of(project_path)?;
    client_in(&accounts::load(), &crate::settings::get_settings().forge.picks, remote)
}

fn client_in(
    file: &AccountsFile,
    picks: &BTreeMap<String, String>,
    remote: Remote,
) -> Result<Client, ForgeError> {
    match accounts::resolve(file, picks, &remote) {
        Resolution::Account(id) => {
            let (host, account) = accounts::find(file, &id).ok_or(ForgeError::NotAuthenticated)?;
            let forge = forge_for(
                account.provider,
                &account.base_url,
                fresh_token(file, host, account),
                login_of(&id),
            );
            Ok(Client { account_id: id, repo: remote.repo, forge })
        }
        Resolution::Pick { .. } => Err(ForgeError::AccountPickNeeded { host: remote.host }),
        Resolution::NoAccount if remote.host == accounts::GITHUB_COM => Err(ForgeError::NotAuthenticated),
        Resolution::NoAccount => Err(ForgeError::UnsupportedRemote { host: remote.host }),
    }
}

/// The adapter for a provider at an account's base URL.
fn forge_for(
    provider: Provider,
    base_url: &str,
    token: Option<String>,
    login: Option<String>,
) -> Box<dyn Forge> {
    let transport = Box::new(UreqTransport::default());
    match provider {
        Provider::Github => Box::new(github::GitHubForge::new(transport, base_url, token, login)),
        Provider::Gitlab => Box::new(gitlab::GitLabForge::new(transport, base_url, token, login)),
    }
}

// Every provider with an adapter, mirrored to the frontend through the model
// fixture. A variant added without one fails `forge_for`'s match first and this
// list second, so the frontend's copy cannot drift past both.
#[cfg(test)]
pub(crate) fn served_providers() -> Vec<Provider> {
    vec![Provider::Github, Provider::Gitlab]
}

/// The ref a forge publishes a pull request's head under.
///
/// Layer 1 reads this with plain `git fetch`, so it is the one piece of
/// provider knowledge the git layer needs and cannot work out for itself.
fn head_ref(provider: Provider, number: u64) -> String {
    match provider {
        Provider::Github => format!("refs/pull/{number}/head"),
        Provider::Gitlab => format!("refs/merge-requests/{number}/head"),
    }
}

/// Which head ref this checkout's forge publishes.
///
/// An unresolved repo answers GitHub's spelling, which is what every caller
/// assumed before GitLab existed: a fetch of a ref the remote does not have
/// fails the same way either spelling does.
pub fn pr_head_ref(project_path: &str, number: u64) -> String {
    let file = accounts::load();
    let provider = remote_of(project_path).ok().and_then(|remote| {
        let picks = crate::settings::get_settings().forge.picks;
        match accounts::resolve(&file, &picks, &remote) {
            Resolution::Account(id) => accounts::find(&file, &id).map(|(_, a)| a.provider),
            // No pick, or no account at all: every account on a host shares its
            // provider, so the first one answers for the host.
            _ => file.hosts.get(&remote.host).and_then(|r| r.accounts.first()).map(|a| a.provider),
        }
    });
    head_ref(provider.unwrap_or(Provider::Github), number)
}

/// Whether git in this checkout should ask Tori for `host`'s credential.
pub fn serves_git(project_path: &str, host: &str) -> bool {
    let Ok(remote) = remote_of(project_path) else {
        return false;
    };
    remote.host == host
        && accounts::serves_git(
            &accounts::load(),
            &crate::settings::get_settings().forge.picks,
            &remote,
        )
}

/// The account git should push and fetch as here, spelled the way git's helper
/// protocol wants it. `None` leaves git to the user's own helpers.
pub fn git_credential(project_path: &str, host: &str) -> Option<(String, String)> {
    let remote = remote_of(project_path).ok()?;
    if remote.host != host {
        return None;
    }
    let file = accounts::load();
    let id = git_account(&file, &crate::settings::get_settings().forge.picks, &remote)?;
    git_login(&file, &id)
}

/// The same from the host and path git hands its helper, for git that runs
/// outside any checkout Tori registered, a clone included.
pub fn git_credential_at(host: &str, path: &str, reach: Reach) -> Option<(String, String)> {
    let file = accounts::load();
    let id = git_account_at(&file, &crate::settings::get_settings().forge.picks, host, path, reach)?;
    git_login(&file, &id)
}

fn git_account_at(
    file: &AccountsFile,
    picks: &BTreeMap<String, String>,
    host: &str,
    path: &str,
    reach: Reach,
) -> Option<String> {
    let remote = remote::parse(&format!("https://{host}/{path}")).ok()?;
    // `parse` drops a port, and a host on another port is another server.
    if remote.host != remote::canonical_host(host) {
        return None;
    }
    if reach == Reach::Everywhere && !accounts::git_everywhere(file, &remote.host) {
        return None;
    }
    git_account(file, picks, &remote)
}

fn git_account(file: &AccountsFile, picks: &BTreeMap<String, String>, remote: &Remote) -> Option<String> {
    match accounts::resolve(file, picks, remote) {
        Resolution::Account(id) if accounts::git_credentials(file, &remote.host) => Some(id),
        _ => None,
    }
}

fn git_login(file: &AccountsFile, id: &str) -> Option<(String, String)> {
    let (host, account) = accounts::find(file, id)?;
    // The same renewal every API call goes through, so a push at the end of a
    // long session does not fail on a token that expired an hour into it.
    let token = fresh_token(file, host, account)?;
    Some((git_username(account.provider).to_string(), token))
}

/// The username each provider expects beside a token over https. Neither reads
/// it as an identity (the token carries that), but both require one.
fn git_username(provider: Provider) -> &'static str {
    match provider {
        Provider::Github => "x-access-token",
        Provider::Gitlab => "oauth2",
    }
}

/// Runs a forge call, renewing the credential once when the host rejects it.
///
/// Inside the call that failed rather than on the next tick: a token that
/// expired mid-session is one Tori can replace without the user, and making
/// them watch a cycle fail first is a pause with nothing behind it.
pub(crate) fn attempt<T>(
    c: &Client,
    run: impl Fn(&dyn Forge) -> Result<T, ForgeError>,
) -> Result<T, ForgeError> {
    let first = run(c.forge.as_ref());
    auth::note_result(&c.account_id, &first);
    note_org_access(&c.account_id, c.forge.as_ref());
    if !matches!(first, Err(ForgeError::CredentialSuspect)) {
        return named_org(c, first);
    }
    let Some(renewed) = renewed_client(c) else {
        return named_org(c, first);
    };
    let second = run(renewed.forge.as_ref());
    auth::note_result(&c.account_id, &second);
    note_org_access(&c.account_id, renewed.forge.as_ref());
    named_org(c, second)
}

/// Names the organisation behind a `404`, where one is behind it.
///
/// A repo that does not exist and a repo an organisation is hiding from this
/// token answer identically, and only the owner's own public record tells them
/// apart. Asked here rather than at the call sites because every call funnels
/// through [`attempt`], and a `404` on any of them means the same thing.
fn named_org<T>(c: &Client, result: Result<T, ForgeError>) -> Result<T, ForgeError> {
    if result.is_ok() {
        seen().lock().unwrap().insert(repo_key(c));
        return result;
    }
    if !matches!(result, Err(ForgeError::NotFound)) {
        return result;
    }
    // A repo that has answered this account even once belongs to an organisation
    // that already let Tori in, so a later `404` is a sub-resource that is gone,
    // not a door being held shut. Without this every deleted comment on an
    // organisation's repo would read as a blocked application.
    if seen().lock().unwrap().contains(&repo_key(c)) {
        return result;
    }
    match owner_is_org(c) {
        true => Err(ForgeError::OrgUnapproved { org: c.repo.owner.clone() }),
        false => result,
    }
}

/// Repos that have answered, as `owner/repo@account`.
///
/// Per account as well as per repo, because the whole point is what *this*
/// token can reach: a second account on the same host may be a member where the
/// first is not.
fn seen() -> &'static Mutex<std::collections::BTreeSet<String>> {
    static SEEN: std::sync::OnceLock<Mutex<std::collections::BTreeSet<String>>> =
        std::sync::OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(std::collections::BTreeSet::new()))
}

fn repo_key(c: &Client) -> String {
    format!("{}/{}@{}", c.repo.owner, c.repo.repo, c.account_id)
}

/// Whether a repo's owner is an organisation, asked once per owner per account.
///
/// A `404` comes back on every poll tick, and the answer cannot change while the
/// owner exists, so without the memo a repo Tori cannot see would spend a
/// request every two minutes re-learning the same fact. Keyed by account because
/// an owner's login only identifies it together with the host the account is on.
/// A failed probe is not recorded, so an offline laptop does not pin the answer
/// to `false`.
fn owner_is_org(c: &Client) -> bool {
    static KNOWN: std::sync::OnceLock<Mutex<BTreeMap<String, bool>>> = std::sync::OnceLock::new();
    let known = KNOWN.get_or_init(|| Mutex::new(BTreeMap::new()));
    let key = format!("{}@{}", c.repo.owner, c.account_id);
    if let Some(answer) = known.lock().unwrap().get(&key) {
        return *answer;
    }
    let Ok(is_org) = c.forge.owner_is_org(&c.repo.owner) else {
        return false;
    };
    known.lock().unwrap().insert(key, is_org);
    is_org
}

/// Files an organisation that refused this account, where the last call met one.
///
/// Beside [`auth::note_result`] because it answers the same question for the
/// same reason: every forge call passes through here, so an organisation named
/// on any of them is recorded once, in one place, rather than at whichever call
/// sites remembered to look.
fn note_org_access(account_id: &str, forge: &dyn Forge) {
    let Some(access) = forge.sso_challenge() else {
        return;
    };
    // Read before the write, because the write is the expensive half and the
    // refusal repeats on every tick: an organisation already on record leaves
    // the file alone rather than re-saving it for the rest of the session.
    if accounts::find(&accounts::load(), account_id)
        .is_some_and(|(_, a)| a.org_access.iter().any(|o| o.org == access.org))
    {
        return;
    }
    let _ = accounts::update(|file| {
        accounts::note_org_access(file, account_id, access.clone());
        Ok(())
    });
}

/// The same repo and account, holding whatever credential the account has now.
/// `None` when nothing can renew it, which leaves the rejection standing.
fn renewed_client(c: &Client) -> Option<Client> {
    let file = accounts::load();
    let (host, account) = accounts::find(&file, &c.account_id)?;
    let token = fresh_token(&file, host, account)?;
    Some(Client {
        account_id: c.account_id.clone(),
        repo: c.repo.clone(),
        forge: forge_for(account.provider, &account.base_url, Some(token), login_of(&c.account_id)),
    })
}

fn refresher() -> &'static refresh::Refresher {
    static R: std::sync::OnceLock<refresh::Refresher> = std::sync::OnceLock::new();
    R.get_or_init(refresh::Refresher::default)
}

/// What an account's deadline is right now, read live rather than captured, so
/// the caller that waited at the renewal gate sees the deadline the winner just
/// moved and spends no request of its own.
fn live_deadline(id: &str) -> Option<u64> {
    match auth::state(id) {
        AuthState::Suspect { .. } => Some(0),
        _ => accounts::find(&accounts::load(), id).and_then(|(_, a)| a.expires_at),
    }
}

/// The access token to act as, renewed first when it is near its deadline or
/// when the last call came back 401.
///
/// Both triggers run through the same gate: a suspect account reads as already
/// spent, so the next call renews it and clears the suspicion instead of
/// waiting for the user. Only a refused renewal makes that suspicion stick.
fn fresh_token(file: &AccountsFile, host: &str, account: &accounts::Account) -> Option<String> {
    fresh_token_with(file, host, account, live_deadline)
}

/// The same with the deadline supplied, so a test can put an account past one
/// without the accounts file the live reader goes through.
fn fresh_token_with(
    file: &AccountsFile,
    host: &str,
    account: &accounts::Account,
    deadline_of: impl Fn(&str) -> Option<u64>,
) -> Option<String> {
    let id = account.id.clone();
    let current = auth::token(&id);
    let deadline = || deadline_of(&id);
    if !refresh::due(deadline(), now_secs()) {
        return current;
    }
    let renewable = match account.provider {
        // Tori registers no GitHub application, so a refresh token left over
        // from the retired browser flow has nothing to exchange it with.
        Provider::Github => None,
        Provider::Gitlab => token::load_secret(&id).ok().flatten().and_then(|s| s.refresh_token),
    };
    let Some(refresh_token) = renewable else {
        // A token nothing can replace carries a deadline and no way past it.
        // Dropping it on that date would sign the account out on Tori's clock,
        // ahead of the host that is the only authority on whether it still
        // works. A rejection is that authority having already answered, so it
        // is the one due token still withheld.
        return match auth::state(&id) {
            AuthState::Suspect { .. } => None,
            _ => current,
        };
    };
    let client_id = client_id_for(file, account.provider, host)?;
    let endpoints = device_flow::gitlab_endpoints(&account.base_url);
    let renewal = refresh::Renewal {
        account_id: &id,
        refresh_token: &refresh_token,
        client_id: &client_id,
        endpoints: &endpoints,
    };
    let store = |set: &device_flow::TokenSet| -> Result<(), ForgeError> {
        let secret = Secret {
            access_token: set.access_token.clone(),
            refresh_token: set.refresh_token.clone(),
        };
        token::save_secret(&id, &secret)?;
        let at = expires_at(set.expires_in_secs);
        accounts::update(|file| {
            accounts::note_expiry(file, &id, at);
            Ok(())
        })?;
        auth::note_refreshed(&id, secret.access_token);
        Ok(())
    };
    match refresher().ensure(&UreqTransport::default(), &renewal, deadline, now_secs, store) {
        Ok(refresh::Renewed::Fresh(token)) => Some(token),
        Ok(refresh::Renewed::Current) => auth::token(&id),
        Err(refresh::RefreshFailure::Rejected(_)) => {
            auth::note_rejected(&id);
            None
        }
        // The old token is good until its own deadline, so this is a retry
        // rather than a sign-out.
        Err(refresh::RefreshFailure::NotStored(_)) => current,
    }
}

fn login_of(account_id: &str) -> Option<String> {
    match auth::state(account_id) {
        AuthState::SignedIn { login } => Some(login),
        AuthState::Suspect { login } => login,
        AuthState::SignedOut => None,
    }
}

/// A backstop behind the scheduler's own pause. The kill switch is checked
/// before resolving, so `forge.enabled` off means no work at all.
pub(crate) fn gated_client(project_path: &str) -> Result<Client, ForgeError> {
    if !auth::enabled() {
        return Err(ForgeError::NotAuthenticated);
    }
    let client = client_for(project_path)?;
    if !auth::may_call(&client.account_id) {
        return Err(ForgeError::NotAuthenticated);
    }
    Ok(client)
}

// --- pull requests ---

/// The PR for a branch, from the cache when it can be.
///
/// `refresh` is the manual-refresh path. Nothing here is persisted: see
/// [`super::prs`] for why the association is always a query.
#[tauri::command(async)]
pub fn forge_pr_for_branch(
    project_path: String,
    branch: String,
    refresh: bool,
) -> Result<Option<PullRequest>, ForgeErrorDto> {
    let c = client_for(&project_path)?;
    let out = prs::cached_lookup(&c.repo, &branch, refresh, || {
        attempt(&c, |f| f.pull_request_for_branch(&c.repo, &branch))
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
#[tauri::command(async)]
pub fn forge_create_pr(
    project_path: String,
    new_pr: NewPr,
) -> Result<PullRequest, ForgeErrorDto> {
    let c = client_for(&project_path)?;
    let req: CreatePr = new_pr.into();
    let pr = attempt(&c, |f| f.create_pull_request(&c.repo, &req))?;
    prs::record_created(&c.repo, pr.clone());
    Ok(pr)
}

/// Each pull request's state, keyed by the `owner/name` it was asked of, through
/// the gated client since nothing on screen asked.
pub fn pull_request_states(project_path: &str, numbers: &[u64]) -> Result<Vec<((String, u64), PrState)>, ForgeError> {
    let c = gated_client(project_path)?;
    let repo = format!("{}/{}", c.repo.owner, c.repo.repo).to_lowercase();
    let states = attempt(&c, |f| f.pull_request_states(&c.repo, numbers))?;
    Ok(states.into_iter().map(|(n, state)| ((repo.clone(), n), state)).collect())
}

/// Opens a pull request for a socket caller, through the gated client since
/// nothing on screen asked for it.
pub fn create_pr(project_path: &str, req: &CreatePr) -> Result<PullRequest, ForgeError> {
    let c = gated_client(project_path)?;
    let pr = attempt(&c, |f| f.create_pull_request(&c.repo, req))?;
    prs::record_created(&c.repo, pr.clone());
    Ok(pr)
}

/// Pushes the branch, then opens a pull request for it.
///
/// The push is blocking here rather than the usual fire-and-forget, because the
/// create must not run until the head exists on the remote. See
/// [`prs::push_then_create`].
#[tauri::command(async)]
pub fn forge_push_and_create_pr(
    state: tauri::State<'_, crate::askpass::AskpassState>,
    project_path: String,
    remote: String,
    new_pr: NewPr,
) -> Result<PullRequest, ForgeErrorDto> {
    let c = client_for(&project_path)?;
    let inner = state.0.clone();
    // The branch pushed is the PR's own head, read from the same payload the
    // create uses. Taking it as a separate argument is how the two end up
    // disagreeing, and a PR opened against a branch that was never pushed is
    // exactly the failure this command exists to prevent.
    let head = new_pr.head.clone();
    let req: CreatePr = new_pr.into();
    let pr = prs::push_then_create(
        || crate::git::push_branch(&project_path, &remote, &head, inner.sock_path(), inner.token()),
        || attempt(&c, |f| f.create_pull_request(&c.repo, &req)),
    )?;
    prs::record_created(&c.repo, pr.clone());
    Ok(pr)
}

/// One poll tick for a project: PR state, checks and review decision for as many
/// of `branches` as this tick covers.
///
/// `branches` is in the caller's priority order (visible units first), because
/// the frontend is the only side that knows what is on screen. Everything past
/// the per-tick cap comes back as `uncovered` rather than being dropped; see
/// [`super::status`].
#[tauri::command(async)]
pub fn forge_unit_statuses(
    project_path: String,
    branches: Vec<String>,
    refresh: bool,
) -> Result<StatusReport, ForgeErrorDto> {
    let c = gated_client(&project_path)?;
    let watched = pr_watch::watched_numbers(&c.repo.owner, &c.repo.repo);
    // Set only when this call made the request: a cache hit or a coalesced
    // flight read nothing, which is neither seen nor unseen.
    let mut reads = None;
    let out = status::cached_tick(&c.repo, &branches, refresh, |ask| {
        // The snapshot is read whether the call succeeded or not, but only a
        // success carries it out of here: an error path returns the error, and
        // the scheduler backs off on that instead.
        let fetched = attempt(&c, |f| f.unit_statuses_watching(&c.repo, ask, &watched));
        reads = Some(match &fetched {
            Ok((_, read)) => pr_watch::Read::Fetched(read.clone()),
            Err(_) => pr_watch::Read::Failed,
        });
        fetched.map(|(statuses, _)| (statuses, c.forge.rate_snapshot()))
    });
    if let Some(read) = reads.filter(|_| !watched.is_empty()) {
        pr_watch::fold(&c.repo.owner, &c.repo.repo, read);
    }
    let out = out?;
    publish_moved(&project_path, &out.statuses);
    Ok(out)
}

/// The projects and head branches a live pull request watch needs polled.
#[tauri::command]
pub fn pr_watch_polled() -> Vec<pr_watch::Polled> {
    pr_watch::polled()
}

fn publish_moved(project_path: &str, statuses: &[UnitStatus]) {
    let moved = status::moved_since_published(project_path, statuses);
    if moved.is_empty() {
        return;
    }
    let worktrees = crate::worktree::list_worktrees_body(project_path.to_string()).unwrap_or_default();
    for s in moved {
        let worktree = worktrees.iter().find(|w| w.branch == s.head_ref);
        let folder = worktree.map_or(project_path, |w| w.path.as_str());
        let pull_request = s.pull_request.as_ref().map(|pr| {
            serde_json::json!({ "number": pr.number, "state": pr.state, "draft": pr.is_draft, "url": pr.url })
        });
        crate::rpc::publish_pr(
            project_path,
            folder,
            &s.head_ref,
            worktree.is_some(),
            serde_json::json!({ "pull_request": pull_request, "checks": s.checks.state, "review": s.review_decision }),
        );
    }
}

/// Every open pull request on a project, for the Pull Requests panel.
///
/// Deliberately **not** cached and not coalesced, unlike the poll layer. This is
/// a panel the user opened, so a stale answer is worse than a request; the
/// things Phase 5 built its cache for (a tick every two minutes, per project,
/// forever) do not apply to something that happens when somebody clicks.
///
/// The kill switch is checked first for the same reason it is on the poll
/// command: `forge.enabled` off has to mean no traffic, not merely no polling.
///
/// Checks and the review decision are **not** joined in here. The panel reads
/// them from the same status store the sidebar chips do, which is what stops a
/// row and its chip from being two answers to one question.
#[tauri::command(async)]
pub fn forge_list_prs(project_path: String) -> Result<Paged<PullRequest>, ForgeErrorDto> {
    let c = gated_client(&project_path)?;
    Ok(attempt(&c, |f| f.list_pull_requests(&c.repo))?)
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
#[tauri::command(async)]
pub fn forge_pr_files(
    project_path: String,
    number: u64,
) -> Result<Paged<PrFile>, ForgeErrorDto> {
    let c = gated_client(&project_path)?;
    Ok(attempt(&c, |f| f.pull_request_files(&c.repo, number))?)
}

/// Every review conversation on one pull request.
///
/// Read over GraphQL, and that is not an optimisation: REST has no thread object
/// at all, only comments carrying an `in_reply_to_id`, and the resolve mutation
/// takes a `PullRequestReviewThread` node id that no REST response ever
/// produces. A thread read the REST way could be displayed and never resolved.
#[tauri::command(async)]
pub fn forge_review_threads(
    project_path: String,
    number: u64,
) -> Result<Paged<ReviewThread>, ForgeErrorDto> {
    let c = gated_client(&project_path)?;
    Ok(attempt(&c, |f| f.review_threads(&c.repo, number))?)
}

/// Reply to a thread, returning the comment the server stored.
///
/// The caller has already drawn the reply optimistically. What comes back is
/// what corrects the three things it had to guess: the id, the author's login,
/// and the timestamp.
#[tauri::command(async)]
pub fn forge_reply_to_thread(
    project_path: String,
    thread_id: String,
    body: String,
) -> Result<ReviewComment, ForgeErrorDto> {
    let c = gated_client(&project_path)?;
    Ok(attempt(&c, |f| f.reply_to_thread(&c.repo, &thread_id, &body))?)
}

/// Resolve or unresolve a thread.
///
/// One command with a boolean rather than two, mirroring the trait: they are the
/// same intent, and a provider that has one has the other.
///
/// `project_path` is not used to address the thread (a node id is global) but is
/// still taken, so the command refuses on a repo the forge cannot serve for the
/// same reason every other one does, and acts as that repo's account.
#[tauri::command(async)]
pub fn forge_set_thread_resolved(
    project_path: String,
    thread_id: String,
    resolved: bool,
) -> Result<(), ForgeErrorDto> {
    let c = gated_client(&project_path)?;
    Ok(attempt(&c, |f| f.set_thread_resolved(&thread_id, resolved))?)
}

/// Who an account's token belongs to.
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
#[tauri::command(async)]
pub fn forge_viewer(account_id: String) -> Result<String, ForgeErrorDto> {
    Ok(viewer_login(&account_id)?)
}

fn viewer_login(account_id: &str) -> Result<String, ForgeError> {
    if !auth::enabled() || !auth::may_call(account_id) {
        return Err(ForgeError::NotAuthenticated);
    }
    if let AuthState::SignedIn { login } = auth::state(account_id) {
        if !login.is_empty() {
            return Ok(login);
        }
    }
    learn_login(account_id)
}

/// Submit a review: a verdict, a body, and the line comments held with it.
///
/// One call, because a review is atomic on the server. Posting the comments
/// first and the verdict second would leave a half-submitted review behind
/// whenever the second call failed, with nothing telling the caller which
/// comments had already landed.
#[tauri::command(async)]
pub fn forge_submit_review(
    project_path: String,
    number: u64,
    event: ReviewEvent,
    body: String,
    comments: Vec<DraftComment>,
) -> Result<(), ForgeErrorDto> {
    Ok(submit_review(&project_path, number, event, &body, &comments, None)?)
}

/// The review a socket caller submits, the same call the review panel makes,
/// pinned to `head_sha` when the caller drew its comments against one.
pub fn submit_review(
    project_path: &str,
    number: u64,
    event: ReviewEvent,
    body: &str,
    comments: &[DraftComment],
    head_sha: Option<&str>,
) -> Result<(), ForgeError> {
    let c = gated_client(project_path)?;
    attempt(&c, |f| f.submit_review(&c.repo, number, event, body, comments, head_sha))
}

/// One pull request by its number, for a socket caller.
pub fn pull_request(project_path: &str, number: u64) -> Result<PullRequest, ForgeError> {
    let c = gated_client(project_path)?;
    attempt(&c, |f| f.pull_request(&c.repo, number))
}

/// One pull request with its files, whether the signed in account wrote it,
/// and what the host lets a review say, for a socket caller about to review it.
pub fn pr_view(project_path: &str, number: u64) -> Result<super::pr_view::PrView, ForgeError> {
    let c = gated_client(project_path)?;
    let pr = attempt(&c, |f| f.pull_request(&c.repo, number))?;
    let files = attempt(&c, |f| f.pull_request_files(&c.repo, number))?;
    let login = viewer_login(&c.account_id)?;
    Ok(super::pr_view::view(pr, files, &login, c.forge.capabilities()))
}

/// Post one line comment on its own, anchored to the commit the patch came from.
///
/// Its own command rather than a one-comment review, because it carries
/// `commit_id` and a review does not. A caller that has read a patch and then
/// waited has no way to know the head has not moved; naming the commit is what
/// turns that into a refusal instead of a comment on a line that has shifted
/// underneath it.
#[tauri::command(async)]
pub fn forge_add_review_comment(
    project_path: String,
    number: u64,
    commit_id: String,
    comment: DraftComment,
) -> Result<(), ForgeErrorDto> {
    let c = gated_client(&project_path)?;
    Ok(attempt(&c, |f| f.add_review_comment(&c.repo, number, &commit_id, &comment))?)
}

/// Run a mutation that moves a branch, and drop the caches only if it worked.
///
/// **The whole repo, not the one branch.** Landing a pull request moves the base
/// branch, so every *other* open pull request's mergeability and check rollup now
/// describe a commit that is no longer what they will be merged into.
/// Invalidating one entry leaves those siblings confidently stale.
///
/// **Only on success.** A refused mutation changed nothing on the server, and
/// throwing the caches away for it spends a fresh round of requests to re-learn
/// exactly what was already known.
fn landing<F>(repo: &RepoRef, run: F) -> Result<(), ForgeError>
where
    F: FnOnce() -> Result<(), ForgeError>,
{
    run()?;
    prs::invalidate_repo(repo);
    status::invalidate_repo(repo);
    Ok(())
}

/// One pull request in detail: whether it can be landed, how big it is, and who
/// has signed off.
///
/// The verdict is asked rather than worked out. Branch protection, required
/// reviewers and required checks are all invisible from here, so a local verdict
/// renders an enabled button the server then refuses, which is worse than no
/// button: the user learns it will not merge only after asking it to. The
/// totals come back on that same response, which is why they cost nothing extra.
///
/// Uncached, like the other view-opened reads: the poll layer's pacing exists
/// for a tick that runs forever, and this is somebody looking at one pull
/// request. `Unknown` is a real answer (GitHub is still computing it) and means
/// ask again, never "no".
#[tauri::command(async)]
pub fn forge_pr_summary(project_path: String, number: u64) -> Result<PrSummary, ForgeErrorDto> {
    let c = gated_client(&project_path)?;
    Ok(attempt(&c, |f| f.pr_summary(&c.repo, number))?)
}

/// Land the pull request.
///
/// Both caches are dropped for the whole repo on success, not just the entry for
/// this branch: a merge moves the base branch, so every other open pull request's
/// mergeability and check rollup are now answers about a commit that is no longer
/// the tip. Invalidating one branch would leave the siblings quietly stale.
///
/// Only on success. A refused merge changed nothing, and throwing the cache away
/// would spend a fresh round of requests to re-learn what it already knew.
#[tauri::command(async)]
pub fn forge_merge(
    project_path: String,
    number: u64,
    method: MergeMethod,
) -> Result<(), ForgeErrorDto> {
    Ok(merge(&project_path, number, method, None)?)
}

/// Land a pull request for a socket caller, which may pin the head it expects.
pub fn merge(
    project_path: &str,
    number: u64,
    method: MergeMethod,
    expected_head: Option<&str>,
) -> Result<(), ForgeError> {
    let c = gated_client(project_path)?;
    landing(&c.repo, || attempt(&c, |f| f.merge(&c.repo, number, method, expected_head)))
}

/// Merge the base branch into this pull request's head, on the server.
///
/// The server's merge rather than a local one, because the branch may not be
/// checked out on this machine at all; doing it here would mean a fetch, a merge
/// and a push, which is three ways to fail where the forge offers one.
///
/// The same repo-wide invalidation as a merge, for a narrower version of the same
/// reason: the head moved, so the cached check rollup describes a commit that is
/// no longer the tip.
#[tauri::command(async)]
pub fn forge_update_branch(project_path: String, number: u64) -> Result<(), ForgeErrorDto> {
    let c = gated_client(&project_path)?;
    Ok(landing(&c.repo, || attempt(&c, |f| f.update_branch(&c.repo, number)))?)
}

/// Reopen a pull request closed without merging. Through `landing` so the next
/// poll reads it as open rather than serving the cached closed answer.
#[tauri::command(async)]
pub fn forge_reopen(project_path: String, number: u64) -> Result<(), ForgeErrorDto> {
    let c = gated_client(&project_path)?;
    Ok(landing(&c.repo, || attempt(&c, |f| f.reopen(&c.repo, number)))?)
}

/// Installs the keychain store, migrates the pre-accounts token, and restores
/// every account's credential.
///
/// Failure is non-fatal and deliberately so: a keychain that will not open
/// should leave Tori running signed-out, not stop it from starting, the same way
/// the askpass bridge and the tray icon handle their own failures.
pub fn restore_at_startup(enabled: bool) {
    if let Err(e) = token::install_store() {
        log_startup(&format!("forge: {e}"));
        return;
    }
    if let Err(e) = accounts::update(|file| {
        accounts::migrate_legacy(file, token::load_legacy, token::save_secret)?;
        // After the migration, so the account it just wrote is read the same way
        // as every other one.
        accounts::backfill_source(file, |id| {
            token::load_secret(id).ok().flatten().map(|s| s.access_token)
        });
        Ok(())
    }) {
        log_startup(&format!("forge: {e}"));
    }
    let file = accounts::load();
    let mut probe = Vec::new();
    let entries = accounts::all_accounts(&file)
        .map(|(_, account)| {
            let token = token::load_secret(&account.id)
                .unwrap_or_else(|e| {
                    log_startup(&format!("forge: {e}"));
                    None
                })
                .map(|secret| secret.access_token);
            let rejected = account.rejected_at.is_some();
            let unasked = account.provider == Provider::Github && account.scopes.is_none();
            if token.is_some() && (account.login.is_none() || rejected || unasked) {
                probe.push(account.id.clone());
            }
            auth::Restored { id: account.id.clone(), token, login: account.login.clone(), rejected }
        })
        .collect();
    auth::restore(entries, enabled);
    // A migrated account has no login yet, a rejected one gets the recovery a
    // restart used to give, and a GitHub account with no recorded scopes is
    // asked once. Off the setup thread, since each is a request.
    if enabled && !probe.is_empty() {
        std::thread::spawn(move || {
            for id in probe {
                // A `cli` account first: its token is `gh`'s to rotate, so the
                // rejection is usually answered by re-reading it rather than by
                // asking the user for anything.
                if matches!(recover_cli(&id), Ok(Some(_))) {
                    continue;
                }
                let _ = learn_login(&id);
            }
        });
    }
}

/// Asks the forge who an account's token belongs to and records it.
///
/// Routed through [`auth::note_result`] like every other forge call, so a token
/// that has been revoked is discovered here and marks the account suspect rather
/// than silently failing.
fn learn_login(account_id: &str) -> Result<String, ForgeError> {
    let file = accounts::load();
    let (_, account) = accounts::find(&file, account_id).ok_or(ForgeError::NotAuthenticated)?;
    let forge = forge_for(
        account.provider,
        &account.base_url,
        auth::token(account_id),
        login_of(account_id),
    );
    let result = forge.viewer();
    auth::note_result(account_id, &result);
    let login = result?.login;
    auth::note_login(account_id, login.clone());
    let grant = reported_grant(account.provider, account.source, forge.as_ref());
    accounts::update(|file| {
        accounts::note_login(file, account_id, &login);
        if let Some(scopes) = grant.scopes {
            accounts::note_scopes(file, account_id, scopes);
        }
        // Only when the host named one: the grant read says nothing about a
        // token it could not ask about, and writing that silence back would
        // erase a deadline the sign-in recorded.
        if grant.expires_at.is_some() {
            accounts::note_expiry(file, account_id, grant.expires_at);
        }
        Ok(())
    })?;
    Ok(login)
}

/// What to record after a viewer call answered.
///
/// GitHub is free: both headers rode the call that just landed, and a token
/// reporting no classic scopes (a fine-grained one) records an empty list, so it
/// reads as asked and is not asked again at every launch. GitLab costs a
/// request, and only a pasted token is worth it: a browser account's lifetime
/// came with the exchange that minted it, and the endpoint is a personal access
/// token's own record.
fn reported_grant(provider: Provider, source: Source, forge: &dyn Forge) -> Grant {
    match provider {
        Provider::Github => {
            let grant = forge.token_grant();
            Grant { scopes: Some(grant.scopes.unwrap_or_default()), ..grant }
        }
        // Passed through as it came: GitLab has no fine-grained tokens, so an
        // instance that would not answer leaves both halves genuinely unknown,
        // which an empty list would misreport as a token holding nothing.
        Provider::Gitlab if source == Source::Token => forge.token_grant(),
        Provider::Gitlab => Grant::default(),
    }
}

fn log_startup(message: &str) {
    // Matches the prefix every other non-fatal startup failure uses in lib.rs,
    // so one grep finds them all.
    eprintln!("tori: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(number: u64, branch: &str) -> PullRequest {
        PullRequest {
            number,
            title: "t".into(),
            body: None,
            state: super::super::model::PrState::Open,
            is_draft: false,
            author: "skarif2".into(),
            created_at: "2026-09-17T08:14:00Z".into(),
            merged_at: None,
            closed_at: None,
            comments: 0,
            head_ref: branch.into(),
            base_ref: "main".into(),
            head_sha: "abc".into(),
            head_repo_is_origin: true,
            url: "u".into(),
            mergeable_state: super::super::model::MergeableState::Clean,
        }
    }

    #[test]
    fn a_refused_landing_keeps_the_caches_it_did_not_invalidate() {
        // Nothing moved on the server, so the cached answers are still true and
        // throwing them away spends a fresh round of requests to re-learn them.
        let repo = RepoRef { owner: "skarif2".into(), repo: "refused".into() };
        prs::record_created(&repo, pr(1, "wave-3"));
        let err = landing(&repo, || Err(ForgeError::NotMergeable { message: "blocked".into() }))
            .unwrap_err();
        assert!(matches!(err, ForgeError::NotMergeable { .. }));

        let served = prs::cached_lookup(&repo, "wave-3", false, || {
            panic!("a refused landing dropped a cache entry that was still true")
        })
        .unwrap();
        assert_eq!(served.map(|p| p.number), Some(1));
    }

    #[test]
    fn landing_drops_every_branch_of_the_repo_it_landed_in() {
        // The base branch moved, so every *other* open pull request's cached
        // mergeability describes a commit that is no longer what it merges into.
        // Invalidating only the landed branch leaves the siblings confidently
        // stale, which is the failure the merge guard exists to prevent.
        let repo = RepoRef { owner: "skarif2".into(), repo: "landed".into() };
        let other = RepoRef { owner: "skarif2".into(), repo: "untouched".into() };
        prs::record_created(&repo, pr(1, "wave-3"));
        prs::record_created(&repo, pr(2, "sibling"));
        prs::record_created(&other, pr(3, "wave-3"));

        landing(&repo, || Ok(())).unwrap();

        for branch in ["wave-3", "sibling"] {
            let mut asked = false;
            prs::cached_lookup(&repo, branch, false, || {
                asked = true;
                Ok(None)
            })
            .unwrap();
            assert!(asked, "{branch} was served from a cache the merge should have dropped");
        }
        // And only that repo: another checkout of the same branch name is a
        // different question, and re-asking it would spend a request for nothing.
        let served = prs::cached_lookup(&other, "wave-3", false, || {
            panic!("landing in one repo invalidated another")
        })
        .unwrap();
        assert_eq!(served.map(|p| p.number), Some(3));
    }

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
            ForgeError::AccountPickNeeded { host: "github.com".into() },
            ForgeError::Invalid { message: String::new() },
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
        let dir = std::env::temp_dir().join(format!("tori_forge_repo_{n}_{seq}"));
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
            "https://github.com",
            Some(TOKEN.into()),
            None,
        )
        .with_base("https://api.test")
    }

    fn create(f: &super::super::github::GitHubForge) -> ForgeError {
        let repo = RepoRef { owner: "skarif2".into(), repo: "tori".into() };
        let req = CreatePr {
            title: "t".into(),
            body: "b".into(),
            head: "wave-3".into(),
            base: "main".into(),
            draft: false,
        };
        f.create_pull_request(&repo, &req).unwrap_err()
    }

    fn github_account(file: &mut AccountsFile, login: &str) -> String {
        accounts::add_account(file, Provider::Github, "https://github.com", accounts::GITHUB_COM, login, accounts::Source::Token, None)
            .unwrap()
    }

    #[test]
    fn every_way_opening_a_pr_fails_is_its_own_error() {
        // The point is that the UI can branch. A single "could not open a PR"
        // string forces the user to read a sentence to learn whether to add a
        // remote, sign in again, wait, or just click through to a PR that is
        // already open.
        let no_remote = repo_at(None);
        assert!(matches!(remote_of(no_remote.to_str().unwrap()), Err(ForgeError::NoRemote)));

        let gitlab = repo_at(Some("git@gitlab.com:skarif2/tori.git"));
        let remote = remote_of(gitlab.to_str().unwrap()).unwrap();
        match client_in(&AccountsFile::default(), &BTreeMap::new(), remote).err() {
            Some(ForgeError::UnsupportedRemote { host }) => assert_eq!(host, "gitlab.com"),
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
    fn a_worktree_resolves_to_the_same_account_as_its_project() {
        let project = repo_at(Some("git@github.com:skarif2/tori.git"));
        let git = |args: &[&str]| {
            std::process::Command::new("git").arg("-C").arg(&project).args(args).output().unwrap()
        };
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "x"]);
        let worktree = project.with_extension("wt");
        git(&["worktree", "add", "-b", "wave-3", worktree.to_str().unwrap()]);

        let mut file = AccountsFile::default();
        github_account(&mut file, "skarif2");
        let work = github_account(&mut file, "globex-arif");
        let mut picks = BTreeMap::new();

        let resolve = |path: &std::path::Path, picks: &BTreeMap<String, String>| {
            client_in(&file, picks, remote_of(path.to_str().unwrap()).unwrap()).map(|c| c.account_id)
        };
        assert!(matches!(
            resolve(&project, &picks),
            Err(ForgeError::AccountPickNeeded { host }) if host == "github.com"
        ));

        picks.insert(remote_of(project.to_str().unwrap()).unwrap().key(), work.clone());
        assert_eq!(resolve(&project, &picks).ok(), Some(work.clone()));
        assert_eq!(resolve(&worktree, &picks).ok(), Some(work), "the worktree shares the pick");

        let _ = std::fs::remove_dir_all(&worktree);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_pasted_token_past_its_deadline_still_goes_out() {
        // Nothing here can renew it, and Tori's clock is not the authority on
        // whether the host still accepts it. Withholding it on the date would
        // sign the account out early, with no way back but another paste.
        let id = "github-com-lapsed-pat";
        // Installs the mock credential store process-wide; the service name is
        // this test's own, so nothing else reads what it writes.
        let _ = super::super::token::tests::mock_entry_in("com.tori.forge.lapsed-pat", id);
        auth::sign_in(id, &Secret::access("ghp_lapsed".into()), Some("lapsed".into())).unwrap();

        let account = accounts::Account {
            id: id.into(),
            provider: Provider::Github,
            base_url: "https://github.com".into(),
            login: Some("lapsed".into()),
            label: "lapsed".into(),
            expires_at: Some(1),
            rejected_at: None,
            scopes: None,
            source: Source::Token,
            org_access: Vec::new(),
        };
        let token = fresh_token_with(&AccountsFile::default(), accounts::GITHUB_COM, &account, |_| {
            Some(1)
        });
        assert_eq!(token.as_deref(), Some("ghp_lapsed"));

        auth::sign_out(id).unwrap();
    }

    #[test]
    fn a_github_account_from_the_retired_browser_flow_still_sends_its_token() {
        // What `cli-first`'s backfill left behind: a file with no `source`
        // field, whose `gho_` token reads as a browser sign-in. That route and
        // its application are gone, so there is nothing left to exchange the
        // pair against and the account has to keep working until GitHub itself
        // refuses it.
        let id = "github-com-retired-browser";
        let _ = super::super::token::tests::mock_entry_in("com.tori.forge.retired-browser", id);

        let mut file: AccountsFile = serde_json::from_str(&format!(
            r#"{{"hosts":{{"github.com":{{"accounts":[
                {{"id":"{id}","provider":"github","baseUrl":"https://github.com",
                 "login":"arif","label":"arif","expiresAt":1}}
            ]}}}}}}"#
        ))
        .unwrap();
        accounts::backfill_source(&mut file, |_| Some("gho_from_the_device_flow".into()));
        assert_eq!(accounts::find(&file, id).unwrap().1.source, Source::Browser);

        // The old flow's pair, refresh half and all.
        let pair =
            Secret { access_token: "gho_retired".into(), refresh_token: Some("ghr_retired".into()) };
        auth::sign_in(id, &pair, Some("arif".into())).unwrap();

        let (_, account) = accounts::find(&file, id).unwrap();
        let token = fresh_token_with(&file, accounts::GITHUB_COM, account, |_| Some(1));
        assert_eq!(token.as_deref(), Some("gho_retired"));

        auth::sign_out(id).unwrap();
    }

    #[test]
    fn a_github_sign_in_records_the_scopes_the_host_reported_and_gitlab_records_none() {
        use super::super::http::test_support::StubTransport;
        let stub = |resp| Box::new(StubTransport::new(vec![resp]));
        let github = github::GitHubForge::new(
            stub(StubTransport::with_headers(200, &[("X-OAuth-Scopes", "repo, workflow")], r#"{"login":"arif"}"#)),
            "https://github.com",
            Some("gho_test".into()),
            None,
        );
        github.viewer().unwrap();
        let mut file = AccountsFile::default();
        let (base_url, host) = accounts::normalize_base_url("github.com").unwrap();
        let id = accounts::add_account(&mut file, Provider::Github, &base_url, &host, "arif", accounts::Source::Token, None).unwrap();
        let grant = reported_grant(Provider::Github, Source::Token, &github);
        accounts::note_scopes(&mut file, &id, grant.scopes.unwrap());
        let file: AccountsFile = serde_json::from_str(&serde_json::to_string(&file).unwrap()).unwrap();
        let (_, account) = accounts::find(&file, &id).unwrap();
        assert_eq!(account.scopes.as_deref(), Some(&["repo".to_string(), "workflow".to_string()][..]));

        // A fine-grained token sends no header. It still counts as asked, so the
        // startup probe does not ask again at every launch.
        let fine = github::GitHubForge::new(
            stub(StubTransport::json(200, r#"{"login":"arif"}"#)),
            "https://github.com",
            Some("github_pat_test".into()),
            None,
        );
        fine.viewer().unwrap();
        assert_eq!(reported_grant(Provider::Github, Source::Token, &fine).scopes, Some(vec![]));

        let gitlab = gitlab::GitLabForge::new(
            stub(StubTransport::json(200, r#"{"username":"arif"}"#)),
            "https://gitlab.com",
            Some("glpat_test".into()),
            None,
        );
        gitlab.viewer().unwrap();
        // The one GitLab source that is not asked: the browser flow already said
        // how long its token lives, and the endpoint is a personal access
        // token's own record anyway.
        assert_eq!(reported_grant(Provider::Gitlab, Source::Browser, &gitlab), Grant::default());
    }

    #[test]
    fn a_dated_token_records_its_deadline_and_a_browser_gitlab_account_is_not_asked() {
        use super::super::http::test_support::StubTransport;
        // GitHub says so in a header on the viewer call itself, down to the
        // second and always in UTC.
        let github = github::GitHubForge::new(
            Box::new(StubTransport::new(vec![StubTransport::with_headers(
                200,
                &[
                    ("X-OAuth-Scopes", "repo, workflow"),
                    ("GitHub-Authentication-Token-Expiration", "2026-12-31 23:59:59 UTC"),
                ],
                r#"{"login":"arif"}"#,
            )])),
            "https://github.com",
            Some("ghp_dated".into()),
            None,
        );
        github.viewer().unwrap();
        let grant = reported_grant(Provider::Github, Source::Token, &github);
        assert_eq!(grant.expires_at, Some(1_798_761_599));

        // GitLab keeps both facts on the token's own record, and dates it to the
        // day rather than the second.
        let gitlab = gitlab::GitLabForge::new(
            Box::new(StubTransport::new(vec![
                StubTransport::json(200, r#"{"username":"arif"}"#),
                StubTransport::json(200, r#"{"scopes":["api","write_repository"],"expires_at":"2027-03-01"}"#),
            ])),
            "https://gitlab.com",
            Some("glpat_dated".into()),
            None,
        );
        gitlab.viewer().unwrap();
        let grant = reported_grant(Provider::Gitlab, Source::Token, &gitlab);
        assert_eq!(grant.expires_at, Some(1_803_859_200));
        assert_eq!(grant.scopes.as_deref(), Some(&["api".to_string(), "write_repository".to_string()][..]));

        // The same instance from the browser: one queued response, and a second
        // request would exhaust it, so this also proves nothing was spent.
        let browser = gitlab::GitLabForge::new(
            Box::new(StubTransport::new(vec![StubTransport::json(200, r#"{"username":"arif"}"#)])),
            "https://gitlab.com",
            Some("glpat_browser".into()),
            None,
        );
        browser.viewer().unwrap();
        assert_eq!(reported_grant(Provider::Gitlab, Source::Browser, &browser), Grant::default());
    }

    #[test]
    fn gh_answers_for_a_new_login_and_stands_aside_for_every_other_target() {
        let mut file = AccountsFile::default();
        let host = accounts::GITHUB_COM;

        // A host Tori holds nothing on: the common first sign-in, and the one
        // case where reading gh takes nothing away.
        assert!(gh_may_answer(&file, host, "skarif2", None, CliAsk::Whoever));

        let personal = accounts::add_account(
            &mut file,
            Provider::Github,
            "https://github.com",
            host,
            "skarif2",
            accounts::Source::Cli,
            None,
        )
        .unwrap();
        // Pressing add again with gh logged in as the account already held would
        // re-sign-in that one instead of adding the second identity asked for.
        assert!(!gh_may_answer(&file, host, "skarif2", None, CliAsk::Whoever));
        assert!(gh_may_answer(&file, host, "globex-arif", None, CliAsk::Whoever), "a login Tori does not hold yet");

        // Re-auth follows the account, not gh: only the account gh supplied.
        assert!(gh_may_answer(&file, host, "skarif2", Some(&personal), CliAsk::Whoever));
        let pasted = github_account(&mut file, "globex-arif");
        assert!(
            !gh_may_answer(&file, host, "globex-arif", Some(&pasted), CliAsk::Whoever),
            "a pasted account is repaired with a token, not silently re-sourced"
        );
        // gh switched accounts under a cli-sourced one: storing that token here
        // would file somebody else's credential under this account's id.
        assert!(!gh_may_answer(&file, host, "globex-arif", Some(&personal), CliAsk::Whoever));
        assert!(!gh_may_answer(&file, host, "skarif2", Some("no-such-account"), CliAsk::Whoever));

        // Pressed by hand, on a control that names the CLI: the pasted account
        // and gh are the same person, and an organisation that refused Tori's
        // application has no quarrel with gh's, so this is the one route left.
        assert!(gh_may_answer(&file, host, "globex-arif", Some(&pasted), CliAsk::Named));
        // Still not somebody else. Asking for gh cannot move an account to a
        // login that is not the one it holds.
        assert!(!gh_may_answer(&file, host, "globex-arif", Some(&personal), CliAsk::Named));
    }

    #[test]
    fn a_rejected_cli_account_recovers_from_gh_unless_gh_moved_on() {
        let mut file = AccountsFile::default();
        let host = accounts::GITHUB_COM;
        let id = accounts::add_account(
            &mut file,
            Provider::Github,
            "https://github.com",
            host,
            "skarif2",
            accounts::Source::Cli,
            None,
        )
        .unwrap();
        let account = || accounts::find(&file, &id).unwrap().1;

        // The ordinary rejection: gh rotated its token, same person behind it.
        assert!(switched_away(account(), "skarif2").is_none());
        assert!(switched_away(account(), "SKARIF2").is_none(), "logins compare without case");
        assert!(gh_may_answer(&file, host, "skarif2", Some(&id), CliAsk::Whoever), "so the fresh token is stored");

        // `gh auth switch` since: the account's id is already picked by repos,
        // so adopting this token would quietly re-point them at another person.
        let e = switched_away(account(), "globex-arif").expect("a switch is refused");
        let message = e.to_string();
        assert!(message.contains("globex-arif"), "names who gh is now: {message}");
        assert!(message.contains("skarif2"), "and who the account is: {message}");

        // A pasted account is nobody's business but the user's, switch or not.
        let pasted = github_account(&mut file, "globex-arif");
        let pasted = accounts::find(&file, &pasted).unwrap().1;
        assert!(switched_away(pasted, "someone-else").is_none());
    }

    #[test]
    fn gitlab_com_signs_in_with_tori_s_application_even_with_an_id_stored() {
        // A token renews only with the application that issued it, so an id
        // left over from before Tori registered one must not win on gitlab.com.
        let mut file = AccountsFile::default();
        accounts::set_app_id(&mut file, accounts::GITLAB_COM, "their-own-app");
        accounts::set_app_id(&mut file, "git.example.com", "company-app");

        assert_eq!(
            client_id_for(&file, Provider::Gitlab, accounts::GITLAB_COM).as_deref(),
            Some(device_flow::GITLAB_COM_CLIENT_ID)
        );
        assert_eq!(client_id_for(&file, Provider::Gitlab, "git.example.com").as_deref(), Some("company-app"));
        assert_eq!(client_id_for(&file, Provider::Gitlab, "gitlab.acme.test"), None);
    }

    #[test]
    fn each_provider_publishes_a_pull_request_head_under_its_own_ref() {
        // The one piece of provider knowledge the git layer needs. Fetching
        // GitHub's spelling from GitLab finds nothing, and the gap expander then
        // has no content to show for a merge request that is right there.
        assert_eq!(head_ref(Provider::Github, 7), "refs/pull/7/head");
        assert_eq!(head_ref(Provider::Gitlab, 7), "refs/merge-requests/7/head");
    }

    #[test]
    fn a_github_enterprise_remote_resolves_through_its_account() {
        let mut file = AccountsFile::default();
        let (base_url, host) = accounts::normalize_base_url("ghe.acme.test").unwrap();
        let id = accounts::add_account(&mut file, Provider::Github, &base_url, &host, "arif", accounts::Source::Token, None).unwrap();
        let remote = remote::parse("git@ghe.acme.test:acme/widgets.git").unwrap();
        assert_eq!(client_in(&file, &BTreeMap::new(), remote).ok().map(|c| c.account_id), Some(id));
    }

    #[test]
    fn a_clone_resolves_its_account_from_the_host_and_path_git_sends() {
        let mut file = AccountsFile::default();
        let (base_url, host) = accounts::normalize_base_url("gitlab.com").unwrap();
        let arif = accounts::add_account(&mut file, Provider::Gitlab, &base_url, &host, "skarif2", accounts::Source::Token, None).unwrap();
        let picks = BTreeMap::new();
        let path = "skarif2/masterchef.git";

        let tori = Reach::Tori;
        assert_eq!(git_account_at(&file, &picks, "gitlab.com", path, tori), None, "the switch is off");
        accounts::set_git_credentials(&mut file, "gitlab.com", true);
        assert_eq!(git_account_at(&file, &picks, "gitlab.com", path, tori), Some(arif));
        assert_eq!(git_account_at(&file, &picks, "gitlab.com:8443", path, tori), None);
        assert_eq!(git_account_at(&file, &picks, "gitlab.com", "", tori), None);

        let work = accounts::add_account(&mut file, Provider::Gitlab, &base_url, &host, "globex-arif", accounts::Source::Token, None).unwrap();
        assert_eq!(git_account_at(&file, &picks, "gitlab.com", path, tori), None, "two accounts, no pick, no default");
        let picks = BTreeMap::from([("gitlab.com/skarif2/masterchef".to_string(), work.clone())]);
        assert_eq!(git_account_at(&file, &picks, "gitlab.com", path, tori), Some(work));
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

    fn switched_off() {
        let acct = auth::Restored {
            id: "acct".into(),
            token: Some(TOKEN.into()),
            login: Some("skarif2".into()),
            rejected: false,
        };
        auth::restore(vec![acct], false);
    }

    #[test]
    fn the_kill_switch_stops_a_poll_before_it_can_reach_anything() {
        // The deferred half of the `forge.enabled` promise: the scheduler pauses
        // itself, and this is the backstop that makes "no request" true even if a
        // caller forgets. The path handed in is not a repo at all, so a build
        // where the gate is missing fails with a *remote* error instead, which is
        // what makes this assertion discriminating rather than decorative.
        let not_a_repo = std::env::temp_dir().join("tori_forge_no_repo_here");
        switched_off();

        let err = forge_unit_statuses(
            not_a_repo.to_string_lossy().into_owned(),
            vec!["wave-3".into()],
            false,
        )
        .unwrap_err();
        assert_eq!(err.kind, "notAuthenticated", "a disabled integration reached the repo");

        auth::restore(vec![], true);
    }

    #[test]
    fn the_kill_switch_stops_a_pr_listing_too() {
        // Same backstop, second door. `forge.enabled` off has to mean no
        // traffic at all, not merely no polling, and a panel the user opens is
        // exactly the caller that would otherwise reach the wire while the
        // scheduler sat paused. The path is not a repo, so a build missing the
        // gate fails with a *remote* error instead.
        let not_a_repo = std::env::temp_dir().join("tori_forge_no_repo_here");
        switched_off();

        let err = forge_list_prs(not_a_repo.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(err.kind, "notAuthenticated", "a disabled integration listed pull requests");

        auth::restore(vec![], true);
    }

    #[test]
    fn the_kill_switch_stops_a_file_listing_too() {
        // Third door onto the wire, same backstop. A PR detail view is opened by
        // a click, so it reaches Rust while the scheduler sits paused, and a
        // "no polling" reading of the toggle would let it straight through.
        let not_a_repo = std::env::temp_dir().join("tori_forge_no_repo_here");
        switched_off();

        let err = forge_pr_files(not_a_repo.to_string_lossy().into_owned(), 12).unwrap_err();
        assert_eq!(err.kind, "notAuthenticated", "a disabled integration listed changed files");

        auth::restore(vec![], true);
    }

    #[test]
    fn a_poll_report_never_carries_the_token() {
        // The whole reason the report is its own type rather than `PollOutcome`.
        let json = serde_json::to_string(&PollReport::Authorized {
            account_id: "github-com-skarif2".into(),
            login: "skarif2".into(),
        })
        .unwrap();
        assert!(json.contains("\"accountId\""));
        assert!(!json.contains("gho_"), "a token reached the frontend: {json}");
        let pending = serde_json::to_string(&PollReport::Pending { next_interval_secs: 10 }).unwrap();
        assert!(pending.contains("\"nextIntervalSecs\":10"), "the frontend reads camelCase: {pending}");

        let denied = serde_json::to_value(PollReport::Denied { code: device_flow::ACCESS_DENIED.into() }).unwrap();
        assert_eq!(denied, serde_json::json!({ "kind": "denied", "code": "access_denied" }));
        let expired = serde_json::to_value(PollReport::Expired { code: device_flow::EXPIRED_TOKEN.into() }).unwrap();
        assert_eq!(expired, serde_json::json!({ "kind": "expired", "code": "expired_token" }));
    }
}
