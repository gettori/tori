//! Whether Sway currently has a usable forge credential, and what to do when
//! the answer changes.
//!
//! A pure core ([`AuthCore`] per account, gathered in [`AuthStore`]) plus a thin
//! global wrapper, per `[[lesson_pure_core_for_global_stores]]`. The core owns one
//! decision the rest of the app keeps asking: **may I call the API right now?**
//! Three separate things can say no (no token, a suspect token, the kill
//! switch), and every caller getting that wrong in its own way is how a
//! disabled integration ends up still polling.
//!
//! ## Why a 401 suspends rather than deletes
//!
//! Deleting the keychain entry on the first 401 costs the user a full
//! device-flow re-auth, on their phone, to recover from what may have been a
//! proxy, a captive portal, or a forge incident. The asymmetry is severe: not
//! deleting costs one stalled poll cycle. So a 401 marks the credential
//! **suspect**: polling pauses, the UI prompts, and the token stays exactly
//! where it was. Only the user's sign-out or re-sign-in actually clears it, and
//! any answered call clears the suspicion by itself.

use super::model::AuthState;
use super::token::Secret;
use std::collections::BTreeMap;

/// The credential state, with nothing global in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthCore {
    token: Option<String>,
    login: Option<String>,
    /// A 401 has been seen and not yet superseded by a success.
    suspect: bool,
    /// The `forge.enabled` kill switch. Separate from the token on purpose:
    /// stopping the network traffic must not mean losing the credential.
    enabled: bool,
}

impl Default for AuthCore {
    fn default() -> Self {
        Self { token: None, login: None, suspect: false, enabled: true }
    }
}

impl AuthCore {
    /// Restores from what the keychain held at startup.
    pub fn restored(token: Option<String>, login: Option<String>, enabled: bool) -> Self {
        Self { token, login, suspect: false, enabled }
    }

    pub fn state(&self) -> AuthState {
        match (&self.token, self.suspect) {
            (None, _) => AuthState::SignedOut,
            (Some(_), true) => AuthState::Suspect { login: self.login.clone() },
            (Some(_), false) => AuthState::SignedIn { login: self.login.clone().unwrap_or_default() },
        }
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// The one question every caller asks.
    ///
    /// Deliberately not three separate checks at three call sites: a signed-out
    /// app, a suspect credential and a disabled integration must all stop the
    /// poller, and only one of those is obvious enough to be remembered
    /// everywhere.
    pub fn may_call(&self) -> bool {
        self.enabled && self.token.is_some() && !self.suspect
    }

    /// A 401 came back. Non-destructive by design.
    pub fn note_unauthorized(&mut self) {
        if self.token.is_some() {
            self.suspect = true;
        }
    }

    /// Any answered call. Clears a suspicion that turned out to be transient.
    pub fn note_success(&mut self) {
        self.suspect = false;
    }

    /// Folds a forge call's outcome into the credential state.
    ///
    /// Only a 401 says anything about the credential. Treating any failure as a
    /// rejection would be worse than the gap it closes: it would tell the user
    /// to sign in again over a rate limit or an offline laptop.
    pub fn note_result<T>(&mut self, result: &Result<T, super::ForgeError>) {
        match result {
            Ok(_) => self.note_success(),
            Err(super::ForgeError::CredentialSuspect) => self.note_unauthorized(),
            Err(_) => {}
        }
    }

    /// Records who the token belongs to, once it is known.
    pub fn note_login(&mut self, login: String) {
        if self.token.is_some() {
            self.login = Some(login);
        }
    }

    /// A renewal replaced the access token, which also clears any suspicion:
    /// the pair the server just issued is the one that works.
    pub fn note_refreshed(&mut self, token: String) {
        self.token = Some(token);
        self.suspect = false;
    }

    /// Completing a device flow, or re-signing-in after a suspicion.
    pub fn sign_in(&mut self, token: String, login: Option<String>) {
        self.token = Some(token);
        self.login = login;
        self.suspect = false;
    }

    /// Forgets the credential. The caller deletes it from the keychain; this is
    /// only the in-memory half.
    pub fn sign_out(&mut self) {
        self.token = None;
        self.login = None;
        self.suspect = false;
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
}

/// Every account's credential, keyed by account id, under one kill switch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthStore {
    accounts: BTreeMap<String, AuthCore>,
    enabled: bool,
}

impl Default for AuthStore {
    fn default() -> Self {
        Self { accounts: BTreeMap::new(), enabled: true }
    }
}

impl AuthStore {
    /// `(account id, token, login)` per account the keychain answered for.
    pub fn restored(entries: Vec<(String, Option<String>, Option<String>)>, enabled: bool) -> Self {
        let accounts = entries
            .into_iter()
            .map(|(id, token, login)| (id, AuthCore::restored(token, login, enabled)))
            .collect();
        Self { accounts, enabled }
    }

    /// An account Sway holds no credential for reads as signed out.
    pub fn state(&self, id: &str) -> AuthState {
        self.accounts.get(id).map_or(AuthState::SignedOut, AuthCore::state)
    }

