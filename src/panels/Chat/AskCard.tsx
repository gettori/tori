import { createSignal, For, Show } from "solid-js";
import Button from "../../components/Button/Button";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { findSession } from "../../utils/sessionStore";
import { answerAsk, type SocketAsk } from "../../utils/socketAsks";
import ApprovalDraft from "./ApprovalDraft";
import styles from "./Chat.module.css";

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
