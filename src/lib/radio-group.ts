import {
  Item,
  ItemControl,
  ItemDescription,
  ItemIndicator,
  ItemInput,
  ItemLabel,
  Label,
  Root,
} from "@kobalte/core/radio-group";

/**
 * Kobalte's radio group, and the only door it comes through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Sway's
 * contact surface with `@kobalte/core`, `boundary.test.ts` fails the suite if
 * anything outside this folder names the package, and the styled wrapper in
 * `src/components/RadioGroup/` is what the app composes.
 *
 * One namespace object per primitive, per the convention #94 settled: the app
 * writes `RadioGroup.Item`, never a bare `Item`, because Kobalte reuses these
 * part names across every primitive in this folder.
 *
 * `ItemDescription` is here where `checkbox.ts` deliberately omits its
 * `Description`, and the difference is real rather than an inconsistency: a
 * checkbox's hint belongs to the one box and its call sites already own an
 * sr-only span, whereas a radio option's second line is part of the choice
 * itself and has to be announced with the option it describes.
 *
 * Absent deliberately: the group's own `Description` and `ErrorMessage`.
 * Nothing composes them, and a re-export nothing composes reads as a supported
 * part of the surface.
 */
export const RadioGroup = {
  Root,
  Label,
  Item,
  ItemInput,
  ItemControl,
  ItemIndicator,
  ItemLabel,
  ItemDescription,
};
