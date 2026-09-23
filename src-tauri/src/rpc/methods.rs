//! `sessions.list` and `session.tail`, read from the same stores the sidebar and
//! the chat panel read.

use std::collections::{BTreeMap, HashSet};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::frame::{RpcError, INTERNAL_ERROR};
use super::server::{Backend, ListParams, TailParams};
use crate::chat::commands::{history_source, read_history};
use crate::chat::host::ChatState;
use crate::chat::model::{cap_output, ChatEvent};
use crate::sessions::{cwd_matches, listed_sessions, SessionIndex, SessionMeta};

const DEFAULT_LIST_LIMIT: usize = 50;
const DEFAULT_TAIL_LIMIT: usize = 50;

#[derive(Serialize)]
struct Row {
    #[serde(flatten)]
    meta: SessionMeta,
    live: bool,
}

/// A session this Tori is running right now, joined from the claims (agent) and
/// the chat host (cwd). A terminal tab's agent has no cwd here.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Live {
    pub agent: String,
    pub cwd: String,
}

fn live_row(id: &str, live: &Live, now: u64) -> SessionMeta {
    SessionMeta {
        id: id.to_string(),
        path: String::new(),
        cwd: live.cwd.clone(),
        branch: String::new(),
        title: String::new(),
        last_active: now,
        created_at: now,
        name: None,
        agent: live.agent.clone(),
        profile: None,
        profile_label: None,
    }
}

/// Indexed rows stamped `live`, with live sessions the index has not seen yet
/// (no transcript written) put first, since they are the newest there are.
fn list(indexed: Vec<SessionMeta>, live: &BTreeMap<String, Live>, params: &ListParams, now: u64) -> Vec<Value> {
    let seen: HashSet<&str> = indexed.iter().map(|m| m.id.as_str()).collect();
    let fresh: Vec<SessionMeta> = live
        .iter()
        .filter(|(id, _)| !seen.contains(id.as_str()))
        .map(|(id, l)| live_row(id, l, now))
        .filter(|m| params.cwd.as_deref().is_none_or(|folder| cwd_matches(&m.cwd, folder)))
        .collect();
    fresh
        .into_iter()
        .chain(indexed)
        .map(|meta| Row { live: live.contains_key(&meta.id), meta })
        .filter(|row| !params.live.unwrap_or(false) || row.live)
        .take(params.limit.unwrap_or(DEFAULT_LIST_LIMIT))
        .filter_map(|row| serde_json::to_value(row).ok())
        .collect()
}

/// The last `limit` events with every tool output capped. Capped here rather
/// than through `ChatHost::cut_outputs`, which would store the full outputs in
/// a live session's small cache and evict the ones the panel is holding.
fn tail(mut events: Vec<ChatEvent>, limit: usize) -> Vec<ChatEvent> {
    let keep = events.len().saturating_sub(limit);
    let mut tail = events.split_off(keep);
    for event in &mut tail {
        if let ChatEvent::ToolCallCompleted { output: Some(output), output_truncated, .. } = event {
            if let Some(cut) = cap_output(output) {
                *output = cut;
                *output_truncated = true;
            }
        }
    }
    tail
}

pub struct TauriBackend {
    pub app: AppHandle,
}

impl TauriBackend {
    fn live(&self) -> BTreeMap<String, Live> {
        let host = &self.app.state::<ChatState>().0;
        let mut live: BTreeMap<String, Live> = host
            .registry
            .held_here()
            .into_iter()
            .map(|(id, agent)| (id, Live { agent, cwd: String::new() }))
            .collect();
        for (id, cwd) in host.live_sessions() {
            live.entry(id).or_default().cwd = cwd;
        }
        live
    }
}

impl Backend for TauriBackend {
    fn sessions_list(&self, params: ListParams) -> Result<Value, RpcError> {
        let indexed = listed_sessions(&self.app.state::<SessionIndex>(), params.cwd.as_deref());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Ok(Value::Array(list(indexed, &self.live(), &params, now)))
    }

