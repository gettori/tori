// Lightweight window-event bus for cross-component actions.

// A live terminal tab, surfaced from the terminal area to the sidebar so its
// confirms (checkout, destructive delete) can count what's actually running in a
// folder, including shell + fresh-agent tabs that pgrep can't see. `workspace` is
// the branch-unit folder the tab is grouped under; `sessionId` (resumed agents
// only) lets the sidebar dedup a tab against a pgrep-matched session.
export type LiveTab = {
  id: string;
  workspace: string;
  kind: "shell" | "agent" | "command";
  sessionId?: string;
  // Agent program for a resumed/spawned agent tab; lets a session-row probe
  // (session_running) pick the right per-agent pgrep pattern.
  agent?: "claude" | "pi";
};

export const FOCUS_SEARCH = "sway:focus-search";
export const FOCUS_TERMINAL = "sway:focus-terminal";
export const CLOSE_TAB = "sway:close-tab";
export const SESSIONS_REFRESH = "sway:sessions-refresh";
export const THEME_APPLIED = "sway:theme-applied";
export const SETTINGS_CHANGED = "sway:settings-changed";

// Payload-carrying event: open a file in the editor at an optional position.
// (File-change fan-out is not here — that rides the backend `fs://changed`
// Tauri event, consumed directly by the editor panes.)
export const OPEN_IN_EDITOR = "sway:open-in-editor";
export type OpenInEditor = { path: string; line?: number; col?: number };

// Payload-carrying event: open a session's transcript as a read-only virtual
// tab in the editor's center pane. Emitted by the sidebar's session context menu.
export const OPEN_TRANSCRIPT = "sway:open-transcript";
export type OpenTranscript = { id: string; sessionPath: string; agent: "claude" | "pi"; name: string };

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
export type NewSession = { folderPath: string; projectName: string; agent?: "claude" | "pi" };

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
