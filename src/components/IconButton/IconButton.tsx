import { splitProps, type JSX } from "solid-js";
import styles from "./IconButton.module.css";
import type { ControlSize } from "../controls";

export interface IconButtonProps
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  /** The glyph (inline `<svg>` or seti component). */
  icon: JSX.Element;
  size?: ControlSize;
  /** Pressed/selected look, for a toggle. Reflected as `aria-pressed`. */
  active?: boolean;
}

/** A square icon-only control whose side is the size's fixed control height.
 *  Use for toggles (pass `active`) and bare icon actions. An accessible name is
 *  required: pass `aria-label` (a `title` backfills it and doubles as a tooltip),
 *  since there is no visible text. */
export default function IconButton(props: IconButtonProps) {
  const [local, rest] = splitProps(props, [
    "icon",
    "size",
    "active",
    "class",
    "type",
    "aria-label",
    "aria-pressed",
    "title",
  ]);

  const title = () =>
    typeof local.title === "string" ? local.title : undefined;
  const ariaLabel = () => local["aria-label"] ?? title();
  // `active` drives the brand-fill look and, by default, aria-pressed. A pane
  // toggle whose "on" state is the plain (not filled) look passes an explicit
  // aria-pressed instead, keeping the accent styling on a `class`.
  const ariaPressed = () => local["aria-pressed"] ?? local.active;

  if (import.meta.env.DEV && ariaLabel() == null) {
    console.warn(
      "[IconButton] is missing an accessible name; pass `aria-label` (or a `title`).",
    );
  }

  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      aria-label={ariaLabel()}
      aria-pressed={ariaPressed()}
      title={title()}
      class={local.class}
      classList={{
        [styles.iconBtn]: true,
        [styles[local.size ?? "md"]]: true,
        [styles.active]: !!local.active,
      }}
    >
      {local.icon}
    </button>
  );
}
