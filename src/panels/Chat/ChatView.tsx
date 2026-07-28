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
import ModeSelector, { BYPASS_STILL_APPROVED } from "./ModeSelector";
import ModelPicker from "./ModelPicker";
import FastModeStatus from "./FastModeStatus";
import { fmtTokens, usageSummary } from "../../utils/chatUsage";
import { rateLimitMessage } from "../../utils/chatRateLimit";
import RuleList from "./RuleList";
import type { Answer } from "./PermissionPrompt";
import type { HunkRef } from "./ToolCallCard";
import Button from "../../components/Button/Button";
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
  seedForSend,
  pushHistory,
  setDraft,
  takeAutoSend,
  takePending,
} from "../../utils/chatCompose";
import { folderActors } from "../../utils/folderActors";
import { hunkRevertPermission } from "../../utils/hunkRevert";
import { parseChatEvent, type ChatEvent, type ContentBlock, type PermissionMode } from "../../utils/chatTypes";
import { dropLiveChat, chatsInFolder, setLiveChat } from "../../utils/chatSessions";
import { checkpointChatTurn } from "../../utils/checkpoints";
import {
  contextTokens,
  pickableModels,
  selectedModel,
  type PickableModel,
} from "../../utils/chatModels";
import { findAgent } from "../../utils/agents";
import { settings } from "../Settings/settingsStore";
import { markNoticed, noticed, shouldNotice, MULTI_CHAT_NOTICE } from "../../utils/chatConcurrency";
import {
  emitWith,
  AGENT_FILES_WRITTEN,
  FOCUS_SESSION_TAB,
  TOAST,
  type AgentFilesWritten,
  type FocusSessionTab,
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
  shownEffort,
  turnModel,
  shownMode,
  shownModelValue,
  takeForSend,
  visibleItems,
  type ChatState,
  type QueuedInput,
  type ToolItem,
} from "./chatStore";
import { noteRulesChanged, rulesRevision, type ScopedRule } from "../../utils/chatRules";
import {
  refusalMessage,
  refusalOf,
  CONTESTED_NOTICE,
  type ClaimOutcome,
} from "../../utils/chatOwnership";
import styles from "./Chat.module.css";

/** `SpawnResult` from `chat/commands.rs`. A refusal is a normal answer, not an
 *  error: it names the tab that holds the session, or the orphaned child. */
