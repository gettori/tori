//! Which turn, and which tool call in it, wrote each hunk of a diff.
//!
//! `agent_lines` answers "which turn" for the editor gutter by replaying the
//! diffs between one file's recorded turns. This answers the reviewer's whole
//! question for a hunk, and it has to stay honest where that walk goes quiet: a
//! heredoc names no path, a PTY session records nothing, and two chats can be
//! mid-turn in one worktree at once.
//!
//! **The walk crosses every checkpoint of every session in the worktree**, not
//! only the turns that named this file, so an interval is always small enough
//! to ask who was in a turn during it. Intervals in which the file's blob did not
//! change are dropped by one batched `cat-file` before any diff runs, so the cost
//! is the number of times the file actually moved.
//!
//! **Who wrote an interval is decided by evidence, weakest claim wins.** Each
//! session turn overlapping the interval is read from its transcript (Claude's
//! jsonl, or the mirror log of an ACP session) and graded: it named this file, it
//! ran something that could have written it without naming it, or it could not
//! have. The touched records stand in only where the transcript cannot be
//! matched to the turn. One writer and nothing else in doubt makes a claim; any
//! other shape says why it cannot.
//!
//! **The resolution is still a turn.** A hand edit made while a turn was running
//! is credited to that turn, the same limit `agent_lines` states.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_lines::{capture, line_count, live_index_path, parse_hunks, Hunk};
use crate::chat::model::{ChatEvent, ContentBlock, ToolKind};
use crate::chat::snapshot::WRITE_TOOLS;
use crate::checkpoint::{
    checkpoint_points, path_parseable, recorded_turns, relative_to, turn_record, worktree_members, write_tree_scratch,
};
use crate::sessions::{SubagentTranscript, TranscriptTurn};

/// How many intervals that changed the file the walk replays, newest kept.
/// Lines older than that read as `Capped`, never as a younger turn's.
const MAX_CHANGES: usize = 40;

/// Attribution values below zero: no interval claims the line.
const BEFORE: i32 = -1;
const CAPPED: i32 = -2;
/// A gap between two lines where nothing was deleted.
const NO_GAP: i32 = i32::MIN;

/// Claude tools that write nothing, beyond the ones whose writes Tori can
/// already read. A turn of questions and tool lookups is not a suspect.
const INERT_TOOLS: &[&str] = &[
    "AskUserQuestion",
    "ToolSearch",
    "Skill",
    "EnterPlanMode",
    "ExitPlanMode",
];

/// The longest string a call's input carries out, so a `Write` of a large
/// file does not ship the file.
const INPUT_CAP: usize = 4000;
const PROMPT_CAP: usize = 300;
const REPLY_CAP: usize = 2000;

/// A session in the worktree, as the listing knows it.
#[derive(Clone, Debug)]
pub struct SessionRef {
    pub id: String,
    pub agent: String,
    pub title: String,
    pub cwd: String,
    pub profile: Option<String>,
    /// When its transcript last moved, which bounds its last turn. 0 when not
    /// known, which leaves that turn open.
    pub last_active: u64,
}

