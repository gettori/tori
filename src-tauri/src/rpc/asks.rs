//! Questions a chat's shell asked through `tori ask`. Held here rather than in
//! the webview so a reload loses neither the card nor an answer nobody has read.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::approvals::{Approval, Approvals, APPROVE, REJECT};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ask {
    pub id: String,
    pub session: String,
    pub question: String,
    pub options: Vec<String>,
    pub approval: Option<Approval>,
}

struct Held {
    ask: Ask,
    answer: Option<String>,
    approval_id: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum Waited {
    Answered { answer: String, approval_id: Option<String> },
    Pending,
    Unknown,
}

#[derive(Debug, PartialEq)]
pub enum By {
    User,
    Socket,
}

#[derive(Debug, PartialEq)]
pub enum NotAnswered {
    Unknown,
    // An approval ask answered over the socket, where no person is behind the answer.
    UsersOnly,
}

#[derive(Default)]
pub struct Asks {
    held: Mutex<HashMap<String, Held>>,
    answered: Condvar,
    pub approvals: Approvals,
}

impl Asks {
    pub fn create(&self, session: String, question: String, options: Vec<String>, approval: Option<Approval>) -> Ask {
        // Unguessable, since any caller can wait on an id and reading an answer consumes it.
        let id = format!("ask-{}", crate::chat::approval::random_token());
        let options = match approval {
            Some(_) => vec![APPROVE.to_string(), REJECT.to_string()],
            None => options,
        };
        let ask = Ask { id: id.clone(), session, question, options, approval };
        self.held().insert(id, Held { ask: ask.clone(), answer: None, approval_id: None });
        ask
    }

    pub fn forget(&self, id: &str) {
        self.held().remove(id);
    }

    // Wakes any waiter, which then finds its ask gone.
    pub fn forget_session(&self, session: &str) {
        self.held().retain(|_, h| h.ask.session != session);
        self.approvals.forget_session(session);
        self.answered.notify_all();
    }

    pub fn answer(&self, id: &str, answer: String, by: By) -> Result<(), NotAnswered> {
        let mut held = self.held();
        let entry = held.get_mut(id).filter(|h| h.answer.is_none()).ok_or(NotAnswered::Unknown)?;
        if let Some(approval) = &entry.ask.approval {
            if by == By::Socket {
                return Err(NotAnswered::UsersOnly);
            }
            if answer == APPROVE {
                entry.approval_id = Some(self.approvals.grant(&entry.ask.session, approval.clone()));
            }
        }
        entry.answer = Some(answer);
        self.answered.notify_all();
        Ok(())
    }

    // An answer is handed out once, then forgotten.
    pub fn wait(&self, id: &str, timeout: Duration) -> Waited {
        let deadline = Instant::now() + timeout;
        let mut held = self.held();
        loop {
            match held.get(id) {
                None => return Waited::Unknown,
                Some(Held { answer: Some(_), .. }) => {
                    let Some(Held { answer, approval_id, .. }) = held.remove(id) else { return Waited::Unknown };
                    return Waited::Answered { answer: answer.unwrap_or_default(), approval_id };
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

    pub fn pending_for(&self, session: &str) -> Option<Ask> {
        self.held().values().find(|h| h.answer.is_none() && h.ask.session == session).map(|h| h.ask.clone())
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
    use crate::forge::MergeMethod;
    use crate::rpc::approvals::Draft;
    use std::sync::Arc;

    fn asks_with_one() -> (Arc<Asks>, Ask) {
        let asks = Arc::new(Asks::default());
        let ask = asks.create("s1".into(), "ok?".into(), vec!["yes".into(), "no".into()], None);
        (asks, ask)
    }

    #[test]
    fn an_answer_inside_the_window_wakes_the_waiter() {
        let (asks, ask) = asks_with_one();
        let answering = asks.clone();
        let id = ask.id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            assert!(answering.answer(&id, "yes".into(), By::Socket).is_ok());
        });
        assert_eq!(asks.wait(&ask.id, Duration::from_secs(5)), Waited::Answered { answer: "yes".into(), approval_id: None });
        assert_eq!(asks.wait(&ask.id, Duration::ZERO), Waited::Unknown, "read once, then gone");
    }

    #[test]
    fn an_answer_after_the_window_is_held_for_the_next_wait() {
        let (asks, ask) = asks_with_one();
        assert_eq!(asks.wait(&ask.id, Duration::from_millis(10)), Waited::Pending);
        assert_eq!(asks.pending(), vec![ask.clone()]);
        assert!(asks.answer(&ask.id, "no".into(), By::Socket).is_ok());
        assert_eq!(asks.answer(&ask.id, "yes".into(), By::Socket), Err(NotAnswered::Unknown), "the first answer stands");
        assert!(asks.pending().is_empty());
        assert_eq!(asks.wait(&ask.id, Duration::ZERO), Waited::Answered { answer: "no".into(), approval_id: None });
    }

    fn approval_ask(asks: &Asks) -> Ask {
        let draft = Draft::PrMerge { number: 7, method: MergeMethod::Squash, head_sha: "abc".into() };
        asks.create("s1".into(), "merge?".into(), vec!["sure".into()], Some(Approval { project: "/p".into(), draft }))
    }

    #[test]
    fn an_approval_answered_after_the_window_hands_its_id_to_the_next_wait() {
        let asks = Asks::default();
        let ask = approval_ask(&asks);
        assert_eq!(ask.options, [APPROVE, REJECT], "an approval offers only these two");
        assert_eq!(asks.wait(&ask.id, Duration::from_millis(10)), Waited::Pending);
        asks.answer(&ask.id, APPROVE.into(), By::User).unwrap();
        let Waited::Answered { answer, approval_id: Some(approval_id) } = asks.wait(&ask.id, Duration::ZERO) else {
            panic!("no approval id")
        };
        assert_eq!(answer, APPROVE);
        let wanted = ask.approval.unwrap();
        assert!(asks.approvals.reserve(Some(&approval_id), "s1", &wanted).is_ok());
    }

    #[test]
    fn only_the_user_answers_an_approval() {
        let asks = Asks::default();
        let ask = approval_ask(&asks);
        assert_eq!(asks.answer(&ask.id, APPROVE.into(), By::Socket), Err(NotAnswered::UsersOnly));
        assert_eq!(asks.pending(), vec![ask], "the ask stays open");
    }
}
