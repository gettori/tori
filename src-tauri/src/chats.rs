//! A chat is a folder Tori owns, `chats/<space>/<id>`, and every session spawned
//! with it as cwd: the first send, and the forks, rewinds and handoffs that
//! follow keep the cwd, so they stay one chat and share what it wrote. Home's
//! chats sit under `.home`, a name no space can have, since spaces skip
//! dot folders.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Past this many files a listing stops, so an agent that unpacks an archive
/// into its folder cannot stall the panel.
const LIST_CAP: usize = 500;

pub fn root() -> PathBuf {
    crate::owned_state::config_dir().join("chats")
}

const HOME: &str = ".home";

#[derive(Serialize)]
pub struct NewChat {
    id: String,
    folder: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Artifact {
    path: String,
    name: String,
    size: u64,
    modified: u64,
}

#[derive(Debug, Serialize, Default)]
pub struct Artifacts {
    made: Vec<Artifact>,
    added: Vec<Artifact>,
}

fn is_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn is_space(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\'])
}

/// The folder a space's chats live in, Home's for `None`. A name is joined onto
/// the root, so anything that could climb out of it is refused.
fn space_dir(root: &Path, space: Option<&str>) -> Result<PathBuf, String> {
    match space {
        None => Ok(root.join(HOME)),
        Some(name) if is_space(name) => Ok(root.join(name)),
        Some(name) => Err(format!("not a space name: {name}")),
    }
}

/// A chat folder handed back from the frontend, accepted only as exactly
/// `<root>/<space or .home>/<id>`, so a delete can never point anywhere else.
fn chat_folder(root: &Path, folder: &str) -> Result<PathBuf, String> {
    let refuse = || format!("not a chat folder: {folder}");
    let rel = Path::new(folder).strip_prefix(root).map_err(|_| refuse())?;
    let parts: Vec<&str> = rel
        .components()
        .map(|c| match c {
            std::path::Component::Normal(s) => s.to_str().unwrap_or(""),
            _ => "",
        })
        .collect();
    match parts.as_slice() {
        [space, id] if (*space == HOME || is_space(space)) && is_id(id) => Ok(root.join(space).join(id)),
        _ => Err(refuse()),
    }
}

#[tauri::command]
pub fn chats_root() -> String {
    root().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn chat_new(space: Option<String>) -> Result<NewChat, String> {
    new_in(&root(), space.as_deref())
}

fn new_in(root: &Path, space: Option<&str>) -> Result<NewChat, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let folder = space_dir(root, space)?.join(&id);
    std::fs::create_dir_all(&folder).map_err(|e| format!("cannot create {}: {e}", folder.display()))?;
    Ok(NewChat {
        id,
        folder: folder.to_string_lossy().into_owned(),
    })
}

#[tauri::command(async)]
pub fn chat_delete(folder: String) -> Result<(), String> {
    remove(&chat_folder(&root(), &folder)?)
}

/// Every chat of a deleted space goes with it. Called after the space folder
/// itself is gone; a space that never had a chat has nothing here.
pub fn delete_space_chats(space: &str) -> Result<(), String> {
    remove(&space_dir(&root(), Some(space))?)
}

fn remove(folder: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(folder) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("cannot delete {}: {e}", folder.display())),
        _ => Ok(()),
    }
}

#[tauri::command(async)]
pub fn chat_artifacts(folder: String, transcripts: Vec<String>) -> Result<Artifacts, String> {
    artifacts_in(&root(), &folder, &transcripts, &crate::attachments::dir())
}

fn artifacts_in(root: &Path, folder: &str, transcripts: &[String], attachments: &Path) -> Result<Artifacts, String> {
    let mut made = Vec::new();
    walk(&chat_folder(root, folder)?, &mut made);
    let mut added: Vec<Artifact> = Vec::new();
    for transcript in transcripts {
        for holder in crate::attachments::holders_named_by_cached(Path::new(transcript), attachments) {
            let mut files = Vec::new();
            walk(&holder, &mut files);
            for file in files {
                if !added.iter().any(|a| a.path == file.path) {
                    added.push(file);
                }
            }
        }
    }
    for list in [&mut made, &mut added] {
        list.sort_by_key(|a| std::cmp::Reverse(a.modified));
    }
    Ok(Artifacts { made, added })
}

