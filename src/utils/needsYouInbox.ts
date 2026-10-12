import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emitWith, NAVIGATE, type NavTarget } from "./events";
import { blocks, unanswered, type NeedsYouEvent } from "./needsYouSignals";
import { setPendingCard } from "./pendingCard";

const [needsYouEvents, setNeedsYouEvents] = createSignal<NeedsYouEvent[]>([]);
export { needsYouEvents };

export const needsYouCount = () => unanswered(needsYouEvents());

let request = 0;

export async function refreshNeedsYou() {
  const mine = ++request;
  const events = await invoke<NeedsYouEvent[]>("needs_you_list").catch(() => null);
  if (events && mine === request) setNeedsYouEvents(events);
}

export function openEvent(e: NeedsYouEvent) {
  void invoke("needs_you_seen", { session: e.session, folder: e.folder, branch: e.branch }).catch(() => {});
  if (e.chat && e.session && e.resolvedAt === null && blocks(e.kind)) setPendingCard(e.session);
  emitWith<NavTarget>(NAVIGATE, e.session ? { folder: e.folder, session: e.session } : { folder: e.folder });
}

let started = false;

export function watchNeedsYou() {
  if (started) return;
  started = true;
  void listen("needs-you://changed", () => void refreshNeedsYou());
  void refreshNeedsYou();
}
