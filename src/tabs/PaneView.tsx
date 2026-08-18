// One pane of the work area (plan phase 7, placed by phase 8): the unified
// strip above a stage slot that adopts module-owned hosts (stageHost.ts).
//
// With a `paneId` the pane draws what the placement store put in it, across
// kinds; without one it draws its pin kind's whole strip, which is what a panel
// mounted outside the shell (every panel-only suite) still wants.
import { createEffect, Show } from "solid-js";
import UnifiedTabStrip from "./UnifiedTabStrip";
import { maybeKindEntry } from "./registry";
import { isKindHome, paneActiveId, paneHostIds, paneTabs, reorderPane } from "./paneTabs";
import { stageHost } from "./stageHost";
import { setPaneActive } from "../layout/tabPlacement";
import { preserveScrollAndFocus } from "../utils/rowMovePreserve";
import { emit, REFIT_PANES } from "../utils/events";
import type { UnifiedTab, UnifiedTabKind } from "./unifiedTabs";
import styles from "./PaneView.module.css";

export default function PaneView(props: {
  pinKind: UnifiedTabKind;
  paneId?: string;
  ws?: string;
}) {
  const entry = () => maybeKindEntry(props.pinKind);
  const placed = () => (props.paneId ? paneTabs(props.ws ?? "", props.paneId) : null);
  const items = (): UnifiedTab[] => placed() ?? entry()?.stripItems?.() ?? [];
  const activeId = () =>
    props.paneId ? paneActiveId(props.ws ?? "", props.paneId) : (entry()?.stripActiveId?.() ?? null);
  // A placed pane hosts its tabs across every workspace (see paneHostIds); an
  // unplaced one hosts its kind's whole set (the editor's one shared stage,
  // every terminal tab's surface).
  const hostIds = () =>
    props.paneId ? paneHostIds(props.ws ?? "", props.paneId) : (entry()?.hostIds?.(null, []) ?? []);

  let root!: HTMLDivElement;
  let slot!: HTMLDivElement;

  // Adoption: append only hosts the slot is missing. Moving an already-adopted
  // host would detach a live surface for nothing; order inside the slot is
  // meaningless (surfaces self-hide, overlays are absolute).
  createEffect(() => {
    const ids = hostIds();
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
        items={items()}
        activeId={activeId()}
        pinKind={props.pinKind}
        onActivate={(t) => props.paneId && setPaneActive(props.ws ?? "", props.paneId, t.id)}
        onReorder={(next) =>
          preserveScrollAndFocus(root, () => {
            if (props.paneId) reorderPane(props.ws ?? "", next);
            else entry()?.stripReorder?.(next);
          })
        }
      />
      <div class={styles.stage} ref={slot}>
        {/* Once per workspace, not once per pane: the restore offer and the
            empty-pane note belong to the pane the kind opens into. */}
        <Show when={!props.paneId || isKindHome(props.ws ?? "", props.pinKind, props.paneId)}>
          {entry()?.overlay?.()}
        </Show>
      </div>
    </div>
  );
}
