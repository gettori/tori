import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";
import { ArrowUp, ChevronLeft } from "lucide-solid";
import Icon from "../../src/components/Icon/Icon";
import Horizon, { pickScene } from "../../src/components/Autopilot/Horizon";
import { WheelGlyph } from "../../src/components/Autopilot/Wheel";
import ApprovalDraft from "../../src/panels/Chat/ApprovalDraft";
import {
  activityOf,
  autopilotState,
  decisionOf,
  decisionsFor,
  heroFor,
  overLimit,
  queuedItems,
  workerCards,
  type AutopilotEvent,
  type ItemRow,
} from "../../src/utils/autopilotRows";
import type { AskApproval, SocketAsk } from "../../src/utils/socketAsks";
import Chat from "./Chat";
import type { RemoteClient } from "./remote";
import { Chevron, DOT, PhaseMark } from "./Root";
import { sessionLabel, type SessionRow } from "./tree";
import styles from "./shell.module.css";

export type Runner = {
  state: "off" | "starting" | "idle" | "working" | "error";
  session: string | null;
  agent: string | null;
  cwd: string | null;
  error: { title: string; detail: string } | null;
};

type FullHold = {
  item: string;
  ask: string;
  session: string;
  shown_in: string[];
  question: string;
  options: string[];
  project: string;
  draft: Omit<AskApproval, "project">;
  asked_at: number;
  answer: string | null;
};

type State = { runner: Runner; holds: FullHold[]; items: ItemRow[]; limits?: { max_workers?: number } };

type AskRow = { kind: string; id: string; session: string; text: string; options: string[]; approval?: AskApproval };

export type Crew = { sessions: Set<string>; worktrees: Set<string> };

const LOG_LIMIT = 50;

export function watchRunner(client: RemoteClient) {
  const [state, setState] = createSignal<State | null>(null);
  const load = () =>
    client
      .request<State>("autopilot.state")
      .then(setState)
      .catch(() => {});
  createEffect(on(client.generation, (n) => n > 0 && void load()));
  onCleanup(
    client.subscribe("autopilot", (data) => {
      const ev = data as { kind?: string; runner?: Runner; hold?: unknown; item?: unknown } | null;
      if (ev?.kind === "autopilot.status" && ev.runner) {
        const runner = ev.runner;
        setState((s) => s && { ...s, runner });
      }
      if (ev?.kind === "autopilot.changed" && (ev.hold !== undefined || ev.item !== undefined)) void load();
      if (ev?.kind === "autopilot.changed" && ev.hold !== undefined) void refetchCalls();
    }),
  );
  const runner = () => state()?.runner ?? null;
  const holds = () => (state()?.holds ?? []).filter((hold) => hold.answer === null);
  const items = () => state()?.items ?? [];
  const session = () => runner()?.session ?? null;
  const [pending, { refetch: refetchCalls }] = createResource<AskRow[], string>(
    () => (client.generation() ? (session() ?? "") : undefined),
    (id) => (id ? client.request<AskRow[]>("session.pending", { id }).catch(() => []) : Promise.resolve([])),
  );
  createEffect(
    on(session, (id) => {
      if (!id) return;
      onCleanup(client.subscribe(`session:${id}`, () => void refetchCalls()));
    }),
  );
  const calls = (): SocketAsk[] => {
    const held = holds().map(askOf);
    const asks = (pending() ?? [])
      .filter((row) => row.kind === "ask" && !held.some((hold) => hold.id === row.id))
      .map((row) => ({ id: row.id, session: row.session, question: row.text, options: row.options, approval: row.approval, shown_in: [session() ?? ""] }));
    return decisionsFor([...held, ...asks], session());
  };
  const crew = createMemo((): Crew => {
    const live = items().filter((item) => item.session_live);
    const sessions = new Set(live.flatMap((item) => (item.session ? [item.session] : [])));
    const own = runner()?.session;
    if (own) sessions.add(own);
    return { sessions, worktrees: new Set(live.flatMap((item) => (item.worktree ? [item.worktree] : []))) };
  });
  return {
    runner,
    holds,
    items,
    crew,
    calls,
    refetchCalls,
    limit: () => state()?.limits?.max_workers ?? 0,
    decisions: () => calls().length,
  };
}

export type Watch = ReturnType<typeof watchRunner>;

const askOf = (hold: FullHold): SocketAsk => ({
  id: hold.ask,
  session: hold.session,
  question: hold.question,
  options: hold.options,
  approval: { project: hold.project, ...hold.draft } as AskApproval,
  shown_in: hold.shown_in,
  item: hold.item,
});

