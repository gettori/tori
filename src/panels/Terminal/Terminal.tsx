import { createSignal, createEffect, createMemo, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import TerminalView from "./TerminalView";
import ChatView from "../Chat/ChatView";
import OverflowTabBar from "../../components/OverflowTabBar";
import Dropdown from "../../components/Menu/Dropdown";
import Icon from "../../components/Icon/Icon";
import Tab from "../../components/Tab/Tab";
import TabMark from "./TabMark";
import HistoryPanel from "./HistoryPanel";
import Button from "../../components/Button/Button";
import { X, ChevronDown, SquareTerminal, History, CircleDashed } from "lucide-solid";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import {
  on as onEvent,
  onWith,
  emitWith,
  CLOSE_TAB,
  OPEN_TERMINAL,
  NEW_SESSION,
  PURGE_UNDER_PATH,
  SESSION_DELETED,
  type SessionDeleted,
  SEND_TO_SESSION,
  SEND_TO_SESSION_RESULT,
  TOAST,
  TAB_JUMP,
  TAB_CYCLE,
  NEXT_WAITING_SESSION,
  FOCUS_SESSION_TAB,
  TERMINAL_TAB_FOCUSED,
  type OpenTerminal,
  type NewSession,
  type PurgeUnderPath,
  type LiveTab,
  type SendToSession,
  type SendToSessionResult,
  type ToastEvent,
  type TabJump,
  type FocusSessionTab,
  type TerminalTabFocused,
} from "../../utils/events";
import { homeDir } from "@tauri-apps/api/path";
import { refreshAgentHealth } from "../../utils/agentHealth";
import { isUnderPath, sameCwd } from "../../utils/pathScope";
import { agents, ensureAdaptersLoaded, findAdapter, agentIdForProgram, applyTemplate } from "../../utils/agents";
import { BLOCKED_REASON, sanitizeForSend, bracketedPaste, sendWithProbeGate, type ProbeState } from "../../utils/safeSend";
import { type SessionStatus } from "../../utils/sessionStatus";
import type { StatusCertainty } from "../../utils/sessionDot";
import { liveSessionStatuses, sessionStatus } from "../../utils/sessionActivity";
import { sessions } from "../../utils/sessionStore";
import { loadTabs, saveTabs, toStore, mergeStore } from "../../utils/tabPersist";
import { chatTabLabel } from "../../utils/chatConcurrency";
import { liveChatIds, liveChats } from "../../utils/chatSessions";
import { offerToComposer, routeFor } from "../../utils/chatCompose";
import { holdingTab, refusalMessage, type Refusal } from "../../utils/chatOwnership";
import { routeSelection, restoreRoute } from "../../utils/sessionSurface";
import { settings } from "../Settings/settingsStore";
import {
  open,
  setOpen,
  setTabTitles,
  tabTitle,
  activeWorkspace,
  setActiveWorkspace,
  activeByWorkspace,
  tabsIn,
  visibleId,
  focusTab,
  resetTerminalTabModel,
  type OpenTerm,
  type TabKind,
} from "./terminalTabStore";
import styles from "./Terminal.module.css";
import Tooltip from "../../components/Tooltip/Tooltip";

// Mirrors src-tauri/src/sessions.rs's `TailState` (session_tail_state).
type TailState = "working" | "done" | "blocked-candidate";

// The subset of Selection focusOrResume actually reads - narrowed so
// safe-send's resume-into-tab path can call it without fabricating a full
// Selection (spaceName, projectKind, ... it never touches).
type ResumeTarget = Pick<Selection, "sessionId" | "agent" | "sessionFile" | "sessionTitle" | "sessionCwd" | "folderPath">;

// `Reaped` from src-tauri/src/chat/ownership.rs. Only `orphan` reaches the
// screen: `stale` is bookkeeping the backend already cleaned up.
type Reaped =
  | { type: "orphan"; sessionId: string; childPid: number; agent: string }
  | { type: "stale"; sessionId: string };
type ChatOrphan = Extract<Reaped, { type: "orphan" }>;

// `RetiredRuleStore` from src-tauri/src/chat/retired.rs: what the one-time sweep
// of the retired gate's rule store removed.
type RetiredRuleStore = { path: string; files: number; projectRules: number };

// Minimal shape of `list_sessions`' return, just what the backfill needs.
type BackfillSession = { id: string; cwd: string; agent?: string; created_at: number };

// The extra fields restore needs to hand a stored session back to focus-or-resume
// (or to the transcript viewer, for a resume-less adapter).
type RestoreSession = BackfillSession & { path: string; title: string; name?: string };

// Every kind except `chat` is shell-hosted, which is exactly what TerminalView
// takes. Narrowed here rather than by widening TerminalView's prop, because a
// chat tab genuinely cannot be rendered by it.
type PtyTab = OpenTerm & { kind: Exclude<TabKind, "chat"> };
const asPtyTab = (t: OpenTerm): PtyTab | null => (t.kind === "chat" ? null : (t as PtyTab));

// A stable, unique id for a shell-hosted tab. Deliberately not the session uuid:
// one shell can host successive agents, and the uuid is a soft attribute.
function shellId(): string {
  return `sh:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

// The command an agent tab types into its shell once (e.g. "claude --resume x\n").
// Args are single-quoted: they're re-parsed by the shell (unlike a direct spawn),
// so a session-file path containing spaces would otherwise word-split and fail.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function agentInit(program: string, args: string[]): string {
  return `${[program, ...args.map(shQuote)].join(" ")}\n`;
}

export default function Terminal(props: {
  selected: Selection | null;
  onOpenChange?: (tabs: LiveTab[]) => void;
  // First-run onboarding is open: suppress the restore offer until it closes.
  onboarding?: boolean;
}) {
  ensureAdaptersLoaded();
  // The tab model lives in terminalTabStore (module-level, phase 4 composes
  // it); the reset keeps its lifetime tied to this panel exactly as before.
  resetTerminalTabModel();
  // A session-backed tab (agent or chat): its label tracks the session name
  // (renamed from the sidebar), and clicking it moves the sidebar selection to
  // its session.
  const isSessionTab = (t: OpenTerm) => (t.kind === "agent" || t.kind === "chat") && !!t.sessionId;

  // Last run's tab strip, read ONCE here during setup. This read must happen
  // before the persist effect below runs (effects run after the component body,
  // so it does): that effect writes the store from the live open set, which is
  // empty at startup, and would otherwise erase last run's tabs before anyone
  // could be offered them.
  const restorable = loadTabs(Date.now());
  // Workspaces already offered a restore this run, so the offer is one-shot per
  // workspace whether it was accepted or declined.
  const [offered, setOffered] = createSignal<Set<string>>(new Set());

  const workspaceTabs = (): OpenTerm[] => {
    const ws = activeWorkspace();
    return ws ? tabsIn(ws) : [];
  };

  // A user click on a tab: focus it AND move the sidebar selection to match (the
  // reverse of a sidebar selection driving focusOrResume). Deliberately NOT in
  // focusTab, which is also called programmatically from focusOrResume - routing
  // the emit through the user gesture only is what keeps the two from looping.
  // A session tab selects its session; a shell tab selects its branch-unit; a
  // command tab (clone/bootstrap) has no branch home, so it changes nothing.
  function selectTab(t: OpenTerm) {
    focusTab(t.workspace, t.id);
    if (t.kind === "command") return;
    emitWith<TerminalTabFocused>(TERMINAL_TAB_FOCUSED, {
      folderPath: t.workspace,
      sessionId: isSessionTab(t) ? t.sessionId : undefined,
    });
  }

  // Restore offer: per workspace, on first visit each run. Never automatic, so a
  // relaunch never silently spawns agent processes. Suppressed while first-run
  // onboarding is open (and re-evaluated when it closes, since the effect reads
  // the flag), so someone meeting Sway is not handed a restore prompt first.
  // Derived, not accumulated: every path assigns, so the banner belongs to the
  // workspace on screen and disappears with it. An early `return` here would
  // leave the previous workspace's banner up while you look at another one.
  const restoreOffer = createMemo((): { ws: string; count: number } | null => {
    if (props.onboarding) return null;
    const ws = activeWorkspace();
    if (!ws || offered().has(ws)) return null;
    // Only offer into an empty group: if this workspace already has live tabs,
    // the stored set is about to be overwritten by current truth anyway.
    if (tabsIn(ws).length) return null;
    const entry = restorable[ws];
    return entry?.tabs.length ? { ws, count: entry.tabs.length } : null;
  });

  // Both answers close the offer for the rest of the run (the memo above reads
  // `offered`, so marking the workspace is what dismisses the banner). Declining
  // deliberately leaves the stored tabs alone: they survive until this
  // workspace's open set next changes, at which point the persist effect
  // overwrites them.
  function markOffered(ws: string) {
    setOffered(new Set(offered()).add(ws));
  }

  async function acceptRestore(ws: string) {
    markOffered(ws);
    const entry = restorable[ws];
    if (!entry) return;
    // One scan for the whole workspace: every stored session is checked against
    // it, so a session deleted since last run is skipped rather than resumed
    // into a dead id.
    const sessions = await invoke<RestoreSession[]>("list_sessions", { folder: ws }).catch(
      () => [] as RestoreSession[],
    );
    const byId = new Map(sessions.map((s) => [s.id, s]));
    let missingSessions = 0;
    let relocated = 0;
    let home: string | null = null;
    const cwdFor = async (cwd: string): Promise<string> => {
      if (await invoke<boolean>("file_exists", { path: cwd }).catch(() => true)) return cwd;
      // A deleted folder must yield a usable shell at home, never a tab whose
      // spawn fails and leaves a dead pane.
      relocated++;
      home ??= await homeDir().catch(() => "/");
      return home;
    };

    // The tab each stored entry produced, by its stored index. Sparse on
    // purpose: a skipped session or a transcript-only reopen leaves a hole, so
    // the stored active index still resolves to the right tab (or to nothing)
    // instead of being read positionally against a shorter live list.
    const producedId: (string | undefined)[] = [];

    for (const [i, d] of entry.tabs.entries()) {
      // Restore is routed on the stored kind alone, never on the default-surface
      // preference: a workspace saved with agent tabs comes back as agent tabs
      // on an install where chat is now the default. See `restoreRoute`.
      const surface = restoreRoute(d.kind);
      if (surface === "chat" && d.sessionId) {
        // Chat restores by resuming its own session id, not by respawning a
        // shell. A session deleted since last run is skipped like any other.
        if (!byId.has(d.sessionId)) {
          missingSessions++;
          continue;
        }
        const id = `chat:${crypto.randomUUID()}`;
        openOrActivate({
          id,
          title: d.title,
          cwd: await cwdFor(d.cwd),
          workspace: ws,
          kind: "chat",
          program: d.program || "claude",
          args: [],
          sessionId: d.sessionId,
          resume: true,
          // Resumed, not re-forked: the fork happened last run and its
          // conversation is in this session's own transcript now. The marker
          // rides along only so the tab keeps saying the agent remembers turns
          // that were undone, which is still true.
          rewindTo: d.rewindTo,
        });
        producedId[i] = id;
        continue;
      }
      // `surface` is "agent" for a stored shell too; the extra kind check is
      // what separates a session-bearing agent tab from one, and a plain shell
      // falls through to the respawn below either way.
      if (surface === "agent" && d.kind === "agent" && d.sessionId) {
        const s = byId.get(d.sessionId);
        if (!s) {
          missingSessions++;
          continue;
        }
        const agentId = s.agent ?? "claude";
        // focusOrResume already focuses an existing tab rather than spawning a
        // second one, so an already-live session never double-spawns.
        await focusOrResume({
          sessionId: s.id,
          agent: agentId,
          sessionFile: s.path,
          sessionTitle: s.name || s.title,
          sessionCwd: s.cwd,
          folderPath: ws,
        });
        producedId[i] = open().find((t) => t.sessionId === s.id)?.id;
        continue;
      }
      // A plain shell, or an agent tab whose session was never attributed: come
      // back as the same shell-hosted tab, seeded again if it had an init.
      const cwd = await cwdFor(d.cwd);
      const id = shellId();
      openOrActivate({
        id,
        title: d.title,
        cwd,
        workspace: ws,
        kind: d.kind,
        program: d.program,
        args: d.args,
        ...(d.kind === "agent" && d.program ? { init: agentInit(d.program, d.args) } : {}),
      });
      producedId[i] = id;
    }

    // Refocus whatever the stored active index actually produced. Restoring in
    // order leaves the last tab focused otherwise, which is rarely the one that
    // was in front.
    const targetId = producedId[entry.active];
    if (targetId) focusTab(ws, targetId);

    const notices: string[] = [];
    if (missingSessions) notices.push(`${missingSessions} session${missingSessions > 1 ? "s" : ""} no longer exist`);
    if (relocated) notices.push(`${relocated} folder${relocated > 1 ? "s" : ""} missing, opened in your home directory`);
    if (notices.length) emitWith<ToastEvent>(TOAST, { message: `Restored tabs: ${notices.join("; ")}.`, kind: "info" });
  }

  // The "+ Claude ›" split button's dropdown of yolo-mode launchers. Still
  // portalled out, because the tab bar clips overflow and would hide a menu
  // rendered inside it; the caret's rect is Kobalte's problem now.
  const [menuOpen, setMenuOpen] = createSignal(false);

  // --- History dropdown -------------------------------------------------------

  const [historyOpen, setHistoryOpen] = createSignal(false);
  let historyEl: HTMLButtonElement | undefined;

  const toggleHistory = () => setHistoryOpen(!historyOpen());

  // Which of this workspace's sessions are open in a tab: History lists those
  // first, whatever their age, and everything else falls into time buckets.
  const openSessionIds = () =>
    workspaceTabs()
      .map((t) => t.sessionId)
      .filter((id): id is string => !!id);

  // Sessions running in this folder that no tab of ours hosts - an agent someone
  // started in a terminal outside Sway, or one left behind by a closed tab.
  // Their whole visibility is this badge, since the panel they live in is shut.
  // A detached session caps at "running" by construction (working and needs-you
  // both need a PTY to observe), so this is a count rather than a rollup.
  //
  // Memoized: it composes a status per session in the folder (47 of them, on
  // this machine's worst case) and the button reads it four times over.
  const detachedLive = createMemo(() => {
    const ws = activeWorkspace();
    if (!ws) return 0;
    const hosted = new Set(open().map((t) => t.sessionId));
    return (sessions()[ws] ?? []).filter(
      (s) => !hosted.has(s.id) && sessionStatus(s.id) !== "none",
    ).length;
  });

  // Where the panel says you are. The selection carries the names when it is
  // pointed here; otherwise the folder's own tail is all there is to say.
  const historyCrumb = (): string[] => {
    const ws = activeWorkspace() ?? "";
    const sel = props.selected;
    if (sel && sel.folderPath === ws) return [sel.spaceName, sel.projectName, sel.branch];
    return ws.split("/").filter(Boolean).slice(-2);
  };

  // Surface the live tabs (id + workspace + kind + soft sessionId + agent) so
  // the sidebar can count what's running for its confirms and probe the right
  // per-agent pgrep pattern for the status dot.
  createEffect(() =>
    props.onOpenChange?.(
      open().map((o) => ({
        id: o.id,
        workspace: o.workspace,
        kind: o.kind,
        sessionId: o.sessionId,
        agent: o.kind === "agent" || o.kind === "chat" ? agentIdForProgram(o.program) : undefined,
      })),
    ),
  );

  // Persist the tab strip so the next run can offer to restore it. Depends on
  // the open set, its order, AND the per-workspace active tab together:
  // recording only on open/close would freeze the order as it was at open time,
  // so a drag-reorder or a tab switch would never survive.
  //
  // Merged, never replaced: `toStore` only sees workspaces with tabs open right
  // now, so a plain write would erase every other workspace's stored tabs (at
  // startup it would erase all of them, since nothing is open yet). `touched`
  // records the workspaces this run actually opened tabs in; only those may be
  // erased by going empty, which is what lets current truth overwrite a
  // declined restore offer.
  const touched = new Set<string>();
  createEffect(() => {
    const live = toStore(open(), activeByWorkspace(), Date.now());
    for (const ws of Object.keys(live)) touched.add(ws);
    saveTabs(mergeStore(restorable, live, touched));
  });

  const offClose = onEvent(CLOSE_TAB, () => {
    const id = visibleId();
    if (id) closeId(id);
  });
  onCleanup(offClose);

  // Cmd+1..9: jump to tab N (0-indexed) of the active workspace's visible bar.
  // `tabsIn(ws)` is canonical order, already reflecting any drag-reorder the
  // bar applied via `mergeReorder`.
  const offTabJump = onWith<TabJump>(TAB_JUMP, ({ index }) => {
    const ws = activeWorkspace();
    if (!ws) return;
    const tab = tabsIn(ws)[index];
    if (tab) focusTab(ws, tab.id);
  });
  onCleanup(offTabJump);

  // Ctrl+Tab: cycle to the next tab in the active workspace, wrapping around.
  const offTabCycle = onEvent(TAB_CYCLE, () => {
    const ws = activeWorkspace();
    if (!ws) return;
    const tabs = tabsIn(ws);
    if (!tabs.length) return;
    const idx = tabs.findIndex((t) => t.id === visibleId());
    focusTab(ws, tabs[(idx + 1) % tabs.length].id);
  });
  onCleanup(offTabCycle);

  // Cmd+Shift+A: focus the next live session whose status is "Waiting for
  // approval" (Phase 1's shared status store), across every workspace/space,
  // cycling from whichever waiting session (if any) is currently focused.
  const offNextWaiting = onEvent(NEXT_WAITING_SESSION, () => {
    const waiting = liveSessionStatuses().filter((s) => s.status === "waitingForApproval");
    if (!waiting.length) return;
    const idx = waiting.findIndex((w) => w.tabId === visibleId());
    const next = waiting[(idx + 1) % waiting.length];
    const tab = open().find((t) => t.id === next.tabId);
    if (tab) focusTab(tab.workspace, tab.id);
  });
  onCleanup(offNextWaiting);

  // Command palette "focus session" action: the session is already open in a
  // tab, so just reveal it (no resume needed).
  const offFocusSessionTab = onWith<FocusSessionTab>(FOCUS_SESSION_TAB, ({ tabId }) => {
    const tab = open().find((t) => t.id === tabId);
    if (tab) focusTab(tab.workspace, tab.id);
  });
  onCleanup(offFocusSessionTab);

  // A space is being deleted: kill + close every terminal tab whose cwd is rooted
  // under it, so no agent keeps running in a folder that is about to vanish.
  const offPurge = onWith<PurgeUnderPath>(PURGE_UNDER_PATH, ({ path }) => {
    for (const t of open()) {
      if (isUnderPath(t.cwd, path)) closeId(t.id);
    }
  });
  onCleanup(offPurge);

  // A session's transcript was deleted: close whatever tab was driving it. The
  // sidebar has already closed the child and released the claim, so this is
  // only the tab. Left open, a chat tab would keep showing history that no
  // longer exists on disk and would still accept typing into a dead session.
  const offSessionDeleted = onWith<SessionDeleted>(SESSION_DELETED, ({ sessionId }) => {
    for (const t of open()) {
      if (t.sessionId === sessionId) closeId(t.id);
    }
  });
  onCleanup(offSessionDeleted);

  // Chat children a crashed Sway left running. The backend refuses to reclaim
  // their session ids until they are gone, so without this the refusal would be
  // silent: the session simply would not open, with nothing saying why.
  const [orphans, setOrphans] = createSignal<ChatOrphan[]>([]);
  async function endOrphan(o: ChatOrphan) {
    setOrphans(orphans().filter((x) => x.sessionId !== o.sessionId));
    await invoke("chat_terminate_orphan", {
      sessionId: o.sessionId,
      childPid: o.childPid,
      agentId: o.agent,
    }).catch((e) => emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }));
  }

  // A PTY agent tab whose session id was already claimed. Held per tab rather
  // than globally: two refused tabs are two separate offers, and the banner has
  // to end the right leftover process.
  const [ptyRefusals, setPtyRefusals] = createSignal<{ tab: OpenTerm; refusal: Refusal }[]>([]);
  const ptyRefusal = () => ptyRefusals().find((r) => r.tab.id === visibleId()) ?? null;

  function noteRefusal(tab: OpenTerm, refusal: Refusal) {
    setPtyRefusals([...ptyRefusals().filter((r) => r.tab.id !== tab.id), { tab, refusal }]);
  }

  function clearRefusal(tabId: string) {
    setPtyRefusals(ptyRefusals().filter((r) => r.tab.id !== tabId));
  }

  // The way out of every refusal, on both surfaces: a brand-new session id
  // cannot collide with the one that is already held.
  function forkFrom(tab: OpenTerm) {
    // The refused tab spawned nothing, so it is an empty shell that would sit
    // in the bar forever. Closing it also clears its refusal.
    closeId(tab.id);
    void spawnSession(tab.program, tab.workspace, tab.workspace.split("/").pop() || tab.program);
  }

  async function endRefusalOrphan(entry: { tab: OpenTerm; refusal: Refusal }) {
    if (entry.refusal.type !== "orphaned" || !entry.tab.sessionId) return;
    await invoke("chat_terminate_orphan", {
      sessionId: entry.tab.sessionId,
      childPid: entry.refusal.childPid,
      agentId: entry.tab.program,
    })
      .then(() => {
        clearRefusal(entry.tab.id);
        emitWith<ToastEvent>(TOAST, { message: "Ended the leftover session. Reopen it to continue.", kind: "info" });
      })
      .catch((e) => emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }));
  }

  // Tabs (clone / bootstrap) that should re-discover projects when they exit.
  const rediscoverOnExit = new Set<string>();
  // Sign-in tabs, whose whole purpose is to change the answer `agent_health`
  // gave. Without this a completed login would keep reading as signed out until
  // the user went and found the button in Settings.
  const recheckAgentsOnExit = new Set<string>();
  let offOpenTerminal: (() => void) | undefined;
  let offNewSession: (() => void) | undefined;
  let unlistenExit: UnlistenFn | undefined;
  let unlistenSessions: UnlistenFn | undefined;
  onMount(async () => {
    offOpenTerminal = onWith<OpenTerminal>(OPEN_TERMINAL, (t) => {
      if (t.rediscoverOnExit) rediscoverOnExit.add(t.id);
      if (t.recheckAgentsOnExit) recheckAgentsOnExit.add(t.id);
      openOrActivate({
        id: t.id,
        title: t.title,
        cwd: t.cwd,
        // Clone/bootstrap have no branch-unit yet, so they group under their own
        // cwd; opening one reveals that group so its progress is visible. A task
        // runs *at* its branch-unit, so the same line groups it with that unit's
        // other tabs.
        workspace: t.cwd,
        kind: t.kind ?? "command",
        program: t.program,
        args: t.args,
        ...(t.init ? { init: t.init } : {}),
        ...(t.env ? { env: t.env } : {}),
      });
    });
    // Sidebar "New session": matches the "+ Claude" main button (claude, non-yolo).
    // Spawns at the named folder, with no props.selected timing dependency.
    offNewSession = onWith<NewSession>(NEW_SESSION, (s) => {
      spawnSession(s.agent ?? "claude", s.folderPath, s.projectName, false);
    });
    // A shell/agent tab that exits (the user typed `exit`) is closed; a command
    // tab (clone/bootstrap) stays visible so its failure is inspectable, and
    // re-discovers projects. Agent-exit within a live shell fires no event.
    unlistenExit = await listen<string>("pty://exit", (e) => {
      const id = e.payload;
      // Before the early return below, because a sign-in tab is a command tab
      // today but the reason to re-probe is that the process ended, not how the
      // tab happened to be hosted. Abandoning the tab lands here too, and that
      // is correct: the probe re-reads the agent and finds it unchanged.
      if (recheckAgentsOnExit.delete(id)) void refreshAgentHealth();
      const t = open().find((o) => o.id === id);
      if (t && t.kind !== "command") {
        closeId(id);
        return;
      }
      if (rediscoverOnExit.delete(id)) invoke("rediscover").catch(() => {});
    });
    // Pulled, not listened for. The startup reap runs inside Tauri's `setup`,
    // which finishes before this webview exists, so an event emitted there
    // would reach nobody and an orphan would block its session id in silence.
    // The backend parks the result; this is the frontend saying it is ready.
    const reaped = await invoke<Reaped[]>("chat_orphans").catch(() => [] as Reaped[]);
    setOrphans(reaped.filter((o): o is ChatOrphan => o.type === "orphan"));
    // Sway used to decide tool calls from a rule store of its own. It does not,
    // the store is gone, and this is the once the user is told. Pulled here for
    // the same reason as the reap above: the sweep answers `null` on every run
    // after the first, so there is nothing to keep track of on this side.
    void invoke<RetiredRuleStore | null>("chat_retired_stores")
      .then((retired) => {
        if (!retired) return;
        // The project rules are the only part somebody wrote on purpose, so the
        // notice leads with them and says where that intent lives now. Without
        // any, this is bookkeeping and says so plainly.
        const wrote = retired.projectRules
          ? `${retired.projectRules} project rule${retired.projectRules === 1 ? "" : "s"} you had saved went with them - your agent's own permission settings are where those live now.`
          : "None of them were rules you wrote.";
        emitWith<ToastEvent>(TOAST, {
          message: `Sway no longer decides tool calls, so it removed ${retired.files} leftover file${retired.files === 1 ? "" : "s"} from ${retired.path}. ${wrote}`,
          kind: "info",
        });
      })
      .catch(() => {});
    // A transcript just appeared: try to attribute it to a fresh tab (see
    // `backfillFreshSessions`) so the sidebar can focus it in place.
    unlistenSessions = await listen("sessions://changed", () => {
      void backfillFreshSessions().then(() => syncTabTitles());
    });
  });

  // Safe-send (src/utils/safeSend.ts `requestSend`): the sole consumer of
  // SEND_TO_SESSION, since this component owns pty_write and tab/session
  // state. Answers every request with a matching SEND_TO_SESSION_RESULT.
  const offSendToSession = onWith<SendToSession>(SEND_TO_SESSION, (req) => void handleSendToSession(req));
  onCleanup(offSendToSession);

  onCleanup(() => {
    offOpenTerminal?.();
    offNewSession?.();
    unlistenExit?.();
    unlistenSessions?.();
  });

  function openOrActivate(t: OpenTerm) {
    if (!open().some((o) => o.id === t.id)) {
      setOpen([...open(), t]);
    }
    focusTab(t.workspace, t.id);
  }

  // A fresh `+Claude` tab carries no sessionId until its transcript
  // appears (Sway can't invent the id before the CLI writes it) - the
  // "fresh-session double-open" gap: clicking that session's sidebar row can't
  // find the tab. Attribute it here, but only in the unambiguous case: exactly
  // one unattributed agent tab per workspace (two fresh tabs sharing a folder
  // can't be told apart, so both stay unattributed) matched against exactly one
  // session whose cwd matches and which was created at/after the tab's spawn
  // (so an older session sharing the cwd is never misattributed).
  async function backfillFreshSessions() {
    const claimed = new Set(open().map((t) => t.sessionId).filter((x): x is string => !!x));
    const byWorkspace = new Map<string, OpenTerm[]>();
    for (const t of open()) {
      if (t.kind !== "agent" || t.sessionId) continue;
      byWorkspace.set(t.workspace, [...(byWorkspace.get(t.workspace) ?? []), t]);
    }
    for (const [workspace, tabs] of byWorkspace) {
      if (tabs.length !== 1) continue; // ambiguous: two+ fresh tabs in this workspace
      const tab = tabs[0];
      const sessions = await invoke<BackfillSession[]>("list_sessions", { folder: workspace }).catch(
        () => [] as BackfillSession[],
      );
      const candidates = sessions.filter(
        (s) =>
          !claimed.has(s.id) &&
          s.agent === tab.program &&
          sameCwd(s.cwd, tab.cwd) &&
          s.created_at >= (tab.spawnedAt ?? 0),
      );
      if (candidates.length === 1) {
        // Mutate in place + shallow-copy the outer array (same pattern as
        // `mergeReorder`): every tab object keeps its reference, so `<For>`
        // reconciles without remounting anything (gotcha #64 - a rebuilt item
        // ref would kill this tab's PTY).
        tab.sessionId = candidates[0].id;
        setOpen([...open()]);
      }
    }
  }

  // Re-sync every session-backed tab's label to its session's current name, so
  // a rename in the sidebar reflects on the terminal tab (the title is captured
  // at tab creation and would otherwise never change). Runs on sessions://changed
  // alongside the backfill; one list_sessions per distinct workspace.
  async function syncTabTitles() {
    const byWorkspace = new Map<string, OpenTerm[]>();
    for (const t of open()) {
      if ((t.kind === "agent" || t.kind === "chat") && t.sessionId) {
        byWorkspace.set(t.workspace, [...(byWorkspace.get(t.workspace) ?? []), t]);
      }
    }
    if (!byWorkspace.size) return;
    const updates: Record<string, string> = {};
    await Promise.all(
      [...byWorkspace].map(async ([workspace, tabs]) => {
        const sessions = await invoke<RestoreSession[]>("list_sessions", { folder: workspace }).catch(
          () => [] as RestoreSession[],
        );
        const byId = new Map(sessions.map((s) => [s.id, s]));
        for (const t of tabs) {
          const s = byId.get(t.sessionId!);
          if (!s) continue;
          // Mirror focusOrResume's title derivation: session name, else title,
          // else a short id, capped at 28 chars.
          const label = (s.name || s.title || t.sessionId!).slice(0, 28);
          if (label !== tabTitle(t)) updates[t.id] = label;
        }
      }),
    );
    if (Object.keys(updates).length) setTabTitles((m) => ({ ...m, ...updates }));
  }

  // Selecting anything reveals its workspace group. A session selection then does
  // focus-or-resume (Option A): if a tab already hosts that session, focus it (and
  // re-issue the resume in place if the agent has since exited to its shell);
  // otherwise spawn a fresh resume tab. A branch-only selection just reveals the
  // group and spawns nothing. Resume runs at the session's OWN recorded cwd, but
  // the tab groups under the branch-unit folder, not that nested cwd.
  createEffect(
    on(
      () => props.selected,
      (sel) => {
        if (!sel?.folderPath) return;
        setActiveWorkspace(sel.folderPath);
        if (sel.sessionId) void openSelectedSession(sel);
      },
    ),
  );

  // Extra launch args a Sway-launched session gets that an externally-typed
  // registered adapter invocation never would (Phase 3): today just
  // claude's injected `--settings <json>` (crate::hooks), which scopes
  // hook-driven status to sessions this function actually spawned/resumed.
  async function hookArgs(agentId: string): Promise<string[]> {
    return invoke<string[]>("agent_hook_launch_args", { agentId }).catch(() => []);
  }

  /**
   * A session selection, routed to whichever surface the user has made default
   * (chat since Phase 12, PTY agent behind the fallback setting).
   *
   * The `session_running` probe is taken up front rather than inside the PTY
   * branch, because the route itself depends on it: chat drives a session by
   * resuming it, which is unsafe against one already running outside Sway.
   */
  async function openSelectedSession(sel: ResumeTarget) {
    const sessionId = sel.sessionId!;
    const agentId = agents().some((a) => a.id === sel.agent) ? sel.agent! : "claude";
    const hostedHere = open().some((t) => t.sessionId === sessionId);
    // Only worth asking when the answer can change the route. A tab of ours
    // already hosting it short-circuits to `focus` either way, and the PTY
    // branch runs its own probe for the retype decision.
    const runningElsewhere =
      hostedHere || settings.chatDefaults.defaultSurface === "agent"
        ? false
        : await invoke<boolean>("session_running", { id: sessionId, agent: agentId }).catch(() => true);
    const route = routeSelection({
      preference: settings.chatDefaults.defaultSurface,
      hostedHere,
      runningElsewhere,
    });
    if (route === "chat") {
      await continueInChat(sel, agentId);
      return;
    }
    await focusOrResume(sel);
  }

  async function focusOrResume(sel: ResumeTarget) {
    const sessionId = sel.sessionId!;
    const agentId = agents().some((a) => a.id === sel.agent) ? sel.agent! : "claude";
    const a = findAdapter(agentId);
    const existing = open().find((t) => t.sessionId === sessionId);
    if (existing) {
      focusTab(existing.workspace, existing.id);
      // A chat tab already drives this session over stream-json. It hosts no
      // PTY, so there is nothing to retype into, and a second driver would
      // corrupt the transcript anyway.
      if (existing.kind === "chat") return;
      // Agent still carrying its id in argv → visible/live, leave it. If it has
      // exited (dropped to the shell), retype the resume so the session comes
      // back in place. Best-effort: without shell integration we can't tell an
      // idle prompt from a foreground program, so treat "agent gone" as idle.
      const running = await invoke<boolean>("session_running", { id: sessionId, agent: agentId }).catch(
        () => true,
      );
      if (!running) {
        invoke("pty_write", { id: existing.id, data: agentInit(existing.program, existing.args) }).catch(
          () => {},
        );
      }
      return;
    }
    const args = [
      ...applyTemplate(a.resume_args, { id: sessionId, file: sel.sessionFile ?? "" }),
      ...(await hookArgs(agentId)),
    ];
    openOrActivate({
      id: shellId(),
      title: sel.sessionTitle?.slice(0, 28) || sessionId.slice(0, 8),
      cwd: sel.sessionCwd || sel.folderPath,
      workspace: sel.folderPath,
      kind: "agent",
      program: a.program,
      args,
      init: agentInit(a.program, args),
      sessionId,
    });
  }

  // Liveness for the safe-send probe-gate: not-ready until the AGENT process
  // itself is confirmed running (never just the hosting shell, so a queued
  // send never lands in a bare shell), then blocked when the transcript tail
  // shows a needs-you prompt (refuse rather than queue behind it), else ready.
  // Safe-send writes into a PTY, so only a shell-hosted agent tab can serve it.
  // A chat-hosted session is deliberately not a match: it takes the structured
  // route in `handleSendToSession` above, and a `pty_write` at a chat tab's id
  // would land nowhere while reporting success.
  const agentTabFor = (sessionId: string) => open().find((t) => t.kind === "agent" && t.sessionId === sessionId);

  async function probeSessionState(req: SendToSession): Promise<ProbeState> {
    if (!agentTabFor(req.sessionId)) return "not-ready";
    const running = await invoke<boolean>("session_running", { id: req.sessionId, agent: req.agent }).catch(
      () => false,
    );
    if (!running) return "not-ready";
    if (req.sessionPath) {
      const tail = await invoke<TailState>("session_tail_state", {
        id: req.sessionId,
        path: req.sessionPath,
        agent: req.agent,
      }).catch(() => null);
      if (tail === "blocked-candidate") return "blocked";
    }
    return "ready";
  }

  async function handleSendToSession(req: SendToSession) {
    const text = sanitizeForSend(req.text);
    if (!text) return;
    // A chat-backed session takes the structured reading of the same message.
    // Decided here rather than at each caller: this component already knows
    // which session is hosted where, and a caller guessing would have to be
    // told again every time the answer changed.
    if (routeFor(req.sessionId, liveChatIds()) === "chat") {
      offerToComposer(req.sessionId, req.blocks ?? [{ type: "text", text }]);
      const chat = liveChats().find((c) => c.sessionId === req.sessionId);
      if (chat) focusTab(chat.folderPath, chat.tabId);
      emitWith<SendToSessionResult>(SEND_TO_SESSION_RESULT, { requestId: req.requestId, result: "sent" });
      return;
    }
    if (!agentTabFor(req.sessionId)) {
      await focusOrResume({
        sessionId: req.sessionId,
        agent: req.agent,
        sessionFile: req.sessionFile,
        sessionTitle: req.sessionTitle,
        sessionCwd: req.sessionCwd,
        folderPath: req.folderPath,
      });
    }
    const result = await sendWithProbeGate(text, {
      probe: () => probeSessionState(req),
      write: async (t) => {
        const tab = agentTabFor(req.sessionId);
        if (!tab) throw new Error("session tab closed mid-send");
        await invoke("pty_write", { id: tab.id, data: bracketedPaste(t) });
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }).catch((): { kind: "timeout" } => ({ kind: "timeout" }));
    if (result.kind === "blocked") {
      emitWith<ToastEvent>(TOAST, { message: BLOCKED_REASON, kind: "error" });
    } else if (result.kind === "timeout") {
      emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session in time, try again.", kind: "error" });
    }
    emitWith<SendToSessionResult>(SEND_TO_SESSION_RESULT, { requestId: req.requestId, result: result.kind });
  }

  // A new session starts in the branch-unit folder (already the right checkout).
  // Launch args come from the adapter: base args, plus its yolo args when asked
  // (claude's skip permission prompts; an adapter may declare none),
  // plus any Sway-launched-only hook args (Phase 3).
  async function spawnSession(agentId: string, folderPath: string, projectName: string, yolo = false) {
    const a = findAdapter(agentId);
    const args = [...a.base_args, ...(yolo ? a.yolo_args : []), ...(await hookArgs(agentId))];
    openOrActivate({
      id: shellId(),
      title: `${projectName} ${agentId}`,
      cwd: folderPath,
      workspace: folderPath,
      kind: "agent",
      program: a.program,
      args,
      init: agentInit(a.program, args),
      // Floored to match the backend's whole-second `created_at` (epoch_secs
      // truncates): comparing a fractional spawn time against a truncated
      // creation time would spuriously reject a session created in the same
      // wall-clock second as the spawn.
      spawnedAt: Math.floor(Date.now() / 1000),
    });
  }

  // A chat tab hosts no shell. It mints its own session id up front (the
  // transport is spawned with `--session-id`), which is why - unlike an agent
  // tab - it never needs the transcript-appears backfill to learn what it is.
  // Returns the minted session id, so a caller that wants to seed the new chat
  // (send-to-new-session) can address it before it mounts.
  /**
   * Open a chat tab on a **new** session id.
   *
   * `forkFrom` makes it a fork: the new session replays that one's history and
   * the two diverge from there. Without it the chat starts empty. Either way the
   * id is new, which is what makes this the safe answer to a refused claim -
   * a new id cannot collide with the one already held.
   */
  function spawnChat(
    workspace: string,
    cwd: string,
    baseName: string,
    agentId = "claude",
    forkFrom?: string,
    rewindTo?: number,
  ): string {
    const sessionId = crypto.randomUUID();
    openOrActivate({
      id: `chat:${crypto.randomUUID()}`,
      title: chatTabLabel(
        baseName,
        tabsIn(workspace)
          .filter((t) => t.kind === "chat")
          .map(tabTitle),
      ),
      cwd,
      workspace,
      kind: "chat",
      program: agentId,
      args: [],
      sessionId,
      forkFrom,
      rewindTo,
    });
    return sessionId;
  }

  /**
   * Carry a chat into a rewound fork and close the tab it came from.
   *
   * The close is the point: a rewind supersedes the session it came from, and
   * two open tabs on the same work would both be live, both claimed, and both
   * looking like the place to type. The old session is not deleted - it stays
   * on disk with its transcript intact, reachable from the session list - it
   * simply stops being somewhere you can drive.
   *
   * Ordered close-then-open so the claim on the old id is released before the
   * fork asks for its own; they are different ids, so this is tidiness rather
   * than a race, but a fork that outlived its origin's claim would leave the
   * tree showing two live rows for one piece of work.
   */
  function rewindChat(tab: OpenTerm, promptTs: number) {
    if (!tab.sessionId) return;
    const origin = tab.sessionId;
    closeId(tab.id);
    spawnChat(tab.workspace, tab.cwd, tab.workspace.split("/").pop() || "chat", tab.program, origin, promptTs);
  }

  function newChat(agentId = "claude") {
    const sel = props.selected;
    if (!sel) return;
    spawnChat(sel.folderPath, sel.folderPath, sel.projectName, agentId);
  }

  /**
   * Continue an **existing** session in a chat tab: same session id, resumed
   * rather than created, at the session's own recorded cwd.
   *
   * The session need not have come from a chat tab. A PTY agent tab and an
   * outside `claude` write the same transcript the agent reads back on
   * `--resume`, and Sway backfills from that same file, so a conversation
   * started in a terminal continues here with its history intact.
   *
   * Focus-or-resume, like the PTY path: a session already open somewhere is
   * focused rather than opened twice, because two drivers on one session id
   * measurably corrupt its transcript.
   */
  async function continueInChat(sel: ResumeTarget, agentId = "claude") {
    const sessionId = sel.sessionId;
    if (!sessionId) return;
    const existing = open().find((t) => t.sessionId === sessionId);
    if (existing) {
      focusTab(existing.workspace, existing.id);
      return;
    }
    // A session someone else is already resuming cannot be driven from here:
    // two writers on one id measurably corrupt the transcript. `chat_spawn`
    // refuses correctly on its own, but only after a tab has been opened -
    // checking first means the user is told instead of shown an empty tab
    // wearing a refusal banner.
    const running = await invoke<boolean>("session_running", { id: sessionId, agent: agentId }).catch(
      () => false,
    );
    if (running) {
      emitWith<ToastEvent>(TOAST, {
        message: "That session is already running somewhere else. Close it there first, or fork it.",
        kind: "error",
      });
      return;
    }
    openOrActivate({
      id: `chat:${crypto.randomUUID()}`,
      title: chatTabLabel(
        sel.sessionTitle?.slice(0, 28) || sessionId.slice(0, 8),
        tabsIn(sel.folderPath)
          .filter((t) => t.kind === "chat")
          .map(tabTitle),
      ),
      cwd: sel.sessionCwd || sel.folderPath,
      workspace: sel.folderPath,
      kind: "chat",
      program: agentId,
      args: [],
      sessionId,
      resume: true,
    });
  }

  function newSession(agentId: string, yolo = false) {
    const sel = props.selected;
    if (!sel) return;
    spawnSession(agentId, sel.folderPath, sel.projectName, yolo);
  }

  // A plain shell tab: the same login shell as an agent tab, just unseeded (no
  // init), opened in the selected branch-unit folder.
  function newShell() {
    const sel = props.selected;
    if (!sel) return;
    openOrActivate({
      id: shellId(),
      title: `${sel.projectName} shell`,
      cwd: sel.folderPath,
      workspace: sel.folderPath,
      kind: "shell",
      program: "",
      args: [],
    });
  }

  function closeId(id: string) {
    const t = open().find((o) => o.id === id);
    // A chat tab hosts no PTY: `pty_kill` on its id would find nothing, and the
    // stream-json child would keep running (and keep its session id claimed).
    // Unmounting ChatView ends it; this only has to not kill the wrong thing.
    if (t?.kind !== "chat") invoke("pty_kill", { id }).catch(() => {});
    clearRefusal(id);
    setOpen(open().filter((o) => o.id !== id));
    // No active-tab bookkeeping needed: visibleId() falls back to the workspace's
    // first tab when its remembered id is now gone.
  }

  function close(id: string, e: Event) {
    e.stopPropagation();
    closeId(id);
  }

  /** What a chat tab's session is doing, from the live-chat registry, which the
   *  chat's own event stream fills - so it is exact rather than inferred from
   *  PTY quiet. Null for every tab that is not a chat, and for a chat whose
   *  panel has not registered yet. */
  function chatStatus(t: OpenTerm): SessionStatus | null {
    if (t.kind !== "chat") return null;
    return liveChats().find((c) => c.tabId === t.id)?.status ?? null;
  }

  /** Does this tab host a session at all? Shell and command tabs do not, and
   *  get no mark rather than a resting one for a session they will never have. */
  const marksSession = (t: OpenTerm) => t.kind === "chat" || t.kind === "agent";

  /** What that tab's session is doing.
   *
   *  Null for an agent tab whose transcript has not appeared yet (it carries no
   *  session id until then) and for a chat whose panel has not registered - both
   *  render the resting mark rather than nothing, so the strip does not twitch
   *  as a session starts. */
  function tabStatus(t: OpenTerm): SessionStatus | null {
    if (t.kind === "chat") return chatStatus(t);
    return t.sessionId ? sessionStatus(t.sessionId) : null;
  }

  /** On which tier. A chat's own event stream states its status outright; a PTY
   *  agent tab's is composed from a pgrep probe, PTY quiet and a transcript
   *  tail, which is the same answer the sidebar has always shown for it. */
  const tabCertainty = (t: OpenTerm): StatusCertainty => (t.kind === "chat" ? "exact" : "inferred");

  /** Is this tab's session blocked on an approval? A budget stop blocks the same
   *  way and is worded the same way in the tooltip: both mean the session is
   *  waiting on a person. */
  function blockedTab(t: OpenTerm): boolean {
    const s = marksSession(t) ? tabStatus(t) : null;
    return s === "waitingForApproval" || s === "budgetStopped";
  }

  // The bar reorders only the active workspace's tabs (the subset it was given).
  // Splice that new order back over the same slots in the full `open[]`, keeping
  // every object ref and other groups' positions intact (gotcha #64).
  function mergeReorder(next: OpenTerm[]) {
    const ws = activeWorkspace();
    if (!ws) return;
    let i = 0;
    setOpen(open().map((t) => (t.workspace === ws ? next[i++] : t)));
  }

  return (
    <div class={styles.termArea}>
      <OverflowTabBar
        class={styles.termTabs}
        items={workspaceTabs()}
        activeId={visibleId()}
        idOf={(t) => t.id}
        onActivate={(id) => {
          const t = open().find((o) => o.id === id);
          if (t) selectTab(t);
        }}
        onReorder={mergeReorder}
        renderTab={(t) => (
          <Tab
            value={t.id}
            tooltip={blockedTab(t) ? `${t.cwd} - waiting for your approval` : t.cwd}
            onClose={(e) => close(t.id, e)}
            // A session's state is true whether or not you are looking at it, so
            // the tab carries it: without this a background session waiting on
            // an approval is indistinguishable from one still working. It rides
            // on the provider mark rather than on a glyph of its own, so a tab
            // going quiet does not change shape in a strip being scanned.
            icon={
              marksSession(t) ? (
                <TabMark agentId={t.program} status={tabStatus(t)} certainty={tabCertainty(t)} />
              ) : undefined
            }
          >
            {tabTitle(t)}
          </Tab>
        )}
        renderMenuItem={(t) => (
          <>
            <span class="tab-label">{tabTitle(t)}</span>
            <span class="tab-close" aria-label="Close" onClick={(e) => close(t.id, e)}>
              <Icon icon={X} />
            </span>
          </>
        )}
        trailing={
          <>
            <div class={styles.termNewSplit}>
              {/* Main half: quick new shell (terminal icon). Caret half: launch an
                  agent session from a fixed three-option menu. */}
              {/* `whenDisabled`: with no branch picked the label is the reason
                  the button is greyed out, not a description of what it does. */}
              <Tooltip
                as="button"
                type="button"
                class={`${styles.termNew} ${styles.termNewMain}`}
                disabled={!props.selected}
                whenDisabled
                label={props.selected ? `New shell in ${props.selected.projectName}` : "Select a branch first"}
                aria-label={props.selected ? `New shell in ${props.selected.projectName}` : "New shell"}
                onClick={newShell}
              >
                <Icon icon={SquareTerminal} />
              </Tooltip>
              {/* The caret belongs to its `Tooltip`, so the menu wraps it. This
                  wrapper keeps a box (a dropdown anchors on its trigger's rect),
                  and the two sibling rules the split button relies on are
                  written through it, see the stylesheet. */}
              <Dropdown
                as="span"
                wrapper
                class={styles.termNewCaretWrap}
                open={menuOpen()}
                onOpenChange={setMenuOpen}
                placement="bottom-end"
                items={[
                  // The user's default surface leads, and the other one sits
                  // directly under it: whichever way the setting points, the
                  // other route stays a single click from this menu.
                  ...(settings.chatDefaults.defaultSurface === "agent"
                    ? [
                        { label: findAdapter("claude").label, onClick: () => newSession("claude") },
                        { label: `${findAdapter("claude").label} chat`, onClick: () => newChat("claude") },
                      ]
                    : [
                        { label: `${findAdapter("claude").label} chat`, onClick: () => newChat("claude") },
                        { label: `${findAdapter("claude").label} (terminal)`, onClick: () => newSession("claude") },
                      ]),
                  // Only for a session selection, since there is nothing to
                  // continue from a bare branch. The session need not have been
                  // started in chat: every surface writes the transcript this
                  // resumes and backfills from.
                  ...(props.selected?.sessionId
                    ? [
                        {
                          label: "Continue this session in chat",
                          onClick: () => void continueInChat(props.selected!, props.selected!.agent ?? "claude"),
                        },
                        // The counterpart route for a session selection, so the
                        // PTY surface is reachable for an existing session and
                        // not only for a new one.
                        {
                          label: "Continue this session in terminal",
                          onClick: () => void focusOrResume(props.selected!),
                        },
                      ]
                    : []),
                  { label: `${findAdapter("claude").label} (yolo)`, onClick: () => newSession("claude", true) },
                ]}
              >
                <Tooltip
                  as="button"
                  type="button"
                  class={`${styles.termNew} ${styles.termNewCaret}`}
                  disabled={!props.selected}
                  label="Launch an agent session"
                  aria-label="Launch an agent session"
                  // Kobalte writes these on the trigger, which is the wrapper,
                  // and they cannot be taken off it (`wrapper` removes its
                  // `role` and tab stop, not its ARIA). The button is what the
                  // keyboard reaches, so it says this too.
                  aria-haspopup="menu"
                  aria-expanded={menuOpen()}
                >
                  <Icon icon={ChevronDown} class={styles.termNewChevron} />
                </Tooltip>
              </Dropdown>
            </div>
            {/* Session navigation, at the surface the sessions run in rather than
                in a tree you have to find them in. Last in the trailing cluster,
                so the launch control keeps the position muscle memory has. */}
            <Tooltip
              as="button"
              type="button"
              ref={historyEl}
              class={`${styles.termNew} ${styles.termHistory}`}
              disabled={!activeWorkspace()}
              label="Session history"
              aria-label="Session history"
              aria-haspopup="dialog"
              aria-expanded={historyOpen()}
              onClick={toggleHistory}
            >
              <Icon icon={History} />
              <Show when={detachedLive()}>
                <span
                  class={styles.termHistoryBadge}
                  title={
                    detachedLive() === 1
                      ? "1 session running here with no tab open"
                      : `${detachedLive()} sessions running here with no tab open`
                  }
                >
                  <Icon icon={CircleDashed} />
                  <Show when={detachedLive() > 1}>{detachedLive()}</Show>
                </span>
              </Show>
            </Tooltip>
          </>
        }
      />

      <Show when={historyOpen() && activeWorkspace()}>
        {(ws) => (
          <HistoryPanel
            folder={ws()}
            breadcrumb={historyCrumb()}
            openSessionIds={openSessionIds()}
            anchorEl={historyEl}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </Show>

      <div class={styles.termStage}>
        {/* Every tab is always mounted (CSS-hidden unless it is the visible one),
            so switching workspaces never unmounts a group's PTYs (gotcha #64).
            The empty message is an overlay, not a fallback that would replace
            (and thus unmount) the tabs. */}
        <For each={open()}>
          {(t) => (
            <Show
              when={asPtyTab(t)}
              fallback={
                <ChatView
                  sessionId={t.sessionId!}
                  tabId={t.id}
                  agentId={t.program}
                  cwd={t.cwd}
                  workspace={t.workspace}
                  title={tabTitle(t)}
                  resume={!!t.resume}
                  active={visibleId() === t.id}
                  onForkSession={() =>
                    spawnChat(t.workspace, t.cwd, t.workspace.split("/").pop() || "chat", t.program)
                  }
                  onForkFrom={() =>
                    spawnChat(
                      t.workspace,
                      t.cwd,
                      t.workspace.split("/").pop() || "chat",
                      t.program,
                      t.sessionId,
                    )
                  }
                  onRewindFrom={(promptTs) => rewindChat(t, promptTs)}
                  forkFrom={t.forkFrom}
                  rewindTo={t.rewindTo}
                />
              }
            >
              {(term) => (
                <TerminalView
                  id={term().id}
                  cwd={term().cwd}
                  kind={term().kind}
                  program={term().program}
                  args={term().args}
                  init={term().init}
                  env={term().env}
                  sessionId={term().sessionId}
                  active={visibleId() === term().id}
                  onOwnershipRefused={(refusal) => noteRefusal(term(), refusal)}
                />
              )}
            </Show>
          )}
        </For>
        <Show when={!visibleId()}>
          <div class={styles.termEmpty}>
            Select a session to resume it, or pick a branch and start a new Claude or pi session.
          </div>
        </Show>
        {/* Overlay, never a fallback: gating the always-mounted <For> on this
            would unmount every group's TerminalView and kill their PTYs
            (gotcha #64). */}
        {/* A PTY agent tab refused the session id. Same offer the chat surface
            makes, because it is the same refusal: go to what holds it, end the
            leftover process, or start a fresh session beside it. */}
        <Show when={ptyRefusal()}>
          {(entry) => (
            <div class={styles.termRestore}>
              <span class={styles.termRestoreText}>{refusalMessage(entry().refusal)}</span>
              <Show when={holdingTab(entry().refusal)}>
                {(tabId) => (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => emitWith<FocusSessionTab>(FOCUS_SESSION_TAB, { tabId: tabId() })}
                  >
                    Go to it
                  </Button>
                )}
              </Show>
              <Show when={entry().refusal.type === "orphaned"}>
                <Button variant="primary" size="sm" onClick={() => void endRefusalOrphan(entry())}>
                  End it
                </Button>
              </Show>
              <Button size="sm" onClick={() => forkFrom(entry().tab)}>
                Start a new session
              </Button>
            </div>
          )}
        </Show>
        <Show when={orphans().length}>
          <div class={styles.termRestore}>
            <span class={styles.termRestoreText}>
              {orphans().length} chat session{orphans().length > 1 ? "s" : ""} survived a crash and{" "}
              {orphans().length > 1 ? "are" : "is"} still running
            </span>
            <Button variant="primary" size="sm" onClick={() => void Promise.all(orphans().map(endOrphan))}>
              End {orphans().length > 1 ? "them" : "it"}
            </Button>
            <Button size="sm" onClick={() => setOrphans([])}>
              Leave running
            </Button>
          </div>
        </Show>
        <Show when={restoreOffer()}>
          <div class={styles.termRestore}>
            <span class={styles.termRestoreText}>
              {restoreOffer()!.count} terminal tab{restoreOffer()!.count > 1 ? "s" : ""} from last time
            </span>
            <Button variant="primary" size="sm" onClick={() => void acceptRestore(restoreOffer()!.ws)}>
              Restore
            </Button>
            <Button size="sm" onClick={() => markOffered(restoreOffer()!.ws)}>
              Dismiss
            </Button>
          </div>
        </Show>
      </div>
    </div>
  );
}
