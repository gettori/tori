import { createMemo, Show } from "solid-js";
import Tooltip from "../../components/Tooltip/Tooltip";
import { emit, TOGGLE_SIDEBAR } from "../../utils/events";
import { liveSessionStatuses } from "../../utils/sessionActivity";
import { rollupStatuses } from "../../utils/sessionStatus";
import StatusBubble from "./StatusBubble";
import styles from "./SidebarStatus.module.css";

/** Every live session's state, for the titlebar while the sidebar is hidden:
 *  with the space tiles gone too, nothing else says a session wants you. A
 *  click is the sidebar coming back, since that is where the answer is. */
export default function SidebarStatus() {
  const rollup = createMemo(() => rollupStatuses(liveSessionStatuses()));
  const label = () => {
    const r = rollup();
    const parts = [
      [r.waitingForApproval + r.waitingForAnswer, "waiting for you"],
      [r.executing, "executing"],
      [r.idle, "idle"],
      [r.running, "running"],
    ] as const;
    return parts
      .filter(([n]) => n > 0)
      .map(([n, what]) => `${n} ${what}`)
      .join(", ");
  };
  return (
    <Show when={label()}>
      <Tooltip
        as="button"
        type="button"
        class={styles.status}
        label={`${label()}. Show the sidebar`}
        aria-label={`${label()}. Show the sidebar`}
        onClick={() => emit(TOGGLE_SIDEBAR)}
      >
        <StatusBubble rollup={rollup} untitled />
      </Tooltip>
    </Show>
  );
}
