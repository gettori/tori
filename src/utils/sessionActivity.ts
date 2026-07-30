// What every live session is doing right now, and the OS surfaces that follow
// from it: the tray, the dock badge, and the needs-you notification.
//
// This was ~200 lines of LeftSidebar's closure. It never belonged there: the
// tray and the dock badge are app-wide, the composition reads nothing the tree
// owns, and Phase 5's History panel needs the same answer without mounting a
// sidebar. `chatSessions.ts` is the model - a module-level store the surfaces
// read, rather than state a panel lends out.
//
// **Three tiers, in descending certainty**, decided by the pure
// `computeSessionDot` (see `sessionDot.ts`, pinned by a golden fixture). This
// module only gathers that function's inputs and keeps them fresh:
//
//   * a **chat** reports its own status through its event stream (exact);
//   * a **PTY agent tab** is composed from a pgrep probe, PTY output activity
//     and the transcript tail (inferred);
//   * a **detached** session, with no tab at all, caps at "running".
//
// Four things it cannot derive and must be told, via the `note*` setters: the
// live tab set, which space and project owns a folder, what the sidebar has
// selected, and whether the window has focus. Everything else it owns.
import { createSignal, createMemo, createEffect, createRoot, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { LiveTab } from "./events";
import { sessions } from "./sessionStore";
import { liveChats, liveChatIds } from "./chatSessions";
import {
  statusFromDot,
  dotFromStatus,
  type SessionStatus,
  type LiveSessionStatus,
} from "./sessionStatus";
import {
  computeSessionDot,
  dotCertainty,
  type SessionDot,
  type SessionDotInputs,
  type StatusCertainty,
} from "./sessionDot";
import {
  notePresence,
  markSessionAttended,
  liveCounts,
  trayEntries,
  unattendedNeedsYouCount,
  shouldSuppressNotification,
  notifyNeedsYou,
  lastTransition,
  attended,
  type LiveSessionDot,
} from "./presence";

// Mirrors src-tauri/src/sessions.rs's `TailState` (session_tail_state).
export type TailState = "working" | "done" | "blocked-candidate";

/** Which space and project owns a branch-unit folder. Display metadata for the
 *  tray and the notification, which the store cannot work out for itself. */
export type FolderOwner = { spaceName: string; projectName: string };

// --- fed inputs -------------------------------------------------------------

const [liveTabs, setLiveTabs] = createSignal<readonly LiveTab[]>([]);
const [folderOwners, setFolderOwners] = createSignal<Record<string, FolderOwner>>({});
const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
const [windowFocused, setWindowFocused] = createSignal(true);

/** The tab set, from whoever owns it (App, through the sidebar). */
export function noteLiveTabs(tabs: readonly LiveTab[]) {
  setLiveTabs(tabs);
}

/** folderPath -> owning space and project, rebuilt whenever the config does. */
export function noteFolderOwners(owners: Record<string, FolderOwner>) {
  setFolderOwners(owners);
}

/** The sidebar's current selection, and whether the window has focus. Together
 *  they are "you are looking at this", which decides both what counts as
 *  attended and which needs-you edges are worth a notification. */
export function noteAttention(sessionId: string | null, focused: boolean) {
  setSelectedSessionId(sessionId);
  setWindowFocused(focused);
}

// --- owned state ------------------------------------------------------------

// Per-session probe cache for the row status dot: last known liveness, keyed by
// session id, plus the agent used (so a later re-probe of a detached session
// does not need a session-store lookup). Probing is trigger-driven only (row
// selection, sessions://changed, window focus) - never a periodic pgrep.
const [probes, setProbes] = createSignal<Record<string, { agent: string; running: boolean }>>({});

// PTY activity is keyed by the *tab* id (pty_spawn's id), not the session id:
// `pty://activity` fires per hosted shell, so it is cross-referenced through
// the tab set. Transcript-tail state is keyed by session id instead.
const [ptyActivity, setPtyActivity] = createSignal<Record<string, "active" | "quiet">>({});
const [tailStates, setTailStates] = createSignal<Record<string, TailState>>({});

/** Probe a set of sessions at once. Every id asked about is recorded, including
 *  the ones that came back absent, so a session that has since exited flips to
 *  false rather than keeping its last answer. */
export async function probeBatch(want: readonly { id: string; agent: string }[]) {
  const running = new Set(
    await invoke<string[]>("sessions_running", { sessions: want }).catch(() => [] as string[]),
  );
  setProbes((m) => {
    const next = { ...m };
    for (const w of want) next[w.id] = { agent: w.agent, running: running.has(w.id) };
    return next;
  });
}

export const probeSession = (id: string, agent: string) => probeBatch([{ id, agent }]);

/** Re-probe every session whose dot could currently be non-"none": every live
 *  tab's session (catches solid -> none, e.g. a Ctrl+C exit-to-shell) and every
 *  previously-confirmed detached session (catches hollow -> none, e.g. it
 *  exited). Called from sessions://changed and window focus only. */
export function probeActive() {
  const seen = new Set<string>();
  const want: { id: string; agent: string }[] = [];
  for (const t of liveTabs()) {
    if (!t.sessionId || seen.has(t.sessionId)) continue;
    seen.add(t.sessionId);
    want.push({ id: t.sessionId, agent: t.agent ?? probes()[t.sessionId]?.agent ?? "claude" });
  }
  for (const [id, p] of Object.entries(probes())) {
    if (p.running && !seen.has(id)) {
      seen.add(id);
      want.push({ id, agent: p.agent });
    }
  }
  // One call for the whole set: this fires on every sessions://changed, so a
  // probe per session made a busy window pay a subprocess per open tab.
  if (want.length > 0) void probeBatch(want);
}

/** Record a PTY liveness edge, and re-read that session's tail when it moves.
 *  The hooks-status file carrying claude's ground-truth status is not
 *  file-watched, so without this the UI only refreshes on a transcript write
 *  (itself trailing-debounced), leaving a stale `blocked-candidate` pinned
 *  after the user answers - which flaps the dot needsYou<->working on every TUI
 *  redraw and re-fires the notification each time. */
export function notePtyActivity(tabId: string, state: "active" | "quiet") {
  const prev = ptyActivity()[tabId];
  setPtyActivity((m) => ({ ...m, [tabId]: state }));
  if (prev === state) return;
  const tab = liveTabs().find((t) => t.id === tabId);
  if (tab?.sessionId) void refreshTailStateForSession(tab.sessionId);
}

/** Re-read the transcript tail of every live agent tab. */
export async function refreshTailStates() {
  const live = liveTabs().filter((t) => t.kind === "agent" && t.sessionId);
  if (!live.length) return;
  const all = Object.values(sessions()).flat();
  const updates: Record<string, TailState> = {};
  await Promise.all(
    live.map(async (t) => {
      const meta = all.find((s) => s.id === t.sessionId);
      if (!meta) return;
      const agent = meta.agent === "pi" ? "pi" : "claude";
      const state = await invoke<TailState>("session_tail_state", {
        id: meta.id,
        path: meta.path,
        agent,
      }).catch(() => null);
      if (state) updates[t.sessionId!] = state;
    }),
  );
  if (Object.keys(updates).length) setTailStates((m) => ({ ...m, ...updates }));
}

/** Re-read one session's tail on demand. */
export async function refreshTailStateForSession(sessionId: string) {
  const t = liveTabs().find((t) => t.kind === "agent" && t.sessionId === sessionId);
  if (!t) return;
  const meta = Object.values(sessions())
    .flat()
    .find((s) => s.id === sessionId);
  if (!meta) return;
  const agent = meta.agent === "pi" ? "pi" : "claude";
  const state = await invoke<TailState>("session_tail_state", {
    id: meta.id,
    path: meta.path,
    agent,
  }).catch(() => null);
  if (state) setTailStates((m) => ({ ...m, [sessionId]: state }));
}

// --- composition ------------------------------------------------------------

function sessionDotInputs(id: string): SessionDotInputs {
  const tab = liveTabs().find((t) => t.sessionId === id);
  return {
    chatStatus: liveChats().find((c) => c.sessionId === id)?.status,
    hasLiveTab: !!tab,
    running: probes()[id]?.running === true,
    ptyActivity: tab ? ptyActivity()[tab.id] : undefined,
    tailState: tailStates()[id],
  };
}

export function sessionDot(id: string): SessionDot {
  return computeSessionDot(sessionDotInputs(id));
}

/** Whether this session's status was measured or inferred, for the marker the
 *  row renders. Only the exact side is marked. */
export function sessionCertainty(id: string): StatusCertainty {
  return dotCertainty(sessionDotInputs(id));
}

/** The same dot in the Antigravity status vocabulary: a pure remap. */
export function sessionStatus(id: string): SessionStatus {
  return statusFromDot(sessionDot(id));
}

// Every live session's composed dot plus display metadata, recomputed whenever
// any input changes. Shared by the presence tracker, the tray and the dock
// badge, so the three cannot drift by rebuilding it independently.
const liveSessionDots = createMemo<LiveSessionDot[]>(() => {
  const all = Object.values(sessions()).flat();
  const live: LiveSessionDot[] = [];
  for (const t of liveTabs()) {
    if (t.kind !== "agent" || !t.sessionId) continue;
    const meta = all.find((s) => s.id === t.sessionId);
    live.push({
      sessionId: t.sessionId,
      dot: sessionDot(t.sessionId),
      sessionName: meta?.name || meta?.title || t.sessionId,
      projectName: folderOwners()[t.workspace]?.projectName ?? "",
      folderPath: t.workspace,
      tabId: t.id,
    });
  }
  // The chat tier needs none of the composition above: its own event stream
  // says when a turn is running and when a tool call is blocked.
  for (const c of liveChats()) {
    live.push({
      sessionId: c.sessionId,
      dot: dotFromStatus(c.status),
      sessionName: c.sessionName,
      projectName: folderOwners()[c.folderPath]?.projectName ?? "",
      folderPath: c.folderPath,
      tabId: c.tabId,
    });
  }
  return live;
});

// The same set in the status vocabulary, covering every space rather than the
// active one. This is what the rollup badges, the revert guard and the editor's
// diff gate all read, so both tiers belong in it: a chat that is waiting is
// waiting on exactly the same terms as a blocked PTY agent, and a consumer that
// had to union the two lists itself would be a second place for them to
// disagree. `recordedBranch` and `agent` come from the session store rather
// than from the tab, because a tab descriptor carries neither, and without them
// a plain repo's sibling branch units cannot tell their sessions apart.
const liveSessionStatuses = createMemo<LiveSessionStatus[]>(() => {
  const all = Object.values(sessions()).flat();
  const live: LiveSessionStatus[] = [];
  for (const t of liveTabs()) {
    if (t.kind !== "agent" || !t.sessionId) continue;
    const meta = all.find((s) => s.id === t.sessionId);
    const owner = folderOwners()[t.workspace];
    live.push({
      sessionId: t.sessionId,
      status: sessionStatus(t.sessionId),
      sessionName: meta?.name || meta?.title || t.sessionId,
      spaceName: owner?.spaceName ?? "",
      projectName: owner?.projectName ?? "",
      folderPath: t.workspace,
      tabId: t.id,
      recordedBranch: meta?.branch || undefined,
      agent: meta?.agent,
    });
  }
  for (const c of liveChats()) {
    const meta = all.find((s) => s.id === c.sessionId);
    const owner = folderOwners()[c.folderPath];
    live.push({
      sessionId: c.sessionId,
      status: c.status,
      sessionName: c.sessionName,
      spaceName: owner?.spaceName ?? "",
      projectName: owner?.projectName ?? "",
      folderPath: c.folderPath,
      tabId: c.tabId,
      recordedBranch: meta?.branch || undefined,
      agent: meta?.agent,
    });
  }
  return live;
});

export { liveSessionDots, liveSessionStatuses };

/** Whether the editor should poll `sessionId`'s accumulated diff.
 *
 *  Executing, **and not a chat**. The status list covers both tiers now, but a
 *  chat renders its own diff per tool call straight from its event stream;
 *  polling underneath it would be a second, slower answer to a question already
 *  answered exactly. `liveChatIds()` is the discriminator rather than a tier
 *  field on the status, because it already exists and the status type is shared
 *  with surfaces that have no reason to care which tier a session is. */
export function shouldPollAccumulatedDiff(sessionId: string | null | undefined): boolean {
  if (!sessionId || liveChatIds().has(sessionId)) return false;
  return liveSessionStatuses().some((s) => s.sessionId === sessionId && s.status === "executing");
}

// Chats whose tab is the one on screen. A chat that blocks in the pane you are
// watching needs no notification, and the selection cannot tell us that: a
// chat's session id is minted before its transcript exists, so clicking its tab
// resolves only as far as its branch.
const onScreenChats = () => new Set(liveChats().filter((c) => c.visible).map((c) => c.sessionId));

// --- the surfaces -----------------------------------------------------------
//
// One app-lifetime root, because these outlive any component that reads them:
// the tray and the dock badge must keep tracking whether or not the sidebar is
// mounted, and there is nothing to dispose short of the app closing.
createRoot(() => {
  // Feed the presence tracker on every change, so the OS notification, tray and
  // badge share one source of truth instead of re-deriving it independently.
  createEffect(() => notePresence(liveSessionDots()));

  // A session reads as attended once it is both the current selection and the
  // window has focus - the same "you're looking at it" signal focusOrResume
  // already uses to bring a tab to the front.
  createEffect(() => {
    const id = selectedSessionId();
    if (id && windowFocused()) markSessionAttended(id);
  });

  // OS notification on the needs-you rising edge, suppressed if you are already
  // looking at that exact session when it blocks.
  createEffect(
    on(lastTransition, (event) => {
      if (!event) return;
      if (shouldSuppressNotification(event, selectedSessionId() ?? undefined, windowFocused(), onScreenChats()))
        return;
      void notifyNeedsYou(event);
    }),
  );

  // Tray + dock badge, from the same live list. Both are cheap and infrequent
  // (agent state transitions, not PTY bytes), so a plain rebuild-on-change is
  // simpler than an incremental update.
  createEffect(() => {
    const live = liveSessionDots();
    const { running, needsYou } = liveCounts(live);
    invoke("update_tray", { running, needsYou, entries: trayEntries(live) }).catch(() => {});
  });
  createEffect(() => {
    invoke("set_badge_count", {
      count: unattendedNeedsYouCount(liveSessionDots(), attended()),
    }).catch(() => {});
  });
});

/** Drop every measurement. Test support, named so it cannot be mistaken for
 *  part of the store's real API: this state is app-lifetime, so without it a
 *  test that renders twice inherits the first render's probes and tails. */
export function resetSessionActivityForTests() {
  setProbes({});
  setPtyActivity({});
  setTailStates({});
  setLiveTabs([]);
  setFolderOwners({});
  setSelectedSessionId(null);
  setWindowFocused(true);
}
