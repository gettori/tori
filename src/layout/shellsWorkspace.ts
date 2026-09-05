// The Shells workspace's layout: one pane, seeded at startup rather than on
// first visit, because a command tab can open here while another workspace is
// on screen and needs a pane to land in.
import { SHELLS_KEY } from "../utils/features";
import { ensureEnvelope, envelopeFor, seedOnePane } from "./layoutStore";
import { leaves } from "./paneLayout";
import { setPaneLock } from "./tabPlacement";

/** The one pane, asked of the tree rather than restated as a literal id. */
export function shellsPane(): string | null {
  return leaves(envelopeFor(SHELLS_KEY, seedOnePane).layout)[0]?.id ?? null;
}

export function ensureShellsWorkspace() {
  ensureEnvelope(SHELLS_KEY, seedOnePane);
  const pane = shellsPane();
  // Cleared, not merely unset: an install that already ran has the old
  // `command` lock persisted, and a lock names one kind while this pane holds
  // two now. One pane that cannot split has no second pane to refuse a drag to.
  if (pane) setPaneLock(SHELLS_KEY, pane, null);
}
