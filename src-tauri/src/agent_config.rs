//! Which of an agent's config files exist, per account, and how to make one.
//!
//! The frontend cannot answer this. A `[[config.entries]]` row carries a path
//! *relative to an account home*, and the home is either `[accounts]
//! .home_default` (backend-only, `#[serde(skip)]`) or a profile's own stored
//! home. So the settings page asks here for resolved paths and states rather
//! than joining strings it cannot see.
//!
//! Every rule lives in a pure core taking an **explicit** home, and the
//! `#[tauri::command]` wrappers do nothing but pick the homes. That is what
//! makes the tests real: they run against a temp directory and read `$HOME`
//! nowhere, so a symlink case is a symlink somebody made rather than one that
//! happened to be on the machine.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::accounts::{load, profiles_for};
use crate::agents::{AgentAdapter, ConfigEntry, ConfigKind};

/// What is at an entry's path.
///
/// Four states rather than a bool, because the three ways a path can fail to be
/// a plain file are the three the user needs told apart: nothing there yet (make
/// one), a link somewhere else (edit it, but know where it lands), and a link to
/// nothing (a dotfiles repo that moved, which is the one case where "create" is
/// refused instead of quietly writing through a broken link).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryState {
    Missing,
    Present,
    Symlink,
    Dangling,
}

/// One thing inside a directory row, and the file that opening it means.
///
/// The two are not the same, and assuming they were is what made a skill
/// unopenable: a Claude command is `commands/<name>.md` (the child *is* the
/// file) while a skill is `skills/<name>/SKILL.md` (the child is a folder). The
/// row already declares which shape it has, in `new_path`, so this resolves it
/// once here rather than leaving every caller to guess from the name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildView {
    pub name: String,
    /// The file to open, or `None` for a child there is no honest answer for: a
    /// folder whose declared file is not in it. Tori does not pick a different
    /// one, because "the first markdown in there" is a guess that opens the
    /// wrong file exactly when the folder is malformed.
    pub path: Option<String>,
}

/// One `[[config.entries]]` row, resolved against one account home.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    pub id: String,
    pub label: String,
    pub kind: ConfigKind,
    /// Absolute, and **not** canonicalized: the row names the link, not what it
    /// points at, so the reveal action reveals the link the user declared.
    pub path: String,
    pub state: EntryState,
    /// Where a `symlink`/`dangling` row points, verbatim as stored. `None` in
    /// every other state.
    pub target: Option<String>,
    /// Immediate children of a directory row, sorted. A file row and a
    /// directory that is not there yet report none.
    pub children: Vec<ChildView>,
    pub new_name_hint: Option<String>,
}

/// One account's worth of rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileFilesView {
    pub profile_id: String,
    pub label: String,
    pub home: String,
    pub entries: Vec<EntryView>,
}

/// Everything one adapter's Files section renders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFilesView {
    pub adapter_id: String,
    /// `false` for an adapter with no `[config]` table, which renders one line
    /// saying so rather than an empty list that looks like a missing home.
    pub declared: bool,
    pub profiles: Vec<ProfileFilesView>,
}

// --- pure core: the rules, over an explicit home, with no `$HOME` anywhere ---

/// Resolve every entry against `home`.
pub fn entries_for_home(entries: &[ConfigEntry], home: &Path) -> Vec<EntryView> {
    entries.iter().map(|e| entry_for_home(e, home)).collect()
}

fn entry_for_home(entry: &ConfigEntry, home: &Path) -> EntryView {
    let path = home.join(&entry.path);
    let (state, target) = state_of(&path);
    let children = match state {
        // A symlinked directory lists its children too. The row is still a
        // symlink row (that is what is at the path), but refusing to look
        // through it would hide every skill of anybody who keeps them in a
        // dotfiles repo, which is the common case rather than the exotic one.
        EntryState::Present | EntryState::Symlink => children_of(&path, entry.new_path.as_deref()),
        EntryState::Missing | EntryState::Dangling => Vec::new(),
    };
    EntryView {
        id: entry.id.clone(),
        label: entry.label.clone(),
        kind: entry.kind,
        path: path.to_string_lossy().into_owned(),
        state,
        target,
        children,
        new_name_hint: entry.new_name_hint.clone(),
    }
}