/// The tree the diff's new side is, and the checkpoint time it stands at.
/// `until` is `None` for a tree that is the newest thing there is (the working
/// tree, the index); checkpoints at or after `until` are not walked.
#[derive(Clone, Debug)]
pub struct End {
    pub tree: String,
    pub until: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionLabel {
    pub id: String,
    pub agent: String,
    pub title: String,
    pub cwd: String,
    pub profile: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnRef {
    pub session: SessionLabel,
    /// 1-based among the session's prompt boundaries.
    pub ordinal: usize,
    pub prompt_ts: u64,
    pub prompt: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallRef {
    pub tool_use_id: String,
    pub name: String,
    pub kind: ToolKind,
    /// The file's path or name appears in the call's input, which is what
    /// narrows a turn's many shell commands to the likely few.
    pub names_file: bool,
    pub input: Value,
    /// The nearest prose the agent wrote before the call.
    pub reply: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NoneReason {
    /// Already there at the first checkpoint the walk starts from.
    Before,
    /// Older than the changes the walk replays.
    Capped,
    /// Inside a turn of a session Tori ran but whose writes it cannot read.
    Unrecorded,
    /// Inside turns of more than one session that could have written it.
    Overlapping,
    /// While no session Tori knows of was in a turn that could have written it.
    Unseen,
    /// On a pull request whose branch no worktree here holds, so no session
    /// Tori ran could have written it here.
    Outside,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "tier", rename_all = "camelCase")]
pub enum Claim {
    /// One tool call wrote these lines.
    Call { turn: TurnRef, call: CallRef },
    /// The turn wrote them in one of these calls; the evidence does not pick.
    /// Empty when the turn is known but its calls could not be read back.
    Candidates { turn: TurnRef, calls: Vec<CallRef> },
    /// The turn wrote them only through these shell commands.
    Shell { turn: TurnRef, calls: Vec<CallRef> },
    None {
        reason: NoneReason,
        sessions: Vec<SessionLabel>,
    },
}

/// Lines `start..start + count` of the new side carry `claim`. `count` 0 is a
/// deletion after line `start`, as a hunk header writes it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRange {
    pub start: usize,
    pub count: usize,
    pub claim: Claim,
}

/// A hunk's new side: `count` lines from `start`, or a deletion after `start`
/// when `count` is 0.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq, schemars::JsonSchema)]
pub struct Span {
    pub start: usize,
    pub count: usize,
}

/// One interval of the walk.
#[derive(Clone, Debug, PartialEq)]
struct Interval {
    before: String,
    after: String,
    from: u64,
    to: u64,
}

/// Each interval in which the file's blob changed, newest `MAX_CHANGES` kept,
/// and whether any were dropped.
fn changes(points: &[(u64, String)], blobs: &[Option<String>], end: &End) -> (Vec<Interval>, bool) {
    let mut out = Vec::new();
    for (i, (ts, tree)) in points.iter().enumerate() {
        let (after, to) = match points.get(i + 1) {
            Some((next, next_tree)) => (next_tree.clone(), *next),
            None => (end.tree.clone(), end.until.unwrap_or(u64::MAX)),
        };
        if blobs.get(i) != blobs.get(i + 1) {
            out.push(Interval {
                before: tree.clone(),
                after,
                from: *ts,
                to,
            });
        }
    }
    let capped = out.len() > MAX_CHANGES;
    if capped {
        out.drain(..out.len() - MAX_CHANGES);
    }
    (out, capped)
}

/// The file's blob id in each tree, `None` where it is absent, in one
/// `cat-file --batch-check`.
fn blob_ids(repo: &str, trees: &[&str], file: &str) -> Vec<Option<String>> {
    let Ok(mut child) = crate::exec::git_in(repo)
        .args(["cat-file", "--batch-check"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return vec![None; trees.len()];
    };
    if let Some(mut stdin) = child.stdin.take() {
        for tree in trees {
            let _ = writeln!(stdin, "{tree}:{file}");
        }
    }
    let Ok(out) = child.wait_with_output() else {
        return vec![None; trees.len()];
    };
    let mut ids: Vec<Option<String>> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|line| {
            let mut parts = line.split_whitespace();
            match (parts.next(), parts.next()) {
                (Some(id), Some("blob")) => Some(id.to_string()),
                _ => None,
            }
        })
        .collect();
    ids.resize(trees.len(), None);
    ids
}

/// Replay one interval's hunks over the line attribution and the deletion
/// marks between lines. `gaps` has one entry more than `attr`: entry `i` sits
/// above line `i`.
fn apply(attr: &mut Vec<i32>, gaps: &mut Vec<i32>, hunks: &[Hunk], value: i32) {
    let mut delta: isize = 0;
    for h in hunks {
        // A pure insertion's `a` is the line it comes after, not the line it
        // lands on.
        let start = if h.old_count == 0 {
            h.old_start as isize
        } else {
            h.old_start as isize - 1
        };
        let start = (start + delta).clamp(0, attr.len() as isize) as usize;
        let end = (start + h.old_count).min(attr.len());
        attr.splice(start..end, std::iter::repeat_n(value, h.new_count));
        let marks: Vec<i32> = if h.new_count == 0 {
            vec![value]
        } else {
            let mut m = vec![NO_GAP; h.new_count + 1];
            m[0] = gaps[start];
            m[h.new_count] = gaps[end];
            m
        };
        gaps.splice(start..=end, marks);
        delta += h.new_count as isize - h.old_count as isize;
    }
}

/// Per line of the end tree's file, the interval index that wrote it, or
/// `BEFORE` / `CAPPED`; and per gap, the interval that last deleted there.
/// `None` for a file git will not diff as text.
fn replay(repo: &str, file: &str, walk: &[Interval], capped: bool, end: &End) -> Option<(Vec<i32>, Vec<i32>)> {
    let base = if capped { CAPPED } else { BEFORE };
    let start = walk.first().map_or(end.tree.as_str(), |iv| iv.before.as_str());
    let mut attr = vec![base; line_count(repo, start, file)];
    let mut gaps = vec![NO_GAP; attr.len() + 1];
    for (k, iv) in walk.iter().enumerate() {
        let diff = capture(repo, &["diff", "-U0", &iv.before, &iv.after, "--", file])?;
        // git's own marker line, never a content line, which always carries a
        // `+`, `-` or space in front.
        if diff.lines().any(|l| l.starts_with("Binary files ")) {
            return None;
        }
        apply(&mut attr, &mut gaps, &parse_hunks(&diff), k as i32);
    }
    Some((attr, gaps))
}

/// One session's turns: where each starts, and where its last one stops.
struct Turns {
    starts: Vec<u64>,
    last_end: u64,
}

impl Turns {
    fn of(points: &[(u64, String, bool)], recorded: &[u64], last_active: u64) -> Self {
        let mut starts: Vec<u64> = points
            .iter()
            .filter(|(_, _, backstop)| !backstop)
            .map(|(ts, _, _)| *ts)
            .chain(recorded.iter().copied())
            .collect();
        starts.sort_unstable();
        starts.dedup();
        let last = starts.last().copied().unwrap_or(0);
        // A transcript that last moved before its own last turn began is a
        // clock nobody can reason about, so that turn stays open.
        let last_end = match last_active {
            0 => u64::MAX,
            at if at < last => u64::MAX,
            at => at + 1,
        };
        Turns { starts, last_end }
    }

    fn end(&self, start: u64) -> u64 {
        self.starts
            .iter()
            .copied()
            .find(|s| *s > start)
            .unwrap_or(self.last_end)
    }

    /// The turns overlapping `from..to`, by start.
    fn overlapping(&self, from: u64, to: u64) -> Vec<u64> {
        self.starts
            .iter()
            .copied()
            .filter(|start| *start < to && self.end(*start) > from)
            .collect()
    }

    fn ordinal(&self, start: u64) -> usize {
        self.starts.iter().position(|s| *s == start).map_or(0, |i| i + 1)
    }
}

/// How far a transcript's own stamp on a prompt may sit before Tori's
/// checkpoint for it. A chat stamps the checkpoint as it sends, and the CLI
/// writes the record a moment later; a PTY session's checkpoint is the
/// record's own time.
const SKEW: u64 = 1;

/// A session's conversation as Tori can read it back.
enum History {
    /// A claude transcript, kept as records so a turn can be cut out by time.
    Transcript {
        session: String,
        turns: Vec<TranscriptTurn>,
        subagents: Vec<SubagentTranscript>,
    },
    /// A mirror log: events, and no time on any of them.
    Log(Vec<ChatEvent>),
}

impl History {
    fn read(session: &SessionRef) -> Self {
        use crate::chat::commands::{history_source, read_with_prompts, HistorySource};
        match history_source(&session.id, &session.agent) {
            HistorySource::Transcript(path) => History::Transcript {
                session: session.id.clone(),
                turns: crate::sessions::transcript_turns(&path, &session.agent),
                subagents: crate::sessions::subagent_transcripts(&path, &session.agent),
            },
            source => History::Log(read_with_prompts(&session.id, &source, &session.agent).0),
        }
    }

    /// The events of the turn running `start..end`, or `None` when this history
    /// cannot be matched to it.
    ///
    /// A transcript is cut by its records' own times, which is the turn Tori's
    /// checkpoints bound whatever the transcript calls a prompt: a slash
    /// command, a skill's body and a background notification all open records
    /// there without Tori taking a checkpoint. A window holding no record at
    /// all is a transcript that does not reach that far, not a turn that did
    /// nothing. A mirror log has no times; its turns that made a tool call are
    /// matched by rank to the turns Tori recorded a call in, and only when the
    /// two counts agree.
    /// When the turn running `start..end` last wrote anything to its
    /// transcript. A mirror log cannot say.
    fn last_record(&self, start: u64, end: u64) -> Option<u64> {
        let History::Transcript { turns, .. } = self else {
            return None;
        };
        let (from, to) = (start.saturating_sub(SKEW), end.saturating_sub(SKEW));
        turns.iter().filter(|t| t.ts >= from && t.ts < to).map(|t| t.ts).max()
    }

    fn turn(&self, start: u64, end: u64, recorded: &[u64]) -> Option<Vec<ChatEvent>> {
        match self {
            History::Transcript {
                session,
                turns,
                subagents,
            } => {
                let (from, to) = (start.saturating_sub(SKEW), end.saturating_sub(SKEW));
                let first = turns.iter().position(|t| t.ts >= from)?;
                let last = turns.iter().rposition(|t| t.ts < to)?;
                if last < first {
                    return None;
                }
                Some(crate::chat::history::events_from_turns(
                    session,
                    &turns[first..=last],
                    subagents,
                ))
            }
            History::Log(events) => {
                let rank = recorded.iter().position(|ts| *ts == start)?;
                let mut order: Vec<&str> = Vec::new();
                for event in events {
                    let id = match event {
                        ChatEvent::ToolCallCompleted { turn_id, .. } | ChatEvent::FileEdit { turn_id, .. } => turn_id,
                        _ => continue,
                    };
                    if !order.contains(&id.as_str()) {
                        order.push(id);
                    }
                }
                if order.len() != recorded.len() {
                    return None;
                }
                let id = order[rank];
                Some(events.iter().filter(|e| turn_of(e) == Some(id)).cloned().collect())
            }
        }
    }
}

fn turn_of(event: &ChatEvent) -> Option<&str> {
    match event {
        ChatEvent::UserMessage { turn_id, .. }
        | ChatEvent::TextDelta { turn_id, .. }
        | ChatEvent::ThinkingDelta { turn_id, .. }
        | ChatEvent::ToolCallStarted { turn_id, .. }
        | ChatEvent::ToolCallCompleted { turn_id, .. }
        | ChatEvent::FileEdit { turn_id, .. } => Some(turn_id),
        _ => None,
    }
}

/// One tool call of a turn, as the events built it up.
#[derive(Clone, Debug)]
struct Call {
    id: String,
    name: String,
    kind: ToolKind,
    input: Value,
    /// Where it started, for the prose above it.
    at: usize,
    paths: Vec<String>,
    patch_lines: Vec<String>,
}

impl Call {
    fn wrote(&self, repo: &str, file: &str, abs: &str) -> bool {
        self.paths.iter().any(|p| same_file(repo, file, abs, p))
            || (WRITE_TOOLS.contains(&self.name.as_str())
                && self
                    .input
                    .get("file_path")
                    .and_then(Value::as_str)
                    .is_some_and(|p| same_file(repo, file, abs, p)))
    }

    /// Could have written a file without naming it.
    fn loose(&self) -> bool {
        match self.kind {
            ToolKind::Read
            | ToolKind::Edit
            | ToolKind::Search
            | ToolKind::Think
            | ToolKind::Fetch
            | ToolKind::SwitchMode => false,
            ToolKind::Execute => true,
            _ => !path_parseable(&self.name) && !INERT_TOOLS.contains(&self.name.as_str()),
        }
    }

    fn names(&self, file: &str) -> bool {
        let name = Path::new(file).file_name().and_then(|n| n.to_str()).unwrap_or(file);
        let text = self.input.to_string();
        text.contains(file) || text.contains(name)
    }

    /// Every line this call put into a file, as far as its own record says.
    fn written(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut take = |v: Option<&Value>| {
            if let Some(text) = v.and_then(Value::as_str) {
                out.extend(text.lines().map(str::to_string));
            }
        };
        take(self.input.get("new_string"));
        take(self.input.get("content"));
        take(self.input.get("new_source"));
        for edit in self.input.get("edits").and_then(Value::as_array).into_iter().flatten() {
            take(edit.get("new_string"));
        }
        out.extend(self.patch_lines.iter().cloned());
        out
    }
}

fn same_file(repo: &str, file: &str, abs: &str, path: &str) -> bool {
    path == abs || relative_to(repo, path).is_some_and(|rel| rel == file)
}

fn calls_in(events: &[ChatEvent]) -> Vec<Call> {
    let mut calls: Vec<Call> = Vec::new();
    for (at, event) in events.iter().enumerate() {
        let id = match event {
            ChatEvent::ToolCallStarted { tool_use_id, .. }
            | ChatEvent::ToolCallCompleted { tool_use_id, .. }
            | ChatEvent::FileEdit { tool_use_id, .. } => tool_use_id,
            _ => continue,
        };
        let i = match calls.iter().position(|c| c.id == *id) {
            Some(i) => i,
            None => {
                calls.push(Call {
                    id: id.clone(),
                    name: String::new(),
                    kind: ToolKind::Other,
                    input: Value::Null,
                    at,
                    paths: Vec::new(),
                    patch_lines: Vec::new(),
                });
                calls.len() - 1
            }
        };
        let call = &mut calls[i];
        match event {
            ChatEvent::ToolCallStarted { name, kind, input, .. } => {
                if call.name.is_empty() {
                    call.name = name.clone();
                    call.kind = *kind;
                    call.at = at;
                }
                if call.input.is_null() || !input.is_null() && input != &Value::Object(Default::default()) {
                    call.input = input.clone();
                }
            }
            ChatEvent::ToolCallCompleted { files, patch, .. } => {
                call.paths.extend(files.iter().cloned());
                for hunk in patch {
                    call.patch_lines.extend(
                        hunk.lines
                            .iter()
                            .filter_map(|l| l.strip_prefix('+'))
                            .map(str::to_string),
                    );
                }
            }
            ChatEvent::FileEdit { path, .. } => call.paths.push(path.clone()),
            _ => {}
        }
    }
    calls
}

/// The nearest prose above `at` in the main agent's lane, as one run of the
/// deltas it arrived in. A user message above it means there is none.
fn prose(e: &ChatEvent) -> Option<(u8, &str)> {
    match e {
        ChatEvent::TextDelta {
            text, agent_id: None, ..
        } => Some((0, text.as_str())),
        ChatEvent::ThinkingDelta {
            text, agent_id: None, ..
        } => Some((1, text.as_str())),
        _ => None,
    }
}

fn reply_before(events: &[ChatEvent], at: usize) -> Option<String> {
    let mut i = at;
    while i > 0 {
        i -= 1;
        if matches!(events[i], ChatEvent::UserMessage { .. }) {
            return None;
        }
        let Some((kind, text)) = prose(&events[i]) else {
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        let mut parts = vec![text];
        while i > 0 {
            match prose(&events[i - 1]) {
                Some((k, t)) if k == kind => {
                    parts.push(t);
                    i -= 1;
                }
                _ => break,
            }
        }
        parts.reverse();
        return Some(cut(parts.concat().trim(), REPLY_CAP));
    }
    None
}

fn prompt_of(events: &[ChatEvent]) -> Option<String> {
    events.iter().find_map(|e| match e {
        ChatEvent::UserMessage { blocks, .. } => {
            let text: Vec<&str> = blocks
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            let text = text.join("\n");
            (!text.trim().is_empty()).then(|| cut(text.trim(), PROMPT_CAP))
        }
        _ => None,
    })
}

fn cut(text: &str, cap: usize) -> String {
    match text.char_indices().nth(cap) {
        Some((at, _)) => format!("{}...", &text[..at]),
        None => text.to_string(),
    }
}

fn trimmed(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(cut(s, INPUT_CAP)),
        Value::Array(items) => Value::Array(items.iter().map(trimmed).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), trimmed(v))).collect()),
        other => other.clone(),
    }
}

