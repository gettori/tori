import { Lock } from "lucide-solid";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import styles from "./LockedBar.module.css";

export interface LockedBarProps {
  /** What the worker is doing now, e.g. "running pnpm test auth". */
  now: string;
  /** How far the item has come, 0 to 1. */
  progress: number;
  /** Done and waiting on an approval: the bar fills and turns idle. */
  waiting?: boolean;
  onBackToAutopilot?: () => void;
  /** Stops the whole autopilot, which is the only way to take a session over. */
  onStop?: () => void;
}

/** Takes the composer's place in a session the autopilot is driving. Typing
 *  here would race the autopilot's own turns, so the way in is to stop it. */
export default function LockedBar(props: LockedBarProps) {
  const fill = () => (props.waiting ? 1 : Math.min(1, Math.max(0, props.progress)));
  return (
    <div class={styles.bar} role="status">
      <Icon icon={Lock} class={styles.lock} />
      <div class={styles.text}>
        <span class={styles.title}>The autopilot has this session</span>
        <span class={styles.now}>Now: {props.now}</span>
      </div>
      <Button size="sm" variant="ghost" onClick={() => props.onBackToAutopilot?.()}>
        Back to autopilot
      </Button>
      <Button size="sm" icon={<span class={styles.stopGlyph} />} onClick={() => props.onStop?.()}>
        Stop to type
      </Button>
      <span
        class={styles.progress}
        data-waiting={props.waiting ? "true" : "false"}
        style={{ "--locked-fill": String(fill()) }}
      />
    </div>
  );
}
