import { splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { LucideIcon, LucideProps } from "lucide-solid";

export interface IconProps extends LucideProps {
  /** A Lucide icon component, e.g. `import { Settings } from "lucide-solid"`. */
  icon: LucideIcon;
}

/** Thin wrapper around a Lucide icon that applies the app's icon defaults: 16px
 *  size and a 1.75 stroke for a refined (not chunky) look. Any Lucide prop
 *  (`size`, `strokeWidth`, `color`, `class`, ...) overrides the default. Color
 *  inherits `currentColor`, so callers tint via CSS `color`. */
export default function Icon(props: IconProps) {
  const [local, rest] = splitProps(props, ["icon", "size", "strokeWidth"]);
  // Dynamic (not `const Glyph = local.icon`) so a changing `icon` prop swaps the
  // glyph reactively - e.g. a toggle button that flips between two icons.
  return (
    <Dynamic
      component={local.icon}
      size={local.size ?? 16}
      strokeWidth={local.strokeWidth ?? 1.75}
      {...rest}
    />
  );
}
