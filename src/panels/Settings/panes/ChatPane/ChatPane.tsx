import { Show, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Play } from "lucide-solid";
import { homeDir } from "@tauri-apps/api/path";
import { emitWith, OPEN_JOB, TOAST, type OpenJob, type ToastEvent } from "../../../../utils/events";
import { preview, voices as listVoices } from "../../../../utils/speech";
import {
  askToDownload,
  cancelDownload,
  defaultVoice,
  deleteVoice,
  espeakJob,
  mb,
  refresh as refreshVoice,
  sizeLabel,
  status as voiceStatus,
} from "../../../../utils/voiceDownload";
import {
  CREDIT,
  askToDownload as askForDictation,
  cancelDownload as cancelDictationDownload,
  deleteModel,
  refresh as refreshDictation,
  sizeLabel as dictationSizeLabel,
  status as dictationStatus,
} from "../../../../utils/dictationDownload";
import ConfirmDialog from "../../../../components/Dialogs/ConfirmDialog";
import {
  Group,
  Row,
  Stepper,
  optionalNumber,
  rowLabelId,
  setAlert,
  setBlindEdits,
  setBudgets,
  setChatDefaults,
  setNotifications,
  setCheckpoints,
  setConflictRadar,
  setSecretWatch,
  setSpeech,
  setVerification,
  type PaneProps,
} from "../../components/paneKit";
import { settings, type DefaultSurface, type NotificationSettings, type TranscriptDensity } from "../../settingsStore";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import Select, { type SelectOption } from "../../../../components/Select/Select";
import Slider from "../../../../components/Slider/Slider";
import styles from "../../Settings.module.css";
import Switch from "../../../../components/Switch/Switch";
import { warnAtLabel } from "../../../../utils/chatBudget";

/**
 * Chat, in four groups.
 *
 * The `chat` and `checkpoints` catalogue sections both land here, regrouped by
 * the question each row answers rather than by the section it is filed under:
 * how a chat opens and reads, what it tells you about, what stops it running
 * away, and what it may cost.
 * Spending is the group the budgets fix in the data layer unblocked - the
 * ceilings were writable here before it and gone on the next read.
 *
 * The id lists are written out rather than derived from a section, because the
 * grouping cuts across two of them. `settingsPanel.test.tsx` checks that every
 * catalogue entry reaches exactly one row on screen, which is what would catch
 * one being dropped from all four lists.
 */
const SESSIONS = [
  "default-surface",
  "streaming",
  "transcript-density",
  "tool-output-lines",
  "show-hooks",
  "collapse-work",
  "answer-questions",
  "attach-long-pastes",
  "secret-watch",
  "blind-edits",
  "verification",
  "conflict-radar",
  "resume-at-reset",
];

/** The two option lists, module-level so they are not rebuilt per render. The
 *  values are the store's own unions, so a typo here is a type error at the
 *  `onChange` cast rather than a row that silently never matches. */
