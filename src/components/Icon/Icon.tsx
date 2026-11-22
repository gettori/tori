import { omit } from "solid-js";
import { dynamic } from "@solidjs/web";
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
  const rest = omit(props, "icon", "size", "strokeWidth");
  // dynamic() (not `const Glyph = props.icon`) so a changing `icon` prop swaps the
  // glyph reactively - e.g. a toggle button that flips between two icons.
  const Glyph = dynamic(() => props.icon);
  return <Glyph size={props.size ?? 16} strokeWidth={props.strokeWidth ?? 1.75} {...rest} />;
}
