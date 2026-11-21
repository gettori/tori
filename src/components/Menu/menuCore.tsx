import {
  createContext,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  splitProps,
  untrack,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import { anchorLayer, openLayer, pointAnchor, type LayerPlacement } from "../../lib/layer";
import { createTypeahead } from "../../lib/keyboard";
import { callHandler, type TriggerHandler } from "../callHandler";

export type MenuFocus = "content" | "first" | "last" | "none";

type Point = readonly [number, number];

const GRACE_MS = 300;

export const CURSOR_GUTTER = 2;
export const CURSOR_SHIFT = 2;

function insidePolygon([x, y]: Point, polygon: readonly Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface MenuState {
  parent?: MenuState;
  contentId: string;
  isOpen: Accessor<boolean>;
  focusOnOpen: () => MenuFocus;
  open: (focus: MenuFocus) => void;
  close: (recursive?: boolean) => void;
  trigger: Accessor<HTMLElement | undefined>;
  setTrigger: (el: HTMLElement) => void;
  content: Accessor<HTMLElement | undefined>;
  setContent: (el: HTMLElement | undefined) => void;
  highlighted: Accessor<HTMLElement | null>;
  highlight: (row: HTMLElement) => void;
  clearHighlight: () => void;
  focusContent: () => void;
  rows: () => HTMLElement[];
  focusEdge: (edge: "first" | "last") => void;
  setChild: (child: MenuState | undefined) => void;
  setGrace: (polygon: readonly Point[]) => void;
  movingToChild: (e: PointerEvent) => boolean;
}

const MenuContext = createContext<MenuState>();
export const MenuProvider = MenuContext.Provider;

export function useMenu() {
  const menu = useContext(MenuContext);
  if (!menu) throw new Error("A menu part must be rendered inside a menu");
  return menu;
}

export function useParentMenu() {
  return useContext(MenuContext);
}

export function createMenu(options: {
  parent?: MenuState;
  open?: () => boolean | undefined;
  onOpenChange?: (open: boolean) => void;
}): MenuState {
  const [ownOpen, setOwnOpen] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLElement>();
  const [content, setContent] = createSignal<HTMLElement>();
  const [highlighted, setHighlighted] = createSignal<HTMLElement | null>(null);
  let focusOnOpen: MenuFocus = "content";
  let child: MenuState | undefined;
  let grace: readonly Point[] | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(graceTimer));

  const isOpen = () => options.open?.() ?? ownOpen();
  const setOpen = (next: boolean) => {
    if (isOpen() === next) return;
    if (options.open?.() === undefined) setOwnOpen(next);
    options.onOpenChange?.(next);
  };

  const rows = () =>
    Array.from(content()?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])') ?? []);

  const menu: MenuState = {
    parent: options.parent,
    contentId: createUniqueId(),
    isOpen,
    focusOnOpen: () => focusOnOpen,
    open: (focus) => {
      focusOnOpen = focus;
      setOpen(true);
    },
    close: (recursive = false) => {
      setOpen(false);
      if (recursive) options.parent?.close(true);
    },
    trigger,
    setTrigger: (el) => setTrigger(el),
    content,
    setContent: (el) => setContent(el),
    highlighted,
    highlight: (row) => {
      setHighlighted(row);
      row.focus({ preventScroll: true });
      if (child && child.trigger() !== row) child.close();
    },
    clearHighlight: () => setHighlighted(null),
    focusContent: () => {
      child?.close();
      content()?.focus({ preventScroll: true });
      setHighlighted(null);
    },
    rows,
    focusEdge: (edge) => {
      const all = rows();
      const row = edge === "first" ? all[0] : all[all.length - 1];
      if (row) menu.highlight(row);
      else content()?.focus({ preventScroll: true });
    },
    setChild: (next) => {
      child = next;
    },
    setGrace: (polygon) => {
      grace = polygon;
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => (grace = null), GRACE_MS);
    },
    movingToChild: (e) => !!grace && insidePolygon([e.clientX, e.clientY], grace),
  };
  return menu;
}

function inMenuTree(menu: MenuState, target: Node) {
  for (let at: MenuState | undefined = menu; at; at = at.parent) {
    if (at.content()?.contains(target) || at.trigger()?.contains(target)) return true;
  }
  return false;
}

export interface MenuContentProps {
  menu: MenuState;
  placement: LayerPlacement;
  gutter: number;
  shift?: number;
  /** Open at this point instead of off the trigger. */
  point?: () => { x: number; y: number } | undefined;
  returnFocus?: () => HTMLElement | undefined;
  keepFocusOnPress?: boolean;
  labelledBy?: string;
  class?: string;
  children: JSX.Element;
}

