import { createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

/** What the surface hangs off, in viewport coordinates. A cursor position is
 *  the degenerate case, where `left` and `right` are the same point. */
export type PopoverAnchor = {
  left: number;
  right: number;
  /** The edge it opens below, or above when `openAbove` is set. */
  top: number;
};

// Kept off every viewport edge by this much.
const PAD = 6;

/**
 * The one anchored, portalled surface. Right-click menus, button dropdowns and
 * the History panel all position through this.
 *
 * **Portalled**, because the bars these hang off are `overflow: hidden` - a long
 * tab strip has to collapse into `+N` rather than scroll - and a child of one is
 * clipped to the bar's own height.
 *
 * **Unpainted until placed.** Its own size is knowable only after a layout pass,
 * so the viewport clamp costs a frame; painting the unclamped position first
 * makes the surface visibly jump into place, which is worst for a right-aligned
 * panel, whose first guess is out by its whole width.
 *
 * That frame is hidden with `opacity`, not `visibility` or `display`: those two
 * take the surface out of the accessibility tree, so a screen reader would lose
 * it exactly as long as the eye does, and it still has to lay out for the
 * measurement to mean anything.
 *
 * Chrome - width, background, z-index - belongs to the caller's own class. This
 * owns position and dismissal, and nothing else.
 */
export default function Popover(props: {
  anchor: PopoverAnchor;
  /** Which edge is pinned: `start` puts the surface's left edge on the anchor's
   *  left, `end` puts its right edge on the anchor's right. */
  align?: "start" | "end";
  /** Open upward from `anchor.top`. For a control near the bottom of the window,
   *  where opening downward means the clamp drags the surface back over the
   *  thing that opened it. */
  openAbove?: boolean;
  /** The toggle that opened it, so its own click is not also read as an outside
   *  click closing what it is trying to toggle. */
  anchorEl?: HTMLElement;
  /** False while something nested owns dismissal - a row's context menu is
   *  portalled elsewhere, so a click or Escape inside it is "outside" this. */
  dismissable?: boolean;
  onClose: () => void;
  class?: string;
  role?: JSX.AriaAttributes["role"];
  "aria-label"?: string;
  onContextMenu?: (e: MouseEvent) => void;
  ref?: (el: HTMLDivElement) => void;
  children: JSX.Element;
}) {
  let el: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ left: props.anchor.left, top: props.anchor.top });
  const [placed, setPlaced] = createSignal(false);

  // The opening anchor is read here, not inside the frame callback: an owner
  // that renders this from a signal it clears on close would leave the callback
  // reading a position that no longer exists. Clamping to where it actually
  // opened is also the only correct answer.
  onMount(() => {
    const at = { ...props.anchor };
    const align = props.align ?? "start";
    const above = props.openAbove;
    requestAnimationFrame(() => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      let left = align === "end" ? at.right - r.width : at.left;
      if (left + r.width > window.innerWidth - PAD) left = window.innerWidth - r.width - PAD;
      let top = above ? at.top - r.height : at.top;
      if (top + r.height > window.innerHeight - PAD) top = window.innerHeight - r.height - PAD;
      setPos({ left: Math.max(PAD, left), top: Math.max(PAD, top) });
      setPlaced(true);
    });
  });

  function onDocMouseDown(e: MouseEvent) {
    if (props.dismissable === false) return;
    const t = e.target as Node;
    if (el?.contains(t) || props.anchorEl?.contains(t)) return;
    props.onClose();
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && props.dismissable !== false) props.onClose();
  }
  onMount(() => {
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", onDocMouseDown);
    document.removeEventListener("keydown", onKeyDown);
  });

  return (
    <Portal>
      <div
        ref={(node) => {
          el = node;
          props.ref?.(node);
        }}
        class={props.class}
        role={props.role}
        aria-label={props["aria-label"]}
        style={{
          left: `${pos().left}px`,
          top: `${pos().top}px`,
          ...(placed() ? null : { opacity: 0, "pointer-events": "none" }),
        }}
        onContextMenu={(e) => props.onContextMenu?.(e)}
      >
        {props.children}
      </div>
    </Portal>
  );
}
