// Lines you marked to come back to.
//
// The third thing in this wave keyed by absolute path and bucketed per
// workspace, after the jump list and the frecency store, and for the same
// reason: a path open in one worktree names nothing in another. Where those two
// are records of what you *did*, this is a record of what you *chose*, which is
// the whole difference in how it behaves: nothing here expires, nothing is
// capped, and nothing is scored. A bookmark goes away when you remove it or when
// the file does.
//
// Pure and here rather than in the gutter, because two surfaces read it (the
// gutter and the panel) and a third writes it (the pane, following a rename),
// and none of them should own the shape. Persistence sits beside the rule for
// `frecency.ts`'s reason: the storage shape and what reads it are one thing to
// keep honest.

/** One marked line. `label` is absent rather than empty for an unlabelled one,
 *  so the panel can tell "no label" from "a label someone cleared". */
export type Bookmark = { line: number; label?: string };

/** One file's marks, ascending by line. Kept sorted here rather than at each
 *  read, so the panel and the gutter cannot disagree about the order. */
export type FileBookmarks = readonly Bookmark[];

/** One workspace's files, keyed by absolute path. */
export type WorkspaceBookmarks = Readonly<Record<string, FileBookmarks>>;

/** Every workspace's marks, keyed by branch-unit folder. */
export type BookmarkStore = Readonly<Record<string, WorkspaceBookmarks>>;

const LS_BOOKMARKS = "sway.bookmarks";

const byLine = (a: Bookmark, b: Bookmark) => a.line - b.line;

/** This file's marks, empty for a file nobody has marked. */
export function bookmarksFor(store: BookmarkStore, ws: string, path: string): FileBookmarks {
  return store[ws]?.[path] ?? [];
}

/** Whether this line is marked, which is what the gutter's toggle reads. */
export function isBookmarked(store: BookmarkStore, ws: string, path: string, line: number): boolean {
  return bookmarksFor(store, ws, path).some((b) => b.line === line);
}

/** Replace one file's marks. Returns the same store when nothing changed, so a
 *  caller holding this in a signal does not re-run its effects on a no-op, and
 *  drops a file (and then a workspace) left with none rather than keeping an
 *  empty record that would outlive every mark in it. */
export function setFileBookmarks(
  store: BookmarkStore,
  ws: string,
  path: string,
  marks: readonly Bookmark[],
): BookmarkStore {
  const next = [...marks].sort(byLine);
  const before = bookmarksFor(store, ws, path);
  if (sameMarks(before, next)) return store;
  const files = { ...(store[ws] ?? {}) };
  if (next.length) files[path] = next;
  else delete files[path];
  const out = { ...store };
  if (Object.keys(files).length) out[ws] = files;
  else delete out[ws];
  return out;
}

function sameMarks(a: FileBookmarks, b: FileBookmarks): boolean {
  return a.length === b.length && a.every((m, i) => m.line === b[i].line && m.label === b[i].label);
}

/** Mark the line, or unmark it if it already is. Removing takes the label with
 *  it: the label described that mark, and a label with no mark is not something
 *  any surface can show. */
export function toggleBookmark(
  store: BookmarkStore,
  ws: string,
  path: string,
  line: number,
): BookmarkStore {
  const marks = bookmarksFor(store, ws, path);
  const next = marks.some((b) => b.line === line)
    ? marks.filter((b) => b.line !== line)
    : [...marks, { line }];
  return setFileBookmarks(store, ws, path, next);
}

/** Name a mark, or take its name away with an empty string. Does nothing for a
 *  line that is not marked, rather than marking it: a label is a property of a
 *  bookmark, not a second way to make one. */
export function labelBookmark(
  store: BookmarkStore,
  ws: string,
  path: string,
  line: number,
  label: string,
): BookmarkStore {
  const marks = bookmarksFor(store, ws, path);
  if (!marks.some((b) => b.line === line)) return store;
  const text = label.trim();
  const next = marks.map((b) => (b.line === line ? (text ? { line, label: text } : { line }) : b));
  return setFileBookmarks(store, ws, path, next);
}

