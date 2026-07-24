import { fileNames, extensions, defaultIcon, type SetiIcon } from "./mapping";

/** Resolve a Seti icon (glyph + color) for a bare file name (not a path).
 *  Order: exact file name -> longest compound extension -> last extension -> default. */
export function iconFor(name: string): SetiIcon {
  const lower = name.toLowerCase();
  const exact = fileNames[lower];
  if (exact) return exact;

  // Compound extensions first ("vite.config.ts" -> "config.ts" -> "ts"),
  // so multi-dot keys (e.g. "d.ts", "test.js") win over the bare extension.
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join(".");
    const ic = extensions[candidate];
    if (ic) return ic;
  }
  return defaultIcon;
}

/** Seti file-type icon. The mapping names a hue; the active theme supplies the
 *  value, so the tree recolours on a theme switch with no work here. */
export default function FileIcon(props: { name: string }) {
  const icon = () => iconFor(props.name);
  return (
    <span class="seti-icon" aria-hidden="true" style={{ color: `var(--scale-${icon().hue})` }}>
      {icon().glyph}
    </span>
  );
}
