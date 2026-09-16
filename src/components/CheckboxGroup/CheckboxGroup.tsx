import { For, Show, createUniqueId, type JSX } from "solid-js";
import Checkbox from "../Checkbox/Checkbox";
import styles from "./CheckboxGroup.module.css";

/** One choice: the string the app stores, the label the user reads, and an
 *  optional second line that is part of the choice rather than a hint about
 *  it. Deliberately the same shape as `RadioOption`, so a caller that only
 *  learns at runtime whether a question takes one answer or several does not
 *  have to reshape its options to pick a component. */
export type CheckboxOption = {
  value: string;
  label: JSX.Element;
  description?: JSX.Element;
  disabled?: boolean;
};

/**
 * Any number of choices out of a small fixed set: the multi-select counterpart
 * to `<RadioGroup>`.
 *
 * **Composed from `<Checkbox>` rather than wrapped around a primitive**, because
 * Kobalte 0.13.13 has a `checkbox` and no `checkbox-group`. There is nothing to
 * re-export through `src/lib/`, so this component is the group behaviour: the
 * `role="group"` and its accessible name, the value array, and the per-option
 * toggle. Everything the boxes themselves do is already `<Checkbox>`'s, which
 * is where the Kobalte seam stays.
 *
 * **Array in, array out.** The caller owns the selection; every toggle reports
 * the whole next array rather than a delta, so a call site cannot end up
 * applying two toggles to one stale array. Order follows `options`, not click
 * order, which is what keeps a synthesized answer string stable no matter which
 * box the user hit first.
 *
 * **Vertical only, unlike `<RadioGroup>`.** Not an oversight: a multi-select
 * question is 20 of 550 in the measured corpus and every one of them stacks,
 * and an option the user may combine with another needs its own line far more
 * than a mutually exclusive one does. Add the prop when something asks for it.
 *
 * **The group is a `role="group"`, not a fieldset.** A native `<fieldset>`
 * brings layout and legend behaviour that fights the rest of Tori's chrome, and
 * an ARIA group with `aria-labelledby` gives the same announcement without it.
 */
export default function CheckboxGroup(props: {
  options: CheckboxOption[];
  value: string[];
  onChange: (value: string[]) => void;
  /** The visible group label. Omit it only when `aria-label` names the group. */
  label?: JSX.Element;
  disabled?: boolean;
  class?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const labelId = createUniqueId();

  const toggle = (option: CheckboxOption, checked: boolean) => {
    const next = checked
      ? // Rebuilt from `options` rather than appended, so the reported order is
        // the order the user read, not the order they clicked. Rebuilding also
        // drops any value `props.value` holds that no option declares, which is
        // the behaviour a stale selection wants: the group can only report
        // answers the user was actually offered.
        props.options.filter((o) => o.value === option.value || props.value.includes(o.value)).map((o) => o.value)
      : props.value.filter((v) => v !== option.value);
    props.onChange(next);
  };

  return (
    <div
      role="group"
      class={[styles.root, props.class].filter(Boolean).join(" ")}
      aria-label={props["aria-label"]}
      aria-labelledby={props.label !== undefined ? labelId : undefined}
      aria-describedby={props["aria-describedby"]}
    >
      <Show when={props.label !== undefined}>
        <div id={labelId} class={styles.groupLabel}>
          {props.label}
        </div>
      </Show>
      <div class={styles.items}>
        <For each={props.options}>
          {(option) => {
            const descriptionId = createUniqueId();
            return (
              <div class={styles.item}>
                <Checkbox
                  checked={props.value.includes(option.value)}
                  onChange={(checked) => toggle(option, checked)}
                  disabled={props.disabled || option.disabled}
                  label={option.label}
                  aria-describedby={option.description !== undefined ? descriptionId : undefined}
                />
                <Show when={option.description !== undefined}>
                  <div id={descriptionId} class={styles.description}>
                    {option.description}
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
