// Every open pull request on a project, in one list.
//
// Drawn in two places and owned by neither: the right pane's Pull Requests
// mode, and its own tab in the stage. What a row *does* when it is picked
// differs between them, so that is the one thing the caller supplies; the rows,
// the refresh, and every reason the list is empty are the same wherever it is
// drawn.
//
// ## Where each column comes from
//
// The **list** comes from `prListStore`, which owns the request and outlives
// every view of it. This one never fetches; it says when (`ensure` on mount, a
// reload on Refresh, on the pause lifting, and on a pull request opened
// elsewhere), and the store decides what that costs.
//
// The **checks and the review verdict** are read from the poll store, never
// fetched here. That is what stops a row and its sidebar chip from being two
// answers to one question, and it costs nothing: the poller has already asked.
// The price is that a branch the poller has not reached shows no checks, which
// is the same honest blank the chip shows, for the same reason.

import { createEffect, createMemo, on, onCleanup, For, Show } from "solid-js";
import { onWith, PR_OPENED, type PrOpened } from "../../../utils/events";
import { forgeBadges } from "../../../utils/forgeChip";
import { projectPathFor } from "../../../utils/sessionActivity";
import ForgeChipView from "../../../components/ForgeChip/ForgeChip";
import {
  forgePause,
  forgeRepo,
  resolveForgeRepo,
  unitStatus,
  uncoveredUnits,
  pollNow,
} from "../../../utils/forgeStatus";
import { ensurePrList, forgetPrList, prListEntry, reloadPrList } from "../../../utils/prListStore";
import type { PullRequest } from "../../../utils/forgeTypes";
import Button from "../../../components/Button/Button";
import styles from "./PrList.module.css";

/** The sentence for each reason polling is paused, and what to do about it.
 *  These plus a genuinely empty list are four ways of rendering no rows, and a
 *  list that draws the same blank for all of them leaves the user with no idea
 *  which one they are in. */
const PAUSED_COPY = {
  disabled: "GitHub is switched off in Settings.",
  signedOut: "Sign in to GitHub in Settings to see pull requests.",
  suspect: "GitHub rejected the stored credential. Sign in again in Settings.",
  pickAccount: "Pick which account this repo uses from its branch chip in the sidebar.",
} as const;

export default function PrList(props: {
  root: string | null;
  /** What a picked row does. The whole difference between the two places this
   *  is drawn, so it is passed rather than decided here. */
  onPick: (pr: PullRequest) => void;
}) {
  /// Everything about the list itself lives in `prListStore`, which outlives
  /// this component. In the right pane the pull request somebody opens
  /// *replaces* this view, so state held here would be re-fetched on the way
  /// back and a merge landed over there would have nobody to tell.
  const entry = createMemo(() => prListEntry(props.root ?? ""));
  /// What the poll filed this project under. Not the folder on screen when that
  /// folder is a worktree checkout, and reading the statuses under it instead
  /// leaves every row with the blank that means "no tick covered this".
  const pollRoot = () => (props.root ? (projectPathFor(props.root) ?? props.root) : null);
  const loading = () => entry().loading;
  const paused = () => forgePause(props.root);

  // Accounts changing clears every resolution in the store, so ask again.
  createEffect(() => {
    const root = props.root;
    if (root && !forgeRepo(root)) void resolveForgeRepo(root);
  });

  // `ensure` on a project already read costs nothing, which is what makes
  // coming back from an opened pull request free. Signing in still fills the
  // list, because the pause dropped what was held and there is nothing left for
  // `ensure` to consider already read.
  createEffect(
    on([() => props.root, paused], ([root, why]) => {
      if (!root) return;
      if (why !== null) forgetPrList(root);
      else ensurePrList(root);
    }),
  );

  /// A refresh is both halves: the list, and the checks behind it.
  ///
  /// `pollNow("manual")` is what bypasses Rust's freshness window, so a user who
  /// just watched a build finish gets the new rollup rather than one from up to
  /// thirty seconds ago.
  function refresh() {
    const root = props.root;
    if (!root || paused() !== null) return;
    void reloadPrList(root);
    void pollNow("manual");
  }

  // A PR opened from the Changes panel is one this list has never seen. Rust's
  // write-through makes the sidebar chip flip immediately; the listing is its
  // own request, so it has to be told.
  onCleanup(
    onWith<PrOpened>(PR_OPENED, (d) => {
      if (d?.projectPath && d.projectPath === props.root && paused() === null) {
        void reloadPrList(d.projectPath);
      }
    }),
  );

  const shown = () => entry().items;
  const uncovered = () => {
    const root = pollRoot();
    return root ? uncoveredUnits(root) : 0;
  };

  return (
    <div class={styles.panel}>
      <div class={styles.head}>
        <span class={styles.title}>Pull requests</span>
        <Show when={paused() === null && props.root}>
          <Button variant="ghost" onClick={refresh} disabled={loading()}>
            {loading() ? "Loading…" : "Refresh"}
          </Button>
        </Show>
      </div>

      <Show when={paused()}>{(why) => <div class={styles.notice}>{PAUSED_COPY[why()]}</div>}</Show>

      <Show when={paused() === null}>
        <Show when={entry().error}>{(message) => <div class={`${styles.notice} ${styles.bad}`}>{message()}</div>}</Show>

        <Show when={!entry().error && !loading() && shown().length === 0}>
          <div class={styles.notice}>No open pull requests.</div>
        </Show>

        <For each={shown()}>
          {(pr) => {
            // The same badges the sidebar chip is built from, minus the PR
            // glyph: this row already says `#12` in its own title.
            const chip = createMemo(() => forgeBadges(pollRoot() ? unitStatus(pollRoot()!, pr.headRef) : null));
            return (
              <div
                class={styles.row}
                role="button"
                tabIndex={0}
                onClick={() => props.onPick(pr)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  props.onPick(pr);
                }}
              >
                <div class={styles.rowMain}>
                  <span class={styles.number}>#{pr.number}</span>
                  <span class={styles.prTitle} title={pr.title}>
                    {pr.title}
                  </span>
                  <ForgeChipView chip={chip()} />
                </div>
                <div class={styles.rowMeta}>
                  <span class={styles.state} data-pr-state={pr.isDraft ? "draft" : pr.state}>
                    {pr.isDraft ? "draft" : pr.state}
                  </span>
                  <span class={styles.author}>{pr.author}</span>
                  <span class={styles.branch} title={`${pr.headRef} into ${pr.baseRef}`}>
                    {pr.headRef}
                  </span>
                </div>
              </div>
            );
          }}
        </For>

        {/* Both truncations, said out loud. A short list that looks complete is
            the failure nobody reports. */}
        <Show when={entry().truncated}>
          <div class={styles.notice}>This repo has more open pull requests than one listing can carry.</div>
        </Show>
        <Show when={uncovered() > 0}>
          <div class={styles.notice}>
            Checks are not shown for {uncovered()} branch{uncovered() === 1 ? "" : "es"} this poll did not cover.
          </div>
        </Show>
      </Show>
    </div>
  );
}
