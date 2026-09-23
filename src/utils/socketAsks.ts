import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";

export type SocketAsk = { id: string; session: string; question: string; options: string[] };

const [asks, setAsks] = createSignal<SocketAsk[]>([]);

export const asksFor = (session: string) => asks().filter((a) => a.session === session);

export function showAsk(ask: SocketAsk) {
  setAsks((prev) => (prev.some((a) => a.id === ask.id) ? prev : [...prev, ask]));
}

export async function loadPendingAsks() {
  const pending = await invoke<SocketAsk[] | null>("rpc_asks_pending").catch(() => null);
  (pending ?? []).forEach(showAsk);
}

export async function answerAsk(id: string, answer: string) {
  await invoke<boolean>("rpc_ask_answer", { id, answer });
  closeAsk(id);
}

export function closeAsk(id: string) {
  setAsks((prev) => prev.filter((a) => a.id !== id));
}
