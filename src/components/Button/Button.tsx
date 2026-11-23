import { omit, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import Tooltip, { type TooltipPlacement } from "../Tooltip/Tooltip";
import styles from "./Button.module.css";

export type ButtonVariant = "default" | "primary" | "success" | "warn" | "danger" | "ghost";
export type ButtonSize = "md" | "sm" | "xs";

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "title"> {
  /** Narrower than the native attribute, which Solid still types with the
   *  long-dead `"menu"` value. Nothing in Tori passes it. */
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
  const rest = omit(
    props,
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
  );

  const iconOnly = () => props.icon != null && props.children == null;
  // Explicit aria-label wins; for an icon-only button the tooltip backfills the
  // name, so the text a mouse user hovers for doubles as the accessible name.
  const ariaLabel = () => props["aria-label"] ?? (iconOnly() ? props.tooltip : undefined);

  if (import.meta.env.DEV && untrack(() => iconOnly() && ariaLabel() == null)) {
    console.warn("[Button] icon-only button is missing an accessible name; pass `aria-label` (or a `tooltip`).");
  }

  return (
    <Tooltip
      {...rest}
      as="button"
      label={props.tooltip}
      placement={props.tooltipPlacement}
      whenDisabled={props.tooltipWhenDisabled}
      type={props.type ?? "button"}
      aria-label={ariaLabel()}
      class={[
        props.class,
        {
          [styles.btn]: true,
          [styles[props.variant ?? "default"]]: true,
          [styles[props.size ?? "md"]]: true,
          [styles.iconOnly]: iconOnly(),
        },
      ]}
    >
      {props.icon}
      {props.children != null && <span class={styles.label}>{props.children}</span>}
      {props.iconRight}
    </Tooltip>
  );
}
