// Global user settings store. Loads ~/.config/sway/settings.json via the Rust
// backend, applies typography to CSS tokens, and re-applies live when the
// file changes (hand edit or set_settings) through the settings://changed
// watcher event. The reactive store backs the settings panel (Phase 4).
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emit, emitWith, SETTINGS_CHANGED, TOAST } from "../../utils/events";
import type { ToastEvent } from "../../utils/events";
import { getTheme, reloadUserThemes, setTheme } from "../../theme";
import { editorFontSizePx, terminalFontSizePx, uiScale } from "./scale";

export type Appearance = { theme: string };
export type Typography = {
  uiFontFamily: string;
  uiFontSize: number;
  editorFontFamily: string;
  editorFontSize: number;
  terminalFontFamily: string;
  terminalFontSize: number;
  lineHeight: number;
};
export type Checkpoints = { enabled: boolean };
/** What a chat reopens with, remembered per project because the right model and
 *  effort are a property of the work rather than of the user. `model` is the
 *  `--model` **value**, never the resolved id the session reports back: the
 *  value is what the flag takes and what survives a re-resolution. */
export type ChatPrefs = { model?: string | null; effort?: string | null; mode?: string | null };
/** Which surface a single click on a sidebar session opens. Chat is the
 *  default; `agent` is the fallback restoring the pre-chat behaviour. */
export type DefaultSurface = "chat" | "agent";
export type TranscriptDensity = "comfortable" | "compact";
/** Global chat preferences: what a new chat starts with, and how the transcript
 *  renders. Separate from the per-project `chat` map so neither reshapes the
 *  other's on-disk field. */
export type ChatDefaults = {
  defaultSurface: DefaultSurface;
  model?: string | null;
  effort?: string | null;
  mode?: string | null;
  streaming: boolean;
  density: TranscriptDensity;
  toolOutputLines: number;
  approvalAutoDenySecs: number;
  showSwayHooks: boolean;
};
export type Harness = { path?: string | null };
export type Settings = {
  appearance: Appearance;
  typography: Typography;
  checkpoints: Checkpoints;
  chatDefaults: ChatDefaults;
  harness: Harness;
  /** Keyed by project path. A project with no entry has never had a pick. */
  chat: Record<string, ChatPrefs>;
};

