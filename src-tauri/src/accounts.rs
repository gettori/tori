//! Which accounts Sway knows about per harness, and where each one's profile
//! home lives.
//!
//! **State is split by sensitivity, not by feature.** Two stores, in two places,
//! for two different reasons:
//!
//!   * `~/.config/sway/accounts.json` holds labels and email addresses. It is
//!     ordinary config and sits beside `settings.json` and `agents/`, because
//!     that is what it is: a list of names the user chose.
//!   * Profile homes live under the platform data dir (macOS: `~/Library/
//!     Application Support/sway/profiles`), created `0700`. They are *not* in
//!     `~/.config/sway` because that path is commonly a dotfile repo, and a
//!     profile home accumulates the harness's own session transcripts. Copying
//!     a machine's whole conversation history into a git remote is not a thing
//!     a user should be able to do by accident.
//!
//! **Sway stores no credentials, and on macOS the profile home holds none
//! either.** Measured in Phase 0: `claude` keeps its tokens in the login
//! Keychain, under a service name it derives from the config dir
//! (`"Claude Code-credentials-" + sha256($CLAUDE_CONFIG_DIR)[:8]`, the default
//! home taking the unsuffixed name). Nothing under an isolated home is a
//! secret. So "credential home" would be the wrong name for this directory and
//! the wrong claim about what Sway is holding; it is a *profile* home.
//!
//! Per [[lesson_pure_core_for_global_stores]] the rules here are pure functions
//! over an explicit [`AccountsFile`], and the thin wrappers at the bottom do
//! load -> core -> save. Every test in this module runs with no filesystem
//! except the two that are specifically about paths and permissions.
//!
//! The Tauri commands at the bottom are the whole surface the frontend sees.
//! They are thin on purpose: every rule they enforce lives in the pure core
//! above or in [`crate::auth`], so the parts worth testing are tested without a
//! filesystem, a harness, or an app handle.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The profile that is the user's existing login.
///
/// Synthetic: it is never written to `accounts.json` and never comes back from
/// it. That is what makes "the default profile cannot be deleted or renamed" a
/// property of the shape rather than a check somebody has to remember - there
/// is no stored record to delete, and [`remove_profile`]/[`rename_profile`]
/// refuse the id outright.
pub const DEFAULT_PROFILE_ID: &str = "default";

const DEFAULT_PROFILE_LABEL: &str = "Default";

/// On-disk format version for `accounts.json`.
const FILE_VERSION: u32 = 1;

fn default_file_version() -> u32 {
    FILE_VERSION
}

/// One account of one harness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    /// Stable, Sway-minted, and never shown. The label is what the user sees,
    /// so renaming must not invalidate anything pointing at the profile.
    pub id: String,
    pub label: String,
    /// Learned from the harness's own `whoami` probe, when it answers with one.
    /// `None` is normal, not an error: an adapter may have no way to say who is
    /// signed in.
    #[serde(default)]
    pub email: Option<String>,
    /// The **canonical** absolute path handed to the adapter's `home_env`.
    ///
    /// `None` exactly for [`DEFAULT_PROFILE_ID`], which is the whole mechanism
    /// of the default profile: the variable is left unset, so the harness
    /// resolves the login the user already had before Sway existed.
    #[serde(default)]
    pub home: Option<String>,
}

impl Profile {
    pub fn is_default(&self) -> bool {
        self.id == DEFAULT_PROFILE_ID
    }
}

/// The synthetic default profile. Built, never loaded.
pub fn default_profile() -> Profile {
    Profile {
        id: DEFAULT_PROFILE_ID.to_string(),
        label: DEFAULT_PROFILE_LABEL.to_string(),
        email: None,
        home: None,
    }
}

/// `accounts.json`: the profiles the user has *added*, keyed by adapter id.
///
/// `BTreeMap` rather than `HashMap` so the serialized file has a stable key
/// order and a no-op save produces a byte-identical file. A store that reorders
/// itself on every write is noise in whatever the user is diffing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountsFile {
    #[serde(default = "default_file_version")]
    pub version: u32,
    #[serde(default)]
    pub adapters: BTreeMap<String, Vec<Profile>>,
}

impl Default for AccountsFile {
    fn default() -> Self {
        Self { version: FILE_VERSION, adapters: BTreeMap::new() }
    }
}

// --- pure core: the rules, over an explicit file value, with no filesystem ---

/// Every profile for `adapter_id`, default first.
///
/// The default is prepended rather than stored, so it is present for an adapter
/// the user has never touched and cannot go missing from a hand-edited file.
pub fn profiles_for(file: &AccountsFile, adapter_id: &str) -> Vec<Profile> {
    let mut out = vec![default_profile()];
    if let Some(added) = file.adapters.get(adapter_id) {
        out.extend(added.iter().cloned());
    }
    out
}

/// Look up one profile, including the synthetic default.
pub fn profile(file: &AccountsFile, adapter_id: &str, profile_id: &str) -> Option<Profile> {
    profiles_for(file, adapter_id).into_iter().find(|p| p.id == profile_id)
}

/// Add a profile.
///
/// Rejects a duplicate id and rejects reusing [`DEFAULT_PROFILE_ID`], which
/// would otherwise shadow the user's real login with a Sway-managed home and
/// make it unreachable.
pub fn add_profile(
    file: &mut AccountsFile,
    adapter_id: &str,
    profile: Profile,
) -> Result<(), String> {
    if profile.id == DEFAULT_PROFILE_ID {
        return Err(format!("`{DEFAULT_PROFILE_ID}` is the user's existing login and is not a profile Sway adds"));
    }
    if profile.home.is_none() {
        return Err(format!(
            "profile `{}` has no home: only the default profile runs with the home variable unset",
            profile.id
        ));
    }
    let added = file.adapters.entry(adapter_id.to_string()).or_default();
    if added.iter().any(|p| p.id == profile.id) {
        return Err(format!("profile `{}` already exists for `{adapter_id}`", profile.id));
    }
    added.push(profile);
    Ok(())
}

