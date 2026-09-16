import { Content, Portal, Root } from "@kobalte/core/popover";

/**
 * Kobalte's popover, and the only door it comes through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Tori's
 * contact surface with `@kobalte/core`, `boundary.test.ts` fails the suite if
 * anything outside this folder names the package, and the styled wrapper in
 * `src/components/Popover/` is what the app composes.
 *
 * **One namespace object per primitive**, per the convention #94 settled: the
 * app writes `Popover.Root`, never a bare `Root`. Kobalte names `Root`,
 * `Content` and `Portal` identically here, in the dialog and in both menus, so
 * this file would collide with three others the moment one wrapper composed
 * two primitives.
 *
 * The list is an allow-list of the parts an anchored panel is actually built
 * from. Absent deliberately rather than by oversight: `Trigger` (the one
 * consumer runs in anchored controlled mode, where the opening button belongs
 * to the caller and there is no trigger element), `Anchor` (the anchor arrives
 * as `anchorRef` on `Root`, not as a rendered part), and `Arrow`, `Title`,
 * `Description`, `CloseButton`, which nothing composes. A re-export nothing
 * composes reads as a supported part of the surface.
 */
export const Popover = {
  Root,
  Portal,
  Content,
};
