import type { Component } from "solid-js";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { Item, Root, type ToggleGroupItemProps } from "@kobalte/core/toggle-group";

/** An item's props instantiated at `as="button"`, its own default. */
export type ToggleGroupButtonItemProps = PolymorphicProps<
  "button",
  ToggleGroupItemProps<"button">
>;

/**
 * Kobalte's toggle group, and the only door it comes through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Tori's
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
 *
 * **Two doors to the same item.** `Item` is Kobalte's own declaration, generic
 * over what it renders as, which is what lets `LayoutToggles` write
 * `as={IconButton}` and pass that button's own props through it. A generic
 * signature is not inferable *from*, though: hand it to something typed
 * `Component<P>` and `P` silently resolves to `{}`, taking the required `value`
 * with it. `ButtonItem` is the same component pinned to its own `as="button"`
 * default, so a host that infers props off it - `Tooltip`, for `IconGrid`'s
 * tiles - gets the real ones and rejects a tile that forgot its `value`.
 */
export const ToggleGroup = {
  Root,
  Item,
  ButtonItem: Item as Component<ToggleGroupButtonItemProps>,
};
