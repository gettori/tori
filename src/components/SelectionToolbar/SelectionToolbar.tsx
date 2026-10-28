import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import styles from "./SelectionToolbar.module.css";

/** Each selected line as a Markdown quote, then a blank line so what follows
 *  reads as the reply rather than as more of the quote. */
export function quoteBlock(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return `${lines.map((line) => `> ${line}`).join("\n")}\n\n`;
}

// A selection that starts or ends in one of these is the user editing, not
// reading: the question card's Other box and the permission prompt live inside
// the transcript too, and a PDF's toolbar has fields of its own.
const EDITABLE = "textarea, input, select, [contenteditable]:not([contenteditable='false'])";

/** The selection's range when it is non-empty and both ends sit inside `root`
 *  and outside any control, else null. */
export function selectionWithin(root: HTMLElement, sel: Selection | null): Range | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  for (const node of [range.startContainer, range.endContainer]) {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el || !root.contains(el) || el.closest(EDITABLE)) return null;
  }
  return range;
}

export type SelectionAction = { label: string; run: (text: string) => void };

/**
 * Actions floating by a selection.
 *
 * One per surface that offers them (a chat transcript, a PDF), each answering
 * only for its own root: every attached tab stays mounted, so a document-wide
 * listener that did not check containment would draw a toolbar under every
 * hidden chat as well.
 */
export default function SelectionToolbar(props: {
  root: () => HTMLElement | undefined;
  actions: readonly SelectionAction[];
}) {
  const [range, setRange] = createSignal<Range | null>(null);
  const [pos, setPos] = createSignal({ x: 0, y: 0 });

  function place(r: Range) {
    // jsdom has no Range geometry; the toolbar then sits at the origin.
    if (typeof r.getBoundingClientRect !== "function") return;
    const box = r.getBoundingClientRect();
    setPos({ x: box.left, y: box.bottom });
  }
  function sync() {
    const root = props.root();
    const r = root ? selectionWithin(root, document.getSelection()) : null;
    setRange(r);
    if (r) place(r);
  }
  // The transcript scrolls under a standing selection without any
  // selectionchange, so the toolbar follows the rect on scroll.
  function follow() {
    const r = range();
    if (r) place(r);
  }

  onMount(() => {
    document.addEventListener("selectionchange", sync);
    document.addEventListener("scroll", follow, true);
    onCleanup(() => {
      document.removeEventListener("selectionchange", sync);
      document.removeEventListener("scroll", follow, true);
    });
  });

  return (
    <Show when={range()}>
      {(r) => (
        <div
          role="toolbar"
          aria-label="Selection"
          class={styles.toolbar}
          style={{ left: `${pos().x}px`, top: `${pos().y + 4}px` }}
          // Mousedown would move focus and collapse the selection before the
          // click lands, and then there would be nothing to act on.
          onMouseDown={(e) => e.preventDefault()}
        >
          <For each={props.actions}>
            {(action) => (
              <button
                type="button"
                class={styles.action}
                onClick={() => {
                  // The selection's own text, which keeps a line break between
                  // blocks where the bare range would run them together.
                  action.run(document.getSelection()?.toString() || r().toString());
                  setRange(null);
                }}
              >
                {action.label}
              </button>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}
