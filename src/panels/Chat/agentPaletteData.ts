// What the two-pane palette shows, as data.
//
// Kept apart from the component so the rules that decide a row's state are
// testable without a DOM, and so the draft (every chat-capable agent) and a
// locked session (one agent, live models) can feed the same surface.
import { chatCapable, type Adapter } from "../../utils/agents";
import { pickableModels, type PickableModel } from "../../utils/chatModels";
import { cachedModels, distinctModelCount, type ModelCatalog } from "../../utils/modelCatalog";
import { fuzzyScore } from "../../utils/fuzzy";

/** What the left pane says about one agent, on its own row.
 *
 *  Three states rather than a count and two flags: a row shows exactly one of
 *  them, and a shape that cannot express "probing, 5 models, needs fixing" is
 *  what stops the row from trying to. */
export type ProviderHealth =
  | { kind: "count"; count: number }
  | { kind: "probing" }
  | { kind: "fix"; reason: string };

export type PaletteProvider = {
  agentId: string;
  label: string;
  health: ProviderHealth;
  /** Whether a model of this agent can be picked at all. False leaves the row
   *  visible and its models listed but inert: hiding a broken agent is what
   *  makes it unreachable with nothing on screen explaining why. */
  selectable: boolean;
  models: PickableModel[];
};

/** Why this agent cannot be started, in the user's terms, or null when it can.
 *
 *  Only what health already answered. A failed probe is not in here: it costs
 *  the models, not the agent. */
export function fixReason(
  agentId: string,
  ready: (id: string) => boolean,
  signedOut: (id: string) => boolean,
): string | null {
  if (ready(agentId)) return null;
  return signedOut(agentId) ? "Signed out" : "Not installed";
}

/**
 * Every chat-capable agent, with the models Sway already has for it.
 *
 * Cache only: this is what a draft offers before anything has been spawned, so
 * the models come from the last probe rather than from a handshake nobody has
 * made. An agent with no cached catalogue lists none, which is the honest answer
 * rather than the adapter's guesses.
 */
export function paletteProviders(input: {
  adapters: readonly Adapter[];
  catalogs: readonly ModelCatalog[] | null;
  ready: (id: string) => boolean;
  signedOut: (id: string) => boolean;
  probing: (id: string) => boolean;
}): PaletteProvider[] {
  const byId = new Map((input.catalogs ?? []).map((c) => [c.agentId, c] as const));
  return input.adapters.filter(chatCapable).map((adapter) => {
    const catalog = byId.get(adapter.id);
    const reason = fixReason(adapter.id, input.ready, input.signedOut);
    return {
      agentId: adapter.id,
      label: adapter.label,
      health: input.probing(adapter.id)
        ? ({ kind: "probing" } as const)
        : reason !== null
          ? ({ kind: "fix", reason } as const)
          : ({ kind: "count", count: distinctModelCount(catalog) } as const),
      selectable: reason === null,
      models: pickableModels([], cachedModels(catalog), adapter.chat ?? null),
    };
  });
}

/**
 * One agent's live list, for a session that has already handshaken.
 *
 * The same row shape from a different source, which is what makes the lock
 * structural: the palette is handed one provider instead of all of them and
 * needs no mode of its own.
 */
export function lockedProvider(
  adapter: Adapter,
  models: readonly PickableModel[],
): PaletteProvider {
  return {
    agentId: adapter.id,
    label: adapter.label,
    health: { kind: "count", count: models.length },
    selectable: true,
    models: [...models],
  };
}

/**
 * The filter, across every provider at once.
 *
 * A provider survives when its own name matches or any of its models does, and
 * it keeps only the models that matched - so typing "haiku" narrows the right
 * pane and the left one together, and typing "codex" keeps that agent whole.
 * Ranking is the shared fuzzy score, on the model's label and its value, since
 * `claude-sonnet-5` is what a user types as often as `Sonnet`.
 */
export function filterProviders(
  providers: readonly PaletteProvider[],
  query: string,
): PaletteProvider[] {
  const q = query.trim();
  if (!q) return [...providers];
  const out: PaletteProvider[] = [];
  for (const provider of providers) {
    const byName = fuzzyScore(q, provider.label) !== null;
    const scored: { model: PickableModel; score: number }[] = [];
    for (const model of provider.models) {
      const score = Math.max(
        fuzzyScore(q, model.label) ?? Number.NEGATIVE_INFINITY,
        fuzzyScore(q, model.value) ?? Number.NEGATIVE_INFINITY,
      );
      if (score !== Number.NEGATIVE_INFINITY) scored.push({ model, score });
    }
    if (!byName && scored.length === 0) continue;
    scored.sort((a, b) => b.score - a.score);
    // A name match keeps the whole list: the user named the agent, not one of
    // its models, so narrowing to the models that happen to spell it too would
    // hide the rest of what they just asked for.
    out.push({ ...provider, models: byName ? [...provider.models] : scored.map((s) => s.model) });
  }
  return out;
}
