// Hot exit: the unsaved buffers a quit would otherwise discard.
//
// The sibling of `editorTabPersist.ts`, and shaped by the same instinct: a pure
// core that folds, prunes and parses, with the storage read and write as thin
// wrappers around it. Two things differ, and both follow from what is being
// kept.
//
// **It lives in a file, not in localStorage.** A tab entry is a path; a stash
// entry is a whole document plus its undo history. The webview's storage is a
// shared few megabytes, and a quit that silently failed to stash because the
// tab store had already filled the quota would lose exactly the work this
// exists to keep. `hot_exit_load` / `hot_exit_save` (src-tauri/src/hot_exit.rs)
// hold it on disk; the backend never looks inside an entry.
//
// **No CodeMirror here, on purpose.** `state` is opaque: an `EditorState`
// serialized by the editor, which sits behind the lazy chunk boundary. Keeping
// this module free of it is what lets `Editor.tsx` read the stash on the eager
// side, which it must do to put a dirty dot on a tab whose buffer has not been
// built yet.

import { invoke } from "@tauri-apps/api/core";
import {
  emitWith,
  onWith,
  EDITOR_STASH_DIRTY,
  EDITOR_STASH_RESULT,
  type EditorStashDirty,
  type EditorStashResult,
} from "./events";

/** One unsaved buffer, keyed in the store by its absolute path. */
export type StashEntry = {
  /**
   * What the file held on disk when this buffer was last in step with it.
   *
   * The whole restore turns on this. Equal to what the file holds now, the
   * buffer comes back exactly as it was left, undo history included. Different,
   * and somebody rewrote the file while the app was shut: the text still comes
   * back, but the history is dropped and the editor's own conflict banner is
   * raised, because a history is a chain of positions into a document that has
   * since moved.
   */
  savedText: string;
  /** `EditorState.toJSON` with the history field. Opaque to everything outside
   *  the editor pane, which is the only place that can read it back. */
  state: unknown;
  /** When the quit that wrote this happened. */
  savedAt: number;
};

export type HotExitStore = Record<string, StashEntry>;

// Mirrors `editorTabPersist`'s bounds rather than Phase 9's much smaller
// in-memory one: these entries are on disk, where a few megabytes costs
// nothing, and the failure a cap causes here is somebody's unsaved work going
// missing. So the limits are set to "this has been abandoned", not to "this is
// getting large".
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 30;

/**
 * Drop entries that are too old or too many, newest kept.
 *
 * Ties on `savedAt` are ordinary rather than exotic: every entry written by one
 * quit carries that quit's timestamp, so a single crowded session produces a
 * whole store of equal stamps. `Object.entries` order (insertion, which is the
 * order the editor listed its buffers in) breaks them, so the result is at
 * least stable across loads of the same file.
 */
export function pruneStash(
  store: HotExitStore,
  now: number,
  maxAgeMs = MAX_AGE_MS,
  maxEntries = MAX_ENTRIES,
): HotExitStore {
  const fresh = Object.entries(store).filter(([, e]) => now - e.savedAt <= maxAgeMs);
  if (fresh.length > maxEntries) {
    // Sort is stable in every engine this runs on, so equal stamps keep their
    // relative order and the tail that gets cut is deterministic.
    fresh.sort((a, b) => b[1].savedAt - a[1].savedAt);
    fresh.length = maxEntries;
  }
  return Object.fromEntries(fresh);
}

/**
 * Read whatever the backend handed over into a store.
 *
 * Tolerant in the same way `parseStore` is: an entry that does not have the
 * shape is skipped rather than thrown on. This runs at launch, and the one
 * thing worse than losing an unsaved buffer is losing it *and* not starting.
 */
export function parseStash(raw: unknown): HotExitStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: HotExitStore = {};
  for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!path) continue;
    const e = v as Partial<StashEntry> | null;
    if (!e || typeof e.savedText !== "string" || typeof e.savedAt !== "number") continue;
    if (!e.state || typeof e.state !== "object") continue;
    out[path] = { savedText: e.savedText, state: e.state, savedAt: e.savedAt };
  }
  return out;
}

// --- storage ---

/** Read and prune the stash the last quit left. Never throws: a backend that
 *  cannot answer means no restore, not a launch failure. */
