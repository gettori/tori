//! The one time code a device trades for its credential. One code is live at a
//! time, it dies on first use, and it is short enough to type, so a handful of
//! wrong tries burns it rather than letting it be guessed.

use std::sync::Mutex;

use serde::Serialize;

const TTL_MS: u64 = 5 * 60 * 1000;
const MAX_WRONG: u8 = 5;
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// How a live code stopped being redeemable, for the pane showing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Ended {
    Used,
    Burned,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Offer {
    pub code: String,
    pub url: String,
    pub uri: String,
    pub expires_ms: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    NoCode,
    Expired,
    Wrong,
    Burned,
    Mint(String),
}

impl PairError {
    pub fn message(&self) -> String {
        match self {
            PairError::NoCode => "no pairing in progress".into(),
            PairError::Expired => "the code has expired".into(),
            PairError::Wrong => "wrong code".into(),
            PairError::Burned => "too many wrong codes; start pairing again".into(),
            PairError::Mint(e) => format!("the device could not be added: {e}"),
        }
    }
}

struct Live {
    code: String,
    expires_ms: u64,
    wrong: u8,
}

pub struct Pairing {
    live: Mutex<Option<Live>>,
    on_change: Box<dyn Fn(Ended) + Send + Sync>,
}

impl Pairing {
    pub fn new(on_change: Box<dyn Fn(Ended) + Send + Sync>) -> Self {
        Self {
            live: Mutex::new(None),
            on_change,
        }
    }

    pub fn start(&self, url: &str, now_ms: u64) -> Result<Offer, String> {
        let code = random_code()?;
        let expires_ms = now_ms + TTL_MS;
        *self.lock() = Some(Live {
            code: code.clone(),
            expires_ms,
            wrong: 0,
        });
        Ok(Offer {
            code: format!("{}-{}", &code[..4], &code[4..]),
            url: url.to_string(),
            uri: format!("tori://pair?url={url}&code={code}"),
            expires_ms,
        })
    }

    pub fn cancel(&self) {
        if self.lock().take().is_some() {
            (self.on_change)(Ended::Cancelled);
        }
    }

    /// Runs `mint` when `code` is the live one and consumes the code only if
    /// `mint` succeeds, so a failed save leaves it usable.
    pub fn redeem<T>(&self, code: &str, now_ms: u64, mint: impl FnOnce() -> Result<T, String>) -> Result<T, PairError> {
        let mut live = self.lock();
        let held = live.as_mut().ok_or(PairError::NoCode)?;
        if now_ms >= held.expires_ms {
            *live = None;
            return Err(PairError::Expired);
        }
        if !super::auth::constant_time_eq(normalise(code).as_bytes(), held.code.as_bytes()) {
            held.wrong += 1;
            if held.wrong < MAX_WRONG {
                return Err(PairError::Wrong);
            }
            *live = None;
            drop(live);
            (self.on_change)(Ended::Burned);
            return Err(PairError::Burned);
        }
        let minted = mint().map_err(PairError::Mint)?;
        *live = None;
        drop(live);
        (self.on_change)(Ended::Used);
        Ok(minted)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Live>> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// Typed on a phone: case, dashes and spaces do not matter, and the letters
// Crockford leaves out read as the digits they look like.
fn normalise(typed: &str) -> String {
    typed
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            c => c,
        })
        .collect()
}

fn random_code() -> Result<String, String> {
    let mut buf = [0u8; 8];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| ALPHABET[(b & 31) as usize] as char).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn pairing() -> (Pairing, Arc<Mutex<Vec<Ended>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        (Pairing::new(Box::new(move |e| log.lock().unwrap().push(e))), seen)
    }

    fn ok() -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn a_code_works_once_however_it_is_typed() {
        let (p, seen) = pairing();
        let offer = p.start("ws://127.0.0.1:1", 0).unwrap();
        assert_eq!(offer.code.len(), 9);
        assert!(offer.uri.ends_with(&offer.code.replace('-', "")));
        let typed = offer.code.to_lowercase().replace('0', "o").replace('1', "l");
        assert_eq!(p.redeem(&typed, 1, ok), Ok(()));
        assert_eq!(
            p.redeem(&offer.code, 2, ok),
            Err(PairError::NoCode),
            "a used code is refused"
        );
        assert_eq!(*seen.lock().unwrap(), vec![Ended::Used]);
    }

    #[test]
    fn an_expired_code_is_refused() {
        let (p, _) = pairing();
        let offer = p.start("ws://x", 1_000).unwrap();
        assert_eq!(p.redeem(&offer.code, offer.expires_ms, ok), Err(PairError::Expired));
        assert_eq!(p.redeem(&offer.code, 1_001, ok), Err(PairError::NoCode));
    }

    #[test]
    fn five_wrong_tries_burn_the_code() {
        let (p, seen) = pairing();
        let offer = p.start("ws://x", 0).unwrap();
        for _ in 0..4 {
            assert_eq!(p.redeem("AAAAAAAA", 1, ok), Err(PairError::Wrong));
        }
        assert_eq!(p.redeem("AAAAAAAA", 1, ok), Err(PairError::Burned));
        assert_eq!(
            p.redeem(&offer.code, 1, ok),
            Err(PairError::NoCode),
            "the right code after the burn"
        );
        assert_eq!(*seen.lock().unwrap(), vec![Ended::Burned]);
    }

    #[test]
    fn a_second_start_kills_the_first() {
        let (p, _) = pairing();
        let first = p.start("ws://x", 0).unwrap();
        let second = p.start("ws://x", 0).unwrap();
        assert_eq!(p.redeem(&first.code, 1, ok), Err(PairError::Wrong));
        assert_eq!(p.redeem(&second.code, 1, ok), Ok(()));
    }

    #[test]
    fn a_failed_mint_leaves_the_code_live() {
        let (p, seen) = pairing();
        let offer = p.start("ws://x", 0).unwrap();
        assert_eq!(
            p.redeem(&offer.code, 1, || Err::<(), _>("disk full".into())),
            Err(PairError::Mint("disk full".into()))
        );
        assert_eq!(p.redeem(&offer.code, 2, ok), Ok(()));
        assert_eq!(*seen.lock().unwrap(), vec![Ended::Used]);
    }

    #[test]
    fn cancel_ends_a_live_code_and_says_so_once() {
        let (p, seen) = pairing();
        let offer = p.start("ws://x", 0).unwrap();
        p.cancel();
        p.cancel();
        assert_eq!(p.redeem(&offer.code, 1, ok), Err(PairError::NoCode));
        assert_eq!(*seen.lock().unwrap(), vec![Ended::Cancelled]);
    }
}
