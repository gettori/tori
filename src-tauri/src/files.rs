// File-tree listing, file read/write, a per-root file watcher, and git diff
// line marks for the editor's gutter.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Default)]
pub struct FilesWatch(pub Mutex<Option<RecommendedWatcher>>);

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct LineMark {
    pub line: u32,
    pub kind: String, // "added" | "modified" | "removed"
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = Vec::new();
    let read = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if name == ".git" || name == ".DS_Store" {
            continue;
        }
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(Entry {
            name,
            path: item.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    // Dirs first, then case-insensitive alphabetical.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Err("file too large to open".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("binary file".into());
    }
    String::from_utf8(bytes).map_err(|_| "not valid UTF-8".to_string())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Parse "a,b" / "a" from a unified-diff hunk header side. Count defaults to 1.
fn parse_pair(s: &str) -> (u32, u32) {
    let mut it = s.split(',');
    let start = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let count = it.next().and_then(|v| v.parse().ok()).unwrap_or(1);
    (start, count)
}

#[tauri::command]
pub fn git_diff_lines(path: String) -> Result<Vec<LineMark>, String> {
    let dir = Path::new(&path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let output = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["diff", "-U0", "--no-color", "--", &path])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Ok(vec![]); // not a repo, or other git error: no marks
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut marks = Vec::new();
    for line in text.lines() {
        if !line.starts_with("@@") {
            continue;
        }
        // @@ -oldStart,oldCount +newStart,newCount @@
        let minus = match line.split('-').nth(1) {
            Some(m) => m.split_whitespace().next().unwrap_or(""),
            None => continue,
        };
        let plus = match line.split('+').nth(1) {
            Some(p) => p.split_whitespace().next().unwrap_or(""),
            None => continue,
        };
        let (_old_start, old_count) = parse_pair(minus);
        let (new_start, new_count) = parse_pair(plus);

        if new_count == 0 {
            // Pure deletion: flag the line where content was removed.
            marks.push(LineMark {
                line: new_start.max(1),
                kind: "removed".into(),
            });
            continue;
        }
        let kind = if old_count > 0 { "modified" } else { "added" };
        for l in new_start..new_start + new_count {
            marks.push(LineMark {
                line: l,
                kind: kind.into(),
            });
        }
    }
    Ok(marks)
}

/// (Re)install a recursive watcher on `root`; replaces any previous one.
#[tauri::command]
pub fn files_watch_start(
    app: AppHandle,
    state: State<FilesWatch>,
    root: String,
) -> Result<(), String> {
    let app_handle = app.clone();
    let last_emit = std::sync::Arc::new(Mutex::new(Instant::now()));
    let debounce = last_emit.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_err() {
            return;
        }
        if let Ok(mut last) = debounce.lock() {
            if last.elapsed().as_millis() < 300 {
                return;
            }
            *last = Instant::now();
        }
        let _ = app_handle.emit("files://changed", ());
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}
