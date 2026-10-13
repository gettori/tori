//! The window's end of the chat host, which runs in `tori daemon` (`serve.rs`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tauri::ipc::Channel;

use super::commands::{SpawnRequest, SpawnResult};
use super::host::{Levers, Waiting};
use super::model::{
    ChatConfigValue, ChatEvent, ContentBlock, PermissionDecision, PermissionMode, PermissionScope, QuestionAnswer,
};
use super::ownership::{Claim, ClaimOutcome, Registry};
use super::transport::Emit;
use crate::rpc::events::{EndReason, TurnBy};

enum Sink {
    Webview(Channel<Value>),
    Rust(Emit),
}

pub trait Claimed {
    fn agent_of(&self, session_id: &str) -> Option<String>;
    fn profile_of(&self, session_id: &str) -> Option<String>;
    fn account_of(&self, session_id: &str) -> Option<(String, String)>;
    fn sessions_with_live_child(&self, ids: &[String]) -> Vec<String>;
    fn forget(&self, session_id: &str);
}

impl Claimed for Registry {
    fn agent_of(&self, session_id: &str) -> Option<String> {
        Registry::agent_of(self, session_id)
    }
    fn profile_of(&self, session_id: &str) -> Option<String> {
        Registry::profile_of(self, session_id)
    }
    fn account_of(&self, session_id: &str) -> Option<(String, String)> {
        Registry::account_of(self, session_id)
    }
    fn sessions_with_live_child(&self, ids: &[String]) -> Vec<String> {
        Registry::sessions_with_live_child(self, ids)
    }
    fn forget(&self, session_id: &str) {
        Registry::forget(self, session_id)
    }
}

fn call<T: DeserializeOwned>(method: &str, args: Value) -> Result<T, String> {
    let value = crate::rpc::daemon_chat(method, args)?;
    serde_json::from_value(value).map_err(|e| format!("{method}: {e}"))
}

fn read_or_default<T: DeserializeOwned + Default>(method: &str, args: Value) -> T {
    call(method, args).unwrap_or_default()
}

#[derive(Clone, Default)]
pub struct Claims;

impl Claims {
    pub fn claim(&self, session_id: &str, want: Claim) -> ClaimOutcome {
        call("claims.claim", json!({ "session_id": session_id, "want": want }))
            .unwrap_or(ClaimOutcome::Granted { contested: false })
    }

    pub fn release(&self, session_id: &str, tab_id: &str) -> bool {
        read_or_default("claims.release", json!({ "session_id": session_id, "tab_id": tab_id }))
    }

    pub fn held_here(&self) -> Vec<(String, String)> {
        read_or_default("claims.held_here", json!({}))
    }

    pub fn held_by(&self, agent: &str, profile: &str) -> Vec<String> {
        read_or_default("claims.held_by", json!({ "agent": agent, "profile": profile }))
    }
}

impl Claimed for Claims {
    fn agent_of(&self, session_id: &str) -> Option<String> {
        read_or_default("claims.agent_of", json!({ "session_id": session_id }))
    }
    fn profile_of(&self, session_id: &str) -> Option<String> {
        read_or_default("claims.profile_of", json!({ "session_id": session_id }))
    }
    fn account_of(&self, session_id: &str) -> Option<(String, String)> {
        read_or_default("claims.account_of", json!({ "session_id": session_id }))
    }
    fn sessions_with_live_child(&self, ids: &[String]) -> Vec<String> {
        read_or_default("claims.sessions_with_live_child", json!({ "ids": ids }))
    }
    fn forget(&self, session_id: &str) {
        let _ = call::<Value>("claims.forget", json!({ "session_id": session_id }));
    }
}

#[derive(Clone, Default)]
pub struct Chats {
    pub registry: Claims,
    sinks: Arc<Mutex<HashMap<String, Arc<Sink>>>>,
}

#[derive(Default)]
pub struct ChatState(pub Chats);

