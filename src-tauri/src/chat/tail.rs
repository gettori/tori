//! The bounded tail a chat opens with, because folding a whole long history on
//! the webview's main thread stalls the open. The cut is a [`HistoryCursor`],
//! never an index: a growing transcript and late placed subagents move indices.

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
        summary: summarize(&events[..start]),
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

fn summarize(events: &[ChatEvent]) -> HistorySummary {
    let mut s = HistorySummary::default();
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
                for b in blocks {
                    if let ContentBlock::FileRef { label: Some(label), .. } = b {
                        s.labels.push(label.clone());
                    }
                }
            }
            ChatEvent::SubagentStarted { .. } | ChatEvent::SubagentCall { .. } | ChatEvent::SubagentUpdate { .. } => {
                s.lane_events.push(ev.clone());
            }
            _ => {}
        }
    }
    s
}

fn cursor_at(prompts: &[(u64, usize)], at: usize) -> HistoryCursor {
    match prompts.iter().rev().find(|&&(_, start)| start <= at) {
        Some(&(ts, start)) => HistoryCursor { prompt_ts: Some(ts), offset: at - start },
        None => HistoryCursor { prompt_ts: None, offset: at },
    }
}

/// The index a cursor names in a fresh parse, or `None` when its prompt is gone.
#[allow(dead_code)] // the paging command is not wired yet
pub fn resolve(cursor: &HistoryCursor, prompts: &[(u64, usize)]) -> Option<usize> {
    match cursor.prompt_ts {
        None => Some(cursor.offset),
        Some(ts) => prompts.iter().find(|&&(t, _)| t == ts).map(|&(_, start)| start + cursor.offset),
    }
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
        for t in 0..24 {
            prompts.push((1000 + t as u64, events.len()));
            let label = match t {
                2 => Some("[Image 1]"),
                5 => Some("[File 2]"),
                _ => None,
            };
            events.push(user(t, label));
            if t == 3 || t == 9 || t == 20 {
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
                    "type": "subagentUpdate", "sessionId": "s", "agentId": "a1", "status": "completed",
                    "summary": "looked",
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

    /// The webview folds `full` and `summary` plus `events` and compares them
    /// (`historyTail.test.ts`), so the two sides are checked against one file.
    /// `TORI_BLESS=1` rewrites it.
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
            let lines: Vec<String> = events.iter().map(|e| format!("    {}", serde_json::to_string(e).unwrap())).collect();
            fresh += &format!(
                "{}{{\"name\":{:?},\"start\":{start},\"cursor\":{},\"summary\":{},\"full\":[\n{}\n]}}",
                if i == 0 { "" } else { ",\n" },
                name,
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
