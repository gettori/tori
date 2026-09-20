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

import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, FileStack } from "lucide-solid";
import { compactAgo } from "../../../utils/compactAge";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../../utils/events";
import { parsePrArg, prAllTabId, prDiffTabId } from "../../../utils/syntheticTabs";
import { forgeCapabilities, forgeViewer, pollNow, unitStatusForPr } from "../../../utils/forgeStatus";
import { anchorLabel, isSelfAuthored, reviewBlock, submitBlock } from "../../../utils/pendingReview";
import {
  clearDraft,
  ensure,
  headDrift,
  prEntry,
  refresh,
  setReviewBody,
  setThreadsError,
  toDrafts,
} from "../../../utils/prReviewStore";
import { forgeErrorMessage, type ReviewEvent } from "../../../utils/forgeTypes";
import Markdown from "../../Chat/Markdown";
import Button from "../../../components/Button/Button";
import IconButton from "../../../components/IconButton/IconButton";
import Icon from "../../../components/Icon/Icon";
import RadioGroup from "../../../components/RadioGroup/RadioGroup";
import styles from "./PrOverviewView.module.css";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/// The three verdicts, each with what it means rather than what it is called.
///
/// The second line is part of the choice, not a hint about it: "request
/// changes" and "comment" are indistinguishable to anyone who has not used
/// GitHub's review model, and the consequence is the thing that tells them
/// apart.
const VERDICTS: { value: ReviewEvent; label: string; description: string }[] = [
  { value: "comment", label: "Comment", description: "Feedback without an explicit approval" },
  { value: "approve", label: "Approve", description: "Sign off on these changes" },
  {
    value: "requestChanges",
    label: "Request changes",
    description: "Blocks the merge until you approve",
  },
];

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

  // --- the review being written ----------------------------------------------

  const pending = () => entry().pending;
  const staleCount = () => pending().filter((c) => c.anchor !== "ok").length;
  const filesWithPending = () => new Set(pending().map((c) => c.path)).size;

  const [verdict, setVerdict] = createSignal<ReviewEvent>("comment");
  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal<string | null>(null);

  const selfAuthored = createMemo(() => {
    const p = pr();
    return p ? isSelfAuthored(p, forgeViewer(props.workspace)) : null;
  });
  const supported = (event: ReviewEvent) => {
    const caps = forgeCapabilities(props.workspace);
    if (!caps) return true;
    if (event === "approve") return caps.approve;
    if (event === "requestChanges") return caps.requestChanges;
    return caps.commentReview;
  };

  /// Why this review cannot go out, or null.
  ///
  /// The diff-level noes first: they refuse every verdict, so a reader looking
  /// at a greyed button should read "the diff moved" before "this verdict needs
  /// a summary", which they could act on and still not be able to submit.
  const blocked = createMemo(
    () =>
      reviewBlock({
        staleCount: staleCount(),
        drifted: headDrift(props.workspace, number()),
      }) ??
      submitBlock({
        event: verdict(),
        body: entry().reviewBody,
        comments: pending(),
        selfAuthored: selfAuthored(),
        supported: supported(verdict()),
      }),
  );


  async function submitReview() {
    const mine = current;
    const root = props.workspace;
    const n = number();
    setSubmitting(true);
    setSubmitError(null);
    try {
      await invoke<void>("forge_submit_review", {
        projectPath: root,
        number: n,
        event: verdict(),
        body: entry().reviewBody,
        comments: toDrafts(pending()),
      });
      if (mine !== current) return;
      // Only now. A failed submit has to hand the whole set back, or the reader
      // loses every comment they wrote to one refusal.
      clearDraft(root, n);
      setThreadsError(root, n, null);
      // Three things the server has just changed, each read by whoever owns it:
      // the review's own comments are new threads, the verdict counts are on the
      // summary, and the sidebar chip reads the poll.
      void refresh(root, n, "threads");
      void refresh(root, n, "summary");
      void pollNow("manual");
    } catch (e) {
      if (mine === current) setSubmitError(forgeErrorMessage(e));
    } finally {
      if (mine === current) setSubmitting(false);
    }
  }

  /// Open the file this comment sits in, where it can be seen in its rows.
  ///
  /// The jump is the whole reason the list is here: a pending comment read as a
  /// line of text away from its diff is a remark about nothing.
  function jumpTo(path: string) {
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, {
      path: prDiffTabId(props.workspace, number(), path),
    });
  }

  /// Which submit is current, and everything that was about the last pull
  /// request rather than this one.
  ///
  /// The tab is reused when its props change, so two things follow. A slow
  /// answer can land after the one that replaced it and clear a draft belonging
  /// to a different pull request, which the counter guards. And the verdict and
  /// the refusal on screen were about the pull request that just left: carried
  /// over, they read as this one's, so a reader who picked "Request changes" on
  /// the last review finds the next one preloaded with it.
  let current = 0;
  createEffect(
    on([() => props.workspace, number], ([root, n]) => {
      ++current;
      setVerdict("comment");
      setSubmitError(null);
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

            {/* The form the review is submitted from, and the only copy of it.
                A verdict and a summary body in every diff tab would be one piece
                of state with as many copies as there are files open. */}
            <section class={styles.review}>
              <h2 class={styles.sectionTitle}>Your review</h2>

              <Show
                when={pending().length}
                fallback={
                  <p class={styles.quiet}>
                    No line comments yet. A summary on its own is a review too.
                  </p>
                }
              >
                <p class={styles.pendingCount}>
                  {plural(pending().length, "pending comment")} in{" "}
                  {plural(filesWithPending(), "file")}
                </p>

                {/* Each one opens its file's diff, where the comment is a
                    comment on rows rather than a line of text about nothing. */}
                <For each={pending()}>
                  {(c) => (
                    <button
                      type="button"
                      class={styles.jump}
                      data-anchor-state={c.anchor}
                      onClick={() => jumpTo(c.path)}
                    >
                      <span class={styles.jumpAnchor}>{anchorLabel(c)}</span>
                      <span class={styles.jumpBody}>{c.body}</span>
                      {/* Said on the comment itself, not only in the refusal
                          under the button: the reader has to know which one to
                          go and fix. */}
                      <Show when={c.anchor !== "ok"}>
                        <span class={styles.jumpFlag}>
                          {c.anchor === "stale" ? "line is gone" : "line has changed"}
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </Show>

              <textarea
                class={styles.summary}
                rows={3}
                placeholder="Summary comment, optional"
                aria-label="Review summary"
                value={entry().reviewBody}
                onInput={(e) => setReviewBody(props.workspace, number(), e.currentTarget.value)}
              />

              <RadioGroup
                aria-label="Review verdict"
                options={VERDICTS.map((v) => ({
                  value: v.value,
                  label: v.label,
                  description: v.description,
                  // Disabled with its reason rather than hidden: a host without
                  // a verdict and a pull request you wrote yourself are two
                  // different noes, and a missing radio says neither.
                  disabled: !supported(v.value),
                }))}
                value={verdict()}
                onChange={(value) => setVerdict(value as ReviewEvent)}
              />

              <div class={styles.submit}>
                <Button
                  variant="primary"
                  disabled={submitting() || blocked() !== null}
                  tooltipWhenDisabled
                  tooltip={blocked() ?? undefined}
                  onClick={() => void submitReview()}
                >
                  Submit review
                </Button>
                <Show when={pending().length}>
                  <span class={styles.hint}>
                    Posts all {pending().length} at once
                  </span>
                </Show>
              </div>

              {/* Inline, not only as a tooltip: a disabled control with no
                  visible reason is indistinguishable from a broken one. */}
              <Show when={blocked()}>
                {(reason) => (
                  <div class={styles.reason} data-submit-reason>
                    {reason()}
                  </div>
                )}
              </Show>
              <Show when={submitError()}>
                {(message) => <div class={styles.error}>{message()}</div>}
              </Show>
            </section>
          </div>
        )}
      </Show>
    </div>
  );
}
