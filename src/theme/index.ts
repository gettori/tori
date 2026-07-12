// Public theme API. Sway ships bundled themes and can import any VS Code theme
// file; it no longer mirrors an installed VS Code on window focus. The active
// theme is resolved to CSS custom properties and painted onto <html>.
import { invoke } from "@tauri-apps/api/core";
import { emit, THEME_APPLIED } from "../events";
import { type ThemeColors } from "./vscodeMap";
import { distillVsCodeTheme } from "./distill";
import { resolveTheme, applyResolved } from "./resolver";
import { DEFAULT_THEME_ID, getBundledTheme } from "./bundled";

export { listSelectableThemes, listThemes } from "./bundled";
export type { BundledTheme } from "./bundled";

const LS_TOKENS = "sway.theme.v1"; // resolved { --var: value }, for FOUC-free boot
const LS_SELECTED = "sway.theme.selected.v1";

type Selected = { kind: "light" | "dark" | null; bundledId?: string; importPath?: string };

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

function apply(tc: ThemeColors, sel: Selected) {
  const resolved = resolveTheme(tc);
  applyResolved(resolved, tc.kind);
  persist({ ...sel, kind: (tc.kind as Selected["kind"]) ?? sel.kind }, resolved);
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
  apply(distillVsCodeTheme(theme.raw), { kind: theme.kind, bundledId: theme.id });
}

/** Import and apply a VS Code theme file (parsed natively for json5/`include`). */
export async function importThemeFromPath(path: string) {
  const tc = await invoke<ThemeColors>("get_theme_colors_from_path", { path });
  apply(tc, { kind: (tc.kind as Selected["kind"]) ?? null, importPath: path });
}
