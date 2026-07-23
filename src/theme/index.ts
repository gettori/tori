// Public theme API. A theme is a palette of primitives; roles.ts expands it into
// the semantic role set, which is painted onto <html> as inline custom
// properties. The token layer (styles/tokens.css) is the pre-theme fallback.
import { emit, THEME_APPLIED } from "../utils/events";
import { applyResolved } from "./resolver";
import { buildRoles } from "./roles";
import type { Appearance } from "./schema";
import { DEFAULT_THEME_ID, getBundledTheme } from "./bundled";

export { listSelectableThemes, listThemes, DEFAULT_THEME_ID } from "./bundled";
export type { BundledTheme } from "./bundled";

const LS_TOKENS = "sway.theme.v1"; // resolved { --var: value }, for FOUC-free boot
const LS_SELECTED = "sway.theme.selected.v1";

type Selected = { kind: Appearance | null; bundledId?: string };

function readSelected(): Selected | null {
  try {
    return JSON.parse(localStorage.getItem(LS_SELECTED) || "null");
  } catch {
    return null;
  }
}

function persist(sel: Selected, resolved: Record<string, string>) {
  try {
    localStorage.setItem(LS_SELECTED, JSON.stringify(sel));
    localStorage.setItem(LS_TOKENS, JSON.stringify(resolved));
  } catch {
    // ignore quota
  }
}

function apply(resolved: Record<string, string>, appearance: Appearance | null, sel: Selected) {
  applyResolved(resolved, appearance);
  persist({ ...sel, kind: appearance ?? sel.kind }, resolved);
  emit(THEME_APPLIED);
}

/** Synchronous: paint the last-known theme before first render, so the UI never
 *  flashes. Reads only the cached resolved tokens + kind; the token layer owns
 *  any fallback, so a first-ever boot with no cache still paints from CSS. */
export function applyCachedTheme() {
  const sel = readSelected();
  if (sel?.kind) {
    document.documentElement.dataset.theme = sel.kind === "light" ? "light" : "dark";
  }
  try {
    const cached: Record<string, string> = JSON.parse(localStorage.getItem(LS_TOKENS) || "{}");
    const style = document.documentElement.style;
    for (const k of Object.keys(cached)) {
      const v = cached[k];
      if (v) style.setProperty(k, v);
    }
  } catch {
    // ignore
  }
}

/** Select a bundled theme by id. */
export function setTheme(id: string) {
  const theme = getBundledTheme(id) ?? getBundledTheme(DEFAULT_THEME_ID);
  if (!theme) return;
  apply(buildRoles(theme.palette), theme.appearance, { kind: theme.appearance, bundledId: theme.id });
}
