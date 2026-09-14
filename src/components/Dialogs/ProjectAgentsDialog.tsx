import { createSignal } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import CheckboxGroup from "../CheckboxGroup/CheckboxGroup";
import Dialog from "../Dialog/Dialog";
import { enabledChatAgents } from "../../utils/agentEnabled";
import { namedProfiles } from "../../utils/agentHealth";
import { rowLabel, soleProfile } from "../../utils/projectAgents";
import type { AgentRow } from "../../panels/Settings/settingsStore";

export type RuleRow = AgentRow & { key: string; label: string };

const rowKey = (r: AgentRow) => `${r.agent}:${r.profile}`;

export function ruleRows(allowed: AgentRow[]): RuleRow[] {
  const offered: RuleRow[] = enabledChatAgents().flatMap((a) => {
    const named = namedProfiles(a.id);
    const rows = named.length
      ? named.map((p) => ({ agent: a.id, profile: p.id }))
      : [{ agent: a.id, profile: soleProfile(a.id) }];
    return rows.map((r) => ({ ...r, key: rowKey(r), label: rowLabel(r.agent, r.profile) }));
  });
  // A row the project allows stays listed after its account or agent is gone,
  // so the rule it still enforces can be cleared.
  const gone = allowed
    .filter((r) => !offered.some((o) => o.key === rowKey(r)))
    .map((r) => ({ ...r, key: rowKey(r), label: `${rowLabel(r.agent, r.profile)} (unavailable)` }));
  return [...offered, ...gone];
}

export default function ProjectAgentsDialog(props: {
  projectName: string;
  rows: RuleRow[];
  allowed: AgentRow[];
  onConfirm: (rows: AgentRow[]) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = createSignal(props.allowed.map(rowKey));

  const confirm = () =>
    props.onConfirm(
      props.rows.filter((r) => checked().includes(r.key)).map((r) => ({ agent: r.agent, profile: r.profile })),
    );

  return (
    <Dialog
      open
      title={`Agents for ${props.projectName}`}
      onClose={() => props.onCancel()}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" onClick={() => confirm()}>
            Save
          </Button>
        </>
      }
    >
      <div class={styles.msg}>
        Only ticked agents can start or resume a session in this project. Tick none to allow every agent.
      </div>
      <CheckboxGroup
        aria-label="Allowed agents"
        options={props.rows.map((r) => ({ value: r.key, label: r.label }))}
        value={checked()}
        onChange={setChecked}
      />
    </Dialog>
  );
}
