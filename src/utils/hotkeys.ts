import {
  emit,
  emitWith,
  FOCUS_SEARCH,
  FOCUS_TERMINAL,
  FOCUS_PROJECT_SEARCH,
  TAB_JUMP,
  TAB_CYCLE,
  NEXT_WAITING_SESSION,
  STOP_CHAT,
  type StopChat,
  OPEN_PALETTE,
  OPEN_QUICK_OPEN,
  TOGGLE_SHORTCUTS,
  ZOOM_IN,
  ZOOM_OUT,
  ZOOM_RESET,
  RELOAD_APP,
  TOGGLE_SIDEBAR,
  TOGGLE_TERMINAL,
  TOGGLE_EDITOR,
  TOGGLE_FILETREE,
} from "./events";

/** Where a binding is listed in the Cmd+/ sheet. */
export type BindingGroup = "navigate" | "view" | "search" | "terminal" | "session" | "help";

export const GROUP_LABELS: Record<BindingGroup, string> = {
  navigate: "Navigate",
  view: "View",
  search: "Search",
  terminal: "Terminal",
  session: "Sessions",
  help: "Help",
};

/**
 * Where a binding is handled, which decides whether it survives terminal focus.
 *
 * - `global`: routed through `dispatchHotkey`, which BOTH the window listener
 *   and TerminalView's `attachCustomKeyEventHandler` call, so it fires even
 *   while an xterm textarea has DOM focus (which otherwise swallows keydown
 *   before it reaches window).
 * - `window`: window listener only. Cmd+P is deliberately here, not global:
 *   quick-open should not steal the key from a program running in the terminal.
 * - `terminal`: owned by the focused terminal itself and has no table-level
 *   action, because it acts on one xterm instance rather than emitting a
 *   global event. Listed here so the sheet stays complete.
 */
export type BindingScope = "global" | "window" | "terminal";

export type Binding = {
  id: string;
  /** Key chips, in display order. */
  keys: string[];
  label: string;
  group: BindingGroup;
  scope: BindingScope;
  match: (e: KeyboardEvent) => boolean;
  /** Absent for `terminal` scope, whose handler lives in TerminalView. */
  run?: (e: KeyboardEvent) => void;
};

const cmd = (key: string) => (e: KeyboardEvent) =>
  e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === key;

const cmdShift = (key: string) => (e: KeyboardEvent) =>
  e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === key;

// Cmd+Option chords match on `e.code` (physical key), never `e.key`: macOS
// rewrites `e.key` to the Option glyph while Option is held (Opt+J -> "∆"), so a
// key-based match would silently never fire.
const cmdOpt = (code: string) => (e: KeyboardEvent) =>
  e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey && e.code === code;

/**
 * The one canonical binding table. `dispatchHotkey` and the Cmd+/ sheet both
 * read it, so a binding cannot be added, changed, or removed in one without
 * the other following - the drift that makes printed shortcut lists lie.
 *
 * Order is the sheet's display order within each group.
 */
