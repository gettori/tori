//! Which forge accounts Tori holds, per host, and which one a repo acts as.
//!
//! Pure rules over an explicit [`AccountsFile`], then thin load -> core -> save
//! wrappers, like `crate::accounts`. Tokens are not in the file: each account's
//! secret sits in the keychain under its id (see `token`).

use super::model::{AuthState, OrgAccess};
use super::remote::{canonical_host, Remote};
use super::token::Secret;
use super::ForgeError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const GITHUB_COM: &str = "github.com";
pub const GITLAB_COM: &str = "gitlab.com";

/// What the pre-accounts GitHub credential becomes. Fixed, so migrating again
/// after a deleted accounts file updates this account instead of adding a twin.
pub const MIGRATED_GITHUB_ID: &str = "github-com-migrated";

const FILE_VERSION: u32 = 2;

/// A file with no `version` predates the field, so it reads as the first one
/// rather than the current one. A migration keyed on the version has to see it.
fn legacy_version() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Github,
    Gitlab,
}

impl Provider {
    fn label(self) -> &'static str {
        match self {
            Self::Github => "GitHub",
            Self::Gitlab => "GitLab",
        }
    }
}

/// Where an account's token came from. Decides whether `gh` may speak for the
/// account, and which route a host that stops accepting it offers next.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// Read from the user's own `gh` login.
    Cli,
    /// Minted by an OAuth application of Tori's.
    Browser,
    /// Pasted by the user.
    #[default]
    Token,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Tori-minted and stable: the keychain entry and every repo pick name it.
    pub id: String,
    pub provider: Provider,
    pub base_url: String,
    #[serde(default)]
    pub login: Option<String>,
    #[serde(default)]
    pub label: String,
    /// Unix seconds, for tokens that expire.
    #[serde(default)]
    pub expires_at: Option<u64>,
    /// Unix seconds when the host stopped accepting the token, so a restart
    /// comes back suspect instead of signed in.
    #[serde(default)]
    pub rejected_at: Option<u64>,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub source: Source,
    /// Organisations that refused this account and have not been authorized
    /// since. Learned from the hosts' own refusals, never probed for.
    #[serde(default)]
    pub org_access: Vec<OrgAccess>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRecord {
    #[serde(default)]
    pub accounts: Vec<Account>,
    // Per host because only that instance's admin can register one, and absent
    // means token paste is the only route.
    #[serde(default)]
    pub app_id: Option<String>,
    /// Git over https on this host uses the repo's account instead of whatever
    /// credential helper the user has. Off by default: it takes an operation
    /// away from a helper that was already doing it.
    #[serde(default)]
    pub git_credentials: bool,
    /// Git outside Tori asks Tori for this host too, through the user's global
    /// git config.
    #[serde(default)]
    pub git_everywhere: bool,
    /// The account a repo with no pick of its own acts as.
    #[serde(default)]
    pub default_account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsFile {
    #[serde(default = "legacy_version")]
    pub version: u32,
    /// Keyed the way `remote::parse` spells a host.
    #[serde(default)]
    pub hosts: BTreeMap<String, HostRecord>,
    /// The legacy GitHub token has been copied in. Without it, removing that
    /// account would bring it back on the next launch.
    #[serde(default)]
    pub legacy_migrated: bool,
}

impl Default for AccountsFile {
    fn default() -> Self {
        Self { version: FILE_VERSION, hosts: BTreeMap::new(), legacy_migrated: false }
    }
}

pub fn all_accounts(file: &AccountsFile) -> impl Iterator<Item = (&str, &Account)> {
    file.hosts.iter().flat_map(|(host, r)| r.accounts.iter().map(move |a| (host.as_str(), a)))
}

pub fn find<'a>(file: &'a AccountsFile, id: &str) -> Option<(&'a str, &'a Account)> {
    all_accounts(file).find(|(_, a)| a.id == id)
}

pub fn normalize_base_url(input: &str) -> Result<(String, String), ForgeError> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(ForgeError::Invalid { message: "Enter the host's URL.".into() });
    }
    let invalid = || ForgeError::Invalid { message: format!("{trimmed} is not a host URL.") };
    let (scheme, rest) = match trimmed.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => ("https".to_string(), trimmed),
    };
    if scheme == "http" {
        return Err(ForgeError::Invalid { message: "Tori signs in to hosts over https only.".into() });
    }
    if scheme != "https" {
        return Err(invalid());
    }
    let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (canonical_host(host), format!(":{port}")),
        None => (canonical_host(authority), String::new()),
    };
    if host.is_empty() || host.contains(char::is_whitespace) || path.contains(char::is_whitespace) {
        return Err(invalid());
    }
    Ok((format!("{scheme}://{host}{port}{path}"), host))
}

