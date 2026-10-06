//! Which agent turn wrote each line of a file that is not committed yet.
//!
//! Blame stops at HEAD: every line an agent wrote this afternoon is
//! "not committed yet" and nothing more. The turn checkpoints already hold the
//! answer, because each one is a full tree, and the difference between two
//! consecutive trees is exactly what happened in between.
//!
//! So the walk is: start from the tree before the first turn that touched this
//! file, then replay each interval's `git diff -U0` over an attribution vector,
//! stamping the lines a hunk introduces with the turn that introduced them. What
//! comes out is one turn index per line of the file as it stands right now.
//!
//! **The intervals must tile.** A turn that wrote the file through a `Bash`
//! heredoc records no path, so it is not in the plan - but it still moved the
//! file's lines. Between two planned turns the plan therefore carries an unnamed
//! step covering the gap, so line numbers stay exact and an unrecorded write is
//! attributed to nobody rather than to whichever turn happens to be next.
//!
//! **The resolution is a turn, not a keystroke.** A checkpoint is taken per
//! prompt, so the interval between two prompts is the finest thing this can
//! see, and an edit the user makes inside one is credited to the turn whose
//! interval it fell in. Anything finer would need a snapshot per write. The one
//! interval that *is* separable is the tail, after the last recorded turn, and
//! that is attributed to nobody.
//!
//! Sessions come from the caller, not from the checkpoint refs. A bare repo's
//! worktrees share one ref store, so `refs/tori/checkpoint/*` lists sessions
//! from *other* worktrees, whose trees describe an entirely different set of
//! files. The chat panel knows which sessions are in this worktree; git does not.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::checkpoint::{checkpoint_trees, rebuild_touched_index, turns_touching, write_tree_scratch, EMPTY_TREE};

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

/// One interval of the walk: the file as of `before` becomes the file as of
/// `after`, and whatever that introduced belongs to `turn`.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    /// `None` for a gap step: an interval the plan has to cross to keep line
    /// numbers exact, but that no recorded turn claims.
    pub turn: Option<AgentTurn>,
    pub before: String,
    pub after: String,
}

/// How many turns the walk will name, at most.
///
/// Each step is a `git diff` subprocess, and a long session can write one file
/// in dozens of turns, so the plan's length is the cost. The cap keeps the
/// **newest** turns, because the question this answers is about lines that are
/// not committed yet, and those are overwhelmingly recent. What it costs is
/// stated rather than hidden: a line whose turn falls off the front reads as
/// written by nobody, the same as a line written through a path Tori cannot
/// see. It is never credited to the wrong turn.
const MAX_TURNS: usize = 40;

