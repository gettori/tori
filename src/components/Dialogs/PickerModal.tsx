import { createSignal, createMemo, createEffect, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fuzzyScore } from "../../utils/fuzzy";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";

// A portaled, filterable single-select picker modal. Replaces a comma-joined
// prompt title when the caller must pick one item from a potentially large list
// (e.g. attach one of 100s of local branches). Typing fuzzy-filters + ranks via
// the shared fuzzyScore; up/down wrap over the results, Enter/Ok commit, Esc or a
// backdrop click cancels. Row click commits that row.
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

  onMount(() => {
    requestAnimationFrame(() => input?.focus());
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

  function onKeyDown(e: KeyboardEvent) {
    const n = results().length;
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "ArrowDown") {
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
    <Portal>
      <div class={styles.modalBackdrop} onMouseDown={() => props.onCancel()}>
        <div class={`${styles.modal} ${styles.picker}`} onMouseDown={(e) => e.stopPropagation()}>
          <div class={styles.modalTitle}>{props.title}</div>
          <div class={styles.pickerInputWrap}>
            <input
              ref={input}
              class={`${styles.modalInput} ${styles.pickerInput}`}
              placeholder={props.placeholder}
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setIndex(0);
              }}
              onKeyDown={onKeyDown}
            />
            <Show when={query()}>
              <button type="button" class={styles.pickerClear} aria-label="Clear" onClick={clear}>
                ×
              </button>
            </Show>
          </div>
          <div class={styles.pickerList}>
            <Show when={results().length} fallback={<div class={styles.pickerEmpty}>No matches</div>}>
              <For each={results()}>
                {(item, i) => (
                  <div
                    ref={(el) => (rows[i()] = el)}
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
          <div class={styles.modalActions}>
            <Button onClick={() => props.onCancel()}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => commitTyped()}>
              {props.okLabel ?? "OK"}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
