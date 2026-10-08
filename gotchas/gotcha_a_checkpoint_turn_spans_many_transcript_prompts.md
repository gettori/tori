---
summary: slash commands, skill bodies and notifications open transcript records with no checkpoint; cut a turn by record time, not prompt
status: current
updated: 2026-10-08
source: "Provenance plan, gettori/tickets#25 (branch phase-1-block-1), phase provenance-core; release probe on this worktree's real sessions; src-tauri/src/provenance.rs:396 (History::turn), SKEW at :348"
---

# A checkpoint turn spans many transcript prompts

Do NOT match a checkpoint turn to the transcript's nearest prompt. A session driven by a skill had one checkpoint at its `/scribe:plan` command and two and a half hours of work after it, while its transcript held a command record (not a prompt at all), several skill bodies and a task notification as user records. Snapping to the nearest prompt found an empty turn. Why: Tori checkpoints at the prompts it sees go out, and the transcript records far more. Cut the turn as the records whose own time falls from the checkpoint (minus a second of clock skew) to the session's next turn start, and treat a window with no records as "the transcript does not reach here", never as "the turn did nothing".

## Related

- [[component_provenance]] `History::turn`
- [[gotcha_events_and_prompts_lists_tool_results_as_prompts]] the other prompt-list trap
- [[concept_rewind_by_fork]] where the checkpoint and transcript clocks were first measured apart
