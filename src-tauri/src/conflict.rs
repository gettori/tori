//! The three sides of an unresolved merge, and which operation left them there.
//!
//! Its own module rather than more of `git.rs` for the reason `blame.rs` is one:
//! this is a data model read out of the index, not another command surface.
//!
//! **The index holds all three versions while a merge is unresolved.** A
//! conflicted path has no stage 0; it has stage 1 (the merge base), stage 2 and
//! stage 3, readable as `git show :1:<path>` and so on. That is where the merge
//! view gets its documents: the file on disk holds git's marker-riddled attempt,
//! which is a rendering of the conflict rather than the conflict itself.
//!
//! **A stage can be legitimately absent.** A file modified on one side and
//! deleted on the other has no stage for the side that deleted it, and an
//! add/add conflict has no base. That is the ordinary shape of those conflicts,
//! not a failure, so a missing stage reads as `None` and only a path with *no*
//! stages at all is an error.
//!
//! **Stage 2 is not always yours.** Mid-rebase git replays your commits onto the
//! upstream, so the side it is "already on" (stage 2) is the upstream and the
//! side being applied (stage 3) is your own commit: the labels invert relative
//! to a merge. Which operation is running is a fact about the repository, so it
//! is read here; what to *call* each side is a presentation choice and is made
//! in `src/utils/conflict.ts`.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// One conflicted file's three versions, as the index holds them.
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct ConflictStages {
    /// Stage 1, the merge base. `None` for an add/add conflict, where the two
    /// sides created the file independently and there is no common ancestor.
    pub base: Option<String>,
    /// Stage 2, the version already on HEAD. Under a rebase this is the
    /// upstream's, not yours; see the module doc.
    pub ours: Option<String>,
    /// Stage 3, the version being merged in. Under a rebase this is yours.
    pub theirs: Option<String>,
    /// Any stage holds a NUL byte. There is no line-wise view of a binary
    /// conflict, and rendering one as lossy text would offer edits that mean
    /// nothing, so the caller shows the file's name and stops.
    pub binary: bool,
}

/// The operation that left the working tree conflicted.
///
/// `Rebase` covers `rebase-merge` (interactive and merge-backend rebases) and
/// `rebase-apply`, which is also where `git am` lands; both replay a commit onto
/// somewhere else, which is the property that inverts the sides.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ConflictOp {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    /// Nothing in progress that git records. A conflict can still exist here:
    /// `git stash apply` and `git checkout -m` both leave unmerged stages
    /// without writing a state directory.
    None,
}

/// The commit behind one side of a conflict, and the ref that names it.
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct SideRef {
    pub sha: String,
    pub short: String,
    /// A branch or remote-tracking name. `None` when nothing names the commit,
    /// as with a detached HEAD or a commit picked by its sha.
    pub name: Option<String>,
}

/// What stands behind stages 2 and 3, for the pane headers. Mapped through the
/// operation here, like the stages themselves: under a rebase stage 2 is the
/// upstream and stage 3 is the commit being replayed.
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct ConflictSides {
    pub ours: Option<SideRef>,
    pub theirs: Option<SideRef>,
}

fn capture(repo: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(out.stdout)
}

/// Which stages the index holds for `file`, as a 3-bit set (bit 0 = stage 1).
///
/// Asked before reading anything, so a missing stage can be told apart from a
/// path that is not conflicted at all: reading `git show :3:<path>` and treating
/// its failure as "no stage 3" would report a typo'd path as a delete/modify
/// conflict with every side missing.
fn staged_at(repo: &str, file: &str) -> Result<u8, String> {
    let out = capture(repo, &["ls-files", "-u", "-z", "--", file])?;
    let mut mask = 0u8;
    for rec in String::from_utf8_lossy(&out).split('\0').filter(|r| !r.is_empty()) {
        // `<mode> <sha> <stage>\t<path>`: the stage is the last field before
        // the tab, and the path may contain spaces.
        let Some((meta, _)) = rec.split_once('\t') else { continue };
        match meta.rsplit(' ').next() {
            Some("1") => mask |= 1,
            Some("2") => mask |= 2,
            Some("3") => mask |= 4,
            _ => {}
        }
    }
    Ok(mask)
}

