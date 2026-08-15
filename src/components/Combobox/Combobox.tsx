import { createEffect, createMemo, Show, type JSX } from "solid-js";
import { Combobox as Primitive, useComboboxContext } from "../../lib/combobox";
import styles from "./Combobox.module.css";

/** One row: the string the app commits, the label the user reads. */
export type ComboboxOption = { value: string; label: string; disabled?: boolean };

/** A labelled run of rows. A list is either flat or grouped, never mixed:
 *  Kobalte decides "group or option" per entry by the presence of the children
 *  key, so a caller with a headed block and a bare tail has to name the tail
 *  too. Same contract `Select` states, for the same reason. */
export type ComboboxGroup = { label: string; options: ComboboxOption[] };

/**
 * The one filter-and-pick surface: a text filter over a list that is *already
 * open*, on Kobalte's combobox.
 *
 * This is not a select with a search box. Both consumers (the picker dialog and
 * the Omnibox palette) are a list that is the surface, so there is no trigger,
 * no popper and no dismissal layer here: `Control` wraps the `Input`, `Listbox`
 * renders as a plain sibling, and the list is open for as long as it has rows
 * (see `open` below, which is an accessibility decision rather than a state
 * machine). `Combobox.Content` is deliberately not composed; see
 * `src/lib/combobox.ts` for what it would drag in and why every piece of it is
 * wrong inside a dialog that owns those already.
 *
 * **Filtering and ranking stay the caller's.** `defaultFilter` is pinned open
 * because Kobalte's filter only *filters*: it never re-orders, and both
 * consumers rank by fuzzy score. So the caller receives `onQueryChange`, does
 * its own matching, and hands back `options` already filtered and sorted.
 *
 * **String in, string out.** Kobalte traffics in the option object; the wrapper
 * keeps the caller's API on `value` strings, the same shape `Select` exposes.
 *
 * **Labeling is the call site's.** The input is not wired to a `<label>`, so
 * every consumer passes `aria-label`.
 *
 * Chrome is split: this owns the field and the list surface, the caller's
 * `class` adds layout.
 */
