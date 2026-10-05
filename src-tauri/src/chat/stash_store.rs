//! The prompt stash: drafts parked from any chat composer, kept on disk until
//! they are restored or discarded. One list for the whole app, oldest first.
//!
//! An entry is opaque webview JSON (`{ id, text, chips, at }`), but unlike the
//! queue the backend is the only writer: removing an entry sweeps the uploads
//! it named, so the file must never be overwritten by a stale copy of the list.

use std::path::{Path, PathBuf};

use serde_json::Value;

const CAP: usize = 20;

pub fn path() -> PathBuf {
    crate::owned_state::config_dir().join("stash.json")
}

fn load_in(file: &Path) -> Vec<Value> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
        .unwrap_or_default()
}

fn save_in(file: &Path, stash: &[Value]) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(stash).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(file, &json)
}

fn id_of(entry: &Value) -> Option<&str> {
    entry.get("id").and_then(Value::as_str)
}

fn push_in(file: &Path, entry: Value) -> Result<(Vec<Value>, Vec<Value>), String> {
    let mut stash = load_in(file);
    stash.push(entry);
    let over = stash.len().saturating_sub(CAP);
    let dropped: Vec<Value> = stash.drain(..over).collect();
    save_in(file, &stash)?;
    Ok((stash, dropped))
}

fn remove_in(file: &Path, id: &str) -> Result<(Option<Value>, Vec<Value>), String> {
    let mut stash = load_in(file);
    let Some(at) = stash.iter().position(|e| id_of(e) == Some(id)) else {
        return Ok((None, stash));
    };
    let entry = stash.remove(at);
    save_in(file, &stash)?;
    Ok((Some(entry), stash))
}

fn lock() -> std::sync::Arc<std::sync::Mutex<()>> {
    crate::exec::named_lock("prompt-stash")
}

pub fn list() -> Vec<Value> {
    load_in(&path())
}

pub fn push(entry: Value) -> Result<Vec<Value>, String> {
    let (stash, dropped) = {
        let store = lock();
        let _guard = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        push_in(&path(), entry)?
    };
    sweep(&dropped);
    Ok(stash)
}

// No sweep: a restored entry's uploads move into a composer.
pub fn take(id: &str) -> Result<(Option<Value>, Vec<Value>), String> {
    let store = lock();
    let _guard = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    remove_in(&path(), id)
}

pub fn discard(id: &str) -> Result<Vec<Value>, String> {
    let (gone, stash) = {
        let store = lock();
        let _guard = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        remove_in(&path(), id)?
    };
    sweep(gone.as_slice());
    Ok(stash)
}

// After the write, so the stash file already says which entries are left.
fn sweep(removed: &[Value]) {
    if !removed.is_empty() {
        sweep_in(
            removed,
            &crate::attachments::dir(),
            &crate::sessions::watch_dirs(),
            &path(),
        );
    }
}

fn sweep_in(removed: &[Value], dir: &Path, roots: &[PathBuf], file: &Path) {
    let Ok(text) = serde_json::to_vec(removed) else { return };
    let holders = crate::attachments::holders_named_in(&text, dir);
    crate::attachments::drop_unreferenced(&holders, roots, &[file.to_path_buf()]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_file(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tori-stash-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("stash.json")
    }

    fn entry(id: &str) -> Value {
        json!({ "id": id, "text": "later", "chips": [], "at": 0 })
    }

    #[test]
    fn push_then_take_round_trips_the_entry() {
        let f = tmp_file("round-trip");
        push_in(&f, entry("a")).unwrap();
        let (stash, _) = push_in(&f, entry("b")).unwrap();
        assert_eq!(stash, vec![entry("a"), entry("b")]);
        let (taken, stash) = remove_in(&f, "a").unwrap();
        assert_eq!(taken, Some(entry("a")));
        assert_eq!(stash, vec![entry("b")]);
        assert_eq!(load_in(&f), vec![entry("b")]);
    }

    #[test]
    fn a_missing_or_corrupt_file_is_an_empty_stash() {
        let f = tmp_file("corrupt");
        assert!(load_in(&f).is_empty());
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(&f, "[{\"id\": \"a\", \"te").unwrap();
        assert!(load_in(&f).is_empty());
    }

    #[test]
    fn an_unknown_id_takes_nothing() {
        let f = tmp_file("unknown");
        push_in(&f, entry("a")).unwrap();
        let (taken, stash) = remove_in(&f, "zz").unwrap();
        assert_eq!(taken, None);
        assert_eq!(stash, vec![entry("a")]);
        assert_eq!(load_in(&f), vec![entry("a")]);
    }

    #[test]
    fn the_twenty_first_push_drops_the_oldest() {
        let f = tmp_file("cap");
        for n in 0..CAP {
            push_in(&f, entry(&n.to_string())).unwrap();
        }
        let (stash, dropped) = push_in(&f, entry("new")).unwrap();
        assert_eq!(dropped, vec![entry("0")]);
        assert_eq!(stash.len(), CAP);
        assert_eq!(stash.last(), Some(&entry("new")));
    }

    fn scene(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let f = tmp_file(tag);
        let base = f.parent().unwrap().to_path_buf();
        (f, base.join("attachments"), base.join("root"))
    }

    fn upload(dir: &Path, name: &str) -> String {
        let holder = dir.join(name);
        std::fs::create_dir_all(&holder).unwrap();
        let file = holder.join("shot.png");
        std::fs::write(&file, b"png").unwrap();
        file.to_string_lossy().into_owned()
    }

    fn with_chip(id: &str, path: &str) -> Value {
        json!({ "id": id, "text": "[Image 1] look", "chips": [{ "type": "fileRef", "path": path }], "at": 0 })
    }

    fn named_by_transcript(root: &Path, path: &str) {
        let project = root.join("proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join("s.jsonl"),
            format!("{{\"text\":\"[Image 1]: @{path}\"}}\n"),
        )
        .unwrap();
    }

    #[test]
    fn a_discarded_entry_takes_only_the_uploads_nothing_else_names() {
        let (f, dir, root) = scene("discard");
        let alone = upload(&dir, "h1");
        let sent = upload(&dir, "h2");
        let shared = upload(&dir, "h3");
        named_by_transcript(&root, &sent);
        push_in(&f, with_chip("a", &alone)).unwrap();
        push_in(&f, with_chip("b", &sent)).unwrap();
        push_in(&f, with_chip("c", &shared)).unwrap();
        push_in(&f, with_chip("d", &shared)).unwrap();

        for id in ["a", "b", "c"] {
            let (gone, _) = remove_in(&f, id).unwrap();
            sweep_in(gone.as_slice(), &dir, std::slice::from_ref(&root), &f);
        }
        assert!(!dir.join("h1").exists(), "nothing else named it");
        assert!(Path::new(&sent).exists(), "a transcript names it");
        assert!(Path::new(&shared).exists(), "entry d still names it");
    }

    #[test]
    fn the_entry_that_falls_off_the_cap_is_swept() {
        let (f, dir, root) = scene("cap-sweep");
        let oldest = upload(&dir, "h0");
        push_in(&f, with_chip("0", &oldest)).unwrap();
        for n in 1..CAP {
            push_in(&f, entry(&n.to_string())).unwrap();
        }
        let (_, dropped) = push_in(&f, entry("new")).unwrap();
        sweep_in(&dropped, &dir, &[root], &f);
        assert!(!dir.join("h0").exists());
    }
}
