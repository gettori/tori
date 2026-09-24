//! Questions a chat's shell asked through `tori ask`. Held here rather than in
//! the webview so a reload loses neither the card nor an answer nobody has read.
//! An approval asked for an autopilot item is a hold, and holds also go to
//! `holds.json`, so a restart loses neither.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::approvals::{Approval, Approvals, Draft, APPROVE, REJECT};
use crate::owned_state::{now_ms, write_atomically};

pub const WITHDRAWN: &str = "Withdrawn";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ask {
    pub id: String,
    pub session: String,
    pub question: String,
    pub options: Vec<String>,
    pub approval: Option<Approval>,
    // The chat panels showing the card: the asker's, plus its root background
    // session's for an approval a worker asked, since nobody watches the worker.
    pub shown_in: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
}

struct Held {
    ask: Ask,
    answer: Option<String>,
    approval_id: Option<String>,
    asked_at: u64,
    withdrawn: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hold {
    pub item: String,
    pub ask: String,
    pub session: String,
    pub shown_in: Vec<String>,
    pub question: String,
    pub options: Vec<String>,
    pub project: String,
    pub draft: Draft,
    pub asked_at: u64,
    pub answer: Option<String>,
}

fn hold_of(held: &Held) -> Option<Hold> {
    let (Some(item), Some(approval), false) = (&held.ask.item, &held.ask.approval, held.withdrawn) else { return None };
    Some(Hold {
        item: item.clone(),
        ask: held.ask.id.clone(),
        session: held.ask.session.clone(),
        shown_in: held.ask.shown_in.clone(),
        question: held.ask.question.clone(),
        options: held.ask.options.clone(),
        project: approval.project.clone(),
        draft: approval.draft.clone(),
        asked_at: held.asked_at,
        answer: held.answer.clone(),
    })
}

// A grant lived in the old process only, so an Approve nobody read is asked
// again; any other answer still stands and goes to the next wait.
fn reloaded(hold: Hold) -> (String, Held) {
    let answer = hold.answer.filter(|a| a != APPROVE);
    let approval = Approval { project: hold.project, draft: hold.draft };
    let ask = Ask {
        id: hold.ask,
        session: hold.session,
        question: hold.question,
        options: hold.options,
        approval: Some(approval),
        shown_in: hold.shown_in,
        item: Some(hold.item),
    };
    (ask.id.clone(), Held { ask, answer, approval_id: None, asked_at: hold.asked_at, withdrawn: false })
}

#[derive(Default, Serialize, Deserialize)]
struct HoldsFile {
    #[serde(default)]
    holds: Vec<Hold>,
}

struct Disk {
    path: PathBuf,
    publish: Box<dyn Fn(Value) + Send + Sync>,
    // Why the file did not parse: writing it would replace holds this build cannot see.
    unreadable: Option<String>,
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
    disk: Option<Disk>,
}

impl Asks {
    pub fn with_holds(path: PathBuf, publish: Box<dyn Fn(Value) + Send + Sync>) -> Self {
        let parsed = std::fs::read_to_string(&path).ok().map(|t| serde_json::from_str::<HoldsFile>(&t));
        let (file, unreadable) = match parsed {
            None => (HoldsFile::default(), None),
            Some(Ok(file)) => (file, None),
            Some(Err(e)) => (HoldsFile::default(), Some(e.to_string())),
        };
        let held = file.holds.into_iter().map(reloaded).collect();
        Self { held: Mutex::new(held), disk: Some(Disk { path, publish, unreadable }), ..Self::default() }
    }

    pub fn holds(&self) -> Vec<Hold> {
        let mut holds: Vec<Hold> = self.held().values().filter_map(hold_of).collect();
        holds.sort_by_key(|h| h.asked_at);
        holds
    }

    // Called with the lock held, so the file always matches memory.
    fn save(&self, held: &HashMap<String, Held>) {
        let Some(disk) = &self.disk else { return };
        if let Some(e) = &disk.unreadable {
            eprintln!("tori: {} does not parse, so holds are not saved: {e}", disk.path.display());
            return;
        }
        let mut holds: Vec<Hold> = held.values().filter_map(hold_of).collect();
        holds.sort_by_key(|h| h.asked_at);
        let written = serde_json::to_string_pretty(&HoldsFile { holds }).map_err(|e| e.to_string()).and_then(|t| write_atomically(&disk.path, &t));
        if let Err(e) = written {
            eprintln!("tori: holds not saved: {e}");
        }
    }

    // Called with the lock released: a subscriber's socket is not this lock's business.
    fn publish(&self, hold: Option<Hold>, cleared: bool) {
        if let (Some(disk), Some(hold)) = (&self.disk, hold) {
            (disk.publish)(json!({ "kind": "autopilot.changed", "hold": hold, "cleared": cleared, "ts": now_ms() }));
        }
    }

