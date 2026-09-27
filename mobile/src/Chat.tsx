import { For, Show, createEffect, createResource, createSignal, on, onCleanup } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { ArrowUp, ChevronLeft, Ellipsis } from "lucide-solid";
import Icon from "../../src/components/Icon/Icon";
import MessageList from "../../src/panels/Chat/MessageList";
import { applyEvent, initialChat, isRunning, settleBackfill, turnModel, type ChatState } from "../../src/panels/Chat/chatStore";
import { parseChatEvent, type ChatEvent } from "../../src/utils/chatTypes";
import Pending, { type PendingRow } from "./Pending";
import type { RemoteClient } from "./remote";
import { DOT, PhaseMark } from "./Root";
import { AgentMark } from "./Unit";
import { PHASE_LABEL, phaseOf, type Phase, type SessionRow } from "./tree";
import styles from "./mobile.module.css";
import shell from "./shell.module.css";

const HISTORY_TURNS = 5;
// A page can hold 500 events, slow over mobile data; the default timeout would
// drop the socket and reload it forever.
const HISTORY_REPLY_MS = 30_000;

type Page = { events: unknown[]; next: unknown };

// A prompt raised or settled moves one of these; none says which, so any of them
// refetches the whole pending list.
const PENDING_KINDS = new Set(["session.question", "session.permission", "session.needs_you", "session.state", "session.turn_ended"]);

const NEXT = "\u203a";

type Info = {
  model: string | null;
  permission_mode: string | null;
  models: { value: string; resolvedModel: string; displayName: string }[];
  modes: { id: string; label: string; permissive?: boolean }[];
};

// A switch is confirmed only by the next turn, so the pick is shown until
// `session.info` moves off the value it had when the pick was made.
type Pick = { value: string; over: string | null };

function parsed(raw: unknown[]): ChatEvent[] {
  return raw.map(parseChatEvent).filter((ev): ev is ChatEvent => ev !== null);
}

