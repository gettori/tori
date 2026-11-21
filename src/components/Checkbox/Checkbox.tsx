import { createEffect, createUniqueId, Show, type JSX } from "solid-js";
import { Check, Minus } from "../Icon/icons";
import Icon from "../Icon/Icon";
import styles from "./Checkbox.module.css";

/**
 * A boolean option that scopes an action.
 *
 * **Checkbox or Switch is a semantic choice, not a visual one** (#107). This is
 * for an option the user sets *before* confirming something - the dialog
 * checkboxes, ReviewPanel's amend and untracked toggles - where the box reads
 * as "included in what I am about to do". A setting that takes effect the
 * instant it flips is a `<Switch>` instead.
 *
 * The control is a real `<input type="checkbox">`, so
 * Space toggles it without any JS of ours and `getByRole("checkbox")` finds it.
 * We draw the box: the input itself is visually hidden and stays in the accessi-
 * bility tree, which is what keeps the label association and the focus ring
 * honest.
 *
 * `aria-describedby` is passed through to that input rather than to the root,
 * because the sr-only hint spans the call sites own (ReviewPanel,
 * CheckpointTimeline) have to be announced against the control, not the group.
 */
export default function Checkbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Some of what this box stands for, not all of it: a folder whose files are
   *  half read. Drawn as a dash, since a tick for "some" is a lie the reader
   *  acts on. */
  indeterminate?: boolean;
  /** The visible label. Omit it only when `aria-label` names the control. */
  label?: JSX.Element;
  /** `sm` is the box for a dense list row, where the form-sized one reads as a
   *  control with a list around it. Everything else stays the default. */
  size?: "sm";
  disabled?: boolean;
  class?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const baseId = createUniqueId();
  const inputId = `checkbox-${baseId}-input`;
  const labelId = `checkbox-${baseId}-label`;
  const state = {
    get "data-checked"() {
      return props.checked ? "" : undefined;
    },
    get "data-indeterminate"() {
      return props.indeterminate ? "" : undefined;
    },
    get "data-disabled"() {
      return props.disabled ? "" : undefined;
    },
  };
  let input!: HTMLInputElement;

  createEffect(() => {
    input.indeterminate = !!props.indeterminate;
  });

  return (
    <div role="group" class={[styles.root, props.class].filter(Boolean).join(" ")} {...state}>
      <input
        ref={input}
        id={inputId}
        class={styles.input}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props["aria-label"]}
        aria-labelledby={props.label !== undefined ? labelId : undefined}
        aria-describedby={props["aria-describedby"]}
        aria-disabled={props.disabled ? "true" : undefined}
        onChange={(e) => {
          e.stopPropagation();
          const el = e.currentTarget;
          if (!props.disabled) props.onChange(el.checked);
          el.checked = props.checked;
          el.indeterminate = !!props.indeterminate;
        }}
        {...state}
      />
      <div
        class={[styles.control, props.size === "sm" && styles.sm].filter(Boolean).join(" ")}
        onClick={() => {
          input.click();
          input.focus({ preventScroll: true });
        }}
        {...state}
      >
        <div class={styles.indicator} {...state}>
          <Icon icon={props.indeterminate ? Minus : Check} size={props.size === "sm" ? 11 : 15} strokeWidth={3} />
        </div>
      </div>
      <Show when={props.label !== undefined}>
        <label
          id={labelId}
          for={inputId}
          class={styles.label}
          // WebKit does not focus an input through its label.
          onClick={() => input.focus({ preventScroll: true })}
          {...state}
        >
          {props.label}
        </label>
      </Show>
    </div>
  );
}
