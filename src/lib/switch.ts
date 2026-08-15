import { Control, Input, Label, Root, Thumb } from "@kobalte/core/switch";

/**
 * Kobalte's switch, and the only door it comes through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Sway's
 * contact surface with `@kobalte/core`, `boundary.test.ts` fails the suite if
 * anything outside this folder names the package, and the styled wrapper in
 * `src/components/Switch/` is what the app composes.
 *
 * One namespace object per primitive, per the convention #94 settled: the app
 * writes `Switch.Root`, never a bare `Root`.
 *
 * Absent deliberately: `Description` and `ErrorMessage`, which nothing
 * composes. A re-export nothing composes reads as a supported part of the
 * surface.
 */
export const Switch = {
  Root,
  Input,
  Control,
  Thumb,
  Label,
};
