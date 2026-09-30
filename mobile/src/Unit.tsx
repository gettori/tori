import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Plus } from "lucide-solid";
import Icon from "../../src/components/Icon/Icon";
import { WheelGlyph } from "../../src/components/Autopilot/Wheel";
import { agentMark } from "../../src/components/Icon/agentMarks";
import SyncMarks from "../../src/components/SyncMarks/SyncMarks";
import { syncMarks } from "../../src/utils/branchSync";
import { ago } from "../../src/utils/relativeTime";
import { bucketByLastActive } from "../../src/utils/sessionBuckets";
import type { Crew } from "./Autopilot";
import { REFUSED_CODE, RpcError, type RemoteClient } from "./remote";
import { DOT, Offline, PhaseMark } from "./Root";
import { GitCounts, PushTop, watchGit, watchSync } from "./Screens";
import { PHASE_LABEL, agentHolds, atUnit, newest, phaseOf, sessionLabel, type SessionRow, type Topic, type Unit } from "./tree";
import styles from "./shell.module.css";

const EARLIER_LIMIT = 100;
const FALLBACK_AGENT = "claude";

export function AgentMark(props: { agent: string | undefined; size: number }) {
  return (
    <Show when={agentMark(props.agent)} fallback={<span>{(props.agent ?? "?").slice(0, 1).toUpperCase()}</span>}>
      {(mark) => <Dynamic component={mark()} size={`${props.size}px`} />}
    </Show>
  );
}

function NowCard(props: { row: SessionRow; where?: string; crewed: boolean; spinning: boolean; onOpen: () => void }) {
  const phase = () => phaseOf(props.row);
  return (
    <li>
      <button class={styles.card} data-phase={phase()} onClick={() => props.onOpen()}>
        <span class={styles.cardHead}>
          <span class={styles.agentTile}>
            <AgentMark agent={props.row.agent} size={15} />
          </span>
          <span class={styles.cardTitle}>{sessionLabel(props.row)}</span>
        </span>
        <span class={styles.stateRow}>
          <PhaseMark phase={phase()} />
          <span class={styles.stateLabel} data-phase={phase()}>
            {PHASE_LABEL[phase()]}
          </span>
          <span class={styles.time}>{props.where ? `${props.where} ${DOT} ` : ""}{ago(props.row.last_active)}</span>
          <Show when={props.crewed}>
            <span class={styles.apChip} data-spin={props.spinning}>
              <WheelGlyph size={12} />
              Autopilot
            </span>
          </Show>
        </span>
      </button>
    </li>
  );
}

function HistoryItem(props: { row: SessionRow; where?: string; onOpen: () => void }) {
  return (
    <li>
      <button class={`${styles.item} ${styles.historyItem}`} onClick={() => props.onOpen()}>
        <span class={styles.historyMark}>
          <AgentMark agent={props.row.agent} size={14} />
        </span>
        <span class={styles.historyTitle}>{sessionLabel(props.row)}</span>
        <span class={styles.time}>{props.where ? `${props.where} ${DOT} ` : ""}{ago(props.row.last_active)}</span>
      </button>
    </li>
  );
}

/** The live sessions in `units` and the ended ones the Mac lists for their folders. */
export function unitSessions(client: RemoteClient, units: () => Unit[], live: () => SessionRow[], topic?: Pick<Topic, "id" | "home">) {
  const owned = (row: SessionRow) => units().some((unit) => atUnit(row, unit)) || (!!topic && row.home?.topic === topic.id);
  const folders = () => [...units().map((unit) => unit.folder), ...(topic?.home ? [topic.home] : [])];
  const here = () => live().filter(owned);
  const [earlier, { refetch }] = createResource<SessionRow[], number>(
    () => client.generation() || undefined,
    (_, info) =>
      Promise.all(folders().map((cwd) => client.request<SessionRow[]>("sessions.list", { cwd, limit: EARLIER_LIMIT })))
        .then((lists) => {
          const rows = new Map(lists.flat().filter((row) => !row.live && owned(row)).map((row) => [row.id, row]));
          return [...rows.values()].sort((a, b) => b.last_active - a.last_active);
        })
        .catch(() => info.value ?? []),
  );
  onCleanup(
    client.subscribe("sessions", (data) => {
      if ((data as { kind?: string } | null)?.kind === "session.ended") void refetch();
    }),
  );
  return { here, earlier };
}

