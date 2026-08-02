// Blame data, and the one rule about when it may be re-read.
//
// **The cache key is the file plus HEAD, and deliberately nothing else.** Blame
// answers "which commit does this line come from", and a commit cannot change
// while HEAD stands still, however much you type. So an edit does not
// invalidate anything: the line *positions* move, and CM6's own change mapping
// moves the markers with them (see `blameGutter.ts`), while a line the user just
// wrote simply has no marker, which is what "uncommitted" renders as.
//
// The alternative, re-blaming as you type, costs a `git blame` subprocess per
// keystroke burst to learn something already known.

import { invoke } from "@tauri-apps/api/core";

/** Mirrors `BlameCommit` in src-tauri/src/blame.rs. */
export type BlameCommit = {
  sha: string;
  short: string;
  author: string;
  /** Author time, seconds since the epoch. */
  time: number;
  summary: string;
};

/** Mirrors `Blame` in src-tauri/src/blame.rs. */
export type Blame = {
  head: string;
  /** One entry per line of the file, in order: an index into `commits`. */
  lines: number[];
  commits: BlameCommit[];
};

/** git's own name for "not committed": an all-zero sha. */
export const UNCOMMITTED = "0".repeat(40);

/** A fresh empty blame. A function rather than a shared constant: it is handed
 *  straight back to callers, and one exported object everybody holds is one
 *  mutation away from being everybody's problem. */
export function emptyBlame(): Blame {
  return { head: "", lines: [], commits: [] };
}

/** How many reads to keep. A tab strip holds a handful of files and HEAD moves
 *  a few times an hour, so this is generous; the bound is here because the key
 *  includes HEAD, and an unbounded map keyed by a moving value is a leak. */
const MAX_ENTRIES = 40;

const cache = new Map<string, Blame>();

export function blameKey(root: string, file: string, head: string): string {
  return `${root}\0${file}\0${head}`;
}

/**
 * This file's blame at this HEAD, from cache when it has been read before.
 *
 * A failure is an empty blame, not a throw: every caller would answer a failure
 * the same way (show no blame), and blame is decoration, never something worth
 * a toast in front of the file you were trying to read.
 */
export async function blameFor(root: string, file: string, head: string): Promise<Blame> {
  const key = blameKey(root, file, head);
  const hit = cache.get(key);
  if (hit) return hit;
  let blame: Blame;
  try {
    blame = await invoke<Blame>("git_blame", { projectPath: root, file });
  } catch {
    // Not cached: a failure here is the backend being unreachable or the folder
    // being gone, and neither is a fact about this file at this HEAD. Caching it
    // would leave the file blameless until someone happened to commit.
    return emptyBlame();
  }
  cache.set(key, blame);
  // Insertion order, so the first key is the least recently *read from disk*.
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return blame;
}

/**
 * Forget this file's blame, at every HEAD it was read for.
 *
 * The (file, HEAD) key says blame cannot go stale while HEAD stands still, and
 * that is true of *committed* lines. Which lines are uncommitted is a fact about
 * the file's contents, so a write to the file, ours or somebody else's, does
 * invalidate the read even though HEAD has not moved. This is the call that says
 * so; it is not on the typing path, because typing does not write the file.
 */
export function dropBlame(root: string, file: string): void {
  const prefix = `${root}\0${file}\0`;
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

/** Drop everything. For tests, and for leaving a project. */
export function clearBlameCache(): void {
  cache.clear();
}

/**
 * May a freshly read blame be laid onto this buffer?
 *
 * Only when the buffer still holds the text that was blamed. `Blame.lines` is
 * indexed by the line numbering of the file **on disk**, so laying it onto a
 * buffer with three unsaved lines inserted at the top puts every marker three
 * lines out. A dirty buffer already carries markers that were mapped through
 * its own edits, and those are right; the rebuild is what would break them.
 *
 * Here rather than in the editor for the reason `revertGuard` and
 * `commitMessage` are: it is a decision, and a decision unit-tests without a
 * mount, a repo, or CodeMirror.
 */
export function canPlaceBlame(docText: string, savedText: string | undefined): boolean {
  // No buffer record at all (a view rebuilt underneath us) is not evidence of
  // drift, and refusing there would mean never showing blame for that file.
  return savedText === undefined || docText === savedText;
}

/** Seconds in a day, the unit every bucket below is expressed in. */
const DAY = 86_400;

/** Bucket edges in days, newest first. Five buckets plus "older than the last
 *  edge" gives six shades, which is as many as a 3px gutter stripe can carry
 *  before two of them stop being tellable apart. */
const AGE_EDGES = [1, 7, 30, 180, 365];

/**
 * How old a line reads as, 0 (today) to 5 (ancient). The gutter shades on this
 * rather than on the raw age so the scale is stable: a heatmap normalised to the
 * *file's* own oldest line would make a file nobody has touched in years look
 * as fresh as one written this morning.
 */
export function ageBucket(time: number, now = Math.floor(Date.now() / 1000)): number {
  const days = Math.max(0, now - time) / DAY;
  const found = AGE_EDGES.findIndex((edge) => days < edge);
  return found === -1 ? AGE_EDGES.length : found;
}
