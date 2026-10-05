import { createSignal, For, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Checkbox from "../Checkbox/Checkbox";
import Dialog from "../Dialog/Dialog";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import { enabledChatAgents } from "../../utils/agentEnabled";
import { namedProfiles, profileLabel } from "../../utils/agentHealth";
import { findAdapter } from "../../utils/agents";
import { rowLabel, soleProfile } from "../../utils/projectAgents";
import type { AgentRow } from "../../panels/Settings/settingsStore";

/** One offerable agent-and-account pair. `label` is what names the row for
 *  assistive tech; `name` and `account` are the same thing split, because the
 *  row draws the account at its far edge rather than inline. */
export type RuleRow = AgentRow & { key: string; label: string; name: string; account: string };

const rowKey = (r: AgentRow) => `${r.agent}:${r.profile}`;

export function ruleRows(allowed: AgentRow[]): RuleRow[] {
  const offered: RuleRow[] = enabledChatAgents().flatMap((a) => {
    const named = namedProfiles(a.id);
    const rows = named.length
      ? named.map((p) => ({ agent: a.id, profile: p.id }))
      : [{ agent: a.id, profile: soleProfile(a.id) }];
    return rows.map((r) => ({
      ...r,
      key: rowKey(r),
      label: rowLabel(r.agent, r.profile),
      name: findAdapter(r.agent).label,
      account: profileLabel(r.agent, r.profile) ?? "",
    }));
  });
  // A row the project allows stays listed after its account or agent is gone,
  // so the rule it still enforces can be cleared.
  const gone = allowed
    .filter((r) => !offered.some((o) => o.key === rowKey(r)))
    .map((r) => ({
      ...r,
      key: rowKey(r),
      label: `${rowLabel(r.agent, r.profile)} (unavailable)`,
      name: rowLabel(r.agent, r.profile),
      account: "unavailable",
    }));
  return [...offered, ...gone];
}

type Mode = "every" | "only";

/**
 * Which agents may start or resume a session in this project.
 *
 * **The two states are a mode, not an empty list.** The help line used to read
 * "Tick none to allow every agent", so nothing ticked meant both "no agent is
 * allowed" and "every agent is allowed" and the list could not tell you which
 * one you were looking at. The strip says it outright, and the action bar counts
 * the answer back.
 *
 * **Storage is unchanged.** Every mode saves an empty set (which is what "no
 * rule" has always been), Only mode saves the ticked ids, and a project loaded
 * with an empty set opens in Every mode. So a project's rule means the same
 * thing before and after this dialog was redrawn.
 *
 * Ticks survive the switch to Every and back: the mode is a question about the
 * list, not an edit to it, and clearing it on the way past would make an
 * accidental press expensive.
 */
export default function ProjectAgentsDialog(props: {
  projectName: string;
  rows: RuleRow[];
  allowed: AgentRow[];
  onConfirm: (rows: AgentRow[]) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = createSignal<Mode>(props.allowed.length ? "only" : "every");
  const [checked, setChecked] = createSignal(props.allowed.map(rowKey));

  const only = () => mode() === "only";
  const isOn = (key: string) => checked().includes(key);
  const toggle = (key: string, on: boolean) => setChecked((now) => (on ? [...now, key] : now.filter((k) => k !== key)));

  const canSave = () => !only() || checked().length > 0;
  const summary = () => {
    if (!only()) return `All ${props.rows.length} agents allowed`;
    if (!checked().length) return "Tick at least one agent";
    return `${checked().length} of ${props.rows.length} agents allowed`;
  };

  const confirm = () => {
    if (!canSave()) return;
    props.onConfirm(
      only() ? props.rows.filter((r) => isOn(r.key)).map((r) => ({ agent: r.agent, profile: r.profile })) : [],
    );
  };

  return (
    <Dialog
      open
      size="sheet"
      title={`Agents for “${props.projectName}”`}
      onClose={() => props.onCancel()}
      actions={
        <>
          {/* The count, beside the button it gates. It is also the only place
              the refusal is written, which is why it stays up in every mode
              rather than appearing only when the save is off. */}
          <span class={styles.armHint}>{summary()}</span>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={!canSave()} onClick={() => confirm()}>
            Save
          </Button>
        </>
      }
    >
      <div class={styles.spaceForm}>
        <div>
          <SegmentedControl
            class={styles.modeSeg}
            aria-label="Which agents are allowed"
            options={[
              { value: "every", label: "Every agent" },
              { value: "only", label: "Only selected" },
            ]}
            value={mode()}
            onChange={setMode}
          />
          <div class={styles.modeNote}>
            {only()
              ? "Only the agents you tick can start or resume a session in this project."
              : "Any agent you have configured can start a session here. Nothing to pick."}
          </div>
        </div>

        {/* Drawn in both modes, inert in one: what Only mode would ask is
            visible before the switch, so the strip is a choice rather than a
            door. `aria-hidden` with it, since a list nothing can reach is not
            something to announce, and every box inside is `disabled` so the
            hidden subtree holds nothing the keyboard could still land on. */}
        <div class={styles.agentList} classList={{ [styles.agentsIdle]: !only() }} aria-hidden={!only() || undefined}>
          <For each={props.rows}>
            {(row) => (
              <Checkbox
                class={`${styles.agentRow} ${only() && isOn(row.key) ? styles.agentRowOn : ""}`.trim()}
                checked={only() && isOn(row.key)}
                disabled={!only()}
                onChange={(on) => toggle(row.key, on)}
                aria-label={row.label}
                label={
                  <span class={styles.agentLabel}>
                    <span class={styles.agentName}>{row.name}</span>
                    <Show when={row.account}>
                      <span class={styles.agentAccount}>{row.account}</span>
                    </Show>
                  </span>
                }
              />
            )}
          </For>
        </div>
      </div>
    </Dialog>
  );
}
