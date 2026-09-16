//! `git blame --porcelain`, parsed to one commit per line.
//!
//! Its own module rather than more of `git.rs` for the same reason `patch.rs` is
//! one: this is a parser with a data model, not another command surface. The one
//! thing it borrows is a local `capture`, the same twelve lines `backstop.rs`
//! keeps.
//!
//! The porcelain format is a stream of groups. A group opens with
//! `<sha> <orig-line> <final-line> [<n-lines>]`, carries the commit's metadata
//! as `key value` lines, and ends with the source line itself behind a tab.
//! **The metadata is emitted only the first time a commit appears**; every later
//! line of that commit opens with the header alone. So the parser holds the
//! commit it is inside, and a group with no metadata is not a malformed group.

use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;

/// The commit a line came from.
///
/// One per commit, not one per line: a long file usually has a few hundred
/// commits behind it, and repeating the author and summary per line would be
/// most of the payload.
#[derive(Serialize, Debug, PartialEq, Clone, Default)]
pub struct BlameCommit {
    pub sha: String,
    pub short: String,
    pub author: String,
    /// Author time, seconds since the epoch. The frontend does the rendering,
    /// since "how long ago" is a question about the reader's clock.
    pub time: i64,
    pub summary: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Blame {
    /// HEAD when this was read. The caller caches against it: committed-line
    /// blame cannot change while HEAD stands still, however much you type.
    pub head: String,
    /// One entry per line of the file, in order: an index into `commits`.
    pub lines: Vec<u32>,
    pub commits: Vec<BlameCommit>,
}

/// git's own name for "this line is not committed": an all-zero sha. It arrives
/// with an author of "Not Committed Yet" and the current time, neither of which
/// says anything, so the frontend reads the sha and ignores the rest.
///
/// Test-only on this side of the bridge: nothing in Rust branches on it (the sha
/// is passed through verbatim), so it exists here to let the parser's tests name
/// what they are asserting.
#[cfg(test)]
pub const UNCOMMITTED: &str = "0000000000000000000000000000000000000000";

fn capture(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    // Deliberately not trimmed: a file whose last line is empty ends in a group
    // whose source line is a lone tab, and trimming would drop that line's
    // blame and silently shorten the whole list by one.
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn is_sha(word: &str) -> bool {
    word.len() == 40 && word.chars().all(|c| c.is_ascii_hexdigit())
}

/// Parse the porcelain stream into per-line commit indices plus the commits
/// themselves, in first-seen order.
pub fn parse_porcelain(text: &str) -> (Vec<u32>, Vec<BlameCommit>) {
    let mut lines = Vec::new();
    let mut commits: Vec<BlameCommit> = Vec::new();
    let mut index: HashMap<String, u32> = HashMap::new();
    let mut current: Option<u32> = None;

    for line in text.lines() {
        // The source line, which closes the group. Its text is ignored: the
        // buffer on screen already holds it, and it is the one field that would
        // make this payload the size of the file.
        if line.starts_with('\t') {
            if let Some(at) = current {
                lines.push(at);
            }
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("");
        if is_sha(key) {
            current = Some(*index.entry(key.to_string()).or_insert_with(|| {
                commits.push(BlameCommit {
                    sha: key.to_string(),
                    short: key[..7].to_string(),
                    ..Default::default()
                });
                (commits.len() - 1) as u32
            }));
            continue;
        }
        let Some(at) = current else { continue };
        let commit = &mut commits[at as usize];
        match key {
            "author" => commit.author = value.to_string(),
            "author-time" => commit.time = value.parse().unwrap_or(0),
            "summary" => commit.summary = value.to_string(),
            _ => {}
        }
    }
    (lines, commits)
}

/// Blame the working-tree copy of `file`, and say which HEAD it was read at.
///
/// A file git cannot blame (untracked, or never committed) is an empty blame
/// rather than an error: every one of its lines is uncommitted, which is exactly
/// what "no line has a commit" renders as.
#[tauri::command(async)]
pub fn git_blame(project_path: String, file: String) -> Result<Blame, String> {
    let head = capture(&project_path, &["rev-parse", "--quiet", "--verify", "HEAD"])
        .map(|h| h.trim().to_string())
        .unwrap_or_default();
    let Ok(text) = capture(&project_path, &["blame", "--porcelain", "--", &file]) else {
        return Ok(Blame { head, lines: Vec::new(), commits: Vec::new() });
    };
    let (lines, commits) = parse_porcelain(&text);
    Ok(Blame { head, lines, commits })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn porcelain_repeats_only_the_header_after_a_commits_first_line() {
        // The shape that a naive "every group carries its metadata" parser gets
        // wrong: the second line of commit `aaa` has a header and nothing else,
        // and must still be attributed to `aaa`.
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let text = format!(
            "{a} 1 1 2\nauthor Ada\nauthor-time 1700000000\nsummary first\nfilename f.txt\n\tone\n\
             {a} 2 2\n\ttwo\n\
             {b} 3 3 1\nauthor Bob\nauthor-time 1800000000\nsummary second\nfilename f.txt\n\tthree\n",
        );

        let (lines, commits) = parse_porcelain(&text);

        assert_eq!(lines, vec![0, 0, 1], "line 2 belongs to the commit above it");
        assert_eq!(
            commits,
            vec![
                BlameCommit {
                    sha: a.clone(),
                    short: "aaaaaaa".into(),
                    author: "Ada".into(),
                    time: 1_700_000_000,
                    summary: "first".into(),
                },
                BlameCommit {
                    sha: b,
                    short: "bbbbbbb".into(),
                    author: "Bob".into(),
                    time: 1_800_000_000,
                    summary: "second".into(),
                },
            ],
        );
    }

    #[test]
    fn an_uncommitted_line_carries_the_all_zero_sha() {
        // The verify's named case. git hands it an author of "Not Committed Yet"
        // and the current time, so the sha is the only field worth reading.
        let text = format!(
            "{UNCOMMITTED} 1 1 1\nauthor Not Committed Yet\nauthor-time 1900000000\n\
             summary Version of f.txt from f.txt\nfilename f.txt\n\tfresh\n",
        );

        let (lines, commits) = parse_porcelain(&text);

        assert_eq!(lines, vec![0]);
        assert_eq!(commits[0].sha, UNCOMMITTED);
        assert_eq!(commits[0].short, "0000000");
    }

    #[test]
    fn a_file_ending_in_a_blank_line_keeps_that_lines_blame() {
        // The group for a blank last line is a lone tab, which any trim of the
        // captured output would eat, shortening the list by exactly one.
        let a = "a".repeat(40);
        let text = format!("{a} 1 1 2\nauthor Ada\n\tone\n{a} 2 2\n\t\n");

        let (lines, _) = parse_porcelain(&text);

        assert_eq!(lines.len(), 2, "the blank line still has a blame");
    }

    fn repo_with_two_authors() -> std::path::PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tori_blame_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "ada@t"]);
        git(&dir, &["config", "user.name", "Ada"]);
        std::fs::write(dir.join("f.txt"), "one\ntwo\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "first two lines"]);

        git(&dir, &["config", "user.name", "Bob"]);
        std::fs::write(dir.join("f.txt"), "one\ntwo\nthree\n").unwrap();
        git(&dir, &["commit", "-q", "-am", "a third"]);
        dir
    }

    #[test]
    fn blame_reads_a_real_file_line_by_line() {
        let dir = repo_with_two_authors();
        let p = dir.to_string_lossy().into_owned();

        let blame = git_blame(p.clone(), "f.txt".into()).unwrap();

        assert_eq!(blame.lines.len(), 3);
        assert_eq!(blame.head.len(), 40, "head is the sha the cache keys on");
        let author_of = |ln: usize| blame.commits[blame.lines[ln] as usize].author.as_str();
        assert_eq!(author_of(0), "Ada");
        assert_eq!(author_of(1), "Ada");
        assert_eq!(author_of(2), "Bob");
        // The first two lines share one commit, and so one entry.
        assert_eq!(blame.lines[0], blame.lines[1]);
        assert_ne!(blame.lines[1], blame.lines[2]);
        assert!(blame.commits[blame.lines[2] as usize].time > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unsaved_line_is_blamed_on_no_one_rather_than_on_the_last_commit() {
        let dir = repo_with_two_authors();
        let p = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("f.txt"), "one\ntwo\nthree\nfour\n").unwrap();

        let blame = git_blame(p, "f.txt".into()).unwrap();

        assert_eq!(blame.lines.len(), 4);
        assert_eq!(blame.commits[blame.lines[3] as usize].sha, UNCOMMITTED);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_git_cannot_blame_is_an_empty_blame_rather_than_an_error() {
        // An untracked file: every line of it is uncommitted, which is what an
        // empty blame renders as. An error here would be a toast on every open.
        let dir = repo_with_two_authors();
        let p = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("new.txt"), "hello\n").unwrap();

        let blame = git_blame(p, "new.txt".into()).unwrap();

        assert!(blame.lines.is_empty());
        assert!(blame.commits.is_empty());
        assert_eq!(blame.head.len(), 40, "HEAD is still reported");
        std::fs::remove_dir_all(&dir).ok();
    }
}
