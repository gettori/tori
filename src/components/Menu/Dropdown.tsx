import { createUniqueId, merge, Show, omit } from "solid-js";
import { type JSX, dynamic, Portal } from "@solidjs/web";
import type { LayerPlacement } from "../../lib/layer";
import { callHandler, type TriggerHandler } from "../callHandler";
import { useDialogSurface } from "../Dialog/surface";
import { createMenu, CURSOR_GUTTER, CURSOR_SHIFT, MenuContent, MenuProvider } from "./menuCore";
import { MenuGlide, MenuRows, type MenuItem } from "./rows";
import { MenuSurface } from "./surface";
import styles from "./Menu.module.css";
import { defined } from "../../lib/props";

/** Where the menu sits relative to its anchor. */
export type MenuPlacement =
  | "bottom-start"
  | "bottom-end"
  | "top-start"
  | "top-end"
  | "right-start"
  | "left-start"
  /** Hung off the trigger's bottom right corner, opening down and right, for a
   *  small button at the end of a row whose menu should not cover the row. */
  | "corner";

/** The gutter between a trigger and its menu, in px. */
const TRIGGER_GUTTER = 4;

/** A cursor as an anchor. Takes `undefined` because a menu closing by clearing
 *  its `anchor` and its `open` in one update can be read once more in between.
 *  Exported so `Dropdown.test.tsx` can pin the mapping, which jsdom cannot show. */
export function cursorRect(anchor: { x: number; y: number } | undefined) {
  return { x: anchor?.x ?? 0, y: anchor?.y ?? 0 };
}

export interface DropdownProps<T extends HTMLElement = HTMLButtonElement> extends JSX.ButtonHTMLAttributes<T> {
  /** A flat menu, the common case. Ignored when `menu` is given. */
  items?: MenuItem[];
  /** Custom rows (`MenuRow`, `MenuSeparator`), for a menu whose entries carry
   *  more than a label. */
  menu?: JSX.Element;
  /** Open at a point instead of off a trigger, for the one surface that has no
   *  trigger element to hang off: CodeEditor's code-action menu at the caret.
   *  Requires `open`, since there is nothing to toggle. */
  anchor?: { x: number; y: number };
  /** Controlled open state. Optional in trigger mode, required in anchor
   *  mode. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: MenuPlacement;
  /** The element the trigger renders as. A tag name, not a component, for the
   *  reason `Tooltip`'s `as` documents. */
  as?: keyof JSX.HTMLElementTags;
  /** The trigger is a *wrapper* around a control that is already interactive,
   *  rather than being the control itself. A non-`button` trigger is otherwise a
   *  `role="button"` with `tabindex="0"`, and a button inside a button is two tab
   *  stops and one nested control. */
  wrapper?: boolean;
  /** What the menu portals into. Defaults to the enclosing dialog's panel when
   *  there is one, and to `document.body` otherwise. */
  mount?: HTMLElement;
  /** The trigger's own content. Absent in anchor mode. */
  children?: JSX.Element;
}

/**
 * The triggered surface. Everything not listed above is a native attribute and
 * lands on the trigger, so a call site reads as the button it already was plus
 * an `items`. Shares its rows, its stylesheet and its behaviour with
 * `ContextMenu`; what differs is where the menu is anchored.
 *
 * **Anchor mode has no trigger at all.** A menu driven from app state and placed
 * at a point, for CodeEditor's caret menu. Focus goes back to whatever the menu
 * interrupted, so the next keystroke lands in the editor.
 */
