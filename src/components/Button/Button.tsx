import { splitProps, type JSX } from "solid-js";
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
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (inline `<svg>` or seti component). */
  icon?: JSX.Element;
  /** Trailing icon, after the label. */
  iconRight?: JSX.Element;
}

/** The single native button for the app: text, icon+text, or icon-only, on the
 *  shared tokens. Defaults to `type="button"` (no accidental form submits) and
 *  spreads the rest of the native button props. An icon-only button (an `icon`
 *  with no children) must carry an accessible name via `aria-label`; a `title`
 *  is emitted as a hover tooltip and, when present, backfills a missing name. */
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
    "title",
  ]);

  const iconOnly = () => local.icon != null && local.children == null;
  const title = () =>
    typeof local.title === "string" ? local.title : undefined;
  // Explicit aria-label wins; for an icon-only button a title backfills the name
  // so a hover tooltip doubles as the accessible name.
  const ariaLabel = () =>
    local["aria-label"] ?? (iconOnly() ? title() : undefined);

  if (import.meta.env.DEV && iconOnly() && ariaLabel() == null) {
    console.warn(
      "[Button] icon-only button is missing an accessible name; pass `aria-label` (or a `title`).",
    );
  }

  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      aria-label={ariaLabel()}
      title={title()}
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
    </button>
  );
}
