// The terminal pane's tab model, module-level so the unified tab store (plan
// phase 4) can compose it without mounting the panel; sessionStore is the
// precedent. Terminal.tsx resets it at setup: the lifetime still tracks the panel.
import { createSignal } from "solid-js";
import { noteTabFocus } from "../../layout/layoutStore";

// A `task` tab is a shell tab seeded with the task's command line, kept a kind
// of its own for one reason: `tabPersist` restores shell tabs, and restoring a
// task would either re-run it or bring back a bare shell wearing its name.
// Excluded there exactly as a command tab is, and for the same reason.
export type TabKind = "shell" | "agent" | "command" | "chat" | "task";

export type OpenTerm = {
  id: string;
  title: string;
  cwd: string;
  // The branch-unit anchor this tab is grouped under (the selected folderPath at
  // spawn), NOT the tab cwd: a nested session still groups with its branch unit.
  // Command tabs (clone/bootstrap) group under their own cwd.
  workspace: string;
  // Every shell/agent/task tab hosts a login shell; an agent or task tab is that
  // shell seeded with `init`. Command tabs (clone/bootstrap) spawn the program
  // directly. A chat tab hosts no PTY at all: it drives the agent as a
  // stream-json child through the chat host, and renders `ChatView` instead of
  // `TerminalView`.
  kind: TabKind;
  program: string;
  args: string[];
  // Agent and task tabs: the command line typed into the shell once it's ready.
  // Exiting the agent, or a task finishing, drops back to the live shell rather
  // than closing the tab.
  init?: string;
  // Sign-in tabs: the profile's home variable, so the agent writes that
  // account's credentials rather than the default account's.
  env?: Record<string, string>;
  // Agent tabs: the soft session id (the resumed uuid), distinct from the stable
  // shell tab id. Used to focus/resume in place (Phase 2), not for spawning.
  //
  // A chat tab carries one from the moment it has a session, which for a fork, a
  // rewind and a resume is the moment it opens. A new chat opens *without* one:
  // it is a draft until its first message, and the id is minted then, per
  // attempt. So on a chat tab, this field is what says whether anything has been
  // started here at all - see `isChatDraft`.
  sessionId?: string;
  // Chat tabs: is this session already on disk (a restore), or brand new?
  resume?: boolean;
  // Chat tabs: the session this one was forked from. Its history is replayed
  // into this new id, and the two diverge from that point. Distinct from
  // `resume`, which continues writing the *same* session.
  forkFrom?: string;
  // Chat tabs: set when this tab is a rewind of `forkFrom` rather than a plain
  // fork. The checkpoint the worktree was put back to, which is also where the
  // replayed history is cut.
  rewindTo?: number;
  // Fresh (non-resumed) agent tabs only: when this tab was spawned, epoch
  // seconds. Used to attribute the session that appears afterward (see
  // `backfillFreshSessions`).
  spawnedAt?: number;
};

/**
 * A chat tab with nothing started behind it: no child process, no claimed
 * session id, nothing registered as live. The composer is the whole of it, and
 * the first message is what turns it into a chat.
 *
 * Asked structurally rather than carried as a flag, because there is exactly one
 * thing that makes a chat real and this is it.
 */
export const isChatDraft = (t: OpenTerm) => t.kind === "chat" && !t.sessionId;

/**
 * Whether this chat tab can go **back** to being a draft after a first send that
 * never reached a session.
 *
 * Only a tab that was one to begin with. A fork and a rewind replay a history a
 * draft cannot represent, and a resume is a conversation that already exists on
 * disk; turning either into an empty draft would quietly drop the lineage that
 * was the reason for opening it. Those keep their own error surface instead.
 */
export const canRevertToDraft = (t: OpenTerm) => t.kind === "chat" && !t.forkFrom && !t.resume;

const [open, setOpen] = createSignal<OpenTerm[]>([]);
// Live tab labels that can change after a tab is created (a session rename),
// keyed by tab id and overriding OpenTerm.title when present. Kept in a signal
// rather than mutated onto the tab object because the tab bar keys tabs by
// identity (gotcha #64) and never re-runs renderTab for a still-mounted tab,
// so a plain-property title read would not repaint; a signal read does.
const [tabTitles, setTabTitles] = createSignal<Record<string, string>>({});
const tabTitle = (t: OpenTerm) => tabTitles()[t.id] ?? t.title;
// Tabs are grouped by workspace (branch-unit folder). Only the active
// workspace's tabs show in the bar/stage; every other group stays mounted and
// CSS-hidden so its PTYs keep running (gotcha #64). `activeWorkspace` is the
// group on screen; `activeByWorkspace` remembers the focused tab per group.
const [activeWorkspace, setActiveWorkspace] = createSignal<string | null>(null);
const [activeByWorkspace, setActiveByWorkspace] = createSignal<Record<string, string>>({});

const tabsIn = (ws: string) => open().filter((t) => t.workspace === ws);
// The single visible tab: the active workspace's remembered tab, falling back
// to its first tab when that record is unset or points at a closed tab.
const visibleId = (): string | null => {
  const ws = activeWorkspace();
  if (!ws) return null;
  const tabs = tabsIn(ws);
  const recorded = activeByWorkspace()[ws];
  if (recorded && tabs.some((t) => t.id === recorded)) return recorded;
  return tabs.length ? tabs[0].id : null;
};
function focusTab(ws: string, id: string) {
  noteTabFocus(id);
  setActiveWorkspace(ws);
  setActiveByWorkspace({ ...activeByWorkspace(), [ws]: id });
}

export {
  open,
  setOpen,
  tabTitles,
  setTabTitles,
  tabTitle,
  activeWorkspace,
  setActiveWorkspace,
  activeByWorkspace,
  setActiveByWorkspace,
  tabsIn,
  visibleId,
  focusTab,
};

// Called from Terminal.tsx's setup, nowhere else: the panel mounts once per app
// run, so this keeps the model's lifetime what it was before the extraction
// (and gives repeated test mounts a fresh model without touching the tests).
export function resetTerminalTabModel() {
  setOpen([]);
  setTabTitles({});
  setActiveWorkspace(null);
  setActiveByWorkspace({});
}
