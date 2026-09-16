// Lines you asked the debugger to stop on.
//
// Keyed by absolute path and bucketed per workspace: a path open in one worktree
// names nothing in another. A breakpoint has a second life outside this file,
// since the adapter has to be told about it and can answer back.
//
// That second life is deliberately *not* here. This module is pure and knows
// nothing about sessions: `debugBreakpoints.ts` owns the wire, the pending and
// bound states, and the signal the pane reads. Keeping the rules here is what
// lets them be tested without a debug run.

/** One file's lines, ascending. Kept sorted here rather than at each read, so
 *  the gutter and the `setBreakpoints` payload cannot disagree about the
 *  order. */
export type FileBreakpoints = readonly number[];

/** One workspace's files, keyed by absolute path. */
export type WorkspaceBreakpoints = Readonly<Record<string, FileBreakpoints>>;

/** Every workspace's breakpoints, keyed by branch-unit folder. */
export type BreakpointStore = Readonly<Record<string, WorkspaceBreakpoints>>;

const LS_BREAKPOINTS = "tori.breakpoints";

const ascending = (a: number, b: number) => a - b;

/** This file's lines, empty for a file with none. */
export function breakpointsFor(store: BreakpointStore, ws: string, path: string): FileBreakpoints {
  return store[ws]?.[path] ?? [];
}

/** Whether this line has a breakpoint, which is what the gutter's toggle
 *  reads. */
export function isBreakpoint(
  store: BreakpointStore,
  ws: string,
  path: string,
  line: number,
): boolean {
  return breakpointsFor(store, ws, path).includes(line);
}

/** Replace one file's lines. Returns the same store when nothing changed, so a
 *  caller holding this in a signal does not re-run its effects (and does not
 *  re-send `setBreakpoints`) on a no-op, and drops a file (and then a
 *  workspace) left with none rather than keeping an empty record that would
 *  outlive every breakpoint in it. */
export function setFileBreakpoints(
  store: BreakpointStore,
  ws: string,
  path: string,
  lines: readonly number[],
): BreakpointStore {
  const next = [...new Set(lines)].sort(ascending);
  const before = breakpointsFor(store, ws, path);
  if (before.length === next.length && before.every((line, i) => line === next[i])) return store;
  const files = { ...(store[ws] ?? {}) };
  if (next.length) files[path] = next;
  else delete files[path];
  const out = { ...store };
  if (Object.keys(files).length) out[ws] = files;
  else delete out[ws];
  return out;
}

/** Set the breakpoint, or clear it if the line already has one. A gutter click
 *  is a toggle rather than an add, because the same target has to be able to
 *  undo itself; there is nowhere else to click to remove one. */
export function toggleBreakpoint(
  store: BreakpointStore,
  ws: string,
  path: string,
  line: number,
): BreakpointStore {
  const lines = breakpointsFor(store, ws, path);
  const next = lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line];
  return setFileBreakpoints(store, ws, path, next);
}

/** One workspace's files and their lines, by path. Paths sorted so the order
 *  does not move under a caller that iterates them, which the session
 *  configuration does once per session. */
export function breakpointFiles(
  store: BreakpointStore,
  ws: string,
): { path: string; lines: FileBreakpoints }[] {
  const files = store[ws] ?? {};
  return Object.keys(files)
    .sort()
    .map((path) => ({ path, lines: files[path] }));
}

/**
 * Rewrite or drop breakpoints by path, for a file that moved or is gone.
 *
 * Needed because a breakpoint on a trashed file has no gutter left to click, so
 * nothing could ever remove it, and it would go out in every future run's
 * `setBreakpoints` for a path that does not exist. A rename that left them behind would arm the old
 * name and show the new one bare.
 *
 * Applied across *every* workspace, not only the visible one: a folder renamed
 * or trashed on disk is renamed or trashed for all of them.
 *
 * A rename onto a path that already has breakpoints merges the two: they are the
 * same file now, and dropping either side would silently throw away something
 * set by hand.
 */
export function mapBreakpointPaths(
  store: BreakpointStore,
  map: (path: string) => string | null,
): BreakpointStore {
  let changed = false;
  const out: Record<string, WorkspaceBreakpoints> = {};
  for (const [ws, files] of Object.entries(store)) {
    const next: Record<string, number[]> = {};
    for (const [path, lines] of Object.entries(files)) {
      const to = map(path);
      if (to === null) {
        changed = true;
        continue;
      }
      if (to !== path) changed = true;
      next[to] = [...new Set([...(next[to] ?? []), ...lines])].sort(ascending);
    }
    if (Object.keys(next).length) out[ws] = next;
    else changed = changed || Object.keys(files).length > 0;
  }
  return changed ? out : store;
}

// Tolerant of anything already in storage: a shape that does not parse reads as
// "nothing set" rather than throwing on startup. A line that is not a positive
// integer is dropped, since it names no line any editor could scroll to and no
// adapter could bind.
export function parseBreakpointStore(raw: string | null): BreakpointStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, WorkspaceBreakpoints> = {};
    for (const [ws, files] of Object.entries(parsed as Record<string, unknown>)) {
      if (!files || typeof files !== "object") continue;
      const kept: Record<string, number[]> = {};
      for (const [path, lines] of Object.entries(files as Record<string, unknown>)) {
        if (!Array.isArray(lines)) continue;
        const seen = new Set<number>();
        for (const line of lines) {
          if (typeof line !== "number" || !Number.isInteger(line) || line < 1) continue;
          seen.add(line);
        }
        if (seen.size) kept[path] = [...seen].sort(ascending);
      }
      if (Object.keys(kept).length) out[ws] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadBreakpoints(): BreakpointStore {
  try {
    return parseBreakpointStore(localStorage.getItem(LS_BREAKPOINTS));
  } catch {
    return {};
  }
}

export function saveBreakpoints(store: BreakpointStore): void {
  try {
    localStorage.setItem(LS_BREAKPOINTS, JSON.stringify(store));
  } catch {
    /* quota or private mode: the breakpoints last as long as the session does */
  }
}