impl Chats {
    fn sinks(&self) -> MutexGuard<'_, HashMap<String, Arc<Sink>>> {
        self.sinks.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        crate::rpc::daemon_chat(method, args)
    }

    pub fn call_as<T: DeserializeOwned>(&self, method: &str, args: Value) -> Result<T, String> {
        call(method, args)
    }

    pub fn route(&self, params: &Value) {
        let Some(id) = params["session_id"].as_str() else {
            return;
        };
        let ends = matches!(params["event"]["type"].as_str(), Some("sessionEnded"))
            || (params["event"]["type"] == "sessionError" && params["event"]["fatal"] == true);
        // Out of the map first: a listener may call back into this.
        let sink = if ends {
            self.sinks().remove(id)
        } else {
            self.sinks().get(id).cloned()
        };
        match sink.as_deref() {
            Some(Sink::Webview(channel)) => {
                let _ = channel.send(params["event"].clone());
            }
            Some(Sink::Rust(emit)) => {
                if let Ok(event) = serde_json::from_value::<ChatEvent>(params["event"].clone()) {
                    emit(event);
                }
            }
            None => {}
        }
    }

    fn spawn(&self, req: SpawnRequest, sink: Sink) -> Result<SpawnResult, String> {
        let id = req.session_id.clone();
        // In place before the daemon starts it, so the first event has somewhere to go.
        let previous = self.sinks().insert(id.clone(), Arc::new(sink));
        let spawned = call::<SpawnResult>("spawn", json!({ "req": req }));
        if !matches!(&spawned, Ok(r) if r.spawned.is_some()) {
            let mut sinks = self.sinks();
            match previous {
                Some(previous) => {
                    sinks.insert(id, previous);
                }
                None => {
                    sinks.remove(&id);
                }
            }
        }
        spawned
    }

    pub fn spawn_webview(&self, req: SpawnRequest, channel: Channel<Value>) -> Result<SpawnResult, String> {
        self.spawn(req, Sink::Webview(channel))
    }

    pub fn spawn_session(&self, req: SpawnRequest, emit: Emit) -> Result<SpawnResult, String> {
        self.spawn(req, Sink::Rust(emit))
    }

    pub fn is_live(&self, session_id: &str) -> bool {
        read_or_default("is_live", json!({ "session_id": session_id }))
    }

    pub fn live_sessions(&self) -> Vec<(String, String)> {
        read_or_default("live_sessions", json!({}))
    }

    pub fn live_ids(&self) -> Vec<String> {
        read_or_default("live_ids", json!({}))
    }

    pub fn deliver(
        &self,
        session_id: &str,
        blocks: Vec<ContentBlock>,
        mid_turn: bool,
        by: TurnBy,
    ) -> Result<(), String> {
        call(
            "deliver",
            json!({ "session_id": session_id, "blocks": blocks, "mid_turn": mid_turn, "by": by }),
        )
    }

    pub fn note_for_next_turn(&self, session_id: &str, text: String) {
        let _ = call::<Value>("note_for_next_turn", json!({ "session_id": session_id, "text": text }));
    }

    pub fn send(&self, session_id: &str, blocks: Vec<ContentBlock>) -> Result<(), String> {
        call("send", json!({ "session_id": session_id, "blocks": blocks }))
    }

    pub fn steer(&self, session_id: &str, blocks: Vec<ContentBlock>) -> Result<(), String> {
        call("steer", json!({ "session_id": session_id, "blocks": blocks }))
    }

    pub fn settle(&self, session_id: &str, id: &str, answers: &[String]) -> Result<(), String> {
        call(
            "settle",
            json!({ "session_id": session_id, "id": id, "answers": answers }),
        )
    }

    pub fn set_visible(&self, session_id: &str, visible: bool) -> bool {
        read_or_default("set_visible", json!({ "session_id": session_id, "visible": visible }))
    }

    pub fn close(&self, session_id: &str, reason: EndReason) -> Result<(), String> {
        call("close", json!({ "session_id": session_id, "reason": reason }))
    }

    pub fn waiting(&self, session_id: &str) -> Vec<Waiting> {
        read_or_default("waiting", json!({ "session_id": session_id }))
    }

    pub fn waiting_events(&self, session_id: &str) -> Vec<ChatEvent> {
        read_or_default("waiting_events", json!({ "session_id": session_id }))
    }

    pub fn levers(&self, session_id: &str) -> Option<Levers> {
        read_or_default("levers", json!({ "session_id": session_id }))
    }

    pub fn interrupt(&self, session_id: &str) -> Result<(), String> {
        call("interrupt", json!({ "session_id": session_id }))
    }

    pub fn set_mode(&self, session_id: &str, mode: PermissionMode) -> Result<(), String> {
        call("set_mode", json!({ "session_id": session_id, "mode": mode }))
    }

    pub fn set_model(&self, session_id: &str, model: &str, effort: Option<String>) -> Result<(), String> {
        call(
            "set_model",
            json!({ "session_id": session_id, "model": model, "effort": effort }),
        )
    }

    pub fn set_config_option(&self, session_id: &str, config_id: &str, value: ChatConfigValue) -> Result<(), String> {
        call(
            "set_config_option",
            json!({ "session_id": session_id, "config_id": config_id, "value": value }),
        )
    }

    pub fn grant_dirs(&self, session_id: &str, dirs: &[String]) -> Result<(), String> {
        call("grant_dirs", json!({ "session_id": session_id, "dirs": dirs }))
    }

    pub fn answer_permission(
        &self,
        session_id: &str,
        tool_use_id: &str,
        request_id: &str,
        decision: PermissionDecision,
        scope: PermissionScope,
        reason: Option<&str>,
    ) -> Result<(), String> {
        call(
            "answer_permission",
            json!({
                "session_id": session_id,
                "tool_use_id": tool_use_id,
                "request_id": request_id,
                "decision": decision,
                "scope": scope,
                "reason": reason,
            }),
        )
    }

    pub fn answer_question(
        &self,
        session_id: &str,
        tool_use_id: &str,
        request_id: &str,
        answers: &[QuestionAnswer],
    ) -> Result<bool, String> {
        call(
            "answer_question",
            json!({
                "session_id": session_id,
                "tool_use_id": tool_use_id,
                "request_id": request_id,
                "answers": answers,
            }),
        )
    }

    pub fn detach(&self, session_id: &str, tab_id: &str) {
        let _ = call::<Value>("detach", json!({ "session_id": session_id, "tab_id": tab_id }));
    }

    pub fn publish(&self, session_id: &str, kind: &str, fields: Value) {
        let _ = call::<Value>(
            "publish",
            json!({ "session_id": session_id, "kind": kind, "fields": fields }),
        );
    }

    pub fn tool_output(&self, session_id: &str, tool_use_id: &str) -> Option<String> {
        read_or_default(
            "tool_output",
            json!({ "session_id": session_id, "tool_use_id": tool_use_id }),
        )
    }
}
