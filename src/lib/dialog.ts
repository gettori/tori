import {
  CloseButton,
  Content,
  Description,
  Overlay,
  Portal,
  Root,
  Title,
  Trigger,
} from "@kobalte/core/dialog";

/**
 * Kobalte's dialog, and the only door it comes through.
 *
 * `src/lib/` is the whole of Tori's contact surface with `@kobalte/core`.
 * Nothing outside this folder may import the package - `boundary.test.ts`
 * fails the suite if anything does - so swapping the primitives library later
 * edits these files and the handful of wrappers built on them, not the app.
 * The layering above is just as fixed: styled components in `src/components/`
 * compose these parts on design tokens and expose Tori's own API, and panels
 * import those components, never this module.
 *
 * **One namespace object per primitive**, and this is the convention every
 * later `lib/` module follows. Kobalte names its parts `Root`, `Content`,
 * `Title` - identical across dialog, menu, select, popover and tabs - so bare
 * re-exports would collide the first time one wrapper composed two of them,
 * and would read as anonymous at the call site besides. `Dialog.Root` says
 * which primitive it is; `Root` does not.
 *
 * The list is an allow-list, kept to the parts a dialog is actually built from,
 * so what Tori depends on stays legible from this file alone. It is not the
 * whole of Kobalte's dialog: the anchored and non-modal variants are absent
 * until something needs them.
 */
export const Dialog = {
  Root,
  Trigger,
  Portal,
  Overlay,
  Content,
  Title,
  Description,
  CloseButton,
};
