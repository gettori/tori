import { splitProps, type JSX } from "solid-js";
import { ContextMenu as Primitive } from "../../lib/menu";
import { useDialogSurface } from "../Dialog/surface";
import { MenuRows, type MenuItem } from "./rows";
import { MenuSurface } from "./surface";
import styles from "./Menu.module.css";

export interface ContextMenuProps<T extends HTMLElement = HTMLDivElement>
  extends Omit<JSX.HTMLAttributes<T>, "onContextMenu"> {
  /** Runs before the menu opens, and can stop it: Kobalte's trigger calls this
   *  first and bails if it finds the event already prevented.
   *
   *  Re-declared rather than inherited because Solid types the native attribute
   *  against `PointerEvent` and Kobalte's trigger against `MouseEvent`, which do
   *  not unify. The narrower one is the honest signature here: this handler only
   *  ever sees the `contextmenu` event Kobalte passes it. */
  onContextMenu?: JSX.EventHandlerUnion<T, MouseEvent>;
  /** A flat menu, the common case. Ignored when `menu` is given. */
  items?: MenuItem[];
  /** Custom rows (`MenuRow`, `MenuSeparator`), for a menu whose entries carry
   *  more than a label. */
  menu?: JSX.Element;
  /** The element the trigger renders as. A tag name, not a component: the
   *  trigger has to *be* the row, for the same reason `Tooltip`'s does - a Solid
   *  JSX element is already-constructed DOM and nothing can inject the trigger's
   *  handlers into it afterwards. */
  as?: keyof JSX.HTMLElementTags;
  /** Leave the right-click alone entirely, so the browser's own menu opens.
   *  Kobalte's trigger returns before `preventDefault()` when this is set, which
   *  is exactly the shape of the Editor's synthetic-tab case. */
  disabled?: boolean;
  /** Opt in to Kobalte's modality: scroll lock, focus trap, and `aria-hidden` on
   *  everything outside. Off by default, see the module comment. */
  modal?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What the menu portals into. Defaults to the enclosing dialog's panel when
   *  there is one, and to `document.body` otherwise. */
  mount?: HTMLElement;
  /** The trigger's own content: the row as it was before it had a menu. */
  children?: JSX.Element;
}

/**
 * The right-click surface: Kobalte's context menu behind Tori's chrome and
 * Tori's API. Everything not listed above is a native attribute and lands on the
 * trigger, so a call site reads as the row it already was plus an `items`.
 *
 * **The trigger is the row, and it is per-row.** A context menu owns its own
 * cursor placement through its trigger - `ContextMenuRootOptions` is
 * `Omit<MenuRootOptions, "open" | "defaultOpen" | "getAnchorRect">`, so there is
 * no controlled mode and no anchor to hand it - which means every row that wants
 * a menu wraps itself in one of these. That is affordable here because nothing
 * in Tori's trees is virtualized and every row already computes its own items in
 * its own handler. A surface that needs one menu driven from state instead wants
 * `Dropdown`'s anchor mode.
 *
 * **Non-modal by default.** Kobalte defaults `modal: true`, and `preventScroll`
 * defaults to `isModal()`, so accepting the default would add a scroll lock, a
 * focus trap and `ariaHideOutside` to surfaces that have never had any of them.
 * The sharpest case is HistoryPanel, whose row menus live *inside* the popover
 * they belong to: a modal row menu would aria-hide its own panel. Dismissal does
 * not depend on modality - the dismissable layer handles Escape and outside
 * pointerdown either way - so the default costs nothing and `modal` is there for
 * a surface that genuinely wants to trap.
 *
 * **`onOpenChange` is exposed rather than swallowed.** An enclosing surface may
 * need to know a row menu is open: HistoryPanel holds its own popover open and
 * gates its document-level arrow handler on it.
 *
 * **Nesting needs nothing from the call site.** Kobalte's trigger calls
 * `stopPropagation()` on the right-click it claims, so a row inside a row opens
 * its own menu and not its parent's - which is what the hand-rolled menus each
 * wrote a manual `stopPropagation` for. A caller's own `onContextMenu` still
 * runs, and runs *first*: Kobalte bails when it finds the event already
 * prevented, so a row that wants the browser's menu conditionally can say so
 * there rather than toggling `disabled`.
 */
export default function ContextMenu<T extends HTMLElement = HTMLDivElement>(
  props: ContextMenuProps<T>,
) {
  const [local, trigger] = splitProps(props, [
    "items",
    "menu",
    "as",
    "disabled",
    "modal",
    "onOpenChange",
    "mount",
  ]);

  const dialogSurface = useDialogSurface();
  const mount = () => local.mount ?? dialogSurface();

  // The same cast `Tooltip` documents: `T` buys the caller precise handler
  // types, and it is exactly that precision the polymorphic host cannot accept.
  // Confined to this line; `trigger` is the same props object either way.
  const triggerProps = trigger as ContextMenuProps<HTMLDivElement>;

  return (
    // Published rather than only used here: a flyout inside this menu is its own
    // portal and mounts where the menu it belongs to does. See `surface.ts`.
    <MenuSurface.Provider value={mount}>
      <Primitive.Root
        modal={local.modal ?? false}
        onOpenChange={local.onOpenChange}
      >
        <Primitive.Trigger
          as={local.as ?? "div"}
          disabled={local.disabled}
          {...triggerProps}
        />
        <Primitive.Portal mount={mount()}>
          <Primitive.Content
            class={styles.content}
            // A right-click *inside* an open menu would otherwise open the
            // browser's menu on top of Tori's. The hand-rolled Menu did the same.
            onContextMenu={(e: MouseEvent) => e.preventDefault()}
          >
            {local.menu ?? <MenuRows items={local.items ?? []} />}
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </MenuSurface.Provider>
  );
}
