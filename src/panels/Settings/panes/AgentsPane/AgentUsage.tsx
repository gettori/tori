import { Show } from "solid-js";
import RadioGroup, { type RadioOption } from "../../../../components/RadioGroup/RadioGroup";
import Select from "../../../../components/Select/Select";
import Toggle from "../../../../components/Switch/Switch";
import type { UsageRung } from "../../../../utils/agents";
import {
  declaredRungs,
  setUsage,
  usageDetail,
  usageNotify,
  usageSource,
  usageUnavailableReason,
} from "../../../../utils/usageSettings";
import { pollUsage } from "../../../../utils/usageProbe";
import { settings, type UsageDetail, type UsageSource } from "../../settingsStore";
import { rowDomId } from "../../components/paneKit";
import { warnAtLabel } from "../../../../utils/chatBudget";
import styles from "../../Settings.module.css";

// How deep Sway reads this agent's quota, on the agent's own page.
//
// Per agent rather than global, because the rungs are per agent: Claude can
// answer from its own session events today and Codex cannot answer at all yet,
// and one global "read my usage" switch would be a promise Sway keeps for one
// of them. The **threshold** goes the other way and is global, which is why it
// is shown here as a read-only value with a pointer at its one control: how
// full is too full is a question about the user, not about an agent.

/** Every rung, in the ladder's order, plus the answer that is not a rung. */
const SOURCES: { value: string; label: string; description: string }[] = [
  { value: "off", label: "Off", description: "Sway reads no quota for this agent." },
  {
    value: "sessions",
    label: "Sessions",
    description: "From the quota the agent already puts on its own session events. No extra process, no cost.",
  },
  { value: "cli", label: "CLI", description: "Sway runs a bounded read through the agent's own CLI." },
  {
    value: "token",
    label: "Account token",
    // Measured 2026-09-06 and worth the words: macOS binds the allow to the
    // exact binary, so an unsigned build asks again after every update. A user
    // who is told only "your machine will ask" reads the second prompt as a bug.
    description:
      "Reads this account's own token from the login Keychain, the only source for the per-model weekly window. macOS will ask. Always Allow quietens it until Sway next updates, because the permission is bound to the exact build.",
  },
];

const DETAILS = [
  { value: "compact", label: "Compact" },
  { value: "standard", label: "Standard" },
  { value: "full", label: "Full" },
];

export default function AgentUsage(props: { agentId: string; agentLabel: string }) {
  const rungs = () => declaredRungs(props.agentId);
  /** No rung at all: the loader's own sentence says whether the adapter predates
   *  the table or simply declares nothing, and those are different fixes. */
  const unavailable = () => usageUnavailableReason(props.agentId);

  const options = (): RadioOption[] =>
    SOURCES.map((s) => ({
      value: s.value,
      label: s.label,
      description:
        s.value !== "off" && !rungs().includes(s.value as UsageRung)
          ? `${s.description} Not built for ${props.agentLabel} yet.`
          : s.description,
      // Off is always answerable. A rung Sway has no read path for is shown and
      // refused rather than hidden, so the ladder reads as a ladder and a user
      // can see what is coming.
      disabled: s.value !== "off" && !rungs().includes(s.value as UsageRung),
    }));

  return (
    <>
      <div class={styles.groupHead}>
        <span class={styles.groupTitle}>Usage</span>
        <span class={styles.sectionRule} />
      </div>

      <div id={rowDomId("usage-source")} class={styles.row}>
        <label id="usage-source-label" class={styles.label}>
          Usage source
        </label>
        <div class={styles.control}>
          <RadioGroup
            options={options()}
            value={usageSource(props.agentId)}
            // The read follows the click. Turning the token rung on raises a
            // Keychain prompt, and a prompt that arrives minutes later on a
            // background tick is one nobody connects to what they just did.
            onChange={(v) =>
              void setUsage(props.agentId, { source: v as UsageSource }).then(() =>
                pollUsage(props.agentId, "manual"),
              )
            }
            disabled={rungs().length === 0}
            aria-label={`Usage source for ${props.agentLabel}`}
          />
        </div>
        <div class={styles.hint}>
          <Show
            when={unavailable()}
            fallback="How deep Sway reads this agent's quota. Each rung fills the gaps the ones above it leave."
          >
            {(why) => <>Sway can read no quota for {props.agentLabel}: {why()}.</>}
          </Show>
        </div>
      </div>

      <div id={rowDomId("usage-detail")} class={styles.row}>
        <label id="usage-detail-label" class={styles.label}>
          Usage detail
        </label>
        <div class={styles.control}>
          <Select
            options={DETAILS}
            value={usageDetail(props.agentId)}
            onChange={(v) => void setUsage(props.agentId, { detail: v as UsageDetail })}
            aria-labelledby="usage-detail-label"
          />
        </div>
        <div class={styles.hint}>
          How much of this account's quota the titlebar draws. Compact is the window you are nearest
          to; Full adds the per-model windows where a source reports them.
        </div>
      </div>

      <div id={rowDomId("usage-notify")} class={styles.row}>
        <label id="usage-notify-label" class={styles.label}>
          Usage notifications
        </label>
        <div class={styles.control}>
          <Toggle
            checked={usageNotify(props.agentId)}
            onChange={(on) => void setUsage(props.agentId, { notify: on })}
            aria-label={`Notify about ${props.agentLabel} quota`}
          />
        </div>
        <div class={styles.hint}>
          Tells you when a window is approaching or reached. Never while Sway has focus: the
          titlebar is already saying it.
        </div>
      </div>

      {/* Read-only on purpose. One threshold governs Sway's own ceilings and
          every agent's quota windows, so a copy of the control here would be a
          second way to move one number and a reader would not know which won. */}
      <div id={rowDomId("usage-warn-at")} class={styles.row}>
        <label class={styles.label}>Warn at</label>
        <div class={styles.control}>
          <span>{warnAtLabel(settings.budgets?.warnAtFraction)}</span>
        </div>
        <div class={styles.hint}>
          Shared with Sway's own spend ceilings, and set once in Chat &gt; Warn at.
        </div>
      </div>
    </>
  );
}
