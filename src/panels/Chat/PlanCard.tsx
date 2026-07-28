import { For, Show, createMemo } from "solid-js";
import { Check, Circle, LoaderCircle } from "lucide-solid";
import type { PlanItem } from "../../utils/chatTypes";
import styles from "./Chat.module.css";

/**
 * The model's own todo list, pinned above the composer.
 *
 * Pinned rather than appended into the transcript, which is the whole design
 * decision here. `planUpdate` fires repeatedly through a turn, and folding each
 * one into the message list would print the same list five times with one item
 * moved - the transcript would read as the model repeating itself. It is one
 * piece of *current* state, so it renders in one place and is replaced, and the
 * store keeps only the latest (`state.plan`).
 *
 * Above the composer rather than at the top of the pane because a long turn
 * scrolls the transcript away, and "what is it doing and how far in" is the
 * question a plan answers - which is worthless if it has scrolled off.
 */
export default function PlanCard(props: { items: readonly PlanItem[] }) {
  const done = createMemo(() => props.items.filter((i) => i.status === "completed").length);
  // The one in flight, if any. Named rather than counted: with the list
  // collapsed this is the only line worth a row of its own.
  const active = createMemo(() => props.items.find((i) => i.status === "inProgress") ?? null);

  return (
    <Show when={props.items.length > 0}>
      <div class={styles.planCard}>
        <div class={styles.planHead}>
          <span class={styles.planTitle}>Plan</span>
          <span class={styles.planCount}>
            {done()}/{props.items.length}
          </span>
          {/* The in-flight step in the header too, so a glance at the collapsed
              card still answers "what is it doing right now". */}
          <Show when={active()}>{(item) => <span class={styles.planActive}>{item().text}</span>}</Show>
        </div>
        <ul class={styles.planList}>
          <For each={props.items}>
            {(item) => (
              <li class={`${styles.planItem} ${styles[item.status]}`}>
                <span class={styles.planGlyph} aria-hidden="true">
                  <Show
                    when={item.status === "completed"}
                    fallback={
                      <Show when={item.status === "inProgress"} fallback={<Circle size={12} />}>
                        <LoaderCircle size={12} />
                      </Show>
                    }
                  >
                    <Check size={12} />
                  </Show>
                </span>
                <span class={styles.planText}>{item.text}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
