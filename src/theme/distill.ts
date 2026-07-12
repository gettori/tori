// Distil a raw VS Code theme into ThemeColors. Mirrors the Rust distiller
// (src-tauri/src/theme.rs) so bundled themes resolve in the frontend without a
// native round-trip; imported theme *files* go through the Rust command instead
// (json5, `include` following). Kept in sync deliberately.
import { type RawTheme, type ThemeColors, SYN_SCOPES } from "./vscodeMap";

/** Flatten tokenColors[] into scope -> foreground (later rule wins). */
function collectTokenColors(raw: RawTheme): Map<string, string> {
  const out = new Map<string, string>();
  const rules = raw.tokenColors;
  if (!Array.isArray(rules)) return out;
  for (const rule of rules) {
    const fg = rule.settings?.foreground;
    if (typeof fg !== "string") continue;
    const scope = rule.scope;
    const scopes =
      typeof scope === "string"
        ? scope.split(",").map((s) => s.trim()).filter(Boolean)
        : Array.isArray(scope)
          ? scope
          : [];
    for (const s of scopes) out.set(s, fg);
  }
  return out;
}

/** Resolve each syntax category by exact scope, else shortest `scope.` prefix. */
function distillSyntax(tokens: Map<string, string>): Record<string, string> {
  const syn: Record<string, string> = {};
  for (const [category, candidates] of SYN_SCOPES) {
    for (const cand of candidates) {
      const exact = tokens.get(cand);
      if (exact !== undefined) {
        syn[category] = exact;
        break;
      }
      let best: string | undefined;
      let bestLen = Infinity;
      for (const [scope, val] of tokens) {
        if (scope.startsWith(cand + ".") && scope.length < bestLen) {
          best = val;
          bestLen = scope.length;
        }
      }
      if (best !== undefined) {
        syn[category] = best;
        break;
      }
    }
  }
  return syn;
}

export function distillVsCodeTheme(raw: RawTheme): ThemeColors {
  const colors: Record<string, string> = {};
  if (raw.colors) {
    for (const [k, v] of Object.entries(raw.colors)) {
      if (typeof v === "string") colors[k] = v;
    }
  }
  return {
    kind: raw.type ?? null,
    colors,
    syntax: distillSyntax(collectTokenColors(raw)),
  };
}
