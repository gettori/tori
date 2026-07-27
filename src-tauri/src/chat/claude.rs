//! Mapping `claude` stream-json frames onto the normalized [`ChatEvent`] model.
//!
//! This is the only module in the tree that knows what Claude's wire format
//! looks like. Everything it does is derived from the captured corpus in
//! `dev/fixtures/claude/`, which `dev/protocol-probe.mjs` re-verifies against
//! the installed CLI; if the format moves, that script fails before this file
//! starts producing nonsense.
//!
//! The mapper is a small **state machine**, not a pure per-frame function,
//! because three measured properties of the stream make a stateless mapping
//! impossible:
//!
//!   1. **`system/init` re-emits on every turn.** It is not a session-open
//!      frame. The first one opens the session; every later one starts a turn
//!      and reports the model and permission mode currently in force, which is
//!      exactly how a mid-session model or mode switch is *confirmed* rather
//!      than assumed. Treating each as a session start would reset the
//!      transcript on every turn.
//!   2. **Deltas do not name their content block's type.** A
//!      `content_block_delta` carries `index` and a delta kind; whether index 0
//!      is thinking or text was established by the `content_block_start` that
//!      opened it, so the mapper tracks open blocks per index.
//!   3. **A turn has no id on the wire.** Turn ids are synthesized here and
//!      carried on every event so the UI can group a turn's text, tool calls
//!      and usage without re-deriving boundaries.

use std::collections::HashMap;

use serde_json::Value;

use super::model::{
    ChatEvent, Extra, McpServer, PermissionDenial, PermissionMode, SlashCommand, ToolStatus, TurnOutcome, Usage,
};

/// What kind of content an open block at a given index holds. Recorded at
/// `content_block_start` so the deltas that follow can be routed.
#[derive(Debug, Clone, PartialEq)]
enum OpenBlock {
    Text,
    Thinking,
    ToolUse { tool_use_id: String, name: String },
    /// A block type we do not render specially. Its deltas are dropped rather
    /// than guessed at.
    Other,
}

/// Per-session mapping state. One of these lives alongside each child process.
#[derive(Debug, Default)]
pub struct ClaudeMapper {
    session_id: String,
    /// False until the first `system/init`, which is what makes the second and
    /// later ones turn starts instead of session starts.
    session_open: bool,
    /// Incrementing turn counter; `turn_id` is derived from it.
    turn_seq: u64,
    /// Whether a turn is currently open, so a `result` can be attributed and a
    /// stray frame outside a turn does not invent one.
    turn_open: bool,
    open_blocks: HashMap<u64, OpenBlock>,
    /// The rich slash-command catalogue from the `initialize` control response,
    /// held until the first `system/init` can carry it into `SessionStarted`.
    /// `system/init` itself reports only bare names.
    command_catalogue: Vec<SlashCommand>,
    /// Tool inputs accumulated from `input_json_delta`, keyed by block index.
    partial_tool_input: HashMap<u64, String>,
}

