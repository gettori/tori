---
summary: rewind forks the session with its real frames, reverts the tree to that turn and admits the agent still remembers
status: current
updated: 2026-07-29
source: Chat surface plan, phase 5 (branch `chat`); `src/panels/Chat/rewind.ts`; `src-tauri/src/chat/commands.rs:105`; commit "Rewind a chat by forking it, and say what did not go back"
---

# Rewind by fork

Rewinding a chat to an earlier turn means forking the session, reverting the
working tree to that turn's checkpoint, and **announcing what did not go back**.
The one cost the mechanism cannot remove is that the forked agent still remembers
the turns being undone, which is often exactly what the user rewound to escape.
That admission is stated three times rather than once, and tested, so a copy edit
cannot quietly drop it.

## How it works

`chat_spawn` forks with `--resume <old> --fork-session --session-id <new>`
(`commands.rs:105`), so the fork carries the original's **real frames**, tool
results and all. The original session is untouched and keeps its id. The tree is
reverted to the chosen turn's checkpoint (see [[component_turn_checkpoints]]),
and the transcript panel cuts its display at that turn.

**The cut snaps to the nearest human prompt, not to a timestamp.** A chat
checkpoint is stamped `Math.floor(Date.now()/1000)` at `turnStarted`
(`checkpoints.ts:71`) while the transcript is stamped by the harness, so one
prompt carries two timestamps a second or two apart and a `ts < prompt_ts` cut
lands on either side depending on which way they drifted. `prompt_boundary` also
guarantees the cut falls *between* turns rather than inside one, since a replay
severed mid-turn would show a call with no result.

**Rewind is offered on the turn header, and only for turns this tab ran**,
because only those have a checkpoint. A replayed turn's tree state was never
recorded, so offering it would fail at the revert with nothing on screen having
warned it might.

**The cut is not re-applied after a restart.** `--fork-session` copies the
original conversation into the fork's own transcript, so once the tab resumes its
own id the same cut would fall inside that copy and hide the turns run since. The
banner is persisted (`tabPersist.ts`) and the cut is keyed on `forkFrom` being
present; after a restart the panel shows everything, which now matches what the
agent remembers.

## Why it's this way

Three mechanisms were named in the plan and a fourth was found in the codebase
while reading the spawn path. A spike had ruled `--fork-session` out for forking
at the conversation's *end* rather than at a chosen turn, which is true on its
own; combined with the tree revert and a display cut it beats prose replay on
every axis that matters.

- **Rejected `rewind: replay`** (re-feeding a prose summary into a fresh session)
  on two counts beyond fidelity: its loss *grows with session size*, since a real
  session's tool output either blows the context or gets summarised, and it
  writes a synthetic assistant transcript, which `history.rs:52` already refuses
  to do in the smaller case of a compaction summary.
- **Rejected `rewind: files-only`** as strictly worse than fork once fork was on
  the table: it discards real context to avoid a defect that can be stated
  instead.

The published capability value is therefore `rewind: fork`, which is a measured
outcome rather than the phase's name, per
[[concept_harness_capability_tiers]].

## Related

- [[component_turn_checkpoints]] - the per-turn refs the revert uses
- [[component_chat_panel]] - where rewind is offered and the banner lives
- [[concept_harness_capability_tiers]] - `rewindTsFor` is gated on `rewind === "fork"`
- [[lesson_fix_the_kill_threshold_before_measuring]] - the spike discipline that found this variant
