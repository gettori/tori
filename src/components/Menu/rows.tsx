import { For, Show, createUniqueId, type JSX } from "solid-js";
import { ChevronRight, type LucideIcon } from "lucide-solid";
import Icon from "../Icon/Icon";
import { DropdownMenu as Primitive } from "../../lib/menu";
import { useMenuSurface } from "./surface";
import styles from "./Menu.module.css";

/** A menu entry: an action row, a visual separator, or a heading naming what the
 *  menu is acting on. Covers the flat cases (right-click menus, button
 *  dropdowns). Rows that need custom content (icons, a close button) are
 *  expressed as `<MenuRow>` children instead.
 *
 *  Structurally identical to the type the hand-rolled `Menu.tsx` exports, so a
 *  call site migrating in phase 3 or 4 changes its import and nothing else. */
export type MenuItem =
  | { separator: true }
  /** Plain text in every menu but the space menu, whose heading is the space's
   *  own glyph and name rather than a word - which is the whole of what it adds
   *  over a label the rows already carry. */
  | { heading: JSX.Element }
  | {
      label: string;
      onClick: () => void;
      /** A leading glyph, for a menu whose rows are read by shape before they
       *  are read as words. Decorative: the label still carries the meaning, so
       *  it is hidden from the accessibility tree. */
      icon?: LucideIcon;
      danger?: boolean;
      warn?: boolean;
      disabled?: boolean;
      /** See `MenuRow`: refusing rather than disabled keeps a row that says why
       *  reachable by arrow key. */
      refusing?: boolean;
      /** Why the row refuses, drawn under the label and announced after it. A
       *  native `title` would be neither, which is what `refusing` exists for. */
      note?: string;
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
  /** Refusing, but still reachable. Kobalte's `disabled` skips the row in arrow
   *  navigation and typeahead, which takes any reason written on it out of a
   *  keyboard user's reach; this keeps the row navigable and simply does not
   *  act. Use it when the row says *why*, and `disabled` when it does not. */
  refusing?: boolean;
  /** The choice currently in force, painted rather than only ticked. A tick
   *  alone is a mark the eye has to go looking for down the right-hand edge;
   *  the fill is what the model palette already uses to say the same thing. */
  selected?: boolean;
  /** An element whose text describes this row, announced after its label. For a
   *  row whose explanation is drawn somewhere the keyboard cannot reach - a
   *  tooltip, which hangs off a child span rather than off the item. */
  describedBy?: string;
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
        [styles.refusing]: !!props.refusing,
        [styles.selected]: !!props.selected,
      }}
      // Disabled is the primitive's own state, not a class: Kobalte blocks
      // activation, skips the row in arrow navigation and typeahead, and stamps
      // `data-disabled`, which is what the stylesheet paints. A class would only
      // be able to do the last of those.
      disabled={props.disabled}
      aria-disabled={props.refusing || undefined}
      aria-describedby={props.describedBy}
      // A refused row must not close the menu on its way to doing nothing.
      closeOnSelect={props.refusing ? false : props.closeOnSelect}
      onSelect={() => !props.refusing && props.onClick?.()}
    >
      {props.children}
    </Primitive.Item>
  );
}

/** How far a flyout sits from the row that opened it, and how far back up. Both
 *  in px and neither a token, for the reason `Dropdown`'s `TRIGGER_GUTTER`
 *  documents: floating-ui takes numbers, so these never reach CSS and cannot
 *  read `--ui-scale`.
 *
 *  The gutter is the surface's own `--tori-space-3` padding plus the same 4px a
 *  dropdown clears its button by, since the row it is measured from is inset by
 *  that padding: the flyout clears the parent's *edge* by the gap the eye reads,
 *  not the row's. The shift undoes the padding on the other axis, so the
 *  flyout's first row lines up with the row that opened it rather than sitting
 *  one padding lower. */
const SUB_GUTTER = 10;
const SUB_SHIFT = -6;

/**
 * A row that opens another page of the menu beside itself.
 *
 * The four Kobalte parts arrive as one component rather than four exports,
 * because they are never composed apart and one of the four is easy to leave
 * out: the `Portal` is what makes a level *lazy*, since it renders its children
 * only while the submenu is present. A call site that forgot it would mount
 * every level of a tree at once, and a per-level `createResource` would fetch
 * every folder the moment the menu opened.
 *
 * `SubTrigger` is a `role="menuitem"` like any other row, so it carries the row
 * class: a flyout's opener is not a different kind of row, it is a row that
 * happens to lead somewhere. Kobalte writes `aria-haspopup` and `aria-expanded`
 * on it, and closes the whole stack when a row anywhere inside is picked.
 */
