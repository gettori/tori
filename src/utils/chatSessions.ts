// Every chat session Sway is hosting right now, and what it is doing.
//
// The counterpart of `sessionStatus.ts` for the chat surface: that module is
// fed by LeftSidebar, which composes a PTY agent tab's status out of a pgrep
// probe, PTY activity and the transcript tail. A chat needs none of that
// guesswork - its own event stream says exactly when a turn is running - so it
// registers here directly, and consumers that ask "who could be writing in this
// folder" read both tiers.
//
// This exists as its own module rather than as state inside the chat panel so
// `folderActors` (utils) does not have to import a panel, and so the revert
// guard can be tested against it without mounting anything.
import { createSignal } from "solid-js";
import type { SessionStatus } from "./sessionStatus";

export type LiveChat = {
  sessionId: string;
  sessionName: string;
  /** The branch-unit folder the chat tab is grouped under. */
  folderPath: string;
  tabId: string;
  status: SessionStatus;
  /** Is this chat the tab currently on screen? Read by presence: an approval
   *  that blocks in the chat you are watching does not need an OS notification
   *  telling you about it. The sidebar selection cannot answer this - a chat
   *  mints its session id before any transcript exists, so selecting its tab
   *  usually resolves only as far as its branch. */
  visible: boolean;
};

const [liveChats, setLiveChats] = createSignal<LiveChat[]>([]);
export { liveChats };

/** Register or update one chat. Called from the chat panel's status effect, so
 *  a turn starting is visible to the revert guard on the same tick. */
export function setLiveChat(entry: LiveChat) {
  setLiveChats((prev) => {
    const at = prev.findIndex((c) => c.sessionId === entry.sessionId);
    if (at === -1) return [...prev, entry];
    const next = prev.slice();
    next[at] = entry;
    return next;
  });
}

/** A chat tab closed. Its session may still exist on disk, at which point the
 *  detached tier takes over reporting it. */
export function dropLiveChat(sessionId: string) {
  setLiveChats((prev) => prev.filter((c) => c.sessionId !== sessionId));
}

/** Session ids currently hosted in a chat tab, so the pgrep-based detached tier
 *  does not report them a second time (at a lower certainty than the exact
 *  status we already have). */
export function liveChatIds(): Set<string> {
  return new Set(liveChats().map((c) => c.sessionId));
}

/** How many chats are live in a worktree. Feeds both the "second chat on this
 *  worktree" notice and the checkpoint attribution marker. */
export function chatsInFolder(folderPath: string): LiveChat[] {
  return liveChats().filter((c) => c.folderPath === folderPath);
}
