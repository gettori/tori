import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import type { DraftComment, MergeMethod, ReviewEvent } from "./forgeTypes";

export type AskApproval = { project: string } & (
  | { action: "pr.create"; head: string; base: string; title: string; body: string; draft: boolean }
  | { action: "review.submit"; number: number; event: ReviewEvent; body: string; comments: DraftComment[] }
  | { action: "pr.merge"; number: number; method: MergeMethod; head_sha: string }
);

export type SocketAsk = {
  id: string;
  session: string;
  question: string;
  options: string[];
  approval?: AskApproval | null;
  // The panels showing the card; absent from a build older than approvals, where
  // it was the asker's alone.
  shown_in?: string[];
};

const [asks, setAsks] = createSignal<SocketAsk[]>([]);

export const asksFor = (session: string) => asks().filter((a) => (a.shown_in ?? [a.session]).includes(session));

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
