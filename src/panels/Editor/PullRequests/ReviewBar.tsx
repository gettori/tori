// The review being written, and the three ways to end it.
//
// It draws only once something is pending or the reader starts typing, because
// a permanent submit bar over a pull request nobody is reviewing is chrome on
// every diff in the app.
//
// The two verdicts are rendered **disabled with their reason**, never hidden.
// Hiding them would make a self-authored pull request look like a build without
// the feature; showing them greyed with "GitHub does not accept this on your own
// pull request" says which of the two it is.

import { For, Show, createMemo } from "solid-js";
import { anchorLabel, submitBlock } from "../../../utils/pendingReview";
import type { DraftComment, ReviewEvent } from "../../../utils/forgeTypes";
import Button from "../../../components/Button/Button";
import styles from "./ReviewBar.module.css";

const VERBS: { event: ReviewEvent; label: string }[] = [
  { event: "comment", label: "Comment" },
  { event: "approve", label: "Approve" },
  { event: "requestChanges", label: "Request changes" },
];

export default function ReviewBar(props: {
  comments: readonly DraftComment[];
  body: string;
  onBody: (body: string) => void;
  /** null while the viewer is unknown, which blocks both verdicts: not-yet-known
   *  is not known-different. */
  selfAuthored: boolean | null;
  submitting: boolean;
  onSubmit: (event: ReviewEvent) => void;
  onRemove: (index: number) => void;
}) {
  const blockFor = (event: ReviewEvent) =>
    submitBlock({
      event,
      body: props.body,
      comments: props.comments,
      selfAuthored: props.selfAuthored,
    });

  // The reason to spell out under the row: whichever verdict is blocked, since
  // both are blocked for the same reason whenever either is.
  const verdictReason = createMemo(() => blockFor("approve") ?? blockFor("requestChanges"));

  return (
    <div class={styles.bar} data-pending-count={props.comments.length}>
      <div class={styles.head}>
        <span class={styles.count}>
          {props.comments.length === 0
            ? "No line comments yet"
            : `${props.comments.length} pending comment${props.comments.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* Every held comment, with where it will land. Nothing has been posted:
          a review is one atomic call, so until submit these exist only here. */}
      <For each={props.comments}>
        {(c, i) => (
          <div class={styles.pending} data-pending-comment={anchorLabel(c)}>
            <span class={styles.anchor}>{anchorLabel(c)}</span>
            <span class={styles.pendingBody}>{c.body}</span>
            <Button variant="ghost" onClick={() => props.onRemove(i())}>
              Remove
            </Button>
          </div>
        )}
      </For>

      <textarea
        class={styles.body}
        rows={3}
        placeholder="Review summary"
        aria-label="Review summary"
        value={props.body}
        onInput={(e) => props.onBody(e.currentTarget.value)}
      />

      <div class={styles.verbs}>
        <For each={VERBS}>
          {(v) => {
            const why = () => blockFor(v.event);
            return (
              <Button
                variant={v.event === "comment" ? "primary" : "ghost"}
                disabled={props.submitting || why() !== null}
                tooltipWhenDisabled
                tooltip={why() ?? undefined}
                onClick={() => props.onSubmit(v.event)}
              >
                {v.label}
              </Button>
            );
          }}
        </For>
      </div>

      {/* Inline, not only as a tooltip: a disabled control with no visible
          reason is indistinguishable from a broken one. */}
      <Show when={verdictReason()}>
        {(reason) => (
          <div class={styles.reason} data-verdict-reason>
            {reason()}
          </div>
        )}
      </Show>
    </div>
  );
}
