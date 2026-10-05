// The form a review goes out from: the comments being held for it, a summary,
// the verdict, and the one call that sends all three.
//
// Mounted twice, in the pull request's own tab and in the panel beside the
// branch. Neither the summary nor the verdict lives here for that reason: both
// sit in `prReviewStore` under the pull request, so the two mounts are one form
// in two places rather than two half-written reviews. What is local is the
// refusal and the in-flight flag, which are about this mount's own submit.

import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../../utils/events";
import { prDiffTabId } from "../../../utils/syntheticTabs";
import { forgeCapabilities, forgeViewer, pollNow, unitStatusForPr } from "../../../utils/forgeStatus";
import { anchorLabel, isSelfAuthored, reviewBlock, submitBlock } from "../../../utils/pendingReview";
import {
  clearDraft,
  headDrift,
  prEntry,
  refresh,
  setReviewBody,
  setReviewVerdict,
  setThreadsError,
  toDrafts,
} from "../../../utils/prReviewStore";
import { forgeErrorMessage, type ReviewEvent } from "../../../utils/forgeTypes";
import Button from "../../../components/Button/Button";
import RadioGroup from "../../../components/RadioGroup/RadioGroup";
import styles from "./ReviewForm.module.css";

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

export default function ReviewForm(props: { workspace: string; number: number }) {
  const entry = createMemo(() => prEntry(props.workspace, props.number));
  const pr = createMemo(() => unitStatusForPr(props.workspace, props.number)?.pullRequest ?? entry().pr);

  const pending = () => entry().pending;
  const staleCount = () => pending().filter((c) => c.anchor !== "ok").length;
  const filesWithPending = () => new Set(pending().map((c) => c.path)).size;
  const verdict = () => entry().verdict;

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
        drifted: headDrift(props.workspace, props.number),
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
    const n = props.number;
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
      path: prDiffTabId(props.workspace, props.number, path),
    });
  }

  /// Which submit is current, and the refusal that was about the last pull
  /// request rather than this one.
  ///
  /// Both mounts are reused when their props change, so a slow answer can land
  /// after the one that replaced it and clear a draft belonging to a different
  /// pull request, which the counter guards.
  let current = 0;
  createEffect(
    on([() => props.workspace, () => props.number], () => {
      ++current;
      setSubmitError(null);
    }),
  );

  return (
    <div class={styles.review}>
      <Show
        when={pending().length}
        fallback={<p class={styles.quiet}>No line comments yet. A summary on its own is a review too.</p>}
      >
        <p class={styles.pendingCount}>
          {plural(pending().length, "pending comment")} in {plural(filesWithPending(), "file")}
        </p>

        {/* Each one opens its file's diff, where the comment is a comment on
            rows rather than a line of text about nothing. */}
        <For each={pending()}>
          {(c) => (
            <button type="button" class={styles.jump} data-anchor-state={c.anchor} onClick={() => jumpTo(c.path)}>
              <span class={styles.jumpAnchor}>{anchorLabel(c)}</span>
              <span class={styles.jumpBody}>{c.body}</span>
              {/* Said on the comment itself, not only in the refusal under the
                  button: the reader has to know which one to go and fix. */}
              <Show when={c.anchor !== "ok"}>
                <span class={styles.jumpFlag}>{c.anchor === "stale" ? "line is gone" : "line has changed"}</span>
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
        onInput={(e) => setReviewBody(props.workspace, props.number, e.currentTarget.value)}
      />

      <RadioGroup
        aria-label="Review verdict"
        options={VERDICTS.map((v) => ({
          value: v.value,
          label: v.label,
          description: v.description,
          // Disabled with its reason rather than hidden: a host without a
          // verdict and a pull request you wrote yourself are two different
          // noes, and a missing radio says neither.
          disabled: !supported(v.value),
        }))}
        value={verdict()}
        onChange={(value) => setReviewVerdict(props.workspace, props.number, value as ReviewEvent)}
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
          <span class={styles.hint}>Posts all {pending().length} at once</span>
        </Show>
      </div>

      {/* Inline, not only as a tooltip: a disabled control with no visible
          reason is indistinguishable from a broken one. */}
      <Show when={blocked()}>
        {(reason) => (
          <div class={styles.reason} data-submit-reason>
            {reason()}
          </div>
        )}
      </Show>
      <Show when={submitError()}>{(message) => <div class={styles.error}>{message()}</div>}</Show>
    </div>
  );
}
