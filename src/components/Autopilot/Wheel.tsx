import { Show, splitProps } from "solid-js";
import type { LucideProps } from "lucide-solid";
import { badgeCount, type AutopilotState } from "./autopilot";
import styles from "./Wheel.module.css";

const SPOKES =
  "M14.6 12H22.2M13.84 13.84L19.21 19.21M12 14.6V22.2M10.16 13.84L4.79 19.21M9.4 12H1.8M10.16 10.16L4.79 4.79M12 9.4V1.8M13.84 10.16L19.21 4.79";

/** The bare wheel, shaped like a lucide icon so an icon slot can take it. */
export function WheelGlyph(props: LucideProps) {
  const [local, rest] = splitProps(props, ["size", "strokeWidth"]);
  return (
    <svg
      width={local.size ?? 24}
      height={local.size ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={local.strokeWidth ?? 2.3}
      stroke-linecap="round"
      {...rest}
    >
      <circle cx="12" cy="12" r="6.6" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <path d={SPOKES} />
    </svg>
  );
}

export interface WheelProps {
  state: AutopilotState;
  /** Pending decisions, shown as a badge in the needs state. */
  count?: number;
  /** Sits on an active (tinted) segment, so idle and working take the tint's text. */
  active?: boolean;
  /** Recede to the subtle tone, for a mark that is history rather than news:
   *  a row the autopilot started but is not driving now. */
  quiet?: boolean;
  /** Side in px before `--ui-scale`. */
  size?: number;
  class?: string;
}

/** The autopilot's mark. Each state differs by shape, not only by colour: a
 *  strike when off, a turn while working, a count when it needs you, a "!" on
 *  error. Decorative, since whatever carries it names the state in text. */
export default function Wheel(props: WheelProps) {
  return (
    <span
      class={styles.wheel}
      classList={{ [props.class ?? ""]: !!props.class }}
      data-state={props.state}
      data-active={props.active ? "true" : "false"}
      data-quiet={props.quiet ? "true" : undefined}
      style={{ "--wheel-size": `${props.size ?? 14}px` }}
      aria-hidden="true"
    >
      <WheelGlyph class={styles.glyph} />
      <Show when={props.state === "off"}>
        <span class={styles.strike} />
      </Show>
      <Show when={props.state === "working"}>
        <span class={styles.stillDot} />
      </Show>
      <Show when={props.state === "needs"}>
        <span class={styles.badge}>{badgeCount(props.count ?? 1)}</span>
      </Show>
      <Show when={props.state === "error"}>
        <span class={styles.error}>!</span>
      </Show>
    </span>
  );
}