export const DEFAULT_SETTINGS: Settings = {
  appearance: { theme: "sway-dark" },
  typography: {
    uiFontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    uiFontSize: 15,
    editorFontFamily: '"SF Mono", Menlo, Monaco, monospace',
    editorFontSize: 15,
    terminalFontFamily: '"SF Mono", Menlo, Monaco, monospace',
    terminalFontSize: 15,
    lineHeight: 1.5,
  },
  checkpoints: { enabled: true },
  chatDefaults: {
    defaultSurface: "chat",
    streaming: true,
    density: "comfortable",
    toolOutputLines: 20,
    approvalAutoDenySecs: 120,
    showSwayHooks: false,
  },
  harness: {},
  chat: {},
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
export const terminalFontSize = () => terminalFontSizePx(settings.typography.terminalFontSize, zoom());

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

/** Map typography onto the CSS tokens that the chrome and editor read. */
export function applySettings(s: Settings) {
  const st = document.documentElement.style;
  const z = zoom();
  st.setProperty("--sway-font-ui", s.typography.uiFontFamily);
  // Chrome sizing flows from one multiplier: every type step (and, in later
  // phases, spacing and control dimensions) is `calc(<base> * var(--ui-scale))`.
  // Scale is the chosen UI font size over the 15px design baseline, times the
  // global zoom, so the 15px default rests at 1.0 and renders every base at its
  // authored px.
  st.setProperty("--ui-scale", String(uiScale(s.typography.uiFontSize, z)));
  st.setProperty("--editor-font-family", s.typography.editorFontFamily);
  st.setProperty("--editor-font-size", `${editorFontSizePx(s.typography.editorFontSize, z)}px`);
  st.setProperty("--ui-line-height", String(s.typography.lineHeight));
}

/** Surface theme problems as toasts. A theme that will not paint has to say so:
 *  silently landing on a different theme than the settings file names is exactly
 *  the "my theme changed on its own" the import notice exists to avoid.
 *
 *  Capped, because the contrast gate reports every failing pair and a badly
 *  hand-edited palette can fail dozens at once. Three plus a count is a
 *  notification; thirty is a wall the user has to dismiss one row at a time. */
const MAX_THEME_TOASTS = 3;

function reportThemeProblems(problems: string[]) {
  for (const message of problems.slice(0, MAX_THEME_TOASTS)) {
    emitWith<ToastEvent>(TOAST, { message, kind: "error" });
  }
  const rest = problems.length - MAX_THEME_TOASTS;
  if (rest > 0) {
    emitWith<ToastEvent>(TOAST, { message: `...and ${rest} more theme problem${rest === 1 ? "" : "s"}.`, kind: "error" });
  }
}

/** Apply tokens, then the theme named by settings.appearance (the source of
 *  truth). An id nothing provides falls back to the default; a theme that fails
 *  the contrast gate paints nothing, so the app stays where it was. */
function applyAll(s: Settings) {
  applySettings(s);
  reportThemeProblems(setTheme(s.appearance.theme));
}

/** Read settings from disk into the store and apply them. */
export async function loadSettings() {
  try {
    const s = await invoke<Settings>("get_settings");
    setSettings(s);
    applyAll(s);
  } catch {
    // keep current store / defaults
  }
}

/** Persist settings; the watcher echo re-loads the store into agreement. */
export async function saveSettings(next: Settings): Promise<void> {
  const saved = await invoke<Settings>("set_settings", { settings: next });
  setSettings(saved);
  applyAll(saved);
  emit(SETTINGS_CHANGED);
}

/** This project's remembered chat picks, or an empty set for one that has never
 *  had any. */
export function chatPrefs(projectPath: string): ChatPrefs {
  return settings.chat?.[projectPath] ?? {};
}

/**
 * Remember one or more chat picks for a project, leaving the rest alone.
 *
 * Merged rather than replaced because the three picks are made independently:
 * writing the whole record on a model change would erase an effort level the
 * user had chosen a moment earlier.
 *
 * Failure is swallowed on purpose. A pick that could not be persisted is a
 * preference not carried to the next session, which is not worth a toast during
 * a live chat - the pick itself already took effect.
 */
export function rememberChatPrefs(projectPath: string, prefs: ChatPrefs): void {
  const next: Settings = {
    ...settings,
    chat: { ...settings.chat, [projectPath]: { ...chatPrefs(projectPath), ...prefs } },
  };
  void saveSettings(next).catch(() => {});
}

/** Re-read the themes folder, then re-apply the active theme so an edit to the
 *  file currently in use lands without a restart. `setTheme` is what decides
 *  whether that repaints: a theme edited into something illegible paints
 *  nothing, and a theme whose file was deleted falls back to the default.
 *
 *  Only when the active theme came from that folder, though. Re-applying a
 *  bundled theme because some *other* file was saved repaints the whole app and
 *  re-emits THEME_APPLIED, which has the terminal reassign its options for a
 *  change that cannot have touched it. */
async function refreshUserThemes() {
  const wasUserTheme = getTheme(settings.appearance.theme)?.source !== "bundled";
  reportThemeProblems(await reloadUserThemes());
  const isUserTheme = getTheme(settings.appearance.theme)?.source !== "bundled";
  if (wasUserTheme || isUserTheme) reportThemeProblems(setTheme(settings.appearance.theme));
}

/** Load once, start the file watchers, and re-load on external changes. */
export async function initSettings() {
  // Themes before settings: settings.json may name a user theme, and resolving
  // it only after the first paint would flash the fallback and report a theme
  // that in fact exists.
  reportThemeProblems(await reloadUserThemes());
  await loadSettings();
  await invoke("settings_watch_start").catch(() => {});
  await listen("settings://changed", () => loadSettings());
  await invoke("themes_watch_start").catch(() => {});
  await listen("themes://changed", () => refreshUserThemes());
}
