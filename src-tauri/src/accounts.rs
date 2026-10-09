//! Which accounts Tori knows about per agent, and where each one's profile
//! home lives.
//!
//! **State is split by sensitivity, not by feature.** Two stores, in two places,
//! for two different reasons:
//!
//!   * `~/.config/tori/accounts.json` holds labels and email addresses. It is
//!     ordinary config and sits beside `settings.json` and `agents/`, because
//!     that is what it is: a list of names the user chose.
//!   * Profile homes live under the platform data dir (macOS: `~/Library/
//!     Application Support/tori/profiles`), created `0700`. They are *not* in
//!     `~/.config/tori` because that path is commonly a dotfile repo, and a
//!     profile home accumulates the agent's own session transcripts. Copying
//!     a machine's whole conversation history into a git remote is not a thing
//!     a user should be able to do by accident.
//!
//! **Tori stores no credentials, and on macOS the profile home holds none
//! either.** Measured in Phase 0: `claude` keeps its tokens in the login
//! Keychain, under a service name it derives from the config dir
//! (`"Claude Code-credentials-" + sha256($CLAUDE_CONFIG_DIR)[:8]`, the default
//! home taking the unsuffixed name). Nothing under an isolated home is a
//! secret. So "credential home" would be the wrong name for this directory and
//! the wrong claim about what Tori is holding; it is a *profile* home.
//!
//! Per [[lesson_pure_core_for_global_stores]] the rules here are pure functions
//! over an explicit [`AccountsFile`], and the thin wrappers at the bottom do
//! load -> core -> save. Every test in this module runs with no filesystem
//! except the two that are specifically about paths and permissions.
//!
//! The Tauri commands at the bottom are the whole surface the frontend sees.
//! They are thin on purpose: every rule they enforce lives in the pure core
//! above or in [`crate::auth`], so the parts worth testing are tested without a
//! filesystem, a agent, or an app handle.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The profile that is the user's existing login.
///
/// Synthetic: it is never written to `accounts.json` and never comes back from
/// it. That is what makes "the default profile cannot be deleted" a property of
/// the shape rather than a check somebody has to remember, and [`remove_profile`]
/// refuses the id outright.
///
/// Its **label** is a different question and is storable ([`default_labels`]):
/// the label is Tori's own name for an account, which the agent never sees, so
/// calling the user's existing login "Personal" changes a word on screen and
/// nothing else.
///
/// [`default_labels`]: AccountsFile::default_labels
pub const DEFAULT_PROFILE_ID: &str = "default";

const DEFAULT_PROFILE_LABEL: &str = "Default";

/// On-disk format version for `accounts.json`.
const FILE_VERSION: u32 = 1;

fn default_file_version() -> u32 {
    FILE_VERSION
}

/// One account of one agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    /// Stable, Tori-minted, and never shown. The label is what the user sees,
    /// so renaming must not invalidate anything pointing at the profile.
    pub id: String,
    pub label: String,
    /// Learned from the agent's own `whoami` probe, when it answers with one.
    /// `None` is normal, not an error: an adapter may have no way to say who is
    /// signed in.
    #[serde(default)]
    pub email: Option<String>,
    /// The **canonical** absolute path handed to the adapter's `home_env`.
    ///
    /// `None` exactly for [`DEFAULT_PROFILE_ID`], which is the whole mechanism
    /// of the default profile: the variable is left unset, so the agent
    /// resolves the login the user already had before Tori existed.
    #[serde(default)]
    pub home: Option<String>,
    /// Missing reads as `true`: every profile stored before this field was one
    /// Tori created.
    #[serde(default = "managed_by_default")]
    pub managed: bool,
    /// The shell command that runs the agent as this account, see
    /// [`crate::account_commands`]. Stored rather than derived from the label,
    /// so a rename that keeps the command keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

fn managed_by_default() -> bool {
    true
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
        managed: false,
        command: None,
    }
}

/// The default profile as this adapter's, wearing the name the user gave it.
///
/// Still built rather than loaded: only the *label* is stored, so a hand-edited
/// file that lost the entry gets the built-in name back rather than losing the
/// account.
pub fn default_profile_for(file: &AccountsFile, adapter_id: &str) -> Profile {
    let mut profile = default_profile();
    if let Some(label) = file.default_labels.get(adapter_id) {
        profile.label = label.clone();
    }
    profile
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
    /// The user's own name for the **default** account, per adapter, where they
    /// have given it one. Kept out of `adapters`, which holds the profiles Tori
    /// added and every one of which has a home: a default profile stored there
    /// would be listed twice by `profiles_for` and offered for removal.
    ///
    /// Absent means the built-in label, so renaming it back stores nothing and
    /// a file whose default accounts were never renamed carries no key at all.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub default_labels: BTreeMap<String, String>,
}

impl Default for AccountsFile {
    fn default() -> Self {
        Self {
            version: FILE_VERSION,
            adapters: BTreeMap::new(),
            default_labels: BTreeMap::new(),
        }
    }
}

// --- pure core: the rules, over an explicit file value, with no filesystem ---

/// Every profile for `adapter_id`, default first when [`default_present`] says
/// it exists.
pub fn profiles_for(file: &AccountsFile, adapter_id: &str) -> Vec<Profile> {
    let present = crate::agents::find(adapter_id).is_none_or(|a| default_present(&a));
    profiles_for_with(file, adapter_id, present)
}

/// [`profiles_for`] with the default's presence passed in.
///
/// The default is prepended rather than stored, so it cannot go missing from a
/// hand-edited file.
pub fn profiles_for_with(file: &AccountsFile, adapter_id: &str, default_present: bool) -> Vec<Profile> {
    let mut out = Vec::new();
    if default_present {
        out.push(default_profile_for(file, adapter_id));
    }
    if let Some(added) = file.adapters.get(adapter_id) {
        out.extend(added.iter().cloned());
    }
    out
}

/// Look up one profile, including the synthetic default.
pub fn profile(file: &AccountsFile, adapter_id: &str, profile_id: &str) -> Option<Profile> {
    profiles_for(file, adapter_id).into_iter().find(|p| p.id == profile_id)
}

/// How many accounts each adapter holds, for the Agents table's column.
///
/// Counts alone, and only for adapters that declare `[accounts]`: an adapter
/// with no table gets no row here rather than a default "1", because that
/// would claim an account Tori has nothing true to say about. The default
/// profile is in every count, the same way it is in every profile list.
pub fn account_counts(file: &AccountsFile) -> BTreeMap<String, usize> {
    crate::agents::registry()
        .iter()
        .filter(|a| a.accounts.is_some())
        .map(|a| (a.id.clone(), profiles_for(file, &a.id).len()))
        .collect()
}

