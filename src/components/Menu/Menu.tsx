import { For, onCleanup, onMount, createSignal, createContext, useContext, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import styles from "./Menu.module.css";

// A menu entry: an action row, or a visual separator. Covers the flat cases
// (right-click menus, button dropdowns). Rows that need custom content (icons,
// a close button) are expressed as <MenuRow> children instead.
export type MenuItem =
  | { separator: true }
  | { label: string; onClick: () => void; danger?: boolean; warn?: boolean; disabled?: boolean };

// Where the menu opens and what it shows. Held by the caller as a signal that is
// set on open and cleared on close.
export type MenuState = { x: number; y: number; items: MenuItem[] };

// Lets <MenuRow> close the menu when picked without every caller threading the
// close callback down to each row.
const MenuCloseContext = createContext<() => void>(() => {});

// A single custom menu row, for callers whose rows carry more than a label
// (icon + name + trailing controls). Closes the menu, then runs its action.
export function MenuRow(props: {
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  warn?: boolean;
  children: JSX.Element;
}) {
  const close = useContext(MenuCloseContext);
  return (
    <div
      class={styles.menuItem}
      classList={{ [styles.danger]: !!props.danger, [styles.warn]: !!props.warn, [styles.disabled]: !!props.disabled }}
      onClick={() => {
        if (props.disabled) return;
        close();
        props.onClick?.();
      }}
    >
      {props.children}
    </div>
  );
}

// The one portaled, viewport-overflow-safe menu. Positioned at (x, y) with edge
// clamping (flip back from the right/bottom edge rather than overflow), and
// escape / outside-click close. Feed a flat `items` list, or custom rows as
// children (<MenuRow>). Pass `anchorEl` for a toggle button so an outside-click
// on the button doesn't fight the button's own open/close.
export default function Menu(props: {
  x: number;
  y: number;
  onClose: () => void;
  items?: MenuItem[];
  anchorEl?: HTMLElement;
  children?: JSX.Element;
}) {
  let el: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ left: props.x, top: props.y });

  // The menu's own size is known only after mount, so clamp it into the viewport
  // then (flip back from the right/bottom edge rather than overflow).
  onMount(() => {
    requestAnimationFrame(() => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const pad = 6;
      let left = props.x;
      let top = props.y;
      if (left + r.width > window.innerWidth - pad) left = window.innerWidth - r.width - pad;
      if (top + r.height > window.innerHeight - pad) top = window.innerHeight - r.height - pad;
      setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
    });
  });

  function onDocMouseDown(e: MouseEvent) {
    const t = e.target as Node;
    if (el?.contains(t) || props.anchorEl?.contains(t)) return;
    props.onClose();
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onClose();
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
      <MenuCloseContext.Provider value={props.onClose}>
        <div
          ref={el}
          class={styles.menu}
          role="menu"
          style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {props.children ?? (
            <For each={props.items ?? []}>
              {(it) =>
                "separator" in it ? (
                  <div class={styles.menuSep} />
                ) : (
                  <MenuRow onClick={it.onClick} danger={it.danger} warn={it.warn} disabled={it.disabled}>
                    {it.label}
                  </MenuRow>
                )
              }
            </For>
          )}
        </div>
      </MenuCloseContext.Provider>
    </Portal>
  );
}
