import { For, type JSX } from "solid-js";
import styles from "./SegmentedControl.module.css";
import { nextSegmentIndex, type ControlSize } from "../controls";

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
 *  group, the selected segment filled. Roving tabindex + arrow-key navigation
 *  (see `nextSegmentIndex`); only the selected segment is in the tab order. */
export default function SegmentedControl<T extends string>(
  props: SegmentedControlProps<T>,
) {
  let group: HTMLDivElement | undefined;

  const onKeyDown = (e: KeyboardEvent) => {
    const current = props.options.findIndex((o) => o.value === props.value);
    const next = nextSegmentIndex(current, e.key, props.options.length);
    if (next === current) return;
    e.preventDefault();
    props.onChange(props.options[next].value);
    // Move focus to the newly selected segment so the roving index follows.
    group?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={props["aria-label"]}
      onKeyDown={onKeyDown}
      class={props.class}
      classList={{
        [styles.group]: true,
        [styles[props.size ?? "md"]]: true,
      }}
    >
      <For each={props.options}>
        {(opt) => {
          const selected = () => opt.value === props.value;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={selected()}
              aria-label={opt["aria-label"]}
              tabindex={selected() ? 0 : -1}
              classList={{ [styles.segment]: true, [styles.selected]: selected() }}
              onClick={() => props.onChange(opt.value)}
            >
              {opt.icon}
              {opt.label != null && <span>{opt.label}</span>}
            </button>
          );
        }}
      </For>
    </div>
  );
}
