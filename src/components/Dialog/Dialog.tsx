import { createSignal, createUniqueId, onCleanup, Show, type Accessor, onSettled } from "solid-js";
import { type JSX, Portal } from "@solidjs/web";
import { createPresence, openLayer } from "../../lib/layer";
import { DialogSurface } from "./surface";
import styles from "./Dialog.module.css";

/** How wide the panel is. `confirm` and `sheet` are fixed ladders on
 *  `--ui-scale`; `wide` grows with the viewport (see Dialog.module.css). */
export type DialogSize = "confirm" | "sheet" | "palette" | "table" | "wide";

export interface DialogProps {
  open: boolean;
  /** The accessible name, always. `titleHidden` keeps it out of the layout
   *  without taking it out of the accessibility tree. */
  title: string;
  titleHidden?: boolean;
  /** A glyph before the title, such as the space a dialog acts in. */
  lead?: JSX.Element;
  description?: string;
  size?: DialogSize;
  placement?: "center" | "top";
  /** What to focus when the dialog opens. Defaults to the panel itself. */
  initialFocus?: () => HTMLElement | undefined;
  onClose: () => void;
  /** Keys pressed anywhere inside the panel, including the actions row and the
   *  panel itself. For the dialog whose Enter cannot be answered by whatever
   *  has focus: a gated confirm button is `disabled` (so the browser fires no
   *  click on it), and a dialog that names no `initialFocus`, or names one that
   *  resolves to nothing, leaves focus on the panel where no control answers at
   *  all. Escape is not this handler's business: the dialog closes on it and
   *  reports that through `onClose`, so handling it here would fire twice. */
  onKeyDown?: (e: KeyboardEvent) => void;
  /** The button row, pinned below the scrolling body. */
  actions?: JSX.Element;
  /** Extra class on the panel, for a dialog whose body needs its own layout
   *  (the picker's scroll geometry, an icon grid). */
  class?: string;
  children?: JSX.Element;
}

// Its own component so the effect runs after the portal has connected it:
// showModal throws on a node that is not in the document.
function DialogPanel(props: {
  dialog: DialogProps;
  surface: Accessor<HTMLDialogElement | undefined>;
  onSurface: (el: HTMLDialogElement | undefined) => void;
  closed: boolean;
}) {
  const id = createUniqueId();
  const titleId = `dialog-${id}-title`;
  const descriptionId = `dialog-${id}-description`;
  let panel!: HTMLDialogElement;

  onSettled(() => {
    // Not the pressed opener: in WebKit that would pop its tooltip on close.
    const active = document.activeElement;
    const restoreTo = active instanceof HTMLElement && active !== document.body ? active : null;
    return openLayer({
      element: panel,
      modal: true,
      returnFocus: () => restoreTo,
      show: () => {
        // Inert while opening, or showModal focuses the first control and fires its handlers.
        panel.inert = true;
        panel.showModal();
        panel.inert = false;
        // WebKit ignores preventScroll on a target it has not laid out yet.
        void panel.offsetHeight;
        (props.dialog.initialFocus?.() ?? panel).focus({ preventScroll: true });
        // A disabled confirm in a dialog that opens busy refuses focus.
        if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
      },
      hide: () => panel.close(),
      onDismiss: () => {
        if (props.dialog.open) props.dialog.onClose();
      },
      closing: () => !props.dialog.open,
    });
  });
  onCleanup(() => props.onSurface(undefined));

  const panelClass = () =>
    [
      props.dialog.class,
      styles.panel,
      styles[props.dialog.size ?? "confirm"],
      props.dialog.placement === "top" && styles.top,
    ]
      .filter(Boolean)
      .join(" ");
  const titleClass = () =>
    [props.dialog.titleHidden ? styles.titleHidden : styles.title, props.dialog.lead && styles.titleLed]
      .filter(Boolean)
      .join(" ");

  return (
    <dialog
      ref={(el) => {
        panel = el;
        props.onSurface(el);
      }}
      role="dialog"
      // The panel is the focus target when a dialog names none, which Solid's types forbid.
      {...{ tabindex: -1 as never }}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={props.dialog.description ? descriptionId : undefined}
      data-expanded={props.closed ? undefined : ""}
      data-closed={props.closed ? "" : undefined}
      class={panelClass()}
      onKeyDown={(e) => props.dialog.onKeyDown?.(e)}
    >
      <DialogSurface value={props.surface}>
        <div class={props.dialog.titleHidden && !props.dialog.description ? styles.headHidden : styles.head}>
          <h2 id={titleId} class={titleClass()}>
            <Show when={props.dialog.lead}>
              <span class={styles.lead} aria-hidden="true">
                {props.dialog.lead}
              </span>
            </Show>
            {props.dialog.title}
          </h2>
          <Show when={props.dialog.description}>
            <p id={descriptionId} class={styles.description}>
              {props.dialog.description}
            </p>
          </Show>
        </div>
        <Show when={props.dialog.children != null}>
          <div class={styles.body} tabindex={0}>
            {props.dialog.children}
          </div>
        </Show>
        <Show when={props.dialog.actions}>
          <div class={styles.actions}>{props.dialog.actions}</div>
        </Show>
      </DialogSurface>
    </dialog>
  );
}

/**
 * The one modal surface. Every dialog in the app composes this, so the portal,
 * the backdrop, Escape, focus and focus restore are written once.
 *
 * `onKeyDown` reaches the whole panel, including the actions row. A dialog whose
 * confirm is gated cannot lean on the browser clicking its focused button, and
 * one whose `initialFocus` resolves to nothing leaves focus on the panel. See
 * `DebugTargetDialog` in file mode for both at once.
 */
export default function Dialog(props: DialogProps) {
  const [surface, setSurface] = createSignal<HTMLDialogElement>();
  const presence = createPresence(() => props.open, surface);

  return (
    <Show when={presence.mounted()}>
      <Portal>
        <DialogPanel dialog={props} surface={surface} onSurface={setSurface} closed={presence.closed()} />
      </Portal>
    </Show>
  );
}
