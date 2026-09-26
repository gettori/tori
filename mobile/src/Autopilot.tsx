import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";
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

export function watchRunner(client: RemoteClient) {
  const [runner, setRunner] = createSignal<Runner | null>(null);
  createEffect(
    on(client.generation, (n) => {
      if (n === 0) return;
      client
        .request<{ runner: Runner }>("autopilot.state")
        .then((state) => setRunner(state.runner))
        .catch(() => {});
    }),
  );
  onCleanup(
    client.subscribe("autopilot", (data) => {
      const ev = data as { kind?: string; runner?: Runner } | null;
      if (ev?.kind === "autopilot.status" && ev.runner) setRunner(ev.runner);
    }),
  );
  return runner;
}

export function AutopilotRow(props: { client: RemoteClient; runner: () => Runner | null; onOpen: () => void }) {
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
    <section>
      <div class={styles.autopilot}>
        <button class={styles.row} disabled={!props.runner()?.session} onClick={() => props.onOpen()}>
          <span class={styles.rowText}>
            <span class={styles.rowTitle}>Autopilot</span>
            <span class={styles.rowMeta}>{props.runner()?.error?.title ?? props.runner()?.state ?? "unknown"}</span>
          </span>
        </button>
        <button
          class={styles.switch}
          role="switch"
          aria-checked={running()}
          aria-label="Autopilot"
          disabled={busy() || !props.runner()}
          onClick={flip}
        />
      </div>
      <Show when={error()}>{(e) => <p class={styles.error}>{e()}</p>}</Show>
    </section>
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
          </header>
          <p class={styles.hint}>The autopilot is {props.runner()?.state ?? "off"}. Turn it on to see its chat.</p>
        </div>
      }
    >
      {(session) => (
        <Chat
          client={props.client}
          session={{
            id: session,
            title: "Autopilot",
            agent: props.runner()?.agent ?? undefined,
            cwd: props.runner()?.cwd ?? undefined,
            live: true,
            last_active: 0,
          }}
          onBack={props.onBack}
        />
      )}
    </Show>
  );
}
