import Button from "../Button/Button";
import styles from "./ArrivalCard.module.css";

export interface ArrivalCardProps {
  /** The decision as a question, e.g. "Open PR for #123?". */
  title: string;
  /** Branch and size, e.g. "tori/123-login-redirect, 4 files". */
  meta: string;
  /** How long it shows before settling back into the badge. */
  durationMs?: number;
  onApprove?: () => void;
  onOpen?: () => void;
}

/** The moment a new decision arrives while the user is in Workspace: a short
 *  preview under the switch that settles back into the wheel's badge. The
 *  caller owns the dismiss timer: under reduced motion the bar never animates,
 *  so it cannot be the clock. */
export default function ArrivalCard(props: ArrivalCardProps) {
  return (
    <div class={styles.card} role="status" style={{ "--arrival-ms": `${props.durationMs ?? 6000}ms` }}>
      <span class={styles.dot} />
      <span class={styles.title}>{props.title}</span>
      <span class={styles.buttons}>
        <Button size="xs" variant="primary" onClick={() => props.onApprove?.()}>
          Approve
        </Button>
        <Button size="xs" onClick={() => props.onOpen?.()}>
          Open
        </Button>
      </span>
      <span class={styles.meta}>{props.meta}</span>
      <span class={styles.countdown} />
    </div>
  );
}
