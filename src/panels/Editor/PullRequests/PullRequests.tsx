// The Pull Requests panel: every open PR on this project, in one list.
//
// Its own panel rather than another section of the 1,300-line ReviewPanel,
// which is about the working tree. These are about work already pushed, and the
// two share no state, no refresh trigger and no failure modes.
//
// ## Where each column comes from
//
// The **list** is a request this panel makes: `github_list_prs`, uncached,
// because a panel someone just opened wants the current answer and the cache
// Phase 5 built exists to pace a tick that runs forever, not a click.
//
// The **checks and the review verdict** are read from the poll store, never
// fetched here. That is what stops a row and its sidebar chip from being two
// answers to one question, and it costs nothing: the poller has already asked.
// The price is that a branch the poller has not reached shows no checks, which
// is the same honest blank the chip shows, for the same reason.

import { createSignal, createEffect, createMemo, on, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { onWith, PR_OPENED, type PrOpened } from "../../../utils/events";
import { forgeBadges } from "../../../utils/forgeChip";
import ForgeChipView from "../../../components/ForgeChip/ForgeChip";
import {
  forgePause,
  unitStatus,
  uncoveredUnits,
  pollNow,
} from "../../../utils/forgeStatus";
import { forgeErrorMessage, type Paged, type PullRequest } from "../../../utils/forgeTypes";
import Button from "../../../components/Button/Button";
import styles from "./PullRequests.module.css";

/** The sentence for each reason polling is paused, and what to do about it.
 *  These plus a genuinely empty list are four ways of rendering no rows, and a
 *  panel that draws the same blank for all of them leaves the user with no idea
 *  which one they are in. */
const PAUSED_COPY = {
  disabled: "GitHub is switched off in Settings.",
  signedOut: "Sign in to GitHub in Settings to see pull requests.",
  suspect: "GitHub rejected the stored credential. Sign in again in Settings.",
} as const;

export default function PullRequests(props: { root: string | null }) {
  const [items, setItems] = createSignal<PullRequest[]>([]);
  const [truncated, setTruncated] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Which project the list in hand describes. Without it, switching projects
  // shows the previous one's PRs until the new request lands, which reads as a
  // working list of the wrong repo.
  const [listedRoot, setListedRoot] = createSignal<string | null>(null);

  const paused = () => forgePause();

  async function load(root: string) {
    setLoading(true);
    setError(null);
    try {
      const page = await invoke<Paged<PullRequest>>("github_list_prs", { projectPath: root });
      setItems(page.items);
      setTruncated(page.truncated);
      setListedRoot(root);
    } catch (e) {
      setItems([]);
      setTruncated(false);
      setListedRoot(root);
      setError(forgeErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  // Re-list on the project changing and on the pause lifting, so signing in
  // fills the panel instead of leaving the signed-out notice up until something
  // else happens to re-render it.
  createEffect(
    on([() => props.root, paused], ([root, why]) => {
      if (!root || why !== null) {
        setItems([]);
        setListedRoot(null);
        return;
      }
      void load(root);
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
    void load(root);
    void pollNow("manual");
  }

  // A PR opened from the Changes panel is one this list has never seen. Rust's
  // write-through makes the sidebar chip flip immediately; the listing is its
  // own request, so it has to be told.
  onCleanup(
    onWith<PrOpened>(PR_OPENED, (d) => {
      if (d?.projectPath && d.projectPath === props.root && paused() === null) void load(d.projectPath);
    }),
  );

  const shown = createMemo(() => (listedRoot() === props.root ? items() : []));
  const uncovered = () => (props.root ? uncoveredUnits(props.root) : 0);

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

      <Show when={paused()}>
        {(why) => <div class={styles.notice}>{PAUSED_COPY[why()]}</div>}
      </Show>

      <Show when={paused() === null}>
        <Show when={error()}>
          {(message) => <div class={`${styles.notice} ${styles.bad}`}>{message()}</div>}
        </Show>

        <Show when={!error() && !loading() && shown().length === 0}>
          <div class={styles.notice}>No open pull requests.</div>
        </Show>

        <For each={shown()}>
          {(pr) => {
            // The same badges the sidebar chip is built from, minus the PR
            // glyph: this row already says `#12` in its own title.
            const chip = createMemo(() =>
              forgeBadges(props.root ? unitStatus(props.root, pr.headRef) : null),
            );
            return (
              <div class={styles.row}>
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
        <Show when={truncated()}>
          <div class={styles.notice}>
            This repo has more open pull requests than one listing can carry.
          </div>
        </Show>
        <Show when={uncovered() > 0}>
          <div class={styles.notice}>
            Checks are not shown for {uncovered()} branch{uncovered() === 1 ? "" : "es"} this poll
            did not cover.
          </div>
        </Show>
      </Show>
    </div>
  );
}
