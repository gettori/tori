// A chat tab before it has a session: the composer, its controls, and nothing
// behind them.
//
// This is the whole of the draft state. No child process is spawned, no session
// id is minted, no claim is taken and nothing is registered as live, so a tab
// opened and never used costs a tab record and this component. The first send is
// what turns it into a chat: the message is held, the tab record is replaced
// with the session id it minted, and `ChatView` mounts in its place and sends
// the held message once the transport can take a turn.
//
// Kept apart from `ChatView` rather than folded in as a null-session mode: forty
// of that component's call sites are only meaningful with a session id, and
// making them all narrow a nullable one would trade a small duplicate shell for
// a large permanent lie. What the two genuinely share - what an `@` mention
// means, and the model palette - is shared as code, not by living together.
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import Composer from "./Composer";
import ModelPicker from "./ModelPicker";
import ModeSelector from "./ModeSelector";
import { composerAttachments } from "./composerAttachments";
import { paletteProviders } from "./agentPaletteData";
import { probeAgent, probeOnHighlight } from "./draftProbe";
import { dropPending, draftFor, historyFor, markAutoSend, pendingFor, setDraft } from "../../utils/chatCompose";
import { draftPick, hasPick, resetDraftPick, setDraftPick } from "../../utils/chatDraftPick";
import { openAgentCard } from "../../utils/agentCard";
import { agentReady, agentSignedOut, ensureAgentHealthLoaded } from "../../utils/agentHealth";
import { agents, ensureAdaptersLoaded, findAdapter } from "../../utils/agents";
import { capabilitiesFor, restoredPicks, type PickableModel } from "../../utils/chatModels";
import { ensureModelCatalogsLoaded, isProbing, modelCatalogs } from "../../utils/modelCatalog";
import { chatPrefs } from "../Settings/settingsStore";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import styles from "./Chat.module.css";

