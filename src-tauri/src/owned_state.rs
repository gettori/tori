//! Where Tori's own per-project state lives, and how it is written.
//!
//! Small plumbing shared by every owned store: attempts, chat usage, session
//! locators, ownership claims, and the search index's scratch writes. It says
//! two things and nothing else - *where* a per-project map goes, and *how* a
//! file is replaced without a reader ever seeing half of it.
//!
//! **Why it is a module of its own.** All of this used to live in
//! `chat/rules.rs`, next to the permission-rule engine, because that engine was
//! the first thing to need a durable per-project store. Five other callers
//! followed it there. When the rule engine was deleted (Tori no longer decides
//! tool calls; the agent does) the plumbing had to survive it, and a shared
//! helper reached through `chat::rules::` would have been a module named after
//! the one job it no longer does.
//!
//! Per [[lesson_pure_core_for_global_stores]] everything here is a pure function
//! over explicit inputs; deciding *what* to store belongs to each caller.

use std::path::{Path, PathBuf};

/// Where a per-project store lives, under `kind`.
///
/// Shared so every per-project map keys itself the same way. The directory name
/// carries a readable basename plus a hash of the full path, because two
/// checkouts of one repo are two projects and must not share a store, while a
/// path used verbatim would blow past the filename length cap.
pub fn project_state_path(kind: &str, cwd: &str) -> PathBuf {
    let base = Path::new(cwd)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/tori")
        .join(kind)
        .join(format!("{}-{:016x}.json", sanitize_segment(&base), path_hash(cwd)))
}

/// Reduce a value to a bare path segment.
///
/// The values reaching this are basenames and agent session ids, so it should
/// never do anything - which is exactly why it is here: the result is
/// concatenated into a path, and a `..` or a `/` arriving from a agent we do
/// not control must not be able to point the file somewhere else.
fn sanitize_segment(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// FNV-1a over the path bytes. Not cryptographic and does not need to be: it
/// only has to separate two directories that share a basename.
fn path_hash(cwd: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in cwd.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Replace a file's contents in one step: write a sibling temp, flush it to
/// disk, then rename over the target.
///
/// The rename is what makes this atomic - a reader sees the old file or the new
/// one, never a half-written one. The `sync_all` before it is what makes the
/// contents durable rather than merely the name: without it a crash can leave
/// the renamed file present but empty, which for a state store reads as "nothing
/// here" and is exactly the silent state atomic replacement exists to avoid.
pub fn write_atomically(path: &Path, text: &str) -> Result<(), String> {
    replace(path, text, 0o644)
}

/// `write_atomically` for a file holding secrets: the temp is created `0600`,
/// so the contents are never readable by anyone else, not even before the rename.
pub fn write_private(path: &Path, text: &str) -> Result<(), String> {
    replace(path, text, 0o600)
}

fn replace(path: &Path, text: &str, mode: u32) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let parent = path.parent().ok_or("no parent directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".{}.tmp", path.file_name().unwrap_or_default().to_string_lossy()));
    let _ = std::fs::remove_file(&tmp);
    {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(mode).open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    // The rename itself is only durable once the directory entry is, so a crash
    // straight after this cannot resurrect the file that was replaced.
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_checkouts_sharing_a_basename_get_separate_stores() {
        let a = project_state_path("usage", "/Users/x/Projects/tori/main");
        let b = project_state_path("usage", "/Users/x/Projects/tori-fork/main");
        assert_ne!(a, b, "the hash is what keeps two checkouts of one repo apart");
        assert_eq!(a.parent(), b.parent(), "and they still live under the same kind");
    }

    /// The file name is built from a basename Tori does not choose, so nothing
    /// in it may be able to point the file somewhere else.
    ///
    /// Two facts, and the first is the one that does the work: `Path::file_name`
    /// answers `None` for a path ending in `..`, so a traversal never reaches
    /// the sanitizer at all. The sanitizer is what covers everything else.
    #[test]
    fn nothing_in_the_basename_can_point_the_file_elsewhere() {
        let traversal = project_state_path("usage", "/tmp/..");
        let name = traversal.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with('-'), "a `..` should leave no basename at all, got {name}");

        let odd = project_state_path("usage", "/tmp/we ird.name");
        let name = odd.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("we_ird_name-"), "every character outside the safe set is an underscore: {name}");
        assert!(!name.contains('/'), "a separator would point the file elsewhere: {name}");
        assert_eq!(odd.parent(), traversal.parent(), "and both still land under the same kind");
    }

    #[test]
    fn a_replaced_file_is_never_seen_half_written() {
        let dir = std::env::temp_dir().join(format!("tori-owned-state-{}", std::process::id()));
        let path = dir.join("nested").join("state.json");
        write_atomically(&path, "{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");

        write_atomically(&path, "{\"b\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"b\":2}", "the second write replaces rather than appends");

        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "the temp file should have been renamed away, not left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
