import { For, type JSX } from "solid-js";
import { ToggleGroup } from "../../lib/toggle-group";
import styles from "./SegmentedControl.module.css";
import { type ControlSize } from "../controls";

/**
 * One segment, which always has a name.
 *
 * The requirement is in the type rather than in this sentence, which is the
 * point of the shape (#116): a segment carries visible text, or it carries an
 * `aria-label`, and one of the two is not optional. Documenting it as a rule and
 * typing both halves as optional is how an icon-only segment with no name at all
 * shipped and reached axe as `button-name`, impact critical.
 *
 * `Button` cannot be fixed this way and warns at runtime instead: its name is
 * conditional on what it renders and can be backfilled from a tooltip, neither
 * of which a prop type can see. Here there is nothing to infer.
 *
 * `NonNullable` because Solid types `JSX.Element` as including `undefined`, so a
 * bare `label: JSX.Element` would be satisfied by an explicit `label={undefined}`
 * and the union would promise more than it checks.
 */
export type SegmentedOption<T extends string> = {
  value: T;
  /** Leading glyph. */
  icon?: JSX.Element;
} & (
  | {
      /** Visible text, which names the segment. */
      label: NonNullable<JSX.Element>;
      /** Replaces the visible text as the name; rarely what you want here. */
      "aria-label"?: string;
    }
  | {
      /** No visible text: this is an icon-only segment. */
      label?: undefined;
      /** The segment's only name, so it is required. */
      "aria-label": string;
    }
);

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: ControlSize;
  /** `boxed` is the bordered strip. `plain` drops the box and the dividers and
   *  rounds the pressed segment, for a row that reads as tabs rather than as a
   *  control (the sidebar's Spaces/Features). */
  variant?: "boxed" | "plain";
  /** Names the group for assistive tech. */
  "aria-label"?: string;
  class?: string;
}

/** A single-select strip of segments on the shared control tokens: one bordered
 *  group, the selected segment filled. Kobalte's toggle group underneath, so
 *  segments are toggle buttons (`aria-pressed`), arrows/Home/End move focus
 *  without selecting, and Space/Enter select the focused segment; Tab enters
 *  on the selected one.
 *
 *  Two contract points Kobalte does not give for free:
 *
 *  **Always exactly one selected.** Kobalte's single mode lets a press on the
 *  pressed segment clear the selection (`onChange(null)`); this control's API
 *  has no empty state, so that change is dropped and the controlled `value`
 *  holds.
 *
 *  **Activation keys stay inside.** Kobalte selects on Enter/Space keydown and
 *  lets the event bubble, and both dialog consumers confirm on a form-level
 *  Enter, so one keystroke would select a segment *and* submit the dialog.
 *  Stopping propagation here makes the rule predictable: Enter inside the
 *  strip selects, confirming needs focus outside it. */
export default function SegmentedControl<T extends string>(
  props: SegmentedControlProps<T>,
) {
  const onChange = (value: string | string[] | null) => {
    if (value == null || Array.isArray(value)) return;
    if (value !== props.value) props.onChange(value as T);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  };

  return (
    <ToggleGroup.Root
      value={props.value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      aria-label={props["aria-label"]}
      class={props.class}
      classList={{
        [styles.group]: true,
        [styles[props.size ?? "md"]]: true,
        [styles.plain]: props.variant === "plain",
      }}
    >
      <For each={props.options}>
        {(opt) => (
          <ToggleGroup.Item
            value={opt.value}
            aria-label={opt["aria-label"]}
            class={styles.segment}
          >
            {opt.icon}
            {opt.label != null && <span>{opt.label}</span>}
          </ToggleGroup.Item>
        )}
      </For>
    </ToggleGroup.Root>
  );
}
