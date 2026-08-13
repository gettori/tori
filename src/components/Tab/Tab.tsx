import { splitProps, type JSX } from "solid-js";
import Tooltip, { type TooltipPlacement } from "../Tooltip/Tooltip";
import styles from "./Tab.module.css";

export interface TabProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "onClose" | "type" | "title"> {
  /** Narrower than the native attribute, which Solid still types with the
   *  long-dead `"menu"` value. Nothing in Sway passes it. */
  type?: "submit" | "reset" | "button";
  /** Selected look. Reflected as `aria-selected` (the tab has `role="tab"`). */
  active?: boolean;
  /** Leading glyph. */
  icon?: JSX.Element;
  /** The label. */
  children?: JSX.Element;
  /** Extra content after the label, before the close (e.g. dirty/touched dots). */
  trailing?: JSX.Element;
  /** When set, renders a trailing close affordance that calls this instead of
   *  selecting the tab. */
  onClose?: (e: MouseEvent) => void;
  /** Accessible name for the close button (e.g. "Close README.md"). */
  closeLabel?: string;
  /** Hover/focus tooltip - typically the full path behind a truncated label.
   *  Unlike `Button` and `IconButton` this does *not* backfill the accessible
   *  name; see the note on the component. */
  tooltip?: string;
  tooltipPlacement?: TooltipPlacement;
  /** Keep the tooltip reachable while the tab is `disabled`. Off by default,
   *  and opted into per site with a reason - see `Tooltip`. */
  tooltipWhenDisabled?: boolean;
}

/** The shared tab pill: transparent at rest, a quiet fill when active or
 *  hovered. Icon + label, with an optional close button. Used by the editor and
 *  terminal tab strips so they read and scale identically.
 *
 *  **`tooltip` does not become the accessible name here**, which is the one way
 *  this differs from `Button` and `IconButton`. Those two backfill a name from
 *  the tooltip because an icon-only control has none of its own; a tab always
 *  has visible text. An `aria-label` on a tab *replaces* that text as the name
 *  rather than adding to it, so backfilling the full path would silently rename
 *  every tab in the app and break the `getByRole("tab", { name })` queries
 *  written against the label - see the gotcha of the same name in the vault. */
export default function Tab(props: TabProps) {
  const [local, rest] = splitProps(props, [
    "active",
    "icon",
    "children",
    "trailing",
    "onClose",
    "closeLabel",
    "class",
    "type",
    "tooltip",
    "tooltipPlacement",
    "tooltipWhenDisabled",
  ]);

  return (
    <Tooltip
      {...rest}
      as="button"
      label={local.tooltip}
      placement={local.tooltipPlacement}
      whenDisabled={local.tooltipWhenDisabled}
      type={local.type ?? "button"}
      role="tab"
      aria-selected={local.active}
      class={local.class}
      classList={{ [styles.tab]: true, [styles.active]: !!local.active }}
    >
      {local.icon}
      {local.children != null && <span class={styles.label}>{local.children}</span>}
      {local.trailing}
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
    </Tooltip>
  );
}
