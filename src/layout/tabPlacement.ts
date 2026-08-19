// Which pane holds which tab (plan phase 8). The pane tree says what boxes
// exist; this says what goes in them, as an override over the kind's pin rule,
// so a fresh install stores nothing and every tab is still where phase 5 put it.
//
// Four maps per workspace. `tabs` is a hand-moved tab's pane. `kinds` is where
// a kind's tabs land when no tab entry says, so a file opened after the editor
// moved joins it rather than going back. `order` stamps a pane's visible
// sequence, so a merged-in tab appends after what was there and a strip drag
// still wins over both. `locks` is the user saying a pane takes one kind and
// nothing else (phase 11), which outranks both of the first two.
import { createSignal } from "solid-js";
import { leaves, resolvePinPane, type PaneNode } from "./paneLayout";
import { pinSideOf } from "./pinRules";

type WsPlacement = {
  tabs: Record<string, string>;
  kinds: Record<string, string>;
  /** paneId -> the tab that pane shows. */
  active: Record<string, string>;
  /** paneId -> the only kind that pane takes (plan phase 11). A rule about what
   *  may be *put* in a pane: a tab that was already there when the lock was set
   *  stays, since taking it away would be a move nobody asked for. */
  locks: Record<string, string>;
  order: Record<string, number>;
  seq: number;
};

export type TabRef = { id: string; kind: string };

const LS_PLACEMENT = "sway.tabpanes.v1";

const empty = (): WsPlacement => ({ tabs: {}, kinds: {}, active: {}, locks: {}, order: {}, seq: 0 });

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
    locks: strMap(v.locks),
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

/** The rules a pin resolves under here: the user's side for this kind, and the
 *  panes this workspace has locked. Handed to `resolvePinPane` rather than read
 *  by it, so the layout primitive stays pure. */
export const pinRulesFor = (ws: string, kind: string) => ({
  side: pinSideOf(kind),
  locks: wsOf(ws).locks,
});

/** Which kind a pane takes, or null for one that takes anything. */
export const paneLock = (ws: string, paneId: string): string | null =>
  wsOf(ws).locks[paneId] ?? null;

/** Lock a pane to one kind, or clear it. */
export function setPaneLock(ws: string, paneId: string, kind: string | null) {
  const p = wsOf(ws);
  if ((p.locks[paneId] ?? null) === kind) return;
  const locks = { ...p.locks };
  if (kind) locks[paneId] = kind;
  else delete locks[paneId];
  write(ws, { ...p, locks });
}

/** Where a kind's tabs land when nothing moved them individually. A stored home
 *  is dropped when that pane has since been locked to something else: the lock
 *  is the newer answer, and the rule resolves around it. */
export function homePane(ws: string, kind: string, root: PaneNode): string | null {
  const stored = liveId(root, wsOf(ws).kinds[kind]);
  const lock = stored ? paneLock(ws, stored) : null;
  if (stored && (!lock || lock === kind)) return stored;
  return resolvePinPane(root, kind, pinRulesFor(ws, kind))?.id ?? null;
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
 * The one placement guard. Every path that would put a tab in a pane asks here
 * first, and a non-null answer is the sentence the user is shown.
 *
 * Phase 8 kept file tabs to one pane here, because they shared one CodeMirror
 * view; phase 9 gave each pane its own view over the shared buffer map, so that
 * branch is gone. What is left is a pane that does not exist, and a pane the
 * user has locked to another kind (phase 11).
 */
export function placementRefusal(a: {
  ws: string;
  tab: TabRef;
  targetPaneId: string;
  root: PaneNode;
  tabsInWs: TabRef[];
}): string | null {
  if (!leaves(a.root).some((l) => l.id === a.targetPaneId)) return "That pane is gone.";
  const lock = paneLock(a.ws, a.targetPaneId);
  if (lock && lock !== a.tab.kind) return `That pane only takes ${lock} tabs.`;
  return null;
}

/** Move a tab, or say why not. A kind's home follows only when the last tab of
 *  that kind leaves a pane: the whole group moved, so the next tab of it should
 *  open where the group went, while one tab pulled aside is just that. */
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
  const from = paneOfTab(a.ws, a.tab, a.root);
  const tabs = { ...p.tabs, [a.tab.id]: a.targetPaneId };
  const groupLeft =
    !!from &&
    !a.tabsInWs.some(
      (t) => t.kind === a.tab.kind && t.id !== a.tab.id && paneOfTab(a.ws, t, a.root) === from,
    );
  const kinds = groupLeft ? { ...p.kinds, [a.tab.kind]: a.targetPaneId } : p.kinds;
  write(a.ws, { ...p, tabs, kinds, active: { ...p.active, [a.targetPaneId]: a.tab.id } });
  stampOrder(a.ws, [a.tab.id]);
  return null;
}

/**
 * Freeze every tab where it currently sits.
 *
 * Run when the pin rules change (plan phase 11): a tab nobody moved has no
 * entry of its own and resolves through the rule, so a new rule would pick up
 * the whole strip and carry it across the window. Writing the current answer
 * down first makes the new rule what it says it is, a rule for what opens next.
 */
export function pinCurrentPlacements(ws: string, root: PaneNode, tabsInWs: TabRef[]) {
  const p = wsOf(ws);
  const tabs = { ...p.tabs };
  let changed = false;
  for (const t of tabsInWs) {
    if (tabs[t.id]) continue;
    const pane = paneOfTab(ws, t, root);
    if (!pane) continue;
    tabs[t.id] = pane;
    changed = true;
  }
  if (changed) write(ws, { ...p, tabs });
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
  const locks = { ...p.locks };
  for (const t of moving) tabs[t.id] = a.to;
  for (const [kind, pane] of Object.entries(kinds)) if (pane === a.from) kinds[kind] = a.to;
  // The lock and the remembered active tab belonged to the box, not to what was
  // in it (see `forgetPane`): the pane they merge into keeps its own answers.
  delete active[a.from];
  delete locks[a.from];
  write(a.ws, { ...p, tabs, kinds, active, locks });
  stampOrder(a.ws, moving.map((t) => t.id));
}

/**
 * A closed pane leaves nothing behind either. Pane ids are minted from what the
 * tree is *not* using, so a freed id comes back, and a lock or a remembered
 * active tab left under it would be inherited by a pane the user never set it
 * on. Run wherever a pane closes, merge or no merge.
 */
export function forgetPane(ws: string, paneId: string) {
  const p = wsOf(ws);
  if (!(paneId in p.locks) && !(paneId in p.active)) return;
  const locks = { ...p.locks };
  const active = { ...p.active };
  delete locks[paneId];
  delete active[paneId];
  write(ws, { ...p, locks, active });
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
