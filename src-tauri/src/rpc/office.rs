//! What the daemon answers every front from: the method table, and the stores
//! behind it that have to outlive the window (asks, the autopilot, its runner
//! and watcher, the quota readings).

use std::collections::HashSet;
use std::sync::{Arc, OnceLock, Weak};

use serde::Deserialize;
use serde_json::{json, Value};

use super::asks::{self, Asks};
use super::events;
use super::hub::{Channel, Hub};
use super::methods::{DaemonBackend, Screen};
use super::quotas;
use super::runner::Runner;
use super::server::{self, Server, AUTH_TIMEOUT};
use super::states::SessionStates;
use super::watcher::Watcher;
use crate::autopilot::AutopilotStore;
use crate::desk::Desk;
use crate::ui::Ui;

// The window adds this to a prompt's id, so its own askpass and the daemon's
// never answer each other's prompts.
pub const DAEMON_PROMPT: u64 = 1 << 48;

pub struct Office {
    pub server: Arc<Server>,
    remote: Arc<super::remote::Remote>,
    devices: Arc<super::devices::Devices>,
    awake: std::sync::Mutex<Option<super::awake::Awake>>,
    idle_restart: std::sync::atomic::AtomicBool,
    restart: Box<dyn Fn() + Send + Sync>,
    desk: Desk,
    backend: DaemonBackend,
    asks: Arc<Asks>,
    autopilot: Arc<AutopilotStore>,
    runner: Arc<Runner>,
    hub: Arc<Hub>,
    states: Arc<SessionStates>,
    askpass: Option<Arc<crate::askpass::AskpassInner>>,
}

pub struct Parts {
    pub hub: Arc<Hub>,
    pub desk: Desk,
    pub chats: Arc<crate::chat::serve::Served>,
    pub composer: Arc<super::composer::Composer>,
    pub ptys: Arc<crate::pty::host::Host>,
    pub screen: Arc<dyn Screen>,
    // Whether a window took it: a prompt nobody can see fails at once.
    pub prompt: Box<dyn Fn(crate::askpass::PromptEvent) -> bool + Send + Sync>,
    pub restart: Box<dyn Fn() + Send + Sync>,
}

fn autopilot_publisher(hub: &Arc<Hub>, ui: &Ui) -> Box<dyn Fn(Value) + Send + Sync> {
    let (hub, ui) = (hub.clone(), ui.clone());
    Box::new(move |event| {
        ui.emit("autopilot://changed", &event);
        hub.publish(&Channel::Autopilot, event);
    })
}

fn withdraw_holds(asks: Arc<Asks>, ui: Ui) -> Box<dyn Fn(&str) + Send + Sync> {
    Box::new(move |item| {
        for id in asks.withdraw_item(item) {
            ui.emit(asks::CLOSE_EVENT, json!({ "id": id }));
        }
    })
}

fn start_askpass(
    prompt: Box<dyn Fn(crate::askpass::PromptEvent) -> bool + Send + Sync>,
) -> Option<Arc<crate::askpass::AskpassInner>> {
    static SELF: OnceLock<Weak<crate::askpass::AskpassInner>> = OnceLock::new();
    let started = crate::askpass::start(Box::new(move |event| {
        let id = event.id;
        if prompt(event) {
            return;
        }
        if let Some(inner) = SELF.get().and_then(Weak::upgrade) {
            std::thread::spawn(move || crate::askpass::resolve(&inner, id, None));
        }
    }));
    match started {
        Ok(inner) => {
            let _ = SELF.set(Arc::downgrade(&inner));
            crate::credential::publish(inner.sock_path(), inner.credential_token(), inner.everywhere_token());
            Some(inner)
        }
        Err(e) => {
            eprintln!("tori daemon: askpass bridge failed to start: {e}");
            None
        }
    }
}

// A chat stopped by its spend ceiling reports needs_you, so it is held here too.
fn start_watcher(desk: &Desk, autopilot: &Arc<AutopilotStore>, runner: &Arc<Runner>) {
    let status = runner.clone();
    let (watcher, nudges) = Watcher::new(
        desk.states.clone(),
        autopilot.clone(),
        Box::new(move || status.status()),
    );
    super::set_watcher(watcher.clone());
    let chats = desk.chats.clone();
    std::thread::spawn(move || {
        let deliver = |session: &str, text: String| {
            let text = events::from_tori("wake", None, &text);
            chats.host.deliver(
                session,
                vec![crate::chat::model::ContentBlock::Text { text }],
                false,
                events::TurnBy::Watcher,
            )
        };
        let stall = || std::time::Duration::from_secs(u64::from(crate::settings::autopilot().stall_minutes) * 60);
        watcher.run(nudges, deliver, stall);
    });
}

