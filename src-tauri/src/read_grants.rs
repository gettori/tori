//! A reference arrives as a structured block that only a person or Tori sends,
//! never an agent's text, so it is the grant and needs no prompt of its own.

use crate::chat::model::{ContentBlock, RefTarget};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::SystemTime;

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
struct Grants(HashMap<String, BTreeSet<String>>);

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
    crate::owned_state::config_dir().join("read_grants.json")
}

type Stamp = (PathBuf, Option<SystemTime>);
static CACHE: OnceLock<Mutex<(Option<Stamp>, Grants)>> = OnceLock::new();

fn load(path: &Path) -> Result<Grants, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{} does not parse: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Grants::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn save(path: &Path, grants: &Grants) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(grants).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn current() -> Grants {
    let path = store_path();
    let stamp = Some((path.clone(), std::fs::metadata(&path).and_then(|m| m.modified()).ok()));
    let cache = CACHE.get_or_init(|| Mutex::new((None, Grants::default())));
    let mut held = cache.lock().unwrap_or_else(PoisonError::into_inner);
    if held.0 != stamp || stamp.as_ref().is_some_and(|(_, at)| at.is_none()) {
        let grants = load(&path).unwrap_or_else(|e| {
            eprintln!("tori: read grants unreadable, every reference read is refused until fixed: {e}");
            Grants::default()
        });
        *held = (stamp, grants);
    }
    held.1.clone()
}

pub fn granted(reader: &str, target: &str) -> bool {
    current().0.get(reader).is_some_and(|t| t.contains(target))
}

fn referenced(blocks: &[ContentBlock]) -> BTreeSet<String> {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Ref {
                target: RefTarget::Session { id, .. },
                ..
            } => Some(id.clone()),
            _ => None,
        })
        .collect()
}

pub fn grant_referenced(reader: &str, blocks: &[ContentBlock]) -> Result<(), String> {
    let wanted = referenced(blocks);
    if wanted.iter().all(|t| granted(reader, t)) {
        return Ok(());
    }
    let _held = crate::exec::cross_process_store_lock("read_grants")?;
    let path = store_path();
    let mut grants = load(&path)?;
    grants.0.entry(reader.to_string()).or_default().extend(wanted);
    save(&path, &grants)
}

pub fn forget(session: &str) -> Result<(), String> {
    let _held = crate::exec::cross_process_store_lock("read_grants")?;
    let path = store_path();
    let mut grants = load(&path)?;
    let before = serde_json::to_string(&grants).unwrap_or_default();
    grants.0.remove(session);
    grants.0.values_mut().for_each(|t| {
        t.remove(session);
    });
    grants.0.retain(|_, t| !t.is_empty());
    if serde_json::to_string(&grants).unwrap_or_default() == before {
        return Ok(());
    }
    save(&path, &grants)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_ref(id: &str) -> ContentBlock {
        ContentBlock::Ref {
            label: format!("[Session: {id}]"),
            target: RefTarget::Session {
                id: id.into(),
                title: "t".into(),
                agent: "claude".into(),
                project: "p".into(),
            },
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-read-grants-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        seam(dir.join("read_grants.json"));
        dir
    }

    #[test]
    fn a_session_reference_grants_a_read_and_plain_text_does_not() {
        let dir = scratch("grant");
        let text = ContentBlock::Text { text: "read s2".into() };
        grant_referenced("reader", std::slice::from_ref(&text)).unwrap();
        assert!(!granted("reader", "s2"));
        assert!(
            !dir.join("read_grants.json").exists(),
            "a turn with no reference writes nothing"
        );

        grant_referenced("reader", &[text, session_ref("s2")]).unwrap();
        assert!(granted("reader", "s2"));
        assert!(!granted("s2", "reader"), "a grant reads one way");
    }

    #[test]
    fn forgetting_a_session_drops_its_grants_both_ways() {
        scratch("forget");
        grant_referenced("reader", &[session_ref("s2")]).unwrap();
        grant_referenced("other", &[session_ref("reader")]).unwrap();
        forget("reader").unwrap();
        assert!(!granted("reader", "s2"));
        assert!(!granted("other", "reader"));
    }
}