const tail = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function Levers(props: {
  client: RemoteClient;
  id: string;
  agent: string | undefined;
  refused: Record<string, string>;
  onError: (message: string) => void;
}) {
  const [info, { refetch }] = createResource<Info | null, number>(
    () => props.client.generation() || undefined,
    () => props.client.request<Info>("session.info", { id: props.id }).catch(() => null),
  );
  const [model, setModel] = createSignal<Pick | null>(null);
  const [mode, setMode] = createSignal<Pick | null>(null);
  onCleanup(
    props.client.subscribe(`session:${props.id}`, (data) => {
      if ((data as { kind?: string } | null)?.kind === "session.state") void refetch();
    }),
  );
  onCleanup(
    props.client.subscribe("sessions", (data) => {
      const ev = data as { kind?: string; id?: string } | null;
      if (ev?.kind === "session.started" && ev.id === props.id) void refetch();
    }),
  );
  const shown = (pick: Pick | null, confirmed: string | null) => (pick && pick.over === confirmed ? pick.value : confirmed);
  const models = () => info()?.models ?? [];
  const modes = () => info()?.modes ?? [];
  const currentModel = () => {
    const value = shown(model(), info()?.model ?? null);
    return models().find((m) => m.value === value) ?? models().find((m) => m.resolvedModel === value) ?? null;
  };
  const modelValue = () => currentModel()?.value ?? shown(model(), info()?.model ?? null) ?? "";
  const modeValue = () => {
    const pick = mode();
    return shown(pick && props.refused[pick.value] === undefined ? pick : null, info()?.permission_mode ?? null) ?? "";
  };
  const currentMode = () => modes().find((m) => m.id === modeValue());

  const pick = (method: "session.model" | "session.mode", value: string) => {
    const over = method === "session.model" ? (info()?.model ?? null) : (info()?.permission_mode ?? null);
    props.client
      .request(method, method === "session.model" ? { id: props.id, model: value } : { id: props.id, mode: value })
      .then(() => (method === "session.model" ? setModel : setMode)({ value, over }))
      .catch((e: Error) => props.onError(e.message));
  };

  return (
    <>
      <label class={shell.chip}>
        <AgentMark agent={props.agent} size={13} />
        {currentModel()?.displayName || modelValue() || "Model"}
        <select value={modelValue()} disabled={models().length === 0} onChange={(e) => pick("session.model", e.currentTarget.value)}>
          <Show when={!currentModel() && modelValue()}>
            <option value={modelValue()}>{modelValue()}</option>
          </Show>
          <For each={models()}>{(m) => <option value={m.value}>{m.displayName || m.value}</option>}</For>
        </select>
      </label>
      <Show when={modes().length > 0}>
        <label class={shell.chip} data-permissive={currentMode()?.permissive === true}>
          {currentMode()?.label ?? (modeValue() || "Mode")}
          <select value={modeValue()} onChange={(e) => pick("session.mode", e.currentTarget.value)}>
            <Show when={!currentMode()}>
              <option value={modeValue()}>{modeValue() || "Mode"}</option>
            </Show>
            <For each={modes()}>
              {(m) => (
                <option value={m.id} disabled={props.refused[m.id] !== undefined}>
                  {m.label}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>
    </>
  );
}

function ChatMenu(props: { running: boolean; onStop: () => void; onCopy: () => void; onUnit?: () => void }) {
  const [open, setOpen] = createSignal(false);
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <span class={shell.menuAnchor}>
      <button class={shell.more} aria-label="More" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Icon icon={Ellipsis} size={20} strokeWidth={2} />
      </button>
      <Show when={open()}>
        <span class={shell.menuDim} onClick={() => setOpen(false)} />
        <span class={shell.menu} role="menu">
          <button role="menuitem" disabled={!props.running} onClick={run(props.onStop)}>
            Stop
          </button>
          <button role="menuitem" onClick={run(props.onCopy)}>
            Copy session id
          </button>
          <Show when={props.onUnit}>
            {(openUnit) => (
              <button role="menuitem" onClick={run(openUnit())}>
                Open worktree
              </button>
            )}
          </Show>
        </span>
      </Show>
    </span>
  );
}

export default function Chat(props: {
  client: RemoteClient;
  session: () => SessionRow;
  onBack: () => void;
  onUnit?: () => void;
  levers?: boolean;
}) {
  const id = props.session().id;
  const [view, setView] = createStore<{ chat: ChatState; error: string | null }>({ chat: initialChat(id), error: null });
  const [next, setNext] = createSignal<unknown>(null);
  const [paging, setPaging] = createSignal(false);
  const [pending, setPending] = createSignal<PendingRow[]>([]);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  // An earlier page lands before the history but after nothing live, so the
  // two are kept apart and the chat is refolded from both.
  let history: ChatEvent[] = [];
  let live: ChatEvent[] = [];
  // Live events that arrive while history loads wait here, so nothing between
  // the history read and the subscription is lost.
  let parked: ChatEvent[] | null = null;
  let loads = 0;

  // Folded into a plain object and swapped in whole: one render per load.
  const refold = () => {
    const chat = initialChat(id);
    for (const ev of history) applyEvent(chat, ev);
    settleBackfill(chat);
    for (const ev of live) applyEvent(chat, ev);
    setView({ chat, error: null });
  };

  const onLive = (data: unknown) => {
    if ((data as { kind?: string } | null)?.kind === "chat.resync") {
      void load();
      return;
    }
    const ev = parseChatEvent(data);
    if (!ev) return;
    if (ev.type === "modeRefused") setView("error", ev.reason);
    if (parked) return void parked.push(ev);
    live.push(ev);
    setView("chat", produce((chat) => applyEvent(chat, ev)));
  };

  const page = (before: unknown) =>
    props.client.request<Page>(
      "session.history",
      { id, agent: props.session().agent, limit: HISTORY_TURNS, ...(before ? { before } : {}) },
      HISTORY_REPLY_MS,
    );

  async function load() {
    const mine = ++loads;
    parked = [];
    try {
      const latest = await page(null);
      if (mine !== loads) return;
      history = parsed(latest.events);
      live = parked;
      parked = null;
      setNext(latest.next ?? null);
      refold();
    } catch (e) {
      if (mine !== loads) return;
      parked = null;
      setView("error", String(e instanceof Error ? e.message : e));
    }
  }

  async function earlier() {
    const before = next();
    if (!before || paging()) return;
    const mine = loads;
    setPaging(true);
    try {
      const older = await page(before);
      if (mine !== loads) return;
      history = [...parsed(older.events), ...history];
      setNext(older.next ?? null);
      refold();
    } catch (e) {
      if (mine === loads) setView("error", String(e instanceof Error ? e.message : e));
    } finally {
      setPaging(false);
    }
  }

  const refetchPending = () =>
    props.client
      .request<PendingRow[]>("session.pending", { id })
      .then(setPending)
      .catch(() => {});

  const send = async (method: "session.steer" | "session.interrupt") => {
    setSending(true);
    try {
      await props.client.request(method, method === "session.steer" ? { id, text: draft().trim() } : { id });
      if (method === "session.steer") setDraft("");
    } catch (e) {
      setView("error", String(e instanceof Error ? e.message : e));
    } finally {
      setSending(false);
    }
  };

  onCleanup(props.client.subscribe(`chat:${id}`, onLive));
  onCleanup(
    props.client.subscribe(`session:${id}`, (data) => {
      if (PENDING_KINDS.has((data as { kind?: string } | null)?.kind ?? "")) void refetchPending();
    }),
  );
  onCleanup(
    props.client.subscribe("autopilot", (data) => {
      if (data && typeof data === "object" && "hold" in data) void refetchPending();
    }),
  );
  createEffect(
    on(props.client.generation, (n) => {
      if (n === 0) return;
      void load();
      void refetchPending();
    }),
  );

  const phase = (): Phase => {
    const row = phaseOf(props.session());
    return row === "idle" && isRunning(view.chat) ? "working" : row;
  };
  const place = () => {
    const home = props.session().home;
    if (!home) return tail(props.session().cwd ?? "");
    return [home.project && tail(home.project), home.branch ?? tail(home.folder)].filter(Boolean).join(` ${NEXT} `);
  };

  return (
    <div class={shell.chat}>
      <header class={shell.chatTop}>
        <button class={shell.circle} aria-label="Back" onClick={() => props.onBack()}>
          <Icon icon={ChevronLeft} size={20} strokeWidth={2} />
        </button>
        <span class={shell.chatTitles}>
          <span class={shell.chatTitle}>{props.session().name || props.session().title || "New chat"}</span>
          <span class={shell.stateLine}>
            <PhaseMark phase={phase()} />
            {PHASE_LABEL[phase()]}
            <Show when={place()}>
              {" "}
              {DOT} {place()}
            </Show>
          </span>
        </span>
        <ChatMenu
          running={isRunning(view.chat)}
          onStop={() => void send("session.interrupt")}
          onCopy={() => void copy(id)}
          onUnit={props.onUnit}
        />
      </header>
      <Show when={view.error}>
        <p class={shell.banner}>{view.error}</p>
      </Show>
      <div class={styles.transcript}>
        <MessageList
          items={view.chat.items}
          streaming={isRunning(view.chat)}
          sessionId={id}
          cwd={props.session().cwd ?? ""}
          modelLabelFor={(turnId) => turnModel(view.chat, turnId)}
          agentTurn={(turnId) => view.chat.turns[turnId]?.agentInitiated === true}
          onSetMode={() => {}}
          onRevertHunk={async () => false}
          onFetchEarlier={next() ? () => void earlier() : undefined}
        />
      </div>
      <Pending client={props.client} session={id} rows={pending()} onSettled={() => void refetchPending()} />
      <Show when={props.session().live}>
        <form
          class={shell.composer}
          onSubmit={(e) => {
            e.preventDefault();
            if (draft().trim()) void send("session.steer");
          }}
        >
          <textarea
            class={shell.composerInput}
            rows={1}
            placeholder={isRunning(view.chat) ? "Steer the running turn" : "Message"}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
          <span class={shell.composerRow}>
            <Show when={props.levers !== false}>
              <Levers
                client={props.client}
                id={id}
                agent={props.session().agent}
                refused={view.chat.refusedModes}
                onError={(message) => setView("error", message)}
              />
            </Show>
            <button type="submit" class={shell.send} aria-label="Send" disabled={sending() || !draft().trim()}>
              <Icon icon={ArrowUp} size={17} strokeWidth={2.6} />
            </button>
          </span>
        </form>
      </Show>
    </div>
  );
}
