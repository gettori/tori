//! Where the forge token lives, and what a rejection of it means.
//!
//! Two halves, split the way `[[lesson_pure_core_for_global_stores]]` describes:
//!
//!   * a **pure core** ([`save_to`], [`load_from`], [`delete_from`]) that takes
//!     its `Entry` explicitly, so it is exercised against `keyring-core`'s mock
//!     store and never touches a real keychain in a test run;
//!   * a **thin wrapper** ([`save_secret`], [`load_secret`], [`delete_secret`])
//!     that supplies the per-account entry and is the only part that knows there
//!     is a default.
//!
//! The store itself is installed once at startup by [`install_store`]. Nothing
//! here reaches the network; the credential is handed to `github::GitHubForge`.

use super::ForgeError;
use keyring_core::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};

/// The keychain service every account's secret is stored under, keyed by the
/// account id. Stable, because changing it orphans every stored token.
const ACCOUNT_SERVICE: &str = "com.tori.forge";
/// The single GitHub credential from before accounts existed. Read once by the
/// migration and left in place, so a downgraded build still finds it.
const LEGACY_SERVICE: &str = "com.tori.forge.github";
const LEGACY_USER: &str = "oauth";

/// What one account keeps in the keychain. One entry for both tokens, so a
/// refresh replaces the pair in a single write.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl Secret {
    pub fn access(token: String) -> Self {
        Self {
            access_token: token,
            refresh_token: None,
        }
    }
}

/// Installs the platform credential store as the process default.
///
/// Called once from setup. `keyring-core` has no default store until something
/// sets one (`Entry::new` answers `NoDefaultStore` otherwise), which is exactly
/// what lets a test install the mock instead.
///
/// Fails where the OS has no store Tori uses, rather than running with none and
/// failing every save far from the cause.
pub fn install_store() -> Result<(), ForgeError> {
    let store = crate::platform::native::credential_store().map_err(|message| ForgeError::Transport { message })?;
    keyring_core::set_default_store(store);
    Ok(())
}

fn account_entry(account_id: &str) -> Result<Entry, ForgeError> {
    Entry::new(ACCOUNT_SERVICE, account_id).map_err(map_err)
}

/// Keyring failures that are not "there is nothing stored" become transport
/// errors: from a caller's point of view a keychain that will not answer is the
/// same class of problem as a network that will not.
fn map_err(e: KeyringError) -> ForgeError {
    ForgeError::Transport {
        message: format!("keychain: {e}"),
    }
}

// --- pure core (entry explicit, no globals) ---

pub fn save_to(entry: &Entry, token: &str) -> Result<(), ForgeError> {
    entry.set_password(token).map_err(map_err)
}

/// The stored token, or `None` when there is none.
///
/// A missing credential is `Ok(None)`, not an error: "signed out" is an ordinary
/// state this app is in every first run, and making it an error would push every
/// caller into matching on an error variant to discover something normal.
pub fn load_from(entry: &Entry) -> Result<Option<String>, ForgeError> {
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(map_err(e)),
    }
}

/// Deletes the credential. Deleting one that is already gone succeeds, so
/// signing out twice is not an error.
pub fn delete_from(entry: &Entry) -> Result<(), ForgeError> {
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(map_err(e)),
    }
}

pub fn save_secret_to(entry: &Entry, secret: &Secret) -> Result<(), ForgeError> {
    let text = serde_json::to_string(secret).map_err(|e| ForgeError::Malformed {
        message: format!("secret: {e}"),
    })?;
    save_to(entry, &text)
}

pub fn load_secret_from(entry: &Entry) -> Result<Option<Secret>, ForgeError> {
    let Some(text) = load_from(entry)? else {
        return Ok(None);
    };
    // The serde error is dropped on purpose: its message can quote the input.
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|_| ForgeError::Malformed {
            message: "the stored secret is not readable".into(),
        })
}

// --- thin wrappers over the real entries ---

pub fn save_secret(account_id: &str, secret: &Secret) -> Result<(), ForgeError> {
    #[cfg(all(debug_assertions, not(test)))]
    return dev_file::save(account_id, secret);
    #[allow(unreachable_code)]
    save_secret_to(&account_entry(account_id)?, secret)
}

pub fn load_secret(account_id: &str) -> Result<Option<Secret>, ForgeError> {
    #[cfg(all(debug_assertions, not(test)))]
    if let Some(secret) = dev_file::read().remove(account_id) {
        return Ok(Some(secret));
    }
    let secret = load_secret_from(&account_entry(account_id)?)?;
    // Copied once so the keychain is asked once, not on every reload.
    #[cfg(all(debug_assertions, not(test)))]
    if let Some(secret) = &secret {
        dev_file::save(account_id, secret)?;
    }
    Ok(secret)
}

pub fn delete_secret(account_id: &str) -> Result<(), ForgeError> {
    #[cfg(all(debug_assertions, not(test)))]
    return dev_file::delete(account_id);
    #[allow(unreachable_code)]
    delete_from(&account_entry(account_id)?)
}

