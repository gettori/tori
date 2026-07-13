import { createSignal, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import styles from "./Dialogs.module.css";

// A portaled text-input modal that replaces window.prompt, which macOS WKWebView
// (Tauri's webview) does not implement, so every prompt()-based sidebar action
// silently no-oped. Enter submits, Escape or a backdrop click cancels. Submit
// passes the raw value (which may be empty); cancel passes null. That mirrors
// the prompt() contract callers rely on, where "" is a distinct valid answer
// (e.g. blank = git default branch) separate from a cancel.
export default function PromptModal(props: {
  title: string;
  initial?: string;
  okLabel?: string;
  // An optional muted line shown above the input (e.g. the current value being
  // replaced), so a "change X" dialog can display the old value.
  note?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = createSignal(props.initial ?? "");
  let input: HTMLInputElement | undefined;

  // Focus and select the seeded value so a suggested name is easy to overwrite.
  onMount(() => {
    requestAnimationFrame(() => {
      input?.focus();
      input?.select();
    });
  });

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      props.onSubmit(value());
    }
  }

  return (
    <Portal>
      <div class={styles.modalBackdrop} onMouseDown={() => props.onCancel()}>
        <div class={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
          <div class={styles.modalTitle}>{props.title}</div>
          <Show when={props.note}>
            <div class={styles.modalNote}>{props.note}</div>
          </Show>
          <input
            ref={input}
            class={styles.modalInput}
            value={value()}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <div class={styles.modalActions}>
            <button class={styles.modalBtn} onClick={() => props.onCancel()}>
              Cancel
            </button>
            <button class={`${styles.modalBtn} ${styles.primary}`} onClick={() => props.onSubmit(value())}>
              {props.okLabel ?? "OK"}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
