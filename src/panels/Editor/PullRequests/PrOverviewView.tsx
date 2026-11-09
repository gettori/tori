// One pull request as a whole, as a tab in the stage.
//
// The diff tabs beside it are each one file; this is the pull request itself:
// what it says it does, how big it is, and where its reviews stand.
//
// It fetches nothing. `ensure` on mount, everything read from `prReviewStore`,
// so this tab open beside four diff tabs is still one read of each part.
//
// **No merge control.** Landing a branch is the panel's, and only the panel's:
// two buttons that merge is two places a stale verdict can offer it.

import { createEffect, createMemo, on, Show } from "solid-js";
import { prActivity } from "../../../utils/prMeta";
import { parsePrArg } from "../../../utils/syntheticTabs";
import { unitStatusForPr } from "../../../utils/forgeStatus";
import { ensure, prEntry } from "../../../utils/prReviewStore";
import MarkdownDocument from "../MarkdownDocument";
import PrHeader from "./PrHeader";
import styles from "./PrOverviewView.module.css";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function PrOverviewView(props: { workspace: string; arg: string }) {
  const number = createMemo(() => parsePrArg(props.arg));

  const entry = createMemo(() => prEntry(props.workspace, number()));
  /// The poll first and the store second, the same order `PrDiffView` reads
  /// them in and for the same reasons: the poll is fresher and already on
  /// screen, and the store's copy is what keeps a pull request on a branch this
  /// machine has no unit for from rendering as no pull request at all.
  const pr = createMemo(() => unitStatusForPr(props.workspace, number())?.pullRequest ?? entry().pr);
  /// The size and the standing verdicts, where the host describes a pull
  /// request in one read. Null on GitLab, and null until the read lands.
  const counts = () => entry().summary?.counts ?? null;

  const activity = createMemo(() => prActivity(entry().summary?.updatedAt ?? null, counts()));
  const reviews = () => counts()?.reviews ?? null;
  createEffect(
    on([() => props.workspace, number], ([root, n]) => {
      // Idempotent per pull request, so coming back to one already read costs
      // nothing and shows it at once.
      ensure(root, n);
    }),
  );

  return (
    <div class={styles.overview}>
      <Show when={pr()} fallback={<div class="tree-empty">No pull request here carries that number.</div>}>
        {(p) => (
          <div class={styles.column}>
            <PrHeader pr={p()} counts={counts()} />

            <Show when={activity().length || reviews()}>
              <div class={styles.meta}>
                <Show when={activity().length}>
                  <span>{activity().join(", ")}</span>
                </Show>
                {/* Absent rather than zeroed when the reviews could not all be
                    read: "no approvals" is a verdict, and nobody reached it. */}
                <Show when={reviews()}>
                  {(r) => (
                    <>
                      <span class={styles.verdict} data-verdict="approved" data-count={r().approved}>
                        {plural(r().approved, "approval")}
                      </span>
                      <span class={styles.verdict} data-verdict="changesRequested" data-count={r().changesRequested}>
                        {plural(r().changesRequested, "change request")}
                      </span>
                    </>
                  )}
                </Show>
              </div>
            </Show>

            <hr class={styles.rule} />

            {/* The description only. A pull request's timeline is a conversation
                with the forge's own affordances behind it, and half of one
                rendered here would read as the whole thing. */}
            <Show
              when={p().body?.trim()}
              fallback={<div class={styles.noBody}>This pull request has no description.</div>}
            >
              {(body) => (
                <MarkdownDocument text={body()} base={props.workspace} source={`${props.workspace}#${number()}`} />
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
