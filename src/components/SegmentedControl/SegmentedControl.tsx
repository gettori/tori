import { For, type JSX } from "solid-js";
import { ToggleGroup } from "../../lib/toggle-group";
import styles from "./SegmentedControl.module.css";
import { type ControlSize } from "../controls";

export interface SegmentedOption<T extends string> {
  value: T;
  /** Visible text; optional for an icon-only segment (then pass `label` via `aria`). */
  label?: JSX.Element;
  /** Leading glyph. */
  icon?: JSX.Element;
  /** Accessible name, required when there is no text `label`. */
  "aria-label"?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: ControlSize;
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
