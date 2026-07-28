import { Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Channel, invoke } from "@tauri-apps/api/core";
import MessageList from "./MessageList";
import Composer from "./Composer";
import ModeSelector from "./ModeSelector";
import RuleList from "./RuleList";
import type { Answer } from "./PermissionPrompt";
import type { HunkRef } from "./ToolCallCard";
import Button from "../../components/Button/Button";
import ConfirmDialog, { type ConfirmOpts, type ConfirmReq } from "../../components/Dialogs/ConfirmDialog";
import { clearPending, dropPending, pendingFor, takePending } from "../../utils/chatCompose";
import { folderActors } from "../../utils/folderActors";
import { hunkRevertPermission } from "../../utils/hunkRevert";
import { parseChatEvent, type ContentBlock, type PermissionMode } from "../../utils/chatTypes";
import { dropLiveChat, chatsInFolder, setLiveChat } from "../../utils/chatSessions";
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
  chatStatus,
  clearAwaitingTurn,
  discardQueue,
  enqueue,
  filesWritten,
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
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);

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
      if (!ev) return;
      edit((s) => applyEvent(s, ev));
      // The session says which files it wrote, so the gutter and the Changes
      // panel do not have to wait for the watcher to notice. The watcher's own
      // event still arrives; both consumers are idempotent.
      const written = filesWritten(ev);
      if (written.length) emitWith<AgentFilesWritten>(AGENT_FILES_WRITTEN, { paths: [...written] });
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
    // Chips belong to the composer that was showing them; a reopened tab must
    // not inherit an attachment nobody can see the origin of any more.
    clearPending(props.sessionId);
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

      <MessageList
        items={state.items}
        streaming={running()}
        sessionId={props.sessionId}
        cwd={props.cwd}
        onAnswer={onAnswer}
        onRevertHunk={onRevertHunk}
      />

      <Composer
        running={running()}
        queue={state.queue}
        attachments={pendingFor(props.sessionId)}
        held={state.queueHeld}
        disabled={refused() || state.ended}
        onSend={onSend}
        onInterrupt={onInterrupt}
        onDropQueued={(id) => edit((s) => removeQueued(s, id))}
        onDropAttachment={(id) => dropPending(props.sessionId, id)}
        onSendQueued={() => edit((s) => releaseQueue(s))}
        onDiscardQueued={() => edit((s) => discardQueue(s))}
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
