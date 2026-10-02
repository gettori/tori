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
import ConfigMirror from "./ConfigMirror";
import FollowToggle from "./FollowToggle";
import ModelPicker from "./ModelPicker";
import ModeSelector from "./ModeSelector";
import { composerAttachments } from "./composerAttachments";
import { attachmentSources, chatTier } from "../../utils/chatCapabilities";
import { paletteProviders } from "./agentPaletteData";
import { probeAgent, probeOnHighlight, recheckAgent } from "./draftProbe";
import { dropPending, draftFor, draftOriginFor, historyFor, markAutoSend, pendingFor, setDraft } from "../../utils/chatCompose";
import { invoke } from "@tauri-apps/api/core";
import { draftPick, hasPick, resetDraftPick, setDraftOption, setDraftPick } from "../../utils/chatDraftPick";
import { openAgentCard } from "../../utils/agentCard";
import {
  agentReady,
  agentVersion,
  ensureAgentHealthLoaded,
  namedProfiles,
  profileLabel,
  profileSignedOut,
} from "../../utils/agentHealth";
import { ensureAdaptersLoaded, findAdapter } from "../../utils/agents";
import { agentOffReason, enabledChatAgents } from "../../utils/agentEnabled";
import { agentRefusal } from "../../utils/projectAgents";
import {
  cachedModes,
  capabilitiesFor,
  modeAfterModelSwitch,
  restoredPicks,
  type PickableModel,
} from "../../utils/chatModels";
import { keptOptionValues, overlaidOptions } from "../../utils/chatTypes";
import {
  cachedCommands,
  cachedOptions,
  catalogFor,
  ensureModelCatalogsLoaded,
  isProbing,
  modelCatalogs,
} from "../../utils/modelCatalog";
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
  /** Which account of `agentId` it would start on; `null` is the default
   *  profile. The send gate is per account: a draft on Globex must not be
   *  refused because the personal login expired. */
  profile: string | null;
  /** Why the last first-send attempt did not reach a session. Rendered above the
   *  composer, because it is the thing that decides what the user does next. */
  error?: string;
  /** Point the draft at a different agent, or at a different account of the
   *  one it is on. Both together: a model belongs to an account, so picking one
   *  row cannot leave the tab naming the other row's account. */
  onSelectAgent: (agentId: string, profile: string | null) => void;
  /** Mint a session and spawn it. The held message rides along on the other
   *  side, so this takes nothing and returns nothing. */
  onStart: () => void;
}) {
  // Set the moment a send is accepted and never cleared: this surface is on its
  // way out, and the only thing left to stop is a second Enter landing in the
  // window before the swap has drawn.
  const [starting, setStarting] = createSignal(false);
  const tier = () => chatTier(findAdapter(props.agentId).chat?.transport);
  const attachments = composerAttachments(
    () => props.tabId,
    () => props.cwd,
    tier,
    () => catalogFor(props.agentId, props.profile)?.catalogue?.capabilities,
    (reason) => emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" }),
  );

  onMount(() => {
    ensureAdaptersLoaded();
    ensureAgentHealthLoaded();
    // The cache, then one probe for the agent this draft would actually start.
    // Opening a chat on claude is already going to launch claude, so asking it
    // costs nothing new; asking every other agent on the machine would.
    void ensureModelCatalogsLoaded().then(() => probeAgent(props.agentId, props.profile));
  });
  onCleanup(() => probeOnHighlight.cancel());

  const providers = createMemo(() =>
    paletteProviders({
      // The agents this install offers, not every one the registry ships. The
      // palette is a list of things the user can start, so an agent they turned
      // off is absent rather than listed and refused.
      adapters: enabledChatAgents(),
      catalogs: modelCatalogs(),
      // One row per account, so every row describes the account it would
      // actually start on rather than borrowing this draft's.
      profilesFor: namedProfiles,
      ready: agentReady,
      signedOut: profileSignedOut,
      probing: isProbing,
      allowed: (id, profile) => !agentRefusal(props.cwd, id, profile),
      version: agentVersion,
    }),
  );
  const mine = () =>
    providers().find((p) => p.agentId === props.agentId && p.profile === props.profile) ?? null;
  const models = () => mine()?.models ?? [];
  const pick = () => draftPick(props.tabId);
  // The palette drops the options on its way to `PickableModel`, so the mirror
  // reads the catalogue itself. Keyed on the pick because claude's levers are a
  // function of the model, which is why switching model re-cuts the set.
  const catalog = () => catalogFor(props.agentId, props.profile);
  const options = () => cachedOptions(catalog(), pick().model);

  const model = () => models().find((m) => m.value === pick().model) ?? null;
  const chatConfig = () => findAdapter(props.agentId).chat ?? null;
  // One accessor for the agent's own modes, beside `chatConfig` and for the same
  // reason: the selector, the restore and the model-switch guard must not each
  // decide separately whether the agent's list or the adapter's table is in
  // charge. `ChatView` splits the same question the same way.
  const agentModes = () => cachedModes(catalog(), chatConfig());
  const offered = () => capabilitiesFor(model(), chatConfig(), agentModes().modes);
  // What the pill says, on `ChatView`'s rule: the pick, else the mode a session
  // opened now would be in. A display fallback rather than a pick, so a draft
  // nobody touched sends nothing and holds its first message on nothing.
  const shownMode = () => pick().mode ?? agentModes().current;

  /**
   * Open on this project's last-used pick, once there is a catalogue to check
   * it against.
   *
   * Checked rather than trusted: a stored value the agent no longer offers is
   * dropped by `restoredPicks`, so the pill never shows a row a send would be
   * refused for. Nothing is filed by agent here - the catalogue is the filter,
   * and a pick that survives it is one this agent really does take.
   *
   * With nothing remembered, or nothing remembered that survives the check, it
   * opens on the agent's own first row instead of on no model at all. That row
   * is the agent's default - claude publishes it under the name - so naming it
   * sends what the CLI would have run anyway, and the pill and the effort
   * control get something to describe rather than standing there saying
   * "Default" about a model nothing has picked.
   *
   * Runs once per draft, guarded on the pick being empty: a user who has chosen
   * something (including by switching agents, which sets a model) has answered
   * this question already.
   */
  createEffect(() => {
    if (!models().length || hasPick(untrack(() => draftPick(props.tabId)))) return;
    const restored = restoredPicks(
      models(),
      chatPrefs(props.workspace),
      chatConfig(),
      agentModes().modes,
    );
    const model = restored.model ?? models()[0];
    if (!model) return;
    setDraftPick(props.tabId, {
      model: model.value,
      effort: restored.effort,
      mode: restored.mode,
    });
  });

  /** Drop picked values this catalogue no longer recognises, the check
   *  `restoredPicks` makes for a remembered model. Guarded on a catalogue
   *  existing: an unprobed agent publishes none, which is not a withdrawal. */
  createEffect(() => {
    if (!catalog()?.catalogue) return;
    const values = untrack(() => draftPick(props.tabId)).optionValues;
    const kept = keptOptionValues(options(), values);
    if (Object.keys(kept).length !== Object.keys(values).length) {
      setDraftPick(props.tabId, { optionValues: kept });
    }
  });

  /** Why this draft cannot be sent, or null. The agent stays selected either
   *  way: a draft that silently switched away from a broken agent would be Tori
   *  choosing for the user, and the pill is where the problem is legible. */
  const blocked = () => {
    // The tab can outlive the setting: a draft left open while its agent was
    // turned off in another window still names it, and sending would start
    // something the user has said they do not want offered.
    const off = agentOffReason(props.agentId, props.profile);
    if (off) return off;
    const refused = agentRefusal(props.cwd, props.agentId, props.profile);
    if (refused) return refused;
    const health = mine()?.health;
    if (!health || health.kind !== "fix") return null;
    return `${findAdapter(props.agentId).label}: ${health.reason.toLowerCase()}`;
  };

  function onPickModel(agentId: string, profile: string | null, picked: PickableModel) {
    if (agentId !== props.agentId || profile !== props.profile) {
      // Mode and effort name things the *old* row published, so they go with it
      // rather than being carried onto flags the new one never declared. A
      // different account counts as a different row for the same reason it is a
      // different catalogue: the two lists are two answers.
      resetDraftPick(props.tabId, picked.value);
      props.onSelectAgent(agentId, profile);
      return;
    }
    // A mode the new model does not offer is dropped here rather than left to
    // the menu hiding its row, which is the same walk-around `ChatView` closes:
    // picking `auto` on a model that has it and then switching to one that does
    // not leaves the draft still asking for `auto`, which the CLI accepts, exits
    // 0 on, and silently runs as something else.
    const mode = modeAfterModelSwitch(
      picked,
      findAdapter(props.agentId).chat ?? null,
      shownMode(),
      agentModes().modes,
    );
    setDraftPick(props.tabId, { model: picked.value, ...(mode !== null ? { mode } : {}) });
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

      <Show when={draftOriginFor(props.tabId)}>
        {(origin) => (
          <div class={styles.draftOrigin}>
            from{" "}
            <button
              type="button"
              class={styles.draftOriginLink}
              onClick={() => void invoke("plugin:opener|open_url", { url: origin().url }).catch(() => {})}
            >
              {origin().display}
            </button>
          </div>
        )}
      </Show>

      <Composer
        running={false}
        steering={false}
        steerCost={null}
        queue={[]}
        attachments={pendingFor(props.tabId)}
        draft={draftFor(props.tabId)}
        onDraftChange={(t) => setDraft(props.tabId, t)}
        history={historyFor(props.tabId)}
        // The agent's own last answer, cached with the models by the same
        // handshake. It used to be empty here on the reasoning that a stale set
        // would promise commands this chat may not have - which left `/` in a
        // new chat opening on nothing at all, in a composer whose whole content
        // is unsent. The model picker faced the same argument and answered it
        // the other way; this follows it. See `cachedCommands`.
        commands={cachedCommands(catalog())}
        held={false}
        disabled={starting() || blocked() !== null}
        loadFiles={attachments.loadProjectFiles}
        onSend={onSend}
        onAttachFile={attachments.onAttachFile}
        onAttachPaths={attachments.onAttachPaths}
        uploads={attachmentSources(tier(), catalog()?.catalogue?.capabilities).uploads}
        onAttachUploads={attachments.onAttachUploads}
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
              profile={props.profile}
              profileLabel={profileLabel(props.agentId, props.profile)}
              onSelectModel={onPickModel}
              onSelectEffort={(effort) => setDraftPick(props.tabId, { effort })}
              onHighlightAgent={(agentId, profile) => probeOnHighlight(agentId, profile)}
              onRecheckAgent={(agentId, profile) => recheckAgent(agentId, profile)}
              onFixAgent={openAgentCard}
            />
            <Show when={offered().modes.length > 0}>
              <ModeSelector
                mode={shownMode()}
                modes={offered().modes}
                pending={false}
                disabled={starting()}
                onSelect={(mode) => setDraftPick(props.tabId, { mode })}
              />
            </Show>
            {/* Overlaid rather than shown as published: nothing echoes a switch
                back here, so a flip would otherwise move nothing on screen. */}
            <ConfigMirror
              options={overlaidOptions(options(), pick().optionValues)}
              disabled={starting()}
              onSet={(configId, value) => setDraftOption(props.tabId, configId, value)}
            />
            <FollowToggle />
            <Show when={blocked()}>
              {(reason) => <span class={styles.barNote}>{reason()}</span>}
            </Show>
          </>
        }
      />
    </div>
  );
}
