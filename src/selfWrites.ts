// Echo suppression for Sway's own file writes. When the editor saves a file the
// Phase-1 watcher fires `fs://changed` for that same path ~250ms later (its
// debounce). Without this, the fs://changed consumers (the Phase-4 gutter
// refresh, the Phase-5 reload/follow-mode) would treat the save as an external
// edit. `markSelfWrite` records a path on save; consumers call `isSelfWrite` to
// skip the matching echo. It is a TTL peek (not one-shot) so multiple consumers
// can each check it; the window is short so a genuine external edit shortly
// after a save is not masked for long.

const recent = new Map<string, number>();
const TTL_MS = 1200;

export function markSelfWrite(path: string) {
  recent.set(path, Date.now());
}

/** True if `path` was written by Sway within the TTL (non-consuming peek). */
export function isSelfWrite(path: string): boolean {
  const at = recent.get(path);
  if (at === undefined) return false;
  if (Date.now() - at > TTL_MS) {
    recent.delete(path);
    return false;
  }
  return true;
}
