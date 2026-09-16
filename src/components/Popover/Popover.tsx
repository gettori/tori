import { onCleanup, onMount, type JSX } from "solid-js";
import { Popover as Primitive } from "../../lib/popover";
import styles from "./Popover.module.css";

/** Where the surface sits relative to its anchor. Kobalte accepts twelve
 *  placements; these four are what an anchored panel uses, and keeping the
 *  union local is what lets this file expose a placement type without the app
 *  importing one from the primitives package - which `boundary.test.ts` would
 *  fail it for, this file included. */
export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

/** The gap between the anchor and the surface, in px. Not a token: Kobalte
 *  takes a number and hands it to floating-ui, so it never reaches CSS and
 *  cannot read `--ui-scale`. 12 is the offset the hand-rolled panel opened at
 *  (`r.bottom + 12`), restated rather than re-derived. */
const ANCHOR_GUTTER = 12;

/**
 * The anchored panel surface: Kobalte's popover behind Tori's chrome and Tori's
 * API. The menus have their own pair of wrappers (`Menu/`); this is for a panel
 * with arbitrary content that hangs off a control, and its one consumer is the
 * History dropdown.
 *
 * **Anchored controlled mode, and mounted is open.** There is no `Trigger`: the
 * opening button belongs to the caller, which mounts this inside a `<Show>`
 * while it is open. Kobalte's open state therefore never transitions while the
 * surface exists - Escape and outside presses arrive as `onOpenChange(false)`,
 * the caller flips its own signal, and the whole tree unmounts still "open".
 *
 * **Focus is owned here, at both ends.** On open, Kobalte's autofocus is
 * prevented and redirected to `initialFocus`, so the caller decides what the
 * keyboard lands on rather than whichever focusable happens to render first.
 * On close, the element focused at mount is restored from `onCleanup`, not
 * `onCloseAutoFocus`: the close pipeline that hook belongs to only runs on an
 * open-to-closed transition Kobalte gets to see, and unmounting is not one.
 *
 * **The anchor's own press is excluded from dismissal.** Kobalte excludes only
 * its `Trigger`, and in anchor mode there is none, so without this a press on
 * the toggle would dismiss the surface and the button's own click would reopen
 * it in the same gesture. The exclusion covers focus too: shift-tabbing back
 * onto the anchor is not leaving.
 *
 * Chrome is split: this owns the base surface (background, border, shadow,
 * z-index, in `Popover.module.css`), the caller's `class` adds layout.
 */
export default function Popover(props: {
  /** The control the surface hangs off. Kobalte anchors to it directly, and a
   *  press on it is the control's own to interpret rather than an outside
   *  dismissal - see the module comment. */
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
}) {
  onMount(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    onCleanup(() => returnTo?.focus?.());
  });

  return (
    <Primitive.Root
      open
      modal={false}
      placement={props.placement ?? "bottom-end"}
      gutter={ANCHOR_GUTTER}
      anchorRef={() => props.anchorEl}
      onOpenChange={(isOpen) => {
        if (!isOpen) props.onClose();
      }}
    >
      <Primitive.Portal>
        <Primitive.Content
          class={[styles.surface, props.class].filter(Boolean).join(" ")}
          aria-label={props["aria-label"]}
          ref={props.ref}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            props.initialFocus?.()?.focus();
          }}
          onInteractOutside={(e) => {
            const target = e.detail.originalEvent.target as Node | null;
            if (target && props.anchorEl?.contains(target)) e.preventDefault();
          }}
        >
          {props.children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
