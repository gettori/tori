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
//! Nothing outside the tests calls any of this yet: Phase 3 wires the account
//! commands and the sign-in ladder on top of it. The allow is module-wide
//! rather than eleven separate ones because the whole module is waiting on one
//! caller, and it comes off in a single line when that caller lands.
#![allow(dead_code)]

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
            login_args: vec![],
            logout_args: vec![],
            whoami_args: vec![],
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