/// The same login on a host updates that account instead of adding one, and a
/// sign-in for an account with no login yet (the migrated one) adopts it.
pub fn add_account(
    file: &mut AccountsFile,
    provider: Provider,
    base_url: &str,
    host: &str,
    login: &str,
    source: Source,
    reauth: Option<&str>,
) -> Result<String, ForgeError> {
    let mut taken: Vec<String> = all_accounts(file).map(|(_, a)| a.id.clone()).collect();
    taken.push(MIGRATED_GITHUB_ID.to_string());
    if let Some(other) = file.hosts.get(host).and_then(|r| r.accounts.iter().find(|a| a.provider != provider)) {
        return Err(ForgeError::Invalid {
            message: format!("{host} is already added as {}.", other.provider.label()),
        });
    }
    let record = file.hosts.entry(host.to_string()).or_default();
    let same_login = |a: &&mut Account| a.login.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(login));
    if let Some(existing) = record.accounts.iter_mut().find(same_login) {
        existing.login = Some(login.to_string());
        existing.base_url = base_url.to_string();
        existing.rejected_at = None;
        existing.source = source;
        return Ok(existing.id.clone());
    }
    let unnamed = |a: &&mut Account| a.login.is_none() && reauth == Some(a.id.as_str());
    if let Some(adopted) = record.accounts.iter_mut().find(unnamed) {
        adopted.login = Some(login.to_string());
        if adopted.label.is_empty() {
            adopted.label = login.to_string();
        }
        adopted.base_url = base_url.to_string();
        adopted.rejected_at = None;
        adopted.source = source;
        return Ok(adopted.id.clone());
    }
    let id = mint_id(&taken, host, login);
    record.accounts.push(Account {
        id: id.clone(),
        provider,
        base_url: base_url.to_string(),
        login: Some(login.to_string()),
        label: login.to_string(),
        expires_at: None,
        rejected_at: None,
        scopes: None,
        source,
        org_access: Vec::new(),
    });
    Ok(id)
}

/// The route an account took, for files written before the field existed.
///
/// Only an OAuth application mints a `gho_` token, so that prefix is the one
/// surviving record of a browser sign-in on an account that never stored its
/// route. Gated on the file version rather than run every launch, because a
/// `gh` token wears the same prefix and would keep flipping a [`Source::Cli`]
/// account to [`Source::Browser`].
pub fn backfill_source(file: &mut AccountsFile, read: impl Fn(&str) -> Option<String>) {
    if file.version >= FILE_VERSION {
        return;
    }
    for account in file.hosts.values_mut().flat_map(|r| r.accounts.iter_mut()) {
        if account.provider == Provider::Github && read(&account.id).is_some_and(|t| t.starts_with("gho_")) {
            account.source = Source::Browser;
        }
    }
    file.version = FILE_VERSION;
}

/// Readable rather than random, so the keychain entry names who it is for.
fn mint_id(taken: &[String], host: &str, login: &str) -> String {
    let slug = |s: &str| -> String {
        s.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect()
    };
    let base = format!("{}-{}", slug(host), slug(login));
    if !taken.contains(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|id| !taken.contains(id))
        .expect("an unbounded range always finds a free suffix")
}

pub fn remove_account(file: &mut AccountsFile, id: &str) -> Option<Account> {
    let host = find(file, id).map(|(host, _)| host.to_string())?;
    let record = file.hosts.get_mut(&host)?;
    let index = record.accounts.iter().position(|a| a.id == id)?;
    let removed = record.accounts.remove(index);
    if record.default_account.as_deref() == Some(id) {
        record.default_account = None;
    }
    if record.accounts.is_empty() {
        file.hosts.remove(&host);
    }
    Some(removed)
}

// Absolute rather than a duration, because the process will not be running for
// most of the wait.
pub fn note_expiry(file: &mut AccountsFile, id: &str, expires_at: Option<u64>) {
    for account in file.hosts.values_mut().flat_map(|r| r.accounts.iter_mut()) {
        if account.id == id {
            account.expires_at = expires_at;
        }
    }
}

/// A still-suspect account keeps the date it was first rejected on.
pub fn note_rejection(file: &mut AccountsFile, id: &str, suspect: bool, now: u64) {
    for account in file.hosts.values_mut().flat_map(|r| r.accounts.iter_mut()) {
        if account.id == id {
            account.rejected_at = if suspect { account.rejected_at.or(Some(now)) } else { None };
        }
    }
}

/// Files an organisation's refusal, once.
///
/// An organisation that is in the way refuses every poll tick, and the URL
/// carries a per-request authorization token, so a newest-wins rule would
/// rewrite the accounts file every couple of minutes for as long as the block
/// lasted. The first URL is kept instead: opening a spent one lands on GitHub's
/// own page, which issues a fresh challenge there.
///
/// Answers whether anything changed, so the caller can skip the save.
pub fn note_org_access(file: &mut AccountsFile, id: &str, access: OrgAccess) -> bool {
    let mut added = false;
    for account in file.hosts.values_mut().flat_map(|r| r.accounts.iter_mut()) {
        if account.id == id && !account.org_access.iter().any(|a| a.org == access.org) {
            account.org_access.push(access.clone());
            added = true;
        }
    }
    added
}

