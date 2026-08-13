import { splitProps, type JSX } from "solid-js";
import Tooltip, { type TooltipPlacement } from "../Tooltip/Tooltip";
import styles from "./Button.module.css";

export type ButtonVariant =
  | "default"
  | "primary"
  | "success"
  | "warn"
  | "danger"
  | "ghost";
export type ButtonSize = "md" | "sm" | "xs";

export interface ButtonProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "title"> {
  /** Narrower than the native attribute, which Solid still types with the
   *  long-dead `"menu"` value. Nothing in Sway passes it. */
  type?: "submit" | "reset" | "button";
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (inline `<svg>` or seti component). */
  icon?: JSX.Element;
  /** Trailing icon, after the label. */
  iconRight?: JSX.Element;
  /** Hover/focus tooltip, and - for an icon-only button - the accessible name
   *  when no `aria-label` is given. This replaced `title`, which never appeared
   *  for a keyboard user; the native attribute is no longer accepted here. */
  tooltip?: string;
  tooltipPlacement?: TooltipPlacement;
  /** Keep the tooltip reachable while the button is `disabled`. Off by default,
   *  and opted into per site with a reason - see `Tooltip`. */
  tooltipWhenDisabled?: boolean;
}

/** The single native button for the app: text, icon+text, or icon-only, on the
 *  shared tokens. Defaults to `type="button"` (no accidental form submits) and
 *  spreads the rest of the native button props. An icon-only button (an `icon`
 *  with no children) must carry an accessible name via `aria-label`; a `tooltip`
 *  backfills a missing one.
 *
 *  A native `title` does not reach here any more: issue 102 swept the app onto
 *  `tooltip` and `src/test/interactiveTitle.test.ts` keeps it that way. */
export default function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "icon",
    "iconRight",
    "children",
    "class",
    "type",
    "aria-label",
    "tooltip",
    "tooltipPlacement",
    "tooltipWhenDisabled",
  ]);

  const iconOnly = () => local.icon != null && local.children == null;
  // Explicit aria-label wins; for an icon-only button the tooltip backfills the
  // name, so the text a mouse user hovers for doubles as the accessible name.
  const ariaLabel = () =>
    local["aria-label"] ?? (iconOnly() ? local.tooltip : undefined);

  if (import.meta.env.DEV && iconOnly() && ariaLabel() == null) {
    console.warn(
      "[Button] icon-only button is missing an accessible name; pass `aria-label` (or a `tooltip`).",
    );
  }

  return (
    <Tooltip
      {...rest}
      as="button"
      label={local.tooltip}
      placement={local.tooltipPlacement}
      whenDisabled={local.tooltipWhenDisabled}
      type={local.type ?? "button"}
      aria-label={ariaLabel()}
      class={local.class}
      classList={{
        [styles.btn]: true,
        [styles[local.variant ?? "default"]]: true,
        [styles[local.size ?? "md"]]: true,
        [styles.iconOnly]: iconOnly(),
      }}
    >
      {local.icon}
      {local.children != null && (
        <span class={styles.label}>{local.children}</span>
      )}
      {local.iconRight}
    </Tooltip>
  );
}
