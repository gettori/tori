import { getCurrentWindow } from "@tauri-apps/api/window";

// Moving the window by its own chrome.
//
// Two ways of asking for this were already in the tree and neither could work.
// `data-tauri-drag-region` only fires when the press lands on the element that
// carries the attribute, and every pixel of the titlebar is covered by a child
// (the rail, the toolbar, the badges), so the header never saw a mousedown.
// `-webkit-app-region: drag` is Electron's, and WKWebView, which is what Tauri
// runs on macOS, does not implement it at all.
//
// So the contract is written out here instead: a press on chrome starts a
// system drag, a double press zooms, and anything the user can actually operate
// is carved out. The carve-out is by selector rather than by marking each
// control, because the rule "if you can click it, it is not a handle" is the
// one worth keeping true as the chrome grows. Rows that are clickable `div`s
// (the session tree) are not reachable by selector and opt out with
// `data-no-window-drag`.
const INTERACTIVE = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  "summary",
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[contenteditable="true"]',
  '[draggable="true"]',
  "[data-no-window-drag]",
].join(",");

/** `onMouseDown` for a surface that should drag the window. */
export function windowDragStart(e: MouseEvent) {
  // Left button only: the right one opens context menus, and a press that
  // something else already handled is not a drag.
  if (e.button !== 0 || e.defaultPrevented) return;
  const target = e.target as Element | null;
  if (!target || typeof target.closest !== "function") return;
  if (target.closest(INTERACTIVE)) return;
  // One mousedown carries both gestures, the way Tauri's own drag region reads
  // them: `detail` is 2 on the second press of a double click.
  if (e.detail === 2) void getCurrentWindow().toggleMaximize().catch(() => {});
  else void getCurrentWindow().startDragging().catch(() => {});
}
