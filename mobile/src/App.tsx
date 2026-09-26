import { Match, Show, Switch, createEffect, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { rgbTriple, spaceHue } from "../../src/utils/spaceTint";
import { AutopilotChat, watchRunner } from "./Autopilot";
import BottomBar from "./BottomBar";
import Chat from "./Chat";
import { setSpaceName, showWheel, spaceName } from "./prefs";
import Root, { type RootTab } from "./Root";
import { ProjectScreen, TopicScreen } from "./Screens";
import SettingsSheet from "./SettingsSheet";
import UnitScreen from "./Unit";
import { RemoteClient, forget, loadSaved, pair, parsePairLink, type Saved } from "./remote";
import { inUnit, type Project, type SessionRow, type Topic, type Tree, type Unit } from "./tree";
import shell from "./shell.module.css";

const PHONE_NAME = "Phone";
const LIVE_LIMIT = 200;

type View =
  | { screen: "project"; project: Project }
  | { screen: "topic"; topic: Topic }
  | { screen: "unit"; unit: Unit; back: string }
  | { screen: "chat"; row: SessionRow }
  | { screen: "autopilot" }
  | { screen: "settings" };

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
      class={shell.pair}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 class={shell.pairTitle}>Pair with Tori</h1>
      <Show when={props.notice}>
        <p class={shell.notice}>{props.notice}</p>
      </Show>
      <div class={shell.pairCard}>
        <strong>Scan the code on the Mac</strong>
        <span>In Tori on the Mac, open Settings, Remote, Pair a device, and scan the code with this phone's camera. The phone pairs in one step.</span>
      </div>
      <Show when={busy()}>
        <p class={shell.notice}>Pairing</p>
      </Show>
      <Show when={error()}>
        <p class={shell.notice}>{error()}</p>
      </Show>
      <details class={shell.typed} open={!!error()}>
        <summary>Type the address and code instead</summary>
        <label class={shell.field}>
          Link
          <input placeholder="tori://pair?..." onInput={(e) => fromLink(e.currentTarget.value)} />
        </label>
        <label class={shell.field}>
          Address
          <input value={url()} placeholder="ws://192.168.1.10:7878" onInput={(e) => setUrl(e.currentTarget.value)} />
        </label>
        <label class={shell.field}>
          Code
          <input value={code()} placeholder="XXXX-XXXX" autocapitalize="characters" onInput={(e) => setCode(e.currentTarget.value)} />
        </label>
        <label class={shell.field}>
          This phone's name
          <input value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <button class={shell.pairButton} type="submit" disabled={busy() || !url() || !code()}>
          {busy() ? "Pairing" : "Pair"}
        </button>
      </details>
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

function watchTree(client: RemoteClient) {
  const [tree] = createResource<Tree, number>(
    () => client.generation() || undefined,
    // A failed load keeps the last tree: the reconnect that follows refetches.
    (_, info) => client.request<Tree>("projects.list").catch(() => info.value ?? { spaces: [], topics: [] }),
  );
  return tree;
}

function Paired(props: { client: RemoteClient; notice: string | null; onDisconnect: () => void }) {
  const live = liveRows(props.client);
  const tree = watchTree(props.client);
  const { runner, decisions, crew } = watchRunner(props.client);
  const [tab, setTab] = createSignal<RootTab>("projects");
  const [stack, setStack] = createSignal<View[]>([]);
  const space = () => tree()?.spaces.find((s) => s.name === spaceName()) ?? tree()?.spaces[0];
  const hue = () => (space() ? rgbTriple(spaceHue(space()!.name, space()!.color)) : undefined);

  // Each screen is a history entry carrying its depth, so Android's back gesture
  // pops it instead of closing the app, and a reset can pop several at once.
  const go = (view: View) => {
    history.pushState({ depth: stack().length + 1 }, "");
    setStack([...stack(), view]);
  };
  const back = () => history.back();
  const toRoot = () => stack().length > 0 && history.go(-stack().length);
  const popped = (e: PopStateEvent) => setStack(stack().slice(0, (e.state as { depth?: number } | null)?.depth ?? 0));
  window.addEventListener("popstate", popped);
  onCleanup(() => window.removeEventListener("popstate", popped));

  const sheet = () => stack()[stack().length - 1]?.screen === "settings";
  const top = () => {
    const views = stack().filter((v) => v.screen !== "settings");
    return views[views.length - 1];
  };
  const barred = () => !top() || ["project", "topic", "unit"].includes(top()!.screen);
  const openUnit = (unit: Unit, back: string) => go({ screen: "unit", unit, back });
  const openSession = (row: SessionRow) => go({ screen: "chat", row });
  const units = () => tree()?.spaces.flatMap((s) => s.projects.flatMap((p) => p.units.map((unit) => ({ unit, project: p.name })))) ?? [];
  // From a chat reached through its worktree, the worktree is one step back.
  const openHome = (row: SessionRow) => {
    const found = units().find(({ unit }) => inUnit(row.home, unit));
    if (!found) return;
    const below = stack()[stack().length - 2];
    if (below?.screen === "unit" && inUnit(row.home, below.unit)) back();
    else openUnit(found.unit, found.project);
  };

  return (
    <div class={shell.shell} style={{ "--space-rgb": hue() }}>
      <Switch
        fallback={
          <Root
            client={props.client}
            tree={tree()}
            space={space()}
            tab={tab()}
            live={live}
            notice={props.notice}
            onProject={(project) => go({ screen: "project", project })}
            onTopic={(topic) => go({ screen: "topic", topic })}
            onUnit={openUnit}
            onSession={openSession}
            onSettings={() => go({ screen: "settings" })}
          />
        }
      >
        <Match when={top()?.screen === "project" && (top() as { project: Project }).project} keyed>
          {(project) => (
            <ProjectScreen
              client={props.client}
              project={project}
              space={space()?.name ?? ""}
              live={live}
              crew={crew}
              onUnit={(unit) => openUnit(unit, project.name)}
              onBack={back}
            />
          )}
        </Match>
        <Match when={top()?.screen === "topic" && (top() as { topic: Topic }).topic} keyed>
          {(topic) => (
            <TopicScreen client={props.client} topic={topic} tree={tree()} live={live} onUnit={(unit) => openUnit(unit, topic.name)} onBack={back} />
          )}
        </Match>
        <Match when={top()?.screen === "unit" && (top() as { unit: Unit; back: string })} keyed>
          {(view) => (
            <UnitScreen
              client={props.client}
              unit={view.unit}
              back={view.back}
              live={live}
              crew={crew}
              autopilotOn={(runner()?.state ?? "off") !== "off"}
              onOpen={openSession}
              onBack={back}
            />
          )}
        </Match>
        <Match when={top()?.screen === "chat" && (top() as { row: SessionRow }).row} keyed>
          {(row) => {
            // Gone from the live list after being in it means the session ended.
            let seen = false;
            const current = () => {
              const found = live().find((r) => r.id === row.id);
              if (found) seen = true;
              return found ?? (seen ? { ...row, live: false } : row);
            };
            return (
              <Chat
                client={props.client}
                session={current}
                onBack={back}
                onUnit={units().some(({ unit }) => inUnit(row.home, unit)) ? () => openHome(current()) : undefined}
              />
            );
          }}
        </Match>
        <Match when={top()?.screen === "autopilot"}>
          <AutopilotChat client={props.client} runner={runner} onBack={back} />
        </Match>
      </Switch>
      <Show when={barred()}>
        <BottomBar
          spaces={tree()?.spaces ?? []}
          space={space()}
          tab={tab()}
          live={live}
          showWheel={showWheel()}
          runner={runner}
          decisions={decisions}
          onSpace={(picked) => {
            setSpaceName(picked.name);
            setTab("projects");
            toRoot();
          }}
          onTopics={() => {
            setTab("topics");
            toRoot();
          }}
          onWheel={() => go({ screen: "autopilot" })}
        />
      </Show>
      <Show when={sheet()}>
        <SettingsSheet client={props.client} onDone={back} onDisconnect={props.onDisconnect} />
      </Show>
    </div>
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
