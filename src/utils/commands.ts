// The one canonical command table. Everything that can be *run* by name is here:
// the omnibox lists it, the Cmd+/ sheet lists the subset that carries keys,
// and `hotkeys.ts` dispatches that same subset. A command cannot be added,
// changed, or removed in one surface without the others following, which is the
// drift that makes a printed shortcut list lie.
//
// **This module imports `./events` and `./settingsCatalog`, and nothing else,
// deliberately.** `hotkeys.ts` derives its bindings from here and `TerminalView`
// imports `hotkeys.ts`, so any import added here lands in the terminal's chunk.
// That is why every `run` emits an event instead of calling the thing it means,
// and why enablement travels as a declarative `requires` tag rather than as a
// read of some store: resolving the tags is the omnibox's job (see
// components/Omnibox), and it already sits at the leaf of the graph where reading the
// editor and git stores costs nothing. The catalogue is admitted on the same
// terms: it is a list of labels that imports nothing at runtime, which
// `commands.test.ts` checks rather than takes on trust.
import { SECTION_TITLES, SETTINGS } from "./settingsCatalog";
import {
  emit,
  emitWith,
  FOCUS_SEARCH,
  FOCUS_TERMINAL,
  RUN_LAST_TASK,
  FOCUS_PROJECT_SEARCH,
  TAB_JUMP,
  TAB_CYCLE,
  NEXT_WAITING_SESSION,
  STOP_CHAT,
  type StopChat,
  OPEN_OMNIBOX,
  type OpenOmnibox,
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
  EDITOR_SAVE_AS,
  EDITOR_NEW_SCRATCH,
  EDITOR_CLOSE_TAB,
  EDITOR_TOGGLE_PREVIEW,
  EDITOR_TOGGLE_SOFT_WRAP,
  EDITOR_GOTO_LINE,
  EDITOR_NAV_BACK,
  EDITOR_NAV_FORWARD,
  EDITOR_REOPEN_CLOSED,
  EDITOR_EXPAND_SELECTION,
  EDITOR_SHRINK_SELECTION,
  EDITOR_JOIN_LINES,
  EDITOR_SPLIT_SELECTION,
  PREFS_TOGGLE,
  type PrefsToggle,
  OPEN_SETTINGS,
  type OpenSettings,
  EDITOR_LSP_DEFINITION,
  EDITOR_LSP_REFERENCES,
  EDITOR_LSP_RENAME,
  EDITOR_LSP_FORMAT,
  EDITOR_LSP_CODE_ACTION,
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
  | "settings"
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
 *   the omnibox should not steal the key from a program running in the terminal.
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

// Same reason as `cmdOpt` for matching on `e.code`: Option rewrites `e.key`
// (Shift+Opt+F -> "Ï"). This one is the library's own Shift-Alt-F, mirrored
// here so the sheet can print it.
const shiftOpt = (code: string) => (e: KeyboardEvent) =>
  e.shiftKey && e.altKey && !e.metaKey && !e.ctrlKey && e.code === code;

// Ctrl chords, on `e.code` for the same reason the Option ones are: Shift
// rewrites `e.key` for a punctuation key (Shift+- -> "_"), so the shifted half
// of a pair would never match its own unshifted spelling.
const ctrl = (code: string) => (e: KeyboardEvent) =>
  e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === code;

const ctrlShift = (code: string) => (e: KeyboardEvent) =>
  e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.code === code;

const RIGHT_MODES: { mode: SetRightMode["mode"]; label: string }[] = [
  { mode: "files", label: "Files" },
  { mode: "changes", label: "Changes" },
  { mode: "pulls", label: "Pull requests" },
  { mode: "search", label: "Search" },
  { mode: "todos", label: "TODOs" },
  { mode: "tasks", label: "Tasks" },
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
    id: "omnibox",
    keys: ["⌘", "P"],
    label: "Go to a file, action, symbol or line",
    group: "navigate",
    scope: "window",
    match: cmd("p"),
    run: () => emitWith<OpenOmnibox>(OPEN_OMNIBOX, { prefix: "" }),
    // Listing the box inside the box.
    hidden: true,
  },
  {
    // An alias, not a second overlay: the same box, opened on the mode `>`
    // selects. Two keys because "which file" and "what can I run" are asked
    // differently often, and one of them being a prefix away does not make the
    // other worth a detour through it.
    id: "command-palette",
    keys: ["⌘", "K"],
    label: "Run an action",
    group: "navigate",
    scope: "global",
    match: cmd("k"),
    run: () => emitWith<OpenOmnibox>(OPEN_OMNIBOX, { prefix: ">" }),
    hidden: true,
  },
  {
    id: "nav-back",
    keys: ["⌃", "−"],
    label: "Go back to where you were",
    group: "navigate",
    // `window`, not `global`, for the omnibox's reason: these act on the editor's
    // jump list, and a program running in the terminal should keep its own
    // control keys.
    scope: "window",
    match: ctrl("Minus"),
    run: () => emit(EDITOR_NAV_BACK),
  },
  {
    id: "nav-forward",
    keys: ["⌃", "⇧", "−"],
    label: "Go forward again",
    group: "navigate",
    scope: "window",
    match: ctrlShift("Minus"),
    run: () => emit(EDITOR_NAV_FORWARD),
  },
  {
    id: "reopen-closed-tab",
    keys: ["⌘", "⇧", "T"],
    label: "Reopen the tab you just closed",
    group: "navigate",
    // `window` for the same reason as its neighbours: this acts on the editor's
    // tab strip, and a terminal has its own claim on Cmd+Shift+T.
    scope: "window",
    match: cmdShift("t"),
    run: () => emit(EDITOR_REOPEN_CLOSED),
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
    // The build-and-watch loop: run it, read the output, fix, run it again. The
    // second half is the whole point, so it costs a keystroke rather than a
    // picker that would ask the question already answered.
    //
    // Global rather than window, unlike ⌘P: the reason to keep the omnibox out
    // of a running program's keys does not apply, since re-running the build is
    // exactly what you want while reading the last one's output.
    id: "rerun-last-task",
    keys: ["⌘", "⇧", "B"],
    label: "Run the last task again",
    group: "terminal",
    scope: "global",
    match: cmdShift("b"),
    run: () => emit(RUN_LAST_TASK),
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
  // Almost no keys. CM6's own `Mod-s` stays the sole save key: a table-level
  // binding would fire while a terminal had focus, saving a file nobody was
  // looking at. The one exception is Cmd+N below, which is not a CM6 binding at
  // all - it has to work with no buffer open, which is exactly when there is no
  // keymap to hold it.
  {
    id: "editor-new-scratch",
    keys: ["⌘", "N"],
    label: "New scratch buffer",
    sub: "An untitled file, kept until you save it somewhere.",
    group: "editor",
    // `window` for the tab strip's reason: this opens an editor tab, and a
    // program running in the terminal keeps its own claim on the key.
    scope: "window",
    match: cmd("n"),
    run: () => emit(EDITOR_NEW_SCRATCH),
  },
  {
    id: "editor-save",
    label: "Save file",
    group: "editor",
    run: () => emit(EDITOR_SAVE),
    requires: ["editorFile"],
  },
  {
    id: "editor-save-as",
    label: "Save as a new file",
    // Says what happens to the tab, because that is the part a person cannot
    // guess: it follows the file rather than staying on the old one.
    sub: "The tab follows it. A scratch buffer's own file is removed.",
    group: "editor",
    run: () => emit(EDITOR_SAVE_AS),
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
    id: "editor-toggle-soft-wrap",
    label: "Toggle soft wrap",
    // Says which way the setting points, because the command reads as a
    // question ("wrapped or not?") that the palette can already answer.
    sub: "This tab only. Settings holds the default.",
    group: "editor",
    run: () => emit(EDITOR_TOGGLE_SOFT_WRAP),
    requires: ["editorFile"],
  },
  {
    id: "editor-goto-line",
    label: "Go to line",
    group: "editor",
    run: () => emit(EDITOR_GOTO_LINE),
    requires: ["editorFile"],
  },
  // The chords for these four are CM6's, declared in CodeEditor's keymap and
  // deliberately absent here: `Mod-i` already belongs to `defaultKeymap`, and a
  // second binding in this table would fire on a buffer nobody is looking at.
  // The rows exist so the commands are discoverable, and named the way the
  // editor's other rows are.
  {
    id: "editor-expand-selection",
    label: "Expand selection",
    sub: "Grow to the enclosing syntax node.",
    group: "editor",
    run: () => emit(EDITOR_EXPAND_SELECTION),
    requires: ["editorFile"],
  },
  {
    id: "editor-shrink-selection",
    label: "Shrink selection",
    sub: "Step back down one expansion.",
    group: "editor",
    run: () => emit(EDITOR_SHRINK_SELECTION),
    requires: ["editorFile"],
  },
  {
    id: "editor-join-lines",
    label: "Join lines",
    group: "editor",
    run: () => emit(EDITOR_JOIN_LINES),
    requires: ["editorFile"],
  },
  {
    id: "editor-split-selection",
    label: "Split selection into lines",
    sub: "One cursor per selected line.",
    group: "editor",
    run: () => emit(EDITOR_SPLIT_SELECTION),
    requires: ["editorFile"],
  },

  // The language-server four. `languageServerExtensions()` already binds them
  // to F12 / Shift-F12 / F2 / Shift-Alt-F inside the editor's own keymap, which
  // is a set of shortcuts nothing in the app could print and a Mac laptop
  // cannot press without holding Fn. They are registered here so the palette
  // and the Cmd+/ sheet know them, with a Cmd-Opt combo alongside the
  // function-row default.
  //
  // `window`, not `global`: an LSP action is aimed at the editor, and a global
  // binding would fire it at a file nobody is looking at while a terminal had
  // focus. The editor's own keymap preventDefaults whatever it handles, so
  // pressing one of these with the editor focused cannot fire it twice.
  {
    id: "lsp-definition",
    keys: ["⌘", "⌥", "D"],
    label: "Go to definition",
    sub: "F12",
    group: "editor",
    scope: "window",
    match: cmdOpt("KeyD"),
    run: () => emit(EDITOR_LSP_DEFINITION),
    requires: ["editorFile"],
  },
  {
    id: "lsp-references",
    keys: ["⌘", "⌥", "R"],
    label: "Find references",
    sub: "⇧F12",
    group: "editor",
    scope: "window",
    match: cmdOpt("KeyR"),
    run: () => emit(EDITOR_LSP_REFERENCES),
    requires: ["editorFile"],
  },
  {
    id: "lsp-rename",
    keys: ["⌘", "⌥", "N"],
    label: "Rename symbol",
    sub: "F2",
    group: "editor",
    scope: "window",
    match: cmdOpt("KeyN"),
    run: () => emit(EDITOR_LSP_RENAME),
    requires: ["editorFile"],
  },
  {
    id: "lsp-code-action",
    keys: ["⌘", "⌥", "A"],
    label: "Show code actions",
    // The chord every other editor uses, bound in CodeEditor's own keymap
    // beside F2. `⌘.` is not free: it is `stop-chat`, deliberately global so a
    // runaway turn can be stopped from any surface, including this one.
    sub: "⌥⏎",
    group: "editor",
    scope: "window",
    match: cmdOpt("KeyA"),
    run: () => emit(EDITOR_LSP_CODE_ACTION),
    requires: ["editorFile"],
  },
  {
    id: "lsp-format",
    // Not only the language server's, despite the id: the editor tries the
    // project's own Biome or Prettier first and falls back to the server only
    // where there is none. One entry rather than two, because "format this
    // file" is one thing the user wants and the answer to "with what?" is the
    // project's, not theirs.
    //
    // Already reachable on a Mac keyboard, so it keeps the library's binding
    // rather than gaining a second one.
    keys: ["⇧", "⌥", "F"],
    label: "Format document",
    group: "editor",
    scope: "window",
    match: shiftOpt("KeyF"),
    run: () => emit(EDITOR_LSP_FORMAT),
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

  // --- Preferences ---------------------------------------------------------
  //
  // One row per setting, generated rather than written out, so a setting added
  // to the catalogue is reachable by name on the day it is added instead of on
  // the day someone remembers this table.
  //
  // All prefixed, and all keyless. The prefix is what keeps thirty rows out of
  // the way of the twenty that are actions: an empty palette is a list of things
  // to do, and these only surface once you type towards one.
  //
  // A boolean the layer resolution answers for flips in place, in whichever
  // layer is in force. Everything else opens the panel filtered to itself: a
  // font stack has no other value to toggle to, and a command that guessed at
  // one would be a worse affordance than the field.
  ...SETTINGS.map(
    (s): Command => ({
      id: `prefs:${s.id}`,
      label: `Preferences: ${s.label}`,
      sub: SECTION_TITLES[s.section],
      group: "settings",
      run: s.toggles
        ? () => emitWith<PrefsToggle>(PREFS_TOGGLE, { key: s.toggles! })
        : () => emitWith<OpenSettings>(OPEN_SETTINGS, { query: s.label }),
    }),
  ),
];