/// Forgets every refusal on record for an account.
///
/// A sign-in mints a new token with an SSO session of its own, so the stored
/// authorization URLs no longer apply and an org that was blocked may not be.
/// Keeping them would show the user a list of problems they may have just fixed.
pub fn clear_org_access(file: &mut AccountsFile, id: &str) {
    for account in file.hosts.values_mut().flat_map(|r| r.accounts.iter_mut()) {
        if account.id == id {
            account.org_access.clear();
        }
    }
}

pub fn note_scopes(file: &mut AccountsFile, id: &str, scopes: Vec<String>) {
    for account in file.hosts.values_mut().flat_map(|r| r.accounts.iter_mut()) {
        if account.id == id {
            account.scopes = Some(scopes.clone());
        }
    }
}

pub fn note_login(file: &mut AccountsFile, id: &str, login: &str) {
    for account in file.hosts.values_mut().flat_map(|r| r.accounts.iter_mut()) {
        if account.id == id {
            account.login = Some(login.to_string());
            if account.label.is_empty() {
                account.label = login.to_string();
            }
        }
    }
}

/// The old keychain entry is only read, never deleted, so a downgrade still
/// signs in.
pub fn migrate_legacy(
    file: &mut AccountsFile,
    load_legacy: impl FnOnce() -> Result<Option<String>, ForgeError>,
    save: impl FnOnce(&str, &Secret) -> Result<(), ForgeError>,
) -> Result<(), ForgeError> {
    if file.legacy_migrated {
        return Ok(());
    }
    let Some(token) = load_legacy()? else {
        return Ok(());
    };
    save(MIGRATED_GITHUB_ID, &Secret::access(token))?;
    let record = file.hosts.entry(GITHUB_COM.to_string()).or_default();
    if !record.accounts.iter().any(|a| a.id == MIGRATED_GITHUB_ID) {
        record.accounts.push(Account {
            id: MIGRATED_GITHUB_ID.to_string(),
            provider: Provider::Github,
            base_url: format!("https://{GITHUB_COM}"),
            login: None,
            label: String::new(),
            expires_at: None,
            rejected_at: None,
            scopes: None,
            source: Source::default(),
            org_access: Vec::new(),
        });
    }
    file.legacy_migrated = true;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    Account(String),
    /// More than one account on the host and no pick for this repo.
    Pick { candidates: Vec<String> },
    NoAccount,
}

pub fn resolve(file: &AccountsFile, picks: &BTreeMap<String, String>, remote: &Remote) -> Resolution {
    let record = file.hosts.get(&remote.host);
    let accounts = record.map(|r| r.accounts.as_slice()).unwrap_or_default();
    if let Some(picked) = picks.get(&remote.key()) {
        if accounts.iter().any(|a| &a.id == picked) {
            return Resolution::Account(picked.clone());
        }
    }
    if let Some(default) = record.and_then(default_account) {
        return Resolution::Account(default);
    }
    match accounts {
        [] => Resolution::NoAccount,
        [only] => Resolution::Account(only.id.clone()),
        many => Resolution::Pick { candidates: many.iter().map(|a| a.id.clone()).collect() },
    }
}

fn default_account(record: &HostRecord) -> Option<String> {
    record.default_account.clone().filter(|id| record.accounts.iter().any(|a| &a.id == id))
}

pub fn set_default_account(file: &mut AccountsFile, host: &str, id: Option<&str>) -> Result<bool, ForgeError> {
    let record = file.hosts.get_mut(host);
    if let Some(id) = id {
        if !record.as_ref().is_some_and(|r| r.accounts.iter().any(|a| a.id == id)) {
            return Err(ForgeError::Invalid { message: format!("That account is not on {host}.") });
        }
    }
    let Some(record) = record else {
        return Ok(false);
    };
    let next = id.map(str::to_string);
    if record.default_account == next {
        return Ok(false);
    }
    record.default_account = next;
    Ok(true)
}

