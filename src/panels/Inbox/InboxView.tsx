import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import Button from "../../components/Button/Button";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import SegmentedControl from "../../components/SegmentedControl/SegmentedControl";
import { needsYouCount, needsYouEvents, openEvent } from "../../utils/needsYouInbox";
import { byProjectNewestFirst, kindLabel, type NeedsYouEvent } from "../../utils/needsYouSignals";
import { markReviewed, openItem, reviewItems, setInboxOpen } from "../../utils/reviewInbox";
import { opinionLabel, runSecondOpinion, secondOpinionRunning } from "../../utils/secondOpinion";
import { signalLabel, type ReviewItem } from "../../utils/reviewSignals";
import styles from "./InboxView.module.css";

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function Row(props: { item: ReviewItem }) {
  const opinionRunning = () =>
    props.item.secondOpinion?.state === "running" || secondOpinionRunning(props.item.unit.id);
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
            <Show when={props.item.secondOpinion}>
              {(opinion) => {
                const error = () => {
                  const o = opinion();
                  return o.state === "failed" ? o.error : undefined;
                };
                return (
                  <span class={styles.signal} data-kind={error() ? "failed" : "secondOpinion"} title={error()}>
                    {opinionLabel(opinion())}
                  </span>
                );
              }}
            </Show>
          </span>
        </span>
      </button>
      <Button
        size="sm"
        class={styles.mark}
        disabled={opinionRunning()}
        onClick={() =>
          void runSecondOpinion({ id: props.item.unit.id, cwd: props.item.folder, agent: props.item.agent })
        }
      >
        Second opinion
      </Button>
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

function time(ts: number) {
  const at = new Date(ts);
  const clock = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === new Date().toDateString() ? clock : `Yesterday ${clock}`;
}

function EventRow(props: { event: NeedsYouEvent }) {
  return (
    <li class={styles.row} classList={{ [styles.answered]: props.event.resolvedAt !== null }}>
      <button type="button" class={styles.open} onClick={() => openEvent(props.event)}>
        <span class={styles.body}>
          <span class={styles.title}>{props.event.title || folderName(props.event.folder)}</span>
          <span class={styles.where}>
            <span class={styles.kind} data-kind={props.event.kind}>
              {kindLabel(props.event.kind)}
            </span>{" "}
            · {time(props.event.ts)}
            <Show when={props.event.resolvedAt !== null}> · answered</Show>
          </span>
        </span>
      </button>
    </li>
  );
}

type Tab = "needsYou" | "review";

export default function InboxView() {
  const [tab, setTab] = createSignal<Tab>(needsYouCount() > 0 || !reviewItems().length ? "needsYou" : "review");
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && setInboxOpen(false);
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));
  return (
    <section class={styles.overlay} aria-label="Inbox">
      <header class={styles.head}>
        <h2 class={styles.heading}>Inbox</h2>
        <SegmentedControl<Tab>
          aria-label="Inbox list"
          size="sm"
          variant="plain"
          value={tab()}
          onChange={setTab}
          options={[
            { value: "needsYou", label: `Needs you ${needsYouCount()}` },
            { value: "review", label: `Review ${reviewItems().length}` },
          ]}
        />
        <Button variant="ghost" size="sm" class={styles.close} onClick={() => setInboxOpen(false)}>
          Close
        </Button>
      </header>
      <Show when={tab() === "needsYou"}>
        <Show
          when={needsYouEvents().length}
          fallback={<p class={styles.empty}>Nothing has needed you in the last day.</p>}
        >
          <OverlayScroll class={styles.scroll}>
            <For each={byProjectNewestFirst(needsYouEvents())}>
              {(group) => (
                <section class={styles.group} aria-label={group.project || "No project"}>
                  <h3 class={styles.groupHead}>{group.project || "No project"}</h3>
                  <ul class={styles.list}>
                    <For each={group.events}>{(event) => <EventRow event={event} />}</For>
                  </ul>
                </section>
              )}
            </For>
          </OverlayScroll>
        </Show>
      </Show>
      <Show when={tab() === "review"}>
        <Show when={reviewItems().length} fallback={<p class={styles.empty}>Nothing is waiting for review.</p>}>
          <OverlayScroll class={styles.scroll}>
            <ul class={styles.list}>
              <For each={reviewItems()}>{(item) => <Row item={item} />}</For>
            </ul>
          </OverlayScroll>
        </Show>
      </Show>
    </section>
  );
}
