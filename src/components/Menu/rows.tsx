import { createContext, createUniqueId, For, onCleanup, Show, useContext, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { ChevronRight, type IconGlyph } from "../Icon/icons";
import Glide from "../Glide/Glide";
import Icon from "../Icon/Icon";
import Tooltip from "../Tooltip/Tooltip";
import { createMenu, MenuContent, MenuItem as Item, MenuProvider, useMenu } from "./menuCore";
import { useMenuSurface } from "./surface";
import styles from "./Menu.module.css";

/** A menu entry: an action row, a visual separator, or a heading naming what the
 *  menu is acting on. Covers the flat cases (right-click menus, button
 *  dropdowns). Rows that need custom content (a close button) are expressed as
 *  `<MenuRow>` children instead. */
export type MenuItem =
  | { separator: true }
  /** Plain text in every menu but the space menu, whose heading is the space's
   *  own glyph and name rather than a word - which is the whole of what it adds
   *  over a label the rows already carry. */
  | { heading: JSX.Element }
  /** A grid of colour swatches, each its own item, with the chosen one ringed.
   *  `null` is the leading "None" swatch. */
  | { swatches: MenuSwatch[]; value: string | null; onPick: (value: string | null) => void }
  | {
      label: string;
      onClick: () => void;
      /** A leading glyph, for a menu whose rows are read by shape before they
       *  are read as words. Decorative: the label still carries the meaning, so
       *  it is hidden from the accessibility tree. */
      icon?: IconGlyph;
      danger?: boolean;
      warn?: boolean;
      disabled?: boolean;
      /** See `MenuRow`: refusing rather than disabled keeps a row that says why
       *  reachable by arrow key. */
      refusing?: boolean;
      /** Why the row refuses, drawn under the label and announced after it. A
       *  native `title` would be neither, which is what `refusing` exists for. */
      note?: string;
      /** The row's keyboard shortcut, drawn at the row's end. */
      keys?: string;
      /** What the row does, as a tooltip on hover and keyboard focus rather than
       *  a `note` under the label. */
      hint?: string;
    };

/** The rows both wrappers share, so chrome cannot drift between the right-click
 *  menus and the triggered dropdowns. */
export function MenuRow(props: {
  onClick?: () => void;
  disabled?: boolean;
  /** Refusing, but still reachable. `disabled` skips the row in arrow navigation
   *  and typeahead, which takes any reason written on it out of a keyboard
   *  user's reach; this keeps the row navigable and simply does not act. Use it
   *  when the row says *why*, and `disabled` when it does not. */
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
  /** A tooltip for the row, opened by hover and by keyboard focus. */
  tooltip?: string;
  children: JSX.Element;
}) {
  // A call, not an inline ternary: Solid memoises a ternary prop on every read,
  // and a row's select handler reads this one outside any owner.
  const closesOnSelect = () => (props.refusing ? false : props.closeOnSelect);
  return (
    <Tooltip
      as={Item}
      label={props.tooltip}
      placement="right"
      class={[
        styles.item,
        props.danger && styles.danger,
        props.warn && styles.warn,
        props.refusing && styles.refusing,
        props.selected && styles.selected,
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={props.disabled}
      aria-disabled={props.refusing ? "true" : undefined}
      aria-describedby={props.describedBy}
      // A refused row must not close the menu on its way to doing nothing.
      closeOnSelect={closesOnSelect()}
      onSelect={() => !props.refusing && props.onClick?.()}
      // A row selects on Enter's keydown; left to run, its keypress then clicks
      // whatever the row's action focused, which for a confirm dialog is the
      // confirm button.
      onKeyDown={(e: KeyboardEvent) => e.key === "Enter" && e.preventDefault()}
    >
      {props.children}
    </Tooltip>
  );
}

/** The menu's one fill, under the highlighted row. A flyout's parent keeps it
 *  while the pointer is in the flyout, so the trail back up the tree stays lit,
 *  and a destructive row paints its own wash instead. */
export function MenuGlide() {
  return (
    <Glide
      active={(list) =>
        list.querySelector(`.${styles.item}[data-highlighted]:not(.${styles.danger})`) ??
        list.querySelector(`.${styles.item}[data-expanded]`)
      }
    />
  );
}

/** How far a flyout sits from the row that opened it, and how far back up.
 *
 *  The gutter is the surface's own `--tori-space-3` padding plus the same 4px a
 *  dropdown clears its button by, since the row it is measured from is inset by
 *  that padding: the flyout clears the parent's *edge* by the gap the eye reads,
 *  not the row's. The shift undoes the padding on the other axis, so the
 *  flyout's first row lines up with the row that opened it rather than sitting
 *  one padding lower. */
const SUB_GUTTER = 10;
const SUB_SHIFT = -6;

const SUB_OPEN_DELAY = 100;

/**
 * A row that opens another page of the menu beside itself. The level mounts only
 * while it is open, so a per-level `createResource` does not fetch every folder
 * the moment the menu opens.
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
  const parent = useMenu();
  const sub = createMenu({ parent });
  const id = createUniqueId();
  let row!: HTMLDivElement;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelOpen = () => {
    clearTimeout(openTimer);
    openTimer = undefined;
  };
  onCleanup(cancelOpen);

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || parent.movingToChild(e)) return;
    if (props.disabled) {
      parent.focusContent();
      return;
    }
    if (!sub.isOpen() && openTimer === undefined) {
      openTimer = setTimeout(() => {
        openTimer = undefined;
        sub.open("none");
      }, SUB_OPEN_DELAY);
    }
    sub.clearHighlight();
    if (parent.highlighted() !== row) parent.highlight(row);
  };

  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    cancelOpen();
    const level = sub.content()?.getBoundingClientRect();
    if (level) {
      const towardsRight = level.left >= e.clientX;
      const near = towardsRight ? level.left : level.right;
      const far = towardsRight ? level.right : level.left;
      parent.setGrace([
        [e.clientX + (towardsRight ? -5 : 5), e.clientY],
        [near, level.top],
        [far, level.top],
        [far, level.bottom],
        [near, level.bottom],
      ]);
    }
    if (!parent.movingToChild(e)) parent.focusContent();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || props.disabled) return;
    if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowRight") return;
    e.stopPropagation();
    e.preventDefault();
    parent.clearHighlight();
    if (sub.isOpen()) sub.focusEdge("first");
    else sub.open("first");
  };

  return (
    <MenuProvider value={sub}>
      <div
        ref={(el) => {
          row = el;
          sub.setTrigger(el);
        }}
        id={id}
        role="menuitem"
        tabindex={-1}
        class={styles.item}
        aria-haspopup="true"
        aria-expanded={sub.isOpen() ? "true" : "false"}
        aria-controls={sub.isOpen() ? sub.contentId : undefined}
        aria-disabled={props.disabled ? "true" : undefined}
        data-disabled={props.disabled ? "" : undefined}
        data-highlighted={parent.highlighted() === row ? "" : undefined}
        data-expanded={sub.isOpen() ? "" : undefined}
        data-text-value={props.textValue}
        onClick={() => {
          if (!sub.isOpen() && !props.disabled) sub.open("content");
        }}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
      >
        {props.label}
        <Icon icon={ChevronRight} class={styles.subInto} aria-hidden="true" />
      </div>
      <Show when={sub.isOpen()}>
        <Portal mount={surface()}>
          <MenuContent
            menu={sub}
            placement="right-start"
            gutter={SUB_GUTTER}
            shift={SUB_SHIFT}
            returnFocus={sub.trigger}
            labelledBy={id}
            class={styles.content}
          >
            <MenuGlide />
            {props.children}
          </MenuContent>
        </Portal>
      </Show>
    </MenuProvider>
  );
}

/** A rule between groups of rows. */
export function MenuSeparator() {
  return <hr class={styles.separator} />;
}

const GroupLabelId = createContext<string>();

/** What the menu is acting on, rather than something it offers to do. Not a
 *  `menuitem`, so the arrows and typeahead pass over it, and the group it names
 *  announces that name before its first row. Only usable through `MenuRows`,
 *  which owns that group. */
function MenuHeading(props: { children: JSX.Element }) {
  return (
    <span id={useContext(GroupLabelId)} class={styles.heading} aria-hidden="true">
      {props.children}
    </span>
  );
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
      tooltip={props.item.hint}
    >
      <Show when={props.item.icon}>{(icon) => <Icon icon={icon()} aria-hidden="true" />}</Show>
      <Show when={props.item.note} fallback={props.item.label}>
        <span class={styles.noted}>
          {props.item.label}
          <span class={styles.note} id={noteId}>
            {props.item.note}
          </span>
        </span>
      </Show>
      <Show when={props.item.keys}>
        <span class={styles.keys}>{props.item.keys}</span>
      </Show>
    </MenuRow>
  );
}

/** A row whose note describes it without naming it: the label alone is the
 *  accessible name, so a note that changes with state, like a count, does not
 *  rename the row it sits under. */
export function DescribedRow(props: {
  label: string;
  note: string;
  onClick?: () => void;
  disabled?: boolean;
  refusing?: boolean;
}) {
  const noteId = createUniqueId();
  return (
    <MenuRow onClick={props.onClick} disabled={props.disabled} refusing={props.refusing} describedBy={noteId}>
      <span class={styles.noted}>
        {props.label}
        <span class={styles.note} id={noteId} aria-hidden="true">
          {props.note}
        </span>
      </span>
    </MenuRow>
  );
}

export type MenuSwatch = { value: string; label: string; hex: string };

function SwatchRow(props: { swatches: MenuSwatch[]; value: string | null; onPick: (value: string | null) => void }) {
  const swatch = (value: string | null, label: string, hex: string | null) => (
    <Item
      class={[styles.swatch, hex === null && styles.swatchNone, props.value === value && styles.swatchOn]
        .filter(Boolean)
        .join(" ")}
      style={hex ? { "--swatch": hex } : undefined}
      aria-label={props.value === value ? `${label}, chosen` : label}
      onSelect={() => props.onPick(value)}
    />
  );
  return (
    <div class={styles.swatches}>
      {swatch(null, "None", null)}
      <For each={props.swatches}>{(s) => swatch(s.value, s.label, s.hex)}</For>
    </div>
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
        ) : "swatches" in it ? (
          <SwatchRow swatches={it.swatches} value={it.value} onPick={it.onPick} />
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
 *  nothing. */
export function MenuRows(props: { items: MenuItem[] }) {
  const labelId = createUniqueId();
  return (
    <Show when={props.items.some((it) => "heading" in it)} fallback={<FlatRows items={props.items} />}>
      <GroupLabelId.Provider value={labelId}>
        <div role="group" aria-labelledby={labelId}>
          <FlatRows items={props.items} />
        </div>
      </GroupLabelId.Provider>
    </Show>
  );
}
