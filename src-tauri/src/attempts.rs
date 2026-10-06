// Fan-out: several independent attempts at one task, each in its own worktree,
// with one of them promoted and the rest discarded.
//
// Three shapes here are load-bearing rather than incidental.
//
//   * **Attempts live INSIDE the project root**, under one gitignored
//     dot-directory. Not beside it, where a bare container's worktrees sit: a
//     session whose cwd falls outside the discovered project root fails
//     `sessions::cwd_matches`, so its sessions would not appear under the
//     project at all. See [[concept_folder_anchored_sessions]]. The cost is that
//     every walker over the project now has to skip one more directory, which is
//     why `ATTEMPTS_DIR` is exported and consulted by the watcher, search, the
//     file tree and the checkpoint snapshot rather than each inventing its own
//     name.
//   * **Git is the truth; the map is only what git cannot say.** A worktree is
//     already discoverable via `git worktree list`, so this store records only
//     the three things git has no field for: which group an attempt belongs to
//     and what the group was trying to do. Every read reconciles against git, so
//     a `git worktree remove` run outside Tori leaves no stale entry.
//   * **A promotion deletes; it never merges.** The whole point of fan-out is
//     that the attempts are alternatives, so the winner's branch is kept as it
//     stands and the losers are removed outright. Nothing here runs merge,
//     rebase or cherry-pick, and `promotion_never_merges` pins that.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::owned_state::{project_state_path, write_atomically};

/// The one directory attempts live in, relative to the project root.
///
/// A dot-directory on purpose: `config.rs`'s space scan already skips dotfiles,
/// so a project does not sprout three new spaces the moment it fans out. One
/// directory rather than one per attempt, so every walker has a single name to
/// skip and a stale exclusion cannot leave one attempt visible and another not.
pub const ATTEMPTS_DIR: &str = ".tori-attempts";

/// Dependency and build directories worth cloning into a fresh attempt.
///
/// Cloned rather than reinstalled: `npm install` in three attempts is minutes of
/// waiting before any of them can run, and on APFS a clone is near-free. Kept
/// deliberately short, and matched only at the attempt's top level - a nested
/// `node_modules` comes with its parent, and walking the whole tree looking for
/// more would cost more than it saves.
const CLONED_DIRS: &[&str] = &["node_modules", "vendor", "target", ".venv"];

/// One attempt, as Tori records it. `path` is absolute and is the join key
/// against `git worktree list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub path: String,
    pub group_id: String,
    /// What the group was trying to do, in the user's words. Carried so a
    /// promotion months later can say what was being attempted; git records the
    /// branch but nothing records the question.
    pub goal: String,
}

/// The per-project map. A struct rather than a bare `Vec` so a later field is an
/// addition rather than a format break, and `#[serde(default)]` so a record
/// written by a newer Tori still reads here as its attempts rather than as
/// nothing.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptMap {
    #[serde(default)]
    pub attempts: Vec<Attempt>,
}

fn map_path(root: &str) -> PathBuf {
    project_state_path("attempts", root)
}

