import { createMemo, Show, type JSX } from "solid-js";
import { CircleDashed, GitPullRequest } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import { CheckMark, QuestionMark, WorkingMark } from "../../components/Icon/statusMarks";
import type { Rollup } from "../../utils/sessionStatus";
import styles from "./StatusBubble.module.css";

/**
 * Rollup badge: Waiting first (it always wins the row), then Executing, each
 * with an xN count when more than one session shares the state. Renders nothing
 * when neither count is present.
 *
 * An approval and a question share the chip, since both say "this one is
 * waiting on you", and only the title tells them apart.
 *
 * Takes an accessor and reads it inside, so a change of counts updates the chip
 * in place. Rebuilding it would replay the draw-once marks every time any
 * session anywhere changed state.
 *
 * `tile` is the space tile's corner: a 30px square has room for one state, so it
 * shows the one that wins and leaves the rest to the title.
 *
 * `untitled` drops the per-state titles, for a bubble inside a control whose
 * own tooltip already says what it holds.
 */
export default function StatusBubble(props: { rollup: () => Rollup | null; tile?: boolean; untitled?: boolean }) {
  const r = createMemo(() => props.rollup());
  const tile = () => props.tile === true;
  const quiet = () => tile() || props.untitled === true;
  const waiting = () => (r()?.waitingForApproval ?? 0) + (r()?.waitingForAnswer ?? 0);
  const pr = () => r()?.prAttention ?? 0;
  const executing = () => r()?.executing ?? 0;
  const idle = () => r()?.idle ?? 0;
  const running = () => r()?.running ?? 0;
  const waitingTitle = () =>
    r()?.waitingForApproval && r()?.waitingForAnswer
      ? "Waiting for you"
      : r()?.waitingForApproval
        ? "Waiting for approval"
        : "Waiting for an answer";
  const counts = () => [waiting(), pr(), executing(), idle(), running()];
  const shown = (at: number) =>
    counts()[at] > 0 &&
    !(
      tile() &&
      counts()
        .slice(0, at)
        .some((n) => n > 0)
    );
  const tileTitle = () =>
    ["waiting for you", "with a pull request to look at", "executing", "idle", "running"]
      .map((label, at) => (counts()[at] ? `${counts()[at]} ${label}` : ""))
      .filter(Boolean)
      .join(", ");
  return (
    <Show when={counts().some((n) => n > 0)}>
      <span
        class={styles.statusBubble}
        classList={{ [styles.spaceBubble]: tile() }}
        title={tile() ? tileTitle() : undefined}
      >
        <Show when={shown(0)}>
          <span
            class={`${styles.statusBubbleItem} ${styles.waitingForApproval}`}
            title={quiet() ? undefined : waitingTitle()}
          >
            <QuestionMark animate />
            <Show when={waiting() > 1}>{waiting()}</Show>
          </span>
        </Show>
        <Show when={shown(1)}>
          <span
            class={`${styles.statusBubbleItem} ${styles.prAttention}`}
            title={quiet() ? undefined : "Pull request needs attention"}
          >
            <Icon icon={GitPullRequest} />
            <Show when={pr() > 1}>{pr()}</Show>
          </span>
        </Show>
        <Show when={shown(2)}>
          <span class={`${styles.statusBubbleItem} ${styles.executing}`} title={quiet() ? undefined : "Executing"}>
            <WorkingMark animate />
            <Show when={executing() > 1}>{executing()}</Show>
          </span>
        </Show>
        <Show when={shown(3)}>
          <span class={`${styles.statusBubbleItem} ${styles.idle}`} title={quiet() ? undefined : "Idle"}>
            <CheckMark animate />
            <Show when={idle() > 1}>{idle()}</Show>
          </span>
        </Show>
        <Show when={shown(4)}>
          <span class={`${styles.statusBubbleItem} ${styles.running}`} title={quiet() ? undefined : "Running"}>
            <Icon icon={CircleDashed} />
            <Show when={running() > 1}>{running()}</Show>
          </span>
        </Show>
      </span>
    </Show>
  );
}

/** The same corner as the rollup badge, carrying a plain count instead of the
 *  session states: the dock button's hidden-tab total. It shares the geometry
 *  because it shares the corner, and two boxes pinned to the same 30px square
 *  cannot be allowed to drift apart. */
export function CountBubble(props: { children: JSX.Element }) {
  return (
    <span class={styles.spaceBubble}>
      <span class={styles.tileCount}>{props.children}</span>
    </span>
  );
}
