import { Show, type JSX } from "solid-js";
import { Slider as Primitive } from "../../lib/slider";
import styles from "./Slider.module.css";

/**
 * A continuous value on a track: Kobalte's slider behind Tori's chrome and
 * Tori's API.
 *
 * **Scalar, not a range.** Kobalte models every slider as a `number[]` because
 * it supports multi-thumb ranges; Tori's one consumer (the ui-scale preview) is
 * a single value, so the array is unwrapped here rather than at every call
 * site. If a real range ever appears, it gets its own wrapper rather than a
 * union prop on this one.
 *
 * **`onChange` fires continuously while the thumb moves**, which is what makes
 * a live preview possible: the ui-scale control applies each intermediate value
 * as it arrives. Kobalte also offers `onChangeEnd` (drop only) - deliberately
 * not exposed, because nothing wants it and a preview that only updated on
 * release would be the regression this wrapper exists to avoid.
 *
 * Unlike the checkbox and switch, the thumb is a real focusable `<span>` with
 * `role="slider"` rather than a hidden native input, so the arrow keys are
 * Kobalte's own handlers and the thumb itself carries the value and the label
 * association. Kobalte's `Input` part is deliberately not composed here - see
 * `lib/slider.ts` for why it would nest one slider inside another.
 */
export default function Slider(props: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  /** The visible label. Omit it only when `aria-label` names the control. */
  label?: JSX.Element;
  disabled?: boolean;
  class?: string;
  "aria-label"?: string;
}) {
  return (
    <Primitive.Root
      class={[styles.root, props.class].filter(Boolean).join(" ")}
      value={[props.value]}
      // Kobalte hands back the whole thumb array; with one thumb the first entry
      // is the value. Falling back to the current value rather than to 0 keeps a
      // malformed event from yanking the control to its minimum.
      onChange={(next) => props.onChange(next[0] ?? props.value)}
      minValue={props.min}
      maxValue={props.max}
      step={props.step}
      disabled={props.disabled}
    >
      <Show when={props.label !== undefined}>
        <Primitive.Label class={styles.label}>{props.label}</Primitive.Label>
      </Show>
      <Primitive.Track class={styles.track}>
        <Primitive.Fill class={styles.fill} />
        <Primitive.Thumb class={styles.thumb} aria-label={props["aria-label"]} />
      </Primitive.Track>
    </Primitive.Root>
  );
}
