import { createSignal, createMemo, createEffect, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fuzzyScore } from "../fuzzy";

// A portaled, filterable single-select picker modal. Replaces a comma-joined
// prompt title when the caller must pick one item from a potentially large list
// (e.g. attach one of 100s of local branches). Typing fuzzy-filters + ranks via
// the shared fuzzyScore; up/down wrap over the results, Enter selects the
// highlighted item, Esc or a backdrop click cancels. Select-only: Enter/click
// commit only a listed item, never the raw filter text. Cancel passes null via
// the caller's resolver, mirroring the PromptModal contract.
export default function PickerModal(props: {
  title: string;
  items: string[];
  placeholder?: string;
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
      const hit = results()[index()];
      if (hit) props.onSubmit(hit); // no-op when there are zero matches
    }
  }

  return (
    <Portal>
      <div class="modal-backdrop picker-backdrop" onMouseDown={() => props.onCancel()}>
        <div class="modal picker" onMouseDown={(e) => e.stopPropagation()}>
          <div class="modal-title">{props.title}</div>
          <div class="picker-input-wrap">
            <input
              ref={input}
              class="modal-input picker-input"
              placeholder={props.placeholder}
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setIndex(0);
              }}
              onKeyDown={onKeyDown}
            />
            <Show when={query()}>
              <button type="button" class="picker-clear" aria-label="Clear" onClick={clear}>
                ×
              </button>
            </Show>
          </div>
          <div class="picker-list">
            <Show when={results().length} fallback={<div class="picker-empty">No matches</div>}>
              <For each={results()}>
                {(item, i) => (
                  <div
                    ref={(el) => (rows[i()] = el)}
                    class="picker-item"
                    classList={{ active: i() === index() }}
                    onClick={() => props.onSubmit(item)}
                    onMouseEnter={() => setIndex(i())}
                  >
                    {item}
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
