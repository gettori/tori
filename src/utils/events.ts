// Lightweight window-event bus for cross-component actions.
import type { ContentBlock } from "./chatTypes";
import type { AgentId } from "./agents";
import type { EditorToggleKey } from "./settingsCatalog";
import type { DraftOrigin } from "./chatCompose";

// A live terminal tab, surfaced from the terminal area to the sidebar so its
// confirms (checkout, destructive delete) can count what's actually running in a
// folder, including shell + fresh-agent tabs that pgrep can't see. `workspace` is
// the branch-unit folder the tab is grouped under; `sessionId` (resumed agents
// only) lets the sidebar dedup a tab against a pgrep-matched session.
export type LiveTab = {
  id: string;
  workspace: string;
  // A running task counts as live work in the folder exactly as a shell does:
  // "3 tabs are running here" must include the build somebody kicked off, or a
  // checkout confirm undercounts what it is about to disturb.
  kind: "shell" | "agent" | "command" | "chat" | "task";
  // Where the tab was spawned. A Topic tab's `workspace` is `topic:<id>`,
  // not a folder, so the cwd is the only path a Spaces row can count it by.
  cwd?: string;
  sessionId?: string;
  // Agent program for a resumed/spawned agent tab; lets a session-row probe
  // (session_running) pick the right per-agent pgrep pattern.
  agent?: AgentId;
  // How much of the tab exists (see `TabState` in terminalTabStore). Since
  // lazy restore, a tab is no longer proof that anything is running: a
  // restored strip is full of entries with no process behind them, and every
  // consumer that read "has a tab" as "is running" has to read this instead.
  //
  // The dangerous direction is the undercount. A destructive confirm probes
  // only the sessions its tabs do *not* already name, so an inert tab holding
  // a session id would mask a session that genuinely is running.
  state: "inert" | "open" | "live";
};

export const FOCUS_SEARCH = "tori:focus-search";
export const FOCUS_TERMINAL = "tori:focus-terminal";
// Moves keyboard focus into the toast region (Cmd+Option+T), from which Tab
// reaches each toast and Escape dismisses the focused one. Routed through the
// command registry rather than Kobalte's own document-level hotkey listener,
// which never checks defaultPrevented (the double-fire gotcha).
export const FOCUS_TOASTS = "tori:focus-toasts";
// Switches the editor's right panel to the project-wide Search mode and
// focuses its input (Cmd+Shift+F). Distinct from FOCUS_SEARCH, which focuses
// the left sidebar's own filter box.
export const FOCUS_PROJECT_SEARCH = "tori:focus-project-search";

// Payload-carrying event: jump to tab N (0-indexed) of the current
// workspace's visible terminal bar (Cmd+1..9). Consumed by Terminal.tsx.
export const TAB_JUMP = "tori:tab-jump";
export type TabJump = { index: number };

// Cycle to the next tab in the current workspace's visible terminal bar
// (Ctrl+Tab). Consumed by Terminal.tsx.
export const TAB_CYCLE = "tori:tab-cycle";

// Focus the next session (across all live tabs) whose status is "Waiting for
// approval" (Cmd+Shift+A). Consumed by Terminal.tsx.
export const NEXT_WAITING_SESSION = "tori:next-waiting-session";

// Payload-carrying event: stop a chat's running turn (Cmd+.) or, from the
// command palette, one named chat. Consumed by App.tsx, which owns the only
// listener.
//
// It goes through the event bus and App rather than through the chat panel
// because the point of the hotkey is to work while some *other* pane has focus,
// and a stop that depends on the chat being focused is a stop button with extra
// steps.
//
// `sessionId: null` means "work out which one": the palette always names a
// session, the hotkey usually cannot. See `chatToStop` for the resolution and
// for why it refuses to guess between several.
export const STOP_CHAT = "tori:stop-chat";
export type StopChat = { sessionId: string | null };

// Payload-carrying event: open the omnibox, in the mode the prefix selects
// (`""` files, `">"` actions, and the rest of `utils/omniboxModes.ts`). Consumed
// by App.tsx, which owns the only signal behind it.
//
// One event and one overlay where there were two of each. Cmd+P and Cmd+K are
// still two bindings, because the two questions ("which file" and "what can I
// run") are asked differently often enough to deserve separate keys, but they
// now open the same box at different prefixes, and either can be typed into the
// other without closing anything.
export const OPEN_OMNIBOX = "tori:open-omnibox";
export type OpenOmnibox = { prefix: string };

// Toggles the Cmd+/ shortcut sheet. Consumed by App.tsx. A toggle rather than
// an open, so the same key that summons it dismisses it.
export const TOGGLE_SHORTCUTS = "tori:toggle-shortcuts";

