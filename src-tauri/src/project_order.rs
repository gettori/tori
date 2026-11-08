//! The hand-made order of each space's project list, keyed by space name, as
//! project paths top to bottom. Its own file beside `sidebar-order.json`, whose
//! keys are project paths: a space name in there would share that key space.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tauri::Emitter;

pub const CHANGED_EVENT: &str = "project-order://changed";

pub type ProjectOrder = BTreeMap<String, Vec<String>>;

fn file() -> PathBuf {
    crate::owned_state::config_dir().join("project-order.json")
}

// A file that will not read or parse is refused rather than taken as empty:
// the next write would replace every space's order with one.
fn read_from(path: &Path) -> Result<ProjectOrder, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ProjectOrder::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn write_to(path: &Path, space: &str, mut paths: Vec<String>) -> Result<bool, String> {
    let mut seen = std::collections::HashSet::new();
    paths.retain(|k| seen.insert(k.clone()));
    let mut all = read_from(path)?;
    if all.get(space) == Some(&paths) {
        return Ok(false);
    }
    if paths.is_empty() {
        all.remove(space);
    } else {
        all.insert(space.to_string(), paths);
    }
    let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(path, &text)?;
    Ok(true)
}

#[tauri::command(async)]
pub fn project_order_read() -> Result<ProjectOrder, String> {
    read_from(&file())
}

#[tauri::command(async)]
pub fn project_order_write(app: tauri::AppHandle, space: String, paths: Vec<String>) -> Result<(), String> {
    let changed = {
        let _lock = crate::exec::cross_process_store_lock("project-order")?;
        write_to(&file(), &space, paths)?
    };
    if changed {
        let _ = app.emit(CHANGED_EVENT, ());
    }
    Ok(())
}
