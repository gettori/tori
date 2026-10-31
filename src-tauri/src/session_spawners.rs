//! Which chat spawned which, kept on disk: the daemon's own map dies with it,
//! and a transcript keeps a spawned chat's first prompt but not who sent it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::SystemTime;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawn {
    pub spawner: String,
    /// The first prompt the spawner wrote, absent when Tori wrote it (a handoff).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Spawns(HashMap<String, Spawn>);

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
    crate::owned_state::config_dir().join("session_spawners.json")
}

fn load(path: &Path) -> Result<Spawns, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{} does not parse: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Spawns::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn save(path: &Path, spawns: &Spawns) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(spawns).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

type Stamp = (PathBuf, Option<SystemTime>);
static CACHE: OnceLock<Mutex<(Option<Stamp>, Spawns)>> = OnceLock::new();

fn current() -> Spawns {
    let path = store_path();
    let stamp = Some((path.clone(), std::fs::metadata(&path).and_then(|m| m.modified()).ok()));
    let cache = CACHE.get_or_init(|| Mutex::new((None, Spawns::default())));
    let mut held = cache.lock().unwrap_or_else(PoisonError::into_inner);
    if held.0 != stamp || stamp.as_ref().is_some_and(|(_, at)| at.is_none()) {
        let spawns = load(&path).unwrap_or_else(|e| {
            eprintln!("tori: spawn records unreadable, spawned chats lose their spawner until fixed: {e}");
            Spawns::default()
        });
        *held = (stamp, spawns);
    }
    held.1.clone()
}

fn change(edit: impl FnOnce(&mut Spawns)) -> Result<(), String> {
    let _held = crate::exec::cross_process_store_lock("session_spawners")?;
    let path = store_path();
    let mut spawns = load(&path)?;
    edit(&mut spawns);
    save(&path, &spawns)
}

pub fn get(child: &str) -> Option<Spawn> {
    current().0.get(child).cloned()
}

pub fn children_of(spawner: &str) -> Vec<String> {
    current()
        .0
        .into_iter()
        .filter_map(|(child, s)| (s.spawner == spawner).then_some(child))
        .collect()
}

pub fn record(child: &str, spawner: &str, prompt: Option<&str>) -> Result<(), String> {
    change(|s| {
        s.0.insert(
            child.to_string(),
            Spawn {
                spawner: spawner.to_string(),
                prompt: prompt.map(str::to_string),
            },
        );
    })
}

pub fn forget(session: &str) -> Result<(), String> {
    if !current().0.contains_key(session) {
        return Ok(());
    }
    change(|s| {
        s.0.remove(session);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-session-spawners-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        seam(dir.join("session_spawners.json"));
        dir
    }

    #[test]
    fn a_spawn_is_recorded_read_and_forgotten() {
        scratch("record");
        record("child", "parent", Some("hi")).unwrap();
        let spawn = get("child").unwrap();
        assert_eq!(
            (spawn.spawner.as_str(), spawn.prompt.as_deref()),
            ("parent", Some("hi"))
        );
        forget("child").unwrap();
        assert_eq!(get("child"), None);
    }

    #[test]
    fn a_spawner_finds_its_children() {
        scratch("children");
        record("a", "parent", None).unwrap();
        record("b", "parent", None).unwrap();
        record("c", "other", None).unwrap();
        let mut kids = children_of("parent");
        kids.sort();
        assert_eq!(kids, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn a_handoff_records_its_spawner_and_no_prompt() {
        scratch("handoff");
        record("new", "parent", None).unwrap();
        assert_eq!(get("new").map(|s| (s.spawner, s.prompt)), Some(("parent".into(), None)));
    }
}
