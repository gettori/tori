import { onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { COMPOSE_DRAFT, OPEN_IN_EDITOR, OPEN_JOB, OPEN_TERMINAL, onWith } from "../../../utils/events";
import { FOCUSABLE } from "../../../utils/focusable";
import styles from "../Settings.module.css";

/**
 * The panel Settings is drawn in, shared with the project settings dialog so
 * the two close the same way: a portaled modal over the workspace, Escape and
 * a backdrop click to close, Tab kept inside it, and gone the moment one of
 * its buttons opens something behind it.
 */
export default function ModalShell(props: {
  label: string;
  onClose: () => void;
  /** Runs first on Escape. Returning true spends the press inside the panel. */
  onEscape?: () => boolean;
  children: JSX.Element;
}) {
  let panelEl!: HTMLDivElement;

  // The panel is a modal over the workspace, and some of its buttons (Sign in,
  // Install, Open file) start something out there. Without this the dock or
  // the tab opens *behind* the still-open overlay, which reads as the button
  // doing nothing; the panel closes and hands the screen to the work it just
  // started. A chat draft waiting in a composer nobody can see counts too.
  onCleanup(onWith(OPEN_JOB, () => props.onClose()));
  onCleanup(onWith(OPEN_TERMINAL, () => props.onClose()));
  onCleanup(onWith(OPEN_IN_EDITOR, () => props.onClose()));
  onCleanup(onWith(COMPOSE_DRAFT, () => props.onClose()));

  /**
   * Escape, and Tab kept inside the dialog, which is what `aria-modal` claims.
   *
   * **On the panel, not on `window`.** `ShortcutSheet` listens on the window in
   * the capture phase because a focused terminal swallows keydown before it
   * bubbles; this panel does not need that, because the focus trap below means
   * every keystroke already originates inside it. Reaching for the window here
   * would be actively wrong: the palette opens *over* this modal, closes on
   * its own Escape handler, and a capture-phase listener up here would swallow
   * that keystroke.
   *
   * `preventDefault` on the press also stops WKWebView clearing a
   * `type="search"` box natively, which would leave a panel filtered by a
   * query its box no longer shows.
   */
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!props.onEscape?.()) props.onClose();
      return;
    }
    if (e.key !== "Tab") return;
    // `[hidden]` excludes the inactive panes, and `tabindex="-1"` the rail
    // items a roving index has parked: both are still matched by the
    // selector's `button`/`input` clauses, and neither is a stop a real
    // browser would make.
    const items = [...panelEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.closest("[hidden]") && el.getAttribute("tabindex") !== "-1",
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey ? at === first : at === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  return (
    <Portal>
      <div class={styles.backdrop} onMouseDown={() => props.onClose()}>
        <div
          ref={panelEl}
          class={styles.panel}
          role="dialog"
          aria-modal="true"
          aria-label={props.label}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        >
          {props.children}
        </div>
      </div>
    </Portal>
  );
}
