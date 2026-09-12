// The `.shared/` convention as something you can see and repair.
//
// A bare container may hold a `.shared/` folder whose top-level entries are
// symlinked into a worktree when that worktree is created (`worktree::link_shared`).
// Nothing re-runs that, so an entry added after a worktree exists never reaches
// it. A file tree cannot show that gap, which is what this module reports.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::worktree::shared_dir;

/// What one worktree holds at an entry's name.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LinkState {
    /// A symlink pointing at this entry.
    Linked,
    /// Nothing of that name: the worktree predates the entry, or the link was
    /// deleted.
    Missing,
    /// Something else of that name, which `link_shared` never clobbers: a real
    /// file the branch carries, or a link somewhere else.
    Shadowed,
}

#[derive(Serialize, Debug)]
pub struct WorktreeLink {
    pub path: String,
    pub state: LinkState,
}

#[derive(Serialize, Debug)]
pub struct SharedEntry {
    /// A single path component directly under `.shared/`.
    pub name: String,
    pub is_dir: bool,
    pub links: Vec<WorktreeLink>,
}

#[derive(Serialize, Debug)]
pub struct SharedOverview {
    /// `<container>/.shared`, whether or not it exists yet.
    pub dir: String,
    pub exists: bool,
    /// The container's worktrees, its own bare record excluded.
    pub worktrees: Vec<String>,
    pub entries: Vec<SharedEntry>,
}

/// Refuse anything that is not one path component. Every command here joins the
/// name onto a directory, so a `..` or a separator would write outside it.
fn checked_name(name: &str) -> Result<&str, String> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0');
    if bad {
        return Err(format!("\"{name}\" is not a file name."));
    }
    Ok(name)
}

/// The container's worktrees as folders on disk. Filtered rather than pruned:
/// git keeps listing a folder deleted outside Sway, and reading a page must not
/// rewrite the repo's admin files.
fn live_worktrees(container: &str) -> Vec<PathBuf> {
    crate::worktree::list_worktrees_body(container.to_string())
        .unwrap_or_default()
        .into_iter()
        .filter(|w| !w.is_bare)
        .map(|w| PathBuf::from(w.path))
        .filter(|p| p.is_dir())
        .collect()
}

/// Does `<worktree>/<name>` point at `<shared>/<name>`? Compared after
/// resolving both, so a container reached through a symlinked home still
/// matches the link written from its real path.
fn link_state(worktree: &Path, shared: &Path, name: &str) -> LinkState {
    let dest = worktree.join(name);
    let Ok(meta) = dest.symlink_metadata() else {
        return LinkState::Missing;
    };
    if !meta.file_type().is_symlink() {
        return LinkState::Shadowed;
    }
    let want = shared.join(name);
    let same = std::fs::read_link(&dest).is_ok_and(|t| {
        let t = if t.is_absolute() { t } else { worktree.join(t) };
        t == want || (t.canonicalize().ok() == want.canonicalize().ok() && want.exists())
    });
    if same {
        LinkState::Linked
    } else {
        LinkState::Shadowed
    }
}