/// `symlink_metadata` rather than `metadata`, because the whole point is to see
/// the link rather than follow it: `metadata` on a dangling link is an error
/// indistinguishable from a missing file, and on a live one it reports the
/// target's kind with no hint that a link was involved.
fn state_of(path: &Path) -> (EntryState, Option<String>) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return (EntryState::Missing, None);
    };
    if !meta.file_type().is_symlink() {
        return (EntryState::Present, None);
    }
    let target = std::fs::read_link(path).map(|t| t.to_string_lossy().into_owned());
    // `exists()` follows the link, which is exactly the question here.
    let state = if path.exists() {
        EntryState::Symlink
    } else {
        EntryState::Dangling
    };
    (state, target.ok())
}

/// The immediate children of a directory row, sorted, each with the file that
/// opening it means.
///
/// `new_path` is the row's own declaration of the shape (`"{name}.md"` or
/// `"{name}/SKILL.md"`), so a child that is a directory resolves through it.
/// The file has to actually be there: a skill folder with no `SKILL.md` is a
/// broken skill, and pointing at it anyway would hand the editor a path it
/// cannot read.
fn children_of(path: &Path, new_path: Option<&str>) -> Vec<ChildView> {
    let Ok(read) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    let mut children: Vec<ChildView> = read
        .flatten()
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = path.join(&name);
            let opens = if child.is_dir() {
                new_path
                    .map(|p| path.join(p.replace("{name}", &name)))
                    .filter(|f| f.is_file())
            } else {
                Some(child)
            };
            ChildView {
                name,
                path: opens.map(|f| f.to_string_lossy().into_owned()),
            }
        })
        .collect();
    children.sort_by(|a, b| a.name.cmp(&b.name));
    children
}

/// Reject a name that would land the new file somewhere other than under the
/// entry's own directory.
///
/// Rejects rather than sanitizes the dangerous shapes, and sanitizes only what
/// is left: a name silently rewritten from `../foo` to `.._foo` would create a
/// file the user did not ask for and then claim success. `sanitize_segment` is
/// still applied afterwards as the guarantee that the result is one path
/// segment, whatever else it contains.
pub fn check_new_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("a name cannot be empty".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(format!("`{trimmed}` cannot contain a path separator"));
    }
    if trimmed.contains("..") {
        return Err(format!("`{trimmed}` cannot contain `..`"));
    }
    if trimmed.starts_with('.') {
        return Err(format!("`{trimmed}` cannot start with a dot"));
    }
    Ok(crate::accounts::sanitize_segment(trimmed))
}

/// Create one new file under `entry`, resolved against `home`, and return its
/// path.
///
/// Refuses to overwrite and refuses a dangling entry. Both refusals are the same
/// rule stated twice: this writes files a person will edit by hand, so the one
/// outcome it must never have is silently replacing one.
pub fn create_in_home(entry: &ConfigEntry, home: &Path, name: &str) -> Result<PathBuf, String> {
    let root = home.join(&entry.path);
    let (state, target) = state_of(&root);
    if state == EntryState::Dangling {
        return Err(format!(
            "{} points at {}, which is not there",
            entry.label,
            target.as_deref().unwrap_or("nothing")
        ));
    }

    let (file, stem) = match entry.kind {
        // A file row's "new" makes the row's own path; there is no name to ask
        // for, so the template's `{name}` takes the file's own stem.
        ConfigKind::File => {
            let stem = root
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            (root, stem)
        }
        ConfigKind::Dir => {
            let name = check_new_name(name)?;
            let new_path = entry
                .new_path
                .as_ref()
                .ok_or_else(|| format!("{} declares no new_path", entry.label))?
                .replace("{name}", &name);
            (root.join(new_path), name)
        }
    };

    if file.exists() || file.symlink_metadata().is_ok() {
        return Err(format!("{} already exists", file.display()));
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let body = entry.template.as_deref().unwrap_or("").replace("{name}", &stem);
    std::fs::write(&file, body).map_err(|e| format!("cannot write {}: {e}", file.display()))?;
    Ok(file)
}

/// Is `name` a bare path segment naming something that is actually in there?
///
/// **Not** [`check_new_name`], and the difference is the whole point.  Creating
/// takes a slug and the row's `new_path` supplies the shape, so a created name
/// is sanitized (`.` becomes `_`) and never carries an extension. Deleting takes
/// the name `read_dir` reported, which is the real one: `gg.md` has a dot in it
/// and has to survive intact, or the delete misses and reports the file it went
/// looking for was never there.
///
/// So this validates and does not rewrite. What it rules out is the spellings
/// that mean something other than "one entry in this directory".
fn check_child_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("a name cannot be empty".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err(format!("`{name}` cannot contain a path separator"));
    }
    if name == "." || name == ".." {
        return Err(format!("`{name}` is not a name"));
    }
    Ok(())
}