/// What one session turn could have done to the file.
#[derive(Clone, Debug)]
enum Verdict {
    /// It named the file; these are the calls that did.
    Named(Vec<Call>),
    /// It named nothing but ran these, any of which could have written it.
    Loose(Vec<Call>),
    /// It could not have written the file.
    Clean,
    /// Tori cannot read what it did.
    Unrecorded,
}

/// Every session's history, read once and shared by each file one request
/// resolves, so a diff of ten files does not parse a transcript ten times.
pub struct Histories {
    load: Box<dyn Fn(&SessionRef) -> History>,
    read: RefCell<HashMap<String, Rc<History>>>,
}

impl Default for Histories {
    fn default() -> Self {
        Histories::with(Box::new(History::read))
    }
}

impl Histories {
    fn with(load: Box<dyn Fn(&SessionRef) -> History>) -> Self {
        Histories {
            load,
            read: RefCell::new(HashMap::new()),
        }
    }

    fn of(&self, session: &SessionRef) -> Rc<History> {
        if let Some(history) = self.read.borrow().get(&session.id) {
            return history.clone();
        }
        let history = Rc::new((self.load)(session));
        self.read.borrow_mut().insert(session.id.clone(), history.clone());
        history
    }
}

struct Reader<'a> {
    repo: &'a str,
    file: &'a str,
    abs: String,
    sessions: &'a [SessionRef],
    turns: Vec<Turns>,
    recorded: Vec<Vec<u64>>,
    histories: &'a Histories,
    turn_events: HashMap<(usize, u64), Option<Rc<Vec<ChatEvent>>>>,
}

/// Who wrote an interval, before it is narrowed to a line range.
#[derive(Clone, Debug)]
enum Writer {
    Turn {
        session: usize,
        start: u64,
        verdict: Verdict,
    },
    /// More than one turn could have written the interval. The turns that
    /// named the file keep their calls, so a range whose text only one of
    /// those calls wrote can still be claimed.
    Contested {
        named: Vec<(usize, u64, Vec<Call>)>,
        sessions: Vec<usize>,
    },
    Nobody(NoneReason, Vec<usize>),
}

impl<'a> Reader<'a> {
    fn events(&mut self, s: usize, start: u64) -> Option<Rc<Vec<ChatEvent>>> {
        if let Some(events) = self.turn_events.get(&(s, start)) {
            return events.clone();
        }
        let end = self.turns[s].end(start);
        let history = self.histories.of(&self.sessions[s]);
        let events = history.turn(start, end, &self.recorded[s]).map(Rc::new);
        self.turn_events.insert((s, start), events.clone());
        events
    }

    fn last_record(&mut self, s: usize, start: u64) -> Option<u64> {
        let end = self.turns[s].end(start);
        self.histories.of(&self.sessions[s]).last_record(start, end)
    }

    fn verdict(&mut self, s: usize, start: u64) -> Verdict {
        if let Some(events) = self.events(s, start) {
            let calls = calls_in(&events);
            let named: Vec<Call> = calls
                .iter()
                .filter(|c| c.wrote(self.repo, self.file, &self.abs))
                .cloned()
                .collect();
            if !named.is_empty() {
                return Verdict::Named(named);
            }
            let loose: Vec<Call> = calls.into_iter().filter(Call::loose).collect();
            return if loose.is_empty() {
                Verdict::Clean
            } else {
                Verdict::Loose(loose)
            };
        }
        match turn_record(&self.sessions[s].id, start) {
            Some((_, files)) if files.iter().any(|p| same_file(self.repo, self.file, &self.abs, p)) => {
                Verdict::Named(Vec::new())
            }
            Some((tools, _)) if !tools.is_empty() && tools.iter().all(|t| path_parseable(t)) => Verdict::Clean,
            Some(_) => Verdict::Loose(Vec::new()),
            None => Verdict::Unrecorded,
        }
    }

    fn writer(&mut self, iv: &Interval) -> Writer {
        let mut named = Vec::new();
        let mut loose = Vec::new();
        let mut unrecorded = Vec::new();
        for s in 0..self.sessions.len() {
            for start in self.turns[s].overlapping(iv.from, iv.to) {
                // A turn that went quiet before the interval opened is over,
                // whatever time its next prompt came.
                if self.last_record(s, start).is_some_and(|last| last + SKEW < iv.from) {
                    continue;
                }
                match self.verdict(s, start) {
                    v @ Verdict::Named(_) => named.push((s, start, v)),
                    v @ Verdict::Loose(_) => loose.push((s, start, v)),
                    Verdict::Unrecorded => unrecorded.push(s),
                    Verdict::Clean => {}
                }
            }
        }
        let one = |mut v: Vec<(usize, u64, Verdict)>| {
            let (session, start, verdict) = v.remove(0);
            Writer::Turn {
                session,
                start,
                verdict,
            }
        };
        match (named.len(), loose.len(), unrecorded.len()) {
            (1, 0, 0) => one(named),
            (0, 1, 0) => one(loose),
            (0, 0, 0) => Writer::Nobody(NoneReason::Unseen, Vec::new()),
            (0, 0, _) => Writer::Nobody(NoneReason::Unrecorded, dedup(unrecorded)),
            _ => {
                let all = named.iter().chain(&loose).map(|(s, _, _)| *s).chain(unrecorded);
                let sessions = dedup(all.collect());
                let named = named
                    .into_iter()
                    .filter_map(|(s, start, v)| match v {
                        Verdict::Named(calls) => Some((s, start, calls)),
                        _ => None,
                    })
                    .collect();
                Writer::Contested { named, sessions }
            }
        }
    }

    fn label(&self, s: usize) -> SessionLabel {
        let session = &self.sessions[s];
        SessionLabel {
            id: session.id.clone(),
            agent: session.agent.clone(),
            title: session.title.clone(),
            cwd: session.cwd.clone(),
            profile: session.profile.clone(),
        }
    }

    fn turn_ref(&mut self, s: usize, start: u64) -> TurnRef {
        let prompt = self.events(s, start).and_then(|events| prompt_of(&events));
        TurnRef {
            session: self.label(s),
            ordinal: self.turns[s].ordinal(start),
            prompt_ts: start,
            prompt,
        }
    }

    fn call_ref(&mut self, s: usize, start: u64, call: &Call) -> CallRef {
        let reply = self.events(s, start).and_then(|events| reply_before(&events, call.at));
        CallRef {
            tool_use_id: call.id.clone(),
            name: call.name.clone(),
            kind: call.kind,
            names_file: call.names(self.file),
            input: trimmed(&call.input),
            reply,
        }
    }

