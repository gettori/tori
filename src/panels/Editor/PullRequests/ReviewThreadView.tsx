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

/** The anchor as a reader scans it. A thread can span lines, since Tori itself
 *  sends ranges, and a head showing only `line` would name the last line of a
 *  remark whose message to the agent says the whole span. */
function anchor(thread: ReviewThread): string {
  const { line, startLine } = thread;
  if (line === null) return "";
  return startLine !== null && startLine !== line ? `${startLine}-${line}` : `${line}`;
}

export default function ReviewThreadView(props: {
  thread: ReviewThread;
  /** Whether to show the quoted hunk. On by default for a thread with no line
   *  to sit beside; off under a diff row, where the surrounding lines are the
   *  context and repeating them is noise. */
  quoteHunk?: boolean;
  onReply: (body: string) => void;
  onResolve: (resolved: boolean) => void;
  busy?: boolean;
  /** Handing the thread to the agent that owns the branch. `label` names who
   *  would get it and how they are doing, or says why there is nobody, and it
   *  shows either way: a disabled button with no reason beside it is the one
   *  thing worse than no button at all. `note` is how the last attempt went,
   *  on the card rather than in a toast, because a toast that has scrolled a
   *  stack of threads out of mind cannot say *which* one did not go. */
  send?: {
    label: string;
    ready: boolean;
    busy?: boolean;
    note?: { text: string; ok: boolean } | null;
    onSend: () => void;
  };
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
          <Show when={props.thread.line !== null}>:{anchor(props.thread)}</Show>
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

      <Show when={props.send}>
        {(send) => (
          <div class={styles.sendRow} data-send-to={send().label}>
            <Button
              variant="ghost"
              disabled={!send().ready || send().busy}
              onClick={() => send().onSend()}
            >
              Send to agent
            </Button>
            <span class={styles.sendTarget}>{send().label}</span>
            <Show when={send().note}>
              {(note) => (
                <span class={styles.sendNote} data-send-note={note().ok ? "ok" : "error"}>
                  {note().text}
                </span>
              )}
            </Show>
          </div>
        )}
      </Show>

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
