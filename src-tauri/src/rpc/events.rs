//! What goes out on the subscription topics. Every session event carries the
//! same envelope, `{kind, id, project, folder, ts}`, so a subscriber can route
//! any of them without knowing which module noticed it.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// Resolved once per session, because finding the project reads the config and
// lists the discovery root.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Place {
    pub project: Option<String>,
    pub folder: Option<String>,
}

impl Place {
    pub fn of(folder: &str) -> Self {
        if folder.is_empty() {
            return Self::default();
        }
        Self {
            project: project_of(folder, &crate::config::discovered_project_dirs()),
            folder: Some(folder.to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    Closed,
    Died,
    Killed,
}

// On the wire: "user", {"session": id}, {"tab": id}, "local" for a caller Tori
// did not spawn, "agent" for a turn the agent opened itself, "watcher" for a
// wake the autopilot's watcher sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnBy {
    User,
    Session(String),
    Tab(String),
    Local,
    Agent,
    Watcher,
}

// The deepest project holding `cwd`: a worktree sits inside its project's
// folder, and `create_worktree` wants the project, not the worktree.
pub fn project_of(cwd: &str, projects: &[PathBuf]) -> Option<String> {
    let cwd = Path::new(cwd);
    projects
        .iter()
        .filter(|project| cwd.starts_with(project))
        .max_by_key(|project| project.components().count())
        .map(|project| project.to_string_lossy().into_owned())
}

/// Text Tori writes into a chat itself, marked so the chat shows it as Tori's
/// and not as the user's. `from` names the session that sent it, when one did.
pub fn from_tori(kind: &str, from: Option<&str>, text: &str) -> String {
    let from = from.map(|id| format!(" from=\"{id}\"")).unwrap_or_default();
    format!("<tori kind=\"{kind}\"{from}>\n{text}\n</tori>")
}

/// The notes `text` opens with, and what follows them. A queued note travels
/// on the user's own message, and an agent may hand that message back as one
/// string rather than as the blocks it was sent as.
pub fn split_notes(text: &str) -> (Vec<&str>, &str) {
    const END: &str = "\n</tori>";
    let mut notes = Vec::new();
    let mut rest = text;
    loop {
        let t = rest.trim_start();
        let Some(end) = t.starts_with("<tori kind=\"").then(|| t.find(END)).flatten() else { break };
        notes.push(&t[..end + END.len()]);
        rest = &t[end + END.len()..];
    }
    if notes.is_empty() {
        return (notes, text);
    }
    (notes, rest.trim_start())
}

/// The `kind` of a note, when `text` is exactly one.
pub fn note_kind(text: &str) -> Option<&str> {
    match split_notes(text) {
        (notes, "") if notes.len() == 1 => notes[0].strip_prefix("<tori kind=\"")?.split('"').next(),
        _ => None,
    }
}

/// The two kinds that state a Topic in full, so a newer one makes an older
/// one still waiting worthless.
pub fn is_topic_note(text: &str) -> bool {
    matches!(note_kind(text), Some("topic" | "topic-changed"))
}

pub fn same_folder(a: &str, b: &str) -> bool {
    crate::sessions::cwd_matches(a, b) && crate::sessions::cwd_matches(b, a)
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or_default()
}

pub fn session_event(kind: &str, id: &str, place: &Place, fields: Value) -> Value {
    let mut event = json!({
        "kind": kind,
        "id": id,
        "project": place.project,
        "folder": place.folder,
        "ts": now_ms(),
    });
    if let (Some(event), Value::Object(fields)) = (event.as_object_mut(), fields) {
        event.extend(fields);
    }
    event
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worktree_belongs_to_the_deepest_project_holding_it() {
        let projects = vec![PathBuf::from("/code/work"), PathBuf::from("/code/work/tori")];
        assert_eq!(project_of("/code/work/tori/wt/feat", &projects).as_deref(), Some("/code/work/tori"));
        assert_eq!(project_of("/elsewhere", &projects), None);
    }

    #[test]
    fn a_wake_is_credited_to_the_watcher_on_the_wire() {
        assert_eq!(serde_json::to_value(TurnBy::Watcher).unwrap(), "watcher");
        assert_eq!(serde_json::to_value(TurnBy::Session("s1".into())).unwrap(), json!({ "session": "s1" }));
    }

    #[test]
    fn fields_sit_beside_the_envelope() {
        let place = Place { project: Some("/p".into()), folder: Some("/p/wt".into()) };
        let event = session_event("session.ended", "s1", &place, json!({ "reason": EndReason::Killed }));
        assert_eq!(event["kind"], "session.ended");
        assert_eq!(event["id"], "s1");
        assert_eq!(event["project"], "/p");
        assert_eq!(event["folder"], "/p/wt");
        assert_eq!(event["reason"], "killed");
        assert!(event["ts"].as_u64().unwrap() > 0);
    }
}