// Global UI zoom (Cmd+ / Cmd- / Cmd0), consumed by App.tsx, which drives the
// zoom multiplier in settingsStore. Scales chrome, editor, and terminal together.
export const ZOOM_IN = "tori:zoom-in";
export const TOGGLE_AUTOPILOT_VIEW = "tori:toggle-autopilot-view";
export const TOGGLE_AUTOPILOT_POPUP = "tori:toggle-autopilot-popup";
// Take the user somewhere in Tori: a branch-unit folder, a session's tab, or
// both. The sidebar answers, since selection is its; the cockpit steps aside.
export const NAVIGATE = "tori:navigate";
/** Mirrors `NavTarget` in src-tauri/src/autopilot.rs; at least one is set. */
export type NavTarget = { folder?: string; session?: string };
export const ZOOM_OUT = "tori:zoom-out";
export const ZOOM_RESET = "tori:zoom-reset";

// Reload the webview (Cmd+R), consumed by App.tsx. Reloads the frontend only,
// not the Rust backend (that needs a full restart).
export const RELOAD_APP = "tori:reload-app";

// Show/hide toggles for the four major panes. Consumed by App.tsx, which owns
// the visibility flags; TOGGLE_FILETREE also reaches the editor (App reveals the
// editor when the filetree is shown). Emitted by the topbar cluster, the view
// hotkeys, and the command palette so all three drive one path.
export const TOGGLE_SIDEBAR = "tori:toggle-sidebar";
export const TOGGLE_TERMINAL = "tori:toggle-terminal";
export const TOGGLE_EDITOR = "tori:toggle-editor";
export const TOGGLE_FILETREE = "tori:toggle-filetree";
export const TOGGLE_DOCK = "tori:toggle-dock";

// Step the sidebar through its modes. Consumed by LeftSidebar, which owns and
// persists the mode.
export const TOGGLE_SIDEBAR_MODE = "tori:toggle-sidebar-mode";

// Open the dock with this command's tab in front. The terminal panel owns the
// tab model, so it answers for a toast's Show as well as its own dedupe.
export const REVEAL_DOCK = "tori:reveal-dock";
export type RevealDock = { tabId: string };

// A plain shell in the dock. The dock draws the `+`, and the terminal panel owns
// the tab model it opens into.
export const NEW_DOCK_SHELL = "tori:new-dock-shell";

// Open the New Topic dialog. On the bus because the button that asks now sits
// in the sidebar's own head row, and the dialog belongs to the Topic list
// under it; lifting the dialog instead would move its five sibling dialogs too.
export const NEW_TOPIC = "tori:new-topic";

// Make a space the active one, by name. Emitted by the first-run modal when
// the user picks the space Tori should open on. The sidebar owns the active
// space and reads its persisted name once at mount, so writing the storage key
// from outside would not reach the sidebar already mounted behind the modal.
export const ACTIVATE_SPACE = "tori:activate-space";
export type ActivateSpace = { name: string };

// Pane layout edits (plan phase 8), all consumed by App.tsx, which owns the
// tree. Emitted by the command palette and by a tab's own context menu, so a
// split made either way runs the same guards.
export const SPLIT_PANE = "tori:split-pane";
export type SplitPane = {
  dir: "row" | "column";
  /** Which pane to split; the focused one when omitted (the palette). */
  paneId?: string;
  /** Which side of it the new pane takes. Default "after". */
  pos?: "before" | "after";
  /** A tab to carry into the new pane, which is what a drop on an edge is. */
  tabId?: string;
  kind?: string;
};
export const CLOSE_PANE = "tori:close-pane";
/** Move one tab into another pane. `paneId` names the target outright (the tab
 *  menu knows it); `direction` steps to the next or previous pane instead. */
export const MOVE_TAB_TO_PANE = "tori:move-tab-to-pane";
export type MoveTabToPane = {
  /** Omitted by the palette, which knows no tab: the focused pane's own. */
  tabId?: string;
  kind?: string;
  paneId?: string;
  direction?: "next" | "prev";
  /** Where in the target pane's strip it lands; appended when omitted. */
  index?: number;
};

// Fired by App.tsx after a pane transitions hidden -> shown, so the terminal
// refits its cell grid and CodeMirror re-measures without waiting on a
// ResizeObserver tick. Consumed by TerminalView and CodeEditor.
export const REFIT_PANES = "tori:refit-panes";

// Payload-carrying event: switch the editor's right panel to a named mode
// (the command palette's "toggle right-panel mode" actions). Editor.tsx's
// existing fallback-to-files effect handles a mode the current selection
// can't show, so no availability gating is needed here.
/** A pull request was just opened, so any list of them is one row short.
 *  Carries the project it belongs to: two projects can be open at once and a
 *  panel showing the other one has nothing to re-list. */
export const PR_OPENED = "tori:pr-opened";
export type PrOpened = { projectPath: string };

