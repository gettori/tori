//! A chat is a folder Tori owns, `chats/<id>`, and every session spawned with
//! it as cwd: the first send, and the forks, rewinds and handoffs that follow
//! keep the cwd, so they stay one chat and share what it wrote.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Past this many files a listing stops, so an agent that unpacks an archive
/// into its folder cannot stall the panel.
const LIST_CAP: usize = 500;

pub fn root() -> PathBuf {
    crate::owned_state::config_dir().join("chats")
}

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

/// The id is joined onto the root, so anything but a plain name is refused
/// rather than letting `..` point a delete somewhere else.
fn folder_of(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("not a chat id: {id}"));
    }
    Ok(root.join(id))
}

#[tauri::command]
pub fn chats_root() -> String {
    root().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn chat_new() -> Result<NewChat, String> {
    new_in(&root())
}

fn new_in(root: &Path) -> Result<NewChat, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let folder = folder_of(root, &id)?;
    std::fs::create_dir_all(&folder).map_err(|e| format!("cannot create {}: {e}", folder.display()))?;
    Ok(NewChat {
        id,
        folder: folder.to_string_lossy().into_owned(),
    })
}

#[tauri::command(async)]
pub fn chat_delete(chat_id: String) -> Result<(), String> {
    delete_in(&root(), &chat_id)
}

fn delete_in(root: &Path, id: &str) -> Result<(), String> {
    let folder = folder_of(root, id)?;
    match std::fs::remove_dir_all(&folder) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("cannot delete {}: {e}", folder.display())),
        _ => Ok(()),
    }
}

#[tauri::command(async)]
pub fn chat_artifacts(chat_id: String, transcripts: Vec<String>) -> Result<Artifacts, String> {
    artifacts_in(&root(), &chat_id, &transcripts, &crate::attachments::dir())
}

fn artifacts_in(root: &Path, id: &str, transcripts: &[String], attachments: &Path) -> Result<Artifacts, String> {
    let mut made = Vec::new();
    walk(&folder_of(root, id)?, &mut made);
    let mut added: Vec<Artifact> = Vec::new();
    for transcript in transcripts {
        for holder in crate::attachments::holders_named_by(Path::new(transcript), attachments) {
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
    fn a_new_chat_is_a_fresh_folder_under_the_root() {
        let root = temp_root("new");
        let a = new_in(&root).unwrap();
        let b = new_in(&root).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(Path::new(&a.folder), root.join(&a.id));
        assert!(Path::new(&a.folder).is_dir());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn deleting_a_chat_removes_its_folder_and_everything_its_sessions_wrote() {
        let root = temp_root("delete");
        let chat = new_in(&root).unwrap();
        let folder = PathBuf::from(&chat.folder);
        std::fs::write(folder.join("first.md"), "from the first session").unwrap();
        std::fs::create_dir_all(folder.join("out")).unwrap();
        std::fs::write(folder.join("out/fork.csv"), "from a fork").unwrap();
        delete_in(&root, &chat.id).unwrap();
        assert!(!folder.exists());
        assert!(root.is_dir());
        delete_in(&root, &chat.id).unwrap();
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn artifacts_list_the_folder_without_dot_entries_and_the_attachments_its_sessions_name() {
        let root = temp_root("list");
        let chat = new_in(&root).unwrap();
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
            &chat.id,
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