/// Read the map as written, without reconciling. Callers that answer a question
/// about the world want [`list_attempts`]; this is for the write path, which
/// must not drop an entry just because git is momentarily unreadable.
fn read_map(root: &str) -> AttemptMap {
    std::fs::read_to_string(map_path(root))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_map(root: &str, map: &AttemptMap) -> Result<(), String> {
    let text = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    write_atomically(&map_path(root), &text)
}

/// Every path `git worktree list` reports for this repo, canonicalized so the
/// join against a recorded path is not defeated by `/private` on macOS or a
/// trailing slash.
fn live_worktree_paths(root: &str) -> Option<Vec<PathBuf>> {
    let worktrees = crate::worktree::list_worktrees_body(root.to_string()).ok()?;
    Some(worktrees.iter().map(|w| canon(&w.path)).collect())
}

fn canon(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

/// The attempts that still exist, reconciled against git.
///
/// **Git is truth.** An attempt whose worktree was removed outside Tori (`git
/// worktree remove`, or an `rm -rf` plus a prune) is dropped from the map here,
/// so a stale entry cannot outlive the thing it describes. The reconciliation is
/// a read that *writes*, which is unusual and deliberate: doing it lazily on the
/// next promotion would mean the tree renders a group that is already gone.
///
/// If git cannot be read at all the recorded map is returned untouched, because
/// "git failed" and "every worktree was deleted" are not the same answer and
/// only one of them should empty the store.
pub fn list_attempts(root: &str) -> Vec<Attempt> {
    let recorded = read_map(root);
    let Some(live) = live_worktree_paths(root) else {
        return recorded.attempts;
    };
    let kept: Vec<Attempt> = recorded
        .attempts
        .iter()
        .filter(|a| live.contains(&canon(&a.path)))
        .cloned()
        .collect();
    if kept.len() != recorded.attempts.len() {
        let _ = write_map(root, &AttemptMap { attempts: kept.clone() });
    }
    kept
}

/// Record an attempt. Separate from creating the worktree so the two failure
/// modes stay apart: a worktree that exists without a record shows up as an
/// ordinary worktree, which is recoverable, while a record without a worktree is
/// exactly what `list_attempts` reconciles away.
fn record(root: &str, attempt: Attempt) -> Result<(), String> {
    let mut map = read_map(root);
    map.attempts.retain(|a| canon(&a.path) != canon(&attempt.path));
    map.attempts.push(attempt);
    write_map(root, &map)
}

fn forget(root: &str, path: &str) -> Result<(), String> {
    let mut map = read_map(root);
    let target = canon(path);
    map.attempts.retain(|a| canon(&a.path) != target);
    write_map(root, &map)
}

/// Clone the dependency and build directories an attempt needs to run.
///
/// `cp -c` asks APFS for a copy-on-write clone and **fails** rather than falling
/// back to a byte copy, which is what makes the disk cost of three attempts a
/// rounding error instead of three `node_modules`. A failure is not fatal: the
/// attempt is still a valid worktree, it just needs its own install, so this
/// returns the names it could not clone rather than aborting the creation.
///
/// `-R` keeps symlinks as symlinks, which is the half that matters for
/// `node_modules/.bin`: those entries are *relative* links into sibling
/// packages, so copying them as links resolves inside the attempt, while
/// following them would flatten each into a copy of the original.
fn clone_dep_dirs(source: &Path, dest: &Path) -> Vec<String> {
    let mut failed = Vec::new();
    for name in CLONED_DIRS {
        let from = source.join(name);
        if !from.is_dir() {
            continue;
        }
        let to = dest.join(name);
        if to.symlink_metadata().is_ok() {
            continue; // the branch tracks it; never clobber real content
        }
        let ok = crate::platform::process::command("cp")
            .arg("-c")
            .arg("-R")
            .arg(&from)
            .arg(&to)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            let _ = std::fs::remove_dir_all(&to);
            failed.push((*name).to_string());
        }
    }
    failed
}

/// What creating an attempt actually produced, so the UI can say a clone was
/// skipped instead of leaving the user to discover it at the first build.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedAttempt {
    pub path: String,
    pub branch: String,
    /// Dependency directories that could not be cloned, e.g. on a non-APFS
    /// volume. Empty is the normal case.
    pub uncloned: Vec<String>,
}

/// Create one attempt: a worktree on `branch`, inside the project's attempts
/// directory, with its dependency directories cloned in.
///
/// The worktree is created with plain `git worktree add`, not
/// [`crate::worktree::create_worktree`], for one reason: that command creates
/// *beside* a bare container and links `.shared/` from its sibling, and an
/// attempt lives inside the project root instead. Removal does go through the
/// shared path, which is where the dirty and live-use guards live.
#[tauri::command]
pub async fn create_attempt(
    app: AppHandle,
    root: String,
    group_id: String,
    goal: String,
    branch: String,
) -> Result<CreatedAttempt, String> {
    crate::exec::git_write("create_attempt", root.clone(), move || {
        create_attempt_body(app, root, group_id, goal, branch)
    })
    .await
}

pub(crate) fn create_attempt_body(
    app: AppHandle,
    root: String,
    group_id: String,
    goal: String,
    branch: String,
) -> Result<CreatedAttempt, String> {
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("Branch name is empty".into());
    }
    let container = Path::new(&root).join(ATTEMPTS_DIR);
    std::fs::create_dir_all(&container).map_err(|e| e.to_string())?;
    ignore_attempts_dir(&root);

    let folder = attempt_folder(&container, &branch)?;
    let target = container.join(&folder);
    let target_str = target.to_string_lossy().into_owned();

    let out = crate::exec::git_in(&root)
        .args(["worktree", "add", "-b", &branch, &target_str])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    let uncloned = clone_dep_dirs(Path::new(&root), &target);
    // After the clone, not before: `link_shared` skips any name the worktree
    // already has, so linking first would let a `.shared/node_modules` win over
    // the attempt's own cloned one. A no-op unless the attempts container has a
    // `.shared/`, which keeps the convention available here without inventing a
    // second meaning for it.
    crate::worktree::link_shared(&container, &target);
    crate::setup::on_created(&root, &target);
    // Tori created this folder: adopt it so a path that once held other sessions
    // does not surface them as this attempt's history.
    let _ = crate::sessions::adopt(&target_str);
    record(
        &root,
        Attempt {
            path: target_str.clone(),
            group_id,
            goal,
        },
    )?;
    let _ = app.emit("config://changed", ());
    Ok(CreatedAttempt {
        path: target_str,
        branch,
        uncloned,
    })
}

