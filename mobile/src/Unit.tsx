import { For, Show, createResource, onCleanup } from "solid-js";
import { bucketByLastActive } from "../../src/utils/sessionBuckets";
import type { RemoteClient } from "./remote";
import { inUnit, sessionLabel, type SessionRow, type Unit } from "./tree";
import styles from "./mobile.module.css";

const EARLIER_LIMIT = 100;

function SessionButton(props: { row: SessionRow; onOpen: (row: SessionRow) => void }) {
  return (
    <li>
      <button class={styles.row} onClick={() => props.onOpen(props.row)}>
        <span class={styles.dot} data-dot={props.row.dot ?? ""} />
        <span class={styles.rowText}>
          <span class={styles.rowTitle}>{sessionLabel(props.row)}</span>
          <span class={styles.rowMeta}>{props.row.agent}</span>
        </span>
      </button>
    </li>
  );
}

export default function UnitScreen(props: {
  client: RemoteClient;
  unit: Unit;
  live: () => SessionRow[];
  onOpen: (row: SessionRow) => void;
  onBack: () => void;
}) {
  const here = () => props.live().filter((row) => inUnit(row.home, props.unit));
  const [earlier, { refetch }] = createResource<SessionRow[], number>(
    () => props.client.generation() || undefined,
    (_, info) =>
      props.client
        .request<SessionRow[]>("sessions.list", { cwd: props.unit.folder, limit: EARLIER_LIMIT })
        .then((rows) => rows.filter((row) => !row.live && inUnit(row.home, props.unit)))
        .catch(() => info.value ?? []),
  );
  onCleanup(
    props.client.subscribe("sessions", (data) => {
      if ((data as { kind?: string } | null)?.kind === "session.ended") void refetch();
    }),
  );
  const buckets = () => bucketByLastActive(earlier() ?? [], Date.now() / 1000);

  return (
    <div class={styles.screen}>
      <header class={styles.bar}>
        <button class={styles.back} onClick={() => props.onBack()}>
          Back
        </button>
        <span class={styles.title}>{props.unit.label}</span>
      </header>
      <div class={styles.list}>
        <Show when={here().length > 0}>
          <h2 class={styles.section}>Live</h2>
          <ul class={styles.plain}>
            <For each={here()}>{(row) => <SessionButton row={row} onOpen={props.onOpen} />}</For>
          </ul>
        </Show>
        <For
          each={buckets()}
          fallback={
            <Show when={here().length === 0}>
              <p class={styles.hint}>{earlier.loading ? "Loading" : "No sessions here yet"}</p>
            </Show>
          }
        >
          {(bucket) => (
            <>
              <h2 class={styles.section}>{bucket.label}</h2>
              <ul class={styles.plain}>
                <For each={bucket.sessions}>{(row) => <SessionButton row={row} onOpen={props.onOpen} />}</For>
              </ul>
            </>
          )}
        </For>
      </div>
    </div>
  );
}
