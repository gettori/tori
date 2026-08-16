import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Channel, invoke } from "@tauri-apps/api/core";
import MessageList from "./MessageList";
import SessionDiffView from "./SessionDiffView";
import SessionInfo from "./SessionInfo";
import Composer from "./Composer";
import PlanCard from "./PlanCard";
import UsageReadout from "./UsageReadout";
import StatusStrip from "./StatusStrip";
import ModeSelector from "./ModeSelector";
import ModelPicker from "./ModelPicker";
import FastModeStatus from "./FastModeStatus";
import { turnTokens, usageSummary } from "../../utils/chatUsage";
import { rateLimitMessage } from "../../utils/chatRateLimit";
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
import { type SessionDetail } from "./SessionStats";
import ConfirmDialog, { type ConfirmOpts, type ConfirmReq } from "../../components/Dialogs/ConfirmDialog";
import {
  clearComposer,
  draftFor,
  dropPending,
  fileMentionBlocks,
  imageBlocks,
  offerToComposer,
  hasSomethingToSend,
  historyFor,
  pendingFor,
  restoreDraft,
  seedForSend,
  pushHistory,
  setDraft,
  takeAutoSend,
  takePending,
} from "../../utils/chatCompose";
import { folderActors } from "../../utils/folderActors";
import { hunkRevertPermission } from "../../utils/hunkRevert";
import { parseChatEvent, type ChatEvent, type ContentBlock, type PermissionMode } from "../../utils/chatTypes";
import { dropLiveChat, chatsInFolder, liveChats, setLiveChat } from "../../utils/chatSessions";
import { checkpointChatTurn } from "../../utils/checkpoints";
import type { UsageTotals } from "../../utils/chatUsageStore";
import {
  capabilitiesFor,
  contextPercent,
  contextTokens,
  contextWindowFor,
  defaultMode,
  modeAfterModelSwitch,
  pickableModels,
  pickableModes,
  selectedModel,
  type PickableModel,
} from "../../utils/chatModels";
import {
  cachedModels,
  catalogFor,
  refreshCatalogIfDue,
  type CatalogModel,
} from "../../utils/modelCatalog";
import { findAgent } from "../../utils/agents";
import { revealTarget } from "../../utils/agentLines";
import { chatTier, publishedCapabilities, steerCostLabel } from "../../utils/chatCapabilities";
import { settings } from "../Settings/settingsStore";
import { capNotice, markNoticed, noticed, pastCap, shouldNotice, MULTI_CHAT_NOTICE } from "../../utils/chatConcurrency";
import {
  emitWith,
  onWith,
  AGENT_FILES_WRITTEN,
  FOCUS_SESSION_TAB,
  REVEAL_TURN,
  TOAST,
  type AgentFilesWritten,
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
  pendingFlush,
  promptsSent,
  pushSteer,
  pushUserTurn,
  releaseQueue,
  removeQueued,
  resolveApproval,
  revertEffortPick,
  revertModelPick,
  selectEffort,
  selectMode,
  selectModel,
  settleBackfill,
  steerable,
  steerProbe,
  shownEffort,
  turnModel,
  shownMode,
  shownModelValue,
  takeForSend,
  toolCallsSeen,
  visibleItems,
  type ChatState,
  type QueuedInput,
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
import styles from "./Chat.module.css";

/** `SpawnResult` from `chat/commands.rs`. A refusal is a normal answer, not an
 *  error: it names the tab that holds the session, or the orphaned child. */
type SpawnResult = { ownership: ClaimOutcome; spawned: "started" | "rewired" | null };

/** One changed file as `checkpoint_turn_files` reports it. */
type CheckpointFile = { path: string; shared_with?: string[]; unattributed?: boolean };

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
  cwd: string;
  /** The branch-unit folder this tab groups under, which is what "another chat
   *  in this worktree" is measured against. */
  workspace: string;
  title: string;
  /** A tab restored from a previous run, whose session already has a transcript. */
  resume: boolean;
  /** The session this one was forked from, when it is a fork. Its history is
   *  replayed here and the two diverge from that point; new turns never reach
   *  the original. */
  forkFrom?: string;
  /** Set when this tab is a rewind of `forkFrom`: the checkpoint the tree was
   *  put back to, which is also where the replayed history is cut. */
  rewindTo?: number;
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
}) {
  const [state, setState] = createStore<ChatState>(initialChat(props.sessionId));
  const [ownership, setOwnership] = createSignal<ClaimOutcome | null>(null);
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  // The transcript and the diff are two readings of one session, so they are a
  // toggle rather than two places to be. The turn the reader was on is kept
  // across the switch: coming back to the bottom of a long session would lose
  // the place they left, which is the whole reason to look at the diff.
  const [showDiff, setShowDiff] = createSignal(false);
  const [anchorTurn, setAnchorTurn] = createSignal<string | null>(null);
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
  const running = () => isRunning(state);

  // Memoized, not a plain accessor. Solid props are getters and MessageList
  // reads `items` in three places (its window memo, its stick-to-bottom tail
  // probe, and the load-earlier check), so an accessor would re-filter the
  // whole transcript three times for every streaming delta.
  const shownItems = createMemo(() => visibleItems(state.items, settings.chatDefaults.showSwayHooks));

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
    // What this harness last said it can run, so the picker has something true
    // before the handshake lands, and an ask when that answer is missing or
    // describes a binary that has since changed. Scoped to this harness: opening
    // a chat is already launching it, so asking costs nothing new, where a sweep
    // would spawn every other agent on the machine over a chat nobody opened.
    void refreshCatalogIfDue(props.agentId);

    // A rewound chat opens with the announcement already in the composer, so
    // the turn the user actually wanted is that plus their instruction rather
    // than a turn spent on the announcement alone. Only into an empty composer:
    // a remount must not overwrite what they have since typed.
    if (props.rewindTo && !draftFor(props.sessionId).trim()) {
      setDraft(props.sessionId, rewindSeed());
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
    void invoke<number>("chat_prompt_count", { sessionId: props.sessionId, agentId: props.agentId })
      .then(setPromptCount)
      .catch(() => {});

    // Live events arriving before the backfill has been folded in would render
    // this session's history *after* its newest turn. They are parked here
    // until the replay lands, then drained in arrival order.
    let backfilled = false;
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

    // Backfill from the transcript the harness itself wrote, which is the same
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
          for (const item of raw) {
            const ev = parseChatEvent(item);
            if (ev) applyEvent(s, ev);
          }
          // The transcript carries no turn boundaries, so without this the
          // last replayed turn stays "active" and the whole panel reads as
          // working on a turn that finished before the tab existed.
          settleBackfill(s);
        });
      })
      // History is an enhancement, not a precondition: a transcript that cannot
      // be read must not stop the live session from running.
      .catch(() => {})
      .finally(() => {
        // Draining and flipping the flag happen in **one synchronous block**.
        // Split across two microtasks, a channel message delivered between them
        // would be parked and then thrown away by the clear - and because the
        // drain went through `applyEvent` directly, a parked `turnStarted` would
        // also have skipped its checkpoint and its attribution entirely.
        const pending = parked.splice(0, parked.length);
        backfilled = true;
        for (const ev of pending) handleLive(ev);
        // A turn Sway still believed was open when it last went away. Read
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
                  "This turn was interrupted when Sway last closed. Its partial output is above; send again to continue.",
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
      edit((s) => applyEvent(s, ev));
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
      // Sway's own record of whether a turn is in flight. A killed app leaves
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
      // nothing Sway could see is exactly the case attribution must know about:
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

      void invoke<SpawnResult>("chat_spawn", {
        sessionId: props.sessionId,
        tabId: props.tabId,
        agentId: props.agentId,
        cwd: props.cwd,
        resume: opts.reconnect ? true : props.resume,
        // A reconnect is not a fork: the fork already happened, and asking for
        // one again would branch the session a second time.
        forkFrom: opts.reconnect ? null : (props.forkFrom ?? null),
        model: null,
        mode: null,
        effort: null,
        extraDirs: [],
        // Carried at spawn as well as reported by the effect below, because a
        // session restored into a background tab would otherwise stream at full
        // price until the first time somebody looked at it and looked away.
        visible: props.active,
        onEvent: channel,
      })
        .then((res) => {
          setOwnership(res.ownership);
          if (res.ownership.type === "granted" && res.ownership.contested) {
            emitWith<ToastEvent>(TOAST, { message: CONTESTED_NOTICE, kind: "error" });
          }
          // A session opened by "send to a new chat" carries its first turn. Sent
          // only once the claim came back granted: a refused claim has no child to
          // send to, and the seed stays in the composer for the user to decide.
          if (!opts.reconnect && res.ownership.type === "granted" && takeAutoSend(props.sessionId)) {
            onSend(draftFor(props.sessionId));
          }
        })
        .catch((e) => {
          edit((s) =>
            applyEvent(s, { type: "sessionError", sessionId: props.sessionId, message: String(e), fatal: true }),
          );
        });
    }

    reconnect = () => {
      // Cleared before the invoke, so the control stops offering a reconnect
      // that is already under way. A failed spawn drops it straight back to
      // disconnected through the catch above.
      edit((s) => beginReconnect(s));
      connect({ reconnect: true });
    };

    connect({ reconnect: false });
  });

  // A closed tab ends the child. `chat_close` is a no-op for a session that
  // already ended, so this is safe on every unmount path.
  onCleanup(() => {
    dropLiveChat(props.sessionId);
    // The composer's contents belong to the session that was showing them; a
    // reopened tab must not inherit an attachment nobody can see the origin of
    // any more, nor a draft written against a transcript that is gone.
    clearComposer(props.sessionId);
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
  createEffect(() => {
    if (refused()) {
      dropLiveChat(props.sessionId);
      return;
    }
    setLiveChat({
      sessionId: props.sessionId,
      sessionName: props.title,
      folderPath: props.workspace,
      tabId: props.tabId,
      status: chatStatus(state),
      visible: props.active,
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

  // What the harness behind this session actually supports, from the adapter's
  // declared transport. Every gate below asks this rather than asking whether
  // the code exists in this build: the code is here for every session, and a
  // second harness would otherwise inherit Claude's measurements by silence.
  const tier = () => chatTier(findAgent(props.agentId).chat?.transport);


  async function sendBlocks(blocks: ContentBlock[]) {
    edit((s) => pushUserTurn(s, blocks));
    try {
      await invoke("chat_send", { sessionId: props.sessionId, blocks });
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
        if (taken.length) void sendBlocks([{ type: "text", text: taken[0].text }]);
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
   * *this* harness reads stdin mid-turn. A harness that buffers to turn end
   * would take the write and deliver it as the next turn, which the user could
   * not tell apart from a steer that landed, so the declared tier decides and
   * anything short of `consumed-before-next-tool` queues instead.
   */
  const canSteer = () => steerable(state) && tier().steer === "consumed-before-next-tool";

  async function steer(text: string) {
    // Before the gate, not inside `write`: bailing after the gate has committed
    // would report "sent" for a message that was never composed.
    if (!text && !pendingFor(props.sessionId).length) return;
    const result = await sendWithProbeGate(text, {
      probe: async () => steerProbe(state),
      write: async (t) => {
        const attached = takePending(props.sessionId);
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
    restoreDraft(props.sessionId, text);
    if (result?.kind === "blocked") emitWith<ToastEvent>(TOAST, { message: BLOCKED_REASON, kind: "error" });
  }

  // Attachments ride the message that is actually sent, whether it opens a turn
  // or steers one. Only the pre-acknowledgement window still queues, and there
  // the chips stay put and visible: a queued message is sent later, and silently
  // emptying the composer now would leave the user unable to see what the next
  // turn is going to carry.
  function onSend(text: string) {
    // Recorded on the way out whichever path it takes, since from the user's
    // side all three are "I sent that".
    pushHistory(props.sessionId, text);
    // The ceiling, enforced where Sway actually decides: the turn boundary. The
    // message is queued rather than refused, so raising the limit sends what was
    // already typed instead of asking for it again - and it is *said*, because a
    // send that silently did nothing is the worst of the three outcomes.
    const held = stopped();
    if (held) {
      if (text) edit((s) => enqueue(s, text));
      if (!heldSaid()) {
        setHeldSaid(true);
        edit((s) => applyEvent(s, {
          type: "sessionError",
          sessionId: props.sessionId,
          message: heldNotice(held),
          fatal: false,
        }));
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
      if (text) edit((s) => enqueue(s, text));
      return;
    }
    const attached = takePending(props.sessionId);
    const blocks: ContentBlock[] = text ? [...attached, { type: "text", text }] : attached;
    if (!blocks.length) return;
    void sendBlocks(blocks);
  }

  function onAnswer(card: ToolItem, answer: Answer) {
    const approval = card.approval;
    if (!approval) return;
    // Cleared locally first: the card must stop reading as blocked the moment
    // the user answers, and the tool's real outcome still comes from
    // `toolCallCompleted`.
    edit((s) => resolveApproval(s, card.toolUseId));
    // The scope travels with the answer and is recorded by the harness, in the
    // harness's own grammar. Sway keeps no rule store of its own to update.
    void invoke("chat_respond_permission", {
      sessionId: props.sessionId,
      requestId: approval.requestId,
      toolUseId: card.toolUseId,
      decision: answer.decision,
      scope: answer.scope,
      reason: answer.reason,
    }).catch((e) => emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }));
  }

  /** What this chat has spent, in the three currencies a ceiling can name. */
  function spend(): Spend {
    const totals = spent();
    const usage = state.lastUsage;
    return {
      sessionUsd: totals?.session.costUsd ?? null,
      projectUsd: totals?.project.costUsd ?? null,
      // One resolver for both meters and for the ceiling, so a session cannot
      // be stopped against one denominator while the strip draws another.
      contextPercent: contextPercent(contextTokens(usage), shownModel()?.contextWindow ?? null),
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

  /** Arm or clear the stop, and warn once on the way up. */
  async function applyBudget() {
    // The tier still gates this, but on a different thing than it used to: not
    // "does this harness have a hook Sway can refuse a call from", which is no
    // longer how the ceiling works, but "are this chat's turns Sway's to open".
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
      edit((s) => applyEvent(s, {
        type: "sessionError",
        sessionId: props.sessionId,
        message: stopNotice(hit),
        fatal: false,
      }));
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
    edit((s) => applyEvent(s, {
      type: "sessionError",
      sessionId: props.sessionId,
      message: warnNotice(near, budgets),
      fatal: false,
    }));
  }

  function onSelectMode(mode: PermissionMode) {
    edit((s) => selectMode(s, mode));
    void invoke("chat_set_mode", { sessionId: props.sessionId, mode }).catch((e) => {
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
  // carries models at all; the harness names those.
  const chatConfig = () => findAgent(props.agentId).chat ?? null;
  // The last answer this harness gave anyone, which is what a picker has before
  // a session exists. Live wins the moment the handshake lands, so this is the
  // pre-session list and not a merge; see `pickableModels`.
  const cached = (): CatalogModel[] => cachedModels(catalogFor(props.agentId));
  const models = () => pickableModels(state.models, cached(), chatConfig(), state.contextWindows);

  // The entry the picker shows as selected. Resolved through the catalogue
  // rather than read straight off the store, because before the first pick the
  // only thing known is the *resolved* id the session reported, which is not a
  // `--model` value and would leave the control blank.
  //
  // Three sources, most specific first. The transcript's own model is the one
  // that matters on a resumed session: `state.model` is only set by a
  // `system/init` this tab saw, so a chat reopened on an existing session knew
  // nothing and fell back to naming the `default` alias - the pill read
  // "Default (recommended)" while the toolbar, reading the same transcript,
  // read "fable-5". Only when all three are silent is the catalogue's default
  // entry the honest answer: a session started without `--model` is running it
  // by definition.
  const shownModel = () =>
    selectedModel(models(), shownModelValue(state), state.model ?? detail()?.model ?? null) ??
    models().find((m) => m.value === "default") ??
    null;

  /**
   * The session's figures with the live ones overlaid on the scanned ones.
   *
   * `chat_session_detail` re-reads the transcript **file**, and it is triggered
   * by the same `turnCompleted` that the store folds in memory - but the CLI
   * has not necessarily flushed that turn to disk yet, so the scan comes back
   * describing the turn *before* the one that just landed. The store has no such
   * lag: `lastUsage` is the turn's own reported usage.
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
    const live = contextTokens(state.lastUsage);
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
  const stripWindow = () => {
    const ran = detail()?.model;
    if (ran) return contextWindowFor(ran, state.contextWindows);
    return shownModel()?.contextWindow ?? null;
  };

  // The mode the pill shows: the session's own, else the mode the *adapter*
  // nominates. Never the literal "default", which is Claude's spelling and
  // names nothing on a harness whose modes are `auto_edit|yolo`.
  const shownModeValue = () => shownMode(state, defaultMode(chatConfig())?.id ?? null);

  // What this model, on this harness, can actually be asked for. One resolver
  // feeds all three pills, so they cannot disagree about what is on offer.
  // One accessor for the modes on offer, beside `chatConfig` and for the same
  // reason: the selector and the model-switch guard must not each decide
  // separately whether the agent's list or the adapter's table is in charge.
  const liveModes = () => pickableModes(state.modes, chatConfig());
  const offered = () => capabilitiesFor(shownModel(), chatConfig(), liveModes());

  function onSelectModel(model: PickableModel) {
    edit((s) => selectModel(s, model));
    // Effort is sent with the model because that is how the command carries it:
    // a level the new model does not offer would be rejected, so it is dropped
    // rather than sent and blamed on the model switch.
    const effort = model.effortLevels.includes(shownEffort(state) ?? "") ? shownEffort(state) : null;
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

  function onSelectEffort(effort: string) {
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
    void invoke("chat_set_model", { sessionId: props.sessionId, model, effort }).catch((e) => {
      revert();
      emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
    });
  }

  // The project's file index, for `@` completion. Fetched on demand rather than
  // on mount: it is a full walk of the tree, and a chat that never mentions a
  // file should not pay for one. The composer asks once and caches.
  function loadProjectFiles(): Promise<string[]> {
    return invoke<string[]>("list_project_files", { projectPath: props.cwd }).catch(() => []);
  }

  // A completed `@` mention. The composer hands back the project-relative path
  // it showed; resolving it against the session's cwd happens here, so exactly
  // one place decides what a mention means.
  function onAttachFile(relPath: string) {
    offerToComposer(props.sessionId, fileMentionBlocks(`${props.cwd}/${relPath}`));
  }

  // A dragged path is a mention, not an upload: the agent has the filesystem, so
  // sending the bytes would be sending it something it can already read.
  function onAttachPaths(absPaths: string[]) {
    for (const path of absPaths) offerToComposer(props.sessionId, fileMentionBlocks(path));
  }

  function onAttachImages(images: { mediaType: string; base64: string }[]) {
    for (const img of images) offerToComposer(props.sessionId, imageBlocks(img.mediaType, img.base64));
  }

  // Move what is in the composer to a brand-new chat and let it open with that
  // turn. A send the user asked for, at a session that does not exist yet.
  function onSendToNewSession() {
    // Asked before the fork, not after: opening the tab first would leave an
    // empty chat behind (and a spawned child, and a claimed session id) on a
    // click that turns out to have nothing to send.
    if (!hasSomethingToSend(props.sessionId)) {
      emitWith<ToastEvent>(TOAST, { message: "Type something first, or attach a file.", kind: "info" });
      return;
    }
    seedForSend(props.sessionId, props.onForkSession());
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
    <div class={`${styles.chat} ${props.active ? styles.active : ""}`}>
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

      {/* Only when a limit is actually in force. Every captured
          `rate_limit_event` reports `allowed` and one fires per turn, so
          rendering on the event would mean a banner that is always up. */}
      <Show when={rateLimitMessage(state.rateLimit, Date.now())}>
        {(message) => (
          <div class={styles.banner}>
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
          what happened and offers the two real ways out. */}
      <Show when={!refused()}>
        <StatusStrip
          health={connectionHealth(state)}
          running={running()}
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
              <FastModeStatus state={state.fastModeState} reason={state.fastModeDisabledReason} />
              <SessionInfo
                mcpServers={state.mcpServers}
                skills={state.skills}
                agents={state.agents}
                plugins={state.plugins}
                account={state.account}
                capabilities={publishedCapabilities(tier(), state.capabilities)}
                cwd={props.cwd}
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
            items={shownItems()}
            live={state.started}
            sinceTs={firstTurnTs()}
          />
        }
      >
      <MessageList
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
        onAnswer={onAnswer}
        onSetMode={onSelectMode}
        onRevertHunk={onRevertHunk}
        // Gated on the declaration, not on the checkpoint alone: a harness that
        // cannot fork has no way to carry the conversation across, and offering
        // "rewind to here" there would promise the tree *and* the conversation
        // and deliver only the tree.
        rewindTsFor={(turnId) => (tier().rewind === "fork" ? turnStamps()[turnId] ?? null : null)}
        onRewind={onRewind}
      />
      </Show>

      <PlanCard items={state.plan} />

      <Composer
        running={running()}
        steering={canSteer()}
        steerCost={steerCostLabel(tier())}
        queue={state.queue}
        attachments={pendingFor(props.sessionId)}
        draft={draftFor(props.sessionId)}
        onDraftChange={(t) => setDraft(props.sessionId, t)}
        history={historyFor(props.sessionId)}
        commands={state.slashCommands}
        loadFiles={loadProjectFiles}
        held={state.queueHeld}
        disabled={refused() || state.ended}
        onSend={onSend}
        onAttachFile={onAttachFile}
        onAttachPaths={onAttachPaths}
        onAttachImages={onAttachImages}
        onAttachRejected={(reason) => emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" })}
        onInterrupt={onInterrupt}
        onDropQueued={(id) => edit((s) => removeQueued(s, id))}
        onDropAttachment={(id) => dropPending(props.sessionId, id)}
        onSendQueued={() => edit((s) => releaseQueue(s))}
        onDiscardQueued={() => edit((s) => discardQueue(s))}
        // Everything the next turn will run under: the mode, the model and its
        // effort. All the switches land at the same next-turn boundary, so
        // they sit together in the bar under the input.
        controls={
          <>
            {/* Model, then its thinking level, then the mode. The order is the
                dependency: the effort levels on offer are a property of the
                selected model, so the control that decides them comes first,
                and the mode - which no model constrains - sits at the end. */}
            <ModelPicker
              models={models()}
              value={shownModel()?.value ?? null}
              agentId={props.agentId}
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
              disabled={refused() || state.ended}
              onSelect={onSelectMode}
            />
          </>
        }
      />

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
