import { Show, type JSX } from "solid-js";
import { Check, Minus } from "lucide-solid";
import { Checkbox as Primitive } from "../../lib/checkbox";
import Icon from "../Icon/Icon";
import styles from "./Checkbox.module.css";

/**
 * A boolean option that scopes an action: Kobalte's checkbox behind Tori's
 * chrome and Tori's API.
 *
 * **Checkbox or Switch is a semantic choice, not a visual one** (#107). This is
 * for an option the user sets *before* confirming something - the dialog
 * checkboxes, ReviewPanel's amend and untracked toggles - where the box reads
 * as "included in what I am about to do". A setting that takes effect the
 * instant it flips is a `<Switch>` instead.
 *
 * The native input Kobalte renders is a real `<input type="checkbox">`, so
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
  return (
    <Primitive.Root
      class={[styles.root, props.class].filter(Boolean).join(" ")}
      checked={props.checked}
      indeterminate={props.indeterminate}
      onChange={props.onChange}
      disabled={props.disabled}
    >
      <Primitive.Input
        class={styles.input}
        aria-label={props["aria-label"]}
        aria-describedby={props["aria-describedby"]}
      />
      <Primitive.Control class={[styles.control, props.size === "sm" && styles.sm].filter(Boolean).join(" ")}>
        {/* Always mounted: Kobalte's mount-on-check runs the tick through
            solid-presence, whose lazily computed style under jsdom 30 reads a
            document the element has left, and an uncheck inside a Dialog throws.
            CSS hides it instead. */}
        <Primitive.Indicator class={styles.indicator} forceMount>
          <Icon icon={props.indeterminate ? Minus : Check} size={props.size === "sm" ? 11 : 15} strokeWidth={3} />
        </Primitive.Indicator>
      </Primitive.Control>
      <Show when={props.label !== undefined}>
        <Primitive.Label class={styles.label}>{props.label}</Primitive.Label>
      </Show>
    </Primitive.Root>
  );
}
