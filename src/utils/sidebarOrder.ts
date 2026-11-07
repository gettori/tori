import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ProjectOrder = { entries: string[]; lanes: Record<string, string> };

const NONE: readonly string[] = [];

// `null` until the file has been read. Nothing saves before then, so a first
// render, or a read that failed, cannot overwrite it with discovery order.
const [orders, setOrders] = createSignal<Record<string, ProjectOrder> | null>(null);

export const projectOrder = (path: string): readonly string[] => orders()?.[path]?.entries ?? NONE;

async function read() {
  const all = await invoke<Record<string, ProjectOrder> | null>("sidebar_order_read").catch(() => null);
  if (all) setOrders(all);
}

export function startSidebarOrder(): () => void {
  void read();
  let off: (() => void) | undefined;
  let gone = false;
  void listen("sidebar-order://changed", () => void read()).then((fn) => (gone ? fn() : (off = fn)));
  return () => {
    gone = true;
    off?.();
  };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

export function saveProjectOrder(path: string, entries: string[]) {
  const all = orders();
  if (!all || same(entries, projectOrder(path))) return;
  const lanes = Object.fromEntries(Object.entries(all[path]?.lanes ?? {}).filter(([k]) => entries.includes(k)));
  const order = { entries, lanes };
  setOrders({ ...all, [path]: order });
  void invoke("sidebar_order_write", { project: path, order }).catch(() => {});
}

export function resetSidebarOrderForTests() {
  setOrders(null);
}
