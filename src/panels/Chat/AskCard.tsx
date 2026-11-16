import { createSignal, For, Show } from "solid-js";
import Button from "../../components/Button/Button";
import { findSession } from "../../utils/sessionStore";
import type { SocketAsk } from "../../utils/socketAsks";
import ApprovalDraft from "./ApprovalDraft";
import { answering } from "./answering";
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
  const { sending, send } = answering(() => props.ask.id);
  const [pressed, setPressed] = createSignal<string | null>(null);
  const chosen = () => (sending() ? pressed() : null);

  const Question = () => (
    <>
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
    </>
  );

  const Answers = () => (
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
          <Button
            size="sm"
            disabled={sending()}
            data-chosen={chosen() === option ? "" : undefined}
            onClick={() => {
              setPressed(option);
              send(option);
            }}
          >
            {option}
          </Button>
        )}
      </For>
    </Show>
  );

  return (
    <Show
      when={props.ask.approval}
      fallback={
        <div class={`${styles.banner} ${styles.ask}`}>
          <span class={styles.bannerText}>
            <Question />
          </span>
          <Answers />
        </div>
      }
    >
      {(approval) => (
        <div class={`${styles.banner} ${styles.ask} ${styles.askApproval}`}>
          <span class={styles.askTitle}>
            <Question />
          </span>
          <ApprovalDraft approval={approval()} />
          <div class={styles.askFooter}>
            <Answers />
          </div>
        </div>
      )}
    </Show>
  );
}
