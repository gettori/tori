//! Where the forge token lives, and what a rejection of it means.
//!
//! Two halves, split the way `[[lesson_pure_core_for_global_stores]]` describes:
//!
//!   * a **pure core** ([`save_to`], [`load_from`], [`delete_from`]) that takes
//!     its `Entry` explicitly, so it is exercised against `keyring-core`'s mock
//!     store and never touches a real keychain in a test run;
//!   * a **thin wrapper** ([`save`], [`load`], [`delete`]) that supplies the
//!     process-wide entry and is the only part that knows there is a default.
//!
//! The store itself is installed once at startup by [`install_store`]. Nothing
//! here reaches the network; the credential is handed to `github::GitHubForge`.

use super::ForgeError;
use keyring_core::{Entry, Error as KeyringError};

/// The keychain service name. Stable, because changing it orphans every token
/// already stored under the old one.
const SERVICE: &str = "com.sway.forge.github";
/// One credential per forge, not per account: multi-account is out of scope for
/// this wave, and a fixed user keeps the entry a specifier rather than a search.
const USER: &str = "oauth";

/// Installs the platform credential store as the process default.
///
/// Called once from setup. `keyring-core` has no default store until something
/// sets one (`Entry::new` answers `NoDefaultStore` otherwise), which is exactly
/// what lets a test install the mock instead.
pub fn install_store() -> Result<(), ForgeError> {
    #[cfg(target_os = "macos")]
    {
        keyring_core::set_default_store(
            apple_native_keyring_store::keychain::Store::new().map_err(|e| {
                ForgeError::Transport { message: format!("keychain unavailable: {e}") }
            })?,
        );
        Ok(())
    }
    // Sway is macOS-only today. Rather than silently running with no store (so
    // every save fails at the point of use, far from the cause), say so here.
    #[cfg(not(target_os = "macos"))]
    Err(ForgeError::Transport { message: "no credential store on this platform".into() })
}

fn entry() -> Result<Entry, ForgeError> {
    Entry::new(SERVICE, USER).map_err(map_err)
}

/// Keyring failures that are not "there is nothing stored" become transport
/// errors: from a caller's point of view a keychain that will not answer is the
/// same class of problem as a network that will not.
fn map_err(e: KeyringError) -> ForgeError {
    ForgeError::Transport { message: format!("keychain: {e}") }
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

// --- thin wrappers over the default entry ---

pub fn save(token: &str) -> Result<(), ForgeError> {
    save_to(&entry()?, token)
}

pub fn load() -> Result<Option<String>, ForgeError> {
    load_from(&entry()?)
}

pub fn delete() -> Result<(), ForgeError> {
    delete_from(&entry()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;

    static MOCK: Once = Once::new();

    /// Installs the mock store process-wide, once.
    ///
    /// The default store is global, so this cannot be per-test; `Once` keeps
    /// concurrent tests from racing to install it. Every test below then uses a
    /// distinct user so they do not share a credential.
    fn mock_entry(user: &str) -> Entry {
        MOCK.call_once(|| {
            keyring_core::set_default_store(
                keyring_core::mock::Store::new().expect("the mock store always builds"),
            );
        });
        Entry::new(SERVICE, user).expect("mock store accepts any name")
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
}
