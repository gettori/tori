// The tabs you closed, newest first, so Cmd+Shift+T can put one back.
//
// Only the *paths* are here. What made reopening worth having is already built:
// `closedBuffers.ts` keeps the document and its undo history and hands it back
// when the tab reopens through the normal path, refusing it when the file has
// moved on underneath. So this is the small half, the "which one" - and it is
// small enough to be a rule, which is why it is a file next to `purgeTabs.ts`
// and `renameTabs.ts` rather than four lines inside the pane.
//
// Per workspace, bucketed like the tab strip, the jump list and the frecency
// store, and for the same reason: a path closed in one worktree names nothing
// in another.

/** Every workspace's closed paths, newest last. */
export type ClosedStore = Readonly<Record<string, readonly string[]>>;

/**
 * How many closes one workspace remembers.
 *
 * Deliberately larger than `closedBuffers`' eight: this holds paths, not
 * documents, so the tail is nearly free, and reopening the ninth-oldest close
 * still works - it just reads the file fresh instead of handing back its undo
 * history.
 */
export const MAX_REOPENABLE = 20;

/**
 * Push a closed tab onto its workspace's stack.
 *
 * Re-closing a file that is already on the stack moves it to the top rather
 * than leaving two entries, or Cmd+Shift+T pressed twice would reopen the same
 * file and then appear to do nothing the second time.
 */
export function rememberClosedTab(
  store: ClosedStore,
  ws: string,
  path: string,
  cap = MAX_REOPENABLE,
): ClosedStore {
  const kept = (store[ws] ?? []).filter((p) => p !== path);
  kept.push(path);
  return { ...store, [ws]: kept.slice(Math.max(0, kept.length - cap)) };
}

/** Take the most recently closed path back off, or null when there is none. */
export function takeClosedTab(store: ClosedStore, ws: string): { path: string | null; store: ClosedStore } {
  const stack = store[ws] ?? [];
  if (!stack.length) return { path: null, store };
  return { path: stack[stack.length - 1], store: { ...store, [ws]: stack.slice(0, -1) } };
}

/** Rewrite or drop paths across every workspace, for a file that moved or is
 *  gone. Same contract and the same reason as the jump list's sweep: reopening
 *  a path that was renamed or trashed would build a tab on nothing. */
export function sweepClosed(store: ClosedStore, map: (path: string) => string | null): ClosedStore {
  let changed = false;
  const out: Record<string, readonly string[]> = {};
  for (const [ws, stack] of Object.entries(store)) {
    const next: string[] = [];
    for (const path of stack) {
      const to = map(path);
      if (to === null) {
        changed = true;
        continue;
      }
      if (to !== path) changed = true;
      // A folder rename can map several closes onto one path; keep the newest.
      const at = next.indexOf(to);
      if (at !== -1) next.splice(at, 1);
      next.push(to);
    }
    out[ws] = next;
  }
  return changed ? out : store;
}
