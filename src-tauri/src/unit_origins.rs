//! Which chat session made a branch unit's worktree. Kept beside
//! `unit_issues.json` rather than on the unit for the same reason: a unit is
//! rebuilt from git on every load, and writing `tori.toml` loops its watcher.

use crate::config::BranchUnit;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// A worktree born later than this after its record was made is not the one
// the record is about: the name was reused after a removal outside Tori.
const BIRTH_SLACK: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitOrigin {
    pub session: String,
    pub workspace: String,
    pub at: u64,
}

type RepoOrigins = HashMap<String, UnitOrigin>;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct OriginStore(HashMap<String, RepoOrigins>);

fn norm(path: &str) -> String {
    path.trim_end_matches('/').to_string()
}

#[cfg(test)]
thread_local! {
    static TEST_SEAM: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Stand in for the store file on this thread, so a test of a creation or
/// removal path never reads or writes the real config folder.
#[cfg(test)]
pub(crate) fn seam(file: PathBuf) {
    TEST_SEAM.with(|s| *s.borrow_mut() = Some(file));
}

fn store_path() -> PathBuf {
    #[cfg(test)]
    if let Some(file) = TEST_SEAM.with(|s| s.borrow().clone()) {
        return file;
    }
    crate::owned_state::config_dir().join("unit_origins.json")
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

// The window and the daemon both write, so the cache is keyed on the file's
// mtime rather than trusted until this process writes.
type Stamp = (PathBuf, Option<SystemTime>);
static CACHE: OnceLock<Mutex<(Option<Stamp>, OriginStore)>> = OnceLock::new();

impl OriginStore {
    pub fn current() -> Self {
        let path = store_path();
        let stamp = Some((path.clone(), modified(&path)));
        let cache = CACHE.get_or_init(|| Mutex::new((None, OriginStore::default())));
        let mut held = cache.lock().unwrap_or_else(PoisonError::into_inner);
        if held.0 != stamp || stamp.as_ref().is_some_and(|(_, at)| at.is_none()) {
            *held = (stamp, Self::load_from(&path));
        }
        held.1.clone()
    }

    fn load_from(path: &Path) -> Self {
        Self::load_for_write(path).unwrap_or_default()
    }

    // A read can fall back to empty; a write cannot, or it saves the empty
    // store over a file that only failed to parse and every origin is lost.
    fn load_for_write(path: &Path) -> Result<Self, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{} does not parse: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn save_to(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    pub fn for_repo(&self, repo: &str) -> Option<&RepoOrigins> {
        self.0.get(&norm(repo))
    }

    fn put(&mut self, repo: &str, branch: &str, origin: UnitOrigin, live: impl Fn(&str) -> bool) {
        let entries = self.0.entry(norm(repo)).or_default();
        entries.retain(|b, _| b == branch || live(b));
        entries.insert(branch.to_string(), origin);
    }

    fn drop_branch(&mut self, repo: &str, branch: &str) -> bool {
        let key = norm(repo);
        let Some(entries) = self.0.get_mut(&key) else {
            return false;
        };
        let gone = entries.remove(branch).is_some();
        if entries.is_empty() {
            self.0.remove(&key);
        }
        gone
    }
}

fn born_after(folder: &str, at: u64) -> bool {
    let Ok(born) = std::fs::metadata(folder).and_then(|m| m.created()) else {
        return false;
    };
    born > UNIX_EPOCH + Duration::from_secs(at) + BIRTH_SLACK
}

pub fn attach_unless_reused(units: &mut [BranchUnit], origins: Option<&RepoOrigins>) {
    let Some(origins) = origins else {
        return;
    };
    for unit in units {
        if let Some(branch) = &unit.branch {
            unit.made_by = origins
                .get(branch)
                .filter(|o| !born_after(&unit.folder_path, o.at))
                .cloned();
        }
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// None when git could not be asked, which must never read as "gone".
fn has_ref(repo: &str, name: &str) -> Option<bool> {
    crate::exec::git_in(repo)
        .args(["show-ref", "--verify", "--quiet", name])
        .status()
        .ok()
        .map(|s| s.success())
}

fn kept(local: Option<bool>, remote: Option<bool>) -> bool {
    !(local == Some(false) && remote == Some(false))
}

pub fn record(repo: &str, branch: &str, origin: UnitOrigin) -> Result<(), String> {
    let _held = crate::exec::cross_process_store_lock("unit_origins")?;
    record_in(&store_path(), repo, branch, origin)
}

fn record_in(file: &Path, repo: &str, branch: &str, origin: UnitOrigin) -> Result<(), String> {
    match has_ref(repo, &format!("refs/heads/{branch}")) {
        Some(true) => {}
        Some(false) => return Err(format!("\"{branch}\" is not a local branch here yet")),
        None => return Err(format!("git could not be asked whether \"{branch}\" exists in {repo}")),
    }
    let mut store = OriginStore::load_for_write(file)?;
    store.put(repo, branch, origin, |b| {
        kept(
            has_ref(repo, &format!("refs/heads/{b}")),
            has_ref(repo, &format!("refs/remotes/origin/{b}")),
        )
    });
    store.save_to(file)
}

pub fn forget(repo: &str, branch: &str) -> Result<(), String> {
    let recorded = OriginStore::current()
        .for_repo(repo)
        .is_some_and(|o| o.contains_key(branch));
    if !recorded {
        return Ok(());
    }
    let _held = crate::exec::cross_process_store_lock("unit_origins")?;
    forget_in(&store_path(), repo, branch)
}

fn forget_in(file: &Path, repo: &str, branch: &str) -> Result<(), String> {
    let mut store = OriginStore::load_for_write(file)?;
    if store.drop_branch(repo, branch) {
        store.save_to(file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ProjectKind;
    use std::process::Command;

    fn origin(session: &str, at: u64) -> UnitOrigin {
        UnitOrigin {
            session: session.into(),
            workspace: "/p/main".into(),
            at,
        }
    }

    fn unit(branch: &str, folder: &str) -> BranchUnit {
        BranchUnit {
            label: branch.into(),
            folder_path: folder.into(),
            branch: Some(branch.into()),
            kind: ProjectKind::Worktree,
            is_current: false,
            issue: None,
            made_by: None,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-unit-origins-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    fn repo_with_branch(name: &str, branch: &str) -> PathBuf {
        let dir = scratch(name);
        git(&dir, &["init", "-q", "-b", "main"]);
        git(
            &dir,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "i",
            ],
        );
        git(&dir, &["branch", branch]);
        dir
    }

    #[test]
    fn a_record_round_trips_and_lands_on_its_unit() {
        let dir = repo_with_branch("round", "fix-a");
        let file = dir.join("unit_origins.json");
        let repo = dir.to_string_lossy().into_owned();
        let folder = dir.to_string_lossy().into_owned();

        record_in(&file, &format!("{repo}/"), "fix-a", origin("s1", now())).unwrap();

        let store = OriginStore::load_from(&file);
        let mut units = vec![unit("fix-a", &folder), unit("main", &folder)];
        attach_unless_reused(&mut units, store.for_repo(&repo));
        assert_eq!(units[0].made_by.as_ref().map(|o| o.session.as_str()), Some("s1"));
        assert_eq!(units[1].made_by, None);
    }

    #[test]
    fn a_branch_that_does_not_exist_yet_is_not_recorded() {
        let dir = scratch("early");
        git(&dir, &["init", "-q", "-b", "main"]);
        let file = dir.join("unit_origins.json");
        let err = record_in(&file, &dir.to_string_lossy(), "fix-a", origin("s1", now())).unwrap_err();
        assert!(err.contains("fix-a"));
        assert!(!file.exists());
    }

    #[test]
    fn a_record_is_pruned_once_its_branch_is_gone_everywhere() {
        let mut store = OriginStore::default();
        store.put("/r", "a", origin("s1", 1), |_| true);
        store.put("/other", "a", origin("s9", 1), |_| true);
        store.put("/r", "b", origin("s2", 1), |_| false);
        assert_eq!(store.for_repo("/r").unwrap().keys().collect::<Vec<_>>(), vec!["b"]);
        assert!(store.for_repo("/other").unwrap().contains_key("a"));
    }

    #[test]
    fn forget_drops_only_that_branch() {
        let dir = repo_with_branch("forget", "fix-a");
        git(&dir, &["branch", "fix-b"]);
        let file = dir.join("unit_origins.json");
        let repo = dir.to_string_lossy().into_owned();
        record_in(&file, &repo, "fix-a", origin("s1", now())).unwrap();
        record_in(&file, &repo, "fix-b", origin("s2", now())).unwrap();

        forget_in(&file, &repo, "fix-a").unwrap();

        let store = OriginStore::load_from(&file);
        let kept = store.for_repo(&repo).unwrap();
        assert!(!kept.contains_key("fix-a"));
        assert!(kept.contains_key("fix-b"));
    }

    #[test]
    fn forgetting_an_unknown_branch_writes_nothing() {
        let dir = scratch("forget-none");
        let file = dir.join("unit_origins.json");
        forget_in(&file, "/r", "a").unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn a_worktree_born_after_its_record_does_not_get_it() {
        let dir = scratch("reused");
        let folder = dir.to_string_lossy().into_owned();
        let mut origins = RepoOrigins::new();
        origins.insert("fix-a".into(), origin("old", now() - 3600));
        let mut units = vec![unit("fix-a", &folder)];
        attach_unless_reused(&mut units, Some(&origins));
        assert_eq!(units[0].made_by, None);

        origins.insert("fix-a".into(), origin("new", now()));
        attach_unless_reused(&mut units, Some(&origins));
        assert_eq!(units[0].made_by.as_ref().map(|o| o.session.as_str()), Some("new"));
    }

    #[test]
    fn a_store_that_does_not_parse_is_never_written_over() {
        let dir = repo_with_branch("corrupt", "fix-a");
        let file = dir.join("unit_origins.json");
        std::fs::write(&file, "{ not json").unwrap();
        let repo = dir.to_string_lossy().into_owned();
        assert!(record_in(&file, &repo, "fix-a", origin("s1", now())).is_err());
        assert!(forget_in(&file, &repo, "fix-a").is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");
    }

    #[test]
    fn only_a_branch_git_says_is_gone_everywhere_is_pruned() {
        assert!(!kept(Some(false), Some(false)));
        assert!(kept(Some(true), Some(false)));
        assert!(kept(Some(false), Some(true)));
        assert!(kept(None, Some(false)));
        assert!(kept(Some(false), None));
    }

    #[test]
    fn no_store_file_is_an_empty_store() {
        let store = OriginStore::load_from(Path::new("/nonexistent/unit_origins.json"));
        assert!(store.for_repo("/r").is_none());
    }
}