/// Go to the tab a pull request's review is submitted from. Consumed by
/// Editor.tsx, which is the only thing that knows which tab is active, and that
/// is where the pull request is read from: the key is pressed while reading a
/// diff, and the panel beside it is not always mounted.
export const FOCUS_PR_REVIEW = "tori:focus-pr-review";

export const SET_RIGHT_MODE = "tori:set-right-mode";
export type SetRightMode = {
  mode: "files" | "changes" | "pulls" | "search" | "session" | "debug";
  /** With `files`, the section below the tree to show and open. */
  section?: "scripts" | "outline" | "todos";
};

// Payload-carrying event: the right panel's Search, narrowed to one folder of
// one repo (the file tree's Find in Folder). Consumed by Editor.tsx.
export const SEARCH_IN_FOLDER = "tori:search-in-folder";
export type SearchInFolder = { repoPath: string; rel: string };

// Payload-carrying event: a plain shell tab opened in `cwd`, in the selected
// workspace (the file tree's Open in Integrated Terminal). Consumed by
// Terminal.tsx.
export const OPEN_SHELL_AT = "tori:open-shell-at";
export type OpenShellAt = { cwd: string };

// The command registry's editor entries (utils/commands.ts). Each acts on
// whatever tab is active, so none of them carries a path: the editor is the only
// thing that knows which that is, and a palette row naming a file it read a
// moment ago would act on the wrong one after a tab switch.
//
// Save is consumed by CodeEditor (it owns the buffer); the rest by Editor (it
// owns the tabs). GOTO_LINE asks for a line number rather than carrying one -
// Editor is the prompt host, so the palette closes before the prompt opens.
export const EDITOR_SAVE = "tori:editor-save";
export const EDITOR_CLOSE_TAB = "tori:editor-close-tab";
export const EDITOR_TOGGLE_PREVIEW = "tori:editor-toggle-preview";
/** Soft-wrap this one buffer, whatever `settings.editorDefaults.softWrap` says. */
export const EDITOR_TOGGLE_SOFT_WRAP = "tori:editor-toggle-soft-wrap";
export const EDITOR_GOTO_LINE = "tori:editor-goto-line";

// A new untitled buffer, and saving one under a real name. Both consumed by
// Editor: it owns the tabs, and SAVE_AS asks for a path the way GOTO_LINE asks
// for a line, so the palette closes before the prompt opens. The text itself
// comes from `liveBuffers`, which is how the pane reaches a buffer it does not
// own.
export const EDITOR_NEW_SCRATCH = "tori:editor-new-scratch";
export const EDITOR_SAVE_AS = "tori:editor-save-as";

// Reports back out of the editor, for a caller that put a file there and needs
// to know what became of it: the chat composer's open-in-editor link mirrors
// each save into the draft and lets go when the tab closes.
export const EDITOR_FILE_SAVED = "tori:editor-file-saved";
export type EditorFileSaved = { path: string; contents: string };
export const EDITOR_TAB_CLOSED = "tori:editor-tab-closed";
export type EditorTabClosed = { path: string };
/** Close whichever tab holds `path`, if one does. Unlike CLOSE_TAB it names
 *  the file rather than acting on the active tab. `discard` skips the unsaved
 *  changes confirm, for a caller that has already taken the buffer's text. */
export const EDITOR_CLOSE_PATH = "tori:editor-close-path";
export type EditorClosePath = { path: string; discard?: boolean };

// Back and forward through the jump list. Consumed by Editor.tsx, which is
// where the list lives: it is bucketed by workspace exactly as the tab strip is,
// and this pane is the only thing that knows which workspace is selected.
export const EDITOR_NAV_BACK = "tori:editor-nav-back";
export const EDITOR_NAV_FORWARD = "tori:editor-nav-forward";

// Put the most recently closed tab back. Consumed by Editor.tsx, which owns
// both the tab strip and the per-workspace stack of what was closed; the
// document behind it comes back through `closedBuffers` on the normal open
// path, so this carries no payload.
export const EDITOR_REOPEN_CLOSED = "tori:editor-reopen-closed";

// The selection commands, consumed by CodeEditor for the same reason as save:
// they act on the live buffer's selection, which only it holds. Each has a CM6
// chord as well; these carry the palette's copy of it.
export const EDITOR_EXPAND_SELECTION = "tori:editor-expand-selection";
export const EDITOR_SHRINK_SELECTION = "tori:editor-shrink-selection";
export const EDITOR_JOIN_LINES = "tori:editor-join-lines";
export const EDITOR_SPLIT_SELECTION = "tori:editor-split-selection";

