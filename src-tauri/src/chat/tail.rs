//! The bounded tail a chat opens with, because folding a whole long history on
//! the webview's main thread stalls the open. The cut is a [`HistoryCursor`],
//! never an index: a growing transcript and late placed subagents move indices.

use std::collections::{BTreeSet, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::model::{cap_output, ChatEvent, ContentBlock};

/// Rows the tail aims for.
pub const TAIL_ROWS: usize = 75;
/// Rows the tail never drops below when the history has them. The panel's own
/// window (`WINDOW_STEP` in `chatStore.ts`), so an open never shows less than
/// it would have with the whole history loaded.
pub const TAIL_FLOOR: usize = 60;
/// Serialized bytes past which the tail stops growing, once it holds the floor.
pub const TAIL_BYTES: usize = 1 << 20;

/// Where a page starts: the prompt whose turn it falls in, by its transcript
/// timestamp, and how many events into that turn. `None` for events before the
/// first prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCursor {
    pub prompt_ts: Option<u64>,
    pub offset: usize,
}

/// What the events before the cut leave behind in the panel's state.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub compactions: u32,
    pub compaction_reclaimed: u64,
    /// The last compaction's measured size, which is what the context reads
    /// until a later response reports its own.
    pub context_tokens: Option<u64>,
    pub labels: Vec<String>,
    /// The subagent frames, which make no rows and are folded as they are.
    pub lane_events: Vec<ChatEvent>,
    /// What the panel counts off its rows, for the rows not sent. A call the
    /// tail also touches is the tail's to count.
    pub prompts: u32,
    pub tool_calls: u32,
    /// Main agent `AskUserQuestion` calls, kept apart because the panel draws
    /// them as question rows or tool cards depending on a setting.
    pub ask_calls: u32,
    pub touched: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTail {
    pub summary: HistorySummary,
    pub events: Vec<ChatEvent>,
    /// `None` when nothing is left before the tail.
    pub cursor: Option<HistoryCursor>,
}

impl HistoryTail {
    /// Everything as one tail: a history the reader cannot page.
    pub fn whole(events: Vec<ChatEvent>) -> Self {
        Self { summary: HistorySummary::default(), events, cursor: None }
    }
}

fn is_row(ev: &ChatEvent) -> bool {
    matches!(
        ev,
        ChatEvent::UserMessage { .. }
            | ChatEvent::TextDelta { .. }
            | ChatEvent::ThinkingDelta { .. }
            | ChatEvent::ToolCallStarted { .. }
            | ChatEvent::LocalCommand { .. }
            | ChatEvent::Compacted { .. }
    )
}

/// The tail of `events`, which ends at `end`. `prompts` is each prompt's
/// timestamp and the index of its turn's first event, oldest first.
pub fn tail_of(events: &[ChatEvent], prompts: &[(u64, usize)], end: usize) -> HistoryTail {
    let start = cut(&events[..end], prompts);
    HistoryTail {
        summary: summarize(&events[..start], &events[start..end]),
        events: events[start..end].to_vec(),
        cursor: (start > 0).then(|| cursor_at(prompts, start)),
    }
}

/// A turn boundary inside the budget wins only while it keeps the floor.
fn cut(events: &[ChatEvent], prompts: &[(u64, usize)]) -> usize {
    let total = events.iter().filter(|e| is_row(e)).count();
    let floor = TAIL_FLOOR.min(total);
    let mut rows = 0;
    let mut bytes = 0;
    let mut raw = 0;
    // Rows from each index to the end, for the boundary search below.
    let mut rows_from = vec![0; events.len() + 1];
    for i in (0..events.len()).rev() {
        bytes += wire_bytes(&events[i]);
        if is_row(&events[i]) {
            rows += 1;
        }
        rows_from[i] = rows;
        if is_row(&events[i]) && (rows >= TAIL_ROWS || (rows >= floor && bytes >= TAIL_BYTES)) {
            raw = i;
            break;
        }
    }
    if raw == 0 {
        return 0;
    }
    prompts
        .iter()
        .map(|&(_, at)| at)
        .find(|&at| at >= raw && at <= events.len() && rows_from[at] >= floor)
        .unwrap_or(raw)
}

