//! Renewing a token that expires, without spending it twice.
//!
//! GitLab's OAuth tokens live two hours, and every refresh invalidates the pair
//! that produced them. Two poll ticks landing together must therefore not both
//! exchange: the second would present a refresh token the server has already
//! retired, and the account would be lost with nothing the user did wrong.
//! [`Refresher`] is that one-at-a-time gate.
//!
//! The new pair is stored **before** any caller is handed it. A pair that
//! reaches memory and not the keychain is gone on the next launch, and the old
//! one is already retired, so the order is the difference between a renewal and
//! a sign-out.

use super::device_flow::{refresh_with, Endpoints, TokenSet};
use super::http::Transport;
use super::ForgeError;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// How close to its deadline a token is renewed.
///
/// Wide enough that a call starting just under the wire still finishes with a
/// token the server accepts, rather than racing its own expiry.
const MARGIN_SECS: u64 = 300;

/// Whether a token is close enough to its deadline to renew. A token with no
/// deadline never is, which is every GitHub one.
pub fn due(expires_at: Option<u64>, now: u64) -> bool {
    expires_at.is_some_and(|at| at <= now.saturating_add(MARGIN_SECS))
}

/// What an account presents to renew.
pub struct Renewal<'a> {
    pub account_id: &'a str,
    pub refresh_token: &'a str,
    pub client_id: &'a str,
    pub endpoints: &'a Endpoints,
}

/// Why a renewal did not happen, split by what it means for the credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshFailure {
    /// The server refused the refresh token. Nothing can renew this account now,
    /// so it is suspect and the user has to sign in again.
    Rejected(ForgeError),
    /// The new pair could not be stored. The old access token is valid until its
    /// own deadline, so this is a retry rather than a sign-out.
    NotStored(ForgeError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Renewed {
    /// Nothing was due; carry on with whatever the account already had.
    Current,
    /// A new access token, already stored.
    Fresh(String),
}

#[derive(Default)]
pub struct Refresher {
    locks: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
}

impl Refresher {
    fn gate_for(&self, account_id: &str) -> Arc<Mutex<()>> {
        self.locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(account_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Renews the account's token when it is due, at most once across callers.
    ///
    /// `expires_at` is read again behind the gate on purpose: the caller that
    /// waited finds the deadline already moved and spends no request, which is
    /// what keeps a one-use refresh token from being presented twice.
    pub fn ensure(
        &self,
        transport: &dyn Transport,
        renewal: &Renewal<'_>,
        expires_at: impl Fn() -> Option<u64>,
        now: impl Fn() -> u64,
        persist: impl FnOnce(&TokenSet) -> Result<(), ForgeError>,
    ) -> Result<Renewed, RefreshFailure> {
        if !due(expires_at(), now()) {
            return Ok(Renewed::Current);
        }
        let gate = self.gate_for(renewal.account_id);
        let _held = gate.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !due(expires_at(), now()) {
            return Ok(Renewed::Current);
        }
        let set =
            refresh_with(transport, renewal.client_id, renewal.endpoints, renewal.refresh_token)
                .map_err(RefreshFailure::Rejected)?;
        persist(&set).map_err(RefreshFailure::NotStored)?;
        Ok(Renewed::Fresh(set.access_token))
    }
}

#[cfg(test)]
mod tests {
    use super::super::device_flow::gitlab_endpoints;
    use super::super::http::test_support::StubTransport;
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    const NOW: u64 = 1_785_179_400;

    fn renewal<'a>(endpoints: &'a Endpoints) -> Renewal<'a> {
        Renewal {
            account_id: "gitlab-com-arif",
            refresh_token: "glrt_old",
            client_id: "app-id",
            endpoints,
        }
    }

    fn renewed(access: &str) -> String {
        format!(r#"{{"access_token":"{access}","refresh_token":"glrt_new","expires_in":7200}}"#)
    }

    #[test]
    fn a_token_is_renewed_only_near_its_deadline_and_never_without_one() {
        assert!(!due(Some(NOW + 3600), NOW), "an hour of life left is not due");
        assert!(due(Some(NOW + 60), NOW), "a minute left is");
        assert!(due(Some(NOW - 1), NOW), "and so is one already gone");
        // A token that does not expire has nothing to renew, which is every
        // pasted token and every GitHub one.
        assert!(!due(None, NOW));
    }

    #[test]
    fn two_callers_racing_an_expired_token_spend_one_refresh_between_them() {
        // The whole reason this module exists: the server retires the pair it
        // just replaced, so a second exchange would present a dead refresh token
        // and lose the account.
        let endpoints = gitlab_endpoints("https://gitlab.test");
        let stub = StubTransport::new(vec![StubTransport::json(200, &renewed("glpat_new"))]);
        let refresher = Refresher::default();
        let deadline = AtomicU64::new(NOW);

        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    scope.spawn(|| {
                        refresher.ensure(
                            &stub,
                            &renewal(&endpoints),
                            || Some(deadline.load(Ordering::SeqCst)),
                            || NOW,
                            |set| {
                                assert_eq!(set.refresh_token.as_deref(), Some("glrt_new"));
                                deadline.store(NOW + 7200, Ordering::SeqCst);
                                Ok(())
                            },
                        )
                    })
                })
                .collect();
            for handle in handles {
                handle.join().expect("no caller panics").expect("no caller fails");
            }
        });

        assert_eq!(stub.request_count(), 1, "the pair was exchanged twice");
        assert_eq!(deadline.load(Ordering::SeqCst), NOW + 7200);
    }

    #[test]
    fn a_keychain_that_will_not_store_the_new_pair_is_a_retry_not_a_sign_out() {
        // The old access token is valid until its own deadline, so telling the
        // user to sign in again here would be Tori losing an account over a
        // keychain that was busy.
        let endpoints = gitlab_endpoints("https://gitlab.test");
        let stub = StubTransport::new(vec![StubTransport::json(200, &renewed("glpat_new"))]);
        let out = Refresher::default().ensure(
            &stub,
            &renewal(&endpoints),
            || Some(NOW),
            || NOW,
            |_| Err(ForgeError::Transport { message: "keychain: busy".into() }),
        );
        assert!(matches!(out, Err(RefreshFailure::NotStored(_))), "got {out:?}");
    }

    #[test]
    fn a_refused_refresh_is_the_one_failure_that_ends_the_credential() {
        let endpoints = gitlab_endpoints("https://gitlab.test");
        let stub =
            StubTransport::new(vec![StubTransport::json(401, r#"{"error":"invalid_grant"}"#)]);
        let out = Refresher::default().ensure(
            &stub,
            &renewal(&endpoints),
            || Some(NOW),
            || NOW,
            |_| panic!("nothing to store when the exchange failed"),
        );
        assert!(matches!(out, Err(RefreshFailure::Rejected(_))), "got {out:?}");
    }

    #[test]
    fn a_token_with_life_left_is_handed_back_untouched() {
        let endpoints = gitlab_endpoints("https://gitlab.test");
        let stub = StubTransport::new(vec![]);
        let out = Refresher::default().ensure(
            &stub,
            &renewal(&endpoints),
            || Some(NOW + 7200),
            || NOW,
            |_| panic!("nothing was due"),
        );
        assert_eq!(out.unwrap(), Renewed::Current);
        assert_eq!(stub.request_count(), 0);
    }
}
