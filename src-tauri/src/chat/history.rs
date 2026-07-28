//! Replaying a session's transcript into the normalized [`ChatEvent`] model.
//!
//! **Why events rather than a second rendering path.** A chat tab already knows
//! how to fold `ChatEvent`s into a transcript; giving history its own shape
//! would mean two renderers that drift, and the one used less often would be the
//! one that rots. So the file on disk is mapped to the same events a live child
//! emits, and the panel cannot tell the difference beyond the flag it is handed.
//!
//! **Why it works for sessions Sway never ran.** `parse_transcript_turns` reads
//! the jsonl the harness itself writes, and a PTY agent tab, an outside
//! terminal, and a chat tab all write the same file. So a session started
//! anywhere backfills here without a second parser.
//!
//! **The one thing the transcript cannot give back is timing.** There are no
//! deltas on disk, only finished text, so a replayed turn arrives as one
//! `TextDelta` carrying the whole block rather than the hundreds a live turn
//! streams. The fold appends either way, so the result is identical; what is
//! lost is the typing, which is exactly the part nobody wants replayed.

use crate::sessions::{TranscriptBlock, TranscriptTurn};

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
pub fn events_from_turns(session_id: &str, turns: &[TranscriptTurn]) -> Vec<ChatEvent> {
    let mut events = Vec::new();
    // Calls awaiting their result, oldest first. Claude records an id on both
    // halves so the match is exact; pi records none, and for it this queue is
    // the fallback - a result pairs with the oldest call still open, which is
    // the order a single-threaded harness produces them in.
    let mut open_calls: Vec<(String, String)> = Vec::new();
    let mut seq = 0usize;

    for (at, turn) in turns.iter().enumerate() {
        seq += 1;
        let turn_id = format!("{TURN_PREFIX}{seq}");
        let mut user_blocks = Vec::new();

        // The summary of a compaction is the *user* turn straight after it, not
        // a field on the boundary. Rendering it as an ordinary user message
        // would put words in the user's mouth that the harness wrote, so it is
        // consumed here and attached to the compaction instead.
        if turns.get(at.wrapping_sub(1)).is_some_and(is_compaction) && turn.role == "user" && at > 0 {
            continue;
        }

        for block in &turn.blocks {
            match block.kind.as_str() {
                "text" if turn.role == "user" => {
                    if let Some(text) = &block.text {
                        user_blocks.push(ContentBlock::Text { text: text.clone() });
                    }
                }
                "text" => {
                    if let Some(text) = &block.text {
                        events.push(ChatEvent::TextDelta {
                            session_id: session_id.to_string(),
                            turn_id: turn_id.clone(),
                            text: text.clone(),
                        });
                    }
                }
                "thinking" => {
                    if let Some(text) = &block.text {
                        events.push(ChatEvent::ThinkingDelta {
                            session_id: session_id.to_string(),
                            turn_id: turn_id.clone(),
                            text: text.clone(),
                        });
                    }
                }
                "tool_call" => {
                    let tool_use_id = replay_id(block, &mut seq);
                    let name = block.tool_name.clone().unwrap_or_default();
                    open_calls.push((tool_use_id.clone(), name.clone()));
                    events.push(ChatEvent::ToolCallStarted {
                        session_id: session_id.to_string(),
                        turn_id: turn_id.clone(),
                        tool_use_id,
                        name,
                        input: block.tool_input.clone().unwrap_or(serde_json::Value::Null),
                    });
                }
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
                "tool_result" => {
                    let Some((tool_use_id, _)) = take_call(&mut open_calls, block) else {
                        // A result whose call is not in this transcript - a
                        // resumed session whose earlier half lives in another
                        // file, most often. Dropped rather than rendered as a
                        // card with no call, which would read as a phantom tool
                        // run that never happened.
                        continue;
                    };
                    events.push(ChatEvent::ToolCallCompleted {
                        session_id: session_id.to_string(),
                        turn_id: turn_id.clone(),
                        tool_use_id,
                        status: if block.is_error == Some(true) { ToolStatus::Error } else { ToolStatus::Ok },
                        output: block.text.clone(),
                        // Deliberately empty: the transcript records that a tool
                        // ran, not which paths it wrote. Guessing from the input
                        // would feed per-turn attribution a set nothing measured.
                        files: Vec::new(),
                        // Never recorded on disk, and a fabricated duration
                        // would be indistinguishable from a real one.
                        duration_ms: None,
                    });
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

fn is_compaction(turn: &TranscriptTurn) -> bool {
    turn.blocks.iter().any(|b| b.kind == "compaction")
}

/// The summary the harness wrote for the compaction at `at`: the text of the
/// user turn immediately following it. `None` when the transcript ends at the
/// boundary, which happens for a session compacted and then closed.
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
    (!text.is_empty()).then_some(text)
}

/// The id to replay a call under: the harness's own when the transcript has one,
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
    use crate::sessions::{text_block, tool_call_block, tool_result_block};

    fn turn(role: &str, blocks: Vec<TranscriptBlock>) -> TranscriptTurn {
        TranscriptTurn { role: role.into(), ts: 0, blocks }
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
            turn("user", vec![tool_result_block(None, "done".into(), false, Some("toolu_1".into()))]),
            turn("assistant", vec![text_block("text", "fixed".into())]),
        ];

        let events = events_from_turns("s1", &turns);
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
                    tool_result_block(None, "b output".into(), false, Some("toolu_b".into())),
                    tool_result_block(None, "a output".into(), true, Some("toolu_a".into())),
                ],
            ),
        ];

        let events = events_from_turns("s1", &turns);
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
        // pi records no tool ids at all, so the fallback has to hold.
        let turns = vec![
            turn("assistant", vec![tool_call_block("Read".into(), serde_json::json!({}), None)]),
            turn("tool", vec![tool_result_block(Some("Read".into()), "out".into(), false, None)]),
        ];
        let events = events_from_turns("s1", &turns);
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
            vec![tool_result_block(None, "orphan".into(), false, Some("toolu_gone".into()))],
        )];
        assert!(events_from_turns("s1", &turns).is_empty());
    }

    #[test]
    fn replayed_ids_cannot_collide_with_a_live_turn() {
        let turns = vec![turn("user", vec![text_block("text", "hi".into())])];
        match &events_from_turns("s1", &turns)[0] {
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
    /// through the harness's own parser and out as replay events, which is what
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
        let events = events_from_turns("s1", &turns);
        assert_eq!(kinds(&events), ["user", "text", "started", "completed"]);

        // The fact the user stated in the terminal is in the replay, which is
        // what a question about it later would be answered from.
        match &events[0] {
            ChatEvent::UserMessage { blocks, .. } => {
                assert_eq!(blocks, &[ContentBlock::Text { text: "the deploy key is DEPLOY-77".into() }]);
            }
            other => panic!("expected a user message, got {other:?}"),
        }
        // The terminal-era call kept the harness's own id, so a later chat turn
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

    /// Measured against a real compacted transcript: the boundary is a
    /// `system`/`compact_boundary` record and the summary is the user message
    /// straight after it, which is why that message is consumed rather than
    /// rendered as something the user typed.
    #[test]
    fn a_compaction_replays_inline_with_the_harnesss_own_summary() {
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
        let events = events_from_turns("s1", &turns);
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
        match &events_from_turns("s1", &turns)[0] {
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
            turn("user", vec![tool_result_block(None, "ok".into(), false, Some("t1".into()))]),
        ];
        match &events_from_turns("s1", &turns)[1] {
            ChatEvent::ToolCallCompleted { files, duration_ms, .. } => {
                assert!(files.is_empty());
                assert!(duration_ms.is_none());
            }
            other => panic!("expected a completed call, got {other:?}"),
        }
    }
}
