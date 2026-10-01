// Every chat session Tori is hosting right now, and what it is doing.
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
import { awaitingUser, type SessionStatus } from "./sessionStatus";

export type LiveChat = {
  sessionId: string;
  sessionName: string;
  /** Which adapter is running it. Read by the usage poll, which asks an agent
   *  for its quota on a background tick only while a chat of its own is open. */
  agentId: string;
  /** The branch-unit folder the chat tab is grouped under. */
  folderPath: string;
  tabId: string;
  status: SessionStatus;
  /** What a `waitingOnBackground` chat is waiting on, for its tab's tooltip. */
  background?: { agents: number; tasks: number };
  /** Is this chat the tab currently on screen? Read by presence: an approval
   *  that blocks in the chat you are watching does not need an OS notification
   *  telling you about it. The sidebar selection cannot answer this - a chat
   *  mints its session id before any transcript exists, so selecting its tab
   *  usually resolves only as far as its branch. */
  visible: boolean;
  /** The session that spawned it, which relays its questions while it is
   *  there to; see `relayed` in sessionActivity. */
  spawner?: string;
  /** When its last turn ran to completion, in epoch milliseconds. Read by
   *  presence to tell a turn that finished from one that was cancelled, failed,
   *  replayed from history, or has a queued message about to follow it. */
  doneAt?: number;
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

/** Would a stop do anything to this chat?
 *
 *  A blocked chat counts: waiting on an approval or on a question, it is still
 *  mid-turn, and stopping is a reasonable answer to a prompt you do not want to
 *  grant. Excluding it would make the one state where a user most wants out the
 *  one state stop is unavailable in. */
export function isStoppable(status: SessionStatus): boolean {
  return status === "executing" || awaitingUser(status);
}

export function stoppableChats(chats: readonly LiveChat[]): LiveChat[] {
  return chats.filter((c) => isStoppable(c.status));
}

/**
 * Which chat an unqualified "stop" means, or null when the answer is not
 * obvious.
 *
 * The whole point of the hotkey is to work from an unfocused pane, so it cannot
 * resolve to "the chat that has focus". It resolves to the chat whose tab is on
 * screen, and failing that to the only one running.
 *
 * **Returns null rather than guessing** when several are running and none is on
 * screen. Stopping is destructive of work in progress and unrecoverable - the
 * turn does not resume - so picking one of three by list order would sometimes
 * silently kill the wrong one. The caller says so and points at the palette,
 * where every running chat is named.
 */
export function chatToStop(chats: readonly LiveChat[]): LiveChat | null {
  const running = stoppableChats(chats);
  if (running.length === 0) return null;
  const onScreen = running.find((c) => c.visible);
  if (onScreen) return onScreen;
  return running.length === 1 ? running[0] : null;
}
