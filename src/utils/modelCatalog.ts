// What a agent said it can run, as the backend cached it.
//
// Mirrors `src-tauri/src/catalog_probe.rs`. The rows are deliberately the same
// shape as a live handshake's `ChatModelInfo`: the backend flattens it, so a
// cached row and a live row are the same JSON and a picker can read one where it
// reads the other. That is what makes "live wins, cache fills in before a
// session exists" a swap of source rather than a swap of shape.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { agentVersion, asProfileId } from "./agentHealth";
import type { ChatAccount, ChatConfigOption, ChatModeInfo, ChatModelInfo, SlashCommand } from "./chatTypes";

// Which of the three things a agent's catalogue currently is.
//
// `neverProbed` is not an error and not an empty catalogue: it is the state of a
// agent nobody has asked yet, and it renders as no answer rather than as zero.
export type CatalogState = "neverProbed" | "failed" | "probed";

// Why a probe did not produce a catalogue. `unsupported` is a fact about Tori,
// not about the binary, so a surface must not render it as the agent failing.
export type ProbeFailureReason = "spawnFailed" | "timedOut" | "signedOut" | "noAnswer" | "unsupported";

export type ProbeFailure = {
  reason: ProbeFailureReason;
  // The agent's own words where there are any. Empty rather than invented.
  detail: string;
  atMs: number;
};

export type CatalogModel = ChatModelInfo & {
  // This row came from the user's own agent configuration rather than the
  // agent's catalogue. Still not something Tori invented, but not something it
  // can confirm either: such a row carries an **empty `resolvedModel`**, because
  // the configured string is passed to the CLI unresolved. Anything deduping by
  // that field has to fall back to `value`, or every user-configured row
  // collapses into one.
  userConfigured?: boolean;
  // The levers this agent has **for this model**, when they depend on it.
  // Claude's do, because the CLI publishes no options at all and Tori assembles
  // them per row. An ACP agent's are per session and live on the catalogue.
  options?: ChatConfigOption[];
};

export type Catalogue = {
  // The binary version at the moment of the probe. Null is the version-unknown
  // case, which is re-checked only when the user asks.
  version: string | null;
  // Which shape of cache this is; see `CACHE_SHAPE`. Optional because a
  // catalogue written before the stamp existed genuinely carries none, and that
  // absence reads as 1 rather than as the current number.
  shape?: number;
  probedAtMs: number;
  models: CatalogModel[];
  modes: ChatModeInfo[];
  // The agent's own config options, in the same shape the live chat mirrors
  // them. Empty for claude, which publishes none. One shape rather than two is
  // what lets the detail page preview an agent's options with the renderer's
  // own rule for which ones have a bespoke control.
  options?: ChatConfigOption[];
  // The account the agent named, when it named one. A catalogue can differ per
  // account, so a surface showing one has to be able to say whose answer it is.
  account: ChatAccount | null;
  // The agent's slash commands, from the same handshake the models came from,
  // for a composer with no session to ask. Optional for a cache written before
  // the field existed, which reads as none rather than as an agent with none.
  commands?: SlashCommand[];
};

export type ModelCatalog = {
  agentId: string;
  // Which account answered, in the backend's spelling (`"default"`, never
  // null). Half of this row's identity: a catalogue is an account's answer, and
  // two accounts of one agent can be on different plans.
  profileId: string;
  state: CatalogState;
  // The last probe that answered, which outlives every failure after it. A
  // failed probe never clears this: stale-but-real beats fresh-but-empty.
  catalogue: Catalogue | null;
  // Set when the most recent attempt failed, cleared by one that answers.
  lastFailure: ProbeFailure | null;
};

/** The cached models for one agent, or none when it has never answered.
 *
 *  A agent in the `failed` state still has its models here when a previous
 *  probe succeeded, which is the whole reason the failure and the catalogue are
 *  separate fields. */
export function cachedModels(catalog: ModelCatalog | undefined): CatalogModel[] {
  const models = catalog?.catalogue?.models ?? [];
  const installed = catalog ? agentVersion(catalog.agentId) : null;
  return isStale(catalog, installed) ? models.map(withoutMeasuredLevels) : models;
}

/** One cached row with Tori's own measured effort levels taken back off it.
 *
 *  **A measurement is scoped to the binary it names**, and `claude::effort_levels`
 *  applied that scope against the version the probe recorded. On a binary that
 *  has since changed, its answer is about something else, so the rows it added
 *  come off and the agent's own published list is what is left. A draft opened
 *  on an upgraded CLI otherwise offered a level nothing had measured for the one
 *  probe round it takes `refreshCatalogIfDue` to land a fresh answer.
 *
 *  Told apart by `supportedEffortLevels` rather than by re-running the version
 *  comparison: a level the agent published is in that list and one Tori measured
 *  is not, so this needs no second copy of the rule that put them there. */
