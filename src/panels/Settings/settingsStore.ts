// Global user settings store. Loads ~/.config/sway/settings.json via the Rust
// backend, applies typography/layout to CSS tokens, and re-applies live when the
// file changes (hand edit or set_settings) through the settings://changed
// watcher event. The reactive store backs the settings panel (Phase 4).
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emit, SETTINGS_CHANGED } from "../../utils/events";
import { setTheme, importThemeFromPath } from "../../theme";

export type Appearance = { theme: string; importPath: string | null };
export type Typography = {
  uiFontFamily: string;
  uiFontSize: number;
  editorFontFamily: string;
  editorFontSize: number;
  terminalFontFamily: string;
  terminalFontSize: number;
  lineHeight: number;
};
export type Layout = { density: "comfortable" | "compact"; radius: number };
export type Checkpoints = { enabled: boolean };
export type Settings = { appearance: Appearance; typography: Typography; layout: Layout; checkpoints: Checkpoints };

export const DEFAULT_SETTINGS: Settings = {
  appearance: { theme: "dark-plus", importPath: null },
  typography: {
    uiFontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    uiFontSize: 15,
    editorFontFamily: '"SF Mono", Menlo, Monaco, monospace',
    editorFontSize: 15,
    terminalFontFamily: '"SF Mono", Menlo, Monaco, monospace',
    terminalFontSize: 15,
    lineHeight: 1.5,
  },
  layout: { density: "comfortable", radius: 5 },
  checkpoints: { enabled: true },
};

const [settings, setSettings] = createStore<Settings>(DEFAULT_SETTINGS);
export { settings };

// --- Global zoom (VSCode's "Zoom In/Out" model) ---------------------------
//
// A single multiplier layered on top of every base font size (chrome, editor,
// terminal) so one shortcut scales the whole UI together. The user's chosen base
// sizes in Settings stay untouched; zoom is a reversible overlay (Cmd+0 -> 1).
// Persisted to localStorage (not the settings JSON) so a rapid Cmd+= burst is
// instant and never churns the on-disk file or triggers the settings watcher.
const ZOOM_KEY = "sway.zoom";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;

function clampZoom(z: number): number {
  // Snap to a 0.1 grid so repeated ± steps don't drift on float error.
  const snapped = Math.round(z * 10) / 10;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, snapped));
}

function readStoredZoom(): number {
  const raw = Number(localStorage.getItem(ZOOM_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampZoom(raw) : 1;
}

const [zoom, setZoomSignal] = createSignal(readStoredZoom());
export { zoom };

/** Effective terminal font size in px (base setting × zoom), read by xterm.
 *  Reactive: reads both the store and the zoom signal. */
export const terminalFontSize = () => Math.round(settings.typography.terminalFontSize * zoom());

function setZoom(z: number) {
  const next = clampZoom(z);
  setZoomSignal(next);
  localStorage.setItem(ZOOM_KEY, String(next));
  // Re-fold the new zoom into the chrome/editor CSS tokens. (The terminal reads
  // terminalFontSize() reactively, so it needs no explicit re-apply here.)
  applySettings(settings);
}
export function zoomIn() {
  setZoom(zoom() + ZOOM_STEP);
}
export function zoomOut() {
  setZoom(zoom() - ZOOM_STEP);
}
export function resetZoom() {
  setZoom(1);
}

/** Map typography/layout onto the CSS tokens that the chrome and editor read. */
export function applySettings(s: Settings) {
  const st = document.documentElement.style;
  const z = zoom();
  st.setProperty("--sway-font-ui", s.typography.uiFontFamily);
  // Chrome font-sizes are `calc(<px> * var(--ui-scale))`, authored against a 13px
  // design baseline; scale is the chosen UI size over that baseline, times the
  // global zoom (e.g. the 15px default renders chrome at 15/13× its authored px).
  st.setProperty("--ui-scale", String((s.typography.uiFontSize / 13) * z));
  st.setProperty("--editor-font-family", s.typography.editorFontFamily);
  st.setProperty("--editor-font-size", `${s.typography.editorFontSize * z}px`);
  st.setProperty("--ui-line-height", String(s.typography.lineHeight));
  // Radii are `calc(<px> * var(--ui-radius-scale))`; scale is the chosen radius
  // over the 5px baseline, so the default (5) is 1 and renders unchanged.
  st.setProperty("--ui-radius-scale", String(s.layout.radius / 5));
  // Padding/gap are `calc(<px> * var(--ui-density))`; compact tightens spacing.
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
