// Lightweight window-event bus for cross-component actions.
import type { ContentBlock } from "./chatTypes";

// A live terminal tab, surfaced from the terminal area to the sidebar so its
// confirms (checkout, destructive delete) can count what's actually running in a
// folder, including shell + fresh-agent tabs that pgrep can't see. `workspace` is
// the branch-unit folder the tab is grouped under; `sessionId` (resumed agents
// only) lets the sidebar dedup a tab against a pgrep-matched session.
export type LiveTab = {
  id: string;
  workspace: string;
  kind: "shell" | "agent" | "command" | "chat";
  sessionId?: string;
  // Agent program for a resumed/spawned agent tab; lets a session-row probe
  // (session_running) pick the right per-agent pgrep pattern.
  agent?: "claude" | "pi";
};

export const FOCUS_SEARCH = "sway:focus-search";
export const FOCUS_TERMINAL = "sway:focus-terminal";
// Switches the editor's right panel to the project-wide Search mode and
// focuses its input (Cmd+Shift+F). Distinct from FOCUS_SEARCH, which focuses
// the left sidebar's own filter box.
export const FOCUS_PROJECT_SEARCH = "sway:focus-project-search";

// Payload-carrying event: jump to tab N (0-indexed) of the current
// workspace's visible terminal bar (Cmd+1..9). Consumed by Terminal.tsx.
export const TAB_JUMP = "sway:tab-jump";
export type TabJump = { index: number };

// Cycle to the next tab in the current workspace's visible terminal bar
// (Ctrl+Tab). Consumed by Terminal.tsx.
export const TAB_CYCLE = "sway:tab-cycle";

// Focus the next session (across all live tabs) whose status is "Waiting for
// approval" (Cmd+Shift+A). Consumed by Terminal.tsx.
export const NEXT_WAITING_SESSION = "sway:next-waiting-session";

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
export const STOP_CHAT = "sway:stop-chat";
export type StopChat = { sessionId: string | null };

// Opens the Cmd+K command palette. Consumed by App.tsx.
export const OPEN_PALETTE = "sway:open-palette";

// Opens the Cmd+P quick-open file finder. Consumed by App.tsx. Emitted only
// from the window-level listener, never from a focused terminal - see the
// `window` scope in utils/hotkeys.ts.
export const OPEN_QUICK_OPEN = "sway:open-quick-open";

// Toggles the Cmd+/ shortcut sheet. Consumed by App.tsx. A toggle rather than
// an open, so the same key that summons it dismisses it.
export const TOGGLE_SHORTCUTS = "sway:toggle-shortcuts";

// Global UI zoom (Cmd+ / Cmd- / Cmd0), consumed by App.tsx, which drives the
// zoom multiplier in settingsStore. Scales chrome, editor, and terminal together.
export const ZOOM_IN = "sway:zoom-in";
export const ZOOM_OUT = "sway:zoom-out";
export const ZOOM_RESET = "sway:zoom-reset";

// Reload the webview (Cmd+R), consumed by App.tsx. Reloads the frontend only,
// not the Rust backend (that needs a full restart).
export const RELOAD_APP = "sway:reload-app";

// Show/hide toggles for the four major panes. Consumed by App.tsx, which owns
// the visibility flags; TOGGLE_FILETREE also reaches the editor (App reveals the
// editor when the filetree is shown). Emitted by the topbar cluster, the view
// hotkeys, and the command palette so all three drive one path.
export const TOGGLE_SIDEBAR = "sway:toggle-sidebar";
export const TOGGLE_TERMINAL = "sway:toggle-terminal";
export const TOGGLE_EDITOR = "sway:toggle-editor";
export const TOGGLE_FILETREE = "sway:toggle-filetree";

// Fired by App.tsx after a pane transitions hidden -> shown, so the terminal
// refits its cell grid and CodeMirror re-measures without waiting on a
// ResizeObserver tick. Consumed by TerminalView and CodeEditor.
export const REFIT_PANES = "sway:refit-panes";

// Payload-carrying event: switch the editor's right panel to a named mode
// (the command palette's "toggle right-panel mode" actions). Editor.tsx's
// existing fallback-to-files effect handles a mode the current selection
// can't show, so no availability gating is needed here.
export const SET_RIGHT_MODE = "sway:set-right-mode";
export type SetRightMode = { mode: "files" | "changes" | "search" | "session" | "shared" | "docs" };

// Payload-carrying event: focus a specific live terminal tab by id (the
// command palette's "focus session" action, when the session is already
// open). Consumed by Terminal.tsx.
export const FOCUS_SESSION_TAB = "sway:focus-session-tab";
export type FocusSessionTab = { tabId: string };

