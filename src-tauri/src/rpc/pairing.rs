//! The one time code a device trades for its credential. One code is live at a
//! time, it dies on first use, and it is short enough to type, so a handful of
//! wrong tries burns it rather than letting it be guessed.

use std::io::Read;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

const TTL_MS: u64 = 5 * 60 * 1000;
const ALLOW_WAIT: Duration = Duration::from_secs(60);
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Request {
    pub name: String,
    pub addr: String,
}

pub trait Asker: Send + Sync {
    fn ask(&self, request: &Request) -> Result<(), PairError>;
    fn settled(&self);
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    NoCode,
    Expired,
    Wrong,
    Burned,
    Waiting,
    NoWindow,
    Denied,
    Unanswered,
    Mint(String),
}

impl PairError {
    pub fn message(&self) -> String {
        match self {
            PairError::NoCode => "no pairing in progress".into(),
            PairError::Expired => "the code has expired".into(),
            PairError::Wrong => "wrong code".into(),
            PairError::Burned => "too many wrong codes; start pairing again".into(),
            PairError::Waiting => "a pairing is waiting".into(),
            PairError::NoWindow => "Tori is not open on the Mac to allow this device".into(),
            PairError::Denied => "the Mac did not allow this device".into(),
            PairError::Unanswered => "nobody allowed this device on the Mac in time".into(),
            PairError::Mint(e) => format!("the device could not be added: {e}"),
        }
    }
}

struct Live {
    code: String,
    expires_ms: u64,
    wrong: u8,
    waiting: bool,
}

pub struct Pairing {
    live: Mutex<Option<Live>>,
    on_change: Box<dyn Fn(Ended) + Send + Sync>,
    asker: Box<dyn Asker>,
    answer: Mutex<Option<SyncSender<bool>>>,
    wait: Duration,
}

impl Pairing {
    pub fn new(on_change: Box<dyn Fn(Ended) + Send + Sync>, asker: Box<dyn Asker>) -> Self {
        Self {
            live: Mutex::new(None),
            on_change,
            asker,
            answer: Mutex::new(None),
            wait: ALLOW_WAIT,
        }
    }

    pub fn start(&self, url: &str, now_ms: u64) -> Result<Offer, String> {
        let code = random_code()?;
        let expires_ms = now_ms + TTL_MS;
        *self.lock() = Some(Live {
            code: code.clone(),
            expires_ms,
            wrong: 0,
            waiting: false,
        });
        Ok(Offer {
            code: format!("{}-{}", &code[..4], &code[4..]),
            url: url.to_string(),
            uri: format!("tori://pair?url={url}&code={code}"),
            expires_ms,
        })
    }

    pub fn cancel(&self) {
        self.stop_waiting();
        if self.lock().take().is_some() {
            (self.on_change)(Ended::Cancelled);
        }
    }

    pub fn allow(&self, yes: bool) -> Result<(), String> {
        let answer = self.answer_slot().take().ok_or("no device is waiting to pair")?;
        answer.send(yes).map_err(|_| "the device stopped waiting".to_string())
    }

