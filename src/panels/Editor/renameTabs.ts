// Repointing every editor tab at a path that just moved, across all workspaces.
//
// The sibling of `purgeTabs`, and pure for the same two reasons. A rename must
// not close tabs (the file still exists, and it may be dirty), so the only
// correct answer is to rewrite the paths in place; and expressing that as one
// map-in, map-out function removes the alternative of several signal setters in
// a row where each has to read what the last one wrote.

import { isUnderPath } from "../../utils/pathScope";
import { isSyntheticId } from "../../utils/syntheticTabs";

export type PathTab = { path: string };

export type TabMaps<T extends PathTab> = {
  /** Open tabs per workspace, in strip order. */
  tabs: Record<string, T[]>;
  /** The focused tab's path per workspace, or null. */
  active: Record<string, string | null>;
};

/** The new path for `path` when `from` becomes `to`, or null when `path` is not
 *  the renamed node and does not live under it. */
export function repoint(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return isUnderPath(path, from) ? to + path.slice(from.length) : null;
}

/**
 * Rewrite every tab addressing `from`, or anything under it, to the matching
 * path under `to`. Renaming a folder moves each open file inside it, so the
 * prefix case is the common one, not an edge.
 *
 * Tabs are never closed and never reordered: a rename is not a removal, and a
 * dirty buffer whose file was renamed must keep its unsaved text. The active tab
 * per workspace follows the same rewrite, so the focused file stays focused
 * rather than the strip silently jumping elsewhere.
 *
 * Synthetic tabs (`tori://…`) are left alone. Their ids are not filesystem
 * paths, so prefix-rewriting one would produce an id addressing nothing.
 *
 * `moved` lists the (from, to) pairs so the caller can carry path-keyed state
 * (dirty flags, preview choices, stashed work) across with them.
 */
export function renameTabsUnder<T extends PathTab>(
  maps: TabMaps<T>,
  from: string,
  to: string,
): TabMaps<T> & { moved: { from: string; to: string }[] } {
  const moved: { from: string; to: string }[] = [];
  const tabs: Record<string, T[]> = {};
  for (const [ws, list] of Object.entries(maps.tabs)) {
    tabs[ws] = list.map((t) => {
      if (isSyntheticId(t.path)) return t;
      const next = repoint(t.path, from, to);
      if (next === null) return t;
      moved.push({ from: t.path, to: next });
      return { ...t, path: next };
    });
  }
  if (!moved.length) return { tabs: maps.tabs, active: maps.active, moved };

  const active: Record<string, string | null> = {};
  for (const [ws, current] of Object.entries(maps.active)) {
    active[ws] = current && !isSyntheticId(current) ? (repoint(current, from, to) ?? current) : current;
  }
  return { tabs, active, moved };
}

/**
 * Repoint one workspace's clean tabs under `from` to `to`, for a root that moved
 * while the old folder stays. A dirty tab keeps its path. Other workspaces are
 * untouched: the old folder is still somebody's unit, and its tabs are theirs.
 */
export function retargetCleanTabs<T extends PathTab>(
  maps: TabMaps<T>,
  ws: string,
  from: string,
  to: string,
  dirty: (path: string) => boolean,
): TabMaps<T> {
  const list = maps.tabs[ws];
  if (!list) return maps;
  const next = (p: string) => (isSyntheticId(p) || dirty(p) ? null : repoint(p, from, to));
  const current = maps.active[ws] ?? null;
  return {
    tabs: { ...maps.tabs, [ws]: list.map((t) => ({ ...t, path: next(t.path) ?? t.path })) },
    active: { ...maps.active, [ws]: current && (next(current) ?? current) },
  };
}
