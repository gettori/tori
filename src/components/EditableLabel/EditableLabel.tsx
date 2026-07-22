import { createEffect, on, Show } from "solid-js";
import styles from "./EditableLabel.module.css";

// An inline-editable text label: shows `value` as a span, and on a caller-owned
// `editing` flag swaps to a text field seeded with `value`. Enter (or blur)
// commits the trimmed text, Escape reverts. The parent owns the `editing`
// signal so it can also react to the edit (e.g. suspend row drag while active)
// and so only one label edits at a time.
//
// Why the parent owns `editing` rather than this component: the row/tab this
// sits in is `draggable`, and a live drag would fight text selection; the
// parent flips `draggable` off for the item being edited. Double-click starts
// it via `onEdit` (a no-op the parent can decline, e.g. non-session tabs).
export default function EditableLabel(props: {
  value: string;
  editing: boolean;
  class?: string;
  title?: string;
  /** Double-click on the label. The parent decides whether to start editing. */
  onEdit: () => void;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  let inputEl: HTMLInputElement | undefined;
  // Guards the trailing blur that fires when Enter/Escape unmounts the input:
  // without it, committing/cancelling would run twice (once from the key, once
  // from the blur the unmount triggers).
  let finishing = false;

  createEffect(
    on(
      () => props.editing,
      (editing) => {
        if (!editing) return;
        finishing = false;
        // Focus + select once the input is in the DOM.
        queueMicrotask(() => {
          inputEl?.focus();
          inputEl?.select();
        });
      },
    ),
  );

  const finish = (save: boolean) => {
    if (finishing) return;
    finishing = true;
    const next = (inputEl?.value ?? "").trim();
    if (save && next && next !== props.value) props.onCommit(next);
    else props.onCancel();
  };

  return (
    <Show
      when={props.editing}
      fallback={
        <span
          class={props.class}
          title={props.title}
          onDblClick={(e) => {
            e.stopPropagation();
            props.onEdit();
          }}
        >
          {props.value}
        </span>
      }
    >
      <input
        ref={inputEl}
        class={`${props.class ?? ""} ${styles.input}`}
        value={props.value}
        spellcheck={false}
        autocomplete="off"
        // Keep every gesture inside the field: the containing row/tab owns
        // click-to-select and (for the sidebar) drag, none of which should fire
        // while renaming.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
      />
    </Show>
  );
}
