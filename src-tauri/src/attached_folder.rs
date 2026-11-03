//! Detection reads a folder's git files rather than running git: the folder is
//! not trusted until it is attached, and running git in it would run its
//! `.git/config`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct LinkedWorktree {
    pub branch: Option<String>,
    pub path: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Layout {
    Plain,
    Clone {
        branch: Option<String>,
        branches: usize,
        remote: Option<String>,
        worktrees: Vec<LinkedWorktree>,
    },
    Bare {
        worktrees: Vec<LinkedWorktree>,
    },
}

#[derive(Serialize, Debug)]
pub struct Attached {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub path: String,
    pub name: String,
    pub layout: Layout,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

enum GitDir {
    None,
    Main { dir: PathBuf, bare: bool },
    WorktreeOf(PathBuf),
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

fn relative_to(base: &Path, target: &str) -> PathBuf {
    let target = Path::new(target);
    if target.is_absolute() {
        target.to_path_buf()
    } else {
        base.join(target)
    }
}

fn canon(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn repo_of_common(common: &Path) -> PathBuf {
    let common = canon(common);
    match common.file_name().and_then(|n| n.to_str()) {
        Some(".git" | ".bare") => common.parent().map(Path::to_path_buf).unwrap_or(common),
        _ => common,
    }
}

fn config_says_bare(gitdir: &Path) -> bool {
    let Some(text) = read_trimmed(&gitdir.join("config")) else {
        return false;
    };
    let mut in_core = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_core = line.eq_ignore_ascii_case("[core]");
        } else if in_core {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim().eq_ignore_ascii_case("bare") {
                    return value.trim().eq_ignore_ascii_case("true");
                }
            }
        }
    }
    false
}

fn git_dir(folder: &Path) -> GitDir {
    let dotgit = folder.join(".git");
    if dotgit.is_dir() {
        let bare = config_says_bare(&dotgit);
        return GitDir::Main { dir: dotgit, bare };
    }
    if dotgit.is_file() {
        let Some(target) = read_trimmed(&dotgit).and_then(|t| t.strip_prefix("gitdir:").map(|g| g.trim().to_string()))
        else {
            return GitDir::None;
        };
        let target = relative_to(folder, &target);
        return match read_trimmed(&target.join("commondir")) {
            Some(common) => GitDir::WorktreeOf(repo_of_common(&relative_to(&target, &common))),
            None => GitDir::Main {
                bare: config_says_bare(&target),
                dir: target,
            },
        };
    }
    let bare = folder.join(".bare");
    if bare.join("HEAD").is_file() {
        return GitDir::Main { dir: bare, bare: true };
    }
    if folder.join("HEAD").is_file() && folder.join("objects").is_dir() {
        return GitDir::Main {
            dir: folder.to_path_buf(),
            bare: true,
        };
    }
    GitDir::None
}

pub(crate) fn repo_of_linked_worktree(folder: &Path) -> Option<PathBuf> {
    let holder = folder.ancestors().find(|a| a.join(".git").exists())?;
    match git_dir(holder) {
        GitDir::WorktreeOf(repo) => Some(repo),
        _ => None,
    }
}

fn head_branch(gitdir: &Path) -> Option<String> {
    read_trimmed(&gitdir.join("HEAD"))?
        .strip_prefix("ref: refs/heads/")
        .map(str::to_string)
}

fn local_branch_count(gitdir: &Path) -> usize {
    fn walk(dir: &Path, prefix: &str, names: &mut HashSet<String>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
            if entry.path().is_dir() {
                walk(&entry.path(), &format!("{name}/"), names);
            } else {
                names.insert(name);
            }
        }
    }
    let mut names = HashSet::new();
    walk(&gitdir.join("refs").join("heads"), "", &mut names);
    if let Some(packed) = read_trimmed(&gitdir.join("packed-refs")) {
        names.extend(
            packed
                .lines()
                .filter_map(|l| l.split_once(' ')?.1.strip_prefix("refs/heads/"))
                .map(str::to_string),
        );
    }
    names.len()
}

fn origin_url(gitdir: &Path) -> Option<String> {
    let text = read_trimmed(&gitdir.join("config"))?;
    let mut in_origin = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_origin = line == "[remote \"origin\"]";
        } else if in_origin {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "url" {
                    return Some(value.trim().to_string());
                }
            }
        }
    }
    None
}

