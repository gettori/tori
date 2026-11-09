// Which pull request this is, drawn the way the host heads one: the title with
// its number, then one line of state, author, branches and size.
//
// One component for the pull request's own tab and for the panel beside the
// branch, so the two read as the same header. `compact` is the panel's 320px:
// a smaller title, the branches on a line of their own, and no size, which the
// panel's file list already heads.

import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ArrowLeft, Copy, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-solid";
import type { LucideIcon } from "lucide-solid";
import type { PrCounts, PullRequest } from "../../../utils/forgeTypes";
import { prOpened } from "../../../utils/prMeta";
import { copyText } from "../../../utils/clipboard";
import Icon from "../../../components/Icon/Icon";
import Tooltip from "../../../components/Tooltip/Tooltip";
import DiffBlocks from "./DiffBlocks";
import styles from "./PrHeader.module.css";

type StateKey = "open" | "draft" | "merged" | "closed";

const STATE: Record<StateKey, { label: string; icon: LucideIcon }> = {
  open: { label: "Open", icon: GitPullRequest },
  draft: { label: "Draft", icon: GitPullRequestDraft },
  merged: { label: "Merged", icon: GitMerge },
  closed: { label: "Closed", icon: GitPullRequestClosed },
};

export default function PrHeader(props: { pr: PullRequest; counts: PrCounts | null; compact?: boolean }) {
  const state = (): StateKey => (props.pr.state === "open" && props.pr.isDraft ? "draft" : props.pr.state);

  return (
    <div class={styles.header} data-compact={props.compact ? "" : undefined}>
      <Dynamic component={props.compact ? "h2" : "h1"} class={styles.title}>
        {props.pr.title}{" "}
        {/* An anchor and not a button, so the middle click and the Cmd+click
            that every other link in the app answers work here too. Named in
            full, since the number alone tells a screen reader nothing about
            where it goes. */}
        <a
          class={styles.number}
          href={props.pr.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open pull request ${props.pr.number} on github.com`}
        >
          #{props.pr.number}
        </a>
      </Dynamic>

      <div class={styles.summary}>
        <span class={styles.state} data-state={state()}>
          <Icon icon={STATE[state()].icon} size={14} aria-hidden="true" />
          {STATE[state()].label}
        </span>
        <span class={styles.byline}>
          <strong class={styles.author}>{props.pr.author}</strong>
          <Show when={prOpened(props.pr)}>{(o) => <> {o()}</>}</Show>
        </span>
        <span class={styles.where}>
          <span class={styles.branches}>
            <span class={styles.branch}>
              <span class={styles.branchName}>{props.pr.baseRef}</span>
            </span>
            <Icon icon={ArrowLeft} size={14} class={styles.arrow} aria-label="from" />
            <span class={styles.branch}>
              <span class={styles.branchName}>{props.pr.headRef}</span>
              <Tooltip
                class={styles.copy}
                label="Copy the branch name"
                aria-label="Copy the branch name"
                onClick={() => void copyText(props.pr.headRef)}
              >
                <Icon icon={Copy} size={12} aria-hidden="true" />
              </Tooltip>
            </span>
          </span>
          {/* Absent until the detail read lands rather than zeroed: "+0 -0" is
              a size, and it would be the wrong one. */}
          <Show when={!props.compact && props.counts}>
            {(c) => (
              <span class={styles.diffstat}>
                <span class={styles.added}>+{c().additions}</span>
                <span class={styles.removed}>-{c().deletions}</span>
                <DiffBlocks additions={c().additions} deletions={c().deletions} />
              </span>
            )}
          </Show>
        </span>
      </div>
    </div>
  );
}
