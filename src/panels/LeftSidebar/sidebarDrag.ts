// Not `utils/dragReorder.ts`: that one stays inside a single list, and this
// drag crosses sections and still carries the row's path for a terminal drop.

import { createSignal, onCleanup, type JSX } from "solid-js";
import { DRAG_ABS_PATH_MIME } from "../../utils/events";

export type Zone = "top" | "middle" | "bottom";

/** Which part of a row `y` is over. Rows that cannot be grouped with split in
 *  halves; the rest give their middle half to grouping. */
export function zoneAt(top: number, height: number, y: number, groupable: boolean): Zone {
  const f = height > 0 ? (y - top) / height : 0;
  if (!groupable) return f < 0.5 ? "top" : "bottom";
  if (f < 0.25) return "top";
  return f > 0.75 ? "bottom" : "middle";
}

export type DropTo = { section: string; index: number } | { groupWith: string };
export type DragCommit = { from: string; to: DropTo };

export type RowSpot = {
  key: string;
  section: string;
  index: number;
  paths: string | string[];
  groupable?: boolean;
};

export type SidebarDragProps = {
  draggable: true;
  onDragStart: JSX.EventHandler<HTMLElement, DragEvent>;
  onDragOver: JSX.EventHandler<HTMLElement, DragEvent>;
  onDragLeave: JSX.EventHandler<HTMLElement, DragEvent>;
  onDrop: JSX.EventHandler<HTMLElement, DragEvent>;
  onDragEnd: JSX.EventHandler<HTMLElement, DragEvent>;
  "data-dragging": string | undefined;
  "data-drop": "before" | "after" | "into" | "refused" | undefined;
};

export type Refusal = { reason: string; x: number; y: number };

export type SidebarDrag = {
  dragging: () => string | null;
  refused: () => Refusal | null;
  rowProps: (spot: RowSpot) => SidebarDragProps;
};

const DROP: Record<Zone, "before" | "after" | "into"> = { top: "before", bottom: "after", middle: "into" };

export function createSidebarDrag(opts: {
  onCommit: (c: DragCommit) => void;
  onActive?: (active: boolean) => void;
  refuse?: (from: string, to: RowSpot, zone: Zone) => string | null;
}): SidebarDrag {
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [over, setOver] = createSignal<{ key: string; zone: Zone; refused: Refusal | null } | null>(null);

  function end() {
    setDragging(null);
    setOver(null);
    opts.onActive?.(false);
  }
  onCleanup(() => dragging() && end());

  return {
    dragging,
    refused: () => over()?.refused ?? null,
    rowProps: (spot) => ({
      draggable: true,
      onDragStart: (e) => {
        e.stopPropagation();
        const value = (Array.isArray(spot.paths) ? spot.paths : [spot.paths]).filter(Boolean).join("\n");
        if (e.dataTransfer) {
          if (value) {
            e.dataTransfer.setData(DRAG_ABS_PATH_MIME, value);
            e.dataTransfer.setData("text/plain", value);
          }
          e.dataTransfer.effectAllowed = "copyMove";
        }
        setDragging(spot.key);
        opts.onActive?.(true);
      },
      onDragOver: (e) => {
        if (!dragging() || dragging() === spot.key) return;
        // Only a preventDefault here makes the row a drop target at all.
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        const zone = zoneAt(rect.top, rect.height, e.clientY, spot.groupable === true);
        const reason = opts.refuse?.(dragging()!, spot, zone) ?? null;
        if (e.dataTransfer) e.dataTransfer.dropEffect = reason ? "none" : "move";
        setOver({ key: spot.key, zone, refused: reason ? { reason, x: e.clientX, y: e.clientY } : null });
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (over()?.key === spot.key) setOver(null);
      },
      onDrop: (e) => {
        const from = dragging();
        const o = over()?.key === spot.key ? over() : null;
        const zone = o && !o.refused ? o.zone : null;
        e.preventDefault();
        e.stopPropagation();
        end();
        if (!from || from === spot.key || !zone) return;
        const to: DropTo =
          zone === "middle"
            ? { groupWith: spot.key }
            : { section: spot.section, index: zone === "top" ? spot.index : spot.index + 1 };
        opts.onCommit({ from, to });
      },
      onDragEnd: () => end(),
      get "data-dragging"() {
        return dragging() === spot.key ? "" : undefined;
      },
      get "data-drop"() {
        const o = over();
        if (o?.key !== spot.key || !dragging()) return undefined;
        return o.refused ? "refused" : DROP[o.zone];
      },
    }),
  };
}
