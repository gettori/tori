import { createSignal, getOwner, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { USAGE_CHANGED, type SessionUsage } from "./chatUsageStore";

export type SpendQuery = { kind: "branch"; project: string; branch: string } | { kind: "item"; id: string };

const keyOf = (q: SpendQuery) => (q.kind === "item" ? `item\0${q.id}` : `branch\0${q.project}\0${q.branch}`);

const [figures, setFigures] = createSignal<Record<string, SessionUsage>>({});
const asked = new Map<string, { query: SpendQuery; holders: number }>();
let started = false;
let soon: ReturnType<typeof setTimeout> | undefined;

async function fetchAll() {
  const queries = [...asked.values()].map((a) => a.query);
  if (queries.length === 0) return;
  const answers = await invoke<SessionUsage[]>("usage_spend", { queries }).catch((e) => {
    console.warn("usage_spend failed", e);
    return null;
  });
  // A figure that can no longer be read is not shown as if it were current.
  if (!answers) {
    setFigures((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !asked.has(key))));
    return;
  }
  const next: Record<string, SessionUsage> = {};
  queries.forEach((q, n) => {
    if (answers[n]) next[keyOf(q)] = answers[n];
  });
  setFigures((prev) => ({ ...prev, ...next }));
}

function fetchSoon() {
  clearTimeout(soon);
  soon = setTimeout(() => void fetchAll(), 50);
}

function start() {
  if (started) return;
  started = true;
  void listen(USAGE_CHANGED, fetchSoon).catch((e) => {
    console.warn("spend: no usage events", e);
    started = false;
  });
}

// Released a microtask late: a computation re-running drops its hold and takes
// it again in the same tick, which must not refetch.
function release(key: string) {
  const held = asked.get(key);
  if (held) held.holders -= 1;
  queueMicrotask(() => {
    if (asked.get(key)?.holders === 0) asked.delete(key);
  });
}

export function resetSpendForTests() {
  asked.clear();
  setFigures({});
}

export function spendFor(query: SpendQuery): SessionUsage | null {
  const key = keyOf(query);
  const held = asked.get(key);
  if (held) held.holders += 1;
  else asked.set(key, { query, holders: 1 });
  start();
  if (!held) fetchSoon();
  if (getOwner()) onCleanup(() => release(key));
  return figures()[key] ?? null;
}
