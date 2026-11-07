import { splitProps, type Component, type JSX } from "solid-js";
import styles from "./statusMarks.module.css";

/**
 * The three session states a sidebar rollup chip can wear: working, waiting on
 * you, and done.
 * Drawn here rather than imported from Lucide because they animate, on the same
 * terms as the git marks: the glyph keeps the chip's own hue through
 * `currentColor`, and only the light that passes through it takes the brighter
 * foreground.
 *
 * The chip names the state in its `title`, so the marks stay `aria-hidden`,
 * exactly as the static Lucide glyphs they replace were.
 *
 * Working loops for as long as it is mounted. The other two draw themselves
 * once and rest, since a question or a finished turn is an event, and a glyph
 * that kept redrawing would read as still working.
 */

const DEFAULT_STROKE = 1.75;

/** The travelling tip runs a touch heavier than the ink it leads, as the git
 *  marks' head does, so it is readable at 14px. */
function tipStroke(width: number | string | undefined): number | string {
  const n = Number(width ?? DEFAULT_STROKE);
  return Number.isFinite(n) ? n * 1.125 : (width ?? DEFAULT_STROKE);
}

export type StatusMarkProps = JSX.SvgSVGAttributes<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
  /** Run the animation. Off, the mark is its resting glyph, which is what a
   *  picture of the sidebar wants. */
  animate?: boolean;
};

function Frame(props: StatusMarkProps & { mark: string; children: JSX.Element }) {
  const [local, rest] = splitProps(props, ["size", "strokeWidth", "animate", "class", "mark", "children"]);
  return (
    <svg
      viewBox="0 0 24 24"
      width={local.size ?? 16}
      height={local.size ?? 16}
      fill="none"
      stroke="currentColor"
      stroke-width={local.strokeWidth ?? DEFAULT_STROKE}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      data-mark={local.mark}
      data-animate={local.animate ? "true" : "false"}
      classList={{ [styles.mark]: true, [local.class ?? ""]: !!local.class }}
      {...rest}
    >
      {local.children}
    </svg>
  );
}

const QUESTION_CURVE = "M8 7a4 4 0 1 1 6.5 3.12C13 11.2 12 12 12 14";
// Lucide's check, reversed so the pen starts at the short left stroke.
const CHECK_LINE = "M4 12 9 17 20 6";

/** A session waiting on an approval or an answer. */
export const QuestionMark: Component<StatusMarkProps> = (props) => (
  <Frame {...props} mark="question">
    <path class={styles.ink} pathLength="100" d={QUESTION_CURVE} />
    <path class={styles.tip} pathLength="100" stroke-width={tipStroke(props.strokeWidth)} d={QUESTION_CURVE} />
    <circle class={styles.point} cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
  </Frame>
);

/** A session whose turn has finished. */
export const CheckMark: Component<StatusMarkProps> = (props) => (
  <Frame {...props} mark="check">
    <path class={styles.ink} pathLength="100" d={CHECK_LINE} />
    <path class={styles.tip} pathLength="100" stroke-width={tipStroke(props.strokeWidth)} d={CHECK_LINE} />
  </Frame>
);

/** A session mid-turn.
 *
 *  Each part is an `<svg>` of its own rather than a shape inside one: motion
 *  inside an SVG lays out and repaints every frame, while an `<svg>` element
 *  that only moves and fades is left to the compositor. (A box around the
 *  `<svg>` is not: WebKit lays that out every frame too, measured.) The first
 *  dot is last so it stays over the left chevron as that springs inward. */
export const WorkingMark: Component<Pick<StatusMarkProps, "size" | "strokeWidth" | "animate" | "class">> = (props) => {
  const piece = (classes: string, d: string) => (
    <svg
      viewBox="0 0 24 24"
      width={props.size ?? 16}
      height={props.size ?? 16}
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? DEFAULT_STROKE}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={`${styles.piece} ${classes}`}
    >
      <path d={d} />
    </svg>
  );
  return (
    <span
      aria-hidden="true"
      data-mark="working"
      data-animate={props.animate ? "true" : "false"}
      classList={{ [styles.mark]: true, [styles.working]: true, [props.class ?? ""]: !!props.class }}
    >
      {piece(`${styles.dot} ${styles.dot2}`, "M12 12h.01")}
      {piece(`${styles.dot} ${styles.dot3}`, "M16 12h.01")}
      {piece(styles.right, "m17 7 5 5-5 5")}
      {piece(styles.left, "m7 7-5 5 5 5")}
      {piece(`${styles.dot} ${styles.dot1}`, "M8 12h.01")}
      {piece(`${styles.spark} ${styles.dot1}`, "M8 12h.01")}
      {piece(`${styles.spark} ${styles.dot2}`, "M12 12h.01")}
      {piece(`${styles.spark} ${styles.dot3}`, "M16 12h.01")}
    </span>
  );
};
