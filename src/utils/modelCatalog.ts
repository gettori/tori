// What a harness said it can run, as the backend cached it.
//
// Mirrors `src-tauri/src/catalog_probe.rs`. The rows are deliberately the same
// shape as a live handshake's `ChatModelInfo`: the backend flattens it, so a
// cached row and a live row are the same JSON and a picker can read one where it
// reads the other. That is what makes "live wins, cache fills in before a
// session exists" a swap of source rather than a swap of shape.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { agentHealth } from "./agentHealth";
import type { ChatAccount, ChatModeInfo, ChatModelInfo } from "./chatTypes";

// Which of the three things a harness's catalogue currently is.
//
// `neverProbed` is not an error and not an empty catalogue: it is the state of a
// harness nobody has asked yet, and it renders as no answer rather than as zero.
export type CatalogState = "neverProbed" | "failed" | "probed";

// Why a probe did not produce a catalogue. `unsupported` is a fact about Sway,
// not about the binary, so a surface must not render it as the harness failing.
export type ProbeFailureReason = "spawnFailed" | "timedOut" | "signedOut" | "noAnswer" | "unsupported";

export type ProbeFailure = {
  reason: ProbeFailureReason;
  // The harness's own words where there are any. Empty rather than invented.
  detail: string;
  atMs: number;
};

export type CatalogModel = ChatModelInfo & {
  // This row came from the user's own harness configuration rather than the
  // harness's catalogue. Still not something Sway invented, but not something it
  // can confirm either: such a row carries an **empty `resolvedModel`**, because
  // the configured string is passed to the CLI unresolved. Anything deduping by
  // that field has to fall back to `value`, or every user-configured row
  // collapses into one.
  userConfigured?: boolean;
};

export type Catalogue = {
  // The binary version at the moment of the probe. Null is the version-unknown
  // case, which is re-checked only when the user asks.
  version: string | null;
  probedAtMs: number;
  models: CatalogModel[];
  modes: ChatModeInfo[];
  // The agent's own config options, verbatim. Empty for claude, which publishes
  // none. Typed loosely here because nothing reads them yet.
  options?: unknown[];
  // The account the harness named, when it named one. A catalogue can differ per
  // account, so a surface showing one has to be able to say whose answer it is.
  account: ChatAccount | null;
};

export type ModelCatalog = {
  harnessId: string;
  state: CatalogState;
  // The last probe that answered, which outlives every failure after it. A
  // failed probe never clears this: stale-but-real beats fresh-but-empty.
  catalogue: Catalogue | null;
  // Set when the most recent attempt failed, cleared by one that answers.
  lastFailure: ProbeFailure | null;
};

/** The cached models for one harness, or none when it has never answered.
 *
 *  A harness in the `failed` state still has its models here when a previous
 *  probe succeeded, which is the whole reason the failure and the catalogue are
 *  separate fields. */
export function cachedModels(catalog: ModelCatalog | undefined): CatalogModel[] {
  return catalog?.catalogue?.models ?? [];
}

/** How many *distinct* models a catalogue offers.
 *
 *  Deduped by `resolvedModel`, because a catalogue names aliases: `default`,
 *  `sonnet` and `claude-sonnet-5` are three rows and one model, and a card
 *  reading "8 models" for five would be counting Sway's ability to spell.
 *
 *  **Falling back to `value` is not a nicety.** A user-configured row carries an
 *  empty `resolvedModel` on purpose (Sway passes the string to the CLI
 *  unresolved and claims no resolution), so keying on that field alone collapses
 *  every configured model into one. The picker still shows every row; only the
 *  count dedupes. */
export function distinctModelCount(catalog: ModelCatalog | undefined): number {
  return new Set(cachedModels(catalog).map((m) => m.resolvedModel || m.value)).size;
}

/** Whether what is remembered no longer describes the binary on disk.
 *
 *  The same rule as `ModelCatalog::is_stale`, and deliberately the same
 *  shape: version comparison only, never a TTL, and **both unknown-version
 *  cases answer false**. Neither is evidence that anything changed, and
 *  treating absence of evidence as staleness would re-probe a version-less
 *  binary on every read. Such a harness comes back through Check again. */
export function isStale(catalog: ModelCatalog | undefined, currentVersion: string | null): boolean {
  const recorded = catalog?.catalogue?.version;
  if (!recorded || !currentVersion) return false;
  return recorded !== currentVersion;
}

// --- the shared store ---
//
// One answer for every surface, the same reason `agentHealth` is a store: the
// harness card's count, the detail page's list and the chat picker all read this,
// and three components each fetching it is three chances to disagree about what
// a harness offers.

// Null means "not asked yet", which is distinct from an empty array: one is
// ignorance, the other is an answer.
const [modelCatalogs, setModelCatalogs] = createSignal<ModelCatalog[] | null>(null);
export { modelCatalogs };

let reading: Promise<ModelCatalog[] | null> | null = null;

/** The catalogue Sway remembers for one harness, or undefined before the store
 *  has an answer at all. */
export function catalogFor(harnessId: string): ModelCatalog | undefined {
  return modelCatalogs()?.find((c) => c.harnessId === harnessId);
}

