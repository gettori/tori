import { For, Show, createMemo, createSignal } from "solid-js";
import { Check, ChevronDown, Circle, LoaderCircle } from "lucide-solid";
import Tooltip from "../../components/Tooltip/Tooltip";
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
 *
 * Whose plan: any agent that publishes one, which is every ACP agent. Claude's
 * build carries no todo tool at all (measured on 2.1.251: no `TodoWrite` in
 * `system/init`), so it has nothing to publish rather than a shape this refuses.
 */
export default function PlanCard(props: { items: readonly PlanItem[] }) {
  const done = createMemo(() => props.items.filter((i) => i.status === "completed").length);
  // The one in flight, if any. Named rather than counted: with the list
  // collapsed this is the only line worth a row of its own.
  const active = createMemo(() => props.items.find((i) => i.status === "inProgress") ?? null);
  // Open by default, which is the card as it always was. Per mount rather than
  // remembered: a plan belongs to a turn, and one folded away yesterday is not
  // an instruction about the next one.
  const [open, setOpen] = createSignal(true);
  const tally = () => `${done()}/${props.items.length}`;

  const rows = () => (
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
  );

  return (
    <Show when={props.items.length > 0}>
      <Show
        when={open()}
        fallback={
          // Folded, the plan is one figure on the composer's own edge, with
          // the whole list a hover away. Its row has no height of its own, so
          // folding gives every pixel of it back to the conversation.
          <div class={styles.planPillRow}>
            <Tooltip
              as="button"
              type="button"
              class={styles.planPill}
              // The same rows the open card draws, from one accessor, so the
              // two cannot drift into two descriptions of one plan.
              label={rows()}
              aria-label={`Plan: ${tally()} done. Show the list.`}
              aria-expanded={false}
              onClick={() => setOpen(true)}
            >
              {tally()}
            </Tooltip>
          </div>
        }
      >
        <div class={styles.planCard}>
          {/* The head is the fold, the way a tool call's row is: one control,
              on the thing it folds, rather than a separate affordance beside
              it. */}
          <button type="button" class={styles.planHead} aria-expanded onClick={() => setOpen(false)}>
            <span class={styles.planCaret} aria-hidden="true">
              <ChevronDown size={12} />
            </span>
            <span class={styles.planTitle}>Plan</span>
            <span class={styles.planCount}>{tally()}</span>
            {/* The in-flight step in the header too, so a glance at the card
                still answers "what is it doing right now". */}
            <Show when={active()}>{(item) => <span class={styles.planActive}>{item().text}</span>}</Show>
          </button>
          {rows()}
        </div>
      </Show>
    </Show>
  );
}
