//! What stands between an issue call and the host: a rate gate per account,
//! and a short cache with single flight for the assigned list.
//!
//! The poll layer's backoff lives in the webview (`forgePoll.ts`), and an issue
//! call from the socket never passes through it. So the gate is here, in Rust,
//! where every caller does pass: once the host has said "rate limited", nothing
//! goes out for that account until the deadline the host named.

use super::IssueRef;
use crate::forge::model::RepoRef;
use crate::forge::status::{SingleFlight, FRESH_FOR};
use crate::forge::{now_secs, ForgeError, RateLimitKind};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// How long to hold off when a refusal named no deadline at all.
const UNNAMED_WAIT_SECS: u64 = 60;

#[derive(Default)]
pub struct Gate {
    /// Account id to the limit it hit and the unix second it lifts.
    limits: Mutex<HashMap<String, (RateLimitKind, u64)>>,
    fresh: Mutex<HashMap<String, (Instant, Vec<IssueRef>)>>,
    flight: SingleFlight<Vec<IssueRef>>,
}

impl Gate {
    /// The refusal a call would get right now, without asking the host.
    pub fn refuse(&self, account: &str, now: u64) -> Result<(), ForgeError> {
        let limits = self.limits.lock().unwrap_or_else(|e| e.into_inner());
        match limits.get(account) {
            Some(&(kind, until)) if until > now => Err(ForgeError::RateLimited {
                kind,
                retry_after_secs: Some(until - now),
                reset_at_secs: Some(until),
            }),
            _ => Ok(()),
        }
    }

    /// Learns from an answer: a rate limit closes the gate until its deadline,
    /// anything the host actually answered opens it.
    pub fn note<T>(&self, account: &str, result: &Result<T, ForgeError>, now: u64) {
        let mut limits = self.limits.lock().unwrap_or_else(|e| e.into_inner());
        match result {
            Err(ForgeError::RateLimited {
                kind,
                retry_after_secs,
                reset_at_secs,
            }) => {
                let until = retry_after_secs
                    .map(|s| now + s)
                    .or(*reset_at_secs)
                    .filter(|u| *u > now)
                    .unwrap_or(now + UNNAMED_WAIT_SECS);
                limits.insert(account.to_string(), (*kind, until));
            }
            Err(ForgeError::Transport { .. }) => {}
            _ => {
                limits.remove(account);
            }
        }
    }

    /// One call through the gate.
    pub fn call<T>(&self, account: &str, run: impl FnOnce() -> Result<T, ForgeError>) -> Result<T, ForgeError> {
        self.refuse(account, now_secs())?;
        let out = run();
        self.note(account, &out, now_secs());
        out
    }

    /// The assigned list, from the cache when it is fresh, else one request
    /// however many callers ask at once. A failure caches nothing.
    pub fn assigned(
        &self,
        account: &str,
        repo: &RepoRef,
        refresh: bool,
        fetch: impl FnOnce() -> Result<Vec<IssueRef>, ForgeError>,
    ) -> Result<Vec<IssueRef>, ForgeError> {
        let key = format!("{account}\n{}/{}", repo.owner, repo.repo);
        if !refresh {
            let fresh = self.fresh.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((at, list)) = fresh.get(&key) {
                if at.elapsed() <= FRESH_FOR {
                    return Ok(list.clone());
                }
            }
        }
        let list = self.flight.run(key.clone(), || self.call(account, fetch))?;
        self.fresh
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, (Instant::now(), list.clone()));
        Ok(list)
    }
}

pub fn gate() -> &'static Gate {
    static GATE: OnceLock<Gate> = OnceLock::new();
    GATE.get_or_init(Gate::default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::issues::IssueKind;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    fn repo() -> RepoRef {
        RepoRef {
            owner: "gettori".into(),
            repo: "tori".into(),
        }
    }

    fn limited(reset_at: u64) -> ForgeError {
        ForgeError::RateLimited {
            kind: RateLimitKind::Primary,
            retry_after_secs: None,
            reset_at_secs: Some(reset_at),
        }
    }

    #[test]
    fn a_rate_limit_stops_the_next_call_before_it_is_sent() {
        let gate = Gate::default();
        let reset = now_secs() + 600;
        let first: Result<(), _> = gate.call("a1", || Err(limited(reset)));
        assert!(first.is_err());
        let sent = AtomicUsize::new(0);
        let second = gate.call("a1", || {
            sent.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        assert_eq!(sent.load(Ordering::SeqCst), 0);
        assert!(matches!(second, Err(ForgeError::RateLimited { reset_at_secs: Some(r), .. }) if r == reset));
        // Another account is not held back by this one's budget.
        assert!(gate.refuse("a2", now_secs()).is_ok());
    }

    #[test]
    fn the_gate_opens_at_the_hosts_deadline() {
        let gate = Gate::default();
        gate.note::<()>("a1", &Err(limited(1_000)), 900);
        assert!(gate.refuse("a1", 999).is_err());
        assert!(gate.refuse("a1", 1_000).is_ok());
    }

    #[test]
    fn a_retry_after_wins_over_the_reset() {
        let gate = Gate::default();
        let err = ForgeError::RateLimited {
            kind: RateLimitKind::Secondary,
            retry_after_secs: Some(30),
            reset_at_secs: Some(5_000),
        };
        gate.note::<()>("a1", &Err(err), 100);
        assert!(gate.refuse("a1", 129).is_err());
        assert!(gate.refuse("a1", 130).is_ok());
    }

    #[test]
    fn a_failed_list_is_not_cached() {
        let gate = Gate::default();
        let _ = gate.assigned("a1", &repo(), false, || Err(ForgeError::NotFound));
        let got = gate.assigned("a1", &repo(), false, || Ok(vec![])).unwrap();
        assert!(got.is_empty());
    }

    #[test]
    fn a_fresh_list_answers_without_a_request() {
        let gate = Gate::default();
        let item = IssueRef {
            key: "1".into(),
            display: "#1".into(),
            title: "t".into(),
            url: "u".into(),
            kind: IssueKind::Issue,
        };
        gate.assigned("a1", &repo(), false, || Ok(vec![item.clone()])).unwrap();
        let again = gate
            .assigned("a1", &repo(), false, || panic!("should come from the cache"))
            .unwrap();
        assert_eq!(again, vec![item]);
    }

    #[test]
    fn concurrent_asks_make_one_request() {
        let gate = Arc::new(Gate::default());
        let sent = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(2));
        let lead = {
            let (gate, sent, start) = (gate.clone(), sent.clone(), start.clone());
            std::thread::spawn(move || {
                gate.assigned("a1", &repo(), true, || {
                    start.wait();
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    sent.fetch_add(1, Ordering::SeqCst);
                    Ok(vec![])
                })
            })
        };
        start.wait();
        let follow = gate.assigned("a1", &repo(), true, || {
            sent.fetch_add(1, Ordering::SeqCst);
            Ok(vec![])
        });
        assert!(lead.join().unwrap().is_ok());
        assert!(follow.is_ok());
        assert_eq!(sent.load(Ordering::SeqCst), 1);
    }
}