export function MenuSub(props: {
  /** The trigger row's own content, the same shape a `MenuRow` takes. */
  label: JSX.Element;
  disabled?: boolean;
  /** What typeahead matches on, when the label is not plain text. */
  textValue?: string;
  /** The rows of the level this row opens. */
  children: JSX.Element;
}) {
  // The wrapper's mount, not this row's own reading of it: see `surface.ts`.
  const surface = useMenuSurface();

  return (
    <Primitive.Sub gutter={SUB_GUTTER} shift={SUB_SHIFT}>
      <Primitive.SubTrigger class={styles.item} disabled={props.disabled} textValue={props.textValue}>
        {props.label}
        <Icon icon={ChevronRight} class={styles.subInto} aria-hidden="true" />
      </Primitive.SubTrigger>
      <Primitive.Portal mount={surface()}>
        <Primitive.SubContent
          class={styles.content}
          onContextMenu={(e: MouseEvent) => e.preventDefault()}
        >
          {props.children}
        </Primitive.SubContent>
      </Primitive.Portal>
    </Primitive.Sub>
  );
}

/** A rule between groups of rows. Kobalte renders it as an `<hr>` carrying
 *  `role="separator"`, so arrow navigation and typeahead skip it without this
 *  file saying anything. */
export function MenuSeparator() {
  return <Primitive.Separator class={styles.separator} />;
}

/** What the menu is acting on, rather than something it offers to do. Kobalte's
 *  `GroupLabel`, so it is not a `menuitem`: the arrows and typeahead pass over
 *  it, and the group it names announces that name before its first row instead
 *  of the label being read as an option.
 *
 *  Unexported, unlike every other row here: it reads the id it registers from
 *  the enclosing group's context and throws without one, so it is only ever
 *  usable through `MenuRows`, which owns that group. */
function MenuHeading(props: { children: JSX.Element }) {
  return <Primitive.GroupLabel class={styles.heading}>{props.children}</Primitive.GroupLabel>;
}

/** One action row of a flat list, with its `note` drawn under the label rather
 *  than hung off a native `title`: a hover-only reason on a row the keyboard
 *  can reach is the defect `src/test/interactiveTitle.test.ts` guards against,
 *  and `describedBy` is what announces it after the label instead. */
function NoteRow(props: { item: Extract<MenuItem, { label: string }> }) {
  const noteId = createUniqueId();
  return (
    <MenuRow
      onClick={props.item.onClick}
      danger={props.item.danger}
      warn={props.item.warn}
      disabled={props.item.disabled}
      refusing={props.item.refusing}
      describedBy={props.item.note ? noteId : undefined}
    >
      <Show when={props.item.icon}>
        {(icon) => <Icon icon={icon()} aria-hidden="true" />}
      </Show>
      <Show when={props.item.note} fallback={props.item.label}>
        <span class={styles.noted}>
          {props.item.label}
          <span class={styles.note} id={noteId}>
            {props.item.note}
          </span>
        </span>
      </Show>
    </MenuRow>
  );
}

/** The rows of a flat `MenuItem[]`, ungrouped. Split out so `MenuRows` can put
 *  the same list inside a group or not without writing it twice. */
function FlatRows(props: { items: MenuItem[] }) {
  return (
    <For each={props.items}>
      {(it) =>
        "separator" in it ? (
          <MenuSeparator />
        ) : "heading" in it ? (
          <MenuHeading>{it.heading}</MenuHeading>
        ) : (
          <NoteRow item={it} />
        )
      }
    </For>
  );
}

/** A flat `MenuItem[]` as rows. What a caller gets when it passes `items`
 *  rather than composing children by hand.
 *
 *  The group appears only when something is there to name it: an unlabelled
 *  `role="group"` around every menu in the app would be structure that says
 *  nothing, and `GroupLabel` cannot stand outside one. */
export function MenuRows(props: { items: MenuItem[] }) {
  return (
    <Show
      when={props.items.some((it) => "heading" in it)}
      fallback={<FlatRows items={props.items} />}
    >
      <Primitive.Group>
        <FlatRows items={props.items} />
      </Primitive.Group>
    </Show>
  );
}
