// Which pane holds which tab (plan phase 8). The pane tree says what boxes
// exist; this says what goes in them, as an override over the kind's pin rule,
// so a fresh install stores nothing and every tab is still where phase 5 put it.
//
// Three maps per workspace. `tabs` is a hand-moved tab's pane. `kinds` is where
// a kind's tabs land when no tab entry says, so a file opened after the editor
// moved joins it rather than going back. `order` stamps a pane's visible
// sequence, so a merged-in tab appends after what was there and a strip drag
// still wins over both.
import { createSignal } from "solid-js";
import { leaves, resolvePinPane, type PaneNode } from "./paneLayout";

type WsPlacement = {
  tabs: Record<string, string>;
  kinds: Record<string, string>;
  /** paneId -> the tab that pane shows. */
  active: Record<string, string>;
  order: Record<string, number>;
  seq: number;
};

export type TabRef = { id: string; kind: string };

const LS_PLACEMENT = "sway.tabpanes.v1";

const empty = (): WsPlacement => ({ tabs: {}, kinds: {}, active: {}, order: {}, seq: 0 });

function sanitize(raw: unknown): WsPlacement | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const strMap = (x: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (x && typeof x === "object") {
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        if (typeof val === "string") out[k] = val;
      }
    }
    return out;
  };
  const numMap = (x: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (x && typeof x === "object") {
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
      }
    }
    return out;
  };
  const order = numMap(v.order);
  const seq = typeof v.seq === "number" && Number.isFinite(v.seq) ? v.seq : 0;
  return {
    tabs: strMap(v.tabs),
    kinds: strMap(v.kinds),
    active: strMap(v.active),
    order,
    seq: Math.max(seq, ...Object.values(order), 0),
  };
}

function load(): Record<string, WsPlacement> {
  const out: Record<string, WsPlacement> = {};
  try {
    const raw = localStorage.getItem(LS_PLACEMENT);
    if (!raw) return out;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return out;
    for (const [ws, rec] of Object.entries(parsed as Record<string, unknown>)) {
      const ok = sanitize(rec);
      if (ok) out[ws] = ok;
    }
  } catch {
    // ignore: an unreadable store just means no overrides
  }
  return out;
}

const [placements, setPlacements] = createSignal<Record<string, WsPlacement>>(load());

function persist() {
  try {
    localStorage.setItem(LS_PLACEMENT, JSON.stringify(placements()));
  } catch {
    // ignore
  }
}

const wsOf = (ws: string): WsPlacement => placements()[ws] ?? empty();

function write(ws: string, next: WsPlacement) {
  setPlacements({ ...placements(), [ws]: next });
  persist();
}

// A pane id is only meaningful inside its own workspace's tree, so every read
// validates against the tree it is asked about and falls back to the pin rule.
const liveId = (root: PaneNode, id: string | undefined): string | null =>
  id && leaves(root).some((l) => l.id === id) ? id : null;

/** Where a kind's tabs land when nothing moved them individually. */
export function homePane(ws: string, kind: string, root: PaneNode): string | null {
  return liveId(root, wsOf(ws).kinds[kind]) ?? resolvePinPane(root, kind)?.id ?? null;
}

export function paneOfTab(ws: string, tab: TabRef, root: PaneNode): string | null {
  return liveId(root, wsOf(ws).tabs[tab.id]) ?? homePane(ws, tab.kind, root);
}

/** A pane's tabs in display order: the stamped sequence first, store order
 *  behind it (an unstamped tab has never been moved, so its store slot is the
 *  only order it has). */
