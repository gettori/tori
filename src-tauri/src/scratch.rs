// Scratch buffers: the untitled tabs Cmd+N opens, kept in
// `~/.config/sway/scratch/`.
//
// **A scratch is a file, not a new kind of tab.** That is the whole design, and
// everything else follows from it: the frontend's tab strip, its per-workspace
// restore (`editorTabPersist.ts`), its hot-exit stash and its read/write path
// all key on an absolute path, so a scratch that has one needs no branch in any
// of them. The alternative - a synthetic `sway://scratch/...` id like the commit
// log's - would have cost a special case in each, and `toStore` drops those
// deliberately, so an untitled tab could never have survived a relaunch.
//
// This module therefore does one small thing: hand out the next empty file. The
// same directory convention as `checkpoint.rs` and `hooks.rs`, and the same
// pure-core / thin-command split as `hot_exit.rs`, so naming is unit-testable
// off the real home directory.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const STEM: &str = "Untitled-";

// A directory listing is a moment old by the time the file is created, so the
// create is the real arbiter and this only bounds how many collisions we will
// walk past before giving up.
const MAX_TRIES: usize = 64;

fn scratch_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/sway/scratch")
}

// --- pure core (explicit path, no globals), unit-tested off-disk ---

/// The lowest free `Untitled-N`, given the names already in the directory.
///
/// Lowest rather than highest-plus-one: a scratch that was promoted or closed
/// gives its number back, so a person who opens and abandons a dozen of them is
/// not left typing into `Untitled-137`.
fn next_name(taken: &BTreeSet<String>) -> String {
    (1u32..)
        .map(|n| format!("{STEM}{n}"))
        .find(|name| !taken.contains(name))
        .unwrap_or_else(|| format!("{STEM}1"))
}

fn names_in(dir: &Path) -> BTreeSet<String> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

/// Create the next empty scratch file in `dir` and answer with its path.
///
/// `create_new`, never `create`: the name came from a listing taken a moment
/// ago, and the one outcome worth ruling out is truncating a scratch somebody
/// is still typing into. A name that lost the race is recorded and the walk
/// continues.
fn create_in(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut taken = names_in(dir);
    for _ in 0..MAX_TRIES {
        let name = next_name(&taken);
        let path = dir.join(&name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                taken.insert(name);
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("could not find a free scratch name".to_string())
}

// --- commands ---

/// Where scratch files live. The frontend needs it to tell a scratch tab from
/// any other file tab, which is the one place the two differ: closing an
/// untouched scratch takes its file with it, and saving one under a new name
/// promotes it.
#[tauri::command]
pub fn scratch_dir() -> String {
    scratch_root().to_string_lossy().into_owned()
}

#[tauri::command(async)]
pub fn scratch_new() -> Result<String, String> {
    create_in(&scratch_root()).map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sway-scratch-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn taken(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn starts_at_one_in_an_empty_directory() {
        assert_eq!(next_name(&taken(&[])), "Untitled-1");
    }

    #[test]
    fn fills_the_lowest_gap() {
        assert_eq!(next_name(&taken(&["Untitled-1", "Untitled-3"])), "Untitled-2");
    }

    #[test]
    fn ignores_files_that_are_not_scratch_names() {
        assert_eq!(next_name(&taken(&["notes.md", "Untitled"])), "Untitled-1");
    }

    #[test]
    fn creates_the_directory_and_an_empty_file() {
        let dir = tmp_dir("create");
        let path = create_in(&dir).unwrap();
        assert_eq!(path, dir.join("Untitled-1"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn never_hands_out_a_name_twice() {
        let dir = tmp_dir("twice");
        let first = create_in(&dir).unwrap();
        let second = create_in(&dir).unwrap();
        assert_ne!(first, second);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn leaves_a_scratch_that_already_has_content_alone() {
        // The load-bearing half of `create_new`: a second window (or a stale
        // listing) must never truncate a file somebody is typing into.
        let dir = tmp_dir("existing");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Untitled-1"), "half a thought").unwrap();
        let path = create_in(&dir).unwrap();
        assert_eq!(path, dir.join("Untitled-2"));
        assert_eq!(
            std::fs::read_to_string(dir.join("Untitled-1")).unwrap(),
            "half a thought"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
