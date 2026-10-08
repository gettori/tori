---
summary: turns overlapping an interval are graded named, loose, clean or unrecorded; one writer claims, content breaks ties, quiet turns drop out
status: current
updated: 2026-10-08
source: "Provenance plan, gettori/tickets#25 (branch phase-1-block-1), phase provenance-core; src-tauri/src/provenance.rs (Verdict, writer, pick_by_content, last_record); measured with a release probe on this worktree's real sessions"
---

# Who wrote an interval

The checkpoint walk ([[component_provenance]]) knows *when* a line changed, an interval between two checkpoints. Who wrote it is settled by grading every session turn that overlapped the interval, and the claim is only as strong as that grading allows.

## How it works

- **Turn spans.** A session's turn starts are its non-backstop checkpoint times plus the turns it recorded a tool call in. A turn runs to the session's next start; the last one to the transcript's last activity.
- **Grading one turn** (`Verdict`, `provenance.rs:648`). Its events are read from its own transcript (see [[gotcha_a_checkpoint_turn_spans_many_transcript_prompts]]) or an ACP mirror log matched by rank. It is **Named** when a call wrote the file, **Loose** when it ran something that could write without naming a path (a shell, an unknown or MCP tool), **Clean** otherwise. With no readable history the touched record decides, and with none at all it is **Unrecorded**. `AskUserQuestion`, `ToolSearch`, `Skill`, `EnterPlanMode`, `ExitPlanMode` count as inert.
- **Settling** (`writer`, `provenance.rs:764`). One Named turn and nothing else in doubt is a claim; one Loose turn alone is a `shell` claim (or `candidates` if not all shell); nobody overlapping is `unseen`; only unrecorded sessions is `unrecorded`; anything else is contested.
- **Contested is settled per range by content** (`pick_by_content`, `provenance.rs:921`): if exactly one write call's own text holds every non-blank line of the range, it is named. A neighbour running tests does not hide the edit that wrote the lines.
- **A quiet turn is no suspect** (`last_record`, `provenance.rs:731`): a turn whose transcript went quiet before the interval opened is over, even if its next prompt came the next morning.

## Why it is this way

Every rule here came from running the resolver on real sessions. Without the inert list, a turn of questions made every hunk "one of 87 calls". Without the quiet-turn bound, an overnight turn overlapped everything after it. Without the content tiebreak, every concurrent pair of chats read as overlapping, since nearly every turn runs some shell. What remains is honest: a turn with a touched record but no checkpoint of its own cannot split an interval, so two turns of one session can still read as overlapping there.

The resolution is a turn: a hand edit made during a turn is credited to it, the limit [[concept_line_provenance]] already states.

## Related

- [[component_provenance]] the module this lives in
- [[concept_evidence_tiered_attribution]] weaker evidence, weaker claim
- [[gotcha_events_and_prompts_lists_tool_results_as_prompts]] a trap met while reading turns
