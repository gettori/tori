//! A side chat: a fork of a chat's session that may read and change nothing.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use super::model::PermissionMode;

pub const REFUSED: &str = "This is a side chat: it can read and answer, and it cannot change anything.";

/// How an agent is held to reading. An agent missing here has no mode Tori can
/// confirm as read-only, so it gets no side chat and no second opinion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadOnly {
    /// A launch flag, confirmed from the mode the session reports it started in.
    Flag(&'static str),
    /// A `mode` config option, set and confirmed before the first turn.
    Option(&'static str),
}

impl ReadOnly {
    pub fn mode(self) -> &'static str {
        match self {
            Self::Flag(mode) | Self::Option(mode) => mode,
        }
    }
}

const READ_ONLY: &[(&str, ReadOnly)] = &[
    ("claude", ReadOnly::Flag("plan")),
    ("codex", ReadOnly::Option("read-only")),
];

pub fn read_only(agent: &str) -> Option<ReadOnly> {
    READ_ONLY.iter().find(|(id, _)| *id == agent).map(|(_, how)| *how)
}

pub fn read_only_agents() -> Vec<String> {
    READ_ONLY.iter().map(|(id, _)| (*id).to_string()).collect()
}

/// The agents a side chat can be opened on, for the webview to offer it.
#[tauri::command]
pub fn chat_side_agents() -> Vec<String> {
    read_only_agents()
}

struct Side {
    parent: String,
    how: ReadOnly,
    confirmed: bool,
    asked: bool,
}

static SIDES: LazyLock<Mutex<HashMap<String, Side>>> = LazyLock::new(Mutex::default);

fn sides() -> std::sync::MutexGuard<'static, HashMap<String, Side>> {
    SIDES.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn mark(session: &str, parent: &str, how: ReadOnly) {
    let side = Side {
        parent: parent.to_string(),
        how,
        confirmed: matches!(how, ReadOnly::Flag(_)),
        asked: false,
    };
    sides().insert(session.to_string(), side);
    super::usage::adopt(session, parent);
}

pub fn forget(session: &str) {
    if sides().remove(session).is_some() {
        super::usage::forget_parent(session);
    }
}

pub fn parent(session: &str) -> Option<String> {
    sides().get(session).map(|s| s.parent.clone())
}

pub fn is_side(session: &str) -> bool {
    sides().contains_key(session)
}

pub fn may_send(session: &str) -> bool {
    sides().get(session).is_none_or(|s| s.confirmed)
}

// An option-held agent opens in its own default mode, so the mode it starts in
// says nothing until the option is confirmed.
pub fn left_lock(session: &str, mode: &PermissionMode) -> bool {
    sides()
        .get(session)
        .is_some_and(|s| s.confirmed && mode.as_str() != s.how.mode())
}

#[derive(Debug, PartialEq, Eq)]
pub enum ModeStep {
    Hold,
    Set(&'static str),
    Left(String),
    Unheld,
}

// Every `ConfigOptions` carries the agent's whole option set, so one without a
// mode option means the agent has no lever to hold.
pub fn on_mode_option(session: &str, current: Option<&str>) -> ModeStep {
    let mut all = sides();
    let Some(side) = all.get_mut(session).filter(|s| matches!(s.how, ReadOnly::Option(_))) else {
        return ModeStep::Hold;
    };
    let Some(current) = current else {
        return ModeStep::Unheld;
    };
    let held = side.how.mode();
    if current == held {
        side.confirmed = true;
        return ModeStep::Hold;
    }
    if side.confirmed {
        return ModeStep::Left(current.to_string());
    }
    if side.asked {
        return ModeStep::Hold;
    }
    side.asked = true;
    ModeStep::Set(held)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_marked_session_is_a_side_chat_and_forgetting_unmarks_it() {
        assert!(!is_side("side-a"));
        mark("side-a", "parent-a", ReadOnly::Flag("plan"));
        assert!(is_side("side-a"));
        assert_eq!(parent("side-a").as_deref(), Some("parent-a"));
        assert_eq!(super::super::usage::parent_of("side-a"), "parent-a");
        forget("side-a");
        assert!(!is_side("side-a"));
        assert_eq!(parent("side-a"), None);
        assert_eq!(super::super::usage::parent_of("side-a"), "side-a");
    }

    #[test]
    fn a_side_chat_leaves_the_lock_on_any_mode_but_plan() {
        mark("side-b", "parent-b", ReadOnly::Flag("plan"));
        assert!(!left_lock("side-b", &PermissionMode::new("plan")));
        assert!(left_lock("side-b", &PermissionMode::new("default")));
        assert!(!left_lock("not-a-side", &PermissionMode::new("default")));
        forget("side-b");
    }

    #[test]
    fn an_option_held_side_chat_asks_once_confirms_then_closes_on_a_change() {
        mark("side-c", "parent-c", ReadOnly::Option("read-only"));
        assert!(!may_send("side-c"));
        assert!(
            !left_lock("side-c", &PermissionMode::new("agent")),
            "its opening mode is not the lock's yet"
        );
        assert_eq!(on_mode_option("side-c", Some("agent")), ModeStep::Set("read-only"));
        assert_eq!(on_mode_option("side-c", Some("agent")), ModeStep::Hold, "asked once");
        assert!(!may_send("side-c"));
        assert_eq!(on_mode_option("side-c", Some("read-only")), ModeStep::Hold);
        assert!(may_send("side-c"));
        assert_eq!(on_mode_option("side-c", Some("agent")), ModeStep::Left("agent".into()));
        assert_eq!(on_mode_option("side-c", None), ModeStep::Unheld);
        assert!(left_lock("side-c", &PermissionMode::new("agent")));
        forget("side-c");
        assert!(may_send("side-c"));
    }

    #[test]
    fn claude_and_codex_have_a_known_read_only_mode() {
        assert_eq!(read_only("claude"), Some(ReadOnly::Flag("plan")));
        assert_eq!(read_only("codex"), Some(ReadOnly::Option("read-only")));
        assert_eq!(read_only("opencode"), None);
    }
}
