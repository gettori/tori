import { createSignal, type JSX } from "solid-js";
import styles from "./Resizer.module.css";

type Props = {
  // "x": a vertical bar dragged left/right to resize a width (default).
  // "y": a horizontal bar dragged up/down to resize a height.
  axis?: "x" | "y";
  // Which panel `value` sizes, relative to the handle: "before" (the panel that
  // precedes the handle) grows as you drag toward the end; "after" grows as you
  // drag toward the start.
  side: "before" | "after";
  value: number;
  min?: number;
  max?: number;
  onInput: (next: number) => void;
  onCommit?: () => void;
  // Rest appearance: "gutter" is invisible until hover (outer gaps between
  // surfaces); "hairline" keeps a faint line at rest (dividers inside one card).
  variant?: "gutter" | "hairline";
};

export default function Resizer(props: Props): JSX.Element {
  const axis = () => props.axis ?? "x";
  const [dragging, setDragging] = createSignal(false);

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    const horizontal = axis() === "x";
    const start = horizontal ? e.clientX : e.clientY;
    const startVal = props.value;
    const sign = props.side === "before" ? 1 : -1;
    const min = props.min ?? 0;
    const max = props.max ?? Infinity;

    // Coalesce pointer moves to one update per animation frame: a raw pointermove
    // stream can fire several times per frame, and each update relayouts heavy
    // panes (terminal, editor). One write per frame keeps the drag smooth.
    let frame = 0;
    let latest = start;
    function apply() {
      frame = 0;
      const next = startVal + (latest - start) * sign;
      props.onInput(Math.max(min, Math.min(max, next)));
    }
    function onMove(ev: PointerEvent) {
      latest = horizontal ? ev.clientX : ev.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (frame) {
        cancelAnimationFrame(frame);
        apply(); // flush the final position
      }
      document.body.classList.remove("dragging");
      setDragging(false);
      props.onCommit?.();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.classList.add("dragging");
    setDragging(true);
  }

  return (
    <div
      class={styles.resizer}
      classList={{
        [styles.x]: axis() === "x",
        [styles.y]: axis() === "y",
        [styles.hairline]: (props.variant ?? "gutter") === "hairline",
        [styles.dragging]: dragging(),
      }}
      role="separator"
      aria-orientation={axis() === "x" ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
    />
  );
}
