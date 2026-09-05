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
  // Command tabs group under `shells:`, which is no unit's key.
  workspace: string;
  // Every shell/agent/task tab hosts a login shell; an agent or task tab is that
  // shell seeded with `init`. Command tabs (clone/bootstrap) spawn the program
  // directly. A chat tab hosts no PTY at all: it drives the agent as a
  // stream-json child through the chat host, and renders `ChatView` instead of
  // `TerminalView`.
  kind: TabKind;
  program: string;
  args: string[];
  // Which signed-in account of `program` this tab runs as. `null` is the
  // default profile, which is the agent's home variable left unset. Required
  // rather than optional so a new opener cannot forget it and silently spawn
  // somebody else's account; bound at spawn and never switched afterwards.
  profile: string | null;
  // Agent and task tabs: the command line typed into the shell once it's ready.
  // Exiting the agent, or a task finishing, drops back to the live shell rather
  // than closing the tab.
  init?: string;
  // The profile's home variable, so the agent reads and writes that account
  // rather than the default one. Derived from `profile` at spawn and on
  // restore rather than persisted: the home path is Sway's to resolve, and a
  // stored copy would go stale the moment a profile home moved.
  env?: Record<string, string>;
  // Command tabs: what to re-read once the command reports. A clone that never
  // re-discovers never appears; a sign-in that never re-probes still reads as
  // signed out. Set at open and never changed, so neither replaces the tab.
  rediscoverOnExit?: boolean;
  recheckAgentsOnExit?: boolean;
  // Command tabs: the workspace that was on screen when this one opened, so an
  // auto-close that empties the group can hand the window back. Empty for a tab
  // opened from somewhere that is not a branch unit.
  bornIn?: string;
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

/**
 * How much of a tab exists yet.
 *
 * - `inert`: a strip entry and nothing else. No surface mounted, no process, no
 *   claim. A restored tab starts here, and reaching for it is what builds it.
 * - `open`: the surface is mounted and can be read, but nothing is running.
 * - `live`: a PTY, or a chat child, is attached.
 *
 * Monotonic. Nothing walks a tab back: every step forward spawns or mounts
 * something a step back would have to tear down, and tearing down is what
 * closing a tab is for.
 */
export type TabState = "inert" | "open" | "live";

const RANK: Record<TabState, number> = { inert: 0, open: 1, live: 2 };

/**
 * The states this kind passes through, in order.
 *
 * Only chat has `open`. A PTY with no process has nothing to render, so there
 * is no readable middle for a terminal kind to sit in - the first reach for one
 * spawns it.
 */
export const statesFor = (kind: TabKind): TabState[] =>
  kind === "chat" ? ["inert", "open", "live"] : ["inert", "live"];

/**
 * Where a tab nothing has recorded a state for sits.
 *
 * Every tab opened by a user gesture is already as far along as it goes: a
 * shell spawns its PTY on mount, a fork or a resume opens with its session, and
 * a new chat is `open` until its first send mints one. Only a restore has a tab
 * that is less than that, and it says so explicitly.
 */
const defaultState = (t: OpenTerm): TabState => (isChatDraft(t) ? "open" : "live");

// Keyed by tab id, in a signal rather than a field on `OpenTerm`, for the
// reason `tabTitles` below is: the strip keys tabs by identity (gotcha #64) and
// never re-renders a still-mounted tab, so a plain-property read would not
// repaint when a tab wakes up. A signal read does.
const [tabStates, setTabStates] = createSignal<Record<string, TabState>>({});

export const tabState = (t: OpenTerm): TabState => tabStates()[t.id] ?? defaultState(t);

/**
 * Move a tab forward, or refuse.
 *
 * Monotonic by construction: a state this kind does not have, or one at or
 * behind where the tab already is, is refused rather than clamped, so a caller
 * that meant to go back finds out here instead of appearing to work.
 */
export function advanceTabState(t: OpenTerm, next: TabState): boolean {
  if (!statesFor(t.kind).includes(next)) return false;
  if (RANK[next] <= RANK[tabState(t)]) return false;
  setTabStates({ ...tabStates(), [t.id]: next });
  return true;
}

/**
 * Start a tab at `inert`.
 *
 * The one write that does not move forward, which is why it is not
 * `advanceTabState`: it says where a tab *begins*, before there is a tab. Only
 * a restore has anything to say here. Seeding an id that already carries a
 * state is refused, since that would be the backward move the model exists to
 * prevent.
 */
export function seedInert(id: string): void {
  if (id in tabStates()) return;
  setTabStates({ ...tabStates(), [id]: "inert" });
}

/**
 * The one step activating this tab takes.
 *
 * An inert tab wakes up; anything further along stays exactly where it is, so
 * clicking a tab twice is not two steps, and clicking an already-open draft is
 * not a spawn.
 */
export const stateOnActivate = (t: OpenTerm): TabState =>
  tabState(t) === "inert" ? statesFor(t.kind)[1] : tabState(t);

/** A closed tab leaves no state behind, or a future tab reusing the id would
 *  inherit it (restore reuses stored ids since Phase 1). */
export function dropTabState(id: string): void {
  if (!(id in tabStates())) return;
  const next = { ...tabStates() };
  delete next[id];
  setTabStates(next);
}

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
  setTabStates({});
  setActiveWorkspace(null);
  setActiveByWorkspace({});
}