// Hot exit's quit handshake. Editor.tsx asks, CodeEditor answers with whether
// the unsaved buffers actually reached the disk, matched by `requestId` the way
// SEND_TO_SESSION is. A request/result pair rather than a call, because the
// buffers live behind the lazy editor boundary and Editor holds that component
// only through props. `requestStash` in utils/hotExit.ts wraps both sides;
// nothing should emit these directly.
export const EDITOR_STASH_DIRTY = "tori:editor-stash-dirty";
export type EditorStashDirty = { requestId: string };
export const EDITOR_STASH_RESULT = "tori:editor-stash-result";
export type EditorStashResult = { requestId: string; ok: boolean };

// Payload-carrying event: flip one `EditorDefaults` boolean in whichever layer
// is currently in force (the workspace overlay where it supplies the value, the
// user's settings file otherwise), exactly as the Settings checkbox does.
//
// A setting is not editor state, but the toggle is an event like the rest,
// because `commands.ts` may reach nothing but this module and so cannot call the
// settings store itself. App.tsx listens, since the store is global and the
// command has to work with the panel closed.
//
// One event for every boolean rather than one per setting: the alternative is a
// new event name and a new listener for each key a later phase adds, which is
// the registration cost this generic payload exists to remove.
export const PREFS_TOGGLE = "tori:prefs-toggle";
export type PrefsToggle = { key: EditorToggleKey };

// Payload-carrying event: open the Settings panel, optionally with its filter
// box pre-filled so one setting is what the panel opens onto. Consumed by
// App.tsx, which owns the panel's open flag.
//
// This is how a `Preferences: ...` command reaches a setting it cannot toggle: a
// font stack or a dollar ceiling has no other value to flip to, so the command
// takes you to it rather than guessing at one.
export const OPEN_SETTINGS = "tori:open-settings";
/** `query` seeds the search box; `entry` is the catalogue id of the one setting
 *  the command pointed at, which the panel scrolls to, focuses and flashes. The
 *  query alone would only get you to the right tab - two settings can match one
 *  label, and the box is a filter rather than an address. */
export type OpenSettings = { query?: string; entry?: string };

// The language-server commands. They exist as events, and not only as CM6 key
// bindings, so the palette and the Cmd+/ sheet list them: a binding the library
// installs privately is a shortcut nothing can print. Consumed by CodeEditor,
// which owns the view they run against; each is a no-op when the active file
// has no language server, exactly as its function-row key already is.
export const EDITOR_LSP_DEFINITION = "tori:editor-lsp-definition";
export const EDITOR_LSP_REFERENCES = "tori:editor-lsp-references";
export const EDITOR_LSP_RENAME = "tori:editor-lsp-rename";
export const EDITOR_LSP_FORMAT = "tori:editor-lsp-format";
// Not a library binding like the four above: nothing in `@codemirror/lsp-client`
// asks for a code action at all, so this one is Tori's from end to end.
export const EDITOR_LSP_CODE_ACTION = "tori:editor-lsp-code-action";
// A whole-file action, named by its LSP kind. One event carrying the kind
// rather than one event per command: the three differ only in which string
// goes on the wire, and three handlers would be three copies of one function.
export const EDITOR_LSP_SOURCE_ACTION = "tori:editor-lsp-source-action";
export type SourceAction = { kind: string; label: string };
// Looking somewhere rather than going there: the answer is rendered inside the
// file being read, so nothing opens and nothing scrolls away. Separate events
// from the two above because the destination is the same and the *gesture* is
// not - "show me" and "take me there" are different intentions about the same
// symbol, and one command doing both would have to guess which was meant.
export const EDITOR_PEEK_DEFINITION = "tori:editor-peek-definition";
export const EDITOR_PEEK_REFERENCES = "tori:editor-peek-references";
export const EDITOR_PEEK_IMPLEMENTATION = "tori:editor-peek-implementation";
export const EDITOR_PEEK_TYPE_DEFINITION = "tori:editor-peek-type-definition";

/** The LSP kinds those commands are spelled with. Here rather than beside the
 *  rest of the source-action logic because `commands.ts` needs them and is
 *  allowed to import this module and one other, on purpose (see its header).
 *
 *  `source.sortImports` rather than a "sort members" kind: the spec has no such
 *  kind, so a command spelled that way would be one nothing ever answers. These
 *  three are what `typescript-language-server` actually advertises. */
export const SOURCE_KINDS = {
  organizeImports: "source.organizeImports",
  removeUnused: "source.removeUnused",
  sortImports: "source.sortImports",
} as const;