/// Delete one child of a directory row, and return what was removed.
///
/// A skill is a folder, a command is a file, and this has to take the whole
/// skill: leaving `skills/<name>/` behind with its `SKILL.md` gone leaves a
/// half-skill the agent may still try to load. So a folder-shaped child goes
/// recursively, which is the one recursive delete in this module and the reason
/// the guards below are worth spelling out.
///
///   * the name is validated as a bare segment (see [`check_child_name`],
///     which validates without rewriting, unlike the create path's);
///   * the resolved child must still sit directly under the entry's own
///     directory after both have been canonicalized, so no link and no `..`
///     smuggled through a filesystem can move the target;
///   * a child that is **itself a symlink** has the link removed, never the
///     tree it points at. Unlinking a skill kept in a dotfiles repo must not
///     delete the dotfiles repo's copy.
pub fn delete_in_home(entry: &ConfigEntry, home: &Path, name: &str) -> Result<PathBuf, String> {
    check_child_name(name)?;
    let root = home.join(&entry.path);
    let child = root.join(name);

    // `symlink_metadata`, so a link is seen as a link rather than as whatever
    // it points at.
    let meta = std::fs::symlink_metadata(&child).map_err(|e| format!("cannot remove {}: {e}", child.display()))?;

    // Belt and braces over `check_new_name`: that rules out the spellings, this
    // rules out the filesystem. A `root` reached through a link is fine (its
    // canonical form is the link's target, and the child canonicalizes under
    // the same one); a child that escapes it is not.
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve {}: {e}", root.display()))?;
    let parent = child
        .parent()
        .ok_or_else(|| format!("{} has no parent", child.display()))?
        .canonicalize()
        .map_err(|e| format!("cannot resolve {}: {e}", child.display()))?;
    if parent != canonical_root {
        return Err(format!("{} is not inside {}", child.display(), root.display()));
    }

    if meta.file_type().is_symlink() || meta.is_file() {
        std::fs::remove_file(&child)
    } else {
        std::fs::remove_dir_all(&child)
    }
    .map_err(|e| format!("cannot remove {}: {e}", child.display()))?;
    Ok(child)
}

// --- thin wrappers: pick the homes, call the core ---

fn adapter(adapter_id: &str) -> Result<&'static AgentAdapter, String> {
    crate::agents::find(adapter_id).ok_or_else(|| format!("unknown agent `{adapter_id}`"))
}

/// Every account's home for this adapter, default first.
///
/// The default account's home is the adapter's `home_default`; a named
/// profile's is its own stored one. A profile with neither is skipped rather
/// than resolved against the process's cwd.
pub(crate) fn homes_for(adapter: &AgentAdapter) -> Vec<(String, String, PathBuf)> {
    let default_home = adapter.accounts.as_ref().and_then(|a| a.home_default.clone());
    let file = load();
    profiles_for(&file, &adapter.id)
        .into_iter()
        .filter_map(|p| {
            let home = match &p.home {
                Some(h) => PathBuf::from(h),
                None => default_home.clone()?,
            };
            Some((p.id, p.label, home))
        })
        .collect()
}