    pub fn create(
        &self,
        session: String,
        question: String,
        options: Vec<String>,
        approval: Option<Approval>,
        mirror: Option<String>,
        item: Option<String>,
    ) -> Ask {
        // Unguessable, since any caller can wait on an id and reading an answer consumes it.
        let id = format!("ask-{}", crate::chat::approval::random_token());
        let options = match approval {
            Some(_) => vec![APPROVE.to_string(), REJECT.to_string()],
            None => options,
        };
        let mirror = mirror.filter(|m| approval.is_some() && *m != session);
        let shown_in = std::iter::once(session.clone()).chain(mirror).collect();
        let ask = Ask { id: id.clone(), session, question, options, approval, shown_in, item };
        let entry = Held { ask: ask.clone(), answer: None, approval_id: None, asked_at: now_ms(), withdrawn: false };
        let hold = hold_of(&entry);
        {
            let mut held = self.held();
            held.insert(id, entry);
            if hold.is_some() {
                self.save(&held);
            }
        }
        self.publish(hold, false);
        ask
    }

    pub fn forget(&self, id: &str) {
        let hold = {
            let mut held = self.held();
            let hold = held.remove(id).as_ref().and_then(hold_of);
            if hold.is_some() {
                self.save(&held);
            }
            hold
        };
        self.publish(hold, true);
    }

    // Wakes any waiter, which then finds its ask gone. A hold outlives its chat:
    // the item it is for still needs the answer. Its grant does not, so an
    // Approve nobody read is asked again, as after a restart.
    pub fn forget_session(&self, session: &str) {
        let reopened: Vec<Hold> = {
            let mut held = self.held();
            held.retain(|_, h| h.ask.session != session || hold_of(h).is_some());
            let mut reopened = Vec::new();
            for entry in held.values_mut().filter(|h| h.ask.session == session && h.answer.as_deref() == Some(APPROVE)) {
                entry.answer = None;
                entry.approval_id = None;
                reopened.extend(hold_of(entry));
            }
            if !reopened.is_empty() {
                self.save(&held);
            }
            reopened
        };
        self.approvals.forget_session(session);
        self.answered.notify_all();
        for hold in reopened {
            self.publish(Some(hold), false);
        }
    }

    // A restarted autopilot is a new session id: what the old one asked, and the
    // worker cards mirrored to it, belong to the new one. Returns the moved asks.
    pub fn rebind_session(&self, from: &str, to: &str) -> Vec<Ask> {
        let (moved, holds) = {
            let mut held = self.held();
            let mut moved = Vec::new();
            for entry in held.values_mut() {
                let mut touched = entry.ask.session == from;
                if touched {
                    entry.ask.session = to.to_string();
                }
                for shown in entry.ask.shown_in.iter_mut().filter(|s| *s == from) {
                    *shown = to.to_string();
                    touched = true;
                }
                entry.ask.shown_in.dedup();
                if touched {
                    moved.push(entry);
                }
            }
            let holds: Vec<Hold> = moved.iter().filter_map(|h| hold_of(h)).collect();
            let moved: Vec<Ask> = moved.into_iter().map(|h| h.ask.clone()).collect();
            if !holds.is_empty() {
                self.save(&held);
            }
            (moved, holds)
        };
        for hold in holds {
            self.publish(Some(hold), false);
        }
        moved
    }

    pub fn answer(&self, id: &str, answer: String, by: By) -> Result<(), NotAnswered> {
        let hold = {
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
            let hold = hold_of(entry);
            if hold.is_some() {
                self.save(&held);
            }
            self.answered.notify_all();
            hold
        };
        self.publish(hold, false);
        Ok(())
    }

    // Never approves: a waiter reads `WITHDRAWN`, and a grant nobody has read yet is dropped.
    pub fn withdraw(&self, id: &str) -> bool {
        let hold = {
            let mut held = self.held();
            let Some(entry) = held.get_mut(id) else { return false };
            let Some(mut hold) = hold_of(entry) else { return false };
            if let Some(granted) = entry.approval_id.take() {
                self.approvals.spend(&granted);
            }
            entry.answer = Some(WITHDRAWN.to_string());
            entry.withdrawn = true;
            hold.answer = entry.answer.clone();
            self.save(&held);
            self.answered.notify_all();
            hold
        };
        self.publish(Some(hold), true);
        true
    }

    pub fn withdraw_item(&self, item: &str) -> Vec<String> {
        let ids: Vec<String> = self.held().values().filter_map(hold_of).filter(|h| h.item == item).map(|h| h.ask).collect();
        ids.into_iter().filter(|id| self.withdraw(id)).collect()
    }

