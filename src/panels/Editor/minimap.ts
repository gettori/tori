// The minimap: a scaled-down render of the whole file down the right edge.
//
// `@replit/codemirror-minimap` does the drawing (adopted in this wave's package
// audit: MIT, current, and its CM6 peers match the versions here). It asks the
// host for one thing, the element to draw into, which is the hook this module
// exists for: the class it carries is how the app reaches inside a package that
// otherwise paints two of its own fixed greys.
//
// The class is a literal string rather than a CSS-module class, following the
// diff and blame gutters (`src/App.css`), for the same reason: the element ends
// up in CodeMirror's DOM, outside the component's scoped tree, and the styles
// have to be able to name what the package puts inside it.
//
// **`@lezer/common` is a direct dependency because of this package**, even
// though no file here imports it: the minimap lists it as a *peer*, which the
// host has to satisfy. Every language pack already pulls the same copy in, so
// npm dedupes to one either way, but that is a property of hoisting rather than
// a promise, and a second copy of it would break node-type identity across the
// syntax tree. `package.json` has nowhere to say this, so it is said here.

import { showMinimap } from "@replit/codemirror-minimap";
import type { Extension } from "@codemirror/state";

/** Styled in `App.css`, beside the other classes handed to CodeMirror. */
export const MINIMAP_CLASS = "cm-sway-minimap";

/**
 * A scaled render of the file, in the editor's right gutter.
 *
 * The package sizes it at a sixth of the editor's width and shrinks it further
 * as the pane narrows, so it takes a share of the editor rather than a fixed
 * column: it cannot reach the panel beside it, and it sits on the opposite side
 * from the diff and blame gutters, which are gutters proper.
 */
export function minimap(): Extension {
  return showMinimap.of({
    create: () => {
      const dom = document.createElement("div");
      dom.classList.add(MINIMAP_CLASS);
      return { dom };
    },
  });
}