const SURFACES: SelectOption[] = [
  { value: "chat", label: "Chat" },
  { value: "agent", label: "Terminal (agent tab)" },
];
const DENSITIES: SelectOption[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

const NOTIFICATIONS = [
  "notify-needs-you",
  "sound-needs-you",
  "notify-turn-finished",
  "sound-turn-finished",
  "tray-count",
];
const SAFETY = ["checkpoints"];
const READ_ALOUD = ["read-aloud-model", "read-aloud-pronunciation", "read-aloud-voice", "read-aloud-rate"];
const DICTATION = ["dictation-model"];

const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.1;
const SAMPLE = "This is how a reply will sound when Tori reads it to you.";
const SPENDING = ["max-concurrent-chats", "session-budget", "project-budget", "context-budget", "warn-at"];

/** The stops the "Warn at" slider offers. 50% is as early as a warning is worth
 *  having; the top stop is 100%, which is the off switch rather than a warning
 *  that fires exactly as the limit lands. */
const WARN_AT_MIN = 0.5;
const WARN_AT_MAX = 1;
const WARN_AT_STEP = 0.05;

/** Hear a state's sound without waiting for a session to reach it. Played by
 *  Rust, the same way the real one is, so what is heard is what will play. */
function PlaySound(props: { sound: keyof NotificationSettings; label: string }) {
  return (
    <IconButton
      size="sm"
      icon={<Icon icon={Play} />}
      tooltip="Play the sound"
      aria-label={props.label}
      onClick={() => void invoke("sound_preview", { sound: props.sound }).catch(() => {})}
    />
  );
}

const toast = (message: string) => emitWith<ToastEvent>(TOAST, { message, kind: "error" });

export default function ChatPane(props: PaneProps) {
  void refreshVoice().catch((e) => toast(`Couldn't check the downloaded voice: ${String(e)}`));
  void refreshDictation().catch((e) => toast(`Couldn't check the dictation model: ${String(e)}`));
  const [voices] = createResource(
    () => voiceStatus().model ?? false,
    () =>
      listVoices().catch(() => {
        toast(`Couldn't list the downloaded voices, so only ${defaultVoice().name} is offered.`);
        return [];
      }),
  );
  const runEspeak = async (verb: "install" | "uninstall") => {
    const cwd = await homeDir().catch(() => "/");
    emitWith<OpenJob>(OPEN_JOB, espeakJob(verb, cwd));
  };
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  const removeVoice = () => {
    setConfirmingDelete(false);
    void deleteVoice().catch((e) => toast(`Couldn't delete the voice: ${String(e)}`));
  };
  const downloading = () => voiceStatus().downloading;
  const [confirmingModelDelete, setConfirmingModelDelete] = createSignal(false);
  const removeModel = () => {
    setConfirmingModelDelete(false);
    void deleteModel().catch((e) => toast(`Couldn't delete the dictation model: ${String(e)}`));
  };
  const voiceOptions = (): SelectOption[] => [
    { value: "", label: `${defaultVoice().name} (en-US)` },
    ...(voices() ?? [])
      .filter((v) => v.id !== defaultVoice().id)
      .map((v) => ({ value: v.id, label: `${v.name} (${v.language})` })),
  ];
  return (
    <>
      <Group {...props} title="Sessions" ids={SESSIONS}>
        <Row
          {...props}
          id="default-surface"
          label="Open sessions in"
          hint="Which surface a click on a session opens. The other one stays available from the split-button menu either way, and already-saved tabs reopen on the surface they were saved on."
        >
          <div class={styles.control}>
            <Select
              options={SURFACES}
              value={settings.chatDefaults.defaultSurface}
              onChange={(value) => setChatDefaults({ defaultSurface: value as DefaultSurface })}
              aria-labelledby={rowLabelId("default-surface")}
            />
          </div>
        </Row>

        {/* No default model/effort/mode settings on purpose: a new chat opens on
            whatever the CLI itself would choose, and the composer's pickers
            change course mid-conversation. */}

        <Row {...props} id="streaming" label="Stream responses">
          <Switch
            checked={settings.chatDefaults.streaming}
            onChange={(streaming) => setChatDefaults({ streaming })}
            aria-label="Stream responses"
          />
        </Row>

        <Row {...props} id="transcript-density" label="Transcript density">
          <div class={styles.control}>
            <Select
              options={DENSITIES}
              value={settings.chatDefaults.density}
              onChange={(value) => setChatDefaults({ density: value as TranscriptDensity })}
              aria-labelledby={rowLabelId("transcript-density")}
            />
          </div>
        </Row>

        <Row
          {...props}
          id="tool-output-lines"
          label="Tool output lines"
          hint="Lines shown before a tool's output folds. 0 shows all of it."
        >
          <Stepper
            aria-label="Tool output lines"
            min={0}
            max={500}
            step={5}
            value={settings.chatDefaults.toolOutputLines}
            onChange={(v) => setChatDefaults({ toolOutputLines: v })}
          />
        </Row>

        <Row
          {...props}
          id="show-hooks"
          label="Show every hook event"
          hint="Off, the transcript shows a hook only when it fails; a hook that ran as configured is not news. On reveals every execution, Tori's own per-tool-call approval hook included."
        >
          <Switch
            checked={settings.chatDefaults.showToriHooks}
            onChange={(showToriHooks) => setChatDefaults({ showToriHooks })}
            aria-label="Show every hook event"
          />
        </Row>

        <Row
          {...props}
          id="collapse-work"
          label="Collapse agent work"
          hint="On, the transcript reads as prompts and replies: thinking, tool calls, hooks and answered questions fold into a one line card you can open. A permission prompt or a question still waiting on you shows as usual until you answer it."
        >
          <Switch
            checked={settings.chatDefaults.collapseWork}
            onChange={(collapseWork) => setChatDefaults({ collapseWork })}
            aria-label="Collapse agent work"
          />
        </Row>

        <Row
          {...props}
          id="answer-questions"
          label="Answer the agent's questions here"
          hint="On, a question the agent asks becomes a form in the transcript. Off restores the permission card it used to be, where the only answers are allow and deny, and allowing lets the agent record that nobody answered."
        >
          <Switch
            checked={settings.chatDefaults.answerQuestionsInline}
            onChange={(answerQuestionsInline) => setChatDefaults({ answerQuestionsInline })}
            aria-label="Answer the agent's questions here"
          />
        </Row>

        <Row
          {...props}
          id="attach-long-pastes"
          label="Attach long pastes as files"
          hint="On, a paste over 30 lines or 3000 characters becomes a file chip the agent reads off disk, and the box stays readable. Off keeps every paste in the box, for when you want to point at a line of it."
        >
          <Switch
            checked={settings.chatDefaults.attachLongPastes}
            onChange={(attachLongPastes) => setChatDefaults({ attachLongPastes })}
            aria-label="Attach long pastes as files"
          />
        </Row>

        <Row
          {...props}
          id="secret-watch"
          label="Mark secret file reads"
          hint="On, a turn in which an agent read a file like .env or a key, or ran a command naming one, says so in the chat, on its tab and in Checkpoints. Nothing is blocked either way. Add patterns under secretWatch.patterns in settings.json."
        >
          <Switch
            checked={settings.secretWatch.enabled}
            onChange={setSecretWatch}
            aria-label="Mark secret file reads"
          />
        </Row>

        <Row
          {...props}
          id="blind-edits"
          label="Mark edits made without reading"
          hint="On, an ACP agent's edit to an existing file the session never read, searched or named says so on the call and at the head of its turn. Claude's own tools already refuse such an edit. Nothing is blocked either way."
        >
          <Switch
            checked={settings.blindEdits.enabled}
            onChange={setBlindEdits}
            aria-label="Mark edits made without reading"
          />
        </Row>

        <Row
          {...props}
          id="verification"
          label="Mark unverified turns"
          hint="On, a turn that changed code says whether a test, type check, lint or build ran after its last edit: verified, failed, or unverified when nothing ran or its exit was not seen. Shown in the chat, on its tab and in Checkpoints. Nothing is blocked either way."
        >
          <Switch
            checked={settings.verification.enabled}
            onChange={setVerification}
            aria-label="Mark unverified turns"
          />
        </Row>

        <Row
          {...props}
          id="conflict-radar"
          label="Watch branches for conflicts"
          hint="On, a branch that would conflict with its base says so on its sidebar row before a pull request exists. Off, Tori runs none of these checks and the row stays quiet either way."
        >
          <Switch
            checked={settings.conflictRadar.enabled}
            onChange={setConflictRadar}
            aria-label="Watch branches for conflicts"
          />
        </Row>

        <Row
          {...props}
          id="resume-at-reset"
          label="Resume at reset"
          hint="On, a claude chat that stopped on a usage limit gets one message from Tori asking it to continue, shortly after the limit resets. Off, the limit banner can still do this for one chat."
        >
          <Switch
            checked={settings.chatDefaults.resumeAtReset}
            onChange={(resumeAtReset) => setChatDefaults({ resumeAtReset })}
            aria-label="Resume at reset"
          />
        </Row>
      </Group>

      <Group {...props} title="Notifications" ids={NOTIFICATIONS}>
        <Row {...props} id="notify-needs-you" label="Notify when a session needs you">
          <Switch
            checked={settings.notifications.needsYou.notify}
            onChange={(notify) => setAlert("needsYou", { notify })}
            aria-label="Notify when a session needs you"
          />
        </Row>

        <Row {...props} id="sound-needs-you" label="Play a sound when a session needs you">
          <PlaySound sound="needsYou" label="Play the needs you sound" />
          <Switch
            checked={settings.notifications.needsYou.sound}
            onChange={(sound) => setAlert("needsYou", { sound })}
            aria-label="Play a sound when a session needs you"
          />
        </Row>

        <Row {...props} id="notify-turn-finished" label="Notify when a chat finishes its turn">
          <Switch
            checked={settings.notifications.turnFinished.notify}
            onChange={(notify) => setAlert("turnFinished", { notify })}
            aria-label="Notify when a chat finishes its turn"
          />
        </Row>

        <Row {...props} id="sound-turn-finished" label="Play a sound when a chat finishes its turn">
          <PlaySound sound="turnFinished" label="Play the turn finished sound" />
          <Switch
            checked={settings.notifications.turnFinished.sound}
            onChange={(sound) => setAlert("turnFinished", { sound })}
            aria-label="Play a sound when a chat finishes its turn"
          />
        </Row>

        <Row {...props} id="tray-count" label="Show the needs you count in the menu bar">
          <Switch
            checked={settings.notifications.trayCount}
            onChange={(trayCount) => setNotifications({ trayCount })}
            aria-label="Show the needs you count in the menu bar"
          />
        </Row>
      </Group>

      <Group {...props} title="Safety" ids={SAFETY}>
        <Row
          {...props}
          id="checkpoints"
          label="Snapshot on each prompt"
          hint="Lets a session's turns be diffed and reverted. Adds one git snapshot per prompt."
        >
          <Switch
            checked={settings.checkpoints.enabled}
            onChange={(enabled) => setCheckpoints({ enabled })}
            aria-label="Snapshot on each prompt"
          />
        </Row>
      </Group>

      <Group {...props} title="Spending" ids={SPENDING}>
        <Row
          {...props}
          id="max-concurrent-chats"
          label="Warn above"
          hint="Live chats at once before Tori says so. Each one is an agent process with its own token spend, and a chat left open in a background tab goes on costing whether or not it is being read. A warning, not a refusal: 0 turns it off."
        >
          <Stepper
            aria-label="Warn above"
            min={0}
            max={50}
            value={settings.chatDefaults.maxConcurrentChats}
            onChange={(v) => setChatDefaults({ maxConcurrentChats: v })}
          />
        </Row>

        {/* The ceilings keep a plain field rather than a stepper: each one
            is opt-in, and blank is a value a stepper cannot hold or return to.
            The placeholder is what says so. */}
        <Row
          {...props}
          id="session-budget"
          label="Stop this chat after"
          hint="Dollars one chat may spend before it stops starting turns. The turn that crosses the limit is allowed to finish. Leave blank for no limit, which is the default."
        >
          <input
            type="number"
            min="0"
            step="0.5"
            placeholder="no limit"
            aria-label="Stop this chat after"
            class={`${styles.input} ${styles.numField}`}
            value={settings.budgets.sessionUsd ?? ""}
            onChange={(e) => setBudgets({ sessionUsd: optionalNumber(e.currentTarget.value, 0) })}
          />
        </Row>

        <Row
          {...props}
          id="project-budget"
          label="Stop this project after"
          hint="Dollars across every chat in one project. Two chats open on one repo spend one budget."
        >
          <input
            type="number"
            min="0"
            step="0.5"
            placeholder="no limit"
            aria-label="Stop this project after"
            class={`${styles.input} ${styles.numField}`}
            value={settings.budgets.projectUsd ?? ""}
            onChange={(e) => setBudgets({ projectUsd: optionalNumber(e.currentTarget.value, 0) })}
          />
        </Row>

        <Row
          {...props}
          id="item-budget"
          label="Stop an autopilot item after"
          hint="Dollars across every session the autopilot runs for one item, retries and second opinions included. A project or an item can set its own. ACP agents report no cost, so this never stops their workers."
        >
          <input
            type="number"
            min="0"
            step="0.5"
            placeholder="no limit"
            aria-label="Stop an autopilot item after"
            class={`${styles.input} ${styles.numField}`}
            value={settings.budgets.itemUsd ?? ""}
            onChange={(e) => setBudgets({ itemUsd: optionalNumber(e.currentTarget.value, 0) })}
          />
        </Row>

        <Row
          {...props}
          id="context-budget"
          label="Stop at context"
          hint="Percent of the model's context window. Unlike the money limits this one recovers on its own after a compaction."
        >
          <input
            type="number"
            min="1"
            max="100"
            placeholder="no limit"
            aria-label="Stop at context"
            class={`${styles.input} ${styles.numField}`}
            value={settings.budgets.contextPercent ?? ""}
            onChange={(e) => setBudgets({ contextPercent: optionalNumber(e.currentTarget.value, 1) })}
          />
        </Row>

        {/* One threshold for two things that look unrelated on screen and are
            the same question: how full is too full. Splitting it would mean two
            controls to keep in step, and a user who moved one and wondered why
            half their warnings did not change. */}
        <Row
          {...props}
          id="warn-at"
          label="Warn at"
          hint="How full a limit gets before Tori says so. Governs the ceilings above, and is the default for each account's quota windows until that account sets its own under Agents. At 100% nothing is warned about; a limit actually reached is always shown."
        >
          <div class={styles.control}>
            <Slider
              min={WARN_AT_MIN}
              max={WARN_AT_MAX}
              step={WARN_AT_STEP}
              value={settings.budgets.warnAtFraction}
              onChange={(v) => setBudgets({ warnAtFraction: v })}
              aria-label="Warn at"
            />
            <span class={styles.numField}>{warnAtLabel(settings.budgets.warnAtFraction)}</span>
          </div>
        </Row>
      </Group>

      <Group {...props} title="Read aloud" ids={READ_ALOUD}>
        <Row {...props} id="read-aloud-model" label="Voice size">
          <div class={styles.control}>
            <Show
              when={downloading()}
              fallback={
                <Show when={voiceStatus().model} fallback={<span>Not downloaded</span>}>
                  {(size) => (
                    <>
                      <span>{sizeLabel(size())}</span>
                      <Button size="sm" onClick={() => askToDownload()}>
                        Change
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setConfirmingDelete(true)}>
                        Delete
                      </Button>
                    </>
                  )}
                </Show>
              }
            >
              {(p) => (
                <>
                  <span>
                    Downloading, {mb(p().done)} of {mb(p().total)} MB
                  </span>
                  <Button size="sm" onClick={() => void cancelDownload()}>
                    Cancel
                  </Button>
                </>
              )}
            </Show>
          </div>
        </Row>
        <Row {...props} id="read-aloud-pronunciation" label="Pronunciation">
          <div class={styles.control}>
            <Show
              when={voiceStatus().espeak}
              fallback={
                <>
                  <Show
                    when={voiceStatus().brew}
                    fallback={<span>Words Tori does not know are spelled out. Install espeak-ng to fix that.</span>}
                  >
                    <span>Words Tori does not know are spelled out</span>
                    <Button size="sm" onClick={() => void runEspeak("install")}>
                      Install espeak-ng
                    </Button>
                  </Show>
                </>
              }
            >
              <span>espeak-ng says the words Tori does not know</span>
              <Button size="sm" onClick={() => void runEspeak("uninstall")}>
                Uninstall
              </Button>
            </Show>
          </div>
        </Row>

        <Show when={confirmingDelete()}>
          <ConfirmDialog
            title="Delete the voice?"
            message="Read aloud needs it. Getting it back means downloading it again."
            confirmLabel="Delete"
            danger
            onConfirm={removeVoice}
            onCancel={() => setConfirmingDelete(false)}
          />
        </Show>

        <Row {...props} id="read-aloud-voice" label="Voice">
          <div class={styles.control}>
            <Show
              when={voiceStatus().installed}
              fallback={
                <Button size="sm" disabled={!!downloading()} onClick={() => askToDownload()}>
                  Download
                </Button>
              }
            >
              <Select
                options={voiceOptions()}
                value={settings.speech.voice ?? ""}
                onChange={(value) => setSpeech({ voice: value || null })}
                aria-labelledby={rowLabelId("read-aloud-voice")}
              />
              <IconButton
                size="sm"
                icon={<Icon icon={Play} />}
                tooltip="Hear this voice"
                onClick={() => void preview(settings.speech.voice, SAMPLE)}
              />
            </Show>
          </div>
        </Row>

        <Row {...props} id="read-aloud-rate" label="Speed">
          <div class={styles.control}>
            <Slider
              min={RATE_MIN}
              max={RATE_MAX}
              step={RATE_STEP}
              value={settings.speech.rate}
              onChange={(rate) => setSpeech({ rate })}
              aria-label="Speed"
            />
            <span class={styles.numField}>{settings.speech.rate.toFixed(1)}x</span>
          </div>
        </Row>
      </Group>

      <Group {...props} title="Dictation" ids={DICTATION}>
        <Row {...props} id="dictation-model" label="Model">
          <div class={styles.control}>
            <Show
              when={dictationStatus().downloading}
              fallback={
                <Show
                  when={dictationStatus().model}
                  fallback={
                    <>
                      <span>Not downloaded</span>
                      <Button size="sm" onClick={() => askForDictation()}>
                        Download
                      </Button>
                    </>
                  }
                >
                  {(size) => (
                    <>
                      <span>{dictationSizeLabel(size())}</span>
                      <Show when={size() === "parakeet"}>
                        <span>{CREDIT}</span>
                      </Show>
                      <Button size="sm" onClick={() => askForDictation()}>
                        Change
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setConfirmingModelDelete(true)}>
                        Delete
                      </Button>
                    </>
                  )}
                </Show>
              }
            >
              {(p) => (
                <>
                  <span>
                    Downloading, {mb(p().done)} of {mb(p().total)} MB
                  </span>
                  <Button size="sm" onClick={() => void cancelDictationDownload()}>
                    Cancel
                  </Button>
                </>
              )}
            </Show>
          </div>
        </Row>

        <Show when={confirmingModelDelete()}>
          <ConfirmDialog
            title="Delete the dictation model?"
            message="Dictation needs it. Getting it back means downloading it again."
            confirmLabel="Delete"
            danger
            onConfirm={removeModel}
            onCancel={() => setConfirmingModelDelete(false)}
          />
        </Show>
      </Group>
    </>
  );
}
