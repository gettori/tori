// The panel registry (plan phase 4): each tab kind registers how its tab is
// drawn, closed, activated, and staged. Panels register at setup with closures
// over their own state, so the strips draw every kind through one code path
// and the per-kind knowledge lives with the panel that owns the kind.
import type { JSX } from "solid-js";
import Tab from "../components/Tab/Tab";
import type { UnifiedTab, UnifiedTabKind } from "./unifiedTabs";

export type TabDescriptor = {
  /** Leading glyph; undefined for a bare label (plain shells today). */
  icon: (t: UnifiedTab) => JSX.Element | undefined;
  title: (t: UnifiedTab) => JSX.Element | string;
  tooltip: (t: UnifiedTab) => string;
  /** Trailing dirty/status dots. */
  dots?: (t: UnifiedTab) => JSX.Element;
  draggable?: (t: UnifiedTab) => boolean;
  onDragStart?: (t: UnifiedTab, e: DragEvent) => void;
  /** Wraps the on-screen tab (a context menu); the measuring ghost skips it. */
  wrapTab?: (t: UnifiedTab, tab: JSX.Element) => JSX.Element;
  /** The overflow menu row, whole: the two panels' rows genuinely differ. */
  renderMenuItem: (t: UnifiedTab) => JSX.Element;
  /** The bar's trailing action cluster while a tab of this kind is active (or
   *  while an empty pane's pin kind is this kind). A function so the strip can
   *  compare identity: kinds sharing one cluster keep its DOM across an active
   *  switch instead of rebuilding it. */
  trailing?: () => JSX.Element;
  activate: (t: UnifiedTab) => void;
  close: (t: UnifiedTab, e: Event) => void;
  /** The tab's surface on the stage (the render component of the kind). */
  stage?: (t: UnifiedTab) => JSX.Element;
};

const entries = new Map<UnifiedTabKind, TabDescriptor>();

// Re-registering overwrites: a panel remount (tests) refreshes its closures.
export function registerKind(kind: UnifiedTabKind, d: TabDescriptor): void {
  entries.set(kind, d);
}

export function kindEntry(kind: UnifiedTabKind): TabDescriptor {
  const d = entries.get(kind);
  if (!d) throw new Error(`no tab descriptor registered for kind "${kind}"`);
  return d;
}

/** The one tab markup every strip draws, fed entirely from the descriptor. */
export function renderRegistryTab(t: UnifiedTab, ghost?: boolean): JSX.Element {
  const d = kindEntry(t.kind);
  const tab = (
    <Tab
      value={t.id}
      tooltip={d.tooltip(t)}
      draggable={d.draggable?.(t)}
      onDragStart={d.onDragStart && ((e: DragEvent) => d.onDragStart!(t, e))}
      icon={d.icon(t)}
      trailing={d.dots?.(t)}
      onClose={(e) => d.close(t, e)}
    >
      {d.title(t)}
    </Tab>
  );
  return d.wrapTab && !ghost ? d.wrapTab(t, tab) : tab;
}