fn linked_worktrees(gitdir: &Path) -> Vec<LinkedWorktree> {
    let mut found: Vec<LinkedWorktree> = std::fs::read_dir(gitdir.join("worktrees"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let admin = entry.path();
            let dotgit = PathBuf::from(read_trimmed(&admin.join("gitdir"))?);
            let folder = dotgit.parent()?;
            folder.is_dir().then(|| LinkedWorktree {
                branch: head_branch(&admin),
                path: folder.to_string_lossy().into_owned(),
            })
        })
        .collect();
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

fn layout_of(gitdir: &GitDir) -> Layout {
    match gitdir {
        GitDir::Main { dir, bare: true } => Layout::Bare {
            worktrees: linked_worktrees(dir),
        },
        GitDir::Main { dir, bare: false } => Layout::Clone {
            branch: head_branch(dir),
            branches: local_branch_count(dir),
            remote: origin_url(dir),
            worktrees: linked_worktrees(dir),
        },
        GitDir::None | GitDir::WorktreeOf(_) => Layout::Plain,
    }
}

pub(crate) struct Surroundings {
    pub root: Option<PathBuf>,
    pub home: Option<PathBuf>,
    pub own_state: PathBuf,
    pub attached: Vec<(PathBuf, String)>,
}

impl Surroundings {
    fn current(except: Option<&Path>) -> Self {
        let raw = crate::config::attached_entries();
        Self {
            root: crate::config::discovery_root(),
            home: dirs::home_dir(),
            own_state: crate::owned_state::config_dir(),
            attached: raw
                .into_iter()
                .filter(|(path, _)| except.is_none_or(|e| canon(e) != canon(path)))
                .collect(),
        }
    }
}

fn refusal(folder: &Path, gitdir: &GitDir, around: &Surroundings) -> Option<String> {
    let folder = canon(folder);
    if folder.parent().is_none() || around.home.as_deref().map(canon).is_some_and(|h| h == folder) {
        return Some("Pick a project folder, not your home folder or the whole disk.".into());
    }
    if let Some(root) = around.root.as_deref().map(canon) {
        if folder.starts_with(&root) {
            return Some("This folder is inside your base folder, so it's already in a space.".into());
        }
        if root.starts_with(&folder) {
            return Some("This folder holds your base folder. Pick a project folder inside it.".into());
        }
    }
    let own = canon(&around.own_state);
    if folder.starts_with(&own) || own.starts_with(&folder) {
        return Some("This folder holds Tori's own files.".into());
    }
    for (path, name) in &around.attached {
        let path = canon(path);
        if path == folder {
            return Some(format!("Already attached as {name}."));
        }
        if folder.starts_with(&path) {
            return Some(format!("This folder is inside {name}, which is already attached."));
        }
        if path.starts_with(&folder) {
            return Some(format!("This folder holds {name}, which is already attached."));
        }
    }
    if let GitDir::WorktreeOf(repo) = gitdir {
        return Some(format!(
            "This is a worktree of {}. Attach that repository instead.",
            repo.display()
        ));
    }
    None
}

fn inspect_in(folder: &Path, around: &Surroundings) -> Result<Inspection, String> {
    if !folder.is_dir() {
        return Err(format!("{} is not a folder", folder.display()));
    }
    let gitdir = git_dir(folder);
    Ok(Inspection {
        path: folder.to_string_lossy().into_owned(),
        name: crate::config::attached_name(None, folder),
        layout: layout_of(&gitdir),
        refused: refusal(folder, &gitdir, around),
    })
}

fn clean(path: &str) -> PathBuf {
    let trimmed = path.trim();
    PathBuf::from(trimmed.strip_suffix('/').filter(|t| !t.is_empty()).unwrap_or(trimmed))
}

/// What attaching `path` would attach, or why it can't be.
#[tauri::command(async)]
pub fn inspect_folder(path: String) -> Result<Inspection, String> {
    inspect_in(&clean(&path), &Surroundings::current(None))
}

fn unit_folders(inspection: &Inspection) -> Vec<String> {
    let worktrees = match &inspection.layout {
        Layout::Plain => return vec![inspection.path.clone()],
        Layout::Clone { worktrees, .. } | Layout::Bare { worktrees } => worktrees,
    };
    let mut folders = vec![inspection.path.clone()];
    folders.extend(worktrees.iter().map(|w| w.path.clone()));
    folders
}

fn seed_trust_and_adopt(inspection: &Inspection) -> Vec<String> {
    let folder = Path::new(&inspection.path);
    let mut failed = Vec::new();
    for unit in unit_folders(inspection) {
        let outside = !Path::new(&unit).starts_with(folder);
        if unit == inspection.path || outside {
            if let Err(e) = crate::trust::trust(&unit) {
                failed.push(format!("{unit} is not trusted ({e})"));
            }
        }
        if let Err(e) = crate::sessions::adopt(&unit) {
            failed.push(format!("sessions in {unit} were not adopted ({e})"));
        }
    }
    failed
}

/// Attach `path` to Global under `name`, trusting it, since the user picked
/// it in a system dialog.
#[tauri::command(async)]
pub fn attach_folder(app: tauri::AppHandle, path: String, name: String) -> Result<Attached, String> {
    let folder = clean(&path);
    let inspection = {
        let store = crate::exec::cross_process_store_lock("config")?;
        let inspection = inspect_in(&folder, &Surroundings::current(None))?;
        if let Some(why) = &inspection.refused {
            return Err(why.clone());
        }
        let name = crate::config::attached_name(Some(&name), &folder);
        crate::config::write_attached_folder(&store, &inspection.path, Some(&name))?;
        inspection
    };
    let failed = seed_trust_and_adopt(&inspection);
    let _ = tauri::Emitter::emit(&app, "config://changed", ());
    Ok(Attached {
        warning: (!failed.is_empty()).then(|| format!("Attached, but {}.", failed.join("; "))),
        path: inspection.path,
    })
}

/// Forget an attached folder. Nothing on disk changes, and its transcripts stay.
#[tauri::command(async)]
pub fn detach_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    {
        let store = crate::exec::cross_process_store_lock("config")?;
        crate::config::remove_attached_folder(&store, &clean(&path).to_string_lossy())?;
    }
    let _ = tauri::Emitter::emit(&app, "config://changed", ());
    Ok(())
}

