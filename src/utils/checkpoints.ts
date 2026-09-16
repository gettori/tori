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
///
/// **`chatDriven` sessions never fire here.** A chat session reports its own
/// `turnStarted`, which is the real boundary rather than a count inferred from
/// a file the poller re-reads; letting both drive would snapshot every chat turn
/// twice, under two different timestamps, and the second would capture the first
/// snapshot's own turn. Their counts are still *recorded*, so a session that
/// later stops being chat-driven resumes from where it is rather than firing a
/// spurious catch-up for turns already checkpointed.
export function stepCheckpointTrigger(
  state: TriggerState,
  live: PromptTick[],
  chatDriven: ReadonlySet<string> = new Set(),
): { state: TriggerState; fired: PromptTick[] } {
  const next = { ...state };
  const fired: PromptTick[] = [];
  for (const tick of live) {
    const prev = next[tick.sessionId];
    if (!chatDriven.has(tick.sessionId) && tick.promptCount > 0 && tick.promptCount !== prev) {
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
///
/// `chatDriven` are the sessions checkpointing themselves off real turn
/// boundaries; see `stepCheckpointTrigger`.
export async function noteCheckpointTicks(live: PromptTick[], chatDriven: ReadonlySet<string> = new Set()) {
  const { state: next, fired } = stepCheckpointTrigger(state, live, chatDriven);
  state = next;
  await Promise.all(fired.map((f) => snapshot(f.sessionId, f.repoPath, f.lastPromptTs)));
}

/**
 * Snapshot at a chat session's **real** turn boundary.
 *
 * The polling path infers a boundary from a prompt count re-read off the
 * transcript, which lags and can miss a turn entirely; a chat session says
 * exactly when its turn began. Called on `turnStarted`, so the snapshot is the
 * tree *before* that turn's edits - which is what makes reverting the turn mean
 * anything.
 *
 * The ref keying is unchanged (`refs/tori/checkpoint/<sessionId>/<promptTs>`,
 * seconds): the timeline reads refs written by both drivers and would not be
 * able to order them if chat used a different unit.
 */
export async function checkpointChatTurn(sessionId: string, repoPath: string, atSeconds?: number) {
  const ts = atSeconds ?? Math.floor(Date.now() / 1000);
  await snapshot(sessionId, repoPath, ts);
}

function snapshot(sessionId: string, repoPath: string, promptTs: number): Promise<unknown> {
  return invoke("checkpoint_snapshot", { sessionId, repoPath, promptTs }).catch(() => {});
}
