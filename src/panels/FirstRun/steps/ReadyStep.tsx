import { Check } from "lucide-solid";
import Icon from "../../../components/Icon/Icon";
import { shortHome } from "../../../utils/names";
import styles from "../FirstRun.module.css";

export type ReadySummary = {
  root: string;
  space: { name: string; created: boolean };
};

export function readyLead(summary: ReadySummary): string {
  return `Tori will open on the ${summary.space.name} space. Everything here can be changed in Settings.`;
}

export default function ReadyStep(props: { summary: ReadySummary; home: string }) {
  return (
    <div class={styles.summary}>
      <div class={styles.summaryRow}>
        <Icon icon={Check} size={14} strokeWidth={2.5} />
        <span class={styles.summaryLabel}>Base folder</span>
        <span class={`${styles.summaryValue} ${styles.mono}`}>{shortHome(props.summary.root, props.home)}</span>
      </div>
      <div class={styles.summaryRow}>
        <Icon icon={Check} size={14} strokeWidth={2.5} />
        <span class={styles.summaryLabel}>Space</span>
        <span class={styles.summaryValue}>
          {props.summary.space.name}
          {props.summary.space.created ? " (created)" : ""}
        </span>
      </div>
    </div>
  );
}
