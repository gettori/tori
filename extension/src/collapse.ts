import { localPort } from "./tab";

export type Seen = Pick<chrome.tabs.Tab, "id" | "url" | "pendingUrl" | "openerTabId" | "windowId"> & {
  lastAccessed?: number;
};

// A tab another app opened arrives with its address still pending.
export const addressOf = (tab: Seen) => tab.pendingUrl || tab.url || "";

export function keeperOf(created: Seen, tabs: Seen[], port: number): Seen | undefined {
  return tabs
    .filter((t) => t.id !== created.id && t.id !== undefined && localPort(addressOf(t)) === port)
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}
