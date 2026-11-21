import { For, splitProps, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { IconNode } from "lucide";

export interface IconGlyphProps extends Partial<JSX.SvgSVGAttributes<SVGSVGElement>> {
  class?: string;
  size?: string | number;
  color?: string;
  strokeWidth?: string | number;
}

export type IconGlyph = (props: IconGlyphProps) => JSX.Element;

const isNamed = (props: object) =>
  Object.keys(props).some((key) => key.startsWith("aria-") || key === "role" || key === "title");

// Lets the bundler drop every icon a build never imports.
/* @__NO_SIDE_EFFECTS__ */
export function createIcon(name: string, node: IconNode): IconGlyph {
  const compact = name
    .replace(/(^|-)(\w)/g, (_, _sep, letter: string) => letter.toUpperCase())
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  const base = [...new Set(["lucide", "lucide-icon", `lucide-${compact}`, `lucide-${name}`])].join(" ");
  return (props) => {
    const [local, rest] = splitProps(props, ["size", "color", "strokeWidth", "class", "children"]);
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
        width={local.size ?? 24}
        height={local.size ?? 24}
        stroke={local.color ?? "currentColor"}
        stroke-width={Number(local.strokeWidth ?? 2)}
        class={local.class ? `${base} ${local.class}` : base}
        aria-hidden={!local.children && !isNamed(rest) ? "true" : undefined}
        {...rest}
      >
        <For each={node}>{([tag, attrs]) => <Dynamic component={tag} {...(attrs as object)} />}</For>
      </svg>
    );
  };
}
