//! A side chat: a fork of a chat's session that may read and change nothing.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use super::model::PermissionMode;

pub const REFUSED: &str = "This is a side chat: it can read and answer, and it cannot change anything.";

static SIDES: LazyLock<Mutex<HashMap<String, (String, &'static str)>>> = LazyLock::new(Mutex::default);

fn sides() -> std::sync::MutexGuard<'static, HashMap<String, (String, &'static str)>> {
    SIDES.lock().unwrap_or_else(|e| e.into_inner())
}

const READ_ONLY: &[(&str, &str)] = &[("claude", "plan")];

pub fn read_only_mode(agent: &str) -> Option<&'static str> {
    READ_ONLY.iter().find(|(id, _)| *id == agent).map(|(_, mode)| *mode)
}

/// The agents a side chat can be opened on, for the webview to offer it.
#[tauri::command]
pub fn chat_side_agents() -> Vec<String> {
    READ_ONLY.iter().map(|(id, _)| (*id).to_string()).collect()
}

pub fn mark(session: &str, parent: &str, mode: &'static str) {
    sides().insert(session.to_string(), (parent.to_string(), mode));
}

pub fn forget(session: &str) {
    sides().remove(session);
}

pub fn is_side(session: &str) -> bool {
    sides().contains_key(session)
}

pub fn left_lock(session: &str, mode: &PermissionMode) -> bool {
    sides().get(session).is_some_and(|(_, held)| mode.as_str() != *held)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_marked_session_is_a_side_chat_and_forgetting_unmarks_it() {
        assert!(!is_side("side-a"));
        mark("side-a", "parent-a", "plan");
        assert!(is_side("side-a"));
        forget("side-a");
        assert!(!is_side("side-a"));
    }

    #[test]
    fn a_side_chat_leaves_the_lock_on_any_mode_but_plan() {
        mark("side-b", "parent-b", "plan");
        assert!(!left_lock("side-b", &PermissionMode::new("plan")));
        assert!(left_lock("side-b", &PermissionMode::new("default")));
        assert!(!left_lock("not-a-side", &PermissionMode::new("default")));
        forget("side-b");
    }

    #[test]
    fn only_claude_has_a_known_read_only_mode_yet() {
        assert_eq!(read_only_mode("claude"), Some("plan"));
        assert_eq!(read_only_mode("opencode"), None);
    }
}
