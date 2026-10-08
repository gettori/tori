// Which agent turn wrote a line that is not committed yet.
//
// The other half of `blame.ts`. Blame stops at HEAD, so every line written this
// afternoon comes back "not committed yet" and nothing more; the turn
// checkpoints know the rest, and `agent_lines.rs` walks them. This module is the
// read, the cache, and the sentence the widget says.
//
// **The cache is keyed by file alone, not by file plus a version.** Unlike
// blame, whose answer cannot change while HEAD stands still, this answer changes
// every time anything writes the file, so there is no key that notices on its
// own: `dropAgentLines` is called from the same two places `dropBlame` is (our
// own save, and somebody else's write to an open file).

import { invoke } from "@tauri-apps/api/core";

/** Mirrors `AgentTurn` in src-tauri/src/agent_lines.rs. */
export type AgentTurn = {
  session_id: string;
  prompt_ts: number;
  /** 1-based position in its session, so the label can say "turn 12". */
  ordinal: number;
};

/** Mirrors `AgentLines` in src-tauri/src/agent_lines.rs. */
export type AgentLines = {
  /** One entry per line of the file on disk: an index into `turns`, or -1 for a
   *  line no recorded turn wrote. */
  lines: number[];
  turns: AgentTurn[];
};

/** The index a line carries when no turn claims it. */
export const NO_TURN = -1;

export function emptyAgentLines(): AgentLines {
  return { lines: [], turns: [] };
}

/** Same bound and same reasoning as the blame cache: a tab strip holds a handful
 *  of files, and an unbounded map is a leak however slowly it fills. */
const MAX_ENTRIES = 40;

const cache = new Map<string, AgentLines>();

export function agentKey(root: string, file: string): string {
  return `${root}\0${file}`;
}

/**
 * Who wrote this file's uncommitted lines, from cache when it has been read
 * before.
 *
 * The backend finds the sessions that ran in `root` itself, chat and terminal
 * alike, the same set a diff hunk's provenance weighs.
 *
 * A failure is an empty answer, not a throw, for the reason blame's is: this is
 * decoration on a file you were trying to read.
 */
export async function agentLinesFor(root: string, file: string): Promise<AgentLines> {
  const key = agentKey(root, file);
  const hit = cache.get(key);
  if (hit) return hit;
  let read: AgentLines;
  try {
    read = await invoke<AgentLines>("agent_lines", { projectPath: root, file });
  } catch {
    // Not cached, same as blame: a failed read is a fact about the backend, not
    // about who wrote this file.
    return emptyAgentLines();
  }
  cache.set(key, read);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return read;
}

/** Forget this file's answer. Called wherever the file is written, because a
 *  write is the only thing that changes it. */
export function dropAgentLines(root: string, file: string): void {
  cache.delete(agentKey(root, file));
}

/** Drop everything. For tests, and for leaving a project. */
export function clearAgentLinesCache(): void {
  cache.clear();
}

/**
 * What the widget says about a line.
 *
 * The session's own name when the caller knows it (the chat tab is open), else
 * a short form of the id: the label has to name *which* chat, and every session
 * has an id long before it has a title.
 */
export function agentLabel(turn: AgentTurn, sessionName?: string): string {
  const who = sessionName?.trim() || turn.session_id.slice(0, 8);
  return `${who}, turn ${turn.ordinal}`;
}

/**
 * The chat's own id for the turn a checkpoint timestamp names, or null.
 *
 * The two namings exist because they are recorded by different things: a
 * checkpoint is named by the prompt's timestamp, which is what the backend can
 * see, while the transcript is threaded by turn id, which only the tab running
 * the turn learns. `turnStarted` writes both at once, so the map is exact for
 * every turn that tab ran - and empty for a replayed one, which is why this
 * answers null rather than guessing at the nearest.
 */
export function turnIdAt(stamps: Record<string, number>, promptTs: number): string | null {
  return Object.entries(stamps).find(([, ts]) => ts === promptTs)?.[0] ?? null;
}

/**
 * What a chat tab should do with a "show me that turn" request, or null when
 * the request names a different session.
 *
 * A decision rather than a handler, for the reason `revertGuard` and
 * `canPlaceBlame` are: it has three outcomes and each of them is a choice
 * (ignore it; come forward and scroll; come forward and stay put), and testing
 * three choices should not cost a mounted chat panel.
 *
 * `turnId: null` still means come forward. A replayed transcript has no stamps
 * for turns it did not run, and bringing the conversation into view is most of
 * what the reader asked for; scrolling to the nearest turn instead would point
 * them at one that did not write the line.
 */
export function revealTarget(
  mine: string,
  stamps: Record<string, number>,
  ev: { sessionId: string; promptTs: number },
): { turnId: string | null } | null {
  if (ev.sessionId !== mine) return null;
  return { turnId: turnIdAt(stamps, ev.promptTs) };
}