export default function Dropdown<T extends HTMLElement = HTMLButtonElement>(props: DropdownProps<T>) {
  const trigger = omit(props, "items", "menu", "anchor", "open", "onOpenChange", "placement", "as", "wrapper", "mount");
  const handlers = trigger as DropdownProps<HTMLButtonElement>;
  const rest = omit(handlers, "ref", "id", "disabled", "onPointerDown", "onClick", "onKeyDown");

  const dialogSurface = useDialogSurface();
  const mount = () => props.mount ?? dialogSurface();
  const atCursor = () => props.anchor != null;
  const fallbackId = createUniqueId();
  const triggerId = () => (handlers.id ?? fallbackId) as string;
  const tag = () => props.as ?? "button";
  const isButton = () => tag() === "button";

  const menu = createMenu({ open: () => props.open, onOpenChange: (open) => props.onOpenChange?.(open) });
  let pointerType = "";

  const placement = (): LayerPlacement =>
    props.placement === "corner" ? "corner" : (props.placement ?? (atCursor() ? "right-start" : "bottom-start"));

  const toggle = () => (menu.isOpen() ? menu.close() : menu.open("content"));

  const behaviour = {
    ref: (el: HTMLElement) => {
      menu.setTrigger(el);
      (handlers.ref as ((el: HTMLElement) => void) | undefined)?.(el);
    },
    get id() {
      return triggerId();
    },
    get type() {
      return isButton() ? "button" : undefined;
    },
    get role() {
      return isButton() ? undefined : "button";
    },
    get tabindex() {
      return isButton() || handlers.disabled ? undefined : 0;
    },
    get disabled() {
      return isButton() ? handlers.disabled : undefined;
    },
    get "aria-disabled"() {
      return !isButton() && handlers.disabled ? true : undefined;
    },
    get "data-disabled"() {
      return handlers.disabled ? "" : undefined;
    },
    "aria-haspopup": "true",
    get "aria-expanded"() {
      return menu.isOpen();
    },
    get "aria-controls"() {
      return menu.isOpen() ? menu.contentId : undefined;
    },
    get "data-expanded"() {
      return menu.isOpen() ? "" : undefined;
    },
    get "data-closed"() {
      return menu.isOpen() ? undefined : "";
    },
    onPointerDown: (e: PointerEvent) => {
      callHandler(e, handlers.onPointerDown as TriggerHandler);
      pointerType = e.pointerType;
      if (!handlers.disabled && e.pointerType !== "touch" && e.button === 0) toggle();
    },
    onClick: (e: MouseEvent) => {
      callHandler(e, handlers.onClick as TriggerHandler);
      if (!handlers.disabled && pointerType === "touch") toggle();
    },
    onKeyDown: (e: KeyboardEvent) => {
      callHandler(e, handlers.onKeyDown as TriggerHandler);
      if (handlers.disabled) return;
      if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.stopPropagation();
      e.preventDefault();
      menu.open(e.key === "ArrowUp" ? "last" : "first");
    },
  };

  // The keys have to be absent in the normal case, where the values above are
  // the right ones. `group` rather than `presentation`, which forbids the
  // `aria-haspopup` and `aria-expanded` this element still carries.
  const notAControl = () => (props.wrapper ? { role: "group", tabindex: -1 } : {});
  const triggerProps = merge(
    behaviour,
    notAControl,
    defined(rest),
  ) as unknown as JSX.ButtonHTMLAttributes<HTMLButtonElement>;

  const Control = dynamic(() => tag());
  return (
    // Published rather than only used here: a flyout inside this menu is its own
    // portal and mounts where the menu it belongs to does. See `surface.ts`.
    <MenuSurface value={mount}>
      <MenuProvider value={menu}>
        <Show when={!atCursor()}>
          <Control {...triggerProps} />
        </Show>
        <Show when={menu.isOpen()}>
          <Portal mount={mount()}>
            <MenuContent
              menu={menu}
              placement={placement()}
              gutter={atCursor() ? CURSOR_GUTTER : props.placement === "corner" ? 0 : TRIGGER_GUTTER}
              shift={atCursor() ? CURSOR_SHIFT : 0}
              point={atCursor() ? () => cursorRect(props.anchor) : undefined}
              returnFocus={atCursor() ? undefined : menu.trigger}
              labelledBy={atCursor() ? undefined : triggerId()}
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