// A sleeping Mac stops the timer, so the wait is capped and the wall clock read again.
fn start_clock(autopilot: &Arc<AutopilotStore>) {
    const MINUTE: std::time::Duration = std::time::Duration::from_secs(60);
    let store = autopilot.clone();
    std::thread::spawn(move || {
        let mut failed = None;
        loop {
            let fired = crate::settings::autopilot().available
                && match store.fire_due(crate::owned_state::now_ms()) {
                    Ok(fired) => {
                        failed = None;
                        super::watcher_scheduled(&fired);
                        true
                    }
                    Err(e) => {
                        if failed.as_ref() != Some(&e.to_string()) {
                            eprintln!("tori: a schedule did not fire: {e}");
                            failed = Some(e.to_string());
                        }
                        false
                    }
                };
            // Only a pass that fired moved the due slots on; any other would find them due again at once.
            let next = store.next_slot().filter(|_| fired);
            let until = next.map_or(MINUTE, |at| {
                std::time::Duration::from_millis(at.saturating_sub(crate::owned_state::now_ms()))
            });
            store.wait_for_schedules(until.clamp(std::time::Duration::from_secs(1), MINUTE));
        }
    });
}

// On `sessions`, which every phone screen already reads and ignores unknown kinds of.
fn start_radar(desk: &Desk, hub: &Arc<Hub>, autopilot: &Arc<AutopilotStore>) {
    let (ui, hub) = (desk.ui.clone(), hub.clone());
    let (states, items, at_start) = (desk.states.clone(), autopilot.clone(), autopilot.clone());
    let live = states.clone();
    crate::radar::start(crate::radar::Hooks {
        watched: Box::new(move || {
            let mut folders: Vec<String> = states.live_in_folders().into_iter().map(|(_, f)| f).collect();
            folders.extend(items.worktrees());
            folders
        }),
        live: Box::new(move || live.live_in_folders()),
        at_start: Box::new(move || at_start.worktrees()),
        publish: Box::new(move |changed| {
            ui.emit(crate::radar::CHANGED_EVENT, changed);
            let mut event = json!(changed);
            event["kind"] = json!("radar.changed");
            hub.publish(&Channel::Sessions, event);
        }),
    });
}

