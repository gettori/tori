// Resolve ThemeColors to the CSS custom properties the UI reads, and apply them.
// The active theme is written as inline props on <html> (highest priority) plus
// a data-theme attribute; the token layer (styles/tokens.css) supplies anything
// a theme omits.
import { MAP, SYN_MAP, type ThemeColors } from "./vscodeMap";

/** Map a distilled theme to { --cssVar: value } for every semantic token. */
export function resolveTheme(tc: ThemeColors): Record<string, string> {
  const c = tc.colors || {};
  const syn = tc.syntax || {};
  const out: Record<string, string> = {};
  for (const [cssVar, keys, fallback] of MAP) {
    const hit = keys.map((k) => c[k]).find((v) => !!v);
    out[cssVar] = hit ?? fallback;
  }
  for (const [cssVar, key, fallback] of SYN_MAP) {
    out[cssVar] = syn[key] || fallback;
  }
  return out;
}

/** Paint the resolved tokens onto <html> and set light/dark for the token layer. */
export function applyResolved(resolved: Record<string, string>, kind: string | null) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(resolved)) {
    root.style.setProperty(k, v);
  }
  root.dataset.theme = kind === "light" ? "light" : "dark";
}
