// What a pane holds (plan phase 8). The layout layer places tab ids and the
// registry knows what a kind considers active; this is the one place the two
// meet, so a pane's strip, its stages, and the panels all read the same answer.
import { layoutRoot } from "../layout/layoutStore";
import { visibleLeaves } from "../layout/paneLayout";
import type { MenuItem } from "../components/Menu/rows";
import {
  emitWith,
  MOVE_TAB_TO_PANE,
  type MoveTabToPane,
  SPLIT_PANE,
  type SplitPane,
} from "../utils/events";
import {
  activeIdInPane,
  homePane,
  orderInPane,
  paneOfTab,
  stampOrder,
  type TabRef,
} from "../layout/tabPlacement";
import { maybeKindEntry } from "./registry";
import { unifiedTabs, type UnifiedTab } from "./unifiedTabs";

/** This workspace's tabs, in the pane that holds them, in display order. */
export function paneTabs(ws: string, paneId: string): UnifiedTab[] {
  const root = layoutRoot(ws);
  if (!root) return [];
  return orderInPane(
    ws,
    unifiedTabs().filter((t) => t.workspace === ws && paneOfTab(ws, t, root) === paneId),
  );
}

/** Every stage host this pane should hold, background workspaces included: a
 *  tab in another workspace keeps its surface in the pane its kind pins to, so
 *  switching workspaces hides surfaces instead of detaching them (gotcha #64). */
export function paneHostIds(ws: string, paneId: string): string[] {
  const root = layoutRoot(ws);
  if (!root) return [];
  return unifiedTabs()
    .filter((t) => paneOfTab(t.workspace, t, root) === paneId)
    .map((t) => t.id);
}

/** The ids their own kind calls active. One per kind, so a pane holding a file
 *  tab and a terminal tab has two claims and the stored pick breaks the tie. */
const claimedIds = (tabs: UnifiedTab[]): string[] =>
  tabs.filter((t) => maybeKindEntry(t.kind)?.stripActiveId?.() === t.id).map((t) => t.id);

/** Which tab a pane shows. Null when the shell has not seeded this workspace,
 *  which is a caller's cue to keep its own pre-pane behaviour. */
export function paneActiveId(ws: string, paneId: string): string | null {
  if (!layoutRoot(ws)) return null;
  const tabs = paneTabs(ws, paneId);
  return activeIdInPane(ws, paneId, tabs.map((t) => t.id), claimedIds(tabs));
}

/** Does this pane speak for the kind: is it where the kind's tabs land, and so
 *  where its once-per-workspace overlays belong? True with no tree, since then
 *  there is only the panel's own pane. */
export function isKindHome(ws: string, kind: string, paneId: string): boolean {
  const root = layoutRoot(ws);
  return !root || homePane(ws, kind, root) === paneId;
}

/** Is this tab the one its pane shows? Null when there is no pane tree yet. */
export function visibleInPane(tab: TabRef & { workspace: string }): boolean | null {
  const root = layoutRoot(tab.workspace);
  if (!root) return null;
  const pane = paneOfTab(tab.workspace, tab, root);
  return pane ? paneActiveId(tab.workspace, pane) === tab.id : null;
}

/** A tab's own pane menu (plan phase 8): where else it could go, and how to
 *  make somewhere else. Both halves emit, so the shell runs the same guards a
 *  palette command would. */
export function paneMenuItems(ws: string, tab: TabRef): MenuItem[] {
  const root = layoutRoot(ws);
  const here = root ? paneOfTab(ws, tab, root) : null;
  const others = root ? visibleLeaves(root).filter((l) => l.id !== here) : [];
  const order = root ? visibleLeaves(root).map((l) => l.id) : [];
  return [
    ...others.map((l) => ({
      label: `Move to pane ${order.indexOf(l.id) + 1}`,
      onClick: () =>
        emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: tab.id, kind: tab.kind, paneId: l.id }),
    })),
    ...(others.length ? [{ separator: true } as MenuItem] : []),
    {
      label: "Split the pane to the right",
      onClick: () => emitWith<SplitPane>(SPLIT_PANE, { dir: "row" }),
    },
    { label: "Split the pane below", onClick: () => emitWith<SplitPane>(SPLIT_PANE, { dir: "column" }) },
  ];
}

/**
 * Apply one pane's new tab order. The stamp fixes the order inside the pane;
 * each kind's own store then gets its whole workspace list back with only this
 * pane's slots rewritten, so a mixed strip drag reaches both stores and leaves
 * the other panes' tabs where they were.
 */
export function reorderPane(ws: string, next: UnifiedTab[]) {
  stampOrder(ws, next.map((t) => t.id));
  const done = new Set<unknown>();
  for (const t of next) {
    const entry = maybeKindEntry(t.kind);
    const reorder = entry?.stripReorder;
    if (!entry?.stripItems || !reorder || done.has(reorder)) continue;
    done.add(reorder);
    const family = next.filter((n) => maybeKindEntry(n.kind)?.stripReorder === reorder);
    const ids = new Set(family.map((f) => f.id));
    const full = entry.stripItems();
    if (full.filter((f) => ids.has(f.id)).length !== family.length) continue;
    let i = 0;
    reorder(full.map((f) => (ids.has(f.id) ? family[i++] : f)));
  }
}
