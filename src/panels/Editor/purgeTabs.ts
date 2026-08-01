// Closing every editor tab rooted under a folder that is going away, across all
// workspaces at once.
//
// Pure, and its own module, for two reasons. It is destructive (a space delete
// closes tabs with no dirty prompt, because the folder is going regardless), so
// it wants tests that do not need a mounted editor. And expressing it as one
// map-in, map-out function removes the alternative: two signal setters in a row
// where the second has to read what the first just wrote, which holds today only
// because Solid applies setters synchronously.

import { isUnderPath } from "../../utils/pathScope";

export type PathTab = { path: string };

export type TabMaps<T extends PathTab> = {
  /** Open tabs per workspace, in strip order. */
  tabs: Record<string, T[]>;
  /** The focused tab's path per workspace, or null. */
  active: Record<string, string | null>;
};

/**
 * Drop every tab under `root` from every workspace, not only the visible one: a
 * deleted space can hold tabs in several branch-units, and the ones off screen
 * would otherwise survive as tabs addressing a folder that no longer exists.
 *
 * A workspace whose active tab was removed falls back to its last surviving tab,
 * or to null when nothing survives. `removed` lists the dropped paths so the
 * caller can clear the state it keys by path (dirty flags, preview choices).
 */
export function purgeTabsUnder<T extends PathTab>(
  maps: TabMaps<T>,
  root: string,
): TabMaps<T> & { removed: string[] } {
  const removed: string[] = [];
  const tabs: Record<string, T[]> = {};
  for (const [ws, list] of Object.entries(maps.tabs)) {
    tabs[ws] = list.filter((t) => {
      const gone = isUnderPath(t.path, root);
      if (gone) removed.push(t.path);
      return !gone;
    });
  }
  if (!removed.length) return { tabs: maps.tabs, active: maps.active, removed };

  const gone = new Set(removed);
  const active: Record<string, string | null> = {};
  for (const [ws, current] of Object.entries(maps.active)) {
    if (current && gone.has(current)) {
      const survivors = tabs[ws] ?? [];
      active[ws] = survivors.length ? survivors[survivors.length - 1].path : null;
    } else {
      active[ws] = current;
    }
  }
  return { tabs, active, removed };
}
