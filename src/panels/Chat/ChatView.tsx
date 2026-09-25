import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Channel, invoke } from "@tauri-apps/api/core";
import MessageList from "./MessageList";
import QuoteSelection, { quoteBlock } from "../../components/QuoteSelection/QuoteSelection";
import { mirrorSaved, openDraftInEditor, scratchTabClosed, unlinkScratch } from "./composerScratch";
import { liveBufferText } from "../Editor/liveBuffers";
import SessionDiffView from "./SessionDiffView";
import SessionInfo from "./SessionInfo";
import Composer, { type ComposerHandle } from "./Composer";
import LaneStrip, { laneLabel } from "./LaneStrip";
import PlanCard from "./PlanCard";
import UsageReadout from "./UsageReadout";
import StatusStrip from "./StatusStrip";
import ModeSelector from "./ModeSelector";
import ConfigMirror from "./ConfigMirror";
import FollowToggle from "./FollowToggle";
import ModelPicker from "./ModelPicker";
import { lockedProvider } from "./agentPaletteData";
import { isLocked, items as autopilotItems, refreshLocked, setView, stopAutopilot } from "../../utils/autopilotStore";
import LockedBar from "../../components/Autopilot/LockedBar";
import { draftPick, hasPick, pickRidesArgv, setDraftPick } from "../../utils/chatDraftPick";
import { turnTokens, usageSummary } from "../../utils/chatUsage";
import { quotaState, rateLimitFrom, readingsOf, windowSentence } from "../../utils/chatRateLimit";
import { recordReadings, transitionKey, windowsFor } from "../../utils/usageStore";
import { accountWindows, chipFor, usageWarnAt } from "../../utils/usageSettings";
import {
  approaching,
  breach,
  heldNotice,
  stopNotice,
  warnNotice,
  type BudgetBreach,
  type Spend,
} from "../../utils/chatBudget";
import type { Answer } from "./PermissionPrompt";
import type { HunkRef } from "./ToolCallCard";
import Button from "../../components/Button/Button";
import AskCard from "./AskCard";
import { asksFor } from "../../utils/socketAsks";
import { type SessionDetail } from "./SessionStats";
import ConfirmDialog, { type ConfirmOpts, type ConfirmReq } from "../../components/Dialogs/ConfirmDialog";
import {
  draftFor,
  linkedScratchFor,
  dropPending,
  handBackHeldSend,
  hasAutoSend,
  hasSomethingToSend,
  historyFor,
  labelsSeeded,
  markAutoSend,
  pendingFor,
  restoreDraft,
  seedForSend,
  seedLabels,
  pushHistory,
  setDraft,
  takeAutoSend,
  takePending,
} from "../../utils/chatCompose";
import { attachmentsDir, composerAttachments } from "./composerAttachments";
import { folderActors } from "../../utils/folderActors";
import { hunkRevertPermission } from "../../utils/hunkRevert";
import {
  isConversationEvent,
  parseChatEvent,
  type ChatConfigValue,
  currentOf,
  type ChatConfigOption,
  type ChatEvent,
  type ContentBlock,
  type PermissionMode,
  type QuestionAnswer,
} from "../../utils/chatTypes";
import { dropLiveChat, chatsInFolder, liveChats, setLiveChat } from "../../utils/chatSessions";
import { checkpointChatTurn } from "../../utils/checkpoints";
import type { UsageTotals } from "../../utils/chatUsageStore";
import {
  capabilitiesFor,
  contextPercent,
  contextWindowFor,
  defaultMode,
  modeAfterModelSwitch,
  pickableModels,
  pickableModes,
  selectedModel,
  type PickableModel,
} from "../../utils/chatModels";
import { rememberWindows } from "../../utils/contextWindowMemory";
import {
  cachedCommands,
  cachedModels,
  catalogFor,
  refreshCatalogIfDue,
  recordLiveCommands,
  type CatalogModel,
} from "../../utils/modelCatalog";
import { findAdapter } from "../../utils/agents";
import { agentVersion, asProfileId, asTabProfile, namedProfiles, profileLabel } from "../../utils/agentHealth";
import { revealTarget } from "../../utils/agentLines";
import { attachmentSources, chatTier, publishedCapabilities, steerCostLabel } from "../../utils/chatCapabilities";
import { providerMarkKey } from "../../components/Icon/ProviderIcon";
import { rememberChatPrefs, settings } from "../Settings/settingsStore";
import { agentRefusal } from "../../utils/projectAgents";
import { capNotice, markNoticed, noticed, pastCap, shouldNotice, MULTI_CHAT_NOTICE } from "../../utils/chatConcurrency";
import {
  emitWith,
  onWith,
  AGENT_FILES_WRITTEN,
  EDITOR_FILE_SAVED,
  EDITOR_TAB_CLOSED,
  FOCUS_SESSION_TAB,
  REVEAL_TURN,
  TOAST,
  type AgentFilesWritten,
  type EditorFileSaved,
  type EditorTabClosed,
  type FocusSessionTab,
  type RevealTurn,
  type ToastEvent,
} from "../../utils/events";
import {
  applyEvent,
  beginReconnect,
  chatStatus,
  connectionHealth,
  clearAwaitingTurn,
  discardQueue,
  enqueue,
  effortPending,
  filesWritten,
  initialChat,
  isRunning,
  modePending,
  modelPending,
  pendingApprovals,
  pendingSwitchNotice,
  pendingFlush,
  promptsSent,
  pushSteer,
  pushUserTurn,
  releaseQueue,
  removeQueued,
  resolveApproval,
  revertEffortPick,
  revertModelPick,
  seedEffort,
  seedMode,
  seedModel,
  selectEffort,
  selectMode,
  replayFold,
  resetTranscript,
  selectModel,
  sendCapable,
  settleBackfill,
  steerable,
  steerProbe,
  shownEffort,
  turnModel,
  shownMode,
  shownModelValue,
  pushNotice,
  pushQuestionAnswers,
  takeForSend,
  laneStrip,
  backgroundTasks,
  outstandingBackground,
  selectLane,
  blockedLanes,
  laneOf,
  toolCallsSeen,
  visibleItems,
  type ChatItem,
  type ChatState,
  type QueuedInput,
  type QuestionItem,
  type ToolItem,
} from "./chatStore";
import {
  refusalMessage,
  refusalOf,
  CONTESTED_NOTICE,
  type ClaimOutcome,
} from "../../utils/chatOwnership";
import { UNATTRIBUTED_NOTICE } from "../../utils/attribution";
import { BLOCKED_REASON, sendWithProbeGate, type SendResult } from "../../utils/safeSend";
import { REWIND_BANNER, REWIND_CAVEAT, rewindSeed } from "./rewind";
import { CaptainsCall, ReplyMark } from "../../components/Autopilot/ShellParts";
import styles from "./Chat.module.css";

/** `SpawnResult` from `chat/commands.rs`. A refusal is a normal answer, not an
 *  error: it names the tab that holds the session, or the orphaned child. */
type SpawnResult = {
  ownership: ClaimOutcome;
  spawned: "started" | "rewired" | null;
  /** The account the session actually runs as, in the backend's spelling. Not
   *  always what was asked: a resume takes it off the transcript. */
  profileId: string | null;
};

/** One changed file as `checkpoint_turn_files` reports it. */
type CheckpointFile = { path: string; shared_with?: string[]; unattributed?: boolean };

/**
 * How long a first message may be held for a session that has not opened.
 *
 * A ceiling, not an expectation, and armed only while a message is actually
 * waiting. Every measured path answers far inside it (a claude handshake in
 * ~1.6s, an ACP agent inside its own 30s handshake deadline) and a spawn that
 * cannot start rejects at once, so what this catches is a child that started and
 * then went silent - which the claude transport, declaring no deadline of its
 * own, would otherwise wait on forever with the user's message inside it.
 */
const FIRST_SEND_DEADLINE_MS = 60_000;

/** The attachment labels a replayed turn has already spent. */
function labelsOf(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap((b) => (b.type === "fileRef" && b.label ? [b.label] : []));
}

/**
 * One chat session: the transport's events folded into `chatStore`, rendered,
 * and the composer's input sent back.
 *
 * The only reactive wrapper around the store's pure core. Everything that
 * decides anything - ordering, the tool-card race, what the queue does on a
 * cancelled turn, what status this session reports - lives in `chatStore.ts`
 * and is tested without a DOM. This file wires that to Tauri and to the screen.
 */
