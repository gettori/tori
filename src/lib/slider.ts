import { Fill, Label, Root, Thumb, Track } from "@kobalte/core/slider";

/**
 * Kobalte's slider, and the only door it comes through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Sway's
 * contact surface with `@kobalte/core`, `boundary.test.ts` fails the suite if
 * anything outside this folder names the package, and the styled wrapper in
 * `src/components/Slider/` is what the app composes.
 *
 * One namespace object per primitive, per the convention #94 settled: the app
 * writes `Slider.Root`, never a bare `Root`.
 *
 * Absent deliberately: `ValueLabel` (the one consumer previews its value by
 * applying it, not by printing it), `Description` and `ErrorMessage`, which
 * nothing composes, and `Input`. That last one is not a style choice: the part
 * renders an `<input type="range">` for form submission, which carries the
 * `slider` role itself, so composing it inside the thumb puts one slider inside
 * another - axe fails it as `nested-interactive` and `getByRole("slider")`
 * matches two elements. Nothing in Sway submits a form, and the thumb already
 * carries the value and the label association.
 */
export const Slider = {
  Root,
  Track,
  Fill,
  Thumb,
  Label,
};
