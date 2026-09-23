//! Questions a chat's shell asked through `tori ask`. Held here rather than in
//! the webview so a reload loses neither the card nor an answer nobody has read.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ask {
    pub id: String,
    pub session: String,
    pub question: String,
    pub options: Vec<String>,
}

struct Held {
    ask: Ask,
    answer: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum Waited {
    Answered(String),
    Pending,
    Unknown,
}

#[derive(Default)]
pub struct Asks {
    held: Mutex<HashMap<String, Held>>,
    answered: Condvar,
}

impl Asks {
    pub fn create(&self, session: String, question: String, options: Vec<String>) -> Ask {
        // Unguessable, since any caller can wait on an id and reading an answer consumes it.
        let id = format!("ask-{}", crate::chat::approval::random_token());
        let ask = Ask { id: id.clone(), session, question, options };
        self.held().insert(id, Held { ask: ask.clone(), answer: None });
        ask
    }

    pub fn forget(&self, id: &str) {
        self.held().remove(id);
    }

    // Wakes any waiter, which then finds its ask gone.
    pub fn forget_session(&self, session: &str) {
        self.held().retain(|_, h| h.ask.session != session);
        self.answered.notify_all();
    }

    pub fn answer(&self, id: &str, answer: String) -> bool {
        let mut held = self.held();
        let Some(entry) = held.get_mut(id).filter(|h| h.answer.is_none()) else { return false };
        entry.answer = Some(answer);
        self.answered.notify_all();
        true
    }

    // An answer is handed out once, then forgotten.
    pub fn wait(&self, id: &str, timeout: Duration) -> Waited {
        let deadline = Instant::now() + timeout;
        let mut held = self.held();
        loop {
            match held.get(id) {
                None => return Waited::Unknown,
                Some(Held { answer: Some(_), .. }) => {
                    let answer = held.remove(id).and_then(|h| h.answer).unwrap_or_default();
                    return Waited::Answered(answer);
                }
                Some(_) => {}
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Waited::Pending;
            }
            held = self.answered.wait_timeout(held, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    pub fn pending(&self) -> Vec<Ask> {
        self.held().values().filter(|h| h.answer.is_none()).map(|h| h.ask.clone()).collect()
    }

    fn held(&self) -> MutexGuard<'_, HashMap<String, Held>> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn asks_with_one() -> (Arc<Asks>, Ask) {
        let asks = Arc::new(Asks::default());
        let ask = asks.create("s1".into(), "ok?".into(), vec!["yes".into(), "no".into()]);
        (asks, ask)
    }

    #[test]
    fn an_answer_inside_the_window_wakes_the_waiter() {
        let (asks, ask) = asks_with_one();
        let answering = asks.clone();
        let id = ask.id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            assert!(answering.answer(&id, "yes".into()));
        });
        assert_eq!(asks.wait(&ask.id, Duration::from_secs(5)), Waited::Answered("yes".into()));
        assert_eq!(asks.wait(&ask.id, Duration::ZERO), Waited::Unknown, "read once, then gone");
    }

    #[test]
    fn an_answer_after_the_window_is_held_for_the_next_wait() {
        let (asks, ask) = asks_with_one();
        assert_eq!(asks.wait(&ask.id, Duration::from_millis(10)), Waited::Pending);
        assert_eq!(asks.pending(), vec![ask.clone()]);
        assert!(asks.answer(&ask.id, "no".into()));
        assert!(!asks.answer(&ask.id, "yes".into()), "the first answer stands");
        assert!(asks.pending().is_empty());
        assert_eq!(asks.wait(&ask.id, Duration::ZERO), Waited::Answered("no".into()));
    }
}
