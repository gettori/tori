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

/** The forge integration's kill switch. Separate from signing out on purpose:
 *  signing out also stops the traffic but costs the credential, so quieting a
 *  misbehaving poller would disable PR creation and the review surface too. */
export type Github = { enabled: boolean };
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
/** Editor behaviour that is a preference rather than a project fact.
 *
 *  `formatOnSave` defaults **off**, even though the project's config is what
 *  decides which formatter runs: a repo carrying a `.prettierrc` is not
 *  necessarily a repo that is currently formatted, and the first save in one
 *  would otherwise rewrite a file the user never touched.
 *
 *  `vimMode` is here and **not** in `EditorPrefs`: which formatter runs is a
 *  property of the repo, but whether `hjkl` moves the caret is a property of
 *  the person, and the same hands do not change between projects.
 *
 *  The editing-comfort switches below join them for the same reason `vimMode`
 *  is here: they are answers to "how should the code surface behave", which is
 *  a property of the person rather than of the repo. Every one names the phase
 *  that consumes it, because a toggle the settings panel renders and nothing
 *  reads is worse than a missing feature - it reads as broken rather than
 *  absent. Flat rather than nested per feature, so a user looking for soft wrap
 *  does not have to know whether it is a view concern or a language one. */
export type EditorDefaults = {
  formatOnSave: boolean;
  vimMode: boolean;
  /** Vertical guides at each indent level, active one highlighted. (Phase 3) */
  indentGuides: boolean;
  /** Wrap long lines rather than scrolling horizontally. The palette's
   *  per-tab override outranks this for one buffer. (Phase 2) */
  softWrap: boolean;
  /** Show spaces and tabs as dots and arrows. (Phase 2) */
  renderWhitespace: boolean;
  /** Let the last line scroll up to the top of the viewport. (Phase 2) */
  scrollPastEnd: boolean;
  /** Colour brackets by nesting depth. (Phase 6) */
  rainbowBrackets: boolean;
  /** Vertical connectors between a bracket pair's two lines. (Phase 6) */
  bracketPairGuides: boolean;
  /** Document overview strip down the right edge. (Phase 7) */
  minimap: boolean;
  /** Word and snippet completion in buffers no language server claims.
   *  (Phase 5) */
  wordCompletion: boolean;
  /** Keep unsaved buffers across a quit instead of prompting to discard
   *  them. (Phase 10) */
  hotExit: boolean;
};

/** One project's editor overrides. `null`/absent means "no answer here" and
 *  falls through to `editorDefaults`, which is distinct from an explicit
 *  `false` - that is this project saying no.
 *
 *  Only `formatOnSave` is overridable per project, because only it is a
 *  property of the repo. The comfort switches in `EditorDefaults` are the
 *  person's and stay global. */
export type EditorPrefs = { formatOnSave?: boolean | null };

/**
 * Spend ceilings. **Null means unlimited, and that is the default**: a budget
 * nobody asked for that quietly stops an agent mid-task would be worse than no
 * budget at all, so every ceiling here is opt-in.
 *
 * Two currencies, because they answer different questions. Dollars are what a
 * bill is denominated in; context percentage is what actually degrades a long
 * session, and a user watching for one is usually not watching for the other.
 */
export type Budgets = {
  /** Ceiling for one chat session, in dollars. */
  sessionUsd: number | null;
  /** Ceiling across every session in a project, in dollars. Two chats open on
   *  one repo spend one budget. */
  projectUsd: number | null;
  /** Stop when a turn's context window passes this percentage. */
  contextPercent: number | null;
  /** Warn once at this fraction of whichever ceiling is in force. */
  warnAtFraction: number;
};
export type Settings = {
  appearance: Appearance;
  typography: Typography;
  checkpoints: Checkpoints;
  github: Github;
  chatDefaults: ChatDefaults;
  budgets: Budgets;
  editorDefaults: EditorDefaults;
  harness: Harness;
  /** Keyed by project path. A project with no entry has never had a pick. */
  chat: Record<string, ChatPrefs>;
  /** Keyed by project path, same shape and same reason as `chat`. */
  editor: Record<string, EditorPrefs>;
};

