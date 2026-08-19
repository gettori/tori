// Every session transcript Sway knows about, keyed by the branch-unit folder it
// is anchored on.
//
// This was a signal inside LeftSidebar, filled only by expanding a row, which
// made three things that have nothing to do with the tree - transcript tail
// states, turn checkpoints, and resolving a bare session id from a tray or
// notification click - silently depend on the sidebar being open at the right
// node. It is a module-level store for the same reason `chatSessions.ts` is:
// what reads it is not the sidebar and should not have to mount one.
//
// **The map accumulates and is never pruned.** A tab outlives the space it was
// opened in, so dropping a folder when the active space changes would starve
// the needs-you pipeline for an agent still running in the space you navigated
// away from.
//
// **Listing never asks for the historical verdict.** `folder_historical`
// auto-adopts and writes adopted.json, so folding it into the fetch would mean
// a folder the user never opened loses its ghost protection before they ever
// see it. `checkHistorical` is the deliberate call, made only where the
// Historical section is about to render.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/sessions.rs's `SessionMeta`. Compared field by field by
// `the_typescript_mirror_lists_every_serialized_field` on the Rust side, which
// reads this very block: a TypeScript type is erased at runtime, so the Rust
// test is the only thing that can fail when the two drift.
export type SessionMeta = {
  id: string;
  path: string;
  cwd: string;
  branch: string;
  title: string;
  last_active: number;
  created_at: number;
  name: string | null;
  agent?: string;
  // Which account produced the session, derived from the transcript root that
  // held it. null for a row Sway cannot attribute (an ACP session, whose
  // locator records no account) rather than one it guesses at.
  profile?: string | null;
  // The user's label for that account, and only when there is a second account
  // to tell it apart from. null everywhere on a machine that never added one,
  // which is what makes those rows render exactly as they did before.
  profile_label?: string | null;
};

/** One folder's listing, exactly as `list_sessions` returned it. */
export type FolderScan = { folder: string; list: SessionMeta[] };

/** `sessions://changed`. `folders` names the folders whose transcripts moved;
 *  `null` means the backend could not attribute the change (a brand-new
 *  transcript it has not indexed yet, or a burst too wide to name), so every
 *  covered folder refreshes. */
export type SessionsChanged = { folders: string[] | null };

const [sessions, setSessions] = createSignal<Record<string, SessionMeta[]>>({});
export { sessions };

// Per-folder "historical" flag: sessions predating a recreated folder, hidden
// under a collapsed "Historical" section until adopted. That section lives in
// the terminal pane's History dropdown, which is also the only caller of
// `checkHistorical` - see its note below on why that matters.
const [historical, setHistorical] = createSignal<Record<string, boolean>>({});
export { historical };

// Observers of "these folders just rescanned". They get the lists themselves,
// not just the fact that the map changed, because that granularity is what the
// detached-tier probe needs: exactly the sessions this scan turned up, and no
// re-probe of the ones it did not.
const observers = new Set<(scans: readonly FolderScan[]) => void>();

/** Watch folder scans. Returns its own unsubscribe, for `onCleanup`. */
export function onFolderScan(fn: (scans: readonly FolderScan[]) => void): () => void {
  observers.add(fn);
  return () => {
    observers.delete(fn);
  };
}

function announce(scans: readonly FolderScan[]) {
  if (scans.length === 0) return;
  for (const fn of [...observers]) fn(scans);
}

// null distinguishes a failed scan from an empty folder. A failure must keep
// the folder's stale list: read as "these sessions are gone" it would prune
// stamps that are still current and blank a row that is still there.
async function scan(folder: string): Promise<SessionMeta[] | null> {
  return invoke<SessionMeta[]>("list_sessions", { folder }).catch(() => null);
}

/** List one folder now. The single-folder entry point, for a surface that has
 *  just revealed a folder and cannot wait for the next refresh. */
