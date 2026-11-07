// The hand-made order of one project's branch list. Ranks are kept per unit
// key, never per stack or attempt group: those form and dissolve with forge
// and session state, and a rank on them would be lost each time they did.

import { capList } from "./capList";

export const unitKey = (u: { branch: string | null; folderPath: string }) => u.branch ?? u.folderPath;

export type Section<E> = {
  id: string;
  shown: E[];
  hidden: E[];
};

export type ArrangeOptions<E> = {
  keysOf: (e: E) => readonly string[];
  order: readonly string[];
  base?: string | null;
  cap?: { size: number; keep: (e: E) => boolean; open: boolean };
  /** `of` answers null for an entry that stays in `main`, where groups follow
   *  the unlaned entries. `order` lists the lanes top to bottom. */
  lanes?: { of: (e: E) => string | null; order: readonly string[]; isGroup: (e: E) => boolean };
};

export function arrange<E>(entries: readonly E[], opts: ArrangeOptions<E>): Section<E>[] {
  const at = new Map(opts.order.map((k, i) => [k, i]));
  const rank = (e: E) => {
    const keys = opts.keysOf(e);
    if (opts.base != null && keys.includes(opts.base)) return -2;
    const ranks = keys.map((k) => at.get(k)).filter((r): r is number => r !== undefined);
    return ranks.length ? Math.min(...ranks) : -1;
  };
  const sorted = entries
    .map((e, i) => ({ e, i, r: rank(e) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.e);
  const lanes = opts.lanes;
  const lane = (e: E) => (lanes && !lanes.isGroup(e) ? lanes.of(e) : null);
  const main = lanes
    ? [...sorted.filter((e) => !lanes.isGroup(e) && lane(e) === null), ...sorted.filter(lanes.isGroup)]
    : sorted;
  const cap = opts.cap;
  const cut = cap && !cap.open ? capList(main, cap.size, cap.keep) : { shown: main, hidden: [] };
  const laned = (lanes?.order ?? []).flatMap((id) => {
    const shown = sorted.filter((e) => lane(e) === id);
    return shown.length ? [{ id: `lane:${id}`, shown, hidden: [] }] : [];
  });
  return [{ id: "main", ...cut }, ...laned];
}

export function arrive(
  order: readonly string[],
  last: Readonly<Record<string, string>>,
  now: Readonly<Record<string, string>>,
): string[] {
  const moved = (k: string) => last[k] !== undefined && now[k] !== undefined && last[k] !== now[k];
  const arrived = order.filter(moved);
  if (arrived.length === 0) return [...order];
  let out = order.filter((k) => !moved(k));
  for (const lane of new Set(arrived.map((k) => now[k]))) {
    const lead = out.findIndex((k) => now[k] === lane);
    const at = lead < 0 ? 0 : lead;
    out = [...out.slice(0, at), ...arrived.filter((k) => now[k] === lane), ...out.slice(at)];
  }
  return out;
}

export function orderedKeys(keys: readonly string[], order: readonly string[], base?: string | null): string[] {
  return arrange(keys, { keysOf: (k) => [k], order, base })[0].shown;
}

export function moveKeys(
  order: readonly string[],
  moving: readonly string[],
  target: readonly string[],
  side: "before" | "after",
): string[] {
  const rest = order.filter((k) => !moving.includes(k));
  const spots = target.map((k) => rest.indexOf(k)).filter((i) => i >= 0);
  if (spots.length === 0) return [...order];
  const at = side === "before" ? Math.min(...spots) : Math.max(...spots) + 1;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}
