// Dragging a tab between panes (plan phase 10). Two halves, both pure: the
// geometry that turns a pointer over a pane into a zone, and the rule that
// turns a zone into an edit (or into nothing, which is what most of the guards
// produce). The live half is one module signal naming the tab in flight, so a
// pane can draw drop zones only while a drag is on and every reader agrees on
// what is being dragged.
//
// The payload travels as a MIME on the DataTransfer *and* in that signal: a
// `dragover` may read `types` but not `getData`, so the MIME is what a target
// recognizes and the signal is what it reads. `DRAG_PATH_MIME` rides along
// unchanged, which is what keeps a file tab droppable on a terminal.
import { createSignal } from "solid-js";

/** DataTransfer MIME marking a drag that moves a tab between panes. */
export const TAB_MOVE_MIME = "application/x-sway-tab";

export type DragTab = {
  id: string;
  kind: string;
  ws: string;
  /** The pane it started in, or null for a strip outside the pane tree. */
  fromPane: string | null;
};

export type Rect = { left: number; top: number; width: number; height: number };

export type DropZone =
  /** Into this pane's strip, after `afterId` (null = at the head). */
  | { kind: "strip"; afterId: string | null }
  | { kind: "edge"; dir: "left" | "right" | "top" | "bottom" }
  | { kind: "center" };

export type DropAction =
  | { type: "move"; paneId: string; index: number }
  | { type: "split"; paneId: string; dir: "row" | "column"; pos: "before" | "after" };

/** Share of a pane's box each edge claims, and the px it may never exceed (a
 *  wide pane would otherwise have no center left worth aiming at). */
export const EDGE_FRACTION = 0.2;
export const EDGE_MAX = 120;

const [dragging, setDragging] = createSignal<DragTab | null>(null);

/** The tab in flight, or null. Panes draw drop zones only while this is set. */
export const draggingTab = dragging;

let stop: (() => void) | null = null;

/**
 * Begin a tab drag: mark the payload and remember what is moving.
 *
 * Escape and a window blur end it, because the browser gives neither a
 * `dragend` we can rely on: a drag cancelled with the window unfocused (a
 * Cmd-Tab away mid-drag) can leave the last `dragover` as the final word, and a
 * pane would keep its zones lit over a drag that is already over.
 */
export function startTabDrag(t: DragTab, e: DragEvent): void {
  setDragging(t);
  e.dataTransfer?.setData(TAB_MOVE_MIME, t.id);
  const onKey = (k: KeyboardEvent) => {
    if (k.key === "Escape") endTabDrag();
  };
  const onBlur = () => endTabDrag();
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
  stop = () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
  };
}

export function endTabDrag(): void {
  stop?.();
  stop = null;
  setDragging(null);
}

const inside = (r: Rect, x: number, y: number) =>
  x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;

/**
 * Where a pointer over a pane is aiming. One geometry, one precedence, read
 * top to bottom: the strip claims the pointer first (it is the thing a tab
 * order is edited in), then the four edge bands of the pane's box, and what is
 * left is the center.
 *
 * Tabs are the *visible* ones, so an overflowed tab is never an insertion
 * anchor. The answer names the tab to insert after rather than an index, which
 * is what keeps a drop next to the last visible tab from jumping the overflowed
 * ones to the end of the list.
 */
export function hitTest(a: {
  x: number;
  y: number;
  pane: Rect;
  strip: Rect | null;
  tabs: { id: string; rect: Rect }[];
}): DropZone | null {
  if (!inside(a.pane, a.x, a.y)) return null;
  if (a.strip && inside(a.strip, a.x, a.y)) {
    let afterId: string | null = null;
    for (const t of a.tabs) {
      if (a.x >= t.rect.left + t.rect.width / 2) afterId = t.id;
    }
    return { kind: "strip", afterId };
  }
  const bandX = Math.min(a.pane.width * EDGE_FRACTION, EDGE_MAX);
  const bandY = Math.min(a.pane.height * EDGE_FRACTION, EDGE_MAX);
  const left = a.x - a.pane.left;
  const right = a.pane.left + a.pane.width - a.x;
  const top = a.y - a.pane.top;
  const bottom = a.pane.top + a.pane.height - a.y;
  // Horizontal before vertical, so a corner splits the way the shell already
  // reads: a pane beside another one rather than under it.
  if (left <= bandX) return { kind: "edge", dir: "left" };
  if (right <= bandX) return { kind: "edge", dir: "right" };
  if (top <= bandY) return { kind: "edge", dir: "top" };
  if (bottom <= bandY) return { kind: "edge", dir: "bottom" };
  return { kind: "center" };
}

/**
 * What a drop in that zone should do, or null for the drops that are asking
 * for the layout they already have. The no-ops are the point: dropping a tab
 * back where it sits, on its own strip at its own index, or off its own pane's
 * edge while it is the only tab there (which would split a pane and immediately
 * collapse the one it left) all mean nothing, and mean it silently.
 */
export function dropAction(a: {
  zone: DropZone;
  drag: DragTab;
  paneId: string;
  /** The target pane's tabs, in order. */
  idsInPane: string[];
  /** How many tabs the pane it is leaving holds. */
  countInFrom: number;
}): DropAction | null {
  const own = a.drag.fromPane === a.paneId;
  if (a.zone.kind === "edge") {
    if (own && a.countInFrom <= 1) return null;
    const horizontal = a.zone.dir === "left" || a.zone.dir === "right";
    return {
      type: "split",
      paneId: a.paneId,
      dir: horizontal ? "row" : "column",
      pos: a.zone.dir === "left" || a.zone.dir === "top" ? "before" : "after",
    };
  }
  const anchor = a.zone.kind === "strip" && a.zone.afterId ? a.idsInPane.indexOf(a.zone.afterId) : -1;
  const at =
    a.zone.kind === "center" || (a.zone.kind === "strip" && a.zone.afterId && anchor < 0)
      ? a.idsInPane.length
      : anchor + 1;
  if (!own) return { type: "move", paneId: a.paneId, index: at };
  const from = a.idsInPane.indexOf(a.drag.id);
  if (from < 0) return { type: "move", paneId: a.paneId, index: at };
  // Both slots either side of a tab are the slot it is already in.
  if (at === from || at === from + 1) return null;
  return { type: "move", paneId: a.paneId, index: at > from ? at - 1 : at };
}