pub fn start(parts: Parts) -> Arc<Office> {
    let Parts {
        hub,
        desk,
        chats,
        composer,
        ptys,
        screen,
        prompt,
        restart,
    } = parts;
    let askpass = start_askpass(prompt);
    let dir = crate::autopilot::dir();
    let asks = Arc::new(Asks::with_holds(
        dir.join("holds.json"),
        autopilot_publisher(&hub, &desk.ui),
    ));
    let autopilot = Arc::new(
        AutopilotStore::open(dir.clone(), autopilot_publisher(&hub, &desk.ui))
            .on_closed(withdraw_holds(asks.clone(), desk.ui.clone())),
    );
    let pilot = Arc::downgrade(&composer);
    let runner = Arc::new(Runner::new(super::runner::Wiring {
        ui: desk.ui.clone(),
        chats: chats.clone(),
        hub: hub.clone(),
        states: desk.states.clone(),
        asks: asks.clone(),
        pilot: Box::new(move |on| {
            if let Some(composer) = pilot.upgrade() {
                composer.pilot(on);
            }
        }),
        dir,
    }));
    super::set_stores(asks.clone(), runner.clone(), hub.clone(), desk.states.clone());
    start_radar(&desk, &hub, &autopilot);
    start_watcher(&desk, &autopilot, &runner);
    start_clock(&autopilot);
    let moved = desk.ui.clone();
    super::pr_watch::on_polled_moved(Box::new(move || moved.emit("pr_watch://changed", ())));
    let devices = Arc::new(super::devices::Devices::open(super::devices_path()));
    let paired = desk.ui.clone();
    let pairing = Arc::new(super::pairing::Pairing::new(Box::new(move |ended| {
        paired.emit(DEVICES_EVENT, json!({ "ended": ended }));
    })));
    let backend = DaemonBackend {
        desk: desk.clone(),
        screen,
        chats,
        composer,
        ptys,
        askpass: askpass.clone(),
        asks: asks.clone(),
        autopilot: autopilot.clone(),
        runner: runner.clone(),
        adoptable: Arc::default(),
        quotas: Arc::default(),
        devices: devices.clone(),
        hub: hub.clone(),
        uploads: Arc::new(super::uploads::Uploads::new(
            crate::attachments::dir(),
            super::uploads::ABANDONED,
        )),
    };
    let server = Arc::new(Server {
        hub: hub.clone(),
        backend: Box::new(backend.clone()),
        auth_timeout: AUTH_TIMEOUT,
    });
    let remote = Arc::new(super::remote::Remote::new(server.clone(), devices.clone(), pairing));
    let office = Arc::new(Office {
        remote,
        devices,
        awake: std::sync::Mutex::new(None),
        idle_restart: std::sync::atomic::AtomicBool::new(false),
        restart,
        server,
        desk: desk.clone(),
        backend,
        asks,
        autopilot,
        runner: runner.clone(),
        hub,
        states: desk.states,
        askpass,
    });
    let watched = Arc::downgrade(&office);
    office.hub.watch_devices(Box::new(move || {
        if let Some(office) = watched.upgrade() {
            office.desk.ui.emit(DEVICES_EVENT, json!({ "ended": null }));
            office.keep_awake();
        }
    }));
    office.remote.apply(&crate::settings::remote());
    office.keep_awake();
    runner.autostart();
    office
}

// The Settings pane is not a socket subscriber, so it hears about devices here.
const DEVICES_EVENT: &str = "remote://devices";
const UPDATE_EVENT: &str = "daemon://update-waiting";

fn arg<T: for<'de> Deserialize<'de>>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|e| format!("{key}: {e}"))
}

impl Office {
    // A phone would lose something to a sleeping Mac: it is connected, or a
    // session it can watch is working.
    fn awake_wanted(&self) -> bool {
        let listening = matches!(self.remote.status(), super::remote::Status::Listening { .. });
        listening && (!self.hub.connected_devices().is_empty() || self.working() > 0)
    }

    fn working(&self) -> usize {
        let states = self.states.snapshot();
        states
            .values()
            .filter(|s| **s == super::states::SessionState::Working)
            .count()
    }

    pub fn restart_when_idle(&self) {
        self.idle_restart.store(true, std::sync::atomic::Ordering::SeqCst);
        self.sessions_moved();
    }

    pub fn sessions_moved(&self) {
        self.keep_awake();
        if !self.idle_restart.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let working = self.working();
        self.desk.ui.emit(UPDATE_EVENT, json!({ "sessions": working }));
        if working == 0 {
            (self.restart)();
        }
    }

    pub fn keep_awake(&self) {
        let wanted = self.awake_wanted();
        let mut held = self.awake.lock().unwrap_or_else(|e| e.into_inner());
        if wanted && held.is_none() {
            *held = super::awake::Awake::hold("Tori is serving a remote device");
        } else if !wanted {
            *held = None;
        }
    }

    pub fn resolve_prompt(&self, id: u64, value: Option<String>) {
        if let Some(askpass) = &self.askpass {
            crate::askpass::resolve(askpass, id, value);
        }
    }

    pub fn session_question(&self, session: &str) -> Value {
        self.asks.pending_for(session).map_or(Value::Null, |ask| json!(ask))
    }

    pub fn heard_session(&self, id: &str, event: &Value) {
        super::heard_session(&self.autopilot, id, event);
        if event["kind"] == "session.compacted" {
            super::retell_topic(&self.desk, id, event["trigger"] == "auto");
        }
    }

    fn record_quota(&self, agent: &str, profile: Option<&str>, readings: Vec<quotas::Reading>) {
        if let Some(windows) = self.backend.quotas.record(agent, profile, readings) {
            let event = json!({
                "kind": "account.quota",
                "agent": agent,
                "account": profile,
                "windows": windows,
                "ts": events::now_ms(),
            });
            self.hub.publish(&Channel::Accounts, event);
        }
    }

