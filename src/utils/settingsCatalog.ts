// Every setting the Settings panel offers, named once.
//
// Three surfaces read this list and none of them owns it: the panel renders the
// editor rows from it, the panel's filter box searches it, and `commands.ts`
// generates a `Preferences: ...` command per entry. A setting added to the type
// and wired to a feature but missing here is invisible in all three at once,
// which is the drift `settingsCatalog.test.tsx` fails on.
//
// **This module holds data and no behaviour, deliberately.** `commands.ts`
// imports it, `hotkeys.ts` derives its bindings from `commands.ts`, and
// `TerminalView` imports `hotkeys.ts`, so anything reachable from here lands in
// the terminal's chunk. The one import below is `import type`, which the bundler
// erases; the matching rule that searches this list lives next to the panel, in
// `panels/Settings/settingsSearch.ts`, for the same reason.
/** A boolean the three-layer resolution answers for (default < user <
 *  workspace), so it can be flipped without opening the panel. Defined beside
 *  `EditorDefaults` because it is derived from that shape; re-exported here
 *  because this is where the catalog names it. */
export type { EditorToggleKey } from "../panels/Settings/settingsStore";
import type { EditorDefaults, EditorToggleKey } from "../panels/Settings/settingsStore";

/**
 * A section of the panel, in the order the panel renders them.
 *
 * `editor` and `editing` are both titled "Editor" because they are one section
 * to the eye: the first holds the two preferences that carry their own
 * explanation, the second the editing-comfort list. Splitting the *ids* is what
 * lets the filter show one without the other.
 */
export type SettingSection =
  | "agents"
  | "lsp"
  | "github"
  | "appearance"
  | "typography"
  | "editor"
  | "editing"
  | "checkpoints"
  | "chat"
  | "harness";

export const SECTION_TITLES: Record<SettingSection, string> = {
  agents: "Agents",
  lsp: "Language servers",
  github: "GitHub",
  appearance: "Appearance",
  typography: "Typography",
  editor: "Editor",
  editing: "Editor",
  checkpoints: "Checkpoints",
  chat: "Chat",
  harness: "Harness",
};

export type SettingEntry = {
  /** Stable id, and the suffix of this setting's `prefs:` command. Kebab-case,
   *  because it is user-visible in nothing but is compared in tests. */
  id: string;
  section: SettingSection;
  /** What the panel's row is labelled, and what a command is named after. */
  label: string;
  /** The explanation under the row, when the label does not carry it. Also what
   *  the filter box searches by substring. */
  hint?: string;
  /** Set for an `EditorDefaults` boolean, which a command flips in place.
   *  Everything else is reached by opening the panel filtered to it: a font
   *  stack or a dollar ceiling has no "other" value to toggle to. */
  toggles?: EditorToggleKey;
  /** Set for an `EditorDefaults` setting that is **not** a boolean, so it gets
   *  a row of its own rather than a checkbox and no `Preferences:` command.
   *  Named here for `toggles`' reason: every key the three-layer resolution
   *  answers for is registered in this file, and a test compares the two lists
   *  so a setting cannot exist in the type and nowhere on screen. */
  edits?: Exclude<keyof EditorDefaults, EditorToggleKey>;
};

/**
 * Every setting, in panel order.
 *
 * The three sections at the top are rendered by their own components and hold
 * controls that only exist at runtime (a card per agent found, a row per
 * language server installed). They carry one entry each, standing for the
 * section, so the filter and the palette can still reach them by name.
 */
