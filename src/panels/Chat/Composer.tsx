import { For, Show, createSignal } from "solid-js";
import { Send, Square } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Button from "../../components/Button/Button";
import type { QueuedInput } from "./chatStore";
import { chipLabel, type PendingBlock } from "../../utils/chatCompose";
import styles from "./Chat.module.css";

/**
 * The input.
 *
 * Enter sends, Shift+Enter is a newline, Escape interrupts a running turn. The
 * send button becomes a stop button while a turn runs, so there is one control
 * in one place rather than two that disagree.
 *
 * Typing during a turn never drops input and never interleaves it into the
 * running turn: it queues, visibly. The strip below the input is the queue, and
 * every entry in it is removable. When the turn was *cancelled* the queue is
 * held rather than flushed (see `pendingFlush`), and the strip grows send-now
 * and discard actions, because a turn the user stopped must not fire the
 * messages they stopped it to prevent.
 *
 * Attachments (an editor selection, a hunk comment, a diagnostic) arrive as
 * chips above the input and wait there. They are removable and nothing about
 * their arrival sends anything: [[concept_safe_send]]'s insert-only contract is
 * the same on this surface as on a terminal.
 */
export default function Composer(props: {
  running: boolean;
  queue: readonly QueuedInput[];
  attachments: readonly PendingBlock[];
  held: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onDropQueued: (id: string) => void;
  onDropAttachment: (id: string) => void;
  onSendQueued: () => void;
  onDiscardQueued: () => void;
}) {
  const [text, setText] = createSignal("");
  let input: HTMLTextAreaElement | undefined;

  // A turn of nothing but a file reference is a real thing to send ("look at
  // this"), so an attachment is enough on its own.
  const hasContent = () => !!text().trim() || props.attachments.length > 0;

  function submit() {
    const value = text().trim();
    if (!hasContent() || props.disabled) return;
    props.onSend(value);
    setText("");
    // The textarea grows with its content, so it has to be shrunk back by hand.
    if (input) input.style.height = "";
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Escape" && props.running) {
      e.preventDefault();
      props.onInterrupt();
    }
  }

  return (
    <div class={styles.composer}>
      <Show when={props.queue.length}>
        <div class={`${styles.queue} ${props.held ? styles.queueHeld : ""}`}>
          <span class={styles.queueLabel}>
            {props.held
              ? `${props.queue.length} message${props.queue.length > 1 ? "s" : ""} held: the turn was stopped`
              : `Queued for the next turn`}
          </span>
          <For each={props.queue}>
            {(q) => (
              <button
                type="button"
                class={styles.queueItem}
                title="Remove from the queue"
                onClick={() => props.onDropQueued(q.id)}
              >
                {q.text}
              </button>
            )}
          </For>
          <Show when={props.held}>
            <div class={styles.queueActions}>
              <Button size="sm" variant="primary" onClick={() => props.onSendQueued()}>
                Send now
              </Button>
              <Button size="sm" onClick={() => props.onDiscardQueued()}>
                Discard
              </Button>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={props.attachments.length}>
        <div class={styles.attachments}>
          <For each={props.attachments}>
            {(a) => (
              <button
                type="button"
                class={styles.attachment}
                title="Remove this attachment"
                onClick={() => props.onDropAttachment(a.id)}
              >
                {chipLabel(a.block)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class={styles.composerRow}>
        <textarea
          ref={input}
          class={styles.input}
          rows="1"
          placeholder={props.running ? "Type to queue for the next turn" : "Message Claude"}
          value={text()}
          disabled={props.disabled}
          onInput={(e) => {
            setText(e.currentTarget.value);
            // Auto-grow to the content, capped in CSS.
            e.currentTarget.style.height = "";
            e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          class={styles.sendButton}
          title={props.running ? "Stop this turn (Esc)" : "Send (Enter)"}
          aria-label={props.running ? "Stop" : "Send"}
          disabled={props.disabled || (!props.running && !hasContent())}
          onClick={() => (props.running ? props.onInterrupt() : submit())}
        >
          <Icon icon={props.running ? Square : Send} />
        </button>
      </div>
    </div>
  );
}
