import { For, onCleanup, createSignal } from "solid-js";
import { Portal } from "solid-js/web";

// A transient notification. `error` toasts are the common case (a failed git op,
// a rejected worktree removal); `info` is available for successes/notices.
export type Toast = { id: number; message: string; kind: "error" | "info" };

// One toast row that auto-dismisses after `ttl` ms, pausing its own timer while
// hovered so a long git error stays readable. A manual close is always offered.
function ToastRow(props: { toast: Toast; ttl: number; onDismiss: (id: number) => void }) {
  let timer: number | undefined;
  const [paused, setPaused] = createSignal(false);

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
      class="toast"
      classList={{ error: props.toast.kind === "error", info: props.toast.kind === "info", paused: paused() }}
      onMouseEnter={() => {
        setPaused(true);
        clear();
      }}
      onMouseLeave={() => {
        setPaused(false);
        arm();
      }}
    >
      <span class="toast-msg">{props.toast.message}</span>
      <button class="toast-close" title="Dismiss" onClick={() => props.onDismiss(props.toast.id)}>
        ×
      </button>
    </div>
  );
}

// A portaled, bottom-right stack of toasts. Newest at the bottom.
export default function Toasts(props: { toasts: Toast[]; ttl?: number; onDismiss: (id: number) => void }) {
  return (
    <Portal>
      <div class="toast-stack">
        <For each={props.toasts}>
          {(t) => <ToastRow toast={t} ttl={props.ttl ?? 8000} onDismiss={props.onDismiss} />}
        </For>
      </div>
    </Portal>
  );
}
