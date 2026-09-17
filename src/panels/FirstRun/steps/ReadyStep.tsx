import { For } from "solid-js";
import { Check, Minus } from "lucide-solid";
import Icon from "../../../components/Icon/Icon";
import { shortHome } from "../../../utils/names";
import styles from "../FirstRun.module.css";

const DOT = " \u00b7 ";

export type ReadySummary = {
  agents: { found: number; ready: number; signedIn: string[] };
  root: string;
  space: { name: string; created: boolean };
  hosts: { host: string; login: string }[];
  project: { made: string | null; count: number };
};

type Row = { label: string; value: string; done: boolean; mono?: boolean };

export function readyLead(summary: ReadySummary): string {
  const rest =
    summary.agents.found > 0
      ? "Everything here can be changed in Settings."
      : "Sessions start once an agent CLI is installed.";
  return `Tori will open on the ${summary.space.name} space. ${rest}`;
}

function rows(s: ReadySummary, home: string): Row[] {
  const { agents, project } = s;
  const signedIn = agents.signedIn.length > 0 ? `${DOT}${agents.signedIn.join(", ")} signed in` : "";
  return [
    agents.ready > 0
      ? { label: "Agents", value: `${agents.found} found${signedIn}`, done: true }
      : {
          label: "Agents",
          value: `${agents.found > 0 ? `${agents.found} found, none signed in` : "None yet"}${DOT}Settings > Agents`,
          done: false,
        },
    { label: "Base folder", value: shortHome(s.root, home), done: true, mono: true },
    { label: "Space", value: s.space.created ? `${s.space.name} (created)` : s.space.name, done: true },
    s.hosts.length > 0
      ? { label: "Git hosts", value: s.hosts.map((h) => `${h.host} as @${h.login}`).join(", "), done: true }
      : { label: "Git hosts", value: `Skipped${DOT}Settings > Hosts`, done: false },
    project.made
      ? { label: "Project", value: project.made, done: true, mono: true }
      : project.count > 0
        ? { label: "Project", value: `${project.count} project${project.count === 1 ? "" : "s"} in ${s.space.name}`, done: true }
        : { label: "Project", value: `Skipped${DOT}add one from the sidebar`, done: false },
  ];
}

export default function ReadyStep(props: { summary: ReadySummary; home: string }) {
  return (
    <div class={styles.summary}>
      <For each={rows(props.summary, props.home)}>
        {(row) => (
          <div class={styles.summaryRow} data-done={row.done}>
            <Icon icon={row.done ? Check : Minus} size={14} strokeWidth={2.5} />
            <span class={styles.summaryLabel}>{row.label}</span>
            <span class={styles.summaryValue} classList={{ [styles.mono]: !!row.mono }}>
              {row.value}
            </span>
          </div>
        )}
      </For>
    </div>
  );
}