/** Read the cache. **Never probes**, so it is safe on any component's mount.
 *
 *  The split between this and the refreshes is the whole safety property: a
 *  probe spawns the harness's binary, and opening Settings must not launch every
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
      // harness offers anything", which is what an empty array would say.
      reading = null;
      return null;
    });
  return reading;
}

/** Test-only: forget everything, including the once-per-run read latch.
 *
 *  The latch is module state that outlives a test, so without this the *second*
 *  test in a file to mount a card never calls `model_catalogs` at all and
 *  renders whatever the first one left behind. That is a green assertion about
 *  test ordering rather than about the code. Same reason `modelCaps` has one. */
export function __resetModelCatalogsForTests() {
  reading = null;
  setModelCatalogs(null);
  setProbing([]);
}

/** Fold one harness's fresh answer into the store, leaving the rest alone.
 *
 *  In place rather than moved to the end: the store's order is the adapter
 *  registry's, and re-probing one harness must not reorder the cards reading it. */
function absorb(next: ModelCatalog) {
  setModelCatalogs((prev) => {
    const rows = prev ?? [];
    return rows.some((c) => c.harnessId === next.harnessId)
      ? rows.map((c) => (c.harnessId === next.harnessId ? next : c))
      : [...rows, next];
  });
}

// Which harnesses have a probe in flight right now. A signal rather than a plain
// set because a row renders from it, and it is what stops a second picker open
// from asking again while the first answer is still on its way: the store cannot
// say "already probed" until the probe lands.
const [probing, setProbing] = createSignal<readonly string[]>([]);

/** Whether a probe for this harness is in flight. */
export function isProbing(harnessId: string): boolean {
  return probing().includes(harnessId);
}

/** How many harnesses [`refreshDueCatalogs`] would actually ask.
 *
 *  Exported so a Check-all control can disable itself rather than flashing
 *  "asking" and doing nothing: on a settled machine nothing is due, and a button
 *  that silently no-ops reads as a broken one. */
export function dueCount(): number {
  return (modelCatalogs() ?? []).filter(isDue).length;
}

/** Re-ask one harness, whatever its current state. The detail page's Check
 *  again, and the only route back for a binary that reports no version. */
export function refreshCatalog(harnessId: string): Promise<ModelCatalog | null> {
  setProbing((ids) => (ids.includes(harnessId) ? ids : [...ids, harnessId]));
  return invoke<ModelCatalog>("refresh_model_catalog", { harnessId })
    .then((c) => {
      absorb(c);
      return c;
    })
    .catch(() => null)
    .finally(() => setProbing((ids) => ids.filter((id) => id !== harnessId)));
}

/** Ask every harness that has never answered or whose binary has changed.
 *
 *  **One request per harness rather than the backend's batch command**, and the
 *  difference is what the user sees: the batch answers only once its slowest
 *  member does, so a single harness timing out would hold every row empty for
 *  the whole deadline. Fanned out, each row fills the moment its own probe
 *  lands and a failure is one row's error rather than everyone's wait.
 *
 *  Harnesses with a current answer are skipped, which is what makes this safe to
 *  call on a picker's first open: a machine whose catalogues are all fresh
 *  spawns nothing at all. */
export async function refreshDueCatalogs(): Promise<unknown> {
  // The cache first, and awaited: what is due is decided from what is already
  // remembered, and deciding that against a store nobody has read yet answers
  // "nothing is due" for every harness on the machine.
  await ensureModelCatalogsLoaded();
  // The **signal**, not what that promise resolved to. The read is cached once
  // per run, so its value is the state of the world at first load; every probe
  // since has landed in the store and nowhere else. Deciding from the promise
  // re-asks a harness that answered five seconds ago.
  return Promise.all((modelCatalogs() ?? []).filter(isDue).map((c) => refreshCatalog(c.harnessId)));
}

/** Ask one harness, but only if its answer is missing or out of date.
 *
 *  What a chat opening on a harness calls. Scoped to that one harness rather
 *  than sweeping: opening a claude chat is already launching claude, so asking
 *  it costs nothing new, while spawning every *other* agent on the machine
 *  because a chat was opened would be a real surprise. */
export async function refreshCatalogIfDue(harnessId: string): Promise<unknown> {
  await ensureModelCatalogsLoaded();
  const mine = catalogFor(harnessId);
  return mine && isDue(mine) ? refreshCatalog(harnessId) : null;
}

/** Never answered, answered about a binary that has since changed, or failed in
 *  a way a retry could fix.
 *
 *  **A failure is not an answer.** Without that clause a harness that was signed
 *  out once reads "Error" forever, because nothing would ever ask it again after
 *  the user signed in. `unsupported` is the exception and the reason this is a
 *  reason check rather than a state check: it says Sway cannot ask this harness
 *  at all, so a retry is a process spawned to learn the same thing.
 *
 *  In-flight counts as not due, which is what stops a second click from asking
 *  again while the first answer is still on its way: the store cannot say
 *  "probed" until the probe lands. */
function isDue(catalog: ModelCatalog): boolean {
  if (isProbing(catalog.harnessId)) return false;
  if (catalog.lastFailure) return catalog.lastFailure.reason !== "unsupported";
  const version = agentHealth()?.find((h) => h.id === catalog.harnessId)?.version ?? null;
  return catalog.state === "neverProbed" || isStale(catalog, version);
}
