// Which files you actually work in, so a picker opened with an empty box can
// answer before you type.
//
// "Frecency" is frequency times recency: a count on its own promotes the file
// you opened forty times last month, and a timestamp on its own promotes
// whatever you glanced at a minute ago. Neither is the file you are working in.
// The two are combined multiplicatively, so age discounts the whole record
// rather than being one term among several.
//
// An **edit weighs more than an open**, because opening a file is often a
// mistake you correct by opening another one, and editing it never is. That is
// what lets a file edited once this morning outrank one opened repeatedly a
// fortnight ago.
//
// Pure and here rather than in a picker, because Phase 6's omnibox ranks the
// same way and must not reimplement the rule: this module imports nothing from
// any component, and `rankByFrecency` takes the items and their paths rather
// than knowing what a row is. Persistence sits beside the rule for the same
// reason `tabPersist.ts` keeps its own load/save: the storage shape and the
// rule that reads it are one thing to keep honest.

/** What is remembered about one file. Counts plus the last time it was touched;
 *  per-event timestamps would be a log, and a log of every open is not worth
 *  what it costs to keep. */
export type FileStat = { opens: number; edits: number; lastAt: number };

/** One workspace's files, keyed by absolute path. */
export type WorkspaceStats = Readonly<Record<string, FileStat>>;

/** Every workspace's stats, keyed by branch-unit folder. Bucketed like the tab
 *  strip and the jump list, and for the same reason: a path open in one worktree
 *  names nothing in another. */
export type FrecencyStore = Readonly<Record<string, WorkspaceStats>>;

export type Touch = "open" | "edit";

const LS_FRECENCY = "tori.fileFrecency";

/** An edit counts for four opens. Not tuned, chosen: the ratio only has to be
 *  large enough that one edit beats a handful of stale opens. */
export const OPEN_WEIGHT = 1;
export const EDIT_WEIGHT = 4;

/** How long a record takes to lose half its weight. Three days is about the
 *  span of one piece of work: what you were in on Monday should still rank on
 *  Wednesday and be gone by the following week. */
export const HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

/** Files remembered per workspace. Bounded because a long-lived project touches
 *  thousands and the tail scores near zero anyway. */
export const MAX_TRACKED = 200;

/** A file nobody has touched in this long is dropped on load, matching how
 *  `tabPersist` retires a workspace nobody has opened. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** This file's weight now: what it earned, discounted by how long ago. */
export function scoreOf(stat: FileStat, now: number, halfLifeMs = HALF_LIFE_MS): number {
  const weight = stat.opens * OPEN_WEIGHT + stat.edits * EDIT_WEIGHT;
  // Clamped at zero, so a clock that went backwards cannot inflate a record
  // past its earned weight.
  const age = Math.max(0, now - stat.lastAt);
  return weight * Math.pow(0.5, age / halfLifeMs);
}

/** Drop all but the highest-scoring `cap` files. */
function capped(stats: Record<string, FileStat>, now: number, cap: number): Record<string, FileStat> {
  const paths = Object.keys(stats);
  if (paths.length <= cap) return stats;
  const keep = paths.sort((a, b) => scoreOf(stats[b], now) - scoreOf(stats[a], now)).slice(0, cap);
  return Object.fromEntries(keep.map((p) => [p, stats[p]]));
}

/** Record touching a file, and cap the workspace if that put it over. */
export function note(
  store: FrecencyStore,
  ws: string,
  path: string,
  kind: Touch,
  now: number,
  cap = MAX_TRACKED,
): FrecencyStore {
  const stats = store[ws] ?? {};
  const prev = stats[path];
  const next: FileStat = {
    opens: (prev?.opens ?? 0) + (kind === "open" ? 1 : 0),
    edits: (prev?.edits ?? 0) + (kind === "edit" ? 1 : 0),
    lastAt: now,
  };
  return { ...store, [ws]: capped({ ...stats, [path]: next }, now, cap) };
}