export default function ChatDraft(props: {
  /** This tab, which is also the composer's key: a draft has no session id to
   *  file what was typed under, and minting one per send attempt is what keeps a
   *  reverted attempt's id from ever being reused. */
  tabId: string;
  cwd: string;
  /** The project this draft belongs to, which is what its remembered picks are
   *  filed under. The branch-unit folder rather than `cwd`, so every tab in a
   *  workspace agrees on the answer. */
  workspace: string;
  active: boolean;
  /** The agent this draft would start. Lives on the tab record rather than here,
   *  so the tab bar and the palette cannot disagree about it. */
  agentId: string;
  /** Why the last first-send attempt did not reach a session. Rendered above the
   *  composer, because it is the thing that decides what the user does next. */
  error?: string;
  /** Point the draft at a different agent. */
  onSelectAgent: (agentId: string) => void;
  /** Mint a session and spawn it. The held message rides along on the other
   *  side, so this takes nothing and returns nothing. */
  onStart: () => void;
}) {
  // Set the moment a send is accepted and never cleared: this surface is on its
  // way out, and the only thing left to stop is a second Enter landing in the
  // window before the swap has drawn.
  const [starting, setStarting] = createSignal(false);
  const attachments = composerAttachments(
    () => props.tabId,
    () => props.cwd,
  );

  onMount(() => {
    ensureAdaptersLoaded();
    ensureAgentHealthLoaded();
    // The cache, then one probe for the agent this draft would actually start.
    // Opening a chat on claude is already going to launch claude, so asking it
    // costs nothing new; asking every other agent on the machine would.
    void ensureModelCatalogsLoaded().then(() => probeAgent(props.agentId));
  });
  onCleanup(() => probeOnHighlight.cancel());

  const providers = createMemo(() =>
    paletteProviders({
      adapters: agents(),
      catalogs: modelCatalogs(),
      ready: agentReady,
      signedOut: agentSignedOut,
      probing: isProbing,
    }),
  );
  const mine = () => providers().find((p) => p.agentId === props.agentId) ?? null;
  const models = () => mine()?.models ?? [];
  const pick = () => draftPick(props.tabId);

  const model = () => models().find((m) => m.value === pick().model) ?? null;
  const offered = () => capabilitiesFor(model(), findAdapter(props.agentId).chat ?? null);

  /**
   * Open on this project's last-used pick, once there is a catalogue to check
   * it against.
   *
   * Checked rather than trusted: a stored value the agent no longer offers is
   * dropped by `restoredPicks`, so the pill never shows a row a send would be
   * refused for. Nothing is filed by agent here - the catalogue is the filter,
   * and a pick that survives it is one this agent really does take.
   *
   * Runs once per draft, guarded on the pick being empty: a user who has chosen
   * something (including by switching agents, which sets a model) has answered
   * this question already.
   */
  createEffect(() => {
    if (!models().length || hasPick(untrack(() => draftPick(props.tabId)))) return;
    const chat = findAdapter(props.agentId).chat ?? null;
    const restored = restoredPicks(models(), chatPrefs(props.workspace), chat);
    if (!restored.model) return;
    setDraftPick(props.tabId, {
      model: restored.model.value,
      effort: restored.effort,
      mode: restored.mode,
    });
  });

  /** Why this draft cannot be sent, or null. The agent stays selected either
   *  way: a draft that silently switched away from a broken agent would be Sway
   *  choosing for the user, and the pill is where the problem is legible. */
  const blocked = () => {
    const health = mine()?.health;
    if (!health || health.kind !== "fix") return null;
    return `${findAdapter(props.agentId).label}: ${health.reason.toLowerCase()}`;
  };

  function onPickModel(agentId: string, picked: PickableModel) {
    if (agentId !== props.agentId) {
      // Mode and effort name things the *old* agent published, so they go with
      // it rather than being carried onto flags the new one never declared.
      resetDraftPick(props.tabId, picked.value);
      props.onSelectAgent(agentId);
      return;
    }
    setDraftPick(props.tabId, { model: picked.value });
  }

  function onSend(text: string) {
    if (starting() || blocked() !== null) return;
    const trimmed = text.trim();
    // Attachment-only is a valid thing to send, so the chips count too. Nothing
    // at all is not: an empty send would cost a process and a session id.
    if (!trimmed && !pendingFor(props.tabId).length) return;
    setStarting(true);
    markAutoSend(props.tabId, trimmed);
    // After the composer has finished its own submit - it clears the input right
    // after this returns - so replacing the tab record cannot race a write to a
    // surface that is already gone.
    queueMicrotask(() => props.onStart());
  }

  return (
    <div class={`${styles.chat} ${props.active ? styles.active : ""}`}>
      <Show when={props.error}>
        {(message) => (
          <div class={styles.banner}>
            <span class={styles.bannerText}>{message()}</span>
          </div>
        )}
      </Show>

      {/* Where the transcript will be. Empty rather than explained: a chat that
          has not started has nothing to say about itself, and a placeholder
          would be chrome the user reads once and then reads past forever. */}
      <div class={styles.draftFill} />

      <Composer
        running={false}
        steering={false}
        steerCost={null}
        queue={[]}
        attachments={pendingFor(props.tabId)}
        draft={draftFor(props.tabId)}
        onDraftChange={(t) => setDraft(props.tabId, t)}
        history={historyFor(props.tabId)}
        // Empty on purpose: an agent's commands come from its handshake, and no
        // agent has been asked anything yet. Offering a stale set from the last
        // one would promise commands this chat may not have.
        commands={[]}
        held={false}
        disabled={starting() || blocked() !== null}
        loadFiles={attachments.loadProjectFiles}
        onSend={onSend}
        onAttachFile={attachments.onAttachFile}
        onAttachPaths={attachments.onAttachPaths}
        onAttachImages={attachments.onAttachImages}
        onAttachRejected={(reason) => emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" })}
        onDropAttachment={(id) => dropPending(props.tabId, id)}
        // A draft has no turn to interrupt and no queue to hold one: all three
        // are reachable only once something is running.
        onInterrupt={() => {}}
        onDropQueued={() => {}}
        onSendQueued={() => {}}
        onDiscardQueued={() => {}}
        controls={
          <>
            <ModelPicker
              models={models()}
              providers={providers()}
              value={pick().model}
              agentId={props.agentId}
              effort={pick().effort}
              // Nothing is in flight before there is a session, so no pick is
              // ever waiting on a turn boundary here.
              modelPending={false}
              effortPending={false}
              disabled={starting()}
              onSelectModel={onPickModel}
              onSelectEffort={(effort) => setDraftPick(props.tabId, { effort })}
              onHighlightAgent={(agentId) => probeOnHighlight(agentId)}
              onFixAgent={openAgentCard}
            />
            <Show when={offered().modes.length > 0}>
              <ModeSelector
                mode={pick().mode}
                modes={offered().modes}
                pending={false}
                disabled={starting()}
                onSelect={(mode) => setDraftPick(props.tabId, { mode })}
              />
            </Show>
            <Show when={blocked()}>
              {(reason) => <span class={styles.barNote}>{reason()}</span>}
            </Show>
          </>
        }
      />
    </div>
  );
}
