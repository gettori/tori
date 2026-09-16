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
// `panels/Settings/utils/settingsSearch.ts`, for the same reason.
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
  | "dap"
  | "git"
  | "forge"
  | "appearance"
  | "typography"
  | "editor"
  | "editing"
  | "checkpoints"
  | "chat"
  | "panes";

/**
 * A tab in the panel's strip, in the order the strip renders them.
 *
 * A **grouping layer over `SettingSection`**, not a parallel taxonomy: sections
 * stay the unit a setting belongs to and the unit the panel titles, and a tab is
 * just an ordered set of them. That is what lets the strip be replaced by a
 * vertical rail, or the grouping be rearranged, without a single `SettingEntry`
 * moving.
 */
export type SettingTab =
  | "agents"
  | "chat"
  | "editor"
  | "languages"
  | "appearance"
  | "integrations"
  | "panes";

/** Not "Workspace": the panel already uses that word for a folder, and most of
 *  these rows write your global settings. */
export type SettingGroup = "Workbench" | "Application";

export type SettingTabDef = {
  id: SettingTab;
  /** What the tab is labelled in the rail. */
  label: string;
  /** The rail draws a heading whenever this changes, so this list's order is
   *  the rail's order. */
  group: SettingGroup;
  /** A lucide icon id, kebab-case, **as a name rather than the component.**
   *  This module is reachable from the terminal's chunk (see the module
   *  comment), so importing six icon components here would drag lucide in with
   *  them. The panel maps the name to the component at the point of render. */
  icon: string;
  /** The sections this tab shows, in render order. Every `SettingSection`
   *  appears in exactly one tab, which `settingsCatalog.test.tsx` checks. */
  sections: SettingSection[];
};

/**
 * The six tabs, in rail order.
 *
 * The pairings are the ones that read as one subject rather than the ones that
 * happen to be adjacent today: checkpoints are what makes a chat's turns
 * revertible, and the two Editor sections were already titled the same thing.
 *
 * This tab was briefly labelled "Harnesses", to keep it apart from the ~31
 * catalogue entries below the cards, which are agents too. The vocabulary is one
 * word now, so it reads "Agents" again and the catalogue's rows carry the
 * qualifier instead. The id never moved either way: it stays `agents`, so
 * settings.json, the schemas and every `Preferences:` command are untouched.
 */
export const SETTING_TABS: SettingTabDef[] = [
  { id: "agents", label: "Agents", group: "Workbench", icon: "bot", sections: ["agents"] },
  { id: "chat", label: "Chat", group: "Workbench", icon: "message-square", sections: ["chat", "checkpoints"] },
  { id: "editor", label: "Editor", group: "Workbench", icon: "file-code", sections: ["editor", "editing"] },
  { id: "languages", label: "Languages", group: "Workbench", icon: "braces", sections: ["lsp", "dap"] },
  { id: "panes", label: "Panes", group: "Workbench", icon: "columns-2", sections: ["panes"] },
  { id: "appearance", label: "Appearance", group: "Application", icon: "palette", sections: ["appearance", "typography"] },
  { id: "integrations", label: "Integrations", group: "Application", icon: "plug", sections: ["git", "forge"] },
];

/** Which tab a section is shown under. Derived from `SETTING_TABS` rather than
 *  written out beside it, so the two cannot disagree. */
export const TAB_OF_SECTION: Record<SettingSection, SettingTab> = Object.fromEntries(
  SETTING_TABS.flatMap((t) => t.sections.map((s) => [s, t.id])),
) as Record<SettingSection, SettingTab>;

/** Which tab shows one catalogue entry, or `undefined` for an id the catalogue
 *  does not carry. What a palette deep link needs before it can reveal a row:
 *  the row exists in a pane, and the pane has to be the one on screen. */
export function tabOfEntry(id: string): SettingTab | undefined {
  const entry = SETTINGS.find((s) => s.id === id);
  return entry && TAB_OF_SECTION[entry.section];
}

