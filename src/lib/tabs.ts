import { Content, List, Root, Trigger } from "@kobalte/core/tabs";

/**
 * Kobalte's tabs, and the only door they come through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Sway's
 * contact surface with `@kobalte/core`, `boundary.test.ts` fails the suite if
 * anything outside this folder names the package, and the styled wrapper in
 * `src/components/Tab/` is what the app composes.
 *
 * **One namespace object per primitive**, per the convention #94 settled: a
 * wrapper writes `Tabs.Root`, never a bare `Root`. Kobalte names `Root`,
 * `Content` and `Trigger` identically here and in several other primitives,
 * and `Tab` composes this with the tooltip in one file.
 *
 * `Indicator` is withheld deliberately rather than by oversight: no Sway strip
 * draws a sliding underline, and it is the one part that measures its selected
 * trigger on every resize. A re-export nothing composes reads as a supported
 * part of the surface.
 *
 * `Content` is here for Settings, which has six real panels. The three
 * `OverflowTabBar` strips render none: the editor has one shared CodeMirror
 * view and the terminal keeps its stages in a sibling subtree, and Kobalte
 * omits `aria-controls` entirely when no `Content` claims the value, so a
 * panel-less strip is clean rather than dangling.
 */
export const Tabs = {
  Root,
  List,
  Trigger,
  Content,
};
