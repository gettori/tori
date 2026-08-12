import { createSignal, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

// A text-input modal that replaces window.prompt, which macOS WKWebView
// (Tauri's webview) does not implement, so every prompt()-based sidebar action
// silently no-oped. Submit passes the raw value (which may be empty); cancel
// passes null. That mirrors the prompt() contract callers rely on, where "" is a
// distinct valid answer (e.g. blank = git default branch) separate from a
// cancel.
//
// The shell is `Dialog`, which owns the portal, the backdrop, Escape and the
// focus trap. Enter stays here, on the input, because it means "submit this
// field" rather than "dismiss the dialog"; Escape does not, because Kobalte
// already reports it as `onClose` and a second handler would resolve the same
// request twice.
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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    props.onSubmit(value());
  }

  return (
    <Dialog
      open
      title={props.title}
      onClose={() => props.onCancel()}
      // Selected as well as focused, so a suggested name is easy to overwrite.
      // The selection is made before the focus rather than after because this
      // returns the element for `Dialog` to focus; focusing an input does not
      // clear a selection it already has.
      initialFocus={() => {
        input?.select();
        return input;
      }}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" onClick={() => props.onSubmit(value())}>
            {props.okLabel ?? "OK"}
          </Button>
        </>
      }
    >
      <Show when={props.note}>
        <div class={styles.note}>{props.note}</div>
      </Show>
      <input
        ref={input}
        class={styles.input}
        aria-label={props.title}
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
    </Dialog>
  );
}
