// Prompt-boundary trigger for turn-level checkpoints (Finding E). Mirrors
// presence.ts's shape: a pure rising-edge state machine over one tick of live
// sessions' prompt counts, tested in isolation, plus a thin invoke wrapper
// LeftSidebar.tsx drives reactively. A session's prompt_count rising is a new
// human prompt having landed - the exact boundary a checkpoint snapshot
// belongs to (see checkpoint.rs's `checkpoint_snapshot`).
import { invoke } from "@tauri-apps/api/core";

export type PromptTick = { sessionId: string; repoPath: string; promptCount: number; lastPromptTs: number };

type TriggerState = Record<string, number>;

/// Pure: fold one tick of live sessions' prompt counts into the trigger
/// state. Returns the sessions whose prompt count just increased - the
/// caller snapshots those at `lastPromptTs`. A session seen for the first
/// time with a nonzero count also fires (its very first prompt is itself a
/// boundary, captured before that turn's edits happen).
export function stepCheckpointTrigger(
  state: TriggerState,
  live: PromptTick[],
): { state: TriggerState; fired: PromptTick[] } {
  const next = { ...state };
  const fired: PromptTick[] = [];
  for (const tick of live) {
    const prev = next[tick.sessionId];
    if (tick.promptCount > 0 && tick.promptCount !== prev) {
      fired.push(tick);
    }
    next[tick.sessionId] = tick.promptCount;
  }
  return { state: next, fired };
}

let state: TriggerState = {};

/// Called reactively with every live agent session's current prompt tail;
/// snapshots each session whose prompt count just rose. Best-effort: a failed
/// invoke (no repo, git missing) never throws into the caller's effect.
export async function noteCheckpointTicks(live: PromptTick[]) {
  const { state: next, fired } = stepCheckpointTrigger(state, live);
  state = next;
  await Promise.all(
    fired.map((f) =>
      invoke("checkpoint_snapshot", {
        sessionId: f.sessionId,
        repoPath: f.repoPath,
        promptTs: f.lastPromptTs,
      }).catch(() => {}),
    ),
  );
}