fn read_stage(repo: &str, stage: u8, file: &str) -> Result<Vec<u8>, String> {
    // `--` is not accepted after an object name, so the pathspec is the object
    // name: `:2:path` is a single argument git parses itself. A path starting
    // with a dash is therefore not a hazard here either.
    capture(repo, &["show", &format!(":{stage}:{file}")])
}

/// The three versions of a conflicted file.
#[tauri::command(async)]
pub fn git_conflict_stages(project_path: String, file: String) -> Result<ConflictStages, String> {
    let mask = staged_at(&project_path, &file)?;
    if mask == 0 {
        return Err(format!("{file} has no merge conflict."));
    }
    let mut raw: [Option<Vec<u8>>; 3] = [None, None, None];
    for (i, stage) in [1u8, 2, 3].iter().enumerate() {
        if mask & (1 << i) != 0 {
            raw[i] = Some(read_stage(&project_path, *stage, &file)?);
        }
    }
    let binary = raw.iter().flatten().any(|b| b.contains(&0));
    // Lossy for the same reason `git_status` is: a stage that is not valid UTF-8
    // has no text form to show, and `binary` is already telling the caller not
    // to render it.
    let text = |b: &Option<Vec<u8>>| b.as_ref().map(|b| String::from_utf8_lossy(b).into_owned());
    Ok(ConflictStages {
        base: text(&raw[0]),
        ours: text(&raw[1]),
        theirs: text(&raw[2]),
        binary,
    })
}

/// A path inside the git dir, read through `rev-parse --git-path`, never by
/// joining `.git`: in this repo a worktree's git dir is
/// `<main>/.bare/worktrees/<name>`, and `<worktree>/.git` is a file pointing at it.
fn git_path(project_path: &str, name: &str) -> Option<std::path::PathBuf> {
    let out = capture(project_path, &["rev-parse", "--git-path", name]).ok()?;
    let rel = String::from_utf8_lossy(&out).trim().to_string();
    if rel.is_empty() {
        return None;
    }
    let p = Path::new(&rel);
    // `--git-path` answers relative to the repository, not to the caller.
    Some(if p.is_absolute() { p.to_path_buf() } else { Path::new(project_path).join(p) })
}

/// What operation is mid-flight, which decides what to call stages 2 and 3.
#[tauri::command(async)]
pub fn git_conflict_op(project_path: String) -> Result<ConflictOp, String> {
    let present = |name: &str| git_path(&project_path, name).is_some_and(|p| p.exists());

    // Order matters: a cherry-pick or revert that hits a conflict during a
    // rebase leaves both markers, and the rebase is the one that decides which
    // side is being replayed.
    Ok(if present("rebase-merge") || present("rebase-apply") {
        ConflictOp::Rebase
    } else if present("MERGE_HEAD") {
        ConflictOp::Merge
    } else if present("CHERRY_PICK_HEAD") {
        ConflictOp::CherryPick
    } else if present("REVERT_HEAD") {
        ConflictOp::Revert
    } else {
        ConflictOp::None
    })
}

