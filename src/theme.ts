import { invoke } from "@tauri-apps/api/core";
import { emit, THEME_APPLIED } from "./events";

type ThemeColors = {
  kind: string | null;
  colors: Record<string, string>;
  syntax?: Record<string, string>;
};

const LS_THEME = "sway.theme.v1";

// [cssVar, vscode color keys (first present wins), fallback].
const MAP: [string, string[], string][] = [
  ["--bg", ["editor.background"], "#1a1a1a"],
  ["--pane-bg", ["sideBar.background", "editor.background"], "#1e1e1e"],
  ["--pane-head-bg", ["sideBarSectionHeader.background", "tab.inactiveBackground"], "#252526"],
  ["--border", ["panel.border", "sideBar.border", "editorGroup.border"], "#2d2d2d"],
  ["--text", ["foreground", "sideBar.foreground"], "#d4d4d4"],
  ["--text-dim", ["descriptionForeground"], "#808080"],
  ["--accent", ["focusBorder", "button.background", "textLink.foreground"], "#4a9eff"],
  ["--sel", ["list.activeSelectionBackground"], "#094771"],
  ["--hover", ["list.hoverBackground"], "#2a2d2e"],
  ["--input-bg", ["input.background"], "#1a1a1a"],
];

// [cssVar, syntax category (from get_theme_colors.syntax), fallback].
// Fallbacks are the VS Code Dark+ defaults, the built-in palette used when a
// theme exposes no tokenColors. CM6's HighlightStyle reads these via var().
const SYN_MAP: [string, string, string][] = [
  ["--syn-keyword", "keyword", "#569cd6"],
  ["--syn-string", "string", "#ce9178"],
  ["--syn-comment", "comment", "#6a9955"],
  ["--syn-number", "number", "#b5cea8"],
  ["--syn-function", "function", "#dcdcaa"],
  ["--syn-type", "type", "#4ec9b0"],
  ["--syn-variable", "variable", "#9cdcfe"],
];

/** Synchronous: paint with the last-known theme before render, so the UI never
 *  flashes the default palette on startup. Only cached (last-known VS Code)
 *  values are applied as inline overrides; the fallbacks now live in the token
 *  layer (styles/tokens.css, keyed on [data-theme]), so an unthemed boot paints
 *  from CSS and the data-theme toggle is not shadowed by inline props. */
export function applyCachedTheme() {
  let cached: Record<string, string> = {};
  try {
    cached = JSON.parse(localStorage.getItem(LS_THEME) || "{}");
  } catch {
    // ignore
  }
  const root = document.documentElement.style;
  for (const [cssVar] of [...MAP, ...SYN_MAP]) {
    const val = cached[cssVar];
    if (val) root.setProperty(cssVar, val);
  }
}

/** Async: fetch the live VS Code theme, apply it, cache it, notify listeners. */
export async function applyTheme() {
  let t: ThemeColors;
  try {
    t = await invoke<ThemeColors>("get_theme_colors");
  } catch {
    return;
  }
  const c = t.colors || {};
  const syn = t.syntax || {};
  const root = document.documentElement.style;
  const resolved: Record<string, string> = {};
  for (const [cssVar, keys, fallback] of MAP) {
    const hit = keys.map((k) => c[k]).find((v) => !!v);
    const val = hit ?? fallback;
    root.setProperty(cssVar, val);
    resolved[cssVar] = val;
  }
  for (const [cssVar, key, fallback] of SYN_MAP) {
    const val = syn[key] || fallback;
    root.setProperty(cssVar, val);
    resolved[cssVar] = val;
  }
  try {
    localStorage.setItem(LS_THEME, JSON.stringify(resolved));
  } catch {
    // ignore quota
  }
  emit(THEME_APPLIED);
}
