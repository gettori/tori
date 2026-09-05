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
import { editorFontSizePx, terminalFontSizePx, uiScale } from "./utils/scale";
import {
  editorOrigins,
  overlayFile,
  parseOverlay,
  resolveEditorDefaults,
  withOverride,
  type EditorOverlay,
  type Layer,
} from "./utils/workspaceSettings";
import { DEFAULT_PIN_SIDES, type PinSide } from "../../layout/pinRules";

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

/** Where each family of tabs opens (plan phase 11). A pane has no name to pin
 *  to, so a rule names an end of the split tree; `layout/pinRules.ts` is what
 *  resolves one against the tree the workspace actually has. */
export type PanePins = { terminal: PinSide; chat: PinSide; file: PinSide };

/** The forge integration's kill switch. Separate from signing out on purpose:
 *  signing out also stops the traffic but costs the credential, so quieting a
 *  misbehaving poller would disable PR creation and the review surface too. */
export type Github = { enabled: boolean };
/** What a chat reopens with, remembered per project because the right harness,
 *  model and effort are a property of the work rather than of the user. `model`
 *  is the `--model` **value**, never the resolved id the session reports back:
 *  the value is what the flag takes and what survives a re-resolution.
 *
 *  `agent` is the adapter id the last chat here was locked to, which is what a
 *  new draft opens on. Absent in every settings file written before drafts
 *  existed, so it is read through a fallback rather than assumed.
 *
 *  `profile` is the account that agent last ran as, in the **stored** spelling:
 *  the literal `"default"` for the login the user already had, null or absent
 *  only when nothing has been remembered. A tab spells the default account
 *  `null`, so storing that would make "chose the default account" and "never
 *  answered" one value, and the Settings default would then override a project
 *  that had answered. `asProfileId` and `asTabProfile` are the crossings. */
export type ChatPrefs = {
  agent?: string | null;
  profile?: string | null;
  model?: string | null;
  effort?: string | null;
  mode?: string | null;
};
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
  showSwayHooks: boolean;
  /** Render `AskUserQuestion` as an answerable form in the transcript. Off
   *  restores the permission card it used to be, where the only answers are
   *  allow and deny and allowing makes the CLI answer for the user. */
  answerQuestionsInline: boolean;
  /** How many live chats before Sway says the cost is adding up. **Zero means
   *  no cap.** It warns rather than refusing: several chats at once is the
   *  point of the surface, and how many is too many is a property of the
   *  machine and the bill rather than of Sway. */
  maxConcurrentChats: number;
};
/** Binary overrides. `paths` is per adapter id; `path` is the older global
 *  shape, still honoured by the backend as a fallback.
 *
 *  `enabled` is which agents this install offers, keyed by adapter id. Absent
 *  means never answered for, which counts as off - see `utils/agentEnabled`,
 *  which is the only thing that should read this field. */
export type Agent = {
  path?: string | null;
  paths?: Record<string, string>;
  enabled?: Record<string, boolean>;
  /** Which account a new session of one agent starts on, keyed by adapter id,
   *  for a project that has no memory of its own. An agent with no entry starts
   *  on the login the user already had: the default account is the absence of
   *  an answer rather than a stored `"default"`. */
  defaultProfiles?: Record<string, string>;
};
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
  /** Ask the language server to organize this file's imports before writing it.
   *  Off by default for `formatOnSave`'s reason and one of its own: it deletes
   *  imports nothing references yet, which is exactly the state a file is in
   *  halfway through being written. (Wave 7) */
  organizeImportsOnSave: boolean;
  /** Draw the language server's lenses (reference counts, implementations)
   *  above the lines they describe. Off by default, and the only editor setting
   *  whose cost is paid whether or not anybody reads it: a lens is not an answer
   *  to a question the user asked, so it is a request per file per edit that
   *  nothing else would have made. (Wave 7) */
  codeLens: boolean;
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
  /** Pin the enclosing scopes of the top visible line over the file. (Wave 6) */
  stickyScroll: boolean;
  /** Word and snippet completion in buffers no language server claims.
   *  (Phase 5) */
  wordCompletion: boolean;
  /** Keep unsaved buffers across a quit instead of prompting to discard
   *  them. (Phase 10) */
  hotExit: boolean;
  /** Render a chain of single-child folders as one row, `src/utils/helpers`,
   *  so a deep package layout costs one line instead of four. (Wave 6) */
  compactFolders: boolean;
  /**
   * Comma-separated tags the TODO panel looks for, e.g. `TODO,FIXME,HACK`.
   * The one value here that is not a switch, and the reason it is a string
   * rather than a list: the overlay validates a workspace override by comparing
   * `typeof` against this default and decides its origin badge by inequality.
   * Both are exact for a string; on an array the first would admit
   * `[1, {}]` and the second would call every workspace value an override.
   * Split into tags by `todoTags` in `utils/todoScan.ts`. (Wave 6)
   */
  todoPatterns: string;
};