/// Measured as it will cross: `cut_outputs` caps tool output after the cut, so
/// the raw output would spend the byte budget on text that never ships.
fn wire_bytes(ev: &ChatEvent) -> usize {
    let size = |e: &ChatEvent| serde_json::to_vec(e).map_or(0, |v| v.len());
    if let ChatEvent::ToolCallCompleted { output: Some(text), .. } = ev {
        if let Some(capped) = cap_output(text) {
            let mut ev = ev.clone();
            if let ChatEvent::ToolCallCompleted { output, .. } = &mut ev {
                *output = Some(capped);
            }
            return size(&ev);
        }
    }
    size(ev)
}

fn summarize(events: &[ChatEvent], tail: &[ChatEvent]) -> HistorySummary {
    let mut s = HistorySummary::default();
    let in_tail: HashSet<&str> = tail.iter().filter_map(tool_use_id).collect();
    let laned: HashSet<&str> = events
        .iter()
        .filter_map(|e| match e {
            ChatEvent::SubagentCall { tool_use_id, .. } => Some(tool_use_id.as_str()),
            _ => None,
        })
        .collect();
    let mut calls = HashSet::new();
    let mut asks = HashSet::new();
    let mut touched = BTreeSet::new();
    for ev in events {
        match ev {
            ChatEvent::Compacted { pre_tokens, post_tokens, .. } => {
                s.compactions += 1;
                if let Some(post) = post_tokens {
                    s.context_tokens = Some(*post);
                }
                if let (Some(pre), Some(post)) = (pre_tokens, post_tokens) {
                    s.compaction_reclaimed += pre.saturating_sub(*post);
                }
            }
            ChatEvent::UserMessage { blocks, .. } => {
                s.prompts += 1;
                for b in blocks {
                    if let ContentBlock::FileRef { label: Some(label), .. } = b {
                        s.labels.push(label.clone());
                    }
                }
            }
            ChatEvent::SubagentStarted { .. } | ChatEvent::SubagentCall { .. } | ChatEvent::SubagentUpdate { .. } => {
                s.lane_events.push(ev.clone());
            }
            ChatEvent::ToolCallCompleted { files, .. } => touched.extend(files.iter().cloned()),
            _ => {}
        }
        if let Some(id) = tool_use_id(ev) {
            if in_tail.contains(id) || laned.contains(id) {
                continue;
            }
            match ev {
                ChatEvent::ToolCallStarted { name, input, .. } if name == "AskUserQuestion" && asks_questions(input) => {
                    calls.remove(id);
                    asks.insert(id);
                }
                _ if !asks.contains(id) => {
                    calls.insert(id);
                }
                _ => {}
            }
        }
    }
    s.tool_calls = calls.len() as u32;
    s.ask_calls = asks.len() as u32;
    s.touched = touched.into_iter().collect();
    s
}

fn tool_use_id(ev: &ChatEvent) -> Option<&str> {
    match ev {
        ChatEvent::ToolCallStarted { tool_use_id, .. } | ChatEvent::ToolCallCompleted { tool_use_id, .. } => {
            Some(tool_use_id)
        }
        _ => None,
    }
}

/// The panel's `parseQuestions` test: an input it cannot read as questions is
/// drawn as an ordinary tool card instead.
fn asks_questions(input: &serde_json::Value) -> bool {
    let Some(questions) = input.get("questions").and_then(|q| q.as_array()) else { return false };
    !questions.is_empty()
        && questions.iter().all(|q| {
            q.get("question").is_some_and(|t| t.is_string())
                && q.get("options").and_then(|o| o.as_array()).is_some_and(|o| {
                    !o.is_empty() && o.iter().all(|o| o.get("label").is_some_and(|l| l.is_string()))
                })
        })
}

fn cursor_at(prompts: &[(u64, usize)], at: usize) -> HistoryCursor {
    match prompts.iter().rev().find(|&&(_, start)| start <= at) {
        Some(&(ts, start)) => HistoryCursor { prompt_ts: Some(ts), offset: at - start },
        None => HistoryCursor { prompt_ts: None, offset: at },
    }
}

/// The index a cursor names in a fresh parse, or `None` when its prompt is gone.
pub fn resolve(cursor: &HistoryCursor, prompts: &[(u64, usize)]) -> Option<usize> {
    match cursor.prompt_ts {
        None => Some(cursor.offset),
        Some(ts) => prompts.iter().find(|&&(t, _)| t == ts).map(|&(_, start)| start + cursor.offset),
    }
}

/// One page of older history, and where the page before it starts.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub events: Vec<ChatEvent>,
    pub cursor: Option<HistoryCursor>,
}

/// A whole parse, kept so paging back through a session reads its file once.
pub struct Parsed {
    pub events: Vec<ChatEvent>,
    pub prompts: Vec<(u64, usize)>,
}

