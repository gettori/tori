// Expressions you asked the debugger to keep answering.
//
// The same shape as `breakpoints.ts` one level shallower: a workspace's watches
// are a list, not a per-file map, because an expression is not attached to a
// file. Bucketed per workspace for the same reason breakpoints are, since
// `orders.length` means one thing in one worktree and nothing in another.
//
// Pure, and deliberately so: nothing here knows a session exists.
// `debugWatch.ts` owns the evaluating half and the signal the pane reads, which
// is what lets these rules be tested without a debug run.

/** One workspace's expressions, in the order they are shown. */
export type WorkspaceWatches = readonly string[];

/** Every workspace's watches, keyed by branch-unit folder. */
export type WatchStore = Readonly<Record<string, WorkspaceWatches>>;

const LS_WATCHES = "sway.watches";

/**
 * How many expressions one workspace keeps.
 *
 * Every one of them is re-evaluated on every stop, and a stop happens on every
 * step, so a list nobody pruned is a request storm on the F10 key.
 */
export const MAX_WATCHES = 50;

/** This workspace's expressions, empty for one with none. */
export function watchesFor(store: WatchStore, ws: string): WorkspaceWatches {
  return store[ws] ?? [];
}

/** Replace one workspace's list, dropping a workspace left with none rather
 *  than keeping an empty record that outlives every watch in it. */
function setWatches(store: WatchStore, ws: string, list: readonly string[]): WatchStore {
  const before = watchesFor(store, ws);
  if (before.length === list.length && before.every((e, i) => e === list[i])) return store;
  const next = { ...store };
  if (list.length) next[ws] = [...list];
  else delete next[ws];
  return next;
}

/**
 * Append an expression.
 *
 * Trimmed, and a duplicate is a no-op rather than a second row: two identical
 * expressions answer identically forever, so the second one is only a request
 * per stop and a row to scroll past.
 */
export function addWatch(store: WatchStore, ws: string, expression: string): WatchStore {
  const text = expression.trim();
  const list = watchesFor(store, ws);
  if (!text || list.includes(text) || list.length >= MAX_WATCHES) return store;
  return setWatches(store, ws, [...list, text]);
}

/** Drop the expression at `index`. Out of range is a no-op. */
export function removeWatch(store: WatchStore, ws: string, index: number): WatchStore {
  const list = watchesFor(store, ws);
  if (index < 0 || index >= list.length) return store;
  return setWatches(store, ws, [...list.slice(0, index), ...list.slice(index + 1)]);
}

/** Move the expression at `from` to `to`. Either end out of range is a no-op,
 *  so a row cannot be reordered off the list by a stale index. */
export function moveWatch(store: WatchStore, ws: string, from: number, to: number): WatchStore {
  const list = watchesFor(store, ws);
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return store;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return setWatches(store, ws, next);
}

/** Read a stored blob defensively: anything that is not a list of strings is
 *  dropped rather than trusted, since this survives across versions. */
export function parseWatchStore(raw: string | null): WatchStore {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [ws, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const clean = list
        .filter((e): e is string => typeof e === "string")
        .map((e) => e.trim())
        .filter(Boolean)
        .slice(0, MAX_WATCHES);
      if (clean.length) out[ws] = [...new Set(clean)];
    }
    return out;
  } catch {
    return {};
  }
}

export function loadWatches(): WatchStore {
  try {
    return parseWatchStore(localStorage.getItem(LS_WATCHES));
  } catch {
    return {};
  }
}

export function saveWatches(store: WatchStore): void {
  try {
    localStorage.setItem(LS_WATCHES, JSON.stringify(store));
  } catch {
    // A full or unavailable localStorage loses the list on reload, which is
    // worth strictly less than the run in progress.
  }
}