/** The keys of `EditorDefaults` a command can flip and the panel draws as a
 *  checkbox, which is every one whose value is a boolean.
 *
 *  Derived from the shape rather than written out, so a setting that is not a
 *  switch cannot quietly become flippable by being added to the type: the
 *  compiler rejects `toggles: "todoPatterns"` rather than a `Preferences:`
 *  command turning a list of tags into `true`. */
export type EditorToggleKey = {
  [K in keyof EditorDefaults]: EditorDefaults[K] extends boolean ? K : never;
}[keyof EditorDefaults];

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
  panePins: PanePins;
  github: Github;
  chatDefaults: ChatDefaults;
  budgets: Budgets;
  editorDefaults: EditorDefaults;
  agent: Agent;
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
  // Today's layout: terminals and chat on the left, files on the right.
  panePins: { ...DEFAULT_PIN_SIDES },
  chatDefaults: {
    defaultSurface: "chat",
    streaming: true,
    density: "comfortable",
    toolOutputLines: 20,
    showSwayHooks: false,
    answerQuestionsInline: true,
    maxConcurrentChats: 4,
  },
  budgets: { sessionUsd: null, projectUsd: null, contextPercent: null, warnAtFraction: 0.8 },
  // The comfort defaults follow the tickets: the three that only cost a line of
  // pixels are on, the three cosmetic overlays are off (a stance nobody asked
  // for is worse than a switch), and the two behavioural ones are on because a
  // completion that never appears and a quit that still discards work are the
  // states these features exist to end.
  editorDefaults: {
    formatOnSave: false,
    organizeImportsOnSave: false,
    codeLens: false,
    vimMode: false,
    indentGuides: true,
    softWrap: false,
    renderWhitespace: false,
    scrollPastEnd: true,
    rainbowBrackets: false,
    bracketPairGuides: false,
    minimap: false,
    stickyScroll: false,
    wordCompletion: true,
    hotExit: true,
    compactFolders: true,
    todoPatterns: "TODO,FIXME,HACK,XXX",
  },
  agent: {},
  chat: {},
  editor: {},
};

/**
 * What shipped, captured before anything can write over it.
 *
 * `createStore` below proxies `DEFAULT_SETTINGS` *itself*, so the first save
 * rewrites that very object: read it afterwards and it reports the user's
 * values, not the built-in ones. Without this copy the bottom two layers of the
 * three-layer resolution collapse into one, and "where did this value come
 * from" can never answer "the default".
 */
const BUILT_IN_EDITOR: EditorDefaults = { ...DEFAULT_SETTINGS.editorDefaults };

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
// Exported so the Settings row's bounds are these bounds. A row that allowed a
// value `clampZoom` then refused would show a number the app is not at.
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
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

/** The live `--ui-scale` value, for the few sizes that have to be computed in JS
 *  rather than in a `calc(<base> * var(--ui-scale))` token: the pane floors that
 *  bound divider drags. Reactive, so those floors track the UI size the way the
 *  CSS ones do. */
export const chromeScale = () => uiScale(settings.typography.uiFontSize, zoom());

/** The one way in. Clamps to the 0.1 grid, persists, and re-folds the result
 *  into the CSS tokens, so the Settings row and ⌘= cannot diverge. */
