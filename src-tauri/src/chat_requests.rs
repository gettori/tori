//! Not the composer queue: that file is the webview's and is rewritten whole,
//! so an entry added here would be lost.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub from: String,
    pub text: String,
    #[serde(default)]
    pub attach: Vec<String>,
    pub at: u64,
}

#[cfg(test)]
thread_local! {
    static TEST_SEAM: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn seam(dir: PathBuf) {
    TEST_SEAM.with(|s| *s.borrow_mut() = Some(dir));
}

fn dir() -> PathBuf {
    #[cfg(test)]
    if let Some(dir) = TEST_SEAM.with(|s| s.borrow().clone()) {
        return dir;
    }
    crate::owned_state::config_dir().join("chat-requests")
}

// Session ids are uuids, but one arrives from an agent's call and is joined
// into a path.
fn path_in(dir: &Path, session: &str) -> Result<PathBuf, String> {
    let safe = !session.is_empty()
        && session
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    safe.then(|| dir.join(format!("{session}.json")))
        .ok_or_else(|| format!("not a session id: {session}"))
}

fn load(path: &Path) -> Result<Vec<Request>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{} does not parse: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn save(path: &Path, requests: &[Request]) -> Result<(), String> {
    if requests.is_empty() {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(requests).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn list(target: &str) -> Result<Vec<Request>, String> {
    load(&path_in(&dir(), target)?)
}

pub fn add(target: &str, from: &str, text: String, attach: Vec<String>) -> Result<String, String> {
    let path = path_in(&dir(), target)?;
    let _held = crate::exec::cross_process_store_lock("chat_requests")?;
    let mut requests = load(&path)?;
    // One waiting message per sender: an agent that is not related to a chat
    // cannot bury it in requests, only change what it is asking.
    requests.retain(|r| r.from != from);
    let at = crate::unit_origins::now();
    let id = format!("req-{at}-{from}");
    requests.push(Request {
        id: id.clone(),
        from: from.to_string(),
        text,
        attach,
        at,
    });
    save(&path, &requests)?;
    Ok(id)
}

pub fn take(target: &str, id: &str) -> Result<Option<Request>, String> {
    let path = path_in(&dir(), target)?;
    let _held = crate::exec::cross_process_store_lock("chat_requests")?;
    let mut requests = load(&path)?;
    let Some(at) = requests.iter().position(|r| r.id == id) else {
        return Ok(None);
    };
    let taken = requests.remove(at);
    save(&path, &requests)?;
    Ok(Some(taken))
}

pub fn forget(target: &str) -> Result<(), String> {
    let path = path_in(&dir(), target)?;
    let _held = crate::exec::cross_process_store_lock("chat_requests")?;
    save(&path, &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-chat-requests-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        seam(dir.clone());
        dir
    }

    #[test]
    fn a_request_is_added_listed_and_taken_once() {
        scratch("take");
        let id = add("target-1", "from-1", "hi".into(), vec![]).unwrap();
        let listed = list("target-1").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].from.as_str(), listed[0].text.as_str()), ("from-1", "hi"));

        assert_eq!(take("target-1", &id).unwrap().map(|r| r.text), Some("hi".into()));
        assert_eq!(take("target-1", &id).unwrap(), None, "a second accept delivers nothing");
        assert!(list("target-1").unwrap().is_empty());
    }

    #[test]
    fn a_sender_has_one_waiting_message_per_target() {
        scratch("one");
        add("target-3", "from-1", "first".into(), vec![]).unwrap();
        add("target-3", "from-1", "second".into(), vec![]).unwrap();
        add("target-3", "from-2", "other".into(), vec![]).unwrap();
        let texts: Vec<String> = list("target-3").unwrap().into_iter().map(|r| r.text).collect();
        assert_eq!(texts, vec!["second".to_string(), "other".to_string()]);
    }

    #[test]
    fn forgetting_a_session_removes_its_file() {
        let dir = scratch("forget");
        add("target-2", "from-1", "a".into(), vec![]).unwrap();
        add("target-2", "from-2", "b".into(), vec![]).unwrap();
        assert_eq!(list("target-2").unwrap().len(), 2);
        forget("target-2").unwrap();
        assert!(!dir.join("target-2.json").exists());
    }
}