export const BINDINGS: Binding[] = [
  {
    id: "quick-open",
    keys: ["⌘", "P"],
    label: "Open a file by name",
    group: "navigate",
    scope: "window",
    match: cmd("p"),
    run: () => emit(OPEN_QUICK_OPEN),
  },
  {
    id: "command-palette",
    keys: ["⌘", "K"],
    label: "Command palette: sessions, actions, panels",
    group: "navigate",
    scope: "global",
    match: cmd("k"),
    run: () => emit(OPEN_PALETTE),
  },
  {
    id: "filter-sidebar",
    keys: ["⌘", "⇧", "E"],
    label: "Filter the sidebar",
    group: "navigate",
    scope: "global",
    match: cmdShift("e"),
    run: () => emit(FOCUS_SEARCH),
  },
  {
    id: "shortcut-sheet",
    keys: ["⌘", "/"],
    label: "Show this shortcut sheet",
    group: "help",
    scope: "global",
    match: cmd("/"),
    run: () => emit(TOGGLE_SHORTCUTS),
  },
  {
    id: "zoom-in",
    keys: ["⌘", "+"],
    label: "Increase font size",
    group: "view",
    scope: "global",
    // Accept both ⌘= and ⌘⇧+ (same physical key): e.key is "=" unshifted, "+"
    // shifted, so a user pressing either way zooms in.
    match: (e) =>
      e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "=" || e.key === "+"),
    run: () => emit(ZOOM_IN),
  },
  {
    id: "zoom-out",
    keys: ["⌘", "−"],
    label: "Decrease font size",
    group: "view",
    scope: "global",
    match: (e) =>
      e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "-" || e.key === "_"),
    run: () => emit(ZOOM_OUT),
  },
  {
    id: "zoom-reset",
    keys: ["⌘", "0"],
    label: "Reset font size",
    group: "view",
    scope: "global",
    match: (e) => e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "0",
    run: () => emit(ZOOM_RESET),
  },
  {
    id: "reload",
    keys: ["⌘", "R"],
    label: "Reload the app (frontend only)",
    group: "view",
    scope: "global",
    match: cmd("r"),
    run: () => emit(RELOAD_APP),
  },
  {
    id: "toggle-sidebar",
    keys: ["⌘", "B"],
    label: "Show or hide the sidebar",
    group: "view",
    scope: "global",
    match: cmd("b"),
    run: () => emit(TOGGLE_SIDEBAR),
  },
  {
    id: "toggle-terminal",
    keys: ["⌘", "⌥", "J"],
    label: "Show or hide the terminal",
    group: "view",
    scope: "global",
    match: cmdOpt("KeyJ"),
    run: () => emit(TOGGLE_TERMINAL),
  },
  {
    id: "toggle-editor",
    keys: ["⌘", "⌥", "E"],
    label: "Show or hide the editor",
    group: "view",
    scope: "global",
    match: cmdOpt("KeyE"),
    run: () => emit(TOGGLE_EDITOR),
  },
  {
    id: "toggle-filetree",
    keys: ["⌘", "⌥", "B"],
    label: "Show or hide the file tree",
    group: "view",
    scope: "global",
    match: cmdOpt("KeyB"),
    run: () => emit(TOGGLE_FILETREE),
  },
  {
    id: "project-search",
    keys: ["⌘", "⇧", "F"],
    label: "Search across the project",
    group: "search",
    scope: "global",
    match: cmdShift("f"),
    run: () => emit(FOCUS_PROJECT_SEARCH),
  },
  {
    id: "terminal-search",
    keys: ["⌘", "F"],
    label: "Search in the focused terminal",
    group: "search",
    scope: "terminal",
    match: cmd("f"),
  },
  {
    id: "focus-terminal",
    keys: ["⌘", "J"],
    label: "Focus the terminal",
    group: "terminal",
    scope: "global",
    match: cmd("j"),
    run: () => emit(FOCUS_TERMINAL),
  },
  {
    id: "tab-jump",
    keys: ["⌘", "1–9"],
    label: "Jump to terminal tab 1 to 9",
    group: "terminal",
    scope: "global",
    match: (e) =>
      e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key),
    run: (e) => emitWith(TAB_JUMP, { index: Number(e.key) - 1 }),
  },
  {
    id: "tab-cycle",
    keys: ["⌃", "Tab"],
    label: "Cycle terminal tabs",
    group: "terminal",
    scope: "global",
    match: (e) => e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "Tab",
    run: () => emit(TAB_CYCLE),
  },
  {
    id: "next-waiting",
    keys: ["⌘", "⇧", "A"],
    label: "Jump to the next session waiting for approval",
    group: "session",
    scope: "global",
    match: cmdShift("a"),
    run: () => emit(NEXT_WAITING_SESSION),
  },
  {
    id: "stop-chat",
    keys: ["⌘", "."],
    label: "Stop the running turn",
    group: "session",
    // Global, not window: stopping a runaway turn is the thing you most want to
    // do while looking at something else, and a `window` binding would be
    // swallowed the moment a terminal had focus.
    scope: "global",
    match: cmd("."),
    run: () => emitWith<StopChat>(STOP_CHAT, { sessionId: null }),
  },
];

/** Bindings for the sheet, grouped in `GROUP_LABELS` order. */
export function bindingsByGroup(): { group: BindingGroup; bindings: Binding[] }[] {
  return (Object.keys(GROUP_LABELS) as BindingGroup[])
    .map((group) => ({ group, bindings: BINDINGS.filter((b) => b.group === group) }))
    .filter((g) => g.bindings.length > 0);
}

function fire(e: KeyboardEvent, scopes: BindingScope[]): boolean {
  const hit = BINDINGS.find((b) => scopes.includes(b.scope) && b.run && b.match(e));
  if (!hit) return false;
  hit.run!(e);
  return true;
}

/**
 * Match a terminal-safe hotkey and fire its side effect, returning whether it
 * was handled. Called by both App.tsx's window listener and TerminalView's
 * `attachCustomKeyEventHandler`, so these keep working while xterm has focus.
 */
export function dispatchHotkey(e: KeyboardEvent): boolean {
  return fire(e, ["global"]);
}

/**
 * The window-level superset: every binding `dispatchHotkey` handles, plus the
 * `window`-scoped ones that must NOT fire while the terminal has focus.
 */
export function dispatchWindowHotkey(e: KeyboardEvent): boolean {
  return fire(e, ["global", "window"]);
}
