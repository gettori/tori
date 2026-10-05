// What a pane holds (plan phase 8). The layout layer places tab ids and the
// registry knows what a kind considers active; this is the one place the two
// meet, so a pane's strip, its stages, and the panels all read the same answer.
import { createMemo, getOwner, onCleanup, runWithOwner, type Owner } from "solid-js";
import { layoutRoot } from "../layout/layoutStore";
import { visibleLeaves } from "../layout/paneLayout";
import type { MenuItem } from "../components/Menu/rows";
import { emitWith, MOVE_TAB_TO_PANE, type MoveTabToPane, SPLIT_PANE, type SplitPane } from "../utils/events";
import {
  activeIdInPane,
  homePane,
  paneLock,
  placementRefusal,
  setPaneLock,
  orderInPane,
  paneOfTab,
  stampOrder,
  type TabRef,
} from "../layout/tabPlacement";
import { maybeKindEntry } from "./registry";
import { unifiedTabs, type UnifiedTab } from "./unifiedTabs";
import { activeWorkspace, dockActiveId } from "../panels/Terminal/terminalTabStore";
import { dockOpen } from "../layout/dockStore";
import { isShellsKey } from "../utils/topics";

type PanePlacement = {
  /** This workspace's tabs per pane, in display order. */
  byPane: Map<string, UnifiedTab[]>;
  /** Every workspace's tabs on this side of the dock, resolved against this
   *  workspace's tree, per pane: what a pane hosts (background surfaces
   *  included, gotcha #64). */
  hostedByPane: Map<string, UnifiedTab[]>;
};

let placementComputes = 0;
/** How many times a workspace's placement maps were rebuilt. With the memo
 *  installed, one placement change costs one rebuild per observed workspace,
 *  not one filter pass per pane per consumer. */
export function __placementComputesForTests(): number {
  return placementComputes;
}

function computePlacement(ws: string): PanePlacement | null {
  const root = layoutRoot(ws);
  if (!root) return null;
  placementComputes++;
  const byPane = new Map<string, UnifiedTab[]>();
  const hostedByPane = new Map<string, UnifiedTab[]>();
  for (const t of unifiedTabs()) {
    // The dock and the workspace are on screen together, so a surface one of
    // them adopted would be pulled out from under it by the other.
    if (isShellsKey(t.workspace) !== isShellsKey(ws)) continue;
    const pane = paneOfTab(t.workspace, t, root);
    if (!pane) continue;
    const hosted = hostedByPane.get(pane);
    if (hosted) hosted.push(t);
    else hostedByPane.set(pane, [t]);
    if (t.workspace !== ws) continue;
    const own = byPane.get(pane);
    if (own) own.push(t);
    else byPane.set(pane, [t]);
  }
  for (const [pane, tabs] of byPane) byPane.set(pane, orderInPane(ws, tabs));
  return { byPane, hostedByPane };
}

// The memos live under the shell's root, not at module level, so they are
// disposed with the app (the same story as installUnifiedTabsMemo). One memo
// per visited workspace, made lazily on first ask; the map grows with visited
// worktrees, which stay a handful per run.
let placementOwner: Owner | null = null;
let placementMemos: Map<string, () => PanePlacement | null> | null = null;

/** Called once from the shell's setup, inside its reactive root. */
export function installPaneTabsMemo() {
  const owner = getOwner();
  placementOwner = owner;
  placementMemos = new Map();
  onCleanup(() => {
    if (placementOwner === owner) {
      placementOwner = null;
      placementMemos = null;
    }
  });
}

function placement(ws: string): PanePlacement | null {
  if (!placementMemos || !placementOwner) return computePlacement(ws);
  let m = placementMemos.get(ws);
  if (!m) {
    m = runWithOwner(placementOwner, () => createMemo(() => computePlacement(ws)))!;
    placementMemos.set(ws, m);
  }
  return m();
}

/** This workspace's tabs, in the pane that holds them, in display order. */
export function paneTabs(ws: string, paneId: string): UnifiedTab[] {
  return placement(ws)?.byPane.get(paneId) ?? [];
}

