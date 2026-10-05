//! Pasted and dropped chat attachments, written to disk so that every
//! attachment is a path the agent reads like any other file. The directory is
//! handed to the agent with `--add-dir`, so a Read there raises no prompt.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The filename rides in this header, percent-encoded, because the body is
/// the file itself.
const NAME_HEADER: &str = "x-tori-attachment-name";

/// Beside the other things Tori keeps for itself, never under a workspace:
/// a worktree can be deleted while the transcript naming the file lives on.
pub fn dir() -> PathBuf {
    crate::owned_state::config_dir().join("attachments")
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

/// Write `bytes` under `dir` as `<id>/<safe name>`, returning the absolute
/// path. The id is a directory rather than a prefix on the name, so two pastes
/// of `shot.png` stay apart while the file keeps the name the user gave it:
/// that name is what the chip shows and what the agent reads in the path.
pub(crate) fn store_in(dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let id = format!("{nanos:x}-{:x}", SEQ.fetch_add(1, Ordering::Relaxed));
    let holder = dir.join(id);
    std::fs::create_dir_all(&holder).map_err(|e| format!("cannot create {}: {e}", holder.display()))?;
    let dest = holder.join(safe_name(name));
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

/// The holder directories `transcript` names, read before it is deleted: once
/// it is gone nothing can say what it referenced.
///
/// Asked as "which stored file does this text name", never as "which paths does
/// this text contain": the holder id is Tori's own and always plain, so a
/// filename carrying a quote or a backslash cannot escape its way past the
/// scan. The trailing separator keeps `<id>/` from matching `<id>0/`.
pub(crate) fn holders_named_by(transcript: &Path, dir: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read(transcript) else {
        return Vec::new();
    };
    holders_named_in(&text, dir)
}

pub(crate) fn holders_named_in(text: &[u8], dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && contains(text, needle(p).as_bytes()))
        .collect()
}

/// Remove each holder that no transcript under `roots` and no file in
/// `referrers` still names.
///
/// The lifetime rule the plan settled on: a file lives while any transcript
/// names it, because a fork and a chip moved to another tab both leave two
/// turns pointing at one file. `referrers` are Tori's own stores that keep a
/// path outside any transcript, the prompt stash. Anything that cannot be read
/// cannot be spoken for, so a single unreadable file or folder keeps every
/// candidate.
pub(crate) fn drop_unreferenced(holders: &[PathBuf], roots: &[PathBuf], referrers: &[PathBuf]) {
    if holders.is_empty() {
        return;
    }
    let Ok(orphans) = unreferenced(holders, roots, referrers) else {
        return;
    };
    for holder in orphans {
        let _ = std::fs::remove_dir_all(holder);
    }
}

/// Which of `holders` no transcript names, or the error that stopped the sweep
/// before it could say. `<root>/<project>/<file>`, the layout the session index
/// reads these roots by.
fn unreferenced<'a>(
    holders: &'a [PathBuf],
    roots: &[PathBuf],
    referrers: &[PathBuf],
) -> std::io::Result<Vec<&'a PathBuf>> {
    let mut orphans: Vec<&PathBuf> = holders.iter().collect();
    for file in referrers {
        let text = match std::fs::read(file) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        orphans.retain(|h| !contains(&text, needle(h).as_bytes()));
    }
    for root in roots {
        for project in entries(root)?.into_iter().filter(|p| p.is_dir()) {
            for file in entries(&project)?.into_iter().filter(|f| f.is_file()) {
                let text = std::fs::read(&file)?;
                orphans.retain(|h| !contains(&text, needle(h).as_bytes()));
                if orphans.is_empty() {
                    return Ok(orphans);
                }
            }
        }
    }
    Ok(orphans)
}

