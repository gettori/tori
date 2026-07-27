import { Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Channel, invoke } from "@tauri-apps/api/core";
import MessageList from "./MessageList";
import Composer from "./Composer";
import ModeSelector from "./ModeSelector";
import RuleList from "./RuleList";
import type { Answer } from "./PermissionPrompt";
import Button from "../../components/Button/Button";
import { parseChatEvent, type ContentBlock, type PermissionMode } from "../../utils/chatTypes";
import { dropLiveChat, chatsInFolder, setLiveChat } from "../../utils/chatSessions";
import { markNoticed, noticed, shouldNotice, MULTI_CHAT_NOTICE } from "../../utils/chatConcurrency";
import { emitWith, FOCUS_SESSION_TAB, TOAST, type FocusSessionTab, type ToastEvent } from "../../utils/events";
import {
  applyEvent,
  chatStatus,
  clearAwaitingTurn,
  discardQueue,
  enqueue,
  initialChat,
  isRunning,
  modePending,
  pendingFlush,
  pushUserTurn,
  releaseQueue,
  removeQueued,
  resolveApproval,
  selectMode,
  shownMode,
  takeForSend,
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
  active: boolean;
  /** Open a fresh chat beside this one, the way out of every refusal: a new
   *  session id can never collide with the one that is already held. */
  onForkSession: () => void;
}) {
  const [state, setState] = createStore<ChatState>(initialChat(props.sessionId));
  const [ownership, setOwnership] = createSignal<ClaimOutcome | null>(null);
  const [rules, setRules] = createSignal<ScopedRule[]>([]);

  const edit = (fn: (s: ChatState) => void) => setState(produce(fn));
  const running = () => isRunning(state);
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

  onMount(() => {
    const channel = new Channel<unknown>();
    channel.onmessage = (raw) => {
      const ev = parseChatEvent(raw);
      // An unrecognised frame is dropped, never thrown: a panel must not go
      // down mid-turn over a frame it did not expect.
      if (ev) edit((s) => applyEvent(s, ev));
    };
    void invoke<SpawnResult>("chat_spawn", {
      sessionId: props.sessionId,
      tabId: props.tabId,
      agentId: props.agentId,
      cwd: props.cwd,
      resume: props.resume,
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
      })
      .catch((e) => {
        edit((s) =>
          applyEvent(s, { type: "sessionError", sessionId: props.sessionId, message: String(e), fatal: true }),
        );
      });
  });

  // A closed tab ends the child. `chat_close` is a no-op for a session that
  // already ended, so this is safe on every unmount path.
  onCleanup(() => {
    dropLiveChat(props.sessionId);
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

  function onSend(text: string) {
    if (running()) {
      edit((s) => enqueue(s, text));
      return;
    }
    void sendBlocks([{ type: "text", text }]);
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

      {/* The session's standing permissions, above the transcript: the mode it
          will run the next turn in, and everything it may already do without
          asking. Phase 9 adds the model and effort pickers to this row. */}
      <div class={styles.controls}>
        <ModeSelector
          mode={shownMode(state)}
          pending={modePending(state)}
          disabled={refused() || state.ended}
          onSelect={onSelectMode}
        />
        <RuleList rules={rules()} onRemove={onRemoveRule} />
      </div>

      <MessageList items={state.items} streaming={running()} onAnswer={onAnswer} />

      <Composer
        running={running()}
        queue={state.queue}
        held={state.queueHeld}
        disabled={refused() || state.ended}
        onSend={onSend}
        onInterrupt={onInterrupt}
        onDropQueued={(id) => edit((s) => removeQueued(s, id))}
        onSendQueued={() => edit((s) => releaseQueue(s))}
        onDiscardQueued={() => edit((s) => discardQueue(s))}
      />
    </div>
  );
}