pub(crate) fn rekey_value(value: &mut Value, old: &str, new: &str) -> bool {
    let moved = |s: &str| -> Option<String> {
        if s == old {
            Some(new.to_string())
        } else {
            s.strip_prefix(old)
                .filter(|rest| rest.starts_with('/'))
                .map(|rest| format!("{new}{rest}"))
        }
    };
    match value {
        Value::String(s) => match moved(s) {
            Some(m) => {
                *s = m;
                true
            }
            None => false,
        },
        Value::Array(items) => {
            let mut changed = false;
            for item in items.iter_mut() {
                changed |= rekey_value(item, old, new);
            }
            changed
        }
        Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            let mut changed = false;
            for key in keys {
                if let Some(to) = moved(&key) {
                    if let Some(v) = map.remove(&key) {
                        map.insert(to, v);
                        changed = true;
                    }
                }
            }
            for v in map.values_mut() {
                changed |= rekey_value(v, old, new);
            }
            changed
        }
        _ => false,
    }
}

pub(crate) fn rekey_file(file: &Path, old: &str, new: &str) -> Result<(), String> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    let mut value: Value = json5::from_str(&text).map_err(|e| format!("{} does not parse: {e}", file.display()))?;
    if rekey_value(&mut value, old, new) {
        let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        crate::owned_state::write_atomically(file, &text)?;
    }
    Ok(())
}

