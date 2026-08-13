import { createSignal, Show, type JSX } from "solid-js";
import { Dialog as Primitive } from "../../lib/dialog";
import { DialogSurface } from "./surface";
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
  /** Keys pressed anywhere inside the panel, including the actions row and the
   *  panel itself. For the dialog whose Enter cannot be answered by whatever
   *  has focus: a gated confirm button is `disabled` (so the browser fires no
   *  click on it), and a dialog that names no `initialFocus`, or names one that
   *  resolves to nothing, leaves focus on the panel where no control answers at
   *  all. Escape is not this handler's business - Kobalte closes on it and
   *  reports that through `onClose`, so handling it here would fire twice. */
  onKeyDown?: (e: KeyboardEvent) => void;
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
 * Three things Kobalte does not do for this app, and this wrapper does:
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
 * on restored focus has to await a macrotask. When the element captured at open
 * time is gone by the time the dialog closes, which is every dialog opened from
 * a context-menu row, the restore is a no-op and focus lands on `<body>`.
 *
 * **A key seam is ours.** `onKeyDown` reaches the whole panel, including the
 * actions row, which is this component's markup rather than the caller's
 * children. A dialog whose confirm is gated cannot lean on the browser clicking
 * its focused button (a `disabled` button is not clicked), and one whose
 * `initialFocus` resolves to nothing leaves focus on the panel, where no
 * control answers at all. See `DebugTargetDialog` in file mode for both at once.
 */
export default function Dialog(props: DialogProps) {
  let panel: HTMLElement | undefined;
  let restoreTo: HTMLElement | null = null;
  // The same element as `panel`, published reactively for whatever inside the
  // dialog has to portal into it rather than onto the body (see surface.ts).
  // A plain `let` cannot serve: the panel does not exist when the children
  // first run, so a consumer reading it once would read `undefined` forever.
  const [surface, setSurface] = createSignal<HTMLElement>();

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

    // The named element can refuse focus, and the common way is being
    // `disabled`: a dialog that names its confirm button and opens in a busy
    // state (a removal already running, see WorktreeRemoveDialog) names a
    // button the browser will not focus. Without this, focus stays on whatever
    // was outside the dialog, the trap has nothing to hold, and closing a
    // dialog stacked on top of this one restores focus to nowhere.
    if (panel && !panel.contains(document.activeElement)) {
      panel.focus({ preventScroll: true });
    }
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
          ref={(el: HTMLElement) => {
            panel = el;
            setSurface(el);
          }}
          aria-modal="true"
          class={props.class}
          classList={{
            [styles.panel]: true,
            [styles[props.size ?? "confirm"]]: true,
          }}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onKeyDown={(e: KeyboardEvent) => props.onKeyDown?.(e)}
        >
          <DialogSurface.Provider value={surface}>
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
          </DialogSurface.Provider>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