// The command registry's git entries. Consumed by Editor.tsx, which is always
// mounted and knows both the selected workspace and the active file - the
// Changes panel knows the first but is usually not on screen, and has never
// known the second. The actions themselves live in utils/gitActions.
export const GIT_STAGE_ACTIVE = "tori:git-stage-active";
export const GIT_UNSTAGE_ACTIVE = "tori:git-unstage-active";
export const GIT_COMMIT = "tori:git-commit";
export const GIT_PUSH = "tori:git-push";
export const GIT_FETCH = "tori:git-fetch";
export const GIT_PULL = "tori:git-pull";
export const GIT_PULL_REBASE = "tori:git-pull-rebase";
export const GIT_SYNC = "tori:git-sync";
export const GIT_STAGE_ALL = "tori:git-stage-all";
export const GIT_UNSTAGE_ALL = "tori:git-unstage-all";
export const GIT_DISCARD_ALL = "tori:git-discard-all";
export const GIT_COMMIT_SIGNOFF = "tori:git-commit-signoff";
export const GIT_UNDO_COMMIT = "tori:git-undo-commit";
export const GIT_STASH_STAGED = "tori:git-stash-staged";
export const GIT_MERGE_BRANCH = "tori:git-merge-branch";
export const GIT_REBASE_BRANCH = "tori:git-rebase-branch";
export const GIT_ABORT = "tori:git-abort";
export const GIT_CONTINUE = "tori:git-continue";
export const GIT_SKIP = "tori:git-skip";
export const GIT_AUTOSQUASH = "tori:git-autosquash";
export const GIT_BRANCH_CREATE = "tori:git-branch-create";
export const GIT_BRANCH_RENAME = "tori:git-branch-rename";
export const GIT_BRANCH_DELETE = "tori:git-branch-delete";

// Payload-carrying event: focus a specific live terminal tab by id (the
// command palette's "focus session" action, when the session is already
// open). Consumed by Terminal.tsx.
export const FOCUS_SESSION_TAB = "tori:focus-session-tab";
export type FocusSessionTab = { tabId: string };

// Payload-carrying event: the user clicked a terminal tab, so move the sidebar
// selection to match it (the reverse of props.selected -> focusOrResume).
// `sessionId` present -> select that session row; absent (a shell tab) -> select
// the branch-unit at `folderPath`. Emitted ONLY on a user click, never from the
// programmatic focus that a sidebar selection already drives, so the two can't
// feed back into each other. Consumed by LeftSidebar.tsx. Command tabs (clone/
// bootstrap) don't emit it.
export const TERMINAL_TAB_FOCUSED = "tori:terminal-tab-focused";
export type TerminalTabFocused = { folderPath: string; sessionId?: string };
export const CLOSE_TAB = "tori:close-tab";
export const SESSIONS_REFRESH = "tori:sessions-refresh";
export const THEME_APPLIED = "tori:theme-applied";
export const SETTINGS_CHANGED = "tori:settings-changed";

// The payload of the backend `fs://changed` Tauri event, mirroring `struct
// FsChanged` in `src-tauri/src/fs.rs`. Not an event name: `fs://changed` is
// emitted by Rust and listened to directly, this is only the shape its
// consumers must agree on.
//
// Pass it as the type argument (`listen<FsChanged>("fs://changed", …)`) and read
// `e.payload.paths`. An `as` cast on this payload defeats the whole point: that
// is how a consumer came to read a `path` field the watcher has never emitted,
// with no compile error to catch it.
export type FsChanged = {
  /** The watched root the burst came from. Optional only for old fixtures:
   *  the backend always sends it, and a listener showing another worktree
   *  drops the event instead of refreshing against the wrong tree. */
  root?: string;
  paths: string[];
};

// Payload-carrying event: open a file in the editor at an optional position.
// (General file-change fan-out is not here — that rides the backend
// `fs://changed` Tauri event, consumed directly by the editor panes. The one
// exception is AGENT_FILES_WRITTEN below, which is not a fan-out of the watcher
// but a report from a chat session about its own writes.)
export const OPEN_IN_EDITOR = "tori:open-in-editor";
export type OpenInEditor = {
  path: string;
  line?: number;
  col?: number;
  /** Open a Markdown or SVG file rendered rather than as source.
   *
   *  Not `preview`: a tab slot the next open replaces is called that everywhere
   *  else, and one word covering both is how a caller asks for the wrong one. */
  rendered?: boolean;
  /** Land in the pane's one replaceable slot: the next such open takes it over,
   *  and a double click, an edit or a plain open of the same file keeps it. */
  preview?: boolean;
  /** Carry the tab into a new pane split off to the right. */
  side?: boolean;
};

// Payload-carrying event: open a chat draft in the selected branch unit with
// these blocks already attached, and send nothing. Settings needs it because it
// has no Selection of its own: it cannot name a workspace, so it describes the
// draft and lets Terminal (which does have one) decide where it lands, the same
// way OPEN_JOB works. A window with no root toasts instead of guessing.
export const COMPOSE_DRAFT = "tori:compose-draft";
export type ComposeDraft = { blocks: ContentBlock[] };

