//! The issues a chat touched: read through `issues.get`, or named by URL in a
//! message the person sent. Each is kept with its repo, so `#92` in one project
//! never answers for `#92` in another. Only a person turns one into a link.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::SystemTime;

const CAP: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mention {
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

pub type Mentions = BTreeMap<String, Vec<Mention>>;

#[cfg(test)]
thread_local! {
    static TEST_SEAM: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn seam(file: PathBuf) {
    TEST_SEAM.with(|s| *s.borrow_mut() = Some(file));
}

fn store_path() -> PathBuf {
    #[cfg(test)]
    if let Some(file) = TEST_SEAM.with(|s| s.borrow().clone()) {
        return file;
    }
    crate::owned_state::config_dir().join("session_issues.json")
}

fn mention(repo: &str, number: u64) -> Option<Mention> {
    let (owner, repo) = repo.split_once('/')?;
    Some(Mention {
        owner: owner.to_lowercase(),
        repo: repo.to_lowercase(),
        number,
    })
}

pub fn qualified(key: &str, origin: &str) -> Option<Mention> {
    let canonical = crate::issues::canonical_key(key, origin);
    let full = if canonical.contains('#') {
        canonical
    } else {
        format!("{origin}#{canonical}")
    };
    let (repo, number) = crate::issues::split_key(&full)?;
    mention(&repo, number)
}

pub fn mentions_in(text: &str) -> Vec<Mention> {
    static URL: OnceLock<Regex> = OnceLock::new();
    let url = URL.get_or_init(|| {
        Regex::new(r"https?://[^\s/]+/([\w.-]+)/([\w.-]+)(?:/-)?/issues/([1-9]\d*)\b").expect("a valid pattern")
    });
    let mut out: Vec<Mention> = Vec::new();
    for c in url.captures_iter(text) {
        let Ok(number) = c[3].parse::<u64>() else { continue };
        if let Some(m) = mention(&format!("{}/{}", &c[1], &c[2]), number) {
            if !out.contains(&m) {
                out.push(m);
            }
        }
    }
    out
}

fn noted(list: &mut Vec<Mention>, found: &[Mention]) -> bool {
    let before = list.len();
    for m in found {
        if !list.contains(m) {
            list.push(m.clone());
        }
    }
    let changed = list.len() != before;
    if list.len() > CAP {
        list.drain(..list.len() - CAP);
    }
    changed
}

fn load(path: &Path) -> Result<Mentions, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{} does not parse: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Mentions::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn save(path: &Path, mentions: &Mentions) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(mentions).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(path, &json)
}

type Stamp = (PathBuf, Option<SystemTime>);
static CACHE: OnceLock<Mutex<(Option<Stamp>, Mentions)>> = OnceLock::new();

pub fn all() -> Mentions {
    let path = store_path();
    let stamp = Some((path.clone(), std::fs::metadata(&path).and_then(|m| m.modified()).ok()));
    let cache = CACHE.get_or_init(|| Mutex::new((None, Mentions::default())));
    let mut held = cache.lock().unwrap_or_else(PoisonError::into_inner);
    if held.0 != stamp || stamp.as_ref().is_some_and(|(_, at)| at.is_none()) {
        let mentions = load(&path).unwrap_or_else(|e| {
            eprintln!("tori: issue mentions unreadable, Cmd+K finds chats by name only: {e}");
            Mentions::default()
        });
        *held = (stamp, mentions);
    }
    held.1.clone()
}

fn change(edit: impl FnOnce(&mut Mentions) -> bool) -> Result<bool, String> {
    let _held = crate::exec::cross_process_store_lock("session_issues")?;
    let path = store_path();
    let mut mentions = load(&path)?;
    if !edit(&mut mentions) {
        return Ok(false);
    }
    save(&path, &mentions)?;
    Ok(true)
}

// Logged rather than returned: the read or the send it rides on has already happened.
pub fn record(session: &str, found: &[Mention]) -> bool {
    if found.is_empty() {
        return false;
    }
    change(|all| noted(all.entry(session.to_string()).or_default(), found)).unwrap_or_else(|e| {
        eprintln!("tori: issue mentions for {session} were not saved: {e}");
        false
    })
}

pub fn forget(session: &str) -> Result<(), String> {
    change(|all| all.remove(session).is_some()).map(|_| ())
}

#[tauri::command(async)]
pub fn session_issues_list() -> Mentions {
    all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(owner: &str, repo: &str, number: u64) -> Mention {
        Mention {
            owner: owner.into(),
            repo: repo.into(),
            number,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-session-issues-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("session_issues.json");
        seam(file.clone());
        file
    }

    #[test]
    fn a_key_is_kept_with_its_repo() {
        assert_eq!(qualified("92", "gettori/tori"), Some(m("gettori", "tori", 92)));
        assert_eq!(qualified("#92", "gettori/tori"), Some(m("gettori", "tori", 92)));
        assert_eq!(
            qualified("GetTori/Tickets#7", "gettori/tori"),
            Some(m("gettori", "tickets", 7))
        );
        assert_eq!(qualified("ENG-123", "gettori/tori"), None);
    }

    #[test]
    fn issue_urls_are_read_out_of_text_and_pull_requests_are_not() {
        let text = "See https://github.com/GetTori/tickets/issues/32, and \
                    https://gitlab.com/team/app/-/issues/4 plus https://github.com/gettori/tori/pull/46. \
                    Again https://github.com/gettori/tickets/issues/32 and https://github.com/a/b/issues/0";
        assert_eq!(
            mentions_in(text),
            vec![m("gettori", "tickets", 32), m("team", "app", 4)]
        );
        assert!(mentions_in("issue #92 and tickets#7").is_empty());
    }

    #[test]
    fn a_session_keeps_its_newest_mentions_once_each() {
        let mut list = vec![m("o", "r", 1)];
        assert!(!noted(&mut list, &[m("o", "r", 1)]));
        let many: Vec<Mention> = (2..=CAP as u64 + 5).map(|n| m("o", "r", n)).collect();
        assert!(noted(&mut list, &many));
        assert_eq!(list.len(), CAP);
        assert_eq!(list.first(), Some(&m("o", "r", 6)));
        assert_eq!(list.last(), Some(&m("o", "r", CAP as u64 + 5)));
    }

    #[test]
    fn a_recorded_mention_reaches_the_file_and_forgetting_drops_only_that_session() {
        let file = scratch("store");
        assert!(record("chat-a", &[m("gettori", "tori", 92)]));
        assert!(!record("chat-a", &[m("gettori", "tori", 92)]), "nothing new, no write");
        assert!(record("chat-b", &[m("gettori", "tickets", 7)]));
        let on_disk: Mentions = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(on_disk["chat-a"], vec![m("gettori", "tori", 92)]);

        forget("chat-a").unwrap();
        let left = all();
        assert!(!left.contains_key("chat-a"));
        assert_eq!(left["chat-b"], vec![m("gettori", "tickets", 7)]);
    }
}