export function SessionList(props: {
  here: SessionRow[];
  earlier: SessionRow[] | undefined;
  crew: () => Crew;
  autopilotOn: boolean;
  where?: (row: SessionRow) => string | undefined;
  onOpen: (row: SessionRow) => void;
}) {
  const buckets = () => bucketByLastActive(props.earlier ?? [], Date.now() / 1000);
  return (
    <>
      <Show when={props.here.length > 0}>
        <h2 class={styles.label}>Now</h2>
        <ul class={styles.cards}>
          <For each={props.here}>
            {(row) => (
              <NowCard
                row={row}
                where={props.where?.(row)}
                crewed={props.crew().sessions.has(row.id)}
                spinning={props.autopilotOn}
                onOpen={() => props.onOpen(row)}
              />
            )}
          </For>
        </ul>
      </Show>
      <For
        each={buckets()}
        fallback={
          <Show when={props.here.length === 0}>
            <p class={styles.empty}>{props.earlier === undefined ? "Loading" : "No sessions here yet"}</p>
          </Show>
        }
      >
        {(bucket) => (
          <>
            <h2 class={styles.label}>{bucket.label}</h2>
            <ul class={styles.group}>
              <For each={bucket.sessions}>{(row) => <HistoryItem row={row} where={props.where?.(row)} onOpen={() => props.onOpen(row)} />}</For>
            </ul>
          </>
        )}
      </For>
    </>
  );
}

export default function UnitScreen(props: {
  client: RemoteClient;
  unit: Unit;
  back: string;
  live: () => SessionRow[];
  crew: () => Crew;
  autopilotOn: boolean;
  onOpen: (row: SessionRow) => void;
  onBack: () => void;
}) {
  const { here, earlier } = unitSessions(props.client, () => [props.unit], props.live);
  const git = watchGit(props.client, () => [props.unit.folder]);
  const sync = watchSync(props.client, () => [props.unit]);
  const [spawning, setSpawning] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const spawn = (agent: string) =>
    props.client.request<{ id: string; agent: string }>("session.spawn", { folder: props.unit.folder, agent });

  // The desktop's remembered agent is not on the socket, so the last one used
  // here stands in; a refusal means it has no chat surface.
  const startNew = async () => {
    const remembered = newest([...here(), ...(earlier() ?? [])])?.agent ?? FALLBACK_AGENT;
    setSpawning(true);
    setError(null);
    try {
      const started = await spawn(remembered).catch((e: unknown) => {
        if (e instanceof RpcError && e.code === REFUSED_CODE && remembered !== FALLBACK_AGENT) return spawn(FALLBACK_AGENT);
        throw e;
      });
      props.onOpen({
        id: started.id,
        agent: started.agent,
        cwd: props.unit.folder,
        live: true,
        last_active: Math.floor(Date.now() / 1000),
        home: { project: "", folder: props.unit.folder, branch: props.unit.branch },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSpawning(false);
    }
  };

  return (
    <div class={styles.glow}>
      <PushTop
        back={props.back}
        onBack={props.onBack}
        end={
          <button class={styles.newPill} disabled={spawning()} onClick={() => void startNew()}>
            <Icon icon={Plus} size={13} strokeWidth={2.6} />
            New
          </button>
        }
      />
      <Offline client={props.client} />
      <Show when={error()}>
        <p class={styles.banner}>{error()}</p>
      </Show>
      <div class={styles.scroll}>
        <div class={styles.unitHead}>
          <span class={styles.headTitle}>{props.unit.label}</span>
          <GitCounts
            git={git()?.[props.unit.folder]}
            lead={
              <Show when={props.unit.branch && props.unit.branch !== props.unit.label}>
                <span>{props.unit.branch}</span>
              </Show>
            }
          />
          <SyncMarks marks={agentHolds(here()) ? [] : syncMarks(sync(props.unit))} />
        </div>
        <SessionList here={here()} earlier={earlier()} crew={props.crew} autopilotOn={props.autopilotOn} onOpen={props.onOpen} />
      </div>
    </div>
  );
}
