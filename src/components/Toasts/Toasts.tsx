import { createEffect, createSignal, createUniqueId, For, onCleanup, Show, untrack, type Accessor } from "solid-js";
import { Portal } from "solid-js/web";
import { CircleAlert, CircleCheck, Info, X } from "lucide-solid";
import { createPresence, watchTopModal } from "../../lib/layer";
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

const SWIPE_START_MOUSE = 2;
const SWIPE_START_TOUCH = 10;
const SWIPE_DISMISS = 50;

type ToastItem = {
  id: number;
  text: string;
  kind: ToastKind;
  actions: ToastAction[];
  dismissed: Accessor<boolean>;
  dismiss: () => void;
};

const [toasts, setToasts] = createSignal<readonly ToastItem[]>([]);
let nextId = 0;
let regions = 0;

/** Surface a toast from anywhere. The write API for the whole app: the TOAST
 *  event lands here, and the sidebar's `setError` forwards here. Empty and
 *  whitespace-only messages are a no-op, preserving the old "clear the banner"
 *  idiom that some `setError("")` call sites still use. */
export function pushToast(message: string, kind: ToastKind = "error", action?: ToastAction | ToastAction[]) {
  const text = String(message ?? "").trim();
  if (!text) return;
  const [dismissed, setDismissed] = createSignal(false);
  const item: ToastItem = {
    id: nextId++,
    text,
    kind,
    actions: action ? [action].flat() : [],
    dismissed,
    dismiss: () => setDismissed(true),
  };
  setToasts((list) => [...list, item]);
}

export function clearToasts() {
  if (regions === 0) setToasts([]);
  else for (const toast of toasts()) toast.dismiss();
}

function ToastCard(props: { toast: ToastItem; duration: number; paused: Accessor<boolean> }) {
  const toast = props.toast;
  const titleId = `toast-${createUniqueId()}-title`;
  const [element, setElement] = createSignal<HTMLDivElement>();
  const presence = createPresence(() => !toast.dismissed(), element);

  createEffect(() => {
    if (!presence.mounted()) setToasts((list) => list.filter((other) => other !== toast));
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let startedAt = 0;
  let remaining = props.duration;
  const stopTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining -= Date.now() - startedAt;
  };
  createEffect(() => {
    if (toast.kind === "error") return;
    if (toast.dismissed() || props.paused()) {
      stopTimer();
      return;
    }
    startedAt = Date.now();
    timer = setTimeout(toast.dismiss, remaining);
  });
  onCleanup(stopTimer);

  let swipeFrom: { x: number; y: number } | null = null;
  let swipedBy: number | null = null;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 0) swipeFrom = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!swipeFrom) return;
    const x = Math.max(0, e.clientX - swipeFrom.x);
    const rawX = e.clientX - swipeFrom.x;
    const y = e.clientY - swipeFrom.y;
    if (swipedBy !== null) {
      swipedBy = x;
      return;
    }
    const buffer = e.pointerType === "touch" ? SWIPE_START_TOUCH : SWIPE_START_MOUSE;
    if (x > Math.abs(y) && x > buffer) {
      swipedBy = x;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } else if (Math.abs(rawX) > buffer || Math.abs(y) > buffer) {
      swipeFrom = null;
    }
  };
  const onPointerUp = (e: PointerEvent & { currentTarget: HTMLDivElement }) => {
    const swiped = swipedBy;
    const target = e.target as HTMLElement;
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
    swipeFrom = null;
    swipedBy = null;
    if (swiped === null) return;
    if (swiped > SWIPE_DISMISS) toast.dismiss();
    // The release of a swipe must not also press the button under it.
    e.currentTarget.addEventListener("click", (click) => click.preventDefault(), { once: true });
  };

  return (
    <Show when={presence.mounted()}>
      {/* A div, and the same on the list: role="status" strips an li of its
          listitem role, which fails axe's `list` rule. */}
      <div
        ref={setElement}
        role="status"
        tabindex={0}
        style={{ "user-select": "none", "touch-action": "none" }}
        aria-live="assertive"
        aria-atomic="true"
        aria-labelledby={titleId}
        data-opened={presence.closed() ? undefined : ""}
        data-closed={presence.closed() ? "" : undefined}
        data-swipe-direction="right"
        class={`${styles.toast} ${styles[toast.kind]}`}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          // Spent here, so a dialog around the region stays open.
          e.preventDefault();
          toast.dismiss();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span class={styles.toastIcon} aria-hidden="true">
          <Icon icon={ICON[toast.kind]} />
        </span>
        <div id={titleId} class={styles.toastMsg}>
          {toast.text}
        </div>
        <For each={toast.actions}>
          {(a) => (
            <Button
              size="xs"
              class={styles.toastAction}
              aria-label={a.label}
              onClick={() => {
                a.run();
                toast.dismiss();
              }}
            >
              {a.label}
            </Button>
          )}
        </For>
        <IconButton
          icon={<Icon icon={X} />}
          size="xs"
          class={styles.toastClose}
          aria-label="Dismiss"
          tooltip="Dismiss"
          onClick={toast.dismiss}
        />
      </div>
    </Show>
  );
}

