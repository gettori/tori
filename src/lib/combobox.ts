import type { ComponentProps, JSX } from "solid-js";
import {
  Control,
  Input,
  Item,
  ItemLabel,
  Listbox,
  Root,
  Section,
  useComboboxContext,
} from "@kobalte/core/combobox";

/** Selection behaviour the combobox's listbox forwards to `Listbox.Root` and
 *  does not type. Named here so the one call site that turns hover-focus off
 *  (see Combobox.tsx) is a prop and not a cast; the picker's press/release test
 *  is what fails if a future Kobalte stops forwarding it. */
type ListboxSelection = { shouldFocusOnHover?: boolean };

/**
 * Kobalte's combobox, and the only door it comes through.
 *
 * The same seam `dialog.ts` and `select.ts` document: `src/lib/` is the whole
 * of Sway's contact surface with `@kobalte/core`, `boundary.test.ts` fails the
 * suite if anything outside this folder names the package, and the styled
 * wrapper in `src/components/Combobox/` is what the app composes.
 *
 * **One namespace object per primitive**, per the convention #94 settled: the
 * app writes `Combobox.Root`, never a bare `Root`.
 *
 * The list is an allow-list of the parts a Sway combobox is actually built
 * from, and it is shorter than the primitive's own catalogue because Sway's two
 * pickers are *always open*: the list is the surface, not something a trigger
 * reveals. Absent deliberately rather than by oversight:
 *
 * - `Content` and `Portal`, the popper. `Content` is a Popper positioner *plus*
 *   a dismissable layer, a focus scope, `createHideOutside` and a scroll lock,
 *   and every one of those is wrong for a list rendered inline inside a dialog
 *   that already owns them. `Listbox` renders on its own without it, which is
 *   the whole recipe: `Root` (controlled `open`) > `Control` > `Input`, with
 *   `Listbox` as a sibling.
 * - `Trigger` and `Icon`, which belong to a combobox you open. Neither picker
 *   has anything to open.
 * - `ItemIndicator`, a checkmark for the option in force. Both consumers commit
 *   and close on selection, so no row is ever "the current one" while visible.
 * - `HiddenSelect` (no picker posts an HTML form), `Label`/`Description`/
 *   `ErrorMessage` (labeling is the call site's, through `aria-label`), and
 *   `ItemDescription` (rows compose their own content through `itemComponent`).
 */
export const Combobox = {
  Root,
  Control,
  Input,
  Listbox: Listbox as (props: ComponentProps<typeof Listbox> & ListboxSelection) => JSX.Element,
  Section,
  Item,
  ItemLabel,
};

/**
 * The open combobox's own context, for the one thing its props cannot express.
 *
 * Kobalte owns the input's text: it is a controllable signal with no `value`
 * source (`combobox-base.tsx`), and `Combobox.Input` force-binds the element to
 * it, so there is no `inputValue` prop to pass and no way to write the box from
 * outside. Both Sway pickers do write it (the picker's clear button, the
 * Omnibox `?` rows that retype a prefix in place), so the wrapper mounts one
 * internal child inside `Root` that calls `setInputValue` and publishes a plain
 * controlled `query` prop to callers.
 *
 * Exported separately rather than folded into the namespace above because it is
 * a hook, not a part, and because naming it here is the point: this is the one
 * sanctioned reach past the props API, and it lives in exactly one component.
 */
export { useComboboxContext };
