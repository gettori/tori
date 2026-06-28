// Echo suppression for Sway's own file writes. When the editor saves a file the
// Phase-1 watcher will fire `fs://changed` for that same path; without this, the
// Phase-5 reload/follow-mode consumers would treat the save as an external edit
// and reload/banner the buffer the user just saved. `markSelfWrite` records a
// path on save; the consumers call `consumeSelfWrite` and skip the matching
// event. A short TTL covers the watcher's 250ms debounce, after which a genuine
// later external edit is no longer mistaken for the save echo.

const recent = new Map<string, number>();
const TTL_MS = 1500;

export function markSelfWrite(path: string) {
  recent.set(path, Date.now());
}

/** True if `path` was written by Sway within the TTL (one-shot: consumes it). */
export function consumeSelfWrite(path: string): boolean {
  const at = recent.get(path);
  if (at === undefined) return false;
  recent.delete(path);
  return Date.now() - at <= TTL_MS;
}
