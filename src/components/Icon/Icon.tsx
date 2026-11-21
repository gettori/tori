import { splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { IconGlyph, IconGlyphProps } from "./createIcon";

export interface IconProps extends IconGlyphProps {
  /** An icon component, e.g. `import { Settings } from "./icons"`. */
  icon: IconGlyph;
}

/** Thin wrapper around an icon that applies the app's icon defaults: 16px
 *  size and a 1.75 stroke for a refined (not chunky) look. Any glyph prop
 *  (`size`, `strokeWidth`, `color`, `class`, ...) overrides the default. Color
 *  inherits `currentColor`, so callers tint via CSS `color`. */
export default function Icon(props: IconProps) {
  const [local, rest] = splitProps(props, ["icon", "size", "strokeWidth"]);
  // Dynamic (not `const Glyph = local.icon`) so a changing `icon` prop swaps the
  // glyph reactively - e.g. a toggle button that flips between two icons.
  return <Dynamic component={local.icon} size={local.size ?? 16} strokeWidth={local.strokeWidth ?? 1.75} {...rest} />;
}
