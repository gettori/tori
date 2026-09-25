// The panel registry (plan phase 4): each tab kind registers how its tab is
// drawn, closed, activated, and staged. Panels register at setup with closures
// over their own state, so the strips draw every kind through one code path
// and the per-kind knowledge lives with the panel that owns the kind.
import { createSignal, type JSX } from "solid-js";
import Tab from "../components/Tab/Tab";
import { endTabDrag, startTabDrag } from "./tabDrag";
import type { UnifiedTab, UnifiedTabKind } from "./unifiedTabs";

export type TabDescriptor = {
  /** Leading glyph; undefined for a bare label. */
  icon: (t: UnifiedTab) => JSX.Element | undefined;
  title: (t: UnifiedTab) => JSX.Element | string;
  tooltip: (t: UnifiedTab) => string;
  /** Trailing dirty/status dots. */
  dots?: (t: UnifiedTab) => JSX.Element;
  /** The kind's own payload on a tab drag (a path for a terminal to insert).
   *  The tab-move payload is added for every kind, above this. */
  onDragStart?: (t: UnifiedTab, e: DragEvent) => void;
  /** Wraps the on-screen tab (a context menu); the measuring ghost skips it. */
  wrapTab?: (t: UnifiedTab, tab: JSX.Element) => JSX.Element;
  /** The overflow menu row, whole: the two panels' rows genuinely differ. */
  renderMenuItem: (t: UnifiedTab) => JSX.Element;
  /** This kind's trailing action cluster. Every registered cluster is drawn in
   *  every strip (phase 13), so the controls a pane offers no longer depend on
   *  which tab happens to be active in it. A function so the strip can compare
   *  identity: the five terminal kinds register one cluster and it is drawn
   *  once. */
  trailing?: () => JSX.Element;
  /** Where this kind's cluster sits in that combined row, ascending. Declared
   *  rather than taken from registration order, which is mount order and says
   *  nothing about how the controls read left to right. */
  trailingRank?: number;
  /** Drawn after every ranked cluster, whatever kinds are registered. For a
   *  control that is the strip's own edge rather than any kind's: the filetree
   *  reveal is about the pane's chrome, not about what is open in it. */
  trailingEdge?: () => JSX.Element;
  activate: (t: UnifiedTab) => void;
  close: (t: UnifiedTab, e: Event) => void;
  locked?: (t: UnifiedTab) => JSX.Element | undefined;
  /** A tab the next open of its kind replaces, drawn so it reads as one. */
  transient?: (t: UnifiedTab) => boolean;
  /** Double click, which every editor with a replaceable tab uses to keep it.
   *  Here rather than in `wrapTab` because the handler belongs on the tab
   *  itself, and a wrapper around it would take the click for the strip's
   *  padding too. */
  onDoubleClick?: (t: UnifiedTab) => void;
  /** The tab's surface on the stage (the render component of the kind). */
  stage?: (t: UnifiedTab) => JSX.Element;
  /** Pane hosting (plan phase 7): how a pane pinned to this kind fills itself.
   *  The strip's list/active/reorder, the stage hosts to adopt, and the
   *  overlays drawn over the stage - all closures over the panel's state. */
  stripItems?: () => UnifiedTab[];
  stripActiveId?: () => string | null;
  stripReorder?: (next: UnifiedTab[]) => void;
  stripClass?: string;
  /** The stage hosts a pane must adopt for these of the kind's tabs. `paneId` is
   *  null for a pane outside the tree (a panel mounted on its own), where the
   *  kind answers for everything it has. */
  hostIds?: (paneId: string | null, tabs: UnifiedTab[]) => string[];
  overlay?: () => JSX.Element;
};

const entries = new Map<UnifiedTabKind, TabDescriptor>();
// Registration order is render order now that panes and panels are separate
// components: a pane mounted before its panel must pick the descriptor up when
// it lands, and a Map alone is invisible to tracking scopes.
const [generation, setGeneration] = createSignal(0);

// Re-registering overwrites: a panel remount (tests) refreshes its closures.
export function registerKind(kind: UnifiedTabKind, d: TabDescriptor): void {
  entries.set(kind, d);
  setGeneration((g) => g + 1);
}

export function kindEntry(kind: UnifiedTabKind): TabDescriptor {
  const d = maybeKindEntry(kind);
  if (!d) throw new Error(`no tab descriptor registered for kind "${kind}"`);
  return d;
}

/** Every registered trailing cluster, in the order they are drawn: one entry
 *  per distinct cluster, so the terminal kinds' shared one appears once. Ranked
 *  clusters first, then whatever asked to be the strip's edge. */
export function trailingClusters(): (() => JSX.Element)[] {
  generation();
  const seen = new Set<() => JSX.Element>();
  const out: { rank: number; fn: () => JSX.Element }[] = [];
  const edge: (() => JSX.Element)[] = [];
  for (const d of entries.values()) {
    if (d.trailing && !seen.has(d.trailing)) {
      seen.add(d.trailing);
      out.push({ rank: d.trailingRank ?? 100, fn: d.trailing });
    }
    if (d.trailingEdge && !seen.has(d.trailingEdge)) {
      seen.add(d.trailingEdge);
      edge.push(d.trailingEdge);
    }
  }
  return [...out.sort((a, b) => a.rank - b.rank).map((x) => x.fn), ...edge];
}

/** For readers that must tolerate a not-yet-mounted panel (a pane's pin kind
 *  before its panel registers, App suites that stub the panels outright). */
export function maybeKindEntry(kind: UnifiedTabKind): TabDescriptor | undefined {
  generation();
  return entries.get(kind);
}

/** Where a strip's tabs are being drawn, so a drag off one knows what it is
 *  moving out of. Absent for a strip outside the pane tree. */
export type StripPlace = { ws: string; paneId: string };

/** The one tab markup every strip draws, fed entirely from the descriptor. */
export function renderRegistryTab(t: UnifiedTab, ghost?: boolean, place?: StripPlace): JSX.Element {
  const d = kindEntry(t.kind);
  const tab = (
    <Tab
      value={t.id}
      data-tab-id={t.id}
      tooltip={d.tooltip(t)}
      // Every tab moves between panes, so every tab drags (plan phase 10); what
      // a kind adds to the payload is still the kind's own business.
      draggable={!ghost}
      onDragStart={(e: DragEvent) => {
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
        startTabDrag(
          { id: t.id, kind: t.kind, ws: place?.ws ?? t.workspace, fromPane: place?.paneId ?? null },
          e,
        );
        d.onDragStart?.(t, e);
      }}
      onDragEnd={() => endTabDrag()}
      onDblClick={() => d.onDoubleClick?.(t)}
      data-transient={d.transient?.(t) ? "" : undefined}
      icon={d.icon(t)}
      trailing={d.dots?.(t)}
      onClose={(e) => d.close(t, e)}
      locked={d.locked?.(t)}
    >
      {d.title(t)}
    </Tab>
  );
  return d.wrapTab && !ghost ? d.wrapTab(t, tab) : tab;
}