pub fn drop_picks_for(picks: &mut BTreeMap<String, String>, id: &str) -> bool {
    let before = picks.len();
    picks.retain(|_, picked| picked != id);
    picks.len() != before
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInRoutes {
    pub host: String,
    pub base_url: String,
    /// GitLab only, and only where Tori holds an OAuth client id for the host.
    pub device_flow: bool,
    pub scopes: Vec<String>,
    pub token_url: String,
    // Self-managed GitLab only: on gitlab.com the application is Tori's own,
    // and showing it would invite editing something the user cannot change.
    pub app_id: Option<String>,
}

// An empty stored id reads as absent, so clearing the field in Settings puts
// the host back on token paste.
pub fn app_id(file: &AccountsFile, host: &str) -> Option<String> {
    file.hosts
        .get(host)
        .and_then(|r| r.app_id.clone())
        .filter(|id| !id.trim().is_empty())
}

pub fn set_app_id(file: &mut AccountsFile, host: &str, app_id: &str) -> bool {
    let trimmed = app_id.trim();
    let record = file.hosts.entry(host.to_string()).or_default();
    let next = (!trimmed.is_empty()).then(|| trimmed.to_string());
    if record.app_id == next {
        // A host record kept only for an id that was never set would be an
        // empty entry nothing removes.
        if next.is_none() && record.accounts.is_empty() {
            file.hosts.remove(host);
        }
        return false;
    }
    record.app_id = next;
    if record.app_id.is_none() && record.accounts.is_empty() {
        file.hosts.remove(host);
    }
    true
}

/// Whether git on this host should ask Tori for a credential.
///
/// An account is part of the answer rather than a separate check: the switch
/// exists to hand git *an account's* token, so a host with none cannot be on,
/// which is also what turns it off when the last account goes.
pub fn git_credentials(file: &AccountsFile, host: &str) -> bool {
    file.hosts.get(host).is_some_and(|r| r.git_credentials && !r.accounts.is_empty())
}

pub fn set_git_credentials(file: &mut AccountsFile, host: &str, on: bool) -> bool {
    let Some(record) = file.hosts.get_mut(host) else {
        return false;
    };
    if record.git_credentials == on {
        return false;
    }
    record.git_credentials = on;
    // Off takes the second switch with it, so turning this back on later does
    // not quietly edit the user's global config again.
    record.git_everywhere &= on;
    true
}

/// Only on top of the host's own switch, which is what makes Tori answer at all.
pub fn git_everywhere(file: &AccountsFile, host: &str) -> bool {
    git_credentials(file, host) && file.hosts.get(host).is_some_and(|r| r.git_everywhere)
}

pub fn set_git_everywhere(file: &mut AccountsFile, host: &str, on: bool) -> bool {
    if on && !git_credentials(file, host) {
        return false;
    }
    let Some(record) = file.hosts.get_mut(host) else {
        return false;
    };
    if record.git_everywhere == on {
        return false;
    }
    record.git_everywhere = on;
    true
}

/// Whether git in this checkout should ask Tori: the host's switch is on and
/// the repo acts as exactly one account on it. An unanswered pick falls back to
/// the user's own helpers rather than to a prompt.
pub fn serves_git(file: &AccountsFile, picks: &BTreeMap<String, String>, remote: &Remote) -> bool {
    git_credentials(file, &remote.host) && matches!(resolve(file, picks, remote), Resolution::Account(_))
}

pub fn sign_in_routes(
    provider: Provider,
    base_url: &str,
    host: &str,
    client_id: Option<&str>,
    git_credentials: bool,
) -> SignInRoutes {
    // GitHub's `repo` already carries push, and `workflow` is what lets that push
    // include CI files; GitLab splits the API from the git protocol, so a token
    // that has to serve both says so.
    let scopes: Vec<&str> = match (provider, git_credentials) {
        (Provider::Github, _) => vec!["repo", "workflow"],
        (Provider::Gitlab, false) => vec!["api"],
        (Provider::Gitlab, true) => vec!["api", "write_repository"],
    };
    let token_url = match provider {
        Provider::Github => format!("{base_url}/settings/tokens/new?scopes={}&description=Tori", scopes.join(",")),
        Provider::Gitlab => format!(
            "{base_url}/-/user_settings/personal_access_tokens?name=Tori&scopes={}",
            scopes.join(",")
        ),
    };
    SignInRoutes {
        host: host.to_string(),
        base_url: base_url.to_string(),
        // GitLab's application is registered per instance, so any host with an
        // id has a browser flow. Tori has no GitHub application at all, so
        // every GitHub host signs in through the CLI or a pasted token.
        device_flow: provider == Provider::Gitlab && client_id.is_some_and(|id| !id.trim().is_empty()),
        scopes: scopes.iter().map(|s| s.to_string()).collect(),
        token_url,
        app_id: match provider {
            Provider::Gitlab if host != GITLAB_COM => client_id.map(|id| id.to_string()).filter(|id| !id.is_empty()),
            _ => None,
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    #[serde(flatten)]
    pub account: Account,
    pub auth: AuthState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub host: String,
    pub accounts: Vec<AccountView>,
    pub git_credentials: bool,
    pub git_everywhere: bool,
    pub default_account: Option<String>,
    /// The OAuth application the user registered on a self-managed instance.
    /// Absent on the clouds, where the application is Tori's own and showing it
    /// would invite editing something the user cannot change.
    pub app_id: Option<String>,
}

pub fn account_view(account: &Account, auth: impl Fn(&str) -> AuthState) -> AccountView {
    AccountView { account: account.clone(), auth: auth(&account.id) }
}

pub fn view(file: &AccountsFile, auth: impl Fn(&str) -> AuthState) -> Vec<HostView> {
    file.hosts
        .iter()
        .filter(|(_, record)| !record.accounts.is_empty())
        .map(|(host, record)| HostView {
            host: host.clone(),
            accounts: record.accounts.iter().map(|a| account_view(a, &auth)).collect(),
            git_credentials: git_credentials(file, host),
            git_everywhere: git_everywhere(file, host),
            default_account: default_account(record),
            app_id: (host != GITLAB_COM && host != GITHUB_COM).then(|| app_id(file, host)).flatten(),
        })
        .collect()
}

pub fn accounts_path() -> PathBuf {
    crate::owned_state::config_dir().join("forge_accounts.json")
}

/// An unreadable file reads as empty, like every other Tori store.
pub fn load() -> AccountsFile {
    std::fs::read_to_string(accounts_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Load, change, save, under one lock so two sign-ins cannot mint one id twice.
pub fn update<R>(
    change: impl FnOnce(&mut AccountsFile) -> Result<R, ForgeError>,
) -> Result<R, ForgeError> {
    let lock = crate::exec::named_lock("forge_accounts");
    let _guard = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = load();
    let before = file.clone();
    let out = change(&mut file)?;
    if file != before {
        let text = serde_json::to_string_pretty(&file)
            .map_err(|e| ForgeError::Malformed { message: e.to_string() })?;
        crate::owned_state::write_atomically(&accounts_path(), &text)
            .map_err(|message| ForgeError::Transport { message })?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::super::remote;
    use super::super::token::{self, tests::mock_entry_in};
    use super::*;

    const GH: &str = "https://github.com";

    fn signed_in(file: &mut AccountsFile, login: &str) -> String {
        add_account(file, Provider::Github, GH, GITHUB_COM, login, Source::Token, None).unwrap()
    }

    #[test]
    fn a_saml_refusal_names_the_org_from_its_own_url_and_is_filed_once() {
        use super::super::http::{sso_challenge, test_support::StubTransport};
        let refusal = |value: &str| {
            StubTransport::with_headers(403, &[("X-GitHub-SSO", value)], r#"{"message":"Resource protected by organization SAML enforcement."}"#)
        };
        let first = sso_challenge(&refusal(
            "required; url=https://github.com/orgs/acme/sso?authorization_request=AR_one",
        ))
        .expect("a required challenge names its org");
        assert_eq!(first.org, "acme");
        assert_eq!(first.url, "https://github.com/orgs/acme/sso?authorization_request=AR_one");

        // The other form of the header lists numeric ids and no URL, so there is
        // no login in it to record.
        assert_eq!(sso_challenge(&refusal("partial-results; organizations=21955855")), None);

        let mut file = AccountsFile::default();
        let id = signed_in(&mut file, "arif");
        assert!(note_org_access(&mut file, &id, first), "the first refusal is news");
        assert!(
            !note_org_access(
                &mut file,
                &id,
                OrgAccess { org: "acme".into(), url: "https://github.com/orgs/acme/sso?authorization_request=AR_two".into() },
            ),
            "the same org again changes nothing, so the caller skips the save"
        );
        let (_, account) = find(&file, &id).unwrap();
        // One entry, still the first URL. The refusal repeats on every tick, so
        // a newest-wins rule would rewrite the file for as long as the block
        // lasted, and a spent challenge lands on the page that issues a new one.
        assert_eq!(account.org_access.len(), 1);
        assert_eq!(account.org_access[0].url, "https://github.com/orgs/acme/sso?authorization_request=AR_one");

        // Signing in again mints a new SSO session, so what the old token was
        // refused says nothing about the new one.
        clear_org_access(&mut file, &id);
        assert!(find(&file, &id).unwrap().1.org_access.is_empty());
    }

    fn tori() -> Remote {
        remote::parse("git@github.com:skarif2/tori.git").unwrap()
    }

    #[test]
    fn the_file_round_trips_and_login_and_expiry_may_be_absent() {
        let mut file = AccountsFile::default();
        signed_in(&mut file, "skarif2");
        let text = serde_json::to_string(&file).unwrap();
        assert_eq!(serde_json::from_str::<AccountsFile>(&text).unwrap(), file);

        let bare: AccountsFile = serde_json::from_str(
            r#"{"hosts":{"git.example.com":{"accounts":[
                {"id":"a","provider":"gitlab","baseUrl":"https://git.example.com","label":"Work"}
            ]}}}"#,
        )
        .unwrap();
        let (_, account) = find(&bare, "a").unwrap();
        assert_eq!((account.login.as_deref(), account.expires_at), (None, None));
    }

    #[test]
    fn a_file_without_sources_backfills_the_browser_ones_once() {
        let mut file: AccountsFile = serde_json::from_str(
            r#"{"hosts":{"github.com":{"accounts":[
                {"id":"browser","provider":"github","baseUrl":"https://github.com","login":"a"},
                {"id":"pasted","provider":"github","baseUrl":"https://github.com","login":"b"}
            ]}}}"#,
        )
        .unwrap();
        assert_eq!(file.version, 1, "a file with no version predates the field");
        let source = |file: &AccountsFile, id| find(file, id).unwrap().1.source;
        assert_eq!(source(&file, "browser"), Source::Token);

        let stored = |id: &str| match id {
            "browser" => Some("gho_from_the_device_flow".to_string()),
            _ => Some("ghp_pasted_by_hand".to_string()),
        };
        backfill_source(&mut file, stored);
        assert_eq!(source(&file, "browser"), Source::Browser);
        assert_eq!(source(&file, "pasted"), Source::Token);

        // A `gh` token wears the same prefix, so a second pass must not reach an
        // account that has since signed in through the CLI.
        let mut again = file.clone();
        for account in again.hosts.values_mut().flat_map(|r| r.accounts.iter_mut()) {
            account.source = Source::Cli;
        }
        backfill_source(&mut again, stored);
        assert_eq!(source(&again, "browser"), Source::Cli);
    }

    #[test]
    fn signing_in_by_another_route_records_that_route() {
        let mut file = AccountsFile::default();
        let id = signed_in(&mut file, "skarif2");
        assert_eq!(find(&file, &id).unwrap().1.source, Source::Token);
        add_account(&mut file, Provider::Github, GH, GITHUB_COM, "skarif2", Source::Cli, None).unwrap();
        assert_eq!(find(&file, &id).unwrap().1.source, Source::Cli, "the same account, re-sourced");
    }

    #[test]
    fn two_users_make_two_accounts_and_one_user_twice_makes_one() {
        let mut file = AccountsFile::default();
        let first = signed_in(&mut file, "skarif2");
        let second = signed_in(&mut file, "fonn-arif");
        assert_ne!(first, second);
        assert_eq!(signed_in(&mut file, "SKARIF2"), first, "logins compare without case");
        assert_eq!(file.hosts[GITHUB_COM].accounts.len(), 2);
    }

    #[test]
    fn signing_in_again_clears_a_recorded_rejection() {
        let mut file = AccountsFile::default();
        let id = signed_in(&mut file, "skarif2");
        note_rejection(&mut file, &id, true, 1_785_179_400);
        let text = serde_json::to_string(&file).unwrap();
        assert_eq!(serde_json::from_str::<AccountsFile>(&text).unwrap(), file);

        assert_eq!(signed_in(&mut file, "skarif2"), id);
        assert_eq!(find(&file, &id).unwrap().1.rejected_at, None);
    }

    #[test]
    fn the_legacy_token_becomes_one_github_account_and_stays_for_a_downgrade() {
        let legacy = mock_entry_in("com.tori.forge.github.migration-test", "oauth");
        token::save_to(&legacy, "gho_legacy").unwrap();
        let store = |id: &str, secret: &Secret| {
            token::save_secret_to(&mock_entry_in("com.tori.forge.migration-test", id), secret)
        };
        let read_legacy = || token::load_from(&legacy);

        let mut file = AccountsFile::default();
        migrate_legacy(&mut file, read_legacy, store).unwrap();
        assert_eq!(file.hosts[GITHUB_COM].accounts.len(), 1);
        let moved = mock_entry_in("com.tori.forge.migration-test", MIGRATED_GITHUB_ID);
        assert_eq!(token::load_secret_from(&moved).unwrap(), Some(Secret::access("gho_legacy".into())));
        let restored = super::super::auth::AuthStore::restored(
            vec![super::super::auth::Restored {
                id: MIGRATED_GITHUB_ID.into(),
                token: Some("gho_legacy".into()),
                login: None,
                rejected: false,
            }],
            true,
        );
        assert!(restored.may_call(MIGRATED_GITHUB_ID), "comes up signed in");

        let after_first = file.clone();
        migrate_legacy(&mut file, || panic!("read once"), store).unwrap();
        assert_eq!(file, after_first, "a second run adds nothing");
        assert_eq!(token::load_from(&legacy).unwrap().as_deref(), Some("gho_legacy"));

        // A deleted accounts file migrates again onto the same fixed id.
        let mut fresh = AccountsFile::default();
        migrate_legacy(&mut fresh, read_legacy, store).unwrap();
        assert_eq!(fresh, after_first);
    }

    #[test]
    fn a_repo_uses_the_only_account_and_asks_when_there_are_two() {
        let mut file = AccountsFile::default();
        let mut picks = BTreeMap::new();
        assert_eq!(resolve(&file, &picks, &tori()), Resolution::NoAccount);

        let personal = signed_in(&mut file, "skarif2");
        assert_eq!(resolve(&file, &picks, &tori()), Resolution::Account(personal.clone()));

        let work = signed_in(&mut file, "fonn-arif");
        assert!(matches!(resolve(&file, &picks, &tori()), Resolution::Pick { candidates } if candidates.len() == 2));

        picks.insert(tori().key(), work.clone());
        let https = remote::parse("https://github.com/skarif2/tori").unwrap();
        assert_eq!(resolve(&file, &picks, &https), Resolution::Account(work), "ssh to https keeps the pick");
    }

    #[test]
    fn removing_the_picked_account_returns_the_repo_to_the_pick() {
        let mut file = AccountsFile::default();
        signed_in(&mut file, "a");
        signed_in(&mut file, "b");
        let picked = signed_in(&mut file, "c");
        let mut picks = BTreeMap::from([(tori().key(), picked.clone())]);

        remove_account(&mut file, &picked);
        assert!(drop_picks_for(&mut picks, &picked));
        assert!(matches!(resolve(&file, &picks, &tori()), Resolution::Pick { candidates } if candidates.len() == 2));
    }

    #[test]
    fn a_repo_pick_beats_the_host_default_which_beats_the_pick_state() {
        let mut file = AccountsFile::default();
        let personal = signed_in(&mut file, "skarif2");
        let work = signed_in(&mut file, "fonn-arif");
        let mut picks = BTreeMap::new();
        assert!(matches!(resolve(&file, &picks, &tori()), Resolution::Pick { .. }));

        assert_eq!(set_default_account(&mut file, GITHUB_COM, Some(&work)), Ok(true));
        assert_eq!(resolve(&file, &picks, &tori()), Resolution::Account(work.clone()));

        picks.insert(tori().key(), personal.clone());
        assert_eq!(resolve(&file, &picks, &tori()), Resolution::Account(personal.clone()));

        // Removal is the one thing that clears a default, so the only account left answers.
        picks.clear();
        remove_account(&mut file, &work);
        assert_eq!(file.hosts[GITHUB_COM].default_account, None);
        assert_eq!(resolve(&file, &picks, &tori()), Resolution::Account(personal));

        let text = serde_json::to_string(&file).unwrap();
        assert_eq!(serde_json::from_str::<AccountsFile>(&text).unwrap(), file);
    }

    #[test]
    fn a_default_naming_no_account_on_the_host_is_refused_or_ignored() {
        let mut file = AccountsFile::default();
        signed_in(&mut file, "a");
        signed_in(&mut file, "b");
        let elsewhere =
            add_account(&mut file, Provider::Gitlab, "https://gitlab.com", GITLAB_COM, "arif", Source::Token, None).unwrap();
        assert!(matches!(
            set_default_account(&mut file, GITHUB_COM, Some(&elsewhere)),
            Err(ForgeError::Invalid { .. })
        ));
        assert!(set_default_account(&mut file, "ghe.example.com", Some("a")).is_err());
        assert_eq!(set_default_account(&mut file, "ghe.example.com", None), Ok(false));

        // A hand-edited file can still name a stranger, and resolution must not act as it.
        file.hosts.get_mut(GITHUB_COM).unwrap().default_account = Some("gone".into());
        assert!(matches!(resolve(&file, &BTreeMap::new(), &tori()), Resolution::Pick { .. }));
    }

    #[test]
    fn a_host_default_lets_git_be_answered_without_a_repo_pick() {
        let mut file = AccountsFile::default();
        signed_in(&mut file, "skarif2");
        let work = signed_in(&mut file, "fonn-arif");
        set_git_credentials(&mut file, GITHUB_COM, true);
        let picks = BTreeMap::new();
        assert!(!serves_git(&file, &picks, &tori()));

        set_default_account(&mut file, GITHUB_COM, Some(&work)).unwrap();
        assert!(serves_git(&file, &picks, &tori()));
    }

    #[test]
    fn a_host_holding_only_an_application_id_is_not_listed() {
        let mut file = AccountsFile::default();
        set_app_id(&mut file, "git.example.com", "app-123");
        signed_in(&mut file, "skarif2");

        let hosts = view(&file, |_| AuthState::SignedOut);
        assert_eq!(hosts.iter().map(|h| h.host.as_str()).collect::<Vec<_>>(), [GITHUB_COM]);
    }

    #[test]
    fn a_host_view_names_its_default_in_camel_case() {
        let mut file = AccountsFile::default();
        let id = signed_in(&mut file, "skarif2");
        let json = serde_json::to_value(view(&file, |_| AuthState::SignedOut)).unwrap();
        assert_eq!(json[0]["defaultAccount"], serde_json::Value::Null);

        set_default_account(&mut file, GITHUB_COM, Some(&id)).unwrap();
        let json = serde_json::to_value(view(&file, |_| AuthState::SignedOut)).unwrap();
        assert_eq!(json[0]["defaultAccount"], id.as_str());
    }

    #[test]
    fn every_github_host_offers_only_a_token_and_names_the_scopes() {
        // An id in hand changes nothing on GitHub: there is no application to
        // use it, so github.com and an enterprise server answer the same way.
        let github = sign_in_routes(Provider::Github, GH, GITHUB_COM, Some("Ov23test"), false);
        assert!(!github.device_flow);
        assert_eq!(github.scopes, ["repo", "workflow"]);
        assert!(github.token_url.contains("scopes=repo,workflow"));
        assert!(github.token_url.starts_with("https://github.com/settings/tokens/new"));

        let ghe =
            sign_in_routes(Provider::Github, "https://ghe.example.com", "ghe.example.com", Some("Ov23test"), false);
        assert!(!ghe.device_flow);
        assert_eq!(ghe.scopes, ["repo", "workflow"]);
        assert!(ghe.token_url.starts_with("https://ghe.example.com/"));

        let gitlab = sign_in_routes(Provider::Gitlab, "https://gitlab.com", GITLAB_COM, None, false);
        assert!(!gitlab.device_flow);
        assert_eq!(gitlab.scopes, ["api"]);
    }

    #[test]
    fn gitlab_com_offers_the_browser_without_exposing_tori_s_application_id() {
        let gitlab = sign_in_routes(Provider::Gitlab, "https://gitlab.com", GITLAB_COM, Some("tori-app"), false);
        assert!(gitlab.device_flow);
        assert_eq!(gitlab.app_id, None, "an id the card would show is an id the user would try to edit");

        let own = sign_in_routes(Provider::Gitlab, "https://git.example.com", "git.example.com", Some("app-123"), false);
        assert_eq!(own.app_id.as_deref(), Some("app-123"));
    }

    #[test]
    fn the_git_switch_is_off_by_default_and_goes_with_the_last_account() {
        let mut file = AccountsFile::default();
        let host = "gitlab.example.com";
        let base = "https://gitlab.example.com";
        let first = add_account(&mut file, Provider::Gitlab, base, host, "arif", Source::Token, None).unwrap();
        assert!(!git_credentials(&file, host), "git keeps its own helpers until asked");

        assert!(set_git_credentials(&mut file, host, true));
        assert!(git_credentials(&file, host));
        let text = serde_json::to_string(&file).unwrap();
        assert_eq!(serde_json::from_str::<AccountsFile>(&text).unwrap(), file);

        // On with the switch, the token has to serve the git protocol as well
        // as the API, so the paste screen asks for the scope that does.
        let routes = sign_in_routes(Provider::Gitlab, base, host, None, git_credentials(&file, host));
        assert_eq!(routes.scopes, ["api", "write_repository"]);
        assert!(routes.token_url.contains("scopes=api,write_repository"));

        let remote = remote::parse("https://gitlab.example.com/acme/widgets.git").unwrap();
        let mut picks = BTreeMap::new();
        assert!(serves_git(&file, &picks, &remote), "one account, so git can be answered");

        // An unanswered pick is not an account to act as, so git keeps whatever
        // helper it had rather than being handed an arbitrary one.
        let second = add_account(&mut file, Provider::Gitlab, base, host, "arif-work", Source::Token, None).unwrap();
        assert!(!serves_git(&file, &picks, &remote));
        picks.insert(remote.key(), second.clone());
        assert!(serves_git(&file, &picks, &remote));

        // The last account leaving takes the switch with it: there is nothing
        // left to hand git, so the flag cannot read as on.
        remove_account(&mut file, &first);
        remove_account(&mut file, &second);
        assert!(!git_credentials(&file, host));
        assert!(!serves_git(&file, &picks, &remote));
    }

    #[test]
    fn a_self_managed_gitlab_offers_the_browser_once_its_application_id_is_stored() {
        // Only that instance's admin can register an application, so the id is
        // per host and its absence is what leaves token paste as the one route.
        let mut file = AccountsFile::default();
        let host = "git.example.com";
        let base = "https://git.example.com";
        let routes = |file: &AccountsFile| {
            sign_in_routes(Provider::Gitlab, base, host, app_id(file, host).as_deref(), false)
        };
        assert!(!routes(&file).device_flow);

        assert!(set_app_id(&mut file, host, "app-123"));
        assert!(routes(&file).device_flow, "a registered application unlocks the browser");
        assert_eq!(routes(&file).app_id.as_deref(), Some("app-123"));

        // Clearing it puts the host back on paste, and takes the record with it:
        // an entry holding neither an account nor an id is one nothing removes.
        assert!(set_app_id(&mut file, host, "   "));
        assert!(!routes(&file).device_flow);
        assert!(file.hosts.is_empty());
    }
}