/// Add a profile.
///
/// Rejects a duplicate id and rejects reusing [`DEFAULT_PROFILE_ID`], which
/// would otherwise shadow the user's real login with a Tori-managed home and
/// make it unreachable.
pub fn add_profile(file: &mut AccountsFile, adapter_id: &str, profile: Profile) -> Result<(), String> {
    if profile.id == DEFAULT_PROFILE_ID {
        return Err(format!(
            "`{DEFAULT_PROFILE_ID}` is the user's existing login and is not a profile Tori adds"
        ));
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
/// could only mean signing the user out of the login they had before Tori.
pub fn remove_profile(file: &mut AccountsFile, adapter_id: &str, profile_id: &str) -> Result<Profile, String> {
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

/// Relabel a profile, including the default one: the label is Tori's own name
/// for an account and the agent never sees it, so renaming touches a word on
/// screen and nothing about the login behind it.
pub fn rename_profile(file: &mut AccountsFile, adapter_id: &str, profile_id: &str, label: &str) -> Result<(), String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("a profile label cannot be empty".into());
    }
    // The default account has no stored record, so its name is stored on its
    // own. Renaming it back to the built-in one stores nothing: absent and
    // "Default" are one answer, and a file that recorded the second would be
    // keeping a preference nobody expressed.
    if profile_id == DEFAULT_PROFILE_ID {
        if label == DEFAULT_PROFILE_LABEL {
            file.default_labels.remove(adapter_id);
        } else {
            file.default_labels.insert(adapter_id.to_string(), label.to_string());
        }
        return Ok(());
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

/// One profile's home variable and path, by id, over an explicit accounts file.
///
/// `None` and [`DEFAULT_PROFILE_ID`] are the same request and both answer with
/// no pair, which is the definition of the default profile: the home variable
/// left unset. With the default's home absent that request is an error, since
/// running with the variable unset would create it.
///
/// An id that names no profile is an **error**, never no pair. Falling back
/// would start the session on the user's own login while every label around it
/// said otherwise, which is the one failure this whole feature exists to
/// prevent. The reachable way here is a persisted tab naming a profile that has
/// since been removed.
pub fn profile_pair(
    adapter: &crate::agents::AgentAdapter,
    file: &AccountsFile,
    profile_id: Option<&str>,
) -> Result<Option<(String, String)>, String> {
    let id = profile_id.unwrap_or(DEFAULT_PROFILE_ID);
    if id == DEFAULT_PROFILE_ID {
        return match absent_default_home(adapter) {
            None => Ok(None),
            Some(home) => Err(format!(
                "{} has no default account: {} does not exist",
                adapter.label,
                home.display()
            )),
        };
    }
    let accounts = adapter
        .accounts
        .as_ref()
        .ok_or_else(|| format!("`{}` declares no accounts, so it has no profile `{id}`", adapter.id))?;
    let profile = profile(file, &adapter.id, id).ok_or_else(|| format!("no profile `{id}` for `{}`", adapter.id))?;
    spawn_env(accounts, &profile)
}

/// The same answer as a map, for the spawn boundary that wants an env.
pub fn profile_env(
    adapter: &crate::agents::AgentAdapter,
    file: &AccountsFile,
    profile_id: Option<&str>,
) -> Result<BTreeMap<String, String>, String> {
    Ok(profile_pair(adapter, file, profile_id)?.into_iter().collect())
}

/// The environment a PTY agent tab spawns with, so a terminal session runs as
/// the account its tab says it does.
///
/// The chat path resolves this inside `chat_spawn`; a PTY tab carries an `env`
/// map of its own and asks for one here. A tab stores the profile **id** and
/// derives the env at every spawn rather than persisting the resolved pair:
/// the home path belongs to `accounts.json`, and a stored copy would outlive a
/// rename or a removal and point a shell at a directory nothing owns.
#[tauri::command]
pub async fn profile_spawn_env(
    adapter_id: String,
    profile_id: Option<String>,
) -> Result<BTreeMap<String, String>, String> {
    profile_env(&adapter(&adapter_id)?, &load(), profile_id.as_deref())
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

/// `~/.config/tori/accounts.json`, beside `settings.json` and `agents/`.
pub fn accounts_path() -> PathBuf {
    crate::owned_state::config_dir().join("accounts.json")
}

/// Where profile homes live: the platform data dir, never `~/.config/tori`.
///
/// macOS resolves this to `~/Library/Application Support/tori/profiles`.
pub fn profile_home_root() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join("tori/profiles")
}

/// Whether the default profile exists: the adapter's `home_default` is on disk.
///
/// True for an adapter that declares no `[accounts]` or no `home_default`, since
/// there is nothing to check. Not read from `CLAUDE_CONFIG_DIR`: discovery,
/// config files and MCP resolve against `home_default`, so a row admitted by the
/// variable would describe the wrong account.
pub fn default_present(adapter: &crate::agents::AgentAdapter) -> bool {
    absent_default_home(adapter).is_none()
}

fn absent_default_home(adapter: &crate::agents::AgentAdapter) -> Option<&Path> {
    adapter
        .accounts
        .as_ref()?
        .home_default
        .as_deref()
        .filter(|home| !home.exists())
}

/// Canonicalize a path before it is stored or handed to a agent.
///
/// **Not cosmetic.** Phase 0 measured that `claude` derives its Keychain
/// service name from `sha256` of the raw `CLAUDE_CONFIG_DIR` string, not of a
/// resolved path, so `.../home` and `.../home/` are two different logins for
/// one directory: register a profile with a trailing separator and it reports
/// signed-out forever while its credentials sit under a name nothing looks up.
/// Relative paths and symlinked homes fail the same way. Canonicalizing once,
/// at the boundary, is what keeps one directory to one identity.
///
/// Requires the path to exist, which it does: Tori creates a profile home
/// before it stores one.
pub fn canonicalize_home(path: &Path) -> Result<String, String> {
    let resolved =
        std::fs::canonicalize(path).map_err(|e| format!("cannot resolve profile home {}: {e}", path.display()))?;
    resolved
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("profile home {} is not valid UTF-8", resolved.display()))
}

/// The canonical home for a folder the user already has, or why it cannot be
/// one.
///
/// Refused before anything runs in it: the sign-in probe writes into whatever
/// folder it is pointed at, so a mis-picked one must never reach it. An empty
/// folder has nothing to mix those files into, so it is adopted as it is.
pub fn adopted_home(
    adapter: &crate::agents::AgentAdapter,
    file: &AccountsFile,
    folder: &str,
) -> Result<String, String> {
    let accounts = adapter
        .accounts
        .as_ref()
        .ok_or_else(|| format!("`{}` declares no accounts", adapter.id))?;
    if accounts.home_markers.is_empty() {
        return Err(format!(
            "Tori cannot tell a {} folder from any other, so leave the field empty.",
            adapter.label
        ));
    }
    let path = crate::agents::expand_tilde(folder.trim());
    if !path.is_absolute() {
        return Err("Give the folder's full path, starting with / or ~/.".into());
    }
    if !path.is_dir() {
        return Err(format!("No folder at {}.", path.display()));
    }
    if !is_empty_dir(&path) && !accounts.home_markers.iter().any(|name| path.join(name).exists()) {
        return Err(format!(
            "This folder holds other files and none of {}'s. Pick an empty folder or one {} already uses, or leave the field empty.",
            adapter.label, adapter.label,
        ));
    }
    let home = canonicalize_home(&path)?;
    let default_home = accounts.home_default.as_deref().and_then(|d| canonicalize_home(d).ok());
    if default_home.as_deref() == Some(home.as_str()) {
        return Err(format!(
            "{home} is {}'s default account, which Tori already lists.",
            adapter.label
        ));
    }
    let mut stored = file.adapters.get(&adapter.id).into_iter().flatten();
    if let Some(taken) = stored.find(|p| p.home.as_deref() == Some(home.as_str())) {
        return Err(format!("{home} is already the {} account.", taken.label));
    }
    Ok(home)
}

// Finder drops `.DS_Store` into any folder it has shown, so a folder made with
// "New Folder" and picked through Browse is never literally empty.
fn is_empty_dir(path: &Path) -> bool {
    std::fs::read_dir(path)
        .map(|mut entries| entries.all(|e| e.is_ok_and(|e| e.file_name() == ".DS_Store")))
        .unwrap_or(false)
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
/// `0700` on every directory Tori creates here, not just the leaf: the agent
/// writes its own session transcripts inside, and on a shared machine those are
/// nobody else's business. The adapter level in the middle matters too, since a
/// world-readable one leaks the profile names above the transcripts. Created
/// before canonicalizing, because resolving symlinks needs something to resolve.
fn create_profile_home_in(root: &Path, adapter_id: &str, profile_id: &str) -> Result<String, String> {
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
/// adapter id comes from a TOML Tori does not control.
pub fn sanitize_segment(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// --- thin wrappers: load -> core -> save ---

/// Read `accounts.json`, or an empty store.
///
/// An unreadable or unparseable file reads as empty rather than as an error,
/// matching every other Tori store: the alternative is a broken JSON file
/// making the app unusable rather than making one list short.
pub fn load() -> AccountsFile {
    std::fs::read_to_string(accounts_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

static STORE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Held from load to save by every writer of `accounts.json`: the launch-time
/// command backfill runs beside the Settings commands, and two unlocked writers
/// would each save a copy missing the other's change.
pub fn lock_store() -> std::sync::MutexGuard<'static, ()> {
    STORE.lock().unwrap_or_else(|e| e.into_inner())
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

/// One profile, plus what its agent says about it right now.
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
    pub managed: bool,
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
    /// The account the agent named just now, which is not the same as the
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
    /// The shell command that runs the agent as this account, `None` for an
    /// adapter with no home variable.
    pub command: Option<String>,
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
    pub default_present: bool,
    pub default_home: Option<String>,
    /// Where the default account really runs when Tori's own environment sets
    /// the adapter's `home_env`; see [`inherited_home`]. `None` is the normal
    /// case, the variable unset.
    pub inherited_home: Option<String>,
    /// The agent's binary, which every account command is named after.
    pub program: String,
    /// Where the account commands live, and whether the login shell can find
    /// them there.
    pub command_dir: String,
    pub command_dir_on_path: bool,
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
        let Some(account) = status.account.as_ref() else {
            continue;
        };
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
/// The caller narrows `live` to the one `(agent, profile)` pair being removed.
/// It used to be every live session of the agent, because nothing recorded
/// which account a running session belonged to; both tables carry the profile
/// now, so a chat on the default account no longer blocks removing another one.
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
    /// This agent has no sign-out command, so the user has to be told that
    /// removing the account revokes nothing before anything is deleted.
    AskFirst,
    /// Asked and answered, or a folder the user already had, whose login is
    /// theirs to keep. Forget it.
    ForgetWithoutSigningOut,
}

/// The rule, as a value, so the order is a thing that can be asserted rather
/// than eight lines of straight-line code in a command nothing calls in a test.
///
/// The order is the whole point. Deleting the profile before signing out would
/// leave a credential Tori had abandoned rather than revoked, with nothing left
/// in the UI to try again from.
///
/// `revoke` is whether the login goes with the account: always for a home Tori
/// made, and for a folder the user already had only when they ask for it.
pub fn removal_plan(revoke: bool, has_logout: bool, confirmed_without_logout: bool) -> RemovalStep {
    if !revoke {
        RemovalStep::ForgetWithoutSigningOut
    } else if has_logout {
        RemovalStep::SignOutFirst
    } else if confirmed_without_logout {
        RemovalStep::ForgetWithoutSigningOut
    } else {
        RemovalStep::AskFirst
    }
}

/// What to tell somebody removing an account from a agent that cannot sign
/// out.
///
/// **Not a link to a revocation page**, which is what this task originally asked
/// for, and the reason is the one adapter that reaches this branch. OpenCode's
/// credentials are per *provider* (the measured install held GitHub Copilot),
/// so there is no single page that revokes "the OpenCode account": whose page
/// it would be depends on which provider, and Tori does not know which. A URL
/// field on `[accounts]` would therefore ship empty on every bundled adapter
/// and be a guess on any other.
///
/// What it does instead is name the agent's own credential command, which is
/// derived from what the adapter already declares rather than added as a field
/// nobody could fill in. That is where the revocation actually happens.
fn no_logout_warning(adapter: &crate::agents::AgentAdapter, accounts: &crate::agents::AccountsConfig) -> String {
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
    crate::agents::find(adapter_id).ok_or_else(|| format!("no agent adapter `{adapter_id}`"))
}

/// One profile row, from the sweep's cached answer about it.
///
/// **Nothing is probed here.** Every account's `whoami` rides the health sweep,
/// which runs once per app run and re-runs only when something could have
/// changed the answer. This used to spawn one subprocess per profile on every
/// call, and this command runs on every Settings open, so adding a second
/// account made the accounts screen pay a probe it had already paid for.
fn status_of(
    adapter: &crate::agents::AgentAdapter,
    accounts: &crate::agents::AccountsConfig,
    profile: &Profile,
    cached: &[crate::health::ProfileHealth],
) -> ProfileStatus {
    // `spawn_env` is the single definition of "which home does this profile
    // run in", so neither the login tab nor the sweep's probe can drift from
    // the session they are about. An incoherent profile is unknown rather than
    // pointed at the wrong account, which is the failure `spawn_env` refuses
    // for.
    let home = spawn_env(accounts, profile).ok().flatten();
    let answer = cached.iter().find(|h| h.id == profile.id);
    ProfileStatus {
        id: profile.id.clone(),
        label: profile.label.clone(),
        is_default: profile.is_default(),
        home: profile.home.clone(),
        managed: profile.managed,
        // A profile the sweep has no row for is one added since it last ran.
        // `Unknown` renders neutral and blocks nothing, which is the honest
        // answer for an account nobody has asked about yet.
        sign_in: answer.map(|h| h.sign_in).unwrap_or_default(),
        login: crate::auth::login_route(adapter, home),
        account: answer.and_then(|h| h.account.clone()),
        api_key_source: answer.and_then(|h| h.api_key_source.clone()),
        duplicate_of: None,
        command: crate::account_commands::command_for(adapter, profile, &crate::account_commands::command_dir()),
    }
}

/// The stored file read once, no probes: this renders on every Settings open,
/// and it is a count, which the file alone answers.
#[tauri::command(async)]
pub fn agent_account_counts() -> BTreeMap<String, usize> {
    account_counts(&load())
}

/// Every account this adapter has, and what its agent says about each.
///
/// Read entirely from the health sweep's cache, so this costs no subprocess.
/// A user who has just finished a login gets the fresh answer because the
/// login flow invalidates the sweep, not because this command re-probes.
#[tauri::command]
pub async fn agent_accounts(adapter_id: String) -> Result<AccountsView, String> {
    let adapter = adapter(&adapter_id)?;
    let Some(accounts) = adapter.accounts.clone() else {
        return Ok(AccountsView {
            adapter_id,
            declared: false,
            can_add: false,
            can_sign_out: false,
            default_present: true,
            default_home: None,
            inherited_home: None,
            program: adapter.program.clone(),
            command_dir: String::new(),
            command_dir_on_path: true,
            profiles: Vec::new(),
        });
    };

    let cached = crate::health::cached_profiles(&adapter_id).await;
    let file = load();
    // One look at the disk, so the hint and the missing row cannot disagree.
    let default_on_disk = default_present(&adapter);
    let mut profiles: Vec<ProfileStatus> = profiles_for_with(&file, &adapter_id, default_on_disk)
        .iter()
        .map(|p| status_of(&adapter, &accounts, p, &cached))
        .collect();
    mark_duplicates(&mut profiles);
    let inherited_home = inherited_home(&accounts);
    mark_inherited_home(&mut profiles, inherited_home.as_deref());

    Ok(AccountsView {
        adapter_id,
        declared: true,
        can_add: can_add_account(&accounts),
        can_sign_out: !accounts.logout_args.is_empty(),
        default_present: default_on_disk,
        default_home: accounts.home_default.as_ref().map(|h| h.to_string_lossy().into_owned()),
        inherited_home,
        program: adapter.program.clone(),
        command_dir: crate::account_commands::command_dir().to_string_lossy().into_owned(),
        command_dir_on_path: crate::account_commands::on_path(
            &crate::account_commands::command_dir(),
            crate::env::login_path_if_captured(),
        ),
        profiles,
    })
}

/// The home the default account really runs in when Tori's own environment
/// sets the adapter's `home_env`: every default-profile child inherits it, so
/// "the variable left unset" is then a different account than the user's own
/// login. Measured today: a dev build started from a shell that had exported
/// `CLAUDE_CONFIG_DIR` for a named profile, and signing that profile out took
/// the default down with it. Canonical where the folder exists, so it compares
/// equal to a stored profile home; the raw string otherwise, so it still names
/// what was set.
fn inherited_home(accounts: &crate::agents::AccountsConfig) -> Option<String> {
    let var = accounts.home_env.as_deref()?;
    let raw = std::env::var(var).ok().filter(|v| !v.trim().is_empty())?;
    Some(canonicalize_home(Path::new(&raw)).unwrap_or(raw))
}

/// The default row is a duplicate of the named profile whose home it inherited,
/// which `mark_duplicates` cannot see when that profile is signed out: there is
/// no email on either side to match, yet a sign-out of one is a sign-out of both.
pub fn mark_inherited_home(statuses: &mut [ProfileStatus], inherited: Option<&str>) {
    let Some(inherited) = inherited else { return };
    let twin = statuses
        .iter()
        .find(|s| !s.is_default && s.home.as_deref() == Some(inherited))
        .map(|s| s.label.clone());
    let Some(twin) = twin else { return };
    if let Some(default) = statuses.iter_mut().find(|s| s.is_default) {
        default.duplicate_of.get_or_insert(twin);
    }
}

/// What adding an account answers: the id it was stored under, and the login to
/// open, `None` where the folder it adopted is already signed in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedAccount {
    pub id: String,
    pub login: Option<crate::auth::LoginRoute>,
}

/// Create a profile and its home, ready to be signed in to. With `home` set it
/// adopts that folder instead, through [`adopted_home`].
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
    home: Option<String>,
) -> Result<AddedAccount, String> {
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

    let held = lock_store();
    let mut file = load();
    let id = mint_profile_id(&file, &adapter_id, label);
    let folder = home.as_deref().map(str::trim).filter(|f| !f.is_empty());
    let (home, managed) = match folder {
        Some(folder) => (adopted_home(&adapter, &file, folder)?, false),
        None => (create_profile_home(&adapter_id, &id)?, true),
    };
    let profile = Profile {
        id,
        label: label.to_string(),
        email: None,
        home: Some(home.clone()),
        managed,
        command: None,
    };
    // The directory exists before the store does, because the stored path is
    // the canonical one and canonicalizing needs something to resolve. So if
    // storing it fails, take the directory back: an unreferenced profile home
    // is invisible in the UI and never cleaned up by anything.
    if let Err(e) = add_profile(&mut file, &adapter_id, profile.clone()).and_then(|()| save(&file)) {
        if managed {
            std::fs::remove_dir_all(&home).ok();
        }
        return Err(e);
    }
    drop(held);
    crate::account_commands::sync_quietly();

    let pair = spawn_env(&accounts, &profile)?;
    // A login tab over a folder that is already signed in would only ask the
    // user to sign in again.
    let signed_in = !managed
        && crate::env::resolve_binary(&adapter.program).is_some_and(|path| {
            let answer = crate::auth::whoami(&path, &accounts, pair.as_ref());
            answer.state == crate::auth::SignIn::SignedIn
        });
    Ok(AddedAccount {
        id: profile.id,
        login: (!signed_in).then(|| crate::auth::login_route(&adapter, pair)),
    })
}

/// Ask the user for a folder to add as an account, starting at `default_path`
/// or their home. `None` when they cancel.
///
/// `with invisibles`, because every Claude config folder is a dot folder. The
/// start path goes in as an argument rather than into the script text, so no
/// spelling of it can break the script.
#[tauri::command(async)]
pub fn pick_account_folder(default_path: Option<String>) -> Result<Option<String>, String> {
    if !cfg!(target_os = "macos") {
        return Err(format!(
            "the folder picker is not available on {}",
            std::env::consts::OS
        ));
    }
    let start = default_path
        .map(|p| crate::agents::expand_tilde(p.trim()))
        .filter(|p| p.is_dir())
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    let out = std::process::Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "POSIX path of (choose folder with prompt \"Choose the folder for this account\" \
             default location ((POSIX file (item 1 of argv)) as alias) with invisibles)",
            "-e",
            "end run",
        ])
        .arg(&start)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr);
        // -128 is AppleScript's "User canceled".
        return if said.contains("(-128)") {
            Ok(None)
        } else {
            Err(said.trim().to_string())
        };
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!path.is_empty()).then(|| path.trim_end_matches('/').to_string()))
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
    let stored = file
        .adapters
        .get(adapter_id)
        .into_iter()
        .flatten()
        .map(|p| p.id.clone());
    let taken: Vec<String> = stored.chain([DEFAULT_PROFILE_ID.to_string()]).collect();
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
/// final - a session in flight, a logout the agent rejected - and a caller
/// sniffing strings would offer "remove anyway?" for all of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RemovalOutcome {
    Removed,
    /// This agent cannot sign out. The message says what that means; calling
    /// again with `confirmed_without_logout` proceeds.
    NeedsConfirming {
        message: String,
    },
}