    pub fn may_call(&self, id: &str) -> bool {
        self.accounts.get(id).is_some_and(AuthCore::may_call)
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn token(&self, id: &str) -> Option<&str> {
        self.accounts.get(id).and_then(AuthCore::token)
    }

    pub fn note_result<T>(&mut self, id: &str, result: &Result<T, super::ForgeError>) {
        if let Some(core) = self.accounts.get_mut(id) {
            core.note_result(result);
        }
    }

    pub fn note_login(&mut self, id: &str, login: String) {
        if let Some(core) = self.accounts.get_mut(id) {
            core.note_login(login);
        }
    }

    pub fn note_refreshed(&mut self, id: &str, token: String) {
        if let Some(core) = self.accounts.get_mut(id) {
            core.note_refreshed(token);
        }
    }

    pub fn note_rejected(&mut self, id: &str) {
        if let Some(core) = self.accounts.get_mut(id) {
            core.note_unauthorized();
        }
    }

    pub fn sign_in(&mut self, id: &str, token: String, login: Option<String>) {
        let enabled = self.enabled;
        self.accounts
            .entry(id.to_string())
            .or_insert_with(|| AuthCore::restored(None, None, enabled))
            .sign_in(token, login);
    }

    pub fn sign_out(&mut self, id: &str) {
        self.accounts.remove(id);
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        for core in self.accounts.values_mut() {
            core.set_enabled(enabled);
        }
    }
}

// --- thin global wrapper ---

static AUTH: std::sync::Mutex<Option<AuthStore>> = std::sync::Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut AuthStore) -> R) -> R {
    let mut guard = AUTH.lock().unwrap();
    f(guard.get_or_insert_with(AuthStore::default))
}

pub fn state(id: &str) -> AuthState {
    with(|s| s.state(id))
}

pub fn may_call(id: &str) -> bool {
    with(|s| s.may_call(id))
}

pub fn enabled() -> bool {
    with(|s| s.enabled())
}

pub fn token(id: &str) -> Option<String> {
    with(|s| s.token(id).map(|t| t.to_string()))
}

/// Folds the outcome of a forge call into the credential state.
///
/// **The one bridge between the client and what the UI reads.** The client
/// keeps its own view of the credential so it stays unit-testable in isolation,
/// but that view is useless if it never reaches `forge_accounts`. Every
/// command that calls the forge routes its result through here, so a 401 on any
/// call marks that account's credential suspect exactly once, in one place.
pub fn note_result<T>(id: &str, result: &Result<T, super::ForgeError>) {
    with(|s| s.note_result(id, result));
}

pub fn note_login(id: &str, login: String) {
    with(|s| s.note_login(id, login));
}

/// The in-memory half of a renewal. The keychain write is the caller's, because
/// a new pair is stored before anything is allowed to use it.
pub fn note_refreshed(id: &str, token: String) {
    with(|s| s.note_refreshed(id, token));
}

/// The renewal itself was refused, which is the one failure that ends a
/// credential: nothing can renew it, so the user has to sign in again.
pub fn note_rejected(id: &str) {
    with(|s| s.note_rejected(id));
}

/// Restores every account's credential from the keychain at startup.
pub fn restore(entries: Vec<(String, Option<String>, Option<String>)>, enabled: bool) {
    *AUTH.lock().unwrap() = Some(AuthStore::restored(entries, enabled));
}

/// Stores the secret and takes the account out of suspicion.
pub fn sign_in(id: &str, secret: &Secret, login: Option<String>) -> Result<(), super::ForgeError> {
    super::token::save_secret(id, secret)?;
    with(|s| s.sign_in(id, secret.access_token.clone(), login));
    Ok(())
}