/// Which files this adapter declares, resolved per account.
#[tauri::command]
pub async fn agent_config_files(adapter_id: String) -> Result<ConfigFilesView, String> {
    let adapter = adapter(&adapter_id)?;
    let Some(config) = adapter.config.as_ref() else {
        return Ok(ConfigFilesView {
            adapter_id,
            declared: false,
            profiles: Vec::new(),
        });
    };
    let homes = homes_for(adapter);
    crate::exec::blocking("agent_config_files", move || {
        let profiles = homes
            .into_iter()
            .map(|(profile_id, label, home)| ProfileFilesView {
                profile_id,
                label,
                home: home.to_string_lossy().into_owned(),
                entries: entries_for_home(&config.entries, &home),
            })
            .collect();
        Ok(ConfigFilesView {
            adapter_id,
            declared: true,
            profiles,
        })
    })
    .await
}

/// Create one file under one account's copy of one entry.
#[tauri::command]
pub async fn agent_config_new(
    adapter_id: String,
    profile_id: String,
    entry_id: String,
    name: String,
) -> Result<String, String> {
    let adapter = adapter(&adapter_id)?;
    let config = adapter
        .config
        .as_ref()
        .ok_or_else(|| format!("`{adapter_id}` declares no config files"))?;
    let entry = config
        .entries
        .iter()
        .find(|e| e.id == entry_id)
        .ok_or_else(|| format!("`{adapter_id}` declares no config file `{entry_id}`"))?;
    let (_, _, home) = homes_for(adapter)
        .into_iter()
        .find(|(id, _, _)| *id == profile_id)
        .ok_or_else(|| format!("`{adapter_id}` has no account `{profile_id}` with a home"))?;

    crate::exec::blocking("agent_config_new", move || {
        create_in_home(entry, &home, &name).map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

/// Remove one child of one account's copy of one entry.
#[tauri::command]
pub async fn agent_config_delete(
    adapter_id: String,
    profile_id: String,
    entry_id: String,
    name: String,
) -> Result<String, String> {
    let adapter = adapter(&adapter_id)?;
    let entry = adapter
        .config
        .as_ref()
        .and_then(|c| c.entries.iter().find(|e| e.id == entry_id))
        .ok_or_else(|| format!("`{adapter_id}` declares no config file `{entry_id}`"))?;
    let (_, _, home) = homes_for(adapter)
        .into_iter()
        .find(|(id, _, _)| *id == profile_id)
        .ok_or_else(|| format!("`{adapter_id}` has no account `{profile_id}` with a home"))?;

    crate::exec::blocking("agent_config_delete", move || {
        delete_in_home(entry, &home, &name).map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_home() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        // macOS clocks tick in microseconds, so parallel tests can read the same
        // nanos and share (then delete) one home without the counter.
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori_agent_config_test_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file_entry() -> ConfigEntry {
        ConfigEntry {
            id: "instructions".into(),
            label: "Instructions".into(),
            path: "CLAUDE.md".into(),
            kind: ConfigKind::File,
            new_path: None,
            template: Some("# {name}\n".into()),
            new_name_hint: None,
        }
    }

    fn dir_entry() -> ConfigEntry {
        ConfigEntry {
            id: "skills".into(),
            label: "Skills".into(),
            path: "skills".into(),
            kind: ConfigKind::Dir,
            new_path: Some("{name}/SKILL.md".into()),
            template: Some("---\nname: {name}\n---\n".into()),
            new_name_hint: Some("skill-name".into()),
        }
    }

    /// All four states off one temp home, so the state machine is pinned
    /// against a filesystem somebody built rather than against whatever
    /// `$HOME` happens to hold on the machine running the suite.
    #[test]
    fn every_state_is_reported_from_an_explicit_home() {
        let home = tmp_home();
        let entries = vec![
            ConfigEntry {
                id: "gone".into(),
                path: "gone.md".into(),
                ..file_entry()
            },
            ConfigEntry {
                id: "here".into(),
                path: "here.md".into(),
                ..file_entry()
            },
            ConfigEntry {
                id: "linked".into(),
                path: "linked.md".into(),
                ..file_entry()
            },
            ConfigEntry {
                id: "broken".into(),
                path: "broken.md".into(),
                ..file_entry()
            },
        ];
        std::fs::write(home.join("here.md"), "x").unwrap();
        std::os::unix::fs::symlink(home.join("here.md"), home.join("linked.md")).unwrap();
        std::os::unix::fs::symlink(home.join("nowhere.md"), home.join("broken.md")).unwrap();

        let views = entries_for_home(&entries, &home);
        assert_eq!(views[0].state, EntryState::Missing);
        assert_eq!(views[0].target, None);
        assert_eq!(views[1].state, EntryState::Present);
        assert_eq!(views[2].state, EntryState::Symlink);
        assert!(views[2].target.as_deref().unwrap().ends_with("here.md"));
        assert_eq!(views[3].state, EntryState::Dangling);
        assert!(views[3].target.as_deref().unwrap().ends_with("nowhere.md"));
        // The row names the link, never what it resolves to.
        assert!(views[2].path.ends_with("linked.md"));

        std::fs::remove_dir_all(&home).ok();
    }

    /// A child is not the file. A skill is a *folder* with a `SKILL.md` in it,
    /// so a chip carrying the folder path hands the editor a directory and it
    /// says "Is a directory (os error 21)". `new_path` is the row's own
    /// declaration of which shape it has, so the resolution goes through it.
    #[test]
    fn a_folder_shaped_child_opens_the_file_its_row_declares() {
        let home = tmp_home();
        std::fs::create_dir_all(home.join("skills/beta")).unwrap();
        std::fs::create_dir_all(home.join("skills/alpha")).unwrap();
        std::fs::write(home.join("skills/alpha/SKILL.md"), "x").unwrap();

        let views = entries_for_home(&[dir_entry()], &home);
        assert_eq!(views[0].state, EntryState::Present);
        let kids = &views[0].children;
        assert_eq!(
            kids.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["alpha", "beta"]
        );
        assert!(kids[0].path.as_deref().unwrap().ends_with("skills/alpha/SKILL.md"));
        // `beta` is a folder with no SKILL.md in it. Nothing there is the
        // skill, and picking some other file would open the wrong one exactly
        // when the folder is malformed.
        assert_eq!(kids[1].path, None);

        std::fs::remove_dir_all(&home).ok();
    }

    /// The other shape: a command *is* its file, so the child opens itself.
    #[test]
    fn a_file_shaped_child_opens_itself() {
        let home = tmp_home();
        let entry = ConfigEntry {
            id: "commands".into(),
            label: "Commands".into(),
            path: "commands".into(),
            kind: ConfigKind::Dir,
            new_path: Some("{name}.md".into()),
            template: None,
            new_name_hint: None,
        };
        std::fs::create_dir_all(home.join("commands")).unwrap();
        std::fs::write(home.join("commands/gg.md"), "x").unwrap();

        let views = entries_for_home(&[entry], &home);
        let kids = &views[0].children;
        assert_eq!(kids.len(), 1);
        assert_eq!(kids[0].name, "gg.md");
        assert!(kids[0].path.as_deref().unwrap().ends_with("commands/gg.md"));

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn creating_a_skill_substitutes_the_name_into_the_template() {
        let home = tmp_home();
        let made = create_in_home(&dir_entry(), &home, "commit-helper").unwrap();
        assert!(made.ends_with("skills/commit-helper/SKILL.md"));
        let body = std::fs::read_to_string(&made).unwrap();
        assert!(body.contains("name: commit-helper"), "{body}");
        assert!(!body.contains("{name}"), "{body}");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_duplicate_name_errors_and_changes_nothing() {
        let home = tmp_home();
        let made = create_in_home(&dir_entry(), &home, "dup").unwrap();
        std::fs::write(&made, "mine\n").unwrap();

        let err = create_in_home(&dir_entry(), &home, "dup").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(std::fs::read_to_string(&made).unwrap(), "mine\n");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_name_that_could_escape_the_entry_is_rejected() {
        let home = tmp_home();
        for bad in ["a/b", "..", "../x", ".hidden", "", "   "] {
            let err = create_in_home(&dir_entry(), &home, bad).unwrap_err();
            assert!(
                err.contains("cannot"),
                "`{bad}` should be refused with a reason, got: {err}"
            );
        }
        assert!(!home.join("skills").exists(), "a refused name creates nothing");

        std::fs::remove_dir_all(&home).ok();
    }

    /// Writing through a broken link would create the target rather than fix
    /// the entry, so the user gets told what it points at instead.
    #[test]
    fn a_dangling_entry_refuses_to_be_written_through() {
        let home = tmp_home();
        std::os::unix::fs::symlink(home.join("gone-elsewhere"), home.join("skills")).unwrap();

        let err = create_in_home(&dir_entry(), &home, "anything").unwrap_err();
        assert!(
            err.contains("gone-elsewhere"),
            "the error should name the target: {err}"
        );
        assert!(!home.join("gone-elsewhere").exists());

        std::fs::remove_dir_all(&home).ok();
    }

    /// A skill is a folder, so removing one has to take the folder. Leaving
    /// `skills/<name>/` behind with its SKILL.md gone is a half-skill the agent
    /// may still try to load.
    #[test]
    fn removing_a_folder_shaped_child_takes_the_whole_folder() {
        let home = tmp_home();
        create_in_home(&dir_entry(), &home, "doomed").unwrap();
        std::fs::write(home.join("skills/doomed/notes.md"), "x").unwrap();
        create_in_home(&dir_entry(), &home, "keeper").unwrap();

        let gone = delete_in_home(&dir_entry(), &home, "doomed").unwrap();

        assert!(gone.ends_with("skills/doomed"));
        assert!(!home.join("skills/doomed").exists());
        assert!(home.join("skills/keeper/SKILL.md").exists());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn removing_a_file_shaped_child_takes_the_file() {
        let home = tmp_home();
        let entry = ConfigEntry {
            id: "commands".into(),
            path: "commands".into(),
            new_path: Some("{name}.md".into()),
            ..dir_entry()
        };
        create_in_home(&entry, &home, "gg").unwrap();

        // The name `read_dir` reported, extension and all, which is what the
        // chip carries and what a sanitizing check would have mangled.
        delete_in_home(&entry, &home, "gg.md").unwrap();

        assert!(!home.join("commands/gg.md").exists());
        // The row's own directory is not the child's to take with it.
        assert!(home.join("commands").is_dir());

        std::fs::remove_dir_all(&home).ok();
    }

    /// Unlinking a skill kept in a dotfiles repo must remove the link and not
    /// the repo's copy of it. `remove_dir_all` through a link would have taken
    /// the tree at the other end.
    #[test]
    fn removing_a_linked_child_takes_the_link_not_its_target() {
        let home = tmp_home();
        let real = home.join("elsewhere");
        std::fs::create_dir_all(real.join("inner")).unwrap();
        std::fs::write(real.join("SKILL.md"), "x").unwrap();
        std::fs::create_dir_all(home.join("skills")).unwrap();
        std::os::unix::fs::symlink(&real, home.join("skills/linked")).unwrap();

        delete_in_home(&dir_entry(), &home, "linked").unwrap();

        assert!(std::fs::symlink_metadata(home.join("skills/linked")).is_err());
        assert!(real.join("SKILL.md").exists(), "the target survives");
        assert!(real.join("inner").is_dir());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_name_that_could_escape_the_entry_cannot_delete_either() {
        let home = tmp_home();
        std::fs::create_dir_all(home.join("skills")).unwrap();
        std::fs::write(home.join("bystander.md"), "x").unwrap();

        for bad in ["../bystander.md", "a/b", "..", "", "   "] {
            assert!(
                delete_in_home(&dir_entry(), &home, bad).is_err(),
                "`{bad}` was accepted"
            );
        }
        assert!(home.join("bystander.md").exists());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn removing_something_that_is_not_there_says_so() {
        let home = tmp_home();
        std::fs::create_dir_all(home.join("skills")).unwrap();

        let err = delete_in_home(&dir_entry(), &home, "ghost").unwrap_err();
        assert!(err.contains("cannot remove"), "{err}");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_missing_file_entry_is_created_from_its_own_path() {
        let home = tmp_home();
        let made = create_in_home(&file_entry(), &home, "").unwrap();
        assert!(made.ends_with("CLAUDE.md"));
        assert_eq!(std::fs::read_to_string(&made).unwrap(), "# CLAUDE\n");

        let err = create_in_home(&file_entry(), &home, "").unwrap_err();
        assert!(err.contains("already exists"), "{err}");

        std::fs::remove_dir_all(&home).ok();
    }
}