function withoutMeasuredLevels(model: CatalogModel): CatalogModel {
  if (!model.effortLevels?.length) return model;
  const published = model.effortLevels.filter((l) => model.supportedEffortLevels.includes(l.level));
  return published.length === model.effortLevels.length ? model : { ...model, effortLevels: published };
}

/** The cached levers for one agent on one model, in the shape a live session
 *  publishes them.
 *
 *  Two sources because the agents genuinely differ: claude's options are a
 *  function of the model, ACP's are a function of the session. A row that
 *  carries its own answer wins; empty covers "publishes none" and "never
 *  asked" alike.
 *
 *  **An empty row list falls through rather than winning.** `??` would stop
 *  there, and an ACP model row carries `options: []` by design - the agent's
 *  levers are per session, on the catalogue - so nullish-coalescing shadowed
 *  the whole ACP set the moment a row was found, which since the draft opens on
 *  a model is always. Nothing is lost by falling through: a claude row with no
 *  options falls into a catalogue set that is empty for claude anyway. */
/**
 * The commands a composer can offer before the session that publishes them
 * exists.
 *
 * The agent's own last answer, from the handshake this cache was built by, and
 * empty for an agent nobody has probed. A draft used to offer nothing at all on
 * the reasoning that a stale list would promise commands this chat may not have
 * - the same argument the model picker faced and answered the other way, which
 * is the answer taken here too: the cache is what this agent said last time,
 * the live list replaces it the moment the handshake lands, and a command that
 * has since gone is refused by the agent with a sentence.
 *
 * Skills need no second source: measured on claude 2.1.251, they are already in
 * this list (17 of 49 entries).
 */
export function cachedCommands(catalog: ModelCatalog | undefined): SlashCommand[] {
  return catalog?.catalogue?.commands ?? [];
}

export function cachedOptions(
  catalog: ModelCatalog | undefined,
  model: string | null,
): ChatConfigOption[] {
  const row = model === null ? undefined : cachedModels(catalog).find((m) => m.value === model);
  return row?.options?.length ? row.options : (catalog?.catalogue?.options ?? []);
}

/** How many *distinct* models a catalogue offers.
 *
 *  Deduped by `resolvedModel`, because a catalogue names aliases: `default`,
 *  `sonnet` and `claude-sonnet-5` are three rows and one model, and a card
 *  reading "8 models" for five would be counting Tori's ability to spell.
 *
 *  **Falling back to `value` is not a nicety.** A user-configured row carries an
 *  empty `resolvedModel` on purpose (Tori passes the string to the CLI
 *  unresolved and claims no resolution), so keying on that field alone collapses
 *  every configured model into one. The picker still shows every row; only the
 *  count dedupes. */
export function distinctModelCount(catalog: ModelCatalog | undefined): number {
  return new Set(cachedModels(catalog).map((m) => m.resolvedModel || m.value)).size;
}

/** The cache shape `catalog_probe.rs` writes now, mirrored from `CACHE_SHAPE`
 *  there and compared only here.
 *
 *  Two numbers rather than one because a stamp has to be *written* where the
 *  probe runs and *judged* where the fields are read, and the alternative -
 *  Rust deciding staleness too - is the second implementation of one rule that
 *  `isStale` was moved out of Rust to prevent. A test pins the two equal, so a
 *  bump that lands in one language fails rather than half-applying.
 *
 *  Exported for that test alone; nothing else has any business comparing it. */
export const CACHE_SHAPE = 7;

/** Whether what is remembered no longer describes what this Tori reads.
 *
 *  Two comparisons, never a TTL. **The binary**, on the same rule as
 *  `ModelCatalog::is_stale` and with **both unknown-version cases answering
 *  false**: neither is evidence that anything changed, and treating absence of
 *  evidence as staleness would re-probe a version-less binary on every read.
 *  Such a agent comes back through Check again.
 *
 *  And **the cache's own shape**, which no version comparison can see: a
 *  catalogue missing a field this build reads describes an older Tori, and the
 *  binary on disk need not have moved at all. An unstamped catalogue reads as
 *  shape 1, so introducing the stamp invalidates nothing; bumping the constant
 *  is the one action that makes anybody re-probe. */
export function isStale(catalog: ModelCatalog | undefined, currentVersion: string | null): boolean {
  const cached = catalog?.catalogue;
  if (!cached) return false;
  if ((cached.shape ?? 1) < CACHE_SHAPE) return true;
  if (!cached.version || !currentVersion) return false;
  return cached.version !== currentVersion;
}

