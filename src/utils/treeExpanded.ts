// Which directories the file tree has open, per workspace.
//
// The tree never persisted this: every row owned a local `open` signal, so
// reopening a workspace collapsed everything it had. Lifting the state out of
// the row is also what lets a Feature's sections restore independently, since
// entries are absolute paths: which member a directory belongs to falls out of
// its prefix, so the workspace key alone is enough and no compound key is
// needed.
//
// Two lists, because the two defaults differ. A directory starts shut, so the
// open ones are what gets recorded; a section header starts open, so only the
// closed ones do. Both are swept by path like `breakpoints.ts`, for the same
// reason: an entry naming a trashed folder can never be removed by hand, since
// there is no row left to click.

import { createSignal } from "solid-js";

/** One workspace's tree state: the directories left open, and the section
 *  headers explicitly closed. */
export type WorkspaceExpanded = { dirs: readonly string[]; closed: readonly string[] };

/** Every workspace's, keyed the same way the tab strip is (`wsKey`). */
export type ExpandedStore = Readonly<Record<string, WorkspaceExpanded>>;

const LS_TREE_EXPANDED = "tori.treeExpanded.v1";

/** A tree that does not persist gets one of these instead of a workspace key,
 *  so the shared and docs panes still expand for the session while the save
 *  skips them, and neither can have its rows closed by the files pane's
 *  collapse-all. */
const SESSION_PREFIX = "session:";
let sessions = 0;
export const nextSessionKey = (): string => `${SESSION_PREFIX}${++sessions}`;
const persists = (ws: string) => !ws.startsWith(SESSION_PREFIX);

const EMPTY: WorkspaceExpanded = { dirs: [], closed: [] };

const entryOf = (store: ExpandedStore, ws: string): WorkspaceExpanded => store[ws] ?? EMPTY;

/** Store with `ws` replaced, dropping a workspace left holding nothing rather
 *  than keeping an empty record that would outlive every entry in it. */
function withEntry(store: ExpandedStore, ws: string, next: WorkspaceExpanded): ExpandedStore {
  const out: Record<string, WorkspaceExpanded> = { ...store };
  if (next.dirs.length || next.closed.length) out[ws] = next;
  else delete out[ws];
  return out;
}

/**
 * Rewrite or drop entries by path, for a folder that moved or is gone.
 *
 * Applied across every workspace, not only the visible one: a folder renamed on
 * disk is renamed for all of them. Returns the same store when nothing changed,
 * so a caller holding this in a signal does not re-run its readers on a no-op.
 */
export function mapExpandedPaths(
  store: ExpandedStore,
  map: (path: string) => string | null,
): ExpandedStore {
  let changed = false;
  const out: Record<string, WorkspaceExpanded> = {};
  for (const [ws, entry] of Object.entries(store)) {
    const dirs = mapPaths(entry.dirs, map);
    const closed = mapPaths(entry.closed, map);
    changed ||= !same(dirs, entry.dirs) || !same(closed, entry.closed);
    if (dirs.length || closed.length) out[ws] = { dirs, closed };
  }
  return changed ? out : store;
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((p, i) => p === b[i]);

function mapPaths(paths: readonly string[], map: (path: string) => string | null): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const to = map(path);
    if (to !== null && !out.includes(to)) out.push(to);
  }
  return out;
}

// Tolerant of anything already in storage: a shape that does not parse reads as
// "nothing open" rather than throwing on startup.
export function parseExpandedStore(raw: string | null): ExpandedStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, WorkspaceExpanded> = {};
    for (const [ws, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as { dirs?: unknown; closed?: unknown };
      const entry = { dirs: onlyStrings(v.dirs), closed: onlyStrings(v.closed) };
      if (entry.dirs.length || entry.closed.length) out[ws] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

const onlyStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s) : [];

export function loadExpanded(): ExpandedStore {
  try {
    return parseExpandedStore(localStorage.getItem(LS_TREE_EXPANDED));
  } catch {
    return {};
  }
}

/** Session buckets never reach disk: they belong to one mount of one pane. */
export function saveExpanded(store: ExpandedStore): void {
  try {
    const out: Record<string, WorkspaceExpanded> = {};
    for (const [ws, entry] of Object.entries(store)) if (persists(ws)) out[ws] = entry;
    localStorage.setItem(LS_TREE_EXPANDED, JSON.stringify(out));
  } catch {
    /* quota or private mode: the tree stays expanded as long as the session does */
  }
}

// --- the live store ---------------------------------------------------------
//
// Module-level, so the purge and rename sweeps in `Editor.tsx` can reach it
// without the tree being mounted, and so a whole store read at startup is what
// gets written back: a save built from what is on screen right now would erase
// every workspace this run has not visited.

const [store, setStore] = createSignal<ExpandedStore>(loadExpanded());

function write(next: ExpandedStore, persist = true): void {
  if (next === store()) return;
  setStore(next);
  if (persist) saveExpanded(next);
}

export function isDirOpen(ws: string, path: string): boolean {
  return entryOf(store(), ws).dirs.includes(path);
}

export function setDirOpen(ws: string, path: string, open: boolean): void {
  const entry = entryOf(store(), ws);
  if (entry.dirs.includes(path) === open) return;
  const dirs = open ? [...entry.dirs, path] : entry.dirs.filter((d) => d !== path);
  write(withEntry(store(), ws, { ...entry, dirs }), persists(ws));
}

/** Collapse-all: every directory closes, the section headers stay as they are.
 *  Closing them too would hide the members themselves, which is a different
 *  request from closing the folders inside them. */
export function collapseDirs(ws: string, under?: string): void {
  const entry = entryOf(store(), ws);
  const dirs = under ? entry.dirs.filter((d) => !d.startsWith(`${under}/`)) : [];
  if (dirs.length === entry.dirs.length) return;
  write(withEntry(store(), ws, { ...entry, dirs }), persists(ws));
}

/** Sections start open, so a member that has never been closed is open, and one
 *  that joins a Feature later arrives open rather than hidden. */
export function isSectionOpen(ws: string, root: string): boolean {
  return !entryOf(store(), ws).closed.includes(root);
}

export function setSectionOpen(ws: string, root: string, open: boolean): void {
  const entry = entryOf(store(), ws);
  if (entry.closed.includes(root) === !open) return;
  const closed = open ? entry.closed.filter((r) => r !== root) : [...entry.closed, root];
  write(withEntry(store(), ws, { ...entry, closed }), persists(ws));
}

/** The workspace is gone (a Feature was deleted): drop everything filed under
 *  it, so a relaunch cannot revive it. */
export function dropWorkspaceExpanded(ws: string): void {
  if (!(ws in store())) return;
  const { [ws]: _gone, ...rest } = store();
  write(rest);
}

export function mapExpandedFiles(map: (path: string) => string | null): void {
  write(mapExpandedPaths(store(), map));
}

/** Re-read from storage, so one suite's mounts cannot see another's and a test
 *  can seed the store and then relaunch into it. The app never calls it. */
export function resetExpanded(): void {
  setStore(loadExpanded());
}
