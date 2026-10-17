use std::cell::OnceCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

use super::dots::{self, Bound, Dots, Meta};
use super::events::{self, session_event, Place};
use super::frame::RpcError;
use super::hub::{Channel, Hub};
use super::methods::{self, Joined, Live};
use super::server::{ListParams, WaitParams};
use super::states::{Held, SessionStates, Source};
use crate::chat::host::Levers;
use crate::chat::pulse::Beat;
use crate::presence::Presence;
use crate::pty::wire::Listed;
use crate::sessions::{SessionIndex, SessionRef};

pub trait Sources: Send + Sync {
    fn beats(&self) -> Vec<Beat>;
    fn tabs(&self) -> Vec<Listed>;
    fn tab_of(&self, head: &str) -> Option<String>;
    fn running(&self, refs: Vec<SessionRef>) -> Vec<String>;
    fn live(&self) -> BTreeMap<String, Live>;
    fn levers(&self, id: &str) -> Option<Levers>;
    fn question(&self, id: &str) -> Value;
    fn tell(&self, method: &'static str, params: Value);
    fn heard(&self, id: &str, event: &Value);
}

const STALE_PROBE: Duration = Duration::from_secs(5);

#[derive(PartialEq)]
enum Nudge {
    Compose,
    Probe,
    Changed,
    Present,
}

pub struct Composer {
    sources: Box<dyn Sources>,
    hub: Arc<Hub>,
    pub states: Arc<SessionStates>,
    dots: Dots,
    // Index rows per session, and every id already looked up, so a session with
    // no transcript yet does not re-walk the index on every composition.
    metas: Mutex<(HashMap<String, Meta>, HashSet<String>)>,
    presence: Mutex<Presence>,
    pub index: SessionIndex,
    pub projects: crate::config::ProjectIndex,
    callers: Mutex<crate::hooks::Callers>,
    pilot: AtomicBool,
    nudges: Mutex<Sender<Nudge>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Composer {
    pub fn start(sources: Box<dyn Sources>, hub: Arc<Hub>) -> Arc<Self> {
        let (tx, rx) = channel::<Nudge>();
        let composer = Arc::new(Self {
            sources,
            hub,
            states: Arc::default(),
            dots: Dots::default(),
            metas: Mutex::default(),
            presence: Mutex::new(Presence::unwatched()),
            index: SessionIndex::default(),
            projects: crate::config::ProjectIndex::default(),
            callers: Mutex::default(),
            pilot: AtomicBool::new(false),
            nudges: Mutex::new(tx),
        });
        let weak = Arc::downgrade(&composer);
        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut all = vec![first];
                all.extend(rx.try_iter());
                let Some(composer) = weak.upgrade() else { return };
                if all.iter().any(|n| matches!(n, Nudge::Probe | Nudge::Changed)) {
                    composer.probe();
                }
                if all.iter().any(|n| *n != Nudge::Present) {
                    composer.compose(all.contains(&Nudge::Changed));
                }
                composer.present();
            }
        });
        composer
    }

    fn nudge(&self, what: Nudge) {
        let _ = lock(&self.nudges).send(what);
    }

    fn presence(&self) -> MutexGuard<'_, Presence> {
        lock(&self.presence)
    }

    // A reload restores tabs per workspace on first visit and remounts a chat
    // only when its tab is shown, so what a push leaves out is held while the
    // daemon still runs it.
    pub fn facts(&self, facts: dots::Facts) {
        let tabs: HashSet<String> = self.sources.tabs().into_iter().map(|t| t.tab).collect();
        let chats: HashSet<String> = self.sources.beats().into_iter().map(|b| b.session).collect();
        self.dots
            .replace(facts, |tab| tabs.contains(tab), |id| chats.contains(id));
        self.nudge(Nudge::Compose);
    }

    pub fn attention(&self, session: Option<String>, focused: bool) {
        self.presence().attend(session, focused);
        self.looked();
    }

    // Also on coming back to a window that already shows the session, which
    // sends no attention of its own.
    pub fn looked(&self) {
        let id = self.presence().looking_at().map(str::to_string);
        let cleared = id.is_some_and(|id| self.dots.clear_denied(&id));
        self.nudge(if cleared { Nudge::Compose } else { Nudge::Present });
    }

    #[expect(dead_code, reason = "the unattended deny guard calls it")]
    pub fn denied(&self, id: &str) {
        if self.dots.deny(id) {
            self.nudge(Nudge::Compose);
        }
    }

    pub fn activity(&self, tab: &str, state: &str) {
        let activity = match state {
            "active" => dots::Activity::Active,
            _ => dots::Activity::Quiet,
        };
        if self.dots.note_activity(tab, activity) {
            self.nudge(Nudge::Compose);
        }
    }

    pub fn running(&self, asked: &[(String, String)], running: &[String]) {
        self.dots.note_running(asked, &running.iter().cloned().collect());
        self.nudge(Nudge::Compose);
    }

    pub fn changed(&self) {
        self.nudge(Nudge::Changed);
    }

    pub fn beat(&self) {
        self.nudge(Nudge::Compose);
    }

    pub fn probe_soon(&self) {
        self.nudge(Nudge::Probe);
    }

    pub fn pilot(&self, on: bool) {
        if self.pilot.swap(on, Ordering::Relaxed) != on {
            self.nudge(Nudge::Present);
        }
    }

    pub fn window(&self, attached: bool) {
        if attached {
            self.presence().redraw();
            self.sources.tell("states", json!(self.states.shown()));
        } else {
            self.dots.unseen();
            self.presence().attend(None, false);
        }
        self.nudge(Nudge::Compose);
    }

    pub fn dots_all(&self) -> Vec<dots::Change> {
        self.dots.all()
    }

    pub fn tab_of(&self, session: &str) -> Option<String> {
        self.dots.tab_of(session)
    }

    // So a socket caller never waits on a window to notice a session exited.
    // Queued rather than run inline, which would put a pgrep on the caller's call.
    fn refresh_if_stale(&self) {
        if self.dots.probed_at().is_none_or(|at| at.elapsed() >= STALE_PROBE) {
            self.nudge(Nudge::Probe);
        }
    }

    pub fn lifecycle(&self, id: &str, event: Value) {
        self.publish_session(id, event);
    }

    fn publish_session(&self, id: &str, event: Value) {
        super::pr_wake::session_event(id, &event);
        self.sources.heard(id, &event);
        self.hub.publish_session(id, event);
    }

    pub fn sessions_list(&self, params: &ListParams) -> Value {
        self.refresh_if_stale();
        let live = self.sources.live();
        let indexed = crate::sessions::listed_sessions(&self.index, params.cwd.as_deref());
        let dot = |id: &str| {
            let (dot, certainty) = self.dots.dot(id);
            (dot, certainty, !self.presence().unattended(id, dot))
        };
        let spaces = || (crate::unit_home::spaces(&self.projects), crate::unit_home::topics());
        let rows = methods::sessions_rows(
            indexed,
            params,
            Joined {
                live: &live,
                states: &self.states,
                levers: &|id| self.sources.levers(id),
                dot: &dot,
                spaces: &spaces,
            },
        );
        Value::Array(rows)
    }

    pub fn session_wait(&self, params: WaitParams) -> Result<Value, RpcError> {
        let id = params.id.clone();
        let live = self.sources.live();
        let live_chat = || self.sources.beats().iter().any(|b| b.session == id);
        methods::wait_for(
            params,
            &self.states,
            live_chat,
            || methods::agent_in(&id, &live, &self.index),
            || self.sources.question(&id),
        )
    }

    fn probe(&self) {
        let want = self.dots.to_probe();
        let refs = want
            .iter()
            .map(|(id, agent)| SessionRef {
                id: id.clone(),
                agent: agent.clone(),
            })
            .collect();
        let running = self.sources.running(refs);
        self.dots.note_running(&want, &running.into_iter().collect());
    }

    fn bound(&self, tabs: &[Listed]) -> Vec<Bound> {
        let fired = lock(&self.callers).scan();
        crate::hooks::bound_tabs(&fired, |head| self.sources.tab_of(head))
            .into_iter()
            .filter_map(|(tab, session)| {
                // A tab's hooks speak for it only while it runs the agent that has them.
                let listed = tabs.iter().find(|t| t.tab == tab).filter(|t| {
                    t.agent
                        .as_deref()
                        .and_then(crate::agents::find)
                        .is_some_and(|a| a.hooks)
                })?;
                Some(Bound {
                    tab,
                    session,
                    cwd: listed.cwd.clone(),
                    agent: listed.agent.clone(),
                    held: listed.handed_on,
                })
            })
            .collect()
    }

    // One at a time, so the events two compositions publish never interleave.
    fn compose(&self, reindex: bool) {
        let beats = self.sources.beats();
        let tabs = self.sources.tabs();
        self.dots.settle(&beats, &self.bound(&tabs));
        let mut metas = lock(&self.metas);
        let wanted = self.dots.wants_meta();
        if reindex || wanted.iter().any(|id| !metas.1.contains(id)) {
            let all = crate::sessions::all_sessions(&self.index);
            let rows = all
                .into_iter()
                .filter(|m| wanted.contains(&m.id))
                .map(|m| {
                    let name = m.name.filter(|n| !n.is_empty()).unwrap_or(m.title);
                    (
                        m.id.clone(),
                        Meta {
                            agent: m.agent,
                            path: m.path,
                            branch: m.branch,
                            cwd: m.cwd,
                            name,
                        },
                    )
                })
                .collect();
            *metas = (rows, wanted.into_iter().collect());
        }
        let spaces = OnceCell::new();
        let topics = OnceCell::new();
        let home_of = |at: &str, branch: Option<&str>| {
            let spaces = spaces.get_or_init(|| crate::unit_home::spaces(&self.projects));
            crate::unit_home::home_of(spaces, topics.get_or_init(crate::unit_home::topics), at, branch)
        };
        let tail_blocked = |id: &str, meta: &Meta| {
            crate::sessions::session_tail_state_body(id.to_string(), meta.path.clone(), meta.agent.clone())
                .is_ok_and(|t| t == crate::sessions::TailState::BlockedCandidate)
        };
        let (reports, changes) = self.dots.compose_all(&metas.0, home_of, tail_blocked);
        drop(metas);

        let chats: HashSet<String> = beats.into_iter().map(|b| b.session).collect();
        // A shell back at its prompt has no agent session left in it.
        let tabs: HashSet<String> = tabs.into_iter().filter(|t| t.handed_on).map(|t| t.tab).collect();
        let projects = OnceCell::new();
        let place_of = |folder: &str| Place {
            project: events::project_of(folder, projects.get_or_init(crate::config::discovered_project_dirs)),
            folder: Some(folder.to_string()),
        };
        let alive = |id: &str, held: &Held| match held.source {
            Source::Chat => chats.contains(id),
            Source::Pty => held.tab.as_ref().is_some_and(|tab| tabs.contains(tab)),
        };
        let moved = self.states.replace(reports, place_of, alive);
        if !moved.is_empty() {
            self.sources.tell("states", json!(self.states.shown()));
            crate::radar::sessions_changed();
            if let Some(office) = super::office() {
                office.sessions_moved();
            }
        }
        for event in moved {
            let id = event["id"].as_str().unwrap_or_default().to_string();
            self.publish_session(&id, event);
        }
        // Straight to the hub: a dot is not something the runner or the
        // watcher acts on, and a red check reaches them as `session.pr`.
        for change in &changes {
            let place = if change.folder.is_empty() {
                Place::default()
            } else {
                place_of(&change.folder)
            };
            let event = session_event(
                "session.dot",
                &change.id,
                &place,
                json!({ "dot": change.dot, "certainty": change.certainty }),
            );
            self.hub.publish_session(&change.id, event);
        }
        if !changes.is_empty() {
            self.sources.tell("dots", json!(changes));
        }
    }

    // After every composition, so an edge is only ever a dot that changed.
    fn present(&self) {
        let mut live = self.dots.live();
        let spaces = crate::unit_home::spaces(&self.projects);
        let topics = crate::unit_home::topics();
        {
            let metas = lock(&self.metas);
            for l in &mut live {
                l.branch = metas.0.get(&l.id).map(|m| m.branch.clone()).filter(|b| !b.is_empty());
                if l.name.is_empty() {
                    l.name = metas
                        .0
                        .get(&l.id)
                        .map(|m| m.name.clone())
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| l.id.clone());
                }
                l.project = crate::unit_home::project_name(&spaces, &l.folder);
                if let (true, Some(t)) = (l.project.is_empty(), crate::unit_home::topic_of(&topics, &l.folder)) {
                    l.project = t.name.clone();
                }
            }
        }
        let chats: HashSet<String> = live.iter().filter(|l| l.chat).map(|l| l.id.clone()).collect();
        let pilot = self.pilot.load(Ordering::Relaxed);
        let (edges, relayed, watched, (tray, badge)) = {
            let mut presence = self.presence();
            let edges = presence.step(&live);
            let ids = |keep: &dyn Fn(&crate::presence::Live) -> bool| -> HashSet<String> {
                live.iter().filter(|l| keep(l)).map(|l| l.id.clone()).collect()
            };
            let relayed = ids(&|l| crate::presence::relayed(l.spawner.as_deref(), &chats, pilot));
            let watched = ids(&|l| presence.suppressed(l));
            (edges, relayed, watched, presence.surface(&live))
        };
        let units: Vec<crate::needs_you_log::Unit> = self
            .dots
            .forge()
            .into_iter()
            .map(|u| crate::needs_you_log::Unit {
                project: crate::unit_home::project_name(&spaces, &u.folder_path),
                folder: u.folder_path,
                branch: u.branch,
                attention: u.attention,
                pr_known: u.pr_known,
                pr: u.pull_request,
            })
            .collect();
        let logged = crate::needs_you_log::record(&crate::needs_you_log::Tick {
            live: &live,
            finished: &edges.finished,
            relayed: &relayed,
            watched: &watched,
            units: &units,
        });
        if logged {
            self.hub
                .publish(&Channel::Sessions, json!({ "kind": "needs_you.changed" }));
            self.sources.tell("needs_you.changed", json!({}));
        }
        let quiet: HashSet<String> = relayed.union(&watched).cloned().collect();
        let withdraw = edges.cleared.clone();
        let alerts = match edges.rose.is_empty() && edges.finished.is_empty() {
            true => crate::presence::Alerts::default(),
            false => crate::presence::decide(edges, &quiet, &crate::settings::get_settings().notifications),
        };
        let pick =
            |ids: &[String]| -> Vec<&crate::presence::Live> { live.iter().filter(|l| ids.contains(&l.id)).collect() };
        let shown = json!({
            "withdraw": withdraw,
            "needs_you": pick(&alerts.needs_you),
            "finished": pick(&alerts.finished),
            "needs_you_sound": alerts.needs_you_sound,
            "finished_sound": alerts.finished_sound,
            "tray": tray,
            "badge": badge,
        });
        let quiet_tick = withdraw.is_empty()
            && alerts.needs_you.is_empty()
            && alerts.finished.is_empty()
            && !alerts.needs_you_sound
            && !alerts.finished_sound
            && shown["tray"].is_null()
            && badge.is_none();
        if !quiet_tick {
            self.sources.tell("present", shown);
        }
    }
}
