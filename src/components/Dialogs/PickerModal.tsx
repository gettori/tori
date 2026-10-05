import { createSignal, createMemo, Show } from "solid-js";
import { fuzzyScore } from "../../utils/fuzzy";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Combobox, { type ComboboxOption } from "../Combobox/Combobox";
import Dialog from "../Dialog/Dialog";

// A filterable single-select picker. Replaces a comma-joined prompt title when
// the caller must pick one item from a potentially large list (e.g. attach one
// of 100s of local branches). Typing fuzzy-filters + ranks via the shared
// fuzzyScore; up/down wrap over the results, Enter/Ok commit, Esc or a click
// outside cancels. Row click commits that row.
//
// The shell is `Dialog` and the body is `Combobox` (#110): the filter, the
// listbox, `aria-activedescendant`, the arrow keys and the scroll-into-view all
// belong to the shared surface now, and what is left here is the two things
// that are actually this dialog's own - how it ranks, and what Ok means.
//
// `creatable`: when set, Ok/Enter commit the **raw typed text** if it matches no
// listed item exactly, so the same dialog both attaches a listed branch and
// creates a new one (the create-new affordance is the Ok button, since a name
// with no row cannot be clicked). Select-only (the default) commits only a listed
// item. Cancel passes null via the caller's resolver, mirroring PromptModal.
export default function PickerModal(props: {
  title: string;
  items: string[];
  placeholder?: string;
  creatable?: boolean;
  /** More rows are on their way (a background fetch). The list takes its full
   *  height now: grown later, it would slide every row out from under the
   *  cursor, since the panel is centred and sized by its content. */
  reserve?: boolean;
  okLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = createSignal("");
  // The row Enter would take, reported by the surface. Ok has to agree with the
  // keyboard, and the highlight lives inside the primitive now.
  const [active, setActive] = createSignal<string | null>(null);
  let input: HTMLInputElement | undefined;

  const results = createMemo(() => {
    const q = query().trim();
    if (!q) return props.items;
    const scored: { item: string; score: number }[] = [];
    for (const item of props.items) {
      const s = fuzzyScore(q, item);
      if (s !== null) scored.push({ item, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((r) => r.item);
  });

  // Ranking stays here because it is this dialog's, not the surface's: the
  // surface never re-orders what it is given.
  const options = createMemo<ComboboxOption[]>(() => results().map((item) => ({ value: item, label: item })));

  // Clear the filter and refocus the input so keyboard nav keeps working after
  // a mouse click on the clear button.
  function clear() {
    setQuery("");
    input?.focus();
  }

  // Ok button: commit exactly what's in the input. An exact match to a listed
  // item selects it; else, when creatable, a non-empty query is a new value; else
  // the highlighted row. This is the deliberate create-new path.
  function commitTyped() {
    const q = query().trim();
    if (q && props.items.includes(q)) return props.onSubmit(q);
    if (q && props.creatable) return props.onSubmit(q);
    const hit = active();
    if (hit) props.onSubmit(hit);
  }

  // Enter, in the one case the surface cannot answer: nothing matched, so there
  // is no row to commit and a creatable picker takes the typed name instead.
  // Every other Enter commits the highlight, which is the surface's own doing
  // and arrives through `onSelect` - so filtering-then-Enter (typing "mai" to
  // reach "main") still never creates a branch by accident.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter" || results().length) return;
    const q = query().trim();
    if (q && props.creatable) {
      e.preventDefault();
      props.onSubmit(q);
    }
  }

  return (
    <Dialog
      open
      title={props.title}
      onClose={() => props.onCancel()}
      initialFocus={() => input}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" onClick={() => commitTyped()}>
            {props.okLabel ?? "OK"}
          </Button>
        </>
      }
    >
      <Combobox
        class={styles.pickerField}
        listClass={props.reserve ? styles.pickerListReserved : undefined}
        options={options()}
        query={query()}
        onQueryChange={setQuery}
        onSelect={(value) => props.onSubmit(value)}
        onActiveChange={setActive}
        onKeyDown={onKeyDown}
        inputRef={(el) => (input = el)}
        placeholder={props.placeholder}
        // No visible label line to borrow, unlike the other dialogs in this
        // set, and the panel title names the dialog rather than the field. A
        // placeholder is not a name (it goes away the moment anything is
        // typed) but it is the caller's own words for this list, so it is
        // reused as one where there is one. No caller passes it today, which
        // is why the fallback is the part that matters: without it the field
        // has no accessible name at all in the app, however green a test that
        // supplies a placeholder looks.
        aria-label={props.placeholder ?? "Filter"}
        listLabel={props.title}
        emptyLabel="No matches"
        trailing={
          <Show when={query()}>
            <Button class={styles.pickerClear} variant="ghost" size="xs" aria-label="Clear" onClick={clear}>
              ×
            </Button>
          </Show>
        }
      />
    </Dialog>
  );
}
