import { createEffect, createMemo, createSignal, createUniqueId, For, Show, untrack, type JSX } from "solid-js";
import Glide from "../Glide/Glide";
import { createListRows, optionKey, valueOfKey } from "../listRows";
import OverlayScroll from "../Scrollbar/OverlayScroll";
import styles from "./Combobox.module.css";

/** One row: the string the app commits, the label the user reads. */
export type ComboboxOption = { value: string; label: string; disabled?: boolean };

/** A labelled run of rows. A list is either flat or grouped, never mixed, so a
 *  caller with a headed block and a bare tail has to name the tail too. */
export type ComboboxGroup = { label: string; options: ComboboxOption[] };

/**
 * The one filter-and-pick surface: a text filter over a list that is *already
 * open*.
 *
 * This is not a select with a search box. Both consumers (the picker dialog and
 * the Omnibox palette) are a list that is the surface, so there is no trigger,
 * no positioning and no dismissal layer here: the listbox renders as a plain
 * sibling of the field, and whatever surrounds it owns dismissal and focus.
 *
 * **Filtering and ranking stay the caller's.** The caller receives
 * `onQueryChange`, does its own matching, and hands back `options` already
 * filtered and sorted.
 *
 * **A commit is an event.** No row is ever `aria-selected`, so the same row can
 * be picked twice (the palette's mode signposts are, without the surface
 * closing).
 *
 * **Labeling is the call site's.** The input is not wired to a `<label>`, so
 * every consumer passes `aria-label`.
 *
 * Chrome is split: this owns the field and the list surface, the caller's
 * `class` adds layout.
 */
