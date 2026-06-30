// Lightweight window-event bus for cross-component actions.

export const FOCUS_SEARCH = "sway:focus-search";
export const FOCUS_TERMINAL = "sway:focus-terminal";
export const CLOSE_TAB = "sway:close-tab";
export const SESSIONS_REFRESH = "sway:sessions-refresh";
export const THEME_APPLIED = "sway:theme-applied";

// Payload-carrying event: open a file in the editor at an optional position.
// (File-change fan-out is not here — that rides the backend `fs://changed`
// Tauri event, consumed directly by the editor panes.)
export const OPEN_IN_EDITOR = "sway:open-in-editor";
export type OpenInEditor = { path: string; line?: number; col?: number };

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

// DataTransfer MIME carrying an absolute file path when dragging a tree row or
// editor tab onto the terminal (which inserts it as a cwd-relative `@path`).
export const DRAG_PATH_MIME = "application/x-sway-path";

// DataTransfer MIME carrying one or more newline-separated ABSOLUTE paths when
// dragging a left-sidebar row (group / project / branch / session) onto the
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
