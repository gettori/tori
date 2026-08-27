// Searches you named and meant to keep.
//
// The same (query, options) pair `searchHistory.ts` records, under a different
// contract, and the difference is the one `bookmarks.ts` draws against
// `frecency.ts`: history is a record of what you *did*, so it is automatic,
// capped and ordered by recency; this is a record of what you *chose*, so
// nothing here is capped, nothing expires, and nothing reorders itself. A saved
// search goes away when you delete it.
//
// Kept in insertion order rather than sorted by name: this is a list somebody
// curated, and a control whose rows rearrange themselves when you rename one is
// a control you have to re-read every time you use it.

import { parseSearchOptions, parseSearchRepos, type SearchOptions } from "./searchOptions";

/** One named search. `name` is unique within a workspace. */
export type SavedSearch = {
  name: string;
  query: string;
  options: SearchOptions;
  /** The member **repo paths** this search was narrowed to, absent for one that
   *  covers every member. Same identity choice as `SearchRecall.repos`: a
   *  worktree recreated at a new folder is still the member you picked. */
  repos?: string[];
};

/** One workspace's saved searches, in the order they were added. */
export type WorkspaceSaved = readonly SavedSearch[];

/** Every workspace's saved searches, keyed by root. */
export type SavedSearchStore = Readonly<Record<string, WorkspaceSaved>>;

const LS_SAVED_SEARCHES = "sway.savedSearches";

/** This workspace's saved searches, empty for one with none. */
export function savedFor(store: SavedSearchStore, ws: string): WorkspaceSaved {
  return store[ws] ?? [];
}

/** Whether a name is already in use here. Exact match, so `TODOs` and `todos`
 *  are two names: a case-folding rule would have to be explained in a tooltip
 *  to be discoverable, and nobody reads it before typing the second one. */
export function nameTaken(store: SavedSearchStore, ws: string, name: string): boolean {
  const trimmed = name.trim();
  return savedFor(store, ws).some((s) => s.name === trimmed);
}

/**
 * Add a search under `name`, or update the one already there.
 *
 * Updating in place rather than refusing: saving over a name you can see in the
 * list is how you correct one, and the alternative is delete-then-save for what
 * reads as a single act. A blank name is refused, because a row with nothing to
 * click on cannot be deleted either.
 */
export function saveSearch(
  store: SavedSearchStore,
  ws: string,
  name: string,
  query: string,
  options: SearchOptions,
  repos: readonly string[] = [],
): SavedSearchStore {
  const trimmed = name.trim();
  if (!ws || !trimmed || !query) return store;
  const entry: SavedSearch = {
    name: trimmed,
    query,
    options: { ...options },
    ...(repos.length ? { repos: [...repos] } : {}),
  };
  const here = savedFor(store, ws);
  const at = here.findIndex((s) => s.name === trimmed);
  const next = at >= 0 ? here.map((s, i) => (i === at ? entry : s)) : [...here, entry];
  return { ...store, [ws]: next };
}

/**
 * Rename one, keeping its place in the list.
 *
 * Refused (the store comes back unchanged) when the new name is blank or
 * already belongs to another entry: silently merging two saved searches into
 * one would destroy whichever the user was not looking at.
 */
export function renameSearch(
  store: SavedSearchStore,
  ws: string,
  from: string,
  to: string,
): SavedSearchStore {
  const trimmed = to.trim();
  if (!trimmed || trimmed === from) return store;
  const here = savedFor(store, ws);
  if (!here.some((s) => s.name === from) || here.some((s) => s.name === trimmed)) return store;
  return { ...store, [ws]: here.map((s) => (s.name === from ? { ...s, name: trimmed } : s)) };
}

/** Remove one. Drops the workspace's entry entirely once its last search goes,
 *  so an emptied list does not outlive every search in it. */
export function deleteSearch(store: SavedSearchStore, ws: string, name: string): SavedSearchStore {
  const here = savedFor(store, ws);
  const next = here.filter((s) => s.name !== name);
  if (next.length === here.length) return store;
  const out = { ...store };
  if (next.length) out[ws] = next;
  else delete out[ws];
  return out;
}

export function parseSavedStore(raw: string | null): SavedSearchStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, WorkspaceSaved> = {};
    for (const [ws, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      const kept: SavedSearch[] = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        const e = entry as { name?: unknown; query?: unknown; options?: unknown; repos?: unknown };
        if (typeof e?.name !== "string" || typeof e?.query !== "string") continue;
        const name = e.name.trim();
        // A stored file with a duplicate name would give the panel two rows
        // that delete each other, so the first one wins and the rest go.
        if (!name || !e.query || seen.has(name)) continue;
        seen.add(name);
        const repos = parseSearchRepos(e.repos);
        kept.push({
          name,
          query: e.query,
          options: parseSearchOptions(e.options),
          ...(repos ? { repos } : {}),
        });
      }
      if (kept.length) out[ws] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadSavedSearches(): SavedSearchStore {
  try {
    return parseSavedStore(localStorage.getItem(LS_SAVED_SEARCHES));
  } catch {
    return {};
  }
}

export function saveSavedSearches(store: SavedSearchStore): void {
  try {
    localStorage.setItem(LS_SAVED_SEARCHES, JSON.stringify(store));
  } catch {
    /* quota or private mode: they last as long as the session does */
  }
}