    pub fn redeem<T>(
        &self,
        code: &str,
        now_ms: u64,
        request: &Request,
        pending: impl FnOnce(),
        mint: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, PairError> {
        let code = normalise(code);
        let answer = {
            let mut live = self.lock();
            let held = live.as_mut().ok_or(PairError::NoCode)?;
            if now_ms >= held.expires_ms {
                *live = None;
                return Err(PairError::Expired);
            }
            // Before the code is checked, so tries while the Mac decides cannot
            // burn the code out from under the device it is about to allow.
            if held.waiting {
                return Err(PairError::Waiting);
            }
            if !super::auth::constant_time_eq(code.as_bytes(), held.code.as_bytes()) {
                held.wrong += 1;
                if held.wrong < MAX_WRONG {
                    return Err(PairError::Wrong);
                }
                *live = None;
                drop(live);
                (self.on_change)(Ended::Burned);
                return Err(PairError::Burned);
            }
            held.waiting = true;
            let (tx, rx) = sync_channel(1);
            *self.answer_slot() = Some(tx);
            rx
        };
        pending();
        let allowed = self
            .asker
            .ask(request)
            .and_then(|()| match answer.recv_timeout(self.wait) {
                Ok(true) => Ok(()),
                Ok(false) => Err(PairError::Denied),
                Err(_) => Err(PairError::Unanswered),
            });
        self.stop_waiting();
        self.asker.settled();
        let mut live = self.lock();
        let held = live
            .as_mut()
            .filter(|held| held.code == code)
            .ok_or(PairError::NoCode)?;
        held.waiting = false;
        allowed?;
        // Consumed only now: a refusal or a failed save leaves the code usable.
        let minted = mint().map_err(PairError::Mint)?;
        *live = None;
        drop(live);
        (self.on_change)(Ended::Used);
        Ok(minted)
    }

    // Dropping the sender wakes a redeem still waiting on the Mac.
    fn stop_waiting(&self) {
        self.answer_slot().take();
    }

    fn answer_slot(&self) -> std::sync::MutexGuard<'_, Option<SyncSender<bool>>> {
        self.answer.lock().unwrap_or_else(|e| e.into_inner())
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
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| ALPHABET[(b & 31) as usize] as char).collect())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    use std::sync::Arc;

    pub(crate) struct Window(pub Mutex<SyncSender<Request>>);

    impl Asker for Window {
        fn ask(&self, request: &Request) -> Result<(), PairError> {
            let _ = self.0.lock().unwrap().send(request.clone());
            Ok(())
        }
        fn settled(&self) {}
    }

    pub(crate) struct NoWindow;

    impl Asker for NoWindow {
        fn ask(&self, _: &Request) -> Result<(), PairError> {
            Err(PairError::NoWindow)
        }
        fn settled(&self) {}
    }

    pub(crate) fn with_window(on_change: Box<dyn Fn(Ended) + Send + Sync>) -> (Pairing, Receiver<Request>) {
        let (tx, rx) = sync_channel(8);
        (Pairing::new(on_change, Box::new(Window(Mutex::new(tx)))), rx)
    }

    pub(crate) fn answer_next(
        pairing: Arc<Pairing>,
        asked: Receiver<Request>,
        yes: bool,
    ) -> std::thread::JoinHandle<Receiver<Request>> {
        std::thread::spawn(move || {
            asked.recv().unwrap();
            pairing.allow(yes).unwrap();
            asked
        })
    }

    fn pairing() -> (Arc<Pairing>, Receiver<Request>, Arc<Mutex<Vec<Ended>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let (p, asked) = with_window(Box::new(move |e| log.lock().unwrap().push(e)));
        (Arc::new(p), asked, seen)
    }

    fn phone() -> Request {
        Request {
            name: "Pixel".into(),
            addr: "100.64.0.2".into(),
        }
    }

    fn ok() -> Result<(), String> {
        Ok(())
    }

    fn allowed(
        p: &Arc<Pairing>,
        asked: Receiver<Request>,
        yes: bool,
        code: &str,
    ) -> (Result<(), PairError>, Receiver<Request>) {
        let answering = answer_next(p.clone(), asked, yes);
        let result = p.redeem(code, 1, &phone(), || {}, ok);
        (result, answering.join().unwrap())
    }

    #[test]
    fn a_code_works_once_however_it_is_typed_and_the_mac_allows_it() {
        let (p, asked, seen) = pairing();
        let offer = p.start("ws://127.0.0.1:1", 0).unwrap();
        assert_eq!(offer.code.len(), 9);
        assert!(offer.uri.ends_with(&offer.code.replace('-', "")));
        let typed = offer.code.to_lowercase().replace('0', "o").replace('1', "l");
        let (result, _) = allowed(&p, asked, true, &typed);
        assert_eq!(result, Ok(()));
        assert_eq!(
            p.redeem(&offer.code, 2, &phone(), || {}, ok),
            Err(PairError::NoCode),
            "a used code is refused"
        );
        assert_eq!(*seen.lock().unwrap(), vec![Ended::Used]);
    }

    #[test]
    fn a_denied_device_gets_nothing_and_the_code_stays_live() {
        let (p, asked, seen) = pairing();
        let offer = p.start("ws://x", 0).unwrap();
        let (result, asked) = allowed(&p, asked, false, &offer.code);
        assert_eq!(result, Err(PairError::Denied));
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(allowed(&p, asked, true, &offer.code).0, Ok(()));
    }

    #[test]
    fn an_unanswered_request_times_out_and_the_code_stays_live() {
        let (tx, _asked) = sync_channel(8);
        let mut p = Pairing::new(Box::new(|_| {}), Box::new(Window(Mutex::new(tx))));
        p.wait = Duration::from_millis(50);
        let offer = p.start("ws://x", 0).unwrap();
        assert_eq!(
            p.redeem(&offer.code, 1, &phone(), || {}, ok),
            Err(PairError::Unanswered)
        );
        assert_eq!(
            p.redeem(&offer.code, 1, &phone(), || {}, ok),
            Err(PairError::Unanswered)
        );
    }

    #[test]
    fn with_no_window_open_nobody_can_allow_and_the_code_stays_live() {
        let p = Pairing::new(Box::new(|_| {}), Box::new(NoWindow));
        let offer = p.start("ws://x", 0).unwrap();
        let mut minted = false;
        let result = p.redeem(
            &offer.code,
            1,
            &phone(),
            || {},
            || {
                minted = true;
                ok()
            },
        );
        assert_eq!(result, Err(PairError::NoWindow));
        assert!(!minted);
        assert_eq!(p.redeem(&offer.code, 1, &phone(), || {}, ok), Err(PairError::NoWindow));
    }

    #[test]
    fn a_second_pair_while_one_waits_is_told_so() {
        let (p, asked, _) = pairing();
        let offer = p.start("ws://x", 0).unwrap();
        let first = {
            let (p, code) = (p.clone(), offer.code.clone());
            std::thread::spawn(move || p.redeem(&code, 1, &phone(), || {}, ok))
        };
        assert_eq!(asked.recv().unwrap(), phone(), "the Mac sees who is asking");
        assert_eq!(p.redeem(&offer.code, 1, &phone(), || {}, ok), Err(PairError::Waiting));
        p.allow(true).unwrap();
        assert_eq!(first.join().unwrap(), Ok(()));
    }

    #[test]
    fn an_expired_code_is_refused() {
        let (p, _, _) = pairing();
        let offer = p.start("ws://x", 1_000).unwrap();
        assert_eq!(
            p.redeem(&offer.code, offer.expires_ms, &phone(), || {}, ok),
            Err(PairError::Expired)
        );
        assert_eq!(
            p.redeem(&offer.code, 1_001, &phone(), || {}, ok),
            Err(PairError::NoCode)
        );
    }

    #[test]
    fn five_wrong_tries_burn_the_code() {
        let (p, _, seen) = pairing();
        let offer = p.start("ws://x", 0).unwrap();
        for _ in 0..4 {
            assert_eq!(p.redeem("AAAAAAAA", 1, &phone(), || {}, ok), Err(PairError::Wrong));
        }
        assert_eq!(p.redeem("AAAAAAAA", 1, &phone(), || {}, ok), Err(PairError::Burned));
        assert_eq!(
            p.redeem(&offer.code, 1, &phone(), || {}, ok),
            Err(PairError::NoCode),
            "the right code after the burn"
        );
        assert_eq!(*seen.lock().unwrap(), vec![Ended::Burned]);
    }

    #[test]
    fn a_second_start_kills_the_first() {
        let (p, asked, _) = pairing();
        let first = p.start("ws://x", 0).unwrap();
        let second = p.start("ws://x", 0).unwrap();
        assert_eq!(p.redeem(&first.code, 1, &phone(), || {}, ok), Err(PairError::Wrong));
        assert_eq!(allowed(&p, asked, true, &second.code).0, Ok(()));
    }

    #[test]
    fn a_failed_mint_leaves_the_code_live() {
        let (p, asked, seen) = pairing();
        let offer = p.start("ws://x", 0).unwrap();
        let answering = answer_next(p.clone(), asked, true);
        assert_eq!(
            p.redeem(&offer.code, 1, &phone(), || {}, || Err::<(), _>("disk full".into())),
            Err(PairError::Mint("disk full".into()))
        );
        assert_eq!(allowed(&p, answering.join().unwrap(), true, &offer.code).0, Ok(()));
        assert_eq!(*seen.lock().unwrap(), vec![Ended::Used]);
    }

    #[test]
    fn cancel_ends_a_live_code_and_says_so_once() {
        let (p, _, seen) = pairing();
        let offer = p.start("ws://x", 0).unwrap();
        p.cancel();
        p.cancel();
        assert_eq!(p.redeem(&offer.code, 1, &phone(), || {}, ok), Err(PairError::NoCode));
        assert_eq!(*seen.lock().unwrap(), vec![Ended::Cancelled]);
    }
}
