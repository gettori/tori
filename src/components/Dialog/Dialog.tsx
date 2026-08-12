import { Show, type JSX } from "solid-js";
import { Dialog as Primitive } from "../../lib/dialog";
import styles from "./Dialog.module.css";

/** How wide the panel is. `confirm` and `sheet` are fixed ladders on
 *  `--ui-scale`; `wide` grows with the viewport (see Dialog.module.css). */
export type DialogSize = "confirm" | "sheet" | "wide";

export interface DialogProps {
  open: boolean;
  /** The accessible name, always. `titleHidden` keeps it out of the layout
   *  without taking it out of the accessibility tree. */
  title: string;
  titleHidden?: boolean;
  description?: string;
  size?: DialogSize;
  /** What to focus when the dialog opens. Defaults to the panel itself. */
  initialFocus?: () => HTMLElement | undefined;
  onClose: () => void;
  /** The button row, pinned below the scrolling body. */
  actions?: JSX.Element;
  /** Extra class on the panel, for a dialog whose body needs its own layout
   *  (the picker's scroll geometry, an icon grid). */
  class?: string;
  children?: JSX.Element;
}

/**
 * The one modal surface: Kobalte's dialog behind Sway's chrome and Sway's API.
 * Every dialog in the app composes this, so the Portal, the backdrop, Escape,
 * the focus trap and focus restore are written once instead of fourteen times.
 *
 * Two things Kobalte does not do for this app, and this wrapper does:
 *
 * **`aria-modal` is ours.** `DialogContent` sets `role="dialog"` and wires
 * `aria-labelledby`/`aria-describedby`, but modality is expressed by
 * aria-hiding everything else, not by the attribute. Sway asserts the attribute
 * in its own tests, so it is passed explicitly.
 *
 * **Focus restore is ours.** In modal mode Kobalte's close handler calls
 * `preventDefault()` and then focuses its `Trigger`. Sway's dialogs are opened
 * from app state (`askConfirm`, a hotkey, an `askpass://prompt` event) and have
 * no trigger element, so that restore is a no-op and the default one has
 * already been suppressed: focus would land nowhere and the next keystroke
 * would go to `document.body` rather than back to the terminal. So the element
 * that had focus at open time is captured and restored here.
 *
 * Both auto-focus events are dispatched by Kobalte's focus scope, and the
 * unmount one fires from a `setTimeout(0)` after cleanup, so a test asserting
 * on restored focus has to await a macrotask.
 */
export default function Dialog(props: DialogProps) {
  let panel: HTMLElement | undefined;
  let restoreTo: HTMLElement | null = null;

  function onOpenAutoFocus(e: Event) {
    // Kobalte dispatches this *before* focusing anything, so the active element
    // is still whatever the dialog interrupted.
    const previous = document.activeElement;
    restoreTo =
      previous instanceof HTMLElement && previous !== document.body
        ? previous
        : null;

    e.preventDefault();
    (props.initialFocus?.() ?? panel)?.focus({ preventScroll: true });
  }

  function onCloseAutoFocus(e: Event) {
    // Already prevented means the focus scope found focus outside the panel on
    // something focusable: something else deliberately took it, so leave it.
    if (e.defaultPrevented) {
      restoreTo = null;
      return;
    }
    e.preventDefault();
    restoreTo?.focus({ preventScroll: true });
    restoreTo = null;
  }

  return (
    <Primitive.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay class={styles.backdrop} />
        <Primitive.Content
          ref={panel}
          aria-modal="true"
          class={props.class}
          classList={{
            [styles.panel]: true,
            [styles[props.size ?? "confirm"]]: true,
          }}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <div class={styles.head}>
            <Primitive.Title
              class={props.titleHidden ? styles.titleHidden : styles.title}
            >
              {props.title}
            </Primitive.Title>
            <Show when={props.description}>
              <Primitive.Description class={styles.description}>
                {props.description}
              </Primitive.Description>
            </Show>
          </div>
          {/* Focusable because it scrolls. A dialog whose body holds no
              control of its own (a long confirmation, a list of rows) would
              otherwise be unscrollable by keyboard: the panel has focus but
              the body is the scroller, and the page behind is locked. This is
              what axe's `scrollable-region-focusable` asks for, and that rule
              is disabled under jsdom (no scroll geometry), so no test here can
              catch its absence. The cost is one tab stop per dialog; rendered
              only when there is a body at all. */}
          <Show when={props.children != null}>
            <div class={styles.body} tabindex={0}>
              {props.children}
            </div>
          </Show>
          <Show when={props.actions}>
            <div class={styles.actions}>{props.actions}</div>
          </Show>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