export const SETTINGS: SettingEntry[] = [
  {
    id: "agents",
    section: "agents",
    label: "Agents",
    hint: "Which agent CLIs Sway found on your PATH, their versions, and the drift from what its adapters were built against.",
  },
  {
    id: "language-servers",
    section: "lsp",
    label: "Language servers",
    hint: "Which language servers are installed, and which files each one claims.",
  },
  {
    id: "github",
    section: "github",
    label: "GitHub",
    hint: "The account Sway acts as, signing in and out, and the forge integration's kill switch.",
  },

  { id: "theme", section: "appearance", label: "Theme" },

  { id: "ui-font-family", section: "typography", label: "UI font family" },
  { id: "ui-font-size", section: "typography", label: "UI font size" },
  { id: "editor-font-family", section: "typography", label: "Editor font family" },
  { id: "editor-font-size", section: "typography", label: "Editor font size" },
  { id: "terminal-font-family", section: "typography", label: "Terminal font family" },
  { id: "terminal-font-size", section: "typography", label: "Terminal font size" },
  { id: "line-height", section: "typography", label: "Line height" },

  // The two editor preferences that are not editing *comfort*: each carries its
  // own explanation, which is why they sit above the list rather than in it.
  {
    id: "format-on-save",
    section: "editor",
    label: "Format on save",
    toggles: "formatOnSave",
    hint: "Runs the project's own Biome or Prettier before writing, and nothing at all in a project that has neither. Off by default: a repo carrying a formatter config is not necessarily one that is currently formatted.",
  },
  {
    id: "organize-imports-on-save",
    section: "editor",
    label: "Organize imports on save",
    toggles: "organizeImportsOnSave",
    hint: "Asks the language server to sort this file's imports and drop the unused ones, just before the formatter runs. Off by default: it removes imports nothing references yet, which is what a file looks like halfway through being written.",
  },
  {
    id: "vim-mode",
    section: "editor",
    label: "Vim keybindings",
    toggles: "vimMode",
    hint: "Modal editing in the code editor, with a status line showing pending commands. Sway's own shortcuts keep working: ⌘S still saves, and the language commands still fire from normal mode.",
  },

  // The editing-comfort toggles, in the order they read as a list rather than in
  // the order the wave built them: what the text looks like, then what the
  // editor does for you, then what survives a quit.
  { id: "indent-guides", section: "editing", label: "Indentation guides", toggles: "indentGuides" },
  {
    id: "soft-wrap",
    section: "editing",
    label: "Soft wrap long lines",
    toggles: "softWrap",
    hint: "The default for every buffer. ⌘K's “Toggle soft wrap” overrides it for one tab.",
  },
  { id: "render-whitespace", section: "editing", label: "Show spaces and tabs", toggles: "renderWhitespace" },
  { id: "scroll-past-end", section: "editing", label: "Scroll past the last line", toggles: "scrollPastEnd" },
  { id: "rainbow-brackets", section: "editing", label: "Colour brackets by depth", toggles: "rainbowBrackets" },
  { id: "bracket-pair-guides", section: "editing", label: "Bracket pair guide lines", toggles: "bracketPairGuides" },
  { id: "minimap", section: "editing", label: "Minimap", toggles: "minimap" },
  {
    id: "sticky-scroll",
    section: "editing",
    label: "Sticky scroll",
    toggles: "stickyScroll",
    hint: "Pins the class and function headers of whatever is at the top of the screen over it, so a long body still says what it belongs to. Needs a language whose grammar Sway parses.",
  },
  {
    id: "word-completion",
    section: "editing",
    label: "Word completion without a language server",
    toggles: "wordCompletion",
    hint: "Suggests words already in the buffer, only where no language server has claimed the file, so it never competes with real completions.",
  },
  {
    id: "hot-exit",
    section: "editing",
    label: "Keep unsaved edits across a quit",
    toggles: "hotExit",
    hint: "Quitting stashes unsaved buffers and restores them on the next launch instead of asking you to discard them. If the stash cannot be written, the discard prompt still appears.",
  },
  {
    id: "compact-folders",
    section: "editing",
    label: "Compact single-child folders",
    toggles: "compactFolders",
    hint: "A folder whose only child is another folder renders as one row, src/utils/helpers, instead of a staircase. Gitignored folders are left alone.",
  },
  {
    // No `toggles`: a list of tags has no other value to flip to, so it is
    // reached by opening the panel the way a font stack is.
    id: "todo-patterns",
    section: "editing",
    edits: "todoPatterns",
    label: "TODO tags",
    hint: "Comma-separated tags the TODO panel searches for, matched case-sensitively so a TODO marker is not confused with the word in prose. Set it per workspace to follow a repo's own convention.",
  },

  {
    id: "checkpoints",
    section: "checkpoints",
    label: "Snapshot on each prompt",
    hint: "Lets a session's turns be diffed and reverted. Adds one git snapshot per prompt.",
  },

  {
    id: "default-surface",
    section: "chat",
    label: "Open sessions in",
    hint: "Which surface a click on a session opens: the chat pane or a terminal agent tab.",
  },
  { id: "streaming", section: "chat", label: "Stream responses" },
  { id: "transcript-density", section: "chat", label: "Transcript density" },
  {
    id: "tool-output-lines",
    section: "chat",
    label: "Tool output lines",
    hint: "Lines shown before a tool's output folds. 0 shows all of it.",
  },
  {
    id: "approval-auto-deny",
    section: "chat",
    label: "Auto-deny approvals after",
    hint: "Seconds an unanswered tool approval waits before Sway denies it.",
  },
  {
    id: "session-budget",
    section: "chat",
    label: "Stop this chat after",
    hint: "Dollars one chat may spend before it stops at its next tool call. Blank for no limit.",
  },
  {
    id: "project-budget",
    section: "chat",
    label: "Stop this project after",
    hint: "Dollars across every chat in one project. Two chats open on one repo spend one budget.",
  },
  {
    id: "context-budget",
    section: "chat",
    label: "Stop at context",
    hint: "Percent of the model's context window. Unlike the money limits this one recovers after a compaction.",
  },
  {
    id: "show-hooks",
    section: "chat",
    label: "Show every hook event",
    hint: "Off, the transcript shows a hook only when it fails. On reveals every execution.",
  },

  {
    id: "harness-path",
    section: "harness",
    label: "Binary path",
    hint: "Overrides the discovered agent binary for new chat sessions. Leave it empty to use the one found in Agents.",
  },
];