export async function loadStash(now: number): Promise<HotExitStore> {
  try {
    return pruneStash(parseStash(await invoke("hot_exit_load")), now);
  } catch {
    return {};
  }
}

/**
 * Write the stash, answering whether it actually landed.
 *
 * The boolean is the point. Its caller is a quit deciding whether it may skip
 * the "unsaved edits will be lost" prompt, and a preference being switched on
 * is not evidence that the work reached the disk.
 */
export async function saveStash(store: HotExitStore): Promise<boolean> {
  try {
    await invoke("hot_exit_save", { stash: store });
    return true;
  } catch {
    return false;
  }
}

// --- the pending stash, read once at launch ---

// Entries this run has not handed to a buffer yet. Module-level for the same
// reason `closedBuffers` is: the two halves that need it are on opposite sides
// of the lazy editor boundary, and `Editor.tsx` needs it before `CodeEditor`
// exists at all (to put a dirty dot on a tab whose buffer is not built yet).
let pending: HotExitStore = {};

/** Load the last quit's stash and hold it for this run's restores. */
export async function loadPendingStash(now: number): Promise<HotExitStore> {
  pending = await loadStash(now);
  return pending;
}

/** Paths still waiting to be restored: which tabs wear a dirty dot at launch. */
export function pendingStashPaths(): string[] {
  return Object.keys(pending);
}

/**
 * Take the entry for `path`, if there is one.
 *
 * Taken and not read, so a buffer built twice in one run (closed and reopened)
 * gets the file rather than a second copy of last run's unsaved text, which by
 * then would be older than what the user has been editing.
 */
export function takeStashEntry(path: string): StashEntry | undefined {
  const entry = pending[path];
  delete pending[path];
  return entry;
}

/**
 * What a quit should write: this run's unsaved buffers, plus the entries it
 * never got round to handing back.
 *
 * The second half is not a detail. Restoring is lazy, so quitting with three
 * stashed files and clicking only one leaves the other two with no buffer at
 * all; a quit that wrote only what the editor currently holds would drop them,
 * and the second relaunch would find the work gone. Live buffers win, since a
 * path with a buffer has been restored and edited since.
 *
 * A buffer that was restored and then *saved* is in neither half: `pending`
 * gave it up when the buffer was built, and it is not dirty any more.
 */
export function stashToWrite(live: HotExitStore): HotExitStore {
  return { ...pending, ...live };
}

/**
 * Forget the entry for `path` without restoring it.
 *
 * For a tab closed on the "the edits in this tab will be lost" confirm. A tab
 * restored from the stash wears its dirty dot before any buffer exists, so
 * discarding it never goes near `takeStashEntry`; without this the entry would
 * still be pending at the next quit, `stashToWrite` would carry it over, and
 * the work the user explicitly threw away would be waiting for them on the
 * following launch.
 */
export function dropStashEntry(path: string): void {
  delete pending[path];
}

/** Forget everything held for this run. Exported for tests, which share a
 *  module instance across cases. */
export function clearPendingStash(): void {
  pending = {};
}

// --- the quit handshake ---

// Long enough for a serialize-and-write of a handful of documents, short enough
// that a pane which is not going to answer does not hold the window open. On
// timeout the caller falls back to the confirm dialog, so the cost of being
// wrong here is a prompt, never a silent loss.
const STASH_TIMEOUT_MS = 5000;

/**
 * Ask the editor pane to stash its dirty buffers, and resolve with whether it
 * managed to.
 *
 * A request/result pair rather than a direct call, following `requestSend`: the
 * buffers live inside `CodeEditor`, which `Editor.tsx` holds only through props
 * behind `lazy()`, so there is no object to call a method on. Resolves `false`
 * if nobody answers, which routes the quit back through the prompt.
 */
export function requestStash(): Promise<boolean> {
  const id = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve(ok);
    };
    const off = onWith<EditorStashResult>(EDITOR_STASH_RESULT, (r) => {
      if (r.requestId === id) finish(r.ok);
    });
    const timer = setTimeout(() => finish(false), STASH_TIMEOUT_MS);
    emitWith<EditorStashDirty>(EDITOR_STASH_DIRTY, { requestId: id });
  });
}
