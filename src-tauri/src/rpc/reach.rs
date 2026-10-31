//! A chat that read untrusted text can be turned against another, so reach
//! follows a relation Tori recorded or a person granted, never a bare id.

use super::auth::{Caller, Principal};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Steer,
    Read,
}

pub trait Facts {
    fn spawner_of(&self, id: &str) -> Option<String>;
    fn autopilot(&self) -> Option<String>;
    fn is_item(&self, id: &str) -> bool;
    fn handed_to(&self, id: &str) -> Option<String>;
    fn cwd(&self, id: &str) -> Option<String>;
    fn made_by(&self, cwd: &str) -> Option<String>;
    fn topic_of(&self, cwd: &str) -> Option<String>;
    fn granted_read(&self, reader: &str, target: &str) -> bool;
}

fn made(f: &impl Facts, maker: &str, of: &str) -> bool {
    f.cwd(of).and_then(|cwd| f.made_by(&cwd)).as_deref() == Some(maker)
}

pub fn owns(f: &impl Facts, caller: &str, target: &str) -> bool {
    f.spawner_of(target).as_deref() == Some(caller)
        || made(f, caller, target)
        || (f.autopilot().as_deref() == Some(caller) && f.is_item(target))
}

pub fn related(f: &impl Facts, caller: &str, target: &str, reach: Reach) -> bool {
    if caller == target || owns(f, caller, target) || owns(f, target, caller) {
        return true;
    }
    let handed = f.handed_to(target).as_deref() == Some(caller) || f.handed_to(caller).as_deref() == Some(target);
    let topic = |id: &str| f.cwd(id).and_then(|cwd| f.topic_of(&cwd));
    let same_topic = topic(caller).is_some_and(|t| topic(target).as_deref() == Some(t.as_str()));
    handed || same_topic || (reach == Reach::Read && f.granted_read(caller, target))
}

pub fn may_read(f: &impl Facts, principal: &Principal, target: &str) -> Result<(), String> {
    match principal {
        Principal::Session(Caller::Chat(me)) if !related(f, me, target, Reach::Read) => Err(format!(
            "{target} is not related to this chat, so it cannot read it; tell the user if you need it"
        )),
        _ => Ok(()),
    }
}

pub fn fork_source(principal: &Principal, id: &str, from: Option<String>) -> Option<String> {
    match principal {
        Principal::Session(Caller::Chat(me)) if me != id => None,
        _ => from,
    }
}

/// Agent steers between two chats with no person speaking in either, past
/// which a steer waits for one: two agents answering each other loop forever.
pub const LOOP_CAP: u32 = 5;

static STEERS: OnceLock<Mutex<HashMap<(String, String), u32>>> = OnceLock::new();

