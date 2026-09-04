//! Replaying a session's transcript into the normalized [`ChatEvent`] model.
//!
//! **Why events rather than a second rendering path.** A chat tab already knows
//! how to fold `ChatEvent`s into a transcript; giving history its own shape
//! would mean two renderers that drift, and the one used less often would be the
//! one that rots. So the file on disk is mapped to the same events a live child
//! emits, and the panel cannot tell the difference beyond the flag it is handed.
//!
//! **Why it works for sessions Sway never ran.** `parse_transcript_turns` reads
//! the jsonl the agent itself writes, and a PTY agent tab, an outside
//! terminal, and a chat tab all write the same file. So a session started
//! anywhere backfills here without a second parser.
//!
//! **The one thing the transcript cannot give back is timing.** There are no
//! deltas on disk, only finished text, so a replayed turn arrives as one
//! `TextDelta` carrying the whole block rather than the hundreds a live turn
//! streams. The fold appends either way, so the result is identical; what is
//! lost is the typing, which is exactly the part nobody wants replayed.

use std::collections::{HashMap, HashSet};

use crate::sessions::{SubagentTranscript, TranscriptBlock, TranscriptTurn};

use super::claude::tool_kind;
use super::model::{ChatEvent, ContentBlock, ToolStatus};

/// Ids for replayed turns and calls are prefixed so they can never collide with
/// a live turn's (`turn-1`) or a real `tool_use_id` (`toolu_...`), which is what
/// keeps a backfilled card from being upserted by an unrelated live one.
const TURN_PREFIX: &str = "hist-turn-";
const TOOL_PREFIX: &str = "hist-tool-";

/// Map a whole transcript to the events that rebuild it, oldest first.
///
/// Turn grouping follows the file rather than being re-derived: each
/// `TranscriptTurn` is one turn, because that is the only boundary the
/// transcript actually records.
pub fn events_from_turns(
    session_id: &str,
    turns: &[TranscriptTurn],
    subagents: &[SubagentTranscript],
) -> Vec<ChatEvent> {
    let mut events = Vec::new();
    // Calls awaiting their result, oldest first. Claude records an id on both
    // halves so the match is exact; a transcript recording none falls back to
    // order - a result pairs with the oldest call still open, which is the
    // order a single-threaded agent produces them in.
    let mut open_calls: Vec<(String, String)> = Vec::new();
    let mut seq = 0usize;
    let by_call: HashMap<&str, &SubagentTranscript> =
        subagents.iter().map(|s| (s.tool_use_id.as_str(), s)).collect();
    let mut expanding = HashSet::new();

    for (at, turn) in turns.iter().enumerate() {
        seq += 1;
        let turn_id = format!("{TURN_PREFIX}{seq}");
        let mut user_blocks = Vec::new();

        // The summary of a compaction is the *user* turn straight after it, not
        // a field on the boundary. Rendering it as an ordinary user message
        // would put words in the user's mouth that the agent wrote, so it is
        // consumed here and attached to the compaction instead.
        if turns.get(at.wrapping_sub(1)).is_some_and(is_compaction) && turn.role == "user" && at > 0 {
            continue;
        }

        for block in &turn.blocks {
            match block.kind.as_str() {
                // An attachment was sent as a text block naming its path, so
                // that is how it comes back: the same labelled `FileRef` the
                // live turn carried, and ordinary prose otherwise.
                "text" if turn.role == "user" => {
                    if let Some(text) = &block.text {
                        user_blocks.push(ContentBlock::from_replayed_text(text));
                    }
                }
                // Without its bytes, which the transcript reader deliberately
                // did not keep. The turn says an image was there; only the live
                // turn that sent it can still draw it.
                "image" if turn.role == "user" => user_blocks.push(ContentBlock::ImageRef),
                "compaction" => {
                    events.push(ChatEvent::Compacted {
                        session_id: session_id.to_string(),
                        turn_id: turn_id.clone(),
                        trigger: block.compact_trigger.clone(),
                        pre_tokens: block.pre_tokens,
                        post_tokens: block.post_tokens,
                        summary: summary_after(turns, at),
                    });
                }
                // Two records carry one and a backgrounded subagent writes
                // both, so the later `<task-notification>` patches the
                // `async_launched` the `Agent` result left behind - the same
                // way `task_updated` patches `task_started` on the wire.
                "subagent" => {
                    if let Some(outcome) = &block.subagent {
                        events.push(ChatEvent::SubagentUpdate {
                            session_id: session_id.to_string(),
                            agent_id: outcome.agent_id.clone(),
                            status: Some(outcome.status.clone()),
                            activity: None,
                            last_tool_name: None,
                            usage: Some(outcome.usage),
                            summary: outcome.summary.clone(),
                        });
                    }
                }
                "text" | "thinking" | "tool_call" | "tool_result" => {
                    let opened = push_block(
                        &mut events,
                        session_id,
                        &turn_id,
                        None,
                        block,
                        &mut open_calls,
                        &mut seq,
                    );
                    // The lane this call opened, replayed inside the turn that
                    // launched it.
                    if let Some(sub) = opened.as_deref().and_then(|id| by_call.get(id)) {
                        expand_subagent(&mut events, session_id, &turn_id, sub, &by_call, &mut seq, &mut expanding);
                    }
                }
                _ => {}
            }
        }
        if !user_blocks.is_empty() {
            events.push(ChatEvent::UserMessage {
                session_id: session_id.to_string(),
                turn_id: turn_id.clone(),
                blocks: user_blocks,
            });
        }
    }

    events
}

