import { For, Show, onCleanup, onMount } from "solid-js";
import Button from "../../components/Button/Button";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import {
  markReviewed,
  openItem,
  reviewItems,
  setInboxOpen,
  signalLabel,
  type ReviewItem,
} from "../../utils/reviewInbox";
import styles from "./InboxView.module.css";

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function Row(props: { item: ReviewItem }) {
  return (
    <li class={styles.row}>
      <button type="button" class={styles.open} onClick={() => openItem(props.item)}>
        <span class={styles.score} aria-label={`Risk ${props.item.score}`}>
          {props.item.score}
        </span>
        <span class={styles.body}>
          <span class={styles.title}>{props.item.title || props.item.unit.id.slice(0, 8)}</span>
          <span class={styles.where}>
            {folderName(props.item.folder)} · {props.item.agent}
          </span>
          <Show when={props.item.summary}>{(summary) => <span class={styles.summary}>{summary()}</span>}</Show>
          <span class={styles.signals}>
            <For each={props.item.signals}>
              {(signal) => (
                <span class={styles.signal} data-kind={signal.kind}>
                  {signalLabel(signal)}
                </span>
              )}
            </For>
          </span>
        </span>
      </button>
      <Button
        size="sm"
        class={styles.mark}
        disabled={props.item.running}
        tooltip={props.item.running ? "Still working. Mark it once its turn ends." : undefined}
        tooltipWhenDisabled
        onClick={() => void markReviewed(props.item)}
      >
        Mark reviewed
      </Button>
    </li>
  );
}

export default function InboxView() {
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && setInboxOpen(false);
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));
  return (
    <section class={styles.overlay} aria-label="Inbox">
      <header class={styles.head}>
        <h2 class={styles.heading}>Inbox</h2>
        <span class={styles.count}>{reviewItems().length}</span>
        <Button variant="ghost" size="sm" class={styles.close} onClick={() => setInboxOpen(false)}>
          Close
        </Button>
      </header>
      <Show when={reviewItems().length} fallback={<p class={styles.empty}>Nothing is waiting for review.</p>}>
        <OverlayScroll class={styles.scroll}>
          <ul class={styles.list}>
            <For each={reviewItems()}>{(item) => <Row item={item} />}</For>
          </ul>
        </OverlayScroll>
      </Show>
    </section>
  );
}