    /// The claim for lines `lines` of the new side, written in `writer`'s
    /// interval.
    fn claim(&mut self, writer: &Writer, lines: &[&str]) -> Claim {
        let (s, start, verdict) = match writer {
            Writer::Nobody(reason, sessions) => {
                return Claim::None {
                    reason: *reason,
                    sessions: sessions.iter().map(|s| self.label(*s)).collect(),
                }
            }
            Writer::Contested { named, sessions } => {
                let all: Vec<(usize, u64, &Call)> = named
                    .iter()
                    .flat_map(|(s, start, calls)| calls.iter().map(move |c| (*s, *start, c)))
                    .collect();
                let calls: Vec<Call> = all.iter().map(|(_, _, c)| (*c).clone()).collect();
                let Some(picked) = pick_by_content(&calls, lines) else {
                    return Claim::None {
                        reason: NoneReason::Overlapping,
                        sessions: sessions.iter().map(|s| self.label(*s)).collect(),
                    };
                };
                let (s, start, _) = all[calls.iter().position(|c| c.id == picked.id).unwrap_or(0)];
                let turn = self.turn_ref(s, start);
                return Claim::Call {
                    turn,
                    call: self.call_ref(s, start, picked),
                };
            }
            Writer::Turn {
                session,
                start,
                verdict,
            } => (*session, *start, verdict),
        };
        let turn = self.turn_ref(s, start);
        match verdict {
            Verdict::Named(calls) => {
                let picked = match calls.as_slice() {
                    [only] => Some(only),
                    _ => pick_by_content(calls, lines),
                };
                match picked {
                    Some(call) => Claim::Call {
                        turn,
                        call: self.call_ref(s, start, call),
                    },
                    None => Claim::Candidates {
                        turn,
                        calls: calls.iter().map(|c| self.call_ref(s, start, c)).collect(),
                    },
                }
            }
            Verdict::Loose(calls) => {
                let refs: Vec<CallRef> = calls.iter().map(|c| self.call_ref(s, start, c)).collect();
                if !calls.is_empty() && calls.iter().all(|c| c.kind == ToolKind::Execute) {
                    Claim::Shell { turn, calls: refs }
                } else {
                    Claim::Candidates { turn, calls: refs }
                }
            }
            Verdict::Clean | Verdict::Unrecorded => Claim::Candidates {
                turn,
                calls: Vec::new(),
            },
        }
    }
}

fn dedup(mut v: Vec<usize>) -> Vec<usize> {
    v.sort_unstable();
    v.dedup();
    v
}

/// The one call whose own record holds every line of the range, if exactly
/// one does. Blank lines prove nothing and are skipped.
fn pick_by_content<'c>(calls: &'c [Call], lines: &[&str]) -> Option<&'c Call> {
    let wanted: Vec<&str> = lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if wanted.is_empty() {
        return None;
    }
    let mut holding = calls.iter().filter(|c| {
        let written: Vec<String> = c.written().iter().map(|l| l.trim().to_string()).collect();
        wanted.iter().all(|w| written.iter().any(|l| l == w))
    });
    let first = holding.next()?;
    holding.next().is_none().then_some(first)
}

/// One file walked to its end tree: who wrote each line and each gap, and the
/// reader that turns an interval into a claim.
struct Walked<'a> {
    walk: Vec<Interval>,
    capped: bool,
    attr: Vec<i32>,
    gaps: Vec<i32>,
    lines: Vec<String>,
    reader: Reader<'a>,
    writers: HashMap<i32, Writer>,
}

impl<'a> Walked<'a> {
    /// `None` for a file git will not diff as text.
    fn new(
        repo: &'a str,
        file: &'a str,
        end: &End,
        sessions: &'a [SessionRef],
        histories: &'a Histories,
    ) -> Option<Self> {
        let per_session: Vec<Vec<(u64, String, bool)>> =
            sessions.iter().map(|s| checkpoint_points(repo, &s.id)).collect();
        let mut points: Vec<(u64, String)> = per_session
            .iter()
            .flatten()
            .filter(|(ts, _, _)| end.until.is_none_or(|until| *ts < until))
            .map(|(ts, tree, _)| (*ts, tree.clone()))
            .collect();
        points.sort();
        points.dedup();
        let trees: Vec<&str> = points
            .iter()
            .map(|(_, t)| t.as_str())
            .chain([end.tree.as_str()])
            .collect();
        let blobs = blob_ids(repo, &trees, file);
        let (walk, capped) = changes(&points, &blobs, end);
        let (attr, gaps) = replay(repo, file, &walk, capped, end)?;
        let text = capture(repo, &["show", &format!("{}:{file}", end.tree)]).unwrap_or_default();
        let recorded: Vec<Vec<u64>> = sessions.iter().map(|s| recorded_turns(&s.id)).collect();
        let reader = Reader {
            repo,
            file,
            abs: Path::new(repo).join(file).to_string_lossy().into_owned(),
            sessions,
            turns: sessions
                .iter()
                .enumerate()
                .map(|(i, s)| Turns::of(&per_session[i], &recorded[i], s.last_active))
                .collect(),
            recorded,
            histories,
            turn_events: HashMap::new(),
        };
        Some(Walked {
            walk,
            capped,
            attr,
            gaps,
            lines: text.lines().map(str::to_string).collect(),
            reader,
            writers: HashMap::new(),
        })
    }

    fn writer_of(&mut self, value: i32) -> Writer {
        if let Some(w) = self.writers.get(&value) {
            return w.clone();
        }
        let w = match value {
            CAPPED => Writer::Nobody(NoneReason::Capped, Vec::new()),
            v if v < 0 => Writer::Nobody(NoneReason::Before, Vec::new()),
            v => self.reader.writer(&self.walk[v as usize]),
        };
        self.writers.insert(value, w.clone());
        w
    }

    /// The claim on a deletion after line `after`.
    fn deletion(&mut self, after: usize) -> ClaimRange {
        let value = match self.gaps.get(after).copied().unwrap_or(NO_GAP) {
            NO_GAP if self.capped => CAPPED,
            NO_GAP => BEFORE,
            mark => mark,
        };
        let writer = self.writer_of(value);
        ClaimRange {
            start: after,
            count: 0,
            claim: self.reader.claim(&writer, &[]),
        }
    }

    /// Lines `first..last`, 0-based, as runs sharing an interval, each with
    /// its claim.
    fn runs(&mut self, first: usize, last: usize) -> Vec<ClaimRange> {
        let last = last.min(self.attr.len());
        let mut out = Vec::new();
        let mut at = first;
        while at < last {
            let value = self.attr[at];
            let mut run_end = at + 1;
            while run_end < last && self.attr[run_end] == value {
                run_end += 1;
            }
            let writer = self.writer_of(value);
            let slice: Vec<&str> = self
                .lines
                .get(at..run_end)
                .map(|l| l.iter().map(String::as_str).collect())
                .unwrap_or_default();
            out.push(ClaimRange {
                start: at + 1,
                count: run_end - at,
                claim: self.reader.claim(&writer, &slice),
            });
            at = run_end;
        }
        out
    }
}

/// Who wrote each requested hunk of `file`, as runs of lines sharing a claim.
///
/// A hunk is passed as its blocks of changed lines, so its context lines are
/// never claimed. `sessions` is every session that ran in this worktree. A
/// hunk of a file git will not diff as text gets no ranges.
pub fn hunk_provenance(
    repo: &str,
    file: &str,
    end: &End,
    sessions: &[SessionRef],
    hunks: &[Vec<Span>],
    histories: &Histories,
) -> Vec<Vec<ClaimRange>> {
    let Some(mut walked) = Walked::new(repo, file, end, sessions, histories) else {
        return vec![Vec::new(); hunks.len()];
    };
    let mut out = Vec::with_capacity(hunks.len());
    for blocks in hunks {
        let mut ranges = Vec::new();
        for span in blocks {
            match span.count {
                0 => ranges.push(walked.deletion(span.start)),
                count => {
                    let first = span.start.saturating_sub(1);
                    ranges.extend(walked.runs(first, first + count));
                }
            }
        }
        out.push(ranges);
    }
    out
}

/// The turn that wrote each line of `file` in `end`, for the editor gutter:
/// the same walk and the same evidence as a hunk's claim, so the two cannot
/// disagree. An index into the turns per line, or -1 where no turn is claimed.
/// `None` for a file git will not diff as text.
pub fn line_turns(
    repo: &str,
    file: &str,
    end: &End,
    sessions: &[SessionRef],
    histories: &Histories,
) -> Option<(Vec<i32>, Vec<TurnRef>)> {
    let mut walked = Walked::new(repo, file, end, sessions, histories)?;
    let mut lines = Vec::with_capacity(walked.attr.len());
    let mut turns: Vec<TurnRef> = Vec::new();
    let count = walked.attr.len();
    for range in walked.runs(0, count) {
        let index = match range.claim {
            Claim::Call { turn, .. } | Claim::Candidates { turn, .. } | Claim::Shell { turn, .. } => {
                let at = turns
                    .iter()
                    .position(|t| t.session.id == turn.session.id && t.prompt_ts == turn.prompt_ts);
                at.unwrap_or_else(|| {
                    turns.push(turn);
                    turns.len() - 1
                }) as i32
            }
            Claim::None { .. } => -1,
        };
        lines.extend(std::iter::repeat_n(index, range.count));
    }
    Some((lines, turns))
}

