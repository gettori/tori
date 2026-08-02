// One review conversation: its comments, a reply box, and the resolve toggle.
//
// Rendered in two places that must look the same, under a diff line and in the
// outdated group, so the card knows nothing about where it sits. What it does
// know is that an outdated thread has to carry the quote of the hunk it was
// written against: with no line to sit beside, that quote is the whole of what
// makes the remark readable.
//
// The card owns no thread state. Replying and resolving are handed up, because
// the optimistic append, the reconcile and the rollback all operate on the whole
// list and belong in one place (`reviewThreads.ts`), not in a component that
// exists once per thread.

import { createSignal, For, Show } from "solid-js";
import { isPending } from "../../../utils/reviewThreads";
import type { ReviewThread } from "../../../utils/forgeTypes";
import Button from "../../../components/Button/Button";
import styles from "./ReviewThreadView.module.css";

export default function ReviewThreadView(props: {
  thread: ReviewThread;
  /** Whether to show the quoted hunk. On by default for a thread with no line
   *  to sit beside; off under a diff row, where the surrounding lines are the
   *  context and repeating them is noise. */
  quoteHunk?: boolean;
  onReply: (body: string) => void;
  onResolve: (resolved: boolean) => void;
  busy?: boolean;
}) {
  const [draft, setDraft] = createSignal("");
  const [replying, setReplying] = createSignal(false);

  function send() {
    const body = draft().trim();
    // An empty reply posts nothing rather than an empty comment, which cannot
    // be deleted from here once it exists.
    if (!body) return;
    props.onReply(body);
    setDraft("");
    setReplying(false);
  }

  return (
    <div
      class={styles.thread}
      data-thread-id={props.thread.id}
      data-resolved={props.thread.isResolved ? "yes" : "no"}
      data-outdated={props.thread.isOutdated ? "yes" : "no"}
    >
      <div class={styles.head}>
        <span class={styles.where}>
          {props.thread.path}
          <Show when={props.thread.line !== null}>:{props.thread.line}</Show>
        </span>
        <Show when={props.thread.isOutdated}>
          <span class={styles.tag}>outdated</span>
        </Show>
        <Show when={props.thread.isResolved}>
          <span class={styles.tag}>resolved</span>
        </Show>
        <Button
          variant="ghost"
          disabled={props.busy}
          onClick={() => props.onResolve(!props.thread.isResolved)}
        >
          {props.thread.isResolved ? "Unresolve" : "Resolve"}
        </Button>
      </div>

      {/* The anchor as GitHub recorded it. For an outdated thread this is the
          only thing that says what the remark was about. */}
      <Show when={(props.quoteHunk ?? props.thread.line === null) && props.thread.diffHunk}>
        <pre class={styles.hunk}>{props.thread.diffHunk}</pre>
      </Show>

      <For each={props.thread.comments}>
        {(c) => (
          <div class={styles.comment} data-pending={isPending(c) ? "yes" : "no"}>
            <div class={styles.byline}>
              <span class={styles.author}>{c.author}</span>
              <Show when={isPending(c)}>
                <span class={styles.tag}>sending…</span>
              </Show>
            </div>
            <div class={styles.body}>{c.body}</div>
          </div>
        )}
      </For>

      <Show
        when={replying()}
        fallback={
          <Button variant="ghost" onClick={() => setReplying(true)}>
            Reply
          </Button>
        }
      >
        <div class={styles.replyBox}>
          <textarea
            class={styles.input}
            rows={3}
            // Focused by hand, not by `autofocus`: the attribute is honoured
            // inconsistently on an element inserted long after load, and a box
            // that opens looking ready but needs a second click is worse than
            // one that does not open at all.
            ref={(el) => queueMicrotask(() => el.focus())}
            aria-label={`Reply to the thread on ${props.thread.path}`}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e: KeyboardEvent) => {
              // Enter is a newline in a review comment; the send is deliberate.
              if (e.key === "Escape") setReplying(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div class={styles.replyActions}>
            <Button variant="ghost" onClick={() => setReplying(false)}>
              Cancel
            </Button>
            <Button onClick={send} disabled={!draft().trim()}>
              Reply
            </Button>
          </div>
        </div>
      </Show>
    </div>
  );
}