// Payload-carrying event: the user clicked a terminal tab, so move the sidebar
// selection to match it (the reverse of props.selected -> focusOrResume).
// `sessionId` present -> select that session row; absent (a shell tab) -> select
// the branch-unit at `folderPath`. Emitted ONLY on a user click, never from the
// programmatic focus that a sidebar selection already drives, so the two can't
// feed back into each other. Consumed by LeftSidebar.tsx. Command tabs (clone/
// bootstrap) don't emit it.
export const TERMINAL_TAB_FOCUSED = "sway:terminal-tab-focused";
export type TerminalTabFocused = { folderPath: string; sessionId?: string };
export const CLOSE_TAB = "sway:close-tab";
export const SESSIONS_REFRESH = "sway:sessions-refresh";
export const THEME_APPLIED = "sway:theme-applied";
export const SETTINGS_CHANGED = "sway:settings-changed";

// Payload-carrying event: open a file in the editor at an optional position.
// (General file-change fan-out is not here — that rides the backend
// `fs://changed` Tauri event, consumed directly by the editor panes. The one
// exception is AGENT_FILES_WRITTEN below, which is not a fan-out of the watcher
// but a report from a chat session about its own writes.)
export const OPEN_IN_EDITOR = "sway:open-in-editor";
export type OpenInEditor = { path: string; line?: number; col?: number };

// Payload-carrying event: the files a chat session's tool call just wrote,
// straight off its `toolCallCompleted`/`fileEdit` events.
//
// The watcher already reports these ~250ms later (its debounce), so this is not
// new information - it is the same information sooner, and exactly, since the
// event names the files rather than a directory burst. The gutter and the
// Changes panel take it so an agent edit is on screen while the user is still
// reading the tool card. Consumers keep their `isSelfWrite` check and stay
// idempotent, because the watcher's echo is still coming.
export const AGENT_FILES_WRITTEN = "sway:agent-files-written";
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
export const SESSION_DELETED = "sway:session-deleted";
export type SessionDeleted = { sessionId: string };

// Payload-carrying event: open a session's transcript as a read-only virtual
// tab in the editor's center pane. Emitted by the sidebar's session context menu.
export const OPEN_TRANSCRIPT = "sway:open-transcript";
export type OpenTranscript = { id: string; sessionPath: string; agent: "claude" | "pi"; name: string; cwd: string };

// Payload-carrying event: open a terminal tab running a specific command (used
// by clone / bare-worktree bootstrap, which need native git progress + auth).
// When rediscoverOnExit is set, the terminal area re-discovers on process exit.
export const OPEN_TERMINAL = "sway:open-terminal";
export type OpenTerminal = {
  id: string;
  title: string;
  cwd: string;
  program: string;
  args: string[];
  rediscoverOnExit?: boolean;
};

// Payload-carrying event: start a fresh agent session in a branch-unit folder.
// Emitted by the sidebar's "New session" menu item; the terminal area owns the
// spawn (id/title/yolo conventions), so the sidebar only names the target.
export const NEW_SESSION = "sway:new-session";
// `agent` is any registered adapter id (Terminal.tsx's spawnSession treats it
// as opaque, looking it up via findAgent), not just the original claude/pi
// pair - the command palette's "new session per registered agent" needs the
// full registry, e.g. opencode or a user-added adapter.
export type NewSession = { folderPath: string; projectName: string; agent?: string };

// Payload-carrying event: tear down everything rooted under a path (used when a
// space is deleted). The terminal area kills + closes PTY tabs whose cwd is under
// it; the editor pane closes buffers under it. Emitted before the native delete so
// no agent keeps writing into a vanishing cwd.
export const PURGE_UNDER_PATH = "sway:purge-under-path";
export type PurgeUnderPath = { path: string };

// Payload-carrying event: surface a toast from anywhere. The sidebar owns the
// toast stack (setError), so components outside it (e.g. the editor's file tree)
// emit this instead of holding their own notifier.
export const TOAST = "sway:toast";
export type ToastEvent = { message: string; kind?: "error" | "info" };

// Payload-carrying event pair: the safe-send primitive (src/utils/safeSend.ts
// `requestSend`). Any panel can ask to insert text at a session's prompt;
// Terminal.tsx is the sole consumer (it owns pty_write + tab/session state)
// and answers with the result, matched by `requestId`. Never call `pty_write`
// directly for a composed message - route through `requestSend` so the
// probe-gate and insert-only guarantee apply uniformly.
export const SEND_TO_SESSION = "sway:send-to-session";
export type SendToSession = {
  requestId: string;
  sessionId: string;
  text: string;
  agent: string;
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

export const SEND_TO_SESSION_RESULT = "sway:send-to-session-result";
export type SendToSessionResult = { requestId: string; result: "sent" | "blocked" | "timeout" };

// DataTransfer MIME carrying an absolute file path when dragging a tree row or
// editor tab onto the terminal (which inserts it as a cwd-relative `@path`).
export const DRAG_PATH_MIME = "application/x-sway-path";

// DataTransfer MIME carrying one or more newline-separated ABSOLUTE paths when
// dragging a left-sidebar row (space / project / branch / session) onto the
// terminal. Unlike DRAG_PATH_MIME these are inserted verbatim as `@<abspath>`
// (not relativized to the cwd), so the agent gets the full path to read from.
export const DRAG_ABS_PATH_MIME = "application/x-sway-abspath";

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
