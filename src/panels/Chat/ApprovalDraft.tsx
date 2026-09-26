import { For, Show } from "solid-js";
import type { AskApproval } from "../../utils/socketAsks";
import styles from "./Chat.module.css";

const VERDICT = { approve: "Approve", comment: "Comment", requestChanges: "Request changes" } as const;

export default function ApprovalDraft(props: { approval: AskApproval }) {
  const pr = () => (props.approval.action === "pr.create" ? props.approval : undefined);
  const review = () => (props.approval.action === "review.submit" ? props.approval : undefined);
  const merge = () => (props.approval.action === "pr.merge" ? props.approval : undefined);
  return (
    <div class={styles.askDraft}>
      <Show when={pr()}>
        {(pr) => (
          <>
            <strong>{pr().title}</strong>
            <span class={styles.askDraftMeta}>
              {pr().head} at {pr().head_sha} into {pr().base}
              {pr().draft ? ", as a draft" : ""}
            </span>
            <pre class={styles.askDraftBody}>{pr().body}</pre>
          </>
        )}
      </Show>
      <Show when={review()}>
        {(review) => (
          <>
            <strong>
              {VERDICT[review().event]} on pull request {review().number}
            </strong>
            <span class={styles.askDraftMeta}>at {review().head_sha}</span>
            <pre class={styles.askDraftBody}>{review().body}</pre>
            <For each={review().comments}>
              {(c) => (
                <div>
                  <span class={styles.askDraftMeta}>
                    {c.path}:{c.startLine == null ? "" : `${c.startLine}-`}
                    {c.line}
                    {c.side === "LEFT" ? " (base)" : ""}
                  </span>
                  <pre class={styles.askDraftBody}>{c.body}</pre>
                </div>
              )}
            </For>
          </>
        )}
      </Show>
      <Show when={merge()}>
        {(merge) => (
          <>
            <strong>Merge pull request {merge().number}</strong>
            <span class={styles.askDraftMeta}>
              {merge().method} at {merge().head_sha}
            </span>
          </>
        )}
      </Show>
      <span class={styles.askDraftMeta}>{props.approval.project}</span>
    </div>
  );
}
