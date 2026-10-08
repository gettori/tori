import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SecretHit } from "./chatTypes";
import { isUnderPath, sameCwd } from "./pathScope";

/** One turn's secret reads. `promptTs` is null for a history with no prompts
 *  to anchor on, which is an ACP log. */
export type SecretTurn = { promptTs: number | null; paths: string[]; strength: SecretHit["strength"] };

/** A session the strip is driving, as far as asking about it needs. `status`
 *  is only a trigger: a turn ending is when a read could have landed. */
export type SecretTarget = { id: string; agent: string; cwd: string; status: string | null };

const [bySession, setBySession] = createSignal<Record<string, SecretTurn[]>>({});
const asked = new Map<string, number>();

export const secretTurnsOf = (sessionId: string): SecretTurn[] => bySession()[sessionId] ?? [];

/** The session's strongest claim, or null when it touched nothing. */
export function sessionSecret(sessionId: string): SecretHit["strength"] | null {
  const turns = secretTurnsOf(sessionId);
  if (!turns.length) return null;
  return turns.some((t) => t.strength === "read") ? "read" : "named";
}

async function refresh(t: SecretTarget) {
  const mine = (asked.get(t.id) ?? 0) + 1;
  asked.set(t.id, mine);
  const turns = await invoke<SecretTurn[]>("session_secrets", { sessionId: t.id, agentId: t.agent, cwd: t.cwd }).catch(
    () => null,
  );
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

/** Keep the marks for exactly the live sessions in `targets`. Each is read when
 *  it appears, when its status moves, when a transcript changes on disk and
 *  when settings change; one that leaves the list drops its mark. */
export function watchSecrets(targets: () => SecretTarget[]) {
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

export function resetSecretReadsForTests() {
  asked.clear();
  setBySession({});
}
