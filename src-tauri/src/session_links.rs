//! Only a person makes or breaks a link: it reaches the store through the
//! window's office, never the rpc socket an agent holds, since a link an agent
//! could make would be one injected agent vouching for another.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::SystemTime;

type Pair = (String, String);

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
struct Links(BTreeSet<Pair>);

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
    crate::owned_state::config_dir().join("session_links.json")
}

fn pair(a: &str, b: &str) -> Pair {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

fn load(path: &Path) -> Result<Links, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{} does not parse: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Links::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn save(path: &Path, links: &Links) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(links).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

type Stamp = (PathBuf, Option<SystemTime>);
static CACHE: OnceLock<Mutex<(Option<Stamp>, Links)>> = OnceLock::new();

fn current() -> Links {
    let path = store_path();
    let stamp = Some((path.clone(), std::fs::metadata(&path).and_then(|m| m.modified()).ok()));
    let cache = CACHE.get_or_init(|| Mutex::new((None, Links::default())));
    let mut held = cache.lock().unwrap_or_else(PoisonError::into_inner);
    if held.0 != stamp || stamp.as_ref().is_some_and(|(_, at)| at.is_none()) {
        let links = load(&path).unwrap_or_else(|e| {
            eprintln!("tori: session links unreadable, linked chats reach only what they are related to: {e}");
            Links::default()
        });
        *held = (stamp, links);
    }
    held.1.clone()
}

pub fn linked(a: &str, b: &str) -> bool {
    current().0.contains(&pair(a, b))
}

pub fn links_of(session: &str) -> Vec<String> {
    current()
        .0
        .into_iter()
        .filter_map(|(a, b)| match (a == session, b == session) {
            (true, _) => Some(b),
            (_, true) => Some(a),
            _ => None,
        })
        .collect()
}

fn change(edit: impl FnOnce(&mut Links)) -> Result<(), String> {
    let _held = crate::exec::cross_process_store_lock("session_links")?;
    let path = store_path();
    let mut links = load(&path)?;
    let before = links.0.clone();
    edit(&mut links);
    if links.0 == before {
        return Ok(());
    }
    save(&path, &links)
}

pub fn link(a: &str, b: &str) -> Result<(), String> {
    if a == b {
        return Err("a session is not linked to itself".into());
    }
    change(|links| {
        links.0.insert(pair(a, b));
    })
}

pub fn unlink(a: &str, b: &str) -> Result<(), String> {
    change(|links| {
        links.0.remove(&pair(a, b));
    })
}

pub fn forget(session: &str) -> Result<(), String> {
    change(|links| links.0.retain(|(a, b)| a != session && b != session))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-session-links-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        seam(dir.join("session_links.json"));
        dir
    }

    #[test]
    fn a_link_holds_both_ways_until_it_is_broken() {
        scratch("both");
        link("b", "a").unwrap();
        assert!(linked("a", "b") && linked("b", "a"));
        assert_eq!(links_of("a"), vec!["b".to_string()]);
        assert_eq!(links_of("b"), vec!["a".to_string()]);
        unlink("a", "b").unwrap();
        assert!(!linked("a", "b"));
    }

    #[test]
    fn deleting_a_session_drops_its_links() {
        scratch("forget");
        link("a", "b").unwrap();
        link("a", "c").unwrap();
        link("b", "c").unwrap();
        forget("a").unwrap();
        assert!(links_of("a").is_empty());
        assert!(linked("b", "c"));
    }
}
