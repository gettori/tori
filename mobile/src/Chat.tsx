import { createEffect, on, onCleanup } from "solid-js";
import { createStore, produce } from "solid-js/store";
import MessageList from "../../src/panels/Chat/MessageList";
import { applyEvent, initialChat, isRunning, settleBackfill, turnModel, type ChatState } from "../../src/panels/Chat/chatStore";
import { parseChatEvent, type ChatEvent } from "../../src/utils/chatTypes";
import type { RemoteClient } from "./remote";
import styles from "./mobile.module.css";

export type SessionRow = { id: string; agent?: string; title?: string; cwd?: string; live?: boolean; dot?: string };

const HISTORY_TURNS = 5;
// A page can hold 500 events, slow over mobile data; the default timeout would
// drop the socket and reload it forever.
const HISTORY_REPLY_MS = 30_000;

export default function Chat(props: { client: RemoteClient; session: SessionRow; onBack: () => void }) {
  const id = props.session.id;
  const [view, setView] = createStore<{ chat: ChatState; error: string | null }>({ chat: initialChat(id), error: null });
  // Live events that arrive while history loads wait here, so nothing between
  // the history read and the subscription is lost.
  let parked: ChatEvent[] | null = null;
  let loads = 0;

  const live = (data: unknown) => {
    if ((data as { kind?: string } | null)?.kind === "chat.resync") {
      void load();
      return;
    }
    const ev = parseChatEvent(data);
    if (!ev) return;
    if (parked) parked.push(ev);
    else setView("chat", produce((chat) => applyEvent(chat, ev)));
  };

  async function load() {
    const mine = ++loads;
    parked = [];
    try {
      const page = await props.client.request<{ events: unknown[] }>("session.history", { id, limit: HISTORY_TURNS }, HISTORY_REPLY_MS);
      if (mine !== loads) return;
      // Folded into a plain object and swapped in whole: one render per load.
      const chat = initialChat(id);
      for (const raw of page.events) {
        const ev = parseChatEvent(raw);
        if (ev) applyEvent(chat, ev);
      }
      settleBackfill(chat);
      for (const ev of parked) applyEvent(chat, ev);
      parked = null;
      setView({ chat, error: null });
    } catch (e) {
      if (mine !== loads) return;
      parked = null;
      setView("error", String(e instanceof Error ? e.message : e));
    }
  }

  const unsubscribe = props.client.subscribe(`chat:${id}`, live);
  onCleanup(unsubscribe);
  createEffect(on(props.client.generation, (n) => n > 0 && void load()));

  return (
    <div class={styles.screen}>
      <header class={styles.bar}>
        <button class={styles.back} onClick={() => props.onBack()}>
          Back
        </button>
        <span class={styles.title}>{props.session.title || props.session.cwd || id}</span>
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
        />
      </div>
    </div>
  );
}
