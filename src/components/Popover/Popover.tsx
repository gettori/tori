import { createEffect, onCleanup, untrack, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { anchorLayer, openLayer } from "../../lib/layer";
import { useDialogSurface } from "../Dialog/surface";
import styles from "./Popover.module.css";

/** Where the surface sits relative to its anchor. */
export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

/** The gap between the anchor and the surface, in px. */
const ANCHOR_GUTTER = 12;

interface PopoverProps {
  /** The control the surface hangs off. A press on it is the control's own to
   *  interpret rather than an outside dismissal. With none, the surface stays
   *  in its mount as plain content, which is how the FirstRun art shows it. */
  anchorEl?: HTMLElement;
  placement?: PopoverPlacement;
  /** What takes focus when the surface opens. An accessor, because the caller's
   *  ref is not assigned until the surface's children have rendered. */
  initialFocus?: () => HTMLElement | undefined;
  onClose: () => void;
  class?: string;
  "aria-label"?: string;
  /** The content element, for callers that scroll or query inside it. */
  ref?: (el: HTMLDivElement) => void;
  children: JSX.Element;
}

// Its own component so these effects run after the portal has connected it:
// showPopover throws on a node that is not in the document.
function Surface(props: PopoverProps) {
  let content!: HTMLDivElement;
  const anchored = untrack(() => props.anchorEl !== undefined);

  createEffect(() => {
    const anchor = props.anchorEl;
    if (anchor) onCleanup(anchorLayer(anchor, content, props.placement ?? "bottom-end", ANCHOR_GUTTER));
  });

  createEffect(() =>
    untrack(() => {
      if (!anchored) {
        props.initialFocus?.()?.focus();
        return;
      }
      const release = openLayer({
        element: content,
        show: () => content.showPopover(),
        hide: () => content.hidePopover(),
        onDismiss: () => props.onClose(),
        ignorePress: (target) => !!props.anchorEl?.contains(target),
        dismissOnFocusOutside: true,
      });
      onCleanup(release);
      props.initialFocus?.()?.focus();
    }),
  );

  return (
    <div
      ref={(el) => {
        content = el;
        props.ref?.(el);
      }}
      popover={anchored ? "manual" : undefined}
      role="dialog"
      tabindex={-1}
      data-expanded=""
      class={[styles.surface, props.class].filter(Boolean).join(" ")}
      aria-label={props["aria-label"]}
    >
      {props.children}
    </div>
  );
}

/**
 * The anchored panel surface. The menus have their own pair of wrappers
 * (`Menu/`); this is for a panel with arbitrary content that hangs off a
 * control. The caller mounts it inside a `<Show>` while it is open, so mounted
 * is open, and every dismissal arrives as `onClose`.
 *
 * Inside a dialog it portals into the panel, because a modal hides whatever is
 * outside its panel from assistive tech (`Dialog/surface.ts`).
 *
 * Chrome is split: this owns the base surface (background, border, shadow, in
 * `Popover.module.css`), the caller's `class` adds layout.
 */
export default function Popover(props: PopoverProps) {
  const dialogSurface = useDialogSurface();
  return (
    <Portal mount={dialogSurface()}>
      <Surface {...props} />
    </Portal>
  );
}