    /// A chat's own rate limit frame, filed under the account it runs on, so
    /// the windows are known with no window open.
    pub fn rate_limit(&self, session: &str, event: &crate::chat::model::ChatEvent) {
        let readings = quotas::of_rate_limit(event);
        if readings.is_empty() {
            return;
        }
        let account = crate::chat::client::Claimed::account_of(&*self.backend.chats.host.registry, session);
        let Some((agent, profile)) = account else { return };
        let profile = Some(profile.as_str()).filter(|p| *p != crate::accounts::DEFAULT_PROFILE_ID);
        self.record_quota(&agent, profile, readings);
    }

    fn locked(&self, session: &str) -> bool {
        super::is_locked(&self.states, &self.autopilot, &self.runner, session)
    }

    pub fn call(&self, op: &str, args: &Value) -> Result<Value, String> {
        use server::Backend;
        if let Some(topics) = op.strip_prefix("topics.") {
            let projects = &self.backend.composer.projects;
            return crate::topics::commands::office(&self.desk, projects, topics, args);
        }
        let to = |v: Result<Value, super::frame::RpcError>| v.map_err(|e| e.message);
        match op {
            "asks.pending" => Ok(json!(self.asks.pending())),
            "asks.answer" => {
                let (id, answer): (String, String) = (arg(args, "id")?, arg(args, "answer")?);
                Ok(json!(self.asks.answer(&id, answer, asks::By::User).is_ok()))
            }
            "autopilot.start" => self.runner.start().map(|s| json!(s)),
            "autopilot.stop" => self.runner.stop().map(|s| json!(s)),
            "autopilot.status" => Ok(json!(self.runner.status())),
            "autopilot.state" => to(self.backend.autopilot_state()),
            "sessions.adoptable" => Ok(json!(self.backend.adoptable())),
            "sessions.adopted" => {
                self.backend.adopted(&arg::<String>(args, "session")?);
                Ok(json!({}))
            }
            "autopilot.contracts" => Ok(json!(self.autopilot.projects())),
            "autopilot.worktrees" => Ok(json!(self.autopilot.worktrees())),
            "autopilot.project_set" => {
                let patch: server::ProjectSetParams = arg(args, "patch")?;
                to(patch.apply(&self.autopilot, arg(args, "project_path")?))
            }
            "autopilot.pickup" => self.pickup(&arg::<String>(args, "project_path")?).map(|()| json!({})),
            "autopilot.log" => Ok(json!(self.autopilot.recent_log(arg(args, "limit")?))),
            "autopilot.schedules" => Ok(json!(self.autopilot.schedules())),
            "autopilot.rules" => Ok(json!(self.autopilot.rules(&crate::settings::pr_rules()))),
            "autopilot.rule_resume" => {
                let project: String = arg(args, "project")?;
                self.autopilot.resume_rule(&project).map_err(|e| e.to_string())?;
                Ok(json!(self.autopilot.rules(&crate::settings::pr_rules())))
            }
            "autopilot.schedule_resume" => {
                let id: String = arg(args, "id")?;
                self.autopilot
                    .resume_schedule(&id)
                    .map(|row| json!(row))
                    .map_err(|e| e.to_string())
            }
            "autopilot.closed_by_hand" => {
                let held: HashSet<String> = self.asks.holds().into_iter().map(|h| h.item).collect();
                self.autopilot
                    .closed_by_hand(&arg::<String>(args, "session")?, &held)
                    .map(|_| json!({}))
                    .map_err(|e| e.to_string())
            }
            "autopilot.locked" => {
                let mut sessions: Vec<String> = self
                    .autopilot
                    .sessions()
                    .into_iter()
                    .chain(self.states.spawned())
                    .collect();
                sessions.sort();
                sessions.dedup();
                sessions.retain(|id| self.locked(id));
                Ok(json!(sessions))
            }
            "locked" => Ok(json!(self.locked(&arg::<String>(args, "session")?))),
            "pr_watch.start" => {
                let session: String = arg(args, "session")?;
                let item = self.autopilot.item_for_session(&session).is_some();
                super::pr_watch::watch(&session, &arg::<String>(args, "project")?, arg(args, "number")?, item)
                    .map(|w| json!(w.url))
            }
            "pr_watch.list" => {
                let rows: Vec<Value> = super::pr_watch::store()
                    .list()
                    .into_iter()
                    .filter(|w| !w.ended)
                    .map(|w| json!({ "session": w.session, "url": w.url, "project": w.project, "branch": w.branch }))
                    .collect();
                Ok(json!(rows))
            }
            "pr_watch.stop" => super::pr_watch::stop(&arg::<String>(args, "session")?, &arg::<String>(args, "url")?)
                .map(|stopped| json!(stopped)),
            "pr_watch.watched" => Ok(json!(super::pr_watch::watched_numbers(
                &arg::<String>(args, "owner")?,
                &arg::<String>(args, "repo")?
            ))),
            "pr_watch.fold" => {
                let (owner, repo): (String, String) = (arg(args, "owner")?, arg(args, "repo")?);
                super::pr_watch::fold(&owner, &repo, arg(args, "read")?);
                Ok(json!({}))
            }
            "pr_watch.polled" => Ok(json!(super::pr_watch::polled())),
            "pr_watch.session_deleted" => {
                super::pr_watch::session_deleted(&arg::<String>(args, "session")?);
                Ok(json!({}))
            }
            "review.forget" => {
                crate::review::forget_session(&arg::<String>(args, "id")?);
                Ok(json!({}))
            }
            "quota" => {
                let (agent, profile): (String, Option<String>) = (arg(args, "agent")?, arg(args, "profile")?);
                self.record_quota(&agent, profile.as_deref(), arg(args, "readings")?);
                Ok(json!({}))
            }
            "rule_review" => {
                let review: crate::autopilot::RuleReview = arg(args, "review")?;
                let item = self
                    .autopilot
                    .rule_review(
                        &arg::<String>(args, "project")?,
                        &arg::<String>(args, "repo")?,
                        &arg::<String>(args, "account")?,
                        review,
                    )
                    .map_err(|e| e.to_string())?;
                super::watcher_started(&item);
                Ok(json!({}))
            }
            "spawn_review" => {
                let params = server::SpawnParams {
                    folder: Some(arg(args, "folder")?),
                    project: Some(arg(args, "project")?),
                    prompt: Some(arg(args, "prompt")?),
                    background: Some(true),
                    agent: arg(args, "agent")?,
                    account: arg(args, "account")?,
                    model: arg(args, "model")?,
                    effort: arg(args, "effort")?,
                    mode: arg(args, "mode")?,
                    ..Default::default()
                };
                let spawned = self
                    .backend
                    .spawn(&super::auth::Principal::Local, params, true)
                    .map_err(|e| e.message)?;
                Ok(spawned["id"].clone())
            }
            "publish_pr" => {
                super::publish_pr(
                    &arg::<String>(args, "project")?,
                    &arg::<String>(args, "folder")?,
                    &arg::<String>(args, "branch")?,
                    arg(args, "checked_out")?,
                    args.get("fields").cloned().unwrap_or(Value::Null),
                );
                Ok(json!({}))
            }
            "radar.moved" => {
                crate::radar::moved(&arg::<String>(args, "path")?);
                Ok(json!({}))
            }
            "radar.note_read" => {
                crate::radar::note_read(
                    &arg::<String>(args, "path")?,
                    &arg::<String>(args, "branch")?,
                    arg(args, "conflicts")?,
                    arg(args, "local_base")?,
                );
                Ok(json!({}))
            }
            "radar.set_drawn" => {
                crate::radar::set_drawn(arg(args, "units")?);
                Ok(json!({}))
            }
            "radar.settings_changed" => {
                crate::radar::settings_changed();
                Ok(json!({}))
            }
            "radar.signals" => Ok(json!(crate::radar::session_signals(
                &arg::<String>(args, "session")?,
                &arg::<String>(args, "folder")?
            ))),
            "radar.list" => Ok(json!(crate::radar::list())),
            "browsers.mint" => {
                super::browsers::mint(&super::browsers::store(), &self.hub).map(|id| json!({ "id": id }))
            }
            "browsers.revoke" => super::browsers::revoke(&super::browsers::store(), &self.hub).map(|()| json!({})),
            "browsers.status" => Ok(super::browsers::status(&super::browsers::store(), &self.hub)),
            "browser.opening" => {
                self.hub
                    .note_opened(&arg::<String>(args, "url")?, std::time::Instant::now());
                Ok(json!({}))
            }
            "ports.scan" => {
                let worktrees: Vec<String> = arg(args, "worktrees")?;
                if let Some(pids) = arg(args, "exclude")? {
                    crate::ports::exclude(pids);
                }
                Ok(json!(crate::ports::scan(&worktrees, std::time::Duration::ZERO)))
            }
            "ports.exclude" => {
                crate::ports::exclude(arg(args, "pids")?);
                Ok(json!({}))
            }
            "needs_you.list" => Ok(json!(crate::needs_you_log::list())),
            "needs_you.seen" => {
                let (session, folder, branch): (Option<String>, Option<String>, Option<String>) =
                    (arg(args, "session")?, arg(args, "folder")?, arg(args, "branch")?);
                if crate::needs_you_log::seen(session.as_deref(), folder.as_deref(), branch.as_deref()) {
                    super::publish_needs_you(&self.desk.ui);
                }
                Ok(json!({}))
            }
            "digest.list" => Ok(json!(crate::digest::read(arg(args, "since")?))),
            "digest.looked" => {
                crate::needs_you_log::looked(arg(args, "at")?);
                Ok(json!({}))
            }
            "digest.limit_resumed" => {
                let registry = &*self.backend.chats.host.registry;
                let (session, folder): (String, String) = (arg(args, "session_id")?, arg(args, "folder")?);
                let kind = crate::needs_you_log::Kind::LimitResumed;
                if crate::digest::note_limit(registry, kind, &session, &folder, arg(args, "resets_at")?) {
                    super::publish_needs_you(&self.desk.ui);
                }
                Ok(json!({}))
            }
            "review.inbox" => Ok(json!(crate::review::inbox_now(&self.backend.composer.index))),
            "review.mark" => {
                let index = &self.backend.composer.index;
                crate::review::mark_now(&self.desk.ui, index, arg(args, "unit")?, arg(args, "to_ts")?)
                    .map(|()| json!({}))
            }
            "second_opinion.running" => Ok(json!(crate::second_opinion::running_now())),
            "second_opinion.list" => Ok(json!(crate::second_opinion::list_in(
                &self.backend.composer.index,
                arg(args, "folder")?
            ))),
            "second_opinion.set_status" => crate::second_opinion::set_status_in(
                &self.desk.ui,
                arg(args, "folder")?,
                arg(args, "session")?,
                arg(args, "ids")?,
                arg(args, "status")?,
            )
            .map(|()| json!({})),
            "second_opinion.run" => crate::second_opinion::run_in(
                &self.desk.ui,
                &self.backend.chats,
                &self.backend.composer.index,
                arg(args, "session")?,
                arg(args, "agent")?,
                arg(args, "profile")?,
            )
            .map(|()| json!({})),
            "remote.set" => {
                let remote: crate::settings::Remote = arg(args, "remote")?;
                crate::settings::set_remote(remote.clone())?;
                let status = self.remote.apply(&remote);
                self.keep_awake();
                Ok(json!(status))
            }
            "remote.status" => Ok(json!(self.remote.status())),
            "pairing.start" => self.remote.start_pairing().map(|offer| json!(offer)),
            "pairing.cancel" => {
                self.remote.cancel_pairing();
                Ok(json!({}))
            }
            "devices.list" => {
                let connected = self.hub.connected_devices();
                let rows: Vec<Value> = self
                    .devices
                    .list()
                    .into_iter()
                    .map(|d| json!({ "id": d.id, "name": d.name, "created_ms": d.created_ms, "connected": connected.contains(&d.id) }))
                    .collect();
                Ok(json!(rows))
            }
            // Revoked in the file first: a connection still being set up checks
            // the file after registering, so it cannot slip between the two.
            "device.revoke" => {
                let id: String = arg(args, "id")?;
                self.devices.revoke(&id)?;
                self.hub.close_device(&id);
                self.desk.ui.emit(DEVICES_EVENT, json!({ "ended": null }));
                Ok(json!({}))
            }
            other => Err(format!("no office call {other}")),
        }
    }

