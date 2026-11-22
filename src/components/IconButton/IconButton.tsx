import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import Tooltip, { type TooltipPlacement } from "../Tooltip/Tooltip";
import styles from "./IconButton.module.css";
import type { ControlSize } from "../controls";

export interface IconButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "title"> {
  /** Narrower than the native attribute, which Solid still types with the
   *  long-dead `"menu"` value. Nothing in Tori passes it. */
  type?: "submit" | "reset" | "button";
  /** The glyph (inline `<svg>` or seti component). */
  icon: JSX.Element;
  size?: ControlSize;
  /** Pressed/selected look, for a toggle. Reflected as `aria-pressed`. */
  active?: boolean;
  /** Hover/focus tooltip, and the accessible name when no `aria-label` is
   *  given. This replaced `title`, which never appeared for a keyboard user;
   *  the native attribute is no longer accepted here. */
  tooltip?: string;
  tooltipPlacement?: TooltipPlacement;
  /** Keep the tooltip reachable while the button is `disabled`. Off by default,
   *  and opted into per site with a reason - see `Tooltip`. */
  tooltipWhenDisabled?: boolean;
}

/** A square icon-only control whose side is the size's fixed control height.
 *  Use for toggles (pass `active`) and bare icon actions. An accessible name is
 *  required: pass `aria-label` (a `tooltip` backfills it and is also what a
 *  hover or a keyboard focus shows), since there is no visible text. */
export default function IconButton(props: IconButtonProps) {
  const rest = omit(
    props,
    "icon",
    "size",
    "active",
    "class",
    "type",
    "aria-label",
    "aria-pressed",
    "tooltip",
    "tooltipPlacement",
    "tooltipWhenDisabled",
  );

  const ariaLabel = () => props["aria-label"] ?? props.tooltip;
  // `active` drives the brand-fill look and, by default, aria-pressed. A pane
  // toggle whose "on" state is the plain (not filled) look passes an explicit
  // aria-pressed instead, keeping the accent styling on a `class`.
  const ariaPressed = () => {
    if (props["aria-pressed"] !== undefined) return props["aria-pressed"];
    if (props.active === undefined) return undefined;
    return props.active ? "true" : "false";
  };

  if (import.meta.env.DEV && ariaLabel() == null) {
    console.warn("[IconButton] is missing an accessible name; pass `aria-label` (or a `tooltip`).");
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
      aria-pressed={ariaPressed()}
      class={[
        props.class,
        {
          [styles.iconBtn]: true,
          [styles[props.size ?? "md"]]: true,
          [styles.active]: !!props.active,
        },
      ]}
    >
      {props.icon}
    </Tooltip>
  );
}
