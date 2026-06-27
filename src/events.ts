// Lightweight window-event bus for cross-pane keyboard actions, so panes can
// react without prop-drilling refs through the tree.

export const FOCUS_SIDEBAR = "sway:focus-sidebar";
export const FOCUS_TERMINAL = "sway:focus-terminal";
export const FOCUS_EDITOR = "sway:focus-editor";
export const FOCUS_SEARCH = "sway:focus-search";
export const CLOSE_TAB = "sway:close-tab";

export function emit(name: string) {
  window.dispatchEvent(new CustomEvent(name));
}

export function on(name: string, fn: () => void): () => void {
  const handler = () => fn();
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}
