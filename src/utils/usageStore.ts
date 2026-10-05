// What every agent account's quota windows are at, merged across every source
// that has ever reported one.
//
// Module-level rather than per-panel, because the thing being described is not a
// panel: a Claude account's five-hour window is one fact about one login, and
// three chats open on it are three views of that fact. A per-chat store would
// give each of them its own copy, so two chats on one account would disagree
// about the same number and the titlebar would have no one place to read.
//
// **The merge is per window kind, and absence is a property of the source, not
// of the newest sample.** A passive `rate_limit_event` names the two generic
// windows; the account-token rung also returns the model-scoped weekly one. If a
// later passive sample replaced the whole account, the scoped window would blink
// out every turn. So a sample updates the kinds it names and leaves the rest
// alone, and a window is missing only when nothing has ever returned it.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { asProfileId } from "./agentHealth";
import type { QuotaReading, QuotaState } from "./chatRateLimit";

/** Which rung of the source ladder a reading came from. Recorded so the card
 *  can say where a number is from, and so a deeper rung's extra windows are
 *  attributable rather than anonymous. */
export type UsageSource = "sessions" | "cli" | "token";

export type WindowReading = QuotaReading & {
  /** Epoch **milliseconds** (a local clock reading), unlike `resetsAt`, which
   *  is epoch seconds because that is what every source sends. */
  sampledAt: number;
  source: UsageSource;
};

/**
 * How much a reading can still be believed.
 *
 * Three, not two, and the third is the one that matters: a window past its
 * reset is not an old number, it is a *wrong* number. Drawing it dimmed the way
 * a merely-old one is drawn would show 98% on a quota that has since emptied.
 */
export type Temporal = "live" | "stale" | "expired";

/**
 * When a reading stops counting as current.
 *
 * A passive sample only arrives when a turn runs, so a chat being read rather
 * than driven goes quiet for long stretches with nothing wrong. Fifteen minutes
 * is past that and well inside the shortest window (five hours), so a stale
 * mark means "nobody has asked lately", never "this window is about to reset".
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/** `agentId` and the account in the backend's spelling, joined by a separator no
 *  id can contain. A single string so it can key a plain object that serialises. */
export type AccountKey = string;

/** Built rather than written as an escape on purpose: a raw NUL byte in a source
 *  file type-checks, passes every test, and makes git read the file as binary. */
const SEP = String.fromCharCode(0);

export const accountKey = (agentId: string, profile: string | null): AccountKey =>
  `${agentId}${SEP}${asProfileId(profile)}`;

/** The key read back apart, with the account in the **backend's** spelling (the
 *  default account is the literal `"default"`, never null). A surface that
 *  iterates the store gets an agent and an account out of it; nothing else
 *  should take this string apart. */
export function splitAccountKey(key: AccountKey): { agentId: string; profile: string } {
  const at = key.indexOf(SEP);
  return at === -1
    ? { agentId: key, profile: asProfileId(null) }
    : { agentId: key.slice(0, at), profile: key.slice(at + 1) };
}

/** Readings by account, then by window kind. */
type Readings = Record<AccountKey, Record<string, WindowReading>>;

/**
 * Which transitions have already been announced, and until when.
 *
 * The value is the window's `resetsAt` in epoch **seconds**, which is what makes
 * this prunable: a key whose reset has passed describes a window that no longer
 * exists, so keeping it would silence the next one. Without the stamp the set
 * could only ever grow, and the first notice of a new window would be swallowed
 * by the record of the last one.
 */
type Fired = Record<string, number | null>;

const [readings, setReadings] = createSignal<Readings>({});
const [fired, setFired] = createSignal<Fired>({});

/** Every account with at least one window on record, whatever state it is in. */
export function accountsWithReadings(): AccountKey[] {
  return Object.keys(readings()).filter((k) => Object.keys(readings()[k]).length > 0);
}

/** One account's windows, newest sample per kind, in a stable order so a strip
 *  does not reshuffle its bars when a sample lands. */
export function windowsFor(agentId: string, profile: string | null): WindowReading[] {
  const account = readings()[accountKey(agentId, profile)] ?? {};
  return Object.keys(account)
    .sort()
    .map((kind) => account[kind]);
}

export function windowFor(agentId: string, profile: string | null, kind: string): WindowReading | null {
  return readings()[accountKey(agentId, profile)]?.[kind] ?? null;
}

/**
 * Fold a source's readings into the account.
 *
 * Per kind, and only forward: a sample older than the one on record is dropped
 * rather than applied. Two chats on one account report the same windows on their
 * own turn boundaries, and events do not arrive in the order they were sampled
 * once a replayed transcript is in the mix.
 */
export function recordReadings(
  agentId: string,
  profile: string | null,
  source: UsageSource,
  incoming: QuotaReading[],
  now = Date.now(),
) {
  if (!incoming.length) return;
  const key = accountKey(agentId, profile);
  let changed = false;
  setReadings((prev) => {
    const account = { ...prev[key] };
    for (const r of incoming) {
      const held = account[r.kind];
      if (held && held.sampledAt > now) continue;
      account[r.kind] = { ...r, sampledAt: now, source };
      changed = true;
    }
    return changed ? { ...prev, [key]: account } : prev;
  });
  if (!changed) return;
  scheduleSave();
  // Rust decides whether a window moved; this is every sample.
  const readings = incoming.map(({ kind, utilization, resetsAt }) => ({ kind, utilization, resetsAt }));
  invoke("rpc_quota", { agent: agentId, profile, readings }).catch(() => {});
}

