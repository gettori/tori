// The Shells workspace's layout: one pane that takes command tabs and nothing
// else. Seeded at startup rather than on first visit, because a command tab
// can open here while another workspace is on screen and needs a pane to land in.
import { SHELLS_KEY } from "../utils/features";
import { ensureEnvelope, envelopeFor, seedOnePane } from "./layoutStore";
import { leaves } from "./paneLayout";
import { setPaneLock } from "./tabPlacement";

/** The pane the lock is on, asked of the tree rather than restated: a lock
 *  written for an id the tree does not have would let any kind in here. */
export function shellsPane(): string | null {
  return leaves(envelopeFor(SHELLS_KEY, seedOnePane).layout)[0]?.id ?? null;
}

export function ensureShellsWorkspace() {
  ensureEnvelope(SHELLS_KEY, seedOnePane);
  const pane = shellsPane();
  if (pane) setPaneLock(SHELLS_KEY, pane, "command");
}