/// Every session whose turns ran in `root`: its own sessions, minus the Topic
/// worktrees nested under it, plus the sessions of any Topic home it is a
/// member of.
pub fn worktree_sessions(index: &crate::sessions::SessionIndex, root: &str) -> Vec<SessionRef> {
    let mut homes: HashMap<String, bool> = HashMap::new();
    crate::sessions::listed_sessions(index, None)
        .into_iter()
        .filter(|s| {
            crate::sessions::owned_by_listing(&s.cwd, root)
                || *homes
                    .entry(s.cwd.clone())
                    .or_insert_with(|| worktree_members(&s.cwd).is_some_and(|roots| roots.iter().any(|r| r == root)))
        })
        .map(|s| SessionRef {
            title: s.name.clone().unwrap_or_else(|| s.title.clone()),
            id: s.id,
            agent: s.agent,
            cwd: s.cwd,
            profile: s.profile,
            last_active: s.last_active,
        })
        .collect()
}

/// The working tree as a tree, through the same scratch index `agent_lines`
/// keeps per repo.
pub fn live_end(repo: &str) -> Result<End, String> {
    Ok(End {
        tree: write_tree_scratch(repo, &live_index_path(repo))?,
        until: None,
    })
}

/// The tree a session's turn at `ts` ended at: its next checkpoint, or the
/// working tree for its latest turn.
pub fn checkpoint_end(repo: &str, session_id: &str, ts: u64) -> Result<End, String> {
    match checkpoint_points(repo, session_id)
        .into_iter()
        .find(|(at, _, _)| *at > ts)
    {
        Some((at, tree, _)) => Ok(End { tree, until: Some(at) }),
        None => live_end(repo),
    }
}

/// One hunk's changed lines as blocks on the new side, built a line at a time.
/// A run of removals with nothing added in its place is a block of count 0
/// after the line above it.
struct Blocks {
    line: usize,
    open: Option<(usize, usize, bool)>,
    out: Vec<Span>,
}

impl Blocks {
    /// From a hunk header, `@@ -a,b +c,d @@`.
    fn new(header: &str) -> Option<Self> {
        let new = header
            .strip_prefix("@@ -")?
            .split_once(" +")
            .and_then(|(_, r)| r.split_once(" @@"))
            .map(|(n, _)| n)?;
        let (start, count) = match new.split_once(',') {
            None => (new.parse().ok()?, 1),
            Some((start, count)) => (start.parse().ok()?, count.parse().ok()?),
        };
        Some(Blocks {
            // An empty new side names the line it follows, not the one it is.
            line: if count == 0 { start + 1 } else { start },
            open: None,
            out: Vec::new(),
        })
    }

    fn feed(&mut self, text: &str) {
        if text.starts_with('+') {
            self.open.get_or_insert((self.line, 0, false)).1 += 1;
            self.line += 1;
        } else if text.starts_with('-') {
            self.open.get_or_insert((self.line, 0, false)).2 = true;
        } else if text.starts_with(' ') {
            self.close();
            self.line += 1;
        }
    }

    fn close(&mut self) {
        match self.open.take() {
            Some((start, count, _)) if count > 0 => self.out.push(Span { start, count }),
            Some((start, _, true)) => self.out.push(Span {
                start: start - 1,
                count: 0,
            }),
            _ => {}
        }
    }

    fn finish(mut self) -> Vec<Span> {
        self.close();
        self.out
    }
}

/// One hunk, header and body, as its blocks of changed lines.
pub fn hunk_spans(hunk: &str) -> Vec<Span> {
    let mut lines = hunk.lines();
    let Some(mut blocks) = lines.next().and_then(Blocks::new) else {
        return Vec::new();
    };
    for text in lines {
        blocks.feed(text);
    }
    blocks.finish()
}

/// Every hunk of a unified diff as its blocks of changed lines, per file in
/// order.
pub fn spans_of(diff: &str) -> Vec<(String, Vec<Vec<Span>>)> {
    let mut out: Vec<(String, Vec<Vec<Span>>)> = Vec::new();
    let mut old_path = String::new();
    let mut hunk: Option<Blocks> = None;
    let finish = |hunk: &mut Option<Blocks>, out: &mut Vec<(String, Vec<Vec<Span>>)>| {
        if let (Some(blocks), Some(file)) = (hunk.take(), out.last_mut()) {
            file.1.push(blocks.finish());
        }
    };
    // Only a file's header carries `---` and `+++` lines. Inside a hunk the
    // same prefix is a removed `-- ` line or an added `++ ` one.
    let mut in_header = false;
    for text in diff.lines() {
        if text.starts_with("diff --git ") {
            finish(&mut hunk, &mut out);
            in_header = true;
        } else if let Some(path) = text.strip_prefix("--- ").filter(|_| in_header) {
            old_path = path.strip_prefix("a/").unwrap_or(path).to_string();
        } else if let Some(path) = text.strip_prefix("+++ ").filter(|_| in_header) {
            let path = match path {
                "/dev/null" => old_path.clone(),
                p => p.strip_prefix("b/").unwrap_or(p).to_string(),
            };
            out.push((path, Vec::new()));
        } else if text.starts_with("@@ -") {
            finish(&mut hunk, &mut out);
            in_header = false;
            hunk = Blocks::new(text);
        } else if let Some(blocks) = hunk.as_mut() {
            blocks.feed(text);
        }
    }
    finish(&mut hunk, &mut out);
    out
}

/// The index as a tree, written from a copy of it so the user's own index,
/// and the cache tree git would store back into it, is never touched.
pub fn index_end(repo: &str) -> Result<End, String> {
    let index = capture(repo, &["rev-parse", "--path-format=absolute", "--git-path", "index"])
        .map(|p| p.trim().to_string())
        .ok_or("no index to read")?;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let copy = std::env::temp_dir().join(format!("tori-provenance-index-{}-{seq}", std::process::id()));
    std::fs::copy(&index, &copy).map_err(|e| e.to_string())?;
    let tree = crate::exec::git_in(repo)
        .args(["write-tree"])
        .env("GIT_INDEX_FILE", &copy)
        .output();
    let _ = std::fs::remove_file(&copy);
    let out = tree.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(End {
        tree: String::from_utf8_lossy(&out.stdout).trim().to_string(),
        until: None,
    })
}

/// Tauri: who wrote each hunk of a diff tab, whose new side is the working
/// tree, or the index for a staged diff.
#[tauri::command(async)]
pub fn diff_provenance(
    index: tauri::State<'_, crate::sessions::SessionIndex>,
    project_path: String,
    file: String,
    hunks: Vec<String>,
    staged: bool,
) -> Result<Vec<Vec<ClaimRange>>, String> {
    let end = if staged {
        index_end(&project_path)?
    } else {
        live_end(&project_path)?
    };
    let sessions = worktree_sessions(&index, &project_path);
    let blocks: Vec<Vec<Span>> = hunks.iter().map(|h| hunk_spans(h)).collect();
    Ok(hunk_provenance(
        &project_path,
        &file,
        &end,
        &sessions,
        &blocks,
        &Histories::default(),
    ))
}

/// Tauri: who wrote each hunk of a Checkpoints diff. A turn's diff ends at
/// that turn's next checkpoint; a "since" diff and a backstop's (no session)
/// end at the working tree, as their diffs do.
#[tauri::command(async)]
pub fn checkpoint_provenance(
    index: tauri::State<'_, crate::sessions::SessionIndex>,
    repo_path: String,
    session_id: Option<String>,
    prompt_ts: u64,
    file: String,
    cumulative: bool,
    hunks: Vec<String>,
) -> Result<Vec<Vec<ClaimRange>>, String> {
    let (root, file) = match worktree_members(&repo_path) {
        Some(roots) => crate::checkpoint::in_member(&roots, &file)?,
        None => (repo_path, file),
    };
    let end = match session_id {
        Some(session) if !cumulative => checkpoint_end(&root, &session, prompt_ts)?,
        _ => live_end(&root)?,
    };
    let sessions = worktree_sessions(&index, &root);
    let blocks: Vec<Vec<Span>> = hunks.iter().map(|h| hunk_spans(h)).collect();
    Ok(hunk_provenance(
        &root,
        &file,
        &end,
        &sessions,
        &blocks,
        &Histories::default(),
    ))
}

/// A pull request's head as the forge reports it.
pub struct PrHead {
    pub branch: String,
    pub sha: String,
    /// False for a fork's pull request, whose branch is never one here.
    pub from_origin: bool,
}

