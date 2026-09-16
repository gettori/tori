import { splitProps, type JSX } from "solid-js";
import Tooltip, { type TooltipPlacement } from "../Tooltip/Tooltip";
import styles from "./IconButton.module.css";
import type { ControlSize } from "../controls";

export interface IconButtonProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "title"> {
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
  const [local, rest] = splitProps(props, [
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
  ]);

  const ariaLabel = () => local["aria-label"] ?? local.tooltip;
  // `active` drives the brand-fill look and, by default, aria-pressed. A pane
  // toggle whose "on" state is the plain (not filled) look passes an explicit
  // aria-pressed instead, keeping the accent styling on a `class`.
  const ariaPressed = () => local["aria-pressed"] ?? local.active;

  if (import.meta.env.DEV && ariaLabel() == null) {
    console.warn(
      "[IconButton] is missing an accessible name; pass `aria-label` (or a `tooltip`).",
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
      aria-pressed={ariaPressed()}
      class={local.class}
      classList={{
        [styles.iconBtn]: true,
        [styles[local.size ?? "md"]]: true,
        [styles.active]: !!local.active,
      }}
    >
      {local.icon}
    </Tooltip>
  );
}