/// The four block kinds a lane and the main conversation both produce, mapped in
/// one place so the two cannot drift. `agent_id` names the lane, `None` for the
/// main agent. Returns the call it opened, which is where a subagent hangs.
fn push_block(
    events: &mut Vec<ChatEvent>,
    session_id: &str,
    turn_id: &str,
    agent_id: Option<&str>,
    block: &TranscriptBlock,
    open_calls: &mut Vec<(String, String)>,
    seq: &mut usize,
) -> Option<String> {
    match block.kind.as_str() {
        "text" => {
            if let Some(text) = &block.text {
                events.push(ChatEvent::TextDelta {
                    session_id: session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    text: text.clone(),
                    agent_id: agent_id.map(str::to_string),
                });
            }
        }
        "thinking" => {
            if let Some(text) = &block.text {
                events.push(ChatEvent::ThinkingDelta {
                    session_id: session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    text: text.clone(),
                    agent_id: agent_id.map(str::to_string),
                });
            }
        }
        "tool_call" => {
            let tool_use_id = replay_id(block, seq);
            let name = block.tool_name.clone().unwrap_or_default();
            open_calls.push((tool_use_id.clone(), name.clone()));
            // Beside the call, never a field on it, matching how the live
            // mapper names a nested call's lane.
            if let Some(agent_id) = agent_id {
                events.push(ChatEvent::SubagentCall {
                    session_id: session_id.to_string(),
                    agent_id: agent_id.to_string(),
                    tool_use_id: tool_use_id.clone(),
                });
            }
            events.push(ChatEvent::ToolCallStarted {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
                tool_use_id: tool_use_id.clone(),
                kind: tool_kind(&name),
                name,
                input: block.tool_input.clone().unwrap_or(serde_json::Value::Null),
                // A transcript records neither, the same way it records
                // no written paths below.
                locations: Vec::new(),
                title: None,
            });
            return Some(tool_use_id);
        }
        "tool_result" => {
            let Some((tool_use_id, _)) = take_call(open_calls, block) else {
                // A result whose call is not in this transcript - a
                // resumed session whose earlier half lives in another
                // file, most often. Dropped rather than rendered as a
                // card with no call, which would read as a phantom tool
                // run that never happened.
                return None;
            };
            events.push(ChatEvent::ToolCallCompleted {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
                tool_use_id,
                status: if block.is_error == Some(true) { ToolStatus::Error } else { ToolStatus::Ok },
                // Whole, and cut by the host afterwards through the same
                // cache a live event goes through. Cutting here instead
                // would leave a replayed card offering to fetch a
                // remainder nothing kept.
                output: block.text.clone(),
                // Deliberately empty: the transcript records that a tool
                // ran, not which paths it wrote. Guessing from the input
                // would feed per-turn attribution a set nothing measured.
                files: Vec::new(),
                // Never recorded on disk, and a fabricated duration
                // would be indistinguishable from a real one.
                duration_ms: None,
                // Read by the scanner from the same
                // `summarise_result` the live adapter uses, so a
                // replayed card and a live one cannot disagree about
                // the same result.
                summary: block.tool_summary.clone(),
                output_truncated: false,
                // Read back off the same `toolUseResult` a live run
                // reads, so a replayed edit draws the same diff. It is
                // the only source that survives a reload: nothing
                // captures a before-state for a session this process
                // never watched run.
                patch: block.tool_patch.clone(),
            });
        }
        _ => {}
    }
    None
}

/// One subagent's whole conversation, replayed into the turn that launched it.
/// Its own message boundaries are not turns here: headers the live run never
/// made would offer "rewind to here" on a boundary nobody typed.
fn expand_subagent(
    events: &mut Vec<ChatEvent>,
    session_id: &str,
    turn_id: &str,
    sub: &SubagentTranscript,
    by_call: &HashMap<&str, &SubagentTranscript>,
    seq: &mut usize,
    expanding: &mut HashSet<String>,
) {
    // Nothing the CLI writes can make a cycle; a `meta.json` naming a call
    // inside its own transcript would otherwise recurse until the stack ran out.
    if !expanding.insert(sub.agent_id.clone()) {
        return;
    }
    // After the `Agent` card, so a lane launched by another subagent finds its
    // parent already named in `laneOfCall`.
    events.push(ChatEvent::SubagentStarted {
        session_id: session_id.to_string(),
        agent_id: sub.agent_id.clone(),
        tool_use_id: sub.tool_use_id.clone(),
        // Only a subagent writes a sidecar, so replay reaches here for no other
        // kind of task and does not have to read one off disk.
        task_type: crate::chat::claude::SUBAGENT_TASK.to_string(),
        agent_type: sub.agent_type.clone(),
        description: sub.description.clone(),
        prompt: sub.prompt.clone(),
    });
    // Its own, because a subagent's calls pair within its own file.
    let mut open_calls: Vec<(String, String)> = Vec::new();
    for turn in &sub.turns {
        for block in &turn.blocks {
            let opened =
                push_block(events, session_id, turn_id, Some(&sub.agent_id), block, &mut open_calls, seq);
            if let Some(nested) = opened.as_deref().and_then(|id| by_call.get(id)) {
                expand_subagent(events, session_id, turn_id, nested, by_call, seq, expanding);
            }
        }
    }
    expanding.remove(&sub.agent_id);
}

fn is_compaction(turn: &TranscriptTurn) -> bool {
    turn.blocks.iter().any(|b| b.kind == "compaction")
}

