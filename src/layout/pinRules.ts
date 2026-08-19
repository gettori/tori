// Where a kind's tabs open (plan phase 11). Panes are anonymous, so a pin is a
// routing rule over positions rather than a name: "files open at the rightmost
// pane" survives a split, a close and a move, which a pane id would not.
//
// The rule set lives here rather than in the settings store so the layout layer
// never imports it: the shell pushes the user's answer in with `setPinSides`,
// and everything that resolves a pin reads it back out of one signal.
import { createSignal } from "solid-js";

/** Which end of the tree a kind opens at. */
export type PinSide = "leftmost" | "rightmost";

/** The three rules a user actually has: one per family of tab kinds. A kind is
 *  mapped onto its family by `pinGroup`, so registering a sixth terminal kind
 *  needs no new setting. */
export type PinGroup = "terminal" | "chat" | "file";
export type PinSides = Record<PinGroup, PinSide>;

/** Today's layout, and what an install with no answer stored gets. */
export const DEFAULT_PIN_SIDES: PinSides = {
  terminal: "leftmost",
  chat: "leftmost",
  file: "rightmost",
};

export const pinGroup = (kind: string): PinGroup =>
  kind === "file" ? "file" : kind === "chat" ? "chat" : "terminal";

const [sides, setSides] = createSignal<PinSides>(DEFAULT_PIN_SIDES);

/** The rules in force. Reactive, so changing one re-routes the next tab that
 *  opens without touching the tabs already placed (those carry their own pane
 *  in the placement store). */
export const pinSides = sides;

export function setPinSides(next: Partial<PinSides>): void {
  setSides({ ...DEFAULT_PIN_SIDES, ...next });
}

export const pinSideOf = (kind: string): PinSide => sides()[pinGroup(kind)];

/** Tests and the shell's own reset, beside the other layout models. */
export function resetPinRules(): void {
  setSides(DEFAULT_PIN_SIDES);
}