function CallCard(props: { ask: SocketAsk; watch: Watch; live: SessionRow[]; busy: boolean; onAnswer: (answer: string) => void }) {
  const [text, setText] = createSignal("");
  const asker = (session: string) => {
    const row = props.live.find((r) => r.id === session);
    return row ? sessionLabel(row) : session.slice(0, 8);
  };
  const decision = () => decisionOf(props.ask, props.watch.items(), props.watch.holds(), asker);
  const ref = () => [decision().ticket?.label, decision().worker, decision().age].filter(Boolean).join(` ${DOT} `);
  return (
    <div class={styles.callCard} aria-busy={props.busy}>
      <span class={styles.callText}>
        <Show when={ref()}>
          <span class={styles.callRef}>{ref()}</span>
        </Show>
        <span class={styles.callTitle}>{decision().title || decision().summary}</span>
        <Show when={decision().title}>
          <span class={styles.callBody}>{decision().summary}</span>
        </Show>
      </span>
      <Show when={props.ask.approval}>
        {(approval) => (
          <details class={styles.callDraft}>
            <summary>Show the draft</summary>
            <ApprovalDraft approval={approval()} />
          </details>
        )}
      </Show>
      <span class={styles.callActions}>
        <For each={props.ask.options}>
          {(option, at) => (
            <button class={at() === 0 ? styles.callYes : styles.callNo} disabled={props.busy} onClick={() => props.onAnswer(option)}>
              {option}
            </button>
          )}
        </For>
      </span>
      <Show when={!props.ask.approval}>
        <form
          class={styles.callActions}
          onSubmit={(e) => {
            e.preventDefault();
            if (text().trim()) props.onAnswer(text().trim());
          }}
        >
          <input class={styles.callInput} placeholder="Or type an answer" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
        </form>
      </Show>
    </div>
  );
}

