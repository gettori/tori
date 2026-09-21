// Per-workspace preference overlay: `<workspace>/.tori/settings.json`.
//
// The third layer under the built-in defaults and `~/.config/tori/settings.json`
// (see `settings.rs`). Same file format for the same reason: JSONC in, pretty
// JSON out, so a hand edit with comments in it survives a write from the panel.
//
// **Local to the machine, never committed.** On the first write the directory is
// added to the repo's own `.git/info/exclude`, so it is invisible to git from
// the moment it exists rather than showing up in the Changes panel as a file
// nobody asked for, and a teammate who never runs Tori sees nothing. The cost of
// that choice is that these settings cannot be shared with a team; the global
// file is where a preference meant to travel belongs.
//
// **The keys are opaque here.** The overlay is carried as a `serde_json::Value`
// and validated on the frontend against the shape of the editor defaults, so a
// later feature adding a setting needs no change in this file. Rust's only jobs
// are the file format, the directory, and the exclude line.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::git::exclude_from_repo;

/// The workspace-local directory. Excluded from the repo on first write.
pub const TORI_DIR: &str = ".tori";

fn overlay_path(root: &str) -> PathBuf {
    Path::new(root).join(TORI_DIR).join("settings.json")
}

fn empty() -> Value {
    Value::Object(Map::new())
}

/// Read an overlay's text into a value.
///
/// Comment-tolerant, like the global file. Anything that is not a JSON object
/// (a truncated write, a stray array, a file someone pasted over) reads as *no
/// overlay* rather than as an error: the layer below it is always a complete
/// answer, so a broken overlay costs the user their per-workspace picks and
/// nothing else.
pub(crate) fn parse_overlay(text: &str) -> Value {
    match json5::from_str::<Value>(text) {
        Ok(v) if v.is_object() => v,
        _ => empty(),
    }
}

#[tauri::command(async)]
pub fn get_workspace_settings(root: String) -> Value {
    std::fs::read_to_string(overlay_path(&root))
        .map(|t| parse_overlay(&t))
        .unwrap_or_else(|_| empty())
}

#[tauri::command(async)]
pub fn set_workspace_settings(root: String, settings: Value) -> Result<Value, String> {
    // Load-modify-save on the workspace-settings store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("workspace-settings");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // Excluded *before* the file is written, so there is no window in which git
    // would report it. Doing this the other way round is what would put an
    // unexplained untracked file in the Changes panel, however briefly.
    exclude_from_repo(&root, TORI_DIR);
    let path = overlay_path(&root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Creating {} failed: {e}", dir.display()))?;
    }
    // The panel writes only the blocks it manages, so a hand-written block
    // beside them (`lsp`) is carried over rather than erased by the next click.
    let mut merged = std::fs::read_to_string(&path).map(|t| parse_overlay(&t)).unwrap_or_else(|_| empty());
    if let (Some(into), Some(from)) = (merged.as_object_mut(), settings.as_object()) {
        into.extend(from.clone());
    }
    let text = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{text}\n"))
        .map_err(|e| format!("Writing {} failed: {e}", path.display()))?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A fresh repo per test. Named per test, not per process: these run
    /// concurrently in one binary, and a shared path means one test's cleanup
    /// deletes the directory another is still writing to.
    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-ws-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        Command::new("git").arg("-C").arg(&dir).arg("init").output().unwrap();
        dir
    }

    #[test]
    fn a_workspace_with_no_overlay_reads_as_no_overrides_rather_than_an_error() {
        let dir = repo("none");
        assert_eq!(get_workspace_settings(dir.to_string_lossy().into_owned()), empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_comment_survives_the_read_and_a_broken_file_reads_as_empty() {
        assert_eq!(
            parse_overlay("{ /* mine */ \"editor\": { \"compactFolders\": false } }"),
            serde_json::json!({ "editor": { "compactFolders": false } }),
        );
        for broken in ["", "not json", "[1, 2]", "\"a string\""] {
            assert_eq!(parse_overlay(broken), empty(), "{broken:?}");
        }
    }

    #[test]
    fn writing_an_override_makes_the_directory_invisible_to_git() {
        let dir = repo("invisible");
        let root = dir.to_string_lossy().into_owned();

        set_workspace_settings(root.clone(), serde_json::json!({ "editor": { "compactFolders": false } })).unwrap();

        // The whole point of the tracking story: the first override must not
        // leave an unexplained untracked file in the Changes panel.
        let out = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["status", "--porcelain", "--untracked-files=all"])
            .output()
            .unwrap();
        let status = String::from_utf8_lossy(&out.stdout);
        assert!(!status.contains(TORI_DIR), "git reported the overlay: {status:?}");

        // And nothing tracked was touched to achieve it.
        assert!(!dir.join(".gitignore").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn what_was_written_is_what_comes_back() {
        let dir = repo("roundtrip");
        let root = dir.to_string_lossy().into_owned();
        let value = serde_json::json!({ "editor": { "compactFolders": false, "minimap": true } });

        set_workspace_settings(root.clone(), value.clone()).unwrap();

        assert_eq!(get_workspace_settings(root), value);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_second_write_does_not_add_a_second_exclude_line() {
        let dir = repo("twice");
        let root = dir.to_string_lossy().into_owned();

        set_workspace_settings(root.clone(), serde_json::json!({ "editor": {} })).unwrap();
        set_workspace_settings(root, serde_json::json!({ "editor": { "minimap": true } })).unwrap();

        let exclude = std::fs::read_to_string(dir.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.lines().filter(|l| l.trim() == format!("{TORI_DIR}/")).count(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_folder_that_is_not_a_repo_still_takes_an_override() {
        // A `.shared/` folder is a real folder outside any git repo; the
        // exclude simply has nowhere to go, and that must not refuse the write.
        let dir = std::env::temp_dir().join(format!("tori-ws-plain-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();

        set_workspace_settings(root.clone(), serde_json::json!({ "editor": { "minimap": true } })).unwrap();

        assert_eq!(
            get_workspace_settings(root),
            serde_json::json!({ "editor": { "minimap": true } }),
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