export default function ChatView(props: {
  sessionId: string;
  tabId: string;
  agentId: string;
  /** Which account of `agentId` this session runs as; `null` is the default
   *  profile. Sent at spawn, where the backend resolves it against the home the
   *  transcript is actually in and refuses a tab naming a different one. */
  profile: string | null;
  cwd: string;
  /** The branch-unit folder this tab groups under, which is what "another chat
   *  in this worktree" is measured against. */
  workspace: string;
  title: string;
  /** A tab restored from a previous run, whose session already has a transcript. */
  resume: boolean;
  /** Whether this tab's child has been started.
   *
   *  False only for a restored chat that has been opened to read: the transcript
   *  is replayed from disk, nothing is spawned, nothing claims the session and
   *  nothing reports it as live. The first send is what starts it. */
  started: boolean;
  /** Start this tab's child. Called by a first send on a chat that was opened to
   *  read; the message rides along in the auto-send store, the way a draft's
   *  does. */
  onStart: () => void;
  /** The session this one was forked from, when it is a fork. Its history is
   *  replayed here and the two diverge from that point; new turns never reach
   *  the original. */
  forkFrom?: string;
  /** Set when this tab is a rewind of `forkFrom`: the checkpoint the tree was
   *  put back to, which is also where the replayed history is cut. */
  rewindTo?: number;
  /** Spawned unattended. Passed on every spawn, resumes included, so the
   *  backend gates this session's outward tools. */
  background?: boolean;
  /** The session that spawned this one, for a resume to link it back to. */
  spawner?: string;
  /** A session this view watches but does not own, such as the autopilot's:
   *  unmounting leaves it running instead of closing it. */
  detach?: boolean;
  /** Drawn for the autopilot's cockpit: its marks, no status strip, and no
   *  pickers, since the autopilot's picks live in Settings. */
  cockpit?: boolean;
  active: boolean;
  /** Open a fresh chat beside this one, the way out of every refusal: a new
   *  session id can never collide with the one that is already held. Returns
   *  the new session's id, so this one can seed it. */
  onForkSession: () => string;
  /** Fork *this* session: a new id that replays this one's history. Distinct
   *  from `onForkSession`, which starts empty - that one is the escape hatch
   *  from a refused claim, where touching the contested session is the thing to
   *  avoid. */
  onForkFrom: () => string;
  /** Carry this conversation into a new chat whose files, and whose replayed
   *  history, stop at `promptTs`. Closes this tab: the rewind supersedes it, and
   *  leaving both open would leave two tabs claiming to be the same work. */
  onRewindFrom: (promptTs: number) => void;
  /** This session never got far enough to take the first message being held for
   *  it. Puts the tab back to a draft, holding `reason`, so the harness can be
   *  re-picked and the message sent again. Called only when there was a held
   *  message; an ordinary session's failures stay on this surface. */
  onFirstSendFailed: (reason: string) => void;
  /** The backend resolved this session's account to something other than what
   *  the tab asked for, which on a resume is the transcript's own account. Only
   *  called on a difference, so the tab record is written once and never on the
   *  common path. */
  onProfileResolved: (profile: string | null) => void;
}) {
  // The preference is read once, at store creation, and not tracked: a live
  // chat swapping its question cards for permission prompts mid-turn would be
  // worse than waiting for the next session. Same rule the backend applies when
  // it spawns.
  const [state, setState] = createStore<ChatState>(
    initialChat(props.sessionId, settings.chatDefaults.answerQuestionsInline),
  );
  const [ownership, setOwnership] = createSignal<ClaimOutcome | null>(null);
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  /** The account this session runs as, which everything account-scoped in here
   *  reads instead of `props.profile`: the tab's value is what was *asked* for,
   *  and a resume can land on a different one. */
  const [resolvedProfile, setResolvedProfile] = createSignal<string | null>(props.profile);
  // What the composer's contents are filed under. The **tab**, not the session:
  // this tab may have held what the user typed before it had a session id at
  // all, and a first send that never reaches one hands it straight back. See
  // [[ComposerKey]] in `chatCompose.ts`.
  const composerKey = () => props.tabId;

  /** Whether this session can take a turn yet. The rule, and why it differs by
   *  transport, lives with the rest of the store's decisions. */
  const canSend = () => sendCapable(state, findAdapter(props.agentId).chat?.transport);

  // What this tab is set to run as, read once: it is what the session is
  // *opened* on, and every change after that goes through the session's own
  // controls - which write back here as they land, so a tab restored next
  // launch opens on what this conversation was actually running.
  //
  // All-null for a fork or a rewind, which start from the conversation rather
  // than from a pick.
  const opening = draftPick(props.tabId);

  /** Whether the opening pick is in force, so the held first message may go.
   *
   *  True from the start for claude, whose pick rides the argv: the session that
   *  answers the handshake is already running it. An ACP adapter declares no
   *  `model_args` at all and refuses a model before its session exists, so there
   *  the pick is a request made after the session opens and awaited before the
   *  first message is sent on it. */
  const [pickApplied, setPickApplied] = createSignal(
    pickRidesArgv(findAdapter(props.agentId).chat?.transport) || !hasPick(opening),
  );
  let pickTried = false;
  /** Whether this session has already been written down as the project's
   *  last-used one. Once per session, at the moment it can take a turn. */
  let remembered = false;

  /**
   * Hand a held first message back, and tell the tab its session never happened.
   *
   * Answers false when nothing was being held, which is the ordinary case: a
   * resumed tab that is refused keeps its refusal banner and its two ways out.
   * Only a tab whose *first* message is still waiting turns back into a draft,
   * because only there is there something to hand back and a harness worth
   * re-picking. The child, if one started, is ended by this surface's own
   * unmount.
   */
  function failFirstSend(reason: string): boolean {
    const held = takeAutoSend(composerKey());
    if (held === null) return false;
    handBackHeldSend(composerKey(), held);
    props.onFirstSendFailed(reason);
    return true;
  }
  // The transcript and the diff are two readings of one session, so they are a
  // toggle rather than two places to be. The turn the reader was on is kept
  // across the switch: coming back to the bottom of a long session would lose
  // the place they left, which is the whole reason to look at the diff.
  const [showDiff, setShowDiff] = createSignal(false);
  const [anchorTurn, setAnchorTurn] = createSignal<string | null>(null);
  // The transcript's scrolling root and the composer's insert handle, for the
  // Quote button that carries a selection from the one into the other.
  let transcriptEl: HTMLDivElement | undefined;
  let composer: ComposerHandle | undefined;
  // The draft's scratch tab, while it has one: the editor reports each save
  // and the close, and this composer answers only for its own linked path.
  const linkedName = () => linkedScratchFor(composerKey())?.split("/").pop() ?? null;
  onMount(() => {
    const offSaved = onWith<EditorFileSaved>(EDITOR_FILE_SAVED, (saved) => mirrorSaved(composerKey(), saved));
    const offClosed = onWith<EditorTabClosed>(EDITOR_TAB_CLOSED, (closed) => void scratchTabClosed(composerKey(), closed));
    onCleanup(() => {
      offSaved();
      offClosed();
    });
  });
  // This run's first turn boundary. The diff view's attribution spans from
  // here, which is exactly the span the in-memory before-states cover: a
  // resumed session's earlier turns left no capture behind.
  const [firstTurnTs, setFirstTurnTs] = createSignal<number | null>(null);
  // The checkpoint behind each turn this tab ran, which is what makes that turn
  // rewindable. Replayed turns are absent on purpose: their snapshot, if one was
  // ever taken, belongs to whichever run took it, and offering to rewind to a
  // tree state nothing recorded would fail at the revert with nothing on screen
  // having warned it might.
  const [turnStamps, setTurnStamps] = createSignal<Record<string, number>>({});
  // What this session and its project have spent, read back from disk on open so
  // a reopened tab resumes its budget rather than restarting it.
  const [spent, setSpent] = createSignal<UsageTotals | null>(null);
  // The ceiling that stopped this chat, if one did. Sticky: the stop is
  // terminal for the session, so this is cleared only by raising the limit.
  const [stopped, setStopped] = createSignal<BudgetBreach | null>(null);
  // Which ceiling the user has already been warned about, or null. Keyed on the
  // limit rather than a bare flag: once per ceiling, not once per turn (a
  // warning that repeats every turn is one people learn to scroll past) and not
  // once per session either (raising a limit has to be able to warn again).
  const [warned, setWarned] = createSignal<string | null>(null);
  // Whether the user has already been told, this stop, that their message is
  // parked rather than sent. Once per stop: pressing send five times into a
  // stopped chat is five reasonable attempts and one piece of news, and five
  // identical rows would push the queue itself off the screen. Reset when the
  // ceiling is raised, so the next stop says it again.
  const [heldSaid, setHeldSaid] = createSignal(false);
  // Human prompts the transcript holds, which is what says whether this chat
  // observed the whole session or only part of it.
  const [promptCount, setPromptCount] = createSignal(0);

  function askConfirm(opts: ConfirmOpts): Promise<boolean> {
    return new Promise((resolve) => setConfirmReq({ ...opts, resolve }));
  }
  function resolveConfirm(v: boolean) {
    const req = confirmReq();
    setConfirmReq(null);
    req?.resolve(v);
  }

  const edit = (fn: (s: ChatState) => void) => setState(produce(fn));

  // The level this session opened on is in force from the first frame: it rode
  // the argv the child was started with, and nothing on the wire will ever
  // mention it again. Without this the control read "Default" over a child
  // running `--effort high`, on a fresh session as much as on a restored one.
  if (opening.effort !== null) edit((s) => seedEffort(s, opening.effort));
  // Mode and model only where the pick *is* argv: an ACP pick is a request sent
  // after the session opens and may be refused, so it is not yet in force.
  // Safe in the body: replay emits no `sessionStarted` and no `turnStarted`.
  if (pickRidesArgv(findAdapter(props.agentId).chat?.transport)) {
    // Read out first: narrowing a property does not survive into the closure.
    const { mode: openedMode, model: openedModel } = opening;
    if (openedMode !== null) edit((s) => seedMode(s, openedMode));
    if (openedModel !== null) edit((s) => seedModel(s, openedModel));
  }
  const running = () => isRunning(state);

  // Memoized, not a plain accessor. Solid props are getters and MessageList
  // reads `items` in three places (its window memo, its stick-to-bottom tail
  // probe, and the load-earlier check), so an accessor would re-filter the
  // whole transcript three times for every streaming delta.
  const shownItems = createMemo(() =>
    visibleItems(state.items, settings.chatDefaults.showToriHooks, state.selectedLane),
  );

  /** The lane being read, by name, for the composer's placeholder. */
  const watchedLane = () => {
    const lane = state.selectedLane === null ? null : state.lanes[state.selectedLane];
    return lane ? laneLabel(lane) : null;
  };

  /** The lane an `Agent` call opened, so its card can offer a way in from where
   *  the launch actually happened rather than from a strip of equal chips. */
  const laneOpenedBy = (toolUseId: string) =>
    laneStrip(state).find((l) => l.toolUseId === toolUseId)?.agentId ?? null;

  /** The lane a row on screen actually belongs to, which only differs from what
   *  the reader picked for a blocked row: those show in main too. */
  const blockedIn = (it: ChatItem) => (state.selectedLane === null ? laneOf(it) : null);

  // The strip's three numbers. Derived from the transcript rather than kept as
  // counters, so a replayed history and a live session count the same way.
  const touchedFiles = createMemo(() => {
    const paths = new Set<string>();
    for (const it of state.items) {
      if (it.kind !== "tool") continue;
      for (const f of it.files) paths.add(f);
      for (const e of it.edits) paths.add(e.path);
    }
    return paths.size;
  });
  // The session's figures, from the same backend read the toolbar shows for a
  // sidebar selection, so the two never disagree about this session. Refreshed
  // when a turn completes rather than polled: a turn is exactly what moves these
  // numbers, and the transcript is only written as one lands.
  const [detail, setDetail] = createSignal<SessionDetail | null>(null);
  function loadDetail() {
    void invoke<SessionDetail | null>("chat_session_detail", {
      sessionId: props.sessionId,
      agentId: props.agentId,
    })
      .then(setDetail)
      .catch(() => {});
  }
  createEffect(on(() => state.turnsCompleted, loadDetail));
  // A refused claim means no child was started, so nothing may be typed at it.
  // Narrowed so the banners below read their own fields without casting.
  const refusal = () => refusalOf(ownership());
  const refused = () => refusal() !== null;
  const heldElsewhere = () => {
    const r = refusal();
    return r && r.type !== "orphaned" ? r : null;
  };
  const orphaned = () => {
    const r = refusal();
    return r && r.type === "orphaned" ? r : null;
  };

  // Assigned by `onMount`'s `connect`, which owns the channel and the spawn
  // arguments. Held out here so the connection control can reach it without
  // lifting the whole event pipeline out of the closure it belongs in.
  let reconnect: (() => void) | undefined;

  onMount(() => {
    // What this agent last said it can run, so the picker has something true
    // before the handshake lands, and an ask when that answer is missing or
    // describes a binary that has since changed. Scoped to this agent: opening
    // a chat is already launching it, so asking costs nothing new, where a sweep
    // would spawn every other agent on the machine over a chat nobody opened.
    void refreshCatalogIfDue(props.agentId, props.profile);

    // A rewound chat opens with the announcement already in the composer, so
    // the turn the user actually wanted is that plus their instruction rather
    // than a turn spent on the announcement alone. Only into an empty composer:
    // a remount must not overwrite what they have since typed.
    if (props.rewindTo && !draftFor(composerKey()).trim()) {
      setDraft(composerKey(), rewindSeed());
    }

    // The budget this tab is resuming, and how much of the session it can
    // actually vouch for. Both are reads of what happened before this tab
    // existed, so both happen on open rather than being accumulated.
    void invoke<UsageTotals>("chat_usage_totals", { cwd: props.cwd, sessionId: props.sessionId })
      .then((totals) => {
        setSpent(totals);
        return applyBudget();
      })
      .catch(() => {});
    // Where this agent's earlier turns come from. `session-replay` means the
    // agent hands them back on the live channel and Tori's log is only a cache
    // of that, which is what the reset, the notice and the prompt-count re-read
    // all key on. Declared here rather than beside `tier` far below, because a
    // `const` does not hoist and everything above reads it from a callback.
    const historySource = () => chatTier(findAdapter(props.agentId).chat?.transport).historySource;

    // Re-read as well as read: for an agent Tori counts from its own sidecar,
    // the figure taken here predates the session/load that is about to rewrite
    // it. One definition, called at open and again once the replay has landed.
    function refreshPromptCount() {
      void invoke<number>("chat_prompt_count", { sessionId: props.sessionId, agentId: props.agentId })
        .then(setPromptCount)
        .catch(() => {});
    }
    refreshPromptCount();

    // Live events arriving before the backfill has been folded in would render
    // this session's history *after* its newest turn. They are parked here
    // until the replay lands, then drained in arrival order.
    let backfilled = false;
    // Whether the agent is still handing over the conversation it already had.
    // Only ever true for a transport whose history rides the live channel; see
    // `replayFold`. Set per connect, since a reconnect replays again.
    let replaying = false;
    // Whether this connect's replay has already replaced what the backfill drew.
    // Per connect for the same reason `replaying` is: a reconnect replays the
    // conversation again, and that one supersedes the panel just as the first
    // did.
    let replacedBackfill = false;
    // Whether the "this agent keeps the conversation itself" notice is the only
    // thing on screen. Not per connect: it is pushed once, by the backfill, and
    // cleared the first time this session says anything at all.
    let emptyNoticeShown = false;
    const parked: ChatEvent[] = [];
    // The checkpoint timestamp of the turn currently running, so this session's
    // reported writes are filed against the same turn its snapshot is named
    // after. Null before the first turn, when there is no boundary to file
    // against - a write then belongs to no turn rather than to turn zero.
    let turnTs: number | null = null;
    // Tool names by `toolUseId`. The name arrives on `toolCallStarted` and the
    // write targets on `toolCallCompleted`, so the two have to be rejoined here
    // to report which tool wrote what. Which tool ran is what tells attribution
    // whether its file list is exhaustive: a `Bash` call names no path, so a
    // turn containing one can only ever be a lower bound on what it wrote.
    const toolNames = new Map<string, string>();

    // Backfill from the transcript the agent itself wrote, which is the same
    // file whether the earlier turns happened in this panel, in a PTY agent tab
    // or in an outside terminal. A session with none yet replays nothing.
    //
    // A fork reads the session it forked *from*: its own file does not exist
    // until the CLI writes it, and what the user expects to see is the history
    // up to the fork point.
    void invoke<unknown[]>("chat_history", {
      sessionId: props.sessionId,
      fromSessionId: props.forkFrom ?? null,
      agentId: props.agentId,
      // A rewind cuts the replay where the tree was put back to, so the
      // conversation on screen and the files on disk agree. What the *agent*
      // remembers is not cut, which is what the banner below exists to say.
      //
      // Only while this tab is still reading the session it rewound *from*.
      // `--fork-session` copies the original conversation into the fork's own
      // transcript, so once the tab is restored and resuming its own id, the
      // same cut would fall in the middle of that copy and hide the turns run
      // since the rewind. The banner survives the restart (`rewindTo` is
      // persisted); the cut deliberately does not.
      upToPromptTs: props.forkFrom ? (props.rewindTo ?? null) : null,
    })
      .then((raw) => {
        // Replayed history is folded straight in rather than through
        // `handleLive`: it is finished work, so it must not re-snapshot
        // checkpoints or re-record attribution for turns that already ran.
        edit((s) => {
          const labels: string[] = [];
          for (const item of raw) {
            const ev = parseChatEvent(item);
            if (!ev) continue;
            applyEvent(s, ev);
            if (ev.type === "userMessage") labels.push(...labelsOf(ev.blocks));
          }
          // The transcript carries no turn boundaries, so without this the
          // last replayed turn stays "active" and the whole panel reads as
          // working on a turn that finished before the tab existed.
          settleBackfill(s);
          // A restored tab for an agent that keeps its own conversation, with
          // nothing saved yet. Blank is the one thing this must not be: an
          // inert tab does not spawn ([[adr_lazy_tab_attachment]]), so there is
          // no way to tell "no turns" from "not loaded yet" without saying it.
          if (historySource() === "session-replay" && s.items.length === 0 && !s.started) {
            emptyNoticeShown = true;
            pushNotice(s, "This agent keeps the conversation itself; it loads when the chat starts", "info");
          }
          // In the same edit as the turns, so no send can slip between the
          // history landing and the numbering being raised above it.
          seedLabels(composerKey(), labels);
        });
      })
      // History is an enhancement, not a precondition: a transcript that cannot
      // be read must not stop the live session from running. It must not fail
      // *silently* either, which is what this used to do: a session with turns
      // on disk opened blank and looked like a session with no turns, and the
      // one fact that tells those apart went to a swallowed rejection.
      .catch((err) => {
        edit((s) =>
          applyEvent(s, {
            type: "sessionError",
            sessionId: props.sessionId,
            message: `Could not read this session's earlier turns: ${String(err)}`,
            fatal: false,
          }),
        );
        // Nothing to seed from, but a send held for the seed must still go.
        seedLabels(composerKey(), []);
      })
      .finally(() => {
        // Draining and flipping the flag happen in **one synchronous block**.
        // Split across two microtasks, a channel message delivered between them
        // would be parked and then thrown away by the clear - and because the
        // drain went through `applyEvent` directly, a parked `turnStarted` would
        // also have skipped its checkpoint and its attribution entirely.
        const pending = parked.splice(0, parked.length);
        backfilled = true;
        for (const ev of pending) handleLive(ev);
        // A question or permission asked while no view was attached reached
        // nobody live, and history has it without the id that answers it.
        void invoke<unknown[]>("chat_waiting", { sessionId: props.sessionId })
          .then((raw) => {
            for (const item of raw) {
              const ev = parseChatEvent(item);
              if (ev) handleLive(ev);
            }
          })
          .catch(() => {});
        // A turn Tori still believed was open when it last went away. Read
        // *after* the backfill so the notice lands at the end of the replayed
        // history, where that turn actually is. Consumed as it is read, so it
        // is announced once rather than on every reopen.
        void invoke<{ turnId: string } | null>("chat_take_interrupted_turn", {
          sessionId: props.sessionId,
        })
          .then((open) => {
            if (!open) return;
            edit((s) =>
              applyEvent(s, {
                type: "sessionError",
                sessionId: props.sessionId,
                message:
                  "This turn was interrupted when Tori last closed. Its partial output is above; send again to continue.",
                fatal: false,
              }),
            );
          })
          .catch(() => {});
      });

    // One path for every live event, whether it arrived while the backfill was
    // still in flight or after. Two paths is how a parked event ends up folded
    // into the transcript without the side effects a live one gets.
    function handleLive(ev: ChatEvent) {
      // History that arrives on the live channel, for a transport that has no
      // transcript to read. Folded and nothing more: the side effects below all
      // belong to work happening now.
      const fold = replayFold(ev, replaying);
      replaying = fold.replaying;
      // The session has just re-read its own conversation, so anything Tori
      // counts off that conversation was counted before it landed.
      if (ev.type === "sessionStarted" && historySource() === "session-replay") {
        refreshPromptCount();
      }
      // The chat is open now, so the notice saying its history arrives when it
      // opens has been answered. Folded into the same edit as the frame itself,
      // rather than a second write and a second render for one event.
      const clearsNotice = ev.type === "sessionStarted" && emptyNoticeShown && !replacedBackfill;
      if (clearsNotice) emptyNoticeShown = false;
      const dropNotice = (s: ChatState) => {
        // Only while it is still the only thing here. A turn sent from this tab
        // before the session finished opening is real conversation, and
        // dropping the notice must not take that with it.
        if (clearsNotice && s.items.length === 1) resetTranscript(s);
      };
      if (fold.as !== "live") {
        edit((s) => {
          dropNotice(s);
          // The backfill above drew Tori's own log of this conversation. The
          // agent owns the conversation, so its replay is the authority and
          // replaces that drawing rather than being folded on top of it. Keyed
          // on the first *conversation* frame, so a replay bringing only
          // notices and config leaves the history on screen alone - the same
          // question, and the same seven frames, the log's own rebuild uses.
          if (!replacedBackfill && isConversationEvent(ev)) {
            replacedBackfill = true;
            // The notice goes with everything else on screen, and saying so
            // here is what stops a later reconnect from reading the flag as
            // still-showing and clearing a conversation to match it.
            emptyNoticeShown = false;
            resetTranscript(s);
          }
          applyEvent(s, ev);
          // The replay carries no turn boundaries, exactly like a transcript.
          if (fold.as === "settle") settleBackfill(s);
          // A transport with no transcript to read replays its user turns
          // here, so this is the only place its spent labels can raise the
          // numbering. `seedLabels` only ever raises, so a live turn's own
          // labels arriving this way change nothing.
          if (ev.type === "userMessage") seedLabels(composerKey(), labelsOf(ev.blocks));
        });
        return;
      }
      edit((s) => {
        dropNotice(s);
        applyEvent(s, ev);
      });
      // Under the account the session actually ran as, which is the cache the
      // next draft on it reads.
      if (ev.type === "sessionReady" || ev.type === "sessionStarted") {
        recordLiveCommands(props.agentId, resolvedProfile(), ev.slashCommands);
      }
      // A session that died before it could take the message being held for it.
      // Handing the message back and turning the tab into a draft again is a
      // better answer than a dead transcript with the user's words inside it:
      // the harness is the thing that failed, and the draft is where a different
      // one can be picked.
      if (ev.type === "sessionError" && ev.fatal && !canSend()) {
        failFirstSend(ev.message);
      }
      // Said out loud as well as marked on the row: the row is behind a menu
      // the user has already closed by the time the answer comes back.
      if (ev.type === "modeRefused") {
        emitWith<ToastEvent>(TOAST, { message: ev.reason, kind: "error" });
        if (ev.mode === askedMode) askedMode = null;
      }
      if (ev.type === "configOptions") recordConfirmed(ev.options);
      // Into the account's store, not just this session's: the quota belongs to
      // the login, and three chats on it are three views of one number. The
      // account of record is the backend's resolved one, so a resumed session
      // files under the profile its transcript is actually in.
      if (ev.type === "rateLimit") {
        recordReadings(props.agentId, resolvedProfile(), "sessions", readingsOf(rateLimitFrom(ev)));
      }
      // A real turn boundary, not one inferred from a re-read prompt count.
      // Fired on `turnStarted` so the snapshot is the tree *before* this turn's
      // edits, which is the only state reverting the turn can mean.
      if (ev.type === "turnStarted") {
        const at = Math.floor(Date.now() / 1000);
        turnTs = at;
        if (firstTurnTs() === null) setFirstTurnTs(at);
        setTurnStamps((prev) => ({ ...prev, [ev.turnId]: at }));
        // No tool call outlives the turn that opened it, so anything still in
        // here is spent. Cleared per turn rather than never, which would grow
        // the map for as long as the panel is open.
        toolNames.clear();
        void checkpointChatTurn(props.sessionId, props.cwd, turnTs);
      }
      // A turn's cost is persisted the moment it lands, not on close: a ceiling
      // that forgets what has been spent whenever a tab is reopened is not a
      // ceiling, and a crash mid-session must not reset the tally to zero.
      if (ev.type === "turnCompleted") {
        void recordSpend(ev.usage ? turnTokens(ev.usage) : 0, ev.costUsd);
      }
      // Tori's own record of whether a turn is in flight. A killed app leaves
      // this set, which is the only way to tell a turn that was interrupted
      // from one that ended: the transcript just stops either way.
      if (ev.type === "turnStarted" || ev.type === "turnCompleted") {
        void invoke("chat_mark_turn", {
          sessionId: props.sessionId,
          turnId: ev.type === "turnStarted" ? ev.turnId : null,
        }).catch(() => {});
      }
      if (ev.type === "toolCallStarted") toolNames.set(ev.toolUseId, ev.name);
      // The session says which files it wrote, so the gutter and the Changes
      // panel do not have to wait for the watcher to notice. The watcher's own
      // event still arrives; both consumers are idempotent.
      const written = filesWritten(ev);
      if (written.length) {
        emitWith<AgentFilesWritten>(AGENT_FILES_WRITTEN, { paths: [...written] });
      }
      // The measurement that makes per-turn attribution exact: these are the
      // paths *this* session wrote, which is what the whole-tree snapshot
      // cannot say when several chats share one worktree. Recorded against the
      // turn's own checkpoint timestamp so the two line up.
      //
      // Reported per tool call and not per write, because a call that wrote
      // nothing Tori could see is exactly the case attribution must know about:
      // an unrecorded `Bash` call leaves a turn looking like a PTY turn, which
      // takes the unfiltered branch and claims another session's edits.
      if (turnTs !== null && (ev.type === "toolCallCompleted" || ev.type === "fileEdit")) {
        void invoke("checkpoint_note_touched", {
          sessionId: props.sessionId,
          promptTs: turnTs,
          // An unrecognised name is honest here: it is not on the
          // path-parseable allowlist, so the turn grades as partial rather than
          // claiming a completeness nothing established.
          tool: toolNames.get(ev.toolUseId) ?? "",
          files: [...written],
        }).catch(() => {});
      }
    }

    /**
     * Start (or restart) the child and claim the session.
     *
     * Re-callable, because a reconnect is the same operation: a fresh
     * `Channel` (one invoke, one channel), a fresh `chat_spawn`, a fresh claim.
     * The host releases the claim when a child dies, so a reconnect re-takes it
     * rather than contending with a ghost.
     *
     * `resume` is forced on for a reconnect whatever this tab was opened as: the
     * session exists on disk by then, and starting it fresh would silently
     * abandon the transcript the panel is still showing.
     */
    function connect(opts: { reconnect: boolean }) {
      // A reconnect re-attaches to a child that is already running, so only a
      // start answers to the rows the project allows.
      const refused = opts.reconnect ? null : agentRefusal(props.cwd, props.agentId, props.profile);
      if (refused) {
        const message = `${refused}.`;
        edit((s) => applyEvent(s, { type: "sessionError", sessionId: props.sessionId, message, fatal: true }));
        failFirstSend(message);
        return;
      }
      // Re-armed per connect, not once per panel: a reconnect re-opens the
      // session, so an agent that replays on open replays again.
      replaying = chatTier(findAdapter(props.agentId).chat?.transport).historySource === "session-replay";
      replacedBackfill = false;
      const channel = new Channel<unknown>();
      channel.onmessage = (raw) => {
        const ev = parseChatEvent(raw);
        // An unrecognised frame is dropped, never thrown: a panel must not go
        // down mid-turn over a frame it did not expect.
        if (!ev) return;
        // Parked until the replay has landed, or the session's history would
        // render after its newest turn.
        if (!backfilled) {
          parked.push(ev);
          return;
        }
        handleLive(ev);
      };

      // Where pasted files are written, handed over as a directory the agent
      // may read without asking. Only for a transport that takes uploads: for
      // any other the flag has no template and the directory nothing in it.
      const uploads = chatTier(findAdapter(props.agentId).chat?.transport).attachmentUploads.length > 0;
      const extraDirs = uploads ? attachmentsDir().then((dir) => (dir ? [dir] : [])) : Promise.resolve([]);
      void extraDirs
        .then((extraDirs) =>
          invoke<SpawnResult>("chat_spawn", {
            sessionId: props.sessionId,
            tabId: props.tabId,
            agentId: props.agentId,
            cwd: props.cwd,
            resume: opts.reconnect ? true : props.resume,
            // A reconnect keeps the tab's account for the same reason it keeps
            // its session: it is re-attaching to the conversation that is
            // already there, not choosing where to start a new one.
            profile: props.profile,
            // A reconnect is not a fork: the fork already happened, and asking
            // for one again would branch the session a second time.
            forkFrom: opts.reconnect ? null : (props.forkFrom ?? null),
            // The draft's pick, as argv. A reconnect re-attaches to a session
            // that already has these in force, so re-asserting them would be
            // Tori overriding whatever the conversation switched to since.
            model: opts.reconnect ? null : opening.model,
            mode: opts.reconnect ? null : opening.mode,
            effort: opts.reconnect ? null : opening.effort,
            extraDirs,
            // Carried at spawn as well as reported by the effect below, because
            // a session restored into a background tab would otherwise stream
            // at full price until the first time somebody looked at it and
            // looked away.
            visible: props.active,
            background: props.background ?? false,
            spawner: props.spawner ?? null,
            onEvent: channel,
          }),
        )
        .then((res) => {
          setOwnership(res.ownership);
          // The spawner mark lands with the spawn, before any item names this session.
          if (props.spawner) void refreshLocked();
          // The account of record is the backend's answer, not the tab's guess:
          // a resume passing `null` runs under the transcript's own account, and
          // a tab that kept its `null` would file this session's quota readings
          // under nobody. Kept locally as well as pushed to the tab, since the
          // tab record is not reactive by design (mutated in place so `<For>`
          // does not remount this whole surface).
          const resolved = asTabProfile(res.profileId);
          if (res.profileId !== null && resolved !== props.profile) {
            setResolvedProfile(resolved);
            props.onProfileResolved(resolved);
          }
          if (res.ownership.type === "granted" && res.ownership.contested) {
            emitWith<ToastEvent>(TOAST, { message: CONTESTED_NOTICE, kind: "error" });
          }
          // A refused claim has no child to send to, so a message held for this
          // session's first turn goes back to the composer now rather than
          // waiting on a session that is never coming. The held message is *not*
          // sent here even when the claim is granted: granted says a child
          // started, not that it can take a turn. See `sendCapable`.
          if (res.ownership.type !== "granted") {
            failFirstSend("that session is already open somewhere else, so nothing was sent.");
          }
        })
        .catch((e) => {
          edit((s) =>
            applyEvent(s, { type: "sessionError", sessionId: props.sessionId, message: String(e), fatal: true }),
          );
          failFirstSend(String(e));
        });
    }

    reconnect = () => {
      // Cleared before the invoke, so the control stops offering a reconnect
      // that is already under way. A failed spawn drops it straight back to
      // disconnected through the catch above.
      edit((s) => beginReconnect(s));
      connect({ reconnect: true });
    };

    // The spawn, and only the spawn, waits on the tab being started. Everything
    // above - the backfill, the parking, the event pipeline - is set up either
    // way, so a chat opened to read is a full transcript with nothing behind it
    // and the first send has only the child left to add.
    //
    // `props.started` is the only thing tracked. `connect` reads `props.active`
    // on its way past, so a plain effect would re-run on every switch to and
    // from this tab - and the re-run would dispose the deadline timer below
    // while the message it is the backstop for is still being held.
    let spawned = false;
    createEffect(() => {
      if (!props.started || spawned) return;
      spawned = true;
      untrack(() => {
        connect({ reconnect: false });

        // Nothing may hold a first message forever. The claude transport
        // declares no handshake deadline at all, so a binary that spawns and
        // then wedges would leave the message the user already pressed Enter on
        // sitting in a tab that says "connecting" and never stops. A backstop
        // rather than an expectation: a claude handshake is measured in seconds,
        // an ACP agent fails its own 30s handshake deadline first, and a spawn
        // that cannot start rejects immediately - so this fires only when
        // something has genuinely hung.
        //
        // Read here rather than at mount: an opened chat marks its held message
        // at the moment it starts, which is after mount and before this runs.
        if (hasAutoSend(composerKey())) {
          const timer = setTimeout(() => {
            if (canSend()) return;
            failFirstSend("that agent did not get a session open in time, so nothing was sent.");
          }, FIRST_SEND_DEADLINE_MS);
          onCleanup(() => clearTimeout(timer));
        }
      });
    });
  });

  /**
   * Put the draft's pick to an ACP session, now that it has one.
   *
   * Awaited before the held message goes, but the invoke only rejects a switch
   * the transport refuses synchronously (`Switch::Unsupported` or `Unknown`);
   * the agent's own refusal is an event that lands after the message has gone.
   */
  createEffect(() => {
    if (pickApplied() || !canSend() || pickTried) return;
    pickTried = true;
    void untrack(async () => {
      try {
        if (opening.model !== null) {
          await invoke("chat_set_model", {
            sessionId: props.sessionId,
            model: opening.model,
            effort: opening.effort,
          });
        }
        if (opening.mode !== null) {
          await invoke("chat_set_mode", { sessionId: props.sessionId, mode: opening.mode });
        }
        setPickApplied(true);
      } catch (e) {
        edit((s) =>
          applyEvent(s, {
            type: "sessionError",
            sessionId: props.sessionId,
            message: `That model was refused, so nothing was sent: ${String(e)}`,
            fatal: false,
          }),
        );
      }
    });
  });

  let optionsTried = false;
  /** The draft's option picks, once there is a session. Apart from the pick
   *  above because an option rides no argv on any transport, and a refused one
   *  toasts rather than holding the message: it cannot change the answer. */
  createEffect(() => {
    if (optionsTried || !canSend()) return;
    optionsTried = true;
    for (const [configId, value] of Object.entries(opening.optionValues)) {
      applyConfigOption(configId, value);
    }
  });

  /**
   * Record what this project's next draft should open on.
   *
   * At send-capable rather than at spawn, because that is where the tab is
   * genuinely locked to this agent: a spawn that never got a session open would
   * otherwise leave the project defaulting to a harness that does not work here.
   *
   * The agent goes down for every session, a fork and a resume included - it is
   * the last one actually used, whichever way the tab was opened. The picks only
   * go down when this tab made them, since a resumed session's model is the one
   * the conversation already had rather than a choice made now.
   *
   * The account goes down beside the agent and on the same rule, because it is
   * the same kind of fact: what this project last ran as. Written in the stored
   * spelling, where the default account is a value rather than a silence, and
   * only for an agent that has two accounts to tell apart: recorded on a
   * one-account install, "the default account" would later outrank a Settings
   * default the user set after adding their second login.
   */
  createEffect(() => {
    // A background worker runs on its project contract's picks, not the user's.
    if (remembered || props.background || !canSend()) return;
    remembered = true;
    rememberChatPrefs(props.workspace, {
      agent: props.agentId,
      ...(namedProfiles(props.agentId).length ? { profile: asProfileId(resolvedProfile()) } : {}),
      ...(opening.model !== null ? { model: opening.model, effort: opening.effort } : {}),
      ...(opening.mode !== null ? { mode: opening.mode } : {}),
    });
  });

  // A message written before this session could take it: a draft tab's first
  // send, or one handed over by "send to a new chat". Sent here rather than at
  // spawn, because a spawned child is not yet a session that can answer.
  createEffect(() => {
    // And the label seed: a held `[Image 1]` may still be renamed by the
    // transcript, and it has to go out under the name it ends up with.
    if (!canSend() || !pickApplied() || !labelsSeeded(composerKey())) return;
    // Only readiness is tracked. `onSend` reads half the store on its way
    // through, and tracking that would re-run this on every turn boundary for
    // the rest of the session.
    untrack(() => {
      const held = takeAutoSend(composerKey());
      if (held === null) return;
      // The composer showed it while it waited; the turn now appearing above is
      // where it lives from here.
      setDraft(composerKey(), "");
      onSend(held, "chat_send_held");
    });
  });

  // This surface ends the child. `chat_close` is a no-op for a session that
  // already ended, so this is safe on every unmount path - including the one
  // that is not a close at all: a first send replaces the tab record, which
  // remounts this component, and the session it is leaving must not outlive it.
  //
  // The composer is deliberately *not* cleared here. It belongs to the tab now,
  // and this unmount happens on a promotion and a revert as well as a close, so
  // clearing would throw away the very message a first send is carrying. The tab
  // clears it when the tab itself goes away.
  //
  // Gated on this tab having started one. A chat opened only to read mounts
  // over a session id it never claimed, and that id can be live in another tab:
  // closing the reader would end somebody else's child.
  onCleanup(() => {
    dropLiveChat(props.sessionId);
    if (!props.started) return;
    if (props.detach) {
      void invoke("chat_detach", { sessionId: props.sessionId, tabId: props.tabId }).catch(() => {});
      return;
    }
    void invoke("chat_close", { sessionId: props.sessionId }).catch(() => {});
  });

  // A blame widget in the editor pointed at one of this session's turns.
  //
  // The editor knows a session and a prompt timestamp, which is how the
  // checkpoints are named; only this tab can turn that into a turn id, because
  // the mapping is built as its own turns run. A turn from a replayed transcript
  // has no stamp, so the tab still comes forward and the transcript stays where
  // it was, which is a better answer than scrolling somewhere arbitrary.
  onCleanup(
    onWith<RevealTurn>(REVEAL_TURN, (ev) => {
      const target = revealTarget(props.sessionId, turnStamps(), ev);
      if (!target) return;
      emitWith<FocusSessionTab>(FOCUS_SESSION_TAB, { tabId: props.tabId });
      if (target.turnId) setAnchorTurn(target.turnId);
    }),
  );

  // Report this chat's status to whoever asks who could be writing in this
  // folder. Exact, not probed: the event stream says when a turn is running.
  //
  // Registration starts before the claim resolves, because there is no answer
  // yet and a session that IS ours must not be invisible for the round trip. A
  // refusal therefore has to un-register: left behind, a chat that never
  // started would report as a live session forever, adding a phantom blocker to
  // the revert guard and a phantom sibling to the multi-chat count.
  //
  // A chat opened only to read its transcript is the same phantom by another
  // route: it has a session id but no child, so it registers nothing until it
  // starts. Twelve of them must count as zero.
  createEffect(() => {
    if (!props.started || refused()) {
      dropLiveChat(props.sessionId);
      return;
    }
    setLiveChat({
      sessionId: props.sessionId,
      sessionName: props.title,
      agentId: props.agentId,
      folderPath: props.workspace,
      tabId: props.tabId,
      status: asksFor(props.sessionId).length ? "waitingForAnswer" : chatStatus(state),
      background: outstandingBackground(state),
      visible: props.active,
      worker: props.spawner !== undefined,
    });
  });

  // Tell the host which tab is on screen, so a session behind this one has its
  // per-token deltas coalesced instead of paying to repaint a transcript nobody
  // can see. Deferred: the spawn above already carried the opening value, and
  // re-sending it would race the invoke that establishes the session.
  createEffect(
    on(
      () => props.active,
      (active) => {
        // Nothing to coalesce for a session with no child on the other end.
        if (!props.started) return;
        void invoke("chat_set_visible", { sessionId: props.sessionId, visible: active }).catch(() => {});
      },
      { defer: true },
    ),
  );

  // The second chat on a worktree: say once, per worktree, that the two share
  // one working tree and that checkpoint attribution suffers for it.
  const multiChatNotice = () => shouldNotice(chatsInFolder(props.workspace).length, props.workspace, noticed());

  // Too many at once, said in the chat that put the count past the line rather
  // than in all of them. Unlike the notice above this is not dismissible: the
  // cost is still being paid while the banner is up, and it goes away on its own
  // the moment a chat closes or the limit is raised.
  const overCap = () =>
    pastCap(
      props.sessionId,
      liveChats().map((c) => c.sessionId),
      settings.chatDefaults.maxConcurrentChats,
    );
  const capSaid = () => capNotice(liveChats().length, settings.chatDefaults.maxConcurrentChats);

  // What the agent behind this session actually supports, from the adapter's
  // declared transport. Every gate below asks this rather than asking whether
  // the code exists in this build: the code is here for every session, and a
  // second agent would otherwise inherit Claude's measurements by silence.
  const tier = () => chatTier(findAdapter(props.agentId).chat?.transport);


  // A held message is exempt from the autopilot's lock: it is the first prompt
  // this session was opened with, not someone typing into a running one.
  async function sendBlocks(blocks: ContentBlock[], command: "chat_send" | "chat_send_held" = "chat_send") {
    edit((s) => pushUserTurn(s, blocks));
    try {
      await invoke(command, { sessionId: props.sessionId, blocks });
    } catch (e) {
      edit((s) => {
        clearAwaitingTurn(s);
        applyEvent(s, { type: "sessionError", sessionId: props.sessionId, message: String(e), fatal: false });
      });
    }
  }

  // The flush driver. `takeForSend` is atomic precisely because this re-runs the
  // instant the state it reads changes: taking the message and marking the turn
  // in flight separately would let it observe the gap and flush the whole
  // backlog at once.
  createEffect(
    on(
      () => pendingFlush(state),
      (next) => {
        if (!next) return;
        const taken: QueuedInput[] = [];
        edit((s) => {
          const t = takeForSend(s);
          if (t) taken.push(t);
        });
        if (taken.length) void sendBlocks([{ type: "text", text: taken[0].text }], taken[0].held ? "chat_send_held" : "chat_send");
      },
    ),
  );

  /**
   * Deliver a message into the turn that is already running.
   *
   * Routed through [[concept_safe_send]]'s probe gate rather than straight at
   * `chat_send`, so a session blocked on a permission prompt is refused with
   * the same reason the PTY route gives instead of having a message written
   * past the question the user still has to answer.
   *
   * The transcript row and the composer's attachments are both taken inside
   * `write`, so a refusal leaves the chips where the user can still see them
   * and puts no phantom row in the transcript.
   *
   * A steer that did not land puts the typed text **back** in the composer, per
   * [[concept_safe_send]]'s own rule that a caller keeps the text on anything
   * but "sent". This path needs it where the queue never did: `Composer.submit`
   * clears the input the moment `onSend` returns, and a steer resolves long
   * after that, so without this a session blocked on a permission prompt would
   * refuse the message and eat it.
   */
  /**
   * Both halves of "this message can go into the running turn".
   *
   * `steerable` knows only that a turn is under way; it cannot know whether
   * *this* agent reads stdin mid-turn. A agent that buffers to turn end
   * would take the write and deliver it as the next turn, which the user could
   * not tell apart from a steer that landed, so the declared tier decides and
   * anything short of `consumed-before-next-tool` queues instead.
   */
  const canSteer = () => steerable(state) && tier().steer === "consumed-before-next-tool";

  async function steer(text: string) {
    // Before the gate, not inside `write`: bailing after the gate has committed
    // would report "sent" for a message that was never composed.
    if (!text && !pendingFor(composerKey()).length) return;
    const result = await sendWithProbeGate(text, {
      probe: async () => steerProbe(state),
      write: async (t) => {
        const attached = takePending(composerKey());
        const blocks: ContentBlock[] = t ? [...attached, { type: "text", text: t }] : attached;
        // `chat_steer`, not `chat_send`: the latter also flushes a queued mode
        // or model switch, and a steer must leave that for the turn it was
        // promised to rather than spending it on one already running.
        await invoke("chat_steer", { sessionId: props.sessionId, blocks });
        edit((s) => pushSteer(s, blocks));
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }).catch((e): SendResult | null => {
      // Unlike a turn there is no `awaitingTurn` to roll back: the running turn
      // is unaffected by a steer that never left, so this only has to say so.
      // Null rather than a `SendResult`, because none of them is true here and
      // claiming "sent" would be a lie the next branch reads.
      edit((s) => applyEvent(s, { type: "sessionError", sessionId: props.sessionId, message: String(e), fatal: false }));
      return null;
    });
    if (result?.kind === "sent") return;
    restoreDraft(composerKey(), text);
    if (result?.kind === "blocked") emitWith<ToastEvent>(TOAST, { message: BLOCKED_REASON, kind: "error" });
  }

  // Attachments ride the message that is actually sent, whether it opens a turn
  // or steers one. Only the pre-acknowledgement window still queues, and there
  // the chips stay put and visible: a queued message is sent later, and silently
  // emptying the composer now would leave the user unable to see what the next
  // turn is going to carry.
  // The autopilot drives this session: no composer, and its questions are the autopilot's to answer.
  const locked = () => isLocked(props.sessionId);
  const lockedItem = () => autopilotItems().find((i) => i.session === props.sessionId && !["done", "failed"].includes(i.state));

  function onSend(text: string, command: "chat_send" | "chat_send_held" = "chat_send") {
    // A draft being edited in a scratch tab sends what the editor holds right
    // now, saved or not, and the tab and its file go with it.
    const scratch = linkedScratchFor(composerKey());
    if (scratch) text = liveBufferText(scratch) ?? text;
    // Recorded on the way out whichever path it takes, since from the user's
    // side all three are "I sent that".
    pushHistory(composerKey(), text);
    void unlinkScratch(composerKey(), { closeTab: true });
    // A chat that was opened to read has no child yet. The message is held the
    // way a draft's first send holds one and the tab is told to start, which
    // resumes **this** session id rather than minting a fresh one; the effect
    // above sends it as soon as the transport can take a turn.
    if (!props.started) {
      if (!text && !pendingFor(composerKey()).length) return;
      markAutoSend(composerKey(), text);
      props.onStart();
      return;
    }
    // The transcript is still being read, so an attachment numbered now may
    // yet be renamed. Held the same way, and sent by the same effect, once
    // the numbering is settled.
    if (!labelsSeeded(composerKey())) {
      if (!text && !pendingFor(composerKey()).length) return;
      markAutoSend(composerKey(), text);
      return;
    }
    // The ceiling, enforced where Tori actually decides: the turn boundary. The
    // message is queued rather than refused, so raising the limit sends what was
    // already typed instead of asking for it again - and it is *said*, because a
    // send that silently did nothing is the worst of the three outcomes.
    const held = stopped();
    if (held) {
      if (text) edit((s) => enqueue(s, text, command === "chat_send_held"));
      if (!heldSaid()) {
        setHeldSaid(true);
        edit((s) => pushNotice(s, heldNotice(held), "error"));
      }
      return;
    }
    if (running()) {
      if (canSteer()) {
        void steer(text);
        return;
      }
      // Attachment-only is a valid thing to send but not a valid thing to
      // queue: the queue carries text, so an empty entry would flush as an
      // empty turn once the running one ends.
      if (text) edit((s) => enqueue(s, text, command === "chat_send_held"));
      return;
    }
    const attached = takePending(composerKey());
    const blocks: ContentBlock[] = text ? [...attached, { type: "text", text }] : attached;
    if (!blocks.length) return;
    void sendBlocks(blocks, command);
  }

  function onAnswer(card: ToolItem, answer: Answer) {
    const approval = card.approval;
    if (!approval) return;
    // Cleared locally first: the card must stop reading as blocked the moment
    // the user answers, and the tool's real outcome still comes from
    // `toolCallCompleted`.
    edit((s) => resolveApproval(s, card.toolUseId));
    // The scope travels with the answer and is recorded by the agent, in the
    // agent's own grammar. Tori keeps no rule store of its own to update.
    void invoke("chat_respond_permission", {
      sessionId: props.sessionId,
      requestId: approval.requestId,
      toolUseId: card.toolUseId,
      decision: answer.decision,
      scope: answer.scope,
      reason: answer.reason,
    }).catch((e) => emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }));
  }

  /** Send a question's answers, and settle the card without waiting.
   *
   *  The local settle is the same move `onAnswer` makes above and for the same
   *  reason: the form must stop being answerable the moment Submit is pressed,
   *  since the request behind it can only take one answer. The agent's own
   *  record arrives separately as the tool result.
   *
   *  A `false` return means nothing was waiting on that id any more, which is
   *  the one case worth a toast: the answer the user just wrote went nowhere. */
  function onAnswerQuestion(item: QuestionItem, answers: QuestionAnswer[]) {
    if (!item.requestId) return;
    edit((s) => pushQuestionAnswers(s, item.toolUseId, answers));
    void invoke<boolean>("chat_answer_question", {
      sessionId: props.sessionId,
      requestId: item.requestId,
      toolUseId: item.toolUseId,
      answers,
    })
      .then((landed) => {
        if (!landed) {
          emitWith<ToastEvent>(TOAST, {
            message: "That question was already closed, so the answer was not sent.",
            kind: "error",
          });
        }
      })
      .catch((e) => emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }));
  }

  /** What this chat has spent, in the three currencies a ceiling can name. */
  function spend(): Spend {
    const totals = spent();
    return {
      sessionUsd: totals?.session.costUsd ?? null,
      projectUsd: totals?.project.costUsd ?? null,
      // One resolver for both meters and for the ceiling, so a session cannot
      // be stopped against one denominator while the strip draws another.
      contextPercent: contextPercent(state.contextTokens, stripWindow()),
    };
  }

  /**
   * Persist one completed turn, then decide whether this chat may run another.
   *
   * The stop is armed **between** turns, which is also the only place it can be:
   * the ceiling is only knowable once a turn has reported what it cost. Armed in
   * the rule file, it then bites at the *next tool boundary* - the hook fires
   * before a call runs, so the refusal means the tool never started rather than
   * that it was cut off halfway. Nothing here can stop a tool mid-flight, which
   * is the property the plan asked for and the one this shape gives for free.
   */
  async function recordSpend(tokens: number, costUsd: number | null) {
    const totals = await invoke<UsageTotals>("chat_record_usage", {
      cwd: props.cwd,
      sessionId: props.sessionId,
      tokens,
      costUsd,
    }).catch(() => null);
    if (!totals) return;
    setSpent(totals);
    await applyBudget();
  }

  // A ceiling edited mid-session takes effect at once rather than at the next
  // turn end. Tracked on the limits alone, so an unrelated settings change (a
  // font size) does not re-run the budget check.
  createEffect(
    on(
      () => [settings.budgets?.sessionUsd, settings.budgets?.projectUsd, settings.budgets?.contextPercent],
      () => void applyBudget(),
      { defer: true },
    ),
  );

  /**
   * A clock the quota surfaces can depend on.
   *
   * `Date.now()` is not reactive, and a window expiring is the one transition
   * nothing sends an event for: a reached limit refuses turns, so no further
   * `rate_limit_event` arrives, and a banner recomputed only when a reading
   * lands would still say "reached" hours after the reset that cleared it. A
   * minute is finer than any of these windows needs.
   */
  const [clock, setClock] = createSignal(Date.now());
  onMount(() => {
    const tick = setInterval(() => setClock(Date.now()), 60_000);
    onCleanup(() => clearInterval(tick));
  });

  /** This tab's account, its windows, and what the two thresholds make of them.
   *  One accessor so the banner and the notice cannot disagree about `now`. */
  const quotaWindows = () => {
    const warnAt = usageWarnAt(props.agentId, resolvedProfile());
    const now = clock();
    return windowsFor(props.agentId, resolvedProfile()).map((r) => ({
      reading: r,
      state: quotaState(r, warnAt, now),
      sentence: () => windowSentence(r, warnAt, now),
    }));
  };

  /**
   * The one window of this tab's account whose limit is actually in force.
   *
   * Read from the account store rather than from this session's own last event,
   * which is what makes it right in a chat that has never run a turn: the quota
   * belongs to the login, so a sibling chat hitting the wall is news here too,
   * and a fresh tab on a blocked account must not look open for business.
   *
   * `reached` only. A level merely climbing is the strip's job and, past the
   * threshold, one notice; a banner for it would be permanently up on any busy
   * account, which is how a banner stops being read.
   */
  const quotaBanner = () => quotaWindows().find((w) => w.state === "reached")?.sentence() ?? null;

  /** The windows this chat has already spoken about, keyed the way the store
   *  keys a transition. Per chat rather than shared: the news belongs in every
   *  open chat of the account, and one shared flag would put it in whichever
   *  one happened to render first. */
  const said = new Set<string>();

  // One attention notice per window per reset, in this chat. `approaching` only:
  // `reached` has the banner, `expired` and `ok` have nothing to say.
  createEffect(() => {
    // A window kept off the strip is one the user said they do not want to hear
    // about, the same rule the OS notification follows.
    const shown = accountWindows(props.agentId, resolvedProfile());
    for (const w of quotaWindows()) {
      if (w.state !== "approaching") continue;
      if (!shown.includes(chipFor(w.reading.kind))) continue;
      const key = transitionKey(props.agentId, resolvedProfile(), w.reading.kind, w.reading.resetsAt, "approaching");
      if (said.has(key)) continue;
      const sentence = w.sentence();
      if (!sentence) continue;
      said.add(key);
      edit((s) => pushNotice(s, sentence, "attention"));
    }
  });

  /** Arm or clear the stop, and warn once on the way up. */
  async function applyBudget() {
    // The tier still gates this, but on a different thing than it used to: not
    // "does this agent have a hook Tori can refuse a call from", which is no
    // longer how the ceiling works, but "are this chat's turns Tori's to open".
    // A PTY-only agent's are not. Reporting a ceiling as armed where it is not
    // is the one failure a spend ceiling must not have.
    if (!tier().spendCeilings) return;
    const budgets = settings.budgets;
    if (!budgets) return;
    const now = spend();

    const hit = breach(now, budgets);
    if (hit && !stopped()) {
      setStopped(hit);
      // Into the store as well as the signal: `chatStatus` reads the store, and
      // that is what puts this session on the sidebar's needs-you edge. It is
      // also what stops the flush driver, since `pendingFlush` reads it - see
      // there for why the ceiling is not expressed as a queue hold.
      edit((st) => {
        st.budgetStopped = true;
      });
      edit((s) => pushNotice(s, stopNotice(hit), "error"));
      return;
    }
    if (!hit && stopped()) {
      // The ceiling moved. Clearing the flag is all it takes: the flush driver
      // is watching `pendingFlush`, so whatever was typed while stopped goes out
      // on the next tick rather than needing to be sent again.
      setStopped(null);
      setHeldSaid(false);
      edit((st) => {
        st.budgetStopped = false;
      });
      return;
    }
    // Re-armed whenever the ceiling itself moves, keyed on the limit rather than
    // on a bare flag. Raising a limit after being warned about the old one would
    // otherwise mean never being warned about the new one - the warning would
    // fire once per session for the life of the tab and then go quiet for good.
    const ceiling = `${budgets.sessionUsd}/${budgets.projectUsd}/${budgets.contextPercent}`;
    if (warned() !== ceiling) setWarned(null);
    if (hit || warned() === ceiling) return;
    const near = approaching(now, budgets);
    if (!near) return;
    setWarned(ceiling);
    // The one that changes tier: a ceiling being approached is a heads-up, not
    // a failure, and it read as one for as long as it rode `sessionError`.
    edit((s) => pushNotice(s, warnNotice(near, budgets), "attention"));
  }

  // What an ACP session was asked to switch to and has not answered yet. Its
  // answer (`configOptions`) is the record's trigger: a pick it took is written
  // to the tab and the project, one it refused or answered otherwise is dropped.
  let askedMode: PermissionMode | null = null;
  let askedModel: { model: string; effort: string | null } | null = null;
  function recordConfirmed(options: readonly ChatConfigOption[]) {
    const mode = currentOf(options, "mode");
    if (askedMode !== null && mode === askedMode) {
      rememberChatPrefs(props.workspace, { mode });
      setDraftPick(props.tabId, { mode });
      askedMode = null;
    }
    const model = currentOf(options, "model");
    if (askedModel !== null && model !== null) {
      if (model === askedModel.model) {
        rememberChatPrefs(props.workspace, askedModel);
        setDraftPick(props.tabId, askedModel);
      }
      askedModel = null;
    }
  }

  function onSelectMode(mode: PermissionMode) {
    edit((s) => selectMode(s, mode));
    void invoke("chat_set_mode", { sessionId: props.sessionId, mode })
      .then(() => {
        // On ACP the invoke resolves on staging, so the record waits for the
        // agent's answer (`recordConfirmed`): written here, a refused mode
        // would reopen every later draft in this project on it.
        if (!pickRidesArgv(findAdapter(props.agentId).chat?.transport)) {
          askedMode = mode;
          return;
        }
        rememberChatPrefs(props.workspace, { mode });
        // And on the tab, which is what a restore reads: a resumed session
        // comes back on the CLI's default mode, so this is the only record of
        // the one it was in.
        setDraftPick(props.tabId, { mode });
      })
      .catch((e) => {
        // The request never left, so the control must stop promising a switch.
        // Left set, it would show a mode the session will never enter.
        edit((s) => {
          if (s.pendingMode === mode) s.pendingMode = null;
        });
        emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
      });
  }

  // What the picker may offer: the session's own catalogue when the handshake
  // gave us one, the probe cache when it did not, nothing when neither has an
  // answer. `pickableModels` owns that choice so the picker, the effort control
  // and the meter cannot each decide it differently.
  // One accessor for the adapter's chat table, so the mode fallback and the
  // capability resolver cannot each reach for it differently. It no longer
  // carries models at all; the agent names those.
  const chatConfig = () => findAdapter(props.agentId).chat ?? null;
  // The last answer this agent gave anyone, which is what a picker has before
  // a session exists. Live wins the moment the handshake lands, so this is the
  // pre-session list and not a merge; see `pickableModels`.
  const cached = (): CatalogModel[] => cachedModels(catalogFor(props.agentId, resolvedProfile()));
  const models = () => pickableModels(state.models, cached(), state.contextWindows);

  // Four sources, most-trusted first: a pick this tab sent, the id the child
  // reported, what this tab spawned the child with, the transcript's last turn.
  // A spawn re-declares the model the transcript predates, so 3 outranks 4.
  const shownModel = () =>
    selectedModel(models(), shownModelValue(state), state.model ?? null) ??
    selectedModel(models(), state.openingModel, null) ??
    selectedModel(models(), null, detail()?.model ?? null) ??
    models().find((m) => m.value === "default") ??
    null;

  /**
   * The session's figures with the live ones overlaid on the scanned ones.
   *
   * `chat_session_detail` re-reads the transcript **file**, and it is triggered
   * by the same `turnCompleted` that the store folds in memory - but the CLI
   * has not necessarily flushed that turn to disk yet, so the scan comes back
   * describing the turn *before* the one that just landed. The store has no such
   * lag: `contextTokens` is the newest response's own figure.
   *
   * So the scan stays the baseline (it is the only thing that knows a resumed
   * session's earlier turns) and the store overrides it wherever the store is
   * both live and complete:
   *
   *   - **context** is the latest turn's input, not a total, so the newest
   *     reading is the whole answer rather than a delta to add to the file's.
   *   - **prompts and tool calls** are counted off `items`, which replay seeds
   *     with the session's earlier turns, so the count is complete.
   *   - **compactions** are counted as their events arrive, and replay emits
   *     `compacted` for a resumed session's earlier ones too, so that count is
   *     complete for the same reason.
   *
   * **Turns deliberately stays scanned.** `turnsCompleted` counts this run
   * only: replayed history carries no turn frames, so overriding with it would
   * make a resumed session's turn count collapse to however many turns this
   * window has watched, which is worse than a turn stale.
   */
  const liveDetail = () => {
    const scanned = detail();
    if (!scanned) return null;
    const live = state.contextTokens;
    return {
      ...scanned,
      context_tokens: live ?? scanned.context_tokens,
      prompt_count: promptsSent(state),
      tool_count: toolCallsSeen(state),
      compaction_count: state.compactions,
      compaction_reclaimed: state.compactionReclaimed,
    };
  };

  // The window for the model the **stats row is describing**, which is the one
  // the transcript says ran - not `shownModel()`, the one currently selected in
  // the picker. The two differ after a mid-session switch, where dividing the
  // historical figures by the new model's window would be simply wrong.
  //
  // The budget ceiling reads this too. It used to divide by
  // `shownModel()?.contextWindow` while the strip divided by the resolver,
  // which is two denominators for one ratio: a session could be stopped at a
  // percentage the strip was not showing.
  const stripWindow = () => {
    const ran = detail()?.model;
    if (ran) return contextWindowFor(ran, state.contextWindows, state.contextWindow);
    return shownModel()?.contextWindow ?? state.contextWindow ?? null;
  };

  // What a completed turn measured, kept for the next session on this model so
  // it can open at 0/1M rather than at nothing. Only ever the agent's own
  // figure; see utils/contextWindowMemory.
  // Spread rather than passed by reference: a store proxy read as one object
  // subscribes to the reference, and the reducer merges into it in place, so
  // the effect would never see the model that arrived.
  createEffect(() => rememberWindows({ ...state.contextWindows }));

  // The mode the pill shows: the session's own, else the mode the *adapter*
  // nominates. Never the literal "default", which is Claude's spelling and
  // names nothing on a agent whose modes are `auto_edit|yolo`.
  const shownModeValue = () => shownMode(state, defaultMode(chatConfig())?.id ?? null);

  // What this model, on this agent, can actually be asked for. One resolver
  // feeds all three pills, so they cannot disagree about what is on offer.
  // One accessor for the modes on offer, beside `chatConfig` and for the same
  // reason: the selector and the model-switch guard must not each decide
  // separately whether the agent's list or the adapter's table is in charge.
  const liveModes = () => pickableModes(state.modes, chatConfig());
  const offered = () => capabilitiesFor(shownModel(), chatConfig(), liveModes());

  // The agent and the account are ignored on purpose: a locked session is
  // handed one provider, so the only pair the palette can name is this one.
  function onSelectModel(_agentId: string, _profile: string | null, model: PickableModel) {
    edit((s) => selectModel(s, model));
    // Effort is sent with the model because that is how the command carries it:
    // a level the new model does not offer would be rejected, so it is dropped
    // rather than sent and blamed on the model switch.
    const carried = shownEffort(state) ?? "";
    const takeable = model.effortLevels.some((l) => l.level === carried && !l.disabled);
    const effort = takeable ? shownEffort(state) : null;
    applyModelChange(model.value, effort, () => edit((s) => revertModelPick(s, model.value)));

    // A mode the new model does not offer is dropped on the same rule, but it
    // needs a request of its own: mode does not ride the model command.
    //
    // Without this the gate is walkable from one control away. Picking `auto`
    // on Sonnet and then switching to Haiku removes the row from the menu but
    // leaves the session still asking for `auto`, which the CLI accepts, exits
    // 0 on, and silently runs as `default` - the pill promising a mode the
    // session is not in, which is the failure this phase exists to remove.
    const next = modeAfterModelSwitch(model, chatConfig(), shownModeValue(), liveModes());
    if (next !== null) onSelectMode(next);
  }

  function onSelectEffort(effort: string | null) {
    // A model value is required by the command, so an effort-only change re-sends
    // the model the picker is already showing. Without one there is nothing to
    // attach the level to, and the CLI has no effort-only control.
    //
    // Checked *before* the pick is staged: staging first would leave the control
    // promising a level at the next turn that no request ever carried.
    const value = shownModel()?.value;
    if (value === undefined) return;
    edit((s) => selectEffort(s, effort));
    applyModelChange(value, effort, () => edit((s) => revertEffortPick(s, effort)));
  }

  // No pick is replayed at spawn on purpose: a new chat opens on whatever the
  // CLI itself would choose, so the session's defaults are Claude's defaults.
  // The pickers exist for changing course mid-conversation, not for staging a
  // configuration before one.

  /** The one path to `chat_set_model`. A request that never left must not leave
   *  a control promising a switch: the CLI's own error is what the user sees,
   *  rather than a picker that silently shows a model the session never
   *  entered. */
  function applyModelChange(model: string, effort: string | null, revert: () => void) {
    void invoke("chat_set_model", { sessionId: props.sessionId, model, effort })
      // A pick that lands is also the way out of a refused opening pick: the
      // first message is still held, and this is the session finally being on a
      // model it agreed to.
      .then(() => {
        setPickApplied(true);
        // Same split as the mode: an ACP answer is the acceptance, the argv
        // transport's resolved invoke is.
        if (!pickRidesArgv(findAdapter(props.agentId).chat?.transport)) {
          askedModel = { model, effort };
          return;
        }
        // Recorded only once the agent has taken it, so the next draft here
        // opens on a model that was accepted rather than one that was refused.
        rememberChatPrefs(props.workspace, { model, effort });
        // The tab's own record, for the restore. Effort especially: nothing on
        // the wire reports it back and a resume does not carry it, so this is
        // the only place a reload can learn the level from.
        setDraftPick(props.tabId, { model, effort });
      })
      .catch((e) => {
        revert();
        emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
      });
  }

  /** The one path to `chat_set_config_option`, for the mirrored controls.
   *
   *  Nothing is reverted on failure because nothing moved optimistically: the
   *  control renders the option set the agent last published, and the agent
   *  answers every switch with a fresh one. So a refused switch leaves the
   *  control showing what is actually in force, and the error says why. */
  function applyConfigOption(configId: string, value: ChatConfigValue) {
    void invoke("chat_set_config_option", { sessionId: props.sessionId, configId, value }).catch(
      (e) => emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }),
    );
  }

  // Shared with the draft surface, so what an `@` mention resolves to cannot
  // differ between a chat and the draft it grew out of.
  const attachments = composerAttachments(composerKey, () => props.cwd, tier, () => state.capabilities, (reason) =>
    emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" }),
  );

  // Move what is in the composer to a brand-new chat and let it open with that
  // turn. A send the user asked for, at a session that does not exist yet.
  function onSendToNewSession() {
    // Asked before the fork, not after: opening the tab first would leave an
    // empty chat behind (and a spawned child, and a claimed session id) on a
    // click that turns out to have nothing to send.
    if (!hasSomethingToSend(composerKey())) {
      emitWith<ToastEvent>(TOAST, { message: "Type something first, or attach a file.", kind: "info" });
      return;
    }
    seedForSend(composerKey(), props.onForkSession());
  }

  /**
   * Go back to how things were before a turn.
   *
   * Three things at once, and only two of them are clean. The tree goes back to
   * that turn's checkpoint, scoped to what this session recorded writing, so a
   * concurrent chat's work is left alone. The replay is cut at the same
   * checkpoint, so the conversation on screen matches the files. But the
   * conversation is carried on by a **fork**, spawned `--resume <old>
   * --fork-session`, whose context is the whole original including the turns
   * being undone - so the agent remembers writing files that are no longer
   * there. That is stated in the confirm, again in the banner, and again in the
   * message the new chat opens with; see `rewind.ts`.
   *
   * Refused mid-turn rather than queued. A revert lands as a write to the
   * worktree, and the turn still running is the other writer.
   */
  async function onRewind(promptTs: number) {
    if (running()) {
      emitWith<ToastEvent>(TOAST, {
        message: "This chat is mid-turn. Let it finish or interrupt it, then rewind.",
        kind: "error",
      });
      return;
    }
    // Cumulative, because rewinding *to* a boundary undoes every turn since,
    // not just the one whose header was clicked.
    //
    // Fails closed. An empty list here is indistinguishable from "nothing to
    // warn about", so swallowing the error would run the rewind with the
    // "another chat wrote this too" prompt silently skipped - the revert itself
    // would still be scoped correctly by the backend, but the user would have
    // been denied the decision this call exists to offer them.
    let files: CheckpointFile[];
    try {
      files = await invoke<CheckpointFile[]>("checkpoint_turn_files", {
        repoPath: props.workspace,
        sessionId: props.sessionId,
        promptTs,
        cumulative: true,
        others: chatsInFolder(props.workspace)
          .map((c) => c.sessionId)
          .filter((id) => id !== props.sessionId),
      });
    } catch (e) {
      emitWith<ToastEvent>(TOAST, {
        message: `Could not work out which files that turn touched, so nothing was rewound: ${String(e)}`,
        kind: "error",
      });
      return;
    }

    // Files the tree says changed that no session claims. The revert is scoped
    // to what this one recorded, so these stay put - said before the fact,
    // because "go back to here" reads as a promise that everything went back.
    const orphans = files.filter((f) => f.unattributed).map((f) => f.path);
    if (orphans.length) {
      const go = await askConfirm({
        title: `${orphans.length} file${orphans.length === 1 ? "" : "s"} will be left alone`,
        message: `${orphans.join(", ")}\n\n${UNATTRIBUTED_NOTICE}\n\nThe rewind leaves these exactly as they are.`,
        confirmLabel: "Rewind the rest",
      });
      if (!go) return;
    }

    const shared = files.filter((f) => f.shared_with?.length).map((f) => f.path);
    let confirmedShared: string[] = [];
    if (shared.length) {
      const who = [...new Set(files.flatMap((f) => f.shared_with ?? []))];
      const alsoRevert = await askConfirm({
        title: `${shared.length} file${shared.length === 1 ? "" : "s"} also written by another chat`,
        message: `${shared.join(", ")} ${shared.length === 1 ? "was" : "were"} also written by ${who.join(", ")}. Rewinding ${shared.length === 1 ? "it" : "them"} undoes that session's work too.`,
        confirmLabel: "Rewind these too",
        danger: true,
      });
      if (alsoRevert) confirmedShared = shared;
    }

    const ok = await askConfirm({
      title: "Rewind to before this turn?",
      message: `Every file this chat wrote from that turn on goes back to how it was. The current state is saved as a checkpoint first, so this is reversible.\n\n${REWIND_CAVEAT}`,
      confirmLabel: "Rewind",
      danger: true,
    });
    if (!ok) return;

    try {
      await invoke<unknown>("checkpoint_revert_tree", {
        repoPath: props.workspace,
        sessionId: props.sessionId,
        promptTs,
        shared: confirmedShared,
      });
    } catch (e) {
      emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
      return;
    }
    // This session is being superseded, so anything it left claiming a turn is
    // in flight has to go with it: a mark left behind would greet whoever
    // reopens the old id with an interruption notice for a turn that was
    // deliberately undone, long after the fact.
    await invoke("chat_mark_turn", { sessionId: props.sessionId, turnId: null }).catch(() => {});
    props.onRewindFrom(promptTs);
  }

  // Undo one hunk of an edit this session made.
  //
  // Gated by the same guard a whole-tree revert takes, because the hazard is the
  // same and smaller only in size: an agent mid-turn in this folder may be
  // writing the very file we are about to rewrite, and whichever write lands
  // second wins silently. The actors are gathered at click time, which is what
  // `folderActors` is built for - the detached tier costs a probe per off-tab
  // session, so it must not run per event.
  //
  // The buffer refresh is not wired here on purpose: the revert writes the file
  // on disk, and the editor reloads it through [[concept_fs_change_pipeline]]'s
  // watcher, the same path a checkpoint revert takes.
  async function onRevertHunk(ref: HunkRef): Promise<boolean> {
    const permission = hunkRevertPermission(await folderActors(props.workspace), props.workspace);
    if (permission.kind === "refuse") {
      emitWith<ToastEvent>(TOAST, { message: permission.reason, kind: "error" });
      return false;
    }
    const name = ref.path.split("/").pop() ?? ref.path;
    const ok = await askConfirm({
      title: `Revert this hunk of ${name}?`,
      message:
        permission.kind === "confirm"
          ? `${permission.reason} Reverting this hunk writes to the file anyway.`
          : "This rewrites that region of the file on disk, back to what the tool call found.",
      confirmLabel: "Revert",
      danger: true,
    });
    if (!ok) return false;
    try {
      const outcome = await invoke<string>("chat_revert_tool_hunk", {
        sessionId: props.sessionId,
        toolUseId: ref.toolUseId,
        cwd: props.cwd,
        path: ref.path,
        hunkIndex: ref.hunkIndex,
        fingerprint: ref.fingerprint,
      });
      // Undoing a creation removes the file, and the card's diff then reads as
      // "unchanged" - true of the bytes, misleading about what happened. Saying
      // which of the two it was is the difference between the two readings.
      emitWith<ToastEvent>(TOAST, {
        message: outcome === "deleted" ? `Removed ${name}, which this call created.` : `Reverted that hunk of ${name}.`,
        kind: "info",
      });
      return true;
    } catch (e) {
      emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
      return false;
    }
  }

  function onInterrupt() {
    void invoke("chat_interrupt", { sessionId: props.sessionId }).catch(() => {});
  }

  function endOrphan(childPid: number) {
    void invoke("chat_terminate_orphan", {
      sessionId: props.sessionId,
      childPid,
      agentId: props.agentId,
    })
      .then(() => emitWith<ToastEvent>(TOAST, { message: "Ended the leftover session. Reopen it to continue.", kind: "info" }))
      .catch((e) => emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }));
  }

  return (
    <div class={`${styles.chat} ${props.active ? styles.active : ""}`} data-cockpit={props.cockpit ? "true" : undefined}>
      <Show when={overCap()}>
        <div class={styles.banner}>
          <span class={styles.bannerText}>{capSaid()}</span>
        </div>
      </Show>

      <Show when={multiChatNotice()}>
        <div class={styles.banner}>
          <span class={styles.bannerText}>{MULTI_CHAT_NOTICE}</span>
          <Button size="sm" onClick={() => markNoticed(props.workspace)}>
            Got it
          </Button>
        </div>
      </Show>

      {/* The one part of a rewind that could not be undone: the fork carries the
          original's whole context, so the agent remembers the turns that are no
          longer above it. Persistent rather than dismissable - the gap lasts as
          long as the session does. */}
      <Show when={props.rewindTo}>
        <div class={styles.banner}>
          <span class={styles.bannerText}>{REWIND_BANNER}</span>
        </div>
      </Show>

      {/* This account's quota, not this session's last frame: a sibling chat on
          the same login hitting the wall is news here too, and a chat that has
          never run a turn must not look open for business. */}
      <Show when={quotaBanner()}>
        {(message) => (
          <div class={`${styles.banner} ${styles.bannerReached}`}>
            <span class={styles.bannerText}>{message()}</span>
          </div>
        )}
      </Show>

      {/* An ownership refusal is an offer, not an error string: go to what
          holds the session, or start a fresh one beside it. */}
      <Show when={heldElsewhere()}>
        {(held) => (
          <div class={styles.refusal}>
            <span class={styles.bannerText}>{refusalMessage(held())}</span>
            <Button
              size="sm"
              variant="primary"
              onClick={() => emitWith<FocusSessionTab>(FOCUS_SESSION_TAB, { tabId: held().tabId })}
            >
              Go to it
            </Button>
            <Button size="sm" onClick={() => props.onForkSession()}>
              Start a new chat
            </Button>
          </div>
        )}
      </Show>

      <Show when={orphaned()}>
        {(orphan) => (
          <div class={styles.refusal}>
            <span class={styles.bannerText}>{refusalMessage(orphan())}</span>
            <Button size="sm" variant="primary" onClick={() => endOrphan(orphan().childPid)}>
              End it
            </Button>
            <Button size="sm" onClick={() => props.onForkSession()}>
              Start a new chat
            </Button>
          </div>
        )}
      </Show>

      {/* Not for a refused claim. No child was ever started there, so the
          health would sit on "connecting" forever - a claim about a process
          that is never coming - and a Reconnect button would offer to take a
          session another tab holds. The refusal banner above already says
          what happened and offers the two real ways out.

          Nor for a chat that has not been started: there is no connection to
          report the health of, and Reconnect would spawn the very child the tab
          is deliberately doing without. */}
      <Show when={props.started && !refused() && !props.cockpit}>
        <StatusStrip
          health={connectionHealth(state)}
          running={running()}
          background={outstandingBackground(state)}
          compacting={state.compactingItemId !== null}
          awaitingApproval={pendingApprovals(state).length > 0}
          files={touchedFiles()}
          detail={liveDetail()}
          contextWindow={stripWindow()}
          agentId={props.agentId}
          onReconnect={() => reconnect?.()}
          menu={
            <div class={styles.menuBody}>
              <div class={styles.menuActions}>
                <Button
                  size="sm"
                  tooltip={
                    showDiff()
                      ? "Back to the turn-by-turn transcript"
                      : "See every file this session changed, as one diff per file"
                  }
                  onClick={() => setShowDiff(!showDiff())}
                >
                  {showDiff() ? "Show transcript" : "Show changes as a diff"}
                </Button>
                <Button
                  size="sm"
                  tooltip="Open a new chat and send what is in the composer to it"
                  onClick={onSendToNewSession}
                >
                  Send to a new chat
                </Button>
                {/* Only once there is something to branch from. A fork of a
                    session with no turns is just a new chat, and offering it as
                    a fork would promise history that does not exist. */}
                <Show when={state.started && state.items.length > 0}>
                  <Button
                    size="sm"
                    tooltip="Branch this conversation into a new session, keeping everything up to here"
                    onClick={() => props.onForkFrom()}
                  >
                    Fork this chat
                  </Button>
                </Show>
              </div>
              <UsageReadout summary={usageSummary({ ...state, promptsInTranscript: promptCount() })} />
              <SessionInfo
                mcpServers={state.mcpServers}
                skills={state.skills}
                agents={state.agents}
                plugins={state.plugins}
                account={state.account}
                capabilities={publishedCapabilities(tier(), state.capabilities)}
                cwd={props.cwd}
                agentId={props.agentId}
                profile={resolvedProfile()}
                profileLabel={profileLabel(props.agentId, resolvedProfile())}
              />
            </div>
          }
        />
      </Show>

      <Show
        when={!showDiff()}
        fallback={
          <SessionDiffView
            sessionId={props.sessionId}
            cwd={props.cwd}
            // Every lane's rows, not the selected one's: this answers "what
            // did this session do to my files", and a subagent's edit going
            // missing would break the one view trusted to be complete.
            items={state.items}
            live={state.started}
            sinceTs={firstTurnTs()}
          />
        }
      >
      <MessageList
        ref={(el) => (transcriptEl = el)}
        items={shownItems()}
        streaming={running()}
        sessionId={props.sessionId}
        cwd={props.cwd}
        anchorTurnId={anchorTurn()}
        onAnchor={setAnchorTurn}
        // The catalogue's display name when the resolved id matches one, the
        // raw id when it does not: an old id from a resumed transcript is
        // still better named than hidden.
        modelLabelFor={(turnId) => {
          const resolved = turnModel(state, turnId);
          if (!resolved) return null;
          return models().find((m) => m.resolvedModel === resolved)?.label ?? resolved;
        }}
        onAnswer={locked() ? undefined : onAnswer}
        onAnswerQuestion={locked() ? undefined : onAnswerQuestion}
        onSetMode={onSelectMode}
        onRevertHunk={onRevertHunk}
        // Gated on the declaration, not on the checkpoint alone: a agent that
        // cannot fork has no way to carry the conversation across, and offering
        // "rewind to here" there would promise the tree *and* the conversation
        // and deliver only the tree.
        rewindTsFor={(turnId) => (tier().rewind === "fork" ? turnStamps()[turnId] ?? null : null)}
        agentTurn={(turnId) => state.turns[turnId]?.agentInitiated === true}
        laneOpenedBy={(toolUseId) => laneOpenedBy(toolUseId)}
        blockedIn={blockedIn}
        onOpenLane={(agentId) => edit((s) => selectLane(s, agentId))}
        onRewind={onRewind}
        replyMark={props.cockpit ? ReplyMark : undefined}
      />
      </Show>
      {/* Selected transcript text goes into the reply as a quote. Scoped to this
          transcript's root, since every attached tab stays mounted. */}
      <QuoteSelection root={() => transcriptEl} onQuote={(text) => composer?.insertBlock(quoteBlock(text))} />

      <Show when={props.cockpit && asksFor(props.sessionId).length}>
        {(count) => (
          <div class={styles.cockpitCall}>
            <CaptainsCall count={count()} />
          </div>
        )}
      </Show>
      <For each={asksFor(props.sessionId)}>{(ask) => <AskCard ask={ask} here={props.sessionId} />}</For>

      <PlanCard items={state.plan} />

      <LaneStrip
        lanes={laneStrip(state)}
        tasks={backgroundTasks(state)}
        blocked={blockedLanes(state)}
        selected={state.selectedLane}
        busy={running()}
        mark={providerMarkKey(state.model, props.agentId)}
        onSelect={(agentId) => edit((s) => selectLane(s, agentId))}
        active={props.active}
      />

      <Show
        when={!locked()}
        fallback={
          <LockedBar
            now={lockedItem()?.note ?? "working"}
            progress={0}
            waiting={lockedItem()?.state === "waiting_on_you"}
            onBackToAutopilot={() => setView("autopilot")}
            onStop={() => void stopAutopilot()}
          />
        }
      >
        <Composer
          watching={watchedLane()}
          running={running()}
          steering={canSteer()}
          steerCost={steerCostLabel(tier())}
          queue={state.queue}
          attachments={pendingFor(composerKey())}
          draft={draftFor(composerKey())}
          onDraftChange={(t) => setDraft(composerKey(), t)}
          history={historyFor(composerKey())}
          // This session's own, and the agent's last answer until it has one. A
          // handshake takes a moment to land and a chat opened only to read never
          // gets one at all, and `/` opening on an empty menu in either is worse
          // than a list that may name a command since removed - which the agent
          // refuses with a sentence. Replaced, never merged: once the session has
          // spoken, it is the only authority on what it takes.
          commands={state.slashCommands.length ? state.slashCommands : cachedCommands(catalogFor(props.agentId, resolvedProfile()))}
          loadFiles={attachments.loadProjectFiles}
          held={state.queueHeld}
          disabled={refused() || state.ended}
          onSend={onSend}
          onAttachFile={attachments.onAttachFile}
          onAttachPaths={attachments.onAttachPaths}
          uploads={attachmentSources(tier(), state.capabilities).uploads}
          attachLongPastes={settings.chatDefaults.attachLongPastes}
          fileExists={(path) => invoke<boolean>("file_exists", { path })}
          handle={(h) => (composer = h)}
          linked={linkedName()}
          onOpenInEditor={() => void openDraftInEditor(composerKey())}
          onUnlink={() => void unlinkScratch(composerKey(), { closeTab: true })}
          onAttachUploads={attachments.onAttachUploads}
          onAttachRejected={(reason) => emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" })}
          onInterrupt={onInterrupt}
          onDropQueued={(id) => edit((s) => removeQueued(s, id))}
          onDropAttachment={(id) => dropPending(composerKey(), id)}
          onSendQueued={() => edit((s) => releaseQueue(s))}
          onDiscardQueued={() => edit((s) => discardQueue(s))}
          // One line for all three switches, above the input. In the bar it sat
          // beside whichever pill was pending and pushed the rest along.
          notice={pendingSwitchNotice(state)}
          // Everything the next turn will run under: the mode, the model and its
          // effort. All the switches land at the same next-turn boundary, so
          // they sit together in the bar under the input.
          controls={
            props.cockpit ? undefined : <>
              {/* Model, then its thinking level, then the mode. The order is the
                  dependency: the effort levels on offer are a property of the
                  selected model, so the control that decides them comes first,
                  and the mode - which no model constrains - sits at the end. */}
              <ModelPicker
                models={models()}
                // One provider, which is the whole of the lock: the palette has
                // no locked mode, it is simply handed a list of one.
                providers={[
                  lockedProvider(findAdapter(props.agentId), models(), {
                    version: agentVersion(props.agentId),
                    profile: resolvedProfile(),
                    account: profileLabel(props.agentId, resolvedProfile()),
                  }),
                ]}
                value={shownModel()?.value ?? null}
                agentId={props.agentId}
                profile={resolvedProfile()}
                profileLabel={profileLabel(props.agentId, resolvedProfile())}
                effort={shownEffort(state)}
                modelPending={modelPending(state)}
                effortPending={effortPending(state)}
                disabled={refused() || state.ended}
                onSelectModel={onSelectModel}
                onSelectEffort={onSelectEffort}
              />
              <ModeSelector
                mode={shownModeValue()}
                modes={offered().modes}
                pending={modePending(state)}
                refusals={state.refusedModes}
                disabled={refused() || state.ended}
                onSelect={onSelectMode}
              />
              {/* Last, after the three Tori has controls of its own for: these
                  are the agent's, in the agent's own words, and their order is
                  the order it published them in. */}
              <ConfigMirror
                options={state.configOptions}
                disabled={refused() || state.ended}
                onSet={applyConfigOption}
              />
              <FollowToggle />
            </>
          }
        />
      </Show>

      <Show when={confirmReq()}>
        {(req) => (
          <ConfirmDialog
            title={req().title}
            message={req().message}
            confirmLabel={req().confirmLabel}
            danger={req().danger}
            onConfirm={() => resolveConfirm(true)}
            onCancel={() => resolveConfirm(false)}
          />
        )}
      </Show>
    </div>
  );
}
