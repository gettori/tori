import { For, Match, Show, Switch, createEffect, createResource, createSignal, on, onCleanup } from "solid-js";
import Chat, { type SessionRow } from "./Chat";
import { RemoteClient, loadSaved, pair, parsePairLink, type Saved } from "./remote";
import styles from "./mobile.module.css";

function Pair(props: { onPaired: (saved: Saved) => void; notice: string | null }) {
  const [url, setUrl] = createSignal("");
  const [code, setCode] = createSignal("");
  const [name, setName] = createSignal("Phone");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const fromLink = (text: string) => {
    const link = parsePairLink(text.trim());
    if (!link) return;
    setUrl(link.url);
    setCode(link.code);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      props.onPaired(await pair(url().trim(), code().trim(), name().trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class={styles.pair} onSubmit={submit}>
      <h1 class={styles.heading}>Pair with Tori</h1>
      <Show when={props.notice}>
        <p class={styles.error}>{props.notice}</p>
      </Show>
      <p class={styles.hint}>On the Mac, open Settings, Remote, Pair a device. Paste its link, or type the address and code.</p>
      <label class={styles.field}>
        Link
        <input placeholder="tori://pair?..." onInput={(e) => fromLink(e.currentTarget.value)} />
      </label>
      <label class={styles.field}>
        Address
        <input value={url()} placeholder="ws://192.168.1.10:7878" onInput={(e) => setUrl(e.currentTarget.value)} />
      </label>
      <label class={styles.field}>
        Code
        <input value={code()} placeholder="XXXX-XXXX" autocapitalize="characters" onInput={(e) => setCode(e.currentTarget.value)} />
      </label>
      <label class={styles.field}>
        This phone's name
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <Show when={error()}>
        <p class={styles.error}>{error()}</p>
      </Show>
      <button class={styles.primary} type="submit" disabled={busy() || !url() || !code()}>
        {busy() ? "Pairing" : "Pair"}
      </button>
    </form>
  );
}

function Sessions(props: { client: RemoteClient; onOpen: (row: SessionRow) => void }) {
  const [rows, { refetch }] = createResource(
    () => props.client.generation() || undefined,
    () => props.client.request<SessionRow[]>("sessions.list", { live: true, limit: 50 }),
  );
  const moved = (data: unknown) => {
    const kind = (data as { kind?: string } | null)?.kind;
    if (kind === "session.started" || kind === "session.ended" || kind === "session.dot") void refetch();
  };
  onCleanup(props.client.subscribe("sessions", moved));

  return (
    <div class={styles.screen}>
      <header class={styles.bar}>
        <span class={styles.title}>{props.client.saved.name}</span>
        <span class={styles.status} data-status={props.client.status()}>
          {props.client.status()}
        </span>
      </header>
      <ul class={styles.list}>
        <For each={rows() ?? []} fallback={<li class={styles.hint}>{rows.loading ? "Loading" : "No live sessions"}</li>}>
          {(row) => (
            <li>
              <button class={styles.row} onClick={() => props.onOpen(row)}>
                <span class={styles.dot} data-dot={row.dot ?? ""} />
                <span class={styles.rowText}>
                  <span class={styles.rowTitle}>{row.title || row.cwd || row.id}</span>
                  <span class={styles.rowMeta}>{row.agent}</span>
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

export default function App() {
  const [saved, setSaved] = createSignal<Saved | null>(loadSaved());
  const [notice, setNotice] = createSignal<string | null>(null);
  const [client, setClient] = createSignal<RemoteClient | null>(null);
  const [open, setOpen] = createSignal<SessionRow | null>(null);

  createEffect(
    on(saved, (s) => {
      client()?.close();
      setOpen(null);
      setClient(
        s &&
          new RemoteClient(s, () => {
            setNotice("This phone was removed from Tori. Pair it again to reconnect.");
            setSaved(null);
          }),
      );
    }),
  );

  const wake = () => document.visibilityState === "visible" && client()?.wake();
  document.addEventListener("visibilitychange", wake);
  onCleanup(() => document.removeEventListener("visibilitychange", wake));

  return (
    <Switch>
      <Match when={!client()}>
        <Pair notice={notice()} onPaired={(s) => (setNotice(null), setSaved(s))} />
      </Match>
      <Match when={open()}>
        {(row) => <Chat client={client()!} session={row()} onBack={() => setOpen(null)} />}
      </Match>
      <Match when={client()}>{(c) => <Sessions client={c()} onOpen={setOpen} />}</Match>
    </Switch>
  );
}
