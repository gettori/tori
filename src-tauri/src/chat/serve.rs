//! Run by `tori daemon`, so a chat outlives the window.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use super::commands::{self, SpawnRequest};
use super::host::ChatHost;
use super::model::{ChatEvent, ContentBlock};
use super::ownership::{Claim, Orphans};
use super::transport::Emit;
use crate::rpc::events::{EndReason, TurnBy};

pub type Events = Arc<dyn Fn(&'static str, Value) + Send + Sync>;

// Consecutive text arrives a token at a time; a frame's worth goes as one.
const DELTA_WINDOW: Duration = Duration::from_millis(16);

pub struct Served {
    pub host: ChatHost,
    orphans: Orphans,
    events: Events,
}

fn arg<T: DeserializeOwned>(p: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(p.get(key).cloned().unwrap_or(Value::Null)).map_err(|e| format!("{key}: {e}"))
}

fn reply(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

impl Served {
    pub fn new(events: Events) -> Arc<Self> {
        let served = Arc::new(Self {
            host: ChatHost::default(),
            orphans: Orphans::default(),
            events,
        });
        served.orphans.set(super::ownership::reap_on_startup());
        let tap = Arc::downgrade(&served);
        served.host.set_publisher(Arc::new(move |id, data| {
            if let Some(served) = tap.upgrade() {
                served.lifecycle(id, data);
            }
        }));
        served
    }

    // The window marks open turns too, but a turn that ends with no window would
    // read as interrupted on the next launch.
    fn lifecycle(&self, id: &str, data: Value) {
        match data["kind"].as_str() {
            Some("session.turn_started") => {
                let turn = data["turn_id"].as_str().map(str::to_string);
                note_mark(id, commands::mark_turn(id, turn));
            }
            Some("session.turn_ended" | "session.ended") => {
                note_mark(id, commands::mark_turn(id, None));
            }
            _ => {}
        }
        (self.events)("chat.lifecycle", json!({ "id": id, "data": data }));
    }

    fn forward(&self, session_id: &str) -> Emit {
        let (tx, rx) = channel::<ChatEvent>();
        let (events, id) = (self.events.clone(), session_id.to_string());
        thread::spawn(move || {
            coalesce(
                rx,
                |event| events("chat.event", json!({ "session_id": id, "event": event })),
                DELTA_WINDOW,
            )
        });
        Box::new(move |event| {
            let _ = tx.send(event);
        })
    }

    pub fn shutdown(&self) {
        self.host.shutdown();
    }

    pub fn deliver(&self, id: &str, text: String, by: TurnBy) -> Result<(), String> {
        self.host.deliver(id, vec![ContentBlock::Text { text }], false, by)
    }

    pub fn call(&self, method: &str, p: &Value) -> Result<Value, String> {
        let host = &self.host;
        let id = || arg::<String>(p, "session_id");
        match method {
            "spawn" => {
                let req: SpawnRequest = arg(p, "req")?;
                let emit = self.forward(&req.session_id);
                reply(commands::spawn_session(host, req, emit)?)
            }
            "is_live" => reply(host.is_live(&id()?)),
            "live_sessions" => reply(host.live_sessions()),
            "live_ids" => reply(host.live_ids()),
            "deliver" => reply(host.deliver(&id()?, arg(p, "blocks")?, arg(p, "mid_turn")?, arg(p, "by")?)?),
            "note_for_next_turn" => {
                host.note_for_next_turn(&id()?, arg(p, "text")?);
                Ok(Value::Null)
            }
            "send" => reply(host.send(&id()?, arg(p, "blocks")?)?),
            "steer" => reply(host.steer(&id()?, arg(p, "blocks")?)?),
            "settle" => reply(host.settle(&id()?, &arg::<String>(p, "id")?, &arg::<Vec<String>>(p, "answers")?)?),
            "set_visible" => reply(host.set_visible(&id()?, arg(p, "visible")?)),
            "close" => reply(host.close(
                &id()?,
                arg::<Option<EndReason>>(p, "reason")?.unwrap_or(EndReason::Closed),
            )?),
            "waiting" => reply(host.waiting(&id()?)),
            "waiting_events" => reply(host.waiting_events(&id()?)),
            "levers" => reply(host.levers(&id()?)),
            "interrupt" => reply(host.interrupt(&id()?)?),
            "set_mode" => reply(host.set_mode(&id()?, arg(p, "mode")?)?),
            "set_model" => reply(host.set_model(&id()?, &arg::<String>(p, "model")?, arg(p, "effort")?)?),
            "set_config_option" => {
                reply(host.set_config_option(&id()?, &arg::<String>(p, "config_id")?, arg(p, "value")?)?)
            }
            "grant_dirs" => reply(host.grant_dirs(&id()?, &arg::<Vec<String>>(p, "dirs")?)?),
            "answer_permission" => reply(host.answer_permission(
                &id()?,
                &arg::<String>(p, "tool_use_id")?,
                &arg::<String>(p, "request_id")?,
                arg(p, "decision")?,
                arg(p, "scope")?,
                arg::<Option<String>>(p, "reason")?.as_deref(),
            )?),
            "answer_question" => reply(host.answer_question(
                &id()?,
                &arg::<String>(p, "tool_use_id")?,
                &arg::<String>(p, "request_id")?,
                &arg::<Vec<_>>(p, "answers")?,
            )?),
            "detach" => {
                host.detach(&id()?, &arg::<String>(p, "tab_id")?);
                Ok(Value::Null)
            }
            "publish" => {
                host.publish(&id()?, &arg::<String>(p, "kind")?, arg(p, "fields")?);
                Ok(Value::Null)
            }
            "tool_output" => reply(host.tool_output(&id()?, &arg::<String>(p, "tool_use_id")?)),
            "tool_before_state" => reply(commands::tool_before_state(
                host,
                &id()?,
                &arg::<String>(p, "tool_use_id")?,
                &arg::<String>(p, "cwd")?,
            )?),
            "tool_diff" => reply(commands::tool_diff(
                host,
                &id()?,
                &arg::<String>(p, "tool_use_id")?,
                &arg::<String>(p, "cwd")?,
            )?),
            "session_diff" => reply(commands::session_diff(host, &id()?, &arg::<String>(p, "cwd")?)?),
            "revert_tool_hunk" => reply(commands::revert_tool_hunk(
                host,
                &id()?,
                &arg::<String>(p, "tool_use_id")?,
                &arg::<String>(p, "cwd")?,
                &arg::<String>(p, "path")?,
                arg(p, "hunk_index")?,
                &arg::<String>(p, "fingerprint")?,
            )?),
            "history" => {
                let (session_id, agent_id) = (id()?, arg::<String>(p, "agent_id")?);
                let source = arg::<Option<String>>(p, "from_session_id")?.unwrap_or_else(|| session_id.clone());
                let agent = agent_id.clone();
                let tail = tauri::async_runtime::block_on(commands::history_reply(
                    host,
                    session_id,
                    move || commands::history_source(&source, &agent),
                    agent_id,
                    arg(p, "up_to_prompt_ts")?,
                    arg(p, "cwd")?,
                ));
                reply(tail)
            }
            "history_page" => reply(commands::history_page(
                host,
                id()?,
                arg(p, "from_session_id")?,
                arg(p, "agent_id")?,
                arg(p, "cursor")?,
                arg(p, "cwd")?,
            )?),
            "orphans" => reply(self.orphans.take()),
            "terminate_orphan" => reply(super::ownership::terminate_orphan(
                &host.registry,
                &id()?,
                arg(p, "child_pid")?,
                &arg::<String>(p, "agent_id")?,
            )?),
            "checkpoint_snapshot" => reply(crate::checkpoint::snapshot_locked(
                id()?,
                arg(p, "repo_path")?,
                arg(p, "prompt_ts")?,
            )?),
            "claims.claim" => {
                let mut want: Claim = arg(p, "want")?;
                // The daemon holds every child now, so it is the process whose death orphans them.
                want.tori_pid = std::process::id();
                reply(host.registry.claim(&id()?, want))
            }
            "claims.release" => reply(host.registry.release(&id()?, &arg::<String>(p, "tab_id")?)),
            "claims.held_by" => reply(
                host.registry
                    .held_by(&arg::<String>(p, "agent")?, &arg::<String>(p, "profile")?),
            ),
            "claims.held_here" => reply(host.registry.held_here()),
            "claims.profile_of" => reply(host.registry.profile_of(&id()?)),
            "claims.account_of" => reply(host.registry.account_of(&id()?)),
            "claims.agent_of" => reply(host.registry.agent_of(&id()?)),
            "claims.sessions_with_live_child" => {
                reply(host.registry.sessions_with_live_child(&arg::<Vec<String>>(p, "ids")?))
            }
            "claims.forget" => {
                host.registry.forget(&id()?);
                Ok(Value::Null)
            }
            other => Err(format!("no chat call {other}")),
        }
    }
}

fn note_mark(id: &str, marked: Result<(), String>) {
    if let Err(e) = marked {
        eprintln!("tori daemon: open-turn mark for {id} not written: {e}");
    }
}

fn mergeable(held: &mut ChatEvent, next: &ChatEvent) -> bool {
    use ChatEvent::{TextDelta, ThinkingDelta};
    match (held, next) {
        (
            TextDelta {
                turn_id,
                text,
                agent_id,
                ..
            },
            TextDelta {
                turn_id: t,
                text: more,
                agent_id: a,
                ..
            },
        )
        | (
            ThinkingDelta {
                turn_id,
                text,
                agent_id,
                ..
            },
            ThinkingDelta {
                turn_id: t,
                text: more,
                agent_id: a,
                ..
            },
        ) if turn_id == t && agent_id == a => {
            text.push_str(more);
            true
        }
        _ => false,
    }
}

fn is_delta(event: &ChatEvent) -> bool {
    matches!(event, ChatEvent::TextDelta { .. } | ChatEvent::ThinkingDelta { .. })
}

fn coalesce(rx: Receiver<ChatEvent>, mut out: impl FnMut(ChatEvent), window: Duration) {
    let mut held: Option<(ChatEvent, Instant)> = None;
    loop {
        let next = match &held {
            None => match rx.recv() {
                Ok(event) => event,
                Err(_) => break,
            },
            Some((_, since)) => match rx.recv_timeout(window.saturating_sub(since.elapsed())) {
                Ok(event) => event,
                Err(RecvTimeoutError::Timeout) => {
                    if let Some((event, _)) = held.take() {
                        out(event);
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            },
        };
        if let Some((event, _)) = held.as_mut() {
            if mergeable(event, &next) {
                continue;
            }
        }
        if let Some((event, _)) = held.take() {
            out(event);
        }
        if is_delta(&next) {
            held = Some((next, Instant::now()));
        } else {
            out(next);
        }
    }
    if let Some((event, _)) = held {
        out(event);
    }
}

// A chat idle as composed: live, no turn running, and not stopped at a spend ceiling.
pub fn pr_wake(served: &Arc<Served>, states: Arc<crate::rpc::states::SessionStates>) {
    let deliver = Arc::downgrade(served);
    crate::rpc::pr_wake::start(
        move |session| {
            use crate::rpc::states::{SessionState, Source};
            crate::settings::pr_watch()
                && states
                    .shown()
                    .get(session)
                    .is_some_and(|s| s.state == SessionState::Idle && s.source == Source::Chat)
        },
        move |session, text| {
            let served = deliver.upgrade().ok_or("the daemon is stopping")?;
            served.deliver(
                session,
                crate::rpc::events::from_tori("pr_watch", None, &text),
                TurnBy::Watcher,
            )
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn text(turn: &str, t: &str) -> ChatEvent {
        ChatEvent::TextDelta {
            session_id: "s1".into(),
            turn_id: turn.into(),
            text: t.into(),
            agent_id: None,
        }
    }

    fn run(window: Duration, feed: impl FnOnce(&std::sync::mpsc::Sender<ChatEvent>)) -> Vec<ChatEvent> {
        let (tx, rx) = channel();
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        let worker = thread::spawn(move || coalesce(rx, |e| sink.lock().unwrap().push(e), window));
        feed(&tx);
        drop(tx);
        worker.join().unwrap();
        let events = out.lock().unwrap().clone();
        events
    }

    #[test]
    fn deltas_of_one_turn_go_as_one_and_order_holds() {
        let ended = ChatEvent::SessionEnded {
            session_id: "s1".into(),
            reason: None,
        };
        let sent = run(Duration::from_secs(60), |tx| {
            for t in ["a", "b", "c"] {
                tx.send(text("t1", t)).unwrap();
            }
            tx.send(text("t2", "d")).unwrap();
            tx.send(ended.clone()).unwrap();
            tx.send(text("t2", "e")).unwrap();
        });
        assert_eq!(sent, vec![text("t1", "abc"), text("t2", "d"), ended, text("t2", "e")]);
    }
}
