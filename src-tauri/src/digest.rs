//! Since you looked: what finished while the person was away, and what still
//! waits on them, read out of the needs-you log. Lines are counted here, at
//! read time, since a finished-turn row knows its session but not its turn.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::chat::host::ChatState;
use crate::chat::model::Verdict;
use crate::needs_you_log::{Event, Kind, LogRead};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lines {
    pub added: u64,
    pub removed: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub session: String,
    pub folder: String,
    pub branch: Option<String>,
    pub project: String,
    pub title: String,
    pub chat: bool,
    pub turns: u32,
    pub first_ts: u64,
    pub last_ts: u64,
    pub lines: Option<Lines>,
    pub verdict: Option<Verdict>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Digest {
    pub since: u64,
    pub as_of: u64,
    /// A composition has run since launch, so `waiting` is complete.
    pub ready: bool,
    /// Newest first.
    pub finished: Vec<Finished>,
    pub waiting: Vec<Event>,
    /// Pull requests opened, merged or failing, and usage limits hit and
    /// resumed, newest first.
    pub happened: Vec<Event>,
}

/// One row per session, without lines.
pub fn group(read: &LogRead) -> Vec<Finished> {
    let mut by_session: BTreeMap<&str, Finished> = BTreeMap::new();
    for e in &read.done {
        let Some(session) = e.session.as_deref() else { continue };
        let row = by_session.entry(session).or_insert_with(|| Finished {
            session: session.to_string(),
            folder: e.folder.clone(),
            branch: e.branch.clone(),
            project: e.project.clone(),
            title: e.title.clone(),
            chat: e.chat,
            turns: 0,
            first_ts: e.ts,
            last_ts: e.ts,
            lines: None,
            verdict: read.verdicts.get(session).map(|c| c.verdict),
        });
        row.turns += 1;
        row.last_ts = e.ts;
        row.title.clone_from(&e.title);
    }
    let mut rows: Vec<Finished> = by_session.into_values().collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.last_ts));
    rows
}

pub fn read(since: Option<u64>) -> Digest {
    let read = crate::needs_you_log::since(since);
    let mut finished = group(&read);
    for row in finished.iter_mut().filter(|r| r.chat) {
        row.lines = crate::checkpoint::session_lines_since(&row.folder, &row.session, row.first_ts / 1000)
            .map(|(added, removed)| Lines { added, removed });
    }
    Digest {
        since: read.since,
        as_of: read.as_of,
        ready: crate::needs_you_log::composed(),
        finished,
        waiting: read.waiting,
        happened: read.happened,
    }
}

/// A limit row for the account `session` runs as, named the way the session
/// list names it.
pub fn note_limit(
    registry: &impl crate::chat::client::Claimed,
    kind: Kind,
    session: &str,
    folder: &str,
    resets_at: u64,
) -> bool {
    let Some((agent, profile)) = registry.account_of(session) else {
        return false;
    };
    let label = crate::sessions::profile_label(&crate::accounts::load(), &agent, Some(&profile));
    let title = label.map_or_else(|| agent.clone(), |l| format!("{agent} {l}"));
    crate::needs_you_log::note_limit(kind, &format!("{agent}/{profile}"), resets_at, session, folder, title)
}

#[tauri::command(async)]
pub fn digest_list(since: Option<u64>) -> Digest {
    read(since)
}

#[tauri::command]
pub fn digest_looked(at: u64) {
    crate::needs_you_log::looked(at);
}

/// Tori sent a chat its continue after the limit reset, by the setting or by
/// the banner's button. `resets_at` is the reset it waited for, epoch seconds.
#[tauri::command]
pub fn digest_limit_resumed(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChatState>,
    session_id: String,
    folder: String,
    resets_at: u64,
) {
    if note_limit(&state.0.registry, Kind::LimitResumed, &session_id, &folder, resets_at) {
        crate::rpc::publish_needs_you(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::needs_you_log::{Checked, Kind};

    fn done(session: &str, ts: u64, chat: bool) -> Event {
        Event {
            id: format!("{session}-{ts}"),
            ts,
            session: Some(session.into()),
            folder: "/p/repo".into(),
            branch: None,
            project: "repo".into(),
            title: format!("{session} at {ts}"),
            kind: Kind::Done,
            resolved_at: None,
            settled: false,
            chat,
        }
    }

    #[test]
    fn finished_turns_group_per_session_newest_first() {
        let read = LogRead {
            since: 0,
            as_of: 100,
            done: vec![done("a", 10, true), done("b", 20, false), done("a", 30, true)],
            waiting: Vec::new(),
            happened: Vec::new(),
            verdicts: BTreeMap::from([(
                "a".to_string(),
                Checked {
                    ts: 30,
                    verdict: Verdict::Verified,
                },
            )]),
        };
        let rows = group(&read);
        let sessions: Vec<(&str, u32, u64, u64)> = rows
            .iter()
            .map(|r| (r.session.as_str(), r.turns, r.first_ts, r.last_ts))
            .collect();
        assert_eq!(sessions, [("a", 2, 10, 30), ("b", 1, 20, 20)]);
        assert_eq!(rows[0].title, "a at 30");
        assert_eq!(rows[0].verdict, Some(Verdict::Verified));
        assert_eq!(rows[1].verdict, None);
    }

    #[test]
    fn a_pty_session_gets_no_lines_or_verdict() {
        let read = LogRead {
            since: 0,
            as_of: 100,
            done: vec![done("t", 10, false)],
            waiting: Vec::new(),
            happened: Vec::new(),
            verdicts: BTreeMap::new(),
        };
        let row = &group(&read)[0];
        assert_eq!((row.lines.as_ref(), row.verdict), (None, None));
    }
}