export const SECTION_TITLES: Record<SettingSection, string> = {
  agents: "Agents",
  lsp: "Language servers",
  dap: "Debuggers",
  git: "Git",
  forge: "Hosts",
  appearance: "Appearance",
  typography: "Typography",
  editor: "Editor",
  editing: "Editor",
  checkpoints: "Checkpoints",
  chat: "Chat",
  panes: "Panes",
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
  // The usage controls live on an account's own card, on the agent's detail
  // page, because what they answer is per account: a quota window belongs to a
  // login. Listed here anyway, because the catalogue is what the filter
  // searches and what the palette generates a row from, and a setting missing
  // here is invisible in both.
  {
    id: "titlebar-preview",
    section: "agents",
    label: "Titlebar preview",
    hint: "Which of an account's quota windows the titlebar carries, and how deep Sway reads for it. Nothing lit means nothing read. Set per account on the agent's page.",
  },
  {
    id: "usage-warn-at",
    section: "agents",
    label: "Warn at",
    hint: "How full one account's quota gets before Sway says so. Follows the shared threshold in Chat until you move it. Set per account on the agent's page.",
  },
  {
    id: "usage-notify",
    section: "agents",
    label: "Usage notifications",
    hint: "Whether a quota window approaching or reached is worth an OS notification. Never sent while Sway has focus. Set per account on the agent's page.",
  },
  // The Files rows sit on the agent's own page too, and for a sharper version of
  // the same reason: what they list is per account *and* per adapter, so there
  // is nothing here for a pane to render. One entry per kind rather than one
  // for the group, because "skills" and "subagents" are the words somebody
  // types into the filter, and a single "Files" row answers neither.
  {
    id: "agent-instructions",
    section: "agents",
    label: "Instructions",
    hint: "The agent's own instructions file (CLAUDE.md for Claude), per account. Open, reveal or create it on the agent's page.",
  },
  {
    id: "agent-skills",
    section: "agents",
    label: "Skills",
    hint: "The skills folder the agent reads at user level, per account. Listed and created on the agent's page.",
  },
  {
    id: "agent-commands",
    section: "agents",
    label: "Commands",
    hint: "The slash commands the agent reads at user level, per account. Listed and created on the agent's page.",
  },
  {
    id: "agent-subagents",
    section: "agents",
    label: "Subagents",
    hint: "The subagents the agent reads at user level, per account. Listed and created on the agent's page.",
  },
  {
    id: "agent-settings-file",
    section: "agents",
    label: "Settings and hooks",
    hint: "The agent's own settings file, where its hooks and permissions live. Sway lists it and never edits it for you; open it on the agent's page.",
  },
  {
    id: "language-servers",
    section: "lsp",
    label: "Language servers",
    hint: "Which language servers are installed, and which files each one claims.",
  },
  {
    id: "debuggers",
    section: "dap",
    label: "Debuggers",
    hint: "Which debug adapters are installed, and which files each one can run under a debugger.",
  },
  {
    id: "git",
    section: "git",
    label: "Git",
    hint: "Whether git is installed and usable, and what to run to install it when it is not.",
  },
  {
    id: "forge",
    section: "forge",
    label: "Hosts",
    // The product names stay in the hint: the filter is fuzzy over both fields,
    // so "github" has to keep finding this section after the rename.
    hint: "Accounts on GitHub, GitLab and self-hosted instances of either, signing in and out, and the integration's kill switch.",
  },

  { id: "theme", section: "appearance", label: "Theme" },
  {
    // Bare, like the card-section entries: no `toggles` (it is not a boolean and
    // has no workspace layer) and no `edits` (it is not an `EditorDefaults` key -
    // zoom is localStorage-backed, so a burst of ⌘= never churns settings.json).
    // Listed anyway, because the catalogue is what the search counts and what the
    // palette generates a row from, and a setting missing here is invisible in
    // both.
    id: "zoom",
    section: "appearance",
    label: "Zoom",
    hint: "Scales the whole interface, on top of the font sizes below. ⌘= and ⌘- move it a step, ⌘0 resets it.",
  },

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
    id: "code-lens",
    section: "editor",
    label: "Code lens",
    toggles: "codeLens",
    hint: "Draws the language server's reference and implementation counts above the lines they describe. Off by default: unlike every other language feature it asks a question nobody asked it, so it costs a round trip per file per edit whether or not you read the answer.",
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
  // Two reader preferences that live in localStorage rather than in
  // `EditorDefaults`: each is something you switch on while reading one file and
  // off again a minute later, so neither belongs in the settings file or its
  // workspace overlay. Bare entries for `zoom`'s reason - the panel is not the
  // only place they are reached from, but it is the only place they are *found*.
  {
    id: "blame",
    section: "editing",
    label: "Git blame",
    hint: "Shows who last changed each line, in the editor's gutter. The editor's own blame button switches it too, and the two stay in step.",
  },
  {
    id: "side-by-side-diff",
    section: "editing",
    label: "Side-by-side diffs",
    hint: "Two columns instead of one for every diff Sway renders: commits, pull requests, review and chat. Narrow panes fall back to inline regardless.",
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
    id: "pin-terminal",
    section: "panes",
    label: "Terminals open in",
    hint: "Which end of the split a new terminal, agent, command or task tab lands in. Tabs already open stay where they are.",
  },
  {
    id: "pin-chat",
    section: "panes",
    label: "Chats open in",
    hint: "Which end of the split a new chat tab lands in. Tabs already open stay where they are.",
  },
  {
    id: "pin-file",
    section: "panes",
    label: "Files open in",
    hint: "Which end of the split a file opens in. Files already open stay where they are.",
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
    id: "max-concurrent-chats",
    section: "chat",
    label: "Warn above",
    hint: "Live chats before Sway says the cost is adding up. It warns rather than refusing. 0 for no limit.",
  },
  {
    id: "session-budget",
    section: "chat",
    label: "Stop this chat after",
    hint: "Dollars one chat may spend before it stops starting turns. Blank for no limit.",
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
    id: "warn-at",
    section: "chat",
    label: "Warn at",
    hint: "How full a limit gets before Sway says so. Governs the ceilings above, and is the default for each account's quota windows until that account sets its own under Agents. 100% turns the warning off; a limit actually reached is always shown.",
  },
  {
    id: "show-hooks",
    section: "chat",
    label: "Show every hook event",
    hint: "Off, the transcript shows a hook only when it fails. On reveals every execution.",
  },
  {
    id: "attach-long-pastes",
    section: "chat",
    label: "Attach long pastes as files",
    hint: "A paste over 30 lines or 3000 characters becomes a file chip. Off keeps every paste in the box.",
  },
];