/// Remove a profile, returning it so the caller can clean up its home.
///
/// Refuses the default: there is nothing stored to remove, and "removing" it
/// could only mean signing the user out of the login they had before Sway.
pub fn remove_profile(
    file: &mut AccountsFile,
    adapter_id: &str,
    profile_id: &str,
) -> Result<Profile, String> {
    if profile_id == DEFAULT_PROFILE_ID {
        return Err("the default profile is the user's existing login and cannot be removed".into());
    }
    let added = file
        .adapters
        .get_mut(adapter_id)
        .ok_or_else(|| format!("`{adapter_id}` has no added profiles"))?;
    let at = added
        .iter()
        .position(|p| p.id == profile_id)
        .ok_or_else(|| format!("no profile `{profile_id}` for `{adapter_id}`"))?;
    let removed = added.remove(at);
    if added.is_empty() {
        file.adapters.remove(adapter_id);
    }
    Ok(removed)
}

/// Relabel a profile. Refuses the default, whose label names a thing Sway does
/// not own.
pub fn rename_profile(
    file: &mut AccountsFile,
    adapter_id: &str,
    profile_id: &str,
    label: &str,
) -> Result<(), String> {
    if profile_id == DEFAULT_PROFILE_ID {
        return Err("the default profile is the user's existing login and cannot be renamed".into());
    }
    if label.trim().is_empty() {
        return Err("a profile label cannot be empty".into());
    }
    let target = file
        .adapters
        .get_mut(adapter_id)
        .and_then(|added| added.iter_mut().find(|p| p.id == profile_id))
        .ok_or_else(|| format!("no profile `{profile_id}` for `{adapter_id}`"))?;
    target.label = label.to_string();
    Ok(())
}

/// The one environment variable a session for `profile` must carry.
///
/// `Ok(None)` for the default profile, and that is the entire definition of it:
/// the variable is left unset rather than pointed at a copy of the user's home.
///
/// `Err` for a profile that has a home while its adapter declares no
/// `home_env`. That combination cannot be produced through the UI, since an
/// adapter without a home variable cannot claim isolation and so offers no
/// "add account" action, but it survives a hand-edited `accounts.json` or an
/// adapter TOML that dropped the field. Folding it into `None` would spawn that
/// profile into the user's *real* login while the UI labelled it a separate
/// account, which is the exact failure the accounts table exists to prevent, so
/// it refuses rather than degrades.
pub fn spawn_env(
    accounts: &crate::agents::AccountsConfig,
    profile: &Profile,
) -> Result<Option<(String, String)>, String> {
    let Some(home) = profile.home.as_ref() else {
        return Ok(None);
    };
    let var = accounts.home_env.as_ref().ok_or_else(|| {
        format!(
            "profile `{}` has a home but its adapter declares no accounts.home_env, \
             so the session would silently run as the default account",
            profile.id
        )
    })?;
    Ok(Some((var.clone(), home.clone())))
}

/// May the user add a second account for this adapter?
///
/// Gated on the measured claim, never on merely having a `home_env`. An adapter
/// with a home variable whose credential store is shared behind it would accept
/// a second profile and silently sign the first one out; the loader already
/// refuses `supports_isolation` without a `home_env`, so this one field is the
/// whole question.
pub fn can_add_account(accounts: &crate::agents::AccountsConfig) -> bool {
    accounts.supports_isolation
}

// --- paths and homes: the thin filesystem layer ---

/// `~/.config/sway/accounts.json`, beside `settings.json` and `agents/`.
pub fn accounts_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/accounts.json")
}

/// Where profile homes live: the platform data dir, never `~/.config/sway`.
///
/// macOS resolves this to `~/Library/Application Support/sway/profiles`.
pub fn profile_home_root() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join("sway/profiles")
}

/// Canonicalize a path before it is stored or handed to a harness.
///
/// **Not cosmetic.** Phase 0 measured that `claude` derives its Keychain
/// service name from `sha256` of the raw `CLAUDE_CONFIG_DIR` string, not of a
/// resolved path, so `.../home` and `.../home/` are two different logins for
/// one directory: register a profile with a trailing separator and it reports
/// signed-out forever while its credentials sit under a name nothing looks up.
/// Relative paths and symlinked homes fail the same way. Canonicalizing once,
/// at the boundary, is what keeps one directory to one identity.
///
/// Requires the path to exist, which it does: Sway creates a profile home
/// before it stores one.
pub fn canonicalize_home(path: &Path) -> Result<String, String> {
    let resolved = std::fs::canonicalize(path)
        .map_err(|e| format!("cannot resolve profile home {}: {e}", path.display()))?;
    resolved
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("profile home {} is not valid UTF-8", resolved.display()))
}

/// Create a profile home for `profile_id` and return its canonical path.
///
/// Reachable from Phase 3's "add an account" flow; the root-taking form below
/// is what the tests drive, so the permission rule is asserted against a temp
/// directory instead of the developer's real Application Support.
pub fn create_profile_home(adapter_id: &str, profile_id: &str) -> Result<String, String> {
    create_profile_home_in(&profile_home_root(), adapter_id, profile_id)
}

/// Create a profile home under an explicit root and return its canonical path.
///
/// `0700` on every directory Sway creates here, not just the leaf: the harness
/// writes its own session transcripts inside, and on a shared machine those are
/// nobody else's business. The adapter level in the middle matters too, since a
/// world-readable one leaks the profile names above the transcripts. Created
/// before canonicalizing, because resolving symlinks needs something to resolve.
fn create_profile_home_in(
    root: &Path,
    adapter_id: &str,
    profile_id: &str,
) -> Result<String, String> {
    let by_adapter = root.join(sanitize_segment(adapter_id));
    let dir = by_adapter.join(sanitize_segment(profile_id));
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create profile home: {e}"))?;
    for level in [root, &by_adapter, &dir] {
        restrict_to_owner(level)?;
    }
    canonicalize_home(&dir)
}

