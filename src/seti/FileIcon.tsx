import { fileNames, extensions, defaultGlyph } from "./mapping";

/** Resolve a Seti glyph for a bare file name (not a path).
 *  Order: exact file name -> longest compound extension -> last extension -> default. */
export function glyphFor(name: string): string {
  const lower = name.toLowerCase();
  const exact = fileNames[lower];
  if (exact) return exact;

  // Compound extensions first ("vite.config.ts" -> "config.ts" -> "ts"),
  // so multi-dot keys (e.g. "d.ts", "test.js") win over the bare extension.
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join(".");
    const g = extensions[candidate];
    if (g) return g;
  }
  return defaultGlyph;
}

/** Monochrome Seti file-type icon; tint comes from the inherited CSS `color`. */
export default function FileIcon(props: { name: string }) {
  return (
    <span class="seti-icon" aria-hidden="true">
      {glyphFor(props.name)}
    </span>
  );
}