// Rendered inside the portal so these effects run once it is connected:
// showPopover throws on a node that is not in the document.
export function MenuContent(props: MenuContentProps) {
  const menu = untrack(() => props.menu);
  let el!: HTMLDivElement;

  const typeahead = createTypeahead({
    keys: () => menu.rows().map((row) => row.id),
    text: (id) => {
      const row = document.getElementById(id);
      return row?.dataset.textValue ?? row?.textContent ?? "";
    },
    current: () => menu.highlighted()?.id,
    onMatch: (id) => {
      const row = document.getElementById(id);
      if (row) menu.highlight(row);
    },
  });

  createEffect(() => {
    const point = props.point?.();
    const anchor = point ? pointAnchor(point.x, point.y) : menu.trigger();
    if (point) onCleanup(() => anchor?.remove());
    if (anchor) onCleanup(anchorLayer(anchor, el, props.placement, props.gutter, props.shift));
  });

  createEffect(() =>
    untrack(() => {
      menu.parent?.setChild(menu);
      const release = openLayer({
        element: el,
        show: () => el.showPopover(),
        hide: () => el.hidePopover(),
        onDismiss: () => menu.close(true),
        ignorePress: (target) => inMenuTree(menu, target),
        dismissOnFocusOutside: true,
        returnFocus: props.returnFocus,
        keepFocusOnPress: props.keepFocusOnPress,
      });
      onCleanup(() => {
        menu.parent?.setChild(undefined);
        menu.setContent(undefined);
        menu.clearHighlight();
        release();
      });
      const focus = menu.focusOnOpen();
      const moveFocus = () => {
        if (!el.isConnected) return;
        if (focus === "first" || focus === "last") menu.focusEdge(focus);
        else if (focus === "content") el.focus({ preventScroll: true });
      };
      // The press's own mousedown moves focus after this, so land behind it.
      if (window.event?.type === "pointerdown") setTimeout(moveFocus);
      else moveFocus();
    }),
  );

  const move = (row: HTMLElement | undefined) => {
    if (!row) return;
    menu.highlight(row);
    row.scrollIntoView?.({ block: "nearest" });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Solid delegates through a portal, so a flyout's keys arrive here as well.
    if (!el.contains(e.target as Node)) return;
    if (e.key === "Tab") {
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowLeft" && menu.parent) {
      e.preventDefault();
      const opener = menu.trigger();
      menu.close();
      if (opener) menu.parent.highlight(opener);
      return;
    }
    const rows = menu.rows();
    const at = rows.indexOf(menu.highlighted() as HTMLElement);
    if (e.key === "ArrowDown") move(rows[at < 0 ? 0 : (at + 1) % rows.length]);
    else if (e.key === "ArrowUp") move(rows[at <= 0 ? rows.length - 1 : at - 1]);
    else if (e.key === "Home") move(rows[0]);
    else if (e.key === "End") move(rows[rows.length - 1]);
    else {
      typeahead(e);
      return;
    }
    e.preventDefault();
  };

  return (
    <div
      ref={(node) => {
        el = node;
        menu.setContent(node);
      }}
      id={menu.contentId}
      popover="manual"
      role="menu"
      tabindex={-1}
      data-expanded=""
      data-orientation="vertical"
      aria-labelledby={props.labelledBy}
      class={props.class}
      onKeyDown={onKeyDown}
      onPointerEnter={() => menu.parent?.clearHighlight()}
      // A right-click inside an open menu would otherwise open the browser's
      // menu on top of this one.
      onContextMenu={(e) => e.preventDefault()}
    >
      {props.children}
    </div>
  );
}

export type MenuItemProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  disabled?: boolean;
  closeOnSelect?: boolean;
  onSelect?: () => void;
  textValue?: string;
  type?: string;
};

export function MenuItem(props: MenuItemProps) {
  const menu = useMenu();
  const id = createUniqueId();
  const [local, others] = splitProps(props, [
    "ref",
    "disabled",
    "closeOnSelect",
    "onSelect",
    "textValue",
    "type",
    "onPointerMove",
    "onPointerLeave",
    "onPointerUp",
    "onKeyDown",
  ]);
  let row!: HTMLDivElement;

  const select = () => {
    local.onSelect?.();
    // After the click this pointerup belongs to, which would otherwise land on
    // whatever sits under the menu.
    if (local.closeOnSelect ?? true) setTimeout(() => menu.close(true), 1);
  };

  return (
    <div
      ref={(el) => {
        row = el;
        (local.ref as ((el: HTMLDivElement) => void) | undefined)?.(el);
      }}
      id={id}
      role="menuitem"
      tabindex={-1}
      aria-disabled={local.disabled ? "true" : undefined}
      data-disabled={local.disabled ? "" : undefined}
      data-highlighted={menu.highlighted() === row ? "" : undefined}
      data-text-value={local.textValue}
      onPointerMove={(e) => {
        callHandler(e, local.onPointerMove as TriggerHandler);
        if (e.pointerType !== "mouse" || menu.movingToChild(e)) return;
        if (local.disabled) menu.focusContent();
        else if (menu.highlighted() !== row) menu.highlight(row);
      }}
      onPointerLeave={(e) => {
        callHandler(e, local.onPointerLeave as TriggerHandler);
        if (e.pointerType === "mouse" && !menu.movingToChild(e)) menu.focusContent();
      }}
      onPointerUp={(e) => {
        callHandler(e, local.onPointerUp as TriggerHandler);
        if (!local.disabled && e.button === 0) select();
      }}
      onKeyDown={(e) => {
        callHandler(e, local.onKeyDown as TriggerHandler);
        if (e.repeat || local.disabled || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        select();
      }}
      {...others}
    />
  );
}
