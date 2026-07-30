// How a folder's session history is grouped for the History panel: by when each
// session was last active, newest first.
//
// Pure and separate from the panel because the whole of the "every session
// appears exactly once, and no empty bucket renders" claim lives here - the
// panel only renders what this returns. Boundaries are *local midnights*, not
// rolling 24-hour windows: a session from 11pm last night reads as "Yesterday"
// at 1am, which is what someone scanning the list means by it.

/** Sessions sharing one era, in the order they should render. */
export type SessionBucket<T> = { label: string; sessions: T[] };

const DAY = 86_400;

/** Local midnight of the day `epochSecs` falls in, as epoch seconds. */
function startOfDay(epochSecs: number): number {
  const d = new Date(epochSecs * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Group by `last_active`, newest bucket first and newest session first inside
 * each. Empty buckets are dropped, so a folder with one session renders one
 * heading rather than five.
 *
 * A session stamped in the future (a clock that moved) lands in Today rather
 * than in no bucket at all: the point of the grouping is that nothing falls out
 * of the list.
 */
export function bucketByLastActive<T extends { last_active: number }>(
  list: readonly T[],
  now: number,
): SessionBucket<T>[] {
  const today = startOfDay(now);
  const eras: { label: string; from: number }[] = [
    { label: "Today", from: today },
    { label: "Yesterday", from: today - DAY },
    { label: "Previous 7 days", from: today - 7 * DAY },
    { label: "Previous 30 days", from: today - 30 * DAY },
    { label: "Older", from: -Infinity },
  ];
  const out = eras.map((e) => ({ label: e.label, sessions: [] as T[] }));
  for (const s of [...list].sort((a, b) => b.last_active - a.last_active)) {
    const i = eras.findIndex((e) => s.last_active >= e.from);
    out[i < 0 ? out.length - 1 : i].sessions.push(s);
  }
  return out.filter((b) => b.sessions.length > 0);
}