/// `0700`, on unix. A no-op elsewhere, where the mode has no meaning.
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("cannot restrict {}: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Reduce an id to a bare path segment, for the same reason
/// [`crate::owned_state`] does: the result is concatenated into a path, and an
/// adapter id comes from a TOML Sway does not control.
fn sanitize_segment(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

// --- thin wrappers: load -> core -> save ---

/// Read `accounts.json`, or an empty store.
///
/// An unreadable or unparseable file reads as empty rather than as an error,
/// matching every other Sway store: the alternative is a broken JSON file
/// making the app unusable rather than making one list short.
pub fn load() -> AccountsFile {
    std::fs::read_to_string(accounts_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Write `accounts.json` atomically, so a crash mid-write cannot truncate it.
///
/// Truncation matters more here than the file's size suggests: a lenient reader
/// turns a half-written store into "no accounts", which looks exactly like a
/// user who never added any, and the profile homes it forgot about stay on disk
/// unreferenced.
pub fn save(file: &AccountsFile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(&accounts_path(), &text)
}

// --- what the accounts screen asks for ---

/// One profile, plus what its harness says about it right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStatus {
    pub id: String,
    pub label: String,
    /// Published rather than left to the frontend to infer by comparing ids, so
    /// "the default cannot be removed or renamed" is one rule with one source
    /// instead of a backend refusal and a frontend guess that agree by luck.
    pub is_default: bool,
    pub home: Option<String>,
    pub sign_in: crate::auth::SignIn,
    /// How to sign **this** profile in.
    ///
    /// Per profile rather than per adapter, and that is not a detail: the route
    /// carries the home variable, so one route shared across a card would sign
    /// every profile into whichever account the shared copy happened to name.
    /// A single `login` on [`AccountsView`] read exactly that way for one
    /// revision of this file, and it would have sent every "Sign in" press to
    /// the user's existing login while the row it was pressed on said "Work".
    pub login: crate::auth::LoginRoute,
    /// The account the harness named just now, which is not the same as the
    /// `email` stored on the profile: this one is live, that one is the last
    /// thing that was learned.
    pub account: Option<String>,
    pub api_key_source: Option<String>,
    /// The label of an earlier profile signed in to the same account.
    ///
    /// A warning, never a refusal. Two profiles on one account is a thing a
    /// person may genuinely want (a scratch home, a different set of project
    /// settings), so this says what it sees and leaves the decision alone.
    pub duplicate_of: Option<String>,
}

/// Everything one adapter's accounts card renders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsView {
    pub adapter_id: String,
    /// `false` for an adapter with no `[accounts]` table, which renders no
    /// account controls at all rather than an inert set of them.
    pub declared: bool,
    pub can_add: bool,
    /// `false` for an adapter with no `logout_args`, which the removal flow has
    /// to say out loud: tokens stay valid until they expire.
    pub can_sign_out: bool,
    pub profiles: Vec<ProfileStatus>,
}

/// Mark every profile signed in to an account an earlier one already holds.
///
/// Pure and order-sensitive: the *first* profile holding an account is the
/// original and the rest point back at it, so the default profile (always first)
/// is never the one flagged as a copy. Comparison is case-insensitive, because
/// an address that differs only in case is the same account everywhere that
/// matters.
pub fn mark_duplicates(statuses: &mut [ProfileStatus]) {
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    for status in statuses.iter_mut() {
        let Some(account) = status.account.as_ref() else { continue };
        let key = account.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        match seen.get(&key) {
            Some(first) => status.duplicate_of = Some(first.clone()),
            None => {
                seen.insert(key, status.label.clone());
            }
        }
    }
}

/// Why a removal must not go ahead, or `None`.
///
/// **Refuses rather than ends.** Of the two answers the phase allows, refusing
/// is the one that cannot lose work: ending a session for the user means killing
/// an agent mid-turn on their behalf, and they can do it themselves in one click
/// from the tab this message points them at.
///
/// Coarser than it will eventually be, and knowingly so: it blocks on any live
/// session of the *harness*, not of the profile, because Sway does not yet
/// record which profile a running session belongs to. Phase 4 carries the
/// profile through `SessionMeta`, and this narrows then. Blocking too much is
/// the safe direction: the failure it prevents is a session writing into a home
/// that was deleted underneath it.
pub fn removal_refusal(live: &[String], what: &str) -> Option<String> {
    if live.is_empty() {
        return None;
    }
    Some(format!(
        "{what} is still running {} session{}. Close {} first, then remove it.",
        live.len(),
        if live.len() == 1 { "" } else { "s" },
        if live.len() == 1 { "it" } else { "them" },
    ))
}

/// What removing a profile has to do before it forgets it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemovalStep {
    /// Sign out first, and stop if that fails.
    SignOutFirst,
    /// This harness has no sign-out command, so the user has to be told that
    /// removing the account revokes nothing before anything is deleted.
    AskFirst,
    /// Asked and answered. Forget it.
    ForgetWithoutSigningOut,
}

/// The rule, as a value, so the order is a thing that can be asserted rather
/// than eight lines of straight-line code in a command nothing calls in a test.
///
/// The order is the whole point. Deleting the profile before signing out would
/// leave a credential Sway had abandoned rather than revoked, with nothing left
/// in the UI to try again from.
pub fn removal_plan(has_logout: bool, confirmed_without_logout: bool) -> RemovalStep {
    if has_logout {
        RemovalStep::SignOutFirst
    } else if confirmed_without_logout {
        RemovalStep::ForgetWithoutSigningOut
    } else {
        RemovalStep::AskFirst
    }
}

/// What to tell somebody removing an account from a harness that cannot sign
/// out.
///
/// **Not a link to a revocation page**, which is what this task originally asked
/// for, and the reason is the one adapter that reaches this branch. OpenCode's
/// credentials are per *provider* (the measured install held GitHub Copilot),
/// so there is no single page that revokes "the OpenCode account": whose page
/// it would be depends on which provider, and Sway does not know which. A URL
/// field on `[accounts]` would therefore ship empty on every bundled adapter
/// and be a guess on any other.
///
/// What it does instead is name the harness's own credential command, which is
/// derived from what the adapter already declares rather than added as a field
/// nobody could fill in. That is where the revocation actually happens.
fn no_logout_warning(
    adapter: &crate::agents::AgentAdapter,
    accounts: &crate::agents::AccountsConfig,
) -> String {
    let manage = accounts
        .login_args
        .first()
        .map(|first| format!(" Manage its credentials with `{} {first}`.", adapter.program))
        .unwrap_or_default();
    format!(
        "{} offers no sign-out command, so removing this account forgets it here but leaves \
         its tokens valid until they expire.{manage} Confirm to remove it anyway.",
        adapter.label
    )
}

// --- commands ---

fn adapter(adapter_id: &str) -> Result<crate::agents::AgentAdapter, String> {
    crate::agents::find(adapter_id)
        .cloned()
        .ok_or_else(|| format!("no agent adapter `{adapter_id}`"))
}

/// Probe one profile, resolving its home the same way a session would.
///
/// `cached` is the default profile's answer, already computed by the health
/// sweep. Reusing it is what makes "cached until an explicit refresh" true of
/// the profile every adapter has: without it, opening Settings would probe the
/// default account a second time for every card on screen.
fn status_of(
    adapter: &crate::agents::AgentAdapter,
    accounts: &crate::agents::AccountsConfig,
    path: Option<&std::path::Path>,
    profile: &Profile,
    cached: &crate::auth::Whoami,
) -> ProfileStatus {
    // `spawn_env` is the single definition of "which home does this profile
    // run in", so neither the probe nor the login tab can drift from the
    // session they are about. An incoherent profile is unknown rather than
    // probed against the wrong account, which is the failure `spawn_env`
    // refuses for.
    let home = spawn_env(accounts, profile).ok().flatten();
    let answer = match (profile.is_default(), path) {
        (true, _) => cached.clone(),
        (false, Some(path)) => crate::auth::whoami(path, accounts, home.as_ref()),
        (false, None) => crate::auth::Whoami::default(),
    };
    ProfileStatus {
        id: profile.id.clone(),
        label: profile.label.clone(),
        is_default: profile.is_default(),
        home: profile.home.clone(),
        sign_in: answer.state,
        login: crate::auth::login_route(adapter, home),
        account: answer.email,
        api_key_source: answer.api_key_source,
        duplicate_of: None,
    }
}

/// Every account this adapter has, and what its harness says about each.
///
/// Not cached: this is the accounts screen asking on purpose, one probe per
/// profile, and a user who just finished a login is the main person reading it.
/// The cached answer for the *default* profile rides `agent_health` instead,
/// which is what the picker and the Agents cards read.
#[tauri::command]
pub async fn agent_accounts(adapter_id: String) -> Result<AccountsView, String> {
    let adapter = adapter(&adapter_id)?;
    let path = crate::env::resolve_binary(&adapter.program);
    let Some(accounts) = adapter.accounts.clone() else {
        return Ok(AccountsView {
            adapter_id,
            declared: false,
            can_add: false,
            can_sign_out: false,
            profiles: Vec::new(),
        });
    };

    let cached = crate::health::cached_sign_in(&adapter_id).await;
    let file = load();
    let mut profiles: Vec<ProfileStatus> = profiles_for(&file, &adapter_id)
        .iter()
        .map(|p| status_of(&adapter, &accounts, path.as_deref(), p, &cached))
        .collect();
    mark_duplicates(&mut profiles);

    Ok(AccountsView {
        adapter_id,
        declared: true,
        can_add: can_add_account(&accounts),
        can_sign_out: !accounts.logout_args.is_empty(),
        profiles,
    })
}

/// Create a profile and its home, ready to be signed in to.
///
/// The home exists before the profile is stored, because the stored path is the
/// canonical one and canonicalizing needs something to resolve. Phase 0 measured
/// why that matters: `claude` hashes the raw environment string, so a
/// non-canonical spelling is a second identity for one directory.
///
/// It does **not** sign anybody in. The caller opens the login route next, and
/// the profile sits there signed out until they finish, which is honest: a
/// profile that existed only after a successful login would leave a home on disk
/// with nothing pointing at it every time somebody closed the tab.
#[tauri::command]
pub async fn add_agent_account(
    adapter_id: String,
    label: String,
) -> Result<crate::auth::LoginRoute, String> {
    let adapter = adapter(&adapter_id)?;
    let accounts = adapter
        .accounts
        .clone()
        .ok_or_else(|| format!("`{adapter_id}` declares no accounts"))?;
    if !can_add_account(&accounts) {
        return Err(format!(
            "`{adapter_id}` has no measured account isolation, so a second account would share \
             the first one's home"
        ));
    }
    let label = label.trim();
    if label.is_empty() {
        return Err("a profile label cannot be empty".into());
    }

    let mut file = load();
    let id = mint_profile_id(&file, &adapter_id, label);
    let home = create_profile_home(&adapter_id, &id)?;
    let profile = Profile {
        id: id.clone(),
        label: label.to_string(),
        email: None,
        home: Some(home.clone()),
    };
    // The directory exists before the store does, because the stored path is
    // the canonical one and canonicalizing needs something to resolve. So if
    // storing it fails, take the directory back: an unreferenced profile home
    // is invisible in the UI and never cleaned up by anything.
    if let Err(e) = add_profile(&mut file, &adapter_id, profile.clone()).and_then(|()| save(&file)) {
        std::fs::remove_dir_all(&home).ok();
        return Err(e);
    }

    Ok(crate::auth::login_route(&adapter, spawn_env(&accounts, &profile)?))
}

/// A stable id for a new profile, derived from the label and made unique.
///
/// Derived rather than random so the profile home under Application Support is
/// something a person can recognize, and uniqued against what is already stored
/// so two profiles called "Work" do not collide.
fn mint_profile_id(file: &AccountsFile, adapter_id: &str, label: &str) -> String {
    let base = sanitize_segment(&label.to_lowercase());
    let base = base.trim_matches('_');
    let base = if base.is_empty() { "account" } else { base };
    let taken: Vec<String> =
        profiles_for(file, adapter_id).into_iter().map(|p| p.id).collect();
    if !taken.iter().any(|id| id == base) {
        return base.to_string();
    }
    // An infinite range, so there is always an answer. `unwrap_or_default` here
    // would hand back an empty id, which becomes a profile home at the adapter
    // directory itself.
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|id| !taken.contains(id))
        .expect("an unbounded range always finds a free suffix")
}

