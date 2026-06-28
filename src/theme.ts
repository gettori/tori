import { invoke } from "@tauri-apps/api/core";
import { emit, THEME_APPLIED } from "./events";

type ThemeColors = { kind: string | null; colors: Record<string, string> };

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

/** Synchronous: paint with the last-known theme (or fallbacks) before render,
 *  so the UI never flashes the default palette on startup. */
export function applyCachedTheme() {
  let cached: Record<string, string> = {};
  try {
    cached = JSON.parse(localStorage.getItem(LS_THEME) || "{}");
  } catch {
    // ignore
  }
  const root = document.documentElement.style;
  for (const [cssVar, , fallback] of MAP) {
    root.setProperty(cssVar, cached[cssVar] ?? fallback);
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
  const root = document.documentElement.style;
  const resolved: Record<string, string> = {};
  for (const [cssVar, keys, fallback] of MAP) {
    const hit = keys.map((k) => c[k]).find((v) => !!v);
    const val = hit ?? fallback;
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
