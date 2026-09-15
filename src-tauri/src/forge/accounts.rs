//! Which forge accounts Sway holds, per host, and which one a repo acts as.
//!
//! Pure rules over an explicit [`AccountsFile`], then thin load -> core -> save
//! wrappers, like `crate::accounts`. Tokens are not in the file: each account's
//! secret sits in the keychain under its id (see `token`).

use super::model::AuthState;
use super::remote::{canonical_host, Remote};
use super::token::Secret;
use super::ForgeError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const GITHUB_COM: &str = "github.com";

/// What the pre-accounts GitHub credential becomes. Fixed, so migrating again
/// after a deleted accounts file updates this account instead of adding a twin.
pub const MIGRATED_GITHUB_ID: &str = "github-com-migrated";

const FILE_VERSION: u32 = 1;

fn file_version() -> u32 {
    FILE_VERSION
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Sway-minted and stable: the keychain entry and every repo pick name it.
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
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRecord {
    #[serde(default)]
    pub accounts: Vec<Account>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsFile {
    #[serde(default = "file_version")]
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
        return Err(ForgeError::Invalid { message: "Sway signs in to hosts over https only.".into() });
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
        return Ok(existing.id.clone());
    }
    let unnamed = |a: &&mut Account| a.login.is_none() && reauth == Some(a.id.as_str());
    if let Some(adopted) = record.accounts.iter_mut().find(unnamed) {
        adopted.login = Some(login.to_string());
        if adopted.label.is_empty() {
            adopted.label = login.to_string();
        }
        adopted.base_url = base_url.to_string();
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
    });
    Ok(id)
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
    if record.accounts.is_empty() {
        file.hosts.remove(&host);
    }
    Some(removed)
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
    let accounts = file.hosts.get(&remote.host).map(|r| r.accounts.as_slice()).unwrap_or_default();
    if let Some(picked) = picks.get(&remote.key()) {
        if accounts.iter().any(|a| &a.id == picked) {
            return Resolution::Account(picked.clone());
        }
    }
    match accounts {
        [] => Resolution::NoAccount,
        [only] => Resolution::Account(only.id.clone()),
        many => Resolution::Pick { candidates: many.iter().map(|a| a.id.clone()).collect() },
    }
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
    /// Only where Sway holds an OAuth client id for the host.
    pub device_flow: bool,
    pub scopes: Vec<String>,
    pub token_url: String,
}

pub fn sign_in_routes(provider: Provider, base_url: &str, host: &str, has_client_id: bool) -> SignInRoutes {
    let (scope, token_url) = match provider {
        Provider::Github => ("repo", format!("{base_url}/settings/tokens/new?scopes=repo&description=Sway")),
        Provider::Gitlab => {
            ("api", format!("{base_url}/-/user_settings/personal_access_tokens?name=Sway&scopes=api"))
        }
    };
    SignInRoutes {
        host: host.to_string(),
        base_url: base_url.to_string(),
        device_flow: has_client_id && provider == Provider::Github && host == GITHUB_COM,
        scopes: vec![scope.to_string()],
        token_url,
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
}

pub fn account_view(account: &Account, auth: impl Fn(&str) -> AuthState) -> AccountView {
    AccountView { account: account.clone(), auth: auth(&account.id) }
}

pub fn view(file: &AccountsFile, auth: impl Fn(&str) -> AuthState) -> Vec<HostView> {
    file.hosts
        .iter()
        .map(|(host, record)| HostView {
            host: host.clone(),
            accounts: record.accounts.iter().map(|a| account_view(a, &auth)).collect(),
        })
        .collect()
}

pub fn accounts_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/forge_accounts.json")
}

/// An unreadable file reads as empty, like every other Sway store.
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
        add_account(file, Provider::Github, GH, GITHUB_COM, login, None).unwrap()
    }

    fn sway() -> Remote {
        remote::parse("git@github.com:skarif2/sway.git").unwrap()
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
    fn two_users_make_two_accounts_and_one_user_twice_makes_one() {
        let mut file = AccountsFile::default();
        let first = signed_in(&mut file, "skarif2");
        let second = signed_in(&mut file, "fonn-arif");
        assert_ne!(first, second);
        assert_eq!(signed_in(&mut file, "SKARIF2"), first, "logins compare without case");
        assert_eq!(file.hosts[GITHUB_COM].accounts.len(), 2);
    }

    #[test]
    fn the_legacy_token_becomes_one_github_account_and_stays_for_a_downgrade() {
        let legacy = mock_entry_in("com.sway.forge.github.migration-test", "oauth");
        token::save_to(&legacy, "gho_legacy").unwrap();
        let store = |id: &str, secret: &Secret| {
            token::save_secret_to(&mock_entry_in("com.sway.forge.migration-test", id), secret)
        };
        let read_legacy = || token::load_from(&legacy);

        let mut file = AccountsFile::default();
        migrate_legacy(&mut file, read_legacy, store).unwrap();
        assert_eq!(file.hosts[GITHUB_COM].accounts.len(), 1);
        let moved = mock_entry_in("com.sway.forge.migration-test", MIGRATED_GITHUB_ID);
        assert_eq!(token::load_secret_from(&moved).unwrap(), Some(Secret::access("gho_legacy".into())));
        let restored = super::super::auth::AuthStore::restored(
            vec![(MIGRATED_GITHUB_ID.into(), Some("gho_legacy".into()), None)],
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
        assert_eq!(resolve(&file, &picks, &sway()), Resolution::NoAccount);

        let personal = signed_in(&mut file, "skarif2");
        assert_eq!(resolve(&file, &picks, &sway()), Resolution::Account(personal.clone()));

        let work = signed_in(&mut file, "fonn-arif");
        assert!(matches!(resolve(&file, &picks, &sway()), Resolution::Pick { candidates } if candidates.len() == 2));

        picks.insert(sway().key(), work.clone());
        let https = remote::parse("https://github.com/skarif2/sway").unwrap();
        assert_eq!(resolve(&file, &picks, &https), Resolution::Account(work), "ssh to https keeps the pick");
    }

    #[test]
    fn removing_the_picked_account_returns_the_repo_to_the_pick() {
        let mut file = AccountsFile::default();
        signed_in(&mut file, "a");
        signed_in(&mut file, "b");
        let picked = signed_in(&mut file, "c");
        let mut picks = BTreeMap::from([(sway().key(), picked.clone())]);

        remove_account(&mut file, &picked);
        assert!(drop_picks_for(&mut picks, &picked));
        assert!(matches!(resolve(&file, &picks, &sway()), Resolution::Pick { candidates } if candidates.len() == 2));
    }

    #[test]
    fn github_com_offers_the_browser_and_any_other_host_only_a_token() {
        let github = sign_in_routes(Provider::Github, GH, GITHUB_COM, true);
        assert!(github.device_flow);
        assert_eq!(github.scopes, ["repo"]);
        assert!(github.token_url.starts_with("https://github.com/settings/tokens/new"));

        let ghe = sign_in_routes(Provider::Github, "https://ghe.example.com", "ghe.example.com", true);
        assert!(!ghe.device_flow);
        assert!(ghe.token_url.starts_with("https://ghe.example.com/"));

        let gitlab = sign_in_routes(Provider::Gitlab, "https://gitlab.com", "gitlab.com", true);
        assert!(!gitlab.device_flow);
        assert_eq!(gitlab.scopes, ["api"]);
    }
}
