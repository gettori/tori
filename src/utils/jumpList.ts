// Where you have been in the editor, so Back and Forward mean something.
//
// The model is the browser's, not vim's: entries are positions that were
// arrived at, `index` names the one you are standing on, and recording a new
// position throws away the forward leg. That truncation rule is the whole of
// the interesting part, which is why it lives here as a pure module rather than
// inside Editor.tsx - the same reason `purgeTabs.ts`, `softWrapTabs.ts` and
// `closedBuffers.ts` are their own files. A rule tests without a mounted pane.
//
// Per workspace (branch-unit folder), matching how the tab strip is already
// bucketed: a path open in one worktree names nothing in another, so one shared
// list would offer to send you back to a file that is not there.

/**
 * A place worth coming back to.
 *
 * `line` is absent for "wherever that file opens", which is what a tree click
 * or a cross-file go-to-definition actually means: the tab may already be open
 * five hundred lines down, and pinning the entry to line 1 would make going
 * back to it worse than doing nothing.
 */
export type JumpEntry = { path: string; line?: number };

/** `index` is where the list's cursor sits; -1 when nothing is recorded. */
export type JumpList = { entries: readonly JumpEntry[]; index: number };

/** Every workspace's list, keyed by branch-unit folder. */
export type JumpStore = Readonly<Record<string, JumpList>>;

export const EMPTY_JUMPS: JumpList = { entries: [], index: -1 };

/** How many places one workspace remembers. Entries are two small strings, so
 *  this is bounded for tidiness rather than for memory: a list longer than this
 *  is one nobody walks back through. */
export const MAX_JUMPS = 50;

/**
 * How far the caret must move in a single step to count as a jump rather than
 * drift.
 *
 * Arrowing down through a function moves one line per keystroke and must record
 * nothing, or the list fills with positions no one chose. A go-to-definition, a
 * search hit, or a click into a folded block crosses this in one transaction.
 */
export const JUMP_LINE_THRESHOLD = 10;

/** Whether a caret move from `from` to `to` was a jump, not drift. */
export function isSignificantMove(from: number, to: number, threshold = JUMP_LINE_THRESHOLD): boolean {
  return Math.abs(to - from) >= threshold;
}

/** The entry the list is standing on, or null when nothing is recorded. */
export function current(list: JumpList): JumpEntry | null {
  return list.entries[list.index] ?? null;
}

export function canGoBack(list: JumpList): boolean {
  return list.index > 0;
}

export function canGoForward(list: JumpList): boolean {
  return list.index >= 0 && list.index < list.entries.length - 1;
}

/**
 * Record arriving somewhere.
 *
 * Two entries can describe one destination, and that has to be collapsed rather
 * than stacked: opening a file records the file with no line, and the caret
 * landing inside it a moment later records a line in that same file. Left as
 * two entries, the first Back press would look like it did nothing. So a
 * position in the file the list is already standing on *refines* that entry in
 * place; only a different file, or a different line in the same file once one is
 * known, appends.
 *
 * Appending truncates the forward leg, which is what makes Back-then-jump
 * behave like every browser: the branch you did not take is gone.
 *
 * Returns the same list when nothing changed, so a caller holding this in a
 * signal does not re-run its effects on a no-op.
 */
export function record(list: JumpList, entry: JumpEntry, cap = MAX_JUMPS): JumpList {
  const at = current(list);
  if (at && at.path === entry.path && (at.line === undefined || at.line === entry.line)) {
    if (at.line === entry.line) return list;
    const entries = list.entries.slice();
    entries[list.index] = entry;
    return { entries, index: list.index };
  }
  const kept = list.entries.slice(0, list.index + 1);
  kept.push(entry);
  // Trimmed from the front, so the index follows the entries it names.
  const over = Math.max(0, kept.length - cap);
  const entries = over ? kept.slice(over) : kept;
  return { entries, index: entries.length - 1 };
}

/** Step the list's cursor. Returns the same list at either end, which is what
 *  the disabled arrows are reading through `canGoBack`/`canGoForward`. */
export function step(list: JumpList, dir: -1 | 1): JumpList {
  if (dir === -1 ? !canGoBack(list) : !canGoForward(list)) return list;
  return { entries: list.entries, index: list.index + dir };
}

/**
 * Rewrite or drop every entry by path, for a file that moved or is gone.
 *
 * Entries are keyed by absolute path, exactly like the tab strip and the dirty
 * flags, so they have to follow the tree's edits for the same reason those do:
 * a rename that left the list behind would send Back to a path that no longer
 * exists, and a trash would leave the file reachable through an arrow after it
 * had been thrown away.
 *
 * `map` returns a new path, the same path, or `null` to drop the entry. What
 * "under a folder" means is the caller's to decide (`repoint` for a rename,
 * `isUnderPath` for a purge), so there is still one definition of it rather
 * than a second copy here.
 *
 * Dropping entries moves the cursor: it lands on the newest survivor *before*
 * where it was standing, so Back keeps walking backwards and Forward keeps
 * walking toward the newest. Returns the same list when nothing matched.
 */
export function mapPaths(list: JumpList, map: (path: string) => string | null): JumpList {
  const entries: JumpEntry[] = [];
  let changed = false;
  let index = -1;
  // Survivors recorded before the one the cursor was on, which is where the
  // cursor goes if that one is dropped.
  let before = 0;
  for (let i = 0; i < list.entries.length; i++) {
    const entry = list.entries[i];
    const next = map(entry.path);
    if (next === null) {
      changed = true;
      continue;
    }
    if (next !== entry.path) changed = true;
    if (i === list.index) index = entries.length;
    else if (i < list.index) before++;
    entries.push(next === entry.path ? entry : { ...entry, path: next });
  }
  if (!changed) return list;
  if (index === -1) index = entries.length ? Math.max(0, before - 1) : -1;
  return { entries, index };
}

/** This workspace's list; an untouched workspace reads as empty rather than
 *  undefined, so no call site has to spell that out. */
export function listFor(store: JumpStore, ws: string): JumpList {
  return store[ws] ?? EMPTY_JUMPS;
}

/** `record`, scoped to one workspace. Same store back when nothing changed. */
export function recordIn(store: JumpStore, ws: string, entry: JumpEntry, cap = MAX_JUMPS): JumpStore {
  const before = listFor(store, ws);
  const after = record(before, entry, cap);
  return after === before ? store : { ...store, [ws]: after };
}

/** `step`, scoped to one workspace. Same store back at either end. */
export function stepIn(store: JumpStore, ws: string, dir: -1 | 1): JumpStore {
  const before = listFor(store, ws);
  const after = step(before, dir);
  return after === before ? store : { ...store, [ws]: after };
}

/** `mapPaths` across *every* workspace, not only the visible one: a folder
 *  renamed or trashed on disk is renamed or trashed for all of them, and the
 *  lists off screen are exactly the ones nobody would notice going stale. */
export function mapPathsIn(store: JumpStore, map: (path: string) => string | null): JumpStore {
  let out: Record<string, JumpList> | null = null;
  for (const [ws, list] of Object.entries(store)) {
    const next = mapPaths(list, map);
    if (next === list) continue;
    out ??= { ...store };
    out[ws] = next;
  }
  return out ?? store;
}
