use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

use crate::sessions::SessionIndex;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFacts {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub dirty: bool,
    pub unpushed: bool,
    /// Epoch seconds: the newest of the worktree's creation, its last commit and
    /// the last write to a session anchored in it.
    pub last_activity: u64,
    /// HEAD is the merged pull request's head or behind it, so everything here
    /// went into the merge. False when the caller named no head for the branch.
    pub in_merged_head: bool,
}

/// Every secondary worktree of `project_path` the sweep may consider, with the
/// main checkout, Topic members and fan-out attempts already left out.
/// `merged_heads` maps a branch to the head commit of its merged pull request,
/// and `merged_only` limits the answer to those branches.
#[tauri::command(async)]
pub fn worktree_cleanup_facts(
    index: State<SessionIndex>,
    project_path: String,
    merged_heads: Option<HashMap<String, String>>,
    merged_only: Option<bool>,
) -> Result<Vec<CleanupFacts>, String> {
    let mut owned: HashSet<PathBuf> = crate::unit_home::topics()
        .iter()
        .flat_map(|t| t.members.iter().filter_map(|m| m.worktree_path.as_deref()))
        .map(canon)
        .collect();
    owned.extend(
        crate::attempts::list_attempts(&project_path)
            .iter()
            .map(|a| canon(&a.path)),
    );
    let heads = merged_heads.unwrap_or_default();
    let only = merged_only
        .unwrap_or(false)
        .then(|| heads.keys().cloned().collect::<HashSet<_>>());
    let sessions = crate::sessions::activity_by_cwd(&index);
    Ok(facts_in(&project_path, &owned, &heads, only.as_ref(), |folder| {
        sessions
            .iter()
            .filter(|(cwd, _)| crate::sessions::cwd_matches(cwd, folder))
            .map(|(_, at)| *at)
            .max()
    }))
}

pub(crate) fn facts_in(
    project_path: &str,
    owned: &HashSet<PathBuf>,
    merged_heads: &HashMap<String, String>,
    only: Option<&HashSet<String>>,
    newest_session: impl Fn(&str) -> Option<u64>,
) -> Vec<CleanupFacts> {
    // An unreadable repo lists as empty, which here correctly means "nothing to
    // remove", so no `repo_readable` probe is needed.
    crate::worktree::prune_worktrees(project_path);
    let Ok(listed) = crate::worktree::list_worktrees_body(project_path.to_string()) else {
        return vec![];
    };
    listed
        .into_iter()
        .filter(|w| !w.is_main && !w.is_bare && w.branch != "(detached)" && !w.branch.is_empty())
        .filter(|w| !owned.contains(&canon(&w.path)))
        .filter(|w| only.is_none_or(|o| o.contains(&w.branch)))
        .filter_map(|w| {
            let p = Path::new(&w.path);
            let head = capture(p, &["rev-parse", "HEAD"])?;
            let last_activity = [created_at(p), last_commit(p), newest_session(&w.path)]
                .into_iter()
                .flatten()
                .max()
                .unwrap_or(0);
            // A merged head this clone never fetched fails the check, which keeps
            // the worktree: the safe answer when git cannot say.
            let in_merged_head = merged_heads.get(&w.branch).is_some_and(|sha| {
                crate::git::not_an_option(sha).is_ok() && succeeds(p, &["merge-base", "--is-ancestor", &head, sha])
            });
            Some(CleanupFacts {
                in_merged_head,
                dirty: crate::worktree::tree_dirty(p).unwrap_or(true),
                unpushed: crate::worktree::branch_unpushed(p),
                path: w.path,
                branch: w.branch,
                head,
                last_activity,
            })
        })
        .collect()
}

