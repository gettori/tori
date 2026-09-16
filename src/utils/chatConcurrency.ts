// What happens when a worktree hosts more than one live chat.
//
// Several chats per branch is the point of the chat surface, but it lands on a
// checkpoint layer that was written when a worktree had at most one live agent:
// `checkpoint.rs` keys its refs per session yet snapshots the whole tree with
// `git add -A`, so with two chats writing into one working tree each turn's
// snapshot also contains the other's edits. The real fix is per-turn attribution
// from `toolCallCompleted.files`, which is a later phase.
//
// The attribution work has since landed: `checkpoint.rs` records each session's
// own `toolCallCompleted.files` per turn and intersects them with the tree diff,
// so a turn's file list and its revert are now scoped to what that session
// actually wrote. **The unreliable marker is gone with it.**
//
// The one-time notice stays. It was never about attribution being wrong: the
// working tree is genuinely shared state, and two agents editing one checkout
// can still interleave writes to the same file, race each other's builds, and
// see each other's half-finished work. Attribution says who wrote what; it does
// not make concurrent editing of one tree safe, and no attribution scheme
// would.
import { createSignal } from "solid-js";

const LS_NOTICED = "tori.multiChatNotice";

/** Worktrees whose multi-chat notice has already been shown and dismissed.
 *  Tolerant of anything in storage: junk reads as "nothing dismissed" rather
 *  than throwing on startup. */
function loadNoticed(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_NOTICED) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

// Shared, not per-panel. The notice appears in *both* chats sharing a worktree,
// so a private copy per panel would leave the banner up in the other one after
// it had been dismissed in the first.
const [noticed, setNoticed] = createSignal<ReadonlySet<string>>(loadNoticed());
export { noticed };

/** Dismiss this worktree's notice, everywhere, for good. */
export function markNoticed(folderPath: string): void {
  const seen = new Set(noticed()).add(folderPath);
  setNoticed(seen);
  try {
    localStorage.setItem(LS_NOTICED, JSON.stringify([...seen]));
  } catch {
    /* quota or private mode: the notice degrades to being shown again */
  }
}

/** Should this worktree's notice be shown? Only from the second live chat, and
 *  only until it has been dismissed once. */
export function shouldNotice(liveChatCount: number, folderPath: string, seen: ReadonlySet<string>): boolean {
  return liveChatCount > 1 && !seen.has(folderPath);
}

export const MULTI_CHAT_NOTICE =
  "Another chat is already running in this worktree. They share one working tree, so the two can edit the same files at the same time. Each turn's changes and reverts are attributed per session, but a shared file is marked rather than silently assigned to one.";

/**
 * Is this chat one of the ones past the cap?
 *
 * Answered by *position*, not by the total: the chats that were already running
 * when the cap was reached are not the ones to nag, and a banner appearing in
 * every open tab at once reads as a fault rather than as a consequence. So the
 * warning attaches to the chats opened past the line, which is where the choice
 * to open another one was actually made.
 *
 * `liveIds` is in registration order, which is open order. **Zero, or anything
 * below it, is no cap at all**, matching the setting's "zero means unlimited".
 */
export function pastCap(sessionId: string, liveIds: readonly string[], cap: number): boolean {
  if (cap <= 0) return false;
  const at = liveIds.indexOf(sessionId);
  return at >= cap;
}

/**
 * What the over-cap chat says.
 *
 * Names both ways out, because the cap is a warning rather than a refusal and a
 * warning that does not say what to do about it is just noise. It carries no
 * dismiss: the condition is live, and closing a chat or raising the cap takes it
 * away, where a dismissal would hide the cost while it went on being paid.
 */
export function capNotice(live: number, cap: number): string {
  return `${live} chats are running at once, past your limit of ${cap}. Each one is a live agent process with its own token spend. Close one, or raise the limit in Settings.`;
}

/**
 * A label that tells one chat from the others already open on the same branch.
 *
 * Several chats per branch is the point of the surface, and three tabs all
 * reading "tori chat" would make the tab bar useless. Superseded per tab by the
 * session's own name once its transcript exists.
 *
 * Taken against the labels actually in use rather than against a count: closing
 * the first chat and opening another would otherwise hand out a number the
 * still-open second chat already has.
 */
export function chatTabLabel(baseName: string, taken: readonly string[]): string {
  const used = new Set(taken);
  const nth = (n: number) => (n === 1 ? `${baseName} chat` : `${baseName} chat ${n}`);
  for (let n = 1; ; n++) {
    const label = nth(n);
    if (!used.has(label)) return label;
  }
}

