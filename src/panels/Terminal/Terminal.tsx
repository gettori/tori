import { createSignal, createEffect, createMemo, on, onCleanup, onMount, untrack, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import TerminalView, { type PtyExit } from "./TerminalView";
import ChatView from "../Chat/ChatView";
import ChatDraft from "../Chat/ChatDraft";
import Dropdown from "../../components/Menu/Dropdown";
import Icon from "../../components/Icon/Icon";
import TabMark from "./TabMark";
import { TabMemberChip } from "../../components/MemberChip/MemberChip";
import HistoryPanel from "./HistoryPanel";
import Button from "../../components/Button/Button";
import { X, ChevronDown, Plus, History, CircleDashed } from "lucide-solid";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import {
  on as onEvent,
  onWith,
  emitWith,
  CLOSE_TAB,
  OPEN_TERMINAL,
  COMPOSE_DRAFT,
  OPEN_JOB,
  type OpenJob,
  REVEAL_DOCK,
  type RevealDock,
  NEW_DOCK_SHELL,
  OPEN_SHELL_AT,
  type OpenShellAt,
  NEW_SESSION,
  PURGE_UNDER_PATH,
  PURGE_WORKSPACE,
  type PurgeWorkspace,
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
  type ComposeDraft,
  type ToastEvent,
  type TabJump,
  type FocusSessionTab,
  type TerminalTabFocused,
} from "../../utils/events";
import { homeDir } from "@tauri-apps/api/path";
import {
  agentEnabled,
  agentOffReason,
  draftChatAgent,
  draftChatProfile,
} from "../../utils/agentEnabled";
import {
  asProfileId,
  asTabProfile,
  ensureAgentHealthLoaded,
  namedProfiles,
  refreshAgentHealth,
  profileLabel,
} from "../../utils/agentHealth";
import { isUnderPath, sameCwd } from "../../utils/pathScope";
import {
  isFeatureKey,
  isShellsKey,
  selectionRoot,
  SHELLS_KEY,
  workspaceFolders,
  workspaceKey,
} from "../../utils/features";
import { commandStatus, commandVerdict, dropCommandStatus, reportCommandExit } from "./commandStatus";
import { dropInitRefusal, initRefusal, refuseInit } from "./initRefusal";
import { createFeatureMembers, memberFor, type TintedMember } from "../../utils/featureMembers";
import {
  agents,
  chatCapable,
  ensureAdaptersLoaded,
  findAdapter,
  agentIdForProgram,
  applyTemplate,
} from "../../utils/agents";
import { BLOCKED_REASON, sanitizeForSend, bracketedPaste, sendWithProbeGate, type ProbeState } from "../../utils/safeSend";
import { awaitingUser, blockedOnUser, type SessionStatus } from "../../utils/sessionStatus";
import type { StatusCertainty } from "../../utils/sessionDot";
import { liveSessionStatuses, sessionStatus } from "../../utils/sessionActivity";
import { sessions } from "../../utils/sessionStore";
import {
  loadTabs,
  saveTabs,
  toStore,
  mergeStore,
  restoreId,
  activeIndex,
  type WorkspaceTabs,
} from "../../utils/tabPersist";
import { profileEnv } from "../../utils/profileEnv";
import { debounce } from "../../utils/debounce";
import { chatTabLabel } from "../../utils/chatConcurrency";
import { liveChatIds, liveChats } from "../../utils/chatSessions";
import { clearComposer, draftFor, offerToComposer, routeFor, setDraft } from "../../utils/chatCompose";
import { clearDraftPick, draftPick, pickRidesArgv, setDraftPick } from "../../utils/chatDraftPick";
import { resumedPicks } from "../../utils/chatModels";
import { holdingTab, refusalMessage, type Refusal } from "../../utils/chatOwnership";
import { routeSelection, restoreRoute } from "../../utils/sessionSurface";
import { chatPrefs, rememberChatPrefs, settings } from "../Settings/settingsStore";
import {
  advanceTabState,
  canRevertToDraft,
  dropTabState,
  isChatDraft,
  open,
  seedInert,
  setOpen,
  setTabTitles,
  stateOnActivate,
  tabState,
  tabTitle,
  activeWorkspace,
  setActiveWorkspace,
  activeByWorkspace,
  setActiveByWorkspace,
  tabsIn,
  activeIdIn,
  visibleId,
  focusTab,
  focusDockTab,
  resetTerminalTabModel,
  type OpenTerm,
  type TabKind,
} from "./terminalTabStore";
import { nextActiveAfterClose } from "../../layout/paneLayout";
import { kindPaneFocused, revealKindPane } from "../../layout/layoutStore";
import { dockFocused, showDock } from "../../layout/dockStore";
import { stageHost, dropStageHost } from "../../tabs/stageHost";
import { forgetTab } from "../../layout/tabPlacement";
import { paneMenuItems, visibleInPane } from "../../tabs/paneTabs";
import ContextMenu from "../../components/Menu/ContextMenu";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import { unifiedTabs, unifyTerm, type TerminalUnifiedTab, type UnifiedTab } from "../../tabs/unifiedTabs";
import { registerKind, kindEntry, type TabDescriptor } from "../../tabs/registry";
import styles from "./Terminal.module.css";
import patterns from "../../styles/patterns.module.css";
import Tooltip from "../../components/Tooltip/Tooltip";

// Mirrors src-tauri/src/sessions.rs's `TailState` (session_tail_state).
type TailState = "working" | "done" | "blocked-candidate";

// The subset of Selection focusOrResume actually reads - narrowed so
// safe-send's resume-into-tab path can call it without fabricating a full
// Selection (spaceName, projectKind, ... it never touches).
type ResumeTarget = Pick<
  Selection,
  "sessionId" | "agent" | "profile" | "sessionFile" | "sessionTitle" | "sessionCwd" | "folderPath"
>;

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
type BackfillSession = { id: string; cwd: string; agent?: string; profile?: string | null; created_at: number };

// The extra fields restore needs to hand a stored session back to focus-or-resume
// (or to the transcript viewer, for a resume-less adapter).
type RestoreSession = BackfillSession & { path: string; title: string; name?: string };

// Every kind except `chat` is shell-hosted, which is exactly what TerminalView
// takes. Narrowed here rather than by widening TerminalView's prop, because a
// chat tab genuinely cannot be rendered by it.
type PtyTab = OpenTerm & { kind: Exclude<TabKind, "chat"> };

// How long a draft's composer sits still before the tab store is rewritten.
// Long enough that typing never writes localStorage, short enough that a pause
// to think is already saved.
const DRAFT_SAVE_MS = 500;

// A stable, unique id for a shell-hosted tab. Deliberately not the session uuid:
// one shell can host successive agents, and the uuid is a soft attribute.
function shellId(): string {
  return `sh:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

// The same for a chat tab, which hosts no shell and so has no PTY to name it.
function chatId(): string {
  return `chat:${crypto.randomUUID()}`;
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
  // The sweep too, and for the same reason: the launch menu offers the agent
  // terminal once per account, and an unread sweep names no accounts at all -
  // so a two-account install would get one unlabelled row until some other
  // surface happened to load it. A cached read, no subprocess.
  ensureAgentHealthLoaded();
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
  // Workspaces this run has already restored, so a switch away and back does not
  // run it a second time. A workspace with nothing stored counts as restored the
  // moment it is looked at: there is no second answer to give.
  const [restored, setRestored] = createSignal<Set<string>>(new Set());

  /**
   * What the backend is holding right now.
   *
   * Two listings in two key spaces: `chat_live_sessions` answers in **session**
   * ids and `pty_live_ids` in **frontend tab** ids, because that is what each
   * host is keyed by. A restored tab is matched against its own one.
   *
   * Asked per restore rather than cached for the run. A workspace is restored
   * on first visit, which can be an hour after startup, and a cached answer
   * would still name a PTY that exited in between - so the tab would come back
   * `live`, mount its surface, find nothing to rewire and **spawn**, which is
   * the eager path this whole ticket exists to remove.
   *
   * A listing that fails answers empty, which restores everything inert. That
   * is the safe direction: an inert tab spawns nothing and can still be reached
   * for, where a wrong `live` spawns.
   */
  const backendLive = () =>
    Promise.all([
      invoke<string[]>("chat_live_sessions").catch(() => [] as string[]),
      invoke<string[]>("pty_live_ids").catch(() => [] as string[]),
    ]).then(([chat, pty]) => ({ chat: new Set(chat), pty: new Set(pty) }));

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
    if (isShellsKey(t.workspace)) return focusDockTab(t.id);
    focusTab(t.workspace, t.id);
    if (isFeatureKey(t.workspace)) return;
    emitWith<TerminalTabFocused>(TERMINAL_TAB_FOCUSED, {
      folderPath: t.workspace,
      sessionId: isSessionTab(t) ? t.sessionId : undefined,
    });
  }

  // How many restores are in flight. A count rather than a flag because a
  // workspace switch can start a second one while the first is still awaiting,
  // and the first to finish must not un-suppress the other.
  const [restoring, setRestoring] = createSignal(0);

  /**
   * Restore this workspace's strip, once per run.
   *
   * Automatic since the tabs it brings back cost nothing: a restored tab is an
   * entry until it is reached for. The banner it replaces existed to stop a
   * relaunch from silently spawning agent processes, and that is now a property
   * of what a restored tab *is* rather than of a question asked first.
   *
   * The workspace is marked before the first `await`, so the effect below can
   * re-run freely while this is still in flight.
   */
  async function restoreWorkspace(ws: string) {
    setRestored(new Set(restored()).add(ws));
    const entry = restorable[ws];
    if (!entry?.tabs.length) return;
    setRestoring(restoring() + 1);
    const done = restoreInto(ws, entry).finally(() => {
      setRestoring(restoring() - 1);
      inFlight.delete(ws);
    });
    inFlight.set(ws, done);
    await done;
  }

  /**
   * This workspace's strip, brought back if it has not been already.
   *
   * Anything that decides whether to *open* a tab has to go through here first.
   * Restore is both automatic and asynchronous now, so a decision made from
   * `open()` at launch is made against an empty strip that is about to be
   * filled: "no tab hosts this session" is answered wrong, and a second tab is
   * opened for a session the restore was already bringing back. The duplicate
   * is persisted, so the next launch starts from two and the strip grows by one
   * every time.
   *
   * Waiting on an in-flight restore is not enough on its own. The effect above
   * only starts one once `activeWorkspace` is set, and it is the **selection**
   * that sets it - so at launch the selection runs first, with nothing yet in
   * flight to wait for. So this starts the restore rather than only joining it,
   * and `restoreWorkspace` marks the workspace before its first `await`, which
   * is what keeps the effect from running a second one.
   *
   * A plain map rather than a signal: nothing renders from it, and every caller
   * is already async.
   */
  const inFlight = new Map<string, Promise<void>>();
  async function stripReady(ws: string) {
    const running = inFlight.get(ws);
    if (running) return running;
    if (!restored().has(ws)) await restoreWorkspace(ws);
  }

  // On first visit, per workspace. Suppressed while first-run onboarding is open
  // (and re-evaluated when it closes, since this reads the flag), so someone
  // meeting Sway does not get last run's tabs drawn behind the welcome.
  createEffect(() => {
    if (props.onboarding) return;
    const ws = activeWorkspace();
    if (!ws || restored().has(ws)) return;
    // Only into an empty group: a workspace that already has tabs open is about
    // to have its stored set overwritten by current truth anyway.
    if (tabsIn(ws).length) return;
    void restoreWorkspace(ws);
  });

  /**
   * Say what the backend is holding that no stored tab can reach.
   *
   * Measured against the **whole** `sway.terminalTabs` store, not the workspace
   * being restored. Only one workspace is visited on a reload, so a check
   * scoped to the restored subset would call every other workspace's live
   * session stranded - which is the opposite of true: those come back the
   * moment their workspace is looked at.
   *
   * What is left really is unreachable. A PTY whose tab record is gone has no
   * id anything will ever ask for again, and a chat session no tab names is one
   * only the session list can still find.
   */
  async function reportStranded() {
    const live = await backendLive();
    const storedTabs = new Set<string>();
    const storedSessions = new Set<string>();
    for (const entry of Object.values(restorable)) {
      for (const t of entry.tabs) {
        if (t.id) storedTabs.add(t.id);
        if (t.sessionId) storedSessions.add(t.sessionId);
      }
    }
    const ptys = [...live.pty].filter((id) => !storedTabs.has(id)).length;
    const chats = [...live.chat].filter((id) => !storedSessions.has(id)).length;
    const total = ptys + chats;
    if (!total) return;
    emitWith<ToastEvent>(TOAST, {
      message: `${total} process${total > 1 ? "es" : ""} ${
        total > 1 ? "are" : "is"
      } still running with no tab left to reach ${total > 1 ? "them" : "it"}.`,
      kind: "info",
    });
  }

  // A `feature:<id>` workspace spans its member folders, so a per-folder
  // listing is unioned. Only the selected Feature's roots are known here; a
  // Feature that is not selected lists nothing.
  async function listSessionsFor<T>(ws: string): Promise<T[]> {
    const lists = await Promise.all(
      workspaceFolders(ws, props.selected).map((folder) =>
        invoke<T[]>("list_sessions", { folder }).catch(() => [] as T[]),
      ),
    );
    return lists.flat();
  }

  async function restoreInto(ws: string, entry: WorkspaceTabs) {
    // Waited for rather than assumed: a stored draft names its harness, and
    // checking that name against a list that has not arrived would answer "no
    // such agent" for every one of them and restore the lot onto claude.
    await ensureAdaptersLoaded();
    // One scan for the whole workspace: every stored session is checked against
    // it, so a session deleted since last run is skipped rather than resumed
    // into a dead id.
    const sessions = await listSessionsFor<RestoreSession>(ws);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    let missingSessions = 0;
    let missingProfiles = 0;
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
    // The id a stored entry comes back under, refusing one anything open
    // already holds. Read live rather than from a snapshot taken up front: this
    // loop awaits, and `openOrActivate` lands its tab synchronously, so `open()`
    // is the only thing that stays true across both.
    //
    // Named for the seeding, not the id: the write is the whole of what makes a
    // restore lazy. Seeded before the tab exists, so a restored tab never mounts
    // a surface or spawns a process, not even for the frame between opening it
    // and recording what it is.
    //
    // Unless the backend is still holding this one, which is a webview reload
    // rather than a relaunch. Then the seed is skipped and `defaultState` reads
    // the tab as `live`, so its surface mounts at once and re-subscribes: a
    // detached PTY's output is dropped rather than buffered, so a tab that
    // waited to be clicked would come back missing whatever ran meanwhile.
    //
    // `hosts` is asked in the surface's own key. A chat ignores the id it comes
    // back under, because the host is keyed by session and rewires whichever tab
    // subscribes; a terminal cannot, because the id **is** the key, and a
    // collision hands back a fresh one that names nothing.
    const live = await backendLive();
    const restoredId = (stored: string | undefined, fresh: () => string, hosts: (id: string) => boolean) => {
      const id = restoreId(stored, new Set(open().map((t) => t.id)), fresh);
      if (!hosts(id)) seedInert(id);
      return id;
    };
    /** A draft has no child to be holding, on either key. */
    const never = () => false;

    for (const [i, d] of entry.tabs.entries()) {
      // Restore is routed on the stored kind alone, never on the default-surface
      // preference: a workspace saved with agent tabs comes back as agent tabs
      // on an install where chat is now the default. See `restoreRoute`.
      const surface = restoreRoute(d.kind);
      if (surface === "chat" && !d.sessionId) {
        // A draft: there is no session to resume and nothing to respawn, so it
        // comes back as the same unstarted tab, holding what was typed into it
        // and what it was set to run as. Still no process and no claim - a
        // restored draft costs exactly what an opened one does.
        //
        // Opened directly rather than through `openChatTab`, which exists to
        // *name* a new chat and would run the stored title back through
        // `chatTabLabel`. That is a relabel, not a restore: "Hello chat" comes
        // back as "Hello chat chat", and again every launch. The stored title
        // is already the answer that function gave when the tab was made.
        const id = restoredId(d.id, chatId, never);
        openOrActivate(
          {
            id,
            title: d.title,
            cwd: await cwdFor(d.cwd),
            workspace: ws,
            kind: "chat",
            program: storedChatAgent(d.program),
            args: [],
            profile: d.profile ?? null,
          },
          false,
        );
        if (d.text) setDraft(id, d.text);
        if (d.pick) setDraftPick(id, d.pick);
        producedId[i] = id;
        continue;
      }
      if (surface === "chat" && d.sessionId) {
        // Chat restores by resuming its own session id, not by respawning a
        // shell. A session deleted since last run is skipped like any other.
        if (!byId.has(d.sessionId)) {
          missingSessions++;
          continue;
        }
        const id = restoredId(d.id, chatId, () => live.chat.has(d.sessionId!));
        const s = byId.get(d.sessionId)!;
        openOrActivate({
          id,
          // The session's own name wins over the stored one, on the same rule
          // `syncTabTitles` and `focusOrResume` already use: a rename lands on
          // the session, so that is where the current name is. It also heals a
          // store written before the title was persisted through `tabTitle`,
          // which is every store that has a chat in it today.
          title: (s.name || s.title || d.title).slice(0, 28),
          cwd: await cwdFor(d.cwd),
          workspace: ws,
          kind: "chat",
          program: d.program || "claude",
          args: [],
          // The listing's answer wins over the stored one: both name an
          // account, but the listing's comes from the root that actually held
          // the transcript, which is the same authority `chat_spawn` resolves
          // against. Preferring the store would turn a profile renamed since
          // last launch into a refused resume.
          profile: asTabProfile(s.profile ?? d.profile),
          sessionId: d.sessionId,
          resume: true,
          // Resumed, not re-forked: the fork happened last run and its
          // conversation is in this session's own transcript now. The marker
          // rides along only so the tab keeps saying the agent remembers turns
          // that were undone, which is still true.
          rewindTo: d.rewindTo,
        },
        false,
      );
        // What was typed at this conversation while nothing was driving it, and
        // what it was running.
        //
        // The pick used to be left behind here, on the reasoning that the
        // session already has a model. That holds for the model and for nothing
        // else: measured on claude 2.1.251, a resumed session reports the model
        // it had and comes back on the CLI's *default* permission mode, with no
        // effort level reported at all. So the pick is the only record of what
        // this conversation was set to, and the spawn below re-asserts it.
        if (d.text) setDraft(id, d.text);
        if (d.pick) setDraftPick(id, d.pick);
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
        const id = restoredId(d.id, shellId, (id) => live.pty.has(id));
        await focusOrResume(
          {
            sessionId: s.id,
            agent: agentId,
            // The root the transcript was found under, not the stored id: a
            // session resumes into the home it is actually in.
            profile: asTabProfile(s.profile ?? d.profile),
            sessionFile: s.path,
            sessionTitle: s.name || s.title,
            sessionCwd: s.cwd,
            folderPath: ws,
          },
          id,
          false,
        );
        const landed = open().find((t) => t.sessionId === s.id)?.id;
        producedId[i] = landed;
        // A tab already hosting this session is focused rather than opened, so
        // the id seeded above was never taken up; leaving its record behind
        // would sit there inert for a tab that does not exist.
        if (landed !== id) dropTabState(id);
        continue;
      }
      // A plain shell, or an agent tab whose session was never attributed: come
      // back as the same shell-hosted tab, seeded again if it had an init.
      const cwd = await cwdFor(d.cwd);
      // Derived here, not restored: a stored env would respawn against a home
      // that may have been renamed or removed since. A profile that no longer
      // resolves drops the tab rather than respawning it on the user's own
      // login under a label that says otherwise.
      const profile = d.kind === "agent" ? (d.profile ?? null) : null;
      let env: Record<string, string> | undefined;
      if (d.kind === "agent") {
        env = await profileEnv(agentIdForProgram(d.program), profile).catch(() => undefined);
        if (!env) {
          missingProfiles++;
          continue;
        }
      }
      const id = restoredId(d.id, shellId, (id) => live.pty.has(id));
      openOrActivate({
        id,
        title: d.title,
        cwd,
        workspace: ws,
        kind: d.kind,
        program: d.program,
        args: d.args,
        profile,
        ...(env && Object.keys(env).length ? { env } : {}),
          ...(d.kind === "agent" && d.program ? { init: agentInit(d.program, d.args) } : {}),
        },
        false,
      );
      producedId[i] = id;
    }

    // Refocus whatever the stored active entry actually produced. Restoring in
    // order leaves the last tab focused otherwise, which is rarely the one that
    // was in front. Resolved through `producedId` either way, so a skipped
    // session leaves the focus alone rather than handing it to a neighbour.
    const activeAt = activeIndex(entry);
    const targetId = activeAt >= 0 ? producedId[activeAt] : undefined;
    if (targetId) focusTab(ws, targetId);

    const notices: string[] = [];
    if (missingSessions) notices.push(`${missingSessions} session${missingSessions > 1 ? "s" : ""} no longer exist`);
    if (missingProfiles)
      notices.push(`${missingProfiles} tab${missingProfiles > 1 ? "s" : ""} ran on an account that is gone`);
    if (relocated) notices.push(`${relocated} folder${relocated > 1 ? "s" : ""} missing, opened in your home directory`);
    if (notices.length) emitWith<ToastEvent>(TOAST, { message: `Restored tabs: ${notices.join("; ")}.`, kind: "info" });
  }

  // --- History dropdown -------------------------------------------------------

  const [historyOpen, setHistoryOpen] = createSignal(false);
  // Set by the press rather than by a ref: every pane's strip mounts this
  // cluster (phase 13), so the anchor is whichever button was clicked.
  const [historyEl, setHistoryEl] = createSignal<HTMLElement | undefined>();

  const toggleHistory = (e: MouseEvent) => {
    setHistoryEl(e.currentTarget as HTMLElement);
    setHistoryOpen(!historyOpen());
  };

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
    // Only a live tab hosts its session. A restored tab nobody reached for
    // names a session it is not driving, and counting it as hosted would hide
    // exactly the case this button is about: running here, with no tab on it.
    const hosted = new Set(open().filter((t) => tabState(t) === "live").map((t) => t.sessionId));
    return (sessions()[ws] ?? []).filter(
      (s) => !hosted.has(s.id) && sessionStatus(s.id) !== "none",
    ).length;
  });

  // Where the panel says you are. The selection carries the names when it is
  // pointed here; otherwise the folder's own tail is all there is to say.
  const historyCrumb = (): string[] => {
    const ws = activeWorkspace() ?? "";
    const sel = props.selected;
    if (sel && workspaceKey(sel) === ws) {
      if (sel.kind === "feature") return [sel.featureName ?? sel.projectName, sel.branch];
      return [sel.spaceName, sel.projectName, sel.branch];
    }
    return ws.split("/").filter(Boolean).slice(-2);
  };

  // Surface the live tabs (id + workspace + kind + soft sessionId + agent +
  // state) so the sidebar can count what's running for its confirms and probe
  // the right per-agent pgrep pattern for the status dot.
  //
  // `state` rides along because since lazy restore a tab is no longer proof
  // that anything is running; every consumer reads it rather than the tab's
  // mere existence.
  createEffect(() =>
    props.onOpenChange?.(
      open().map((o) => {
        // A refused agent tab is its shell and nothing more, so it is counted as one.
        const refused = !!initRefusal(o.id);
        return {
          id: o.id,
          workspace: o.workspace,
          kind: refused ? "shell" : o.kind,
          cwd: o.cwd,
          sessionId: refused ? undefined : o.sessionId,
          agent: !refused && (o.kind === "agent" || o.kind === "chat") ? agentIdForProgram(o.program) : undefined,
          state: tabState(o),
        };
      }),
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
  // Whether a chat tab has a child on the other end. The persist rule is "a chat
  // with no live child keeps what was typed at it", which covers a draft and a
  // restored chat opened only to read: neither has a session to carry the text.
  const chatIsLive = (t: OpenTerm) => t.kind === "chat" && tabState(t) === "live";
  // A draft's unsent text and its pick live in stores of their own, keyed by tab
  // id. Read here rather than inside `tabPersist`, which stays a pure fold over
  // whatever it is handed.
  //
  // The **title** is read the same way, and for the same reason. `t.title` is
  // captured when the tab is made and never changes; what the strip actually
  // renders is `tabTitle`, the override `syncTabTitles` and a rename write. So
  // persisting `t.title` stored the label a chat was born with - "<session>
  // chat", straight out of `chatTabLabel` - and threw away the session's real
  // name every save. Nothing showed it until restore ran on its own: the
  // override lands a moment after the tab opens, so the wrong title was only
  // ever on screen for a frame, and only the store kept it.
  const withDrafts = (tabs: readonly OpenTerm[]) =>
    tabs.map((t) => {
      const named = { ...t, title: tabTitle(t) };
      if (named.kind !== "chat") return named;
      // The pick goes down either way. A live chat's session restores its own
      // model and nothing else: `--permission-mode` and `--effort` are
      // per-process flags a resume does not carry, so this is the only record
      // of two of the three. Its *text* is still left behind, which is the
      // half a running conversation really does have somewhere else to keep.
      if (chatIsLive(named)) return { ...named, live: true, pick: draftPick(t.id) };
      return { ...named, live: false, text: draftFor(t.id), pick: draftPick(t.id) };
    });

  function saveTabStore(tabs: readonly OpenTerm[], active: Record<string, string>) {
    const live = toStore(untrack(() => withDrafts(tabs)), active, Date.now());
    for (const ws of Object.keys(live)) touched.add(ws);
    saveTabs(mergeStore(restorable, live, touched));
  }

  createEffect(() => saveTabStore(open(), activeByWorkspace()));

  // The same save, armed by a keystroke instead of run by one. Composer text
  // changes on every key, and this store is a single localStorage key covering
  // every workspace, so writing it per keypress is the one frequency it cannot
  // afford. What is lost by the delay is the last few hundred ms of typing in a
  // draft, on a quit that lands inside the window.
  const saveDrafts = debounce(() => saveTabStore(open(), activeByWorkspace()), DRAFT_SAVE_MS);
  createEffect(() => {
    for (const t of open()) {
      // Read for the subscription, not for the value: touching these stores is
      // the whole of what makes a keystroke, or a landed switch, arm the timer
      // below.
      if (t.kind !== "chat") continue;
      // Every chat, live or not: a live one's pick moves when a model or mode
      // switch lands, and that is what the next launch resumes it on.
      draftPick(t.id);
      if (!chatIsLive(t)) draftFor(t.id);
    }
    saveDrafts();
  });
  onCleanup(() => saveDrafts.cancel());

  // Every tab key below is pane-scoped (plan phase 6): the editor panel
  // listens to the same events for its own tabs, and the focused pane is what
  // decides which listener acts, so one keystroke never lands twice.
  const paneFocused = () => kindPaneFocused(activeWorkspace() ?? "", "shell");
  // The group the tab keys address: the dock's while it holds them.
  const keyedGroup = () => (dockFocused() ? SHELLS_KEY : paneFocused() ? activeWorkspace() : null);
  const focusIn = (ws: string, id: string) => (isShellsKey(ws) ? focusDockTab(id) : focusTab(ws, id));

  // Cmd+W. Not the strip's close button, which stays immediate: the keystroke
  // is blind (whatever happens to be active), so the busy cases ask first.
  const offClose = onEvent(CLOSE_TAB, () => {
    const ws = keyedGroup();
    const id = ws ? activeIdIn(ws) : null;
    if (id) void closeGuarded(id);
  });
  onCleanup(offClose);

  // Cmd+1..9: jump to tab N (0-indexed) of the keyed group's bar. `tabsIn(ws)`
  // is canonical order, already reflecting any drag-reorder the bar applied via
  // `mergeReorder`.
  const offTabJump = onWith<TabJump>(TAB_JUMP, ({ index }) => {
    const ws = keyedGroup();
    if (!ws) return;
    const tab = tabsIn(ws)[index];
    if (tab) focusIn(ws, tab.id);
  });
  onCleanup(offTabJump);

  // Ctrl+Tab: cycle to the next tab in the keyed group, wrapping around.
  const offTabCycle = onEvent(TAB_CYCLE, () => {
    const ws = keyedGroup();
    if (!ws) return;
    const tabs = tabsIn(ws);
    if (!tabs.length) return;
    const idx = tabs.findIndex((t) => t.id === activeIdIn(ws));
    focusIn(ws, tabs[(idx + 1) % tabs.length].id);
  });
  onCleanup(offTabCycle);

  // Cmd+Shift+A: focus the next live session whose status is "Waiting for
  // approval" (Phase 1's shared status store), across every workspace/space,
  // cycling from whichever waiting session (if any) is currently focused.
  const offNextWaiting = onEvent(NEXT_WAITING_SESSION, () => {
    const waiting = liveSessionStatuses().filter((s) => awaitingUser(s.status));
    if (!waiting.length) return;
    const idx = waiting.findIndex((w) => w.tabId === visibleId());
    const next = waiting[(idx + 1) % waiting.length];
    const tab = open().find((t) => t.id === next.tabId);
    if (tab) {
      // Pane-aware (plan phase 6): a hidden or unfocused pane is revealed and
      // focused before the tab inside it, or the jump lands off screen.
      revealKindPane(tab.workspace, tab.kind);
      focusTab(tab.workspace, tab.id);
    }
  });
  onCleanup(offNextWaiting);

  // Command palette "focus session" action: the session is already open in a
  // tab, so just reveal it (no resume needed).
  const offFocusSessionTab = onWith<FocusSessionTab>(FOCUS_SESSION_TAB, ({ tabId }) => {
    const tab = open().find((t) => t.id === tabId);
    if (tab) {
      revealKindPane(tab.workspace, tab.kind);
      focusTab(tab.workspace, tab.id);
    }
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

  // A workspace key is gone (a Feature was deleted): close its tabs, and mark
  // it touched so the persisted store drops it rather than restoring it later.
  const offPurgeWs = onWith<PurgeWorkspace>(PURGE_WORKSPACE, ({ workspace }) => {
    for (const t of open()) {
      if (t.workspace === workspace) closeId(t.id);
    }
    touched.add(workspace);
    saveTabStore(open(), activeByWorkspace());
  });
  onCleanup(offPurgeWs);

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

  // Why a chat tab's first send never reached a session, per tab, for the draft
  // it just became. Held out here rather than on the tab record for the same
  // reason a renamed tab's title is (gotcha #64): the record's identity is what
  // mounts the surface, so writing a message onto it would remount the draft
  // this message is meant to be read in.
  const [draftErrors, setDraftErrors] = createSignal<Record<string, string>>({});
  const draftError = (tabId: string) => draftErrors()[tabId];

  function clearDraftError(tabId: string) {
    if (!(tabId in draftErrors())) return;
    const next = { ...draftErrors() };
    delete next[tabId];
    setDraftErrors(next);
  }

  // The way out of every refusal, on both surfaces: a brand-new session id
  // cannot collide with the one that is already held.
  function forkFrom(tab: OpenTerm) {
    // The refused tab spawned nothing, so it is an empty shell that would sit
    // in the bar forever. Closing it also clears its refusal.
    closeId(tab.id);
    // On the refused tab's own account: a fork is the same work under a new
    // session id, and moving it to another login would be a different session.
    void spawnSession(tab.program, tab.workspace, tab.workspace.split("/").pop() || tab.program, false, tab.workspace, tab.profile);
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

  let offOpenTerminal: (() => void) | undefined;
  let offNewSession: (() => void) | undefined;
  let offOpenJob: (() => void) | undefined;
  let offRevealDock: (() => void) | undefined;
  let offNewDockShell: (() => void) | undefined;
  let offShellAt: (() => void) | undefined;
  let offComposeDraft: (() => void) | undefined;
  let unlistenExit: UnlistenFn | undefined;
  let unlistenRefused: UnlistenFn | undefined;
  let unlistenSessions: UnlistenFn | undefined;
  onMount(async () => {
    offOpenTerminal = onWith<OpenTerminal>(OPEN_TERMINAL, (t) => {
      openOrActivate({
        id: t.id,
        title: t.title,
        cwd: t.cwd,
        // A task runs *at* its branch-unit, so this groups it with that unit's
        // other tabs. Sound for the only kind still arriving here: the ones
        // whose cwd was not a branch unit are jobs now.
        workspace: t.cwd,
        kind: t.kind,
        program: t.program,
        args: t.args,
        // A task tab hosts a login shell running a command line, not an agent
        // signed in to anything, so it has no account to be on.
        profile: null,
        ...(t.init ? { init: t.init } : {}),
      });
    });
    offOpenJob = onWith<OpenJob>(OPEN_JOB, openCommand);
    offRevealDock = onWith<RevealDock>(REVEAL_DOCK, ({ tabId }) => revealDock(tabId));
    offNewDockShell = onEvent(NEW_DOCK_SHELL, () => void newShellInDock());
    offShellAt = onWith<OpenShellAt>(OPEN_SHELL_AT, ({ cwd }) => newShell(cwd));
    // Settings has no Selection, so it describes a draft and this decides where
    // it lands. Its own guard, not the sender's: the panel's copy of the root
    // was read when it opened, and the selection can have moved since.
    offComposeDraft = onWith<ComposeDraft>(COMPOSE_DRAFT, (d) => {
      const sel = props.selected;
      const root = selectionRoot(sel);
      if (!sel || !root) {
        emitWith<ToastEvent>(TOAST, { message: "Select a project first", kind: "info" });
        return;
      }
      const ws = workspaceKey(sel);
      const agent = draftAgent(ws);
      if (!agent) return;
      const tabId = openChatDraft(ws, root, sel.projectName, agent, draftProfile(ws, agent));
      // Offered, never sent. The user reads what is in the box and decides.
      offerToComposer(tabId, d.blocks);
      focusTab(ws, tabId);
    });
    // Sidebar "New session": matches the "+ Claude" main button (claude, non-yolo).
    // Spawns at the named folder, with no props.selected timing dependency.
    offNewSession = onWith<NewSession>(NEW_SESSION, (s) => {
      spawnSession(s.agent ?? "claude", s.folderPath, s.projectName, false);
    });
    // A tab whose process ends (the user typed `exit`, a task finished) is
    // closed. Agent-exit within a live shell fires no event. A command tab's
    // process is the command, so its exit is the verdict instead.
    unlistenExit = await listen<PtyExit>("pty://exit", (e) => {
      const t = open().find((o) => o.id === e.payload.id);
      if (!t) return;
      if (t.kind === "command") noteCommandExit(t, e.payload.code);
      else closeId(t.id);
    });
    unlistenRefused = await listen<{ id: string; foreground: string }>("pty://init-refused", (e) =>
      refuseInit(e.payload.id, e.payload.foreground),
    );
    // Pulled, not listened for. The startup reap runs inside Tauri's `setup`,
    // which finishes before this webview exists, so an event emitted there
    // would reach nobody and an orphan would block its session id in silence.
    // The backend parks the result; this is the frontend saying it is ready.
    const reaped = await invoke<Reaped[]>("chat_orphans").catch(() => [] as Reaped[]);
    setOrphans(reaped.filter((o): o is ChatOrphan => o.type === "orphan"));
    // The same startup pass the listing itself belongs to, and after the reap:
    // an orphan the backend has just ended is not something to report as
    // stranded. Not awaited, so a slow listing does not hold up the rest.
    void reportStranded();
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
    offOpenJob?.();
    offRevealDock?.();
    offNewDockShell?.();
    offShellAt?.();
    offComposeDraft?.();
    unlistenExit?.();
    unlistenRefused?.();
    unlistenSessions?.();
  });

  // `focus` is false for a restore, which brings a whole strip back at once and
  // then focuses the one tab that was in front. Focusing each in turn would
  // *wake* each in turn - a tab on screen is not inert - so a lazy restore
  // would spawn the very processes it exists to avoid.
  function openOrActivate(t: OpenTerm, focus = true) {
    if (!open().some((o) => o.id === t.id)) {
      setOpen([...open(), t]);
    }
    if (focus) focusTab(t.workspace, t.id);
  }

  /**
   * Sway is running something for you: a clone, a bootstrap, an install, a
   * sign-in. It opens as a command tab in the dock, in front, and the dock comes
   * up with it; the workspace underneath stays exactly where it was.
   *
   * The id is the dedupe key it was minted as: pressing Install twice reaches
   * the install in progress rather than racing two package managers over one
   * bin directory. `interactive` decides only whether the keyboard follows.
   */
  function openCommand(j: OpenJob) {
    if (open().some((o) => o.id === j.id)) {
      emitWith<RevealDock>(REVEAL_DOCK, { tabId: j.id });
      return;
    }
    const tab: OpenTerm = {
      id: j.id,
      title: j.title,
      cwd: j.cwd,
      workspace: SHELLS_KEY,
      kind: "command",
      program: j.program,
      args: j.args,
      // A command runs as whoever started it; the account it may be signing in
      // to arrives as `env`, not as a profile of its own.
      profile: null,
      ...(j.env ? { env: j.env } : {}),
      ...(j.rediscoverOnExit ? { rediscoverOnExit: true } : {}),
      ...(j.recheckAgentsOnExit ? { recheckAgentsOnExit: true } : {}),
      ...(j.interactive ? { interactive: true } : {}),
    };
    setOpen([...open(), tab]);
    revealDock(tab.id);
  }

  // No branch behind the dock, so a shell of your own there opens at home.
  async function newShellInDock() {
    const cwd = await homeDir().catch(() => "/");
    const tab: OpenTerm = {
      id: shellId(),
      title: "Shell",
      cwd,
      workspace: SHELLS_KEY,
      kind: "shell",
      program: "",
      args: [],
      profile: null,
    };
    setOpen([...open(), tab]);
    revealDock(tab.id);
  }

  function revealDock(tabId: string) {
    if (!tabsIn(SHELLS_KEY).some((t) => t.id === tabId)) return;
    showDock(true);
    focusDockTab(tabId);
  }

  // Dock up for a command, progress, dock gone: it stays only for what is in it.
  createEffect(
    on(
      () => tabsIn(SHELLS_KEY).length,
      (count, prev) => {
        if (count === 0 && prev) showDock(false);
      },
    ),
  );

  /**
   * A command exited. A `null` code is an exit the backend could not confirm,
   * which counts as a failure.
   *
   * First report wins, so nothing can re-toast or flip a verdict. A clean run
   * closes its own tab: the toast is the record, and a receipt you have to
   * dismiss is a chore. Anything else stays on screen wearing its code, which
   * is the output worth keeping.
   */
  function noteCommandExit(t: OpenTerm, code: number | null) {
    if (!reportCommandExit(t.id, code)) return;
    // After the verdict is recorded, so anything watching sees the outcome even
    // when the tab is about to go.
    if (t.rediscoverOnExit) invoke("rediscover").catch(() => {});
    if (t.recheckAgentsOnExit) void refreshAgentHealth();
    const failed = code !== 0;
    emitWith<ToastEvent>(TOAST, {
      message: !failed
        ? `${t.title} finished`
        : code === null
          ? `${t.title} ended without an exit code`
          : `${t.title} failed (exit ${code})`,
      kind: failed ? "error" : "info",
      ...(failed
        ? { action: { label: "Show", run: () => emitWith<RevealDock>(REVEAL_DOCK, { tabId: t.id }) } }
        : {}),
    });
    if (!failed) closeId(t.id);
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
      // A tab short of `live` hosts nothing, so no session can have appeared
      // because of it. It also carries no `spawnedAt`, and the `?? 0` floor
      // below would then make every unclaimed session in the folder a
      // candidate - so an inert tab would not merely fail to match, it would
      // match the wrong session.
      if (t.kind !== "agent" || t.sessionId || tabState(t) !== "live" || initRefusal(t.id)) continue;
      byWorkspace.set(t.workspace, [...(byWorkspace.get(t.workspace) ?? []), t]);
    }
    for (const [workspace, tabs] of byWorkspace) {
      if (tabs.length !== 1) continue; // ambiguous: two+ fresh tabs in this workspace
      const tab = tabs[0];
      const sessions = await listSessionsFor<BackfillSession>(workspace);
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
        const sessions = await listSessionsFor<RestoreSession>(workspace);
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
      (sel, prev) => {
        const ws = workspaceKey(sel);
        if (!sel || !ws) return;
        setActiveWorkspace(ws);
        if (sel.sessionId) {
          // A sidebar session click means "take me there": reveal and focus
          // the pane the session's tab lives in (or will open in), even when
          // that pane is hidden or another pane holds focus (plan phase 6).
          // Not on the first delivery: that is the selection restored at
          // launch, and revealing for it would override the workspace's saved
          // pane focus (phase 5) with nobody having clicked anything.
          if (prev !== undefined) revealKindPane(ws, "shell");
          void openSelectedSession(sel);
        }
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
   * The liveness probe is taken up front rather than inside the PTY branch,
   * because the route itself depends on it: chat drives a session by resuming
   * it, which is unsafe against one already running outside Sway.
   *
   * `session_running_elsewhere`, never `session_running`: a chat child outlives
   * a webview reload while its tab does not, so the plain probe finds Sway's own
   * process and routes the session onto the PTY surface, where the chat claim
   * this same Sway holds then refuses it.
   */
  async function openSelectedSession(sel: ResumeTarget) {
    // Before anything reads `open()`. At launch the selection is delivered
    // before this workspace has been restored, so every question below would be
    // answered against an empty strip. Restore never reaches this function, so
    // there is nothing here to wait on itself.
    await stripReady(sel.folderPath);
    const sessionId = sel.sessionId!;
    const agentId = agents().some((a) => a.id === sel.agent) ? sel.agent! : "claude";
    // Hosting means *driving*, so a tab short of `live` does not count. It also
    // must not: `hostedHere` short-circuits the probe below to false, so an
    // inert tab naming this session would send a session that is genuinely
    // running elsewhere to the chat surface, which drives it by resuming it -
    // the one operation measured to corrupt a transcript.
    const hostedHere = open().some((t) => t.sessionId === sessionId && tabState(t) === "live");
    // Only worth asking when the answer can change the route. A tab of ours
    // already hosting it short-circuits to `focus` either way, and the PTY
    // branch runs its own probe for the retype decision.
    const runningElsewhere =
      hostedHere || settings.chatDefaults.defaultSurface === "agent"
        ? false
        : await invoke<boolean>("session_running_elsewhere", { id: sessionId, agent: agentId }).catch(
            () => true,
          );
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

  // `id` is handed in by a restore, which seeds it inert before calling so the
  // resumed tab comes back as a strip entry rather than a spawned shell. Every
  // other caller is opening a tab that has never existed.
  //
  // A restore also asks for no focus: it brings a whole strip back and focuses
  // the one tab that was in front afterwards, and focusing here would wake this
  // one on the way past.
  async function focusOrResume(sel: ResumeTarget, id: string = shellId(), focus = true) {
    const sessionId = sel.sessionId!;
    const agentId = agents().some((a) => a.id === sel.agent) ? sel.agent! : "claude";
    const a = findAdapter(agentId);
    const existing = open().find((t) => t.sessionId === sessionId);
    if (existing) {
      if (focus) focusTab(existing.workspace, existing.id);
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
    // A session lives in exactly one profile home, so resuming it anywhere else
    // would start an empty conversation wearing its name. Refuse rather than
    // open a tab that cannot be what it says it is.
    const env = await spawnEnvOrWarn(agentId, sel.profile ?? null);
    if (!env) return;
    openOrActivate({
      id,
      title: sel.sessionTitle?.slice(0, 28) || sessionId.slice(0, 8),
      cwd: sel.sessionCwd || sel.folderPath,
      workspace: sel.folderPath,
      kind: "agent",
      program: a.program,
      args,
        profile: sel.profile ?? null,
        ...(Object.keys(env).length ? { env } : {}),
        init: agentInit(a.program, args),
        sessionId,
      },
      focus,
    );
  }

  /**
   * The spawn env for a tab about to open, or `null` after saying why not.
   *
   * A profile the backend cannot resolve is a tab that must not open: an empty
   * env would start the agent on the user's own login while every label around
   * it named another account.
   */
  async function spawnEnvOrWarn(agentId: string, profile: string | null): Promise<Record<string, string> | null> {
    return await profileEnv(agentId, profile).catch(() => {
      emitWith<ToastEvent>(TOAST, {
        message: "That account is no longer set up. Add it again in Settings, or start on another one.",
        kind: "error",
      });
      return null;
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
      // Addressed to the tab hosting that session, because that is what a
      // composer is filed under: the caller knows a session, and this is the one
      // place that can turn one into the other.
      const chat = liveChats().find((c) => c.sessionId === req.sessionId);
      if (chat) {
        offerToComposer(chat.tabId, req.blocks ?? [{ type: "text", text }]);
        focusTab(chat.folderPath, chat.tabId);
      }
      emitWith<SendToSessionResult>(SEND_TO_SESSION_RESULT, { requestId: req.requestId, result: "sent" });
      return;
    }
    if (!agentTabFor(req.sessionId)) {
      await focusOrResume({
        sessionId: req.sessionId,
        agent: req.agent,
        profile: req.profile,
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
  //
  // `profile` is the account it runs as, and **`undefined` is not `null`**: a
  // caller that names one (a fork, the launch menu's per-account rows) is
  // obeyed, including when it names the default account, while a caller that
  // names none gets the project's remembered account or this agent's Settings
  // default. Two callers open a session without an account in mind, so the
  // resolution lives here rather than at each of them.
  async function spawnSession(
    agentId: string,
    folderPath: string,
    projectName: string,
    yolo = false,
    workspace = folderPath,
    asked?: string | null,
  ) {
    const a = findAdapter(agentId);
    const profile = asked !== undefined ? asked : draftProfile(workspace, agentId);
    const args = [...a.base_args, ...(yolo ? a.yolo_args : []), ...(await hookArgs(agentId))];
    const env = await spawnEnvOrWarn(agentId, profile);
    if (!env) return;
    // The account this project last used, on the same rule a chat records it:
    // an agent tab runs as an account exactly the way a chat does. The agent
    // itself is not recorded here - that is what locking a chat means, and a
    // terminal opened beside one should not move which agent it opens on.
    //
    // Only for an agent that has accounts to tell apart. The memory is one slot
    // per project, so a codex tab recording "the default account" would answer
    // for claude too and quietly move a project off the login it had chosen.
    if (namedProfiles(agentId).length) {
      rememberChatPrefs(workspace, { profile: asProfileId(profile) });
    }
    openOrActivate({
      id: shellId(),
      title: `${projectName} ${agentId}`,
      cwd: folderPath,
      workspace,
      kind: "agent",
      program: a.program,
      args,
      profile,
      ...(Object.keys(env).length ? { env } : {}),
      init: agentInit(a.program, args),
      // Floored to match the backend's whole-second `created_at` (epoch_secs
      // truncates): comparing a fractional spawn time against a truncated
      // creation time would spuriously reject a session created in the same
      // wall-clock second as the spawn.
      spawnedAt: Math.floor(Date.now() / 1000),
    });
  }

  // A chat tab hosts no shell. Every one of them is opened here, draft or not,
  // and all of them return the **tab** id: the tab is what a caller can address
  // before there is a session to address, and since the composer is filed under
  // it, the tab is also what a seed has to be handed to.
  function openChatTab(
    workspace: string,
    cwd: string,
    baseName: string,
    agentId: string,
    profile: string | null = null,
    session?: { sessionId: string; forkFrom?: string; rewindTo?: number },
    // Restore hands its stored id in so the tab comes back as itself, and takes
    // the focus itself once the whole strip is back; every other caller is
    // opening a tab that has never existed and wants to be looking at it.
    id: string = chatId(),
    focus = true,
  ): string {
    openOrActivate({
      id,
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
        profile,
        ...session,
      },
      focus,
    );
    return id;
  }

  /**
   * Open a chat tab on a **new** session id, spawned as soon as it mounts.
   *
   * `forkFrom` makes it a fork: the new session replays that one's history and
   * the two diverge from there. Without it the chat starts empty. Either way the
   * id is new, which is what makes this the safe answer to a refused claim -
   * a new id cannot collide with the one already held.
   *
   * A plain new chat does *not* come through here: it opens as a draft and
   * mints its id when it is first sent to. This is for the openings that already
   * know which session they are, which is every fork and every rewind.
   */
  function spawnChat(
    workspace: string,
    cwd: string,
    baseName: string,
    agentId = "claude",
    forkFrom?: string,
    rewindTo?: number,
    // A fork and a rewind stay on the account they came from: the transcript
    // they replay lives in that profile's home, and a fork onto another
    // account would have nothing to read.
    profile: string | null = null,
  ): string {
    return openChatTab(workspace, cwd, baseName, agentId, profile, {
      sessionId: crypto.randomUUID(),
      forkFrom,
      rewindTo,
    });
  }

  /**
   * Open a chat tab with **no session at all**.
   *
   * Nothing is spawned, nothing is claimed and no id is minted: the tab is a
   * draft until it is sent to, and a draft that is closed unused costs a tab
   * record. This is what a new chat is now - see `startChatDraft` for the other
   * half.
   */
  function openChatDraft(
    workspace: string,
    cwd: string,
    baseName: string,
    agentId = "claude",
    profile: string | null = null,
  ): string {
    return openChatTab(workspace, cwd, baseName, agentId, profile);
  }

  /**
   * A draft's first send: mint the session it will run as, so the surface swaps
   * to a real chat that spawns, claims and sends.
   *
   * Replacing the tab record rather than mutating it is the mechanism and not an
   * accident: the stage is keyed by tab identity, so a replaced record is what
   * unmounts the draft and mounts the chat in its place.
   *
   * The id is minted per attempt. A previous attempt's id is dead the moment it
   * is handed back, so a retry after a failure can never re-offer an id an agent
   * already wrote a record against.
   */
  /**
   * Point a draft at a different agent, or at a different account of it.
   *
   * Both in one write. A model belongs to an account, so a palette row names a
   * pair, and setting them separately would leave a frame in which the tab
   * claims one account's model under another's login.
   *
   * Only a draft: `program` and `profile` are what a live chat's session was
   * started under, so changing them there would leave the tab claiming an agent
   * and an account that are not the ones on the other end of the socket.
   */
  function setChatDraftAgent(tabId: string, agentId: string, profile: string | null) {
    const tab = open().find((t) => t.id === tabId);
    if (!tab || !isChatDraft(tab)) return;
    setOpen(open().map((t) => (t.id === tabId ? { ...t, program: agentId, profile } : t)));
  }

  /**
   * Record the account the backend resolved this chat to, which on a resume is
   * the transcript's own rather than whatever the tab asked for.
   *
   * Mutated in place + a shallow copy of the outer array, the `mergeReorder`
   * pattern: the tab keeps its reference so `<For>` reconciles without
   * remounting (gotcha #64). A rebuilt record would tear down the ChatView that
   * has just spawned, and its remount would spawn again.
   */
  function recordChatProfile(tabId: string, profile: string | null) {
    const tab = open().find((t) => t.id === tabId);
    if (!tab || tab.profile === profile) return;
    tab.profile = profile;
    setOpen([...open()]);
  }

  function startChatDraft(tabId: string) {
    clearDraftError(tabId);
    const tab = open().find((t) => t.id === tabId);
    // A draft sits at `open` until here. Advanced before the record swap so the
    // chat that mounts in its place is already started: read as `open`, it would
    // render as a transcript-only tab and wait for a first send that has just
    // happened.
    if (tab) advanceTabState(tab, "live");
    setOpen(open().map((t) => (t.id === tabId ? { ...t, sessionId: crypto.randomUUID() } : t)));
  }

  /**
   * Put a chat tab back to being a draft, holding why its session never opened.
   *
   * Only a tab that *was* a draft: a fork or a resume carries a lineage a draft
   * cannot represent, so those keep their own error surface and their own ways
   * out rather than silently becoming empty chats. The message itself is already
   * back in the composer by the time this runs; this decides what the tab is.
   */
  function revertChatDraft(tabId: string, reason: string) {
    const tab = open().find((t) => t.id === tabId);
    if (!tab || !canRevertToDraft(tab)) return;
    setDraftErrors({ ...draftErrors(), [tabId]: reason });
    setOpen(open().map((t) => (t.id === tabId ? { ...t, sessionId: undefined } : t)));
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
    spawnChat(
      tab.workspace,
      tab.cwd,
      tab.workspace.split("/").pop() || "chat",
      tab.program,
      origin,
      promptTs,
      tab.profile,
    );
  }

  /**
   * A stored agent id, if anything still answers to it.
   *
   * Checked against the registry rather than trusted, because these ids outlive
   * the adapter that wrote them: one dropped from the TOML would leave a draft
   * whose `program` names nothing, and `findAdapter` would quietly serve
   * claude's config under the other one's name. **Not** checked against what is
   * enabled: a restored draft comes back as the tab it was, and the composer is
   * where an agent since turned off says so.
   */
  function storedChatAgent(id: string | null | undefined): string {
    if (id && agents().some((a) => a.id === id && chatCapable(a))) return id;
    return draftChatAgent(null) ?? "claude";
  }

  /**
   * The harness a new draft here opens on: whatever the last chat in this
   * project locked to, the first agent this install offers otherwise, and null
   * when it offers none.
   *
   * The remembered id is checked rather than trusted, because these ids outlive
   * the adapter that wrote them: one dropped from the TOML would leave a draft
   * whose `program` names nothing, and `findAdapter` would quietly serve
   * claude's config under the other one's name. It is checked against what is
   * *offered* rather than what exists, so a project whose last chat was on an
   * agent since turned off opens on one the user still wants.
   *
   * Keyed by the **workspace**, which is what a chat lock writes under
   * (`ChatView` has only the tab's workspace to write with) and what `ChatDraft`
   * reads its remembered model under. For a plain folder the two spellings are
   * one string; for a Feature they are `feature:<id>` and the active root, so
   * reading by root here meant a Feature's memory was written where nothing
   * looked for it.
   */
  const draftAgent = (workspace: string) => draftChatAgent(chatPrefs(workspace).agent);

  /** And the account it opens on: this project's last, that agent's Settings
   *  default behind it. Read from the same place and checked the same way, so
   *  an account removed since is dropped rather than spawned against. */
  const draftProfile = (workspace: string, agentId: string) =>
    draftChatProfile(agentId, chatPrefs(workspace).profile);

  /** Why a new chat cannot be started here, or null. */
  const noChatReason = () => {
    const root = selectionRoot(props.selected);
    if (!root) return "Select a branch first";
    return draftAgent(workspaceKey(props.selected))
      ? null
      : "No agent enabled. Turn one on in Settings.";
  };

  /** The menu's two agent-backed rows, each present only while its agent is
   *  one this install offers. Arrays so a call site can spread them in place
   *  and an absent row costs no entry rather than a hole. */
  const newChatItem = () => (noChatReason() ? [] : [{ label: "New chat", onClick: () => newChat() }]);
  /** The agent-terminal row, one per account once there are two of them.
   *
   *  An agent tab runs as an account exactly the way a chat does, so a single
   *  row would start whichever login Sway happened to inherit while the menu
   *  said only "Claude". `namedProfiles` is empty on a single-account install,
   *  which is what keeps that menu exactly as it was. */
  const claudeTerminalItem = (note?: string) => {
    if (!agentEnabled("claude")) return [];
    // One parenthetical, however many things go in it: the account and the
    // "this is the terminal one" note are both asides on the same row, and two
    // brackets in a row read as a mistake.
    const label = (account?: string) => {
      const name = findAdapter("claude").label;
      const aside = [account, note].filter(Boolean).join(", ");
      return aside ? `${name} (${aside})` : name;
    };
    const accounts = namedProfiles("claude");
    return accounts.length
      ? accounts.map((a) => ({
          label: label(a.label),
          onClick: () => newSession("claude", false, asTabProfile(a.id)),
        }))
      : [{ label: label(), onClick: () => newSession("claude") }];
  };

  // A new chat is a draft: no process, no session id, no claim, until the first
  // message decides there is going to be a conversation at all.
  function newChat(agentId?: string) {
    const sel = props.selected;
    const root = selectionRoot(sel);
    if (!sel || !root) return;
    const ws = workspaceKey(sel);
    const agent = agentId ?? draftAgent(ws);
    if (!agent) return;
    openChatDraft(ws, root, sel.projectName, agent, draftProfile(ws, agent));
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
    //
    // "Elsewhere" is the whole of the question: one of *our* live chat children
    // is what a reload leaves behind, and `chat_spawn` rewires that rather than
    // resuming it. Asking the plain liveness probe here turned every reopen
    // after a reload into "already running somewhere else".
    const running = await invoke<boolean>("session_running_elsewhere", {
      id: sessionId,
      agent: agentId,
    }).catch(() => false);
    if (running) {
      emitWith<ToastEvent>(TOAST, {
        message: "That session is already running somewhere else. Close it there first, or fork it.",
        kind: "error",
      });
      return;
    }
    const id = `chat:${crypto.randomUUID()}`;
    // A restore reads the pick off the tab record; a sidebar click mints a new
    // tab id, so that record is gone and the project's memory is the only thing
    // left that knows. Skipped on ACP, which republishes its own on session/load.
    if (pickRidesArgv(findAdapter(agentId).chat?.transport)) {
      const resumed = resumedPicks(chatPrefs(sel.folderPath), findAdapter(agentId).chat ?? null);
      if (resumed.mode !== null || resumed.effort !== null) setDraftPick(id, resumed);
    }
    openOrActivate({
      id,
      // The session's own name, not a label built from it. `chatTabLabel` is
      // for a chat that has no name yet - a draft named after its project, a
      // fork named after its folder - and appending " chat" to a session that
      // is already called something is a rename nobody asked for. It also only
      // held until `syncTabTitles` ran, which is why the suffix used to appear
      // for a few seconds and then vanish. Same derivation as `focusOrResume`
      // and `syncTabTitles`, so all three agree from the first frame.
      title: (sel.sessionTitle || sessionId).slice(0, 28),
      cwd: sel.sessionCwd || sel.folderPath,
      workspace: sel.folderPath,
      kind: "chat",
      program: agentId,
      args: [],
      profile: sel.profile ?? null,
      sessionId,
      resume: true,
    });
  }

  function newSession(agentId: string, yolo = false, profile?: string | null) {
    const sel = props.selected;
    const root = selectionRoot(sel);
    if (!sel || !root) return;
    spawnSession(agentId, root, sel.projectName, yolo, workspaceKey(sel), profile);
  }

  // A plain shell tab: the same login shell as an agent tab, just unseeded (no
  // init), opened in the selected branch-unit folder or a folder inside it.
  function newShell(at?: string) {
    const sel = props.selected;
    const root = selectionRoot(sel);
    if (!sel || !root) return;
    const sub = at && at !== root ? at.slice(at.lastIndexOf("/") + 1) : null;
    openOrActivate({
      id: shellId(),
      title: sub ? `${sub} shell` : `${sel.projectName} shell`,
      cwd: at ?? root,
      workspace: workspaceKey(sel),
      kind: "shell",
      program: "",
      args: [],
      // A bare login shell runs no agent, so it is on no account.
      profile: null,
    });
  }

  /**
   * Every tab in this workspace that was restored and never reached for.
   *
   * What the banner's Dismiss used to do, as an action rather than an answer to
   * a question: the strip is already there, so this is "I do not want these"
   * said afterwards instead of before. Nothing is killed and nothing is
   * unclaimed, because nothing was ever started - which is what `inert` means.
   */
  const inertTabs = () => workspaceTabs().filter((t) => tabState(t) === "inert");

  function closeInert() {
    for (const t of inertTabs()) closeId(t.id);
  }

  function closeId(id: string) {
    const t = open().find((o) => o.id === id);
    // A chat tab hosts no PTY: `pty_kill` on its id would find nothing, and the
    // stream-json child would keep running (and keep its session id claimed).
    // Unmounting ChatView ends it; this only has to not kill the wrong thing.
    //
    // A tab short of `live` has nothing behind it either - no PTY was ever
    // spawned - so the same reasoning applies to a restored tab nobody reached
    // for, whatever its kind.
    if (t && t.kind !== "chat" && tabState(t) === "live") invoke("pty_kill", { id }).catch(() => {});
    clearRefusal(id);
    // The composer belongs to the tab, so it is emptied when the tab goes and
    // not before: its surface unmounts on a first send and on a revert too, and
    // clearing there would throw away the message those two are carrying.
    if (t?.kind === "chat") {
      clearComposer(id);
      clearDraftError(id);
      clearDraftPick(id);
    }
    // Closing the active tab hands the slot to its right neighbor, then the
    // left (plan phase 5's unified policy; the fallback used to be the first
    // tab). Recorded directly rather than through focusTab, so closing a tab
    // in a background workspace cannot pull that workspace on screen.
    if (t) {
      const wsTabs = tabsIn(t.workspace);
      const recorded = activeByWorkspace()[t.workspace];
      const activeNow = recorded && wsTabs.some((o) => o.id === recorded) ? recorded : wsTabs[0]?.id;
      if (activeNow === id) {
        const next = nextActiveAfterClose(wsTabs.map((o) => o.id), id);
        if (next) setActiveByWorkspace({ ...activeByWorkspace(), [t.workspace]: next });
      }
    }
    setOpen(open().filter((o) => o.id !== id));
    if (t) forgetTab(t.workspace, id);
    dropTabState(id);
    // Or a later tab reusing this id would inherit its verdict: command ids are
    // minted from what they act on, so `install:claude` comes back.
    dropCommandStatus(id);
    dropInitRefusal(id);
    dropStageHost(id);
  }

  function close(id: string, e: Event) {
    e.stopPropagation();
    // The one kind whose X has to ask. A bootstrap stopped part-way skips its
    // `|| rm -rf` and leaves a `.bare` stub behind.
    if (isRunningCommand(id)) return void closeGuarded(id);
    closeId(id);
  }

  const isRunningCommand = (id: string) => {
    const t = open().find((o) => o.id === id);
    return !!t && t.kind === "command" && commandStatus(id) === "running";
  };

  // In-app replacement for window.confirm (unimplemented in WKWebView); the
  // same shape the editor panel uses.
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  function askConfirm(opts: ConfirmOpts): Promise<boolean> {
    return new Promise((resolve) => setConfirmReq({ ...opts, resolve }));
  }
  function resolveConfirm(v: boolean) {
    const req = confirmReq();
    setConfirmReq(null);
    req?.resolve(v);
  }

  /** Cmd+W's per-kind guard (plan phase 6): an idle shell closes at once; a
   *  chat mid-turn (its own event stream, exact) or a PTY agent that is not
   *  quiet (the inferred status, best-effort by design) asks first. */
  async function closeGuarded(id: string) {
    const t = open().find((o) => o.id === id);
    if (!t) return;
    // A running command has nothing to resume, so its message says what is lost
    // rather than what survives: a clone or bootstrap killed half-way leaves the
    // folder it was making behind ([[gotchas#clone-and-bootstrap-run-in-a-terminal-tab]]).
    if (isRunningCommand(id)) {
      const ok = await askConfirm({
        title: `${tabTitle(t)} is still running.`,
        message: "Stop it and close the tab? Whatever it had part-made is left as it is.",
        confirmLabel: "Stop",
        danger: true,
      });
      if (!ok) return;
      closeId(id);
      return;
    }
    const busy = (t.kind === "chat" || t.kind === "agent") && tabStatus(t) === "executing";
    if (busy) {
      const ok = await askConfirm({
        title: `${tabTitle(t)} is still working.`,
        message:
          t.kind === "chat"
            ? "Close the tab anyway? The turn stops here; the transcript stays and the session can be resumed."
            : "Close the tab anyway? Its process ends now; the transcript stays and the session can be resumed.",
        confirmLabel: "Close",
        danger: true,
      });
      if (!ok) return;
    }
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
  const marksSession = (t: OpenTerm) => (t.kind === "chat" || t.kind === "agent") && !initRefusal(t.id);

  /** What that tab's session is doing.
   *
   *  Null for an agent tab whose transcript has not appeared yet (it carries no
   *  session id until then) and for a chat whose panel has not registered - both
   *  render the resting mark rather than nothing, so the strip does not twitch
   *  as a session starts. */
  function tabStatus(t: OpenTerm): SessionStatus | null {
    // A tab short of `live` is driving nothing, whatever its session id says.
    // "none" rather than null: null is "not known yet" and renders the resting
    // mark, which is the right answer for a session that is starting and the
    // wrong one for a restored tab that has not been reached for.
    if (tabState(t) !== "live") return "none";
    // Its shell never started the agent, whatever session id the tab carries.
    if (initRefusal(t.id)) return null;
    if (t.kind === "chat") return chatStatus(t);
    return t.sessionId ? sessionStatus(t.sessionId) : null;
  }

  /** On which tier. A chat's own event stream states its status outright; a PTY
   *  agent tab's is composed from a pgrep probe, PTY quiet and a transcript
   *  tail, which is the same answer the sidebar has always shown for it. */
  const tabCertainty = (t: OpenTerm): StatusCertainty => (t.kind === "chat" ? "exact" : "inferred");

  /** Is this tab's session blocked on the user? An approval, a question and a
   *  budget stop all block the same way, and the tooltip words each one. */
  function blockedTab(t: OpenTerm): boolean {
    const s = marksSession(t) ? tabStatus(t) : null;
    return s !== null && blockedOnUser(s);
  }

  // Splice the bar's new order (active workspace only) back over the same
  // slots in open[], keeping refs and other groups intact (gotcha #64). Only
  // Portal markers move now; PaneView preserves the strip's scroll around it.
  function mergeReorder(next: OpenTerm[]) {
    const ws = activeWorkspace();
    if (!ws) return;
    // The splice is positional, so it is only sound when `next` covers exactly
    // this workspace's slots; a shorter list (a mixed pane list filtered down)
    // must refuse rather than splice undefined into open[].
    if (next.length !== open().filter((t) => t.workspace === ws).length) return;
    let i = 0;
    setOpen(open().map((t) => (t.workspace === ws ? next[i++] : t)));
  }

  // Phase 4: every terminal kind registers its tab descriptor and stage view,
  // closing over this panel's state; the strip and stage below render through
  // the registry with no per-kind switches of their own.
  const asTerm = (u: UnifiedTab) => (u as TerminalUnifiedTab).term;
  // Which surface is on screen. With a pane tree, that is per pane (two panes
  // can each show a terminal); with none, the workspace's own visible tab, as
  // it was before panes could split.
  const onScreen = (t: OpenTerm) => visibleInPane(t) ?? visibleId() === t.id;

  // The same shared resource the editor reads, not a second one: `list_features`
  // is fetched once per generation module-wide, so two panels asking cannot end
  // up drawing two different member sets during a refetch.
  const featureId = () => (props.selected?.kind === "feature" ? (props.selected.featureId ?? null) : null);
  const members = createFeatureMembers(featureId);

  /** Which member a tab's shell is sitting in. A terminal has no file, so the
   *  cwd is what answers; null outside a Feature. */
  const tabMember = (cwd: string): TintedMember | null =>
    featureId() ? memberFor(cwd, members()) : null;

  const termMenuItem = (u: UnifiedTab) => {
    const t = asTerm(u);
    const m = tabMember(t.cwd);
    return (
      <>
        {m && <TabMemberChip member={m} />}
        <span class="tab-label">{m ? `${m.label} / ${tabTitle(t)}` : tabTitle(t)}</span>
        <span class="tab-close" aria-label="Close" onClick={(e) => close(t.id, e)}>
          <Icon icon={X} />
        </span>
      </>
    );
  };
  // A memo, not a bare call: `active` feeds fit/focus effects and the
  // `chat_set_visible` flip, and a getter prop re-runs them whenever anything
  // behind onScreen changes. The memo makes them fire on real edges only.
  /**
   * Has this tab been reached for yet, and can it ever be un-reached?
   *
   * Latched: once true it stays true for the life of the row, so the surface it
   * gates is mounted once and never gated off again. `advanceTabState` already
   * refuses every backward move, but a `Show` that *can* close is a destroy
   * gate for a live PTY ([[lesson_a_mount_gate_is_a_destroy_gate]]), and this
   * makes that structurally impossible rather than a property of another file.
   */
  const wokenMemo = (t: OpenTerm) => createMemo<boolean>((was) => was || tabState(t) !== "inert", false);

  /**
   * A tab that is on screen is not inert: being looked at is the whole of what
   * "reached for" means.
   *
   * An effect rather than a branch inside `selectTab`, so every path that can
   * put a tab on screen wakes it the same way - a click, a restore's refocus,
   * a pane becoming visible, the `tabs[0]` fallback when nothing is recorded.
   * Re-running is free: `advanceTabState` refuses anything that is not a step
   * forward, and `stateOnActivate` hands it the tab's own state once it is past
   * inert.
   */
  const wakeOnScreen = (t: OpenTerm, active: () => boolean) =>
    createEffect(() => {
      // A restore brings a whole strip back one tab at a time, and `visibleId`
      // falls back to the first tab whenever the workspace has no recorded
      // active one - so mid-restore, whichever tab was created first reads as
      // on screen and would wake. Nothing in a restore has been reached for
      // until it settles and the stored active tab is focused.
      //
      // A signal, so clearing it re-runs this effect: the tab that is genuinely
      // in front then wakes, and no wake is lost.
      if (restoring()) return;
      if (active()) advanceTabState(t, stateOnActivate(t));
    });

  const ptyStage = (u: UnifiedTab) => {
    const term = asTerm(u) as PtyTab;
    const active = createMemo(() => onScreen(term));
    const woken = wokenMemo(term);
    wakeOnScreen(term, active);
    // No fallback: an inert tab is a strip entry and nothing else, so there is
    // no PTY to spawn and nothing to draw. A terminal kind has no readable
    // middle state - a shell with no process has nothing to show.
    //
    // `Show` defers its children until the condition holds, which is what keeps
    // `TerminalView` (and its `pty_spawn`) from being built for a tab nobody has
    // reached for. Pinned by the restore suite, not by reading the compiler.
    return <Show when={woken()}>{ptySurface(term, active)}</Show>;
  };
  const ptySurface = (term: PtyTab, active: () => boolean) => {
    return (
      <TerminalView
        id={term.id}
        cwd={term.cwd}
        kind={term.kind}
        program={term.program}
        args={term.args}
        init={term.init}
        env={term.env}
        profile={term.profile}
        sessionId={term.sessionId}
        active={active()}
        autoFocus={term.kind === "command" ? !!term.interactive : undefined}
        onOwnershipRefused={(refusal) => noteRefusal(term, refusal)}
      />
    );
  };
  const chatStage = (u: UnifiedTab) => {
    const t = asTerm(u);
    const active = createMemo(() => onScreen(t));
    const woken = wokenMemo(t);
    wakeOnScreen(t, active);
    return <Show when={woken()}>{chatSurface(t, active)}</Show>;
  };
  const chatSurface = (t: OpenTerm, active: () => boolean) => {
    // No session id means nothing has been started here yet: this tab is a
    // draft, and the draft surface is all of it. Decided here rather than inside
    // the chat, which is what lets every session-shaped thing `ChatView` does
    // keep assuming it has a session - because until this branch flips, it is
    // not mounted at all.
    if (isChatDraft(t)) {
      return (
        <ChatDraft
          tabId={t.id}
          cwd={t.cwd}
          workspace={t.workspace}
          active={active()}
          agentId={t.program}
          profile={t.profile}
          error={draftError(t.id)}
          onSelectAgent={(agentId, profile) => setChatDraftAgent(t.id, agentId, profile)}
          onStart={() => startChatDraft(t.id)}
        />
      );
    }
    // Past the branch above, so this tab has a session by construction: the two
    // states are exactly "has a session id" and "does not".
    return (
      <ChatView
        sessionId={t.sessionId!}
        tabId={t.id}
        agentId={t.program}
        profile={t.profile}
        cwd={t.cwd}
        workspace={t.workspace}
        title={tabTitle(t)}
        resume={!!t.resume}
        // A chat that has been reached for but not started renders its
        // transcript from disk and spawns nothing. `resume` above is what its
        // first send then starts it on, so the child comes back to this
        // session rather than to a fresh one.
        started={tabState(t) === "live"}
        onStart={() => advanceTabState(t, "live")}
        active={active()}
        onForkSession={() =>
          spawnChat(t.workspace, t.cwd, t.workspace.split("/").pop() || "chat", t.program, undefined, undefined, t.profile)
        }
        onForkFrom={() =>
          spawnChat(
            t.workspace,
            t.cwd,
            t.workspace.split("/").pop() || "chat",
            t.program,
            t.sessionId,
            undefined,
            t.profile,
          )
        }
        onRewindFrom={(promptTs) => rewindChat(t, promptTs)}
        onFirstSendFailed={(reason) => revertChatDraft(t.id, reason)}
        onProfileResolved={(profile) => recordChatProfile(t.id, profile)}
        forkFrom={t.forkFrom}
        rewindTo={t.rewindTo}
      />
    );
  };
  // The bar's trailing cluster, one closure shared by every terminal kind (the
  // strip keeps its DOM across active switches within the family, see
  // UnifiedTabStrip). Moved verbatim from the old bar's `trailing` prop.
  const termTrailing = () => {
    // Declared here rather than at panel scope: every pane's strip draws this
    // cluster since phase 13, and a shared signal would open the split button's
    // menu in all of them at once. Still portalled out, because the tab bar
    // clips overflow and would hide a menu rendered inside it.
    const [menuOpen, setMenuOpen] = createSignal(false);
    return (
      <>
      <div class={styles.termNewSplit}>
        {/* Main half: a new chat, which is a draft and so costs nothing until
            it is written in. A plus rather than a terminal icon, because the
            thing it makes is no longer a shell: the shell moved into the menu
            beside every other surface. Caret half: everything else. */}
        {/* `whenDisabled`: with no branch picked, or with no agent enabled,
            the label is the reason the button is greyed out, not a
            description of what it does. */}
        <Tooltip
          as="button"
          type="button"
          class={`${styles.termNew} ${styles.termNewMain}`}
          disabled={noChatReason() !== null}
          whenDisabled
          label={noChatReason() ?? `New chat in ${props.selected!.projectName}`}
          aria-label={props.selected ? `New chat in ${props.selected.projectName}` : "New chat"}
          onClick={() => newChat()}
        >
          <Icon icon={Plus} />
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
            //
            // The chat entry names no agent any more. It opens a draft, and
            // which harness that draft would start is the palette's answer
            // (the project's last-used one), not this menu's.
            //
            // Every entry that would start an agent is absent unless that
            // agent is one this install offers: a menu row is a promise, and
            // one that starts something the user turned off in Settings is
            // Sway going around its own setting.
            ...(settings.chatDefaults.defaultSurface === "agent"
              ? [...claudeTerminalItem(), ...newChatItem()]
              : [...newChatItem(), ...claudeTerminalItem("terminal")]),
            // The shell the main half used to open, still one click away. No
            // agent behind it, so nothing gates it.
            { label: "Terminal", onClick: () => newShell() },
            // Absent when there is nothing to close, since a row that would
            // do nothing is worse than no row. Counted in the label: the
            // whole point is knowing how much of the strip this clears.
            ...(inertTabs().length
              ? [
                  {
                    label: `Close ${inertTabs().length} tab${inertTabs().length > 1 ? "s" : ""} not started`,
                    onClick: closeInert,
                  },
                ]
              : []),
            // Only for a session selection, since there is nothing to
            // continue from a bare branch. The session need not have been
            // started in chat: every surface writes the transcript this
            // resumes and backfills from.
            ...(props.selected?.sessionId
              ? [
                  {
                    label: "Continue this session in chat",
                    // Disabled rather than absent, and the label says why: the
                    // session exists and the reader can see it, so a row that
                    // silently vanished would read as Sway losing it.
                    disabled: agentOffReason(props.selected.agent ?? "claude", props.selected.profile) !== null,
                    onClick: () => void continueInChat(props.selected!, props.selected!.agent ?? "claude"),
                  },
                  // The counterpart route for a session selection, so the
                  // PTY surface is reachable for an existing session and
                  // not only for a new one.
                  {
                    label: "Continue this session in terminal",
                    disabled: agentOffReason(props.selected.agent ?? "claude", props.selected.profile) !== null,
                    onClick: () => void focusOrResume(props.selected!),
                  },
                ]
              : []),
            ...(agentEnabled("claude")
              ? [{ label: `${findAdapter("claude").label} (yolo)`, onClick: () => newSession("claude", true) }]
              : []),
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
          in a tree you have to find them in. After the launch control: the
          two are one pair, and the thing you reach for most often is the
          one nearer the strip's edge. */}
      <Tooltip
        as="button"
        type="button"
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
    );
  };

  // The strip consumes the unified model filtered to this panel's kinds: same
  // tabs, same order, same references, read through the union. Declared before
  // the registrations below, which capture it into descriptor objects.
  const stripTabs = (): TerminalUnifiedTab[] => {
    const ws = activeWorkspace();
    return ws ? unifiedTabs().filter((u): u is TerminalUnifiedTab => u.kind !== "file" && u.workspace === ws) : [];
  };

  const termDescriptor = (kind: TabKind): TabDescriptor => ({
    // A session's state is true whether or not you are looking at it, so the
    // tab carries it: it rides on the provider mark rather than a glyph of its
    // own, so a tab going quiet does not change shape in a scanned strip.
    icon: (u) => {
      const t = asTerm(u);
      const mark = marksSession(t) ? (
        <TabMark agentId={t.program} status={tabStatus(t)} certainty={tabCertainty(t)} />
      ) : undefined;
      const m = tabMember(t.cwd);
      // Still undefined outside a Feature, so a plain shell keeps the bare label
      // the descriptor documents.
      if (!m) return mark;
      return (
        <>
          <TabMemberChip member={m} />
          {mark}
        </>
      );
    },
    // Hidden span rather than `aria-label`, the same reason the file tabs give.
    title: (u) => {
      const t = asTerm(u);
      const m = tabMember(t.cwd);
      return m ? (
        <>
          <span class={patterns.srOnly}>{m.label} / </span>
          {tabTitle(t)}
        </>
      ) : (
        tabTitle(t)
      );
    },
    tooltip: (u) => {
      const t = asTerm(u);
      // An inert tab looks like every other entry in the strip, so the hover
      // text is where it says it is only an entry. Without it a restored strip
      // reads as a dozen running things.
      if (tabState(t) === "inert") return `${t.cwd} - not started, open it to load it`;
      // Appended rather than substituted: a tab waiting for your approval says
      // so whatever has happened to the folder underneath it.
      const m = tabMember(t.cwd);
      const state = m && !m.state.usable ? `\n${m.label}: ${m.state.label}` : "";
      // Which account this tab runs as, and only where there is more than one
      // to tell apart - `profileLabel` applies that rule. On a single-account
      // install every tab would otherwise say "Default", which names nothing.
      const account = profileLabel(t.program, t.profile);
      const on = account ? `\nAccount: ${account}` : "";
      return blockedTab(t)
        ? `${t.cwd} - waiting for your approval${state}${on}`
        : `${t.cwd}${state}${on}`;
    },
    dots: (u) => (
      <Show when={u.kind === "command" && commandVerdict(u.id)}>
        {(verdict) => (
          <span class={styles.tabVerdict} data-verdict>
            {verdict()}
          </span>
        )}
      </Show>
    ),
    renderMenuItem: termMenuItem,
    // Where this tab could go, and how to make somewhere for it to go. The
    // registry skips the wrap for the measuring ghost row.
    wrapTab: (u, tab) => (
      <ContextMenu class={styles.tabMenu} items={paneMenuItems(asTerm(u).workspace, u)}>
        {tab}
      </ContextMenu>
    ),
    trailing: termTrailing,
    trailingRank: 20,
    activate: (u) => selectTab(asTerm(u)),
    close: (u, e) => close(u.id, e),
    stage: kind === "chat" ? chatStage : ptyStage,
    // Pane hosting (plan phase 7): the shell-pinned pane draws this panel's
    // strip and adopts every open tab's host - all workspaces, so a workspace
    // switch hides surfaces instead of detaching them (gotcha #64).
    stripItems: stripTabs,
    stripActiveId: visibleId,
    stripReorder: (next) =>
      mergeReorder(next.filter((u): u is TerminalUnifiedTab => u.kind !== "file").map((u) => u.term)),
    stripClass: styles.termTabs,
    // A terminal tab is its own surface, so a pane adopts exactly its own; a
    // pane-less panel keeps every one of them (phase 7's shape).
    hostIds: (paneId, tabs) => (paneId ? tabs.map((t) => t.id) : open().map((t) => t.id)),
    overlay: termOverlay,
  });
  // The stage overlays, drawn by the pane (PaneView) over whatever hosts it
  // adopted. Overlays, never fallbacks: gating the always-mounted surfaces on
  // any of these would unmount TerminalViews and kill their PTYs (gotcha #64).
  const termOverlay = () => (
    <>
      <Show when={!visibleId()}>
        <div class={styles.termEmpty}>
          Select a session to resume it, or pick a branch and start a new Claude or pi session.
        </div>
      </Show>
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
    </>
  );

  for (const kind of ["shell", "agent", "command", "chat", "task"] as TabKind[]) {
    registerKind(kind, termDescriptor(kind));
  }

  // A service host since phase 7: no visible output. Surfaces render through
  // Portals into stage hosts (adopted by PaneView), strip and overlays through
  // the registry, and the dialogs portal themselves.
  return (
    <>
      {/* Every tab is always mounted (CSS-hidden unless it is the visible one),
          so switching workspaces never unmounts a group's PTYs (gotcha #64). A
          strip reorder moves only these Portal markers, not the surfaces. */}
      <For each={open()}>
        {(t) => <Portal mount={stageHost(t.id)}>{kindEntry(t.kind).stage!(unifyTerm(t))}</Portal>}
      </For>
      <Show when={historyOpen() && activeWorkspace()}>
        {(ws) => (
          <HistoryPanel
            folder={ws()}
            breadcrumb={historyCrumb()}
            openSessionIds={openSessionIds()}
            anchorEl={historyEl()}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </Show>
      <Show when={confirmReq()}>
        <ConfirmDialog
          title={confirmReq()!.title}
          message={confirmReq()!.message}
          confirmLabel={confirmReq()!.confirmLabel}
          danger={confirmReq()!.danger}
          onConfirm={() => resolveConfirm(true)}
          onCancel={() => resolveConfirm(false)}
        />
      </Show>
    </>
  );
}
