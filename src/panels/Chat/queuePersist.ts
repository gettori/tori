// A chat's composer queue on disk, one file per session, so a reload or a
// relaunch hands it back (`chat/queue_store.rs` owns the file).
import { invoke } from "@tauri-apps/api/core";
import type { QueuedInput } from "./chatStore";

// One chain per session: two invokes in flight can land in either order, and
// the older queue landing last would bring back an entry that was removed.
const chains = new Map<string, Promise<void>>();
// What each session's file holds, so a queue that did not change is not
// written again on every effect run and every mount.
const written = new Map<string, string>();

function chained(sessionId: string, write: () => Promise<unknown>): Promise<void> {
  const next = (chains.get(sessionId) ?? Promise.resolve()).then(write).then(
    () => {},
    () => {},
  );
  chains.set(sessionId, next);
  return next;
}

// `steering` is never written: a restored entry stuck in flight would be
// skipped by the flush, the edit and every steer for good.
function stored(queue: readonly QueuedInput[]): QueuedInput[] {
  return queue.map(({ id, blocks, held }) =>
    JSON.parse(JSON.stringify(held ? { id, blocks, held } : { id, blocks })),
  );
}

export function saveQueue(sessionId: string, queue: readonly QueuedInput[]): Promise<void> {
  const snapshot = stored(queue);
  const json = JSON.stringify(snapshot);
  if (written.get(sessionId) === json) return chains.get(sessionId) ?? Promise.resolve();
  written.set(sessionId, json);
  return chained(sessionId, () => invoke("chat_queue_save", { sessionId, queue: snapshot }));
}

export function dropQueue(sessionId: string): Promise<void> {
  written.set(sessionId, "[]");
  return chained(sessionId, () => invoke("chat_queue_save", { sessionId, queue: [] }));
}

export async function loadQueue(sessionId: string): Promise<QueuedInput[]> {
  const raw = await invoke<unknown>("chat_queue_load", { sessionId }).catch(() => []);
  const entries = Array.isArray(raw)
    ? stored(raw.filter((q): q is QueuedInput => typeof q?.id === "string" && Array.isArray(q?.blocks)))
    : [];
  written.set(sessionId, JSON.stringify(entries));
  return entries;
}