fn pair(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

fn steers() -> std::sync::MutexGuard<'static, HashMap<(String, String), u32>> {
    STEERS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

pub fn over_cap(a: &str, b: &str) -> bool {
    steers().get(&pair(a, b)).copied().unwrap_or(0) >= LOOP_CAP
}

pub fn note_agent_steer(a: &str, b: &str) {
    *steers().entry(pair(a, b)).or_insert(0) += 1;
}

pub fn person_spoke(session: &str) {
    steers().retain(|(a, b), _| a != session && b != session);
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Deliver,
    Queue,
}

pub fn steer_verdict(f: &impl Facts, caller: &str, target: &str, mid_turn: bool) -> Verdict {
    let down = owns(f, caller, target);
    let joins = mid_turn && related(f, caller, target, Reach::Steer);
    if (down || joins) && !over_cap(caller, target) {
        Verdict::Deliver
    } else {
        Verdict::Queue
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use super::Facts;
    use std::collections::{HashMap, HashSet};

    #[derive(Default)]
    pub struct Fake {
        pub spawners: HashMap<&'static str, &'static str>,
        pub autopilot: Option<&'static str>,
        pub items: HashSet<&'static str>,
        pub handed: HashMap<&'static str, &'static str>,
        pub cwds: HashMap<&'static str, &'static str>,
        pub makers: HashMap<&'static str, &'static str>,
        pub topics: HashMap<&'static str, &'static str>,
        pub grants: HashSet<(&'static str, &'static str)>,
    }

    impl Facts for Fake {
        fn spawner_of(&self, id: &str) -> Option<String> {
            self.spawners.get(id).map(|s| s.to_string())
        }
        fn autopilot(&self) -> Option<String> {
            self.autopilot.map(str::to_string)
        }
        fn is_item(&self, id: &str) -> bool {
            self.items.contains(id)
        }
        fn handed_to(&self, id: &str) -> Option<String> {
            self.handed.get(id).map(|s| s.to_string())
        }
        fn cwd(&self, id: &str) -> Option<String> {
            self.cwds.get(id).map(|s| s.to_string())
        }
        fn made_by(&self, cwd: &str) -> Option<String> {
            self.makers.get(cwd).map(|s| s.to_string())
        }
        fn topic_of(&self, cwd: &str) -> Option<String> {
            self.topics.get(cwd).map(|s| s.to_string())
        }
        fn granted_read(&self, reader: &str, target: &str) -> bool {
            self.grants.iter().any(|(r, t)| *r == reader && *t == target)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::Fake;
    use super::*;

    fn both_ways(f: &Fake, a: &str, b: &str) -> bool {
        related(f, a, b, Reach::Steer) && related(f, b, a, Reach::Steer)
    }

    #[test]
    fn a_session_reaches_itself() {
        assert!(related(&Fake::default(), "a", "a", Reach::Steer));
    }

    #[test]
    fn a_spawner_and_its_worker_reach_each_other() {
        let f = Fake {
            spawners: [("w", "s")].into(),
            ..Default::default()
        };
        assert!(both_ways(&f, "s", "w"));
    }

    #[test]
    fn a_worktree_maker_and_a_chat_in_it_reach_each_other() {
        let f = Fake {
            cwds: [("child", "/p/fix-a"), ("parent", "/p/main")].into(),
            makers: [("/p/fix-a", "parent")].into(),
            ..Default::default()
        };
        assert!(both_ways(&f, "parent", "child"));
    }

    #[test]
    fn the_autopilot_and_its_items_reach_each_other() {
        let f = Fake {
            autopilot: Some("ap"),
            items: ["item"].into(),
            ..Default::default()
        };
        assert!(both_ways(&f, "ap", "item"));
    }

    #[test]
    fn a_handoff_joins_the_old_session_and_the_new() {
        let f = Fake {
            handed: [("old", "new")].into(),
            ..Default::default()
        };
        assert!(both_ways(&f, "old", "new"));
    }

    #[test]
    fn chats_in_one_topic_reach_each_other() {
        let f = Fake {
            cwds: [("a", "/t/home"), ("b", "/r/member")].into(),
            topics: [("/t/home", "t1"), ("/r/member", "t1")].into(),
            ..Default::default()
        };
        assert!(both_ways(&f, "a", "b"));
    }

    #[test]
    fn unrelated_chats_do_not() {
        let f = Fake {
            cwds: [("a", "/p/x"), ("b", "/q/y")].into(),
            topics: [("/p/x", "t1"), ("/q/y", "t2")].into(),
            ..Default::default()
        };
        assert!(!related(&f, "a", "b", Reach::Steer));
        assert!(!related(&f, "a", "b", Reach::Read));
    }

    #[test]
    fn a_read_grant_allows_reading_but_not_steering() {
        let f = Fake {
            grants: [("reader", "target")].into(),
            ..Default::default()
        };
        assert!(related(&f, "reader", "target", Reach::Read));
        assert!(!related(&f, "reader", "target", Reach::Steer));
        assert!(!related(&f, "target", "reader", Reach::Read));
    }

    #[test]
    fn a_chat_reads_only_what_it_is_related_to_and_a_person_reads_anything() {
        let f = Fake {
            grants: [("reader", "target")].into(),
            ..Default::default()
        };
        let chat = |id: &str| Principal::Session(Caller::Chat(id.into()));
        assert!(may_read(&f, &chat("reader"), "target").is_ok());
        assert!(may_read(&f, &chat("stranger"), "target").is_err());
        assert!(may_read(&f, &Principal::Device("d1".into()), "target").is_ok());
        assert!(may_read(&f, &Principal::Session(Caller::Terminal("t1".into())), "target").is_ok());
    }

    #[test]
    fn a_steer_down_an_owning_line_delivers_even_to_an_idle_chat() {
        let f = Fake {
            spawners: [("w1", "s1")].into(),
            ..Default::default()
        };
        assert_eq!(steer_verdict(&f, "s1", "w1", false), Verdict::Deliver);
    }

    #[test]
    fn a_steer_up_to_an_idle_parent_waits_and_joins_a_busy_one() {
        let f = Fake {
            cwds: [("child2", "/p/fix-b")].into(),
            makers: [("/p/fix-b", "parent2")].into(),
            ..Default::default()
        };
        assert_eq!(steer_verdict(&f, "child2", "parent2", false), Verdict::Queue);
        assert_eq!(steer_verdict(&f, "child2", "parent2", true), Verdict::Deliver);
    }

    #[test]
    fn a_steer_to_an_unrelated_chat_waits_even_mid_turn() {
        assert_eq!(steer_verdict(&Fake::default(), "x1", "y1", true), Verdict::Queue);
    }

    #[test]
    fn the_steer_past_the_cap_waits_until_a_person_speaks() {
        let f = Fake {
            spawners: [("w3", "s3")].into(),
            ..Default::default()
        };
        for _ in 0..LOOP_CAP {
            assert_eq!(steer_verdict(&f, "s3", "w3", true), Verdict::Deliver);
            note_agent_steer("s3", "w3");
        }
        assert_eq!(steer_verdict(&f, "s3", "w3", true), Verdict::Queue);
        assert_eq!(
            steer_verdict(&f, "w3", "s3", true),
            Verdict::Queue,
            "the cap is per pair, either way"
        );
        person_spoke("w3");
        assert_eq!(steer_verdict(&f, "s3", "w3", true), Verdict::Deliver);
    }
}
