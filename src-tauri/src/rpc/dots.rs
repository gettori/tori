//! Every session's dot, composed here from facts: what the webview alone knows
//! (which tab hosts which session, each chat's status, forge attention) plus
//! what Rust measures (PTY activity, the transcript tail, the liveness probe).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::states::{Reported, SessionState, Source};
use crate::config::{BranchUnit, ProjectKind};
use crate::presence::Live;
use crate::unit_home::Home;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Dot {
    Solid,
    Hollow,
    Working,
    NeedsYou,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Certainty {
    Exact,
    Inferred,
}

/// The webview's status vocabulary, which a chat reports its own state in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Executing,
    WaitingOnBackground,
    WaitingForApproval,
    WaitingForAnswer,
    BudgetStopped,
    Idle,
    Running,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Active,
    Quiet,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Inputs {
    pub chat_status: Option<Status>,
    pub has_live_tab: bool,
    pub running: bool,
    pub pty: Option<Activity>,
    pub tail_blocked: bool,
    pub forge_attention: bool,
}

fn dot_from_status(status: Status) -> Dot {
    match status {
        Status::Executing | Status::WaitingOnBackground => Dot::Working,
        Status::WaitingForApproval | Status::WaitingForAnswer | Status::BudgetStopped => Dot::NeedsYou,
        Status::Idle => Dot::Solid,
        Status::Running => Dot::Hollow,
        Status::None => Dot::None,
    }
}

fn tier_dot(input: &Inputs) -> Dot {
    if let Some(status) = input.chat_status {
        return dot_from_status(status);
    }
    if !input.has_live_tab {
        return if input.running { Dot::Hollow } else { Dot::None };
    }
    if !input.running {
        return Dot::None;
    }
    match input.pty {
        Some(Activity::Active) => Dot::Working,
        Some(Activity::Quiet) if input.tail_blocked => Dot::NeedsYou,
        _ => Dot::Solid,
    }
}

/// What the session is doing (the socket's `state`, which a red check never
/// moves, since the autopilot already hears of that as `session.pr`) and the
/// dot the sidebar draws, which a red check raises when nothing is moving.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Composed {
    pub state: Option<SessionState>,
    pub dot: Dot,
    pub certainty: Certainty,
    /// The dot is `NeedsYou` because of the pull request, not the agent, so the
    /// webview can draw it as the PR rather than as a question.
    pub raised: bool,
}