/// What is in `dir`, and nothing at all for a directory that is not there: a
/// root this machine never made names no file, which is not the same as a root
/// that refused to be read.
fn entries(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    match std::fs::read_dir(dir) {
        Ok(found) => Ok(found.flatten().map(|e| e.path()).collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// What a transcript holds for a file in `holder`: its directory and the
/// separator the filename follows.
fn needle(holder: &Path) -> String {
    format!("{}/", holder.to_string_lossy())
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

fn percent_decode(encoded: &str) -> String {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).filter(|_| bytes[i] == b'%');
        match hex
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
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
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("tori-attachments-{nanos:x}-{}", std::process::id()))
    }

    /// The name the user gave it, unchanged: the id is the directory, so the
    /// chip and the agent both read `shot.png` rather than `<id>-shot.png`.
    #[test]
    fn round_trips_bytes_under_the_name_it_was_given() {
        let dir = scratch();
        let path = store_in(&dir, "shot.png", b"\x89PNG").expect("stored");
        assert!(path.starts_with(dir.to_string_lossy().as_ref()));
        assert!(path.ends_with("/shot.png"), "{path}");
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

    /// A transcript line naming a stored file, the way the transport writes it.
    fn transcript(root: &Path, name: &str, paths: &[&str]) -> PathBuf {
        let project = root.join("proj");
        std::fs::create_dir_all(&project).expect("project dir");
        let file = project.join(name);
        let text: String = paths
            .iter()
            .map(|p| format!("{{\"text\":\"[image 1]: @{p}\"}}\n"))
            .collect();
        std::fs::write(&file, text).expect("transcript");
        file
    }

    fn holder_of(path: &str) -> PathBuf {
        Path::new(path).parent().expect("a holder").to_path_buf()
    }

    /// A fork copies the conversation, so two transcripts name one file. The
    /// file belongs to whichever of them is still there.
    #[test]
    fn an_attachment_outlives_the_transcript_that_sent_it_while_a_fork_names_it() {
        let base = scratch();
        let dir = base.join("attachments");
        let roots = vec![base.join("root")];
        let shared = store_in(&dir, "shot.png", b"a").expect("stored");
        let mine = store_in(&dir, "only.png", b"b").expect("stored");
        let original = transcript(&roots[0], "original.jsonl", &[&shared, &mine]);
        let fork = transcript(&roots[0], "fork.jsonl", &[&shared]);

        let named = holders_named_by(&original, &dir);
        assert_eq!(named.len(), 2, "{named:?}");
        std::fs::remove_file(&original).expect("delete");
        drop_unreferenced(&named, &roots, &[]);
        assert!(Path::new(&shared).exists(), "the fork still names it");
        assert!(!holder_of(&mine).exists(), "the holder goes, not just the file");

        let named = holders_named_by(&fork, &dir);
        std::fs::remove_file(&fork).expect("delete");
        drop_unreferenced(&named, &roots, &[]);
        assert!(!holder_of(&shared).exists(), "nothing names it now");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Profile homes are separate roots, and a session in one is no less a
    /// reference than a session in the other.
    #[test]
    fn an_attachment_named_under_a_second_root_is_kept() {
        let base = scratch();
        let dir = base.join("attachments");
        let roots = vec![base.join("root"), base.join("profile")];
        let shared = store_in(&dir, "shot.png", b"a").expect("stored");
        let mine = transcript(&roots[0], "mine.jsonl", &[&shared]);
        transcript(&roots[1], "theirs.jsonl", &[&shared]);

        let named = holders_named_by(&mine, &dir);
        std::fs::remove_file(&mine).expect("delete");
        drop_unreferenced(&named, &roots, &[]);
        assert!(Path::new(&shared).exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A stashed draft holds its upload outside any transcript, so deleting the
    /// session it was pasted in must leave the file for the stash.
    #[test]
    fn an_attachment_only_a_referrer_names_is_kept() {
        let base = scratch();
        let dir = base.join("attachments");
        let roots = vec![base.join("root")];
        let stashed = store_in(&dir, "shot.png", b"a").expect("stored");
        let sent = transcript(&roots[0], "s.jsonl", &[&stashed]);
        let stash = base.join("stash.json");
        std::fs::write(&stash, format!("[{{\"chips\":[{{\"path\":\"{stashed}\"}}]}}]")).expect("stash");

        let named = holders_named_by(&sent, &dir);
        std::fs::remove_file(&sent).expect("delete");
        drop_unreferenced(&named, &roots, &[base.join("missing.json"), stash.clone()]);
        assert!(Path::new(&stashed).exists(), "the stash still names it");

        std::fs::write(&stash, "[]").expect("emptied");
        drop_unreferenced(&named, &roots, &[stash]);
        assert!(!holder_of(&stashed).exists(), "nothing names it now");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Only what this session named, and only under the attachments dir: a
    /// mentioned file is the user's own and was never Tori's to remove.
    #[test]
    fn a_file_the_transcript_never_named_is_not_a_candidate() {
        let base = scratch();
        let dir = base.join("attachments");
        let stored = store_in(&dir, "shot.png", b"a").expect("stored");
        let elsewhere = base.join("notes.md");
        std::fs::write(&elsewhere, b"notes").expect("write");
        let file = transcript(&base.join("root"), "s.jsonl", &[&elsewhere.to_string_lossy()]);

        assert!(holders_named_by(&file, &dir).is_empty());
        assert!(Path::new(&stored).exists());
        let _ = std::fs::remove_dir_all(&base);
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
        assert_eq!(
            safe_name(&percent_decode("%2E%2E%2Fx%2Fr%C3%A9sum%C3%A9.pdf")),
            "résumé.pdf"
        );
    }
}
