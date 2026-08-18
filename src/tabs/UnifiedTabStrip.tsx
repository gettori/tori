// One pane's tab strip (plan phase 6): a single OverflowTabBar over a
// heterogeneous UnifiedTab list, every per-kind decision resolved through the
// registry. The two-pane default feeds it kind-filtered lists, so it renders
// exactly what the panels' own bars did; a mixed list needs no other code path.
import { createMemo } from "solid-js";
import OverflowTabBar from "../components/OverflowTabBar";
import { kindEntry, maybeKindEntry, renderRegistryTab, type StripPlace } from "../tabs/registry";
import { idOf, type UnifiedTab, type UnifiedTabKind } from "./unifiedTabs";

export default function UnifiedTabStrip(props: {
  items: UnifiedTab[];
  activeId: string | null;
  /** The pane's pin kind: whose trailing cluster shows while the strip is
   *  empty or the active id names no tab of this pane. */
  pinKind: UnifiedTabKind;
  onReorder: (next: UnifiedTab[]) => void;
  /** Runs before the kind's own activate, for the pane to remember its pick. */
  onActivate?: (t: UnifiedTab) => void;
  /** Which pane's strip this is, for a drag that leaves it (plan phase 10). */
  place?: StripPlace;
  /** The strip's own box, which the pane hit-tests a drop against. */
  ref?: (el: HTMLElement) => void;
  class?: string;
}) {
  const activeTab = () => props.items.find((t) => t.id === props.activeId);
  // The trailing cluster follows the active tab's kind. Memoized on the
  // descriptor's trailing function itself: the five terminal kinds register
  // the same cluster, so switching between them keeps its DOM (open menus,
  // refs), while a genuine kind change swaps the whole cluster.
  // `maybe`: an empty pane's pin kind can name a panel that has not registered
  // yet (or never will, in App suites that stub the panels); items imply
  // registration, the pin kind alone does not.
  const trailingOf = createMemo(() => maybeKindEntry((activeTab() ?? { kind: props.pinKind }).kind)?.trailing);
  return (
    <OverflowTabBar
      ref={props.ref}
      class={props.class}
      items={props.items}
      activeId={props.activeId}
      idOf={idOf}
      onActivate={(id) => {
        const u = props.items.find((t) => t.id === id);
        if (!u) return;
        props.onActivate?.(u);
        kindEntry(u.kind).activate(u);
      }}
      onReorder={props.onReorder}
      renderTab={(t, ghost) => renderRegistryTab(t, ghost, props.place)}
      renderMenuItem={(t) => kindEntry(t.kind).renderMenuItem(t)}
      trailing={trailingOf()?.()}
    />
  );
}
