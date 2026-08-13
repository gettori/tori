import { Content, Portal, Root, Trigger } from "@kobalte/core/tooltip";

/**
 * Kobalte's tooltip, and the only door it comes through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Sway's
 * contact surface with `@kobalte/core`, `boundary.test.ts` fails the suite if
 * anything outside this folder names the package, and the styled wrapper in
 * `src/components/Tooltip/` is what the app composes.
 *
 * **One namespace object per primitive**, per the convention #94 settled: the
 * app writes `Tooltip.Root`, never a bare `Root`. Kobalte names `Root`,
 * `Content` and `Portal` identically here and in the dialog, so this file and
 * `dialog.ts` would collide on import the moment one wrapper composed both -
 * which the tooltip's `mount` seam makes an everyday case, not a hypothetical.
 *
 * The list is an allow-list of the parts a tooltip is actually built from.
 * `Arrow` is absent deliberately rather than by oversight: Sway's tooltips draw
 * none (see Tooltip.module.css), and a re-export nothing composes reads as a
 * supported part of the surface.
 */
export const Tooltip = {
  Root,
  Trigger,
  Portal,
  Content,
};