// --- the shared store ---
//
// One answer for every surface, the same reason `agentHealth` is a store: the
// agent card's count, the detail page's list and the chat picker all read this,
// and three components each fetching it is three chances to disagree about what
// a agent offers.

// Null means "not asked yet", which is distinct from an empty array: one is
// ignorance, the other is an answer.
const [modelCatalogs, setModelCatalogs] = createSignal<ModelCatalog[] | null>(null);
export { modelCatalogs };

let reading: Promise<ModelCatalog[] | null> | null = null;

/** The catalogue Tori remembers for one account of one agent, or undefined
 *  before the store has an answer at all.
 *
 *  **No fallback to the default account.** An account with no row of its own is
 *  one nobody has probed, and answering with the default account's models would
 *  offer a picker rows this account may not have - which is the confusion the
 *  per-account key exists to end. The missing row is a never-probed one and
 *  `refreshCatalogIfDue` fills it. */
export function catalogFor(agentId: string, profile: string | null = null): ModelCatalog | undefined {
  const id = asProfileId(profile);
  return modelCatalogs()?.find((c) => c.agentId === agentId && c.profileId === id);
}

/** Read the cache. **Never probes**, so it is safe on any component's mount.
 *
 *  The split between this and the refreshes is the whole safety property: a
 *  probe spawns the agent's binary, and opening Settings must not launch every
 *  agent on the machine.
 *
 *  Returns the in-flight read rather than nothing, so a caller that needs the
 *  answer (deciding what is due for a re-probe) can wait for the same request
 *  every other caller is already sharing. */
export function ensureModelCatalogsLoaded(): Promise<ModelCatalog[] | null> {
  if (reading) return reading;
  reading = invoke<ModelCatalog[]>("model_catalogs")
    .then((c) => {
      // Guarded rather than trusted, the same rule `AgentsSection` applies to
      // `agent_health`: this is an IPC reply, and a reply that is not a list
      // must leave the store unanswered rather than throw through every card
      // reading it.
      const rows = Array.isArray(c) ? c : [];
      setModelCatalogs(rows);
      return rows;
    })
    .catch(() => {
      // Left null, and the read is retryable. Unknown must not render as "no
      // agent offers anything", which is what an empty array would say.
      reading = null;
      return null;
    });
  return reading;
}

/** Forget the cache and its once-per-run read latch, so the next reader asks
 *  the backend again.
 *
 *  The store holds one row per **account**, and `model_catalogs` enumerates
 *  them from `accounts.json`, so adding or removing an account changes which
 *  rows exist. Without this a freshly added account had no row at all, and
 *  `refreshCatalogIfDue` (which only asks about a row it can see) would never
 *  probe it until the app restarted. Called where the account list changes,
 *  beside `forgetProfileEnvs` and for the same reason. */
export function forgetModelCatalogs() {
  reading = null;
  setModelCatalogs(null);
  setProbing([]);
}

/** Test-only: forget everything, including the once-per-run read latch.
 *
 *  The latch is module state that outlives a test, so without this the *second*
 *  test in a file to mount a card never calls `model_catalogs` at all and
 *  renders whatever the first one left behind. That is a green assertion about
 *  test ordering rather than about the code. Same reason `modelCaps` has one. */
export function __resetModelCatalogsForTests() {
  forgetModelCatalogs();
}

/** One account and agent, as one key. A space because neither id can contain
 *  one, the same join `profileEnv` uses for the same pair.
 *
 *  Exported so anything else keying on the pair (the palette builds a map of
 *  catalogues) joins it the same way and spells the default account once. */
export const catalogKey = (agentId: string, profile: string | null) =>
  `${agentId} ${asProfileId(profile)}`;
const rowKey = (c: ModelCatalog) => catalogKey(c.agentId, c.profileId);

/** Fold one account's fresh answer into the store, leaving the rest alone.
 *
 *  In place rather than moved to the end: the store's order is the adapter
 *  registry's, and re-probing one account must not reorder the cards reading
 *  it. */
function absorb(next: ModelCatalog) {
  setModelCatalogs((prev) => {
    const rows = prev ?? [];
    const key = rowKey(next);
    return rows.some((c) => rowKey(c) === key)
      ? rows.map((c) => (rowKey(c) === key ? next : c))
      : [...rows, next];
  });
}

// Which accounts have a probe in flight right now. A signal rather than a plain
// set because a row renders from it, and it is what stops a second picker open
// from asking again while the first answer is still on its way: the store cannot
// say "already probed" until the probe lands.
const [probing, setProbing] = createSignal<readonly string[]>([]);

