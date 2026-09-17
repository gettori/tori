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
import { tabScopePath } from "../../utils/syntheticTabs";
import { searchBufferRoots } from "./searchResultsStore";

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
 *
 * A synthetic tab (`tori://…`) is matched on the workspace its id carries, not
 * on the id itself, so a deleted space takes its commit-log tabs with it rather
 * than leaving views onto a folder that is gone.
 *
 * `rootsOf` is the one exception, and the reason it is injected: a results
 * buffer's id carries a workspace *key*, which inside a Topic is not a folder
 * at all, so only the document knows which repos its rows write into. It stays
 * a parameter so this module is still testable without the buffer store.
 */
export function purgeTabsUnder<T extends PathTab>(
  maps: TabMaps<T>,
  root: string,
  rootsOf: (id: string) => string[] | null = searchBufferRoots,
): TabMaps<T> & { removed: string[] } {
  const removed: string[] = [];
  const tabs: Record<string, T[]> = {};
  for (const [ws, list] of Object.entries(maps.tabs)) {
    tabs[ws] = list.filter((t) => {
      const gone = scopes(t.path, rootsOf).some((p) => isUnderPath(p, root));
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

/**
 * The folders a tab is scoped to. One for nearly everything; a results buffer
 * answers with every member it spans, and any of them under the purge takes it.
 *
 * Dropped rather than trimmed: the line map is fixed at build time and the
 * buffer forbids a line-count change, so a partly invalidated document cannot
 * be repaired into an honest one.
 */
function scopes(id: string, rootsOf: (id: string) => string[] | null): string[] {
  const roots = rootsOf(id);
  return roots?.length ? roots : [tabScopePath(id)];
}
