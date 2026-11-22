import { For, omit } from "solid-js";
import { type JSX, dynamic } from "@solidjs/web";
import type { IconNode } from "lucide";

export interface IconGlyphProps extends Partial<JSX.SvgSVGAttributes<SVGSVGElement>> {
  size?: string | number;
  color?: JSX.SvgSVGAttributes<SVGSVGElement>["color"];
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
    const rest = omit(props, "size", "color", "strokeWidth", "class", "children");
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
        width={props.size ?? 24}
        height={props.size ?? 24}
        stroke={props.color ?? "currentColor"}
        stroke-width={Number(props.strokeWidth ?? 2)}
        class={[base, props.class]}
        aria-hidden={!props.children && !isNamed(rest) ? "true" : undefined}
        {...rest}
      >
        <For each={node}>
          {([tag, attrs]) => {
            const Part = dynamic(() => tag);
            return <Part {...(attrs as object)} />;
          }}
        </For>
      </svg>
    );
  };
}
