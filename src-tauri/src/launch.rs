use std::path::Path;

/// Is there something at `path` worth revealing?
///
/// `symlink_metadata`, so a **dangling** symlink still counts: it is a real
/// entry the user can see and repair in Finder, and following the link would
/// report it missing and offer nothing. Split out from the command so it can be
/// tested without a test run opening Finder windows.
fn check_reveal_target(path: &str) -> Result<(), String> {
    std::fs::symlink_metadata(path)
        .map(|_| ())
        .map_err(|e| format!("cannot reveal {path}: {e}"))
}

/// Reveal a file or folder in Finder, selected in its parent.
#[tauri::command(async)]
pub fn reveal_in_finder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    check_reveal_target(&path)?;
    crate::platform::native::reveal(&app, Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// The command itself is not called here: it opens a Finder window, and a
    /// test suite that rearranges the user's desktop is a test suite nobody
    /// runs. What is testable is the gate in front of it.
    #[test]
    fn reveal_refuses_a_path_with_nothing_at_it_and_accepts_a_broken_link() {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tori_reveal_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();

        let gone = dir.join("gone.md");
        let err = check_reveal_target(&gone.to_string_lossy()).unwrap_err();
        assert!(err.contains("cannot reveal"), "{err}");

        let broken = dir.join("broken.md");
        crate::platform::testing::symlink(&dir.join("nowhere.md"), &broken);
        check_reveal_target(&broken.to_string_lossy()).expect("a dangling link is still an entry Finder can show");

        std::fs::remove_dir_all(&dir).ok();
    }
}
