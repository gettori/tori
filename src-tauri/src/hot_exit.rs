// Hot exit: the unsaved buffers a quit would otherwise discard, kept on disk so
// the next launch can hand them back.
//
// **Deliberately opaque.** This module stores and returns a `serde_json::Value`
// and never looks inside it. The shape belongs to the editor, and most of each
// entry is a serialized CodeMirror `EditorState` (its undo history included),
// which Rust could only mirror as an untyped blob anyway. Typing the envelope
// here would duplicate a schema the frontend already owns and tests, and would
// invite the two copies to drift; what stays here is the part that genuinely
// belongs to the backend, which is durability.
//
// **Why a file rather than localStorage**, which is where the tab strip's own
// restore lives (`editorTabPersist.ts`): an entry carries a whole document plus
// its history, and the webview's storage is a shared few megabytes. A quit that
// silently failed to stash because the tab store had already filled the quota
// would lose exactly the work this feature exists to keep. Bounding by age and
// count is the frontend's job, mirroring its sibling.
//
// Same pure-core / thin-wrapper split as `settings.rs` and `onboarding.rs`, so
// the load and save paths are unit-testable off-disk.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

fn stash_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/tori/hot-exit.json")
}

// --- pure core (explicit path, no globals), unit-tested off-disk ---

/// Read the stash, or an empty object when there is nothing readable there.
///
/// Never an error. A missing file is the ordinary case (nothing has quit dirty
/// yet), and a corrupt one is a file that has already lost whatever it held:
/// failing the launch over either would turn "your unsaved work is gone" into
/// "the editor will not start", which is strictly worse.
fn load_from(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn save_to(path: &Path, stash: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(stash).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

// --- commands ---

#[tauri::command(async)]
pub fn hot_exit_load() -> Value {
    load_from(&stash_path())
}

/// Write the stash. **This one does report failure**, unlike the read: the
/// caller is a quit deciding whether it may skip the "unsaved edits will be
/// lost" prompt, and it may only skip it if the work actually landed somewhere.
#[tauri::command(async)]
pub fn hot_exit_save(stash: Value) -> Result<(), String> {
    save_to(&stash_path(), &stash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tori-hot-exit-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("hot-exit.json")
    }

    #[test]
    fn round_trips_what_it_was_given() {
        let p = tmp_file("round-trip");
        let stash = json!({
            "/a/b.txt": {
                "text": "unsaved\r\nlines\r\n",
                "savedAt": 1_700_000_000_000i64,
                // Stands in for `EditorState.toJSON`: nested, and none of it
                // this module's business.
                "state": { "doc": "unsaved\r\nlines\r\n", "history": { "done": [[]] } }
            }
        });
        save_to(&p, &stash).unwrap();

        assert_eq!(load_from(&p), stash);
    }

    #[test]
    fn a_missing_file_is_an_empty_stash_not_an_error() {
        let p = std::env::temp_dir().join("tori-hot-exit-does-not-exist.json");
        let _ = std::fs::remove_file(&p);
        assert_eq!(load_from(&p), json!({}));
    }

    #[test]
    fn a_corrupt_file_is_an_empty_stash_not_an_error() {
        // A quit killed mid-write leaves exactly this. Refusing to launch over
        // it would be a worse outcome than the loss that already happened.
        let p = tmp_file("corrupt");
        std::fs::write(&p, "{\"/a/b.txt\": {\"text\": \"half").unwrap();
        assert_eq!(load_from(&p), json!({}));
    }

    #[test]
    fn a_file_holding_something_that_is_not_an_object_is_empty_too() {
        // Valid JSON, wrong shape. The frontend indexes the stash by path, so a
        // list or a bare string would arrive as an object with no keys anyway;
        // answering `{}` says so rather than letting it find out.
        let p = tmp_file("not-object");
        std::fs::write(&p, "[1, 2, 3]").unwrap();
        assert_eq!(load_from(&p), json!({}));
    }

    #[test]
    fn saving_creates_the_directory_it_needs() {
        let p = tmp_file("mkdir").parent().unwrap().join("nested/deep/hot-exit.json");
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
        save_to(&p, &json!({ "/x": 1 })).unwrap();
        assert_eq!(load_from(&p), json!({ "/x": 1 }));
    }

    #[test]
    fn a_later_save_replaces_the_whole_stash() {
        // The frontend hands over the complete set every time, so an entry it
        // dropped (a file that was saved before quitting) has to disappear
        // rather than survive as a merge.
        let p = tmp_file("replace");
        save_to(&p, &json!({ "/a": 1, "/b": 2 })).unwrap();
        save_to(&p, &json!({ "/b": 3 })).unwrap();
        assert_eq!(load_from(&p), json!({ "/b": 3 }));
    }
}
