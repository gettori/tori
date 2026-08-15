// Scaffolding shared by the tests that mount the real `Editor` with a stubbed
// `CodeEditor`. Only the parts with no per-test meaning live here: the jsdom
// gaps, the selection literal, and the strings the pane renders when it is
// empty. Each test keeps its own `vi.mock` factories, because a mock factory is
// hoisted and because *what the backend answers* is the thing those tests are
// actually varying.

import type { Selection } from "../../LeftSidebar/LeftSidebar";

/** jsdom has no ResizeObserver, and several panes observe their own width. */
export function installResizeObserver(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

/**
 * Run `requestAnimationFrame` callbacks synchronously, for a test that needs the
 * tab strip's *visible* row rather than its measuring ghost.
 *
 * `OverflowTabBar` seeds its visible count from the item list at mount, which is
 * empty, and only corrects it in an `onMount` rAF. jsdom never runs that frame,
 * so the count stays at zero and every tab overflows: the ghost ends up the only
 * copy of a tab in the document. That is why `src/test/tabs.ts`'s `tab()` looks
 * past `aria-hidden`, and it was harmless until the ghost stopped carrying a
 * context menu (skarif2/sway#103 phase 4), because a right-click on the ghost
 * now asks a copy with nothing to answer with.
 *
 * Widths are still all zero, so this does not fake a layout. It only lets the
 * measurement happen at all, which is enough to put one tab on screen.
 */
export function installAnimationFrame(): void {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof requestAnimationFrame;
}

/** A plain branch-unit selection rooted at `folderPath`. Cast at the call site:
 *  `Selection` carries session fields the editor does not read here. */
export function selectionFor(folderPath: string): Partial<Selection> {
  return {
    spaceName: "space",
    projectName: "proj",
    projectPath: folderPath.slice(0, folderPath.lastIndexOf("/")) || "/",
    folderPath,
    branch: "main",
    projectKind: "plain",
  };
}

/** What the editor pane says with nothing open. Matched rather than asserted
 *  verbatim, so a reworded empty state does not fail four unrelated tests. */
export const EMPTY_PANE = /Open a file from the tree/;
