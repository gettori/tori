import { Show } from "solid-js";
import Button from "../../components/Button/Button";
import type { ConnectionHealth } from "./chatStore";
import styles from "./Chat.module.css";

const LABEL: Record<ConnectionHealth, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
};

/**
 * Whether this chat still has a `claude` behind it, and the way back when it
 * does not.
 *
 * A healthy session says so quietly - one word in the controls row, no colour
 * competing with the status the sidebar already shows. A dead one is the case
 * worth interrupting for, because every control in the pane is inert until it
 * is fixed and nothing else in the UI explains why.
 *
 * The reconnect resumes the session rather than starting a new one, so the
 * transcript on screen stays the transcript that continues.
 */
export default function ConnectionStatus(props: { health: ConnectionHealth; onReconnect: () => void }) {
  return (
    <span class={`${styles.connection} ${styles[props.health]}`} title={LABEL[props.health]}>
      <span class={styles.connectionDot} aria-hidden="true" />
      <span>{LABEL[props.health]}</span>
      <Show when={props.health === "disconnected"}>
        <Button size="sm" onClick={() => props.onReconnect()} title="Resume this session in a new process">
          Reconnect
        </Button>
      </Show>
    </span>
  );
}