export default function Combobox(props: {
  options: ComboboxOption[] | ComboboxGroup[];
  /** The filter text. Controlled: Kobalte owns the element's value, so this is
   *  written back through the primitive's own context (see `Bridge`). */
  query: string;
  onQueryChange: (query: string) => void;
  /** A row was committed, by Enter or by click. */
  onSelect: (value: string) => void;
  placeholder?: string;
  "aria-label": string;
  /** The list's own accessible name, e.g. what is being picked. */
  listLabel?: string;
  /** Shown in place of the list when nothing matches. The list is *withdrawn*
   *  rather than emptied: a listbox promises selectable children, and one with
   *  none is worse than none at all. Announced, because withdrawing the list
   *  also withdraws Kobalte's own count announcement (it is gated on the open
   *  state), which would leave a filter that matches nothing completely silent. */
  emptyLabel?: string;
  /** Row content, when a bare label is not enough (the palette's icons, key
   *  chips and secondary text). Defaults to the label. */
  itemComponent?: (option: ComboboxOption) => JSX.Element;
  /** An affordance inside the field, after the input (the picker's clear
   *  button). Inside `Control` rather than beside it, so it reads as part of
   *  the field and cannot drift away from it on a narrow surface. */
  trailing?: JSX.Element;
  /** Keys the caller handles itself, before the primitive sees them. The
   *  picker's create-on-Enter needs this: with nothing matching there is no row
   *  for Enter to commit, so the primitive does nothing and the caller decides
   *  whether an unmatched name is a new one. */
  onKeyDown?: (event: KeyboardEvent) => void;
  /** The row Enter would commit right now, or null when there is none. For a
   *  caller with a second commit path that has to agree with the keyboard (the
   *  picker's Ok button), since the highlight lives inside the primitive. */
  onActiveChange?: (value: string | null) => void;
  inputRef?: (el: HTMLInputElement) => void;
  class?: string;
}) {
  const hasRows = createMemo(() =>
    (props.options as (ComboboxOption | ComboboxGroup)[]).some((entry) =>
      "options" in entry ? entry.options.length > 0 : true,
    ),
  );
  // Declared only for a grouped list, because the key is all-or-nothing:
  // Kobalte reads it off *every* top-level entry, so one bare option in a list
  // that declares it throws on `undefined.filter`. This is the enforcement
  // behind "either flat or grouped, never mixed", and it is a throw rather than
  // a mis-render, which is the good version of that.
  const grouped = createMemo(() =>
    (props.options as (ComboboxOption | ComboboxGroup)[]).some((entry) => "options" in entry),
  );

  // Kobalte builds *every* section node with `key: ""` and the listbox renders
  // the collection through `<Key by="key">`, so two headings are two entries
  // claiming one key. That survives a first render but not an update: a list
  // that goes from one heading to two comes back with one, in the other one's
  // place. Rebuilding rather than reconciling the list when the headings change
  // is the containable half of that; the rows themselves are unaffected, and a
  // flat list yields a constant here so it never remounts.
  const headings = createMemo(
    () =>
      "g:" +
      (props.options as (ComboboxOption | ComboboxGroup)[])
        .filter((entry): entry is ComboboxGroup => "options" in entry)
        .map((group) => group.label)
        .join("\n"),
  );

  return (
    <Primitive.Root<ComboboxOption, ComboboxGroup>
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      optionLabel="label"
      optionDisabled="disabled"
      optionGroupChildren={grouped() ? "options" : undefined}
      // Open whenever there is anything to show, which for these surfaces is
      // "always, until the filter matches nothing". The list *is* the surface,
      // so nothing ever calls Kobalte's own `open()`, which is why the active
      // row has to be seeded by hand below.
      //
      // Tracking the row count rather than pinning this to `true` is what keeps
      // the empty state honest: `Combobox.Input` always carries
      // `role="combobox"`, and a combobox that says `aria-expanded="true"` while
      // its `aria-controls` names nothing is a critical `aria-required-attr`
      // violation. Collapsed is both the accessible answer and the true one.
      open={hasRows()}
      // Pinned empty, which makes a commit an *event* rather than a state these
      // surfaces then have to undo. Left uncontrolled, Kobalte treats a pick as
      // a selection toggle, so picking the same row twice fires `onChange` with
      // the value and then with `null`: the palette's mode signposts, which are
      // picked repeatedly without the surface ever closing, would go dead on the
      // second press. It also stops `resetInputValue` rewriting the filter box
      // to the picked row's label, and it is what makes the "no row is ever
      // `aria-selected`" shape below true rather than merely usual.
      value={null}
      allowsEmptyCollection
      // Wrapping arrows, which is what both surfaces had by hand.
      shouldFocusWrap
      // The caller has already filtered and ranked; re-filtering here would
      // silently drop rows whose match the caller scored and Kobalte cannot see.
      defaultFilter={() => true}
      onInputChange={(value) => props.onQueryChange(value)}
      onChange={(option) => {
        // Null is Kobalte clearing the selection, which these pickers never do:
        // a commit is always a row.
        if (option) props.onSelect(option.value);
      }}
      sectionComponent={(section) => (
        <Primitive.Section class={styles.section}>{section.section.rawValue.label}</Primitive.Section>
      )}
      itemComponent={(item) => (
        <Primitive.Item item={item.item} class={styles.item}>
          {/* Still the label part when the caller owns the row's content: it is
              what names the option in the accessibility tree, so a rich row
              must be inside it rather than beside it. Only the layout differs,
              a text run against a row of parts. */}
          <Primitive.ItemLabel class={props.itemComponent ? styles.itemRow : styles.itemLabel}>
            {props.itemComponent?.(item.item.rawValue) ?? item.item.rawValue.label}
          </Primitive.ItemLabel>
        </Primitive.Item>
      )}
    >
      <Bridge query={props.query} options={props.options} onActiveChange={props.onActiveChange} />
      <Primitive.Control class={`${styles.control} ${props.class ?? ""}`.trim()}>
        <Primitive.Input
          ref={props.inputRef}
          class={styles.input}
          placeholder={props.placeholder}
          aria-label={props["aria-label"]}
          onKeyDown={(event: KeyboardEvent) => props.onKeyDown?.(event)}
        />
        {props.trailing}
      </Primitive.Control>
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
        {/* The child has to declare its parameter: `Show` only treats a
            function child as a render callback when it takes one, and hands
            back the function itself otherwise - which memoises to the same
            reference and never rebuilds, quietly undoing `keyed`. */}
        <Show when={headings()} keyed>
          {(_signature) => (
            <Primitive.Listbox class={styles.listbox} aria-label={props.listLabel} />
          )}
        </Show>
      </Show>
    </Primitive.Root>
  );
}

/**
 * The one sanctioned reach past the primitive's props, in the one file allowed
 * to make it. Two jobs, both of which Kobalte's props cannot express:
 *
 * 1. **Write the filter text.** Kobalte owns the input's value as a signal with
 *    no external source, so a controlled `query` prop has nowhere to land. This
 *    pushes it in.
 *
 * 2. **Seed the active row.** Kobalte only ever highlights a row inside its own
 *    `open()`, and a combobox that is open from birth never calls it, so nothing
 *    would be highlighted until the user pressed an arrow key: typing "mai" and
 *    pressing Enter would commit nothing. Both surfaces have always put the top
 *    match under Enter, so the first selectable row is highlighted here whenever
 *    the highlight is missing or the filter has just dropped the row that had it
 *    (Kobalte clears the focused key on every keystroke).
 */
function Bridge(props: {
  query: string;
  options: ComboboxOption[] | ComboboxGroup[];
  onActiveChange?: (value: string | null) => void;
}) {
  const context = useComboboxContext();

  createEffect(() => context.setInputValue(props.query));

  // Reported rather than exposed: the key *is* the option's value (`optionValue`
  // above), so a caller learns which row Enter would take without learning that
  // there is a collection behind it.
  createEffect(() => {
    const key = context.listState().selectionManager().focusedKey();
    props.onActiveChange?.(key ?? null);
  });

  createEffect(() => {
    // Read both, so a re-seed follows a re-filter as well as a keystroke.
    props.options;
    props.query;

    const state = context.listState();
    const manager = state.selectionManager();
    const collection = state.collection();

    const current = manager.focusedKey();
    if (current != null && collection.getItem(current) != null) return;

    let first: string | undefined;
    for (const node of collection) {
      if (node.type === "item" && !node.disabled) {
        first = node.key;
        break;
      }
    }
    if (first == null) return;

    manager.setFocused(true);
    manager.setFocusedKey(first);
  });

  return null;
}
