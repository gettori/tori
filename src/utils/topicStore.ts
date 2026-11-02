// Watched rather than always on, so a window with nothing Topic-shaped on
// screen never asks for the list.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { noteTopics, type Topic } from "./topics";

export type Promoted = { topic: Topic; from: string | null; to: string | null };

const [records, setRecords] = createSignal<Topic[]>([]);
const [reloads, setReloads] = createSignal(0);
const [loadError, setLoadError] = createSignal<string | null>(null);

export const topics = records;
export const topicsReloaded = reloads;
export const topicsError = loadError;

function put(list: Topic[]) {
  setRecords(list);
  noteTopics(list);
}

// Latest request wins: a refetch started later must not be overwritten by an
// earlier one that resolved later.
let seq = 0;
export async function reloadTopics(): Promise<void> {
  const mine = ++seq;
  try {
    const list = (await invoke<Topic[] | null>("list_topics")) ?? [];
    if (mine !== seq) return;
    put(list);
    setLoadError(null);
    setReloads((n) => n + 1);
  } catch (e) {
    if (mine !== seq) return;
    setLoadError(String(e));
  }
}

export function applyTopic(topic: Topic): void {
  const prev = records();
  const i = prev.findIndex((t) => t.id === topic.id);
  const next = prev.slice();
  if (i < 0) next.push(topic);
  else next[i] = topic;
  put(next);
}

export function dropTopic(id: string): void {
  put(records().filter((t) => t.id !== id));
}

const promotedSubs = new Set<(p: Promoted) => void>();

export function onPromoted(fn: (p: Promoted) => void): () => void {
  promotedSubs.add(fn);
  return () => promotedSubs.delete(fn);
}

let watchers = 0;
let generation = 0;
let unlisten: UnlistenFn[] = [];

async function start() {
  const mine = ++generation;
  await reloadTopics();
  const offs = [
    await listen<Topic>("topics://changed", (e) => applyTopic(e.payload)),
    await listen("config://changed", () => void reloadTopics()),
    await listen<Promoted>("topics://promoted", (e) => {
      applyTopic(e.payload.topic);
      for (const fn of promotedSubs) fn(e.payload);
    }),
  ];
  if (mine !== generation) return offs.forEach((off) => off());
  unlisten = offs;
}

function stop() {
  generation++;
  seq++;
  unlisten.forEach((off) => off());
  unlisten = [];
  setRecords([]);
  setReloads(0);
  setLoadError(null);
}

export function watchTopics(): () => void {
  if (watchers++ === 0) void start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--watchers === 0) stop();
  };
}