type SpawnResult = { ownership: ClaimOutcome; spawned: "started" | "rewired" | null };

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
}) {
  const [state, setState] = createStore<ChatState>(initialChat(props.sessionId));
  const [ownership, setOwnership] = createSignal<ClaimOutcome | null>(null);
  const [rules, setRules] = createSignal<ScopedRule[]>([]);
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
  const messageCount = createMemo(() =>
    state.items.reduce((n, it) => n + (it.kind === "user" || it.kind === "text" ? 1 : 0), 0),
  );
  // Null until a turn completed: a zero would be a claim (see UsageReadout).
  const sessionTokens = () => {
    const summary = usageSummary(state);
    return summary.turn ? fmtTokens(summary.session.tokens) : null;
  };
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
        turnTs = Math.floor(Date.now() / 1000);
        if (firstTurnTs() === null) setFirstTurnTs(turnTs);
        // No tool call outlives the turn that opened it, so anything still in
        // here is spent. Cleared per turn rather than never, which would grow
        // the map for as long as the panel is open.
        toolNames.clear();
        void checkpointChatTurn(props.sessionId, props.cwd, turnTs);
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

  // The second chat on a worktree: say once, per worktree, that the two share
  // one working tree and that checkpoint attribution suffers for it.
  const multiChatNotice = () => shouldNotice(chatsInFolder(props.workspace).length, props.workspace, noticed());

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

  // Attachments ride the turn that is actually sent. While a turn runs the typed
  // text queues but the chips stay put and visible, because a queued message is
  // sent later and silently emptying the composer of its attachments now would
  // leave the user unable to see what the next turn is going to carry.
  function onSend(text: string) {
    // Recorded on the way out whichever path it takes, since from the user's
    // side both are "I sent that".
    pushHistory(props.sessionId, text);
    if (running()) {
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

  // Re-read rather than patched locally: the rule store is a file the hook
  // helper reads on every tool call, and a list maintained here would be a
  // second opinion about what is in force.
  //
  // Keyed on the shared revision, not on this panel's own edits: a project rule
  // is shared by every chat open on the folder, so one granted next door changes
  // what this chat will do without asking. One file read per rule change across
  // all chats, which is nothing next to a tool call.
  createEffect(() => {
    rulesRevision();
    void invoke<ScopedRule[]>("chat_list_rules", { sessionId: props.sessionId, cwd: props.cwd })
      .then(setRules)
      .catch(() => setRules([]));
  });

  function onAnswer(card: ToolItem, answer: Answer) {
    const approval = card.approval;
    if (!approval) return;
    // Cleared locally first: the card must stop reading as blocked the moment
    // the user answers, and the tool's real outcome still comes from
    // `toolCallCompleted`.
    edit((s) => resolveApproval(s, card.toolUseId));
    void invoke("chat_respond_permission", {
      sessionId: props.sessionId,
      cwd: props.cwd,
      requestId: approval.requestId,
      toolName: card.name ?? "",
      toolInput: card.input ?? {},
      decision: answer.decision,
      scope: answer.scope,
      reason: answer.reason,
    })
      .then(() => {
        if (answer.scope !== "once") noteRulesChanged();
      })
      .catch((e) => emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }));
  }

  function onRemoveRule(rule: ScopedRule) {
    void invoke("chat_remove_rule", {
      sessionId: props.sessionId,
      cwd: props.cwd,
      tool: rule.tool,
      prefix: rule.prefix,
    })
      .then(noteRulesChanged)
      .catch((e) => emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }));
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
  // gave us one, the adapter's table when it did not. `pickableModels` owns
  // that choice so the picker, the effort control and the meter cannot each
  // decide it differently.
  const models = () => pickableModels(state.models, findAgent(props.agentId).chat ?? null);

  // The entry the picker shows as selected. Resolved through the catalogue
  // rather than read straight off the store, because before the first pick the
  // only thing known is the *resolved* id the session reported, which is not a
  // `--model` value and would leave the control blank.
  const shownModel = () => selectedModel(models(), shownModelValue(state), state.model);

  function onSelectModel(model: PickableModel) {
    edit((s) => selectModel(s, model));
    // Effort is sent with the model because that is how the command carries it:
    // a level the new model does not offer would be rejected, so it is dropped
    // rather than sent and blamed on the model switch.
    const effort = model.effortLevels.includes(shownEffort(state) ?? "") ? shownEffort(state) : null;
    applyModelChange(model.value, effort, () => edit((s) => revertModelPick(s, model.value)));
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
      <Show when={multiChatNotice()}>
        <div class={styles.banner}>
          <span class={styles.bannerText}>{MULTI_CHAT_NOTICE}</span>
          <Button size="sm" onClick={() => markNoticed(props.workspace)}>
            Got it
          </Button>
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
          tokens={sessionTokens()}
          messages={messageCount()}
          onReconnect={() => reconnect?.()}
          menu={
            <div class={styles.menuBody}>
              <div class={styles.menuActions}>
                <Button
                  size="sm"
                  title={
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
                  title="Open a new chat and send what is in the composer to it"
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
                    title="Branch this conversation into a new session, keeping everything up to here"
                    onClick={() => props.onForkFrom()}
                  >
                    Fork this chat
                  </Button>
                </Show>
              </div>
              <UsageReadout summary={usageSummary(state)} />
              <FastModeStatus state={state.fastModeState} reason={state.fastModeDisabledReason} />
              <RuleList rules={rules()} onRemove={onRemoveRule} />
              <SessionInfo
                mcpServers={state.mcpServers}
                skills={state.skills}
                agents={state.agents}
                plugins={state.plugins}
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
        onRevertHunk={onRevertHunk}
      />
      </Show>

      <PlanCard items={state.plan} />

      <Composer
        running={running()}
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
            <ModeSelector
              mode={shownMode(state)}
              pending={modePending(state)}
              disabled={refused() || state.ended}
              onSelect={onSelectMode}
            />
            <ModelPicker
              models={models()}
              value={shownModel()?.value ?? null}
              effort={shownEffort(state)}
              contextTokens={contextTokens(state.lastUsage)}
              modelPending={modelPending(state)}
              effortPending={effortPending(state)}
              disabled={refused() || state.ended}
              onSelectModel={onSelectModel}
              onSelectEffort={onSelectEffort}
            />
          </>
        }
        // Bypass names itself after something Sway does not actually let it do,
        // so the guard stays a visible line rather than a tooltip.
        notice={
          <Show when={shownMode(state) === "bypassPermissions"}>
            <div class={styles.composerNotice}>{BYPASS_STILL_APPROVED}</div>
          </Show>
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