/// Dot entries are the agent's own state (`.claude`), not something it made
/// for the user. Symlinks are skipped so a link to `/` cannot be walked.
fn walk(dir: &Path, out: &mut Vec<Artifact>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= LIST_CAP {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else { continue };
        if name.starts_with('.') || kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            walk(&entry.path(), out);
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        out.push(Artifact {
            path: entry.path().to_string_lossy().into_owned(),
            name,
            size: meta.len(),
            modified,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori_chats_{tag}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(list: &[Artifact]) -> Vec<&str> {
        list.iter().map(|a| a.name.as_str()).collect()
    }

    #[test]
    fn a_new_chat_is_a_fresh_folder_under_its_space() {
        let root = temp_root("new");
        let a = new_in(&root, None).unwrap();
        let b = new_in(&root, Some("work")).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(Path::new(&a.folder), root.join(".home").join(&a.id));
        assert_eq!(Path::new(&b.folder), root.join("work").join(&b.id));
        assert!(Path::new(&a.folder).is_dir() && Path::new(&b.folder).is_dir());
        assert!(new_in(&root, Some("../out")).is_err());
        assert!(new_in(&root, Some(".home")).is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn only_a_folder_two_levels_under_the_root_is_a_chat() {
        let root = temp_root("folder");
        let ok = |p: &str| chat_folder(&root, &format!("{}/{p}", root.display())).is_ok();
        assert!(ok(".home/abc-1"));
        assert!(ok("work/abc-1"));
        assert!(!ok("abc-1"));
        assert!(!ok("work/abc-1/sub"));
        assert!(!ok("../x/abc-1"));
        assert!(!ok(".other/abc-1"));
        assert!(chat_folder(&root, "/tmp/work/abc-1").is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn deleting_a_chat_removes_its_folder_and_everything_its_sessions_wrote() {
        let root = temp_root("delete");
        let chat = new_in(&root, Some("work")).unwrap();
        let folder = PathBuf::from(&chat.folder);
        std::fs::write(folder.join("first.md"), "from the first session").unwrap();
        std::fs::create_dir_all(folder.join("out")).unwrap();
        std::fs::write(folder.join("out/fork.csv"), "from a fork").unwrap();
        remove(&chat_folder(&root, &chat.folder).unwrap()).unwrap();
        assert!(!folder.exists());
        assert!(root.join("work").is_dir());
        remove(&chat_folder(&root, &chat.folder).unwrap()).unwrap();
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn artifacts_list_the_folder_without_dot_entries_and_the_attachments_its_sessions_name() {
        let root = temp_root("list");
        let chat = new_in(&root, None).unwrap();
        let folder = PathBuf::from(&chat.folder);
        std::fs::create_dir_all(folder.join(".claude")).unwrap();
        std::fs::write(folder.join(".claude/settings.json"), "{}").unwrap();
        std::fs::write(folder.join(".hidden"), "").unwrap();
        std::fs::write(folder.join("plan.md"), "# plan").unwrap();
        std::fs::create_dir_all(folder.join("data")).unwrap();
        std::fs::write(folder.join("data/rows.csv"), "a,b").unwrap();

        let attachments = root.join("attachments");
        std::fs::create_dir_all(attachments.join("h1")).unwrap();
        std::fs::write(attachments.join("h1/brief.pdf"), "pdf").unwrap();
        std::fs::create_dir_all(attachments.join("h2")).unwrap();
        std::fs::write(attachments.join("h2/other.png"), "png").unwrap();
        let transcript = root.join("t.jsonl");
        let named = attachments.join("h1/brief.pdf");
        std::fs::write(&transcript, format!("{{\"text\":\"{}\"}}", named.display())).unwrap();
        let fork = root.join("fork.jsonl");
        std::fs::write(&fork, format!("{{\"text\":\"{}\"}}", named.display())).unwrap();

        let got = artifacts_in(
            &root,
            &chat.folder,
            &[transcript.display().to_string(), fork.display().to_string()],
            &attachments,
        )
        .unwrap();
        let mut made = names(&got.made);
        made.sort();
        assert_eq!(made, ["plan.md", "rows.csv"]);
        assert_eq!(names(&got.added), ["brief.pdf"]);
        std::fs::remove_dir_all(root).ok();
    }
}
