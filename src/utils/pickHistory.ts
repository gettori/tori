// Keyed by the whole query, so "side" and "sid" learn apart.

const LS_PICKS = "tori.navPicks";
export const MAX_QUERIES = 200;
export const PER_QUERY = 5;

// Pairs, not an object: an all-digit query would be an integer key, and those
// sort ahead of the rest.
export type PickStore = readonly (readonly [string, readonly string[]])[];

const normal = (query: string) => query.trim().toLowerCase().replace(/\s+/g, " ");

export function picksFor(store: PickStore, query: string): readonly string[] {
  const q = normal(query);
  return store.find(([k]) => k === q)?.[1] ?? [];
}

export function withPick(store: PickStore, query: string, id: string): PickStore {
  const q = normal(query);
  if (!q) return store;
  const ids = [id, ...picksFor(store, q).filter((p) => p !== id)].slice(0, PER_QUERY);
  return [[q, ids] as const, ...store.filter(([k]) => k !== q)].slice(0, MAX_QUERIES);
}

export function parsePicks(raw: string | null): PickStore {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is [string, string[]] =>
          Array.isArray(e) &&
          typeof e[0] === "string" &&
          Array.isArray(e[1]) &&
          e[1].every((id: unknown) => typeof id === "string"),
      )
      .slice(0, MAX_QUERIES);
  } catch {
    return [];
  }
}

export function loadPicks(): PickStore {
  try {
    return parsePicks(localStorage.getItem(LS_PICKS));
  } catch {
    return [];
  }
}

export function savePicks(store: PickStore) {
  try {
    localStorage.setItem(LS_PICKS, JSON.stringify(store));
  } catch {
    // Quota or private mode: ties fall back to visits and input order.
  }
}