export const DEFAULT_SETTINGS: Settings = {
  appearance: { theme: "sway-dark" },
  github: { enabled: true },
  typography: {
    uiFontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    uiFontSize: 15,
    editorFontFamily: '"SF Mono", Menlo, Monaco, monospace',
    editorFontSize: 15,
    // Mirrors `default_terminal_font_family` in src-tauri/src/settings.rs: the
    // bundled Nerd Font (public/fonts) first, the platform's monospace behind
    // it. Only used before the backend's settings arrive; the file is the
    // source of truth.
    terminalFontFamily: '"JetBrainsMono Nerd Font Mono", "SF Mono", Menlo, Monaco, monospace',
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
  budgets: { sessionUsd: null, projectUsd: null, contextPercent: null, warnAtFraction: 0.8 },
  // The comfort defaults follow the tickets: the three that only cost a line of
  // pixels are on, the three cosmetic overlays are off (a stance nobody asked
  // for is worse than a switch), and the two behavioural ones are on because a
  // completion that never appears and a quit that still discards work are the
  // states these features exist to end.
  editorDefaults: {
    formatOnSave: false,
    vimMode: false,
    indentGuides: true,
    softWrap: false,
    renderWhitespace: false,
    scrollPastEnd: true,
    rainbowBrackets: false,
    bracketPairGuides: false,
    minimap: false,
    wordCompletion: true,
    hotExit: true,
  },
  harness: {},
  chat: {},
  editor: {},
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
  // Transcript prose rides the *terminal's* size, not the chrome's. A chat and a
  // terminal are the same activity in this app - reading what a CLI said back -
  // so the two panes have to read at one size, and the size a user reaches for
  // when text is too small to read output in is the terminal's. Only the size:
  // the transcript stays in the UI face, since it is prose, not a cell grid.
  st.setProperty("--chat-font-size", `${terminalFontSizePx(s.typography.terminalFontSize, z)}px`);
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

/**
 * Whether a save in `projectPath` should run the project's formatter first.
 *
 * The project's own answer where it has one, the global default otherwise. The
 * three-way distinction is the point: `undefined` and `null` both mean "this
 * project has never been asked", while `false` is a project that was asked and
 * said no, and must not be overruled by the global default being on.
 *
 * A null path (no workspace selected) can only be the default: there is no
 * project to have an opinion.
 */
export function formatOnSaveFor(projectPath: string | null): boolean {
  const own = projectPath ? settings.editor?.[projectPath]?.formatOnSave : undefined;
  return own ?? settings.editorDefaults?.formatOnSave ?? false;
}

/** Whether the code editor is in vim mode. Global, with no per-project form:
 *  see `EditorDefaults`. */
export function vimModeOn(): boolean {
  return settings.editorDefaults?.vimMode ?? false;
}

/** Flip vim mode and remember it. Lives here rather than in `Settings.tsx`
 *  because the palette can toggle it too, and the Settings panel is not
 *  necessarily open when it does. Swallowed on failure for the same reason a
 *  chat pick is: the choice has already taken effect on screen. */
export function toggleVimMode(): void {
  const next: Settings = {
    ...settings,
    editorDefaults: { ...settings.editorDefaults, vimMode: !vimModeOn() },
  };
  void saveSettings(next).catch(() => {});
}

/** Remember this project's format-on-save answer. Swallowed on failure for the
 *  same reason a chat pick is: the choice already took effect. */
export function rememberFormatOnSave(projectPath: string, on: boolean | null): void {
  const next: Settings = {
    ...settings,
    editor: {
      ...settings.editor,
      [projectPath]: { ...settings.editor?.[projectPath], formatOnSave: on },
    },
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
