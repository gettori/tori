import { Show, splitProps, type JSX } from "solid-js";
import { DropdownMenu as Primitive } from "../../lib/menu";
import { useDialogSurface } from "../Dialog/surface";
import { MenuRows, type MenuItem } from "./rows";
import styles from "./Menu.module.css";

/** Where the menu sits relative to its anchor. Kobalte accepts twelve
 *  placements; these are the ones Sway's dropdowns use, and keeping the union
 *  local is what lets this file expose a placement type without the app
 *  importing one from the primitives package - which `boundary.test.ts` would
 *  fail it for, this file included. */
export type MenuPlacement =
  | "bottom-start"
  | "bottom-end"
  | "top-start"
  | "top-end"
  | "right-start"
  | "left-start";

/** The gutter between a trigger and its menu, in px. Not a token: Kobalte takes
 *  a number and passes it to floating-ui, so it never reaches CSS and cannot
 *  read `--ui-scale`. 4px is the reference's value (adr_solid_ui_reference). */
const TRIGGER_GUTTER = 4;
/** Kobalte's own context-menu offsets, restated here because the anchor mode is
 *  a cursor-placed menu with no trigger and should read identically to one. */
const CURSOR_GUTTER = 2;
const CURSOR_SHIFT = 2;

/** A cursor as an anchor: a point, not a box, which is the same two-field rect
 *  Kobalte's own context menu hands its popper.
 *
 *  Takes `undefined` because the popper asks for the rect on its own schedule,
 *  not the caller's: a menu closing by clearing its `anchor` and its `open` in
 *  one update can be asked once more in between. The origin is the honest answer
 *  for a menu that is on its way out, and the alternative is a throw.
 *
 *  Exported only so `Dropdown.test.tsx` can pin the mapping. jsdom gives
 *  floating-ui no geometry at all - the positioner reads `top: 0; left: 0`
 *  whatever it is anchored to - so there is no rendered value an x/y swap would
 *  show up in, and the alternative to this is no guard. */
export function cursorRect(anchor: { x: number; y: number } | undefined) {
  return { x: anchor?.x ?? 0, y: anchor?.y ?? 0 };
}

export interface DropdownProps<T extends HTMLElement = HTMLButtonElement>
  extends JSX.ButtonHTMLAttributes<T> {
  /** A flat menu, the common case. Ignored when `menu` is given. */
  items?: MenuItem[];
  /** Custom rows (`MenuRow`, `MenuSeparator`), for a menu whose entries carry
   *  more than a label. */
  menu?: JSX.Element;
  /** Open at a point instead of off a trigger, for the one surface that has no
   *  trigger element to hang off: CodeEditor's code-action menu at the caret.
   *  Requires `open`, since there is nothing for Kobalte to toggle. */
  anchor?: { x: number; y: number };
  /** Controlled open state. Optional in trigger mode, required in anchor
   *  mode. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: MenuPlacement;
  /** Opt in to Kobalte's modality: scroll lock, focus trap, and `aria-hidden` on
   *  everything outside. Off by default, see `ContextMenu`'s module comment. */
  modal?: boolean;
  /** The element the trigger renders as. A tag name, not a component, for the
   *  reason `Tooltip`'s `as` documents. */
  as?: keyof JSX.HTMLElementTags;
  /** What the menu portals into. Defaults to the enclosing dialog's panel when
   *  there is one, and to `document.body` otherwise. */
  mount?: HTMLElement;
  /** The trigger's own content. Absent in anchor mode. */
  children?: JSX.Element;
}

/**
 * The triggered surface: Kobalte's dropdown menu behind Sway's chrome and Sway's
 * API. Everything not listed above is a native attribute and lands on the
 * trigger, so a call site reads as the button it already was plus an `items`.
 *
 * Shares its rows, its stylesheet and its non-modal default with `ContextMenu`;
 * what differs is where the menu is anchored, and that is the whole reason there
 * are two wrappers rather than one. See `src/lib/menu.ts` on the asymmetry.
 *
 * **Anchor mode has no trigger at all.** `DropdownMenu.Root` accepts both `open`
 * and `getAnchorRect`, which `ContextMenu.Root` explicitly omits, so a menu
 * driven entirely from app state and placed at a point is possible here and
 * nowhere else. This is how Kobalte's own context menu is built internally - a
 * signal of `{x, y}` handed straight to `getAnchorRect` - so the offsets below
 * are its numbers rather than invented ones, and a caret menu reads exactly like
 * a right-click menu.
 *
 * **Focus restore in anchor mode is ours,** for the reason `Dialog`'s is: on
 * close Kobalte focuses its `Trigger`, and in anchor mode there is none, so the
 * default restore is a no-op and focus would land on `<body>`. For CodeEditor
 * that means the next keystroke goes nowhere instead of back into the editor.
 * The element focused at open time is captured and restored here. Trigger mode
 * needs none of this: Kobalte's own restore has something to aim at.
 */
export default function Dropdown<T extends HTMLElement = HTMLButtonElement>(
  props: DropdownProps<T>,
) {
  const [local, trigger] = splitProps(props, [
    "items",
    "menu",
    "anchor",
    "open",
    "onOpenChange",
    "placement",
    "modal",
    "as",
    "mount",
  ]);

  const dialogSurface = useDialogSurface();
  const mount = () => local.mount ?? dialogSurface();
  const atCursor = () => local.anchor != null;

  // The same cast `Tooltip` documents: `T` buys the caller precise handler
  // types, and it is exactly that precision the polymorphic host cannot accept.
  const triggerProps = trigger as DropdownProps<HTMLButtonElement>;

  let restoreTo: HTMLElement | null = null;

  function onOpenAutoFocus() {
    if (!atCursor()) return;
    // Dispatched before Kobalte focuses anything, so the active element is still
    // whatever the menu interrupted. Not prevented: the menu still wants focus,
    // this only records where to hand it back.
    const previous = document.activeElement;
    restoreTo =
      previous instanceof HTMLElement && previous !== document.body
        ? previous
        : null;
  }

  function onCloseAutoFocus(e: Event) {
    if (!atCursor()) return;
    // Already prevented means something outside deliberately took focus; leave
    // it where it is.
    if (e.defaultPrevented) {
      restoreTo = null;
      return;
    }
    e.preventDefault();
    restoreTo?.focus({ preventScroll: true });
    restoreTo = null;
  }

  return (
    <Primitive.Root
      modal={local.modal ?? false}
      open={local.open}
      onOpenChange={local.onOpenChange}
      placement={local.placement ?? (atCursor() ? "right-start" : "bottom-start")}
      gutter={atCursor() ? CURSOR_GUTTER : TRIGGER_GUTTER}
      shift={atCursor() ? CURSOR_SHIFT : undefined}
      // Floating-ui treats the point as a zero-size anchor and flips or slides
      // the menu against the viewport from there.
      getAnchorRect={atCursor() ? () => cursorRect(local.anchor) : undefined}
    >
      <Show when={!atCursor()}>
        <Primitive.Trigger as={local.as ?? "button"} {...triggerProps} />
      </Show>
      <Primitive.Portal mount={mount()}>
        <Primitive.Content
          class={styles.content}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          // A right-click inside an open menu would otherwise open the browser's
          // menu on top of Sway's. The hand-rolled Menu did the same.
          onContextMenu={(e: MouseEvent) => e.preventDefault()}
        >
          {local.menu ?? <MenuRows items={local.items ?? []} />}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
