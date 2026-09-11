// One pane's tab strip (plan phase 6): a single OverflowTabBar over a
// heterogeneous UnifiedTab list, every per-kind decision resolved through the
// registry. A pane holds whatever kinds were put in it, so the list is mixed by
// default and the trailing controls are every kind's at once (phase 13).
import { For, type JSX } from "solid-js";
import OverflowTabBar from "../components/OverflowTabBar";
import { kindEntry, renderRegistryTab, trailingClusters, type StripPlace } from "../tabs/registry";
import { idOf, type UnifiedTab } from "./unifiedTabs";
import { traceMark, traceSwitchStart } from "../utils/perfTrace";

export default function UnifiedTabStrip(props: {
  items: UnifiedTab[];
  activeId: string | null;
  onReorder: (next: UnifiedTab[]) => void;
  /** Runs before the kind's own activate, for the pane to remember its pick. */
  onActivate?: (t: UnifiedTab) => void;
  /** Which pane's strip this is, for a drag that leaves it (plan phase 10). */
  place?: StripPlace;
  /** The strip's own box, which the pane hit-tests a drop against. */
  ref?: (el: HTMLElement) => void;
  class?: string;
  /** The pane does not hold focus, so its selection is not drawn. */
  blurred?: boolean;
  /** Tabs and its own `trailing` only: the dock's strip, where no kind's
   *  controls apply. */
  bare?: boolean;
  trailing?: JSX.Element;
}) {
  // Every registered cluster, not the active tab's (phase 13): what a pane
  // offers should not depend on which of its tabs is in front. Keyed by the
  // cluster function, so a kind switch inside one strip keeps its DOM (open
  // menus, refs) instead of rebuilding it.
  return (
    <OverflowTabBar
      ref={props.ref}
      class={`unified-strip ${props.blurred ? "pane-blur" : ""} ${props.class ?? ""}`}
      items={props.items}
      activeId={props.activeId}
      idOf={idOf}
      onActivate={(id) => {
        const u = props.items.find((t) => t.id === id);
        if (!u) return;
        // The one fan-out point for every kind's activation, so it is also the
        // one place a tab switch can be timed from.
        traceSwitchStart("tab", id);
        props.onActivate?.(u);
        traceMark("tab:placed");
        kindEntry(u.kind).activate(u);
        traceMark("tab:activated");
      }}
      onReorder={props.onReorder}
      renderTab={(t, ghost) => renderRegistryTab(t, ghost, props.place)}
      renderMenuItem={(t) => kindEntry(t.kind).renderMenuItem(t)}
      trailing={props.bare ? props.trailing : <For each={trailingClusters()}>{(cluster) => cluster()}</For>}
    />
  );
}
