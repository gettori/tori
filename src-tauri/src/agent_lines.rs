//! Which agent turn wrote each line of a file that is not committed yet.
//!
//! Blame stops at HEAD: every line an agent wrote this afternoon is
//! "not committed yet" and nothing more. The answer is the same one a diff
//! hunk's provenance gives, read per line rather than per hunk, so this is a
//! thin projection of `provenance::line_turns`: the gutter and the hunk panel
//! walk the same checkpoints and weigh the same evidence, and cannot disagree
//! about who wrote a line.
//!
//! Sessions are found by the worktree they ran in, not from the checkpoint
//! refs: a bare repo's worktrees share one ref store, so the refs list sessions
//! from *other* worktrees, whose trees describe an entirely different set of
//! files.

use std::path::PathBuf;

use serde::Serialize;

use crate::provenance::{line_turns, live_end, worktree_sessions, Histories, SessionRef};

/// A turn that wrote the file, as the widget names it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AgentTurn {
    pub session_id: String,
    pub prompt_ts: u64,
    /// 1-based position in its session, so the label can read "turn 12".
    pub ordinal: usize,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct AgentLines {
    /// One entry per line of the file as it is on disk: an index into `turns`,
    /// or -1 for a line no recorded turn wrote (committed, hand-typed, or
    /// written by a turn that named no path).
    pub lines: Vec<i32>,
    pub turns: Vec<AgentTurn>,
}

/// `@@ -a,b +c,d @@` as the numbers that matter: where the old lines were, how
/// many there were, and how many replaced them.
#[derive(Debug, PartialEq)]
pub(crate) struct Hunk {
    pub old_start: usize,
    pub old_count: usize,
    pub new_count: usize,
}

pub(crate) fn parse_hunks(diff: &str) -> Vec<Hunk> {
    diff.lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("@@ -")?;
            let (old, rest) = rest.split_once(" +")?;
            let new = rest.split_once(" @@")?.0;
            let field = |spec: &str| -> Option<(usize, usize)> {
                match spec.split_once(',') {
                    // A count of 1 is written implicitly, as a bare line number.
                    None => Some((spec.parse().ok()?, 1)),
                    Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
                }
            };
            let (old_start, old_count) = field(old)?;
            let (_, new_count) = field(new)?;
            Some(Hunk {
                old_start,
                old_count,
                new_count,
            })
        })
        .collect()
}

