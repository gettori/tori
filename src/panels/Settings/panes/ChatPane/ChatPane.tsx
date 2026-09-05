import {
  Group,
  Row,
  Stepper,
  optionalNumber,
  rowLabelId,
  setBudgets,
  setChatDefaults,
  setCheckpoints,
  type PaneProps,
} from "../../components/paneKit";
import { settings, type DefaultSurface, type TranscriptDensity } from "../../settingsStore";
import Select, { type SelectOption } from "../../../../components/Select/Select";
import Slider from "../../../../components/Slider/Slider";
import styles from "../../Settings.module.css";
import Switch from "../../../../components/Switch/Switch";

/**
 * Chat, in three groups.
 *
 * The `chat` and `checkpoints` catalogue sections both land here, regrouped by
 * the question each row answers rather than by the section it is filed under:
 * how a chat opens and reads, what stops it running away, and what it may cost.
 * Spending is the group the budgets fix in the data layer unblocked - the
 * ceilings were writable here before it and gone on the next read.
 *
 * The id lists are written out rather than derived from a section, because the
 * grouping cuts across two of them. `settingsPanel.test.tsx` checks that every
 * catalogue entry reaches exactly one row on screen, which is what would catch
 * one being dropped from all three lists.
 */
const SESSIONS = [
  "default-surface",
  "streaming",
  "transcript-density",
  "tool-output-lines",
  "show-hooks",
  "answer-questions",
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

const SAFETY = ["checkpoints"];
const SPENDING = ["max-concurrent-chats", "session-budget", "project-budget", "context-budget", "warn-at"];

/** The stops the "Warn at" slider offers. 50% is as early as a warning is worth
 *  having; the top stop is 100%, which is the off switch rather than a warning
 *  that fires exactly as the limit lands. */
const WARN_AT_MIN = 0.5;
const WARN_AT_MAX = 1;
const WARN_AT_STEP = 0.05;

/** 100% reads as off, because that is what it does: `approaching` is disabled
 *  outside (0, 1) for both the ceilings and the quota windows. Reaching a limit
 *  is never silenced by it. */
const warnAtLabel = (v: number) => (v >= WARN_AT_MAX ? "off" : `${Math.round(v * 100)}%`);

export default function ChatPane(props: PaneProps) {
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
          hint="Off, the transcript shows a hook only when it fails; a hook that ran as configured is not news. On reveals every execution, Sway's own per-tool-call approval hook included."
        >
          <Switch
            checked={settings.chatDefaults.showSwayHooks}
            onChange={(showSwayHooks) => setChatDefaults({ showSwayHooks })}
            aria-label="Show every hook event"
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
          hint="Live chats at once before Sway says so. Each one is an agent process with its own token spend, and a chat left open in a background tab goes on costing whether or not it is being read. A warning, not a refusal: 0 turns it off."
        >
          <Stepper
            aria-label="Warn above"
            min={0}
            max={50}
            value={settings.chatDefaults.maxConcurrentChats}
            onChange={(v) => setChatDefaults({ maxConcurrentChats: v })}
          />
        </Row>

        {/* The three ceilings keep a plain field rather than a stepper: each one
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
          hint="How full a limit gets before Sway says so. Governs both the ceilings above and the agents' own quota windows, which the titlebar shows. At 100% nothing is warned about; a limit actually reached is always shown."
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
    </>
  );
}