/** Whether a probe for this account of this agent is in flight. */
export function isProbing(agentId: string, profile: string | null = null): boolean {
  return probing().includes(catalogKey(agentId, profile));
}

/** How many agents [`refreshDueCatalogs`] would actually ask.
 *
 *  Exported so a Check-all control can disable itself rather than flashing
 *  "asking" and doing nothing: on a settled machine nothing is due, and a button
 *  that silently no-ops reads as a broken one. */
export function dueCount(): number {
  return (modelCatalogs() ?? []).filter(isDue).length;
}

/** Re-ask one account of one agent, whatever its current state. The detail
 *  page's Check again, and the only route back for a binary that reports no
 *  version. */
export function refreshCatalog(agentId: string, profile: string | null = null): Promise<ModelCatalog | null> {
  const key = catalogKey(agentId, profile);
  setProbing((ids) => (ids.includes(key) ? ids : [...ids, key]));
  return invoke<ModelCatalog>("refresh_model_catalog", { agentId, profileId: profile })
    .then((c) => {
      absorb(c);
      return c;
    })
    .catch(() => null)
    .finally(() => setProbing((ids) => ids.filter((id) => id !== key)));
}

/** Fold a live session's command list into this account's cache, so the next
 *  draft's `/` menu opens on what the agent said last, not on what the last
 *  probe heard. A probe is only re-run on a version change, so a plugin
 *  installed since it ran stayed out of the menu until an explicit Ask again.
 *  Fire-and-forget: the session already has its list. */
export function recordLiveCommands(agentId: string, profile: string | null, commands: readonly SlashCommand[]) {
  if (!commands.length) return;
  void invoke<ModelCatalog>("record_live_catalog", { agentId, profileId: profile, commands })
    .then(absorb)
    .catch(() => null);
}

/** Ask every agent that has never answered or whose binary has changed.
 *
 *  **One request per agent rather than the backend's batch command**, and the
 *  difference is what the user sees: the batch answers only once its slowest
 *  member does, so a single agent timing out would hold every row empty for
 *  the whole deadline. Fanned out, each row fills the moment its own probe
 *  lands and a failure is one row's error rather than everyone's wait.
 *
 *  Agents with a current answer are skipped, which is what makes this safe to
 *  call on a picker's first open: a machine whose catalogues are all fresh
 *  spawns nothing at all. */
export async function refreshDueCatalogs(): Promise<unknown> {
  // The cache first, and awaited: what is due is decided from what is already
  // remembered, and deciding that against a store nobody has read yet answers
  // "nothing is due" for every agent on the machine.
  await ensureModelCatalogsLoaded();
  // The **signal**, not what that promise resolved to. The read is cached once
  // per run, so its value is the state of the world at first load; every probe
  // since has landed in the store and nowhere else. Deciding from the promise
  // re-asks a agent that answered five seconds ago.
  return Promise.all(
    (modelCatalogs() ?? []).filter(isDue).map((c) => refreshCatalog(c.agentId, c.profileId)),
  );
}

/** Ask one account of one agent, but only if its answer is missing or out of
 *  date.
 *
 *  What a chat opening on a agent calls. Scoped to the one account it would
 *  start: opening a claude chat is already launching claude, so asking it costs
 *  nothing new, while spawning every *other* agent on the machine because a
 *  chat was opened would be a real surprise. */
export async function refreshCatalogIfDue(agentId: string, profile: string | null = null): Promise<unknown> {
  await ensureModelCatalogsLoaded();
  const mine = catalogFor(agentId, profile);
  return mine && isDue(mine) ? refreshCatalog(agentId, profile) : null;
}

/** Never answered, answered about a binary that has since changed, or failed in
 *  a way a retry could fix.
 *
 *  **A failure is not an answer.** Without that clause a agent that was signed
 *  out once reads "Error" forever, because nothing would ever ask it again after
 *  the user signed in. `unsupported` is the exception and the reason this is a
 *  reason check rather than a state check: it says Tori cannot ask this agent
 *  at all, so a retry is a process spawned to learn the same thing.
 *
 *  In-flight counts as not due, which is what stops a second click from asking
 *  again while the first answer is still on its way: the store cannot say
 *  "probed" until the probe lands. */
function isDue(catalog: ModelCatalog): boolean {
  if (isProbing(catalog.agentId, catalog.profileId)) return false;
  if (catalog.lastFailure) return catalog.lastFailure.reason !== "unsupported";
  return catalog.state === "neverProbed" || isStale(catalog, agentVersion(catalog.agentId));
}
