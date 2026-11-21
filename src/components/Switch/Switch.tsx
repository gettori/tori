import { createUniqueId, Show, type JSX } from "solid-js";
import Tooltip from "../Tooltip/Tooltip";
import styles from "./Switch.module.css";

/**
 * A setting that takes effect the instant it flips.
 *
 * **Switch or Checkbox is a semantic choice, not a visual one** (#107). This is
 * for a boolean whose flip *is* the action - every Settings toggle, and the
 * view filters in SessionPanel and CheckpointTimeline. An option that only
 * scopes some later confirmation is a `<Checkbox>` instead.
 *
 * The control is a real `<input type="checkbox">` carrying `role="switch"`,
 * so Space toggles it with no JS of ours, screen readers announce it as a
 * switch, and `getByRole("switch")` finds it. The track and thumb are ours; the
 * input is visually hidden and stays in the accessibility tree.
 *
 * `aria-describedby` is passed through to that input, for the sr-only hints the
 * panel call sites keep alongside their toggles.
 */
export default function Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The visible label. Omit it only when `aria-label` names the control. */
  label?: JSX.Element;
  /**
   * A hover description, on the track.
   *
   * The track rather than the input, which is the trigger `Tooltip` would
   * rather have: the input is visually hidden at 1px, so a popper anchored on
   * it lands nowhere near the switch. That trade costs the keyboard path, so
   * this is a mouse affordance only and a call site passing it still has to
   * name the control with `aria-label` - which is the rule for a tooltip
   * anywhere in Tori, since a tooltip is a description and never a name.
   *
   * Absent renders the bare track with no tooltip machinery around it, so the
   * switches that want no tooltip pay for none.
   */
  tooltip?: JSX.Element;
  disabled?: boolean;
  /** Refusing, but still focusable. `disabled` takes the input out of the tab
   *  order, and with it any `aria-describedby` reason for the refusal, so a
   *  caller that has one to give uses this and rejects the change itself. */
  "aria-disabled"?: boolean;
  class?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const baseId = createUniqueId();
  const inputId = `switch-${baseId}-input`;
  const labelId = `switch-${baseId}-label`;
  const state = {
    get "data-checked"() {
      return props.checked ? "" : undefined;
    },
    get "data-disabled"() {
      return props.disabled ? "" : undefined;
    },
  };
  let input!: HTMLInputElement;

  return (
    <div role="group" class={[styles.root, props.class].filter(Boolean).join(" ")} {...state}>
      <input
        ref={input}
        id={inputId}
        class={styles.input}
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        aria-checked={props.checked ? "true" : "false"}
        aria-label={props["aria-label"]}
        aria-labelledby={props.label !== undefined ? labelId : undefined}
        aria-describedby={props["aria-describedby"]}
        aria-disabled={props.disabled || props["aria-disabled"] ? "true" : undefined}
        onChange={(e) => {
          e.stopPropagation();
          const el = e.currentTarget;
          if (!props.disabled) props.onChange(el.checked);
          el.checked = props.checked;
        }}
        {...state}
      />
      <Tooltip<HTMLDivElement>
        as="div"
        class={styles.control}
        label={props.tooltip}
        onClick={() => {
          input.click();
          input.focus({ preventScroll: true });
        }}
        {...state}
      >
        <div class={styles.thumb} {...state} />
      </Tooltip>
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
