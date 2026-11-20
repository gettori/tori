import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { CircleAlert, CircleCheck, Info, X } from "lucide-solid";
import { Toast } from "../../lib/toast";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";
import { on as onEvent, onWith, FOCUS_TOASTS, TOAST, type ToastEvent } from "../../utils/events";
import styles from "./Toasts.module.css";

// A transient notification. `error` toasts are the common case (a failed git op,
// a rejected worktree removal), `success` is for an action that finished, and
// `info` is for a notice that is neither.
//
// `action` is for a notice whose undo has nowhere else to live: a cross-file
// rename rewrote files the user is not looking at, and the moment they would
// want that back is the moment they are told about it. Not a general button
// slot - a toast dismisses itself, so anything that matters later belongs
// somewhere that persists.
export type ToastAction = { label: string; run: () => void };
export type ToastKind = "error" | "info" | "success";

// An error stays until it is closed: it is the one kind that carries something
// to read or act on, and it often lands while the user is looking elsewhere.

const ICON = { error: CircleAlert, info: Info, success: CircleCheck };

const TTL = 8000;
const PEEKING = 3;
const SHOWN = 5;

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
      persistent={kind === "error"}
      class={`${styles.toast} ${styles[kind]}`}
    >
      <span class={styles.toastIcon} aria-hidden="true">
        <Icon icon={ICON[kind]} />
      </span>
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
 *  timers (8s, paused while hovered, focused or while the window is in the
 *  background), and Escape-dismissal of a focused toast; this component owns
 *  where toasts appear (portalled, bottom-right), the deck they stack into, and
 *  the TOAST event bridge.
 *
 *  Deliberate overrides of Kobalte's defaults: `limit` lifted (the deck shows
 *  the newest few and keeps the rest until those close), and the built-in
 *  Alt+T document listener disabled: Option+letter types a glyph on macOS and
 *  the listener never yields to a defaultPrevented key, so the combo lives in
 *  the command registry instead (`focus-toasts`, Cmd+Option+T) and arrives
 *  here as FOCUS_TOASTS.
 *
 *  Listeners registered in the component body, not onMount: an async mount gap
 *  is a window where a startup toast lands on nobody. */
export default function ToastRegion(props: { duration?: number }) {
  let listEl: HTMLDivElement | undefined;
  const [count, setCount] = createSignal(0);
  onCleanup(onWith<ToastEvent>(TOAST, (d) => pushToast(d.message, d.kind ?? "error", d.action)));
  onCleanup(onEvent(FOCUS_TOASTS, () => listEl?.focus({ preventScroll: true })));
  onMount(() => {
    if (listEl) onCleanup(observeStack(listEl, setCount));
  });
  return (
    <Portal>
      <Toast.Region
        aria-label="Notifications"
        // No key code is ever this string, which is the whole point: Kobalte
        // offers no off switch for its listener, only a combo to match.
        hotkey={["HandledByCommandRegistry"]}
        duration={props.duration ?? TTL}
        limit={Infinity}
        class={styles.toastRegion}
      >
        <Show when={count() > 1}>
          <div class={styles.clearAll}>
            <Button size="xs" onClick={() => Toast.toaster.clear()}>
              Clear all
            </Button>
          </div>
        </Show>
        <Toast.List as="div" ref={listEl} class={styles.toastStack} />
      </Toast.Region>
    </Portal>
  );
}

/** Lays the deck out from measured heights, which CSS cannot know: each toast
 *  gets its place counted from the newest, its natural height and its offset
 *  when fanned out, and the list gets the heights of both shapes. A toast on
 *  its way out (`data-closed`) has already left the deck, so the rest close up
 *  while it fades. */
function observeStack(list: HTMLElement, setCount: (n: number) => void): () => void {
  const layout = () => {
    const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
    const open = [...list.children]
      .filter((el): el is HTMLElement => el instanceof HTMLElement && !el.hasAttribute("data-closed"))
      .reverse();
    let offset = 0;
    open.forEach((el, i) => {
      const height = naturalHeight(el);
      el.dataset.stack = i === 0 ? "front" : i < PEEKING ? "peek" : i < SHOWN ? "tucked" : "hidden";
      el.style.setProperty("--toast-index", String(Math.min(i, PEEKING - 1)));
      el.style.setProperty("--toast-offset", `${offset}px`);
      el.style.setProperty("--toast-height", `${height}px`);
      if (i < SHOWN) offset += height + gap;
    });
    const front = open[0] ? naturalHeight(open[0]) : 0;
    const peeks = Math.min(open.length, PEEKING) - 1;
    list.style.setProperty("--toast-front-height", `${front}px`);
    list.style.setProperty("--stack-peeks", String(Math.max(0, peeks)));
    list.style.setProperty("--stack-expanded-height", `${Math.max(0, offset - gap)}px`);
    setCount(open.length);
  };
  const resize = new ResizeObserver(layout);
  const mutate = new MutationObserver(() => {
    for (const el of list.children) resize.observe(el);
    layout();
  });
  mutate.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-closed"] });
  layout();
  return () => {
    mutate.disconnect();
    resize.disconnect();
  };
}

/** A toast behind the front one is clamped to the front's height, so its own
 *  box cannot be measured; its parts are laid out at full size either way. */
function naturalHeight(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  const frame =
    parseFloat(cs.paddingTop) +
    parseFloat(cs.paddingBottom) +
    parseFloat(cs.borderTopWidth) +
    parseFloat(cs.borderBottomWidth);
  let content = 0;
  for (const child of el.children) content = Math.max(content, (child as HTMLElement).offsetHeight);
  return content + (frame || 0);
}