// Payload-carrying event: a file or folder the file tree just renamed or moved.
// A rename is not a removal, so nothing closes: open tabs repoint to the new
// path (`renameTabs.ts`) and their buffers move with them, keeping unsaved text
// and undo history. Renaming a folder moves everything open inside it, which is
// why consumers match on prefix rather than on equality.
export const FILE_RENAMED = "tori:file-renamed";
export type FileRenamed = { from: string; to: string };

// Payload-carrying event: a Topic member's root moved (a reference got its
// worktree). Unlike a rename both folders stay, so only the workspace's clean
// tabs follow; a dirty one keeps its path, since its unsaved text was written
// against the old folder's file.
export const ROOT_MOVED = "tori:root-moved";
export type RootMoved = { workspace: string; from: string; to: string };

// Payload-carrying event: the files a chat session's tool call just wrote,
// straight off its `toolCallCompleted`/`fileEdit` events.
//
// The watcher already reports these ~250ms later (its debounce), so this is not
// new information - it is the same information sooner, and exactly, since the
// event names the files rather than a directory burst. The gutter and the
// Changes panel take it so an agent edit is on screen while the user is still
// reading the tool card. Consumers keep their `isSelfWrite` check and stay
// idempotent, because the watcher's echo is still coming.
export const AGENT_FILES_WRITTEN = "tori:agent-files-written";
export type AgentFilesWritten = { paths: string[] };

// How long a consumer coalesces a burst of the above. This event is per tool
// call where the watcher's is per burst, so a turn making fifty edits would run
// fifty refreshes without it. Deliberately shorter than the watcher's own ~250ms
// so the whole point (being there before it) survives.
export const AGENT_WRITE_DEBOUNCE_MS = 100;

// Payload-carrying event: a session's transcript was deleted, so any tab still
// driving or displaying it must go. Emitted by the sidebar after the session's
// child has been closed and its claim released, because a tab left open on a
// deleted transcript would keep rendering history that no longer exists and
// could still be typed at.
export const SESSION_DELETED = "tori:session-deleted";
export type SessionDeleted = { sessionId: string };

// Payload-carrying event: show the turn that wrote a line. Emitted by the
// editor's blame widget, which knows a session id and a prompt timestamp and
// nothing else; the chat tab for that session answers by scrolling its
// transcript to the matching turn.
//
// A timestamp rather than a turn id, because that is what the checkpoints are
// named by. Only the tab hosting the session can translate the two, since the
// mapping is built as its turns run.
export const REVEAL_TURN = "tori:reveal-turn";
export type RevealTurn = { sessionId: string; promptTs: number };

// Payload-carrying event: rewind a chat to one of its checkpoints, asked for
// from the Changes panel. The chat tab hosting the session answers, because the
// rewind is its own: it forks the session and cuts the replay as well as
// reverting the tree, and only the tab can do the first two.
export const REWIND_CHAT = "tori:rewind-chat";
export type RewindChat = { sessionId: string; promptTs: number };

// Payload-carrying event: a History row was acted on. The dropdown lives in the
// terminal pane and reaches none of what these actions need - the selection
// chain with its plain-repo checkout guard, the rename prompt, the delete
// confirm - all of which the sidebar already owns and already has tests for. So
// History names the session and what to do with it, and the sidebar answers
// exactly as its own row would. One event rather than three keeps that seam a
// single thing to find.
export const SESSION_ACTION = "tori:session-action";
export type SessionAction = { sessionId: string; action: "open" | "rename" | "delete" };

// Payload-carrying event: open a tab that runs one task at a branch unit. The
// transient commands (clone, bootstrap, install, sign-in) left through OPEN_JOB
// below; what stays is the kind whose cwd is a real workspace.
export const OPEN_TERMINAL = "tori:open-terminal";
export type OpenTerminal = {
  id: string;
  title: string;
  cwd: string;
  program: string;
  args: string[];
  /** Shell-hosted and seeded with `init`, so the task sees the PATH the user's
   *  own terminal has. Excluded from tab persistence: re-running a task on
   *  relaunch is not a restore. The only kind this event still opens. */
  kind: "task";
  /** The command line typed into the shell once it is ready, newline included.
   *  Delivered **backend-once** by `pty_spawn`, so a remount re-subscribes to
   *  the live process rather than running the command a second time. */
  init?: string;
};