    fn session_tail(&self, params: TailParams) -> Result<Value, RpcError> {
        let from = history_source(&params.id, &params.agent);
        let events = tail(read_history(&params.id, &from, &params.agent, None), params.limit.unwrap_or(DEFAULT_TAIL_LIMIT));
        serde_json::to_value(events).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::commands::HistorySource;
    use serde_json::json;

    fn meta(id: &str, cwd: &str, last_active: u64) -> SessionMeta {
        SessionMeta { last_active, ..live_row(id, &Live { agent: "claude".into(), cwd: cwd.into() }, last_active) }
    }

    fn ids(rows: &[Value]) -> Vec<&str> {
        rows.iter().map(|r| r["id"].as_str().unwrap()).collect()
    }

    fn live(entries: &[(&str, &str)]) -> BTreeMap<String, Live> {
        entries.iter().map(|(id, cwd)| (id.to_string(), Live { agent: "codex".into(), cwd: cwd.to_string() })).collect()
    }

    #[test]
    fn rows_are_stamped_live_and_a_live_session_not_yet_indexed_comes_first() {
        let indexed = vec![meta("a", "/p", 30), meta("b", "/p", 20)];
        let rows = list(indexed, &live(&[("b", "/p"), ("new", "/p/wt")]), &ListParams::default(), 99);
        assert_eq!(ids(&rows), ["new", "a", "b"]);
        assert_eq!(rows.iter().map(|r| r["live"].as_bool().unwrap()).collect::<Vec<_>>(), [true, false, true]);
        assert_eq!((rows[0]["agent"].clone(), rows[0]["cwd"].clone()), (json!("codex"), json!("/p/wt")));
    }

    #[test]
    fn live_only_limit_and_cwd_narrow_the_list() {
        let indexed = vec![meta("a", "/p", 30), meta("b", "/p", 20)];
        let only_live = ListParams { live: Some(true), ..Default::default() };
        assert_eq!(ids(&list(indexed.clone(), &live(&[("b", "/p")]), &only_live, 99)), ["b"]);

        let one = ListParams { limit: Some(1), ..Default::default() };
        assert_eq!(ids(&list(indexed.clone(), &live(&[]), &one, 99)), ["a"]);

        // The indexed rows arrive already narrowed; the fresh live ones are narrowed here.
        let under = ListParams { cwd: Some("/p".into()), ..Default::default() };
        assert_eq!(ids(&list(indexed, &live(&[("x", "/elsewhere"), ("y", "/p/sub")]), &under, 99)), ["y", "a", "b"]);
    }

    fn fixture(name: &str) -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/fixtures/sessions")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn a_transcript_tail_is_the_last_events_in_order() {
        let from = HistorySource::Transcript(fixture("subagent-foreground.jsonl"));
        let all = read_history("s1", &from, "claude", None);
        assert!(all.len() > 2, "the fixture has more than the tail: {}", all.len());
        let last = tail(all.clone(), 2);
        assert_eq!(serde_json::to_value(&last).unwrap(), serde_json::to_value(&all[all.len() - 2..]).unwrap());
        assert_eq!(tail(all.clone(), 10_000).len(), all.len());
    }

    #[test]
    fn a_log_tail_is_the_last_events_in_order() {
        let path = std::env::temp_dir().join(format!("tori-rpc-tail-{}-{:?}.jsonl", std::process::id(), std::thread::current().id()));
        let lines: Vec<String> = ["one", "two", "three"]
            .iter()
            .map(|t| {
                serde_json::to_string(&ChatEvent::UserMessage {
                    session_id: "s1".into(),
                    turn_id: "t1".into(),
                    blocks: vec![crate::chat::model::ContentBlock::Text { text: t.to_string() }],
                })
                .unwrap()
            })
            .collect();
        std::fs::write(&path, lines.join("\n")).unwrap();
        let got = tail(read_history("s1", &HistorySource::Log(path.clone()), "codex", None), 2);
        let _ = std::fs::remove_file(&path);
        let texts: Vec<String> = got.iter().map(|e| serde_json::to_value(e).unwrap()["blocks"][0]["text"].as_str().unwrap().to_string()).collect();
        assert_eq!(texts, ["two", "three"]);
    }

    #[test]
    fn an_unknown_session_tails_to_nothing() {
        assert!(read_history("nope", &HistorySource::Missing, "claude", None).is_empty());
        let missing = std::env::temp_dir().join("tori-rpc-tail-missing.jsonl");
        assert!(read_history("nope", &HistorySource::Log(missing), "codex", None).is_empty());
    }
}
