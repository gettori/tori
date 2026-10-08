import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isUnderPath, sameCwd } from "./pathScope";

/** A session the strip is driving, as far as asking about it needs. `status`
 *  is only a trigger: a turn ending is when a turn's answer could have moved. */
export type SessionTarget = { id: string; agent: string; cwd: string; status: string | null };

/** Per-turn answers a backend command reads off each live session's
 *  transcript, kept for exactly the sessions a strip is driving. */
export function turnWatch<T>(command: string) {
  const [bySession, setBySession] = createSignal<Record<string, T[]>>({});
  const asked = new Map<string, number>();

  async function refresh(t: SessionTarget) {
    const mine = (asked.get(t.id) ?? 0) + 1;
    asked.set(t.id, mine);
    const turns = await invoke<T[]>(command, { sessionId: t.id, agentId: t.agent, cwd: t.cwd }).catch(() => null);
    // Latest request wins, and a session that stopped being live while this was
    // in flight stays forgotten.
    if (!turns || asked.get(t.id) !== mine) return;
    setBySession((prev) => ({ ...prev, [t.id]: turns }));
  }

  function forget(id: string) {
    asked.delete(id);
    setBySession((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  }

  /** Each target is read when it appears, when its status moves, when a
   *  transcript changes on disk and when settings change; one that leaves the
   *  list drops its answer. */
  function watch(targets: () => SessionTarget[]) {
    const seen = new Map<string, string>();
    createEffect(
      on(targets, (list) => {
        const live = new Set(list.map((t) => t.id));
        for (const id of [...seen.keys()]) {
          if (live.has(id)) continue;
          seen.delete(id);
          forget(id);
        }
        for (const t of list) {
          const key = `${t.agent}\u0000${t.cwd}\u0000${t.status}`;
          if (seen.get(t.id) === key) continue;
          seen.set(t.id, key);
          void refresh(t);
        }
      }),
    );
    const all = () => targets().forEach((t) => void refresh(t));
    // Only the sessions in the folders whose transcripts moved: a mid-turn agent
    // fires this constantly, and each refresh of a grown transcript parses it whole.
    const moved = (e: { payload: { folders: string[] | null } | null }) => {
      const folders = e.payload?.folders;
      if (!folders) return all();
      for (const t of targets()) {
        if (folders.some((f) => sameCwd(f, t.cwd) || isUnderPath(t.cwd, f))) void refresh(t);
      }
    };
    const offs = [listen("sessions://changed", moved), listen("settings://changed", all)];
    onCleanup(() => offs.forEach((off) => void off.then((f) => f()).catch(() => {})));
  }

  return {
    turnsOf: (sessionId: string): T[] => bySession()[sessionId] ?? [],
    watch,
    reset() {
      asked.clear();
      setBySession({});
    },
  };
}
