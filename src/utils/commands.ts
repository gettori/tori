// The one canonical command table. Everything that can be *run* by name is here:
// the Cmd+K palette lists it, the Cmd+/ sheet lists the subset that carries keys,
// and `hotkeys.ts` dispatches that same subset. A command cannot be added,
// changed, or removed in one surface without the others following, which is the
// drift that makes a printed shortcut list lie.
//
// **This module imports `./events` and nothing else, deliberately.** `hotkeys.ts`
// derives its bindings from here and `TerminalView` imports `hotkeys.ts`, so any
// import added here lands in the terminal's chunk. That is why every `run` emits
// an event instead of calling the thing it means, and why enablement travels as
// a declarative `requires` tag rather than as a read of some store: resolving the
// tags is the palette's job (see CommandPalette), and it already sits at the leaf
// of the graph where reading the editor and git stores costs nothing.
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
  SET_RIGHT_MODE,
  type SetRightMode,
  EDITOR_SAVE,
  EDITOR_CLOSE_TAB,
  EDITOR_TOGGLE_PREVIEW,
  EDITOR_GOTO_LINE,
  GIT_STAGE_ACTIVE,
  GIT_UNSTAGE_ACTIVE,
  GIT_COMMIT,
  GIT_PUSH,
} from "./events";

/** Where a command is listed, in the palette and in the Cmd+/ sheet. */
export type CommandGroup =
  | "navigate"
  | "view"
  | "search"
  | "terminal"
  | "session"
  | "editor"
  | "git"
  | "help";

/**
 * Where a key-carrying command is handled, which decides whether it survives
 * terminal focus.
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
export type CommandScope = "global" | "window" | "terminal";

/**
 * What has to be true for a command to do anything, as a tag rather than a
 * predicate. A predicate would have to read the editor and git stores, and
 * importing either here would put them in the terminal's chunk (see the module
 * comment). The palette resolves these into a refusal reason.
 */
export type Requirement = "editorTab" | "editorFile" | "gitRoot" | "staged" | "ahead";

export type Command = {
  id: string;
  label: string;
  group: CommandGroup;
  /** Secondary text in the palette. */
  sub?: string;
  /** Key chips, in display order. Present means this is also a binding. */
  keys?: string[];
  scope?: CommandScope;
  match?: (e: KeyboardEvent) => boolean;
  /** Absent for `terminal` scope, whose handler lives in TerminalView. */
  run?: (e?: KeyboardEvent) => void;
  /** All must hold, in order; the first unmet one supplies the refusal reason. */
  requires?: Requirement[];
  /** Keep out of the palette's list (it is the palette, or it needs a key event
   *  to mean anything). Still dispatched, still listed in the sheet. */
  hidden?: boolean;
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

const RIGHT_MODES: { mode: SetRightMode["mode"]; label: string }[] = [
  { mode: "files", label: "Files" },
  { mode: "changes", label: "Changes" },
  { mode: "search", label: "Search" },
  { mode: "session", label: "Session" },
  { mode: "shared", label: "Shared" },
  { mode: "docs", label: "Docs" },
];

/**
 * Every command, in display order. Key-carrying entries come first and in the
 * order the Cmd+/ sheet has always shown them, since `BINDINGS` is a filtered
 * view over this list and the sheet renders that view in place.
 */
export const COMMANDS: Command[] = [
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
    // Listing the palette inside the palette.
    hidden: true,
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
    // No `run`: the focused xterm owns it. Nothing for the palette to offer.
    hidden: true,
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
    // The only command whose target is the key that fired it, so it is the only
    // one that cannot be run from a list of names.
    run: (e) => {
      if (e) emitWith(TAB_JUMP, { index: Number(e.key) - 1 });
    },
    hidden: true,
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
    // The palette lists every stoppable chat by name instead, which is the case
    // this binding deliberately refuses to guess at (see `chatToStop`).
    hidden: true,
  },

  // --- Editor -------------------------------------------------------------
  //
  // No keys. CM6's own `Mod-s` stays the sole save key: a table-level binding
  // would fire while a terminal had focus, saving a file nobody was looking at.
  {
    id: "editor-save",
    label: "Save file",
    group: "editor",
    run: () => emit(EDITOR_SAVE),
    requires: ["editorFile"],
  },
  {
    id: "editor-close-tab",
    label: "Close editor tab",
    group: "editor",
    run: () => emit(EDITOR_CLOSE_TAB),
    // Any tab, not just a file one: the commit log is closed the same way.
    requires: ["editorTab"],
  },
  {
    id: "editor-toggle-preview",
    label: "Toggle preview (Markdown, SVG)",
    group: "editor",
    run: () => emit(EDITOR_TOGGLE_PREVIEW),
    requires: ["editorFile"],
  },
  {
    id: "editor-goto-line",
    label: "Go to line",
    group: "editor",
    run: () => emit(EDITOR_GOTO_LINE),
    requires: ["editorFile"],
  },
  ...RIGHT_MODES.map(
    (m): Command => ({
      id: `mode:${m.mode}`,
      label: `Show ${m.label}`,
      group: "editor",
      run: () => emitWith<SetRightMode>(SET_RIGHT_MODE, { mode: m.mode }),
    }),
  ),

  // --- Git ----------------------------------------------------------------
  {
    id: "git-stage",
    label: "Stage this file",
    group: "git",
    run: () => emit(GIT_STAGE_ACTIVE),
    requires: ["gitRoot", "editorFile"],
  },
  {
    id: "git-unstage",
    label: "Unstage this file",
    group: "git",
    run: () => emit(GIT_UNSTAGE_ACTIVE),
    requires: ["gitRoot", "editorFile"],
  },
  {
    id: "git-commit",
    label: "Commit staged changes",
    group: "git",
    run: () => emit(GIT_COMMIT),
    requires: ["gitRoot", "staged"],
  },
  {
    id: "git-push",
    label: "Push to origin",
    group: "git",
    run: () => emit(GIT_PUSH),
    requires: ["gitRoot", "ahead"],
  },
];
