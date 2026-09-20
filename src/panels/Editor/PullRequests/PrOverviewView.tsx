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
import { ExternalLink, FileStack } from "lucide-solid";
import { compactAgo } from "../../../utils/compactAge";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../../utils/events";
import { parsePrArg, prAllTabId } from "../../../utils/syntheticTabs";
import { unitStatusForPr } from "../../../utils/forgeStatus";
import { ensure, prEntry } from "../../../utils/prReviewStore";
import Markdown from "../../Chat/Markdown";
import Button from "../../../components/Button/Button";
import IconButton from "../../../components/IconButton/IconButton";
import Icon from "../../../components/Icon/Icon";
import ReviewForm from "./ReviewForm";
import styles from "./PrOverviewView.module.css";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function PrOverviewView(props: { workspace: string; arg: string }) {
  const number = createMemo(() => parsePrArg(props.arg));

  const entry = createMemo(() => prEntry(props.workspace, number()));
  /// The poll first and the store second, the same order `PrDiffView` reads
  /// them in and for the same reasons: the poll is fresher and already on
  /// screen, and the store's copy is what keeps a pull request on a branch this
  /// machine has no unit for from rendering as no pull request at all.
  const pr = createMemo(
    () => unitStatusForPr(props.workspace, number())?.pullRequest ?? entry().pr,
  );
  /// The size and the standing verdicts, where the host describes a pull
  /// request in one read. Null on GitLab, and null until the read lands.
  const counts = () => entry().summary?.counts ?? null;

  /// Who opened it and when, then how big it is.
  ///
  /// Two halves because they arrive separately: the author and the date ride
  /// the `PullRequest` every list already has, while the counts exist only on
  /// the detail read. Rendering the line only once both had landed would leave
  /// it blank for a request nobody needs to wait for.
  const meta = createMemo(() => {
    const p = pr();
    if (!p) return [];
    const opened = Date.parse(p.createdAt);
    const parts = [
      p.author,
      Number.isNaN(opened) ? null : `opened ${compactAgo(opened / 1000)}`,
    ];
    const c = counts();
    if (c) {
      parts.push(plural(c.commits, "commit"), plural(c.changedFiles, "file"));
    }
    return parts.filter((part): part is string => part !== null);
  });

  createEffect(
    on([() => props.workspace, number], ([root, n]) => {
      // Idempotent per pull request, so coming back to one already read costs
      // nothing and shows it at once.
      ensure(root, n);
    }),
  );

  return (
    <div class={styles.overview}>
      <Show
        when={pr()}
        fallback={<div class="tree-empty">No pull request here carries that number.</div>}
      >
        {(p) => (
          <div class={styles.column}>
            <div class={styles.head}>
              <h1 class={styles.title}>
                <span class={styles.number}>#{p().number}</span>
                {p().title}
              </h1>
              {/* The other way to read the diff: one scrolling tab instead of
                  a tab per file. Here rather than only in the panel, because
                  this is the tab a review is started from. */}
              <Button
                variant="ghost"
                size="sm"
                icon={<Icon icon={FileStack} size={14} />}
                onClick={() =>
                  emitWith<OpenInEditor>(OPEN_IN_EDITOR, {
                    path: prAllTabId(props.workspace, number()),
                  })
                }
              >
                Review all files
              </Button>
              <IconButton
                size="sm"
                icon={<Icon icon={ExternalLink} />}
                tooltip={`Open pull request ${p().number} on github.com`}
                onClick={() => window.open(p().url, "_blank", "noreferrer")}
              />
            </div>
            <div class={styles.meta}>{meta().join(", ")}</div>
            <div class={styles.branches}>
              {p().headRef} -&gt; {p().baseRef}
            </div>

            {/* The counts and the standing verdicts, which only the detail read
                carries. Absent until it lands rather than zeroed: "+0 -0, nobody
                has reviewed" is a sentence, and it would be the wrong one. */}
            <Show when={counts()}>
              {(c) => (
                <div class={styles.rollup}>
                  <span class={styles.counts}>
                    <span class={styles.added}>+{c().additions}</span>
                    <span class={styles.removed}>-{c().deletions}</span>
                  </span>
                  {/* Absent rather than zeroed when the reviews could not all be
                      read: "no approvals" is a verdict, and nobody reached it. */}
                  <Show when={c().reviews}>
                    {(r) => (
                      <>
                        <span
                          class={styles.verdict}
                          data-verdict="approved"
                          data-count={r().approved}
                        >
                          {plural(r().approved, "approval")}
                        </span>
                        <span
                          class={styles.verdict}
                          data-verdict="changesRequested"
                          data-count={r().changesRequested}
                        >
                          {plural(r().changesRequested, "change request")}
                        </span>
                      </>
                    )}
                  </Show>
                </div>
              )}
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
                <div class={styles.body}>
                  <Markdown text={body()} cwd={props.workspace} />
                </div>
              )}
            </Show>

            <hr class={styles.rule} />

            {/* One mount of the shared form, the other being the panel's.
                Both read the pull request's own draft, so the verdict picked
                here is the verdict the panel shows. */}
            <section class={styles.reviewSection}>
              <h2 class={styles.sectionTitle}>Your review</h2>
              <ReviewForm workspace={props.workspace} number={number()} />
            </section>
          </div>
        )}
      </Show>
    </div>
  );
}
