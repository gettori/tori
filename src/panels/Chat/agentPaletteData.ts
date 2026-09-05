// What the two-pane palette shows, as data.
//
// Kept apart from the component so the rules that decide a row's state are
// testable without a DOM, and so the draft (every chat-capable agent) and a
// locked session (one agent, live models) can feed the same surface.
import { chatCapable, type Adapter } from "../../utils/agents";
import { pickableModels, type PickableModel } from "../../utils/chatModels";
import { cachedModels, catalogKey, distinctModelCount, type ModelCatalog } from "../../utils/modelCatalog";
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
  /** The account this row's models and health are about, in the tab model's
   *  spelling (`null` is the default account). Carried so picking a row can
   *  bind the tab to the account whose list it just read. */
  profile: string | null;
  label: string;
  health: ProviderHealth;
  /** Whether a model of this agent can be picked at all. False leaves the row
   *  visible and its models listed but inert: hiding a broken agent is what
   *  makes it unreachable with nothing on screen explaining why. */
  selectable: boolean;
  /** This agent's model names carry a `Provider/Name` path worth unpicking for
   *  display. From the adapter's own declaration, never inferred from the
   *  strings: a `/` in an honest model name is not a path. */
  splitModels: boolean;
  /** The binary's version, for the models pane to name the agent with. Null is
   *  rendered as nothing rather than a guess. */
  version: string | null;
  models: PickableModel[];
};

/** A model's name split for display: what to head the row with, and the
 *  provider chain that used to crowd it, ending in the model's bare id. */
export type ModelDisplay = {
  name: string;
  segments: string[];
};

/**
 * `GitHub Copilot/Claude Sonnet 4.6` + `github-copilot/claude-sonnet-4.6`
 * becomes `Claude Sonnet 4.6` over `GitHub Copilot . claude-sonnet-4.6`, and
 * pi's `openrouter/Amazon: Nova 2 Lite` peels its vendor prefix into the chain
 * too. Null when the label carries no path, which is what lets a flagged
 * agent's plain-named model render untouched.
 *
 * Display only, and the caller gates it on the adapter's `split_model_names`:
 * this is a naming convention two agents happen to share, not a protocol fact,
 * so nothing here ever feeds a wire id, a preference, or the filter.
 */
export function splitModelDisplay(label: string, value: string): ModelDisplay | null {
  const parts = label
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const chain = parts.slice(0, -1);
  let name = parts[parts.length - 1];
  // Pi qualifies the name itself (`Amazon: Nova 2 Lite`); the vendor belongs
  // with the route, not the title.
  const colon = name.indexOf(":");
  if (colon > 0) {
    chain.push(name.slice(0, colon).trim());
    name = name.slice(colon + 1).trim();
  }
  if (!name) return null;
  const idParts = value.split("/");
  const idTail = idParts[idParts.length - 1] || value;
  // A chain segment that arrived as a bare lowercase id (`openrouter`) gets a
  // capital, since it now stands where a display name would.
  return { name, segments: [...chain.map(pretty), idTail] };
}

const pretty = (s: string) => (s === s.toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s);

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
  /** Which account each agent's row is about. A profile id belongs to one
   *  agent, so this is asked per row rather than passed once: handing the
   *  draft's own account to every other agent would describe each of them by
   *  an account it does not have. */
  profileFor: (id: string) => string | null;
  ready: (id: string, profile: string | null) => boolean;
  signedOut: (id: string, profile: string | null) => boolean;
  probing: (id: string, profile: string | null) => boolean;
  /** The binary's measured version, from `agentVersion`. Optional so a caller
   *  with no health sweep still gets a palette; the head then falls back to
   *  the version the probe recorded, which is the list's own vintage. */
  version?: (id: string) => string | null;
}): PaletteProvider[] {
  const byPair = new Map(
    (input.catalogs ?? []).map((c) => [catalogKey(c.agentId, c.profileId), c] as const),
  );
  return input.adapters.filter(chatCapable).map((adapter) => {
    const profile = input.profileFor(adapter.id);
    const catalog = byPair.get(catalogKey(adapter.id, profile));
    const reason = fixReason(
      adapter.id,
      (id) => input.ready(id, profile),
      (id) => input.signedOut(id, profile),
    );
    return {
      agentId: adapter.id,
      profile,
      label: adapter.label,
      health: input.probing(adapter.id, profile)
        ? ({ kind: "probing" } as const)
        : reason !== null
          ? ({ kind: "fix", reason } as const)
          : ({ kind: "count", count: distinctModelCount(catalog) } as const),
      selectable: reason === null,
      splitModels: adapter.chat?.split_model_names ?? false,
      version: input.version?.(adapter.id) ?? catalog?.catalogue?.version ?? null,
      models: pickableModels([], cachedModels(catalog)),
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
  /** The binary version the health sweep measured, and the account the session
   *  is locked to. Both optional because they are display facts the palette can
   *  go without. */
  info: { version?: string | null; profile?: string | null } = {},
): PaletteProvider {
  return {
    agentId: adapter.id,
    profile: info.profile ?? null,
    label: adapter.label,
    health: { kind: "count", count: models.length },
    selectable: true,
    splitModels: adapter.chat?.split_model_names ?? false,
    version: info.version ?? null,
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
