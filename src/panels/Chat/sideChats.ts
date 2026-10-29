// The lock itself lives in Rust, keyed by the `sideOf` every spawn carries, so
// nothing here decides what a side chat may do.
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import type { ChatItem, ToolItem, TurnRecord } from "./chatStore";
import { canFork } from "../../utils/agentForks";
import type { SavedSides } from "../../utils/tabPersist";
import { findSession } from "../../utils/sessionStore";
import { clearComposer } from "../../utils/chatCompose";
import { clearDraftPick } from "../../utils/chatDraftPick";
import { dropQueue } from "./queuePersist";

export type SideChat = { tabId: string; sessionId: string; n: number } & (
  | { restored?: false }
  | { restored: true; started: boolean }
);
export type Drawer = { sides: SideChat[]; active: string | null; closed: SideChat[] };

const EMPTY: Drawer = { sides: [], active: null, closed: [] };

const [sideAgents, setSideAgents] = createSignal<readonly string[]>([]);
void Promise.resolve()
  .then(() => invoke<string[]>("chat_side_agents"))
  .then((ids) => setSideAgents(Array.isArray(ids) ? ids : []))
  .catch(() => {});

export function sideChatOffered(readOnly: readonly string[], agentId: string, forks: boolean): boolean {
  return forks && readOnly.includes(agentId);
}

export function canSideChat(agentId: string, profile: string | null): boolean {
  return sideChatOffered(sideAgents(), agentId, canFork(agentId, profile));
}

export function sideLabel(side: SideChat): string {
  return `Side ${side.n}`;
}

export function nextSideNumber(drawer: Drawer): number {
  return Math.max(0, ...drawer.sides.map((s) => s.n), ...drawer.closed.map((s) => s.n)) + 1;
}

export function withSide(drawer: Drawer, side: SideChat): Drawer {
  return { ...drawer, sides: [...drawer.sides, side].sort((a, b) => a.n - b.n), active: side.tabId };
}

export function withoutSide(drawer: Drawer, tabId: string): Drawer {
  const at = drawer.sides.findIndex((s) => s.tabId === tabId);
  if (at === -1) return { ...drawer, closed: drawer.closed.filter((s) => s.tabId !== tabId) };
  const sides = drawer.sides.filter((s) => s.tabId !== tabId);
  if (drawer.active !== tabId) return { ...drawer, sides };
  const next = sides[at] ?? sides[at - 1] ?? null;
  return { ...drawer, sides, active: next?.tabId ?? null };
}

// Closing ends the fork's process but keeps it listed, to resume later.
export function withSideClosed(drawer: Drawer, tabId: string): Drawer {
  const side = drawer.sides.find((s) => s.tabId === tabId);
  if (!side) return drawer;
  const closed: SideChat = { tabId, sessionId: side.sessionId, n: side.n, restored: true, started: false };
  return { ...withoutSide(drawer, tabId), closed: [...drawer.closed, closed].sort((a, b) => a.n - b.n) };
}

// A side closed before its first turn has no transcript to resume, so it comes
// back as a fresh fork under the same number.
export function withSideReopened(drawer: Drawer, tabId: string, resumable: boolean, fresh: () => string): Drawer {
  const side = drawer.closed.find((s) => s.tabId === tabId);
  if (!side) return drawer;
  const back: SideChat = resumable ? side : { tabId, sessionId: fresh(), n: side.n };
  return withSide({ ...drawer, closed: drawer.closed.filter((s) => s.tabId !== tabId) }, back);
}

const [drawers, setDrawers] = createStore<Record<string, Drawer>>({});

export function drawerOf(parentTab: string): Drawer {
  return drawers[parentTab] ?? EMPTY;
}

export function openSide(parentTab: string): SideChat {
  const drawer = drawerOf(parentTab);
  const side = { tabId: `side:${crypto.randomUUID()}`, sessionId: crypto.randomUUID(), n: nextSideNumber(drawer) };
  setDrawers(parentTab, withSide(drawer, side));
  return side;
}

export function closeSide(parentTab: string, tabId: string): void {
  setDrawers(parentTab, withSideClosed(drawerOf(parentTab), tabId));
}

