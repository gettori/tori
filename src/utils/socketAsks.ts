import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import type { DraftComment, MergeMethod, ReviewEvent } from "./forgeTypes";

export type AskApproval = { project: string } & (
  | { action: "pr.create"; head: string; base: string; title: string; body: string; draft: boolean; head_sha: string }
  | {
      action: "review.submit";
      number: number;
      event: ReviewEvent;
      body: string;
      comments: DraftComment[];
      head_sha: string;
    }
  | { action: "pr.push"; number: number; head: string; head_sha: string }
  | { action: "pr.merge"; number: number; method: MergeMethod; head_sha: string }
  | { action: "session.spawn"; agent: string; mode: string; folder: string }
  | { action: "pty.attach"; tab: string }
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
  // The autopilot item an approval is for, which makes it a hold.
  item?: string;
  // Absent from a build older than cards outside a chat, where it was always a chat.
  surface?: { kind: "chat" } | { kind: "tab"; id: string } | { kind: "window" };
};

const [asks, setAsks] = createSignal<SocketAsk[]>([]);

export const allAsks = asks;

export const asksFor = (session: string) => asks().filter((a) => (a.shown_in ?? [a.session]).includes(session));

export const asksForTab = (tab: string) => asks().filter((a) => a.surface?.kind === "tab" && a.surface.id === tab);

export const windowAsks = () => asks().filter((a) => a.surface?.kind === "window");

export function showAsk(ask: SocketAsk) {
  setAsks((prev) =>
    prev.some((a) => a.id === ask.id) ? prev.map((a) => (a.id === ask.id ? ask : a)) : [...prev, ask],
  );
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
