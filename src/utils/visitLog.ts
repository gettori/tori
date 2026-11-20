// Keys only: each open resolves them against the live index, so a place that
// has since gone is not drawn, and the log never has to hear that it went.

const LS_VISITS = "tori.visits";
export const MAX_VISITS = 30;

export function withVisit(log: readonly string[], key: string, cap = MAX_VISITS): string[] {
  return [key, ...log.filter((k) => k !== key)].slice(0, cap);
}

export function recentPlaces<P extends { id: string }>(
  log: readonly string[],
  places: readonly P[],
  current: string | null,
): P[] {
  const byId = new Map(places.map((p) => [p.id, p]));
  return log.flatMap((key) => (key === current ? [] : (byId.get(key) ?? [])));
}

export function loadVisits(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LS_VISITS) ?? "[]");
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string").slice(0, MAX_VISITS) : [];
  } catch {
    return [];
  }
}

export function noteVisit(key: string) {
  const log = loadVisits();
  if (log[0] === key) return;
  try {
    localStorage.setItem(LS_VISITS, JSON.stringify(withVisit(log, key)));
  } catch {
    // Quota or private mode: Cmd+K opens on its other groups.
  }
}