export default function AutopilotScreen(props: {
  client: RemoteClient;
  watch: Watch;
  live: () => SessionRow[];
  onBack: () => void;
  onChat: () => void;
  onSession: (id: string) => void;
}) {
  const runner = () => props.watch.runner();
  const session = () => runner()?.session ?? null;
  const calls = () => props.watch.calls();

  const [log, setLog] = createSignal<AutopilotEvent[]>([]);
  createEffect(
    on(props.client.generation, (n) => {
      if (n === 0) return;
      props.client
        .request<AutopilotEvent[]>("autopilot.log", { limit: LOG_LIMIT })
        .then((events) => setLog([...events].reverse()))
        .catch(() => {});
    }),
  );
  onCleanup(
    props.client.subscribe("autopilot", (data) => {
      const ev = data as (AutopilotEvent & { kind?: string }) | null;
      if (ev?.kind === "autopilot.changed") setLog([ev, ...log()].slice(0, LOG_LIMIT));
    }),
  );
  const activity = () => log().flatMap((e) => activityOf(e, props.watch.items()) ?? []);

  const inFlight = () =>
    props.watch
      .items()
      .filter((item) => item.state === "running" || item.state === "waiting_on_you")
      .sort((a, b) => a.created - b.created);
  const workers = () => workerCards(inFlight());

  const state = () => autopilotState(runner() ?? { state: "off" }, calls().length);
  const off = () => state() === "off";
  const queued = () => queuedItems(props.watch.items()).filter((q) => !q.proposed).length;
  const hero = () => heroFor(state(), calls().length, workers().length, queued(), props.watch.limit());
  const [now, setNow] = createSignal(new Date());
  const tick = setInterval(() => setNow(new Date()), 60_000);
  onCleanup(() => clearInterval(tick));
  const scene = () => {
    if (state() === "error" || overLimit(workers().length, props.watch.limit())) return "storm";
    return off() ? "night" : pickScene(now().getHours());
  };

  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const act = (key: string, method: string, params: unknown = {}) => {
    setBusy(key);
    setError(null);
    return props.client
      .request(method, params)
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setBusy(null);
        void props.watch.refetchCalls();
      });
  };
  const flip = () => void act("switch", off() ? "autopilot.start" : "autopilot.stop");

  const [draft, setDraft] = createSignal("");
  const send = () => {
    const id = session();
    if (!id || !draft().trim()) return;
    void act("send", "session.steer", { id, text: draft().trim() }).then(() => {
      setDraft("");
      props.onChat();
    });
  };

  return (
    <div class={styles.autopilot}>
      <div class={styles.horizon} data-off={off()}>
        <div class={styles.horizonScene}>
          <Horizon scene={scene()} />
        </div>
        <div class={styles.horizonShade} />
        <div class={styles.horizonTop}>
          <button class={styles.glass} aria-label="Back" onClick={() => props.onBack()}>
            <Icon icon={ChevronLeft} size={20} strokeWidth={2} />
          </button>
          <button
            class={`${styles.glass} ${styles.glassPill}`}
            role="switch"
            aria-checked={!off()}
            aria-label="Autopilot"
            disabled={busy() === "switch" || !runner()}
            onClick={flip}
          >
            {off() ? "Off" : "On"}
            <span class={styles.apToggle} data-on={!off()} />
          </button>
        </div>
        <div class={styles.horizonText}>
          <span class={styles.eyebrow} data-spin={!off()}>
            <WheelGlyph size={13} />
            Autopilot {DOT} {hero().eyebrow}
          </span>
          <span class={styles.headline}>{hero().title}</span>
          <span class={styles.subline}>{hero().body}</span>
        </div>
      </div>
      <Show when={error()}>
        <p class={styles.banner}>{error()}</p>
      </Show>
      <div class={styles.apScroll}>
        <Show when={runner()?.error}>
          {(failure) => (
            <div class={styles.infoCard} data-error="true">
              <strong>{failure().title}</strong>
              <span>{failure().detail}</span>
            </div>
          )}
        </Show>
        <Show
          when={!off()}
          fallback={
            <div class={styles.docked}>
              <div class={styles.infoCard}>
                <span>The autopilot picks up issues, runs workers in your worktrees and asks you before anything leaves the machine.</span>
              </div>
              <button class={styles.setSail} disabled={busy() === "switch" || !runner()} onClick={flip}>
                <WheelGlyph size={18} />
                Set sail
              </button>
            </div>
          }
        >
          <Show when={session()}>
            <ul class={styles.group}>
              <li>
                <button class={styles.item} onClick={() => props.onChat()}>
                  <span class={styles.text}>
                    <span class={styles.name}>Chat</span>
                    <span class={styles.meta}>The autopilot's own conversation</span>
                  </span>
                  <Chevron />
                </button>
              </li>
            </ul>
          </Show>
          <Show when={calls().length > 0}>
            <h2 class={`${styles.label} ${styles.callLabel}`}>
              Your call {DOT} {calls().length}
            </h2>
            <div class={styles.calls}>
              <For each={calls()}>
                {(ask) => (
                  <CallCard
                    ask={ask}
                    watch={props.watch}
                    live={props.live()}
                    busy={busy() === ask.id}
                    onAnswer={(answer) => void act(ask.id, "ask.answer", { id: ask.id, answer })}
                  />
                )}
              </For>
            </div>
          </Show>
          <h2 class={styles.label}>Crew</h2>
          <Show when={workers().length > 0} fallback={<p class={styles.empty}>The deck is quiet. Hand the autopilot a ticket or a PR.</p>}>
            <div class={styles.crew}>
              <For each={workers()}>
                {(worker, at) => {
                  const item = () => inFlight()[at()];
                  return (
                    <button
                      class={styles.worker}
                      disabled={!item()?.session}
                      onClick={() => item()?.session && props.onSession(item()!.session!)}
                    >
                      <span class={styles.workerHead}>
                        <PhaseMark phase={worker.status === "needs" ? "needs" : worker.status === "idle" ? "idle" : "working"} />
                        <span class={styles.time}>{worker.ticket.label}</span>
                      </span>
                      <span class={styles.workerName}>{worker.title}</span>
                      <span class={styles.workerTask}>{worker.doing}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
          <h2 class={styles.label}>Log</h2>
          <div class={styles.log}>
            <For each={activity()} fallback={<p class={styles.empty}>Nothing logged yet</p>}>
              {(entry) => (
                <div class={styles.logRow}>
                  <span class={styles.logTime}>{entry.time}</span>
                  <span class={styles.logText} data-needs={entry.needsYou === true}>
                    <Show when={entry.ticket}>{(ticket) => <span class={styles.logTicket}>{ticket().label} </span>}</Show>
                    {entry.text}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <form
        class={styles.apComposer}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          placeholder={session() ? "Message the autopilot" : "Set sail to message the autopilot"}
          disabled={!session()}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <button type="submit" class={styles.apSend} aria-label="Send" disabled={!session() || !draft().trim() || busy() === "send"}>
          <Icon icon={ArrowUp} size={16} strokeWidth={2.6} />
        </button>
      </form>
    </div>
  );
}

export function AutopilotChat(props: { client: RemoteClient; runner: () => Runner | null; onBack: () => void }) {
  createEffect(() => props.runner()?.session || props.onBack());
  return (
    <Show when={props.runner()?.session} keyed>
      {(session) => (
        <Chat
          client={props.client}
          session={() => ({
            id: session,
            title: "Autopilot",
            agent: props.runner()?.agent ?? undefined,
            cwd: props.runner()?.cwd ?? undefined,
            live: true,
            last_active: 0,
          })}
          onBack={props.onBack}
          levers={false}
        />
      )}
    </Show>
  );
}