pub fn compose(input: &Inputs) -> Composed {
    let tier = tier_dot(input);
    let state = match tier {
        Dot::Working | Dot::Hollow => Some(SessionState::Working),
        Dot::NeedsYou => Some(SessionState::NeedsYou),
        Dot::Solid => Some(SessionState::Idle),
        Dot::None => None,
    };
    let raised = input.forge_attention && matches!(tier, Dot::Solid | Dot::Hollow);
    let dot = if raised { Dot::NeedsYou } else { tier };
    let certainty = if input.chat_status.is_some() {
        Certainty::Exact
    } else {
        Certainty::Inferred
    };
    Composed {
        state,
        dot,
        certainty,
        raised,
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabFact {
    pub id: String,
    pub session: String,
    pub live: bool,
    pub workspace: String,
    #[serde(default)]
    pub agent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFact {
    pub session: String,
    pub status: Status,
    pub folder: String,
    #[serde(default)]
    pub visible: bool,
    #[serde(default)]
    pub spawner: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub done_at: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeUnit {
    pub folder_path: String,
    pub kind: ProjectKind,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub is_current: bool,
    pub attention: bool,
}

impl ForgeUnit {
    fn unit(&self) -> BranchUnit {
        BranchUnit {
            label: String::new(),
            folder_path: self.folder_path.clone(),
            branch: self.branch.clone(),
            kind: self.kind,
            is_current: self.is_current,
            issue: None,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
pub struct Facts {
    #[serde(default)]
    pub tabs: Vec<TabFact>,
    #[serde(default)]
    pub chats: Vec<ChatFact>,
    #[serde(default)]
    pub forge: Vec<ForgeUnit>,
}

/// Where a session's transcript is and which branch it recorded, from the index.
#[derive(Debug, Clone, Default)]
pub struct Meta {
    pub agent: String,
    pub path: String,
    pub branch: String,
    pub cwd: String,
    pub name: String,
}

#[derive(Debug, Clone)]
struct Probe {
    agent: String,
    running: bool,
}

#[derive(Default)]
struct Inner {
    facts: Facts,
    activity: HashMap<String, Activity>,
    probes: HashMap<String, Probe>,
    probed_at: Option<Instant>,
    dots: BTreeMap<String, Change>,
}

/// One session's dot and the unit row it sits under, as it last changed, for
/// the topic and the webview mirror.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Change {
    pub id: String,
    pub dot: Dot,
    pub certainty: Certainty,
    pub raised: bool,
    pub home: Option<Home>,
    #[serde(skip)]
    pub folder: String,
}

#[derive(Default)]
pub struct Dots(Mutex<Inner>);

impl Dots {
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    // A reload restores tabs per workspace on first visit and remounts a chat
    // only when its tab is shown, so what a push leaves out is kept while its
    // tab or chat is still alive rather than read as gone.
    pub fn replace(&self, next: Facts, tab_alive: impl Fn(&str) -> bool, chat_alive: impl Fn(&str) -> bool) {
        let mut inner = self.inner();
        let mut facts = next;
        let tabs: HashSet<String> = facts.tabs.iter().map(|t| t.id.clone()).collect();
        let chats: HashSet<String> = facts.chats.iter().map(|c| c.session.clone()).collect();
        let held_tabs: Vec<TabFact> = inner
            .facts
            .tabs
            .iter()
            .filter(|t| !tabs.contains(&t.id) && tab_alive(&t.id))
            .cloned()
            .collect();
        let held_chats: Vec<ChatFact> = inner
            .facts
            .chats
            .iter()
            .filter(|c| !chats.contains(&c.session) && chat_alive(&c.session))
            .cloned()
            .collect();
        facts.tabs.extend(held_tabs);
        facts.chats.extend(held_chats);
        inner.activity.retain(|tab, _| tab_alive(tab));
        inner.facts = facts;
    }

    pub fn note_activity(&self, tab: &str, activity: Activity) -> bool {
        self.inner().activity.insert(tab.to_string(), activity) != Some(activity)
    }

    pub fn note_running(&self, asked: &[(String, String)], running: &HashSet<String>) {
        let mut inner = self.inner();
        for (id, agent) in asked {
            inner.probes.insert(
                id.clone(),
                Probe {
                    agent: agent.clone(),
                    running: running.contains(id),
                },
            );
        }
        // A stopped session with no tab is `none` either way, so it is not kept.
        let Inner { facts, probes, .. } = &mut *inner;
        probes.retain(|id, p| p.running || facts.tabs.iter().any(|t| &t.session == id));
        inner.probed_at = Some(Instant::now());
    }

    pub fn probed_at(&self) -> Option<Instant> {
        self.inner().probed_at
    }

    /// What a liveness probe should ask about: every bound tab's session, and
    /// every session last seen running, the one that can drop to `none`.
    pub fn to_probe(&self) -> Vec<(String, String)> {
        let inner = self.inner();
        let mut want: BTreeMap<String, String> = BTreeMap::new();
        for t in &inner.facts.tabs {
            let agent = t
                .agent
                .clone()
                .or_else(|| inner.probes.get(&t.session).map(|p| p.agent.clone()));
            want.entry(t.session.clone())
                .or_insert_with(|| agent.unwrap_or_else(|| "claude".into()));
        }
        for (id, p) in inner.probes.iter().filter(|(_, p)| p.running) {
            want.entry(id.clone()).or_insert_with(|| p.agent.clone());
        }
        want.into_iter().collect()
    }

    pub fn wants_meta(&self) -> Vec<String> {
        let inner = self.inner();
        let mut ids: Vec<String> = inner.facts.tabs.iter().map(|t| t.session.clone()).collect();
        ids.extend(inner.facts.chats.iter().map(|c| c.session.clone()));
        ids.extend(inner.probes.iter().filter(|(_, p)| p.running).map(|(id, _)| id.clone()));
        ids.sort();
        ids.dedup();
        ids
    }

    pub fn dot(&self, id: &str) -> (Dot, Certainty) {
        self.inner()
            .dots
            .get(id)
            .map_or((Dot::None, Certainty::Inferred), |c| (c.dot, c.certainty))
    }

    /// Every session a tab or a chat hosts, agent tabs first. A tab's name and
    /// every project are the caller's to fill in.
    pub fn live(&self) -> Vec<Live> {
        let inner = self.inner();
        let dot = |id: &str| inner.dots.get(id).map_or(Dot::None, |c| c.dot);
        let hosted = |id: &str, folder: &str| Live {
            id: id.to_string(),
            dot: dot(id),
            name: String::new(),
            project: String::new(),
            folder: folder.to_string(),
            chat: false,
            visible: false,
            spawner: None,
            done_at: 0,
        };
        let tabs = inner.facts.tabs.iter().map(|t| hosted(&t.session, &t.workspace));
        let chats = inner.facts.chats.iter().map(|c| Live {
            name: c.name.clone(),
            chat: true,
            visible: c.visible,
            spawner: c.spawner.clone(),
            done_at: c.done_at,
            ..hosted(&c.session, &c.folder)
        });
        tabs.chain(chats).collect()
    }

    pub fn all(&self) -> Vec<Change> {
        self.inner().dots.values().cloned().collect()
    }

    /// Compose every known session. Returns what `SessionStates` should hold,
    /// which leaves the forge out, and the dots that changed since last time.
    pub fn compose_all(
        &self,
        meta: &HashMap<String, Meta>,
        home_of: impl Fn(&str, Option<&str>) -> Option<Home>,
        tail_blocked: impl Fn(&str, &Meta) -> bool,
    ) -> (Vec<Reported>, Vec<Change>) {
        let mut inner = self.inner();
        let facts = &inner.facts;
        let mut ids: Vec<&str> = facts.tabs.iter().map(|t| t.session.as_str()).collect();
        ids.extend(facts.chats.iter().map(|c| c.session.as_str()));
        ids.extend(inner.probes.keys().map(String::as_str));
        ids.sort();
        ids.dedup();

        let mut reports = Vec::new();
        let mut dots = BTreeMap::new();
        for id in ids {
            let tab = facts.tabs.iter().find(|t| t.session == id && t.live);
            let chat = facts.chats.iter().find(|c| c.session == id);
            let running = inner.probes.get(id).is_some_and(|p| p.running);
            let pty = tab.and_then(|t| inner.activity.get(&t.id).copied());
            let session = meta.get(id);
            let blocked = tab.is_some()
                && running
                && pty == Some(Activity::Quiet)
                && session.is_some_and(|m| tail_blocked(id, m));
            let branch = session.map(|m| m.branch.as_str()).filter(|b| !b.is_empty());
            let hosted = tab
                .map(|t| t.workspace.clone())
                .or_else(|| chat.map(|c| c.folder.clone()));
            let home = hosted
                .as_deref()
                .or(session.map(|m| m.cwd.as_str()))
                .and_then(|at| home_of(at, branch));
            let folder = hosted
                .or_else(|| home.as_ref().map(|h| h.folder.clone()))
                .unwrap_or_default();
            let input = Inputs {
                chat_status: chat.map(|c| c.status),
                has_live_tab: tab.is_some(),
                running,
                pty,
                tail_blocked: blocked,
                forge_attention: forge_attention(&facts.forge, &folder, branch),
            };
            let composed = compose(&input);
            let change = Change {
                id: id.to_string(),
                dot: composed.dot,
                certainty: composed.certainty,
                raised: composed.raised,
                home,
                folder,
            };
            dots.insert(id.to_string(), change);
            let Some(state) = composed.state else { continue };
            if let Some(chat) = chat {
                reports.push(Reported {
                    id: id.into(),
                    state,
                    source: Source::Chat,
                    folder: Some(chat.folder.clone()),
                    tab: None,
                });
                continue;
            }
            // A socket state for a PTY session only while its agent tab is there.
            if let Some(t) = facts.tabs.iter().find(|t| t.session == id) {
                reports.push(Reported {
                    id: id.into(),
                    state,
                    source: Source::Pty,
                    folder: Some(t.workspace.clone()),
                    tab: Some(t.id.clone()),
                });
            }
        }

        let mut changes: Vec<Change> = dots
            .iter()
            .filter(|(id, c)| inner.dots.get(*id) != Some(*c))
            .map(|(_, c)| c.clone())
            .collect();
        for (id, _) in inner
            .dots
            .iter()
            .filter(|(id, c)| !dots.contains_key(*id) && c.dot != Dot::None)
        {
            changes.push(Change {
                id: id.clone(),
                dot: Dot::None,
                certainty: Certainty::Inferred,
                raised: false,
                home: None,
                folder: String::new(),
            });
        }
        inner.dots = dots;
        (reports, changes)
    }
}

/// Whether the branch-unit this session belongs to wants looking at. Siblings
/// are the units sharing its folder, which only a plain repo has more than one of.
fn forge_attention(forge: &[ForgeUnit], folder: &str, branch: Option<&str>) -> bool {
    if folder.is_empty() {
        return false;
    }
    let here: Vec<&ForgeUnit> = forge.iter().filter(|u| u.folder_path == folder).collect();
    let units: Vec<BranchUnit> = here.iter().map(|u| u.unit()).collect();
    let siblings: Vec<&BranchUnit> = units.iter().collect();
    here.iter()
        .zip(&units)
        .any(|(f, u)| f.attention && crate::unit_home::belongs_to_unit(branch, u, &siblings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn inputs(v: &Value) -> Inputs {
        let pty = match v["ptyActivity"].as_str() {
            Some("active") => Some(Activity::Active),
            Some("quiet") => Some(Activity::Quiet),
            _ => None,
        };
        Inputs {
            chat_status: serde_json::from_value(v["chatStatus"].clone()).ok(),
            has_live_tab: v["hasLiveTab"].as_bool().unwrap_or(false),
            running: v["running"].as_bool().unwrap_or(false),
            pty,
            tail_blocked: v["tailState"] == "blocked-candidate",
            forge_attention: v["forgeAttention"].as_bool().unwrap_or(false),
        }
    }

    fn dot(v: &Value) -> Dot {
        serde_json::from_value(v.clone()).unwrap()
    }

    #[test]
    fn reproduces_the_status_golden() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/sessionDot.golden.json")).unwrap();
        assert!(!cases.is_empty());
        for case in &cases {
            assert_eq!(compose(&inputs(&case["inputs"])).dot, dot(&case["dot"]), "{case}");
        }
    }

    #[test]
    fn reproduces_the_ci_golden() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/sessionDotCi.golden.json")).unwrap();
        assert!(!cases.is_empty());
        for case in &cases {
            let mut input = inputs(&case["inputs"]);
            assert_eq!(compose(&input).dot, dot(&case["with"]), "{case}");
            input.forge_attention = false;
            assert_eq!(compose(&input).dot, dot(&case["without"]), "{case}");
        }
    }

    #[test]
    fn a_red_check_raises_the_dot_but_not_the_state() {
        let idle = Inputs {
            has_live_tab: true,
            running: true,
            forge_attention: true,
            ..Default::default()
        };
        let c = compose(&idle);
        assert_eq!(c.dot, Dot::NeedsYou);
        assert_eq!(c.state, Some(SessionState::Idle));
    }

    fn tab(id: &str, session: &str) -> TabFact {
        TabFact {
            id: id.into(),
            session: session.into(),
            live: true,
            workspace: "/p/repo".into(),
            agent: Some("claude".into()),
        }
    }

    fn chat(session: &str, status: Status) -> ChatFact {
        ChatFact {
            session: session.into(),
            status,
            folder: "/p/repo".into(),
            visible: false,
            spawner: None,
            name: String::new(),
            done_at: 0,
        }
    }

    #[test]
    fn a_push_that_leaves_out_a_live_tab_or_chat_keeps_it() {
        let dots = Dots::default();
        dots.replace(
            Facts {
                tabs: vec![tab("t1", "s1")],
                chats: vec![chat("c1", Status::Executing)],
                forge: vec![],
            },
            |_| false,
            |_| false,
        );
        dots.replace(Facts::default(), |tab| tab == "t1", |chat| chat == "c1");
        let kept = dots.inner().facts.clone();
        assert_eq!(kept.tabs, vec![tab("t1", "s1")]);
        assert_eq!(kept.chats, vec![chat("c1", Status::Executing)]);
        dots.replace(Facts::default(), |_| false, |_| false);
        assert_eq!(dots.inner().facts, Facts::default());
    }

    #[test]
    fn a_detached_session_that_stops_running_drops_to_none() {
        let dots = Dots::default();
        dots.note_running(&[("d".into(), "claude".into())], &HashSet::from(["d".to_string()]));
        dots.compose_all(&HashMap::new(), |_, _| None, |_, _| false);
        assert_eq!(dots.dot("d").0, Dot::Hollow);
        assert_eq!(dots.to_probe(), [("d".to_string(), "claude".to_string())]);
        dots.note_running(&[("d".into(), "claude".into())], &HashSet::new());
        let (_, changes) = dots.compose_all(&HashMap::new(), |_, _| None, |_, _| false);
        assert_eq!(changes.iter().map(|c| c.dot).collect::<Vec<_>>(), [Dot::None]);
    }

    #[test]
    fn a_home_folder_chat_and_an_old_member_worktree_session_both_land_on_the_topic() {
        let dots = Dots::default();
        let home_chat = ChatFact {
            folder: "topic:auth-1".into(),
            ..chat("home", Status::WaitingForApproval)
        };
        dots.replace(
            Facts {
                tabs: vec![],
                chats: vec![home_chat],
                forge: vec![],
            },
            |_| false,
            |_| false,
        );
        dots.note_running(&[("old".into(), "claude".into())], &HashSet::from(["old".to_string()]));
        let old = Meta {
            agent: "claude".into(),
            path: String::new(),
            branch: "auth".into(),
            cwd: "/p/api/.tori/worktrees/auth".into(),
            name: String::new(),
        };
        let topics = [crate::unit_home::tests::topic()];
        let (_, changes) = dots.compose_all(
            &HashMap::from([("old".to_string(), old)]),
            |at, branch| crate::unit_home::home_of(&[], &topics, at, branch),
            |_, _| false,
        );
        let placed = |id: &str| {
            changes
                .iter()
                .find(|c| c.id == id)
                .map(|c| (c.dot, c.home.as_ref().and_then(|h| h.topic.clone())))
        };
        assert_eq!(placed("home"), Some((Dot::NeedsYou, Some("auth-1".into()))));
        assert_eq!(placed("old"), Some((Dot::Hollow, Some("auth-1".into()))));
    }
}
