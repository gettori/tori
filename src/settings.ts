// Global user settings store. Loads ~/.config/sway/settings.json via the Rust
// backend, applies typography/layout to CSS tokens, and re-applies live when the
// file changes (hand edit or set_settings) through the settings://changed
// watcher event. The reactive store backs the settings panel (Phase 4).
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emit, SETTINGS_CHANGED } from "./events";
import { setTheme, importThemeFromPath } from "./theme";

export type Appearance = { theme: string; importPath: string | null };
export type Typography = {
  uiFontFamily: string;
  uiFontSize: number;
  editorFontFamily: string;
  editorFontSize: number;
  lineHeight: number;
};
export type Layout = { density: "comfortable" | "compact"; radius: number };
export type Settings = { appearance: Appearance; typography: Typography; layout: Layout };

export const DEFAULT_SETTINGS: Settings = {
  appearance: { theme: "dark-plus", importPath: null },
  typography: {
    uiFontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    uiFontSize: 13,
    editorFontFamily: '"SF Mono", Menlo, Monaco, monospace',
    editorFontSize: 13,
    lineHeight: 1.5,
  },
  layout: { density: "comfortable", radius: 5 },
};

const [settings, setSettings] = createStore<Settings>(DEFAULT_SETTINGS);
export { settings };

/** Map typography/layout onto the CSS tokens that the chrome and editor read. */
export function applySettings(s: Settings) {
  const st = document.documentElement.style;
  st.setProperty("--sway-font-ui", s.typography.uiFontFamily);
  // Chrome font-sizes are `calc(<px> * var(--ui-scale))`; scale is the chosen UI
  // size over the 13px baseline, so the default (13) is 1 and renders unchanged.
  st.setProperty("--ui-scale", String(s.typography.uiFontSize / 13));
  st.setProperty("--editor-font-family", s.typography.editorFontFamily);
  st.setProperty("--editor-font-size", `${s.typography.editorFontSize}px`);
  st.setProperty("--ui-line-height", String(s.typography.lineHeight));
  st.setProperty("--ui-radius", `${s.layout.radius}px`);
  st.setProperty("--ui-density", s.layout.density === "compact" ? "0.85" : "1");
}

/** Drive the theme module from settings.appearance (the source of truth). */
async function applyAppearanceTheme(a: Appearance) {
  if (a.theme === "import" && a.importPath) {
    try {
      await importThemeFromPath(a.importPath);
      return;
    } catch {
      // imported file gone/unreadable: fall back to the default theme
    }
    setTheme("dark-plus");
    return;
  }
  setTheme(a.theme);
}

/** Apply tokens synchronously, then the theme. */
async function applyAll(s: Settings) {
  applySettings(s);
  await applyAppearanceTheme(s.appearance);
}

/** Read settings from disk into the store and apply them. */
export async function loadSettings() {
  try {
    const s = await invoke<Settings>("get_settings");
    setSettings(s);
    await applyAll(s);
  } catch {
    // keep current store / defaults
  }
}

/** Persist settings; the watcher echo re-loads the store into agreement. */
export async function saveSettings(next: Settings): Promise<void> {
  const saved = await invoke<Settings>("set_settings", { settings: next });
  setSettings(saved);
  await applyAll(saved);
  emit(SETTINGS_CHANGED);
}

/** Load once, start the file watcher, and re-load on external changes. */
export async function initSettings() {
  await loadSettings();
  await invoke("settings_watch_start").catch(() => {});
  await listen("settings://changed", () => loadSettings());
}
