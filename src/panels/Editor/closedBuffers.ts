// What a closed tab leaves behind, so reopening it is a return rather than a
// fresh read.
//
// Closing a tab used to drop its `EditorState` outright, taking the undo
// history, the cursor and the fold state with it. Reopening then built a new
// state from disk, so an edit made a minute earlier could not be undone: the
// only record of it had been the history that was thrown away.
//
// A sibling of `purgeTabs.ts` and `softWrapTabs.ts`, for the same reason. The
// interesting part is a rule (which buffers are worth keeping, how many, and
// when one may be handed back), and a rule tests without a mounted pane.
//
// **What is kept is data, not a live state, and that distinction is load
// bearing.** The store outlives the editor pane, which Editor.tsx unmounts the
// moment the last tab anywhere closes. A live `EditorState` carries the
// configuration it was built with, and that configuration is full of the old
// component instance: the update listener that reports the dirty flag closes
// over that instance's buffer map and props, and the blame and preferences
// compartments are objects the next instance has never heard of. Handing one
// back after a remount produces a buffer that looks perfect and answers to
// nothing. So a closed buffer is serialized (`EditorState.toJSON` with the
// history field) and rebuilt into whatever the *current* instance configures.
//
// **Bounded, because the entries are not small.** Each holds the whole document
// plus its undo history, so an unbounded store would grow with every file the
// session ever touched. `editorTabPersist` caps at 30, but those are path
// descriptors; these are documents, and eight is about as many tabs as anyone
// reopens by hand.

/** How many closed buffers to keep. Least recently closed goes first. */
export const MAX_CLOSED_BUFFERS = 8;

/** The half of a stored entry this module makes decisions about: the text the
 *  file had when it was last read or written. */
export type Recallable = { savedText: string };

/**
 * Keep this buffer against a later reopen, evicting the stalest if that puts
 * the store over its cap.
 *
 * Recency is the `Map`'s own insertion order, which is why an existing entry is
 * deleted before being set again: re-closing a tab has to move it to the young
 * end, or a file that keeps being reopened would be evicted as though it had
 * been sitting untouched since the first time.
 */
export function rememberClosed<T>(
  store: Map<string, T>,
  path: string,
  buf: T,
  cap = MAX_CLOSED_BUFFERS,
): void {
  store.delete(path);
  store.set(path, buf);
  // A loop rather than one delete: the cap is a parameter, so it can move down
  // under a store that is already fuller than the new value.
  while (store.size > cap) {
    const stalest = store.keys().next().value;
    if (stalest === undefined) break;
    store.delete(stalest);
  }
}

/**
 * Take back the buffer kept for `path`, if it still describes the file.
 *
 * `diskText` is what the file holds *now*, read as the buffer would hold it
 * (see `fromDisk` in lineEndings.ts, not the raw bytes). An entry whose saved
 * text no longer matches is refused: its undo history is a chain of positions
 * into a document that has since moved, and replaying it against the new
 * content would corrupt rather than restore. The caller builds a fresh buffer
 * in that case, which is the same thing closing and reopening always did.
 *
 * The entry is dropped either way. A refused one will never be accepted (the
 * file only moves further away), so leaving it in the store would cost memory
 * to hold an answer already known to be no.
 */
export function reviveClosed<T extends Recallable>(
  store: Map<string, T>,
  path: string,
  diskText: string,
): T | undefined {
  const buf = store.get(path);
  store.delete(path);
  return buf && buf.savedText === diskText ? buf : undefined;
}