/// The page that ends where `cursor` starts. `None` when the cursor's prompt is
/// no longer in the file.
pub fn page_before(parsed: &Parsed, cursor: &HistoryCursor) -> Option<HistoryPage> {
    let end = resolve(cursor, &parsed.prompts).filter(|&end| end <= parsed.events.len())?;
    let tail = tail_of(&parsed.events, &parsed.prompts, end);
    Some(HistoryPage { events: tail.events, cursor: tail.cursor })
}

/// What a cached parse was read from: the file's modification time and length,
/// either of which moves when claude appends a turn.
pub type Stamp = (SystemTime, u64);

/// The last few sessions paged through, most recent first. Bounded, because a
/// reload reattaches every chat tab and a parse per tab would hold every
/// history in memory again, just on this side.
pub struct PageCache {
    cap: usize,
    entries: VecDeque<(String, Stamp, Arc<Parsed>)>,
}

impl PageCache {
    pub const fn new(cap: usize) -> Self {
        Self { cap, entries: VecDeque::new() }
    }

    fn take(&mut self, key: &str, stamp: Stamp) -> Option<Arc<Parsed>> {
        let at = self.entries.iter().position(|(k, s, _)| k == key && *s == stamp)?;
        let entry = self.entries.remove(at)?;
        let parsed = entry.2.clone();
        self.entries.push_front(entry);
        Some(parsed)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    fn put(&mut self, key: &str, stamp: Stamp, parsed: Arc<Parsed>) {
        self.entries.retain(|(k, _, _)| k != key);
        self.entries.push_front((key.to_string(), stamp, parsed));
        self.entries.truncate(self.cap);
    }
}

/// The parse for `key` at `stamp`, from the cache or from `parse`. The parse
/// runs outside the lock, so one slow session does not hold up another's page.
pub fn cached(cache: &Mutex<PageCache>, key: &str, stamp: Stamp, parse: impl FnOnce() -> Parsed) -> Arc<Parsed> {
    if let Some(hit) = lock(cache).take(key, stamp) {
        return hit;
    }
    let parsed = Arc::new(parse());
    lock(cache).put(key, stamp, parsed.clone());
    parsed
}

fn lock(cache: &Mutex<PageCache>) -> std::sync::MutexGuard<'_, PageCache> {
    cache.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(turn: usize, label: Option<&str>) -> ChatEvent {
        let mut blocks = vec![ContentBlock::Text { text: format!("prompt {turn}") }];
        if let Some(l) = label {
            blocks.push(ContentBlock::FileRef {
                path: "/tmp/a.png".into(),
                start_line: None,
                end_line: None,
                text: None,
                label: Some(l.into()),
            });
        }
        ChatEvent::UserMessage { session_id: "s".into(), turn_id: format!("t{turn}"), blocks }
    }

    fn text(turn: usize, body: &str) -> ChatEvent {
        ChatEvent::TextDelta { session_id: "s".into(), turn_id: format!("t{turn}"), text: body.into(), agent_id: None }
    }

    fn history(turns: usize, replies: usize) -> (Vec<ChatEvent>, Vec<(u64, usize)>) {
        let mut events = Vec::new();
        let mut prompts = Vec::new();
        for t in 0..turns {
            prompts.push((1000 + t as u64, events.len()));
            events.push(user(t, None));
            for r in 0..replies {
                events.push(text(t, &format!("reply {r}")));
            }
        }
        (events, prompts)
    }

    fn rows(events: &[ChatEvent]) -> usize {
        events.iter().filter(|e| is_row(e)).count()
    }

    #[test]
    fn a_short_history_is_one_tail_with_nothing_before_it() {
        let (events, prompts) = history(5, 3);
        let tail = tail_of(&events, &prompts, events.len());
        assert_eq!(tail.events.len(), events.len());
        assert_eq!(tail.cursor, None);
        assert_eq!(tail.summary, HistorySummary::default());
    }

    #[test]
    fn a_long_history_cuts_at_the_first_turn_boundary_inside_the_budget() {
        // Ten rows a turn: the budget of 75 runs out mid turn, and the next
        // boundary up keeps 70 rows, above the floor.
        let (events, prompts) = history(100, 9);
        let tail = tail_of(&events, &prompts, events.len());
        assert_eq!(rows(&tail.events), 70);
        assert!(matches!(tail.events[0], ChatEvent::UserMessage { .. }));
        assert_eq!(tail.cursor, Some(HistoryCursor { prompt_ts: Some(1093), offset: 0 }));
    }