/// Pick a folder name inside the attempts directory, never overwriting one that
/// exists. Mirrors `worktree::pick_worktree_folder`'s rule (last segment, then a
/// slug) with a numeric suffix after that, because three attempts at one task
/// routinely want three names from one branch stem.
fn attempt_folder(container: &Path, branch: &str) -> Result<String, String> {
    let base: String = branch
        .rsplit('/')
        .next()
        .unwrap_or(branch)
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    if base.is_empty() {
        return Err("Branch name has no usable folder segment".into());
    }
    if !container.join(&base).exists() {
        return Ok(base);
    }
    for n in 2..100 {
        let candidate = format!("{base}-{n}");
        if !container.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err(format!("Too many attempts named \"{base}\"; remove some first."))
}

/// Keep the attempts directory out of the repo. The rule (and why it is
/// `.git/info/exclude` rather than the user's `.gitignore`) lives in
/// `git::exclude_from_repo`, which the per-workspace settings overlay shares.
fn ignore_attempts_dir(root: &str) {
    crate::git::exclude_from_repo(root, ATTEMPTS_DIR);
}

/// Promote one attempt and discard the rest of its group.
///
/// **The winner is kept as it stands.** Its branch is not merged, rebased or
/// cherry-picked anywhere; promotion means the other attempts stop existing, and
/// what to do with the winning branch afterwards is ordinary git work the user
/// does themselves. See this module's header.
///
/// Everything a loser owned goes with it: the worktree and its branch, the
/// session records anchored at its path, its checkpoint refs and its per-turn
/// attribution files. A leftover in any one of those is a session that shows up
/// in the tree pointing at a directory that is gone.
#[tauri::command(async)]
pub fn promote_attempt(
    app: AppHandle,
    index: tauri::State<'_, crate::sessions::SessionIndex>,
    chat: tauri::State<'_, crate::chat::host::ChatState>,
    root: String,
    winner_path: String,
) -> Result<Vec<String>, String> {
    let attempts = list_attempts(&root);
    let winner = canon(&winner_path);
    let Some(group) = attempts
        .iter()
        .find(|a| canon(&a.path) == winner)
        .map(|a| a.group_id.clone())
    else {
        return Err("That attempt is not recorded, so its group cannot be resolved.".into());
    };

    let mut problems = Vec::new();
    for loser in attempts
        .iter()
        .filter(|a| a.group_id == group && canon(&a.path) != winner)
    {
        // Resolved before the worktree goes: a session is found by its recorded
        // cwd, and once the directory is gone there is nothing left to match on.
        let sessions = crate::sessions::ids_under(&index, &loser.path);
        if let Err(e) = discard_attempt(&root, &loser.path, &sessions, Some(&chat.0.registry)) {
            problems.push(format!("{}: {e}", loser.path));
        }
    }
    // The winner stops being an attempt: its group is decided, and leaving it
    // recorded would render a group of one forever.
    forget(&root, &winner_path)?;
    let _ = app.emit("config://changed", ());
    Ok(problems)
}

/// Remove one attempt and everything anchored at its path.
///
/// Forced, unlike an ordinary worktree removal: a losing attempt is by
/// definition work being thrown away, and the dirty guard exists to stop
/// *accidental* loss. The deliberate half is the promotion confirm in the UI.
///
/// The per-session teardown runs **before** the worktree is removed, because
/// `checkpoint_prune` addresses the repo through a path that is about to stop
/// existing. `registry` is the app's live one or `None` in a test: a second
/// `Registry` built here would write the claims file from its own stale
/// snapshot and drop a running session's claim.
fn discard_attempt(
    root: &str,
    path: &str,
    session_ids: &[String],
    registry: Option<&crate::chat::ownership::Registry>,
) -> Result<(), String> {
    // Everything below writes to the shared repo (refs, the worktree list, a
    // branch delete), so it all queues behind the repository write lock.
    let lock = crate::exec::repo_lock(root);
    let _repo = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let branch = crate::worktree::list_worktrees_body(root.to_string())
        .ok()
        .and_then(|wts| {
            wts.into_iter()
                .find(|w| canon(&w.path) == canon(path))
                .map(|w| w.branch)
        })
        .filter(|b| !b.is_empty() && b != "(detached)");

    for id in session_ids {
        // Refs and the per-turn attribution directory both go; the refs live in
        // the shared repo, so leaving them would outlive the worktree entirely.
        let _ = crate::checkpoint::checkpoint_prune_body(root.to_string(), id.clone());
        if let Some(registry) = registry {
            registry.forget(id);
        }
    }

    // The shared removal path, not a second copy of it: it owns the dirty guard,
    // the `--force` that drops regenerable `.shared/` symlinks, and the prune of
    // the stale admin entry. `force` is true because a losing attempt is work
    // being discarded on purpose; the guard exists to stop *accidental* loss,
    // and the deliberate half is the promotion confirm.
    crate::worktree::do_remove_worktree(root, path, true)?;

    if let Some(branch) = branch {
        let del = crate::exec::git_in(root)
            .args(["branch", "-D", &branch])
            .output()
            .map_err(|e| e.to_string())?;
        if !del.status.success() {
            return Err(format!(
                "worktree removed, but branch \"{branch}\" was not deleted: {}",
                String::from_utf8_lossy(&del.stderr).trim()
            ));
        }
    }
    forget(root, path)
}

/// The attempts a project has, for the tree. Reconciled against git on every
/// call, which is what makes task 2's guarantee hold on the surface that
/// actually renders.
#[tauri::command(async)]
pub fn list_project_attempts(root: String) -> Result<Vec<Attempt>, String> {
    Ok(list_attempts(&root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let out = crate::platform::process::command("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A scratch directory that cleans itself up, plus the project-state map it
    /// wrote. There is no `tempfile` dependency in this crate, and the map lives
    /// under the real `~/.config/tori`, so a test that did not remove its own
    /// would leave an entry behind for a path that no longer exists.
    struct Scratch {
        path: PathBuf,
        root: String,
    }

    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("tori-attempts-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("scratch dir");
            // Canonicalized because macOS resolves `/var` to `/private/var`, and
            // git reports the resolved form: an uncanonicalized root would make
            // every path comparison in here a false negative.
            let path = std::fs::canonicalize(&path).expect("canonical scratch");
            let root = path.to_string_lossy().into_owned();
            Self { path, root }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(map_path(&self.root));
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// A repo with one commit, so `git worktree add` has something to branch.
    fn repo(name: &str) -> Scratch {
        let dir = Scratch::new(name);
        let root = dir.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.email", "t@t"]);
        git(root, &["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "first"]);
        dir
    }

    /// The map records only what git cannot: the group and the goal. Three
    /// attempts read back as one group, and a worktree Tori did not create is
    /// not swept into it.
    #[test]
    fn three_attempts_read_back_as_one_group_and_an_ordinary_worktree_is_unaffected() {
        let dir = repo("group");
        let root = dir.root.clone();

        // An ordinary worktree, made the way a user would, outside the group.
        let plain = dir.path().join("plain-wt");
        git(
            dir.path(),
            &["worktree", "add", "-b", "plain", &plain.to_string_lossy()],
        );

        for n in 1..=3 {
            let container = dir.path().join(ATTEMPTS_DIR);
            std::fs::create_dir_all(&container).unwrap();
            let target = container.join(format!("try-{n}"));
            git(
                dir.path(),
                &["worktree", "add", "-b", &format!("try-{n}"), &target.to_string_lossy()],
            );
            record(
                &root,
                Attempt {
                    path: target.to_string_lossy().into_owned(),
                    group_id: "g1".into(),
                    goal: "make the parser faster".into(),
                },
            )
            .unwrap();
        }

        let listed = list_attempts(&root);
        assert_eq!(listed.len(), 3, "three attempts, one group");
        assert!(listed.iter().all(|a| a.group_id == "g1"));
        assert!(listed.iter().all(|a| a.goal == "make the parser faster"));
        assert!(
            !listed.iter().any(|a| a.path.contains("plain-wt")),
            "a worktree Tori did not create is not an attempt"
        );
    }

    /// Git is the truth. A worktree removed outside Tori leaves no entry behind,
    /// and the reconciliation is written back rather than recomputed forever.
    #[test]
    fn a_worktree_removed_outside_tori_leaves_no_stale_entry() {
        let dir = repo("stale");
        let root = dir.root.clone();
        let container = dir.path().join(ATTEMPTS_DIR);
        std::fs::create_dir_all(&container).unwrap();

        let gone = container.join("gone");
        let kept = container.join("kept");
        for (path, branch) in [(&gone, "gone"), (&kept, "kept")] {
            git(dir.path(), &["worktree", "add", "-b", branch, &path.to_string_lossy()]);
            record(
                &root,
                Attempt {
                    path: path.to_string_lossy().into_owned(),
                    group_id: "g1".into(),
                    goal: "g".into(),
                },
            )
            .unwrap();
        }
        assert_eq!(list_attempts(&root).len(), 2);

        git(dir.path(), &["worktree", "remove", "--force", &gone.to_string_lossy()]);

        let listed = list_attempts(&root);
        assert_eq!(listed.len(), 1, "the removed worktree is gone from the map");
        assert!(listed[0].path.contains("kept"));
        // Written back, not just filtered on the way out.
        let on_disk = read_map(&root);
        assert_eq!(on_disk.attempts.len(), 1, "the reconciliation was persisted");
    }

    /// An attempt is created inside the project root, under one directory, and
    /// the root gains exactly that one new entry. A cwd outside the root would
    /// fail `sessions::cwd_matches` and the attempt's sessions would not appear
    /// under the project at all.
    #[test]
    fn an_attempt_is_created_inside_the_root_which_gains_exactly_one_entry() {
        let dir = repo("inside");
        let root = dir.path();
        let before: Vec<_> = std::fs::read_dir(root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();

        let container = root.join(ATTEMPTS_DIR);
        std::fs::create_dir_all(&container).unwrap();
        for n in 1..=3 {
            let target = container.join(format!("try-{n}"));
            git(
                root,
                &["worktree", "add", "-b", &format!("try-{n}"), &target.to_string_lossy()],
            );
        }

        let after: Vec<_> = std::fs::read_dir(root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(
            after.len(),
            before.len() + 1,
            "three attempts, one new entry at the root"
        );
        assert!(after.iter().any(|n| n == ATTEMPTS_DIR));
        // Inside the root, which is what keeps the sessions discoverable.
        assert!(container.starts_with(root));
    }

    /// The folder namer never overwrites: three attempts from one branch stem
    /// get three directories.
    #[test]
    fn attempt_folders_never_collide() {
        let dir = Scratch::new("folders");
        let c = dir.path();
        assert_eq!(attempt_folder(c, "feature/fast-parser").unwrap(), "fast-parser");
        std::fs::create_dir_all(c.join("fast-parser")).unwrap();
        assert_eq!(attempt_folder(c, "feature/fast-parser").unwrap(), "fast-parser-2");
        std::fs::create_dir_all(c.join("fast-parser-2")).unwrap();
        assert_eq!(attempt_folder(c, "feature/fast-parser").unwrap(), "fast-parser-3");
    }

    /// The attempts directory is ignored through the repo's own exclude file,
    /// not the user's tracked `.gitignore`, and adding it twice does not
    /// duplicate the line.
    #[test]
    fn the_attempts_dir_is_excluded_without_touching_a_tracked_gitignore() {
        let dir = repo("exclude");
        let root = dir.root.clone();
        ignore_attempts_dir(&root);
        ignore_attempts_dir(&root);

        let exclude = std::fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert_eq!(
            exclude
                .lines()
                .filter(|l| l.trim() == format!("{ATTEMPTS_DIR}/"))
                .count(),
            1,
            "written once, not once per call"
        );
        assert!(
            !dir.path().join(".gitignore").exists(),
            "the user's tracked ignore file is untouched"
        );

        // And it actually takes effect: an attempt directory is not untracked dirt.
        std::fs::create_dir_all(dir.path().join(ATTEMPTS_DIR)).unwrap();
        std::fs::write(dir.path().join(ATTEMPTS_DIR).join("x"), "x").unwrap();
        let out = crate::platform::process::command("git")
            .arg("-C")
            .arg(dir.path())
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&out.stdout).contains(ATTEMPTS_DIR),
            "the attempts dir must not show as untracked"
        );
    }

    /// Promotion keeps the winner's branch and removes every other attempt in
    /// the group, along with its branch and its map entry. An attempt in a
    /// *different* group is untouched.
    #[test]
    fn promoting_a_winner_removes_its_rivals_and_leaves_other_groups_alone() {
        let dir = repo("promote");
        let root = dir.root.clone();
        let container = dir.path().join(ATTEMPTS_DIR);
        std::fs::create_dir_all(&container).unwrap();

        let mut paths = Vec::new();
        for (n, group) in [("a", "g1"), ("b", "g1"), ("c", "g2")] {
            let target = container.join(n);
            git(dir.path(), &["worktree", "add", "-b", n, &target.to_string_lossy()]);
            let p = target.to_string_lossy().into_owned();
            record(
                &root,
                Attempt {
                    path: p.clone(),
                    group_id: group.into(),
                    goal: "g".into(),
                },
            )
            .unwrap();
            paths.push(p);
        }

        // Losing work is discarded deliberately, so the dirty guard is bypassed;
        // this pins that a loser with real edits still goes.
        std::fs::write(container.join("b").join("a.txt"), "edited\n").unwrap();

        let problems = discard_all_for_test(&root, &paths[0]);
        assert!(problems.is_empty(), "promotion reported: {problems:?}");

        let left = list_attempts(&root);
        assert_eq!(left.len(), 1, "only the other group's attempt is still an attempt");
        assert_eq!(left[0].group_id, "g2");

        assert!(!container.join("b").exists(), "the loser's directory is gone");
        assert!(container.join("a").exists(), "the winner's worktree stays");
        assert!(container.join("c").exists(), "another group is untouched");

        let branches = crate::platform::process::command("git")
            .arg("-C")
            .arg(dir.path())
            .args(["branch", "--format=%(refname:short)"])
            .output()
            .unwrap();
        let branches = String::from_utf8_lossy(&branches.stdout);
        assert!(branches.contains('a'), "the winner's branch is kept");
        assert!(
            !branches.lines().any(|l| l.trim() == "b"),
            "the loser's branch is deleted"
        );
    }

    /// `promote_attempt` needs an `AppHandle` to emit, which a unit test has no
    /// way to build, so the promotion body is exercised through the same two
    /// calls it makes. Kept beside it rather than restructured, so what the test
    /// drives stays obviously the same work.
    fn discard_all_for_test(root: &str, winner_path: &str) -> Vec<String> {
        let attempts = list_attempts(root);
        let winner = canon(winner_path);
        let group = attempts
            .iter()
            .find(|a| canon(&a.path) == winner)
            .map(|a| a.group_id.clone())
            .expect("the winner is recorded");
        let mut problems = Vec::new();
        for loser in attempts
            .iter()
            .filter(|a| a.group_id == group && canon(&a.path) != winner)
        {
            if let Err(e) = discard_attempt(root, &loser.path, &[], None) {
                problems.push(format!("{}: {e}", loser.path));
            }
        }
        forget(root, winner_path).unwrap();
        problems
    }

    /// The clone has to leave an attempt *usable*, which for a node project
    /// means two things: the packages are there, and `node_modules/.bin` still
    /// resolves. Those links are relative into sibling packages, so copying them
    /// as links is what keeps them pointing inside the attempt; following them
    /// would flatten each into a copy of the origin's file.
    ///
    /// Disk growth is asserted as a ratio rather than an absolute, because a
    /// clone's cost on APFS is metadata and the point is that three attempts do
    /// not cost three trees.
    #[test]
    fn cloned_dependencies_are_usable_and_cost_far_less_than_three_copies() {
        let dir = repo("clone");
        let root = dir.path();

        // Big enough that three byte copies would dwarf any background churn on
        // the volume while the test runs.
        const MB: usize = 1024 * 1024;
        let nm = root.join("node_modules");
        std::fs::create_dir_all(nm.join("left/bin")).unwrap();
        std::fs::create_dir_all(nm.join(".bin")).unwrap();
        std::fs::write(nm.join("left/bin/cli.js"), vec![b'x'; 24 * MB]).unwrap();
        std::fs::write(nm.join("left/index.js"), vec![b'y'; 24 * MB]).unwrap();
        // The real shape: a *relative* link, which is why it can travel at all.
        std::os::unix::fs::symlink("../left/bin/cli.js", nm.join(".bin/cli")).unwrap();

        let baseline = free_kb(root);
        let container = root.join(ATTEMPTS_DIR);
        std::fs::create_dir_all(&container).unwrap();
        for n in 1..=3 {
            let target = container.join(format!("try-{n}"));
            git(
                root,
                &["worktree", "add", "-b", &format!("try-{n}"), &target.to_string_lossy()],
            );
            let failed = clone_dep_dirs(root, &target);
            assert!(failed.is_empty(), "clone reported failures: {failed:?}");

            assert!(
                target.join("node_modules/left/index.js").is_file(),
                "packages are present"
            );
            let link = target.join("node_modules/.bin/cli");
            assert!(
                link.symlink_metadata().unwrap().file_type().is_symlink(),
                ".bin entries must stay symlinks, not become copies"
            );
            // Resolves inside this attempt, not back at the origin.
            let resolved = std::fs::canonicalize(&link).expect(".bin link resolves");
            assert!(
                resolved.starts_with(std::fs::canonicalize(&target).unwrap()),
                "the .bin link escaped its attempt: {resolved:?}"
            );
        }

        let consumed = baseline - free_kb(root);
        let one_copy = apparent_kb(&nm);
        assert!(
            consumed < one_copy,
            "three cloned attempts consumed {consumed}KB, which is not far below one copy of node_modules ({one_copy}KB)"
        );
    }

    /// Free space on the volume, which is the **only** instrument that sees a
    /// clone.
    ///
    /// `du` cannot: it reports each file's own allocated blocks and knows
    /// nothing about blocks two files share, so a perfect clone reads there as a
    /// full second copy. Measured directly while writing this: three clones of a
    /// 200MB tree consumed zero blocks and `du` still reported 200MB apiece.
    fn free_kb(path: &Path) -> i64 {
        let out = crate::platform::process::command("df")
            .arg("-k")
            .arg(path)
            .output()
            .expect("df runs");
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .nth(1)
            .and_then(|l| l.split_whitespace().nth(3))
            .and_then(|n| n.parse().ok())
            .unwrap_or(0)
    }

    /// What one copy *would* cost, which is what `du` is actually good for.
    fn apparent_kb(path: &Path) -> i64 {
        let out = crate::platform::process::command("du")
            .arg("-sk")
            .arg(path)
            .output()
            .expect("du runs");
        String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .next()
            .and_then(|n| n.parse().ok())
            .unwrap_or(0)
    }

    /// The per-turn snapshot must not walk the attempts.
    ///
    /// The plan asked for a pathspec exclusion "not by gitignore alone, since
    /// gitignore stops files entering the index but not git stat-ing the tree to
    /// discover that". Measured while writing this, and **that is not how git
    /// behaves**: an ignored *directory* is pruned rather than descended (4000
    /// ignored files added in 34ms, against 200ms for the same files tracked).
    /// The pathspec was also actively harmful, since an exclude matching only
    /// ignored paths makes `git add` fail. So the ignore entry is the mechanism,
    /// and this is the test that says so.
    ///
    /// Asserted on the resulting tree rather than on a stopwatch: a timing
    /// assertion on a shared machine is a flake, while "the attempt's files are
    /// not in the snapshot" is the property that makes the latency claim true
    /// and is exact.
    #[test]
    fn the_per_turn_snapshot_does_not_walk_the_attempts() {
        let dir = repo("snapshot");
        let root = dir.path();
        let root_str = dir.root.clone();
        ignore_attempts_dir(&root_str);

        let container = root.join(ATTEMPTS_DIR);
        std::fs::create_dir_all(&container).unwrap();
        for n in 1..=3 {
            let target = container.join(format!("try-{n}"));
            git(
                root,
                &["worktree", "add", "-b", &format!("try-{n}"), &target.to_string_lossy()],
            );
            std::fs::create_dir_all(target.join("node_modules/pkg")).unwrap();
            std::fs::write(target.join("node_modules/pkg/index.js"), "dep\n").unwrap();
            std::fs::write(target.join("attempt-only.txt"), "only in the attempt\n").unwrap();
        }
        std::fs::write(root.join("real.txt"), "the user's own work\n").unwrap();

        let index = std::env::temp_dir().join(format!("tori-attempts-idx-{}", std::process::id()));
        let _ = std::fs::remove_file(&index);
        let tree = crate::checkpoint::write_tree_scratch(&root_str, &index).expect("snapshot");

        let listing = crate::platform::process::command("git")
            .arg("-C")
            .arg(root)
            .args(["ls-tree", "-r", "--name-only", &tree])
            .output()
            .unwrap();
        let listing = String::from_utf8_lossy(&listing.stdout);
        assert!(
            listing.contains("real.txt"),
            "the user's own new file is still captured"
        );
        assert!(
            !listing.contains(ATTEMPTS_DIR),
            "the attempts directory reached the snapshot: {listing}"
        );
        assert!(!listing.contains("attempt-only.txt"));
        let _ = std::fs::remove_file(&index);
    }

    /// Removal goes through the shared worktree lifecycle, so its guards apply
    /// here rather than being reimplemented. The dirty guard refuses an attempt
    /// with real edits when it is not forced, which is what makes forcing it
    /// during a promotion a *decision* instead of the only behaviour there is.
    ///
    /// The `.shared/` linking is creation-only and survives the clone step: it
    /// runs after the clone and skips any name the attempt already has, so a
    /// cloned `node_modules` is never replaced by a shared one.
    #[test]
    fn removal_keeps_the_shared_guards_and_shared_links_survive_the_clone() {
        let dir = repo("lifecycle");
        let root = dir.path();
        let root_str = dir.root.clone();
        let container = root.join(ATTEMPTS_DIR);
        std::fs::create_dir_all(container.join(SHARED_TEST_DIR)).unwrap();
        std::fs::write(container.join(SHARED_TEST_DIR).join(".env"), "SECRET=1\n").unwrap();
        // A shared name that collides with something the clone provides.
        std::fs::create_dir_all(container.join(SHARED_TEST_DIR).join("node_modules")).unwrap();

        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "cloned\n").unwrap();

        let target = container.join("try-1");
        git(root, &["worktree", "add", "-b", "try-1", &target.to_string_lossy()]);
        clone_dep_dirs(root, &target);
        crate::worktree::link_shared(&container, &target);

        assert!(
            target.join(".env").symlink_metadata().is_ok(),
            "a shared file is linked in"
        );
        assert!(
            target.join("node_modules/pkg/index.js").is_file(),
            "the clone survives: a shared name must not replace it"
        );
        assert!(
            !target
                .join("node_modules")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink(),
            "node_modules stayed the clone, not a link to the shared one"
        );

        // The dirty guard is real, and forcing past it is the deliberate half.
        std::fs::write(target.join("a.txt"), "unsaved work\n").unwrap();
        assert!(
            crate::worktree::do_remove_worktree(&root_str, &target.to_string_lossy(), false).is_err(),
            "an attempt with real edits is refused unless forced"
        );
        crate::worktree::do_remove_worktree(&root_str, &target.to_string_lossy(), true)
            .expect("forcing is what a promotion does");
        assert!(!target.exists());
    }

    /// Quick-open and the file tree read `list_project_files`, which must not
    /// offer a file from a second checkout of the same project: every source
    /// file would otherwise appear once per attempt.
    #[test]
    fn quick_open_never_offers_a_file_from_an_attempt() {
        let dir = repo("quickopen");
        let root = dir.path();
        let root_str = dir.root.clone();
        ignore_attempts_dir(&root_str);

        let container = root.join(ATTEMPTS_DIR);
        std::fs::create_dir_all(&container).unwrap();
        let target = container.join("try-1");
        git(root, &["worktree", "add", "-b", "try-1", &target.to_string_lossy()]);
        std::fs::write(target.join("attempt-only.txt"), "x\n").unwrap();

        let files = crate::fs::list_project_files_body(root_str).expect("listing");
        assert!(
            files.iter().any(|f| f.contains("a.txt")),
            "the project's own files are still offered"
        );
        assert!(
            !files
                .iter()
                .any(|f| f.contains(ATTEMPTS_DIR) || f.contains("attempt-only")),
            "an attempt's files reached quick-open: {files:?}"
        );
    }

    /// The bare-container `.shared/` directory name, spelled here rather than
    /// imported because `worktree`'s copy is private and this test only needs to
    /// build the fixture that exercises it.
    const SHARED_TEST_DIR: &str = ".shared";

    /// Attempts are alternatives, not branches to combine. This module must
    /// never grow a merge: the whole design says the losers are discarded, and a
    /// stray `git merge` here would quietly turn "pick one" into "take all".
    #[test]
    fn promotion_never_merges() {
        let source = include_str!("attempts.rs");
        // The doc comments deliberately say the words, so only the command
        // strings this file could actually run are checked.
        for forbidden in ["\"merge\"", "\"rebase\"", "\"cherry-pick\""] {
            assert!(
                !source.contains(forbidden),
                "{forbidden} appears as a git argument; attempts are discarded, never combined"
            );
        }
    }
}