/// What a removal attempt resolved to.
///
/// "Needs confirming" is a **value**, not an error string, for the same reason
/// `chat::ownership::ClaimOutcome` is: the caller has to act differently on it,
/// and the only way to tell it apart from a refusal would be to match on the
/// message text. That distinction matters here because the other refusals are
/// final - a session in flight, a logout the harness rejected - and a caller
/// sniffing strings would offer "remove anyway?" for all of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RemovalOutcome {
    Removed,
    /// This harness cannot sign out. The message says what that means; calling
    /// again with `confirmed_without_logout` proceeds.
    NeedsConfirming { message: String },
}

/// Sign a profile out and forget it, or say why not.
///
/// The order is load-bearing. Logout runs **first**, and a failure stops the
/// removal: deleting the profile behind a live token would leave a credential
/// Sway had abandoned rather than revoked, with nothing left in the UI to try
/// again from.
///
/// `confirmed_without_logout` is the caller having told the user what an adapter
/// with no logout command means and been told to proceed anyway. It is a
/// separate argument rather than a silent fallback so that the removal cannot
/// quietly become a delete for adapters that never had a logout.
#[tauri::command]
pub async fn remove_agent_account(
    chat: tauri::State<'_, crate::chat::host::ChatState>,
    adapter_id: String,
    profile_id: String,
    confirmed_without_logout: bool,
) -> Result<RemovalOutcome, String> {
    let adapter = adapter(&adapter_id)?;
    let accounts = adapter
        .accounts
        .clone()
        .ok_or_else(|| format!("`{adapter_id}` declares no accounts"))?;

    if let Some(refusal) =
        removal_refusal(&chat.0.registry.held_by(&adapter_id), &adapter.label)
    {
        return Err(refusal);
    }

    let mut file = load();
    let profile = profile(&file, &adapter_id, &profile_id)
        .ok_or_else(|| format!("no profile `{profile_id}` for `{adapter_id}`"))?;

    match removal_plan(!accounts.logout_args.is_empty(), confirmed_without_logout) {
        RemovalStep::SignOutFirst => {
            let path = crate::env::resolve_binary(&adapter.program).ok_or_else(|| {
                format!("`{}` is not installed, so it cannot sign out", adapter.program)
            })?;
            let home = spawn_env(&accounts, &profile)?;
            crate::auth::logout(&path, &accounts, home.as_ref())
                .map_err(|e| format!("{} would not sign out: {e}", adapter.label))?;
        }
        RemovalStep::AskFirst => {
            return Ok(RemovalOutcome::NeedsConfirming {
                message: no_logout_warning(&adapter, &accounts),
            })
        }
        RemovalStep::ForgetWithoutSigningOut => {}
    }

    let removed = remove_profile(&mut file, &adapter_id, &profile_id)?;
    save(&file)?;
    // The home goes last, after the store no longer points at it. The other
    // order leaves a stored profile aimed at a directory that is gone, which
    // reads as a working account right up until a session starts in it.
    if let Some(home) = removed.home {
        std::fs::remove_dir_all(&home)
            .map_err(|e| format!("signed out and forgot the account, but its home is still at {home}: {e}"))?;
    }
    Ok(RemovalOutcome::Removed)
}