export function reopenSide(parentTab: string, tabId: string): void {
  const side = drawerOf(parentTab).closed.find((s) => s.tabId === tabId);
  const resumable = !!side && !!findSession(side.sessionId);
  setDrawers(
    parentTab,
    withSideReopened(drawerOf(parentTab), tabId, resumable, () => crypto.randomUUID()),
  );
}

// What a side chat leaves behind in the webview once it is gone.
function forget(side: SideChat): void {
  clearComposer(side.tabId);
  void dropQueue(side.sessionId);
  clearDraftPick(side.tabId);
}

export function removeSide(parentTab: string, tabId: string): void {
  const drawer = drawerOf(parentTab);
  const side = [...drawer.sides, ...drawer.closed].find((s) => s.tabId === tabId);
  setDrawers(parentTab, withoutSide(drawer, tabId));
  if (side) forget(side);
}

export function selectSide(parentTab: string, tabId: string): void {
  setDrawers(parentTab, "active", tabId);
}

export function markSideStarted(parentTab: string, tabId: string): void {
  const sides = drawerOf(parentTab).sides;
  const at = sides.findIndex((s) => s.tabId === tabId);
  const side = sides[at];
  if (side?.restored) setDrawers(parentTab, "sides", at, { ...side, started: true });
}

export function savedSides(drawer: Drawer): SavedSides | undefined {
  if (!drawer.sides.length && !drawer.closed.length) return undefined;
  return {
    sessions: drawer.sides.map((s) => s.sessionId),
    active: drawer.sides.findIndex((s) => s.tabId === drawer.active),
    ...(drawer.closed.length ? { closed: drawer.closed.map((s) => s.sessionId) } : {}),
  };
}

export function restoredDrawer(saved: SavedSides, exists: (sessionId: string) => boolean, fresh: () => string): Drawer {
  let n = 0;
  const restore = (sessionId: string): SideChat => ({
    tabId: `side:${fresh()}`,
    sessionId,
    n: ++n,
    restored: true,
    started: false,
  });
  const kept = saved.sessions.map((sessionId, i) => ({ sessionId, i })).filter(({ sessionId }) => exists(sessionId));
  const sides = kept.map(({ sessionId }) => restore(sessionId));
  const closed = (saved.closed ?? []).filter(exists).map(restore);
  const active = sides[kept.findIndex(({ i }) => i === saved.active)] ?? sides[sides.length - 1];
  return { sides, active: active?.tabId ?? null, closed };
}

export function restoreSides(parentTab: string, saved: SavedSides, exists: (sessionId: string) => boolean): void {
  const drawer = restoredDrawer(saved, exists, () => crypto.randomUUID());
  if (drawer.sides.length || drawer.closed.length) setDrawers(parentTab, drawer);
}

// The parent tab closed, so its side chats go too.
export function dropSides(parentTab: string): void {
  const drawer = drawerOf(parentTab);
  setDrawers(produce((all) => void delete all[parentTab]));
  [...drawer.sides, ...drawer.closed].forEach(forget);
}

function planOf(it: ToolItem): string | null {
  if (it.toolKind !== "switchMode") return null;
  const plan = (it.input as { plan?: unknown } | null)?.plan;
  return typeof plan === "string" && plan.trim() ? plan : null;
}

// Claude in plan mode often hands its answer over as a plan, and a side chat
// denies that call, so the answer would otherwise sit in a refused tool card.
export function planAsReply(items: readonly ChatItem[]): ChatItem[] {
  return items.map((it) => {
    if (it.kind !== "tool") return it;
    const plan = planOf(it);
    if (plan === null) return it;
    return { kind: "text", id: it.id, turnId: it.turnId ?? "", text: plan, agentId: it.agentId };
  });
}

export function lastReplies(items: readonly ChatItem[], turns: Readonly<Record<string, TurnRecord>>): Set<string> {
  const last = new Map<string, string>();
  for (const it of items) {
    if (it.kind === "text" && it.agentId === null && turns[it.turnId]?.completed) last.set(it.turnId, it.id);
  }
  return new Set(last.values());
}

export function fromSide(reply: string): string {
  return `From a side chat:\n\n${reply}`;
}
