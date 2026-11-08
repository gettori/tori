import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const NONE: readonly string[] = [];

// `null` until the file has been read. Nothing saves before then, so a first
// render, or a read that failed, cannot overwrite it with alphabetical order.
const [orders, setOrders] = createSignal<Record<string, string[]> | null>(null);

/** A space's projects as paths, top to bottom. */
export const projectListOrder = (space: string): readonly string[] => orders()?.[space] ?? NONE;

async function read() {
  const all = await invoke<Record<string, string[]> | null>("project_order_read").catch(() => null);
  if (all) setOrders(all);
}

export function startProjectListOrder(): () => void {
  void read();
  let off: (() => void) | undefined;
  let gone = false;
  void listen("project-order://changed", () => void read()).then((fn) => (gone ? fn() : (off = fn)));
  return () => {
    gone = true;
    off?.();
  };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

export function saveProjectListOrder(space: string, paths: string[]) {
  const all = orders();
  if (!all || same(paths, projectListOrder(space))) return;
  setOrders({ ...all, [space]: paths });
  void invoke("project_order_write", { space, paths }).catch(() => {});
}

export function resetProjectListOrderForTests() {
  setOrders(null);
}
