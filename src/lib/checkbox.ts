import { Control, Indicator, Input, Label, Root } from "@kobalte/core/checkbox";

/**
 * Kobalte's checkbox, and the only door it comes through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Sway's
 * contact surface with `@kobalte/core`, `boundary.test.ts` fails the suite if
 * anything outside this folder names the package, and the styled wrapper in
 * `src/components/Checkbox/` is what the app composes.
 *
 * One namespace object per primitive, per the convention #94 settled: the app
 * writes `Checkbox.Root`, never a bare `Root`, because Kobalte reuses these
 * part names across every primitive in this folder.
 *
 * Absent deliberately: `Description` and `ErrorMessage`. The sites that need a
 * described-by relationship (ReviewPanel's hints) keep their own sr-only spans
 * and reach the input via an `aria-describedby` pass-through, and nothing
 * renders a validation message.
 */
export const Checkbox = {
  Root,
  Input,
  Control,
  Indicator,
  Label,
};