export function orderInPane<T extends TabRef>(ws: string, tabs: T[]): T[] {
  const stamps = wsOf(ws).order;
  return tabs
    .map((t, i) => ({ t, i, s: stamps[t.id] ?? 0 }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.t);
}

/** Restamp `ids` as one pane's sequence, after everything stamped so far. */
export function stampOrder(ws: string, ids: string[]) {
  if (ids.length === 0) return;
  const p = wsOf(ws);
  const order = { ...p.order };
  let seq = p.seq;
  for (const id of ids) order[id] = ++seq;
  write(ws, { ...p, order, seq });
}

/**
 * Which tab a pane shows. `claimed` are the ids their own kind calls active
 * (one per kind), and they win: that is what keeps spawning, restoring and
 * every existing focus path deciding what is on screen, exactly as before panes
 * could split. The pane's own last pick only breaks a tie between two kinds, or
 * speaks for a pane no kind is pointing at.
 */
export function activeIdInPane(
  ws: string,
  paneId: string,
  idsInPane: string[],
  claimed: string[],
): string | null {
  const stored = wsOf(ws).active[paneId];
  const here = claimed.filter((id) => idsInPane.includes(id));
  if (stored && here.includes(stored)) return stored;
  if (here.length > 0) return here[0];
  if (stored && idsInPane.includes(stored)) return stored;
  return idsInPane[0] ?? null;
}

export function setPaneActive(ws: string, paneId: string, tabId: string) {
  const p = wsOf(ws);
  if (p.active[paneId] === tabId) return;
  write(ws, { ...p, active: { ...p.active, [paneId]: tabId } });
}

/**
 * The one placement guard (plan phase 8 task 2). Every path that would put a
 * tab in a pane asks here first, and a non-null answer is the sentence the user
 * is shown. Phase 9 deletes the `file` branch and nothing else changes: file
 * tabs share one CodeMirror stage today, so they cannot be in two panes at once.
 */
export function placementRefusal(a: {
  ws: string;
  tab: TabRef;
  targetPaneId: string;
  root: PaneNode;
  tabsInWs: TabRef[];
}): string | null {
  if (!leaves(a.root).some((l) => l.id === a.targetPaneId)) return "That pane is gone.";
  if (paneOfTab(a.ws, a.tab, a.root) === a.targetPaneId) return null;
  if (a.tab.kind !== "file") return null;
  const stranded = a.tabsInWs.filter(
    (t) => t.kind === "file" && t.id !== a.tab.id && paneOfTab(a.ws, t, a.root) !== a.targetPaneId,
  );
  if (stranded.length === 0) return null;
  return `Files open in one pane for now. Close or move the other ${stranded.length} file tab${
    stranded.length > 1 ? "s" : ""
  } first.`;
}

/** Move a tab, or say why not. A file tab that gets this far is the only one
 *  outside the target (the guard saw to that), so its kind home moves with it
 *  and the next file opens beside it rather than back where files used to be. */
export function moveTabToPane(a: {
  ws: string;
  tab: TabRef;
  targetPaneId: string;
  root: PaneNode;
  tabsInWs: TabRef[];
}): string | null {
  const refusal = placementRefusal(a);
  if (refusal) return refusal;
  const p = wsOf(a.ws);
  const tabs = { ...p.tabs, [a.tab.id]: a.targetPaneId };
  const kinds = a.tab.kind === "file" ? { ...p.kinds, file: a.targetPaneId } : p.kinds;
  write(a.ws, { ...p, tabs, kinds, active: { ...p.active, [a.targetPaneId]: a.tab.id } });
  stampOrder(a.ws, [a.tab.id]);
  return null;
}

/** Close-pane merge (plan phase 8 task 3): every tab in `from` lands in `to`,
 *  appended after what `to` already holds. Runs before the tree edit, while
 *  `from` still exists to resolve against. */
export function mergePaneInto(a: {
  ws: string;
  from: string;
  to: string;
  root: PaneNode;
  tabsInWs: TabRef[];
}) {
  const moving = orderInPane(
    a.ws,
    a.tabsInWs.filter((t) => paneOfTab(a.ws, t, a.root) === a.from),
  );
  const p = wsOf(a.ws);
  const tabs = { ...p.tabs };
  const kinds = { ...p.kinds };
  const active = { ...p.active };
  for (const t of moving) tabs[t.id] = a.to;
  for (const [kind, pane] of Object.entries(kinds)) if (pane === a.from) kinds[kind] = a.to;
  delete active[a.from];
  write(a.ws, { ...p, tabs, kinds, active });
  stampOrder(a.ws, moving.map((t) => t.id));
}

/** A closed tab leaves nothing behind: its entries would otherwise outlive it
 *  and be inherited by a future tab that reused the id (a file path does). */
export function forgetTab(ws: string, tabId: string) {
  const p = wsOf(ws);
  if (!(tabId in p.tabs) && !(tabId in p.order) && !Object.values(p.active).includes(tabId)) return;
  const tabs = { ...p.tabs };
  const order = { ...p.order };
  const active = { ...p.active };
  delete tabs[tabId];
  delete order[tabId];
  for (const [pane, id] of Object.entries(active)) if (id === tabId) delete active[pane];
  write(ws, { ...p, tabs, order, active });
}

// Called from App's setup, beside resetPaneLayoutModel, for its reason: the
// shell mounts once per app run, and repeated test mounts get a fresh model.
export function resetTabPlacement() {
  setPlacements(load());
}