export async function fetchSessions(folder: string) {
  const list = await scan(folder);
  setSessions((m) => ({ ...m, [folder]: list ?? m[folder] ?? [] }));
  if (list) announce([{ folder, list }]);
}

// Folders with a first listing in flight. The caller is a reactive effect, so
// two firings in quick succession (the config arriving, then a tab opening)
// would otherwise both see the same folder as missing and list it twice.
const inFlight = new Set<string>();

/** Cover `folders`, listing only the ones the store has never seen. Folders it
 *  already holds are left to `refreshSessions`, which rescans the lot. */
export async function trackFolders(folders: readonly string[]) {
  const have = sessions();
  const missing = [...new Set(folders)].filter(
    (f) => f && !(f in have) && !inFlight.has(f),
  );
  if (missing.length === 0) return;
  for (const f of missing) inFlight.add(f);
  try {
    await fill(missing, true);
  } finally {
    for (const f of missing) inFlight.delete(f);
  }
}

/** Rescan the folders the store already covers.
 *
 *  `only` narrows it to the folders an event named. Anything the store does not
 *  cover is dropped rather than listed: a folder nobody is showing has no row
 *  to refresh, and `trackFolders` is what brings a new one in. Omit it (the
 *  event could not say which folders moved) and every covered folder rescans,
 *  which is what this always did. */
export async function refreshSessions(only?: readonly string[]) {
  const covered = Object.keys(sessions());
  const folders = only ? covered.filter((f) => only.includes(f)) : covered;
  if (folders.length === 0) return;
  await fill(folders, false);
}

// Scan a batch in parallel and commit it as one write. Parallel rather than
// serial because the store now covers every branch-unit in the space rather
// than only the expanded ones, so a serial pass would grow with the tree; the
// backing scanner is head-only and mtime-cached, so a repeat pass is cheap.
// One write, and one `announce`, so an observer pays for the batch once rather
// than once per folder (the detached sweep would otherwise re-probe per scan).
async function fill(folders: readonly string[], seedEmpty: boolean) {
  const next: Record<string, SessionMeta[]> = {};
  const scans: FolderScan[] = [];
  await Promise.all(
    folders.map(async (folder) => {
      const list = await scan(folder);
      if (list) {
        next[folder] = list;
        scans.push({ folder, list });
      } else if (seedEmpty) {
        // A folder asked about for the first time gets an entry even when the
        // scan failed, so `refreshSessions` retries it on the next event.
        next[folder] = [];
      }
    }),
  );
  setSessions((m) => ({ ...m, ...next }));
  announce(scans);
}

/** Ask whether `folder` is a recreated folder whose sessions predate it, and
 *  remember the answer. **This writes to disk** - the verdict auto-adopts when
 *  the sessions clearly belong to the folder - so call it only where the
 *  Historical section is about to be shown. */
export async function checkHistorical(folder: string) {
  try {
    const hist = await invoke<boolean>("folder_historical", { folder });
    setHistorical((m) => ({ ...m, [folder]: hist }));
  } catch {
    /* leave the folder unflagged; it renders as an ordinary listing */
  }
}

/** Record an adoption the caller has already persisted, without re-asking. */
export function markAdopted(folder: string) {
  setHistorical((m) => ({ ...m, [folder]: false }));
}

/** Where a bare session id lives. The tray's per-session entries and a
 *  needs-you notification both carry an id and nothing else. */
export function findSession(id: string): { folder: string; session: SessionMeta } | null {
  for (const [folder, list] of Object.entries(sessions())) {
    const session = list.find((s) => s.id === id);
    if (session) return { folder, session };
  }
  return null;
}

/** Drop everything. Test support, named so it cannot be mistaken for part of
 *  the store's real API: module-level state outlives a component, unlike the
 *  signal this replaced, so without it a test that renders twice inherits the
 *  first render's listings. */
export function resetSessionStoreForTests() {
  setSessions({});
  setHistorical({});
  inFlight.clear();
}