/**
 * Coalesce the writes.
 *
 * A sample lands on every turn boundary of every open chat, and one file write
 * per turn for a number that moves by a percent is waste. Losing the last few
 * seconds to a crash costs nothing: the next turn re-reports the same windows,
 * and the fired keys the write is really protecting are re-derived from readings
 * that have not gone anywhere.
 */
const SAVE_DEBOUNCE_MS = 5_000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveUsageStore();
  }, SAVE_DEBOUNCE_MS);
}

/** How much of this reading is still true. */
export function temporalOf(r: WindowReading, now = Date.now()): Temporal {
  if (r.resetsAt !== null && r.resetsAt * 1000 <= now) return "expired";
  return now - r.sampledAt >= STALE_AFTER_MS ? "stale" : "live";
}

/**
 * The unit of deduplication everywhere: one account's one window, for one reset,
 * entering one state. A new `resetsAt` is a new window, and so re-arms the notice
 * on its own.
 *
 * Exported because two things dedupe on it and only one of them persists. A
 * notification is once per machine, so it uses the saved set below; a transcript
 * notice is once per *chat*, since the news belongs in every open chat of the
 * account, so each panel keeps its own set of these strings.
 */
export const transitionKey = (
  agentId: string,
  profile: string | null,
  kind: string,
  resetsAt: number | null,
  state: QuotaState,
): string => `${accountKey(agentId, profile)}${SEP}${kind}${SEP}${resetsAt ?? "none"}${SEP}${state}`;

/**
 * Whether this transition is news, marking it said if it is.
 *
 * Called on every event, because the event stream is the only thing that knows a
 * level moved; the dedupe is what turns one-per-turn into one-per-window. `ok`
 * and `expired` are never announced, so they can never be marked.
 */
export function shouldAnnounce(agentId: string, profile: string | null, r: WindowReading, state: QuotaState): boolean {
  if (state !== "approaching" && state !== "reached") return false;
  const key = transitionKey(agentId, profile, r.kind, r.resetsAt, state);
  if (key in fired()) return false;
  setFired((prev) => ({ ...prev, [key]: r.resetsAt }));
  // The one thing that must reach disk. A notice repeated after every restart is
  // the failure this whole set exists to prevent.
  scheduleSave();
  return true;
}

/**
 * Drop every fired key that can no longer be proved current.
 *
 * A past reset is the ordinary case: that window is gone and the next one must
 * be free to announce itself. A key with **no** reset is dropped too, for the
 * opposite reason - nothing about it can ever go stale, so persisting it would
 * silence that window permanently. Repeating a notice after a restart is the
 * lesser failure of the two.
 */
export function pruneFired(f: Fired, now = Date.now()): Fired {
  const out: Fired = {};
  for (const [k, resetsAt] of Object.entries(f)) {
    if (resetsAt !== null && resetsAt * 1000 > now) out[k] = resetsAt;
  }
  return out;
}

/** What goes to disk, and what comes back. Mirrors `usage_snapshot.rs`. */
export type UsageSnapshot = {
  readings: Readings;
  fired: Fired;
};

export function usageSnapshot(now = Date.now()): UsageSnapshot {
  return { readings: readings(), fired: pruneFired(fired(), now) };
}

/**
 * Read the last snapshot back, so a restart opens with the windows it knew.
 *
 * The fired set is seeded along with it, which is the point: a restart inside a
 * window that has already been announced must not announce it again, and the
 * only record that it was is this one.
 */
export async function loadUsageStore(now = Date.now()) {
  try {
    const snap = await invoke<UsageSnapshot | null>("usage_snapshot_load");
    if (!snap) return;
    setReadings(snap.readings ?? {});
    setFired(pruneFired(snap.fired ?? {}, now));
  } catch {
    /* an unreadable snapshot is one cold start, not a broken titlebar */
  }
}

export async function saveUsageStore(now = Date.now()) {
  const snap = usageSnapshot(now);
  setFired(snap.fired);
  try {
    await invoke("usage_snapshot_save", { snapshot: snap });
  } catch {
    /* the titlebar is live either way; a failed write costs the next restart */
  }
}

/** Drop everything. Test support, named so it cannot be mistaken for part of the
 *  store's real API: module-level state outlives a component, so without it a
 *  test inherits the previous one's readings. */
export function resetUsageStoreForTests() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  setReadings({});
  setFired({});
}

/**
 * Put one account's windows on record without an event. Test and story support,
 * following `resetSessionStoreForTests`.
 *
 * `recordReadings` would do most of this, and deliberately does not do all of
 * it: it stamps `sampledAt` with the clock, so a story showing what a stale
 * reading looks like could only get one by waiting fifteen minutes. Here the
 * stamp is an argument.
 */
export function seedUsageStoreForTests(
  agentId: string,
  profile: string | null,
  incoming: (QuotaReading & Partial<Pick<WindowReading, "sampledAt" | "source">>)[],
  now = Date.now(),
) {
  const key = accountKey(agentId, profile);
  setReadings((prev) => {
    const account = { ...prev[key] };
    for (const r of incoming) {
      account[r.kind] = { ...r, sampledAt: r.sampledAt ?? now, source: r.source ?? "sessions" };
    }
    return { ...prev, [key]: account };
  });
}
