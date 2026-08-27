// The queries you have run, per workspace, so the last one is an arrow key away.
//
// The fourth thing in this wave bucketed per workspace, after the jump list,
// the frecency store and the bookmarks, and for their reason: a query is
// answered by a project, and the same words mean different work in a different
// worktree.
//
// An entry carries its **options**, not just its text. The panel's toggles are
// part of what was asked - "needle" with regex on is a different search from
// "needle" without it - so recalling a query has to restore them or it hands
// back something the user never ran.
//
// Pure and here rather than in the panel, following `bookmarks.ts`: the storage
// shape, the dedupe rule and the recall cursor are the decisions, and the panel
// is the surface that renders them.

import { parseSearchOptions, parseSearchRepos, type SearchOptions } from "./searchOptions";

/** One query as it was run. */
export type SearchRecall = {
  query: string;
  options: SearchOptions;
  /** The member **repo paths** the search was narrowed to, absent for one that
   *  searched every member. Repo paths rather than the section paths the panel
   *  greps: a worktree recreated somewhere else is still the same member, and a
   *  restriction that forgot it would come back silently unrestricted. */
  repos?: string[];
};

/** One workspace's queries, **newest first**, which is the order the arrows
 *  walk and so the order it is stored in. */
export type WorkspaceHistory = readonly SearchRecall[];

/** Every workspace's queries, keyed by root. */
export type SearchHistoryStore = Readonly<Record<string, WorkspaceHistory>>;

const LS_SEARCH_HISTORY = "sway.searchHistory";

/** Deep enough to reach yesterday's work, shallow enough that the arrows still
 *  get somewhere. Nothing here expires: a query costs a few dozen bytes, and a
 *  history that quietly forgets is worse than one that ends. */
export const MAX_HISTORY = 50;

/** The cursor value meaning "not recalling", i.e. showing what you typed. */
export const DRAFT = -1;

/** This workspace's queries, empty for one nobody has searched. */
export function historyFor(store: SearchHistoryStore, ws: string): WorkspaceHistory {
  return store[ws] ?? [];
}

/**
 * Record a query as run.
 *
 * One entry per query **text**, carrying the options it was last run with,
 * rather than one per (text, options) pair. Toggling case on and searching the
 * same word again is a correction, not a second search worth arrowing past, and
 * the pair-keyed alternative fills the list with entries that look identical in
 * a control that shows only the text.
 *
 * Re-running an old query moves it to the front, so the list stays ordered by
 * when you last cared about it rather than when you first typed it.
 *
 * `repos` travels with the entry for the reason the options do: a query run
 * against one member of a Feature is a different search from the same words run
 * against all of them. An empty list writes no field at all, so an unrestricted
 * search stores exactly what it stored before.
 */
export function noteQuery(
  store: SearchHistoryStore,
  ws: string,
  query: string,
  options: SearchOptions,
  repos: readonly string[] = [],
  cap = MAX_HISTORY,
): SearchHistoryStore {
  if (!ws || !query) return store;
  const entry: SearchRecall = {
    query,
    options: { ...options },
    ...(repos.length ? { repos: [...repos] } : {}),
  };
  const rest = historyFor(store, ws).filter((h) => h.query !== query);
  return { ...store, [ws]: [entry, ...rest].slice(0, cap) };
}

/**
 * Where the arrows land next.
 *
 * `cursor` is `DRAFT` while you are typing and an index into the history once
 * you start recalling. Up goes back in time and stops at the oldest entry;
 * down comes forward and stops at `DRAFT`, which is what restores the text you
 * had typed before you started arrowing. Clamped rather than wrapped: a list
 * that loops has no end to feel, and arriving back at your own draft by
 * pressing Up is a surprise nobody asked for.
 */
export function stepRecall(history: WorkspaceHistory, cursor: number, step: 1 | -1): number {
  const next = cursor + step;
  if (next < DRAFT) return DRAFT;
  if (next > history.length - 1) return Math.max(DRAFT, history.length - 1);
  return next;
}

/** The entry a cursor names, or `null` for `DRAFT` and anything out of range. */
export function recallAt(history: WorkspaceHistory, cursor: number): SearchRecall | null {
  return cursor >= 0 && cursor < history.length ? history[cursor] : null;
}

export function parseHistoryStore(raw: string | null): SearchHistoryStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, WorkspaceHistory> = {};
    for (const [ws, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      const kept: SearchRecall[] = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        const e = entry as { query?: unknown; options?: unknown; repos?: unknown };
        if (typeof e?.query !== "string" || !e.query || seen.has(e.query)) continue;
        seen.add(e.query);
        const repos = parseSearchRepos(e.repos);
        kept.push({
          query: e.query,
          options: parseSearchOptions(e.options),
          ...(repos ? { repos } : {}),
        });
        if (kept.length === MAX_HISTORY) break;
      }
      if (kept.length) out[ws] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadSearchHistory(): SearchHistoryStore {
  try {
    return parseHistoryStore(localStorage.getItem(LS_SEARCH_HISTORY));
  } catch {
    return {};
  }
}

export function saveSearchHistory(store: SearchHistoryStore): void {
  try {
    localStorage.setItem(LS_SEARCH_HISTORY, JSON.stringify(store));
  } catch {
    /* quota or private mode: the history lasts as long as the session does */
  }
}
