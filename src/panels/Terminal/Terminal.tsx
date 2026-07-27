import { createSignal, createEffect, createMemo, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import TerminalView from "./TerminalView";
import OverflowTabBar from "../../components/OverflowTabBar";
import Menu from "../../components/Menu/Menu";
import Icon from "../../components/Icon/Icon";
import Tab from "../../components/Tab/Tab";
import Button from "../../components/Button/Button";
import { X, ChevronDown, SquareTerminal } from "lucide-solid";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import {
  on as onEvent,
  onWith,
  emitWith,
  CLOSE_TAB,
  OPEN_TERMINAL,
  NEW_SESSION,
  PURGE_UNDER_PATH,
  SEND_TO_SESSION,
  SEND_TO_SESSION_RESULT,
  TOAST,
  OPEN_TRANSCRIPT,
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
  type OpenTranscript,
} from "../../utils/events";
import { homeDir } from "@tauri-apps/api/path";
import { isUnderPath, sameCwd } from "../../utils/pathScope";
import { agents, ensureAgentsLoaded, findAgent, applyTemplate } from "../../utils/agents";
import { sanitizeForSend, bracketedPaste, sendWithProbeGate, type ProbeState } from "../../utils/safeSend";
import { liveStatuses } from "../../utils/sessionStatus";
import { loadTabs, saveTabs, toStore, mergeStore } from "../../utils/tabPersist";
import styles from "./Terminal.module.css";

// Mirrors src-tauri/src/sessions.rs's `TailState` (session_tail_state).
type TailState = "working" | "done" | "blocked-candidate";

// The subset of Selection focusOrResume actually reads - narrowed so
// safe-send's resume-into-tab path can call it without fabricating a full
// Selection (spaceName, projectKind, ... it never touches).
type ResumeTarget = Pick<Selection, "sessionId" | "agent" | "sessionFile" | "sessionTitle" | "sessionCwd" | "folderPath">;

type TabKind = "shell" | "agent" | "command";

type OpenTerm = {
  id: string;
  title: string;
  cwd: string;
  // The branch-unit anchor this tab is grouped under (the selected folderPath at
  // spawn), NOT the tab cwd: a nested session still groups with its branch unit.
  // Command tabs (clone/bootstrap) group under their own cwd.
  workspace: string;
  // Every shell/agent tab hosts a login shell; an agent tab is that shell seeded
  // with `init`. Command tabs (clone/bootstrap) spawn the program directly.
  kind: TabKind;
  program: string;
  args: string[];
  // Agent tabs: the command line typed into the shell once it's ready. Exiting
  // the agent drops back to the live shell rather than closing the tab.
  init?: string;
  // Agent tabs: the soft session id (the resumed uuid), distinct from the stable
  // shell tab id. Used to focus/resume in place (Phase 2), not for spawning.
  sessionId?: string;
  // Fresh (non-resumed) agent tabs only: when this tab was spawned, epoch
  // seconds. Used to attribute the session that appears afterward (see
  // `backfillFreshSessions`).
  spawnedAt?: number;
};

// Minimal shape of `list_sessions`' return, just what the backfill needs.
type BackfillSession = { id: string; cwd: string; agent?: string; created_at: number };

// The extra fields restore needs to hand a stored session back to focus-or-resume
// (or to the transcript viewer, for a resume-less adapter).
type RestoreSession = BackfillSession & { path: string; title: string; name?: string };

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
  ensureAgentsLoaded();
  const [open, setOpen] = createSignal<OpenTerm[]>([]);
  // Live tab labels that can change after a tab is created (a session rename),
  // keyed by tab id and overriding OpenTerm.title when present. Kept in a signal
  // rather than mutated onto the tab object because the tab bar keys tabs by
  // identity (gotcha #64) and never re-runs renderTab for a still-mounted tab,
  // so a plain-property title read would not repaint; a signal read does.
  const [tabTitles, setTabTitles] = createSignal<Record<string, string>>({});
  const tabTitle = (t: OpenTerm) => tabTitles()[t.id] ?? t.title;
  // A session-backed (agent) tab: its label tracks the session name (renamed
  // from the sidebar), and clicking it moves the sidebar selection to its session.
  const isSessionTab = (t: OpenTerm) => t.kind === "agent" && !!t.sessionId;
  // Tabs are grouped by workspace (branch-unit folder). Only the active
  // workspace's tabs show in the bar/stage; every other group stays mounted and
  // CSS-hidden so its PTYs keep running (gotcha #64). `activeWorkspace` is the
  // group on screen; `activeByWorkspace` remembers the focused tab per group.
  const [activeWorkspace, setActiveWorkspace] = createSignal<string | null>(null);
  const [activeByWorkspace, setActiveByWorkspace] = createSignal<Record<string, string>>({});

  // Last run's tab strip, read ONCE here during setup. This read must happen
  // before the persist effect below runs (effects run after the component body,
  // so it does): that effect writes the store from the live open set, which is
  // empty at startup, and would otherwise erase last run's tabs before anyone
  // could be offered them.
  const restorable = loadTabs(Date.now());
  // Workspaces already offered a restore this run, so the offer is one-shot per
  // workspace whether it was accepted or declined.
  const [offered, setOffered] = createSignal<Set<string>>(new Set());

  const tabsIn = (ws: string) => open().filter((t) => t.workspace === ws);
  const workspaceTabs = (): OpenTerm[] => {
    const ws = activeWorkspace();
    return ws ? tabsIn(ws) : [];
  };
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
    setActiveWorkspace(ws);
    setActiveByWorkspace({ ...activeByWorkspace(), [ws]: id });
  }

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
      if (d.kind === "agent" && d.sessionId) {
        const s = byId.get(d.sessionId);
        if (!s) {
          missingSessions++;
          continue;
        }
        const agentId = s.agent ?? "claude";
        if (findAgent(agentId).resume_args.length === 0) {
          // Resume-less adapter: the transcript is the only way back to it.
          emitWith<OpenTranscript>(OPEN_TRANSCRIPT, {
            id: s.id,
            sessionPath: s.path,
            agent: agentId === "pi" ? "pi" : "claude",
            name: s.name || s.title,
            cwd: s.cwd,
          });
          continue;
        }
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

  // The "+ Claude ›" split button's dropdown of yolo-mode launchers. The menu is
  // portalled to <body> and anchored to the caret because the tab bar clips
  // overflow, which would otherwise hide a menu rendered inside it.
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuPos, setMenuPos] = createSignal({ left: 0, top: 0 });
  let splitEl: HTMLDivElement | undefined;
  let caretEl: HTMLButtonElement | undefined;

  function toggleMenu() {
    if (menuOpen()) {
      setMenuOpen(false);
      return;
    }
    if (caretEl) {
      const r = caretEl.getBoundingClientRect();
      setMenuPos({ left: r.right, top: r.bottom + 4 });
    }
    setMenuOpen(true);
  }

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
        agent: o.kind === "agent" ? (o.program === "pi" ? "pi" : "claude") : undefined,
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
    const waiting = liveStatuses().filter((s) => s.status === "waitingForApproval");
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

  // Tabs (clone / bootstrap) that should re-discover projects when they exit.
  const rediscoverOnExit = new Set<string>();
  let offOpenTerminal: (() => void) | undefined;
  let offNewSession: (() => void) | undefined;
  let unlistenExit: UnlistenFn | undefined;
  let unlistenSessions: UnlistenFn | undefined;
  onMount(async () => {
    offOpenTerminal = onWith<OpenTerminal>(OPEN_TERMINAL, (t) => {
      if (t.rediscoverOnExit) rediscoverOnExit.add(t.id);
      openOrActivate({
        id: t.id,
        title: t.title,
        cwd: t.cwd,
        // Clone/bootstrap have no branch-unit yet, so they group under their own
        // cwd; opening one reveals that group so its progress is visible.
        workspace: t.cwd,
        kind: "command",
        program: t.program,
        args: t.args,
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
      const t = open().find((o) => o.id === id);
      if (t && t.kind !== "command") {
        closeId(id);
        return;
      }
      if (rediscoverOnExit.delete(id)) invoke("rediscover").catch(() => {});
    });
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

  // A fresh `+Claude`/`+Pi` tab carries no sessionId until its transcript
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
      if (t.kind === "agent" && t.sessionId) {
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
        if (sel.sessionId) void focusOrResume(sel);
      },
    ),
  );

  // Extra launch args a Sway-launched session gets that an externally-typed
  // `claude`/`pi`/`opencode` invocation never would (Phase 3): today just
  // claude's injected `--settings <json>` (crate::hooks), which scopes
  // hook-driven status to sessions this function actually spawned/resumed.
  async function hookArgs(agentId: string): Promise<string[]> {
    return invoke<string[]>("agent_hook_launch_args", { agentId }).catch(() => []);
  }

  async function focusOrResume(sel: ResumeTarget) {
    const sessionId = sel.sessionId!;
    const agentId = agents().some((a) => a.id === sel.agent) ? sel.agent! : "claude";
    const a = findAgent(agentId);
    const existing = open().find((t) => t.sessionId === sessionId);
    if (existing) {
      focusTab(existing.workspace, existing.id);
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
  async function probeSessionState(req: SendToSession): Promise<ProbeState> {
    if (!open().some((t) => t.sessionId === req.sessionId)) return "not-ready";
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
    if (!open().some((t) => t.sessionId === req.sessionId)) {
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
        const tab = open().find((o) => o.sessionId === req.sessionId);
        if (!tab) throw new Error("session tab closed mid-send");
        await invoke("pty_write", { id: tab.id, data: bracketedPaste(t) });
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }).catch((): { kind: "timeout" } => ({ kind: "timeout" }));
    if (result.kind === "blocked") {
      emitWith<ToastEvent>(TOAST, { message: "Session is waiting for permission, answer it first.", kind: "error" });
    } else if (result.kind === "timeout") {
      emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session in time, try again.", kind: "error" });
    }
    emitWith<SendToSessionResult>(SEND_TO_SESSION_RESULT, { requestId: req.requestId, result: result.kind });
  }

  // A new session starts in the branch-unit folder (already the right checkout).
  // Launch args come from the adapter: base args, plus its yolo args when asked
  // (claude's skip permission prompts; pi's is empty - it launches yolo already),
  // plus any Sway-launched-only hook args (Phase 3).
  async function spawnSession(agentId: string, folderPath: string, projectName: string, yolo = false) {
    const a = findAgent(agentId);
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
    invoke("pty_kill", { id }).catch(() => {});
    setOpen(open().filter((o) => o.id !== id));
    // No active-tab bookkeeping needed: visibleId() falls back to the workspace's
    // first tab when its remembered id is now gone.
  }

  function close(id: string, e: MouseEvent) {
    e.stopPropagation();
    closeId(id);
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
            active={visibleId() === t.id}
            onClick={() => selectTab(t)}
            title={t.cwd}
            closeLabel="Close"
            onClose={(e) => close(t.id, e)}
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
          <div class={styles.termNewSplit} ref={splitEl}>
            {/* Main half: quick new shell (terminal icon). Caret half: launch an
                agent session from a fixed three-option menu. */}
            <button
              class={`${styles.termNew} ${styles.termNewMain}`}
              disabled={!props.selected}
              title={props.selected ? `New shell in ${props.selected.projectName}` : "Select a branch first"}
              onClick={newShell}
            >
              <Icon icon={SquareTerminal} />
            </button>
            <button
              ref={caretEl}
              class={`${styles.termNew} ${styles.termNewCaret}`}
              disabled={!props.selected}
              title="Launch an agent session"
              aria-haspopup="menu"
              aria-expanded={menuOpen()}
              onClick={toggleMenu}
            >
              <Icon icon={ChevronDown} class={styles.termNewChevron} />
            </button>
            <Show when={menuOpen()}>
              <Menu
                x={menuPos().left}
                y={menuPos().top}
                anchorEl={splitEl}
                onClose={() => setMenuOpen(false)}
                items={[
                  { label: findAgent("claude").label, onClick: () => newSession("claude") },
                  { label: `${findAgent("claude").label} (yolo)`, onClick: () => newSession("claude", true) },
                  { label: `${findAgent("pi").label} (yolo)`, onClick: () => newSession("pi", true) },
                ]}
              />
            </Show>
          </div>
        }
      />

      <div class={styles.termStage}>
        {/* Every tab is always mounted (CSS-hidden unless it is the visible one),
            so switching workspaces never unmounts a group's PTYs (gotcha #64).
            The empty message is an overlay, not a fallback that would replace
            (and thus unmount) the tabs. */}
        <For each={open()}>
          {(t) => (
            <TerminalView
              id={t.id}
              cwd={t.cwd}
              kind={t.kind}
              program={t.program}
              args={t.args}
              init={t.init}
              sessionId={t.sessionId}
              active={visibleId() === t.id}
            />
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
