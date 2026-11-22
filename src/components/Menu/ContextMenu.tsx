import { createSignal, createUniqueId, merge, onCleanup, Show, omit } from "solid-js";
import { type JSX, dynamic, Portal } from "@solidjs/web";
import { callHandler, type TriggerHandler } from "../callHandler";
import { useDialogSurface } from "../Dialog/surface";
import { createMenu, CURSOR_GUTTER, CURSOR_SHIFT, MenuContent, MenuProvider } from "./menuCore";
import { MenuGlide, MenuRows, type MenuItem } from "./rows";
import { MenuSurface } from "./surface";
import styles from "./Menu.module.css";
import { defined } from "../../lib/props";

export interface ContextMenuProps<T extends HTMLElement = HTMLDivElement> extends Omit<
  JSX.HTMLAttributes<T>,
  "onContextMenu"
> {
  /** Runs before the menu opens, and can stop it by preventing the event.
   *
   *  Re-declared because Solid types the native attribute against `PointerEvent`,
   *  and this handler only ever sees a `contextmenu` `MouseEvent`. */
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
  /** Leave the right-click alone entirely, so the browser's own menu opens. */
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What the menu portals into. Defaults to the enclosing dialog's panel when
   *  there is one, and to `document.body` otherwise. */
  mount?: HTMLElement;
  /** The trigger's own content: the row as it was before it had a menu. */
  children?: JSX.Element;
}

const LONG_PRESS_MS = 700;

const isTouchOrPen = (e: PointerEvent) => e.pointerType === "touch" || e.pointerType === "pen";

/**
 * The right-click surface. Everything not listed above is a native attribute and
 * lands on the trigger, so a call site reads as the row it already was plus an
 * `items`.
 *
 * **The trigger is the row, and it is per-row.** Every row that wants a menu
 * wraps itself in one of these. A surface that needs one menu driven from state
 * instead wants `Dropdown`'s anchor mode.
 *
 * **Not modal.** HistoryPanel's row menus live inside the popover they belong to,
 * so a modal one would hide its own panel.
 *
 * **`onOpenChange` is exposed rather than swallowed.** HistoryPanel holds its
 * popover open and gates its document-level arrow handler on it.
 *
 * **Nesting needs nothing from the call site.** The trigger stops the right-click
 * it claims, so a row inside a row opens its own menu and not its parent's. A
 * caller's `onContextMenu` runs first, and preventing the event there leaves the
 * browser's menu to open.
 */
export default function ContextMenu<T extends HTMLElement = HTMLDivElement>(props: ContextMenuProps<T>) {
  const trigger = omit(props, "items", "menu", "as", "disabled", "onOpenChange", "mount");
  const handlers = trigger as ContextMenuProps<HTMLDivElement>;
  const rest = omit(
    handlers,
    "ref",
    "style",
    "onContextMenu",
    "onPointerDown",
    "onPointerMove",
    "onPointerCancel",
    "onPointerUp",
  );

  const dialogSurface = useDialogSurface();
  const mount = () => props.mount ?? dialogSurface();
  const menu = createMenu({ onOpenChange: (open) => props.onOpenChange?.(open) });
  const [point, setPoint] = createSignal({ x: 0, y: 0 });

  let longPress: ReturnType<typeof setTimeout> | undefined;
  const cancelLongPress = () => clearTimeout(longPress);
  onCleanup(cancelLongPress);

  const behaviour = {
    id: `contextmenu-${createUniqueId()}-trigger`,
    ref: (el: HTMLElement) => {
      menu.setTrigger(el);
      (handlers.ref as ((el: HTMLElement) => void) | undefined)?.(el);
    },
    get style() {
      const style = handlers.style;
      return typeof style === "string"
        ? `-webkit-touch-callout: none; ${style}`
        : { "-webkit-touch-callout": "none", ...style };
    },
    get "data-disabled"() {
      return props.disabled ? "" : undefined;
    },
    get "data-expanded"() {
      return menu.isOpen() ? "" : undefined;
    },
    get "data-closed"() {
      return menu.isOpen() ? undefined : "";
    },
    onContextMenu: (e: MouseEvent) => {
      callHandler(e, handlers.onContextMenu as TriggerHandler);
      if (props.disabled || e.defaultPrevented) return;
      cancelLongPress();
      e.preventDefault();
      e.stopPropagation();
      setPoint({ x: e.clientX, y: e.clientY });
      if (menu.isOpen()) menu.focusContent();
      else menu.open("content");
    },
    onPointerDown: (e: PointerEvent) => {
      callHandler(e, handlers.onPointerDown as TriggerHandler);
      if (props.disabled || !isTouchOrPen(e)) return;
      cancelLongPress();
      setPoint({ x: e.clientX, y: e.clientY });
      longPress = setTimeout(() => menu.open("none"), LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      callHandler(e, handlers.onPointerMove as TriggerHandler);
      if (isTouchOrPen(e)) cancelLongPress();
    },
    onPointerCancel: (e: PointerEvent) => {
      callHandler(e, handlers.onPointerCancel as TriggerHandler);
      if (isTouchOrPen(e)) cancelLongPress();
    },
    onPointerUp: (e: PointerEvent) => {
      callHandler(e, handlers.onPointerUp as TriggerHandler);
      if (isTouchOrPen(e)) cancelLongPress();
    },
  };

  const triggerProps = merge(behaviour, defined(rest)) as unknown as JSX.HTMLAttributes<HTMLDivElement>;

  const Control = dynamic(() => props.as ?? "div");
  return (
    // Published rather than only used here: a flyout inside this menu is its own
    // portal and mounts where the menu it belongs to does. See `surface.ts`.
    <MenuSurface value={mount}>
      <MenuProvider value={menu}>
        <Control {...triggerProps} />
        <Show when={menu.isOpen()}>
          <Portal mount={mount()}>
            <MenuContent
              menu={menu}
              placement="right-start"
              gutter={CURSOR_GUTTER}
              shift={CURSOR_SHIFT}
              point={point}
              keepFocusOnPress
              class={styles.content}
            >
              <MenuGlide />
              {props.menu ?? <MenuRows items={props.items ?? []} />}
            </MenuContent>
          </Portal>
        </Show>
      </MenuProvider>
    </MenuSurface>
  );
}