// Payload-carrying event: run a transient command Tori starts for you (clone,
// bare-worktree bootstrap, agent install/update/uninstall, sign-in). Opens a
// `kind: "command"` tab in the dock's `shells:` group, a synthetic key no
// branch unit's strip is ever on, so it can neither join nor hide one
// ([[adr_jobs_leave_the_tab_model]]). Consumed by Terminal.tsx.
export const OPEN_JOB = "tori:open-job";
export type OpenJob = {
  /** Also the dedupe key: a second start under a live id reveals that job
   *  rather than spawning a second process. */
  id: string;
  title: string;
  cwd: string;
  program: string;
  args: string[];
  /** Extra environment for the job's process. A sign-in job carries the
   *  profile's home variable, which is the whole mechanism of signing in to a
   *  second account: the agent writes its credentials wherever this points. */
  env?: Record<string, string>;
  /** Takes the keyboard the moment it opens. True for a sign-in (browser OAuth
   *  that has to be typed at) and an install (vendor installers prompt); false
   *  for a clone, which must not misdirect the next keystroke. */
  interactive?: boolean;
  /** Re-discover projects when the process exits. Set by clone and bootstrap:
   *  without it the cloned project never appears. */
  rediscoverOnExit?: boolean;
  /** Re-probe agent health when the process exits. Set by sign-in and install,
   *  whose whole purpose is to change the answer: without it a completed login
   *  would keep reading as signed out. */
  recheckAgentsOnExit?: boolean;
  /** Which account a clean exit finishes signing in. Set by sign-in only:
   *  the agent's own first-run flag is set for that home, so its next
   *  interactive run does not open the wizard on an account already in. */
  completeSignInOnExit?: { agentId: string; profileId: string };
};

// Start a debug run (F5). Fire-and-forget and payload-less on purpose: the
// command registry owns the key but not the workspace, and which target this
// means depends on the selected branch-unit and what was last debugged there.
// Editor resolves that and opens the picker when there is no answer yet, so a
// first press teaches rather than doing nothing.
export const DEBUG_START = "tori:debug-start";

// Stop the debug run (Shift+F5). Payload-less for the same reason.
export const DEBUG_STOP = "tori:debug-stop";
/** Set or clear a breakpoint on the caret's line in the file on screen. */
export const DEBUG_TOGGLE_BREAKPOINT = "tori:debug-toggle-breakpoint";

// Stop the run and start the same target again. Its own event rather than a
// stop followed by a start from the caller, because the two have to be ordered
// against each other: a start issued while the previous run is still being torn
// down joins that run instead of replacing it.
export const DEBUG_RESTART = "tori:debug-restart";

// Open the target picker at a specific kind, which is what the palette's three
// rows do. A kind rather than a whole target: the picker still has to resolve
// the root, read that root's scripts and offer the remembered port.
export const DEBUG_PICK = "tori:debug-pick";
export type DebugPick = { kind: "file" | "script" | "attach" };

// Fire-and-forget: run this workspace's most recently run task again. The
// command registry owns the binding but not the workspace, so App resolves the
// selection and the recents store; nothing here says which task, because the
// answer changes with the selected branch-unit.
export const RUN_LAST_TASK = "tori:run-last-task";

// Payload-carrying event: start a fresh agent session in a branch-unit folder.
// Emitted by the sidebar's "New session" menu item; the terminal area owns the
// spawn (id/title/yolo conventions), so the sidebar only names the target.
export const NEW_SESSION = "tori:new-session";
// `agent` is any registered adapter id (Terminal.tsx's spawnSession treats it
// as opaque, looking it up via findAdapter), not just the bundled
// pair - the command palette's "new session per registered agent" needs the
// full registry, e.g. a user-added adapter.
export type NewSession = { folderPath: string; projectName: string; agent?: string };

// Payload-carrying event: open a chat draft in a branch-unit folder the sidebar
// just created, so a new worktree does not land on an empty strip. With a
// `prompt` (a unit started from an issue) the draft opens even beside tabs the
// folder already has.
export const NEW_CHAT_AT = "tori:new-chat-at";
export type NewChatAt = {
  folderPath: string;
  projectName: string;
  prompt?: string;
  origin?: DraftOrigin;
};

// Payload-carrying event: tear down everything rooted under a path (used when a
// space is deleted). The terminal area kills + closes PTY tabs whose cwd is under
// it; the editor pane closes buffers under it. Emitted before the native delete so
// no agent keeps writing into a vanishing cwd.
export const PURGE_UNDER_PATH = "tori:purge-under-path";
export type PurgeUnderPath = { path: string };

// A whole workspace key is going away (a Topic was deleted). Unlike a path
// purge nothing on disk is touched: every per-workspace store drops the key so
// a later Topic reusing nothing of it starts clean. Emitted after the delete.
//
// `roots` are the Topic's member folders, and only the debug state keyed on
// one is dropped for them. Deliberately not the whole per-workspace sweep: the
// delete *offers* to remove each worktree rather than removing it, so a member
// the user keeps can still be opened as a branch unit, and its tabs, terminals
// and tree state are that unit's, not the Topic's.
export const PURGE_WORKSPACE = "tori:purge-workspace";
export type PurgeWorkspace = { workspace: string; roots?: string[] };

