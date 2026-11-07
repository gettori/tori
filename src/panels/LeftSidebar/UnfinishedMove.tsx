import { createSignal, Show } from "solid-js";
import Button from "../../components/Button/Button";
import type { PlannedMove } from "../../utils/moveProjects";
import styles from "./MisplacedProjects.module.css";

export default function UnfinishedMove(props: { moves: PlannedMove[]; onResume: () => Promise<void> }) {
  const [busy, setBusy] = createSignal(false);
  const left = () => props.moves.filter((m) => !m.done).length;

  async function resume() {
    setBusy(true);
    try {
      await props.onResume();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class={styles.misplaced} role="status">
      <div class={styles.row}>
        <span>
          A move didn't finish: {left()} of {props.moves.length} {props.moves.length === 1 ? "folder" : "folders"} left
        </span>
        <Button size="sm" variant="primary" disabled={busy()} onClick={() => void resume()}>
          Resume
        </Button>
      </div>
      <Show when={busy()}>
        <p class={styles.note}>Moving...</p>
      </Show>
    </div>
  );
}
