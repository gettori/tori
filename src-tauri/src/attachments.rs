//! Pasted and dropped chat attachments, written to disk so that every
//! attachment is a path the agent reads like any other file. The directory is
//! handed to the agent with `--add-dir`, so a Read there raises no prompt.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The filename rides in this header, percent-encoded, because the body is
/// the file itself.
const NAME_HEADER: &str = "x-sway-attachment-name";

/// Beside the other things Sway keeps for itself, never under a workspace:
/// a worktree can be deleted while the transcript naming the file lives on.
pub fn dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/attachments")
}

#[tauri::command]
pub fn attachments_dir() -> String {
    dir().to_string_lossy().into_owned()
}

/// The bytes ride as the raw request body rather than as base64 in JSON: a
/// 30MB PDF would otherwise be a 40MB string parsed twice on its way here.
#[tauri::command]
pub fn store_attachment(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let name = request
        .headers()
        .get(NAME_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default();
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => return Err("store_attachment takes the file as a raw body".into()),
    };
    store_in(&dir(), &name, bytes)
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` under `dir` as `<id>-<safe name>`, returning the absolute
/// path. The id keeps two pastes of `shot.png` apart; the name keeps the file
/// recognisable to the agent and to anyone looking in the folder.
pub(crate) fn store_in(dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let id = format!("{nanos:x}-{:x}", SEQ.fetch_add(1, Ordering::Relaxed));
    let dest = dir.join(format!("{id}-{}", safe_name(name)));
    std::fs::write(&dest, bytes).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// The last path component only, with separators and control characters
/// gone. A name is what the agent sees, never where the file goes.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control()).take(120).collect();
    if cleaned.is_empty() || cleaned.chars().all(|c| c == '.') {
        "attachment".into()
    } else {
        cleaned
    }
}

fn percent_decode(encoded: &str) -> String {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).filter(|_| bytes[i] == b'%');
        match hex.and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok()) {
            Some(b) => {
                out.push(b);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        std::env::temp_dir().join(format!("sway-attachments-{nanos:x}-{}", std::process::id()))
    }

    #[test]
    fn round_trips_bytes_under_a_recognisable_name() {
        let dir = scratch();
        let path = store_in(&dir, "shot.png", b"\x89PNG").expect("stored");
        assert!(path.starts_with(dir.to_string_lossy().as_ref()));
        assert!(path.ends_with("-shot.png"), "{path}");
        assert_eq!(std::fs::read(&path).expect("read back"), b"\x89PNG");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_pastes_of_the_same_name_are_two_files() {
        let dir = scratch();
        let a = store_in(&dir, "shot.png", b"a").expect("stored");
        let b = store_in(&dir, "shot.png", b"b").expect("stored");
        assert_ne!(a, b);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_name_cannot_choose_where_the_file_goes() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\Users\\x\\shot.png"), "shot.png");
        assert_eq!(safe_name(".."), "attachment");
        assert_eq!(safe_name(""), "attachment");
        assert_eq!(safe_name("a\nb.png"), "ab.png");
    }

    #[test]
    fn the_header_name_comes_back_decoded() {
        assert_eq!(percent_decode("rapport%20%C3%A9t%C3%A9.pdf"), "rapport été.pdf");
        assert_eq!(percent_decode("plain.png"), "plain.png");
        // A stray percent is kept rather than turned into an error the user
        // would have to read about a file they only pasted.
        assert_eq!(percent_decode("100%.png"), "100%.png");
        assert_eq!(safe_name(&percent_decode("%2E%2E%2Fx%2Fr%C3%A9sum%C3%A9.pdf")), "résumé.pdf");
    }
}
