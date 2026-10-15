use std::process::Command;

use crate::env::augmented_path;

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
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    check_reveal_target(&path)?;
    crate::exec::spawn_detached(Command::new("open").env("PATH", augmented_path()).arg("-R").arg(&path))
        .map_err(|e| e.to_string())
}

/// Kinds a click may hand to their default app: documents and media, whose
/// default app shows them. An allowlist, because a denylist only knows the
/// launchers someone thought of, and agents write files.
const OPENABLE_EXTENSIONS: &[&str] = &[
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "pages", "numbers", "key", "epub",
    "csv", "tsv", "html", "htm", "svg", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif",
    "avif", "ico", "psd", "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "mp4", "m4v", "mov", "webm", "mkv", "avi",
];

/// Resolve `path` and say whether its default app may be asked to open it.
///
/// Checked on the link's target, not the link: `notes.pdf` pointing at a
/// `.command` would otherwise pass on its name and run on its target.
fn check_open_target(path: &str) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let real = std::fs::canonicalize(path).map_err(|e| format!("cannot open {path}: {e}"))?;
    let meta = std::fs::metadata(&real).map_err(|e| format!("cannot open {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    if meta.permissions().mode() & 0o111 != 0 {
        return Err(format!(
            "Tori does not open executable files outside the editor: {path}"
        ));
    }
    let ext = real
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !OPENABLE_EXTENSIONS.contains(&ext.as_str()) {
        let kind = if ext.is_empty() {
            "files without an extension".to_string()
        } else {
            format!(".{ext} files")
        };
        return Err(format!(
            "Tori opens documents and media in their default app, not {kind}."
        ));
    }
    Ok(real)
}

/// Open a document or media file in the app the system picks for it.
#[tauri::command(async)]
pub fn open_in_default_app(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let real = check_open_target(&path)?;
    app.opener()
        .open_path(real.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
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
        std::os::unix::fs::symlink(dir.join("nowhere.md"), &broken).unwrap();
        check_reveal_target(&broken.to_string_lossy()).expect("a dangling link is still an entry Finder can show");

        std::fs::remove_dir_all(&dir).ok();
    }
}