/// Sign a profile out and forget it, or say why not.
///
/// The order is load-bearing. Logout runs **first**, and a failure stops the
/// removal: deleting the profile behind a live token would leave a credential
/// Tori had abandoned rather than revoked, with nothing left in the UI to try
/// again from.
///
/// `confirmed_without_logout` is the caller having told the user what an adapter
/// with no logout command means and been told to proceed anyway. It is a
/// separate argument rather than a silent fallback so that the removal cannot
/// quietly become a delete for adapters that never had a logout.
///
/// `sign_out` is the user asking for the login to go as well, which matters only
/// for a folder they already had: a home Tori made is always signed out.
#[tauri::command]
pub async fn remove_agent_account(
    chat: tauri::State<'_, crate::chat::host::ChatState>,
    ptys: tauri::State<'_, crate::pty::PtyState>,
    adapter_id: String,
    profile_id: String,
    confirmed_without_logout: bool,
    sign_out: bool,
) -> Result<RemovalOutcome, String> {
    let adapter = adapter(&adapter_id)?;
    let accounts = adapter
        .accounts
        .clone()
        .ok_or_else(|| format!("`{adapter_id}` declares no accounts"))?;

    // Two tables, because neither sees the other's tabs. Claims cover chat tabs
    // and *resumed* PTY tabs; the PTY host's own table is the only thing that
    // sees a **fresh** agent tab, which holds no claim until its session id
    // exists. Asking one alone would delete a home with an agent running in it.
    //
    // Both answer in tab ids, so the sort-and-dedupe means something: a resumed
    // PTY tab is in both, and counting it twice would tell the user to close
    // two things that are one tab.
    let mut live = [
        chat.0.registry.held_by(&adapter_id, &profile_id),
        ptys.live_agent_tabs(&adapter_id, &profile_id),
    ]
    .concat();
    live.sort();
    live.dedup();
    if let Some(refusal) = removal_refusal(&live, &adapter.label) {
        return Err(refusal);
    }

    let profile = profile(&load(), &adapter_id, &profile_id)
        .ok_or_else(|| format!("no profile `{profile_id}` for `{adapter_id}`"))?;

    let revoke = profile.managed || sign_out;
    match removal_plan(revoke, !accounts.logout_args.is_empty(), confirmed_without_logout) {
        RemovalStep::SignOutFirst => {
            let path = crate::env::resolve_binary(&adapter.program)
                .ok_or_else(|| format!("`{}` is not installed, so it cannot sign out", adapter.program))?;
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

    // Read again under the lock: the sign-out above can take seconds, too long
    // to hold every other writer off for.
    let held = lock_store();
    let mut file = load();
    let removed = remove_profile(&mut file, &adapter_id, &profile_id)?;
    save(&file)?;
    drop(held);
    crate::account_commands::sync_quietly();
    // The catalogue is this account's answer, so it goes with the account. Left
    // behind, it would be handed to the next profile minted under the same id.
    crate::catalog_probe::forget(&adapter_id, &profile_id);
    // Same reasoning for the default: an entry naming a profile that is gone
    // would make every new session of this agent resolve to nothing, and a
    // profile later minted under the same id would silently inherit the answer.
    crate::settings::forget_default_profile(&adapter_id, &profile_id);
    // The home goes last, after the store no longer points at it. The other
    // order leaves a stored profile aimed at a directory that is gone, which
    // reads as a working account right up until a session starts in it.
    discard_home(&removed)?;
    Ok(RemovalOutcome::Removed)
}

fn discard_home(removed: &Profile) -> Result<(), String> {
    let Some(home) = removed.home.as_ref().filter(|_| removed.managed) else {
        return Ok(());
    };
    std::fs::remove_dir_all(home)
        .map_err(|e| format!("signed out and forgot the account, but its home is still at {home}: {e}"))
}

/// Sign one profile out without forgetting it.
///
/// The recoverable sibling of `remove_agent_account`: the profile and its home
/// stay stored, only the credential is revoked, through the agent's own logout
/// command with this profile's home in the environment. No confirmation step
/// here because nothing is destroyed - signing back in restores everything -
/// and no fallback for an adapter with no `logout_args`: `can_sign_out` is
/// what gates the button, and reaching this without one is an error worth
/// hearing about rather than a silent no-op.
#[tauri::command]
pub async fn sign_out_agent_account(adapter_id: String, profile_id: String) -> Result<(), String> {
    let adapter = adapter(&adapter_id)?;
    let accounts = adapter
        .accounts
        .clone()
        .ok_or_else(|| format!("`{adapter_id}` declares no accounts"))?;
    let file = load();
    let profile = profile(&file, &adapter_id, &profile_id)
        .ok_or_else(|| format!("no profile `{profile_id}` for `{adapter_id}`"))?;
    let path = crate::env::resolve_binary(&adapter.program)
        .ok_or_else(|| format!("`{}` is not installed, so it cannot sign out", adapter.program))?;
    let home = spawn_env(&accounts, &profile)?;
    crate::auth::logout(&path, &accounts, home.as_ref())
        .map_err(|e| format!("{} would not sign out: {e}", adapter.label))
}

/// Set the home's first-run flag after a sign-in Tori started has exited clean.
///
/// `Ok(false)` when there was nothing to do: the adapter declares no flag, the
/// state file is not there (the login wrote nothing, so there is no home to
/// finish), or the flag is already set. The file is Claude's own live state,
/// so only that one key is touched and the rest is written back as read.
#[tauri::command]
pub async fn complete_sign_in(adapter_id: String, profile_id: String) -> Result<bool, String> {
    let adapter = adapter(&adapter_id)?;
    let Some(flag) = adapter.accounts.as_ref().and_then(|a| a.onboarded.clone()) else {
        return Ok(false);
    };
    let (_, _, home) = crate::agent_config::homes_for(&adapter)
        .into_iter()
        .find(|(id, _, _)| *id == profile_id)
        .ok_or_else(|| format!("`{adapter_id}` has no account `{profile_id}` with a home"))?;
    crate::exec::blocking("complete_sign_in", move || {
        let path = home.join(&flag.file);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(format!("could not read {}: {e}", path.display())),
        };
        let mut state: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("{} is not JSON: {e}", path.display()))?;
        let object = state
            .as_object_mut()
            .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
        if object.get(&flag.key).and_then(|v| v.as_bool()) == Some(true) {
            return Ok(false);
        }
        object.insert(flag.key.clone(), serde_json::Value::Bool(true));
        let out = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
        std::fs::write(&path, out).map_err(|e| format!("could not write {}: {e}", path.display()))?;
        Ok(true)
    })
    .await
}