    // An answer is handed out once, then forgotten.
    pub fn wait(&self, id: &str, timeout: Duration) -> Waited {
        let deadline = Instant::now() + timeout;
        let mut held = self.held();
        loop {
            match held.get(id) {
                None => return Waited::Unknown,
                Some(Held { answer: Some(_), .. }) => {
                    let Some(read) = held.remove(id) else { return Waited::Unknown };
                    let hold = hold_of(&read);
                    if hold.is_some() {
                        self.save(&held);
                    }
                    drop(held);
                    self.publish(hold, true);
                    return Waited::Answered { answer: read.answer.unwrap_or_default(), approval_id: read.approval_id };
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
        let ask = asks.create("s1".into(), "ok?".into(), vec!["yes".into(), "no".into()], None, Some("root".into()), None);
        (asks, ask)
    }

    #[test]
    fn an_answer_inside_the_window_wakes_the_waiter() {
        let (asks, ask) = asks_with_one();
        assert_eq!(ask.shown_in, ["s1"], "only an approval is mirrored");
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
        asks.create("s1".into(), "merge?".into(), vec!["sure".into()], Some(Approval { project: "/p".into(), draft }), Some("root".into()), None)
    }

    #[test]
    fn an_approval_answered_after_the_window_hands_its_id_to_the_next_wait() {
        let asks = Asks::default();
        let ask = approval_ask(&asks);
        assert_eq!(ask.options, [APPROVE, REJECT], "an approval offers only these two");
        assert_eq!(ask.shown_in, ["s1", "root"], "a worker's approval shows in its root's chat too");
        assert_eq!(asks.wait(&ask.id, Duration::from_millis(10)), Waited::Pending);
        asks.answer(&ask.id, APPROVE.into(), By::User).unwrap();
        let Waited::Answered { answer, approval_id: Some(approval_id) } = asks.wait(&ask.id, Duration::ZERO) else {
            panic!("no approval id")
        };
        assert_eq!(answer, APPROVE);
        let wanted = ask.approval.unwrap();
        assert!(asks.approvals.reserve(Some(&approval_id), "s1", &wanted).is_ok());
    }

    fn holds_at(name: &str) -> (PathBuf, Asks) {
        let path = crate::autopilot::tests::temp_dir(name).join("holds.json");
        let asks = Asks::with_holds(path.clone(), Box::new(|_| {}));
        (path, asks)
    }

    fn hold_ask(asks: &Asks, item: &str) -> Ask {
        let draft = Draft::PrMerge { number: 7, method: MergeMethod::Squash, head_sha: "abc".into() };
        let approval = Some(Approval { project: "/p".into(), draft });
        asks.create("s1".into(), "merge?".into(), vec![], approval, Some("root".into()), Some(item.into()))
    }

    fn on_disk(path: &PathBuf) -> Vec<Hold> {
        serde_json::from_str::<HoldsFile>(&std::fs::read_to_string(path).unwrap()).unwrap().holds
    }

    #[test]
    fn a_hold_is_on_disk_from_its_ask_until_its_answer_is_read() {
        let (path, asks) = holds_at("write-through");
        let ask = hold_ask(&asks, "item-1");
        let held = on_disk(&path);
        assert_eq!((held[0].item.as_str(), held[0].shown_in.clone(), held[0].answer.clone()), ("item-1", vec!["s1".to_string(), "root".to_string()], None));
        asks.answer(&ask.id, APPROVE.into(), By::User).unwrap();
        assert_eq!(on_disk(&path)[0].answer.as_deref(), Some(APPROVE));
        assert!(matches!(asks.wait(&ask.id, Duration::ZERO), Waited::Answered { approval_id: Some(_), .. }));
        assert!(on_disk(&path).is_empty(), "a read answer is no longer held");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_restart_asks_a_pending_or_unread_approve_again_and_keeps_an_unread_reject() {
        let (path, asks) = holds_at("reload");
        let pending = hold_ask(&asks, "item-1");
        let approved = hold_ask(&asks, "item-2");
        let rejected = hold_ask(&asks, "item-3");
        asks.answer(&approved.id, APPROVE.into(), By::User).unwrap();
        asks.answer(&rejected.id, REJECT.into(), By::User).unwrap();
        asks.forget_session("s1");
        assert_eq!(asks.holds().len(), 3, "the chat ending keeps its holds");
        drop(asks);

        let again = Asks::with_holds(path.clone(), Box::new(|_| {}));
        let mut open: Vec<String> = again.pending().into_iter().map(|a| a.id).collect();
        open.sort();
        let mut expected = vec![pending.id.clone(), approved.id.clone()];
        expected.sort();
        assert_eq!(open, expected, "the grant died with the process, so the Approve is asked again");
        assert!(again.pending().iter().all(|a| a.shown_in == ["s1", "root"]), "under the same chats");
        assert_eq!(again.wait(&rejected.id, Duration::ZERO), Waited::Answered { answer: REJECT.into(), approval_id: None });
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn only_the_user_answers_an_approval() {
        let asks = Asks::default();
        let ask = approval_ask(&asks);
        assert_eq!(asks.answer(&ask.id, APPROVE.into(), By::Socket), Err(NotAnswered::UsersOnly));
        assert_eq!(asks.pending(), vec![ask], "the ask stays open");
    }
}
