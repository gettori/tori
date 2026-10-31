//! The sessions a chat is tied to, for the chips above its input. Gathered from
//! what Tori already keeps (spawns, worktree origins, links) and from the chat's
//! own transcript, never a store of its own that could drift from them.

use crate::chat::model::ChatEvent;
use serde::Serialize;

// Declared in the order a session's relation wins when it has several: a
// chat this one spawned and later prompted is the chat it spawned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Relation {
    Spawned,
    MadeWorktree,
    Linked,
    Prompted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    From,
    To,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Related {
    pub id: String,
    pub side: Side,
    pub relation: Relation,
}

#[derive(Debug, Default)]
pub struct Facts {
    pub spawner: Option<String>,
    pub spawned: Vec<String>,
    pub maker_of_mine: Option<String>,
    pub in_my_worktrees: Vec<String>,
    pub links: Vec<String>,
    pub steered: Vec<String>,
    pub prompted_by: Vec<String>,
}

pub fn relations_of(me: &str, facts: Facts) -> Vec<Related> {
    let candidates = facts
        .spawner
        .into_iter()
        .map(|id| (id, Side::From, Relation::Spawned))
        .chain(facts.maker_of_mine.map(|id| (id, Side::From, Relation::MadeWorktree)))
        .chain(facts.spawned.into_iter().map(|id| (id, Side::To, Relation::Spawned)))
        .chain(
            facts
                .in_my_worktrees
                .into_iter()
                .map(|id| (id, Side::To, Relation::MadeWorktree)),
        )
        .chain(facts.links.into_iter().map(|id| (id, Side::To, Relation::Linked)))
        .chain(facts.steered.into_iter().map(|id| (id, Side::To, Relation::Prompted)))
        .chain(
            facts
                .prompted_by
                .into_iter()
                .map(|id| (id, Side::From, Relation::Prompted)),
        );
    let mut out: Vec<Related> = Vec::new();
    for (id, side, relation) in candidates {
        if id == me || id.is_empty() {
            continue;
        }
        match out.iter_mut().find(|r| r.id == id) {
            Some(had) if relation < had.relation => {
                had.side = side;
                had.relation = relation;
            }
            Some(_) => {}
            None => out.push(Related { id, side, relation }),
        }
    }
    out
}

/// The sessions a transcript steered through Tori, in order, each once. Claude
/// names the call `mcp__tori__session_steer`; an ACP agent wraps it as
/// `{ server, tool, arguments }`.
pub fn steer_targets(events: &[ChatEvent]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for event in events {
        let ChatEvent::ToolCallStarted { name, input, .. } = event else {
            continue;
        };
        let id = if name == "mcp__tori__session_steer" {
            input["id"].as_str()
        } else if input["server"] == "tori" && input["tool"] == "session_steer" {
            input["arguments"]["id"].as_str()
        } else {
            None
        };
        if let Some(id) = id.filter(|id| !out.iter().any(|o| o == id)) {
            out.push(id.to_string());
        }
    }
    out
}

/// The sessions whose prompts reached this transcript, wrapped as a peer's
/// note (`<tori kind="steer"|"linked" from="...">`), in order, each once.
pub fn prompt_senders(events: &[ChatEvent]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for event in events {
        let ChatEvent::UserMessage { blocks, .. } = event else {
            continue;
        };
        let [crate::chat::model::ContentBlock::Text { text }] = blocks.as_slice() else {
            continue;
        };
        let Some(from) = peer_sender(text) else { continue };
        if !out.iter().any(|o| o == from) {
            out.push(from.to_string());
        }
    }
    out
}

fn peer_sender(text: &str) -> Option<&str> {
    let rest = text.trim_start();
    let rest = rest
        .strip_prefix("<tori kind=\"steer\" from=\"")
        .or_else(|| rest.strip_prefix("<tori kind=\"linked\" from=\""))?;
    rest.split_once('"').map(|(from, _)| from).filter(|f| !f.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::model::ToolKind;
    use serde_json::json;

    fn call(name: &str, input: serde_json::Value) -> ChatEvent {
        ChatEvent::ToolCallStarted {
            session_id: "me".into(),
            turn_id: "t".into(),
            tool_use_id: "u".into(),
            name: name.into(),
            input,
            kind: ToolKind::Other,
            locations: vec![],
            title: None,
            secret: None,
        }
    }

    fn one(facts: Facts) -> Vec<(String, Side, Relation)> {
        relations_of("me", facts)
            .into_iter()
            .map(|r| (r.id, r.side, r.relation))
            .collect()
    }

    #[test]
    fn each_fact_becomes_its_relation() {
        assert_eq!(
            one(Facts {
                spawner: Some("p".into()),
                ..Default::default()
            }),
            vec![("p".into(), Side::From, Relation::Spawned)]
        );
        assert_eq!(
            one(Facts {
                maker_of_mine: Some("m".into()),
                ..Default::default()
            }),
            vec![("m".into(), Side::From, Relation::MadeWorktree)]
        );
        assert_eq!(
            one(Facts {
                spawned: vec!["c".into()],
                ..Default::default()
            }),
            vec![("c".into(), Side::To, Relation::Spawned)]
        );
        assert_eq!(
            one(Facts {
                in_my_worktrees: vec!["w".into()],
                ..Default::default()
            }),
            vec![("w".into(), Side::To, Relation::MadeWorktree)]
        );
        assert_eq!(
            one(Facts {
                links: vec!["l".into()],
                ..Default::default()
            }),
            vec![("l".into(), Side::To, Relation::Linked)]
        );
        assert_eq!(
            one(Facts {
                steered: vec!["s".into()],
                ..Default::default()
            }),
            vec![("s".into(), Side::To, Relation::Prompted)]
        );
    }

    #[test]
    fn prompt_senders_come_from_peer_notes_anywhere_in_the_transcript() {
        let user = |text: &str| ChatEvent::UserMessage {
            session_id: "me".into(),
            turn_id: "t".into(),
            blocks: vec![crate::chat::model::ContentBlock::Text { text: text.into() }],
        };
        let mut events = vec![user("<tori kind=\"steer\" from=\"early\">\nhi\n</tori>")];
        events.extend((0..500).map(|i| user(&format!("prompt {i}"))));
        events.push(user("<tori kind=\"linked\" from=\"peer\">\nyo\n</tori>"));
        events.push(user("<tori kind=\"brief\">\nnot a peer\n</tori>"));
        assert_eq!(prompt_senders(&events), vec!["early".to_string(), "peer".to_string()]);
        assert_eq!(
            one(Facts {
                prompted_by: vec!["early".into()],
                ..Default::default()
            }),
            vec![("early".into(), Side::From, Relation::Prompted)]
        );
    }

    #[test]
    fn steer_targets_come_from_the_whole_transcript_in_both_shapes() {
        let mut events = vec![call("mcp__tori__session_steer", json!({ "id": "early", "text": "hi" }))];
        events.extend((0..500).map(|i| call("Bash", json!({ "command": format!("echo {i}") }))));
        events.push(call(
            "execute",
            json!({ "server": "tori", "tool": "session_steer", "arguments": { "id": "acp" } }),
        ));
        events.push(call("mcp__tori__session_steer", json!({ "id": "early" })));
        assert_eq!(steer_targets(&events), vec!["early".to_string(), "acp".to_string()]);
    }
}
