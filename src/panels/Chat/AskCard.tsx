import { createSignal, For, Show } from "solid-js";
import Button from "../../components/Button/Button";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { findSession } from "../../utils/sessionStore";
import { answerAsk, type AskApproval, type SocketAsk } from "../../utils/socketAsks";
import styles from "./Chat.module.css";

const VERDICT = { approve: "Approve", comment: "Comment", requestChanges: "Request changes" } as const;

function ApprovalDraft(props: { approval: AskApproval }) {
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
              {pr().head} into {pr().base}
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
            <pre class={styles.askDraftBody}>{review().body}</pre>
            <For each={review().comments}>
              {(c) => (
                <div>
                  <span class={styles.askDraftMeta}>
                    {c.path}:{c.line}
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

export default function AskCard(props: { ask: SocketAsk; here: string }) {
  const asker = () => {
    if (props.ask.session === props.here) return null;
    const meta = findSession(props.ask.session)?.session;
    return meta?.name || meta?.title || props.ask.session.slice(0, 8);
  };
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const send = (answer: string) => {
    if (!answer.trim() || sending()) return;
    setSending(true);
    answerAsk(props.ask.id, answer.trim()).catch((e) => {
      setSending(false);
      emitWith<ToastEvent>(TOAST, { message: `The answer did not reach the asker: ${String(e)}`, kind: "error" });
    });
  };
  return (
    <div class={props.ask.approval ? `${styles.banner} ${styles.askApproval}` : styles.banner}>
      <span class={styles.bannerText}>
        <Show when={asker()}>{(name) => <span class={styles.askDraftMeta}>{name()} asks: </span>}</Show>
        {props.ask.question}
      </span>
      <Show
        when={props.ask.options.length}
        fallback={
          <>
            <input
              class={styles.askInput}
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && send(text())}
              aria-label="Answer"
            />
            <Button size="sm" disabled={sending()} onClick={() => send(text())}>
              Answer
            </Button>
          </>
        }
      >
        <For each={props.ask.options}>
          {(option) => (
            <Button size="sm" disabled={sending()} onClick={() => send(option)}>
              {option}
            </Button>
          )}
        </For>
      </Show>
      <Show when={props.ask.approval}>{(approval) => <ApprovalDraft approval={approval()} />}</Show>
    </div>
  );
}