fn git_says(worktree: &Path, args: &[&str], name: &str) -> bool {
    std::process::Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(args)
        .arg("--")
        .arg(name)
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Does git carry this file on the branch? The one state that cannot be shared:
/// moving a tracked file out of the worktree reads as a deletion on the branch.
fn is_tracked(worktree: &Path, name: &str) -> bool {
    git_says(worktree, &["ls-files", "--error-unmatch", "-z"], name)
}

fn is_ignored(worktree: &Path, name: &str) -> bool {
    git_says(worktree, &["check-ignore", "-q"], name)
}

/// The exclude file every worktree of a container shares. `--git-common-dir` is
/// the container's own git dir, not the per-worktree one, which is exactly why
/// one line here hides a name in all of them at once.
fn exclude_file(worktree: &Path) -> Option<PathBuf> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(["rev-parse", "--git-common-dir"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let dir = if Path::new(&dir).is_absolute() {
        PathBuf::from(dir)
    } else {
        worktree.join(dir)
    };
    Some(dir.join("info").join("exclude"))
}

/// The block Sway owns inside the exclude file. Everything after it to the next
/// comment (or the end) is ours to add to and take from; anything above it is
/// the user's and is never rewritten.
const EXCLUDE_HEADER: &str = "# Shared in worktrees (managed by Sway)";

/// Split the exclude file into the lines before our block, our names, and the
/// lines after it.
fn split_exclude(text: &str) -> (Vec<&str>, Vec<&str>, Vec<&str>) {
    let lines: Vec<&str> = text.lines().collect();
    let Some(at) = lines.iter().position(|l| l.trim() == EXCLUDE_HEADER) else {
        return (lines, Vec::new(), Vec::new());
    };
    let end = lines[at + 1..]
        .iter()
        .position(|l| l.trim_start().starts_with('#'))
        .map(|i| at + 1 + i)
        .unwrap_or(lines.len());
    let ours = lines[at + 1..end].iter().copied().filter(|l| !l.trim().is_empty()).collect();
    (lines[..at].to_vec(), ours, lines[end..].to_vec())
}

fn write_exclude(path: &Path, before: &[&str], ours: &[&str], after: &[&str]) -> Result<(), String> {
    let mut out: Vec<String> = before.iter().map(|s| s.to_string()).collect();
    while out.last().is_some_and(|l| l.trim().is_empty()) {
        out.pop();
    }
    if !ours.is_empty() {
        if !out.is_empty() {
            out.push(String::new());
        }
        out.push(EXCLUDE_HEADER.to_string());
        out.extend(ours.iter().map(|s| s.to_string()));
    }
    out.extend(after.iter().map(|s| s.to_string()));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut body = out.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    std::fs::write(path, body).map_err(|e| e.to_string())
}

fn exclude_add(worktree: &Path, name: &str) -> Result<(), String> {
    let Some(path) = exclude_file(worktree) else {
        return Ok(());
    };
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let (before, mut ours, after) = split_exclude(&text);
    if ours.contains(&name) {
        return Ok(());
    }
    ours.push(name);
    write_exclude(&path, &before, &ours, &after)
}

fn exclude_remove(worktree: &Path, name: &str) -> Result<(), String> {
    let Some(path) = exclude_file(worktree) else {
        return Ok(());
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let (before, ours, after) = split_exclude(&text);
    if !ours.contains(&name) {
        return Ok(());
    }
    let kept: Vec<&str> = ours.into_iter().filter(|l| *l != name).collect();
    write_exclude(&path, &before, &kept, &after)
}

/// Top-level names `.shared/` holds, sorted, so two reads of one container list
/// them in the same order.
fn entry_names(shared: &Path) -> Vec<(String, bool)> {
    let Ok(dir) = std::fs::read_dir(shared) else {
        return Vec::new();
    };
    let mut out: Vec<(String, bool)> = dir
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            (name != ".DS_Store").then(|| (name, e.path().is_dir()))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// What the Shared in worktrees page draws: the entries, and where each one
/// did not land.
#[tauri::command(async)]
pub fn shared_overview(container: String) -> Result<SharedOverview, String> {
    let shared = shared_dir(Path::new(&container));
    let worktrees = live_worktrees(&container);
    let entries = entry_names(&shared)
        .iter()
        .map(|(name, is_dir)| SharedEntry {
            name: name.clone(),
            is_dir: *is_dir,
            links: worktrees
                .iter()
                .map(|w| WorktreeLink {
                    path: w.to_string_lossy().to_string(),
                    state: link_state(w, &shared, name),
                })
                .collect(),
        })
        .collect();
    Ok(SharedOverview {
        dir: shared.to_string_lossy().to_string(),
        exists: shared.is_dir(),
        worktrees: worktrees.iter().map(|w| w.to_string_lossy().to_string()).collect(),
        entries,
    })
}

/// How many links are missing across the whole container: the number the
/// sidebar's indicator lights on. Skips the candidate scan, which is a git call
/// per worktree and says nothing about whether anything is wrong.
#[tauri::command(async)]
pub fn shared_drift(container: String) -> Result<u32, String> {
    let shared = shared_dir(Path::new(&container));
    if !shared.is_dir() {
        return Ok(0);
    }
    Ok(drift_in(&shared, &live_worktrees(&container)))
}

fn drift_in(shared: &Path, worktrees: &[PathBuf]) -> u32 {
    entry_names(shared)
        .iter()
        .flat_map(|(name, _)| worktrees.iter().map(move |w| (w, name)))
        .filter(|(w, name)| link_state(w, shared, name) == LinkState::Missing)
        .count() as u32
}

// The three mutations take their worktree list rather than looking it up, so a
// test can exercise them on plain folders. Only the commands below ask git.

fn link_in(shared: &Path, worktrees: &[PathBuf], name: &str) -> Result<u32, String> {
    let src = shared.join(name);
    if !src.exists() {
        return Err(format!("\"{name}\" is not in the shared folder."));
    }
    let mut linked = 0;
    for w in worktrees {
        if link_state(w, shared, name) != LinkState::Missing {
            continue;
        }
        std::os::unix::fs::symlink(&src, w.join(name)).map_err(|e| e.to_string())?;
        linked += 1;
    }
    Ok(linked)
}

fn remove_in(shared: &Path, worktrees: &[PathBuf], name: &str) -> Result<(), String> {
    let target = shared.join(name);
    if !target.exists() {
        return Err(format!("\"{name}\" is not in the shared folder."));
    }
    for w in worktrees {
        if link_state(w, shared, name) == LinkState::Linked {
            let _ = std::fs::remove_file(w.join(name));
        }
    }
    if target.is_dir() && !target.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    }
    // The exclude line was written to hide the links; with the entry and its
    // links gone there is nothing left for it to hide.
    if let Some(w) = worktrees.first() {
        exclude_remove(w, name)?;
    }
    Ok(())
}

/// Link one entry into every worktree that has nothing of its name. Answers how
/// many it reached. A shadowed name is left alone, the same rule `link_shared`
/// follows at creation: a file the branch carries is never replaced by a link.
#[tauri::command(async)]
pub fn shared_link(container: String, name: String) -> Result<u32, String> {
    let name = checked_name(&name)?;
    link_in(&shared_dir(Path::new(&container)), &live_worktrees(&container), name)
}

/// What sharing this file would do, so the confirmation can say it before it
/// happens rather than after.
#[derive(Serialize, Debug)]
pub struct SharePlan {
    /// Git carries it on the branch. The one answer that blocks the whole thing.
    pub tracked: bool,
    /// Already hidden from git, so no exclude line is needed.
    pub ignored: bool,
    pub is_dir: bool,
    /// Worktrees that would gain a link, this one excluded.
    pub links: u32,
    /// The container already has an entry of this name.
    pub taken: bool,
}

#[tauri::command(async)]
pub fn shared_plan(container: String, worktree: String, name: String) -> Result<SharePlan, String> {
    let name = checked_name(&name)?;
    let shared = shared_dir(Path::new(&container));
    let w = PathBuf::from(&worktree);
    let src = w.join(name);
    if src.symlink_metadata().is_err() {
        return Err(format!("\"{name}\" is not in that worktree."));
    }
    Ok(SharePlan {
        tracked: is_tracked(&w, name),
        ignored: is_ignored(&w, name),
        is_dir: src.is_dir(),
        links: live_worktrees(&container)
            .iter()
            .filter(|o| o.as_path() != w && link_state(o, &shared, name) == LinkState::Missing)
            .count() as u32,
        taken: shared.join(name).exists(),
    })
}

/// Move `<worktree>/<name>` into `.shared/`, link it back, and link it into
/// every other worktree. The move is what makes it shared: a copy would leave
/// the original as the one file nobody else's link points at.
///
/// A name git does not already ignore also gets a line in the container's
/// exclude file, so the new symlinks do not show up as untracked in every
/// worktree at once. That file is per-clone and shared across worktrees, which
/// is why nothing lands in `.gitignore`.
#[tauri::command(async)]
pub fn shared_add(container: String, worktree: String, name: String) -> Result<u32, String> {
    let name = checked_name(&name)?;
    let shared = shared_dir(Path::new(&container));
    let w = PathBuf::from(&worktree);
    let src = w.join(name);
    if src.symlink_metadata().is_err() {
        return Err(format!("\"{name}\" is not in that worktree."));
    }
    if is_tracked(&w, name) {
        return Err(format!(
            "Git carries \"{name}\" on this branch. Only files git does not track can be shared."
        ));
    }
    let dest = shared.join(name);
    if dest.exists() {
        return Err(format!("The shared folder already has \"{name}\"."));
    }
    if !is_ignored(&w, name) {
        exclude_add(&w, name)?;
    }
    std::fs::create_dir_all(&shared).map_err(|e| e.to_string())?;
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    std::os::unix::fs::symlink(&dest, &src).map_err(|e| e.to_string())?;
    Ok(link_in(&shared, &live_worktrees(&container), name)? + 1)
}

/// Stop sharing, keeping the file: it moves back into `worktree` as a real
/// file, and every other worktree's link is dropped. Answers how many links
/// went.
///
/// Moved rather than copied into each: an entry can be a folder the size of
/// `node_modules`, and writing N copies of it to undo one link is not an undo.
#[tauri::command(async)]
pub fn shared_keep_in(container: String, worktree: String, name: String) -> Result<u32, String> {
    let name = checked_name(&name)?;
    let shared = shared_dir(Path::new(&container));
    let w = PathBuf::from(&worktree);
    let src = shared.join(name);
    if !src.exists() {
        return Err(format!("\"{name}\" is not in the shared folder."));
    }
    let mut dropped: u32 = 0;
    for other in live_worktrees(&container) {
        if link_state(&other, &shared, name) != LinkState::Linked {
            continue;
        }
        std::fs::remove_file(other.join(name)).map_err(|e| e.to_string())?;
        if other != w {
            dropped += 1;
        }
    }
    // Its link is gone by now, so anything still here is the worktree's own and
    // the move would silently replace it.
    let dest = w.join(name);
    if dest.symlink_metadata().is_ok() {
        return Err(format!("{} already has its own \"{name}\".", basename(&w)));
    }
    std::fs::rename(&src, dest).map_err(|e| e.to_string())?;
    exclude_remove(&w, name)?;
    Ok(dropped)
}

fn basename(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// Delete an entry and every link pointing at it. The links go first: removing
/// the target first would leave each worktree holding a dangling link that
/// nothing here can still recognise as ours.
#[tauri::command(async)]
pub fn shared_remove(container: String, name: String) -> Result<(), String> {
    let name = checked_name(&name)?;
    remove_in(&shared_dir(Path::new(&container)), &live_worktrees(&container), name)
}

/// Drop one worktree's link without touching the entry: the per-worktree
/// opt-out, for a checkout that wants its own copy or none at all.
#[tauri::command(async)]
pub fn shared_unlink(container: String, worktree: String, name: String) -> Result<(), String> {
    let name = checked_name(&name)?;
    let shared = shared_dir(Path::new(&container));
    let w = PathBuf::from(&worktree);
    if link_state(&w, &shared, name) != LinkState::Linked {
        return Err(format!("That worktree has no link to \"{name}\"."));
    }
    std::fs::remove_file(w.join(name)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::SHARED_DIR;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sway-shared-test-{n}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A container folder with `n` worktree folders beside its `.shared/`. Git
    /// is never involved: the mutations take their worktree list, and only the
    /// commands wrapping them look one up.
    fn container(n: usize) -> (PathBuf, PathBuf, Vec<PathBuf>) {
        let root = unique_tmp();
        let shared = root.join(SHARED_DIR);
        fs::create_dir_all(&shared).unwrap();
        let wts = (0..n)
            .map(|i| {
                let w = root.join(format!("wt{i}"));
                fs::create_dir_all(&w).unwrap();
                w
            })
            .collect();
        (root, shared, wts)
    }

    fn put(shared: &Path, name: &str, body: &str) -> PathBuf {
        let p = shared.join(name);
        fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn link_state_tells_ours_from_a_real_file_and_from_a_stray_link() {
        let (root, shared, wts) = container(3);
        let src = put(&shared, ".env", "x");

        std::os::unix::fs::symlink(&src, wts[0].join(".env")).unwrap();
        fs::write(wts[1].join(".env"), "mine").unwrap();

        assert_eq!(link_state(&wts[0], &shared, ".env"), LinkState::Linked);
        // The case `link_shared` refuses to clobber, and the one a "missing"
        // reading would offer to overwrite.
        assert_eq!(link_state(&wts[1], &shared, ".env"), LinkState::Shadowed);
        assert_eq!(link_state(&wts[2], &shared, ".env"), LinkState::Missing);

        let elsewhere = put(&root, "other", "x");
        std::os::unix::fs::symlink(&elsewhere, wts[2].join(".env")).unwrap();
        assert_eq!(link_state(&wts[2], &shared, ".env"), LinkState::Shadowed);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn link_reaches_only_the_worktrees_holding_nothing_of_that_name() {
        let (root, shared, wts) = container(3);
        let src = put(&shared, ".env", "x");
        std::os::unix::fs::symlink(&src, wts[0].join(".env")).unwrap();
        fs::write(wts[1].join(".env"), "mine").unwrap();

        // Only wt2 is reachable: wt0 already holds ours, and wt1's own file is
        // never replaced.
        assert_eq!(link_in(&shared, &wts, ".env").unwrap(), 1);
        assert_eq!(fs::read_to_string(wts[2].join(".env")).unwrap(), "x");
        assert_eq!(fs::read_to_string(wts[1].join(".env")).unwrap(), "mine");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_takes_the_links_with_it_and_leaves_a_shadowing_file() {
        let (root, shared, wts) = container(3);
        let src = put(&shared, ".env", "x");
        std::os::unix::fs::symlink(&src, wts[0].join(".env")).unwrap();
        fs::write(wts[1].join(".env"), "mine").unwrap();

        remove_in(&shared, &wts, ".env").unwrap();

        assert!(wts[0].join(".env").symlink_metadata().is_err(), "our link goes");
        assert_eq!(fs::read_to_string(wts[1].join(".env")).unwrap(), "mine", "their file stays");
        assert!(!shared.join(".env").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn drift_counts_one_per_worktree_that_never_got_an_entry() {
        let (root, shared, wts) = container(3);
        let src = put(&shared, ".env", "x");
        put(&shared, ".npmrc", "x");
        std::os::unix::fs::symlink(&src, wts[0].join(".env")).unwrap();

        // Two entries over three worktrees, one link written: five gaps.
        assert_eq!(drift_in(&shared, &wts), 5);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn drift_is_zero_without_a_shared_folder() {
        let root = unique_tmp();
        assert_eq!(shared_drift(root.to_string_lossy().to_string()).unwrap(), 0);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_name_that_is_not_one_component_is_refused_before_anything_is_touched() {
        let (root, _shared, _w) = container(1);
        let c = root.to_string_lossy().to_string();
        for bad in ["../escape", "a/b", "", "..", "."] {
            assert!(shared_link(c.clone(), bad.into()).is_err(), "{bad} must be refused");
            assert!(shared_remove(c.clone(), bad.into()).is_err(), "{bad} must be refused");
            assert!(shared_unlink(c.clone(), c.clone(), bad.into()).is_err(), "{bad} must be refused");
        }
        fs::remove_dir_all(&root).ok();
    }

    /// The block is delimited by the next comment, so a user's own rules below
    /// ours survive every add and remove.
    #[test]
    fn the_exclude_block_only_owns_the_lines_between_its_header_and_the_next_comment() {
        let text = format!("*.log\n\n{EXCLUDE_HEADER}\n.env\n.npmrc\n\n# mine\nscratch/\n");
        let (before, ours, after) = split_exclude(&text);

        assert_eq!(before, ["*.log", ""]);
        assert_eq!(ours, [".env", ".npmrc"]);
        assert_eq!(after, ["# mine", "scratch/"]);
    }

    #[test]
    fn a_file_with_no_block_is_all_before_it() {
        let (before, ours, after) = split_exclude("*.log\nbuild/\n");
        assert_eq!(before, ["*.log", "build/"]);
        assert!(ours.is_empty());
        assert!(after.is_empty());
    }

    #[test]
    fn writing_an_empty_block_takes_the_header_with_it() {
        let root = unique_tmp();
        let f = root.join("exclude");
        write_exclude(&f, &["*.log"], &[".env"], &["# mine"]).unwrap();
        assert_eq!(
            fs::read_to_string(&f).unwrap(),
            format!("*.log\n\n{EXCLUDE_HEADER}\n.env\n# mine\n")
        );

        // The last name removed: no orphan header left behind.
        write_exclude(&f, &["*.log"], &[], &["# mine"]).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "*.log\n# mine\n");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn keeping_a_file_moves_it_back_and_drops_the_other_links() {
        let (root, shared, wts) = container(3);
        let src = put(&shared, ".env", "secret");
        for w in &wts {
            std::os::unix::fs::symlink(&src, w.join(".env")).unwrap();
        }

        let dropped = shared_keep_in(
            root.to_string_lossy().to_string(),
            wts[1].to_string_lossy().to_string(),
            ".env".into(),
        );
        // Git is not involved here, so the worktree list is empty and only the
        // move half runs: the file lands back as a real file either way.
        assert!(dropped.is_ok());
        assert_eq!(fs::read_to_string(wts[1].join(".env")).unwrap(), "secret");
        assert!(!wts[1].join(".env").symlink_metadata().unwrap().file_type().is_symlink());
        assert!(!shared.join(".env").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn entry_names_are_sorted_and_skip_the_finder_droppings() {
        let (root, shared, _w) = container(0);
        put(&shared, ".npmrc", "x");
        put(&shared, ".DS_Store", "x");
        put(&shared, ".env", "x");

        let names: Vec<String> = entry_names(&shared).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, [".env", ".npmrc"]);

        fs::remove_dir_all(&root).ok();
    }
}