/**
 * Order items by how much you work in them, highest first.
 *
 * Generic over the item so the picker's rows, the palette's rows and whatever
 * Phase 6's omnibox uses are all the same call. Items with no record score zero
 * and keep the order they came in, which is what makes this safe to apply to a
 * whole project file list: the untouched tail stays in its original order
 * instead of being shuffled.
 */
export function rankByFrecency<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  stats: WorkspaceStats,
  now: number,
): T[] {
  const scored = items.map((item, i) => {
    const stat = stats[pathOf(item)];
    return { item, i, score: stat ? scoreOf(stat, now) : 0 };
  });
  // The index tie-break rather than relying on sort stability: it is guaranteed
  // by the spec now, but saying so here is what makes the "untouched tail keeps
  // its order" claim readable at the call site.
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}

/** The files most worth offering with nothing typed. */
export function topFiles(stats: WorkspaceStats, now: number, limit: number): string[] {
  return rankByFrecency(Object.keys(stats), (p) => p, stats, now).slice(0, limit);
}

/** Drop records nobody has touched in `maxAgeMs`, and any workspace left empty. */
export function pruneStale(store: FrecencyStore, now: number, maxAgeMs = MAX_AGE_MS): FrecencyStore {
  const out: Record<string, WorkspaceStats> = {};
  for (const [ws, stats] of Object.entries(store)) {
    const kept = Object.entries(stats).filter(([, s]) => now - s.lastAt <= maxAgeMs);
    if (kept.length) out[ws] = Object.fromEntries(kept);
  }
  return out;
}

/** Rewrite or drop records by path, for a file that moved or is gone. Same
 *  contract as the jump list's sweep, and needed for the same reason: these are
 *  keyed by absolute path, so a rename or a trash has to reach them or the
 *  picker keeps offering a file that is not there. */
export function mapPaths(store: FrecencyStore, map: (path: string) => string | null): FrecencyStore {
  let changed = false;
  const out: Record<string, WorkspaceStats> = {};
  for (const [ws, stats] of Object.entries(store)) {
    const next: Record<string, FileStat> = {};
    for (const [path, stat] of Object.entries(stats)) {
      const to = map(path);
      if (to === null) {
        changed = true;
        continue;
      }
      if (to !== path) changed = true;
      // A rename onto a path already tracked merges the two records: they are
      // the same file now, and keeping the larger counts is the only answer
      // that does not silently forget work.
      const at = next[to];
      next[to] = at
        ? { opens: at.opens + stat.opens, edits: at.edits + stat.edits, lastAt: Math.max(at.lastAt, stat.lastAt) }
        : stat;
    }
    if (Object.keys(next).length) out[ws] = next;
    else changed = changed || Object.keys(stats).length > 0;
  }
  return changed ? out : store;
}

// Tolerant of anything already in storage: a shape that does not parse reads as
// "nothing remembered" rather than throwing on startup.
export function parseStore(raw: string | null): FrecencyStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, WorkspaceStats> = {};
    for (const [ws, stats] of Object.entries(parsed as Record<string, unknown>)) {
      if (!stats || typeof stats !== "object") continue;
      const kept: Record<string, FileStat> = {};
      for (const [path, s] of Object.entries(stats as Record<string, unknown>)) {
        const stat = s as Partial<FileStat> | null;
        if (
          !stat ||
          typeof stat.opens !== "number" ||
          typeof stat.edits !== "number" ||
          typeof stat.lastAt !== "number"
        ) {
          continue;
        }
        kept[path] = { opens: stat.opens, edits: stat.edits, lastAt: stat.lastAt };
      }
      if (Object.keys(kept).length) out[ws] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadFrecency(now: number): FrecencyStore {
  try {
    return pruneStale(parseStore(localStorage.getItem(LS_FRECENCY)), now);
  } catch {
    return {};
  }
}

export function saveFrecency(store: FrecencyStore): void {
  try {
    localStorage.setItem(LS_FRECENCY, JSON.stringify(store));
  } catch {
    /* quota or private mode: ranking degrades to the project's own file order */
  }
}
