import { For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import Button from "../Button/Button";
import styles from "./Toasts.module.css";

// A transient notification. `error` toasts are the common case (a failed git op,
// a rejected worktree removal); `info` is available for successes/notices.
//
// `action` is for a notice whose undo has nowhere else to live: a cross-file
// rename rewrote files the user is not looking at, and the moment they would
// want that back is the moment they are told about it. Not a general button
// slot - a toast dismisses itself, so anything that matters later belongs
// somewhere that persists.
export type ToastAction = { label: string; run: () => void };
export type Toast = { id: number; message: string; kind: "error" | "info"; action?: ToastAction };

// One toast row that auto-dismisses after `ttl` ms, pausing its own timer while
// hovered so a long git error stays readable. A manual close is always offered.
function ToastRow(props: { toast: Toast; ttl: number; onDismiss: (id: number) => void }) {
  let timer: number | undefined;

  function arm() {
    clear();
    timer = window.setTimeout(() => props.onDismiss(props.toast.id), props.ttl);
  }
  function clear() {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  }
  arm();
  onCleanup(clear);

  return (
    <div
      class={styles.toast}
      classList={{ [styles.error]: props.toast.kind === "error", [styles.info]: props.toast.kind === "info" }}
      onMouseEnter={() => clear()}
      onMouseLeave={() => arm()}
    >
      <span class={styles.toastMsg}>{props.toast.message}</span>
      <Show when={props.toast.action}>
        {(a) => (
          <Button
            class={styles.toastAction}
            size="xs"
            onClick={() => {
              a().run();
              props.onDismiss(props.toast.id);
            }}
          >
            {a().label}
          </Button>
        )}
      </Show>
      <Button class={styles.toastClose} variant="ghost" size="xs" aria-label="Dismiss" title="Dismiss" onClick={() => props.onDismiss(props.toast.id)}>
        ×
      </Button>
    </div>
  );
}

// A portaled, bottom-right stack of toasts. Newest at the bottom.
export default function Toasts(props: { toasts: Toast[]; ttl?: number; onDismiss: (id: number) => void }) {
  return (
    <Portal>
      <div class={styles.toastStack}>
        <For each={props.toasts}>
          {(t) => <ToastRow toast={t} ttl={props.ttl ?? 8000} onDismiss={props.onDismiss} />}
        </For>
      </div>
    </Portal>
  );
}