    // After each watch fold, so a rule rides the same poll as the watch it reads.
    pub fn pr_rules_tick(&self) {
        if !crate::settings::autopilot().available {
            return;
        }
        let rules = crate::settings::pr_rules();
        if rules.values().all(|r| r.on.is_empty()) {
            return;
        }
        let shown = self.states.shown();
        let gone = |session: &str| super::pr_rules::session_ended(&shown, session);
        let hits = super::pr_rules::hits(&super::pr_watch::store().list(), &rules, gone);
        let firings = match self.autopilot.fire_rules(&hits) {
            Ok(firings) => firings,
            Err(e) => return eprintln!("tori: a pull request rule did not fire: {e}"),
        };
        let handed = &firings.handed;
        let saved = super::pr_watch::store().update(|watches| {
            watches
                .iter()
                .filter(|w| handed.iter().any(|(s, u, _)| *s == w.session && *u == w.url))
                .map(|w| {
                    let mut next = w.clone();
                    next.hand_over(super::pr_rules::HANDED_OVER);
                    next
                })
                .collect()
        });
        if let Err(e) = saved {
            eprintln!("tori: pull request watch not saved: {e}");
        }
        super::watcher_picked(&firings.filed);
    }

    // Called from the window's forge poll tick, so it rides that cadence and its
    // pause and backoff rather than a clock of its own.
    fn pickup(&self, project: &str) -> Result<(), String> {
        if !crate::settings::autopilot().available {
            return Ok(());
        }
        let sources = self.autopilot.contract(project).unwrap_or_default().issues;
        let Some(list) = crate::issues::commands::assigned_if_offered(project, &sources).map_err(|e| e.to_string())?
        else {
            return Ok(());
        };
        let picked = self
            .autopilot
            .pickup(project, &list.repo, &list.account, &list.lists, &list.failed)
            .map_err(|e| e.to_string())?;
        super::watcher_picked(&picked);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autopilot::{Kind, Patch, Source, Target};
    use crate::rpc::approvals;

    fn merge_approval() -> Option<approvals::Approval> {
        let draft = approvals::Draft::PrMerge {
            number: 7,
            method: crate::forge::MergeMethod::Squash,
            head_sha: "abc".into(),
        };
        Some(approvals::Approval {
            project: "/p".into(),
            draft,
        })
    }

    #[test]
    fn an_item_closing_while_its_hold_is_answered_blocks_neither() {
        let dir = crate::autopilot::tests::temp_dir("close-race");
        let asks = Arc::new(Asks::with_holds(dir.join("holds.json"), Box::new(|_| {})));
        let store = Arc::new(
            AutopilotStore::open(dir.clone(), Box::new(|_| {}))
                .on_closed(withdraw_holds(asks.clone(), Ui::new(|_, _| {}))),
        );
        let source = Source::Pr {
            number: 7,
            repo: "o/r".into(),
        };
        let item = store
            .update(
                Target::Key {
                    kind: Kind::Review,
                    source,
                    project: "/p".into(),
                    origin: "o/r".into(),
                },
                Patch::default(),
            )
            .unwrap()
            .id;
        let ask = asks
            .create(
                "s1".into(),
                "merge?".into(),
                vec![],
                merge_approval(),
                None,
                Some(item.clone()),
            )
            .id;

        let (done_tx, done) = std::sync::mpsc::channel();
        let (closing, answering) = (store.clone(), asks.clone());
        let (item_id, ask_id) = (item.clone(), ask.clone());
        let tx = done_tx.clone();
        std::thread::spawn(move || {
            let state = Patch {
                state: Some(crate::autopilot::State::Done),
                ..Patch::default()
            };
            closing.update(Target::Id(item_id), state).unwrap();
            tx.send(()).unwrap();
        });
        std::thread::spawn(move || {
            let _ = answering.answer(&ask_id, approvals::APPROVE.into(), asks::By::User);
            done_tx.send(()).unwrap();
        });
        for _ in 0..2 {
            done.recv_timeout(std::time::Duration::from_secs(5))
                .expect("neither side blocks");
        }
        assert!(asks.holds().is_empty(), "a done item holds nothing up");
        let read = asks.wait(&ask, std::time::Duration::ZERO);
        assert_eq!(
            read,
            asks::Waited::Answered {
                answer: asks::WITHDRAWN.into(),
                approval_id: None
            },
            "whichever landed first"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