/// Who wrote each hunk of a pull request's file, read at the PR's head.
///
/// Only a branch Tori's own sessions worked on can be attributed, since the
/// worktree checked out on it is where their checkpoints are. A fork's pull
/// request, or a branch no worktree here holds, reads `Outside` on every hunk.
/// The walk stops at the head commit's time, so work done after the push
/// cannot move the lines the pull request shows.
pub fn pr_claims(
    repo: &str,
    head: &PrHead,
    file: &str,
    hunks: &[Vec<Span>],
    sessions_in: &dyn Fn(&str) -> Vec<SessionRef>,
    histories: &Histories,
) -> Result<Vec<Vec<ClaimRange>>, String> {
    let worktree = head
        .from_origin
        .then(|| crate::worktree::list_worktrees_body(repo.to_string()).ok())
        .flatten()
        .and_then(|list| list.into_iter().find(|w| w.branch == head.branch))
        .map(|w| w.path);
    let Some(root) = worktree else {
        return Ok(outside(hunks));
    };
    let tree = capture(&root, &["rev-parse", &format!("{}^{{tree}}", head.sha)])
        .ok_or("the pull request's head is not in this clone yet")?;
    let at: u64 = capture(&root, &["show", "-s", "--format=%ct", &head.sha])
        .and_then(|t| t.trim().parse().ok())
        .ok_or("the pull request's head has no commit time")?;
    let end = End {
        tree: tree.trim().to_string(),
        until: Some(at + 1),
    };
    let sessions = sessions_in(&root);
    Ok(hunk_provenance(&root, file, &end, &sessions, hunks, histories))
}

fn outside(hunks: &[Vec<Span>]) -> Vec<Vec<ClaimRange>> {
    hunks
        .iter()
        .map(|blocks| {
            blocks
                .iter()
                .map(|span| ClaimRange {
                    start: span.start,
                    count: span.count,
                    claim: Claim::None {
                        reason: NoneReason::Outside,
                        sessions: Vec::new(),
                    },
                })
                .collect()
        })
        .collect()
}

/// Tauri: who wrote each hunk of a pull request's file. The head commit has to
/// be in the local object store already, which the gap expansion's fetch does.
#[tauri::command(async)]
pub fn pr_provenance(
    index: tauri::State<'_, crate::sessions::SessionIndex>,
    project_path: String,
    head_ref: String,
    head_sha: String,
    head_repo_is_origin: bool,
    file: String,
    hunks: Vec<String>,
) -> Result<Vec<Vec<ClaimRange>>, String> {
    let blocks: Vec<Vec<Span>> = hunks.iter().map(|h| hunk_spans(h)).collect();
    let head = PrHead {
        branch: head_ref,
        sha: head_sha,
        from_origin: head_repo_is_origin,
    };
    pr_claims(
        &project_path,
        &head,
        &file,
        &blocks,
        &|root| worktree_sessions(&index, root),
        &Histories::default(),
    )
}

pub fn reply_after(turns: &[TranscriptTurn], question: &str) -> Option<String> {
    let texts = |t: &TranscriptTurn| -> Vec<String> {
        t.blocks
            .iter()
            .filter(|b| b.kind == "text")
            .filter_map(|b| b.text.clone())
            .collect()
    };
    let asked = turns
        .iter()
        .rposition(|t| t.role == "user" && texts(t).iter().any(|text| text.contains(question)))?;
    let mut said: Vec<String> = Vec::new();
    for turn in &turns[asked + 1..] {
        if turn.role == "user" && !texts(turn).is_empty() {
            break;
        }
        if turn.role == "assistant" {
            said.extend(texts(turn).into_iter().filter(|t| !t.trim().is_empty()));
        }
    }
    (!said.is_empty()).then(|| said.join("\n\n"))
}

