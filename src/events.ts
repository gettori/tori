// Lightweight window-event bus for cross-component actions.

export const FOCUS_SEARCH = "sway:focus-search";
export const FOCUS_TERMINAL = "sway:focus-terminal";
export const CLOSE_TAB = "sway:close-tab";
export const SESSIONS_REFRESH = "sway:sessions-refresh";
export const THEME_APPLIED = "sway:theme-applied";

export function emit(name: string) {
  window.dispatchEvent(new CustomEvent(name));
}

export function on(name: string, fn: () => void): () => void {
  const handler = () => fn();
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}
