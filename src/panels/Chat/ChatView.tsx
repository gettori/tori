import { Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Channel, invoke } from "@tauri-apps/api/core";
import MessageList from "./MessageList";
import Composer from "./Composer";
import ModeSelector, { MODES } from "./ModeSelector";
import ModelPicker from "./ModelPicker";
import FastModeStatus from "./FastModeStatus";
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
import { parseChatEvent, type ContentBlock, type PermissionMode } from "../../utils/chatTypes";
import { dropLiveChat, chatsInFolder, setLiveChat } from "../../utils/chatSessions";
import {
  contextTokens,
  pickableModels,
  restoredPicks,
  selectedModel,
  type PickableModel,
} from "../../utils/chatModels";
import { findAgent } from "../../utils/agents";
import { chatPrefs, rememberChatPrefs } from "../Settings/settingsStore";
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
  effortPending,
  filesWritten,
  initialChat,
  isRunning,
  modePending,
  modelPending,
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
  shownEffort,
  shownMode,
  shownModelValue,
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
   *  session id can never collide with the one that is already held. Returns
   *  the new session's id, so this one can seed it. */
  onForkSession: () => string;
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
        // A session opened by "send to a new chat" carries its first turn. Sent
        // only once the claim came back granted: a refused claim has no child to
        // send to, and the seed stays in the composer for the user to decide.
        if (res.ownership.type === "granted" && takeAutoSend(props.sessionId)) {
          onSend(draftFor(props.sessionId));
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

  function onSelectMode(mode: PermissionMode, remember = true) {
    edit((s) => selectMode(s, mode));
    if (remember) rememberChatPrefs(props.cwd, { mode });
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

  // `remember` is false when the pick is a replay of what is already stored:
  // writing it back would rewrite settings.json, fire the watcher and re-apply
  // the theme on every chat open, for data that did not change.
  function onSelectModel(model: PickableModel, remember = true) {
    edit((s) => selectModel(s, model));
    // Effort is sent with the model because that is how the command carries it:
    // a level the new model does not offer would be rejected, so it is dropped
    // rather than sent and blamed on the model switch.
    const effort = model.effortLevels.includes(shownEffort(state) ?? "") ? shownEffort(state) : null;
    if (remember) rememberChatPrefs(props.cwd, { model: model.value, effort });
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
    rememberChatPrefs(props.cwd, { model: value, effort });
    applyModelChange(value, effort, () => edit((s) => revertEffortPick(s, effort)));
  }

  // Restore this project's last combination, once the session has reported the
  // catalogue a stored value can be checked against. Applied as a real pick
  // rather than written straight into the store, so it goes through the same
  // next-turn boundary and the same failure handling as a click.
  let restored = false;
  createEffect(() => {
    if (restored || !state.started) return;
    // Latched only once there is something to check against. Marking it done on
    // an empty catalogue would burn the one attempt: with no handshake, the
    // adapter table arrives from `list_agents` a moment later, and the restore
    // has to still be waiting for it.
    const offered = models();
    if (offered.length === 0) return;
    restored = true;
    const prefs = chatPrefs(props.cwd);
    const { model, effort } = restoredPicks(offered, prefs);
    if (model) {
      // Staged before the model pick so the one request carries both, rather
      // than sending a model and then immediately re-sending it with a level.
      if (effort) edit((s) => selectEffort(s, effort));
      onSelectModel(model, false);
    }
    // Mode is Phase 6's control; this only replays the remembered pick through
    // it rather than introducing a second way to set one.
    const mode = MODES.find((m) => m.value === prefs.mode);
    if (mode && mode.value !== state.permissionMode) onSelectMode(mode.value, false);
  });

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

      {/* Everything the next turn will run under: the mode, the model and its
          effort, and the permissions already granted. All three switches land
          at the same next-turn boundary, so they say so in the same words. */}
      <div class={styles.controls}>
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
        <FastModeStatus state={state.fastModeState} reason={state.fastModeDisabledReason} />
        <RuleList rules={rules()} onRemove={onRemoveRule} />
        <Button
          size="sm"
          title="Open a new chat and send what is in the composer to it"
          disabled={refused()}
          onClick={onSendToNewSession}
        >
          Send to a new chat
        </Button>
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