    #[test]
    fn a_boundary_that_would_drop_below_the_floor_is_passed_over() {
        // Forty rows a turn: the boundary inside the budget keeps only 40, so
        // the cut stays where the budget ran out.
        let (events, prompts) = history(10, 39);
        let tail = tail_of(&events, &prompts, events.len());
        assert_eq!(rows(&tail.events), TAIL_ROWS);
        assert!(matches!(tail.events[0], ChatEvent::TextDelta { .. }));
        let c = tail.cursor.expect("history remains before the tail");
        assert_eq!(c.prompt_ts, Some(1008));
        assert_eq!(c.offset, 5);
    }

    #[test]
    fn a_turn_bigger_than_the_budget_is_cut_at_a_row() {
        let (events, prompts) = history(2, 300);
        let tail = tail_of(&events, &prompts, events.len());
        assert_eq!(rows(&tail.events), TAIL_ROWS);
        assert_eq!(tail.cursor.and_then(|c| c.prompt_ts), Some(1001));
    }

    #[test]
    fn the_byte_cap_stops_the_tail_once_it_holds_the_floor() {
        // 32 KiB a row: 1 MiB is reached at 32 rows, under the floor, so the
        // floor wins and the cap stops it at exactly 60.
        let big = "x".repeat(32 * 1024);
        let mut events = Vec::new();
        for i in 0..200 {
            events.push(text(0, &format!("{big}{i}")));
        }
        let tail = tail_of(&events, &[], events.len());
        assert_eq!(rows(&tail.events), TAIL_FLOOR);
    }

    #[test]
    fn small_rows_ignore_the_byte_cap() {
        let (events, prompts) = history(1, 500);
        let tail = tail_of(&events, &prompts, events.len());
        assert_eq!(rows(&tail.events), TAIL_ROWS);
    }

    #[test]
    fn the_summary_carries_what_the_cut_history_leaves_behind() {
        let mut events = vec![
            user(0, Some("[Image 1]")),
            ChatEvent::Compacted {
                session_id: "s".into(),
                turn_id: "t0".into(),
                trigger: Some("auto".into()),
                pre_tokens: Some(150_000),
                post_tokens: Some(20_000),
                summary: None,
            },
            ChatEvent::SubagentStarted {
                session_id: "s".into(),
                agent_id: "a1".into(),
                tool_use_id: "call-1".into(),
                task_type: "local_agent".into(),
                agent_type: "general".into(),
                description: "look".into(),
                prompt: "look around".into(),
            },
        ];
        let mut prompts = vec![(1000, 0)];
        let (more, more_prompts) = history(20, 9);
        let offset = events.len();
        events.extend(more);
        prompts.extend(more_prompts.into_iter().map(|(ts, at)| (ts + 1, at + offset)));

        let tail = tail_of(&events, &prompts, events.len());
        assert_eq!(tail.summary.compactions, 1);
        assert_eq!(tail.summary.compaction_reclaimed, 130_000);
        assert_eq!(tail.summary.context_tokens, Some(20_000));
        assert_eq!(tail.summary.labels, vec!["[Image 1]".to_string()]);
        assert_eq!(tail.summary.lane_events.len(), 1);
    }

    fn from(v: serde_json::Value) -> ChatEvent {
        serde_json::from_value(v).expect("a valid event")
    }

