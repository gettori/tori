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
  forgeRepo,
  resolveForgeRepo,
  unitStatus,
  uncoveredUnits,
  pollNow,
} from "../../../utils/forgeStatus";
import { forgeErrorMessage, type Paged, type PullRequest } from "../../../utils/forgeTypes";
import Button from "../../../components/Button/Button";
import PrDetail from "./PrDetail";
import styles from "./PullRequests.module.css";

/** The sentence for each reason polling is paused, and what to do about it.
 *  These plus a genuinely empty list are four ways of rendering no rows, and a
 *  panel that draws the same blank for all of them leaves the user with no idea
 *  which one they are in. */
const PAUSED_COPY = {
  disabled: "GitHub is switched off in Settings.",
  signedOut: "Sign in to GitHub in Settings to see pull requests.",
  suspect: "GitHub rejected the stored credential. Sign in again in Settings.",
  pickAccount: "Pick which account this repo uses from its branch chip in the sidebar.",
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
  // Which pull request is open in the detail view, if any.
  const [opened, setOpened] = createSignal<PullRequest | null>(null);

  const paused = () => forgePause(props.root);
  // Accounts changing clears every resolution in the store, so ask again.
  createEffect(() => {
    const root = props.root;
    if (root && !forgeRepo(root)) void resolveForgeRepo(root);
  });

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
      // A detail view of a PR from the project just left, or one the credential
      // can no longer fetch files for, is a view that cannot refresh itself.
      setOpened(null);
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

  // The detail view replaces the list rather than sitting beside it: the right
  // pane is one column wide, and a list plus a diff in it would leave neither
  // enough room to read.
  const detail = createMemo(() => {
    const pr = opened();
    const root = props.root;
    // Scoped to the project the list belongs to, so switching projects drops a
    // detail view of a PR the new one has never heard of.
    return pr && root && listedRoot() === root ? { pr, root } : null;
  });

  const list = () => (
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
              <div
                class={styles.row}
                role="button"
                tabIndex={0}
                onClick={() => setOpened(pr)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  setOpened(pr);
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

  // Unkeyed on purpose. `detail()` builds a fresh object each recompute, so
  // `keyed` would tear down and remount the detail view (re-fetching every file)
  // whenever the memo re-ran for reasons that have nothing to do with which pull
  // request is open. Unkeyed re-renders on the *branch* changing, and PrDetail's
  // own effect handles a swap from one pull request to another.
  return (
    <Show when={detail()} fallback={list()}>
      {(d) => (
        <PrDetail
          root={d().root}
          pr={d().pr}
          onBack={() => setOpened(null)}
          // Landing one makes this list wrong, and the list is where the user
          // goes to confirm it worked. Rust drops its caches on a merge; the
          // array held here was fetched before that and has to be asked again.
          onLanded={() => void load(d().root)}
        />
      )}
    </Show>
  );
}
