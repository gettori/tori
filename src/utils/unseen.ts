// Per-session "last viewed" stamps behind the sidebar's unseen-changes dot.
//
// A row badges when its `last_active` is newer than the last time you looked at
// it. There is no global scan to hang a baseline off (`list_sessions` is
// folder-scoped, see component_session_scanner), so the rule is
// stamp-on-first-sight: a session seen in any scan without a stamp gets one
// immediately, and its pre-stamp activity never badges. Pruning is likewise
// scoped to the folder actually scanned, so scanning workspace A must never
// drop workspace B's stamps.
//
// Stamps live in localStorage (a frontend concern, like the layout/selection
// state in App.tsx), not app data.

import { isUnderPath } from "./pathScope";

const LS_LAST_VIEWED = "sway.lastViewed";

// `cwd` is carried alongside the timestamp purely so pruning can tell whether a
// stamp falls inside the folder a scan actually covered.
export type Stamp = { at: number; cwd: string };
export type Stamps = Record<string, Stamp>;

// The slice of SessionMeta the unseen rules need. `agent` is optional for the
// same reason it is on SessionMeta: older scans predate the field.
export type SeenSession = { id: string; agent?: string; cwd: string; last_active: number };

// Sessions are keyed per agent: ids are only unique within an adapter. Missing
// agent falls back to "claude", the app-wide default for a session without one.
export const stampKey = (agent: string | undefined, id: string) => `${agent ?? "claude"}:${id}`;

// Fold one folder scan into the stamp map: stamp anything seen for the first
// time, then drop stamps for sessions that vanished from the scanned folder.
export function reconcileScan(
  stamps: Stamps,
  folder: string,
  seen: readonly SeenSession[],
  now: number,
): Stamps {
  const next: Stamps = { ...stamps };
  const live = new Set<string>();
  for (const s of seen) {
    const k = stampKey(s.agent, s.id);
    live.add(k);
    const prev = next[k];
    // First sight stamps at least as fresh as the session's own activity, so a
    // session that has been busy for days does not badge the moment Sway meets it.
    if (!prev) next[k] = { at: Math.max(now, s.last_active), cwd: s.cwd };
    else if (prev.cwd !== s.cwd) next[k] = { at: prev.at, cwd: s.cwd };
  }
  for (const [k, v] of Object.entries(next)) {
    // Absence from this scan is only evidence of deletion inside the folder the
    // scan covered; every other workspace's stamps are untouched.
    if (!live.has(k) && isUnderPath(v.cwd, folder)) delete next[k];
  }
  return next;
}

/** Whether two stamp maps say the same thing. A fold that changed nothing still
 *  returns a fresh object, so identity cannot answer this, and the caller needs
 *  the answer to skip a whole-map re-serialize rather than pay one per scan. */
export function sameStamps(a: Stamps, b: Stamps): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => b[k] !== undefined && a[k].at === b[k].at && a[k].cwd === b[k].cwd);
}

// Stamp a session as looked-at. Called both when it becomes the selection and
// when it stops being one, so activity that landed while it was open is covered.
export function markViewed(stamps: Stamps, s: { id: string; agent?: string; cwd: string }, now: number): Stamps {
  return { ...stamps, [stampKey(s.agent, s.id)]: { at: now, cwd: s.cwd } };
}

// A row is unseen when it is not the current selection and its activity is
// newer than its stamp. No stamp means never-seen-before, which by the
// stamp-on-first-sight rule is not a badge (the next scan stamps it).
export function isUnseen(stamps: Stamps, s: SeenSession, selectedId: string | null | undefined): boolean {
  if (s.id === selectedId) return false;
  const st = stamps[stampKey(s.agent, s.id)];
  return !!st && s.last_active > st.at;
}

export function loadStamps(): Stamps {
  try {
    const raw = localStorage.getItem(LS_LAST_VIEWED);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Stamps = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<Stamp> | null;
      if (e && typeof e.at === "number" && typeof e.cwd === "string") out[k] = { at: e.at, cwd: e.cwd };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveStamps(stamps: Stamps): void {
  try {
    localStorage.setItem(LS_LAST_VIEWED, JSON.stringify(stamps));
  } catch {
    /* quota or private mode: badges degrade to never-badging, not a crash */
  }
}