    /// Attachments and a lane before the cut, compactions on both sides of it.
    fn rich_history() -> (Vec<ChatEvent>, Vec<(u64, usize)>) {
        let mut events = Vec::new();
        let mut prompts = Vec::new();
        for t in 0..40 {
            prompts.push((1000 + t as u64, events.len()));
            let label = match t {
                2 => Some("[Image 1]"),
                5 => Some("[File 2]"),
                _ => None,
            };
            events.push(user(t, label));
            if t == 3 || t == 9 || t == 20 || t == 36 {
                events.push(from(serde_json::json!({
                    "type": "compacted", "sessionId": "s", "turnId": format!("t{t}"),
                    "trigger": "auto", "preTokens": 150_000 + t, "postTokens": 20_000 + t,
                })));
            }
            if t == 4 {
                events.push(from(serde_json::json!({
                    "type": "toolCallStarted", "sessionId": "s", "turnId": "t4", "toolUseId": "agent-call",
                    "name": "Agent", "input": {"description": "look"},
                })));
                events.push(from(serde_json::json!({
                    "type": "subagentStarted", "sessionId": "s", "agentId": "a1", "toolUseId": "agent-call",
                    "taskType": "local_agent", "agentType": "general", "description": "look", "prompt": "look around",
                })));
                events.push(from(serde_json::json!({
                    "type": "subagentCall", "sessionId": "s", "agentId": "a1", "toolUseId": "inner-call",
                })));
                events.push(from(serde_json::json!({
                    "type": "toolCallStarted", "sessionId": "s", "turnId": "t4", "toolUseId": "inner-call",
                    "name": "Write", "input": {"path": "sub.txt"},
                })));
                events.push(from(serde_json::json!({
                    "type": "toolCallCompleted", "sessionId": "s", "turnId": "t4", "toolUseId": "inner-call",
                    "status": "ok", "output": "ok", "files": ["sub.txt"],
                })));
                events.push(from(serde_json::json!({
                    "type": "subagentUpdate", "sessionId": "s", "agentId": "a1", "status": "completed",
                    "summary": "looked",
                })));
            }
            if t == 6 || t == 30 {
                let id = format!("ask-{t}");
                events.push(from(serde_json::json!({
                    "type": "toolCallStarted", "sessionId": "s", "turnId": format!("t{t}"), "toolUseId": id,
                    "name": "AskUserQuestion",
                    "input": {"questions": [{"question": "Which?", "header": "Pick", "options": [{"label": "A"}, {"label": "B"}]}]},
                })));
                events.push(from(serde_json::json!({
                    "type": "toolCallCompleted", "sessionId": "s", "turnId": format!("t{t}"), "toolUseId": id,
                    "status": "ok", "output": "A",
                })));
            }
            for r in 0..3 {
                events.push(text(t, &format!("reply {r}")));
            }
            events.push(from(serde_json::json!({
                "type": "toolCallStarted", "sessionId": "s", "turnId": format!("t{t}"),
                "toolUseId": format!("call-{t}"), "name": "Read", "input": {"path": "a.rs"},
            })));
            events.push(from(serde_json::json!({
                "type": "toolCallCompleted", "sessionId": "s", "turnId": format!("t{t}"),
                "toolUseId": format!("call-{t}"), "status": "ok", "output": "fn a() {}",
                "files": [format!("src/f{}.rs", t % 7)],
            })));
        }
        (events, prompts)
    }

    /// One turn whose cut lands between a call and its completion, compacted
    /// before the cut and not after it.
    fn split_turn() -> (Vec<ChatEvent>, Vec<(u64, usize)>) {
        let mut events = vec![
            user(0, Some("[Image 1]")),
            from(serde_json::json!({
                "type": "compacted", "sessionId": "s", "turnId": "t0",
                "trigger": "manual", "preTokens": 90_000, "postTokens": 12_000,
            })),
        ];
        for i in 0..45 {
            events.push(from(serde_json::json!({
                "type": "toolCallStarted", "sessionId": "s", "turnId": "t0",
                "toolUseId": format!("call-{i}"), "name": "Read", "input": {"path": "a.rs"},
            })));
            events.push(text(0, &format!("reading {i}")));
            events.push(from(serde_json::json!({
                "type": "toolCallCompleted", "sessionId": "s", "turnId": "t0",
                "toolUseId": format!("call-{i}"), "status": "ok", "output": "fn a() {}",
            })));
        }
        (events, vec![(1000, 0)])
    }

