import { createUniqueId, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import styles from "./RadioGroup.module.css";

/** One choice: the string the app stores, the label the user reads, and an
 *  optional second line that is part of the choice rather than a hint about
 *  it. */
export type RadioOption = {
  value: string;
  label: JSX.Element;
  description?: JSX.Element;
  disabled?: boolean;
};

/**
 * One choice out of a small fixed set, all of them visible at once.
 *
 * **Radio or Select is a density choice.** This is for a handful of options the
 * user should be able to compare side by side without opening anything, which
 * is what an agent's question is. A longer list, or one where the choice is
 * routine enough not to deserve the space, is a `<Select>`.
 *
 * **`null` is a real value and means nothing is chosen.** A question that has
 * not been answered is the common case, not an edge one, and a group that
 * arrived pre-selected would answer it for the user.
 *
 * The inputs are real `<input type="radio">`, so arrow keys move between them
 * and `getByRole("radio")` finds them without any JS of ours. We draw the dot:
 * each input is visually hidden and stays in the accessibility tree, which is
 * what keeps the label association and the focus ring honest.
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
  orientation?: "vertical" | "horizontal";
  class?: string;
  itemClass?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const orientation = () => props.orientation ?? "vertical";
  const baseId = createUniqueId();
  const groupLabelId = `radiogroup-${baseId}-label`;
  const name = `radiogroup-${baseId}`;
  let root!: HTMLDivElement;

  // A refused pick has already unchecked the previous radio natively.
  const syncChecked = () => {
    for (const radio of root.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      radio.checked = radio.value === props.value;
    }
  };

  return (
    <div
      ref={root}
      role="radiogroup"
      class={[styles.root, props.class].filter(Boolean).join(" ")}
      aria-label={props["aria-label"]}
      aria-labelledby={props.label !== undefined ? groupLabelId : undefined}
      aria-describedby={props["aria-describedby"]}
      aria-disabled={props.disabled ? "true" : undefined}
      aria-orientation={orientation() === "vertical" ? "vertical" : "horizontal"}
      data-disabled={props.disabled ? "" : undefined}
    >
      <Show when={props.label !== undefined}>
        <span id={groupLabelId} class={styles.groupLabel} data-disabled={props.disabled ? "" : undefined}>
          {props.label}
        </span>
      </Show>
      <div class={styles.items} data-orientation={orientation()}>
        <For each={props.options}>
          {(option) => {
            const itemId = createUniqueId();
            const inputId = `radio-${itemId}-input`;
            const labelId = `radio-${itemId}-label`;
            const descriptionId = `radio-${itemId}-description`;
            const state = {
              get "data-checked"() {
                return props.value === option.value ? "" : undefined;
              },
              get "data-disabled"() {
                return props.disabled || option.disabled ? "" : undefined;
              },
            };
            let input!: HTMLInputElement;
            return (
              <div role="group" class={[styles.item, props.itemClass].filter(Boolean).join(" ")} {...state}>
                <input
                  ref={input}
                  id={inputId}
                  class={styles.input}
                  type="radio"
                  name={name}
                  value={option.value}
                  checked={props.value === option.value}
                  disabled={props.disabled || option.disabled}
                  aria-labelledby={labelId}
                  aria-describedby={option.description !== undefined ? descriptionId : undefined}
                  onChange={(e) => {
                    e.stopPropagation();
                    if (!props.disabled && !option.disabled) props.onChange(option.value);
                    syncChecked();
                  }}
                  {...state}
                />
                <div
                  class={styles.control}
                  onClick={() => {
                    input.click();
                    input.focus({ preventScroll: true });
                  }}
                  {...state}
                >
                  <div class={styles.indicator} {...state} />
                </div>
                <div class={styles.text}>
                  <label
                    id={labelId}
                    for={inputId}
                    class={styles.label}
                    // WebKit does not focus an input through its label.
                    onClick={() => input.focus({ preventScroll: true })}
                    {...state}
                  >
                    {option.label}
                  </label>
                  <Show when={option.description !== undefined}>
                    <div id={descriptionId} class={styles.description} {...state}>
                      {option.description}
                    </div>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
