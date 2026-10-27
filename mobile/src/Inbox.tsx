import { For, Index, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import SegmentedControl from "../../src/components/SegmentedControl/SegmentedControl";
import {
  digestCount,
  digestTime,
  finishedParts,
  happenedParts,
  isLimit,
  type Digest,
  type Finished,
} from "../../src/utils/digest";
import {
  byProjectNewestFirst,
  eventTime,
  kindLabel,
  unanswered,
  type NeedsYouEvent,
} from "../../src/utils/needsYouSignals";
import { byPlace, type PermissionRow } from "../../src/utils/permissionGroups";
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

export function watchPermissions(client: RemoteClient) {
  const [rows, { refetch }] = createResource<PermissionRow[], number>(
    () => client.generation() || undefined,
    (_, info) => client.request<PermissionRow[]>("permissions.pending").catch(() => info.value ?? []),
  );
  onCleanup(
    client.subscribe("sessions", (data) => {
      if ((data as { kind?: string } | null)?.kind === "permissions.changed") void refetch();
    }),
  );
  return { rows: () => rows() ?? [], count: () => (rows() ?? []).length, refetch: () => void refetch() };
}

// While the tab shows, its start stays where it opened, so reading it does not
// empty it under you. It counts as seen once it stops showing or the app goes
// to the background, on every device at once.
export function watchDigest(client: RemoteClient) {
  let shown = false;
  let pinned: number | undefined;
  const [digest, { refetch }] = createResource<Digest | null, number>(
    () => client.generation() || undefined,
    (_, info) =>
      client
        .request<Digest>("digest.list", shown && pinned !== undefined ? { since: pinned } : {}, LIST_REPLY_MS)
        .then((d) => {
          if (shown && pinned === undefined) pinned = d.since;
          return d;
        })
        .catch(() => info.value ?? null),
  );
  onCleanup(
    client.subscribe("sessions", (data) => {
      if ((data as { kind?: string } | null)?.kind === "needs_you.changed") void refetch();
    }),
  );
  const looked = () => {
    const d = digest();
    if (!shown || !d) return Promise.resolve();
    return client.request("digest.looked", { at: d.asOf }).catch(() => {});
  };
  const away = () => {
    if (document.visibilityState === "hidden") void looked();
  };
  document.addEventListener("visibilitychange", away);
  onCleanup(() => document.removeEventListener("visibilitychange", away));
  return {
    digest: () => digest() ?? null,
    count: () => digestCount(digest() ?? null),
    show: () => {
      shown = true;
      pinned = undefined;
      void refetch();
    },
    hide: () => {
      void looked().then(() => void refetch());
      shown = false;
      pinned = undefined;
    },
  };
}

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

const asEvent = (f: Finished): NeedsYouEvent => ({
  id: f.session,
  ts: f.lastTs,
  session: f.session,
  folder: f.folder,
  branch: f.branch,
  project: f.project,
  title: f.title,
  kind: "done",
  resolvedAt: null,
  settled: false,
  chat: f.chat,
});

function Rows(props: { label: string; rows: { title: string; meta: string; open: () => void }[] }) {
  return (
    <Show when={props.rows.length}>
      <h2 class={styles.label}>{props.label}</h2>
      <ul class={styles.group}>
        <Index each={props.rows}>
          {(row) => (
            <li>
              <button class={styles.item} onClick={() => row().open()}>
                <span class={styles.text}>
                  <span class={styles.name}>{row().title}</span>
                  <span class={styles.meta}>{row().meta}</span>
                </span>
              </button>
            </li>
          )}
        </Index>
      </ul>
    </Show>
  );
}

function SinceList(props: { watch: ReturnType<typeof watchDigest>; onOpen: (e: NeedsYouEvent) => void }) {
  onMount(props.watch.show);
  onCleanup(props.watch.hide);
  const d = () => props.watch.digest();
  const where = (project: string, folder: string) => project || folderName(folder);
  const happened = (limits: boolean) =>
    (d()?.happened ?? [])
      .filter((e) => isLimit(e) === limits)
      .map((e) => ({
        title: e.title || folderName(e.folder),
        meta: [where(e.project, e.folder), ...happenedParts(e)].join(` ${DOT} `),
        open: () => props.onOpen(e),
      }));
  return (
    <Show
      when={props.watch.count()}
      fallback={<p class={styles.empty}>Nothing finished since you last looked, and nothing is waiting on you.</p>}
    >
      <Rows
        label={`Finished since ${digestTime(d()?.since ?? 0)}`}
        rows={(d()?.finished ?? []).map((f) => ({
          title: f.title || folderName(f.folder),
          meta: [where(f.project, f.folder), ...finishedParts(f)].join(` ${DOT} `),
          open: () => props.onOpen(asEvent(f)),
        }))}
      />
      <Rows label="Pull requests" rows={happened(false)} />
      <Rows label="Usage limits" rows={happened(true)} />
      <Rows
        label="Waiting on you"
        rows={(d()?.waiting ?? []).map((e) => ({
          title: e.title || folderName(e.folder),
          meta: `${where(e.project, e.folder)} ${DOT} ${kindLabel(e.kind)} ${DOT} ${eventTime(e.ts)}`,
          open: () => props.onOpen(e),
        }))}
      />
    </Show>
  );
}

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

const agentName = (agent: string) => agent.charAt(0).toUpperCase() + agent.slice(1);

function CommandCard(props: {
  client: RemoteClient;
  rows: PermissionRow[];
  onOpen: (row: PermissionRow) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  const [error, setError] = createSignal<string | null>(null);
  const first = () => props.rows[0];
  const count = () => props.rows.length;
  const run = async (key: string, call: () => Promise<unknown>) => {
    setBusy((keys) => new Set(keys).add(key));
    setError(null);
    try {
      await call();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((keys) => {
        const left = new Set(keys);
        left.delete(key);
        return left;
      });
      props.onDone();
    }
  };
  const allowing = () => busy().has("allow");
  const allow = () =>
    run("allow", async () => {
      const ids = props.rows.map((r) => ({ session: r.session, id: r.id }));
      const { failed } = await props.client.request<{ failed: string[] }>("permissions.allow_group", { ids });
      if (failed.length) throw new Error(`${failed.length} of ${ids.length} did not reach the agent: ${failed[0]}`);
    });
  const deny = (row: PermissionRow) =>
    run(row.id, () => props.client.request("permissions.deny", { session: row.session, id: row.id }));
  return (
    <li class={styles.card}>
      <span class={styles.text}>
        <code class={styles.permissionCommand}>{first().action ?? first().tool}</code>
        <span class={styles.meta}>
          {[agentName(first().agent), first().tool, `${count()} waiting`].join(` ${DOT} `)}
        </span>
        <Show when={first().rule}>
          {(rule) => (
            <span class={styles.meta} data-tone="attention">
              {agentName(first().agent)} will remember {rule()}
            </span>
          )}
        </Show>
      </span>
      <ul class={styles.permissionRows}>
        <For each={props.rows}>
          {(row) => (
            <li class={styles.permissionRow}>
              <button class={styles.item} onClick={() => props.onOpen(row)}>
                <span class={styles.text}>
                  <span class={styles.name}>{folderName(row.folder)}</span>
                  <span class={styles.meta}>{row.tool}</span>
                </span>
              </button>
              <button
                class={mobile.secondary}
                disabled={allowing() || busy().has(row.id)}
                onClick={() => void deny(row)}
              >
                Deny
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={error()}>
        <p class={styles.empty}>{error()}</p>
      </Show>
      <div class={mobile.cardActions}>
        <button class={mobile.primarySmall} disabled={allowing()} onClick={() => void allow()}>
          {count() === 1 ? "Always allow" : `Always allow for all ${count()}`}
        </button>
      </div>
    </li>
  );
}

function PermissionList(props: {
  client: RemoteClient;
  watch: ReturnType<typeof watchPermissions>;
  onOpen: (row: PermissionRow) => void;
}) {
  return (
    <Show when={props.watch.count()} fallback={<p class={styles.empty}>No worker is waiting on a permission.</p>}>
      <For each={byPlace(props.watch.rows())}>
        {(place) => (
          <>
            <h2 class={styles.label}>
              {place.project ? folderName(place.place) : `Other: ${folderName(place.place)}`}
            </h2>
            <ul class={styles.cards}>
              <For each={place.commands}>
                {(command) => (
                  <CommandCard
                    client={props.client}
                    rows={command.rows}
                    onOpen={props.onOpen}
                    onDone={props.watch.refetch}
                  />
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

type Tab = "since" | "needsYou" | "permissions" | "review";

export default function InboxScreen(props: {
  client: RemoteClient;
  inbox: ReturnType<typeof watchInbox>;
  needsYou: ReturnType<typeof watchNeedsYou>;
  permissions: ReturnType<typeof watchPermissions>;
  digest: ReturnType<typeof watchDigest>;
  live: () => SessionRow[];
  onReply: (row: SessionRow) => void;
  onEvent: (e: NeedsYouEvent) => void;
  onPermission: (row: PermissionRow) => void;
  onBack: () => void;
}) {
  props.inbox.refetch();
  const [tab, setTab] = createSignal<Tab>(
    props.digest.count() > 0
      ? "since"
      : props.needsYou.count() > 0 || !props.inbox.items().length
        ? "needsYou"
        : "review",
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
            { value: "since", label: `Since ${props.digest.count()}` },
            { value: "needsYou", label: `Needs you ${props.needsYou.count()}` },
            { value: "permissions", label: `Permissions ${props.permissions.count()}` },
            { value: "review", label: `Review ${props.inbox.items().length}` },
          ]}
        />
        <Show when={tab() === "since"}>
          <SinceList watch={props.digest} onOpen={props.onEvent} />
        </Show>
        <Show when={tab() === "needsYou"}>
          <NeedsYouList events={props.needsYou.events()} onOpen={props.onEvent} />
        </Show>
        <Show when={tab() === "permissions"}>
          <PermissionList client={props.client} watch={props.permissions} onOpen={props.onPermission} />
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
