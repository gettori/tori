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

import { createEffect, createMemo, For, on, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  FileStack,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from "lucide-solid";
import { prActivity, prOpened } from "../../../utils/prMeta";
import { copyText } from "../../../utils/clipboard";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../../utils/events";
import { parsePrArg, prAllTabId } from "../../../utils/syntheticTabs";
import { unitStatusForPr } from "../../../utils/forgeStatus";
import { ensure, prEntry } from "../../../utils/prReviewStore";
import MarkdownDocument from "../MarkdownDocument";
import Button from "../../../components/Button/Button";
import IconButton from "../../../components/IconButton/IconButton";
import Icon from "../../../components/Icon/Icon";
import styles from "./PrOverviewView.module.css";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type StateKey = "open" | "draft" | "merged" | "closed";

const STATE: Record<StateKey, { label: string; icon: LucideIcon }> = {
  open: { label: "Open", icon: GitPullRequest },
  draft: { label: "Draft", icon: GitPullRequestDraft },
  merged: { label: "Merged", icon: GitMerge },
  closed: { label: "Closed", icon: GitPullRequestClosed },
};

type BlockKind = "added" | "removed" | "neutral";

/** The host's five-square size bar: each side gets its share rounded down, and
 *  what rounding leaves over stays grey. */
function diffBlocks(additions: number, deletions: number): BlockKind[] {
  const total = additions + deletions;
  const added = total ? Math.floor((5 * additions) / total) : 0;
  const removed = total ? Math.floor((5 * deletions) / total) : 0;
  return [
    ...Array<BlockKind>(added).fill("added"),
    ...Array<BlockKind>(removed).fill("removed"),
    ...Array<BlockKind>(5 - added - removed).fill("neutral"),
  ];
}

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
  const state = createMemo((): StateKey => {
    const p = pr();
    if (!p) return "open";
    return p.state === "open" && p.isDraft ? "draft" : p.state;
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
      <Show when={pr()} fallback={<div class="tree-empty">No pull request here carries that number.</div>}>
        {(p) => (
          <div class={styles.column}>
            <div class={styles.head}>
              <h1 class={styles.title}>
                {p().title} <span class={styles.number}>#{p().number}</span>
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
                onClick={() => void invoke("plugin:opener|open_url", { url: p().url }).catch(() => {})}
              />
            </div>

            <div class={styles.summary}>
              <span class={styles.state} data-state={state()}>
                <Icon icon={STATE[state()].icon} size={14} aria-hidden="true" />
                {STATE[state()].label}
              </span>
              <span class={styles.byline}>
                <strong class={styles.author}>{p().author}</strong>
                <Show when={prOpened(p())}>{(o) => <> {o()}</>}</Show>
              </span>
              <span class={styles.where}>
                <span class={styles.branches}>
                  <span class={styles.branch} title={p().baseRef}>
                    <span class={styles.branchName}>{p().baseRef}</span>
                  </span>
                  <Icon icon={ArrowLeft} size={14} class={styles.arrow} aria-label="from" />
                  <span class={styles.branch} title={p().headRef}>
                    <span class={styles.branchName}>{p().headRef}</span>
                    <button
                      type="button"
                      class={styles.copy}
                      aria-label="Copy the branch name"
                      title="Copy the branch name"
                      onClick={() => void copyText(p().headRef)}
                    >
                      <Icon icon={Copy} size={12} aria-hidden="true" />
                    </button>
                  </span>
                </span>
                {/* Absent until the detail read lands rather than zeroed: "+0 -0"
                    is a size, and it would be the wrong one. */}
                <Show when={counts()}>
                  {(c) => (
                    <span class={styles.diffstat}>
                      <span class={styles.added}>+{c().additions}</span>
                      <span class={styles.removed}>-{c().deletions}</span>
                      <span class={styles.blocks} aria-hidden="true">
                        <For each={diffBlocks(c().additions, c().deletions)}>
                          {(kind) => <span class={styles.block} data-kind={kind} />}
                        </For>
                      </span>
                    </span>
                  )}
                </Show>
              </span>
            </div>

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
