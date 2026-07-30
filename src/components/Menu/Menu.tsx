import { For, createContext, useContext, type JSX } from "solid-js";
import Popover from "../Popover/Popover";
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
  /** For a row that leads somewhere *inside* the menu (a second page of
   *  options) rather than committing a choice. Closing on that click would
   *  shut the menu the row was navigating within. */
  keepOpen?: boolean;
  children: JSX.Element;
}) {
  const close = useContext(MenuCloseContext);
  return (
    <div
      class={styles.menuItem}
      classList={{ [styles.danger]: !!props.danger, [styles.warn]: !!props.warn, [styles.disabled]: !!props.disabled }}
      onClick={() => {
        if (props.disabled) return;
        if (!props.keepOpen) close();
        props.onClick?.();
      }}
    >
      {props.children}
    </div>
  );
}

// The menu surface: a <Popover> opened at (x, y), left-aligned, carrying menu
// chrome and menu semantics. Positioning, viewport clamping, and escape /
// outside-click close all belong to Popover; what is here is what makes a menu
// a menu. Feed a flat `items` list, or custom rows as children (<MenuRow>).
// Pass `anchorEl` for a toggle button so an outside-click on the button doesn't
// fight the button's own open/close.
export default function Menu(props: {
  x: number;
  y: number;
  /** The right edge of the control this hangs off, when it has width. Defaults
   *  to `x`, which is the cursor case. Only read once a menu end-aligns; it is
   *  here so a caller anchored on a button can describe the button's real span
   *  rather than collapsing it to a point. */
  right?: number;
  onClose: () => void;
  items?: MenuItem[];
  anchorEl?: HTMLElement;
  /** Treat `y` as the edge the menu should sit *above* rather than below. For a
   *  control near the bottom of the window (the composer's), where opening
   *  downward means the clamp drags the menu back over the control that opened
   *  it. Still clamped, so a menu taller than the space above it stays on
   *  screen. */
  openAbove?: boolean;
  children?: JSX.Element;
}) {
  return (
    <Popover
      // A cursor is a zero-width anchor; a button hands over its own span.
      anchor={{ left: props.x, right: props.right ?? props.x, top: props.y }}
      openAbove={props.openAbove}
      anchorEl={props.anchorEl}
      onClose={props.onClose}
      class={styles.menu}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuCloseContext.Provider value={props.onClose}>
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
      </MenuCloseContext.Provider>
    </Popover>
  );
}
