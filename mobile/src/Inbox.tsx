import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import SegmentedControl from "../../src/components/SegmentedControl/SegmentedControl";
import {
  byProjectNewestFirst,
  eventTime,
  kindLabel,
  unanswered,
  type NeedsYouEvent,
} from "../../src/utils/needsYouSignals";
import { signalLabel, type ReviewItem } from "../../src/utils/reviewSignals";
import type { RemoteClient } from "./remote";
import { DOT, Offline } from "./Root";
import { PushTop } from "./Screens";
import type { SessionRow } from "./tree";
import mobile from "./mobile.module.css";
import styles from "./shell.module.css";

// Rust walks every session's git state for this, slower than a plain read.
const LIST_REPLY_MS = 30_000;
// Session events come in bursts while an agent works; one refresh per burst.
const REFRESH_DELAY_MS = 3000;

export function watchInbox(client: RemoteClient) {
  const [items, { refetch }] = createResource<ReviewItem[], number>(
    () => client.generation() || undefined,
    (_, info) => client.request<ReviewItem[]>("review.list", {}, LIST_REPLY_MS).catch(() => info.value ?? []),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(
    client.subscribe("sessions", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refetch(), REFRESH_DELAY_MS);
    }),
  );
  onCleanup(() => clearTimeout(timer));
  return { items: () => items() ?? [], refetch: () => void refetch() };
}

export function watchNeedsYou(client: RemoteClient) {
  const [events, { refetch }] = createResource<NeedsYouEvent[], number>(
    () => client.generation() || undefined,
    (_, info) => client.request<NeedsYouEvent[]>("needs_you.list").catch(() => info.value ?? []),
  );
  onCleanup(
    client.subscribe("sessions", (data) => {
      if ((data as { kind?: string } | null)?.kind === "needs_you.changed") void refetch();
    }),
  );
  return { events: () => events() ?? [], count: () => unanswered(events() ?? []) };
}

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function NeedsYouList(props: { events: NeedsYouEvent[]; onOpen: (e: NeedsYouEvent) => void }) {
  return (
    <Show when={props.events.length} fallback={<p class={styles.empty}>Nothing has needed you in the last day.</p>}>
      <For each={byProjectNewestFirst(props.events)}>
        {(group) => (
          <>
            <h2 class={styles.label}>{group.project || "No project"}</h2>
            <ul class={styles.group}>
              <For each={group.events}>
                {(e) => (
                  <li>
                    <button
                      class={styles.item}
                      data-answered={e.resolvedAt !== null ? "" : undefined}
                      onClick={() => props.onOpen(e)}
                    >
                      <span class={styles.text}>
                        <span class={styles.name}>{e.title || folderName(e.folder)}</span>
                        <span class={styles.meta}>
                          {kindLabel(e.kind)} {DOT} {eventTime(e.ts)}
                          <Show when={e.resolvedAt !== null}> {DOT} answered</Show>
                        </span>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </For>
    </Show>
  );
}

function Card(props: {
  client: RemoteClient;
  item: ReviewItem;
  row: SessionRow | undefined;
  onReply: (row: SessionRow) => void;
  onMarked: () => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.client.request("review.mark", { id: props.item.unit.id, to_ts: props.item.toTs });
      props.onMarked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li class={styles.card} data-phase={props.item.running ? "working" : undefined}>
      <div class={styles.reviewHead}>
        <span class={styles.reviewScore} aria-label={`Risk ${props.item.score}`}>
          {props.item.score}
        </span>
        <span class={styles.text}>
          <span class={styles.reviewTitle}>{props.item.title || props.item.unit.id.slice(0, 8)}</span>
          <span class={styles.meta}>
            {folderName(props.item.folder)} {DOT} {props.item.agent}
          </span>
        </span>
      </div>
      <Show when={props.item.summary}>{(summary) => <p class={styles.reviewSummary}>{summary()}</p>}</Show>
      <div class={styles.reviewSignals}>
        <For each={props.item.signals}>
          {(signal) => (
            <span class={styles.reviewSignal} data-kind={signal.kind}>
              {signalLabel(signal)}
            </span>
          )}
        </For>
      </div>
      <Show when={error()}>
        <p class={styles.empty}>{error()}</p>
      </Show>
      <div class={mobile.cardActions}>
        <Show when={props.row}>
          {(row) => (
            <button class={mobile.secondary} onClick={() => props.onReply(row())}>
              Reply
            </button>
          )}
        </Show>
        <button class={mobile.primarySmall} disabled={props.item.running || busy()} onClick={() => void approve()}>
          {props.item.running ? "Still working" : "Approve"}
        </button>
      </div>
    </li>
  );
}

type Tab = "needsYou" | "review";

export default function InboxScreen(props: {
  client: RemoteClient;
  inbox: ReturnType<typeof watchInbox>;
  needsYou: ReturnType<typeof watchNeedsYou>;
  live: () => SessionRow[];
  onReply: (row: SessionRow) => void;
  onEvent: (e: NeedsYouEvent) => void;
  onBack: () => void;
}) {
  props.inbox.refetch();
  const [tab, setTab] = createSignal<Tab>(
    props.needsYou.count() > 0 || !props.inbox.items().length ? "needsYou" : "review",
  );
  return (
    <div class={styles.glow}>
      <PushTop back="Back" onBack={props.onBack} />
      <Offline client={props.client} />
      <div class={styles.scroll}>
        <h1 class={styles.screenTitle}>Inbox</h1>
        <SegmentedControl<Tab>
          aria-label="Inbox list"
          variant="plain"
          value={tab()}
          onChange={setTab}
          options={[
            { value: "needsYou", label: `Needs you ${props.needsYou.count()}` },
            { value: "review", label: `Review ${props.inbox.items().length}` },
          ]}
        />
        <Show when={tab() === "needsYou"}>
          <NeedsYouList events={props.needsYou.events()} onOpen={props.onEvent} />
        </Show>
        <Show when={tab() === "review"}>
          <Show when={props.inbox.items().length} fallback={<p class={styles.empty}>Nothing is waiting for review.</p>}>
            <ul class={styles.cards}>
              <For each={props.inbox.items()}>
                {(item) => (
                  <Card
                    client={props.client}
                    item={item}
                    row={props.live().find((row) => row.id === item.unit.id)}
                    onReply={props.onReply}
                    onMarked={props.inbox.refetch}
                  />
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </div>
  );
}
