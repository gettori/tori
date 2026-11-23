// Which agent's Settings card somebody asked for.
//
// A signal rather than an event because the two halves are not on screen at the
// same time: the palette's "Fix" row opens Settings, and the agents pane only
// mounts after that, so an event fired at the moment of the click would have
// nobody listening. A pending value survives the gap and is consumed on arrival.
import { createSignal } from "solid-js";
import { emitWith, OPEN_SETTINGS, type OpenSettings } from "./events";

const [wanted, setWanted] = createSignal<string | null>(null);

/** Take the reader to one agent's health card. The two calls are one action:
 *  the panel has to be open before the pane can honour the ask. */
export function openAgentCard(agentId: string) {
  askForAgentCard(agentId);
  emitWith<OpenSettings>(OPEN_SETTINGS, {});
}

/** Ask for one agent's card. Pair it with an `OPEN_SETTINGS` emit: this names
 *  the card, it does not open the panel. */
export function askForAgentCard(agentId: string) {
  setWanted(agentId);
}

/** The card the agents pane should open, or null. Reactive, so a pane that is
 *  already mounted answers a second ask. */
export function wantedAgentCard(): string | null {
  return wanted();
}

/** Consume it. Left unread the value would re-open the card every time the pane
 *  re-rendered, including after the user closed it. */
export function clearWantedAgentCard() {
  setWanted(null);
}
