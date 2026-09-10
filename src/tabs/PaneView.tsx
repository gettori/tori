// One pane of the work area (plan phase 7, placed by phase 8): the unified
// strip above a stage slot that adopts module-owned hosts (stageHost.ts).
//
// With a `paneId` the pane draws what the placement store put in it, across
// kinds; without one it draws its pin kind's whole strip, which is what a panel
// mounted outside the shell (every panel-only suite) still wants.
//
// A placed pane is also a drop target while a tab is in flight (phase 10). The
// strip and the edge bands are claimed in the capture phase, so nothing inside
// the pane sees those drops; the center is left to whatever is on the stage and
// only becomes "put it in this pane" when nothing there took it, which is what
// keeps a file tab dropped on a terminal inserting its path.
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import UnifiedTabStrip from "./UnifiedTabStrip";
import { maybeKindEntry } from "./registry";
import {
  isKindHome,
  paneActiveId,
  paneHostIds,
  paneRefusal,
  paneTabs,
  reorderPane,
} from "./paneTabs";
import { stageHost } from "./stageHost";
import { draggingTab, dropAction, endTabDrag, hitTest, type DropZone } from "./tabDrag";
import { setPaneActive } from "../layout/tabPlacement";
import { focusedPaneId } from "../layout/layoutStore";
import { dockOpen, focusedSurface } from "../layout/dockStore";
import { isShellsKey } from "../utils/features";
import { preserveScrollAndFocus } from "../utils/rowMovePreserve";
import { traceMark } from "../utils/perfTrace";
import {
  emit,
  emitWith,
  MOVE_TAB_TO_PANE,
  type MoveTabToPane,
  REFIT_PANES,
  SPLIT_PANE,
  type SplitPane,
} from "../utils/events";
import type { UnifiedTab, UnifiedTabKind } from "./unifiedTabs";
import styles from "./PaneView.module.css";