function RegionSurface(props: { duration: number }) {
  let region!: HTMLDivElement;
  let list!: HTMLDivElement;
  const [count, setCount] = createSignal(0);
  const [paused, setPaused] = createSignal(false);

  onCleanup(onEvent(FOCUS_TOASTS, () => list.focus({ preventScroll: true })));

  const pause = () => setPaused(true);
  const resume = () => setPaused(false);
  window.addEventListener("blur", pause);
  window.addEventListener("focus", resume);
  onCleanup(() => {
    window.removeEventListener("blur", pause);
    window.removeEventListener("focus", resume);
  });

  const raise = (parent: HTMLElement, fresh?: Element | null) => {
    const focused = region.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    region.hidePopover();
    if (region.parentElement !== parent) parent.append(region);
    region.showPopover();
    for (const toast of list.children) {
      if (toast === fresh || toast.hasAttribute("data-closed")) continue;
      // Showing again restarts the entrance on toasts already on screen.
      for (const animation of toast.getAnimations?.() ?? []) animation.finish();
    }
    focused?.focus({ preventScroll: true });
  };

  createEffect(() =>
    untrack(() => {
      const home = region.parentElement!;
      region.showPopover();
      onCleanup(observeStack(list, setCount));
      // Inside the top modal, because everything outside one is inert. A move
      // drops the popover from the top layer, so it is shown again after.
      const stop = watchTopModal((modal) => {
        const parent = modal ?? home;
        if (region.parentElement !== parent) raise(parent);
      });
      onCleanup(() => {
        stop();
        region.remove();
      });
    }),
  );

  // The top layer paints in show order, so a new toast has to clear an open menu.
  createEffect((before: number) => {
    const now = toasts().length;
    if (now > before) untrack(() => raise(region.parentElement!, list.lastElementChild));
    return now;
  }, toasts().length);

  return (
    <div
      ref={region}
      popover="manual"
      role="region"
      tabindex={-1}
      aria-label="Notifications"
      style={{ "pointer-events": toasts().length > 0 ? "auto" : "none" }}
      class={styles.toastRegion}
      // Only inside a dialog: its Enter-to-confirm must not hear a toast's keys.
      onKeyDown={(e) => {
        if (region.closest("dialog")) e.stopPropagation();
      }}
    >
      <Show when={count() > 1}>
        <div class={styles.clearAll}>
          <Button size="xs" onClick={clearToasts}>
            Clear all
          </Button>
        </div>
      </Show>
      <div
        ref={list}
        tabindex={-1}
        class={styles.toastStack}
        onFocusIn={pause}
        onFocusOut={(e) => {
          if (!list.contains(e.relatedTarget as Node | null)) resume();
        }}
        onPointerMove={pause}
        onPointerLeave={() => {
          if (!list.contains(document.activeElement)) resume();
        }}
      >
        <For each={toasts()}>{(toast) => <ToastCard toast={toast} duration={props.duration} paused={paused} />}</For>
      </div>
    </div>
  );
}

/** The one toast region, mounted once by App: where toasts appear, the deck
 *  they stack into, and the TOAST event bridge. Timers run 8s, paused while the
 *  deck is hovered or focused or the window is in the background.
 *
 *  The listener is registered in the component body: an async mount gap is a
 *  window where a startup toast lands on nobody. */
export default function ToastRegion(props: { duration?: number }) {
  regions++;
  onCleanup(() => regions--);
  onCleanup(onWith<ToastEvent>(TOAST, (d) => pushToast(d.message, d.kind ?? "error", d.action)));
  return (
    <Portal>
      <RegionSurface duration={props.duration ?? TTL} />
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