/// Relabel a profile. The label is the only thing the user chose, so it is the
/// only thing renaming touches.
#[tauri::command]
pub async fn rename_agent_account(
    adapter_id: String,
    profile_id: String,
    label: String,
) -> Result<(), String> {
    let mut file = load();
    rename_profile(&mut file, &adapter_id, &profile_id, &label)?;
    save(&file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn added(id: &str, home: &str) -> Profile {
        Profile {
            id: id.to_string(),
            label: id.to_string(),
            email: None,
            home: Some(home.to_string()),
        }
    }

    // --- the default profile ---

    #[test]
    fn the_default_profile_is_present_for_an_adapter_with_no_stored_profiles() {
        let file = AccountsFile::default();
        let all = profiles_for(&file, "claude");
        assert_eq!(all.len(), 1);
        assert!(all[0].is_default());
        assert_eq!(all[0].home, None, "the default profile is the variable left unset");
    }

    #[test]
    fn the_default_profile_cannot_be_removed_or_renamed() {
        let mut file = AccountsFile::default();
        assert!(remove_profile(&mut file, "claude", DEFAULT_PROFILE_ID).is_err());
        assert!(rename_profile(&mut file, "claude", DEFAULT_PROFILE_ID, "Mine").is_err());
    }

    /// Shadowing the default would point the user's existing login at a
    /// Sway-managed home and make the real one unreachable from the UI.
    #[test]
    fn a_stored_profile_cannot_claim_the_default_id() {
        let mut file = AccountsFile::default();
        let err = add_profile(&mut file, "claude", added(DEFAULT_PROFILE_ID, "/tmp/x")).unwrap_err();
        assert!(err.contains(DEFAULT_PROFILE_ID), "{err}");
    }

    /// Only the default runs with the variable unset. A stored profile with no
    /// home would spawn into whatever the user's real login is, while claiming
    /// to be a separate account.
    #[test]
    fn a_stored_profile_must_have_a_home() {
        let mut file = AccountsFile::default();
        let mut p = added("work", "/tmp/x");
        p.home = None;
        assert!(add_profile(&mut file, "claude", p).is_err());
    }

    // --- the store's rules ---

    #[test]
    fn add_then_list_puts_the_default_first_and_keeps_insertion_order() {
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("work", "/tmp/w")).unwrap();
        add_profile(&mut file, "claude", added("personal", "/tmp/p")).unwrap();
        let ids: Vec<String> = profiles_for(&file, "claude").into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["default", "work", "personal"]);
    }

    #[test]
    fn a_duplicate_id_is_rejected() {
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("work", "/tmp/w")).unwrap();
        assert!(add_profile(&mut file, "claude", added("work", "/tmp/other")).is_err());
    }

    #[test]
    fn profiles_are_per_adapter() {
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("work", "/tmp/w")).unwrap();
        assert_eq!(profiles_for(&file, "claude").len(), 2);
        assert_eq!(profiles_for(&file, "codex").len(), 1, "codex sees only its default");
    }

    #[test]
    fn removing_the_last_profile_leaves_no_empty_adapter_entry() {
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("work", "/tmp/w")).unwrap();
        let gone = remove_profile(&mut file, "claude", "work").unwrap();
        assert_eq!(gone.home.as_deref(), Some("/tmp/w"), "the caller needs the home to clean up");
        assert!(file.adapters.is_empty(), "an empty list should not persist as an entry");
    }

    #[test]
    fn renaming_changes_the_label_and_not_the_id() {
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("work", "/tmp/w")).unwrap();
        rename_profile(&mut file, "claude", "work", "Work account").unwrap();
        let p = profile(&file, "claude", "work").unwrap();
        assert_eq!(p.label, "Work account");
        assert_eq!(p.id, "work");
    }

    #[test]
    fn an_empty_label_is_rejected() {
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("work", "/tmp/w")).unwrap();
        assert!(rename_profile(&mut file, "claude", "work", "   ").is_err());
    }

    // --- serialization ---

    #[test]
    fn a_save_and_reload_round_trip_preserves_every_profile() {
        let mut file = AccountsFile::default();
        let mut p = added("work", "/tmp/w");
        p.email = Some("a@b.c".into());
        p.label = "Work".into();
        add_profile(&mut file, "claude", p).unwrap();
        add_profile(&mut file, "codex", added("alt", "/tmp/a")).unwrap();

        let text = serde_json::to_string_pretty(&file).unwrap();
        let back: AccountsFile = serde_json::from_str(&text).unwrap();
        assert_eq!(back, file);
    }

    /// The default is built, never stored, so it must not appear in the file
    /// even after it has been listed.
    #[test]
    fn the_default_profile_is_never_serialized() {
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("work", "/tmp/w")).unwrap();
        let _ = profiles_for(&file, "claude");
        let text = serde_json::to_string(&file).unwrap();
        assert!(!text.contains(DEFAULT_PROFILE_ID), "default leaked into the file: {text}");
    }

    #[test]
    fn a_file_with_no_version_still_loads() {
        let back: AccountsFile = serde_json::from_str(r#"{"adapters":{}}"#).unwrap();
        assert_eq!(back.version, FILE_VERSION);
    }

    // --- spawn environment ---

    fn accounts_config(home_env: Option<&str>, isolation: bool) -> crate::agents::AccountsConfig {
        crate::agents::AccountsConfig {
            home_env: home_env.map(|s| s.to_string()),
            home_default: None,
            login_args: vec![],
            logout_args: vec![],
            whoami_args: vec![],
            whoami_kind: None,
            supports_isolation: isolation,
        }
    }

    #[test]
    fn a_default_profile_session_sets_no_home_variable() {
        let cfg = accounts_config(Some("CLAUDE_CONFIG_DIR"), true);
        assert_eq!(spawn_env(&cfg, &default_profile()).unwrap(), None);
    }

    #[test]
    fn an_added_profile_session_carries_the_adapters_variable() {
        let cfg = accounts_config(Some("CLAUDE_CONFIG_DIR"), true);
        let env = spawn_env(&cfg, &added("work", "/canonical/w")).unwrap().unwrap();
        assert_eq!(env, ("CLAUDE_CONFIG_DIR".to_string(), "/canonical/w".to_string()));
    }

    /// Reachable only from a hand-edited store or an adapter that dropped the
    /// field, and it must not degrade to Inherit: that would run a profile the
    /// UI calls "Work" inside the user's real login.
    #[test]
    fn a_profile_with_a_home_but_no_home_env_refuses_rather_than_running_as_default() {
        let cfg = accounts_config(None, false);
        let err = spawn_env(&cfg, &added("work", "/canonical/w")).unwrap_err();
        assert!(err.contains("home_env"), "{err}");
    }

    /// An adapter with no verified isolation offers no "add account" action, so
    /// there is never a second profile silently sharing the first one's home.
    #[test]
    fn an_adapter_without_verified_isolation_cannot_add_accounts() {
        assert!(!can_add_account(&accounts_config(None, false)));
        assert!(!can_add_account(&accounts_config(Some("X_HOME"), false)));
        assert!(can_add_account(&accounts_config(Some("X_HOME"), true)));
    }

    // --- paths: the two filesystem facts worth pinning ---

    /// The split-by-sensitivity rule, asserted structurally so it cannot drift
    /// back: `~/.config/sway` is commonly a dotfile repo, and a profile home
    /// fills up with the harness's own transcripts.
    #[test]
    fn no_profile_home_is_created_under_the_config_dir() {
        let config_dir = accounts_path().parent().unwrap().to_path_buf();
        let home_root = profile_home_root();
        assert!(
            !home_root.starts_with(&config_dir),
            "profile homes must not live under {}: got {}",
            config_dir.display(),
            home_root.display()
        );
        assert!(
            accounts_path().starts_with(&config_dir),
            "accounts.json is ordinary config and belongs in the config dir"
        );
    }

    /// A profile home fills up with the harness's own transcripts, so the mode
    /// is part of the store's contract rather than a detail of how it happened
    /// to be created.
    #[test]
    fn a_profile_home_is_created_private_to_its_owner() {
        let root = std::env::temp_dir().join(format!("sway-homes-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();

        let home = create_profile_home_in(&root, "claude", "work").unwrap();
        let path = Path::new(&home);
        assert!(path.is_dir());
        assert!(path.ends_with("claude/work"), "adapter and profile each get a segment: {home}");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(path), 0o700, "the profile home must be owner-only");
            assert_eq!(mode(&std::fs::canonicalize(&root).unwrap()), 0o700, "so must the root");
            assert_eq!(
                mode(path.parent().unwrap()),
                0o700,
                "and the adapter level between them, or the profile names leak"
            );
        }

        std::fs::remove_dir_all(&root).ok();
    }

    /// An adapter id comes from a TOML Sway does not control, and the result is
    /// concatenated into a path.
    #[test]
    fn a_traversing_id_cannot_escape_the_profile_root() {
        let root = std::env::temp_dir().join(format!("sway-escape-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        let canonical_root = std::fs::canonicalize(&root).unwrap();

        let home = create_profile_home_in(&root, "../../etc", "x/../../y").unwrap();
        assert!(
            Path::new(&home).starts_with(&canonical_root),
            "{home} escaped {}",
            canonical_root.display()
        );

        std::fs::remove_dir_all(&root).ok();
    }

    // --- duplicate accounts, and what the warning is for ---

    fn status(label: &str, account: Option<&str>) -> ProfileStatus {
        ProfileStatus {
            id: label.to_lowercase(),
            label: label.to_string(),
            is_default: false,
            home: Some(format!("/tmp/{label}")),
            sign_in: crate::auth::SignIn::SignedIn,
            login: crate::auth::LoginRoute::AgentStates,
            account: account.map(str::to_string),
            api_key_source: None,
            duplicate_of: None,
        }
    }

    /// The twin the phase exists to notice: two profiles, one account, nothing
    /// in the UI to tell them apart.
    #[test]
    fn a_second_profile_on_one_account_points_back_at_the_first() {
        let mut rows =
            [status("Default", Some("a@b.c")), status("Work", Some("a@b.c"))];
        mark_duplicates(&mut rows);
        assert_eq!(rows[0].duplicate_of, None, "the first holder is the original");
        assert_eq!(rows[1].duplicate_of.as_deref(), Some("Default"));
    }

    #[test]
    fn distinct_accounts_are_not_flagged() {
        let mut rows = [status("Work", Some("a@b.c")), status("Personal", Some("d@e.f"))];
        mark_duplicates(&mut rows);
        assert!(rows.iter().all(|r| r.duplicate_of.is_none()));
    }

    /// An address differing only in case is the same account everywhere that
    /// matters, so the warning has to survive the spelling.
    #[test]
    fn case_does_not_hide_a_duplicate() {
        let mut rows = [status("Work", Some("A@B.c")), status("Other", Some("a@b.c "))];
        mark_duplicates(&mut rows);
        assert_eq!(rows[1].duplicate_of.as_deref(), Some("Work"));
    }

    /// Two profiles the harness names nothing for are not evidence of anything.
    /// Codex and OpenCode report no account at all, so treating "both unknown"
    /// as "the same" would flag every second profile they ever had.
    #[test]
    fn profiles_with_no_reported_account_are_never_called_duplicates() {
        let mut rows = [status("Work", None), status("Personal", None), status("Third", Some(" "))];
        mark_duplicates(&mut rows);
        assert!(rows.iter().all(|r| r.duplicate_of.is_none()));
    }

    // --- the sign-in route is per profile ---

    /// The regression this test exists for: the route was briefly one field on
    /// the whole card, built with no home. Every "Sign in" press therefore
    /// opened a tab with no `CLAUDE_CONFIG_DIR`, so pressing it on the row
    /// labelled "Work" signed the user into the login they already had, said it
    /// worked, and left two profiles that were one account.
    #[test]
    fn each_profile_carries_a_route_into_its_own_home() {
        let claude = crate::agents::find("claude").expect("claude ships bundled");
        let accounts = claude.accounts.clone().expect("claude declares accounts");
        let cached = crate::auth::Whoami::default();
        let work = added("work", "/canonical/work");

        let row = status_of(claude, &accounts, None, &work, &cached);
        match row.login {
            crate::auth::LoginRoute::Terminal { home, .. } => assert_eq!(
                home,
                Some(("CLAUDE_CONFIG_DIR".into(), "/canonical/work".into())),
                "the login has to land in this profile's home"
            ),
            other => panic!("claude signs in through a terminal, got {other:?}"),
        }

        // And the default profile signs in with the variable unset, exactly as
        // it runs.
        let row = status_of(claude, &accounts, None, &default_profile(), &cached);
        match row.login {
            crate::auth::LoginRoute::Terminal { home, .. } => assert_eq!(home, None),
            other => panic!("got {other:?}"),
        }
    }

    /// The default profile's answer comes from the cached sweep rather than a
    /// second probe, which is what keeps opening Settings from asking every
    /// harness the same question it was already asked.
    #[test]
    fn the_default_profile_reuses_the_answer_the_sweep_already_has() {
        let claude = crate::agents::find("claude").expect("claude ships bundled");
        let accounts = claude.accounts.clone().expect("claude declares accounts");
        let cached = crate::auth::Whoami {
            state: crate::auth::SignIn::SignedIn,
            email: Some("a@b.c".into()),
            api_key_source: Some("ANTHROPIC_API_KEY".into()),
        };

        // No binary path, so anything that probed would come back unknown.
        let row = status_of(claude, &accounts, None, &default_profile(), &cached);
        assert_eq!(row.sign_in, crate::auth::SignIn::SignedIn);
        assert_eq!(row.account.as_deref(), Some("a@b.c"));
        assert_eq!(row.api_key_source.as_deref(), Some("ANTHROPIC_API_KEY"));

        // An added profile is a different account, so the cached answer must
        // not be handed to it.
        let row = status_of(claude, &accounts, None, &added("work", "/canonical/w"), &cached);
        assert_eq!(row.sign_in, crate::auth::SignIn::Unknown);
        assert_eq!(row.account, None);
    }

    // --- removal, and what stops it ---

    #[test]
    fn removal_is_refused_while_a_session_is_in_flight() {
        let refusal = removal_refusal(&["s1".to_string()], "Claude").expect("refused");
        assert!(refusal.contains("Claude"), "{refusal}");
        assert!(refusal.contains("1 session"), "the count has to be in it: {refusal}");
        assert!(!refusal.contains("1 sessions"), "and read as English: {refusal}");
    }

    #[test]
    fn removal_goes_ahead_when_nothing_is_running() {
        assert_eq!(removal_refusal(&[], "Claude"), None);
    }

    /// The order is the rule. Signing out after forgetting the profile would
    /// leave a credential Sway had abandoned rather than revoked, with nothing
    /// left in the UI to try again from.
    #[test]
    fn a_harness_with_a_logout_command_signs_out_before_forgetting_anything() {
        assert_eq!(removal_plan(true, false), RemovalStep::SignOutFirst);
        // Confirmation is for the *other* branch. An adapter that can sign out
        // must not be talked past it.
        assert_eq!(removal_plan(true, true), RemovalStep::SignOutFirst);
    }

    /// The state the removal flow has to say out loud rather than paper over.
    /// OpenCode is the real case: its logout takes a provider argument, so
    /// there is no single command that signs the harness out.
    #[test]
    fn a_harness_with_no_logout_asks_before_it_deletes() {
        assert_eq!(removal_plan(false, false), RemovalStep::AskFirst);
        assert_eq!(removal_plan(false, true), RemovalStep::ForgetWithoutSigningOut);
    }

    /// The sentence somebody has to agree to, checked against the real adapter
    /// that reaches this branch. It has to say the tokens survive, and it has to
    /// point at where they can actually be revoked.
    #[test]
    fn the_no_logout_warning_says_the_tokens_survive_and_where_to_revoke_them() {
        let opencode = crate::agents::find("opencode").expect("opencode ships bundled");
        let accounts = opencode.accounts.as_ref().expect("opencode declares accounts");
        assert!(accounts.logout_args.is_empty(), "this test is about the no-logout branch");

        let warning = no_logout_warning(opencode, accounts);
        assert!(warning.contains("valid until they expire"), "{warning}");
        assert!(warning.contains("opencode auth"), "name where to revoke them: {warning}");
    }

    /// Derived from what the adapter declares, so an adapter that declares no
    /// login command still gets a complete sentence rather than a dangling one.
    #[test]
    fn the_warning_stays_a_sentence_when_there_is_no_command_to_name() {
        let adapter = crate::agents::test_adapter("thing");
        let accounts = crate::agents::AccountsConfig {
            home_env: None,
            home_default: None,
            login_args: vec![],
            logout_args: vec![],
            whoami_args: vec![],
            whoami_kind: None,
            supports_isolation: false,
        };
        let warning = no_logout_warning(&adapter, &accounts);
        assert!(warning.contains("valid until they expire"), "{warning}");
        assert!(warning.ends_with("Confirm to remove it anyway."), "{warning}");
    }

    /// The store holds names the user chose and addresses the harness reported.
    /// Nothing else has ever been in it, and this is the assertion that says so
    /// out loud, beside the one in `crate::auth` about the Keychain.
    #[test]
    fn accounts_json_holds_no_secret() {
        let mut file = AccountsFile::default();
        let mut p = added("work", "/tmp/w");
        p.email = Some("a@b.c".into());
        add_profile(&mut file, "claude", p).unwrap();
        let text = serde_json::to_string(&file).unwrap();

        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let keys: Vec<String> = value["adapters"]["claude"][0]
            .as_object()
            .expect("a profile is an object")
            .keys()
            .cloned()
            .collect();
        assert_eq!(
            keys,
            ["id", "label", "email", "home"],
            "a new field on a stored profile has to be justified here"
        );
        for smell in ["token", "secret", "password", "key", "credential"] {
            assert!(!text.to_lowercase().contains(smell), "`{smell}` in {text}");
        }
    }

    // --- minting an id for a new profile ---

    #[test]
    fn a_new_profile_id_is_derived_from_its_label() {
        let file = AccountsFile::default();
        assert_eq!(mint_profile_id(&file, "claude", "Work"), "work");
        assert_eq!(mint_profile_id(&file, "claude", "My Work Account"), "my_work_account");
    }

    /// The id becomes a path segment under Application Support, so a label that
    /// sanitizes to nothing must still produce something openable.
    #[test]
    fn a_label_with_nothing_usable_in_it_still_mints_an_id() {
        let file = AccountsFile::default();
        assert_eq!(mint_profile_id(&file, "claude", "///"), "account");
    }

    #[test]
    fn a_second_profile_with_the_same_label_gets_its_own_id() {
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("work", "/tmp/w")).unwrap();
        assert_eq!(mint_profile_id(&file, "claude", "Work"), "work-2");
    }

    /// The synthetic default is in `profiles_for`, so a profile labelled
    /// "Default" must not mint the one id that would shadow the user's real
    /// login.
    #[test]
    fn a_new_profile_can_never_mint_the_default_id() {
        let file = AccountsFile::default();
        let id = mint_profile_id(&file, "claude", "Default");
        assert_ne!(id, DEFAULT_PROFILE_ID);
        assert!(add_profile(&mut AccountsFile::default(), "claude", added(&id, "/tmp/x")).is_ok());
    }

    /// Phase 0's trailing-slash trap, pinned. All three spellings of one
    /// directory must reach one canonical string, or one directory becomes two
    /// logins and a profile reports signed-out for no visible reason.
    #[test]
    fn every_spelling_of_one_directory_canonicalizes_to_one_path() {
        let base = std::env::temp_dir().join(format!("sway-accounts-{}", std::process::id()));
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();

        let plain = canonicalize_home(&real).unwrap();
        let trailing = canonicalize_home(Path::new(&format!("{}/", real.display()))).unwrap();
        let dotted = canonicalize_home(&base.join("./real")).unwrap();
        let indirect = canonicalize_home(&base.join("real/../real")).unwrap();

        assert_eq!(plain, trailing, "a trailing separator must not mint a second identity");
        assert_eq!(plain, dotted);
        assert_eq!(plain, indirect);
        assert!(Path::new(&plain).is_absolute());

        #[cfg(unix)]
        {
            let link = base.join("link");
            std::fs::remove_file(&link).ok();
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert_eq!(plain, canonicalize_home(&link).unwrap(), "a symlinked home is the same home");
        }

        std::fs::remove_dir_all(&base).ok();
    }
}