export default function PaneView(props: {
  pinKind: UnifiedTabKind;
  paneId?: string;
  ws?: string;
}) {
  const entry = () => maybeKindEntry(props.pinKind);
  const inDock = () => isShellsKey(props.ws);
  // A strip only marks its selection while its pane holds focus: two lit tabs in
  // two panes read as two selections, and only one of them is the one every
  // command means.
  const blurred = () => {
    if (dockOpen() && (focusedSurface() === "dock") !== inDock()) return true;
    const focused = props.paneId ? focusedPaneId(props.ws ?? "") : null;
    return !!focused && focused !== props.paneId;
  };
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
  let strip: HTMLElement | undefined;

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
    if (adopted) {
      traceMark("pane:adopt");
      requestAnimationFrame(() => {
        emit(REFIT_PANES);
        traceMark("pane:refit");
      });
    }
  });

  // ---- Drop target (plan phase 10) -----------------------------------------
  const [zone, setZone] = createSignal<DropZone | null>(null);
  const [caret, setCaret] = createSignal(0);
  const [refused, setRefused] = createSignal(false);

  /** Would this pane take the tab in flight? Only asked of a drop into this
   *  pane: an edge drop makes a new pane, and a new pane is locked to nothing.
   *  The drop is still let through, so the shell answers with the sentence
   *  rather than the pane swallowing it. */
  const wouldRefuse = (z: DropZone) => {
    const drag = draggingTab();
    if (!drag || !props.paneId || z.kind === "edge") return false;
    return !!paneRefusal(props.ws ?? "", { id: drag.id, kind: drag.kind }, props.paneId);
  };

  /** A tab's whole box. `data-tab-id` rides the trigger, which stops short of
   *  the close button, so the midpoint that picks an anchor and the caret drawn
   *  at a tab's edge both have to come from the pill around it. */
  const pillRect = (el: HTMLElement) =>
    (el.closest<HTMLElement>("[data-tab-pill]") ?? el).getBoundingClientRect();

  /** The zone under the pointer, or null when this pane is not a target at all
   *  (no tree, or nothing in flight). */
  function zoneAt(e: DragEvent): DropZone | null {
    // A move or a split lands in the selected workspace's tree, which the dock's
    // one pane is not part of, and a tab only ever moves within its own group.
    if (!props.paneId || !draggingTab() || inDock() || draggingTab()!.ws !== props.ws) return null;
    const tabs = strip
      ? [...strip.querySelectorAll<HTMLElement>(".otab-list [data-tab-id]")].map((el) => ({
          id: el.dataset.tabId!,
          rect: pillRect(el),
        }))
      : [];
    return hitTest({
      x: e.clientX,
      y: e.clientY,
      pane: root.getBoundingClientRect(),
      strip: strip?.getBoundingClientRect() ?? null,
      tabs,
    });
  }

  /** The edit this zone means, or null for the drops that ask for the layout
   *  they already have. Asked twice: once to draw, once to apply. */
  function actionFor(z: DropZone) {
    const drag = draggingTab();
    if (!drag || !props.paneId) return null;
    const ws = props.ws ?? "";
    return dropAction({
      zone: z,
      drag,
      paneId: props.paneId,
      idsInPane: paneTabs(ws, props.paneId).map((t) => t.id),
      countInFrom: drag.fromPane ? paneTabs(ws, drag.fromPane).length : 0,
    });
  }

  /** Turn a drop into the edit it means, and say so through the same events the
   *  palette and the tab menu use, so one set of guards runs either way. */
  function apply(z: DropZone) {
    const drag = draggingTab();
    const action = actionFor(z);
    if (!drag || !action) return;
    if (action.type === "move") {
      emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, {
        tabId: drag.id,
        kind: drag.kind,
        paneId: action.paneId,
        index: action.index,
      });
    } else {
      emitWith<SplitPane>(SPLIT_PANE, {
        dir: action.dir,
        paneId: action.paneId,
        pos: action.pos,
        tabId: drag.id,
        kind: drag.kind,
      });
    }
  }

  function show(z: DropZone, e: DragEvent) {
    // The center is drawn by nobody: it is the surface's until the surface
    // passes, and lighting the pane up would promise a landing it may not get.
    // A zone for a no-op is the same false promise: both slots either side of
    // the tab in flight are the slot it already sits in.
    const drawn = z.kind !== "center" && !!actionFor(z);
    setZone(drawn ? z : null);
    setRefused(wouldRefuse(z));
    if (drawn && z.kind === "strip") {
      const box = root.getBoundingClientRect();
      const after =
        z.afterId && strip
          ? strip.querySelector<HTMLElement>(`.otab-list [data-tab-id="${CSS.escape(z.afterId)}"]`)
          : null;
      const at = after ? pillRect(after) : null;
      setCaret((at ? at.left + at.width : (strip?.getBoundingClientRect().left ?? box.left)) - box.left);
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }

  onMount(() => {
    const over = (e: DragEvent) => {
      const z = zoneAt(e);
      if (!z) return;
      show(z, e);
      // The center belongs to the surface until the surface passes: claiming it
      // here would take the terminal's and the composer's path drops with it.
      if (z.kind !== "center") e.stopPropagation();
    };
    const dropClaimed = (e: DragEvent) => {
      const z = zoneAt(e);
      if (!z || z.kind === "center") return;
      e.preventDefault();
      e.stopPropagation();
      setZone(null);
      apply(z);
      endTabDrag();
    };
    const dropLeftover = (e: DragEvent) => {
      const z = zoneAt(e);
      setZone(null);
      // `defaultPrevented`: the stage's own drop handler ran first and took it.
      if (!z || z.kind !== "center" || e.defaultPrevented) return;
      e.preventDefault();
      apply(z);
      endTabDrag();
    };
    const leave = (e: DragEvent) => {
      if (!root.contains(e.relatedTarget as Node | null)) setZone(null);
    };
    root.addEventListener("dragover", over, true);
    root.addEventListener("drop", dropClaimed, true);
    root.addEventListener("drop", dropLeftover);
    root.addEventListener("dragleave", leave, true);
    onCleanup(() => {
      root.removeEventListener("dragover", over, true);
      root.removeEventListener("drop", dropClaimed, true);
      root.removeEventListener("drop", dropLeftover);
      root.removeEventListener("dragleave", leave, true);
    });
  });

  // Escape, a window blur or a dragend end the drag wherever it was; the zones
  // it lit are this pane's own transient state and go with it.
  createEffect(() => {
    if (!draggingTab()) setZone(null);
  });

  return (
    <div class={styles.pane} ref={root}>
      <UnifiedTabStrip
        ref={(el) => (strip = el)}
        class={entry()?.stripClass}
        blurred={blurred()}
        bare={inDock()}
        items={items()}
        activeId={activeId()}
        place={props.paneId ? { ws: props.ws ?? "", paneId: props.paneId } : undefined}
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
        <Show when={!inDock() && (!props.paneId || isKindHome(props.ws ?? "", props.pinKind, props.paneId))}>
          {entry()?.overlay?.()}
        </Show>
      </div>
      <Show when={zone()}>{(z) => <DropOverlay zone={z()} caret={caret()} refused={refused()} />}</Show>
    </div>
  );
}

/** What the pointer is aiming at, drawn: a caret between two tabs, the half the
 *  new pane would take, or the whole stage for a plain append. */
function DropOverlay(props: { zone: DropZone; caret: number; refused: boolean }) {
  const edge = () => (props.zone.kind === "edge" ? props.zone.dir : null);
  return (
    <div
      class={styles.dropZone}
      data-drop-zone={edge() ? `edge-${edge()}` : props.zone.kind}
      data-drop-refused={props.refused ? "" : undefined}
      classList={{
        [styles.dropRefused]: props.refused,
        [styles.dropCaret]: props.zone.kind === "strip",
        [styles.dropHalf]: !!edge(),
        [styles.dropLeft]: edge() === "left",
        [styles.dropRight]: edge() === "right",
        [styles.dropTop]: edge() === "top",
        [styles.dropBottom]: edge() === "bottom",
      }}
      style={props.zone.kind === "strip" ? { left: `${props.caret}px` } : undefined}
    />
  );
}
