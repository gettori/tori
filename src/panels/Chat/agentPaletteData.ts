// What the two-pane palette shows, as data.
//
// Kept apart from the component so the rules that decide a row's state are
// testable without a DOM, and so the draft (every chat-capable agent) and a
// locked session (one agent, live models) can feed the same surface.
import { chatCapable, type Adapter } from "../../utils/agents";
import { asTabProfile } from "../../utils/agentHealth";
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
  /** This row's identity. An agent with two accounts is two rows, so `agentId`
   *  no longer tells them apart, and everything that names a row (the
   *  highlight, the DOM id) keys on this instead. */
  key: string;
  agentId: string;
  /** The account this row's models and health are about, in the tab model's
   *  spelling (`null` is the default account). Carried so picking a row can
   *  bind the tab to the account whose list it just read. */
  profile: string | null;
  label: string;
  /** The plan the agent named for this account, e.g. `Claude Max`. Null on a
   *  single-account install, where it tells nothing apart, and for a catalogue
   *  that never carried one. Never a tier Sway inferred. */
  plan: string | null;
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

/** One account of one agent, as much of it as a row needs. */
export type PaletteAccount = { id: string; label: string };

/**
 * Every chat-capable agent, with the models Sway already has for it.
 *
 * Cache only: this is what a draft offers before anything has been spawned, so
 * the models come from the last probe rather than from a handshake nobody has
 * made. An agent with no cached catalogue lists none, which is the honest answer
 * rather than the adapter's guesses.
 *
 * **One row per (agent, account).** A catalogue is an account's answer, so two
 * logins of one binary are two lists and a single row would be whichever of them
 * probed last. Splitting the provider row rather than sectioning the models pane
 * is what keeps the filter honest: fuzzy search over one merged list returns the
 * same model name twice with nothing to say which account it would run on.
 */
export function paletteProviders(input: {
  adapters: readonly Adapter[];
  catalogs: readonly ModelCatalog[] | null;
  /** This agent's accounts, and **empty when there is only one**, which is what
   *  makes a single-account install render exactly one plain row per agent.
   *  `namedProfiles` is the rule; this is asked per agent because a profile id
   *  belongs to one agent and means nothing to another. */
  profilesFor: (id: string) => readonly PaletteAccount[];
  ready: (id: string, profile: string | null) => boolean;
  signedOut: (id: string, profile: string | null) => boolean;
  probing: (id: string, profile: string | null) => boolean;
  /** Whether the project allows this row. One it leaves out is not listed, unlike
   *  a broken agent: the project chose that, so there is nothing to fix. */
  allowed?: (id: string, profile: string | null) => boolean;
  /** The binary's measured version, from `agentVersion`. Optional so a caller
   *  with no health sweep still gets a palette; the head then falls back to
   *  the version the probe recorded, which is the list's own vintage. */
  version?: (id: string) => string | null;
}): PaletteProvider[] {
  const byPair = new Map(
    (input.catalogs ?? []).map((c) => [catalogKey(c.agentId, c.profileId), c] as const),
  );
  return input.adapters.filter(chatCapable).flatMap((adapter) => {
    // `[null]` is the single-account install: one row, named after the agent
    // alone, which is what it was before accounts existed.
    const named = input.profilesFor(adapter.id);
    const listed: readonly (PaletteAccount | null)[] = named.length ? named : [null];
    const accounts = listed.filter((a) => input.allowed?.(adapter.id, a ? asTabProfile(a.id) : null) ?? true);
    return accounts.map((account) => {
      const profile = account ? asTabProfile(account.id) : null;
      const catalog = byPair.get(catalogKey(adapter.id, profile));
      const reason = fixReason(
        adapter.id,
        (id) => input.ready(id, profile),
        (id) => input.signedOut(id, profile),
      );
      return {
        key: catalogKey(adapter.id, profile),
        agentId: adapter.id,
        profile,
        label: account ? `${adapter.label} / ${account.label}` : adapter.label,
        plan: account ? catalog?.catalogue?.account?.subscriptionType.trim() || null : null,
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
  /** The binary version the health sweep measured, the account the session is
   *  locked to, and that account's label when there is more than one. All
   *  optional because they are display facts the palette can go without. */
  info: { version?: string | null; profile?: string | null; account?: string | null } = {},
): PaletteProvider {
  const profile = info.profile ?? null;
  return {
    key: catalogKey(adapter.id, profile),
    agentId: adapter.id,
    profile,
    label: info.account ? `${adapter.label} / ${info.account}` : adapter.label,
    plan: null,
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
