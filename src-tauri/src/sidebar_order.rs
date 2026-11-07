//! Kept out of `tori.toml` on purpose: a drag rewrites it, and that file is
//! hand-edited and often linked into a dotfiles repo, where every reorder
//! would show up as a diff.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

pub const CHANGED_EVENT: &str = "sidebar-order://changed";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOrder {
    #[serde(default)]
    pub entries: Vec<String>,
    /// The lane each branch was last seen in, so one that moves lanes can be
    /// placed at the top of its new lane.
    #[serde(default)]
    pub lanes: BTreeMap<String, String>,
}

pub type SidebarOrder = BTreeMap<String, ProjectOrder>;

fn file() -> PathBuf {
    crate::owned_state::config_dir().join("sidebar-order.json")
}

// A file that will not read or parse is refused rather than taken as empty:
// the next write would replace every project's order with one.
fn read_from(path: &Path) -> Result<SidebarOrder, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SidebarOrder::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn write_to(path: &Path, project: &str, mut order: ProjectOrder) -> Result<bool, String> {
    let mut seen = std::collections::HashSet::new();
    order.entries.retain(|k| seen.insert(k.clone()));
    order.lanes.retain(|k, _| seen.contains(k));
    let mut all = read_from(path)?;
    if all.get(project) == Some(&order) {
        return Ok(false);
    }
    if order == ProjectOrder::default() {
        all.remove(project);
    } else {
        all.insert(project.to_string(), order);
    }
    let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(path, &text)?;
    Ok(true)
}

#[tauri::command(async)]
pub fn sidebar_order_read() -> Result<SidebarOrder, String> {
    read_from(&file())
}

#[tauri::command(async)]
pub fn sidebar_order_write(app: tauri::AppHandle, project: String, order: ProjectOrder) -> Result<(), String> {
    let changed = {
        let _lock = crate::exec::cross_process_store_lock("sidebar-order")?;
        write_to(&file(), &project, order)?
    };
    if changed {
        let _ = app.emit(CHANGED_EVENT, ());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori_sidebar_order_{}_{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("sidebar-order.json")
    }

    fn order(entries: &[&str], lanes: &[(&str, &str)]) -> ProjectOrder {
        ProjectOrder {
            entries: entries.iter().map(|s| s.to_string()).collect(),
            lanes: lanes.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    #[test]
    fn an_order_round_trips_beside_another_project_s() {
        let path = store("round_trip");
        let a = order(&["main", "feat"], &[("feat", "inReview")]);
        assert!(write_to(&path, "/a", a.clone()).unwrap());
        assert!(write_to(&path, "/b", order(&["x"], &[])).unwrap());
        let all = read_from(&path).unwrap();
        assert_eq!(all.get("/a"), Some(&a));
        assert_eq!(all.get("/b").unwrap().entries, vec!["x".to_string()]);
    }

    #[test]
    fn a_branch_left_out_takes_its_lane_with_it() {
        let path = store("left_out");
        write_to(&path, "/a", order(&["main", "gone"], &[("gone", "done")])).unwrap();
        write_to(&path, "/a", order(&["main"], &[("gone", "done")])).unwrap();
        assert_eq!(read_from(&path).unwrap().get("/a"), Some(&order(&["main"], &[])));
    }

    #[test]
    fn the_same_order_twice_writes_once() {
        let path = store("twice");
        assert!(write_to(&path, "/a", order(&["main"], &[])).unwrap());
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert!(!write_to(&path, "/a", order(&["main", "main"], &[])).unwrap());
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn an_unreadable_file_is_refused_not_replaced() {
        let path = store("unreadable");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(read_from(&path).is_err());
        assert!(write_to(&path, "/a", order(&["main"], &[])).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