/// The summary the agent wrote for the compaction at `at`: the text of the
/// user turn immediately following it, with the framing around it removed.
/// `None` when the transcript ends at the boundary, which happens for a session
/// compacted and then closed.
fn summary_after(turns: &[TranscriptTurn], at: usize) -> Option<String> {
    let next = turns.get(at + 1)?;
    if next.role != "user" {
        return None;
    }
    let text = next
        .blocks
        .iter()
        .filter(|b| b.kind == "text")
        .filter_map(|b| b.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    let text = strip_continuation_framing(&text);
    (!text.is_empty()).then_some(text)
}

/// Openings and closings of the continuation *prompt* the agent wraps its
/// summary in. The summary itself is worth showing - it is the only record of
/// what the model still remembers across the boundary - but it arrives inside
/// instructions written to the model ("Resume directly", "do not acknowledge
/// the summary") and a path to a `.jsonl` on disk. That is one machine talking
/// to another, and rendering it in a conversation reads as though someone said
/// it.
///
/// Matched on the agent's own sentences rather than on structure, because
/// there is no structure: it is one prose blob. A wording we do not know stays
/// whole, which is the safe direction - a summary with its framing still on is
/// noisy, a summary cut in the wrong place has lost content.
const FRAMING_HEAD: &str = "This session is being continued from a previous conversation";
const FRAMING_TAILS: [&str; 3] = [
    "If you need specific details from before compaction",
    "Continue the conversation from where it left off",
    "Please continue the conversation from where we left it off",
];

fn strip_continuation_framing(text: &str) -> String {
    let mut body = text.trim();
    // Only when the preamble is actually there, and only up to the label it
    // ends with: a summary that opens differently keeps every word.
    if body.starts_with(FRAMING_HEAD) {
        if let Some(at) = body.find("Summary:") {
            body = body[at + "Summary:".len()..].trim_start();
        }
    }
    // The earliest closing wins: the instructions run to the end of the message,
    // so anything after the first one is more of the same.
    if let Some(at) = FRAMING_TAILS.iter().filter_map(|t| body.find(t)).min() {
        body = body[..at].trim_end();
    }
    body.trim().to_string()
}

/// How far back a rewind cuts the replay: the index of the turn carrying the
/// prompt a checkpoint was taken for, so `&turns[..at]` is everything before it.
///
/// **Snapped to the nearest human prompt rather than cut at `ts < prompt_ts`.**
/// A chat checkpoint is stamped with Sway's own clock at `turnStarted`
/// (`checkpoints.ts:71`) while the transcript is stamped with the agent's, so
/// one prompt carries two timestamps a second or two apart and a bare
/// comparison lands on either side of it depending on which way they drifted.
/// Snapping puts the cut on the boundary the user pointed at, and it can only
/// ever fall *between* turns rather than inside one - a replay severed
/// mid-turn would show a call with no result.
///
/// The summary the agent writes after a compaction is a `user` turn that the
/// user never typed, so it is not a boundary anyone can mean; `events_from_turns`
/// declines to render it as one for the same reason.
///
/// `None` when the transcript holds no prompt at all, which the caller reads as
/// "nothing to cut at" and replays whole rather than showing an empty session.
pub fn prompt_boundary(turns: &[TranscriptTurn], prompt_ts: u64) -> Option<usize> {
    turns
        .iter()
        .enumerate()
        .filter(|(at, t)| {
            t.role == "user" && !turns.get(at.wrapping_sub(1)).is_some_and(is_compaction)
        })
        .min_by_key(|(_, t)| t.ts.abs_diff(prompt_ts))
        .map(|(at, _)| at)
}

/// The id to replay a call under: the agent's own when the transcript has one,
/// otherwise a synthetic one that at least stays unique within this replay.
fn replay_id(block: &TranscriptBlock, seq: &mut usize) -> String {
    match &block.tool_use_id {
        Some(id) => id.clone(),
        None => {
            *seq += 1;
            format!("{TOOL_PREFIX}{seq}")
        }
    }
}

/// Pair a result with its call, by id when the transcript records one and by
/// arrival order when it does not.
fn take_call(open: &mut Vec<(String, String)>, block: &TranscriptBlock) -> Option<(String, String)> {
    if let Some(id) = &block.tool_use_id {
        let at = open.iter().position(|(open_id, _)| open_id == id)?;
        return Some(open.remove(at));
    }
    if open.is_empty() {
        return None;
    }
    Some(open.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{compaction_block, image_block, text_block, tool_call_block, tool_result_block};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn turn(role: &str, blocks: Vec<TranscriptBlock>) -> TranscriptTurn {
        TranscriptTurn { role: role.into(), ts: 0, blocks }
    }


    /// Captured stream frames, rewritten as the transcript records the CLI
    /// writes for the same run. Only two things actually change: the timestamp
    /// and cwd every record carries, and `tool_use_result` becoming
    /// `toolUseResult`. The content blocks are already identical, which is why
    /// one summariser can serve both.
    fn transcript_of(frames: &[serde_json::Value]) -> String {
        let mut out = String::new();
        for (i, frame) in frames.iter().enumerate() {
            let kind = frame["type"].as_str().unwrap_or_default();
            if kind != "assistant" && kind != "user" {
                continue;
            }
            let mut record = serde_json::json!({
                "type": kind,
                "cwd": "/p",
                "timestamp": format!("2026-08-24T10:00:{:02}.000Z", i % 60),
                "message": frame["message"].clone(),
            });
            if let Some(result) = frame.get("tool_use_result") {
                record["toolUseResult"] = result.clone();
            }
            out.push_str(&record.to_string());
            out.push('\n');
        }
        out
    }

    /// A replayed call and a live one report the same result.
    ///
    /// The two paths read different bytes for the same run: the live adapter
    /// reads the stream's `tool_use_result`, the replay reads the transcript's
    /// `toolUseResult` through the scanner, and until this phase only one of
    /// them read anything at all. So each fixture is pushed through both and
    /// the summaries compared per call. A divergence here is the failure a
    /// shared summariser exists to make impossible.
    ///
    /// The replay side goes through the **real scanner**, not through the block
    /// constructors: a test that summarised the payload itself and handed the
    /// answer to `events_from_turns` would be comparing `summarise_result` with
    /// `summarise_result` and would pass with the scanner reading nothing at
    /// all. So the captured frames are rewritten as the transcript records the
    /// CLI would have written for the same run, and parsed back.
    #[test]
    fn a_replayed_call_summarises_and_diffs_exactly_as_the_live_one_did() {
        use crate::chat::model::{PatchHunk, ToolSummary};
        use std::path::PathBuf;

        // One fixture per summary variant, plus the two shapes that must
        // summarise to nothing on both paths.
        let fixtures = [
            "bash-call",
            "read-call",
            "edit-call",
            "glob-call",
            "grep-modes",
            "webfetch-call",
            "hook-denied",
            "permission-subagent",
        ];
        let mut variants: Vec<&str> = Vec::new();

        for name in fixtures {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("dev/fixtures/claude")
                .join(format!("{name}.jsonl"));
            let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            let frames: Vec<serde_json::Value> = raw
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| serde_json::from_str(l).expect("fixture line is json"))
                .collect();

            // Live: the stream, through the adapter.
            let mut mapper = crate::chat::claude::ClaudeMapper::new("s1");
            let live: Vec<(Option<ToolSummary>, Vec<PatchHunk>)> = frames
                .iter()
                .flat_map(|f| mapper.map(f))
                .filter_map(|e| match e {
                    ChatEvent::ToolCallCompleted { summary, patch, .. } => Some((summary, patch)),
                    _ => None,
                })
                .collect();

            // Replayed: the same run, written as a transcript and read back
            // by the scanner that reads real ones.
            let dir = std::env::temp_dir().join(format!("sway-parity-{name}"));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            let transcript = dir.join("session.jsonl");
            std::fs::write(&transcript, transcript_of(&frames)).expect("write transcript");
            let turns = crate::sessions::transcript_turns(transcript.to_str().unwrap(), "claude");
            let replayed: Vec<(Option<ToolSummary>, Vec<PatchHunk>)> = events_from_turns("s1", &turns, &[])
                .into_iter()
                .filter_map(|e| match e {
                    ChatEvent::ToolCallCompleted { summary, patch, .. } => Some((summary, patch)),
                    _ => None,
                })
                .collect();
            std::fs::remove_dir_all(&dir).ok();

            assert!(!live.is_empty(), "{name}: no completed calls to compare");
            assert_eq!(live, replayed, "{name}: replay and live disagree");
            if name == "edit-call" {
                // The point of carrying the patch at all: a conversation
                // reopened from history has no captured before-state, so this
                // is the only diff its cards can draw.
                assert!(
                    replayed.iter().any(|(_, patch)| !patch.is_empty()),
                    "an edit replayed with no diff to draw"
                );
            }
            for summary in live.into_iter().filter_map(|(s, _)| s) {
                variants.push(match summary {
                    ToolSummary::Search { .. } => "search",
                    ToolSummary::Paths { .. } => "paths",
                    ToolSummary::Read { .. } => "read",
                    ToolSummary::Execute { .. } => "execute",
                    ToolSummary::Edit { .. } => "edit",
                    ToolSummary::Fetch { .. } => "fetch",
                });
            }
        }

        // The comparison is only worth as much as what it compared, so the
        // fixture list has to keep exercising every variant. This is also the
        // phase's own check that no variant is built by its sample list alone.
        variants.sort_unstable();
        variants.dedup();
        assert_eq!(
            variants,
            ["edit", "execute", "fetch", "paths", "read", "search"],
            "a summary variant is no longer produced by any fixture"
        );
    }

    fn kinds(events: &[ChatEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|e| match e {
                ChatEvent::UserMessage { .. } => "user",
                ChatEvent::TextDelta { .. } => "text",
                ChatEvent::ThinkingDelta { .. } => "thinking",
                ChatEvent::ToolCallStarted { .. } => "started",
                ChatEvent::ToolCallCompleted { .. } => "completed",
                _ => "other",
            })
            .collect()
    }

    #[test]
    fn a_replayed_image_keeps_its_place_in_the_prompt() {
        let turns = vec![
            turn("user", vec![image_block(), text_block("text", "what colour is this?".into())]),
            turn("user", vec![image_block()]),
        ];
        let blocks: Vec<Vec<ContentBlock>> = events_from_turns("s1", &turns, &[])
            .into_iter()
            .filter_map(|e| match e {
                ChatEvent::UserMessage { blocks, .. } => Some(blocks),
                _ => None,
            })
            .collect();

        // In front of the text, which is where it was sent.
        assert_eq!(
            blocks[0],
            vec![ContentBlock::ImageRef, ContentBlock::Text { text: "what colour is this?".into() }]
        );
        // An image-only prompt still replays as a prompt. It used to produce no
        // user message at all, so a reopened chat lost the question entirely.
        assert_eq!(blocks[1], vec![ContentBlock::ImageRef]);
    }

    /// One user turn's blocks, in the order they were sent.
    fn user_blocks_of(turns: &[TranscriptTurn]) -> Vec<Vec<ContentBlock>> {
        events_from_turns("s1", turns, &[])
            .into_iter()
            .filter_map(|e| match e {
                ChatEvent::UserMessage { blocks, .. } => Some(blocks),
                _ => None,
            })
            .collect()
    }

    /// The round trip the label exists for: what the composer sent, written by
    /// the transport, read back off the transcript, is the turn that was sent.
    #[test]
    fn a_labelled_attachment_replays_as_the_blocks_that_were_sent() {
        let sent = vec![
            ContentBlock::FileRef {
                path: "/Users/x/.config/sway/attachments/19af-0/shot.png".into(),
                start_line: None,
                end_line: None,
                text: None,
                label: Some("[Image 1]".into()),
            },
            ContentBlock::Text { text: "what colour is [Image 1]?".into() },
            // A name that merely looks ranged keeps every character it had,
            // and a real range comes back as a range rather than as a path
            // with `#L2-4` buried in it.
            ContentBlock::FileRef {
                path: "/Users/x/notes#Lx.md".into(),
                start_line: None,
                end_line: None,
                text: None,
                label: Some("[File 2]".into()),
            },
            ContentBlock::FileRef {
                path: "/Users/x/main.rs".into(),
                start_line: Some(2),
                end_line: Some(4),
                text: None,
                label: Some("[File 3]".into()),
            },
        ];
        let frame = crate::chat::claude_transport::turn_frame(&sent);
        let written: Vec<TranscriptBlock> = frame["message"]["content"]
            .as_array()
            .expect("a user frame carries content")
            .iter()
            .map(|b| text_block("text", b["text"].as_str().expect("a text block").to_string()))
            .collect();

        assert_eq!(user_blocks_of(&[turn("user", written)])[0], sent);
    }

    /// The composer spelled its kinds in lower case before it capitalised
    /// them. Those turns are on disk, and they still name an attachment.
    #[test]
    fn a_turn_written_before_the_labels_were_capitalised_still_replays() {
        let blocks = user_blocks_of(&[turn("user", vec![text_block("text", "[image 1]: @/x/shot.png".into())])]);
        assert_eq!(
            blocks[0],
            vec![ContentBlock::FileRef {
                path: "/x/shot.png".into(),
                start_line: None,
                end_line: None,
                text: None,
                // Verbatim, because that is what the sentence in that turn says.
                label: Some("[image 1]".into()),
            }]
        );
    }

    /// Only the form the transport writes. Everything else is what the user
    /// typed, and typing `[Image 1]` is not attaching one.
    #[test]
    fn a_turn_that_only_looks_labelled_stays_text() {
        let typed = [
            "[Image 1] is the red one",
            "[Image 1]: /Users/x/shot.png",
            "[Image 1]: @shot.png",
            "[video 1]: @/Users/x/clip.mp4",
            "[Image one]: @/Users/x/shot.png",
            "see [Image 1]: @/Users/x/shot.png",
        ];
        for text in typed {
            let blocks = user_blocks_of(&[turn("user", vec![text_block("text", text.into())])]);
            assert_eq!(blocks[0], vec![ContentBlock::Text { text: text.into() }], "{text}");
        }
    }

    #[test]
    fn a_conversation_replays_in_order_with_its_tool_calls_intact() {
        let turns = vec![
            turn("user", vec![text_block("text", "fix the bug".into())]),
            turn(
                "assistant",
                vec![
                    text_block("thinking", "considering".into()),
                    text_block("text", "on it".into()),
                    tool_call_block("Edit".into(), serde_json::json!({ "file_path": "/a" }), Some("toolu_1".into())),
                ],
            ),
            turn("user", vec![tool_result_block(None, "done".into(), false, Some("toolu_1".into()), None, Vec::new())]),
            turn("assistant", vec![text_block("text", "fixed".into())]),
        ];

        let events = events_from_turns("s1", &turns, &[]);
        assert_eq!(kinds(&events), ["user", "thinking", "text", "started", "completed", "text"]);
        // Every event carries the session, since a shared channel routes on it.
        assert!(events.iter().all(|e| matches!(e,
            ChatEvent::UserMessage { session_id, .. }
            | ChatEvent::TextDelta { session_id, .. }
            | ChatEvent::ThinkingDelta { session_id, .. }
            | ChatEvent::ToolCallStarted { session_id, .. }
            | ChatEvent::ToolCallCompleted { session_id, .. } if session_id == "s1")));
    }

    #[test]
    fn a_result_pairs_with_its_own_call_even_when_two_are_open() {
        // Two calls in one assistant turn, results arriving in the other order.
        // Position-based pairing would swap them; the ids do not.
        let turns = vec![
            turn(
                "assistant",
                vec![
                    tool_call_block("Read".into(), serde_json::json!({}), Some("toolu_a".into())),
                    tool_call_block("Bash".into(), serde_json::json!({}), Some("toolu_b".into())),
                ],
            ),
            turn(
                "user",
                vec![
                    tool_result_block(None, "b output".into(), false, Some("toolu_b".into()), None, Vec::new()),
                    tool_result_block(None, "a output".into(), true, Some("toolu_a".into()), None, Vec::new()),
                ],
            ),
        ];

        let events = events_from_turns("s1", &turns, &[]);
        let completed: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::ToolCallCompleted { tool_use_id, output, status, .. } => {
                    Some((tool_use_id.as_str(), output.clone().unwrap_or_default(), *status))
                }
                _ => None,
            })
            .collect();
        assert_eq!(completed[0], ("toolu_b", "b output".into(), ToolStatus::Ok));
        assert_eq!(completed[1], ("toolu_a", "a output".into(), ToolStatus::Error));
    }

    #[test]
    fn a_transcript_without_ids_pairs_by_order() {
        // A transcript recording no tool ids at all still has to pair up.
        let turns = vec![
            turn("assistant", vec![tool_call_block("Read".into(), serde_json::json!({}), None)]),
            turn("tool", vec![tool_result_block(Some("Read".into()), "out".into(), false, None, None, Vec::new())]),
        ];
        let events = events_from_turns("s1", &turns, &[]);
        let started = match &events[0] {
            ChatEvent::ToolCallStarted { tool_use_id, .. } => tool_use_id.clone(),
            other => panic!("expected a started call, got {other:?}"),
        };
        match &events[1] {
            ChatEvent::ToolCallCompleted { tool_use_id, .. } => assert_eq!(tool_use_id, &started),
            other => panic!("expected a completed call, got {other:?}"),
        }
    }

    #[test]
    fn a_result_whose_call_is_missing_is_dropped_rather_than_invented() {
        // The first half of a resumed conversation lives in another file.
        let turns = vec![turn(
            "user",
            vec![tool_result_block(None, "orphan".into(), false, Some("toolu_gone".into()), None, Vec::new())],
        )];
        assert!(events_from_turns("s1", &turns, &[]).is_empty());
    }

    #[test]
    fn replayed_ids_cannot_collide_with_a_live_turn() {
        let turns = vec![turn("user", vec![text_block("text", "hi".into())])];
        match &events_from_turns("s1", &turns, &[])[0] {
            ChatEvent::UserMessage { turn_id, .. } => {
                assert!(turn_id.starts_with(TURN_PREFIX));
                // A live turn is `turn-1`; a replayed one must never be.
                assert_ne!(turn_id, "turn-1");
            }
            other => panic!("expected a user message, got {other:?}"),
        }
    }

    /// The cross-surface case: nothing here came from a chat tab.
    ///
    /// This is the raw jsonl `claude` writes when it is run from a terminal (or
    /// from a PTY agent tab, which is the same binary in a shell). It goes
    /// through the agent's own parser and out as replay events, which is what
    /// makes "started in the terminal, continued in chat" work without a second
    /// reader for each surface.
    #[test]
    fn a_transcript_written_by_a_terminal_session_replays_the_same_way() {
        let dir = std::env::temp_dir().join(format!("sway-history-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("terminal-era.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","timestamp":"2026-07-28T10:00:00Z","message":{"role":"user","content":"the deploy key is DEPLOY-77"}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-07-28T10:00:01Z","message":{"content":[{"type":"text","text":"noted"},{"type":"tool_use","id":"toolu_x","name":"Read","input":{"file_path":"/etc/hosts"}}]}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-07-28T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"127.0.0.1"}]}}"#,
                "\n",
            ),
        )
        .unwrap();

        let turns = crate::sessions::transcript_turns(path.to_str().unwrap(), "claude");
        let events = events_from_turns("s1", &turns, &[]);
        assert_eq!(kinds(&events), ["user", "text", "started", "completed"]);

        // The fact the user stated in the terminal is in the replay, which is
        // what a question about it later would be answered from.
        match &events[0] {
            ChatEvent::UserMessage { blocks, .. } => {
                assert_eq!(blocks, &[ContentBlock::Text { text: "the deploy key is DEPLOY-77".into() }]);
            }
            other => panic!("expected a user message, got {other:?}"),
        }
        // The terminal-era call kept the agent's own id, so a later chat turn
        // referring to the same call lines up rather than forking a second card.
        match &events[2] {
            ChatEvent::ToolCallStarted { tool_use_id, name, .. } => {
                assert_eq!(tool_use_id, "toolu_x");
                assert_eq!(name, "Read");
            }
            other => panic!("expected a started call, got {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    /// The summary arrives wrapped in a prompt the agent wrote *to the
    /// model*: a preamble explaining what a compaction is, and a closing that
    /// tells it to resume without acknowledging any of this, with a path to a
    /// jsonl on disk. Rendering that in a conversation reads as though someone
    /// said it. Wording taken from a real compacted transcript.
    #[test]
    fn a_compaction_summary_arrives_without_the_agents_instructions() {
        let raw = concat!(
            "This session is being continued from a previous conversation that ran out of context. ",
            "The summary below covers the earlier portion of the conversation. Summary: ",
            "1. Primary Request and Intent: the user asked for a detailed summary. ",
            "2. Key Technical Concepts: Sway chat UI project. ",
            "If you need specific details from before compaction (like exact code snippets), ",
            "read the full transcript at: /Users/x/.claude/projects/p/ff243892.jsonl ",
            "Continue the conversation from where it left off without asking the user any further questions.",
        );
        let out = strip_continuation_framing(raw);
        assert!(out.starts_with("1. Primary Request and Intent"), "got {out:?}");
        assert!(out.ends_with("Sway chat UI project."), "got {out:?}");
        assert!(!out.contains(".jsonl"));
        assert!(!out.contains("without asking the user"));
    }

    /// A wording we do not know keeps every word: a summary with its framing
    /// still attached is noisy, one cut in the wrong place has lost content.
    #[test]
    fn an_unrecognised_summary_is_left_whole() {
        let raw = "Here is what happened earlier: we fixed the parser and shipped it.";
        assert_eq!(strip_continuation_framing(raw), raw);
    }

    /// Measured against a real transcript: running `/model haiku` writes three
    /// user-role records (the caveat, the command envelope, the command's own
    /// stdout) and none of them is something the person typed. Replaying them
    /// showed the agent's markup as the user's own messages, and counted each
    /// one as a prompt - a session with two real prompts reporting five.
    #[test]
    fn a_slash_command_is_not_replayed_as_something_the_user_typed() {
        let dir = std::env::temp_dir().join(format!("sway-cmd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("commands.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","timestamp":"2026-07-28T10:00:00Z","message":{"role":"user","content":"start the migration"}}"#,
                "\n",
                r#"{"type":"user","isMeta":true,"timestamp":"2026-07-28T10:01:00Z","message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>"}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-07-28T10:01:01Z","message":{"role":"user","content":"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>"}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-07-28T10:01:02Z","message":{"role":"user","content":"<local-command-stdout>Set model to haiku (claude-haiku-4-5-20251001)</local-command-stdout>"}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-07-28T10:02:00Z","message":{"role":"user","content":"carry on"}}"#,
                "\n",
            ),
        )
        .unwrap();

        let turns = crate::sessions::transcript_turns(path.to_str().unwrap(), "claude");
        let events = events_from_turns("s1", &turns, &[]);
        assert_eq!(kinds(&events), ["user", "user"]);
        let texts: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::UserMessage { blocks, .. } => Some(blocks.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                vec![ContentBlock::Text { text: "start the migration".into() }],
                vec![ContentBlock::Text { text: "carry on".into() }],
            ]
        );
        let _ = std::fs::remove_file(&path);
    }

    /// The exclusion is the opening tag, not a leading `<`: a question about
    /// markup is still a question the user asked.
    #[test]
    fn a_prompt_that_merely_starts_with_markup_is_still_the_users() {
        let dir = std::env::temp_dir().join(format!("sway-markup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("markup.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","timestamp":"2026-07-28T10:00:00Z","message":{"role":"user","content":"<svg viewBox=\"0 0 24 24\"> - why does this not scale?"}}"#,
                "\n",
            ),
        )
        .unwrap();

        let turns = crate::sessions::transcript_turns(path.to_str().unwrap(), "claude");
        assert_eq!(kinds(&events_from_turns("s1", &turns, &[])), ["user"]);
        let _ = std::fs::remove_file(&path);
    }

    /// Measured against a real compacted transcript: the boundary is a
    /// `system`/`compact_boundary` record and the summary is the user message
    /// straight after it, which is why that message is consumed rather than
    /// rendered as something the user typed.
    #[test]
    fn a_compaction_replays_inline_with_the_agents_own_summary() {
        let dir = std::env::temp_dir().join(format!("sway-compact-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("compacted.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","timestamp":"2026-07-28T10:00:00Z","message":{"role":"user","content":"early work"}}"#,
                "\n",
                r#"{"type":"system","subtype":"compact_boundary","timestamp":"2026-07-28T10:01:00Z","compactMetadata":{"trigger":"manual","preTokens":247408,"postTokens":9444}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-07-28T10:01:01Z","message":{"role":"user","content":"This session is being continued from a previous conversation."}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-07-28T10:02:00Z","message":{"content":[{"type":"text","text":"carrying on"}]}}"#,
                "\n",
            ),
        )
        .unwrap();

        let turns = crate::sessions::transcript_turns(path.to_str().unwrap(), "claude");
        let events = events_from_turns("s1", &turns, &[]);
        // The continuation preamble is *not* a second user turn.
        assert_eq!(kinds(&events), ["user", "other", "text"]);
        match &events[1] {
            ChatEvent::Compacted { trigger, pre_tokens, post_tokens, summary, .. } => {
                assert_eq!(trigger.as_deref(), Some("manual"));
                // The reclaim is the checkable half of "compaction reduces
                // reported context usage".
                assert_eq!(*pre_tokens, Some(247408));
                assert_eq!(*post_tokens, Some(9444));
                assert!(post_tokens < pre_tokens);
                assert!(summary.as_deref().unwrap().contains("continued from a previous conversation"));
            }
            other => panic!("expected a compaction, got {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_compaction_with_no_following_turn_reports_no_summary() {
        let turns = vec![turn("compaction", vec![crate::sessions::compaction_block(Some("auto".into()), Some(100), Some(10))])];
        match &events_from_turns("s1", &turns, &[])[0] {
            // A session compacted and then closed has no summary message yet,
            // and inventing one would be worse than saying nothing.
            ChatEvent::Compacted { summary, trigger, .. } => {
                assert!(summary.is_none());
                assert_eq!(trigger.as_deref(), Some("auto"));
            }
            other => panic!("expected a compaction, got {other:?}"),
        }
    }

    #[test]
    fn a_completed_call_claims_no_files_it_did_not_measure() {
        // Per-turn attribution consumes `files`; a replay that guessed from the
        // tool input would feed it paths nothing observed being written.
        let turns = vec![
            turn(
                "assistant",
                vec![tool_call_block("Edit".into(), serde_json::json!({ "file_path": "/a" }), Some("t1".into()))],
            ),
            turn("user", vec![tool_result_block(None, "ok".into(), false, Some("t1".into()), None, Vec::new())]),
        ];
        match &events_from_turns("s1", &turns, &[])[1] {
            ChatEvent::ToolCallCompleted { files, duration_ms, .. } => {
                assert!(files.is_empty());
                assert!(duration_ms.is_none());
            }
            other => panic!("expected a completed call, got {other:?}"),
        }
    }

    fn stamped(role: &str, ts: u64, text: &str) -> TranscriptTurn {
        TranscriptTurn { role: role.into(), ts, blocks: vec![text_block("text", text.into())] }
    }

    #[test]
    fn a_rewind_cuts_at_the_prompt_even_when_the_two_clocks_disagree() {
        // The checkpoint says 1200; the transcript stamped the same prompt 1198,
        // because Sway's `turnStarted` and the agent's write are two clocks.
        // A `ts < prompt_ts` cut would keep that prompt and sever its turn.
        let turns = vec![
            stamped("user", 1000, "first"),
            stamped("assistant", 1005, "done"),
            stamped("user", 1198, "second"),
            stamped("assistant", 1205, "done"),
        ];
        assert_eq!(prompt_boundary(&turns, 1200), Some(2));
        // And when it drifted the other way.
        let later = vec![stamped("user", 1000, "first"), stamped("user", 1202, "second")];
        assert_eq!(prompt_boundary(&later, 1200), Some(1));
    }

    #[test]
    fn a_rewind_never_cuts_inside_an_assistant_turn() {
        // The nearest turn by raw timestamp is the assistant reply, but cutting
        // there would replay a call whose result is on the far side of the cut.
        let turns = vec![
            stamped("user", 1000, "go"),
            stamped("assistant", 1199, "working"),
            stamped("user", 1400, "and again"),
        ];
        assert_eq!(prompt_boundary(&turns, 1200), Some(0));
    }

    #[test]
    fn a_compaction_summary_is_not_a_boundary_a_rewind_can_land_on() {
        // The summary is a `user` turn the user never typed, so nobody can mean
        // it when they point at a turn to go back to.
        let turns = vec![
            stamped("user", 1000, "go"),
            turn("assistant", vec![compaction_block(None, None, None)]),
            stamped("user", 1200, "the summary the agent wrote"),
            stamped("user", 1600, "carry on"),
        ];
        assert_eq!(prompt_boundary(&turns, 1200), Some(0));
    }

    #[test]
    fn a_rewound_replay_renders_as_a_session_that_had_stopped_there() {
        // The property the whole rewind rests on: a tab opened on the cut must
        // show what a tab opened on a session that ended at the cut would show.
        // It is not free - turn ids are numbered from the start of the replay,
        // so a cut that renumbered them would give the rewound tab different
        // ids for the same turns, and its scroll anchor and every upsert keyed
        // on a turn id would land somewhere else.
        let turns = vec![
            stamped("user", 1000, "first"),
            stamped("assistant", 1005, "done"),
            stamped("user", 1200, "second"),
            stamped("assistant", 1205, "also done"),
        ];
        let at = prompt_boundary(&turns, 1200).unwrap();
        let cut = events_from_turns("s1", &turns[..at], &[]);
        let whole = events_from_turns("s1", &turns, &[]);
        assert_eq!(cut, whole[..cut.len()]);
        // And it really did cut: the second exchange is gone, not merely equal
        // by both sides being empty.
        assert!(!cut.is_empty() && cut.len() < whole.len());
    }

    #[test]
    fn a_transcript_with_no_prompt_offers_no_boundary() {
        // Read as "nothing to cut at", so the caller replays the session whole
        // rather than opening it blank.
        assert_eq!(prompt_boundary(&[], 1200), None);
        assert_eq!(prompt_boundary(&[stamped("assistant", 1200, "hi")], 1200), None);
    }

    /// Replay a committed session fixture, sidecars and all. Read from
    /// `CARGO_MANIFEST_DIR` for the reason the fixture README gives.
    fn replay_session(name: &str) -> Vec<ChatEvent> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev/fixtures/sessions")
            .join(format!("{name}.jsonl"));
        let path = path.to_str().expect("fixture path is utf-8");
        let turns = crate::sessions::transcript_turns(path, "claude");
        let subagents = crate::sessions::subagent_transcripts(path, "claude");
        events_from_turns("s1", &turns, &subagents)
    }

    /// The same run as it arrived live, straight off the captured stream.
    fn live_events(name: &str) -> Vec<ChatEvent> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev/fixtures/claude")
            .join(format!("{name}.jsonl"));
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let mut mapper = crate::chat::claude::ClaudeMapper::new("s1");
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<serde_json::Value>(l).expect("fixture line is json"))
            .flat_map(|f| mapper.map(&f))
            .collect()
    }

    /// Every lane a run produced and, in order, what each put on screen.
    /// Consecutive text collapses the way the store's fold collapses it into one
    /// bubble, so a stream's deltas and a replay's whole block compare equal.
    fn lane_shapes(events: &[ChatEvent]) -> BTreeMap<String, Vec<&'static str>> {
        let mut lane_of_call: HashMap<&str, &str> = HashMap::new();
        for ev in events {
            if let ChatEvent::SubagentCall { agent_id, tool_use_id, .. } = ev {
                lane_of_call.insert(tool_use_id, agent_id);
            }
        }
        let mut out: BTreeMap<String, Vec<&'static str>> = BTreeMap::new();
        for ev in events {
            match ev {
                ChatEvent::SubagentStarted { agent_id, .. } => {
                    out.entry(agent_id.clone()).or_default();
                }
                ChatEvent::TextDelta { agent_id: Some(agent_id), .. } => {
                    let rows = out.entry(agent_id.clone()).or_default();
                    if rows.last() != Some(&"text") {
                        rows.push("text");
                    }
                }
                ChatEvent::ToolCallStarted { tool_use_id, .. } => {
                    if let Some(agent_id) = lane_of_call.get(tool_use_id.as_str()) {
                        out.entry((*agent_id).to_string()).or_default().push("tool");
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// Each pair is the **same run** captured twice, the stream and the files
    /// the CLI wrote for it. Comparing two different runs would only prove each
    /// shape self-consistent.
    ///
    /// **A foreground subagent's closing report is not on the wire at all.**
    /// Measured: the nested frames of `permission-subagent` and
    /// `subagent-parallel` are the call and its result and nothing else, while
    /// the backgrounded run does send its closing `assistant/text`. So reopening
    /// a foreground lane shows *more*, and this asserts a superset.
    #[test]
    fn a_reopened_session_offers_the_lanes_the_live_run_showed() {
        for (fixture, session) in [
            ("permission-subagent", "subagent-foreground"),
            ("subagent-background", "subagent-background"),
        ] {
            let replayed = lane_shapes(&replay_session(session));
            let live = lane_shapes(&live_events(fixture));
            assert_eq!(
                replayed.keys().collect::<Vec<_>>(),
                live.keys().collect::<Vec<_>>(),
                "{session}: the same lanes"
            );
            for (lane, rows) in &live {
                let mine = replayed.get(lane).expect("the lane is there");
                assert_eq!(&mine[..rows.len()], &rows[..], "{session}: lane {lane} kept the rows it showed live");
            }
        }

        // The one row the two disagree on, named rather than left to a count.
        assert_eq!(
            lane_shapes(&replay_session("subagent-foreground")).get("acb01121756a92ca0").map(Vec::as_slice),
            Some(["tool", "text"].as_slice()),
            "its call, then the closing report only the sidecar has"
        );
        assert_eq!(
            lane_shapes(&live_events("subagent-background")).get("ad7048d25dc5e778a").map(Vec::as_slice),
            lane_shapes(&replay_session("subagent-background")).get("ad7048d25dc5e778a").map(Vec::as_slice),
            "a backgrounded lane does send its report, so its two shapes match exactly"
        );
    }

    /// A lane belongs to the turn that launched it, so its rows group under the
    /// header the live run put them under.
    #[test]
    fn a_reopened_subagents_rows_stay_in_the_turn_that_launched_it() {
        let events = replay_session("subagent-foreground");
        let launcher = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::ToolCallStarted { tool_use_id, name, turn_id, .. } if name == "Agent" => {
                    Some((tool_use_id.clone(), turn_id.clone()))
                }
                _ => None,
            })
            .expect("the Agent call");
        let laned: Vec<&String> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TextDelta { agent_id: Some(_), turn_id, .. } => Some(turn_id),
                _ => None,
            })
            .collect();
        assert!(!laned.is_empty(), "the lane produced rows to attribute");
        assert!(laned.iter().all(|t| **t == launcher.1), "every laned row sits in the launching turn");
        assert_eq!(launcher.0, "toolu_01Ec9PYYDVBe9S6DjXp4RM1s");
    }

    /// A backgrounded subagent ends twice on disk: the call returns
    /// `async_launched`, the ending arrives later as a notification. The later
    /// record has to win, or a reopened lane reads as never finished.
    #[test]
    fn a_reopened_background_lane_ends_where_its_notification_says() {
        let events = replay_session("subagent-background");
        let statuses: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::SubagentUpdate { agent_id, status: Some(s), .. } if agent_id == "ad7048d25dc5e778a" => {
                    Some(s.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(statuses, ["async_launched", "completed"], "the launch, then the ending");

        let ending = events
            .iter()
            .rev()
            .find_map(|e| match e {
                ChatEvent::SubagentUpdate { usage: Some(u), summary, .. } => Some((*u, summary.clone())),
                _ => None,
            })
            .expect("a terminal update");
        assert_eq!(ending.0.total_tokens, 9551);
        assert_eq!(ending.0.tool_uses, 1);
        assert_eq!(ending.1.as_deref(), Some("Agent \"Create bg file\" finished"));

        // And it is no longer also a message the user appears to have sent.
        let said: Vec<String> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::UserMessage { blocks, .. } => Some(
                    blocks
                        .iter()
                        .map(|b| match b {
                            ContentBlock::Text { text } => text.clone(),
                            _ => String::new(),
                        })
                        .collect::<String>(),
                ),
                _ => None,
            })
            .collect();
        assert_eq!(said.len(), 1, "one prompt, the one that was typed: {said:?}");
    }

    /// The common session, which never launched one, replays as it always did.
    #[test]
    fn a_session_with_no_subagents_replays_untouched() {
        let events = replay_session("plain-prompt");
        assert!(!events.is_empty(), "the fixture still replays");
        assert!(
            !events.iter().any(|e| matches!(
                e,
                ChatEvent::SubagentStarted { .. } | ChatEvent::SubagentCall { .. } | ChatEvent::SubagentUpdate { .. }
            )),
            "no lane is invented for a session that never fanned out"
        );
        assert!(
            events.iter().all(|e| !matches!(e, ChatEvent::TextDelta { agent_id: Some(_), .. })),
            "and no row is laned"
        );
    }
}