/// Deletes the account's credential, which is the only thing that ever does.
pub fn sign_out(id: &str) -> Result<(), super::ForgeError> {
    super::token::delete_secret(id)?;
    with(|s| s.sign_out(id));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_in() -> AuthCore {
        AuthCore::restored(Some("gho_x".into()), Some("skarif2".into()), true)
    }

    #[test]
    fn a_401_pauses_calls_without_forgetting_the_token() {
        let mut a = signed_in();
        assert!(a.may_call());

        a.note_unauthorized();
        assert!(!a.may_call(), "polling pauses");
        assert_eq!(a.state(), AuthState::Suspect { login: Some("skarif2".into()) });
        // The whole point: the credential is still there. Deleting it would
        // cost a full device-flow re-auth to recover from a maybe-transient
        // failure, while keeping it costs one stalled poll cycle.
        assert_eq!(a.token(), Some("gho_x"));
    }

    #[test]
    fn a_transient_401_recovers_on_the_next_success_with_no_re_auth() {
        let mut a = signed_in();
        a.note_unauthorized();
        assert!(!a.may_call());

        // A proxy or a forge incident answered once and then stopped. Nothing
        // the user did fixed this, and nothing they do should have to.
        a.note_success();
        assert!(a.may_call(), "recovered by itself");
        assert_eq!(a.state(), AuthState::SignedIn { login: "skarif2".into() });
        assert_eq!(a.token(), Some("gho_x"), "the same token, never re-fetched");
    }

    #[test]
    fn suspect_keeps_the_login_so_the_prompt_can_name_it() {
        // "Sign back in as skarif2" beats dropping the user at a blank sign-in
        // with no clue which account stopped working.
        let mut a = signed_in();
        a.note_unauthorized();
        match a.state() {
            AuthState::Suspect { login } => assert_eq!(login, Some("skarif2".into())),
            other => panic!("expected suspect, got {other:?}"),
        }
    }

    #[test]
    fn re_signing_in_clears_the_suspicion() {
        let mut a = signed_in();
        a.note_unauthorized();
        a.sign_in("gho_new".into(), Some("skarif2".into()));
        assert!(a.may_call());
        assert_eq!(a.token(), Some("gho_new"));
    }

    #[test]
    fn signing_out_forgets_everything() {
        let mut a = signed_in();
        a.note_unauthorized();
        a.sign_out();
        assert_eq!(a.state(), AuthState::SignedOut);
        assert!(!a.may_call());
        assert_eq!(a.token(), None);
    }

    #[test]
    fn the_kill_switch_stops_calls_without_touching_the_credential() {
        // Separate from signing out on purpose: stopping the traffic must not
        // cost the credential, or the only way to quiet a misbehaving poller
        // would also disable PR creation and the review surface.
        let mut a = signed_in();
        a.set_enabled(false);
        assert!(!a.may_call());
        assert_eq!(a.token(), Some("gho_x"), "still signed in, just quiet");
        assert_eq!(a.state(), AuthState::SignedIn { login: "skarif2".into() });

        a.set_enabled(true);
        assert!(a.may_call());
    }

    #[test]
    fn a_401_while_signed_out_does_not_invent_a_suspect_credential() {
        // Nothing to suspect. Without the guard the UI would prompt to re-sign-in
        // to a token that never existed.
        let mut a = AuthCore::default();
        a.note_unauthorized();
        assert_eq!(a.state(), AuthState::SignedOut);
    }

    #[test]
    fn only_a_401_moves_the_credential_to_suspect() {
        // `note_result` is the single bridge from a call's outcome to what the
        // UI reads. Getting its filter wrong in the other direction is worse
        // than the bug it fixes: telling a user to sign in again over a rate
        // limit or an offline laptop.
        use super::super::{ForgeError, RateLimitKind};
        let mut a = signed_in();
        for harmless in [
            ForgeError::RateLimited {
                kind: RateLimitKind::Primary,
                retry_after_secs: None,
                reset_at_secs: None,
            },
            ForgeError::Transport { message: "offline".into() },
            ForgeError::NotFound,
            ForgeError::Forbidden { message: "scope".into() },
        ] {
            a.note_result(&Err::<(), _>(harmless.clone()));
            assert!(a.may_call(), "{harmless:?} must not read as a rejected token");
        }

        a.note_result(&Err::<(), _>(ForgeError::CredentialSuspect));
        assert!(!a.may_call(), "only a 401 suspends");

        // And an answered call takes it back out of suspicion.
        a.note_result(&Ok::<_, ForgeError>(()));
        assert!(a.may_call());
    }

    #[test]
    fn a_login_is_only_recorded_against_a_real_credential() {
        // Naming an account while signed out would render "signed in as X" for
        // a token that does not exist.
        let mut a = AuthCore::default();
        a.note_login("skarif2".into());
        assert_eq!(a.state(), AuthState::SignedOut);
    }

    #[test]
    fn every_reason_to_stop_is_answered_by_one_question() {
        // Three independent noes, one `may_call`. Three call sites each
        // remembering their own subset is how a disabled integration keeps
        // polling.
        let cases = [
            (AuthCore::default(), "no token"),
            ({
                let mut a = signed_in();
                a.note_unauthorized();
                a
            }, "suspect"),
            ({
                let mut a = signed_in();
                a.set_enabled(false);
                a
            }, "disabled"),
        ];
        for (a, why) in cases {
            assert!(!a.may_call(), "{why} must stop the caller");
        }
    }

    #[test]
    fn a_401_on_one_account_leaves_the_other_untouched() {
        let mut store = AuthStore::restored(
            vec![
                ("personal".into(), Some("gho_a".into()), Some("skarif2".into())),
                ("work".into(), Some("gho_b".into()), Some("fonn-arif".into())),
            ],
            true,
        );
        store.note_result("work", &Err::<(), _>(super::super::ForgeError::CredentialSuspect));
        assert!(!store.may_call("work"));
        assert!(store.may_call("personal"));
        assert_eq!(store.state("personal"), AuthState::SignedIn { login: "skarif2".into() });

        store.set_enabled(false);
        assert!(!store.may_call("personal"), "the kill switch reaches every account");
        assert_eq!(store.state("nobody"), AuthState::SignedOut);
    }
}
