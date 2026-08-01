// Per-workspace editor-tab descriptors, so a relaunch brings back the files you
// had open in each branch-unit.
//
// The sibling of `tabPersist.ts` (terminal tabs), and deliberately a separate
// module rather than a generalisation of it: a terminal tab restores by
// *respawning* (kind, program, args, a fresh id every time), while an editor tab
// is just a path. That difference is the whole shape, so sharing a type would
// mean a union that neither side fully populates.
//
// Two consequences follow from a path being stable across a relaunch:
//
//   - The active tab is stored as its **path**, not as an index into the order.
//     An index would silently point at the wrong file once the prune below drops
//     a deleted path from ahead of it.
//   - Restore never needs to read a file. Only the active tab's buffer is
//     constructed, by the editor's normal swap; the rest are tab descriptors
//     until you click them.

const LS_TABS = "sway.editor.tabs.v1";
// A workspace nobody has opened in this long is almost certainly finished work.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Editor tabs accumulate from every file-tree click, unlike terminal tabs which
// are bounded by how many terminals a person deliberately spawns. Without a cap
// a long week in one workspace restores a tab strip nobody wants.
const MAX_TABS = 30;

export type WorkspaceFiles = {
  paths: string[];
  /** Path of the tab that was focused, or null for none. */
  active: string | null;
  savedAt: number;
};

export type FileTabStore = Record<string, WorkspaceFiles>;

/** The shape this module needs from Editor.tsx's per-workspace tab state. */
export type OpenFileTabLike = { path: string; workspace: string };

// Fold the whole open set into a per-workspace store. Called on every open-set,
// order, or active-tab change, so the stored order always matches what is on
// screen (recording only at open time would freeze the order as it was then).
//
// A tab with no workspace is dropped rather than stored: it belongs to the
// window before a selection has resolved, and a key nothing can ever be
// selected as is a key nothing can ever restore from.
export function toStore(
  open: readonly OpenFileTabLike[],
  activeByWorkspace: Readonly<Record<string, string | null>>,
  now: number,
): FileTabStore {
  const out: FileTabStore = {};
  for (const t of open) {
    if (!t.workspace) continue;
    const ws = (out[t.workspace] ??= { paths: [], active: null, savedAt: now });
    ws.paths.push(t.path);
    if (activeByWorkspace[t.workspace] === t.path) ws.active = t.path;
  }
  for (const ws of Object.values(out)) capInPlace(ws);
  return out;
}

// Keep only the newest `max` paths. New tabs append, so the tail is the newest
// and the head is what goes.
function capInPlace(ws: WorkspaceFiles, max = MAX_TABS): void {
  if (ws.paths.length <= max) return;
  const kept = ws.paths.slice(-max);
  // The active tab is where a restore lands, so it survives the cap even when it
  // sits outside the newest `max`; the oldest kept path makes room for it.
  if (ws.active && !kept.includes(ws.active)) kept[0] = ws.active;
  ws.paths = kept;
}

/** Cap one workspace's stored paths. Exported for the store's own tests. */
export function capTabs(ws: WorkspaceFiles, max = MAX_TABS): WorkspaceFiles {
  const out = { ...ws, paths: [...ws.paths] };
  capInPlace(out, max);
  return out;
}

// Fold this run's live tabs into what is already stored.
//
// A plain replace would be wrong: `toStore` only knows the workspaces with tabs
// open right now, so at startup (nothing open yet) it yields `{}` and would
// erase every workspace's stored tabs. Workspaces this run has not touched are
// therefore carried through untouched. A workspace IS erased once this run has
// opened tabs in it and then closed them all, so current truth wins over what
// was stored.
export function mergeStore(
  prev: FileTabStore,
  live: FileTabStore,
  touched: ReadonlySet<string>,
): FileTabStore {
  const out: FileTabStore = {};
  for (const [ws, v] of Object.entries(prev)) {
    if (!touched.has(ws)) out[ws] = v;
  }
  return { ...out, ...live };
}

/** Drop workspaces whose last save is older than the age cutoff. */
export function pruneStale(store: FileTabStore, now: number, maxAgeMs = MAX_AGE_MS): FileTabStore {
  const out: FileTabStore = {};
  for (const [ws, v] of Object.entries(store)) {
    if (now - v.savedAt <= maxAgeMs) out[ws] = v;
  }
  return out;
}

/**
 * What a workspace's stored entry restores to, given which of its paths still
 * exist on disk. Pure, and reads nothing: the caller resolves existence once and
 * hands the surviving set in, so a restore of thirty tabs is thirty descriptors
 * and no file reads.
 *
 * A stored active path that did not survive falls back to the last surviving
 * tab rather than to nothing, so a restore always lands somewhere.
 */
export function restoreFor(
  entry: WorkspaceFiles | undefined,
  alive: ReadonlySet<string>,
): { paths: string[]; active: string | null } {
  if (!entry) return { paths: [], active: null };
  const paths = entry.paths.filter((p) => alive.has(p));
  if (!paths.length) return { paths: [], active: null };
  const active = entry.active && paths.includes(entry.active) ? entry.active : paths[paths.length - 1];
  return { paths, active };
}

// Tolerant of anything already in storage: a shape that does not parse is
// treated as "nothing stored" rather than throwing on startup.
export function parseStore(raw: string | null): FileTabStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: FileTabStore = {};
    for (const [ws, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!ws) continue;
      const e = v as Partial<WorkspaceFiles> | null;
      if (!e || !Array.isArray(e.paths) || typeof e.savedAt !== "number") continue;
      const paths = e.paths.filter((p): p is string => typeof p === "string" && p.length > 0);
      if (!paths.length) continue;
      const active = typeof e.active === "string" && paths.includes(e.active) ? e.active : null;
      out[ws] = { paths, active, savedAt: e.savedAt };
    }
    return out;
  } catch {
    return {};
  }
}

export function loadTabs(now: number): FileTabStore {
  try {
    return pruneStale(parseStore(localStorage.getItem(LS_TABS)), now);
  } catch {
    return {};
  }
}

export function saveTabs(store: FileTabStore): void {
  try {
    localStorage.setItem(LS_TABS, JSON.stringify(store));
  } catch {
    /* quota or private mode: restore degrades to not happening */
  }
}
