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