impl ClaudeMapper {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            ..Default::default()
        }
    }

    fn turn_id(&self) -> String {
        format!("turn-{}", self.turn_seq)
    }

    /// Absorb the `initialize` control response, whose catalogue is the only
    /// place command descriptions and argument hints exist.
    pub fn absorb_control_response(&mut self, frame: &Value) {
        let inner = &frame["response"]["response"];
        let Some(commands) = inner["commands"].as_array() else {
            return;
        };
        self.command_catalogue = commands
            .iter()
            .filter_map(|c| {
                Some(SlashCommand {
                    name: c["name"].as_str()?.to_string(),
                    description: c["description"].as_str().unwrap_or_default().to_string(),
                    argument_hint: c["argumentHint"].as_str().map(str::to_string),
                    aliases: c["aliases"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                })
            })
            .collect();
    }

    /// Map one stream-json frame to zero or more `ChatEvent`s.
    ///
    /// Zero is a normal and common answer: most frames are either redundant
    /// with a frame we already mapped (the non-streaming `assistant` message
    /// repeats content already sent as deltas) or carry nothing the UI needs.
    /// Guessing an event for such a frame would duplicate content in the
    /// transcript, which is worse than dropping it.
    pub fn map(&mut self, frame: &Value) -> Vec<ChatEvent> {
        match frame["type"].as_str() {
            Some("system") => self.map_system(frame),
            Some("stream_event") => self.map_stream_event(frame),
            Some("user") => self.map_user(frame),
            Some("assistant") => Vec::new(), // Already delivered as deltas; see above.
            Some("rate_limit_event") => self.map_rate_limit(frame),
            Some("result") => self.map_result(frame),
            Some("control_response") => {
                self.absorb_control_response(frame);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn map_system(&mut self, frame: &Value) -> Vec<ChatEvent> {
        match frame["subtype"].as_str() {
            Some("init") => self.map_init(frame),
            _ => Vec::new(),
        }
    }

    fn map_init(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let model = frame["model"].as_str().unwrap_or_default().to_string();
        let mode = permission_mode(frame["permissionMode"].as_str());

        // The measured quirk this whole state machine exists for: the *first*
        // init opens the session, every later one starts a turn.
        if !self.session_open {
            self.session_open = true;
            let bare: Vec<String> = frame["slash_commands"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            // Prefer the control-response catalogue; fall back to bare names so
            // a session that skipped the handshake still gets a usable menu.
            let slash_commands = if self.command_catalogue.is_empty() {
                bare.into_iter()
                    .map(|name| SlashCommand {
                        name,
                        description: String::new(),
                        argument_hint: None,
                        aliases: Vec::new(),
                    })
                    .collect()
            } else {
                self.command_catalogue.clone()
            };

            let mut extra = Extra::new();
            for key in ["claude_code_version", "capabilities", "memory_paths", "skills", "agents", "plugins"] {
                if let Some(v) = frame.get(key) {
                    extra.insert(camel(key), v.clone());
                }
            }
            if let Some(v) = frame.get("fast_mode_state") {
                extra.insert("fastModeState".into(), v.clone());
            }
            if let Some(v) = frame.get("fast_mode_disabled_reason") {
                extra.insert("fastModeDisabledReason".into(), v.clone());
            }

            self.turn_seq = 1;
            self.turn_open = true;
            return vec![
                ChatEvent::SessionStarted {
                    session_id: self.session_id.clone(),
                    cwd: frame["cwd"].as_str().unwrap_or_default().to_string(),
                    model: model.clone(),
                    permission_mode: mode,
                    tools: frame["tools"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                    slash_commands,
                    mcp_servers: mcp_servers(&frame["mcp_servers"]),
                    extra,
                },
                ChatEvent::TurnStarted {
                    session_id: self.session_id.clone(),
                    turn_id: self.turn_id(),
                    model,
                    permission_mode: mode,
                    extra: Extra::new(),
                },
            ];
        }

        self.turn_seq += 1;
        self.turn_open = true;
        self.open_blocks.clear();
        self.partial_tool_input.clear();
        vec![ChatEvent::TurnStarted {
            session_id: self.session_id.clone(),
            turn_id: self.turn_id(),
            model,
            permission_mode: mode,
            extra: Extra::new(),
        }]
    }

    fn map_stream_event(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let ev = &frame["event"];
        let index = ev["index"].as_u64().unwrap_or(0);
        match ev["type"].as_str() {
            Some("content_block_start") => {
                let block = &ev["content_block"];
                let open = match block["type"].as_str() {
                    Some("text") => OpenBlock::Text,
                    Some("thinking") => OpenBlock::Thinking,
                    Some("tool_use") => OpenBlock::ToolUse {
                        tool_use_id: block["id"].as_str().unwrap_or_default().to_string(),
                        name: block["name"].as_str().unwrap_or_default().to_string(),
                    },
                    _ => OpenBlock::Other,
                };
                let started = match &open {
                    // A tool call is announced the moment its block opens, so a
                    // card can render before the arguments have finished
                    // streaming. The input starts empty and fills via
                    // ToolCallProgress.
                    OpenBlock::ToolUse { tool_use_id, name } => vec![ChatEvent::ToolCallStarted {
                        session_id: self.session_id.clone(),
                        turn_id: self.turn_id(),
                        tool_use_id: tool_use_id.clone(),
                        name: name.clone(),
                        input: Value::Object(Default::default()),
                    }],
                    _ => Vec::new(),
                };
                self.open_blocks.insert(index, open);
                started
            }

            Some("content_block_delta") => {
                let delta = &ev["delta"];
                // Route by the block this index opened with: the delta itself
                // never says whether it is text or thinking.
                match (self.open_blocks.get(&index), delta["type"].as_str()) {
                    (Some(OpenBlock::Text), Some("text_delta")) => vec![ChatEvent::TextDelta {
                        session_id: self.session_id.clone(),
                        turn_id: self.turn_id(),
                        text: delta["text"].as_str().unwrap_or_default().to_string(),
                    }],
                    (Some(OpenBlock::Thinking), Some("thinking_delta")) => vec![ChatEvent::ThinkingDelta {
                        session_id: self.session_id.clone(),
                        turn_id: self.turn_id(),
                        text: delta["thinking"].as_str().unwrap_or_default().to_string(),
                    }],
                    // The cryptographic signature of a thinking block is not
                    // content and must never reach the transcript.
                    (Some(OpenBlock::Thinking), Some("signature_delta")) => Vec::new(),
                    (Some(OpenBlock::ToolUse { tool_use_id, .. }), Some("input_json_delta")) => {
                        let chunk = delta["partial_json"].as_str().unwrap_or_default();
                        self.partial_tool_input.entry(index).or_default().push_str(chunk);
                        vec![ChatEvent::ToolCallProgress {
                            session_id: self.session_id.clone(),
                            turn_id: self.turn_id(),
                            tool_use_id: tool_use_id.clone(),
                            partial_input: chunk.to_string(),
                        }]
                    }
                    _ => Vec::new(),
                }
            }

            Some("content_block_stop") => {
                // A finished tool-use block is where the accumulated argument
                // JSON becomes parseable, so this is the first point a card can
                // show real input rather than a fragment.
                let finished = match self.open_blocks.get(&index) {
                    Some(OpenBlock::ToolUse { tool_use_id, name }) => {
                        let raw = self.partial_tool_input.get(&index).cloned().unwrap_or_default();
                        let input = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Object(Default::default()));
                        vec![ChatEvent::ToolCallStarted {
                            session_id: self.session_id.clone(),
                            turn_id: self.turn_id(),
                            tool_use_id: tool_use_id.clone(),
                            name: name.clone(),
                            input,
                        }]
                    }
                    _ => Vec::new(),
                };
                self.open_blocks.remove(&index);
                self.partial_tool_input.remove(&index);
                finished
            }

            Some("message_delta") => {
                let usage = usage_from(&ev["usage"]);
                if usage == Usage::default() {
                    return Vec::new();
                }
                vec![ChatEvent::Usage {
                    session_id: self.session_id.clone(),
                    turn_id: self.turn_id(),
                    usage,
                    extra: Extra::new(),
                }]
            }

            _ => Vec::new(),
        }
    }

    /// A `user` frame in this stream is not the human speaking; it is the tool
    /// results being fed back to the model.
    fn map_user(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let Some(content) = frame["message"]["content"].as_array() else {
            return Vec::new();
        };
        content
            .iter()
            .filter(|c| c["type"] == "tool_result")
            .map(|c| ChatEvent::ToolCallCompleted {
                session_id: self.session_id.clone(),
                turn_id: self.turn_id(),
                tool_use_id: c["tool_use_id"].as_str().unwrap_or_default().to_string(),
                // A blocked call and a call that ran and failed both arrive as
                // `is_error: true`; they are told apart at the session level by
                // whether the id shows up in `result.permission_denials`, so a
                // finer verdict is not available here.
                status: if c["is_error"].as_bool().unwrap_or(false) {
                    ToolStatus::Error
                } else {
                    ToolStatus::Ok
                },
                output: tool_result_text(&c["content"]),
                files: files_touched(&frame["tool_use_result"]),
                duration_ms: None,
            })
            .collect()
    }

    fn map_rate_limit(&mut self, frame: &Value) -> Vec<ChatEvent> {
        let info = &frame["rate_limit_info"];
        vec![ChatEvent::RateLimit {
            session_id: self.session_id.clone(),
            status: info["status"].as_str().unwrap_or_default().to_string(),
            resets_at: info["resetsAt"].as_u64(),
            limit_type: info["rateLimitType"].as_str().map(str::to_string),
        }]
    }

    fn map_result(&mut self, frame: &Value) -> Vec<ChatEvent> {
        if !self.turn_open {
            return Vec::new();
        }
        self.turn_open = false;
        // Unclosed blocks are expected here rather than exceptional: an
        // interrupted turn truncates the stream, so the CLI never sends the
        // closing frames. Clearing them is the mapper honouring the obligation
        // the protocol leaves to the consumer.
        self.open_blocks.clear();
        self.partial_tool_input.clear();

        let is_error = frame["is_error"].as_bool().unwrap_or(false);
        let subtype = frame["subtype"].as_str().unwrap_or_default();
        // An interrupt is delivered as a failure-shaped result. It is not a
        // failure: the user asked for it, and calling it one would make the
        // composer flush the very queue that stop was pressed to hold.
        let outcome = if !is_error {
            TurnOutcome::Completed
        } else if subtype == "error_during_execution" {
            TurnOutcome::Cancelled
        } else {
            TurnOutcome::Errored
        };

        let mut extra = Extra::new();
        for (key, name) in [
            ("ttft_ms", "ttftMs"),
            ("modelUsage", "modelUsage"),
            ("num_turns", "numTurns"),
            ("duration_ms", "durationMs"),
            ("terminal_reason", "terminalReason"),
        ] {
            if let Some(v) = frame.get(key) {
                extra.insert(name.to_string(), v.clone());
            }
        }

        vec![ChatEvent::TurnCompleted {
            session_id: self.session_id.clone(),
            turn_id: self.turn_id(),
            outcome,
            stop_reason: frame["stop_reason"]
                .as_str()
                .map(str::to_string)
                .or_else(|| Some(subtype.to_string()).filter(|s| !s.is_empty())),
            usage: usage_from(&frame["usage"]),
            cost_usd: frame["total_cost_usd"].as_f64(),
            permission_denials: denials(&frame["permission_denials"]),
            extra,
        }]
    }
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

fn permission_mode(raw: Option<&str>) -> PermissionMode {
    match raw {
        Some("acceptEdits") => PermissionMode::AcceptEdits,
        Some("plan") => PermissionMode::Plan,
        Some("bypassPermissions") => PermissionMode::BypassPermissions,
        _ => PermissionMode::Default,
    }
}

fn camel(snake: &str) -> String {
    let mut out = String::with_capacity(snake.len());
    let mut upper = false;
    for ch in snake.chars() {
        if ch == '_' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn mcp_servers(raw: &Value) -> Vec<McpServer> {
    raw.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    Some(McpServer {
                        name: s["name"].as_str()?.to_string(),
                        status: s["status"].as_str().unwrap_or("unknown").to_string(),
                        tool_count: s["toolCount"].as_u64().map(|n| n as u32),
                        error: s["error"].as_str().map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn usage_from(raw: &Value) -> Usage {
    Usage {
        input_tokens: raw["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: raw["output_tokens"].as_u64().unwrap_or(0),
        cache_read_tokens: raw["cache_read_input_tokens"].as_u64().unwrap_or(0),
        cache_write_tokens: raw["cache_creation_input_tokens"].as_u64().unwrap_or(0),
        thinking_tokens: raw["output_tokens_details"]["thinking_tokens"].as_u64().unwrap_or(0),
    }
}

fn denials(raw: &Value) -> Vec<PermissionDenial> {
    raw.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|d| {
                    Some(PermissionDenial {
                        tool_use_id: d["tool_use_id"].as_str()?.to_string(),
                        tool_name: d["tool_name"].as_str().unwrap_or_default().to_string(),
                        tool_input: d["tool_input"].clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A tool result's content is a bare string for most tools and a content-block
/// array for some, so both shapes are flattened to text.
fn tool_result_text(raw: &Value) -> Option<String> {
    if let Some(s) = raw.as_str() {
        return Some(s.to_string());
    }
    let parts: Vec<String> = raw
        .as_array()?
        .iter()
        .filter_map(|b| b["text"].as_str().map(str::to_string))
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// The paths a tool touched, read off `tool_use_result`.
///
/// This is the field per-turn attribution turns on: with several chats sharing
/// one working tree, a whole-tree snapshot cannot say which session wrote what,
/// and this can.
fn files_touched(raw: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for key in ["filePath", "file_path"] {
        for candidate in [raw[key].as_str(), raw["file"][key].as_str()] {
            let Some(p) = candidate else { continue };
            // Deliberately not `Vec::dedup`, which only collapses *adjacent*
            // duplicates: the same path legitimately arrives from more than one
            // of these keys and they are not guaranteed to land next to each
            // other. A duplicate here would double-count a file in per-turn
            // attribution.
            if !out.iter().any(|existing| existing == p) {
                out.push(p.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> Vec<Value> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev/fixtures/claude")
            .join(format!("{name}.jsonl"));
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("fixture line is json"))
            .collect()
    }

    fn run(name: &str) -> Vec<ChatEvent> {
        let mut m = ClaudeMapper::new("s1");
        fixture(name).iter().flat_map(|f| m.map(f)).collect()
    }

    fn count(events: &[ChatEvent], pred: impl Fn(&ChatEvent) -> bool) -> usize {
        events.iter().filter(|e| pred(e)).count()
    }

    /// The measurement this whole state machine exists for.
    #[test]
    fn two_turns_produce_one_session_start_and_two_turn_starts() {
        let events = run("two-turns");
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::SessionStarted { .. })),
            1,
            "system/init re-emits per turn; only the first may open the session"
        );
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::TurnStarted { .. })),
            2
        );
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::TurnCompleted { .. })),
            2
        );
    }

    /// Turn ids must actually separate the turns, or grouping in the UI is
    /// meaningless even with the right counts.
    #[test]
    fn each_turn_gets_a_distinct_id() {
        let events = run("two-turns");
        let ids: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TurnStarted { turn_id, .. } => Some(turn_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec!["turn-1", "turn-2"]);

        // Text from the second turn must not be filed under the first.
        let second_turn_text = events.iter().any(|e| {
            matches!(e, ChatEvent::TextDelta { turn_id, .. } if turn_id == "turn-2")
        });
        assert!(second_turn_text, "no text was attributed to the second turn");
    }

    #[test]
    fn a_plain_turn_streams_text_and_completes() {
        let events = run("plain-turn");
        assert_eq!(count(&events, |e| matches!(e, ChatEvent::SessionStarted { .. })), 1);
        assert!(count(&events, |e| matches!(e, ChatEvent::TextDelta { .. })) > 0);
        let completed = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::TurnCompleted { outcome, .. } => Some(*outcome),
                _ => None,
            })
            .expect("a completed turn");
        assert_eq!(completed, TurnOutcome::Completed);
    }

    #[test]
    fn a_bash_call_becomes_a_tool_card_with_parsed_input() {
        let events = run("bash-call");
        let started: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::ToolCallStarted { name, input, tool_use_id, .. } => {
                    Some((name.clone(), input.clone(), tool_use_id.clone()))
                }
                _ => None,
            })
            .collect();
        assert!(!started.is_empty(), "no tool call was mapped");
        assert!(started.iter().any(|(n, ..)| n == "Bash"), "the Bash call is missing");
        // The block-stop re-emission is what carries the assembled arguments.
        let with_input = started.iter().find(|(n, i, _)| n == "Bash" && i["command"].is_string());
        assert!(with_input.is_some(), "the Bash call never got its parsed input");

        let completed = events.iter().any(|e| matches!(e, ChatEvent::ToolCallCompleted { .. }));
        assert!(completed, "the tool result never became a completion");
    }

    /// The tool-card lifecycle has to line up by id or the UI shows a call that
    /// never finishes next to a result belonging to nothing.
    #[test]
    fn tool_completions_match_a_started_call_by_id() {
        for name in ["bash-call", "edit-call"] {
            let events = run(name);
            let started: Vec<String> = events
                .iter()
                .filter_map(|e| match e {
                    ChatEvent::ToolCallStarted { tool_use_id, .. } => Some(tool_use_id.clone()),
                    _ => None,
                })
                .collect();
            for e in &events {
                if let ChatEvent::ToolCallCompleted { tool_use_id, .. } = e {
                    assert!(
                        started.contains(tool_use_id),
                        "{name}: completion for {tool_use_id} with no matching start"
                    );
                }
            }
        }
    }

    /// An edit is what per-turn attribution needs a path from.
    #[test]
    fn an_edit_reports_the_file_it_touched() {
        let events = run("edit-call");
        let files: Vec<&String> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::ToolCallCompleted { files, .. } => files.first(),
                _ => None,
            })
            .collect();
        assert!(!files.is_empty(), "no tool completion reported a touched file");
        assert!(
            files.iter().any(|f| f.contains("probe.txt")),
            "the edited file never appeared in a completion: {files:?}"
        );
    }

    /// The distinction the composer queue depends on: a cancelled turn is not
    /// an error, and flushing on it would send exactly what stop prevented.
    #[test]
    fn an_interrupted_turn_is_cancelled_not_errored() {
        let events = run("interrupt");
        let outcomes: Vec<TurnOutcome> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TurnCompleted { outcome, .. } => Some(*outcome),
                _ => None,
            })
            .collect();
        assert_eq!(
            outcomes,
            vec![TurnOutcome::Cancelled, TurnOutcome::Completed],
            "the interrupted turn must read as cancelled and the next one as a clean completion"
        );
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::SessionStarted { .. })),
            1,
            "an interrupt must not restart the session"
        );
    }

    #[test]
    fn a_hook_denial_is_carried_on_the_completed_turn() {
        let events = run("hook-denied");
        let denials = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::TurnCompleted { permission_denials, .. } if !permission_denials.is_empty() => {
                    Some(permission_denials.clone())
                }
                _ => None,
            })
            .expect("the denial never reached a completed turn");
        assert_eq!(denials[0].tool_name, "Bash");

        // The reason is not on the denial record; it reaches the model as the
        // tool result, so that is where the UI must read it from.
        let errored = events.iter().any(|e| {
            matches!(e, ChatEvent::ToolCallCompleted { status, output, .. }
                if *status == ToolStatus::Error
                    && output.as_deref().is_some_and(|o| o.contains("denied by fixture hook")))
        });
        assert!(errored, "the denial reason never surfaced on the tool card");
    }

    /// Thinking is rendered separately from the answer, and its signature must
    /// never leak into either.
    #[test]
    fn thinking_is_separated_and_its_signature_dropped() {
        let mut m = ClaudeMapper::new("s1");
        m.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": [], "mcp_servers": []
        }));
        m.map(&serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_start", "index": 0, "content_block": { "type": "thinking" } }
        }));
        let thought = m.map(&serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "hmm" } }
        }));
        assert!(matches!(thought.as_slice(), [ChatEvent::ThinkingDelta { text, .. }] if text == "hmm"));

        let sig = m.map(&serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "SECRET" } }
        }));
        assert!(sig.is_empty(), "a thinking signature must never become an event");
    }

    /// Deltas name only their index, so a mapper that ignored which block that
    /// index opened would file thinking as answer text and vice versa.
    #[test]
    fn deltas_route_by_the_block_their_index_opened() {
        let mut m = ClaudeMapper::new("s1");
        m.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": [], "mcp_servers": []
        }));
        // index 0 = thinking, index 1 = text, interleaved on purpose.
        for (index, ty) in [(0u64, "thinking"), (1, "text")] {
            m.map(&serde_json::json!({
                "type": "stream_event",
                "event": { "type": "content_block_start", "index": index, "content_block": { "type": ty } }
            }));
        }
        let a = m.map(&serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "answer" } }
        }));
        let b = m.map(&serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "reasoning" } }
        }));
        assert!(matches!(a.as_slice(), [ChatEvent::TextDelta { text, .. }] if text == "answer"));
        assert!(matches!(b.as_slice(), [ChatEvent::ThinkingDelta { text, .. }] if text == "reasoning"));
    }

    /// Every fixture must map without panicking and without inventing a second
    /// session, which is the cheapest guard against a future CLI change turning
    /// into a crash in the transport thread.
    #[test]
    fn every_fixture_maps_cleanly() {
        for name in [
            "plain-turn",
            "two-turns",
            "bash-call",
            "edit-call",
            "interrupt",
            "hook-denied",
            "image-turn",
        ] {
            let events = run(name);
            assert!(!events.is_empty(), "{name} produced no events");
            assert_eq!(
                count(&events, |e| matches!(e, ChatEvent::SessionStarted { .. })),
                1,
                "{name} opened more than one session"
            );
            for e in &events {
                assert!(
                    !matches!(e, ChatEvent::SessionError { .. }),
                    "{name} produced a SessionError from a healthy fixture: {e:?}"
                );
            }
        }
    }

    /// The rich catalogue exists only in the control response; `system/init`
    /// has bare names. A session that never handshakes must still get a menu.
    #[test]
    fn the_command_catalogue_comes_from_the_control_response() {
        let control = &fixture("initialize")[0];

        let mut with = ClaudeMapper::new("s1");
        with.map(control);
        let events = with.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": ["review"], "mcp_servers": []
        }));
        let described = match &events[0] {
            ChatEvent::SessionStarted { slash_commands, .. } => slash_commands.clone(),
            other => panic!("expected SessionStarted, got {other:?}"),
        };
        assert!(described.len() > 1, "the catalogue was not absorbed");
        assert!(
            described.iter().any(|c| !c.description.is_empty()),
            "the catalogue carried no descriptions"
        );

        let mut without = ClaudeMapper::new("s1");
        let events = without.map(&serde_json::json!({
            "type": "system", "subtype": "init", "model": "m", "permissionMode": "default",
            "cwd": "/w", "tools": [], "slash_commands": ["review"], "mcp_servers": []
        }));
        let fallback = match &events[0] {
            ChatEvent::SessionStarted { slash_commands, .. } => slash_commands.clone(),
            other => panic!("expected SessionStarted, got {other:?}"),
        };
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].name, "review");
    }

    #[test]
    fn permission_mode_round_trips_from_the_wire_spelling() {
        assert_eq!(permission_mode(Some("bypassPermissions")), PermissionMode::BypassPermissions);
        assert_eq!(permission_mode(Some("acceptEdits")), PermissionMode::AcceptEdits);
        assert_eq!(permission_mode(Some("plan")), PermissionMode::Plan);
        assert_eq!(permission_mode(Some("default")), PermissionMode::Default);
        // An unknown mode must fall back to the strictest, never be guessed at.
        assert_eq!(permission_mode(Some("newModeInV3")), PermissionMode::Default);
        assert_eq!(permission_mode(None), PermissionMode::Default);
    }
}
