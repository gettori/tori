// One pane of the work area (plan phase 7): the unified strip above a stage
// slot that adopts module-owned hosts (stageHost.ts), everything supplied by
// the registry's pane-hosting fields, so phase 8 can place it anywhere.
import { createEffect } from "solid-js";
import UnifiedTabStrip from "./UnifiedTabStrip";
import { maybeKindEntry } from "./registry";
import { stageHost } from "./stageHost";
import { preserveScrollAndFocus } from "../utils/rowMovePreserve";
import { emit, REFIT_PANES } from "../utils/events";
import type { UnifiedTabKind } from "./unifiedTabs";
import styles from "./PaneView.module.css";

export default function PaneView(props: { pinKind: UnifiedTabKind }) {
  const entry = () => maybeKindEntry(props.pinKind);
  let root!: HTMLDivElement;
  let slot!: HTMLDivElement;

  // Adoption: append only hosts the slot is missing. Moving an already-adopted
  // host would detach a live surface for nothing; order inside the slot is
  // meaningless (surfaces self-hide, overlays are absolute).
  createEffect(() => {
    const ids = entry()?.hostIds?.() ?? [];
    let adopted = false;
    for (const id of ids) {
      const el = stageHost(id);
      if (el.parentElement !== slot) {
        slot.appendChild(el);
        adopted = true;
      }
    }
    // After layout, not in it: an adopted xterm/CM6 surface measures its new
    // box on REFIT_PANES, and mid-flush the box has no size yet.
    if (adopted) requestAnimationFrame(() => emit(REFIT_PANES));
  });

  return (
    <div class={styles.pane} ref={root}>
      <UnifiedTabStrip
        class={entry()?.stripClass}
        items={entry()?.stripItems?.() ?? []}
        activeId={entry()?.stripActiveId?.() ?? null}
        pinKind={props.pinKind}
        onReorder={(next) => {
          const reorder = entry()?.stripReorder;
          if (reorder) preserveScrollAndFocus(root, () => reorder(next));
        }}
      />
      <div class={styles.stage} ref={slot}>
        {entry()?.overlay?.()}
      </div>
    </div>
  );
}