export default function Combobox(props: {
  options: ComboboxOption[] | ComboboxGroup[];
  query: string;
  onQueryChange: (query: string) => void;
  /** A row was committed, by Enter or by click. */
  onSelect: (value: string) => void;
  /** The row the caller has parked its choice on, for a dialog whose confirm is
   *  a button. `aria-current` rather than `aria-selected`, which in a combobox
   *  means the committed value. */
  picked?: string | null;
  placeholder?: string;
  "aria-label": string;
  /** The list's own accessible name, e.g. what is being picked. */
  listLabel?: string;
  /** The list is *withdrawn* rather than emptied: a listbox promises selectable
   *  children. Announced, so a filter that matches nothing is not silent. */
  emptyLabel?: string;
  /** Row content, when a bare label is not enough (the palette's icons, key
   *  chips and secondary text). Defaults to the label. */
  itemComponent?: (option: ComboboxOption) => JSX.Element;
  bare?: boolean;
  leading?: JSX.Element;
  /** An affordance inside the field, after the input (the picker's clear
   *  button). Inside `Control` rather than beside it, so it reads as part of
   *  the field and cannot drift away from it on a narrow surface. */
  trailing?: JSX.Element;
  /** Content between the field and the list: the branch dialog's create row and
   *  its list header. A slot rather than the caller drawing it around this
   *  component, because the field and the list are one element's children here
   *  and there is no seam between them from outside. Shown whether or not the
   *  list is, so a filter that matches nothing still offers the name as new. */
  aboveList?: JSX.Element;
  /** Keys the caller sees first. The picker's create-on-Enter needs this: with
   *  nothing matching there is no row for Enter to commit, so the caller decides
   *  whether an unmatched name is a new one. */
  onKeyDown?: (event: KeyboardEvent) => void;
  /** The row Enter would commit right now, or null when there is none. For a
   *  caller with a second commit path that has to agree with the keyboard (the
   *  picker's Ok button). */
  onActiveChange?: (value: string | null) => void;
  initialActive?: string | null;
  inputRef?: (el: HTMLInputElement) => void;
  class?: string;
  /** Layout for the list, as `class` is for the field. Lands on the scroll
   *  frame around it rather than on the list itself, so a `max-height` here is
   *  what decides when the overlay scrollbar appears. */
  listClass?: string;
}) {
  const [scroller, setScroller] = createSignal<HTMLDivElement>();
  const baseId = createUniqueId();
  const inputId = `combobox-${baseId}-input`;
  const listId = `combobox-${baseId}-listbox`;

  const list = createListRows<ComboboxOption>(() => props.options);
  const hasRows = createMemo(() => list.options().length > 0);
  const enabled = createMemo(() =>
    list
      .options()
      .filter((option) => !option.disabled)
      .map((option) => option.value),
  );
  const rowIds = createMemo(() => new Map(list.options().map((option, i) => [option.value, `${listId}-${i}`])));

  const [searchEpoch, setSearchEpoch] = createSignal(0);
  const restartSearch = () => setSearchEpoch((n) => n + 1);
  const [moved, setMoved] = createSignal<{ value: string; search: string }>();
  const search = () => `${searchEpoch()}\0${props.query}`;
  let applied: { value: string; search: string } | undefined;
  const cursor = createMemo<{ value: string; search: string } | undefined>((previous) => {
    const rows = enabled();
    const now = search();
    const arrowed = moved();
    if (arrowed && arrowed !== applied && arrowed.search === now && rows.includes(arrowed.value)) {
      applied = arrowed;
      return arrowed;
    }
    if (previous?.search === now && rows.includes(previous.value)) return previous;
    const named = untrack(() => props.initialActive);
    const value = named != null && rows.includes(named) ? named : rows[0];
    return value === undefined ? undefined : { value, search: now };
  });
  const active = createMemo(() => cursor()?.value ?? null);

  createEffect(() => props.onActiveChange?.(active()));

  createEffect(() => {
    const value = active();
    const frame = scroller();
    if (value === null || !frame) return;
    const id = untrack(() => rowIds().get(value));
    const row = id ? document.getElementById(id) : null;
    if (!row) return;
    const rowBox = row.getBoundingClientRect();
    const frameBox = frame.getBoundingClientRect();
    if (rowBox.top < frameBox.top) frame.scrollTop -= frameBox.top - rowBox.top;
    else if (rowBox.bottom > frameBox.bottom) frame.scrollTop += rowBox.bottom - frameBox.bottom;
  });

  const moveTo = (value: string | undefined) => {
    if (value !== undefined) setMoved({ value, search: search() });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    props.onKeyDown?.(e);
    if (!hasRows()) {
      if (e.key === "Escape") props.onQueryChange("");
      return;
    }
    const rows = enabled();
    const at = rows.indexOf(active() as string);
    switch (e.key) {
      case "Enter": {
        e.preventDefault();
        const value = active();
        if (value !== null) props.onSelect(value);
        break;
      }
      case "ArrowDown":
        e.preventDefault();
        moveTo(rows[at < 0 ? 0 : (at + 1) % rows.length]);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveTo(rows[at <= 0 ? rows.length - 1 : at - 1]);
        break;
      case "Home":
        e.preventDefault();
        moveTo(rows[0]);
        break;
      case "End":
        e.preventDefault();
        moveTo(rows[rows.length - 1]);
        break;
      // PageDown is deliberately inert, and PageUp only reaches a first row with
      // no heading above it: the paging this list has always shipped.
      case "PageDown":
        if (at >= 0) e.preventDefault();
        break;
      case "PageUp":
        if (at < 0) break;
        e.preventDefault();
        if (list.keys()[0] === optionKey(rows[0])) moveTo(rows[0]);
        break;
      case "ArrowLeft":
      case "ArrowRight":
      case "Tab":
      case "Escape":
        restartSearch();
        break;
    }
  };

  const renderRow = (key: string) => {
    const value = valueOfKey(key);
    if (value === undefined) {
      const group = () => {
        const row = list.row(key);
        return row?.kind === "section" ? row.group : undefined;
      };
      return (
        <li role="presentation" class={styles.section}>
          {group()?.label}
        </li>
      );
    }
    const option = () => {
      const row = list.row(key);
      return row?.kind === "option" ? row.option : undefined;
    };
    const isPicked = () => props.picked === value;
    return (
      <li
        id={rowIds().get(value)}
        role="option"
        class={styles.item}
        aria-selected={false}
        aria-disabled={!!option()?.disabled}
        aria-current={isPicked() || undefined}
        data-picked={isPicked() ? "" : undefined}
        data-disabled={option()?.disabled ? "" : undefined}
        data-highlighted={active() === value ? "" : undefined}
        onClick={() => {
          if (!option()?.disabled) props.onSelect(value);
        }}
      >
        {/* The label wraps a rich row too, so the option's name is everything
            inside it. Only the layout differs. */}
        <div class={props.itemComponent ? styles.itemRow : styles.itemLabel}>
          {option() && (props.itemComponent?.(option()!) ?? option()!.label)}
        </div>
      </li>
    );
  };

  return (
    <div role="group">
      <div class={[styles.control, props.bare && styles.bare, props.class].filter(Boolean).join(" ")}>
        {props.leading}
        <input
          ref={props.inputRef}
          id={inputId}
          class={styles.input}
          value={props.query}
          placeholder={props.placeholder}
          type="text"
          role="combobox"
          autocomplete="off"
          autocorrect="off"
          spellcheck={false}
          aria-label={props["aria-label"]}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-expanded={hasRows()}
          aria-controls={hasRows() ? listId : undefined}
          aria-activedescendant={active() === null ? undefined : rowIds().get(active()!)}
          onInput={(e) => {
            props.onQueryChange(e.currentTarget.value);
            if (e.currentTarget.value !== props.query) e.currentTarget.value = props.query;
          }}
          onKeyDown={onKeyDown}
        />
        {props.trailing}
      </div>
      {props.aboveList}
      <Show
        when={hasRows()}
        fallback={
          <Show when={props.emptyLabel}>
            {(label) => (
              <div class={styles.empty} role="status">
                {label()}
              </div>
            )}
          </Show>
        }
      >
        {/* The caller's `listClass` bounds this frame (a `max-height`, per
            OverlayScroll), so the viewport is the scroller. */}
        <OverlayScroll
          class={props.listClass}
          contentClass={styles.listFrame}
          viewportRef={setScroller}
          // The rows are not focusable, so a press would hand focus to the
          // document and take the arrow keys with it.
          onMouseDown={(e: MouseEvent) => e.preventDefault()}
        >
          {/* Never under the picked row: its wash is a choice, not a position. */}
          <Glide
            hover={`.${styles.item}:not([data-disabled]):not([data-picked])`}
            active={(frame) =>
              active() === null ? null : frame.querySelector(`.${styles.item}[data-highlighted]:not([data-picked])`)
            }
          />
          <ul id={listId} role="listbox" class={styles.listbox} aria-label={props.listLabel}>
            <For each={list.keys()}>{renderRow}</For>
          </ul>
        </OverlayScroll>
      </Show>
    </div>
  );
}
