// Filesystem access for the in-webview editor: directory listing, read/write,
// existence checks, plus a per-project recursive watcher that emits a single
// debounced `fs://changed { paths }` for genuine source edits (churn dirs and
// Sway's own write echo are filtered out elsewhere).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
pub fn fs_read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
        });
    }
    // Dirs first, then case-insensitive name — typical file-tree ordering.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// All project files (paths relative to `project_path`) for the quick-open
/// finder. Prefers `git ls-files` (respects .gitignore, lists tracked +
/// untracked-not-ignored); falls back to a recursive walk skipping the churn
/// dirs for a non-git project.
#[tauri::command]
pub fn list_project_files(project_path: String) -> Result<Vec<String>, String> {
    if let Ok(out) = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            return Ok(text.lines().filter(|l| !l.is_empty()).map(String::from).collect());
        }
    }
    let root = PathBuf::from(&project_path);
    let mut files = Vec::new();
    walk_files(&root, &root, &mut files);
    Ok(files)
}

fn walk_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if IGNORED_DIRS.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            walk_files(root, &path, out);
        } else if ft.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().into_owned());
            }
        }
    }
}

pub struct FsWatch(pub Mutex<Option<RecommendedWatcher>>);

impl Default for FsWatch {
    fn default() -> Self {
        FsWatch(Mutex::new(None))
    }
}

/// Directories whose churn must never reach the editor panes: VCS internals and
/// build output. Terminal-driven git/build/install touch these constantly and a
/// match here means "skip" so follow-mode and the git gutter only react to real
/// source edits. (Best-effort gitignore beyond this explicit list is deferred.)
const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "dist", "target"];

fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        matches!(c, std::path::Component::Normal(os)
            if os.to_str().map(|s| IGNORED_DIRS.contains(&s)).unwrap_or(false))
    })
}

#[derive(Clone, Serialize)]
struct FsChanged {
    paths: Vec<String>,
}

/// Install a recursive watcher on the open project dir. Filtered events flow
/// through a channel into a trailing-edge debounce thread that emits one
/// `fs://changed { paths }` per burst. Idempotent: re-installing replaces the
/// previous watcher (dropping it tears down its debounce thread via the closed
/// channel). Mirrors `config_watch_start` / `sessions_watch_start`.
#[tauri::command]
pub fn fs_watch_start(
    app: AppHandle,
    state: State<FsWatch>,
    project_path: String,
) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }

    // notify handler -> channel -> debounce thread -> single batched emit.
    let (tx, rx) = mpsc::channel::<PathBuf>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            for p in event.paths {
                if !is_ignored(&p) {
                    let _ = tx.send(p);
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // Trailing-edge debounce: collect a burst, emit once it goes quiet for
    // 250ms. recv() returns Err when the watcher (and its sender) is dropped,
    // which is how a replaced watcher cleanly ends this thread.
    let app_handle = app.clone();
    thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch: BTreeSet<PathBuf> = BTreeSet::new();
            batch.insert(first);
            while let Ok(next) = rx.recv_timeout(Duration::from_millis(250)) {
                batch.insert(next);
            }
            let paths: Vec<String> = batch
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                let _ = app_handle.emit("fs://changed", FsChanged { paths });
            }
        }
    });

    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignored_dirs_filtered_anywhere_in_path() {
        assert!(is_ignored(Path::new("/p/.git/index")));
        assert!(is_ignored(Path::new("/p/node_modules/x/y.js")));
        assert!(is_ignored(Path::new("/p/dist/bundle.js")));
        assert!(is_ignored(Path::new("/p/src-tauri/target/debug/foo")));
        assert!(!is_ignored(Path::new("/p/src/App.tsx")));
        // A substring of an ignored name must not match.
        assert!(!is_ignored(Path::new("/p/src/distance.ts")));
    }

    #[test]
    fn fs_commands_roundtrip() {
        let dir = std::env::temp_dir().join(format!("sway-fs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hello.txt");
        let fp = file.to_string_lossy().into_owned();

        assert!(!file_exists(fp.clone()));
        fs_write_file(fp.clone(), "hi".into()).unwrap();
        assert!(file_exists(fp.clone()));
        assert_eq!(fs_read_file(fp.clone()).unwrap(), "hi");

        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let entries = fs_read_dir(dir.to_string_lossy().into_owned()).unwrap();
        // Dir sorts before file.
        assert_eq!(entries[0].name, "sub");
        assert!(entries[0].is_dir);
        assert!(entries.iter().any(|e| e.name == "hello.txt" && !e.is_dir));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
