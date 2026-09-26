import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import Chat from "./Chat";
import type { RemoteClient } from "./remote";
import styles from "./mobile.module.css";

export type Runner = {
  state: "off" | "starting" | "idle" | "working" | "error";
  session: string | null;
  agent: string | null;
  cwd: string | null;
  error: { title: string; detail: string } | null;
};

type Item = { session: string | null; worktree: string | null; session_live: boolean };

export type Crew = { sessions: Set<string>; worktrees: Set<string> };

export function watchRunner(client: RemoteClient) {
  const [runner, setRunner] = createSignal<Runner | null>(null);
  const [decisions, setDecisions] = createSignal(0);
  const [items, setItems] = createSignal<Item[]>([]);
  const load = () =>
    client
      .request<{ runner: Runner; holds: { answer: string | null }[]; items: Item[] }>("autopilot.state")
      .then((state) => {
        setRunner(state.runner);
        setDecisions(state.holds.filter((hold) => hold.answer === null).length);
        setItems(state.items.filter((item) => item.session_live));
      })
      .catch(() => {});
  const crew = createMemo((): Crew => {
    const sessions = new Set(items().flatMap((item) => (item.session ? [item.session] : [])));
    const own = runner()?.session;
    if (own) sessions.add(own);
    return { sessions, worktrees: new Set(items().flatMap((item) => (item.worktree ? [item.worktree] : []))) };
  });
  createEffect(on(client.generation, (n) => n > 0 && void load()));
  onCleanup(
    client.subscribe("autopilot", (data) => {
      const ev = data as { kind?: string; runner?: Runner; hold?: unknown; item?: unknown } | null;
      if (ev?.kind === "autopilot.status" && ev.runner) setRunner(ev.runner);
      if (ev?.kind === "autopilot.changed" && (ev.hold !== undefined || ev.item !== undefined)) void load();
    }),
  );
  return { runner, decisions, crew };
}

export function AutopilotSwitch(props: { client: RemoteClient; runner: () => Runner | null }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const running = () => (props.runner()?.state ?? "off") !== "off";
  const flip = () => {
    setBusy(true);
    setError(null);
    props.client
      .request(running() ? "autopilot.stop" : "autopilot.start")
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <button
      class={styles.switch}
      role="switch"
      aria-checked={running()}
      aria-label="Autopilot"
      title={error() ?? undefined}
      disabled={busy() || !props.runner()}
      onClick={flip}
    />
  );
}

export function AutopilotChat(props: { client: RemoteClient; runner: () => Runner | null; onBack: () => void }) {
  return (
    <Show
      when={props.runner()?.session}
      keyed
      fallback={
        <div class={styles.screen}>
          <header class={styles.bar}>
            <button class={styles.back} onClick={() => props.onBack()}>
              Back
            </button>
            <span class={styles.title}>Autopilot</span>
            <AutopilotSwitch client={props.client} runner={props.runner} />
          </header>
          <p class={styles.hint}>The autopilot is {props.runner()?.state ?? "off"}. Turn it on to see its chat.</p>
        </div>
      }
    >
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
          headerEnd={<AutopilotSwitch client={props.client} runner={props.runner} />}
        />
      )}
    </Show>
  );
}