pub(crate) fn capture(repo: &str, args: &[&str]) -> Option<String> {
    let out = crate::exec::git_in(repo).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// How many lines the file has in a given tree. Zero when it is not in it at
/// all, which is what a file the first turn created looks like.
pub(crate) fn line_count(repo: &str, tree: &str, file: &str) -> usize {
    let spec = format!("{tree}:{file}");
    // Untrimmed, deliberately: a file whose last line is blank would otherwise
    // come back one line short, and every line below the first hunk with it.
    capture(repo, &["show", &spec])
        .map(|text| text.split_inclusive('\n').count())
        .unwrap_or(0)
}

/// Where the live snapshot's scratch index lives. Per repo, because git's index
/// carries a stat cache for the files of one worktree; sharing one across repos
/// would make every snapshot a full re-hash.
pub(crate) fn live_index_path(repo: &str) -> PathBuf {
    let slug: String = repo
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .collect();
    crate::owned_state::config_dir().join("agent-lines-index").join(slug)
}

/// Which agent turn wrote each line of `file`, for every session that ran in
/// this worktree.
///
/// An empty answer is the normal case (no agent has written this file), so
/// nothing here is an error: a file no session touched, a repo with no
/// checkpoints, and a failed snapshot all mean the same thing to the reader.
#[tauri::command(async)]
pub fn agent_lines(
    index: tauri::State<'_, crate::sessions::SessionIndex>,
    project_path: String,
    file: String,
) -> Result<AgentLines, String> {
    let sessions = worktree_sessions(&index, &project_path);
    Ok(lines_for(&project_path, &file, &sessions, &Histories::default()))
}

fn lines_for(repo: &str, file: &str, sessions: &[SessionRef], histories: &Histories) -> AgentLines {
    let empty = AgentLines {
        lines: Vec::new(),
        turns: Vec::new(),
    };
    let Ok(end) = live_end(repo) else { return empty };
    // No turns named means no agent wrote the file, and a vector of -1 would
    // only be that fact spelled out once per line.
    match line_turns(repo, file, &end, sessions, histories) {
        Some((lines, turns)) if !turns.is_empty() => AgentLines {
            lines,
            turns: turns
                .into_iter()
                .map(|t| AgentTurn {
                    session_id: t.session.id,
                    prompt_ts: t.prompt_ts,
                    ordinal: t.ordinal,
                })
                .collect(),
        },
        _ => empty,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn hunk_headers_read_both_the_explicit_and_the_implicit_count() {
        let diff = "@@ -1,2 +1,3 @@\n@@ -7 +9,0 @@\n@@ -0,0 +1,4 @@\n";

        assert_eq!(
            parse_hunks(diff),
            vec![
                Hunk {
                    old_start: 1,
                    old_count: 2,
                    new_count: 3
                },
                Hunk {
                    old_start: 7,
                    old_count: 1,
                    new_count: 0
                },
                Hunk {
                    old_start: 0,
                    old_count: 0,
                    new_count: 4
                },
            ]
        );
    }

    use crate::checkpoint::{checkpoint_note_touched, checkpoint_snapshot_body};
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

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
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn tmp_repo() -> (PathBuf, String) {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori_agent_lines_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        (dir, format!("agentsess-{n}-{seq}"))
    }

    fn cleanup(dir: &Path, session: &str) {
        std::fs::remove_dir_all(dir).ok();
        std::fs::remove_file(live_index_path(&dir.to_string_lossy())).ok();
        let touched = crate::owned_state::config_dir()
            .join("checkpoint-touched")
            .join(session);
        std::fs::remove_dir_all(touched).ok();
        crate::checkpoint::remove_indexes(session);
    }

    fn read(dir: &Path, file: &str, session: &str) -> AgentLines {
        let sessions = [SessionRef {
            id: session.into(),
            agent: "claude".into(),
            title: String::new(),
            cwd: String::new(),
            profile: None,
            last_active: 0,
        }];
        lines_for(&dir.to_string_lossy(), file, &sessions, &Histories::default())
    }

    /// One turn: snapshot the tree as it was before it ran, then write and
    /// record, exactly as `turnStarted` and `toolCallCompleted` do.
    fn ran_turn(dir: &Path, session: &str, ts: u64, file: &str, contents: &str) {
        checkpoint_snapshot_body(session.to_string(), dir.to_string_lossy().into_owned(), ts).unwrap();
        std::fs::write(dir.join(file), contents).unwrap();
        checkpoint_note_touched(
            session.to_string(),
            ts,
            "Edit".into(),
            vec![dir.join(file).to_string_lossy().into_owned()],
        )
        .unwrap();
    }

    #[test]
    fn a_line_reports_the_turn_that_wrote_it_not_the_latest_one() {
        // The verify's case. Three turns write the file; the question is what
        // the *middle* line says, since a walk that only diffed the newest
        // checkpoint against disk would put every uncommitted line on turn 3.
        let (dir, session) = tmp_repo();
        std::fs::write(dir.join("f.txt"), "one\ntwo\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "committed"]);

        ran_turn(&dir, &session, 100, "f.txt", "one\nfrom-turn-one\ntwo\n");
        ran_turn(&dir, &session, 200, "f.txt", "one\nfrom-turn-one\ntwo\nfrom-turn-two\n");
        ran_turn(
            &dir,
            &session,
            300,
            "f.txt",
            "one\nfrom-turn-one\ntwo\nfrom-turn-two\nfrom-turn-three\n",
        );

        let out = read(&dir, "f.txt", &session);

        assert_eq!(out.lines.len(), 5, "one entry per line of the file on disk");
        let ordinal_of = |line: usize| out.turns[out.lines[line] as usize].ordinal;
        assert_eq!(out.lines[0], -1, "a committed line belongs to no turn");
        assert_eq!(ordinal_of(1), 1, "written in turn 1, not in the latest turn");
        assert_eq!(out.lines[2], -1);
        assert_eq!(ordinal_of(3), 2);
        assert_eq!(ordinal_of(4), 3);
        cleanup(&dir, &session);
    }

    #[test]
    fn a_line_typed_after_the_last_turn_belongs_to_nobody() {
        // The trailing gap step, and the reason it exists: without it the
        // walk's line numbers stop at the last checkpoint while the file on
        // disk has moved on, and every line below the user's own edit reports
        // the turn belonging to the line above it.
        let (dir, session) = tmp_repo();
        std::fs::write(dir.join("f.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "committed"]);

        ran_turn(&dir, &session, 100, "f.txt", "one\nagent\n");
        // A later prompt closes turn 1's interval. Its own turn only read, so
        // nothing after this boundary is claimed by anyone.
        checkpoint_snapshot_body(session.clone(), dir.to_string_lossy().into_owned(), 200).unwrap();
        checkpoint_note_touched(session.clone(), 200, "Read".into(), vec![]).unwrap();
        std::fs::write(dir.join("f.txt"), "mine\none\nagent\n").unwrap();

        let out = read(&dir, "f.txt", &session);

        assert_eq!(out.lines[0], -1, "the user's own line is claimed by no turn");
        assert_eq!(out.lines[1], -1, "still the committed line");
        assert_eq!(
            out.turns[out.lines[2] as usize].ordinal, 1,
            "and the agent's line moved down with it"
        );
        cleanup(&dir, &session);
    }

    #[test]
    fn an_edit_made_between_two_turns_is_credited_to_the_turn_it_fell_inside() {
        // Named rather than hidden. A checkpoint is taken per prompt, so the
        // interval between two prompts is the finest thing this can see, and an
        // edit the user makes inside one is indistinguishable from the agent's
        // own write there. The alternative would be a snapshot per keystroke.
        let (dir, session) = tmp_repo();
        std::fs::write(dir.join("f.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "committed"]);

        ran_turn(&dir, &session, 100, "f.txt", "one\nagent\n");
        // Between the turns: no checkpoint boundary separates this from the
        // agent's write above it.
        std::fs::write(dir.join("f.txt"), "mine\none\nagent\n").unwrap();
        ran_turn(&dir, &session, 200, "f.txt", "mine\none\nagent\nagent-again\n");

        let out = read(&dir, "f.txt", &session);

        assert_eq!(out.turns[out.lines[0] as usize].ordinal, 1, "inside turn 1's interval");
        assert_eq!(out.turns[out.lines[3] as usize].ordinal, 2);
        cleanup(&dir, &session);
    }

    #[test]
    fn a_binary_file_answers_nothing_rather_than_guessing() {
        // git prints "Binary files ... differ" and no hunks, so the walk cannot
        // follow the file across the interval. Unreachable from the editor,
        // which opens text - but the command is callable with any path.
        let (dir, session) = tmp_repo();
        std::fs::write(dir.join("f.bin"), [0u8, 159, 146, 150]).unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "committed"]);
        checkpoint_snapshot_body(session.clone(), dir.to_string_lossy().into_owned(), 100).unwrap();
        std::fs::write(dir.join("f.bin"), [0u8, 1, 2, 3, 4]).unwrap();
        checkpoint_note_touched(
            session.clone(),
            100,
            "Edit".into(),
            vec![dir.join("f.bin").to_string_lossy().into_owned()],
        )
        .unwrap();

        let out = read(&dir, "f.bin", &session);

        assert!(out.lines.is_empty());
        assert!(
            out.turns.is_empty(),
            "and no turns pointing at lines that are not there"
        );
        cleanup(&dir, &session);
    }

    #[test]
    fn a_file_no_session_wrote_is_empty_rather_than_an_error() {
        let (dir, session) = tmp_repo();
        std::fs::write(dir.join("f.txt"), "one\n").unwrap();

        let out = read(&dir, "f.txt", &session);

        assert!(out.lines.is_empty());
        assert!(out.turns.is_empty());
        cleanup(&dir, &session);
    }
}
