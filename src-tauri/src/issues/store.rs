//! Which issue a branch unit was started from.
//!
//! A branch unit is rebuilt from git on every config load, so the issue cannot
//! live on it. It lives here, in `~/.config/tori/unit_issues.json`, keyed by
//! project path and then branch, beside `attached.json` and for the same
//! reason: writing the watched `tori.toml` would loop the config watcher.
//!
//! A record is written only once its branch exists locally, so no load can see
//! a record without its unit. It is pruned only when its branch is gone both
//! locally and on `origin`, and only on a write: a load never writes.

use crate::config::BranchUnit;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// What a branch unit remembers about its issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitIssue {
    pub key: String,
    pub display: String,
    pub url: String,
    pub title: String,
}

impl From<&super::Issue> for UnitIssue {
    fn from(issue: &super::Issue) -> Self {
        Self {
            key: issue.key.clone(),
            display: issue.display.clone(),
            url: issue.url.clone(),
            title: issue.title.clone(),
        }
    }
}

type RepoIssues = HashMap<String, UnitIssue>;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct IssueStore(HashMap<String, RepoIssues>);

fn norm(path: &str) -> String {
    crate::platform::fs::normalize(path)
}

fn store_path() -> PathBuf {
    crate::owned_state::config_dir().join("unit_issues.json")
}

impl IssueStore {
    pub fn load() -> Self {
        Self::load_from(&store_path())
    }

    fn load_from(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn save_to(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    pub fn for_repo(&self, repo: &str) -> Option<&RepoIssues> {
        self.0.get(&norm(repo))
    }

    fn put(&mut self, repo: &str, branch: &str, issue: UnitIssue, live: impl Fn(&str) -> bool) {
        let entries = self.0.entry(norm(repo)).or_default();
        entries.retain(|b, _| b == branch || live(b));
        entries.insert(branch.to_string(), issue);
    }
}

/// Puts each unit's record on it. Units with none are left as they were.
pub fn attach(units: &mut [BranchUnit], issues: Option<&RepoIssues>) {
    let Some(issues) = issues else {
        return;
    };
    for unit in units {
        if let Some(branch) = &unit.branch {
            unit.issue = issues.get(branch).cloned();
        }
    }
}

fn has_ref(repo: &str, name: &str) -> bool {
    crate::exec::git_in(repo)
        .args(["show-ref", "--verify", "--quiet", name])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Remembers that `branch` in the project at `repo` was started from `issue`.
pub fn record(repo: &str, branch: &str, issue: UnitIssue) -> Result<(), String> {
    record_in(&store_path(), repo, branch, issue)
}

fn record_in(file: &Path, repo: &str, branch: &str, issue: UnitIssue) -> Result<(), String> {
    if !has_ref(repo, &format!("refs/heads/{branch}")) {
        return Err(format!("\"{branch}\" is not a local branch here yet"));
    }
    let lock = crate::exec::named_lock("unit_issues");
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = IssueStore::load_from(file);
    store.put(repo, branch, issue, |b| {
        has_ref(repo, &format!("refs/heads/{b}")) || has_ref(repo, &format!("refs/remotes/origin/{b}"))
    });
    store.save_to(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ProjectKind;

    fn issue(key: &str) -> UnitIssue {
        UnitIssue {
            key: key.into(),
            display: format!("#{key}"),
            url: format!("https://github.com/gettori/tori/issues/{key}"),
            title: "t".into(),
        }
    }

    fn unit(branch: &str) -> BranchUnit {
        BranchUnit {
            label: branch.into(),
            folder_path: "/p".into(),
            branch: Some(branch.into()),
            kind: ProjectKind::Worktree,
            is_current: false,
            issue: None,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-unit-issues-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = crate::platform::process::command("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn a_record_round_trips_and_lands_on_its_unit() {
        let dir = scratch("round");
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
        git(&dir, &["branch", "202-issues"]);
        let file = dir.join("unit_issues.json");
        let repo = dir.to_string_lossy().into_owned();

        record_in(&file, &format!("{repo}/"), "202-issues", issue("202")).unwrap();

        let store = IssueStore::load_from(&file);
        let mut units = vec![unit("202-issues"), unit("main")];
        attach(&mut units, store.for_repo(&repo));
        assert_eq!(units[0].issue, Some(issue("202")));
        assert_eq!(units[1].issue, None);
    }

    #[test]
    fn a_branch_that_does_not_exist_yet_is_not_recorded() {
        let dir = scratch("early");
        git(&dir, &["init", "-q", "-b", "main"]);
        let file = dir.join("unit_issues.json");
        let err = record_in(&file, &dir.to_string_lossy(), "202-issues", issue("202")).unwrap_err();
        assert!(err.contains("202-issues"));
        assert!(!file.exists());
    }

    #[test]
    fn a_record_survives_while_its_branch_is_only_on_the_remote() {
        let mut store = IssueStore::default();
        store.put("/r", "1-a", issue("1"), |_| true);
        // `1-a` is gone locally but `live` still knows it through origin.
        store.put("/r", "2-b", issue("2"), |b| b == "1-a");
        assert_eq!(store.for_repo("/r").unwrap().len(), 2);
    }

    #[test]
    fn a_record_is_pruned_once_its_branch_is_gone_everywhere() {
        let mut store = IssueStore::default();
        store.put("/r", "1-a", issue("1"), |_| true);
        store.put("/other", "1-a", issue("9"), |_| true);
        store.put("/r", "2-b", issue("2"), |_| false);
        assert_eq!(store.for_repo("/r").unwrap().keys().collect::<Vec<_>>(), vec!["2-b"]);
        // Another repo's records are not this write's business.
        assert!(store.for_repo("/other").unwrap().contains_key("1-a"));
    }

    #[test]
    fn no_store_file_is_an_empty_store() {
        let store = IssueStore::load_from(Path::new("/nonexistent/unit_issues.json"));
        assert!(store.for_repo("/r").is_none());
    }
}
