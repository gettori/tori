// Pure helpers for the overflow tab bar (no DOM access, unit-tested in
// tabOverflow.test.ts). The component measures geometry; these decide the math.

export type Reserves = {
  /** Horizontal padding of the bar (left + right). */
  padding: number;
  /** Width of the pinned trailing action (the New / Follow button). */
  trailing: number;
  /** Width of the `+N` count button (reserved only when overflow exists). */
  count: number;
  /** A few px of slack so a tab can never be rendered partially clipped. */
  safety: number;
};

/**
 * How many leading tabs fully fit. `extents[i]` is the right edge of tab i
 * measured from the bar's content-left (so it already folds in inter-tab gaps,
 * per-tab borders, and left padding). Two-pass: if every tab fits without the
 * count button, show them all; otherwise reserve the count button and recount.
 * Always shows at least one tab when any exist.
 */
export function computeVisibleCount(extents: number[], barWidth: number, r: Reserves): number {
  const n = extents.length;
  if (n === 0) return 0;
  const usable = barWidth - r.padding - r.trailing - r.safety;
  if (extents[n - 1] <= usable) return n; // all fit, no overflow
  const usable2 = usable - r.count; // overflow exists: make room for `+N`
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (extents[i] <= usable2) count = i + 1;
    else break;
  }
  return Math.max(1, count);
}

/**
 * Move the tab identified by `id` to `toIndex`, returning a NEW array whose
 * elements are the SAME object references (a shallow copy + splice). The new
 * array reference lets a signal react; the preserved element identities let a
 * referentially-keyed `<For>` reorder DOM nodes instead of remounting them
 * (which for a terminal tab would kill and respawn its PTY). Returns the input
 * array unchanged (same ref, a no-op for the signal) when the id is missing or
 * already at the target slot.
 */
export function moveIntoView<T>(
  items: T[],
  id: string,
  toIndex: number,
  idOf: (t: T) => string,
): T[] {
  const from = items.findIndex((t) => idOf(t) === id);
  if (from < 0) return items;
  const to = Math.max(0, Math.min(toIndex, items.length - 1));
  if (from === to) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
