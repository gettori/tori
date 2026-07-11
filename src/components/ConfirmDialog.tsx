import { onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";

// A portaled yes/no confirmation modal, the async replacement for window.confirm
// (which macOS WKWebView, Tauri's webview, does not implement, so every
// confirm()-gated action silently no-oped). Enter confirms, Escape or a backdrop
// click cancels. Hosts hold a pending request + resolver (see askConfirm) exactly
// like PromptModal, resolving true on confirm and false on cancel.
export type ConfirmOpts = {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
};
export type ConfirmReq = ConfirmOpts & { resolve: (v: boolean) => void };

export default function ConfirmDialog(props: {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  let ok: HTMLButtonElement | undefined;
  onMount(() => requestAnimationFrame(() => ok?.focus()));

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      props.onConfirm();
    }
  }

  return (
    <Portal>
      <div class="modal-backdrop" onMouseDown={() => props.onCancel()}>
        <div class="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <div class="modal-title">{props.title}</div>
          <Show when={props.message}>
            <div class="modal-msg">{props.message}</div>
          </Show>
          <div class="modal-actions">
            <button class="modal-btn" onClick={() => props.onCancel()}>
              Cancel
            </button>
            <button
              ref={ok}
              class={`modal-btn ${props.danger ? "danger" : "primary"}`}
              onClick={() => props.onConfirm()}
            >
              {props.confirmLabel ?? "OK"}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
