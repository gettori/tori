import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

// A yes/no confirmation modal, the async replacement for window.confirm (which
// macOS WKWebView, Tauri's webview, does not implement, so every confirm()-gated
// action silently no-oped). Hosts hold a pending request + resolver (see
// askConfirm) exactly like PromptModal, resolving true on confirm and false on
// cancel.
//
// The shell is `Dialog`: the portal, the backdrop, Escape and the focus trap all
// come from there. Two things that used to be written here and are not any more:
//
//   * **Escape.** Kobalte closes on it and `Dialog` reports that as `onClose`,
//     which is the cancel. A second handler here would resolve the same request
//     twice.
//   * **Enter.** The confirm button takes focus on open, and a browser fires a
//     click on a focused button when Enter is pressed. The old handler sat on
//     the modal element and confirmed from anywhere inside it, which also fired
//     when Cancel had focus; letting the focused control answer for itself is
//     both less code and the less surprising of the two.
//
// The message stays in the body rather than becoming `Dialog`'s `description`,
// because only the body scrolls: a long approval message needs somewhere to go
// inside a panel with a max-height.
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

  return (
    <Dialog
      open
      title={props.title}
      onClose={() => props.onCancel()}
      initialFocus={() => ok}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button
            ref={ok}
            variant={props.danger ? "danger" : "primary"}
            onClick={() => props.onConfirm()}
          >
            {props.confirmLabel ?? "OK"}
          </Button>
        </>
      }
    >
      {/* A ternary rather than a `<Show>`: `Dialog` skips its scrollable body,
          and the tab stop that comes with it, only when `children` is actually
          nullish, and a `<Show>` element is not. */}
      {props.message == null ? undefined : (
        <div class={styles.msg}>{props.message}</div>
      )}
    </Dialog>
  );
}
