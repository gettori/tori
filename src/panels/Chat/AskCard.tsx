import { createSignal, For, Show } from "solid-js";
import Button from "../../components/Button/Button";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { findSession } from "../../utils/sessionStore";
import { answerAsk, type SocketAsk } from "../../utils/socketAsks";
import ApprovalDraft from "./ApprovalDraft";
import Tip from "./Tip";
import Tooltip from "../../components/Tooltip/Tooltip";
import styles from "./Chat.module.css";

export default function AskCard(props: { ask: SocketAsk; here: string }) {
  const meta = () => findSession(props.ask.session)?.session;
  const asker = () => {
    if (props.ask.session === props.here) return null;
    return meta()?.name || meta()?.title || props.ask.session.slice(0, 8);
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
    <div class={`${styles.banner} ${styles.ask}${props.ask.approval ? ` ${styles.askApproval}` : ""}`}>
      <span class={styles.bannerText}>
        <Show when={asker()}>
          {(name) => (
            <Tooltip<HTMLSpanElement>
              as="span"
              class={styles.askDraftMeta}
              label={
                <Tip
                  heading={meta()?.title || name()}
                  lines={[`Session ${props.ask.session.slice(0, 8)}`, ...(meta()?.cwd ? [meta()!.cwd] : [])]}
                  hint="Your answer goes back to that session, not this one"
                />
              }
            >
              {name()} asks:{" "}
            </Tooltip>
          )}
        </Show>
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
