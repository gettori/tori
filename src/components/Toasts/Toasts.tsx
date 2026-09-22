import { For, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { Toast } from "../../lib/toast";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";
import { on as onEvent, onWith, FOCUS_TOASTS, TOAST, type ToastEvent } from "../../utils/events";
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
export type ToastKind = "error" | "info";

const TTL = 8000;

/** Surface a toast from anywhere. The write API for the whole app: the TOAST
 *  event lands here, and the sidebar's `setError` forwards here. Empty and
 *  whitespace-only messages are a no-op, preserving the old "clear the banner"
 *  idiom that some `setError("")` call sites still use. */
export function pushToast(message: string, kind: ToastKind = "error", action?: ToastAction | ToastAction[]) {
  const text = String(message ?? "").trim();
  if (!text) return;
  const actions = action ? [action].flat() : [];
  Toast.toaster.show((props) => (
    // `as="div"`, and the same on the List: Kobalte's default ol/li fails
    // axe's `list` rule, because role="status" strips the li of its listitem
    // role and an ol may only contain listitems. A stack of independent
    // status elements is not a list in any meaningful sense anyway.
    <Toast.Root
      as="div"
      toastId={props.toastId}
      class={`${styles.toast} ${kind === "error" ? styles.error : styles.info}`}
    >
      <Toast.Title class={styles.toastMsg}>{text}</Toast.Title>
      <For each={actions}>
        {(a) => (
          // CloseButton rather than a bare Button: Kobalte runs our onClick
          // first, then closes, which is exactly the old run-then-dismiss.
          // The aria-label restates the visible label so the accessible name
          // is never CloseButton's default "Close" under an "Undo" label.
          <Toast.CloseButton
            as={Button}
            size="xs"
            class={styles.toastAction}
            aria-label={a.label}
            onClick={() => a.run()}
          >
            {a.label}
          </Toast.CloseButton>
        )}
      </For>
      <Toast.CloseButton
        as={IconButton}
        icon={<Icon icon={X} />}
        size="xs"
        class={styles.toastClose}
        aria-label="Dismiss"
        tooltip="Dismiss"
      />
    </Toast.Root>
  ));
}

/** The one toast region, mounted once by App. Kobalte owns the list, the
 *  timers (8s, paused while hovered or focused), and Escape-dismissal of a
 *  focused toast; this component owns where toasts appear (portalled,
 *  bottom-right, newest at the bottom) and the TOAST event bridge.
 *
 *  Deliberate overrides of Kobalte's defaults, per the #105 characterization:
 *  `limit` lifted (the old stack never capped), `pauseOnPageIdle` off (toasts
 *  keep dismissing while the window is blurred, as before), and the built-in
 *  Alt+T document listener disabled: Option+letter types a glyph on macOS and
 *  the listener never yields to a defaultPrevented key, so the combo lives in
 *  the command registry instead (`focus-toasts`, Cmd+Option+T) and arrives
 *  here as FOCUS_TOASTS.
 *
 *  Listeners registered in the component body, not onMount: an async mount gap
 *  is a window where a startup toast lands on nobody. */
export default function ToastRegion() {
  let listEl: HTMLDivElement | undefined;
  onCleanup(onWith<ToastEvent>(TOAST, (d) => pushToast(d.message, d.kind ?? "error", d.action)));
  onCleanup(onEvent(FOCUS_TOASTS, () => listEl?.focus({ preventScroll: true })));
  return (
    <Portal>
      <Toast.Region
        aria-label="Notifications"
        // No key code is ever this string, which is the whole point: Kobalte
        // offers no off switch for its listener, only a combo to match.
        hotkey={["HandledByCommandRegistry"]}
        duration={TTL}
        limit={Infinity}
        pauseOnPageIdle={false}
        class={styles.toastRegion}
      >
        <Toast.List as="div" ref={listEl} class={styles.toastStack} />
      </Toast.Region>
    </Portal>
  );
}