pub fn load_legacy() -> Result<Option<String>, ForgeError> {
    #[cfg(all(debug_assertions, not(test)))]
    return Ok(None);
    #[allow(unreachable_code)]
    load_from(&Entry::new(LEGACY_SERVICE, LEGACY_USER).map_err(map_err)?)
}

/// Where a dev build keeps forge secrets, seeded from the keychain on first
/// read. A keychain item trusts the code signature that wrote it, and a dev
/// build's ad hoc signature changes on every rebuild, so each hot reload asked
/// for the login password again. Release builds never compile this.
#[cfg(all(debug_assertions, not(test)))]
mod dev_file {
    use super::{ForgeError, Secret};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn path() -> PathBuf {
        crate::owned_state::config_dir().join("dev-forge-secrets.json")
    }

    pub fn read() -> BTreeMap<String, Secret> {
        std::fs::read_to_string(path())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn write(all: &BTreeMap<String, Secret>) -> Result<(), ForgeError> {
        use std::io::Write;
        let fail = |e: std::io::Error| ForgeError::Transport {
            message: format!("dev secrets: {e}"),
        };
        let path = path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(fail)?;
        }
        let tmp = path.with_extension("json.tmp");
        let _ = std::fs::remove_file(&tmp);
        let text = serde_json::to_string(all).map_err(|e| ForgeError::Malformed {
            message: format!("secret: {e}"),
        })?;
        let mut file = crate::platform::fs::create_private(&tmp).map_err(fail)?;
        file.write_all(text.as_bytes()).map_err(fail)?;
        std::fs::rename(tmp, path).map_err(fail)
    }

    pub fn save(account_id: &str, secret: &Secret) -> Result<(), ForgeError> {
        let mut all = read();
        all.insert(account_id.to_string(), secret.clone());
        write(&all)
    }

    pub fn delete(account_id: &str) -> Result<(), ForgeError> {
        let mut all = read();
        if all.remove(account_id).is_some() {
            write(&all)?;
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Once;

    static MOCK: Once = Once::new();

    /// Installs the mock store process-wide, once.
    ///
    /// The default store is global, so this cannot be per-test; `Once` keeps
    /// concurrent tests from racing to install it. Every test below then uses a
    /// distinct user so they do not share a credential.
    pub(crate) fn mock_entry_in(service: &str, user: &str) -> Entry {
        MOCK.call_once(|| {
            keyring_core::set_default_store(keyring_core::mock::Store::new().expect("the mock store always builds"));
        });
        Entry::new(service, user).expect("mock store accepts any name")
    }

    fn mock_entry(user: &str) -> Entry {
        mock_entry_in(ACCOUNT_SERVICE, user)
    }

    #[test]
    fn a_token_round_trips_through_the_store() {
        let e = mock_entry("round-trip");
        assert_eq!(load_from(&e).unwrap(), None, "nothing stored yet");

        save_to(&e, "gho_first").unwrap();
        assert_eq!(load_from(&e).unwrap(), Some("gho_first".to_string()));

        // Saving again replaces rather than appending a second credential,
        // which would make the entry ambiguous and fail every later read.
        save_to(&e, "gho_second").unwrap();
        assert_eq!(load_from(&e).unwrap(), Some("gho_second".to_string()));

        delete_from(&e).unwrap();
        assert_eq!(load_from(&e).unwrap(), None, "gone after delete");
    }

    #[test]
    fn a_missing_credential_is_none_not_an_error() {
        // Signed out is an ordinary state, not a failure. If this were an error
        // every caller would have to match an error variant to learn something
        // completely normal.
        let e = mock_entry("never-written");
        assert_eq!(load_from(&e).unwrap(), None);
    }

    #[test]
    fn deleting_twice_is_not_an_error() {
        // Sign out, then sign out again: the second one has nothing to do and
        // must not surface a failure to the user.
        let e = mock_entry("double-delete");
        save_to(&e, "gho_x").unwrap();
        delete_from(&e).unwrap();
        delete_from(&e).unwrap();
        assert_eq!(load_from(&e).unwrap(), None);
    }

    #[test]
    fn the_token_never_appears_in_a_store_error() {
        // The store's errors reach the UI, so they must carry the keychain's
        // complaint and nothing else.
        let msg = map_err(KeyringError::NoEntry).to_string();
        assert!(msg.contains("keychain"));
        assert!(!msg.contains("gho_"));
    }

    #[test]
    fn a_secret_round_trips_with_and_without_a_refresh_token() {
        let e = mock_entry("secret-round-trip");
        assert_eq!(load_secret_from(&e).unwrap(), None);

        save_secret_to(&e, &Secret::access("gho_only".into())).unwrap();
        assert_eq!(load_secret_from(&e).unwrap(), Some(Secret::access("gho_only".into())));

        let pair = Secret {
            access_token: "glpat_a".into(),
            refresh_token: Some("glrt_r".into()),
        };
        save_secret_to(&e, &pair).unwrap();
        assert_eq!(load_secret_from(&e).unwrap(), Some(pair.clone()));
        assert!(!format!("{pair:?}").contains("glpat_a"), "Debug must not print a token");
    }
}
