// One drag-to-reorder gesture, shared by the sidebar's member rows and the
// Toolbar's chip row so the two cannot disagree about what a drop means. The
// carried key lives in a signal rather than in `dataTransfer`: the drop only
// ever lands inside the same list, and reading it back is what would tie this
// to a MIME type every other drag source in the app would then have to avoid.

import { createSignal, onCleanup, type JSX } from "solid-js";

/** `key` moved to where `target` sits, as a new key order. Move up and Move
 *  down commit the same call with the neighbour as the target, so the keyboard
 *  route and the drag cannot disagree about the result. */
export function moveKey(keys: readonly string[], key: string, target: string): string[] {
  const from = keys.indexOf(key);
  const to = keys.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...keys];
  const next = keys.slice();
  next.splice(from, 1);
  next.splice(to, 0, key);
  return next;
}

/** What a row spreads onto itself. Static by design: the reactive part is
 *  `dragging()` and `over()`, which a call site reads in a `classList`. */
export type DragRowProps = {
  draggable: true;
  onDragStart: JSX.EventHandler<HTMLElement, DragEvent>;
  onDragOver: JSX.EventHandler<HTMLElement, DragEvent>;
  onDrop: JSX.EventHandler<HTMLElement, DragEvent>;
  onDragEnd: JSX.EventHandler<HTMLElement, DragEvent>;
};

export type DragReorder = {
  /** The key being carried, for a row that wants to say so. */
  dragging: () => string | null;
  /** The key a drop would land on. */
  over: () => string | null;
  rowProps: (key: string) => DragRowProps;
  /** True for the click a finished drag ends with. A drag is a press that never
   *  becomes a click, but only where the browser agrees; a row whose click does
   *  something else (the Toolbar chip switches the active root) asks here. */
  fromDrag: () => boolean;
};

export function createDragReorder(opts: {
  keys: () => string[];
  onCommit: (keys: string[]) => void;
}): DragReorder {
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [over, setOver] = createSignal<string | null>(null);
  let settle: ReturnType<typeof setTimeout> | undefined;
  let recent = false;

  function end() {
    setDragging(null);
    setOver(null);
    recent = true;
    clearTimeout(settle);
    settle = setTimeout(() => (recent = false), 0);
  }

  onCleanup(() => clearTimeout(settle));

  return {
    dragging,
    over,
    fromDrag: () => recent,
    rowProps: (key) => ({
      draggable: true,
      onDragStart: (e) => {
        e.stopPropagation();
        setDragging(key);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      },
      onDragOver: (e) => {
        if (!dragging() || dragging() === key) return;
        // Only a preventDefault here makes the element a drop target at all.
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        setOver(key);
      },
      onDrop: (e) => {
        const from = dragging();
        e.preventDefault();
        e.stopPropagation();
        end();
        if (!from || from === key) return;
        opts.onCommit(moveKey(opts.keys(), from, key));
      },
      onDragEnd: () => end(),
    }),
  };
}
