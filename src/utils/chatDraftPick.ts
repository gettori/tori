// What a draft has been set to run as, before there is a session to set it on.
//
// Keyed by tab id, like the composer, and for the same reason: a draft has no
// session id to file anything under, and the pick has to survive the tab record
// being replaced (which is what promotes a draft into a chat). The agent itself
// is *not* here - it lives on the tab record as `program`, which is what makes
// the tab bar and the palette agree without a second copy.
import { createSignal } from "solid-js";
import type { ChatTransport } from "./agents";

export type DraftPick = {
  /** The `--model` value, never the resolved id: a stale cache row is caught by
   *  the agent refusing the value it was sent. */
  model: string | null;
  mode: string | null;
  effort: string | null;
};

const EMPTY: DraftPick = { model: null, mode: null, effort: null };

const [picks, setPicks] = createSignal<Record<string, DraftPick>>({});

/** What this tab will start as. All-null before anything was picked, which is
 *  the CLI's own defaults rather than an assertion of them. */
export function draftPick(tabId: string): DraftPick {
  return picks()[tabId] ?? EMPTY;
}

export function setDraftPick(tabId: string, patch: Partial<DraftPick>) {
  setPicks((prev) => ({ ...prev, [tabId]: { ...(prev[tabId] ?? EMPTY), ...patch } }));
}

/** Switch the agent's picks out. Model, mode and effort all name things the
 *  *old* agent published, so carrying any of them across would spawn the new one
 *  with flags it never declared. */
export function resetDraftPick(tabId: string, model: string | null) {
  setPicks((prev) => ({ ...prev, [tabId]: { model, mode: null, effort: null } }));
}

/**
 * Whether this transport takes the pick as command-line arguments.
 *
 * The same shape of question as `sendCapable`, and the same answer either way:
 * a claude-shaped adapter spells a model as `--model`, so the session that
 * answers the handshake is already running it. Every ACP adapter declares
 * `model_args = []` and refuses a model before its session exists, so there the
 * pick is a request made after the session opens and awaited before the first
 * message goes out on it.
 */
export function pickRidesArgv(transport: ChatTransport | undefined): boolean {
  return transport !== "acp";
}

/** Whether anything was picked at all. All-null is the CLI's own defaults, and
 *  a session opening on those has nothing to apply and nothing to await. */
export function hasPick(pick: DraftPick): boolean {
  return pick.model !== null || pick.mode !== null || pick.effort !== null;
}

/** Forget this tab. Called when the tab closes, alongside the composer's own
 *  clear: a tab id is never reused, so anything left here is dead weight. */
export function clearDraftPick(tabId: string) {
  setPicks((prev) => {
    if (!(tabId in prev)) return prev;
    const next = { ...prev };
    delete next[tabId];
    return next;
  });
}
