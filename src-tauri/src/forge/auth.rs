//! Whether Sway currently has a usable forge credential, and what to do when
//! the answer changes.
//!
//! A pure core ([`AuthCore`], state and inputs explicit) plus a thin global
//! wrapper, per `[[lesson_pure_core_for_global_stores]]`. The core owns one
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

/// The credential state, with nothing global in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthCore {
    token: Option<String>,
    login: Option<String>,
    /// A 401 has been seen and not yet superseded by a success.
    suspect: bool,
    /// The `github.enabled` kill switch. Separate from the token on purpose:
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

// --- thin global wrapper ---

static AUTH: std::sync::Mutex<Option<AuthCore>> = std::sync::Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut AuthCore) -> R) -> R {
    let mut guard = AUTH.lock().unwrap();
    f(guard.get_or_insert_with(AuthCore::default))
}

pub fn state() -> AuthState {
    with(|a| a.state())
}

pub fn may_call() -> bool {
    with(|a| a.may_call())
}

pub fn token() -> Option<String> {
    with(|a| a.token().map(|t| t.to_string()))
}

pub fn note_unauthorized() {
    with(|a| a.note_unauthorized());
}

pub fn note_success() {
    with(|a| a.note_success());
}

pub fn set_enabled(enabled: bool) {
    with(|a| a.set_enabled(enabled));
}

/// Folds the outcome of a forge call into the credential state.
///
/// **The one bridge between the client and what the UI reads.** The client
/// keeps its own view of the credential so it stays unit-testable in isolation,
/// but that view is useless if it never reaches `github_auth_state`. Every
/// command that calls the forge routes its result through here, so a 401 on any
/// call marks the credential suspect exactly once, in one place.
pub fn note_result<T>(result: &Result<T, super::ForgeError>) {
    with(|a| a.note_result(result));
}

/// Records who the token belongs to, once it is known.
pub fn note_login(login: String) {
    with(|a| {
        if a.token.is_some() {
            a.login = Some(login);
        }
    });
}

/// Restores the credential from the keychain at startup.
pub fn restore(token: Option<String>, login: Option<String>, enabled: bool) {
    *AUTH.lock().unwrap() = Some(AuthCore::restored(token, login, enabled));
}

/// Stores the token and takes the credential out of suspicion.
pub fn sign_in(token: String, login: Option<String>) -> Result<(), super::ForgeError> {
    super::token::save(&token)?;
    with(|a| a.sign_in(token, login));
    Ok(())
}

/// Deletes the credential, which is the only thing that ever does.
pub fn sign_out() -> Result<(), super::ForgeError> {
    super::token::delete()?;
    with(|a| a.sign_out());
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
        if a.token.is_some() {
            a.login = Some("skarif2".into());
        }
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
}