    /// The webview folds `full`, and the tail with each page merged in front,
    /// and compares them (`historyTail.test.ts`), so the two sides are checked
    /// against one file. `TORI_BLESS=1` rewrites it.
    #[test]
    fn reproduces_the_tail_golden() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../src/panels/Chat/__fixtures__/historyTail.golden.json");
        // One event per line, so a change to the fold reads as a small diff.
        let mut fresh = String::from("[\n");
        for (i, (name, (events, prompts))) in [("rich", rich_history()), ("split", split_turn())].into_iter().enumerate() {
            let tail = tail_of(&events, &prompts, events.len());
            assert!(tail.cursor.is_some(), "{name} is long enough to cut");
            let start = events.len() - tail.events.len();
            assert_eq!(tail.events[..], events[start..]);
            // Each page as the range of `full` it covers, newest first.
            let all = Parsed { events: events.clone(), prompts: prompts.clone() };
            let mut pages = Vec::new();
            let (mut end, mut cursor) = (start, tail.cursor);
            while let Some(c) = cursor {
                let page = page_before(&all, &c).expect("the cursor resolves");
                pages.push(format!("[{},{end}]", end - page.events.len()));
                end -= page.events.len();
                cursor = page.cursor;
            }
            let lines: Vec<String> = events.iter().map(|e| format!("    {}", serde_json::to_string(e).unwrap())).collect();
            fresh += &format!(
                "{}{{\"name\":{:?},\"start\":{start},\"pages\":[{}],\"cursor\":{},\"summary\":{},\"full\":[\n{}\n]}}",
                if i == 0 { "" } else { ",\n" },
                name,
                pages.join(","),
                serde_json::to_string(&tail.cursor).unwrap(),
                serde_json::to_string(&tail.summary).unwrap(),
                lines.join(",\n"),
            );
        }
        fresh += "\n]\n";
        if std::env::var("TORI_BLESS").is_ok() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &fresh).unwrap();
        }
        let committed = std::fs::read_to_string(&path).expect("golden exists, run with TORI_BLESS=1");
        assert_eq!(committed, fresh, "golden is stale, run with TORI_BLESS=1");
    }

    #[test]
    fn the_split_turn_cuts_between_a_call_and_its_completion() {
        let (events, prompts) = split_turn();
        let tail = tail_of(&events, &prompts, events.len());
        let ChatEvent::TextDelta { .. } = &tail.events[0] else { panic!("cut at a text row") };
        assert!(matches!(tail.events[1], ChatEvent::ToolCallCompleted { .. }));
    }

    fn parsed(turns: usize) -> Parsed {
        let (events, prompts) = history(turns, 9);
        Parsed { events, prompts }
    }

    fn stamp(len: u64) -> Stamp {
        (SystemTime::UNIX_EPOCH, len)
    }

    #[test]
    fn paging_back_walks_to_the_first_prompt_with_nothing_twice() {
        let all = parsed(100);
        let open = tail_of(&all.events, &all.prompts, all.events.len());
        let mut seen = open.events.len();
        let mut cursor = open.cursor;
        let mut pages = 0;
        while let Some(c) = cursor {
            let page = page_before(&all, &c).expect("the cursor resolves");
            assert!(!page.events.is_empty());
            seen += page.events.len();
            cursor = page.cursor;
            pages += 1;
        }
        assert_eq!(seen, all.events.len());
        assert!(pages > 1);
    }

    #[test]
    fn a_page_still_lands_after_the_file_grows() {
        let before = parsed(100);
        let open = tail_of(&before.events, &before.prompts, before.events.len());
        let cursor = open.cursor.expect("history remains before the tail");
        let grown = parsed(110);
        let a = page_before(&before, &cursor).unwrap();
        let b = page_before(&grown, &cursor).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn a_second_page_reuses_the_parse() {
        let cache = Mutex::new(PageCache::new(3));
        let mut parses = 0;
        cached(&cache, "a", stamp(1), || { parses += 1; parsed(5) });
        cached(&cache, "a", stamp(1), || { parses += 1; parsed(5) });
        assert_eq!(parses, 1);
    }

    #[test]
    fn a_changed_file_is_parsed_again() {
        let cache = Mutex::new(PageCache::new(3));
        let mut parses = 0;
        cached(&cache, "a", stamp(1), || { parses += 1; parsed(5) });
        cached(&cache, "a", stamp(2), || { parses += 1; parsed(6) });
        assert_eq!(parses, 2);
        assert_eq!(cache.lock().unwrap().entries.len(), 1, "the stale parse is replaced, not kept beside");
    }

    #[test]
    fn a_fourth_session_evicts_the_least_recent() {
        let cache = Mutex::new(PageCache::new(3));
        for key in ["a", "b", "c"] {
            cached(&cache, key, stamp(1), || parsed(2));
        }
        cached(&cache, "a", stamp(1), || panic!("a is still cached"));
        cached(&cache, "d", stamp(1), || parsed(2));
        let keys: Vec<_> = cache.lock().unwrap().entries.iter().map(|(k, _, _)| k.clone()).collect();
        assert_eq!(keys, ["d", "a", "c"]);
    }

    #[test]
    fn a_cursor_still_resolves_after_a_turn_is_appended() {
        let (events, prompts) = history(100, 9);
        let tail = tail_of(&events, &prompts, events.len());
        let cursor = tail.cursor.expect("history remains before the tail");
        let at = events.len() - tail.events.len();

        let (grown, grown_prompts) = history(101, 9);
        assert_eq!(resolve(&cursor, &grown_prompts), Some(at));
        assert_eq!(grown[at], events[at]);
    }
}
