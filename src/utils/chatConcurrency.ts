// What happens when a worktree hosts more than one live chat.
//
// Several chats per branch is the point of the chat surface, but it lands on a
// checkpoint layer that was written when a worktree had at most one live agent:
// `checkpoint.rs` keys its refs per session yet snapshots the whole tree with
// `git add -A`, so with two chats writing into one working tree each turn's
// snapshot also contains the other's edits. The real fix is per-turn attribution
// from `toolCallCompleted.files`, which is a later phase.
//
// So this phase ships the interim rather than the silence: a one-time notice
// when the second chat opens on a worktree, and an explicit unreliable marker on
// that worktree's checkpoint timeline. Both are removed by the attribution work,
// which is why the predicate lives here as one named thing rather than as an
// inline `length > 1` at each site.
import { createSignal } from "solid-js";
import { chatsInFolder } from "./chatSessions";

const LS_NOTICED = "sway.multiChatNotice";

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
  "Another chat is already running in this worktree. They share one working tree, so until per-turn attribution lands, a checkpoint may include the other chat's edits.";

/**
 * Is checkpoint turn-attribution trustworthy for this worktree right now?
 *
 * False whenever two chats are live in it. The timeline says so rather than
 * presenting cross-contaminated turns as fact. Removed by the phase that lands
 * real per-turn attribution.
 */
export function attributionReliable(folderPath: string): boolean {
  return chatsInFolder(folderPath).length <= 1;
}

/**
 * A label that tells one chat from the others already open on the same branch.
 *
 * Several chats per branch is the point of the surface, and three tabs all
 * reading "sway chat" would make the tab bar useless. Superseded per tab by the
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

export const ATTRIBUTION_UNRELIABLE_NOTE =
  "Two chats are running in this worktree. Each checkpoint snapshots the whole tree, so a turn shown here may include the other chat's file changes.";
