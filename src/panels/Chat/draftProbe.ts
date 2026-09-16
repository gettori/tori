// Probing from the palette: one agent at a time, and only when a human meant it.
//
// A probe spawns the agent's binary. Arrowing down a list of six would otherwise
// launch six processes in the time it takes to press the key, so the highlight
// is debounced (only where the cursor came to rest) and every probe is chained
// behind the last (never two binaries at once).
import { debounce } from "../../utils/debounce";
import { refreshCatalog, refreshCatalogIfDue } from "../../utils/modelCatalog";

const HIGHLIGHT_MS = 250;

let chain: Promise<unknown> = Promise.resolve();

/** Ask now, behind whatever is already asking.
 *
 *  `refreshCatalogIfDue` is the whole of the policy: it re-asks an agent that
 *  never answered, one whose binary changed, and one whose last probe failed for
 *  a reason a retry could fix - and refuses one that is already in flight or that
 *  Tori cannot probe at all. */
export function probeAgent(agentId: string, profile: string | null = null) {
  chain = chain.then(() => refreshCatalogIfDue(agentId, profile)).catch(() => null);
}

/** Ask again because a human pressed the button, not because anything is due.
 *
 *  `refreshCatalog` rather than `refreshCatalogIfDue`: the button exists for the
 *  case where Tori believes the answer is current and the reader knows better -
 *  a model added to the account since the last probe, a login that happened in
 *  another window. Chained like every other probe, so pressing it while one is
 *  in flight queues rather than running a second binary. */
export function recheckAgent(agentId: string, profile: string | null = null) {
  chain = chain.then(() => refreshCatalog(agentId, profile)).catch(() => null);
}

/** Ask once the cursor stops moving. */
export const probeOnHighlight = debounce(
  (agentId: string, profile: string | null = null) => probeAgent(agentId, profile),
  HIGHLIGHT_MS,
);