export function setZoom(z: number) {
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

// Whether the file has been read at all. Told apart from its contents because
// the built-in defaults are a plausible-looking answer to every question: a
// consumer that refuses an action on an empty setting has to know whether the
// setting is empty or merely unread. A failed read still counts as loaded - the
// defaults are then the answer the whole app is running on.
const [settingsLoaded, setSettingsLoaded] = createSignal(false);
export { settingsLoaded };

/** Read settings from disk into the store and apply them. */
export async function loadSettings() {
  try {
    const s = await invoke<Settings>("get_settings");
    setSettings(s);
    applyAll(s);
  } catch {
    // keep current store / defaults
  } finally {
    setSettingsLoaded(true);
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

// ---- The per-workspace overlay ------------------------------------------
//
// `<workspace>/.sway/settings.json`, the third layer under the built-in
// defaults and this user's settings file. The rule for which layer wins lives
// in `workspaceSettings.ts`; what lives here is the one loaded overlay and the
// workspace it belongs to.
//
// One at a time, not a map keyed by path, because only the selected workspace's
// answers are ever in force: the editor reads them, the Settings panel badges
// them, and a background workspace's overlay would be a cache with no reader.

const [overlayRoot, setOverlayRoot] = createSignal<string | null>(null);
const [overlay, setOverlay] = createSignal<EditorOverlay>({});
export { overlayRoot };

/**
 * Read the overlay for a workspace, or clear it when nothing is selected.
 *
 * Cleared *before* the read rather than after it, so the moment the selection
 * changes the editor stops applying the previous workspace's answers. Leaving
 * them up during the round trip would show one project's settings applied to
 * another's files, which is worse than a flicker of the user defaults.
 */
export async function loadWorkspaceSettings(root: string | null): Promise<void> {
  setOverlayRoot(root);
  setOverlay({});
  if (!root) return;
  const raw = await invoke<unknown>("get_workspace_settings", { root }).catch(() => null);
  // Re-checked after the await: the selection can move while the read is in
  // flight, and a slow answer for the old workspace must not overwrite the new.
  if (overlayRoot() !== root) return;
  setOverlay(parseOverlay(raw, BUILT_IN_EDITOR));
}

/**
 * The editor settings in force for one named workspace.
 *
 * The overlay answers only for the workspace it was loaded from. Asking about a
 * different project has to fall through to the user layer rather than borrow
 * this one's answers, or a function handed an explicit path would quietly
 * report a *different* project's settings.
 */
function editorDefaultsFor(root: string | null): EditorDefaults {
  const own = root && root === overlayRoot() ? overlay() : {};
  return resolveEditorDefaults(BUILT_IN_EDITOR, settings.editorDefaults, own);
}

/** The editor settings in force here: workspace answer, user answer, default.
 *  Reactive - read this rather than `settings.editorDefaults`, which is only the
 *  middle layer. */
export function editorDefaults(): EditorDefaults {
  return editorDefaultsFor(overlayRoot());
}

/** Which layer supplied each value, for the Settings panel's badge. */
export function editorOrigin(): Record<keyof EditorDefaults, Layer> {
  return editorOrigins(BUILT_IN_EDITOR, settings.editorDefaults, overlay());
}

/**
 * Set or clear this workspace's answer for one setting; `undefined` clears it.
 *
 * The store moves first and the file is written after, so the editor reacts at
 * the speed of a click rather than of a disk. A write that fails leaves the two
 * disagreeing until the next load, which is the same bargain every other
 * preference here makes (see `rememberChatPrefs`), and is reported rather than
 * swallowed because this one writes into the user's repo.
 */
export async function setWorkspaceOverride<K extends keyof EditorDefaults>(
  key: K,
  value: EditorDefaults[K] | undefined,
): Promise<void> {
  const root = overlayRoot();
  if (!root) return;
  const next = withOverride(overlay(), key, value);
  setOverlay(next);
  try {
    await invoke("set_workspace_settings", { root, settings: overlayFile(next) });
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: `Saving this workspace's settings failed: ${e}`, kind: "error" });
  }
  emit(SETTINGS_CHANGED);
}

/**
 * Whether a save in `projectPath` should run the project's formatter first.
 *
 * The project's own answer where it has one, the resolved default otherwise. The
 * three-way distinction is the point: `undefined` and `null` both mean "this
 * project has never been asked", while `false` is a project that was asked and
 * said no, and must not be overruled by the global default being on.
 *
 * A null path (no workspace selected) can only be the default: there is no
 * project to have an opinion.
 */
export function formatOnSaveFor(projectPath: string | null): boolean {
  const own = projectPath ? settings.editor?.[projectPath]?.formatOnSave : undefined;
  return own ?? editorDefaultsFor(projectPath).formatOnSave ?? false;
}

/** Whether a save should organize this project's imports first.
 *
 *  Reads the plain default rather than `formatOnSave`'s per-project override:
 *  which formatter runs is a property of the repo, and a repo can carry a
 *  config saying so. Whether a language server should rewrite your import block
 *  on every save is a habit, and the person who has it has it everywhere. */
export function organizeImportsOnSaveFor(projectPath: string | null): boolean {
  return editorDefaultsFor(projectPath).organizeImportsOnSave ?? false;
}

/** Whether the code editor is in vim mode, in the workspace in force. */
export function vimModeOn(): boolean {
  return editorDefaults().vimMode ?? false;
}

/**
 * Set one editor default, in whichever layer is in force.
 *
 * The panel's checkboxes and the palette's `Preferences: ...` commands both come
 * through here, so the two cannot disagree about where a click lands. Always
 * writing the global layer would make a key look dead wherever a workspace
 * overrides it: the write would land under the overlay, the overlay would keep
 * winning, and the toggle would do nothing however often it was pressed.
 *
 * Swallowed on failure for the same reason a chat pick is: the choice has
 * already taken effect on screen.
 */
export function setEditorDefault<K extends keyof EditorDefaults>(
  key: K,
  on: EditorDefaults[K],
): void {
  if (editorOrigin()[key] === "workspace") {
    void setWorkspaceOverride(key, on);
    return;
  }
  const next: Settings = {
    ...settings,
    editorDefaults: { ...settings.editorDefaults, [key]: on },
  };
  void saveSettings(next).catch(() => {});
}

/** Flip one editor default. What a `Preferences: ...` command runs, which is why
 *  it reads the resolved value rather than the stored one: the thing being
 *  flipped is what the user can see. Only the boolean settings have an "other"
 *  value to flip to, which is what `EditorToggleKey` says in the type. */
export function toggleEditorDefault(key: EditorToggleKey): void {
  setEditorDefault(key, !editorDefaults()[key]);
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