/// The intervals to diff, in order, for a file touched by `turns`.
///
/// Pure over the index: given the turns that touched the file and each
/// session's checkpoint trees, this is the whole schedule. Kept separate from
/// the diffing so the ordering rules (which are the part that goes wrong) test
/// without a repo.
pub fn work_plan(turns: &[AgentTurn], trees: &HashMap<String, Vec<(u64, String)>>, live: &str) -> Vec<Step> {
    let mut ordered: Vec<&AgentTurn> = turns.iter().collect();
    // By time across sessions: two chats in one worktree write the same file in
    // whatever order they ran, and the later write is the one that survives.
    ordered.sort_by(|a, b| {
        a.prompt_ts
            .cmp(&b.prompt_ts)
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    if ordered.len() > MAX_TURNS {
        ordered.drain(..ordered.len() - MAX_TURNS);
    }

    let mut plan: Vec<Step> = Vec::new();
    let mut at: Option<String> = None;
    for turn in ordered {
        let empty = Vec::new();
        let session_trees = trees.get(&turn.session_id).unwrap_or(&empty);
        let before = session_trees
            .iter()
            .rev()
            .find(|(ts, _)| *ts <= turn.prompt_ts)
            .map(|(_, tree)| tree.clone())
            .unwrap_or_else(|| EMPTY_TREE.to_string());
        // No later checkpoint means the turn is still the newest thing that
        // happened, so its "after" is the working tree as it stands.
        let after = session_trees
            .iter()
            .find(|(ts, _)| *ts > turn.prompt_ts)
            .map(|(_, tree)| tree.clone())
            .unwrap_or_else(|| live.to_string());
        if let Some(prev) = &at {
            if *prev != before {
                plan.push(Step {
                    turn: None,
                    before: prev.clone(),
                    after: before.clone(),
                });
            }
        }
        at = Some(after.clone());
        plan.push(Step {
            turn: Some(turn.clone()),
            before,
            after,
        });
    }
    // The tail: whatever moved after the last recorded turn (the user's own
    // typing, another session's write) belongs to nobody, but the lines it
    // added still have to be counted or every line below them is off.
    if let Some(prev) = at {
        if prev != live {
            plan.push(Step {
                turn: None,
                before: prev,
                after: live.to_string(),
            });
        }
    }
    plan
}

/// `@@ -a,b +c,d @@` as the numbers that matter: where the old lines were, how
/// many there were, and how many replaced them.
#[derive(Debug, PartialEq)]
struct Hunk {
    old_start: usize,
    old_count: usize,
    new_count: usize,
}

fn parse_hunks(diff: &str) -> Vec<Hunk> {
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

/// Replay one interval's hunks over the attribution vector.
///
/// `attr` is in the coordinates of the interval's *before* side, which is why
/// the plan tiles: an untracked interval would leave it describing a file that
/// no longer exists at those line numbers.
fn apply_hunks(attr: &mut Vec<i32>, hunks: &[Hunk], value: i32) {
    let mut delta: isize = 0;
    for h in hunks {
        // A pure insertion is `-a,0`, and git's `a` there is the line it comes
        // *after*, not the line it lands on.
        let start = if h.old_count == 0 {
            h.old_start as isize
        } else {
            h.old_start as isize - 1
        };
        let start = (start + delta).clamp(0, attr.len() as isize) as usize;
        let end = (start + h.old_count).min(attr.len());
        attr.splice(start..end, std::iter::repeat_n(value, h.new_count));
        delta += h.new_count as isize - h.old_count as isize;
    }
}

fn capture(repo: &str, args: &[&str]) -> Option<String> {
    let out = crate::exec::git_in(repo).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// How many lines the file has in a given tree. Zero when it is not in it at
/// all, which is what a file the first turn created looks like.
fn line_count(repo: &str, tree: &str, file: &str) -> usize {
    let spec = format!("{tree}:{file}");
    // Untrimmed, deliberately: a file whose last line is blank would otherwise
    // come back one line short, and every line below the first hunk with it.
    capture(repo, &["show", &spec])
        .map(|text| text.split_inclusive('\n').count())
        .unwrap_or(0)
}

/// Walk the plan and stamp each line with the turn that wrote it.
pub fn resolve_lines(repo: &str, file: &str, plan: &[Step]) -> Vec<i32> {
    let Some(first) = plan.first() else { return Vec::new() };
    let mut attr: Vec<i32> = vec![-1; line_count(repo, &first.before, file)];
    let mut turns = 0i32;
    for step in plan {
        let value = match &step.turn {
            Some(_) => {
                turns += 1;
                turns - 1
            }
            None => -1,
        };
        if step.before == step.after {
            continue;
        }
        let Some(diff) = capture(repo, &["diff", "-U0", &step.before, &step.after, "--", file]) else {
            continue;
        };
        // A binary file has no hunks to replay, so the walk cannot follow it
        // across this interval and everything after would be measured against a
        // file it no longer describes. Nothing at all is the honest answer.
        if diff.contains("Binary files ") {
            return Vec::new();
        }
        apply_hunks(&mut attr, &parse_hunks(&diff), value);
    }
    attr
}

/// Where the live snapshot's scratch index lives. Per repo, because git's index
/// carries a stat cache for the files of one worktree; sharing one across repos
/// would make every snapshot a full re-hash.
fn live_index_path(repo: &str) -> PathBuf {
    let slug: String = repo
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .collect();
    crate::owned_state::config_dir().join("agent-lines-index").join(slug)
}

/// Which agent turn wrote each line of `file`, for the chat sessions the caller
/// says are in this worktree.
///
/// An empty answer is the normal case (no agent has written this file), so
/// nothing here is an error: a file no session touched, a repo with no
/// checkpoints, and a failed snapshot all mean the same thing to the reader.
#[tauri::command(async)]
pub fn agent_lines(project_path: String, file: String, sessions: Vec<String>) -> Result<AgentLines, String> {
    let abs = Path::new(&project_path).join(&file).to_string_lossy().into_owned();
    let mut turns: Vec<AgentTurn> = Vec::new();
    for session in &sessions {
        // Once per session ever, and only for one recorded before the index
        // existed: without it those sessions read as having written nothing.
        rebuild_touched_index(session);
        turns.extend(turns_touching(session, &abs).into_iter().map(|t| AgentTurn {
            session_id: t.session_id,
            prompt_ts: t.prompt_ts,
            ordinal: t.ordinal,
        }));
    }
    if turns.is_empty() {
        return Ok(AgentLines {
            lines: Vec::new(),
            turns: Vec::new(),
        });
    }
    let Ok(live) = write_tree_scratch(&project_path, &live_index_path(&project_path)) else {
        return Ok(AgentLines {
            lines: Vec::new(),
            turns: Vec::new(),
        });
    };
    let mut trees: HashMap<String, Vec<(u64, String)>> = HashMap::new();
    for session in turns
        .iter()
        .map(|t| t.session_id.clone())
        .collect::<std::collections::HashSet<_>>()
    {
        let list = checkpoint_trees(&project_path, &session);
        trees.insert(session, list);
    }
    let plan = work_plan(&turns, &trees, &live);
    let lines = resolve_lines(&project_path, &file, &plan);
    // No lines means no answer (a binary file), so the turns go with them: a
    // payload naming turns that nothing points at invites a reader of it to
    // conclude something about the file.
    if lines.is_empty() {
        return Ok(AgentLines {
            lines,
            turns: Vec::new(),
        });
    }
    // In plan order, which is the order `resolve_lines` numbered them in.
    let named: Vec<AgentTurn> = plan.iter().filter_map(|s| s.turn.clone()).collect();
    Ok(AgentLines { lines, turns: named })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(session: &str, ts: u64, ordinal: usize) -> AgentTurn {
        AgentTurn {
            session_id: session.into(),
            prompt_ts: ts,
            ordinal,
        }
    }

    fn trees_of(pairs: &[(&str, &[(u64, &str)])]) -> HashMap<String, Vec<(u64, String)>> {
        pairs
            .iter()
            .map(|(s, list)| {
                (
                    s.to_string(),
                    list.iter().map(|(ts, tree)| (*ts, tree.to_string())).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn the_plan_names_exactly_the_turns_that_touched_the_file() {
        // A 200-turn session, three of whose turns wrote this file. Everything
        // else in the plan is an unnamed gap: the point of the index is that
        // the other 197 turns cost nothing but the crossings between them.
        let long: Vec<(u64, String)> = (1..=200u64).map(|i| (i * 10, format!("t{i}"))).collect();
        let mut trees = HashMap::new();
        trees.insert("s".to_string(), long);
        let turns = vec![turn("s", 30, 3), turn("s", 700, 70), turn("s", 1990, 199)];

        let plan = work_plan(&turns, &trees, "live");

        let named: Vec<u64> = plan
            .iter()
            .filter_map(|s| s.turn.as_ref())
            .map(|t| t.prompt_ts)
            .collect();
        assert_eq!(named, vec![30, 700, 1990]);
        // Three named turns, two crossings between them, one tail. Not 200.
        assert_eq!(plan.len(), 6);
    }

    #[test]
    fn the_intervals_tile_from_the_first_turn_to_the_working_tree() {
        // The property the whole walk rests on: every line number `attr` holds
        // is in the coordinates of the next step's `before`, so a gap between
        // two recorded turns has to be crossed rather than jumped.
        let turns = vec![turn("s", 30, 3), turn("s", 90, 9)];
        let trees = trees_of(&[("s", &[(30, "t3"), (40, "t4"), (90, "t9")])]);

        let plan = work_plan(&turns, &trees, "live");

        let chain: Vec<(&str, &str)> = plan.iter().map(|s| (s.before.as_str(), s.after.as_str())).collect();
        assert_eq!(chain, vec![("t3", "t4"), ("t4", "t9"), ("t9", "live")]);
        // The crossing between the two recorded turns is claimed by nobody.
        assert!(plan[1].turn.is_none(), "a gap belongs to no turn");
        assert_eq!(plan.last().unwrap().after, "live", "the walk ends at the file on disk");
    }

    #[test]
    fn a_file_written_in_more_turns_than_the_cap_keeps_the_newest_of_them() {
        // Each step is a subprocess, so the plan's length is the cost. What the
        // cap drops is stated: the oldest turns, whose lines then read as
        // written by nobody. Never credited to a turn that did not write them.
        let trees: Vec<(u64, String)> = (1..=200u64).map(|i| (i * 10, format!("t{i}"))).collect();
        let mut by_session = HashMap::new();
        by_session.insert("s".to_string(), trees);
        let turns: Vec<AgentTurn> = (1..=100u64).map(|i| turn("s", i * 10, i as usize)).collect();

        let plan = work_plan(&turns, &by_session, "live");

        let named: Vec<usize> = plan.iter().filter_map(|s| s.turn.as_ref()).map(|t| t.ordinal).collect();
        assert_eq!(named.len(), MAX_TURNS);
        assert_eq!(named.first(), Some(&61), "the oldest kept, not the oldest written");
        assert_eq!(named.last(), Some(&100), "and the newest turn is always in");
    }

    #[test]
    fn a_turn_with_no_later_checkpoint_runs_to_the_working_tree() {
        let turns = vec![turn("s", 30, 3)];
        let trees = trees_of(&[("s", &[(30, "t3")])]);

        let plan = work_plan(&turns, &trees, "live");

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].after, "live");
    }

    #[test]
    fn two_sessions_are_walked_in_time_order_not_in_session_order() {
        // Two chats in one worktree: the trees come from different sessions, and
        // the crossing between them is a gap like any other.
        let turns = vec![turn("b", 50, 1), turn("a", 20, 1)];
        let trees = trees_of(&[("a", &[(20, "a1"), (30, "a2")]), ("b", &[(50, "b1"), (60, "b2")])]);

        let plan = work_plan(&turns, &trees, "live");

        let named: Vec<(&str, u64)> = plan
            .iter()
            .filter_map(|s| s.turn.as_ref())
            .map(|t| (t.session_id.as_str(), t.prompt_ts))
            .collect();
        assert_eq!(named, vec![("a", 20), ("b", 50)]);
        assert_eq!(
            plan[1],
            Step {
                turn: None,
                before: "a2".into(),
                after: "b1".into()
            }
        );
    }

    #[test]
    fn a_turn_before_any_checkpoint_starts_from_the_empty_tree() {
        let turns = vec![turn("s", 10, 1)];
        let trees = trees_of(&[("s", &[(20, "t2")])]);

        let plan = work_plan(&turns, &trees, "live");

        assert_eq!(plan[0].before, EMPTY_TREE, "nothing existed before it");
    }

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

    #[test]
    fn an_insertion_lands_after_the_line_git_names() {
        // `-2,0` means "after old line 2", not "at line 2". Off by one here and
        // every attributed line sits one row above the line it describes.
        let mut attr = vec![-1, -1, -1];
        apply_hunks(&mut attr, &parse_hunks("@@ -2,0 +3,2 @@\n"), 5);
        assert_eq!(attr, vec![-1, -1, 5, 5, -1]);
    }

    #[test]
    fn later_hunks_in_one_diff_are_placed_after_the_earlier_ones_shifted_it() {
        let mut attr = vec![-1; 10];
        // Inserting at the very top is `-0,0`; `-1,0` would mean after line 1.
        apply_hunks(&mut attr, &parse_hunks("@@ -0,0 +1,3 @@\n@@ -5,1 +8,1 @@\n"), 2);
        // Three lines added at the top, so old line 5 is now the eighth entry.
        assert_eq!(attr, vec![2, 2, 2, -1, -1, -1, -1, 2, -1, -1, -1, -1, -1]);
    }

    #[test]
    fn a_deletion_takes_its_lines_with_it() {
        let mut attr = vec![0, 1, 2, 3];
        apply_hunks(&mut attr, &parse_hunks("@@ -2,2 +1,0 @@\n"), -1);
        assert_eq!(attr, vec![0, 3]);
    }

    // --- against a real repo ---------------------------------------------

    use crate::checkpoint::{checkpoint_note_touched, checkpoint_snapshot_body};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn git(dir: &Path, args: &[&str]) {
        let out = crate::platform::process::command("git")
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

        let out = agent_lines(
            dir.to_string_lossy().into_owned(),
            "f.txt".into(),
            vec![session.clone()],
        )
        .unwrap();

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
        // A later prompt closes turn 1's interval. Its own turn ran a shell and
        // named no file, so nothing after this boundary is claimed by anyone.
        checkpoint_snapshot_body(session.clone(), dir.to_string_lossy().into_owned(), 200).unwrap();
        checkpoint_note_touched(session.clone(), 200, "Bash".into(), vec![]).unwrap();
        std::fs::write(dir.join("f.txt"), "mine\none\nagent\n").unwrap();

        let out = agent_lines(
            dir.to_string_lossy().into_owned(),
            "f.txt".into(),
            vec![session.clone()],
        )
        .unwrap();

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

        let out = agent_lines(
            dir.to_string_lossy().into_owned(),
            "f.txt".into(),
            vec![session.clone()],
        )
        .unwrap();

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

        let out = agent_lines(
            dir.to_string_lossy().into_owned(),
            "f.bin".into(),
            vec![session.clone()],
        )
        .unwrap();

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

        let out = agent_lines(
            dir.to_string_lossy().into_owned(),
            "f.txt".into(),
            vec![session.clone()],
        )
        .unwrap();

        assert!(out.lines.is_empty());
        assert!(out.turns.is_empty());
        cleanup(&dir, &session);
    }
}