fn canon(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn succeeds(dir: &Path, args: &[&str]) -> bool {
    crate::exec::git_in(dir)
        .args(args)
        .output()
        .is_ok_and(|o| o.status.success())
}

fn capture(dir: &Path, args: &[&str]) -> Option<String> {
    crate::exec::git_in(dir)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The worktree's admin dir is made by `git worktree add` and nothing rewrites
/// it, so its birth time is when the worktree was created. Without this a fresh
/// worktree off an old base would read as idle since that base was committed.
fn created_at(dir: &Path) -> Option<u64> {
    let git_dir = capture(dir, &["rev-parse", "--absolute-git-dir"])?;
    let meta = std::fs::metadata(git_dir).ok()?;
    let at = meta.created().or_else(|_| meta.modified()).ok()?;
    at.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

fn last_commit(dir: &Path) -> Option<u64> {
    capture(dir, &["log", "-1", "--format=%ct", "HEAD"])?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("tori-cleanup-test-{n}-{}", SEQ.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        canon(dir.to_str().unwrap())
    }

    /// A bare container whose only commit is dated `commit_at`, with a `main`
    /// worktree, the layout `create_worktree` produces.
    fn container(commit_at: u64) -> (PathBuf, PathBuf) {
        let root = tmp();
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q"]);
        git(&src, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&src, &["config", "user.email", "t@t.t"]);
        git(&src, &["config", "user.name", "t"]);
        std::fs::write(src.join("a.txt"), "hi").unwrap();
        git(&src, &["add", "."]);
        let date = format!("@{commit_at} +0000");
        let out = Command::new("git")
            .arg("-C")
            .arg(&src)
            .args(["commit", "-qm", "init"])
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .unwrap();
        assert!(out.status.success());
        let cont = root.join("cont");
        std::fs::create_dir_all(&cont).unwrap();
        git(
            &root,
            &[
                "clone",
                "-q",
                "--bare",
                src.to_str().unwrap(),
                cont.join(".bare").to_str().unwrap(),
            ],
        );
        std::fs::write(cont.join(".git"), "gitdir: ./.bare\n").unwrap();
        git(&cont, &["worktree", "add", "-q", "main", "main"]);
        (root, cont)
    }

    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    const NINE_DAYS: u64 = 9 * 86_400;

    #[test]
    fn the_main_checkout_and_owned_worktrees_are_left_out() {
        let (root, cont) = container(now() - NINE_DAYS);
        git(&cont, &["worktree", "add", "-q", "-b", "feat", "feat", "main"]);
        git(&cont, &["worktree", "add", "-q", "-b", "topic", "topic", "main"]);
        let owned = HashSet::from([canon(cont.join("topic").to_str().unwrap())]);

        let facts = facts_in(cont.to_str().unwrap(), &owned, &HashMap::new(), None, |_| None);
        let mut branches: Vec<&str> = facts.iter().map(|f| f.branch.as_str()).collect();
        branches.sort();
        assert_eq!(
            branches,
            ["feat", "main"],
            "the bare record and the Topic member are not candidates"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_dirty_tree_is_flagged() {
        let (root, cont) = container(now() - NINE_DAYS);
        std::fs::write(cont.join("main/scratch.txt"), "work").unwrap();
        let facts = facts_in(cont.to_str().unwrap(), &HashSet::new(), &HashMap::new(), None, |_| None);
        assert!(facts[0].dirty);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_worktree_made_today_off_an_old_commit_is_active_today() {
        let (root, cont) = container(now() - NINE_DAYS);
        git(&cont, &["worktree", "add", "-q", "-b", "fresh", "fresh", "main"]);
        let facts = facts_in(cont.to_str().unwrap(), &HashSet::new(), &HashMap::new(), None, |_| None);
        let fresh = facts.iter().find(|f| f.branch == "fresh").unwrap();
        assert!(
            fresh.last_activity + 60 >= now(),
            "creation counts, not the base commit's date"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_session_anchored_in_the_worktree_moves_last_activity_forward() {
        let (root, cont) = container(now() - 3 * NINE_DAYS);
        let wt = cont.join("main");
        let later = now() + 3600;
        let facts = facts_in(
            cont.to_str().unwrap(),
            &HashSet::new(),
            &HashMap::new(),
            None,
            |folder| (canon(folder) == wt).then_some(later),
        );
        assert_eq!(facts[0].last_activity, later);
        std::fs::remove_dir_all(&root).ok();
    }
}