#[tauri::command(async)]
pub fn ask_why_reply(session_id: String, agent_id: String, question: String) -> Option<String> {
    let path = crate::sessions::transcript_path(&session_id, &agent_id)?;
    reply_after(&crate::sessions::transcript_turns(&path, &agent_id), &question)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint::{checkpoint_note_touched, checkpoint_snapshot_body};
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn a_deletion_leaves_its_interval_between_the_lines_it_removed() {
        let mut attr = vec![BEFORE; 4];
        let mut gaps = vec![NO_GAP; 5];
        apply(&mut attr, &mut gaps, &parse_hunks("@@ -2,2 +1,0 @@\n"), 3);
        assert_eq!(attr, vec![BEFORE, BEFORE]);
        assert_eq!(gaps, vec![NO_GAP, 3, NO_GAP], "the mark sits above what was line 4");
    }

    #[test]
    fn an_insertion_lands_after_the_line_git_names() {
        // `-2,0` means "after old line 2", not "at line 2". Off by one here and
        // every attributed line sits one row above the line it describes.
        let mut attr = vec![-1, -1, -1];
        let mut gaps = vec![NO_GAP; attr.len() + 1];
        apply(&mut attr, &mut gaps, &parse_hunks("@@ -2,0 +3,2 @@\n"), 5);
        assert_eq!(attr, vec![-1, -1, 5, 5, -1]);
    }

    #[test]
    fn later_hunks_in_one_diff_are_placed_after_the_earlier_ones_shifted_it() {
        let mut attr = vec![-1; 10];
        let mut gaps = vec![NO_GAP; attr.len() + 1];
        // Inserting at the very top is `-0,0`; `-1,0` would mean after line 1.
        apply(
            &mut attr,
            &mut gaps,
            &parse_hunks("@@ -0,0 +1,3 @@\n@@ -5,1 +8,1 @@\n"),
            2,
        );
        // Three lines added at the top, so old line 5 is now the eighth entry.
        assert_eq!(attr, vec![2, 2, 2, -1, -1, -1, -1, 2, -1, -1, -1, -1, -1]);
    }

    #[test]
    fn a_deletion_takes_its_lines_with_it() {
        let mut attr = vec![0, 1, 2, 3];
        let mut gaps = vec![NO_GAP; attr.len() + 1];
        apply(&mut attr, &mut gaps, &parse_hunks("@@ -2,2 +1,0 @@\n"), -1);
        assert_eq!(attr, vec![0, 3]);
    }

    #[test]
    fn only_intervals_that_moved_the_file_are_walked() {
        let points: Vec<(u64, String)> = (1..=90u64).map(|i| (i * 10, format!("t{i}"))).collect();
        // The file changed going into turn 3 and into turn 90, and never in
        // between: two diffs, not eighty-nine.
        let mut blobs: Vec<Option<String>> = (1..=90u64)
            .map(|i| {
                Some(
                    if i < 3 {
                        "a"
                    } else if i < 90 {
                        "b"
                    } else {
                        "c"
                    }
                    .to_string(),
                )
            })
            .collect();
        blobs.push(Some("c".into()));
        let end = End {
            tree: "live".into(),
            until: None,
        };

        let (walk, capped) = changes(&points, &blobs, &end);

        assert!(!capped);
        let pairs: Vec<(&str, &str)> = walk.iter().map(|iv| (iv.before.as_str(), iv.after.as_str())).collect();
        assert_eq!(pairs, vec![("t2", "t3"), ("t89", "t90")]);
    }

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
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    struct Fixture {
        dir: PathBuf,
        repo: String,
        sessions: Vec<String>,
    }

    impl Fixture {
        fn new(body: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("tori_provenance_{n}_{seq}"));
            std::fs::create_dir_all(&dir).unwrap();
            git(&dir, &["init", "-q"]);
            git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
            std::fs::write(dir.join("f.txt"), body).unwrap();
            git(&dir, &["add", "-A"]);
            git(&dir, &["commit", "-qm", "committed"]);
            let repo = dir.to_string_lossy().into_owned();
            Fixture {
                dir,
                repo,
                sessions: Vec::new(),
            }
        }

        fn session(&mut self, name: &str) -> String {
            let id = format!("{name}-{}", self.dir.file_name().unwrap().to_string_lossy());
            self.sessions.push(id.clone());
            id
        }

        fn abs(&self) -> String {
            self.dir.join("f.txt").to_string_lossy().into_owned()
        }

        fn snapshot(&self, session: &str, ts: u64) {
            checkpoint_snapshot_body(session.into(), self.repo.clone(), ts).unwrap();
        }

        fn write(&self, body: &str) {
            std::fs::write(self.dir.join("f.txt"), body).unwrap();
        }

        fn end(&self) -> End {
            live_end(&self.repo).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(live_index_path(&self.repo));
            let _ = std::fs::remove_dir_all(&self.dir);
            for s in &self.sessions {
                let touched = crate::owned_state::config_dir().join("checkpoint-touched").join(s);
                let _ = std::fs::remove_dir_all(touched);
                crate::checkpoint::remove_indexes(s);
            }
        }
    }

    impl Fixture {
        fn touched(&self, session: &str, ts: u64, tool: &str, files: Vec<String>) {
            checkpoint_note_touched(session.into(), ts, tool.into(), files).unwrap();
        }
    }

    fn iso(ts: u64) -> String {
        let days = ts / 86_400;
        let rem = ts % 86_400;
        let z = days as i64 + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let mo = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(mo <= 2);
        let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
        format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.000Z")
    }

    /// A claude transcript, one record per line, as the CLI writes it.
    #[derive(Default)]
    struct Transcript(Vec<Value>);

    impl Transcript {
        fn prompt(mut self, ts: u64, text: &str) -> Self {
            self.0.push(serde_json::json!({
                "type": "user", "timestamp": iso(ts), "message": { "role": "user", "content": text }
            }));
            self
        }

        fn say(mut self, ts: u64, text: &str) -> Self {
            self.0.push(serde_json::json!({
                "type": "assistant", "timestamp": iso(ts),
                "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] }
            }));
            self
        }

        fn call(mut self, ts: u64, id: &str, name: &str, input: Value) -> Self {
            self.0.push(serde_json::json!({
                "type": "assistant", "timestamp": iso(ts),
                "message": { "role": "assistant", "content": [{ "type": "tool_use", "id": id, "name": name, "input": input }] }
            }));
            self.0.push(serde_json::json!({
                "type": "user", "timestamp": iso(ts),
                "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": id, "content": "ok" }] }
            }));
            self
        }
    }

    enum Source {
        Claude(Transcript),
        Log(Vec<Value>),
    }

    /// Reads each session the way production does: a claude transcript through
    /// the real parser and replay, a mirror log as the events it holds.
    fn loader(dir: &Path, sources: Vec<(String, Source)>) -> impl Fn(&SessionRef) -> History + 'static {
        let files: HashMap<String, Result<PathBuf, Vec<ChatEvent>>> = sources
            .into_iter()
            .map(|(id, source)| {
                let read = match source {
                    Source::Claude(t) => {
                        let path = dir.with_extension(format!("{id}.jsonl"));
                        let body: Vec<String> = t.0.iter().map(Value::to_string).collect();
                        std::fs::write(&path, body.join("\n") + "\n").unwrap();
                        Ok(path)
                    }
                    Source::Log(events) => {
                        Err(events.into_iter().map(|e| serde_json::from_value(e).unwrap()).collect())
                    }
                };
                (id, read)
            })
            .collect();
        move |session: &SessionRef| match files.get(&session.id) {
            Some(Ok(path)) => History::Transcript {
                session: session.id.clone(),
                turns: crate::sessions::transcript_turns(&path.to_string_lossy(), "claude"),
                subagents: Vec::new(),
            },
            Some(Err(events)) => History::Log(events.clone()),
            None => History::Log(Vec::new()),
        }
    }

    fn session(id: &str, agent: &str, last_active: u64) -> SessionRef {
        SessionRef {
            id: id.into(),
            agent: agent.into(),
            title: format!("{id} title"),
            cwd: String::new(),
            profile: None,
            last_active,
        }
    }

    impl Fixture {
        fn resolve(
            &self,
            sessions: &[SessionRef],
            sources: Vec<(String, Source)>,
            hunks: &[Span],
        ) -> Vec<Vec<ClaimRange>> {
            let histories = Histories::with(Box::new(loader(&self.dir, sources)));
            let blocks: Vec<Vec<Span>> = hunks.iter().map(|span| vec![*span]).collect();
            hunk_provenance(&self.repo, "f.txt", &self.end(), sessions, &blocks, &histories)
        }
    }

    fn call_of(claim: &Claim) -> (&TurnRef, &CallRef) {
        match claim {
            Claim::Call { turn, call } => (turn, call),
            other => panic!("expected one call, got {other:?}"),
        }
    }

    #[test]
    fn an_edit_names_its_call_and_the_prose_above_it_across_a_skewed_clock() {
        // Each checkpoint is stamped two seconds before the transcript's own
        // prompt, the drift a chat's clock and the CLI's clock really show.
        let mut fx = Fixture::new("one\n");
        let a = fx.session("a");
        let abs = fx.abs();
        fx.snapshot(&a, 1000);
        fx.write("one\ntwo\n");
        fx.touched(&a, 1000, "Edit", vec![abs.clone()]);
        fx.snapshot(&a, 2000);
        fx.write("one\ntwo\nthree\n");
        fx.touched(&a, 2000, "Edit", vec![abs.clone()]);
        let transcript = Transcript::default()
            .prompt(1002, "add two")
            .say(1003, "Adding line two.")
            .call(
                1004,
                "toolu_1",
                "Edit",
                serde_json::json!({ "file_path": abs, "old_string": "one\n", "new_string": "one\ntwo\n" }),
            )
            .prompt(2002, "add three")
            .say(2003, "Now three.")
            .call(
                2004,
                "toolu_2",
                "Edit",
                serde_json::json!({ "file_path": abs, "old_string": "two\n", "new_string": "two\nthree\n" }),
            );

        let out = fx.resolve(
            &[session(&a, "claude", 0)],
            vec![(a.clone(), Source::Claude(transcript))],
            &[Span { start: 2, count: 2 }],
        );

        assert_eq!(out[0].len(), 2, "one hunk spanning two turns is two claims");
        let (turn, call) = call_of(&out[0][0].claim);
        assert_eq!((out[0][0].start, out[0][0].count), (2, 1));
        assert_eq!(call.tool_use_id, "toolu_1");
        assert_eq!(call.reply.as_deref(), Some("Adding line two."));
        assert_eq!((turn.ordinal, turn.prompt.as_deref()), (1, Some("add two")));
        let (turn, call) = call_of(&out[0][1].claim);
        assert_eq!(call.tool_use_id, "toolu_2");
        assert_eq!(turn.ordinal, 2);
    }

    #[test]
    fn a_checkpoint_turn_with_two_edits_names_each_on_its_own_hunk() {
        let lines: Vec<String> = (1..=10).map(|i| format!("line {i}")).collect();
        let mut fx = Fixture::new(&(lines.join("\n") + "\n"));
        let a = fx.session("a");
        let abs = fx.abs();
        fx.snapshot(&a, 1000);
        let mut one = lines.clone();
        one[1] = "two, edited".into();
        one[8] = "nine, edited".into();
        fx.write(&(one.join("\n") + "\n"));
        fx.touched(&a, 1000, "Edit", vec![abs.clone()]);
        fx.snapshot(&a, 2000);
        let mut two = one.clone();
        two.insert(0, "a line on top, later".into());
        fx.write(&(two.join("\n") + "\n"));
        fx.touched(&a, 2000, "Edit", vec![abs.clone()]);
        let edit = |id: &str, old: &str, new: &str| {
            (
                id.to_string(),
                serde_json::json!({ "file_path": abs, "old_string": old, "new_string": new }),
            )
        };
        let (x, y, z) = (
            edit("toolu_x", "line 2", "two, edited"),
            edit("toolu_y", "line 9", "nine, edited"),
            edit("toolu_z", "line 1", "a line on top, later\nline 1"),
        );
        let transcript = Transcript::default()
            .prompt(1000, "edit two and nine")
            .call(1001, &x.0, "Edit", x.1)
            .call(1002, &y.0, "Edit", y.1)
            .prompt(2000, "add a line on top")
            .call(2001, &z.0, "Edit", z.1);
        let histories = Histories::with(Box::new(loader(&fx.dir, vec![(a.clone(), Source::Claude(transcript))])));
        let end = checkpoint_end(&fx.repo, &a, 1000).unwrap();

        let out = hunk_provenance(
            &fx.repo,
            "f.txt",
            &end,
            &[session(&a, "claude", 0)],
            &[vec![Span { start: 2, count: 1 }], vec![Span { start: 9, count: 1 }]],
            &histories,
        );

        assert_eq!(call_of(&out[0][0].claim).1.tool_use_id, "toolu_x");
        assert_eq!(call_of(&out[1][0].claim).1.tool_use_id, "toolu_y");
    }

    #[test]
    fn a_pull_request_is_attributed_only_from_the_worktree_that_holds_its_branch() {
        let mut fx = Fixture::new("one\n");
        let a = fx.session("a");
        let wt_dir = fx.dir.with_extension("wt");
        git(
            &fx.dir,
            &["worktree", "add", "-q", "-b", "feature", &wt_dir.to_string_lossy()],
        );
        let wt = std::fs::canonicalize(&wt_dir).unwrap().to_string_lossy().into_owned();
        let abs = format!("{wt}/f.txt");
        checkpoint_snapshot_body(a.clone(), wt.clone(), 1000).unwrap();
        std::fs::write(&abs, "one\ntwo\n").unwrap();
        fx.touched(&a, 1000, "Edit", vec![abs.clone()]);
        git(Path::new(&wt), &["commit", "-qam", "two"]);
        let head = capture(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let transcript = Transcript::default().prompt(1000, "add two").call(
            1001,
            "toolu_pr",
            "Edit",
            serde_json::json!({ "file_path": abs, "old_string": "one\n", "new_string": "one\ntwo\n" }),
        );
        let histories = Histories::with(Box::new(loader(&fx.dir, vec![(a.clone(), Source::Claude(transcript))])));
        let sessions = |_: &str| vec![session(&a, "claude", 0)];
        let hunks = [vec![Span { start: 2, count: 1 }]];
        let claims = |branch: &str, from_origin: bool| {
            let pr = PrHead {
                branch: branch.into(),
                sha: head.clone(),
                from_origin,
            };
            pr_claims(&fx.repo, &pr, "f.txt", &hunks, &sessions, &histories).unwrap()
        };

        assert_eq!(call_of(&claims("feature", true)[0][0].claim).1.tool_use_id, "toolu_pr");
        let elsewhere = Claim::None {
            reason: NoneReason::Outside,
            sessions: Vec::new(),
        };
        assert_eq!(claims("a-teammates-branch", true)[0][0].claim, elsewhere);
        assert_eq!(
            claims("feature", false)[0][0].claim,
            elsewhere,
            "a fork's branch is never this worktree's"
        );
        git(&fx.dir, &["worktree", "remove", "--force", &wt]);
    }

    #[test]
    fn a_forks_answer_is_what_it_said_after_the_question() {
        let dir = std::env::temp_dir().join(format!("tori_reply_after_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let t = Transcript::default()
            .prompt(1000, "the original work")
            .say(1001, "Done with the original work.")
            .prompt(2000, "Context first.\n\nQuestion: why two?\n\nAnswer from memory.")
            .call(2001, "toolu_r", "Read", serde_json::json!({ "file_path": "/r/f" }))
            .say(2002, "Because the parser needs it.")
            .say(2003, "That is all.")
            .prompt(3000, "a later prompt")
            .say(3001, "Not part of the answer.");
        let path = dir.join("fork.jsonl");
        let body: Vec<String> = t.0.iter().map(Value::to_string).collect();
        std::fs::write(&path, body.join("\n") + "\n").unwrap();
        let turns = crate::sessions::transcript_turns(&path.to_string_lossy(), "claude");

        assert_eq!(
            reply_after(&turns, "Question: why two?").as_deref(),
            Some("Because the parser needs it.\n\nThat is all.")
        );
        assert_eq!(reply_after(&turns, "Question: never asked"), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_heredoc_is_claimed_as_its_shell_command() {
        let mut fx = Fixture::new("one\n");
        let a = fx.session("a");
        fx.snapshot(&a, 1000);
        fx.write("one\nfrom heredoc\n");
        fx.touched(&a, 1000, "Bash", Vec::new());
        let command = "cat >> f.txt <<EOF\nfrom heredoc\nEOF";
        let transcript = Transcript::default()
            .prompt(1001, "append it")
            .say(1001, "Appending with a heredoc.")
            .call(1002, "toolu_b", "Bash", serde_json::json!({ "command": command }));

        let out = fx.resolve(
            &[session(&a, "claude", 0)],
            vec![(a.clone(), Source::Claude(transcript))],
            &[Span { start: 2, count: 1 }],
        );

        match &out[0][0].claim {
            Claim::Shell { turn, calls } => {
                assert_eq!(turn.session.id, a);
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].input["command"], command);
                assert_eq!(calls[0].reply.as_deref(), Some("Appending with a heredoc."));
            }
            other => panic!("expected a shell claim, got {other:?}"),
        }
    }

    #[test]
    fn a_heredoc_while_another_session_ran_a_shell_names_neither() {
        let mut fx = Fixture::new("one\n");
        let a = fx.session("a");
        let b = fx.session("b");
        fx.snapshot(&a, 1000);
        fx.snapshot(&b, 1001);
        fx.write("one\nfrom somewhere\n");
        fx.touched(&a, 1000, "Bash", Vec::new());
        fx.touched(&b, 1001, "Bash", Vec::new());
        let ta = Transcript::default().prompt(1000, "append").call(
            1002,
            "toolu_a",
            "Bash",
            serde_json::json!({ "command": "echo x >> f.txt" }),
        );
        let tb = Transcript::default().prompt(1001, "look around").call(
            1003,
            "toolu_b",
            "Bash",
            serde_json::json!({ "command": "ls" }),
        );

        let out = fx.resolve(
            &[session(&a, "claude", 0), session(&b, "claude", 0)],
            vec![(a.clone(), Source::Claude(ta)), (b.clone(), Source::Claude(tb))],
            &[Span { start: 2, count: 1 }],
        );

        match &out[0][0].claim {
            Claim::None { reason, sessions } => {
                assert_eq!(*reason, NoneReason::Overlapping);
                let ids: Vec<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
                assert_eq!(ids, vec![a.as_str(), b.as_str()]);
            }
            other => panic!("expected no claim, got {other:?}"),
        }
    }

    #[test]
    fn a_session_tori_ran_but_cannot_read_is_named_as_unrecorded() {
        // A PTY session: checkpointed at its prompt, no touched record, and
        // here no transcript Tori can match either.
        let mut fx = Fixture::new("one\n");
        let p = fx.session("pty");
        fx.snapshot(&p, 1000);
        fx.write("one\ntwo\n");

        let out = fx.resolve(&[session(&p, "claude", 0)], Vec::new(), &[Span { start: 2, count: 1 }]);

        assert_eq!(
            out[0][0].claim,
            Claim::None {
                reason: NoneReason::Unrecorded,
                sessions: vec![SessionLabel {
                    id: p.clone(),
                    agent: "claude".into(),
                    title: format!("{p} title"),
                    cwd: String::new(),
                    profile: None,
                }],
            }
        );
    }

    #[test]
    fn a_deletion_only_hunk_names_the_turn_that_removed_the_lines() {
        let mut fx = Fixture::new("one\ntwo\nthree\n");
        let a = fx.session("a");
        let abs = fx.abs();
        fx.snapshot(&a, 1000);
        fx.write("one\nthree\n");
        fx.touched(&a, 1000, "Edit", vec![abs.clone()]);
        let transcript = Transcript::default().prompt(1000, "drop two").call(
            1001,
            "toolu_d",
            "Edit",
            serde_json::json!({ "file_path": abs, "old_string": "two\n", "new_string": "" }),
        );

        let out = fx.resolve(
            &[session(&a, "claude", 0)],
            vec![(a.clone(), Source::Claude(transcript))],
            &[Span { start: 1, count: 0 }],
        );

        assert_eq!((out[0][0].start, out[0][0].count), (1, 0));
        assert_eq!(call_of(&out[0][0].claim).1.tool_use_id, "toolu_d");
    }

    #[test]
    fn an_acp_log_is_matched_by_rank_and_read_for_its_call_and_its_shell() {
        let mut fx = Fixture::new("one\n");
        let s = fx.session("acp");
        let abs = fx.abs();
        fx.snapshot(&s, 1000);
        fx.write("one\ntwo\n");
        fx.touched(&s, 1000, "edit", vec![abs.clone()]);
        fx.snapshot(&s, 2000);
        fx.write("one\ntwo\nthree\n");
        fx.touched(&s, 2000, "execute", Vec::new());
        let ev = |v: Value| v;
        let log = vec![
            ev(
                serde_json::json!({ "type": "userMessage", "sessionId": s, "turnId": "turn-1", "blocks": [{ "type": "text", "text": "add two" }] }),
            ),
            ev(serde_json::json!({ "type": "textDelta", "sessionId": s, "turnId": "turn-1", "text": "Adding " })),
            ev(serde_json::json!({ "type": "textDelta", "sessionId": s, "turnId": "turn-1", "text": "two." })),
            ev(
                serde_json::json!({ "type": "toolCallStarted", "sessionId": s, "turnId": "turn-1", "toolUseId": "call_1", "name": "edit", "kind": "edit", "input": {} }),
            ),
            ev(
                serde_json::json!({ "type": "fileEdit", "sessionId": s, "turnId": "turn-1", "toolUseId": "call_1", "path": abs, "kind": "modified" }),
            ),
            ev(
                serde_json::json!({ "type": "toolCallCompleted", "sessionId": s, "turnId": "turn-1", "toolUseId": "call_1", "status": "ok", "files": [abs] }),
            ),
            ev(
                serde_json::json!({ "type": "userMessage", "sessionId": s, "turnId": "turn-2", "blocks": [{ "type": "text", "text": "add three" }] }),
            ),
            ev(
                serde_json::json!({ "type": "toolCallStarted", "sessionId": s, "turnId": "turn-2", "toolUseId": "call_2", "name": "execute", "kind": "execute", "input": { "command": "echo three >> f.txt" } }),
            ),
            ev(
                serde_json::json!({ "type": "toolCallCompleted", "sessionId": s, "turnId": "turn-2", "toolUseId": "call_2", "status": "ok" }),
            ),
        ];

        let out = fx.resolve(
            &[session(&s, "codex", 0)],
            vec![(s.clone(), Source::Log(log))],
            &[Span { start: 2, count: 2 }],
        );

        let (turn, call) = call_of(&out[0][0].claim);
        assert_eq!(call.tool_use_id, "call_1");
        assert_eq!(call.reply.as_deref(), Some("Adding two."));
        assert_eq!(turn.prompt.as_deref(), Some("add two"));
        match &out[0][1].claim {
            Claim::Shell { calls, .. } => assert_eq!(calls[0].input["command"], "echo three >> f.txt"),
            other => panic!("expected a shell claim, got {other:?}"),
        }
    }
}
