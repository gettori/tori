import { For, Show, type JSX } from "solid-js";
import { RadioGroup as Primitive } from "../../lib/radio-group";
import styles from "./RadioGroup.module.css";

/** One choice: the string the app stores, the label the user reads, and an
 *  optional second line that is part of the choice rather than a hint about
 *  it. */
export type RadioOption = {
  /** Non-empty. `""` is how this component spells "nothing chosen", so an
   *  option carrying it would be selected whenever the group is not. */
  value: string;
  label: JSX.Element;
  description?: JSX.Element;
  disabled?: boolean;
};

/**
 * One choice out of a small fixed set, all of them visible at once: Kobalte's
 * radio group behind Tori's chrome and Tori's API.
 *
 * **Radio or Select is a density choice.** This is for a handful of options the
 * user should be able to compare side by side without opening anything, which
 * is what an agent's question is. A longer list, or one where the choice is
 * routine enough not to deserve the space, is a `<Select>`.
 *
 * **String in, string out**, the same contract `<Select>` keeps. Kobalte's own
 * `value`/`onChange` already traffic in the option's string here, so unlike
 * Select this needs no memo to get back to the option object.
 *
 * **`null` is a real value and means nothing is chosen.** A question that has
 * not been answered is the common case, not an edge one, and a group that
 * arrived pre-selected would answer it for the user.
 *
 * It maps to the **empty string**, not to `undefined`, and that is load
 * bearing. Kobalte reads `value === undefined` as "uncontrolled" and starts
 * keeping its own state, so a group handed `undefined` ticks the radio the user
 * pressed even when the caller's value never changed. Measured against the
 * installed 0.13.13: with `undefined`, a call site whose handler refuses the
 * change is left showing a state its store never took. The empty string is a
 * value like any other, so the group stays controlled and matches no option.
 * The cost is that `""` cannot itself be an option value here, which is why
 * `RadioOption.value` is documented as non-empty.
 *
 * The native inputs Kobalte renders are real `<input type="radio">`, so arrow
 * keys move between them and `getByRole("radio")` finds them without any JS of
 * ours. We draw the dot: each input is visually hidden and stays in the
 * accessibility tree, which is what keeps the label association and the focus
 * ring honest.
 *
 * **Labeling.** Pass `label` for a visible group label, or `aria-label` when
 * the group is named by something the caller already rendered. One of the two
 * is required in practice: a radio group with no accessible name fails the axe
 * gate.
 */
export default function RadioGroup(props: {
  options: RadioOption[];
  value: string | null;
  onChange: (value: string) => void;
  /** The visible group label. Omit it only when `aria-label` names the group. */
  label?: JSX.Element;
  disabled?: boolean;
  /** Layout only. The keyboard model is Kobalte's either way; this tells the
   *  primitive which arrow keys to treat as forward, and drives the CSS. */
  orientation?: "vertical" | "horizontal";
  class?: string;
  itemClass?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const orientation = () => props.orientation ?? "vertical";

  return (
    <Primitive.Root
      class={[styles.root, props.class].filter(Boolean).join(" ")}
      // Never `undefined`: that is Kobalte's uncontrolled switch. See the note
      // on `null` above.
      value={props.value ?? ""}
      onChange={props.onChange}
      disabled={props.disabled}
      orientation={orientation()}
      aria-label={props["aria-label"]}
      aria-describedby={props["aria-describedby"]}
    >
      <Show when={props.label !== undefined}>
        <Primitive.Label class={styles.groupLabel}>{props.label}</Primitive.Label>
      </Show>
      <div class={styles.items} data-orientation={orientation()}>
        <For each={props.options}>
          {(option) => (
            <Primitive.Item
              class={[styles.item, props.itemClass].filter(Boolean).join(" ")}
              value={option.value}
              disabled={option.disabled}
            >
              <Primitive.ItemInput class={styles.input} />
              <Primitive.ItemControl class={styles.control}>
                <Primitive.ItemIndicator class={styles.indicator} />
              </Primitive.ItemControl>
              <div class={styles.text}>
                <Primitive.ItemLabel class={styles.label}>{option.label}</Primitive.ItemLabel>
                <Show when={option.description !== undefined}>
                  <Primitive.ItemDescription class={styles.description}>{option.description}</Primitive.ItemDescription>
                </Show>
              </div>
            </Primitive.Item>
          )}
        </For>
      </div>
    </Primitive.Root>
  );
}