/// Relabel a profile, and with `rename_command` move its shell command to the
/// new name too. Without it the command stays, so scripts using it keep working.
#[tauri::command]
pub async fn rename_agent_account(
    adapter_id: String,
    profile_id: String,
    label: String,
    rename_command: bool,
) -> Result<(), String> {
    if rename_command && profile_id != DEFAULT_PROFILE_ID {
        crate::account_commands::rename_with_command(&adapter_id, &profile_id, &label)?;
    } else {
        let _held = lock_store();
        let mut file = load();
        rename_profile(&mut file, &adapter_id, &profile_id, &label)?;
        save(&file)?;
    }
    crate::account_commands::sync_quietly();
    Ok(())
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
            managed: true,
            command: None,
        }
    }

    // --- the default profile ---

    #[test]
    fn the_default_profile_is_present_for_an_adapter_with_no_stored_profiles() {
        let file = AccountsFile::default();
        let all = profiles_for_with(&file, "claude", true);
        assert_eq!(all.len(), 1);
        assert!(all[0].is_default());
        assert_eq!(all[0].home, None, "the default profile is the variable left unset");
    }

    #[test]
    fn the_default_profile_cannot_be_removed() {
        let mut file = AccountsFile::default();
        assert!(remove_profile(&mut file, "claude", DEFAULT_PROFILE_ID).is_err());
    }

    /// Renaming it is a different question from removing it: the label is
    /// Tori's own name for the account and the agent never sees it, so this
    /// changes a word on screen and leaves the account itself alone.
    #[test]
    fn the_default_profile_can_be_renamed_and_stays_the_unset_variable() {
        let mut file = AccountsFile::default();
        rename_profile(&mut file, "claude", DEFAULT_PROFILE_ID, "  Personal  ").unwrap();

        let all = profiles_for_with(&file, "claude", true);
        assert_eq!(all[0].label, "Personal", "trimmed, and it is the name the user typed");
        assert_eq!(all[0].id, DEFAULT_PROFILE_ID);
        assert_eq!(all[0].home, None, "still the variable left unset");
        // Per adapter: one agent's accounts say nothing about another's.
        assert_eq!(profiles_for_with(&file, "codex", true)[0].label, "Default");

        // Back to the built-in name stores nothing, so absent and "Default"
        // stay one answer rather than two.
        rename_profile(&mut file, "claude", DEFAULT_PROFILE_ID, "Default").unwrap();
        assert!(file.default_labels.is_empty());

        assert!(rename_profile(&mut file, "claude", DEFAULT_PROFILE_ID, "   ").is_err());
    }

    /// Shadowing the default would point the user's existing login at a
    /// Tori-managed home and make the real one unreachable from the UI.
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
        let ids: Vec<String> = profiles_for_with(&file, "claude", true)
            .into_iter()
            .map(|p| p.id)
            .collect();
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
        assert_eq!(profiles_for_with(&file, "claude", true).len(), 2);
        assert_eq!(
            profiles_for_with(&file, "codex", true).len(),
            1,
            "codex sees only its default"
        );
    }

    /// The Agents table's column: declared adapters count their default plus
    /// whatever was added, and an adapter with no `[accounts]` table has no
    /// row at all rather than a claimed "1".
    #[test]
    fn account_counts_cover_exactly_the_adapters_that_declare_accounts() {
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("work", "/tmp/w")).unwrap();
        let counts = account_counts(&file);
        let claude_default = crate::agents::find("claude").is_none_or(|a| default_present(&a)) as usize;
        assert_eq!(
            counts.get("claude"),
            Some(&(claude_default + 1)),
            "default where present, plus one added"
        );
        assert_eq!(counts.get("codex"), Some(&1), "the default alone");
        assert_eq!(counts.get("gemini"), None, "gemini declares no [accounts]");
    }

    #[test]
    fn an_absent_default_home_lists_only_the_added_profiles() {
        let mut file = AccountsFile::default();
        assert!(profiles_for_with(&file, "claude", false).is_empty());
        add_profile(&mut file, "claude", added("work", "/tmp/w")).unwrap();
        let ids: Vec<String> = profiles_for_with(&file, "claude", false)
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids, ["work"]);
    }

    #[test]
    fn the_default_is_present_exactly_when_its_declared_home_exists() {
        let root = std::env::temp_dir().join(format!("tori-default-home-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let declaring = |home: PathBuf| {
            let mut a = adapter_with(Some("CLAUDE_CONFIG_DIR"), true);
            a.accounts.as_mut().unwrap().home_default = Some(home);
            a
        };

        assert!(default_present(&declaring(root.clone())));
        assert!(!default_present(&declaring(root.join("missing"))));
        // Nothing declared to check, which is how Codex and OpenCode keep theirs.
        assert!(
            default_present(&adapter_with(Some("CLAUDE_CONFIG_DIR"), true)),
            "no home_default"
        );
        assert!(default_present(&crate::agents::test_adapter("x")), "no [accounts]");

        std::fs::remove_dir_all(&root).ok();
    }

    /// Running with the home variable unset would create the missing home, so
    /// the default is refused by name rather than spawned.
    #[test]
    fn an_absent_default_home_refuses_the_default_profile() {
        let missing = std::env::temp_dir().join(format!("tori-no-default-{}", std::process::id()));
        let mut a = adapter_with(Some("CLAUDE_CONFIG_DIR"), true);
        a.accounts.as_mut().unwrap().home_default = Some(missing.clone());
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("globex", "/canonical/globex")).unwrap();

        for id in [None, Some(DEFAULT_PROFILE_ID)] {
            let err = profile_env(&a, &file, id).unwrap_err();
            assert!(err.contains(&missing.display().to_string()), "{err}");
        }
        assert!(
            profile_env(&a, &file, Some("globex")).is_ok(),
            "an added profile still resolves"
        );
    }

    #[test]
    fn removing_the_last_profile_leaves_no_empty_adapter_entry() {
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("work", "/tmp/w")).unwrap();
        let gone = remove_profile(&mut file, "claude", "work").unwrap();
        assert_eq!(
            gone.home.as_deref(),
            Some("/tmp/w"),
            "the caller needs the home to clean up"
        );
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
        p.managed = false;
        add_profile(&mut file, "claude", p).unwrap();
        add_profile(&mut file, "codex", added("alt", "/tmp/a")).unwrap();
        // The one thing about the default account that is stored: its name.
        rename_profile(&mut file, "claude", DEFAULT_PROFILE_ID, "Personal").unwrap();

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
        let _ = profiles_for_with(&file, "claude", true);
        let text = serde_json::to_string(&file).unwrap();
        assert!(
            !text.contains(DEFAULT_PROFILE_ID),
            "default leaked into the file: {text}"
        );
    }

    #[test]
    fn a_file_with_no_version_still_loads() {
        let back: AccountsFile = serde_json::from_str(r#"{"adapters":{}}"#).unwrap();
        assert_eq!(back.version, FILE_VERSION);
    }

    #[test]
    fn a_profile_stored_before_the_managed_field_loads_as_managed() {
        let text = r#"{"adapters":{"claude":[{"id":"work","label":"Work","home":"/tmp/w"}]}}"#;
        let back: AccountsFile = serde_json::from_str(text).unwrap();
        assert!(back.adapters["claude"][0].managed);
    }

    // --- spawn environment ---

    fn accounts_config(home_env: Option<&str>, isolation: bool) -> crate::agents::AccountsConfig {
        crate::agents::AccountsConfig {
            home_env: home_env.map(|s| s.to_string()),
            home_default: None,
            home_markers: vec![],
            login_args: vec![],
            logout_args: vec![],
            whoami_args: vec![],
            whoami_kind: None,
            supports_isolation: isolation,
            onboarded: None,
            plugins_kind: None,
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

    /// The by-id form every spawn goes through, over an adapter value rather
    /// than the registry, so the whole rule is testable with no `accounts.json`.
    fn adapter_with(home_env: Option<&str>, isolation: bool) -> crate::agents::AgentAdapter {
        let mut a = crate::agents::test_adapter("claude");
        a.id = "claude".into();
        a.accounts = Some(accounts_config(home_env, isolation));
        a
    }

    #[test]
    fn no_profile_and_the_default_profile_are_the_same_empty_environment() {
        let a = adapter_with(Some("CLAUDE_CONFIG_DIR"), true);
        let file = AccountsFile::default();
        assert!(profile_env(&a, &file, None).unwrap().is_empty());
        assert!(profile_env(&a, &file, Some(DEFAULT_PROFILE_ID)).unwrap().is_empty());
    }

    #[test]
    fn an_added_profile_resolves_to_its_home_variable() {
        let a = adapter_with(Some("CLAUDE_CONFIG_DIR"), true);
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("globex", "/canonical/globex")).unwrap();

        let env = profile_env(&a, &file, Some("globex")).unwrap();
        assert_eq!(
            env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some("/canonical/globex")
        );
    }

    /// A tab persisted against a profile that has since been removed. An empty
    /// map here would start the session on the user's own login while the tab
    /// still said "Globex", which is the failure the whole feature exists for.
    #[test]
    fn an_unknown_profile_is_an_error_rather_than_the_default_account() {
        let a = adapter_with(Some("CLAUDE_CONFIG_DIR"), true);
        let err = profile_env(&a, &AccountsFile::default(), Some("gone")).unwrap_err();
        assert!(err.contains("gone"), "{err}");
    }

    /// `spawn_env`'s refusal is surfaced rather than swallowed: an adapter that
    /// dropped `home_env` cannot run an added profile at all.
    #[test]
    fn a_missing_home_env_surfaces_as_the_spawn_envs_own_error() {
        let a = adapter_with(None, false);
        let mut file = AccountsFile::default();
        add_profile(&mut file, "claude", added("globex", "/canonical/globex")).unwrap();

        let err = profile_env(&a, &file, Some("globex")).unwrap_err();
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
    /// back: `~/.config/tori` is commonly a dotfile repo, and a profile home
    /// fills up with the agent's own transcripts.
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

    /// A profile home fills up with the agent's own transcripts, so the mode
    /// is part of the store's contract rather than a detail of how it happened
    /// to be created.
    #[test]
    fn a_profile_home_is_created_private_to_its_owner() {
        let root = std::env::temp_dir().join(format!("tori-homes-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();

        let home = create_profile_home_in(&root, "claude", "work").unwrap();
        let path = Path::new(&home);
        assert!(path.is_dir());
        assert!(
            path.ends_with("claude/work"),
            "adapter and profile each get a segment: {home}"
        );

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

    /// An adapter id comes from a TOML Tori does not control, and the result is
    /// concatenated into a path.
    #[test]
    fn a_traversing_id_cannot_escape_the_profile_root() {
        let root = std::env::temp_dir().join(format!("tori-escape-{}", std::process::id()));
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
            managed: true,
            sign_in: crate::auth::SignIn::SignedIn,
            login: crate::auth::LoginRoute::AgentStates,
            account: account.map(str::to_string),
            api_key_source: None,
            duplicate_of: None,
            command: None,
        }
    }

    /// The twin the phase exists to notice: two profiles, one account, nothing
    /// in the UI to tell them apart.
    #[test]
    fn a_second_profile_on_one_account_points_back_at_the_first() {
        let mut rows = [status("Default", Some("a@b.c")), status("Work", Some("a@b.c"))];
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

    /// Two profiles the agent names nothing for are not evidence of anything.
    /// Codex and OpenCode report no account at all, so treating "both unknown"
    /// as "the same" would flag every second profile they ever had.
    #[test]
    fn profiles_with_no_reported_account_are_never_called_duplicates() {
        let mut rows = [
            status("Work", None),
            status("Personal", None),
            status("Third", Some(" ")),
        ];
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
        let cached: Vec<crate::health::ProfileHealth> = Vec::new();
        let work = added("work", "/canonical/work");

        let row = status_of(&claude, &accounts, &work, &cached);
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
        let row = status_of(&claude, &accounts, &default_profile(), &cached);
        match row.login {
            crate::auth::LoginRoute::Terminal { home, .. } => assert_eq!(home, None),
            other => panic!("got {other:?}"),
        }
    }

    /// **Every** profile's answer comes from the cached sweep, not just the
    /// default's, which is what keeps opening Settings from asking each account
    /// a question it was already asked. This command used to spawn one probe
    /// per profile per call.
    #[test]
    fn every_profile_reads_the_answer_the_sweep_already_has() {
        let claude = crate::agents::find("claude").expect("claude ships bundled");
        let accounts = claude.accounts.clone().expect("claude declares accounts");
        let cached = vec![
            crate::health::ProfileHealth {
                id: DEFAULT_PROFILE_ID.into(),
                label: "Default".into(),
                sign_in: crate::auth::SignIn::SignedIn,
                account: Some("a@b.c".into()),
                api_key_source: Some("ANTHROPIC_API_KEY".into()),
            },
            crate::health::ProfileHealth {
                id: "work".into(),
                label: "Work".into(),
                sign_in: crate::auth::SignIn::SignedOut,
                account: None,
                api_key_source: None,
            },
        ];

        let row = status_of(&claude, &accounts, &default_profile(), &cached);
        assert_eq!(row.sign_in, crate::auth::SignIn::SignedIn);
        assert_eq!(row.account.as_deref(), Some("a@b.c"));
        assert_eq!(row.api_key_source.as_deref(), Some("ANTHROPIC_API_KEY"));

        // Its own row, never the default's: two accounts sign in and out
        // independently, and handing one the other's answer is the failure.
        let row = status_of(&claude, &accounts, &added("work", "/canonical/w"), &cached);
        assert_eq!(row.sign_in, crate::auth::SignIn::SignedOut);
        assert_eq!(row.account, None);
    }

    /// A profile added since the sweep last ran has no row. `Unknown` renders
    /// neutral and blocks nothing, which is the honest answer for an account
    /// nobody has asked about yet.
    #[test]
    fn a_profile_the_sweep_has_not_seen_is_unknown_rather_than_signed_out() {
        let claude = crate::agents::find("claude").expect("claude ships bundled");
        let accounts = claude.accounts.clone().expect("claude declares accounts");

        let row = status_of(&claude, &accounts, &added("fresh", "/canonical/f"), &[]);
        assert_eq!(row.sign_in, crate::auth::SignIn::Unknown);
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
    /// leave a credential Tori had abandoned rather than revoked, with nothing
    /// left in the UI to try again from.
    #[test]
    fn a_agent_with_a_logout_command_signs_out_before_forgetting_anything() {
        assert_eq!(removal_plan(true, true, false), RemovalStep::SignOutFirst);
        // Confirmation is for the *other* branch. An adapter that can sign out
        // must not be talked past it.
        assert_eq!(removal_plan(true, true, true), RemovalStep::SignOutFirst);
    }

    /// The state the removal flow has to say out loud rather than paper over.
    /// OpenCode is the real case: its logout takes a provider argument, so
    /// there is no single command that signs the agent out.
    #[test]
    fn a_agent_with_no_logout_asks_before_it_deletes() {
        assert_eq!(removal_plan(true, false, false), RemovalStep::AskFirst);
        assert_eq!(removal_plan(true, false, true), RemovalStep::ForgetWithoutSigningOut);
    }

    #[test]
    fn an_adopted_folder_is_forgotten_and_left_as_it_was() {
        assert_eq!(removal_plan(false, true, false), RemovalStep::ForgetWithoutSigningOut);
        assert_eq!(removal_plan(false, false, false), RemovalStep::ForgetWithoutSigningOut);

        let root = scratch("discard");
        std::fs::create_dir_all(root.join("adopted/projects")).unwrap();
        std::fs::write(root.join("adopted/.claude.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("made")).unwrap();
        let listing = |dir: &Path| {
            let mut names: Vec<_> = std::fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            names.sort();
            names
        };
        let before = listing(&root.join("adopted"));

        let mut adopted = added("adopted", root.join("adopted").to_str().unwrap());
        adopted.managed = false;
        discard_home(&adopted).unwrap();
        assert_eq!(listing(&root.join("adopted")), before);
        assert_eq!(
            std::fs::read_to_string(root.join("adopted/.claude.json")).unwrap(),
            "{}"
        );

        discard_home(&added("made", root.join("made").to_str().unwrap())).unwrap();
        assert!(!root.join("made").exists(), "a home Tori made goes with its account");

        std::fs::remove_dir_all(&root).ok();
    }

    /// The sentence somebody has to agree to, checked against the real adapter
    /// that reaches this branch. It has to say the tokens survive, and it has to
    /// point at where they can actually be revoked.
    #[test]
    fn the_no_logout_warning_says_the_tokens_survive_and_where_to_revoke_them() {
        let opencode = crate::agents::find("opencode").expect("opencode ships bundled");
        let accounts = opencode.accounts.as_ref().expect("opencode declares accounts");
        assert!(
            accounts.logout_args.is_empty(),
            "this test is about the no-logout branch"
        );

        let warning = no_logout_warning(&opencode, accounts);
        assert!(warning.contains("valid until they expire"), "{warning}");
        assert!(
            warning.contains("opencode auth"),
            "name where to revoke them: {warning}"
        );
    }

    /// Derived from what the adapter declares, so an adapter that declares no
    /// login command still gets a complete sentence rather than a dangling one.
    #[test]
    fn the_warning_stays_a_sentence_when_there_is_no_command_to_name() {
        let adapter = crate::agents::test_adapter("thing");
        let accounts = crate::agents::AccountsConfig {
            home_env: None,
            home_default: None,
            home_markers: vec![],
            login_args: vec![],
            logout_args: vec![],
            whoami_args: vec![],
            whoami_kind: None,
            supports_isolation: false,
            onboarded: None,
            plugins_kind: None,
        };
        let warning = no_logout_warning(&adapter, &accounts);
        assert!(warning.contains("valid until they expire"), "{warning}");
        assert!(warning.ends_with("Confirm to remove it anyway."), "{warning}");
    }

    /// The store holds names the user chose and addresses the agent reported.
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
            ["id", "label", "email", "home", "managed"],
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
        let base = std::env::temp_dir().join(format!("tori-accounts-{}", std::process::id()));
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
            assert_eq!(
                plain,
                canonicalize_home(&link).unwrap(),
                "a symlinked home is the same home"
            );
        }

        std::fs::remove_dir_all(&base).ok();
    }

    fn adopting(root: &Path) -> crate::agents::AgentAdapter {
        let mut a = adapter_with(Some("CLAUDE_CONFIG_DIR"), true);
        let accounts = a.accounts.as_mut().unwrap();
        accounts.home_default = Some(root.join("default"));
        accounts.home_markers = vec![".claude.json".into(), "projects".into()];
        a
    }

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("tori-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_marked_or_empty_folder_is_adopted_at_its_canonical_path() {
        let root = scratch("adopt");
        std::fs::create_dir_all(root.join("work/projects")).unwrap();
        std::fs::create_dir_all(root.join("fresh")).unwrap();
        std::fs::write(root.join("fresh/.DS_Store"), "").unwrap();
        let a = adopting(&root);
        let spelt = format!("{}/", root.join("work").display());

        let home = adopted_home(&a, &AccountsFile::default(), &spelt).unwrap();
        assert_eq!(home, canonicalize_home(&root.join("work")).unwrap());
        let fresh = root.join("fresh").display().to_string();
        let home = adopted_home(&a, &AccountsFile::default(), &fresh).unwrap();
        assert_eq!(home, canonicalize_home(&root.join("fresh")).unwrap());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_folder_that_is_missing_unmarked_or_relative_is_refused() {
        let root = scratch("adopt-refused");
        std::fs::create_dir_all(root.join("stray")).unwrap();
        std::fs::write(root.join("stray/notes.txt"), "").unwrap();
        std::fs::create_dir_all(root.join("work/projects")).unwrap();
        std::fs::write(root.join("a-file"), "").unwrap();
        let a = adopting(&root);
        let refusal = |adapter: &crate::agents::AgentAdapter, folder: PathBuf| {
            adopted_home(adapter, &AccountsFile::default(), folder.to_str().unwrap()).unwrap_err()
        };

        assert!(refusal(&a, root.join("missing")).starts_with("No folder"));
        assert!(refusal(&a, root.join("a-file")).starts_with("No folder"));
        let stray = refusal(&a, root.join("stray"));
        assert!(stray.contains("Pick an empty folder"), "{stray}");
        assert!(refusal(&a, PathBuf::from("work")).contains("full path"));

        let mut blind = a.clone();
        blind.accounts.as_mut().unwrap().home_markers.clear();
        assert!(refusal(&blind, root.join("work")).contains("cannot tell"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_default_home_and_a_folder_already_added_are_refused() {
        let root = scratch("adopt-taken");
        std::fs::create_dir_all(root.join("default/projects")).unwrap();
        std::fs::create_dir_all(root.join("work/projects")).unwrap();
        let a = adopting(&root);
        let mut file = AccountsFile::default();
        let mut work = added("work", &canonicalize_home(&root.join("work")).unwrap());
        work.label = "Work".into();
        add_profile(&mut file, "claude", work).unwrap();

        let refusal = |folder: &str| adopted_home(&a, &file, &root.join(folder).display().to_string()).unwrap_err();
        assert!(refusal("default").contains("default account"));
        assert!(refusal("work").contains("already the Work account"));

        std::fs::remove_dir_all(&root).ok();
    }
}
