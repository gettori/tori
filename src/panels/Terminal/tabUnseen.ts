// Which tabs have printed something while you were looking somewhere else. A
// signal beside the tab model for `commandStatus`'s reason: the strip keys tabs
// by object identity and never re-renders a still-mounted one, so a property on
// `OpenTerm` would never reach the Shells list that draws the dot.
import { createSignal } from "solid-js";

const [unseen, setUnseen] = createSignal<Record<string, true>>({});

/** Has this tab written anything you have not been on screen for? */
export const tabUnseen = (id: string): boolean => id in unseen();

// Driven by `pty://activity`, which fires once per quiet->active transition
// rather than once per chunk, so a redrawing spinner marks its tab once.
export function markTabUnseen(id: string): void {
  if (id in unseen()) return;
  setUnseen({ ...unseen(), [id]: true });
}

/** You are looking at it now, so there is nothing left unseen. */
export function clearTabUnseen(id: string): void {
  if (!(id in unseen())) return;
  const next = { ...unseen() };
  delete next[id];
  setUnseen(next);
}

/** Test seam, mirroring `resetCommandStatus`. */
export function resetTabUnseen(): void {
  setUnseen({});
}