// Payload-carrying event: ask the sidebar to open its own branch-removal
// confirmation for a branch-unit. Emitted by the Pull Requests panel once a pull
// request has been landed, when the branch it was on has nothing left to do.
//
// An event rather than a second delete path, because the sidebar's dialogs are
// where the guards live: a dirty worktree, unpushed commits, and agents still
// running in the folder. A panel that called `remove_worktree_and_branch`
// itself would be a place for all three to be forgotten. The sidebar owns the
// branch-unit list, so it also decides which of its two dialogs a unit gets.
export const REMOVE_BRANCH_UNIT = "tori:remove-branch-unit";
export type RemoveBranchUnit = { projectPath: string; branch: string };

// Payload-carrying event: ask the sidebar to open its own add-branch dialog.
// Emitted by the Pull Requests panel from the state where the pane is standing
// on the base branch, which is the one place a review starts with a branch that
// does not exist yet.
//
// Same reason as `REMOVE_BRANCH_UNIT`: the sidebar owns the branch-unit list and
// the dialog that adds to it, so it also decides which of the two kinds the
// project gets. `base` is what the filter opens on, since a new branch cut here
// starts from the commit the pane is standing on.
export const ADD_BRANCH_UNIT = "tori:add-branch-unit";
export type AddBranchUnit = { projectPath: string; base?: string | null };

// Payload-carrying event: surface a toast from anywhere. components/Toasts owns
// the stack (ToastRegion listens, pushToast writes), so panels emit this instead
// of holding their own notifier.
export const TOAST = "tori:toast";
// `action` is an optional button, or a short row of them. It exists for a notice
// whose undo has nowhere else to live: a cross-file rename rewrote files nobody
// is looking at, and the moment the user would want that back is the moment
// they are told. The callback travels in the event detail rather than as an id,
// because both ends are the same JS realm and an id would need a registry to
// mean anything.
export type ToastEvent = {
  message: string;
  kind?: "error" | "info";
  action?: ToastEventAction | ToastEventAction[];
};
type ToastEventAction = { label: string; run: () => void };

// Payload-carrying event pair: the safe-send primitive (src/utils/safeSend.ts
// `requestSend`). Any panel can ask to insert text at a session's prompt;
// Terminal.tsx is the sole consumer (it owns pty_write + tab/session state)
// and answers with the result, matched by `requestId`. Never call `pty_write`
// directly for a composed message - route through `requestSend` so the
// probe-gate and insert-only guarantee apply uniformly.
export const SEND_TO_SESSION = "tori:send-to-session";
export type SendToSession = {
  requestId: string;
  sessionId: string;
  text: string;
  agent: string;
  // Which account of `agent` the target session runs as; `null` is the default
  // profile. Carried because a safe-send may have to resume the session first,
  // and resuming it as the wrong account writes into the wrong home.
  profile: string | null;
  // The subset of Selection needed to resume the session into a tab if none
  // is open yet (mirrors what Terminal.tsx's focusOrResume reads).
  sessionFile?: string;
  sessionCwd?: string;
  sessionTitle?: string;
  folderPath: string;
  // Transcript path, used to probe the blocked-candidate (needs-you) state
  // via `session_tail_state`; omitted, the probe falls back to plain
  // liveness (`session_running`) with no blocked-refusal.
  sessionPath?: string;
  // The same message as content blocks, for a chat-backed target. A PTY can
  // only hold the flattened `text`, so both readings travel together and
  // Terminal.tsx takes whichever the target can represent. Omitted, a chat
  // target falls back to `text` as one block, which loses the structure but
  // never the message.
  blocks?: ContentBlock[];
};

export const SEND_TO_SESSION_RESULT = "tori:send-to-session-result";
export type SendToSessionResult = { requestId: string; result: "sent" | "blocked" | "timeout" };

// DataTransfer MIME carrying an absolute file path when dragging a tree row or
// editor tab onto the terminal (which inserts it as a cwd-relative `@path`).
export const DRAG_PATH_MIME = "application/x-tori-path";

// DataTransfer MIME carrying one or more newline-separated ABSOLUTE paths when
// dragging a left-sidebar row (space / project / branch / session) onto the
// terminal. Unlike DRAG_PATH_MIME these are inserted verbatim as `@<abspath>`
// (not relativized to the cwd), so the agent gets the full path to read from.
export const DRAG_ABS_PATH_MIME = "application/x-tori-abspath";

export function emit(name: string) {
  window.dispatchEvent(new CustomEvent(name));
}

export function on(name: string, fn: () => void): () => void {
  const handler = () => fn();
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}

// Payload variants — data travels via CustomEvent.detail.
export function emitWith<T>(name: string, detail: T) {
  window.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

export function onWith<T>(name: string, fn: (detail: T) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<T>).detail);
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}
