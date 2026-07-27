// Per-workspace terminal-tab descriptors, so a relaunch can offer to bring the
// tab strip back.
//
// Only enough to *respawn* is stored, never buffer contents: restore is respawn
// + resume (shells fresh in their cwd, sessions via the normal resume path), and
// scrollback lives in the transcript viewer. Storage is keyed by workspace
// (branch-unit folder), matching how the tab strip already groups tabs, so the
// restore offer can be made per workspace on first visit.
//
// Tab ids are NOT persisted: a restored tab gets a fresh PTY and therefore a
// fresh id, so the active tab is recorded as an index into the stored order.

const LS_TABS = "sway.terminalTabs";
// A workspace nobody has opened in this long is almost certainly finished work;
// its stored tabs are dropped rather than offered forever.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Command tabs (clone/bootstrap) are deliberately excluded: they are one-shot
// progress views, and re-running a clone on relaunch would be destructive.
export type PersistedKind = "shell" | "agent" | "chat";

export type PersistedTab = {
  title: string;
  cwd: string;
  kind: PersistedKind;
  program: string;
  args: string[];
  // Agent tabs that were resumed from a known session; absent for a fresh agent
  // tab whose transcript had not appeared yet, and for plain shells.
  //
  // A chat tab always carries one: unlike an agent tab it mints its own session
  // id up front (the transport is spawned with `--session-id`), so there is no
  // window where a live chat has no id to restore against.
  sessionId?: string;
};

export type WorkspaceTabs = {
  tabs: PersistedTab[];
  // Index into `tabs` of the tab that was focused, or -1 for none.
  active: number;
  savedAt: number;
};

export type TabStore = Record<string, WorkspaceTabs>;

// The shape this module needs from Terminal.tsx's OpenTerm.
export type OpenTabLike = {
  id: string;
  title: string;
  cwd: string;
  workspace: string;
  kind: string;
  program: string;
  args: string[];
  sessionId?: string;
};

const isPersistable = (kind: string): kind is PersistedKind =>
  kind === "shell" || kind === "agent" || kind === "chat";

// Fold the whole open set into a per-workspace store. Called on every open-set,
// order, or active-tab change, so the stored order always matches what is on
// screen (recording only at open time would freeze the order as it was then).
export function toStore(
  open: readonly OpenTabLike[],
  activeByWorkspace: Readonly<Record<string, string>>,
  now: number,
): TabStore {
  const out: TabStore = {};
  for (const t of open) {
    if (!isPersistable(t.kind)) continue;
    const ws = (out[t.workspace] ??= { tabs: [], active: -1, savedAt: now });
    if (activeByWorkspace[t.workspace] === t.id) ws.active = ws.tabs.length;
    ws.tabs.push({
      title: t.title,
      cwd: t.cwd,
      kind: t.kind,
      program: t.program,
      args: t.args,
      ...(t.sessionId ? { sessionId: t.sessionId } : {}),
    });
  }
  return out;
}

// Fold this run's live tabs into what is already stored.
//
// A plain replace would be wrong: `toStore` only knows the workspaces with tabs
// open right now, so at startup (nothing open yet) it yields `{}` and would
// erase every workspace's stored tabs. Workspaces this run has not touched are
// therefore carried through untouched. A workspace IS erased once this run has
// opened tabs in it and then closed them all, which is what lets current truth
// overwrite a declined restore offer.
export function mergeStore(prev: TabStore, live: TabStore, touched: ReadonlySet<string>): TabStore {
  const out: TabStore = {};
  for (const [ws, v] of Object.entries(prev)) {
    if (!touched.has(ws)) out[ws] = v;
  }
  return { ...out, ...live };
}

// Drop workspaces whose last save is older than the age cutoff.
export function pruneStale(store: TabStore, now: number, maxAgeMs = MAX_AGE_MS): TabStore {
  const out: TabStore = {};
  for (const [ws, v] of Object.entries(store)) {
    if (now - v.savedAt <= maxAgeMs) out[ws] = v;
  }
  return out;
}

// Tolerant of anything already in storage: a shape that does not parse is
// treated as "nothing stored" rather than throwing on startup.
export function parseStore(raw: string | null): TabStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: TabStore = {};
    for (const [ws, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<WorkspaceTabs> | null;
      if (!e || !Array.isArray(e.tabs) || typeof e.savedAt !== "number") continue;
      const tabs = e.tabs.filter(
        (t): t is PersistedTab =>
          !!t &&
          typeof t.title === "string" &&
          typeof t.cwd === "string" &&
          isPersistable(t.kind) &&
          Array.isArray(t.args) &&
          // A chat tab restores by resuming its session id, so one stored
          // without an id has nothing to come back to: drop it here rather than
          // producing a tab that can never spawn.
          (t.kind !== "chat" || typeof t.sessionId === "string"),
      );
      if (tabs.length) out[ws] = { tabs, active: typeof e.active === "number" ? e.active : -1, savedAt: e.savedAt };
    }
    return out;
  } catch {
    return {};
  }
}

export function loadTabs(now: number): TabStore {
  try {
    return pruneStale(parseStore(localStorage.getItem(LS_TABS)), now);
  } catch {
    return {};
  }
}

export function saveTabs(store: TabStore): void {
  try {
    localStorage.setItem(LS_TABS, JSON.stringify(store));
  } catch {
    /* quota or private mode: restore degrades to not being offered */
  }
}
