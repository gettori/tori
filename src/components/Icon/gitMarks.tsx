import { splitProps, type Component } from "solid-js";
import { FolderGit2, GitMerge } from "lucide-solid";
import Icon, { type IconProps } from "./Icon";
import { brandMark } from "./agentMarks";
import styles from "./gitMarks.module.css";

/**
 * Git's own logo, the logos of the hosts Tori signs in to, and the two git
 * glyphs a sidebar branch-unit row can wear.
 *
 * The row glyphs are Lucide's `folder-git-2` and `git-merge`, wrapped so the
 * state a row carries is drawn in the glyph's own ink: `current` fills the
 * branch tip and brightens, `stub` dashes the folder outline, `active` (a
 * session mid-turn) fills every node. Still rather than looping: motion inside
 * an SVG lays out and repaints every frame, and the row's status chip already
 * moves.
 *
 * The chip names the state in words, so the fill is a second reading of
 * something already on screen and never the only one - which is why the marks
 * stay `aria-hidden`, exactly as the static Lucide glyphs beside them.
 */

export type GitMarkProps = Omit<IconProps, "icon"> & {
  /** A session here is mid-turn. What counts as working is the caller's
   *  question; the mark only draws the answer. */
  active?: boolean;
  /** This is git's checked-out branch here: the mark fills its tip node and
   *  steps out of the column's muted tone. */
  current?: boolean;
};

function Mark(props: GitMarkProps & { icon: IconProps["icon"]; mark: string }) {
  const [local, rest] = splitProps(props, ["active", "current", "class", "mark"]);
  return (
    <Icon
      aria-hidden="true"
      data-mark={local.mark}
      data-active={local.active ? "true" : "false"}
      data-current={local.current ? "true" : undefined}
      classList={{ [styles.mark]: true, [local.class ?? ""]: !!local.class }}
      {...rest}
    />
  );
}

/** A branch of a plain repo. */
export const BranchMark: Component<GitMarkProps> = (props) => <Mark {...props} icon={GitMerge} mark="branch" />;

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
  return <Mark {...rest} icon={FolderGit2} mark="worktree" data-stub={local.stub ? "true" : undefined} />;
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