/**
 * Every stage host this pane should hold, background workspaces included: a tab
 * in another workspace keeps its surface in the pane its kind pins to, so
 * switching workspaces hides surfaces instead of detaching them (gotcha #64).
 *
 * Each kind maps its own tabs to hosts (a terminal tab is its own surface; the
 * editor's panes share one per pane), so this asks rather than assumes.
 */
export function paneHostIds(ws: string, paneId: string): string[] {
  const here = placement(ws)?.hostedByPane.get(paneId) ?? [];
  const out: string[] = [];
  const done = new Set<unknown>();
  for (const t of here) {
    const hostIds = maybeKindEntry(t.kind)?.hostIds;
    if (!hostIds || done.has(hostIds)) continue;
    done.add(hostIds);
    const family = here.filter((o) => maybeKindEntry(o.kind)?.hostIds === hostIds);
    out.push(...hostIds(paneId, family));
  }
  return out;
}

/** The visible panes holding at least one tab of a kind, in shell order. */
export function panesWithKind(ws: string, kind: string): string[] {
  const root = layoutRoot(ws);
  if (!root) return [];
  return visibleLeaves(root)
    .map((l) => l.id)
    .filter((id) => paneTabs(ws, id).some((t) => t.kind === kind));
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
  // The terminal kinds claim the workspace's tab, which is never the dock's.
  const claimed = isShellsKey(ws) ? [dockActiveId()].filter((id): id is string => !!id) : claimedIds(tabs);
  return activeIdInPane(
    ws,
    paneId,
    tabs.map((t) => t.id),
    claimed,
  );
}

/** Does this pane speak for the kind: is it where the kind's tabs land, and so
 *  where its once-per-workspace overlays belong? True with no tree, since then
 *  there is only the panel's own pane. */
export function isKindHome(ws: string, kind: string, paneId: string): boolean {
  const root = layoutRoot(ws);
  return !root || homePane(ws, kind, root) === paneId;
}

/** Where a kind opens, or null when this workspace has no pane tree yet. */
export function kindHomePane(ws: string, kind: string): string | null {
  const root = layoutRoot(ws);
  return root ? homePane(ws, kind, root) : null;
}

/** Is this tab the one its pane shows? Null when there is no pane tree yet.
 *  False for every tab of a background workspace: its panes still remember
 *  their picks, but nothing in them is on screen, and answering true here is
 *  what kept one surface per pane per visited worktree active (fit, focus,
 *  `pty_resize`, `chat_set_visible` never false) across a switch. The dock's
 *  tabs are on screen whenever the dock is, whatever workspace is. */
export function visibleInPane(tab: TabRef & { workspace: string }): boolean | null {
  const root = layoutRoot(tab.workspace);
  if (!root) return null;
  const onScreen = isShellsKey(tab.workspace) ? dockOpen() : tab.workspace === activeWorkspace();
  if (!onScreen) return false;
  const pane = paneOfTab(tab.workspace, tab, root);
  return pane ? paneActiveId(tab.workspace, pane) === tab.id : null;
}

/** Why a pane would refuse this tab, or null (plan phase 11). The same guard
 *  the shell runs when the move happens, asked while a drag is still in the
 *  air, so a pane can say no before it is let go of. */
export function paneRefusal(ws: string, tab: TabRef, paneId: string): string | null {
  const root = layoutRoot(ws);
  if (!root) return null;
  return placementRefusal({
    ws,
    tab,
    targetPaneId: paneId,
    root,
    tabsInWs: unifiedTabs().filter((t) => t.workspace === ws),
  });
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
      onClick: () => emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: tab.id, kind: tab.kind, paneId: l.id }),
    })),
    ...(others.length ? [{ separator: true } as MenuItem] : []),
    // The lock is a property of the box rather than of a tab, so it is written
    // straight to the placement store: there is no guard to run and no other
    // path that sets one.
    ...(here
      ? [
          paneLock(ws, here)
            ? { label: "Let this pane take any tab", onClick: () => setPaneLock(ws, here, null) }
            : {
                label: `Only ${tab.kind} tabs in this pane`,
                onClick: () => setPaneLock(ws, here, tab.kind),
              },
          { separator: true } as MenuItem,
        ]
      : []),
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
  stampOrder(
    ws,
    next.map((t) => t.id),
  );
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
