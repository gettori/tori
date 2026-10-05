//! The composer queue of each chat session, kept on disk so a reload or a
//! relaunch hands it back.
//!
//! Opaque like `hot_exit`: an entry is a webview `QueuedInput`, and typing it
//! here would duplicate a shape the frontend owns and tests. What belongs to the
//! backend is the file per session, and that it goes when the session does.

use std::path::{Path, PathBuf};

use serde_json::Value;

fn dir() -> PathBuf {
    crate::owned_state::config_dir().join("chat-queues")
}

/// None for an id that is not a bare file name. Session ids are uuids, but the
/// value arrives from the webview and is joined into a path.
fn path_in(dir: &Path, session_id: &str) -> Option<PathBuf> {
    let safe = !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    safe.then(|| dir.join(format!("{session_id}.json")))
}

fn load_in(dir: &Path, session_id: &str) -> Vec<Value> {
    path_in(dir, session_id)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
        .unwrap_or_default()
}

fn save_in(dir: &Path, session_id: &str, queue: &[Value]) -> Result<(), String> {
    let path = path_in(dir, session_id).ok_or_else(|| format!("not a session id: {session_id}"))?;
    if queue.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(queue).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(&path, &json)
}

pub fn load(session_id: &str) -> Vec<Value> {
    load_in(&dir(), session_id)
}

pub fn save(session_id: &str, queue: &[Value]) -> Result<(), String> {
    save_in(&dir(), session_id, queue)
}

/// Drop a deleted session's queue. Best effort: the session is already gone.
pub fn forget(session_id: &str) {
    let _ = save(session_id, &[]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tori-chat-queues-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn entry(id: &str) -> Value {
        json!({ "id": id, "blocks": [{ "type": "text", "text": "later" }] })
    }

    #[test]
    fn round_trips_what_it_was_given_in_order() {
        let d = tmp_dir("round-trip");
        let queue = vec![entry("q2"), entry("q1")];
        save_in(&d, "s-1", &queue).unwrap();
        assert_eq!(load_in(&d, "s-1"), queue);
    }

    #[test]
    fn a_missing_file_is_an_empty_queue() {
        assert!(load_in(&tmp_dir("missing"), "s-1").is_empty());
    }

    #[test]
    fn a_corrupt_file_is_an_empty_queue() {
        let d = tmp_dir("corrupt");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("s-1.json"), "[{\"id\": \"q1\", \"blo").unwrap();
        assert!(load_in(&d, "s-1").is_empty());
    }

    #[test]
    fn saving_an_empty_queue_removes_the_file() {
        let d = tmp_dir("empty");
        save_in(&d, "s-1", &[entry("q1")]).unwrap();
        save_in(&d, "s-1", &[]).unwrap();
        assert!(!d.join("s-1.json").exists());
        save_in(&d, "s-1", &[]).unwrap();
    }

    #[test]
    fn an_id_that_is_not_a_file_name_reaches_no_file() {
        let d = tmp_dir("escape");
        assert!(save_in(&d, "../outside", &[entry("q1")]).is_err());
        assert!(load_in(&d, "../outside").is_empty());
        assert!(!d.parent().unwrap().join("outside.json").exists());
    }
}
