import { splitProps, type JSX } from "solid-js";
import styles from "./Tab.module.css";

export interface TabProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "onClose"> {
  /** Selected look. Reflected as `aria-selected` (the tab has `role="tab"`). */
  active?: boolean;
  /** Leading glyph. */
  icon?: JSX.Element;
  /** The label. */
  children?: JSX.Element;
  /** When set, renders a trailing close affordance that calls this instead of
   *  selecting the tab. */
  onClose?: (e: MouseEvent) => void;
  /** Accessible name for the close button (e.g. "Close README.md"). */
  closeLabel?: string;
}

/** The shared tab pill: transparent at rest, a quiet fill when active or
 *  hovered. Icon + label, with an optional close button. Used by the editor and
 *  terminal tab strips so they read and scale identically. */
export default function Tab(props: TabProps) {
  const [local, rest] = splitProps(props, [
    "active",
    "icon",
    "children",
    "onClose",
    "closeLabel",
    "class",
    "type",
  ]);

  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      role="tab"
      aria-selected={local.active}
      class={local.class}
      classList={{ [styles.tab]: true, [styles.active]: !!local.active }}
    >
      {local.icon}
      {local.children != null && <span class={styles.label}>{local.children}</span>}
      {local.onClose && (
        <span
          class={styles.close}
          role="button"
          aria-label={local.closeLabel}
          tabindex={-1}
          onClick={(e) => {
            e.stopPropagation();
            local.onClose!(e);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </span>
      )}
    </button>
  );
}
