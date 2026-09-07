import { splitProps, type Component, type JSX } from "solid-js";
import styles from "./gitMarks.module.css";

/**
 * The two git glyphs a sidebar branch-unit row can wear, drawn here rather than
 * imported from Lucide because they animate: when a session in that unit is
 * mid-turn, a pulse runs the same path the resting glyph draws.
 *
 * The row already carries a status chip that names the state in words, so the
 * pulse is a second reading of something already on screen and never the only
 * one - which is why the marks stay `aria-hidden`, exactly as the static Lucide
 * glyphs they replace were.
 *
 * Shape is Lucide's (`git-branch`, and a folder-with-branch for a worktree),
 * kept at the same 24x24 box and stroke weight as everything else in the
 * column. At rest the mark is plain `currentColor`, indistinguishable from the
 * static glyphs beside it; only the pulse takes a colour of its own, so a row
 * that is not working never differs from its neighbours in any way.
 */

const DEFAULT_STROKE = 1.75;

/** The head of the trace runs a touch heavier than the tail it leads, so the
 *  travelling end is readable at 16px. Derived from the caller's stroke rather
 *  than fixed, or the two would part company at any other size. */
function headStroke(width: number | string | undefined): number | string {
  const n = Number(width ?? DEFAULT_STROKE);
  return Number.isFinite(n) ? n * 1.125 : (width ?? DEFAULT_STROKE);
}

export type GitMarkProps = JSX.SvgSVGAttributes<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
  /** Run the pulse. What counts as working is the caller's question; the mark
   *  only draws the answer. */
  active?: boolean;
};

function Frame(props: GitMarkProps & { mark: string; children: JSX.Element }) {
  const [local, rest] = splitProps(props, ["size", "strokeWidth", "active", "class", "mark", "children"]);
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
      data-active={local.active ? "true" : "false"}
      classList={{ [styles.mark]: true, [local.class ?? ""]: !!local.class }}
      {...rest}
    >
      {local.children}
    </svg>
  );
}

const BRANCH_LINE = "M6 21V9a9 9 0 0 0 9 9";
const FOLDER_OUTLINE =
  "M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5";
const WORKTREE_STEM = "M18 19a5 5 0 0 1-5-5v8";

/** A branch of a plain repo. */
export const BranchMark: Component<GitMarkProps> = (props) => (
  <Frame {...props} mark="branch">
    <g class={styles.base}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d={BRANCH_LINE} />
    </g>
    <g class={styles.pulse}>
      <path class={styles.tail} pathLength="100" d={BRANCH_LINE} />
      <path class={styles.head} pathLength="100" stroke-width={headStroke(props.strokeWidth)} d={BRANCH_LINE} />
      <circle class={styles.nodeTop} cx="6" cy="6" r="3" fill="currentColor" />
      <circle class={styles.nodeEnd} cx="18" cy="18" r="3" fill="currentColor" />
    </g>
  </Frame>
);

/** A worktree folder, or the .bare stub that is one waiting to happen. */
export const WorktreeMark: Component<GitMarkProps> = (props) => (
  <Frame {...props} mark="worktree">
    <g class={styles.base}>
      <path d={WORKTREE_STEM} />
      <path d={FOLDER_OUTLINE} />
      <circle cx="13" cy="12" r="2" />
      <circle cx="20" cy="19" r="2" />
    </g>
    <g class={styles.pulse}>
      <path class={styles.tail} pathLength="100" d={FOLDER_OUTLINE} />
      <path class={styles.head} pathLength="100" stroke-width={headStroke(props.strokeWidth)} d={FOLDER_OUTLINE} />
      <path class={styles.stem} pathLength="100" stroke-width={headStroke(props.strokeWidth)} d={WORKTREE_STEM} />
      <circle class={styles.nodeLeaf} cx="20" cy="19" r="2" fill="currentColor" />
      <circle class={styles.nodeFork} cx="13" cy="12" r="2" fill="currentColor" />
    </g>
  </Frame>
);