/// Re-point a missing attached folder at where it is now, with every store
/// Tori keys by its path. Sessions recorded at the old path stay there.
#[tauri::command(async)]
pub fn relocate_attached_folder(app: tauri::AppHandle, old: String, new: String) -> Result<(), String> {
    let old = clean(&old).to_string_lossy().into_owned();
    let folder = clean(&new);
    let store = crate::exec::cross_process_store_lock("config")?;
    let inspection = inspect_in(&folder, &Surroundings::current(Some(Path::new(&old))))?;
    if let Some(why) = &inspection.refused {
        return Err(why.clone());
    }
    crate::config::relocate_attached_entry(&store, &old, &inspection.path)?;
    let new = inspection.path.as_str();
    let mut failed = Vec::new();
    for (what, result) in [
        ("branches", crate::config::rekey_attached_branches(&store, &old, new)),
        ("sessions", crate::sessions::rekey_adopted(&old, new)),
        ("issues", crate::issues::store::rekey(&old, new)),
        ("origins", crate::unit_origins::rekey(&old, new)),
        ("trust", crate::trust::rekey(&old, new)),
        ("settings", crate::settings::rekey_project(&old, new)),
    ] {
        if let Err(e) = result {
            failed.push(format!("{what}: {e}"));
        }
    }
    drop(store);
    failed.extend(seed_trust_and_adopt(&inspection));
    let _ = tauri::Emitter::emit(&app, "config://changed", ());
    match failed.is_empty() {
        true => Ok(()),
        false => Err(format!(
            "Moved, but some settings stayed at the old path ({})",
            failed.join("; ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::process::Command;

    fn tmp() -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("tori_attach_{n}"));
        std::fs::create_dir_all(&p).unwrap();
        canon(&p)
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t.test")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t.test")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]);
        git(dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        std::fs::write(dir.join("README.md"), "hi").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", "init"]);
    }

    fn around(tmp: &Path) -> Surroundings {
        Surroundings {
            root: Some(tmp.join("root")),
            home: Some(tmp.join("home")),
            own_state: tmp.join("home/.config/tori"),
            attached: vec![(tmp.join("home/clients/acme"), "acme".into())],
        }
    }

    #[test]
    fn an_outside_worktree_belongs_to_its_attached_repo_and_cannot_be_attached_itself() {
        let tmp = tmp();
        let around = around(&tmp);
        let site = tmp.join("site");
        repo(&site);
        let lib = tmp.join("lib.git");
        git(
            &tmp,
            &["clone", "-q", "--bare", &site.to_string_lossy(), &lib.to_string_lossy()],
        );
        let outside = tmp.join("elsewhere/lib-main");
        git(&lib, &["worktree", "add", "-q", &outside.to_string_lossy(), "main"]);

        let in_outside = outside.join("src").to_string_lossy().into_owned();
        assert_eq!(
            crate::rpc::events::project_of(&in_outside, std::slice::from_ref(&lib)),
            Some(lib.to_string_lossy().into_owned())
        );
        let refused = inspect_in(&outside, &around).unwrap().refused.unwrap();
        assert!(refused.starts_with("This is a worktree of"), "{refused}");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn each_refusal_names_its_reason() {
        let tmp = tmp();
        let around = around(&tmp);
        let refused = |rel: &str| {
            let dir = tmp.join(rel);
            std::fs::create_dir_all(&dir).unwrap();
            inspect_in(&dir, &around).unwrap().refused
        };
        assert!(refused("home").unwrap().contains("home folder"));
        assert!(refused("root/work/web").unwrap().contains("inside your base folder"));
        let holds_root = inspect_in(&tmp, &around).unwrap().refused.unwrap();
        assert!(holds_root.contains("holds your base folder"), "{holds_root}");
        assert!(refused("home/.config").unwrap().contains("Tori's own files"));
        assert_eq!(refused("home/clients/acme").unwrap(), "Already attached as acme.");
        assert!(refused("home/clients/acme/docs").unwrap().contains("inside acme"));
        assert!(refused("home/clients").unwrap().contains("holds acme"));
        assert_eq!(refused("home/thesis"), None);
        let disk = inspect_in(Path::new("/"), &around).unwrap().refused;
        assert!(disk.unwrap().contains("whole disk"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn rekeying_moves_keys_and_paths_inside_the_folder_only() {
        let mut store = json!({
            "chat": { "/old/site": { "model": "opus" }, "/old/site-2": { "model": "x" } },
            "paths": ["/old/site", "/old/site/.tori/worktrees/a", "/other"],
            "trusted": ["/old/site"],
        });
        assert!(rekey_value(&mut store, "/old/site", "/new/site"));
        assert_eq!(
            store,
            json!({
                "chat": { "/new/site": { "model": "opus" }, "/old/site-2": { "model": "x" } },
                "paths": ["/new/site", "/new/site/.tori/worktrees/a", "/other"],
                "trusted": ["/new/site"],
            })
        );
        assert!(!rekey_value(&mut store, "/old/site", "/new/site"));
    }

    #[test]
    fn a_store_file_is_rewritten_only_when_something_moved() {
        let tmp = tmp();
        let file = tmp.join("unit_issues.json");
        std::fs::write(&file, r#"{"/old/site": {"main": {"key": "1"}}}"#).unwrap();
        rekey_file(&file, "/old/site", "/new/site").unwrap();
        let moved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(moved, json!({"/new/site": {"main": {"key": "1"}}}));
        rekey_file(&tmp.join("absent.json"), "/old/site", "/new/site").unwrap();
        assert!(!tmp.join("absent.json").exists());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
