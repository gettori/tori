import type { JSX } from "solid-js";
import styles from "./MiniWindow.module.css";

/** A Tori window in miniature: real components laid out at their own size,
 *  then zoomed down to `height` px, so the picture is the app rather than a
 *  copy of it. Inert, so nothing in it takes focus or a click. */
export default function MiniWindow(props: {
  /** Rendered height in px before `--ui-scale`. */
  height: number;
  /** How far the contents shrink, 0.5 is half size. */
  zoom: number;
  /** Centred in the title bar, beside the window buttons. */
  bar?: JSX.Element;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <div class={`${styles.window} ${props.class ?? ""}`} style={{ "--h": props.height }} inert>
      <div class={styles.mini} style={{ zoom: props.zoom, "--z": props.zoom }}>
        <div class={styles.titleBar}>
          <span class={styles.lights}>
            <span />
            <span />
            <span />
          </span>
          {props.bar}
        </div>
        <div class={styles.body}>{props.children}</div>
      </div>
    </div>
  );
}
