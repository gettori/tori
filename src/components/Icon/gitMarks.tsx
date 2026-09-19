import { splitProps, type Component, type JSX } from "solid-js";
import { brandMark } from "./agentMarks";
import styles from "./gitMarks.module.css";

/**
 * Git's own logo, the logos of the hosts Tori signs in to, and the two git
 * glyphs a sidebar branch-unit row can wear.
 * The row glyphs are drawn here rather than imported from Lucide because they animate: when a session in that unit is
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
 * static glyphs beside it; only the pulse takes a colour of its own. The two
 * states the mark carries are both drawn in the glyph's own ink: `current`
 * fills the branch tip and brightens, `stub` dashes the folder outline.
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
  /** This is git's checked-out branch here: the mark fills its tip node and
   *  steps out of the column's muted tone. */
  current?: boolean;
};

function Frame(props: GitMarkProps & { mark: string; children: JSX.Element }) {
  const [local, rest] = splitProps(props, ["size", "strokeWidth", "active", "current", "class", "mark", "children"]);
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
      data-current={local.current ? "true" : undefined}
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
      <circle class={styles.tip} cx="18" cy="18" r="3" />
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

/** A worktree folder, or the .bare stub that is one waiting to happen.
 *
 *  `stub` is that second case drawn rather than labelled: a `.bare` with no
 *  worktrees still holds its branches, and only the working folder is missing,
 *  so the folder outline goes to a dashed line and the branch it would contain
 *  stays solid. The row said this in a `stub` pill before; the pill was a third
 *  thing in an end cluster that already carries the sync run, the forge chip
 *  and the rollup, and this says it in the glyph the row has anyway. */
export const WorktreeMark: Component<GitMarkProps & { stub?: boolean }> = (props) => {
  const [local, rest] = splitProps(props, ["stub"]);
  return (
  <Frame {...rest} mark="worktree" data-stub={local.stub ? "true" : undefined}>
    <g class={styles.base}>
      <path d={WORKTREE_STEM} />
      <path d={FOLDER_OUTLINE} classList={{ [styles.stub]: local.stub }} />
      <circle cx="13" cy="12" r="2" />
      <circle class={styles.tip} cx="20" cy="19" r="2" />
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
};

/** Git's logo, where the tool itself is named. Jason Long's mark, CC BY 3.0
 *  (https://git-scm.com/community/logos), as Simple Icons' 24x24 path. Unlike the
 *  CC0 agent marks it carries that attribution. Monochromed to `currentColor`
 *  like them, rather than the brand orange. */
export const GitLogo = brandMark(
  "M13.09 23.549a1.54 1.54 0 0 1-2.18 0L.451 13.089a1.54 1.54 0 0 1 0-2.179l7.191-7.19 2.733 2.733a1.85 1.85 0 0 0 .964 2.326v6.66a1.849 1.849 0 1 0 1.54 0V8.957l2.508 2.508a1.85 1.85 0 1 0 1.09-1.09l-2.634-2.634a1.85 1.85 0 0 0-2.378-2.377L8.73 2.63 10.91.451a1.54 1.54 0 0 1 2.179 0l10.459 10.46a1.54 1.54 0 0 1 0 2.179z",
);

/** GitHub's mark, as Simple Icons publishes it (CC0), for github.com and
 *  Enterprise hosts alike. */
export const GitHubLogo = brandMark(
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
);

/** GitLab's mark, as Simple Icons publishes it (CC0), for gitlab.com and
 *  self-managed instances alike. */
export const GitLabLogo = brandMark(
  "m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z",
);
