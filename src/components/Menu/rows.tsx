import { For, type JSX } from "solid-js";
import { DropdownMenu as Primitive } from "../../lib/menu";
import styles from "./Menu.module.css";

/** A menu entry: an action row, or a visual separator. Covers the flat cases
 *  (right-click menus, button dropdowns). Rows that need custom content (icons,
 *  a close button) are expressed as `<MenuRow>` children instead.
 *
 *  Structurally identical to the type the hand-rolled `Menu.tsx` exports, so a
 *  call site migrating in phase 3 or 4 changes its import and nothing else. */
export type MenuItem =
  | { separator: true }
  | {
      label: string;
      onClick: () => void;
      danger?: boolean;
      warn?: boolean;
      disabled?: boolean;
    };

/**
 * The rows both wrappers share, so chrome cannot drift between the right-click
 * menus and the triggered dropdowns.
 *
 * **One namespace serves both roots, and this is load-bearing.** Kobalte builds
 * `DropdownMenu` and `ContextMenu` on the same `Menu` internals: `Item`,
 * `Separator`, `Portal`, `Sub`, `SubTrigger` and `SubContent` are re-exported
 * from one shared module by both entry points and are therefore the *same*
 * components, reading the same context. Only `Root`, `Trigger` and `Content`
 * genuinely differ. So this file names one of the two and works inside either
 * root, rather than taking the parts as props or through a context of its own.
 *
 * That is an implementation detail of a dependency, so `src/lib/menu.test.ts`
 * asserts the identity: a Kobalte release that splits the two fails there, with
 * a message naming this file, instead of failing as a mystery here.
 */
export function MenuRow(props: {
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  warn?: boolean;
  /** For a row that leads somewhere *inside* the menu (a second page of
   *  options) rather than committing a choice. Closing on that click would shut
   *  the menu the row was navigating within. */
  closeOnSelect?: boolean;
  children: JSX.Element;
}) {
  return (
    <Primitive.Item
      class={styles.item}
      classList={{
        [styles.danger]: !!props.danger,
        [styles.warn]: !!props.warn,
      }}
      // Disabled is the primitive's own state, not a class: Kobalte blocks
      // activation, skips the row in arrow navigation and typeahead, and stamps
      // `data-disabled`, which is what the stylesheet paints. A class would only
      // be able to do the last of those.
      disabled={props.disabled}
      closeOnSelect={props.closeOnSelect}
      onSelect={() => props.onClick?.()}
    >
      {props.children}
    </Primitive.Item>
  );
}

/** A rule between groups of rows. Kobalte renders it as an `<hr>` carrying
 *  `role="separator"`, so arrow navigation and typeahead skip it without this
 *  file saying anything. */
export function MenuSeparator() {
  return <Primitive.Separator class={styles.separator} />;
}

/** A flat `MenuItem[]` as rows. What a caller gets when it passes `items`
 *  rather than composing children by hand. */
export function MenuRows(props: { items: MenuItem[] }) {
  return (
    <For each={props.items}>
      {(it) =>
        "separator" in it ? (
          <MenuSeparator />
        ) : (
          <MenuRow
            onClick={it.onClick}
            danger={it.danger}
            warn={it.warn}
            disabled={it.disabled}
          >
            {it.label}
          </MenuRow>
        )
      }
    </For>
  );
}
