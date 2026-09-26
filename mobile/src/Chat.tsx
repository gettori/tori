import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { createStore, produce } from "solid-js/store";
import MessageList from "../../src/panels/Chat/MessageList";
import { applyEvent, initialChat, isRunning, settleBackfill, turnModel, type ChatState } from "../../src/panels/Chat/chatStore";
import { parseChatEvent, type ChatEvent } from "../../src/utils/chatTypes";
import type { RemoteClient } from "./remote";
import { sessionLabel, type SessionRow } from "./tree";
import styles from "./mobile.module.css";

const HISTORY_TURNS = 5;
// A page can hold 500 events, slow over mobile data; the default timeout would
// drop the socket and reload it forever.
const HISTORY_REPLY_MS = 30_000;

type Page = { events: unknown[]; next: unknown };

function parsed(raw: unknown[]): ChatEvent[] {
  return raw.map(parseChatEvent).filter((ev): ev is ChatEvent => ev !== null);
}

export default function Chat(props: { client: RemoteClient; session: SessionRow; onBack: () => void }) {
  const id = props.session.id;
  const [view, setView] = createStore<{ chat: ChatState; error: string | null }>({ chat: initialChat(id), error: null });
  const [next, setNext] = createSignal<unknown>(null);
  const [paging, setPaging] = createSignal(false);
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
    if (parked) return void parked.push(ev);
    live.push(ev);
    setView("chat", produce((chat) => applyEvent(chat, ev)));
  };

  const page = (before: unknown) =>
    props.client.request<Page>("session.history", { id, limit: HISTORY_TURNS, ...(before ? { before } : {}) }, HISTORY_REPLY_MS);

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

  onCleanup(props.client.subscribe(`chat:${id}`, onLive));
  createEffect(on(props.client.generation, (n) => n > 0 && void load()));

  return (
    <div class={styles.screen}>
      <header class={styles.bar}>
        <button class={styles.back} onClick={() => props.onBack()}>
          Back
        </button>
        <span class={styles.title}>{sessionLabel(props.session)}</span>
      </header>
      {view.error && <div class={styles.error}>{view.error}</div>}
      <div class={styles.transcript}>
        <MessageList
          items={view.chat.items}
          streaming={isRunning(view.chat)}
          sessionId={id}
          cwd={props.session.cwd ?? ""}
          modelLabelFor={(turnId) => turnModel(view.chat, turnId)}
          onSetMode={() => {}}
          onRevertHunk={async () => false}
          onFetchEarlier={next() ? () => void earlier() : undefined}
        />
      </div>
    </div>
  );
}