fn trimmed(repo: &str, args: &[&str]) -> Option<String> {
    let out = capture(repo, args).ok()?;
    let text = String::from_utf8_lossy(&out).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn side_ref(repo: &str, rev: &str, name: Option<String>) -> Option<SideRef> {
    let sha = trimmed(repo, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")])?;
    let short = trimmed(repo, &["rev-parse", "--short", &sha]).unwrap_or_else(|| sha.chars().take(7).collect());
    Some(SideRef { sha, short, name })
}

// Tips only: `name-rev` would also name `feature~2`, but it walks history to
// do it, which takes seconds on a large repository.
fn branch_name(repo: &str, rev: &str) -> Option<String> {
    let sha = trimmed(repo, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")])?;
    let refs = trimmed(repo, &["for-each-ref", "--points-at", &sha, "--format=%(refname:short)", "refs/heads", "refs/remotes"])?;
    refs.lines().next().map(str::to_string)
}

/// The commits and refs behind the two sides of the conflict in progress.
#[tauri::command(async)]
pub fn git_conflict_sides(project_path: String) -> Result<ConflictSides, String> {
    let repo = project_path.as_str();
    let op = git_conflict_op(project_path.clone())?;
    if op == ConflictOp::Rebase {
        let dir = if git_path(repo, "rebase-merge").is_some_and(|p| p.exists()) { "rebase-merge" } else { "rebase-apply" };
        let read = |name: &str| {
            let text = std::fs::read_to_string(git_path(repo, &format!("{dir}/{name}"))?).ok()?;
            let text = text.trim().to_string();
            (!text.is_empty()).then_some(text)
        };
        // HEAD is the upstream plus whatever has been replayed so far, so it is
        // named after `onto`; the commit being replayed belongs to `head-name`.
        let onto = read("onto").and_then(|sha| branch_name(repo, &sha));
        let head_name = read("head-name").map(|n| n.trim_start_matches("refs/heads/").to_string());
        return Ok(ConflictSides { ours: side_ref(repo, "HEAD", onto), theirs: side_ref(repo, "REBASE_HEAD", head_name) });
    }
    let incoming = match op {
        ConflictOp::Merge => Some("MERGE_HEAD"),
        ConflictOp::CherryPick => Some("CHERRY_PICK_HEAD"),
        ConflictOp::Revert => Some("REVERT_HEAD"),
        _ => None,
    };
    Ok(ConflictSides {
        ours: side_ref(repo, "HEAD", trimmed(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])),
        theirs: incoming.and_then(|rev| side_ref(repo, rev, branch_name(repo, rev))),
    })
}

/// Write the resolved file and mark the conflict finished.
///
/// `content` is the whole file as the reader's choices make it, built from the
/// stages rather than by editing around the markers on disk (see
/// `src/utils/conflict.ts`). `None` means the resolution is that the file is
/// gone, which is the only sensible reading of accepting the side of a
/// delete/modify conflict that deleted it: an empty file is a different answer
/// from no file, and staging one where git means the other resolves the merge
/// into something neither side asked for.
///
/// **Refuses a path that is no longer unmerged.** The tab holds a model of the
/// conflict as it was when it opened, and the merge can be finished or aborted
/// in the terminal underneath it. Without this check a stale tab would write its
/// resolution over whatever is there now and stage it, which is the same class
/// of mistake the discard fingerprints exist to prevent.
#[tauri::command]
pub async fn git_conflict_resolve(project_path: String, file: String, content: Option<String>) -> Result<(), String> {
    crate::exec::git_write("git_conflict_resolve", project_path.clone(), move || git_conflict_resolve_body(project_path, file, content)).await
}

pub(crate) fn git_conflict_resolve_body(
    project_path: String,
    file: String,
    content: Option<String>,
) -> Result<(), String> {
    if staged_at(&project_path, &file)? == 0 {
        return Err(format!("{file} is no longer conflicted, so nothing was written."));
    }
    match content {
        Some(text) => {
            // The path comes from the tab id, which came from `git status`, but
            // this is the one place in the conflict surface that reaches the
            // filesystem directly instead of going through git, so it is the one
            // place that has to re-establish what git was providing.
            let path = crate::git::inside_repo(&project_path, &file)?;
            std::fs::write(&path, text).map_err(|e| e.to_string())?;
            capture(&project_path, &["add", "--", &file])?;
        }
        // `-f` because the path is unmerged: git will not remove a file it
        // cannot compare against a single index entry without being told to.
        None => {
            capture(&project_path, &["rm", "-f", "--", &file])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn git(dir: &Path, args: &[&str]) {
        Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    }

    /// A repo on `main` with `f.txt` committed, plus a `feature` branch, both
    /// ready to be driven into whatever conflict a test needs.
    fn repo(name: &str) -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("sway_conflict_{name}_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&dir, &["config", "user.email", "t@t"]);
        git(&dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("f.txt"), "one\ntwo\nthree\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "init"]);
        git(&dir, &["branch", "feature"]);
        dir
    }

    /// Both branches rewrite `f.txt`, then `main` merges `feature` and fails.
    fn conflicted(name: &str) -> PathBuf {
        let dir = repo(name);
        git(&dir, &["checkout", "-q", "feature"]);
        std::fs::write(dir.join("f.txt"), "one\nTHEIRS\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "theirs"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("f.txt"), "one\nOURS\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "ours"]);
        git(&dir, &["merge", "feature"]);
        dir
    }

    #[test]
    fn all_three_stages_come_out_of_the_index() {
        let dir = conflicted("three");
        let p = dir.to_string_lossy().into_owned();

        let s = git_conflict_stages(p, "f.txt".into()).unwrap();

        // The base is the common ancestor's version, not either side's, and
        // none of the three is the marker-riddled file on disk.
        assert_eq!(s.base.as_deref(), Some("one\ntwo\nthree\n"));
        assert_eq!(s.ours.as_deref(), Some("one\nOURS\nthree\n"));
        assert_eq!(s.theirs.as_deref(), Some("one\nTHEIRS\nthree\n"));
        assert!(!s.binary);
        let on_disk = std::fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(on_disk.contains("<<<<<<<"), "the working copy really does hold markers");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_delete_modify_conflict_reports_the_missing_side_rather_than_failing() {
        // The conflict git cannot represent as two versions: one side deleted
        // the file. Reading stage 3 fails, and the whole read would fail with it
        // if a failed `git show` were taken to mean "no such stage".
        let dir = repo("delete_modify");
        git(&dir, &["checkout", "-q", "feature"]);
        git(&dir, &["rm", "-q", "f.txt"]);
        git(&dir, &["commit", "-qm", "deleted"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("f.txt"), "one\nOURS\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "ours"]);
        git(&dir, &["merge", "feature"]);
        let p = dir.to_string_lossy().into_owned();

        let s = git_conflict_stages(p, "f.txt".into()).unwrap();

        assert!(s.base.is_some(), "the ancestor is still there");
        assert_eq!(s.ours.as_deref(), Some("one\nOURS\nthree\n"));
        assert_eq!(s.theirs, None, "the side that deleted it has no stage");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_add_add_conflict_has_no_base() {
        let dir = repo("add_add");
        git(&dir, &["checkout", "-q", "feature"]);
        std::fs::write(dir.join("new.txt"), "theirs\n").unwrap();
        git(&dir, &["add", "new.txt"]);
        git(&dir, &["commit", "-qm", "theirs adds"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("new.txt"), "ours\n").unwrap();
        git(&dir, &["add", "new.txt"]);
        git(&dir, &["commit", "-qm", "ours adds"]);
        git(&dir, &["merge", "feature"]);
        let p = dir.to_string_lossy().into_owned();

        let s = git_conflict_stages(p, "new.txt".into()).unwrap();

        assert_eq!(s.base, None, "two independent creations share no ancestor");
        assert_eq!(s.ours.as_deref(), Some("ours\n"));
        assert_eq!(s.theirs.as_deref(), Some("theirs\n"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_path_with_no_stages_is_an_error_not_three_empty_sides() {
        // The difference the stage mask exists to make: a file that is simply
        // not conflicted (or not there at all) must not come back looking like
        // a conflict whose every side was deleted.
        let dir = conflicted("not_conflicted");
        let p = dir.to_string_lossy().into_owned();

        let err = git_conflict_stages(p.clone(), "nowhere.txt".into()).unwrap_err();
        assert!(err.contains("no merge conflict"), "unhelpful refusal: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_binary_conflict_says_so_rather_than_offering_mojibake() {
        let dir = repo("binary");
        git(&dir, &["checkout", "-q", "feature"]);
        std::fs::write(dir.join("b.bin"), [0u8, 1, 2, 3]).unwrap();
        git(&dir, &["add", "b.bin"]);
        git(&dir, &["commit", "-qm", "theirs adds"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("b.bin"), [0u8, 9, 9, 9]).unwrap();
        git(&dir, &["add", "b.bin"]);
        git(&dir, &["commit", "-qm", "ours adds"]);
        git(&dir, &["merge", "feature"]);
        let p = dir.to_string_lossy().into_owned();

        let s = git_conflict_stages(p, "b.bin".into()).unwrap();

        assert!(s.binary);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_sides_name_their_commits_and_swap_under_a_rebase() {
        let dir = conflicted("sides");
        let p = dir.to_string_lossy().into_owned();
        let sha = |rev: &str| String::from_utf8_lossy(&capture(&p, &["rev-parse", rev]).unwrap()).trim().to_string();
        let (main, feature) = (sha("main"), sha("feature"));
        let pair = |side: Option<SideRef>| {
            let side = side.expect("a side with a commit");
            assert!(side.sha.starts_with(&side.short), "{} is a prefix of {}", side.short, side.sha);
            (side.sha, side.name)
        };

        let merge = git_conflict_sides(p.clone()).unwrap();
        assert_eq!(pair(merge.ours), (main.clone(), Some("main".to_string())));
        assert_eq!(pair(merge.theirs), (feature.clone(), Some("feature".to_string())));

        // Rebasing main onto feature replays main's commit on top of feature, so
        // stage 2 is feature's and stage 3 is main's: the merge's pair reversed.
        git(&dir, &["merge", "--abort"]);
        git(&dir, &["rebase", "feature"]);
        let rebase = git_conflict_sides(p).unwrap();
        assert_eq!(pair(rebase.ours), (feature, Some("feature".to_string())));
        assert_eq!(pair(rebase.theirs), (main, Some("main".to_string())));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_merge_and_a_rebase_are_told_apart() {
        // The whole reason the operation is read at all: the same two stages
        // mean opposite things under the two, so a view that always calls
        // stage 2 "yours" is wrong for every rebase conflict.
        let dir = conflicted("op_merge");
        let p = dir.to_string_lossy().into_owned();
        assert_eq!(git_conflict_op(p.clone()).unwrap(), ConflictOp::Merge);

        git(&dir, &["merge", "--abort"]);
        assert_eq!(
            git_conflict_op(p.clone()).unwrap(),
            ConflictOp::None,
            "an aborted merge leaves nothing in progress"
        );

        git(&dir, &["rebase", "feature"]);
        assert_eq!(git_conflict_op(p).unwrap(), ConflictOp::Rebase);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_conflict_in_a_linked_worktree_is_found_where_git_actually_keeps_it() {
        // The case the `--git-path` read exists for, and the shape this project
        // actually runs in. A linked worktree's `.git` is a *file* pointing at
        // `<main>/.git/worktrees/<name>`, and that is where MERGE_HEAD is
        // written, so joining `<worktree>/.git/MERGE_HEAD` finds nothing and
        // every conflict in every worktree reads as "nothing in progress".
        let dir = repo("worktree");
        git(&dir, &["checkout", "-q", "feature"]);
        std::fs::write(dir.join("f.txt"), "one\nTHEIRS\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "theirs"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("f.txt"), "one\nOURS\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "ours"]);

        let linked = dir.parent().unwrap().join(format!(
            "{}_linked",
            dir.file_name().unwrap().to_string_lossy()
        ));
        git(&dir, &["worktree", "add", "-q", "-b", "side", &linked.to_string_lossy(), "main"]);
        // Conflict inside the linked worktree, not the main one.
        Command::new("git").arg("-C").arg(&linked).args(["merge", "feature"]).output().unwrap();
        let p = linked.to_string_lossy().into_owned();

        assert!(linked.join(".git").is_file(), "a linked worktree's .git is a file");
        assert!(
            !linked.join(".git/MERGE_HEAD").exists(),
            "the naive join really does miss it, which is what this guards"
        );
        assert_eq!(git_conflict_op(p.clone()).unwrap(), ConflictOp::Merge);

        // And the stages read from the worktree's own index, not the main one.
        let s = git_conflict_stages(p, "f.txt".into()).unwrap();
        assert_eq!(s.ours.as_deref(), Some("one\nOURS\nthree\n"));

        git(&dir, &["worktree", "remove", "--force", &linked.to_string_lossy()]);
        std::fs::remove_dir_all(&linked).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The unmerged stages git still holds for `file`, as text.
    fn unmerged(dir: &Path, file: &str) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["ls-files", "-u", "--", file])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn a_resolution_is_written_to_the_file_and_staged_as_merged() {
        // The two halves of finishing a conflict: the working copy stops holding
        // markers, and the index stops holding three versions. Either one alone
        // leaves the merge unfinished in a way that looks finished.
        let dir = conflicted("resolve");
        let p = dir.to_string_lossy().into_owned();
        assert!(!unmerged(&dir, "f.txt").is_empty(), "starts unmerged");

        git_conflict_resolve_body(p, "f.txt".into(), Some("one\nRESOLVED\nthree\n".into())).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.join("f.txt")).unwrap(),
            "one\nRESOLVED\nthree\n"
        );
        assert!(unmerged(&dir, "f.txt").is_empty(), "the stages are gone");
        let staged = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["diff", "--cached", "--name-only"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&staged.stdout).trim(), "f.txt");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_conflict_that_was_already_finished_elsewhere_is_refused() {
        // The tab holds the conflict as it was when it opened; the merge can be
        // finished or aborted in the terminal underneath it. Writing the stale
        // resolution anyway would overwrite whatever is there now and stage it.
        let dir = conflicted("stale");
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["add", "f.txt"]);
        std::fs::write(dir.join("f.txt"), "resolved by hand\n").unwrap();

        let err = git_conflict_resolve_body(p, "f.txt".into(), Some("stale\n".into())).unwrap_err();

        assert!(err.contains("no longer conflicted"), "unhelpful refusal: {err}");
        assert_eq!(
            std::fs::read_to_string(dir.join("f.txt")).unwrap(),
            "resolved by hand\n",
            "the hand-written resolution survived"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn accepting_a_deletion_removes_the_file_rather_than_emptying_it() {
        // The delete/modify conflict, resolved the way the deleting side meant.
        // An empty file staged here would be a version neither side wrote.
        let dir = repo("resolve_delete");
        git(&dir, &["checkout", "-q", "feature"]);
        git(&dir, &["rm", "-q", "f.txt"]);
        git(&dir, &["commit", "-qm", "deleted"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("f.txt"), "one\nOURS\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "ours"]);
        git(&dir, &["merge", "feature"]);
        let p = dir.to_string_lossy().into_owned();

        git_conflict_resolve_body(p, "f.txt".into(), None).unwrap();

        assert!(!dir.join("f.txt").exists(), "the file is gone, not empty");
        assert!(unmerged(&dir, "f.txt").is_empty(), "and the conflict with it");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_path_that_climbs_out_of_the_worktree_is_refused() {
        // The one place in this module that reaches the filesystem instead of
        // going through git, so the containment git was providing has to be
        // re-established here.
        let dir = conflicted("escape");
        let p = dir.to_string_lossy().into_owned();
        let outside = dir.parent().unwrap().join("escaped.txt");
        std::fs::remove_file(&outside).ok();

        let err = git_conflict_resolve_body(p, "../escaped.txt".into(), Some("owned\n".into()))
            .unwrap_err();

        // Refused before the write, whether by the containment check or by the
        // stage read; what matters is that nothing landed outside.
        assert!(!outside.exists(), "wrote outside the worktree: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_cherry_pick_is_not_reported_as_a_merge() {
        let dir = repo("op_pick");
        git(&dir, &["checkout", "-q", "feature"]);
        std::fs::write(dir.join("f.txt"), "one\nTHEIRS\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "theirs"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("f.txt"), "one\nOURS\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "ours"]);
        git(&dir, &["cherry-pick", "feature"]);
        let p = dir.to_string_lossy().into_owned();

        assert_eq!(git_conflict_op(p).unwrap(), ConflictOp::CherryPick);
        std::fs::remove_dir_all(&dir).ok();
    }
}
