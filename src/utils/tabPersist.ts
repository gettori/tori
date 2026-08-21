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

import { hasOptionPick, hasPick, type DraftPick } from "./chatDraftPick";
import type { ChatConfigValue } from "./chatTypes";

const LS_TABS = "sway.terminalTabs";
// A workspace nobody has opened in this long is almost certainly finished work;
// its stored tabs are dropped rather than offered forever.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Longer than this and a draft comes back empty rather than truncated. This
// store is one localStorage key for every workspace, so a pasted essay in one
// draft would risk the quota and take every other workspace's tabs down with
// it; and half a message handed back would read as whole.
const MAX_DRAFT_TEXT = 16_000;

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
  // A chat tab carries one unless it is a **draft**: a live chat mints its id up
  // front (the transport is spawned with `--session-id`), and a draft has no
  // session at all until its first send. So an absent id on a chat tab is not a
  // gap, it is the thing to restore it as.
  sessionId?: string;
  // A draft's unsent composer text, and what it was set to run as. Only drafts
  // carry these: a live chat comes back by resuming, which brings its own
  // transcript, and the tab id everything else is keyed by is minted fresh on
  // restore so it cannot carry them.
  text?: string;
  pick?: DraftPick;
  // Chat tabs that were rewound: the checkpoint the worktree was put back to.
  // Kept across a relaunch so the tab still says the agent remembers turns that
  // were undone, which stays true for the life of the session. `forkFrom` is
  // deliberately *not* kept: the fork already happened and its conversation is
  // in this session's own transcript, so a restore resumes rather than forking
  // a second time.
  rewindTo?: number;
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
  rewindTo?: number;
  /** A draft's composer text and pick. Both live in their own stores keyed by
   *  tab id; the caller reads them there, so this module keeps its distance. */
  text?: string;
  pick?: DraftPick;
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
    // Only a draft: everything else comes back by respawning or resuming, and
    // what was typed into a live chat belongs to a session that will replay its
    // own transcript.
    const draft = t.kind === "chat" && !t.sessionId;
    ws.tabs.push({
      title: t.title,
      cwd: t.cwd,
      kind: t.kind,
      program: t.program,
      args: t.args,
      ...(t.sessionId ? { sessionId: t.sessionId } : {}),
      ...(t.rewindTo ? { rewindTo: t.rewindTo } : {}),
      ...(draft && t.text && t.text.length <= MAX_DRAFT_TEXT ? { text: t.text } : {}),
      ...(draft && t.pick && (hasPick(t.pick) || hasOptionPick(t.pick)) ? { pick: t.pick } : {}),
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

/** A stored value that is not a string is not a pick; `null` is, and is what
 *  every unset field of a `DraftPick` holds. */
const pickField = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Stored option values, minus anything no switch could ever send. Shape only:
 *  whether the agent still publishes the id is the draft's check, since the
 *  option set is known there and not here. */
const optionValuesField = (v: unknown): Record<string, ChatConfigValue> => {
  const out: Record<string, ChatConfigValue> = {};
  if (!v || typeof v !== "object") return out;
  for (const [id, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "boolean") out[id] = value;
  }
  return out;
};

/** A draft's two fields, normalised. Both are overwritten rather than merged, so
 *  anything the file got wrong is dropped rather than passed on: the tab still
 *  restores, just without that part. */
function draftFields(t: PersistedTab): Pick<PersistedTab, "text" | "pick"> {
  const p = t.pick as Partial<DraftPick> | undefined;
  return {
    text: typeof t.text === "string" && t.text.length <= MAX_DRAFT_TEXT ? t.text : undefined,
    pick:
      p && typeof p === "object"
        ? {
            model: pickField(p.model),
            mode: pickField(p.mode),
            effort: pickField(p.effort),
            optionValues: optionValuesField(p.optionValues),
          }
        : undefined,
  };
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
      const tabs = e.tabs
        .filter(
          (t): t is PersistedTab =>
            !!t &&
            typeof t.title === "string" &&
            typeof t.cwd === "string" &&
            isPersistable(t.kind) &&
            Array.isArray(t.args),
        )
        // A chat tab with no session id is a draft, which is a thing to come
        // back to now rather than a record with nothing behind it. Its two
        // extras are checked here, since a hand-edited file reaches the
        // composer and the palette through them.
        .map((t) => (t.kind === "chat" && !t.sessionId ? { ...t, ...draftFields(t) } : t));
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
