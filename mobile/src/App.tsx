import { Match, Show, Switch, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Chat from "./Chat";
import Home from "./Home";
import SettingsScreen from "./Settings";
import UnitScreen from "./Unit";
import { RemoteClient, forget, loadSaved, pair, parsePairLink, type Saved } from "./remote";
import type { SessionRow, Unit } from "./tree";
import styles from "./mobile.module.css";

const PHONE_NAME = "Phone";
const LIVE_LIMIT = 200;

type View = { screen: "unit"; unit: Unit } | { screen: "chat"; row: SessionRow } | { screen: "settings" };

function Pair(props: { onPaired: (saved: Saved) => void; notice: string | null; link: { url: string; code: string } | null }) {
  const [url, setUrl] = createSignal("");
  const [code, setCode] = createSignal("");
  const [name, setName] = createSignal(PHONE_NAME);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const fromLink = (text: string) => {
    const link = parsePairLink(text.trim());
    if (!link) return;
    setUrl(link.url);
    setCode(link.code);
  };

  const submit = async () => {
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

  createEffect(
    on(
      () => props.link,
      (link) => {
        if (!link) return;
        setUrl(link.url);
        setCode(link.code);
        void submit();
      },
    ),
  );

  return (
    <form
      class={styles.pair}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 class={styles.heading}>Pair with Tori</h1>
      <Show when={props.notice}>
        <p class={styles.error}>{props.notice}</p>
      </Show>
      <p class={styles.hint}>
        On the Mac, open Settings, Remote, Pair a device, and scan the code with the camera. Or paste its link, or type the address and code.
      </p>
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

function liveRows(client: RemoteClient) {
  const [rows, setRows] = createSignal<SessionRow[]>([]);
  const relist = () =>
    client
      .request<SessionRow[]>("sessions.list", { live: true, limit: LIVE_LIMIT })
      .then(setRows)
      .catch(() => {});
  createEffect(on(client.generation, (n) => n > 0 && void relist()));
  onCleanup(
    client.subscribe("sessions", (data) => {
      const ev = data as { kind?: string; id?: string; dot?: string } | null;
      if (ev?.kind === "session.started" || ev?.kind === "session.ended") return void relist();
      if (ev?.kind !== "session.dot") return;
      setRows(rows().map((row) => (row.id === ev.id ? { ...row, dot: ev.dot } : row)));
    }),
  );
  return rows;
}

function Paired(props: { client: RemoteClient; notice: string | null; onDisconnect: () => void }) {
  const live = liveRows(props.client);
  const [stack, setStack] = createSignal<View[]>([]);
  const top = () => stack()[stack().length - 1];
  // Each screen is a history entry, so Android's back gesture pops it instead of
  // closing the app.
  const go = (view: View) => {
    history.pushState(null, "");
    setStack([...stack(), view]);
  };
  const back = () => history.back();
  const popped = () => setStack(stack().slice(0, -1));
  window.addEventListener("popstate", popped);
  onCleanup(() => window.removeEventListener("popstate", popped));

  return (
    <Switch
      fallback={
        <Home
          client={props.client}
          live={live}
          notice={props.notice}
          onUnit={(unit) => go({ screen: "unit", unit })}
          onSession={(row) => go({ screen: "chat", row })}
          onSettings={() => go({ screen: "settings" })}
        />
      }
    >
      <Match when={top()?.screen === "chat" && (top() as { row: SessionRow }).row} keyed>
        {(row) => <Chat client={props.client} session={row} onBack={back} />}
      </Match>
      <Match when={top()?.screen === "unit" && (top() as { unit: Unit }).unit} keyed>
        {(unit) => (
          <UnitScreen client={props.client} unit={unit} live={live} onOpen={(row) => go({ screen: "chat", row })} onBack={back} />
        )}
      </Match>
      <Match when={top()?.screen === "settings"}>
        <SettingsScreen client={props.client} onDisconnect={props.onDisconnect} onBack={back} />
      </Match>
    </Switch>
  );
}

export default function App() {
  const [saved, setSaved] = createSignal<Saved | null>(loadSaved());
  const [notice, setNotice] = createSignal<string | null>(null);
  const [client, setClient] = createSignal<RemoteClient | null>(null);
  const [link, setLink] = createSignal<{ url: string; code: string } | null>(null);

  createEffect(
    on(saved, (s) => {
      client()?.close();
      setClient(
        s &&
          new RemoteClient(s, () => {
            setNotice("This phone was removed from Tori. Pair it again to reconnect.");
            setSaved(null);
          }),
      );
    }),
  );

  const opened = (urls: string[] | null) => {
    const found = urls?.map(parsePairLink).find((l) => l !== null);
    if (!found) return;
    if (saved()) setNotice(`Already paired with ${saved()!.url}. Disconnect in Settings to pair again.`);
    else setLink(found);
  };
  let unlisten: (() => void) | undefined;
  onMount(() => {
    // Outside the Tauri shell (the Vite dev page) there is no deep link plugin.
    invoke<string[] | null>("plugin:deep-link|get_current").then(opened, () => {});
    listen<string[]>("deep-link://new-url", (e) => opened(e.payload)).then(
      (fn) => (unlisten = fn),
      () => {},
    );
  });
  onCleanup(() => unlisten?.());

  const wake = () => document.visibilityState === "visible" && client()?.wake();
  document.addEventListener("visibilitychange", wake);
  onCleanup(() => document.removeEventListener("visibilitychange", wake));

  const disconnect = () => {
    forget();
    setNotice(null);
    setSaved(null);
  };

  return (
    <Show
      when={client()}
      fallback={<Pair notice={notice()} link={link()} onPaired={(s) => (setNotice(null), setLink(null), setSaved(s))} />}
      keyed
    >
      {(c) => <Paired client={c} notice={notice()} onDisconnect={disconnect} />}
    </Show>
  );
}
