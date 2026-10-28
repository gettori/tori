// The lock itself lives in Rust, keyed by the `sideOf` every spawn carries, so
// nothing here decides what a side chat may do.
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import type { ChatItem, ToolItem } from "./chatStore";

export type SideChat = { tabId: string; sessionId: string };
export type Drawer = { sides: SideChat[]; active: string | null };

const EMPTY: Drawer = { sides: [], active: null };

const [sideAgents, setSideAgents] = createSignal<readonly string[]>([]);
void invoke<string[]>("chat_side_agents")
  .then((ids) => setSideAgents(Array.isArray(ids) ? ids : []))
  .catch(() => {});

export function canSideChat(agentId: string): boolean {
  return sideAgents().includes(agentId);
}

export function withSide(drawer: Drawer, side: SideChat): Drawer {
  return { sides: [...drawer.sides, side], active: side.tabId };
}

export function withoutSide(drawer: Drawer, tabId: string): Drawer {
  const at = drawer.sides.findIndex((s) => s.tabId === tabId);
  if (at === -1) return drawer;
  const sides = drawer.sides.filter((s) => s.tabId !== tabId);
  if (drawer.active !== tabId) return { sides, active: drawer.active };
  const next = sides[at] ?? sides[at - 1] ?? null;
  return { sides, active: next?.tabId ?? null };
}

const [drawers, setDrawers] = createStore<Record<string, Drawer>>({});

export function drawerOf(parentTab: string): Drawer {
  return drawers[parentTab] ?? EMPTY;
}

export function openSide(parentTab: string): SideChat {
  const side = { tabId: `side:${crypto.randomUUID()}`, sessionId: crypto.randomUUID() };
  setDrawers(parentTab, withSide(drawerOf(parentTab), side));
  return side;
}

export function closeSide(parentTab: string, tabId: string): void {
  setDrawers(parentTab, withoutSide(drawerOf(parentTab), tabId));
}

export function selectSide(parentTab: string, tabId: string): void {
  setDrawers(parentTab, "active", tabId);
}

/** The parent tab closed. Returns its side chats, for the caller to clean up after. */
export function dropSides(parentTab: string): SideChat[] {
  const gone = drawerOf(parentTab).sides;
  setDrawers(produce((all) => void delete all[parentTab]));
  return gone;
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