/** One workspace's marks as a flat list for the panel, by path then by line.
 *  Paths sorted so the list has an order that does not move under you when a
 *  mark is added; nothing here knows what the panel does with them. */
export function bookmarkRows(
  store: BookmarkStore,
  ws: string,
): { path: string; line: number; label?: string }[] {
  const files = store[ws] ?? {};
  return Object.keys(files)
    .sort()
    .flatMap((path) => files[path].map((b) => ({ path, ...b })));
}

/**
 * Rewrite or drop marks by path, for a file that moved or is gone.
 *
 * Same contract as the jump list's and the frecency store's sweeps, and needed
 * for the same reason: these are keyed by absolute path, so a rename that left
 * them behind would leave the panel offering a file that is not there, and a
 * trash would leave marks nothing can ever reach or remove.
 *
 * Applied across *every* workspace, not only the visible one: a folder renamed
 * or trashed on disk is renamed or trashed for all of them, and the ones off
 * screen are exactly the marks nobody would notice going stale.
 *
 * A rename onto a path that already has marks merges the two by line, keeping
 * the labelled one: they are the same file now, and dropping either side's marks
 * would silently throw away something a person put there by hand.
 */
export function mapPaths(store: BookmarkStore, map: (path: string) => string | null): BookmarkStore {
  let changed = false;
  const out: Record<string, WorkspaceBookmarks> = {};
  for (const [ws, files] of Object.entries(store)) {
    const next: Record<string, Bookmark[]> = {};
    for (const [path, marks] of Object.entries(files)) {
      const to = map(path);
      if (to === null) {
        changed = true;
        continue;
      }
      if (to !== path) changed = true;
      const at = next[to];
      if (!at) {
        next[to] = [...marks];
        continue;
      }
      for (const mark of marks) {
        const i = at.findIndex((b) => b.line === mark.line);
        // Replaced rather than assigned into: the marks came from the caller's
        // store, and writing a label onto one would edit the very object this
        // function is supposed to be returning a new version of.
        if (i < 0) at.push(mark);
        else if (!at[i].label && mark.label) at[i] = { ...at[i], label: mark.label };
      }
    }
    for (const path of Object.keys(next)) next[path].sort(byLine);
    if (Object.keys(next).length) out[ws] = next;
    else changed = changed || Object.keys(files).length > 0;
  }
  return changed ? out : store;
}

// Tolerant of anything already in storage: a shape that does not parse reads as
// "nothing marked" rather than throwing on startup. A line that is not a
// positive integer is dropped, since it names no line any editor could scroll
// to.
export function parseStore(raw: string | null): BookmarkStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, WorkspaceBookmarks> = {};
    for (const [ws, files] of Object.entries(parsed as Record<string, unknown>)) {
      if (!files || typeof files !== "object") continue;
      const kept: Record<string, Bookmark[]> = {};
      for (const [path, marks] of Object.entries(files as Record<string, unknown>)) {
        if (!Array.isArray(marks)) continue;
        const lines: Bookmark[] = [];
        const seen = new Set<number>();
        for (const m of marks) {
          const mark = m as Partial<Bookmark> | null;
          if (!mark || typeof mark.line !== "number" || !Number.isInteger(mark.line) || mark.line < 1) {
            continue;
          }
          if (seen.has(mark.line)) continue;
          seen.add(mark.line);
          lines.push(typeof mark.label === "string" && mark.label ? { line: mark.line, label: mark.label } : { line: mark.line });
        }
        if (lines.length) kept[path] = lines.sort(byLine);
      }
      if (Object.keys(kept).length) out[ws] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadBookmarks(): BookmarkStore {
  try {
    return parseStore(localStorage.getItem(LS_BOOKMARKS));
  } catch {
    return {};
  }
}

export function saveBookmarks(store: BookmarkStore): void {
  try {
    localStorage.setItem(LS_BOOKMARKS, JSON.stringify(store));
  } catch {
    /* quota or private mode: the marks last as long as the session does */
  }
}
