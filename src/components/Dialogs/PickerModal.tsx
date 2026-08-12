import { createSignal, createMemo, createEffect, For, Show } from "solid-js";
import { fuzzyScore } from "../../utils/fuzzy";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

// The list and its rows are named by static ids: only one picker can be open at
// a time (it is raised from `askPick`, which awaits its own resolver), the same
// call `DebugTargetDialog` makes for its field labels.
const LIST_ID = "picker-list";
const optionId = (i: number) => `picker-option-${i}`;

// A filterable single-select picker. Replaces a comma-joined prompt title when
// the caller must pick one item from a potentially large list (e.g. attach one
// of 100s of local branches). Typing fuzzy-filters + ranks via the shared
// fuzzyScore; up/down wrap over the results, Enter/Ok commit, Esc or a click
// outside cancels. Row click commits that row.
//
// The shell is `Dialog`, and the rows are a real `listbox` of `option`s with the
// keyboard selection announced through `aria-activedescendant` on the input.
// That is the one body in this migration that changed rather than moved: the
// rows used to be unroled `div`s whose highlight existed only as a CSS class, so
// a keyboard user had a selection the browser could see and a screen reader
// could not. Focus stays on the input throughout, which is what
// `aria-activedescendant` is for.
//
// An empty result set renders no `listbox` at all, and drops the
// `aria-activedescendant` with it. A `listbox` whose only child is the "No
// matches" line owns no options (`aria-required-children`), and an
// activedescendant naming a row that is not on the page points at nothing.
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
  okLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  let input: HTMLInputElement | undefined;
  const rows: (HTMLDivElement | undefined)[] = [];

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

  // Keep the selection in range as the filtered results change.
  createEffect(() => {
    const n = results().length;
    if (index() >= n) setIndex(0);
  });

  // Scroll the highlighted row into view (net-new vs QuickOpen), so keyboard
  // nav over a long list never moves the selection off-screen.
  createEffect(() => {
    results(); // re-run when the list changes, not only on index change
    rows[index()]?.scrollIntoView({ block: "nearest" });
  });

  // Clear the filter and refocus the input so keyboard nav keeps working after
  // a mouse click on the clear button.
  function clear() {
    setQuery("");
    setIndex(0);
    input?.focus();
  }

  // Ok button: commit exactly what's in the input. An exact match to a listed
  // item selects it; else, when creatable, a non-empty query is a new value; else
  // the highlighted row. This is the deliberate create-new path.
  function commitTyped() {
    const q = query().trim();
    if (q && props.items.includes(q)) return props.onSubmit(q);
    if (q && props.creatable) return props.onSubmit(q);
    const hit = results()[index()];
    if (hit) props.onSubmit(hit);
  }

  // Enter: accept the highlighted suggestion whenever the list has any match, so
  // filtering-then-Enter (e.g. typing "mai" to reach "main") never accidentally
  // creates a branch. Only an empty result set falls through to create the typed
  // name (creatable), matching "if nothing in the list matches, create it".
  function commitEnter() {
    const hit = results()[index()];
    if (hit) return props.onSubmit(hit);
    const q = query().trim();
    if (q && props.creatable) props.onSubmit(q);
  }

  // Arrows and Enter, on the input: focus never leaves it, so there is no case
  // here that needs `Dialog`'s panel-level seam. Escape is Kobalte's, reported
  // back as `onClose`.
  function onKeyDown(e: KeyboardEvent) {
    const n = results().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (n ? (i + 1) % n : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (n ? (i - 1 + n) % n : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commitEnter();
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
      <div class={styles.pickerInputWrap}>
        <input
          ref={input}
          class={`${styles.input} ${styles.pickerInput}`}
          // No visible label line to borrow, unlike the other dialogs in this
          // set, and the panel title names the dialog rather than the field. A
          // placeholder is not a name (it goes away the moment anything is
          // typed) but it is the caller's own words for this list, so it is
          // reused as one where there is one. No caller passes it today, which
          // is why the fallback is the part that matters: without it the field
          // has no accessible name at all in the app, however green a test that
          // supplies a placeholder looks.
          aria-label={props.placeholder ?? "Filter"}
          aria-controls={LIST_ID}
          aria-activedescendant={results().length ? optionId(index()) : undefined}
          placeholder={props.placeholder}
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <Show when={query()}>
          <Button class={styles.pickerClear} variant="ghost" size="xs" aria-label="Clear" onClick={clear}>
            ×
          </Button>
        </Show>
      </div>
      {/* Always on the page so `aria-controls` always resolves; a `listbox`
          only while it has options to own. */}
      <div
        id={LIST_ID}
        class={styles.pickerList}
        role={results().length ? "listbox" : undefined}
        aria-label={results().length ? props.title : undefined}
      >
        <Show when={results().length} fallback={<div class={styles.pickerEmpty}>No matches</div>}>
          <For each={results()}>
            {(item, i) => (
              <div
                ref={(el) => (rows[i()] = el)}
                id={optionId(i())}
                role="option"
                aria-selected={i() === index()}
                class={styles.pickerItem}
                classList={{ [styles.active]: i() === index() }}
                onClick={() => props.onSubmit(item)}
                onMouseEnter={() => setIndex(i())}
              >
                {item}
              </div>
            )}
          </For>
        </Show>
      </div>
    </Dialog>
  );
}
