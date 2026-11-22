import { createUniqueId, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import styles from "./Slider.module.css";

function snapToStep(value: number, min: number, max: number, step: number) {
  const remainder = (value - min) % step;
  let snapped =
    Math.abs(remainder) * 2 >= step ? value + Math.sign(remainder) * (step - Math.abs(remainder)) : value - remainder;
  if (snapped < min) snapped = min;
  else if (snapped > max) snapped = min + Math.floor((max - min) / step) * step;
  // Floating point drift would otherwise leave 1.1500000000000001 in a setting.
  const decimals = step.toString().split(".")[1]?.length ?? 0;
  if (decimals === 0) return snapped;
  const scale = 10 ** (decimals + 1);
  return Math.round(snapped * scale) / scale;
}

/**
 * A continuous value on a track.
 *
 * **Scalar, not a range.** Tori's one consumer (the ui-scale preview) is a
 * single value. If a real range ever appears, it gets its own wrapper rather
 * than a union prop on this one.
 *
 * **`onChange` fires continuously while the thumb moves**, which is what makes
 * a live preview possible: the ui-scale control applies each intermediate value
 * as it arrives.
 *
 * Unlike the checkbox and switch, the thumb is a real focusable `<span>` with
 * `role="slider"` rather than a hidden native input, because a native range
 * draws differently per engine.
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
  const baseId = createUniqueId();
  const labelId = `slider-${baseId}-label`;
  let track!: HTMLDivElement;
  let thumb!: HTMLSpanElement;
  let lastX = 0;
  let unclampedPx: number | null = null;

  const fraction = () => {
    const range = props.max - props.min;
    return range > 0 ? (props.value - props.min) / range : 0;
  };
  const state = {
    "data-orientation": "horizontal",
    get "data-disabled"() {
      return props.disabled ? "" : undefined;
    },
  };

  const setValue = (value: number) => {
    if (props.disabled) return;
    const next = snapToStep(value, props.min, props.max, props.step);
    if (next !== props.value) props.onChange(next);
  };

  const pageSize = () => {
    const tenth = (props.max - props.min) / 10;
    return Math.max(snapToStep(tenth, 0, tenth + props.step, props.step), props.step);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (props.disabled) return;
    const size = e.shiftKey ? pageSize() : props.step;
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = props.value + size;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = props.value - size;
    else if (e.key === "PageUp") next = props.value + pageSize();
    else if (e.key === "PageDown") next = props.value - pageSize();
    else if (e.key === "Home") next = props.min;
    else if (e.key === "End") next = props.max;
    else return;
    e.preventDefault();
    e.stopPropagation();
    setValue(next);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (props.disabled) return;
    const target = e.target as HTMLElement;
    e.preventDefault();
    target.setPointerCapture(e.pointerId);
    lastX = e.clientX;
    unclampedPx = null;
    if (thumb.contains(target)) {
      thumb.focus();
      return;
    }
    const box = track.getBoundingClientRect();
    setValue(props.min + ((e.clientX - box.left) / box.width) * (props.max - props.min));
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
    const { width } = track.getBoundingClientRect();
    unclampedPx = (unclampedPx ?? fraction() * width) + (e.clientX - lastX);
    lastX = e.clientX;
    const clamped = Math.min(1, Math.max(0, unclampedPx / width));
    const steps = Math.round((clamped * (props.max - props.min)) / props.step);
    setValue(Math.min(props.max, props.min + steps * props.step));
  };

  const onPointerUp = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (!target.hasPointerCapture(e.pointerId)) return;
    target.releasePointerCapture(e.pointerId);
    thumb.focus();
  };

  return (
    <div role="group" class={[styles.root, props.class].filter(Boolean).join(" ")} {...state}>
      <Show when={props.label !== undefined}>
        <label id={labelId} class={styles.label} data-disabled={props.disabled ? "" : undefined}>
          {props.label}
        </label>
      </Show>
      <div
        ref={track}
        class={styles.track}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        {...state}
      >
        <div class={styles.fill} style={{ left: "0%", right: `${100 - fraction() * 100}%` }} {...state} />
        <span
          ref={thumb}
          role="slider"
          class={styles.thumb}
          tabindex={props.disabled ? undefined : 0}
          style={{
            position: "absolute",
            left: `calc(${fraction() * 100}%)`,
            transform: "translateX(-50%)",
            "touch-action": "none",
          }}
          aria-valuetext={String(props.value)}
          aria-valuemin={props.min}
          aria-valuenow={props.value}
          aria-valuemax={props.max}
          aria-orientation="horizontal"
          aria-label={props["aria-label"]}
          aria-labelledby={props.label !== undefined ? labelId : undefined}
          onKeyDown={onKeyDown}
          {...state}
        />
      </div>
    </div>
  );
}
