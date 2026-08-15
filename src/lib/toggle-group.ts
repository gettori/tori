import { Item, Root } from "@kobalte/core/toggle-group";

/**
 * Kobalte's toggle group, and the only door it comes through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Sway's
 * contact surface with `@kobalte/core`, `boundary.test.ts` fails the suite if
 * anything outside this folder names the package, and the styled wrappers are
 * what the app composes.
 *
 * **One namespace object per primitive**, per the convention #94 settled: a
 * wrapper writes `ToggleGroup.Root`, never a bare `Root`, which collides with
 * the dialog, the popover and both menus the moment one file composes two
 * primitives.
 *
 * Both selection modes ride this pair: `SegmentedControl` runs `Root` in
 * single mode (its bordered strip), `LayoutToggles` in `multiple` (the topbar
 * pane cluster). The primitive has no other parts, so unlike the popover there
 * is nothing withheld from the list.
 */
export const ToggleGroup = {
  Root,
  Item,
};
