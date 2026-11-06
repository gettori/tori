// Filtered to the files an operation writes: `index` changes on every
// `git status`, and reacting to it would turn Tori's own polling into a loop.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::worktree::{operation, Operation};

// HEAD, not `rebase-merge/msgnum`, carries the step: a rebase rewrites it on
// every pick, and `msgnum` sits one level below the non-recursive watch.
const MARKERS: [&str; 6] = [
    "HEAD",
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
];

// A fast rebase rewrites HEAD dozens of times a second; one read per window is
// enough for a chip.
const SETTLE: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct OperationWatch(Mutex<Option<RecommendedWatcher>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OperationChanged {
    folder: String,
    operation: Option<Operation>,
}

type Emit = Arc<dyn Fn(&str) + Send + Sync>;

fn folder_for<'a>(dirs: &'a HashMap<PathBuf, String>, path: &Path) -> Option<&'a str> {
    let name = path.file_name()?.to_str()?;
    if !MARKERS.contains(&name) {
        return None;
    }
    dirs.get(path.parent()?).map(String::as_str)
}

// Trailing, not leading: the read happens after the window closes, so the last
// write of a burst (the rebase finishing) is never the one dropped.
fn settle(pending: &Arc<Mutex<HashSet<String>>>, folder: &str, emit: &Emit) {
    if !pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(folder.to_string())
    {
        return;
    }
    let pending = pending.clone();
    let folder = folder.to_string();
    let emit = emit.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SETTLE);
        pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&folder);
        emit(&folder);
    });
}

fn watch(folders: Vec<String>, emit: Emit) -> Result<RecommendedWatcher, String> {
    // Canonical, because the events arrive with the real path (macOS's
    // `/private/var` for `/var`) and are matched by their parent.
    let dirs: HashMap<PathBuf, String> = folders
        .into_iter()
        .filter_map(|folder| {
            let dir = crate::worktree::git_dir(Path::new(&folder))?;
            Some((std::fs::canonicalize(dir).ok()?, folder))
        })
        .collect();
    let watched: Vec<PathBuf> = dirs.keys().cloned().collect();
    let pending = Arc::new(Mutex::new(HashSet::new()));
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        for path in &event.paths {
            if let Some(folder) = folder_for(&dirs, path) {
                settle(&pending, folder, &emit);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    for dir in &watched {
        let _ = watcher.watch(dir, RecursiveMode::NonRecursive);
    }
    Ok(watcher)
}

#[tauri::command(async)]
pub fn operation_watch_start(app: AppHandle, state: State<OperationWatch>, folders: Vec<String>) -> Result<(), String> {
    let watcher = watch(
        folders,
        Arc::new(move |folder: &str| {
            let _ = app.emit(
                "worktree://operation",
                OperationChanged {
                    folder: folder.to_string(),
                    operation: operation(Path::new(folder)),
                },
            );
        }),
    )?;
    *state.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn counting() -> (Emit, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let emit: Emit = Arc::new(move |folder: &str| {
            let _ = tx.lock().unwrap().send(folder.to_string());
        });
        (emit, rx)
    }

    #[test]
    fn only_the_files_an_operation_writes_are_heard() {
        let dirs = HashMap::from([(PathBuf::from("/r/.git/worktrees/w"), "/w".to_string())]);
        for name in MARKERS {
            assert_eq!(
                folder_for(&dirs, &Path::new("/r/.git/worktrees/w").join(name)),
                Some("/w")
            );
        }
        for name in ["index", "index.lock", "HEAD.lock", "ORIG_HEAD", "FETCH_HEAD", "logs"] {
            assert_eq!(
                folder_for(&dirs, &Path::new("/r/.git/worktrees/w").join(name)),
                None,
                "{name}"
            );
        }
        assert_eq!(
            folder_for(&dirs, Path::new("/r/.git/worktrees/w/rebase-merge/msgnum")),
            None
        );
        assert_eq!(folder_for(&dirs, Path::new("/elsewhere/HEAD")), None);
    }

    #[test]
    fn a_burst_inside_one_window_emits_once_after_it() {
        let (emit, rx) = counting();
        let pending = Arc::new(Mutex::new(HashSet::new()));
        for _ in 0..50 {
            settle(&pending, "/w", &emit);
        }
        settle(&pending, "/other", &emit);
        let mut got: Vec<String> = (0..2)
            .map(|_| rx.recv_timeout(SETTLE * 4).expect("one per folder"))
            .collect();
        got.sort();
        assert_eq!(got, ["/other", "/w"]);
        assert!(rx.recv_timeout(SETTLE * 2).is_err(), "the burst emits nothing more");

        settle(&pending, "/w", &emit);
        assert_eq!(
            rx.recv_timeout(SETTLE * 4).as_deref(),
            Ok("/w"),
            "a later write opens a new window"
        );
    }

    #[test]
    fn a_rebase_starting_and_ending_on_disk_is_heard_and_an_index_write_is_not() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp = std::env::temp_dir().join(format!("tori-opwatch-{}-{nanos}", std::process::id()));
        let git_dir = tmp.join("repo/.git");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let folder = tmp.join("repo").to_string_lossy().into_owned();
        let (emit, rx) = counting();
        let _watcher = watch(vec![folder.clone()], emit).unwrap();
        // FSEvents can deliver events from just before the watch began.
        std::thread::sleep(Duration::from_millis(500));
        while rx.try_recv().is_ok() {}

        std::fs::write(git_dir.join("index"), "x").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_secs(2)).is_err(),
            "an index write is ignored"
        );

        std::fs::create_dir(git_dir.join("rebase-merge")).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).as_deref(), Ok(folder.as_str()));
        while rx.recv_timeout(SETTLE * 2).is_ok() {}

        std::fs::remove_dir(git_dir.join("rebase-merge")).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).as_deref(), Ok(folder.as_str()));
        std::fs::remove_dir_all(&tmp).ok();
    }
}
